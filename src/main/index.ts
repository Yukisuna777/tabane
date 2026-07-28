import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, dirname, extname, basename } from 'node:path'

import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PtyManager, paneNumberOf } from './ptyManager.js'
import { AgentStateStore } from './agentState.js'
import { readConfig, writeConfig } from './store.js'
import { buildMenu } from './menu.js'
import { SocketServer } from './socketServer.js'
import type {
  AppSettings,
  KillRequest,
  OpenRequest,
  PaneInfo,
  PaneSyncEntry,
  PtyCreateOptions,
  ReportRequest,
  SettingsPatch,
  TabaneRequest,
  TabaneResponse,
  WaitRequest
} from '../shared/types.js'

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

/** 子 claude が hooks で申告してくる状態。ペイン状態とは別軸で持つ。 */
const agentStates = new AgentStateStore()

const ptyManager = new PtyManager(
  (id, data) => send('pty:data', { id, data }),
  (id, exitCode) => {
    send('pty:exit', { id, exitCode })
    // 待っている wait には closed として返す（永遠に待たせない）。
    agentStates.forget(paneNumberOf(id))
  },
  (id, status) => send('pty:status', { id, status }),
  () => readConfig().defaultCwd ?? undefined
)

function registerIpc(): void {
  ipcMain.handle('pty:create', async (_e, opts: PtyCreateOptions) => {
    // CLI 由来のペインなら、予約しておいた cwd と起動コマンドで PTY を作る。
    // renderer は specId を持ち回るだけで、中身（プロンプト・権限）は main が握る。
    const pending = opts.spawnSpecId ? pendingSpawns.get(opts.spawnSpecId) : undefined
    const id = await ptyManager.create({
      ...opts,
      cwd: pending ? pending.spec.cwd : opts.cwd,
      initialCommand: pending ? buildInitialCommand(pending.spec) : undefined
    })
    if (pending && opts.spawnSpecId) {
      clearTimeout(pending.timer)
      pendingSpawns.delete(opts.spawnSpecId)
      pending.resolve(id)
    }
    return id
  })
  ipcMain.on('pane:sync', (_e, panes: PaneSyncEntry[]) => {
    paneTitles.clear()
    for (const p of panes) paneTitles.set(p.ptyId, p.title)
  })
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
  ipcMain.on('cwd:pick', () => void pickDefaultCwd())
  ipcMain.on('cwd:clear', () => {
    writeConfig({ defaultCwd: null })
    pushSettings()
  })
  ipcMain.handle('layout:get', () => readConfig().layout ?? null)
  ipcMain.on('layout:save', (_e, layout: unknown) => writeConfig({ layout }))
  ipcMain.on('open:external', (_e, url: string) => {
    // 端末内リンクを既定ブラウザで開く。http(s) のみ許可（危険/未対応スキームは無視）。
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

// ===== tabane CLI（socket）=====

let socketServer: SocketServer | null = null

/** 同時に開けるペイン数の上限。指揮役の暴走で画面が埋まる前に止める。 */
const MAX_PANES = 8

/** renderer がペインを作って PTY を生成するまでの猶予。 */
const SPAWN_TIMEOUT_MS = 15_000

/** wait の既定タイムアウト。claude 側の Bash 実行上限に収まる長さにしておく。 */
const DEFAULT_WAIT_TIMEOUT_SEC = 600

interface PendingSpawn {
  spec: OpenRequest
  resolve: (ptyId: string) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** `tabane open` で予約した起動スペック。renderer が createPty を呼んだ時点で解決する。 */
const pendingSpawns = new Map<string, PendingSpawn>()

/** ptyId -> ペインのタイトル。renderer が layout 変更のたびに同期してくる。 */
const paneTitles = new Map<string, string>()

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

function shortenHome(p: string): string {
  const home = homedir()
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

/** シェルに渡す文字列を単一引用符で囲む（プロンプト内の引用符・改行を無害化する）。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 子 claude に渡す hooks 設定ファイル。起動時に1度だけ書き出す。 */
function hooksSettingsPath(): string {
  return join(app.getPath('userData'), 'agent-hooks.json')
}

/**
 * bin/tabane の実パス。hooks からは絶対パスで叩く。
 * CLI をパスに通していない環境でも hook が確実に動くようにするため。
 */
function cliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'tabane')
    : join(app.getAppPath(), 'bin', 'tabane')
}

/**
 * hooks 設定を書き出す。ユーザーのリポジトリの .claude/settings.json は絶対に触らず、
 * このファイルを --settings で子プロセスにだけ渡す（tabane 外の作業に漏らさない）。
 *
 * $TABANE_PANE_ID は PTY の env に入れてあるので、hook のコマンド内で展開されて
 * 「どのペインからの申告か」が決まる。よって設定ファイルは全ペイン共通の1枚で足りる。
 */
function writeHooksSettings(): void {
  const report = (state: string): string =>
    `${JSON.stringify(cliPath())} report --pane "$TABANE_PANE_ID" --state ${state}`
  const settings = {
    hooks: {
      // 応答を終えた = そのタスクは一区切り
      Stop: [{ hooks: [{ type: 'command', command: report('done') }] }],
      // 入力待ち（権限確認を含む）になった
      Notification: [{ hooks: [{ type: 'command', command: report('needs_input') }] }]
    }
  }
  try {
    writeFileSync(hooksSettingsPath(), JSON.stringify(settings, null, 2))
  } catch {
    // 書けなくても tabane 自体は動く（状態が推測のみになる）
  }
}

/**
 * ペイン起動時にシェルが実行するコマンドを組み立てる。
 * プロンプトは TUI に流し込まず claude の起動引数として渡し切る。
 */
function buildInitialCommand(spec: OpenRequest): string | undefined {
  if (!spec.prompt) return undefined
  const args: string[] = ['--settings', shellQuote(hooksSettingsPath())]
  // strict は既定のまま（フラグを足さない）。yolo は現状受け付けない。
  if (spec.permission === 'edit') args.push('--permission-mode', 'acceptEdits')
  args.push(shellQuote(spec.prompt))
  return `claude ${args.join(' ')}`
}

async function handleOpen(spec: OpenRequest): Promise<TabaneResponse> {
  if (!mainWindow) return { ok: false, error: 'tabane のウィンドウが開いていない' }
  if (typeof spec.cwd !== 'string' || !spec.cwd) return { ok: false, error: '--cwd は必須' }

  const cwd = expandHome(spec.cwd)
  if (!existsSync(cwd)) return { ok: false, error: `cwd が存在しない: ${spec.cwd}` }

  if (spec.permission === 'yolo') {
    return { ok: false, error: 'yolo は未承認（仕様の残論点）。strict か edit を使って' }
  }
  if (spec.permission && !['strict', 'edit'].includes(spec.permission)) {
    return { ok: false, error: `不明な権限モード: ${spec.permission}` }
  }
  if (ptyManager.ids().length >= MAX_PANES) {
    return { ok: false, error: `ペイン数が上限（${MAX_PANES}）に達している` }
  }

  const specId = randomUUID()
  const title = spec.title || basename(cwd) || 'pane'

  try {
    const ptyId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSpawns.delete(specId)
        reject(new Error('ペイン生成がタイムアウトした'))
      }, SPAWN_TIMEOUT_MS)
      pendingSpawns.set(specId, { spec: { ...spec, cwd }, resolve, reject, timer })
      send('pane:spawn', { specId, title })
    })
    const paneNumber = paneNumberOf(ptyId)
    // claude を起動したペインは、hooks の最初の申告が来るまで running とみなす。
    // これが無いと、起動直後に wait されたとき「申告なし＝unknown」で即返ってしまう。
    if (spec.prompt) agentStates.set(paneNumber, 'running')
    return { ok: true, data: { id: paneNumber } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function handleList(): Promise<TabaneResponse> {
  const panes: PaneInfo[] = []
  for (const id of ptyManager.ids()) {
    const cwd = await ptyManager.cwdOf(id)
    panes.push({
      id: paneNumberOf(id),
      title: paneTitles.get(id) ?? '-',
      cwd: cwd ? shortenHome(cwd) : '-',
      agent: agentStates.get(paneNumberOf(id)) ?? null,
      pane: ptyManager.statusOf(id) ?? 'idle'
    })
  }
  return { ok: true, data: { panes } }
}

async function handleWait(req: WaitRequest): Promise<TabaneResponse> {
  const panes = Array.isArray(req.panes) ? req.panes.filter(Number.isInteger) : []
  if (panes.length === 0) return { ok: false, error: '待つペイン番号が指定されていない' }
  const sec =
    typeof req.timeout === 'number' && req.timeout > 0 ? req.timeout : DEFAULT_WAIT_TIMEOUT_SEC
  const results = await agentStates.wait(panes, sec * 1000)
  return { ok: true, data: { results } }
}

function handleKill(req: KillRequest): TabaneResponse {
  const ids = req.all
    ? ptyManager.ids()
    : (req.panes ?? []).filter(Number.isInteger).map((n) => `pty-${n}`)
  const targets = ids.filter((id) => ptyManager.has(id))
  if (targets.length === 0) return { ok: true, data: { killed: 0 } }

  if (mainWindow && !mainWindow.isDestroyed()) {
    // ペインごと閉じさせる。PTY の破棄は renderer の prune 経路が担うため、
    // ここで kill すると「死んだシェルの入ったペイン」が残ってしまう。
    send('pane:close', { ptyIds: targets })
  } else {
    for (const id of targets) ptyManager.kill(id)
  }
  return { ok: true, data: { killed: targets.length } }
}

function handleReport(req: ReportRequest): TabaneResponse {
  if (!Number.isInteger(req.pane)) return { ok: false, error: 'pane が不正' }
  agentStates.set(req.pane, req.state)
  return { ok: true }
}

async function handleCliRequest(req: TabaneRequest): Promise<TabaneResponse> {
  switch (req.cmd) {
    case 'open':
      return handleOpen(req)
    case 'list':
      return handleList()
    case 'wait':
      return handleWait(req)
    case 'kill':
      return handleKill(req)
    case 'report':
      return handleReport(req)
    default:
      return { ok: false, error: '不明なコマンド' }
  }
}

/**
 * socket を立てる。他のインスタンスが既に握っていれば諦める（多重起動時は先勝ち）。
 * CLI は常に「最初に起動した tabane」に繋がる。
 */
async function startSocketServer(): Promise<void> {
  const server = new SocketServer(join(app.getPath('userData'), 'tabane.sock'), handleCliRequest)
  socketServer = (await server.start()) ? server : null
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
    layoutRestore: cfg.layoutRestore ?? true,
    defaultCwd: cfg.defaultCwd ?? null
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

async function pickDefaultCwd(): Promise<void> {
  if (!mainWindow) return
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '起動フォルダを選択',
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return
  writeConfig({ defaultCwd: res.filePaths[0] })
  pushSettings()
}

/** 全ペインの緊急停止。誤爆すると走行中の作業ごと消えるため確認を挟む。 */
function killAllPanes(): void {
  const targets = ptyManager.ids()
  if (targets.length === 0 || !mainWindow) return
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['停止する', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: `${targets.length} 個のペインを全て停止する？`,
    detail: '実行中のエージェントも含めて、すべて終了します。'
  })
  if (choice !== 0) return
  send('pane:close', { ptyIds: targets })
}

/** tabane コマンドを PATH の通った場所へリンクする。失敗したら手順を案内する。 */
function installCli(): void {
  if (!mainWindow) return
  const src = cliPath()
  const dest = '/usr/local/bin/tabane'
  const manual = `ln -sf ${JSON.stringify(src)} /usr/local/bin/tabane`

  if (existsSync(dest)) {
    const overwrite = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['上書きする', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: `${dest} は既にある。上書きする？`
    })
    if (overwrite !== 0) return
  }

  try {
    if (!existsSync(dirname(dest))) throw new Error(`${dirname(dest)} が無い`)
    if (existsSync(dest)) unlinkSync(dest)
    symlinkSync(src, dest)
    void dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'インストールした',
      detail: `${dest} → ${src}\n\n新しいシェルから tabane が使える。`
    })
  } catch (e) {
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: '自動インストールできなかった',
      detail: `${e instanceof Error ? e.message : String(e)}\n\n手動で実行して：\n${manual}`
    })
  }
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
    currentOpacity: () => readConfig().backgroundOpacity ?? DEFAULT_OPACITY,
    onKillAllPanes: killAllPanes,
    onInstallCli: installCli
  })
}

app.whenReady().then(() => {
  registerIpc()
  refreshMenu()
  writeHooksSettings()
  createWindow()
  void startSocketServer()

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
  socketServer?.stop()
})
