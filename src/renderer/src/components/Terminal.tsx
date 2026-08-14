import { useEffect, useRef } from 'react'
import { attachTerminal, detachTerminal, getSession } from '../terminalRegistry'

interface Props {
  paneId: string
  active: boolean
  /** 分割元シェルの cwd を継ぐための元 PTY id（初回ペインは無し） */
  inheritCwdFromPtyId?: string
  /** `tabane open` 由来のペインなら、main が起動スペックを引くための ID */
  spawnSpecId?: string
  /** PTY が生成できたら親に通知（status 紐付け・focus 用） */
  onReady: (ptyId: string) => void
  onActivate: () => void
}

export function TerminalView({
  paneId,
  active,
  inheritCwdFromPtyId,
  spawnSpecId,
  onReady,
  onActivate
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 永続レジストリに端末を付ける（無ければ生成、あれば DOM を移すだけ）。
    // remount で PTY/xterm は死なない ＝ 分割元シェルがリセットされない。
    const session = attachTerminal(paneId, container, { inheritCwdFromPtyId, spawnSpecId })

    let cancelled = false
    session.readyPromise.then((id) => {
      if (!cancelled) onReady(id)
    })

    const ro = new ResizeObserver(() => {
      try {
        session.fit.fit()
      } catch {
        return
      }
      if (session.ptyId) {
        window.tabane.resizePty(session.ptyId, session.term.cols, session.term.rows)
      }
    })
    ro.observe(container)

    return () => {
      cancelled = true
      ro.disconnect()
      detachTerminal(paneId) // 外すだけ。破棄は App の prune が担う。
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId])

  // active になったら xterm にフォーカスを移す
  useEffect(() => {
    if (active) getSession(paneId)?.term.focus()
  }, [active, paneId])

  return <div ref={containerRef} className="terminal-host" onMouseDown={onActivate} />
}
