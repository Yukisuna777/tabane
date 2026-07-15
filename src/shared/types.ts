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

export type ThemeMode = 'light' | 'dark'

/** 背景画像の表示状態。main が画像を data URI 化して renderer に渡す。 */
export interface BackgroundState {
  /** 表示用 data URI（未設定なら null） */
  dataUri: string | null
  /** 画像レイヤの不透明度 0..1 */
  opacity: number
  /** 画像レイヤの blur(px) */
  blur: number
}

/** アプリ全体の設定（設定GUI・メニューが編集し config.json に永続化） */
export interface AppSettings {
  background: BackgroundState
  fontSize: number
  theme: ThemeMode
  /** 起動時に前回レイアウトを復元するか */
  layoutRestore: boolean
}

/** 設定GUI から渡すスカラー設定のパッチ */
export interface SettingsPatch {
  backgroundOpacity?: number
  backgroundBlur?: number
  fontSize?: number
  theme?: ThemeMode
  layoutRestore?: boolean
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
  /** 現在の設定を取得（起動時に renderer から取りに来る） */
  getSettings(): Promise<AppSettings>
  /** メニュー/設定GUI で設定が変わったときの通知 */
  onSettingsChange(cb: (s: AppSettings) => void): () => void
  /** スカラー設定のパッチ更新（不透明度・blur・フォント・テーマ・復元） */
  updateSettings(patch: SettingsPatch): void
  /** 背景画像をファイルダイアログで選ぶ／クリアする（main 側で永続化） */
  pickBackground(): void
  clearBackground(): void
  /** メニューの「設定…」で設定GUIを開く合図 */
  onOpenSettings(cb: () => void): () => void
  /** 復元用レイアウトの取得・保存（中身は renderer の LayoutNode JSON） */
  getLayout(): Promise<unknown>
  saveLayout(layout: unknown): void
}
