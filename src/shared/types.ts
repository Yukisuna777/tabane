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
  /**
   * `tabane open` が予約した起動スペックの ID。
   * renderer は中身を知らず持ち回るだけで、cwd や起動コマンドの解決は main が行う。
   */
  spawnSpecId?: string
}

/** main -> renderer : CLI から要求されたペイン生成 */
export interface PaneSpawnEvent {
  /** createPty に渡し返してもらう。main はこれで起動スペックを引く。 */
  specId: string
  title: string
}

/** renderer -> main : ペイン一覧の同期（`tabane list` の TITLE 用）。 */
export interface PaneSyncEntry {
  ptyId: string
  title: string
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
  /** 起動時にシェルを開くフォルダ（null なら ~/ ホーム） */
  defaultCwd: string | null
}

/** 設定GUI から渡すスカラー設定のパッチ */
export interface SettingsPatch {
  backgroundOpacity?: number
  backgroundBlur?: number
  fontSize?: number
  theme?: ThemeMode
  layoutRestore?: boolean
}

// ================================================================
// tabane CLI ⇄ main の socket プロトコル（JSON Lines）。
// 1行 = 1メッセージ。リクエストを送ると同じ接続でレスポンスが1つ返る。
// bin/tabane は素の Node スクリプトでこの型を import しないため、
// ここは「実装が従うべき契約書」として置く（両側で形を揃える）。
// ================================================================

/** エージェント（子 claude）の申告状態。ペイン状態(PaneStatus)とは別軸。 */
export type AgentState = 'running' | 'done' | 'needs_input' | 'closed'

/** 子セッションの権限。strict=既定 / edit=編集のみ自動 / yolo=全自動。 */
export type PermissionMode = 'strict' | 'edit' | 'yolo'

export interface OpenRequest {
  cmd: 'open'
  cwd: string
  /** 省略時は claude を起動せずシェルだけ開く。 */
  prompt?: string
  title?: string
  permission?: PermissionMode
}

export interface ListRequest {
  cmd: 'list'
}

export interface WaitRequest {
  cmd: 'wait'
  /** 待つペイン番号（ptyId の連番部分）。 */
  panes: number[]
  /** 秒。切れてもエラーにせず現在の状態を返す。 */
  timeout?: number
}

export interface KillRequest {
  cmd: 'kill'
  panes?: number[]
  all?: boolean
}

/** hooks から呼ばれる内部向け。人間・指揮役が直接使う想定はしない。 */
export interface ReportRequest {
  cmd: 'report'
  pane: number
  state: AgentState
}

export type TabaneRequest =
  | OpenRequest
  | ListRequest
  | WaitRequest
  | KillRequest
  | ReportRequest

/** list の1行ぶん。 */
export interface PaneInfo {
  /** ペイン番号（ptyId の連番部分）。 */
  id: number
  title: string
  cwd: string
  /** hooks 未申告（素のシェル等）は null。 */
  agent: AgentState | null
  pane: PaneStatus
}

/** wait の結果1件。hooks を持たないペイン（素のシェル等）は 'unknown'。 */
export interface WaitResult {
  id: number
  state: AgentState | 'unknown'
}

export type TabaneResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

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
  /** 起動フォルダをダイアログで選ぶ／ホーム(既定)に戻す */
  pickDefaultCwd(): void
  clearDefaultCwd(): void
  /** メニューの「設定…」で設定GUIを開く合図 */
  onOpenSettings(cb: () => void): () => void
  /** 復元用レイアウトの取得・保存（中身は renderer の LayoutNode JSON） */
  getLayout(): Promise<unknown>
  saveLayout(layout: unknown): void
  /** 端末内リンクを既定ブラウザで開く（http(s) のみ。main で shell.openExternal） */
  openExternal(url: string): void
  /** CLI（tabane open）から要求されたペイン生成の通知 */
  onPaneSpawn(cb: (e: PaneSpawnEvent) => void): () => void
  /** CLI（tabane kill）から要求されたペイン終了の通知。ptyId で対象を指す。 */
  onPaneClose(cb: (e: { ptyIds: string[] }) => void): () => void
  /** ペイン一覧（ptyId とタイトル）を main に同期する。tabane list が使う。 */
  syncPanes(panes: PaneSyncEntry[]): void
}
