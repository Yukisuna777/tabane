import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaneStatus, SplitDir } from '../../shared/types'
import {
  closePane,
  collectPaneIds,
  createPane,
  type LayoutNode,
  setSizes,
  setTitle,
  splitPane
} from './layout'
import { SplitView } from './components/SplitView'
import { getSession, pruneTerminals } from './terminalRegistry'

let paneCounter = 1

export function App(): JSX.Element {
  const [layout, setLayout] = useState<LayoutNode>(() => createPane('shell 1'))
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [statusByPty, setStatusByPty] = useState<Record<string, PaneStatus>>({})

  // 初期ペインを active に
  useEffect(() => {
    const ids = collectPaneIds(layout)
    if (activePaneId === null && ids.length > 0) setActivePaneId(ids[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 状態変化を一括購読して ptyId => status に集約
  useEffect(() => {
    const off = window.tabane.onPtyStatus(({ id, status }) => {
      setStatusByPty((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }))
    })
    const offExit = window.tabane.onPtyExit(({ id }) => {
      setStatusByPty((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    })
    return () => {
      off()
      offExit()
    }
  }, [])

  // layout から消えた（＝閉じた）ペインの端末だけを本当に破棄する。
  // remount では detach するだけなので、分割・リサイズでは PTY は死なない。
  useEffect(() => {
    pruneTerminals(new Set(collectPaneIds(layout)))
  }, [layout])

  const handleSplit = useCallback((paneId: string, dir: SplitDir) => {
    paneCounter += 1
    const title = `shell ${paneCounter}`
    // 分割元シェルの cwd を新ペインに継がせる（元 PTY id を渡す）
    const srcPtyId = getSession(paneId)?.ptyId ?? undefined
    setLayout((prev) => splitPane(prev, paneId, dir, title, srcPtyId))
  }, [])

  const handleClose = useCallback((paneId: string) => {
    setLayout((prev) => {
      const next = closePane(prev, paneId)
      return next ?? createPane('shell 1')
    })
  }, [])

  const handleResize = useCallback((splitId: string, sizes: number[]) => {
    setLayout((prev) => setSizes(prev, splitId, sizes))
  }, [])

  const handleTitle = useCallback((paneId: string, title: string) => {
    setLayout((prev) => setTitle(prev, paneId, title))
  }, [])

  const activeRef = useRef(activePaneId)
  activeRef.current = activePaneId

  return (
    <div className="app">
      <div className="titlebar-drag" />
      <SplitView
        node={layout}
        activePaneId={activePaneId}
        statusByPty={statusByPty}
        onActivate={setActivePaneId}
        onSplit={handleSplit}
        onClose={handleClose}
        onResize={handleResize}
        onTitleChange={handleTitle}
      />
    </div>
  )
}
