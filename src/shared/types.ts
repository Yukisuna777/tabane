// main / preload / renderer で共有する型。IPC の契約書。

/** ペインの活動状態。glow するのは 'waiting'。 */
export type PaneStatus = 'idle' | 'busy' | 'waiting'

/** 分割方向。row=横並び（縦の仕切り）、col=縦積み（横の仕切り）。 */
export type SplitDir = 'row' | 'col'

export interface PtyCreateOptions {
  cwd?: string
  /** 明示 cwd が無いとき、この PTY の現在ディレクトリを継いで起動する（分割時のcwd継承）。 */
  inheritCwdFromPtyId?: string
  cols: number
  rows: number
}

/** main -> renderer : PTY からの出力 */
export interface PtyDataEvent {
  id: string
  data: string
}

/** main -> renderer : PTY 終了 */
export interface PtyExitEvent {
  id: string
  exitCode: number
}

/** main -> renderer : 返事待ち検知などの状態変化 */
export interface PtyStatusEvent {
  id: string
  status: PaneStatus
}

/** preload が contextBridge で renderer に公開する API */
export interface TabaneApi {
  createPty(opts: PtyCreateOptions): Promise<string>
  writePty(id: string, data: string): void
  resizePty(id: string, cols: number, rows: number): void
  killPty(id: string): void
  /** ユーザーがそのペインを見た/触った合図。waiting を解除する。 */
  focusPty(id: string): void
  onPtyData(cb: (e: PtyDataEvent) => void): () => void
  onPtyExit(cb: (e: PtyExitEvent) => void): () => void
  onPtyStatus(cb: (e: PtyStatusEvent) => void): () => void
}
