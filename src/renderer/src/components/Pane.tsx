import { useCallback, useState } from 'react'
import type { PaneStatus, SplitDir } from '../../../shared/types'
import type { PaneNode } from '../layout'
import { TitleBar } from './TitleBar'
import { TerminalView } from './Terminal'

interface Props {
  node: PaneNode
  active: boolean
  statusByPty: Record<string, PaneStatus>
  onActivate: (paneId: string) => void
  onSplit: (paneId: string, dir: SplitDir) => void
  onClose: (paneId: string) => void
  onTitleChange: (paneId: string, title: string) => void
}

export function Pane({
  node,
  active,
  statusByPty,
  onActivate,
  onSplit,
  onClose,
  onTitleChange
}: Props): JSX.Element {
  const [ptyId, setPtyId] = useState<string | null>(null)
  const status: PaneStatus = ptyId ? statusByPty[ptyId] ?? 'idle' : 'idle'

  const activate = useCallback(() => {
    onActivate(node.id)
    if (ptyId) window.tabane.focusPty(ptyId)
  }, [node.id, ptyId, onActivate])

  const glow = status === 'waiting'

  return (
    <div
      className={`pane status-${status}${active ? ' active' : ''}${glow ? ' glow' : ''}`}
      onMouseDownCapture={activate}
    >
      <TitleBar
        title={node.title}
        status={status}
        onTitleChange={(t) => onTitleChange(node.id, t)}
        onSplit={(dir) => onSplit(node.id, dir)}
        onClose={() => onClose(node.id)}
      />
      <TerminalView active={active} onReady={setPtyId} onActivate={activate} />
    </div>
  )
}
