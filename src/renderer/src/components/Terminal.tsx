import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

interface Props {
  active: boolean
  /** PTY が生成できたら親に通知（status 紐付け・focus 用） */
  onReady: (ptyId: string) => void
  onActivate: () => void
}

export function TerminalView({ active, onReady, onActivate }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const ptyIdRef = useRef<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Xterm({
      fontFamily: '"HackGen Console NF", "MesloLGS NF", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#0e1512',
        foreground: '#d7e4dd',
        cursor: '#3ddc97',
        selectionBackground: 'rgba(61,220,151,0.28)'
      }
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL 不可の環境では canvas レンダラにフォールバック
    }
    try {
      fit.fit()
    } catch {
      // 初回サイズ未確定時は握りつぶす
    }

    let disposed = false
    let offData: (() => void) | null = null

    window.tabane
      .createPty({ cols: term.cols || 80, rows: term.rows || 24 })
      .then((id) => {
        if (disposed) {
          window.tabane.killPty(id)
          return
        }
        ptyIdRef.current = id
        onReady(id)
        offData = window.tabane.onPtyData((e) => {
          if (e.id === id) term.write(e.data)
        })
        term.onData((d) => window.tabane.writePty(id, d))
      })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (ptyIdRef.current) {
        window.tabane.resizePty(ptyIdRef.current, term.cols, term.rows)
      }
    })
    ro.observe(container)

    return () => {
      disposed = true
      ro.disconnect()
      offData?.()
      if (ptyIdRef.current) window.tabane.killPty(ptyIdRef.current)
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // active になったら xterm にフォーカスを移す
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div
      ref={containerRef}
      className="terminal-host"
      onMouseDown={onActivate}
    />
  )
}
