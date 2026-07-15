import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { PtyManager } from './ptyManager.js'
import { readConfig, writeConfig } from './store.js'
import { buildMenu } from './menu.js'
import type { BackgroundState, PtyCreateOptions } from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_OPACITY = 0.2

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#0c1521',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
  mainWindow?.webContents.send(channel, payload)
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
  ipcMain.handle('bg:get', () => currentBackground())
}

// ===== 背景画像 =====

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

function currentBackground(): BackgroundState {
  const cfg = readConfig()
  return {
    dataUri: loadDataUri(cfg.backgroundImagePath),
    opacity: cfg.backgroundOpacity ?? DEFAULT_OPACITY
  }
}

function pushBackground(): void {
  send('bg:changed', currentBackground())
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
  pushBackground()
}

function clearBackground(): void {
  writeConfig({ backgroundImagePath: null })
  pushBackground()
}

function setOpacity(opacity: number): void {
  writeConfig({ backgroundOpacity: opacity })
  pushBackground()
}

function refreshMenu(): void {
  buildMenu({
    onPickBackground: () => void pickBackground(),
    onClearBackground: clearBackground,
    onSetOpacity: setOpacity,
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
