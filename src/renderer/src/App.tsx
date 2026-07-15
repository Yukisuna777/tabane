import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackgroundState, PaneStatus, SplitDir } from '../../shared/types'
import {
  closePane,
  collectPaneIds,
  createPane,
  isLayoutNode,
  type LayoutNode,
  setSizes,
  setTitle,
  splitPane,
  stripInheritCwd
} from './layout'
import { SplitView } from './components/SplitView'
import { getSession, pruneTerminals, setTerminalBackground } from './terminalRegistry'

let paneCounter = 1

export function App(): JSX.Element {
  // 復元前は null。getLayout() で確定してから描画する（先走って端末を1つ余計に spawn しないため）
  const [layout, setLayout] = useState<LayoutNode | null>(null)
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [statusByPty, setStatusByPty] = useState<Record<string, PaneStatus>>({})
  const [bg, setBg] = useState<BackgroundState>({ dataUri: null, opacity: 0.2 })

  // 起動時：保存済みレイアウトを復元（無ければ新規1ペイン）。妥当性チェック＋
  // inheritCwdFromPtyId 剥がしを通す。
  useEffect(() => {
    window.tabane.getLayout().then((saved) => {
      const restored = isLayoutNode(saved) ? stripInheritCwd(saved) : null
      setLayout(restored ?? createPane('shell 1'))
    })
  }, [])

  // リサイズ（＝ドラッグ連打）だけ debounce 保存。構造変更は各ハンドラで即保存する。
  useEffect(() => {
    if (!layout) return
    const t = window.setTimeout(() => window.tabane.saveLayout(layout), 400)
    return () => window.clearTimeout(t)
  }, [layout])

  // 終了直前（debounce 未発火のまま quit）に取りこぼさないよう最新レイアウトを flush
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  useEffect(() => {
    const flush = (): void => {
      if (layoutRef.current) window.tabane.saveLayout(layoutRef.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // 背景画像：起動時に取得＋メニュー変更を購読
  useEffect(() => {
    window.tabane.getBackground().then(setBg)
    return window.tabane.onBackgroundChange(setBg)
  }, [])

  // 背景画像の ON/OFF で、ペイン半透明化（body クラス）と端末背景の alpha 化を切り替える
  useEffect(() => {
    const on = !!bg.dataUri
    document.body.classList.toggle('bg-image-on', on)
    setTerminalBackground(on ? 'rgba(12,21,33,0.38)' : '#0c1521')
  }, [bg.dataUri])

  // レイアウトが定まったら先頭ペインを active に
  useEffect(() => {
    if (layout && activePaneId === null) {
      const ids = collectPaneIds(layout)
      if (ids.length > 0) setActivePaneId(ids[0])
    }
  }, [layout, activePaneId])

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
    if (layout) pruneTerminals(new Set(collectPaneIds(layout)))
  }, [layout])

  // 構造変更は「即保存」する（デバウンスや終了時 flush に頼らず確実に残す）。
  const applyAndSave = useCallback((next: LayoutNode): void => {
    setLayout(next)
    window.tabane.saveLayout(next)
  }, [])

  const handleSplit = useCallback(
    (paneId: string, dir: SplitDir) => {
      const prev = layoutRef.current
      if (!prev) return
      paneCounter += 1
      const title = `shell ${paneCounter}`
      // 分割元シェルの cwd を新ペインに継がせる（元 PTY id を渡す）
      const srcPtyId = getSession(paneId)?.ptyId ?? undefined
      applyAndSave(splitPane(prev, paneId, dir, title, srcPtyId))
    },
    [applyAndSave]
  )

  const handleClose = useCallback(
    (paneId: string) => {
      const prev = layoutRef.current
      if (!prev) return
      applyAndSave(closePane(prev, paneId) ?? createPane('shell 1'))
    },
    [applyAndSave]
  )

  const handleTitle = useCallback(
    (paneId: string, title: string) => {
      const prev = layoutRef.current
      if (!prev) return
      applyAndSave(setTitle(prev, paneId, title))
    },
    [applyAndSave]
  )

  // リサイズは高頻度なので即保存せず、debounce 効果に任せる。
  const handleResize = useCallback((splitId: string, sizes: number[]) => {
    setLayout((prev) => (prev ? setSizes(prev, splitId, sizes) : prev))
  }, [])

  return (
    <>
      <div
        className="bg-layer"
        style={{
          backgroundImage: bg.dataUri ? `url(${bg.dataUri})` : 'none',
          opacity: bg.dataUri ? bg.opacity : 0
        }}
      />
      <div className="app">
        <div className="titlebar-drag" />
        {layout && (
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
        )}
      </div>
    </>
  )
}
