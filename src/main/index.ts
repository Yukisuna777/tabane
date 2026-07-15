import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { PtyManager } from './ptyManager.js'
import type { PtyCreateOptions } from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
}

app.whenReady().then(() => {
  registerIpc()
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
