// xterm インスタンスと PTY を React のマウント位置から切り離して永続化するレジストリ。
//
// 分割やリサイズでレイアウト木が組み変わると、既存ペインは DOM 上を移動し React に
// unmount→remount される。もし xterm/PTY をコンポーネント内で持つと、その度にシェルが
// 作り直されてしまう（＝分割元のリセット）。そこで paneId をキーに module シングルトンで
// 保持し、コンポーネントは「永続 host div を自分の container に付け外しするだけ」にする。
// 破棄は App が layout 差分で prune する1経路だけ（＝ペインを閉じたときのみ）。

import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

export interface TermSession {
  paneId: string
  term: Xterm
  fit: FitAddon
  /** 永続 host。term.open(el) は生涯1回だけ。付け替えは el ごと移動する。 */
  el: HTMLDivElement
  ptyId: string | null
  /** createPty の結果。再アタッチ時は resolve 済みで即発火。 */
  readyPromise: Promise<string>
  disposed: boolean
  /** 現在ロード中の WebGL addon。コンテキスト喪失で張り替えるため保持する。 */
  webgl: WebglAddon | null
}

const sessions = new Map<string, TermSession>()
// ptyId -> session。pty:data の振り分け用（グローバル1リスナー方式）。
const byPtyId = new Map<string, TermSession>()

// pty:data はペインごとに購読するとペイン数ぶんリスナーが増える（MaxListeners 警告の原因）。
// グローバルに1個だけ購読して id で振り分ける ＝ 何ペインでもリスナー1個。
const offGlobalData = window.tabane.onPtyData((e) => {
  byPtyId.get(e.id)?.term.write(e.data)
})
// dev の HMR で本モジュールが再評価されると古いリスナーが残るため、破棄時に解除する。
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot
if (hot) hot.dispose(() => offGlobalData())

// テーマ×背景画像ON/OFF で端末テーマを組み立てる（fable 設計・brand 由来の値）。
const THEME_BASES = {
  dark: {
    foreground: '#dde8ff', // 月明かりのテキスト
    cursor: '#a9d2ff', // Ice Blue
    selectionBackground: 'rgba(169,210,255,0.28)'
  },
  light: {
    foreground: '#26324a', // brand text-primary
    cursor: '#3f638f', // ライトで見える Ice（原色は薄すぎ）
    selectionBackground: 'rgba(117,154,198,0.30)'
  }
} as const
// ライトでは ANSI の黄/白がほぼ見えないので最低限だけ暗く上書き
const LIGHT_ANSI = {
  yellow: '#9a6a10',
  brightYellow: '#b5791b',
  white: '#8a94a8',
  brightWhite: '#5c6680'
} as const

type ThemeMode = 'light' | 'dark'
let currentTheme: ThemeMode = 'dark'
let terminalFontSize = 13

function computeTheme(): Record<string, string> {
  const base = THEME_BASES[currentTheme]
  const ansi = currentTheme === 'light' ? LIGHT_ANSI : {}
  // 端末背景は常に透明。下のペイン面(--panel / 画像ON時は --glass-pane)を透かして
  // 「入力エリア(端末)」と「ペインの縁」を同一色にする（画像の透け具合も揃う）。
  return { ...base, ...ansi, background: 'rgba(0,0,0,0)' }
}

/**
 * WebGL コンテキストの張り直し上限。これを超えたら諦めて DOM レンダラで走り続ける。
 * GPU が本当に死んでいる環境で無限リトライして CPU を焼かないための蓋。
 */
const WEBGL_MAX_RETRY = 3
/** 張り直しまでの待ち。喪失直後は GPU プロセスがまだ復帰していないことがある。 */
const WEBGL_RELOAD_MS = 300

/**
 * WebGL レンダラを「壊れる前提」で張る。
 *
 * xterm.js は onContextLoss で addon を dispose() することを必須手順としている。
 * 購読しないと、OS スリープ復帰・GPU プロセスのクラッシュ・ディスプレイ切替で
 * コンテキストが失われたあとも死んだコンテキストに描き続け、画面がゴミのまま固定される。
 */
function loadWebgl(session: TermSession, attempt = 0): void {
  if (session.disposed || attempt > WEBGL_MAX_RETRY) return
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      addon.dispose() // 死んだコンテキストに描き続けさせない
      if (session.webgl === addon) session.webgl = null
      window.setTimeout(() => loadWebgl(session, attempt + 1), WEBGL_RELOAD_MS)
    })
    session.term.loadAddon(addon)
    session.webgl = addon
  } catch {
    // WebGL 不可の環境では DOM レンダラのまま走る
  }
}

/**
 * 全端末のグリフキャッシュ（テクスチャアトラス）を捨てて描き直す。
 *
 * アトラスは同一フォント設定の端末間で共有されるため、1枚壊れると全ペインが道連れになる。
 * ＝ここを一括で捨てるのが、化けに対する唯一の効く手当て。
 */
export function redrawAllTerminals(): void {
  for (const session of sessions.values()) {
    try {
      session.term.clearTextureAtlas()
    } catch {
      // DOM レンダラ時など、アトラスを持たない場合は何もしなくてよい
    }
  }
}

export function getSession(paneId: string): TermSession | undefined {
  return sessions.get(paneId)
}

/** 端末のフォントサイズを全ペインに反映して再フィットする。 */
export function setTerminalFontSize(size: number): void {
  terminalFontSize = size
  for (const session of sessions.values()) {
    session.term.options.fontSize = size
    try {
      session.fit.fit()
    } catch {
      // サイズ未確定時は無視
    }
    if (session.ptyId) {
      window.tabane.resizePty(session.ptyId, session.term.cols, session.term.rows)
    }
  }
}

/** テーマ（ライト/ダーク）を端末全体に反映する（背景は常に透明でペイン面を透かす）。 */
export function setTerminalTheme(theme: ThemeMode): void {
  currentTheme = theme
  const t = computeTheme()
  for (const session of sessions.values()) {
    session.term.options.theme = t
  }
}

interface AttachOptions {
  /** 前回終了時に記憶していた cwd。あればここでシェルを起こす。 */
  cwd?: string
  inheritCwdFromPtyId?: string
  /** `tabane open` 由来のペイン。main がこの ID で cwd と起動コマンドを解決する。 */
  spawnSpecId?: string
}

// PTY が出来た合図。App が「ptyId とタイトルの対応」を main へ同期するのに使う
// （Props を増やさずに済むよう、モジュールシングルトンで受け渡す）。
let sessionReadyListener: (() => void) | null = null

export function setSessionReadyListener(cb: (() => void) | null): void {
  sessionReadyListener = cb
}

/** container に、そのペインの端末を（無ければ生成して）アタッチする。 */
export function attachTerminal(
  paneId: string,
  container: HTMLElement,
  opts: AttachOptions = {}
): TermSession {
  const existing = sessions.get(paneId)
  if (existing) {
    container.appendChild(existing.el)
    reflow(existing)
    return existing
  }

  const el = document.createElement('div')
  el.style.width = '100%'
  el.style.height = '100%'
  container.appendChild(el)

  const term = new Xterm({
    fontFamily: '"HackGen Console NF", "MesloLGS NF", Menlo, monospace',
    fontSize: terminalFontSize,
    cursorBlink: true,
    allowProposedApi: true,
    // 背景画像を透かすため常に true。false だと色付きセルに黒帯が焼き込まれ破綻する（fable実機確認）。
    allowTransparency: true,
    // OSC 8 ハイパーリンクの既定挙動（confirm→window.open()＝about:blank）を潰し、
    // 本物の URL を既定ブラウザで直接開く。
    linkHandler: {
      activate: (_event, uri) => window.tabane.openExternal(uri)
    },
    theme: computeTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)

  // Shift+Enter を改行として送る。素の xterm は Shift+Enter も Enter も同じ CR(\r) を
  // 送るため、Claude Code など「Enter=送信・Shift+Enter=改行」を区別する CLI で改行できない。
  // ESC+CR(\x1b\r) を送ると Claude Code が Alt/Option+Enter＝改行挿入として解釈する
  // （kitty keyboard protocol のネゴ不要なので xterm でも確実に効く）。
  // 肝は preventDefault：return false は xterm 内部処理を止めるだけで、これが無いと
  // 非表示 textarea への既定の改行(=CR)が別経路で送られ「送信」に化ける。
  //
  // 変換中（IME 合成中）は素通しする。xterm はカスタムキーハンドラを composition 処理より
  // 先に呼び、false を返すとその場で打ち切る。ここで握ると未確定の日本語が確定されないまま
  // 改行だけが PTY に飛び、確定文字が丸ごと消える（macOS の Chromium は変換中の keydown にも
  // e.key に実キー値を入れてくるため、キー名だけでは見分けられない）。
  term.attachCustomKeyEventHandler((e) => {
    // keyCode 229 は IME 処理中を表す古くからの合図。isComposing の取りこぼし対策に併用する。
    if (e.isComposing || e.keyCode === 229) return true
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const id = session.ptyId
      if (id) window.tabane.writePty(id, '\x1b\r')
      return false
    }
    return true
  })
  safeFit(fit)

  const session: TermSession = {
    paneId,
    term,
    fit,
    el,
    ptyId: null,
    disposed: false,
    webgl: null,
    readyPromise: window.tabane.createPty({
      cols: term.cols || 80,
      rows: term.rows || 24,
      cwd: opts.cwd,
      inheritCwdFromPtyId: opts.inheritCwdFromPtyId,
      spawnSpecId: opts.spawnSpecId
    })
  }
  sessions.set(paneId, session)
  // session が要るので open/fit のあとに張る（喪失時に自分を張り直せるようにするため）。
  loadWebgl(session)

  session.readyPromise.then((id) => {
    if (session.disposed) {
      window.tabane.killPty(id)
      return
    }
    session.ptyId = id
    byPtyId.set(id, session) // グローバルの pty:data 振り分けに登録
    term.onData((d) => window.tabane.writePty(id, d))
    sessionReadyListener?.()
  })

  return session
}

/** container から外すだけ。dispose も kill もしない（再アタッチで復活する）。 */
export function detachTerminal(paneId: string): void {
  const session = sessions.get(paneId)
  if (!session) return
  // DOM から外す前に必ず blur する。
  //
  // 理由1（確定文字の消失）: xterm は確定テキストを setTimeout(0) 越しに textarea から読むが、
  // blur ハンドラは textarea を空にする。順序を握らないと「変換中に分割ボタンを押した」瞬間に
  // 確定文字が空文字として読まれて消える。先に blur しておけば確定→送出→blur の順が保証される。
  // 理由2（合成状態のスタック）: Chromium はフォーカス中の要素が DOM から外れても blur を
  // 発火しないため、_isComposing が true のまま固まり以後の IME 入力を飲み込むことがある。
  try {
    session.term.blur()
  } catch {
    // 破棄済みなど。外すこと自体は続行する
  }
  session.el.remove()
}

/** layout に存在しない paneId のセッションを本当に破棄する（＝ペインを閉じたとき）。 */
export function pruneTerminals(alivePaneIds: Set<string>): void {
  for (const [paneId, session] of [...sessions.entries()]) {
    if (alivePaneIds.has(paneId)) continue
    session.disposed = true
    if (session.ptyId) {
      byPtyId.delete(session.ptyId)
      window.tabane.killPty(session.ptyId)
    } else {
      // まだ生成中：resolve したら即 kill する
      session.readyPromise.then((id) => window.tabane.killPty(id))
    }
    try {
      session.term.dispose()
    } catch {
      // 二重 dispose 等は無視
    }
    session.el.remove()
    sessions.delete(paneId)
  }
}

function reflow(session: TermSession): void {
  safeFit(session.fit)
  if (session.ptyId) {
    window.tabane.resizePty(session.ptyId, session.term.cols, session.term.rows)
  }
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit()
  } catch {
    // サイズ未確定時は握りつぶす
  }
}
