import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  PtyCreateOptions,
  PtyDataEvent,
  PtyExitEvent,
  PtyStatusEvent,
  TabaneApi
} from '../shared/types.js'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: TabaneApi = {
  createPty: (opts: PtyCreateOptions) => ipcRenderer.invoke('pty:create', opts),
  writePty: (id, data) => ipcRenderer.send('pty:write', id, data),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  killPty: (id) => ipcRenderer.send('pty:kill', id),
  focusPty: (id) => ipcRenderer.send('pty:focus', id),
  onPtyData: (cb) => subscribe<PtyDataEvent>('pty:data', cb),
  onPtyExit: (cb) => subscribe<PtyExitEvent>('pty:exit', cb),
  onPtyStatus: (cb) => subscribe<PtyStatusEvent>('pty:status', cb)
}

contextBridge.exposeInMainWorld('tabane', api)
