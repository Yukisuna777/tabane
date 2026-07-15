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
  offData: (() => void) | null
  disposed: boolean
}

const sessions = new Map<string, TermSession>()

// 背景色以外のテーマは固定。背景だけ「画像OFF=不透明 / 画像ON=alpha」で差し替える。
const THEME_BASE = {
  foreground: '#dde8ff', // 月明かりのテキスト
  cursor: '#a9d2ff', // Ice Blue
  selectionBackground: 'rgba(169,210,255,0.28)'
} as const
const OPAQUE_BG = '#0c1521'
let terminalBg: string = OPAQUE_BG

export function getSession(paneId: string): TermSession | undefined {
  return sessions.get(paneId)
}

/** 端末背景色を切り替える（画像ON時は alpha 付きにして背景画像を透かす）。
 *  既存・新規どちらの xterm にも反映する。 */
export function setTerminalBackground(color: string): void {
  terminalBg = color
  for (const session of sessions.values()) {
    session.term.options.theme = { ...THEME_BASE, background: color }
  }
}

interface AttachOptions {
  inheritCwdFromPtyId?: string
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
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    // 背景画像を透かすため常に true。false だと色付きセルに黒帯が焼き込まれ破綻する（fable実機確認）。
    allowTransparency: true,
    theme: { ...THEME_BASE, background: terminalBg }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)
  try {
    term.loadAddon(new WebglAddon())
  } catch {
    // WebGL 不可の環境では canvas レンダラにフォールバック
  }
  safeFit(fit)

  const session: TermSession = {
    paneId,
    term,
    fit,
    el,
    ptyId: null,
    offData: null,
    disposed: false,
    readyPromise: window.tabane.createPty({
      cols: term.cols || 80,
      rows: term.rows || 24,
      inheritCwdFromPtyId: opts.inheritCwdFromPtyId
    })
  }
  sessions.set(paneId, session)

  session.readyPromise.then((id) => {
    if (session.disposed) {
      window.tabane.killPty(id)
      return
    }
    session.ptyId = id
    session.offData = window.tabane.onPtyData((e) => {
      if (e.id === id) term.write(e.data)
    })
    term.onData((d) => window.tabane.writePty(id, d))
  })

  return session
}

/** container から外すだけ。dispose も kill もしない（再アタッチで復活する）。 */
export function detachTerminal(paneId: string): void {
  const session = sessions.get(paneId)
  if (session) session.el.remove()
}

/** layout に存在しない paneId のセッションを本当に破棄する（＝ペインを閉じたとき）。 */
export function pruneTerminals(alivePaneIds: Set<string>): void {
  for (const [paneId, session] of [...sessions.entries()]) {
    if (alivePaneIds.has(paneId)) continue
    session.disposed = true
    session.offData?.()
    if (session.ptyId) {
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
