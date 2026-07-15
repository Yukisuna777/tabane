import { useRef } from 'react'
import type { PaneStatus, SplitDir } from '../../../shared/types'
import type { LayoutNode } from '../layout'
import { Pane } from './Pane'

interface Props {
  node: LayoutNode
  activePaneId: string | null
  statusByPty: Record<string, PaneStatus>
  onActivate: (paneId: string) => void
  onSplit: (paneId: string, dir: SplitDir) => void
  onClose: (paneId: string) => void
  onResize: (splitId: string, sizes: number[]) => void
  onTitleChange: (paneId: string, title: string) => void
}

const MIN_PCT = 10

export function SplitView(props: Props): JSX.Element {
  const { node } = props

  if (node.kind === 'pane') {
    return (
      <Pane
        node={node}
        active={props.activePaneId === node.id}
        statusByPty={props.statusByPty}
        onActivate={props.onActivate}
        onSplit={props.onSplit}
        onClose={props.onClose}
        onTitleChange={props.onTitleChange}
      />
    )
  }

  const isRow = node.dir === 'row'
  const containerRef = useRef<HTMLDivElement>(null)

  const startDrag = (dividerIndex: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const total = isRow ? rect.width : rect.height
    const startSizes = [...node.sizes]
    const startPos = isRow ? e.clientX : e.clientY
    const a = dividerIndex
    const b = dividerIndex + 1
    const pairPct = startSizes[a] + startSizes[b]

    const onMove = (ev: PointerEvent): void => {
      const pos = isRow ? ev.clientX : ev.clientY
      const deltaPct = ((pos - startPos) / total) * 100
      let aPct = startSizes[a] + deltaPct
      let bPct = startSizes[b] - deltaPct
      if (aPct < MIN_PCT) {
        aPct = MIN_PCT
        bPct = pairPct - MIN_PCT
      }
      if (bPct < MIN_PCT) {
        bPct = MIN_PCT
        aPct = pairPct - MIN_PCT
      }
      const next = [...startSizes]
      next[a] = aPct
      next[b] = bPct
      props.onResize(node.id, next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className="split"
      style={{ flexDirection: isRow ? 'row' : 'column' }}
    >
      {node.children.map((child, i) => (
        <div key={child.id} style={{ display: 'contents' }}>
          {/* サイズは flex-grow の「比率」で持たせる（flex-basis:0）。こうすると仕切り(divider)の
              固定幅が先に引かれ、残りをセルが比率で分けるので合計がはみ出さない。 */}
          <div className="split-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            <SplitView {...props} node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`divider ${isRow ? 'divider-v' : 'divider-h'}`}
              onPointerDown={startDrag(i)}
            />
          )}
        </div>
      ))}
    </div>
  )
}
