import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { PtyManager } from './ptyManager.js'
import { readConfig, writeConfig } from './store.js'
import { buildMenu } from './menu.js'
import type { AppSettings, PtyCreateOptions, SettingsPatch } from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_OPACITY = 0.2
const DEFAULT_BLUR = 2
const DEFAULT_FONT_SIZE = 13
const DEFAULT_THEME = 'dark' as const

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    // 保存テーマに合わせて初期背景色を決め、起動時のちらつきを防ぐ
    backgroundColor: (readConfig().theme ?? DEFAULT_THEME) === 'light' ? '#dde4ef' : '#0c1521',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 閉じたら参照を落とす。これが無いと破棄済み webContents に send して
  // 「Object has been destroyed」で落ちる（閉じる際の killAll→pty exit が send を叩くため）。
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // http(s) のみ外部に流す。about:blank 等が来ても OS のアプリ選択を出さない。
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const send = (channel: string, payload: unknown): void => {
  // ウィンドウ破棄後にも pty exit/data コールバックが遅れて届くため、破棄済みなら送らない。
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

const ptyManager = new PtyManager(
  (id, data) => send('pty:data', { id, data }),
  (id, exitCode) => send('pty:exit', { id, exitCode }),
  (id, status) => send('pty:status', { id, status })
)

function registerIpc(): void {
  ipcMain.handle('pty:create', (_e, opts: PtyCreateOptions) => ptyManager.create(opts))
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptyManager.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => ptyManager.kill(id))
  ipcMain.on('pty:focus', (_e, id: string) => ptyManager.focus(id))
  ipcMain.handle('settings:get', () => currentSettings())
  ipcMain.on('settings:update', (_e, patch: SettingsPatch) => {
    writeConfig(patch)
    pushSettings()
  })
  ipcMain.on('bg:pick', () => void pickBackground())
  ipcMain.on('bg:clear', () => clearBackground())
  ipcMain.handle('layout:get', () => readConfig().layout ?? null)
  ipcMain.on('layout:save', (_e, layout: unknown) => writeConfig({ layout }))
  ipcMain.on('open:external', (_e, url: string) => {
    // 端末内リンクを既定ブラウザで開く。http(s) のみ許可（危険/未対応スキームは無視）。
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

// ===== 設定（背景画像・フォント・テーマ・レイアウト復元） =====

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 設定のパスから表示用の data URI を作る。読めなければ null。 */
function loadDataUri(path: string | null | undefined): string | null {
  if (!path) return null
  try {
    const mime = MIME[extname(path).toLowerCase()]
    if (!mime) return null
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}

function currentSettings(): AppSettings {
  const cfg = readConfig()
  return {
    background: {
      dataUri: loadDataUri(cfg.backgroundImagePath),
      opacity: cfg.backgroundOpacity ?? DEFAULT_OPACITY,
      blur: cfg.backgroundBlur ?? DEFAULT_BLUR
    },
    fontSize: cfg.fontSize ?? DEFAULT_FONT_SIZE,
    theme: cfg.theme ?? DEFAULT_THEME,
    layoutRestore: cfg.layoutRestore ?? true
  }
}

function pushSettings(): void {
  send('settings:changed', currentSettings())
  refreshMenu()
}

async function pickBackground(): Promise<void> {
  if (!mainWindow) return
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '背景画像を選択',
    properties: ['openFile'],
    filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return
  writeConfig({ backgroundImagePath: res.filePaths[0] })
  pushSettings()
}

function clearBackground(): void {
  writeConfig({ backgroundImagePath: null })
  pushSettings()
}

function refreshMenu(): void {
  buildMenu({
    onOpenSettings: () => send('menu:open-settings', null),
    onPickBackground: () => void pickBackground(),
    onClearBackground: clearBackground,
    onSetOpacity: (opacity) => {
      writeConfig({ backgroundOpacity: opacity })
      pushSettings()
    },
    currentOpacity: () => readConfig().backgroundOpacity ?? DEFAULT_OPACITY
  })
}

app.whenReady().then(() => {
  registerIpc()
  refreshMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ptyManager.killAll()
})
