import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, PaneStatus, SplitDir } from '../../shared/types'
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
import { SettingsModal } from './components/SettingsModal'
import {
  getSession,
  pruneTerminals,
  setTerminalFontSize,
  setTerminalTheme
} from './terminalRegistry'

let paneCounter = 1

/** 上バー中央のロゴ（束ねマーク）。Ice=返事待ち / Orange=通知 の2状態を象徴。 */
function LogoMark(): JSX.Element {
  return (
    <svg className="topbar-mark" viewBox="300 236 424 576" fill="none" aria-hidden="true">
      <defs>
        <filter id="tb-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="10" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g stroke="#cdd8f2" strokeWidth="22" strokeLinecap="round" fill="none" opacity="0.92">
        <path d="M326 300 C326 450 470 410 470 560 C470 650 455 702 455 792" />
        <path d="M512 256 C512 406 512 410 512 560 C512 650 512 702 512 792" />
        <path d="M605 268 C605 418 533 410 533 560 C533 650 541 702 541 792" />
      </g>
      <path
        d="M419 268 C419 418 491 410 491 560 C491 650 483 702 483 792"
        stroke="#a9d2ff"
        strokeWidth="24"
        strokeLinecap="round"
        fill="none"
        filter="url(#tb-glow)"
      />
      <path
        d="M698 300 C698 450 554 410 554 560 C554 650 569 702 569 792"
        stroke="#ffb057"
        strokeWidth="24"
        strokeLinecap="round"
        fill="none"
        filter="url(#tb-glow)"
      />
      <rect x="432" y="534" width="160" height="52" rx="26" fill="#e6ecfa" />
    </svg>
  )
}

const DEFAULT_SETTINGS: AppSettings = {
  background: { dataUri: null, opacity: 0.2, blur: 2 },
  fontSize: 13,
  theme: 'dark',
  layoutRestore: true,
  defaultCwd: null
}

export function App(): JSX.Element {
  // 復元前は null。設定＋レイアウトが確定してから描画する（余計な端末を spawn しないため）
  const [layout, setLayout] = useState<LayoutNode | null>(null)
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [statusByPty, setStatusByPty] = useState<Record<string, PaneStatus>>({})
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // 起動時：設定とレイアウトをまとめて取得。layoutRestore が ON のときだけ復元。
  useEffect(() => {
    Promise.all([window.tabane.getSettings(), window.tabane.getLayout()]).then(([s, saved]) => {
      setSettings(s)
      const restored = s.layoutRestore && isLayoutNode(saved) ? stripInheritCwd(saved) : null
      setLayout(restored ?? createPane('shell 1'))
    })
    return window.tabane.onSettingsChange(setSettings)
  }, [])

  // メニュー「設定…」/ cmd+, で設定モーダルを開く
  useEffect(() => window.tabane.onOpenSettings(() => setSettingsOpen(true)), [])

  // テーマを data-theme に反映
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  // フォントサイズを全端末に反映
  useEffect(() => {
    setTerminalFontSize(settings.fontSize)
  }, [settings.fontSize])

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

  // 背景画像の ON/OFF でペイン半透明化（body クラス）、テーマで端末テーマを切り替える
  useEffect(() => {
    const on = !!settings.background.dataUri
    document.body.classList.toggle('bg-image-on', on)
  }, [settings.background.dataUri])

  useEffect(() => {
    setTerminalTheme(settings.theme)
  }, [settings.theme])

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

  const { background } = settings

  return (
    <>
      <div
        className="bg-layer"
        style={{
          backgroundImage: background.dataUri ? `url(${background.dataUri})` : 'none',
          opacity: background.dataUri ? background.opacity : 0,
          filter: `blur(${background.blur}px)`
        }}
      />
      <div className="app">
        <div className="topbar">
          <div className="topbar-brand">
            <LogoMark />
            <span className="topbar-title">tabane</span>
          </div>
        </div>
        <div className="app-body">
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
      </div>
      {settingsOpen && (
        <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  )
}
