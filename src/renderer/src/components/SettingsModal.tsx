import { useEffect } from 'react'
import type { AppSettings, ThemeMode } from '../../../shared/types'

interface Props {
  settings: AppSettings
  onClose: () => void
}

const FONT_MIN = 9
const FONT_MAX = 24

export function SettingsModal({ settings, onClose }: Props): JSX.Element {
  // Esc で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { background, fontSize, theme, layoutRestore, defaultCwd } = settings
  const hasImage = !!background.dataUri
  const update = window.tabane.updateSettings
  // フルパスは title に、表示はフォルダ名だけ（長いパスで崩れないように）
  const cwdLabel = defaultCwd
    ? defaultCwd.split('/').filter(Boolean).slice(-1)[0]
    : '~/（ホーム）'

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>設定</h2>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ✕
          </button>
        </div>

        {/* テーマ */}
        <section className="setting-row">
          <label>テーマ</label>
          <div className="segmented">
            {(['light', 'dark'] as ThemeMode[]).map((t) => (
              <button
                key={t}
                className={theme === t ? 'active' : ''}
                onClick={() => update({ theme: t })}
              >
                {t === 'light' ? 'ライト' : 'ダーク'}
              </button>
            ))}
          </div>
        </section>

        {/* フォントサイズ */}
        <section className="setting-row">
          <label>フォントサイズ</label>
          <div className="slider-group">
            <input
              type="range"
              min={FONT_MIN}
              max={FONT_MAX}
              value={fontSize}
              onChange={(e) => update({ fontSize: Number(e.target.value) })}
            />
            <span className="slider-val">{fontSize}px</span>
          </div>
        </section>

        {/* レイアウト復元 */}
        <section className="setting-row">
          <label>起動時にレイアウトを復元</label>
          <button
            className={`toggle ${layoutRestore ? 'on' : ''}`}
            onClick={() => update({ layoutRestore: !layoutRestore })}
            role="switch"
            aria-checked={layoutRestore}
          >
            <span className="knob" />
          </button>
        </section>

        {/* 起動フォルダ */}
        <section className="setting-row">
          <label>起動フォルダ</label>
          <div className="bg-actions">
            <button onClick={() => window.tabane.pickDefaultCwd()}>選択…</button>
            <button onClick={() => window.tabane.clearDefaultCwd()} disabled={!defaultCwd}>
              ホーム
            </button>
            <span className="bg-status" title={defaultCwd ?? '~/'}>
              {cwdLabel}
            </span>
          </div>
        </section>

        <div className="setting-divider" />

        {/* 背景画像 */}
        <section className="setting-row">
          <label>背景画像</label>
          <div className="bg-actions">
            <button onClick={() => window.tabane.pickBackground()}>選択…</button>
            <button onClick={() => window.tabane.clearBackground()} disabled={!hasImage}>
              クリア
            </button>
            <span className="bg-status">{hasImage ? '設定中' : 'なし'}</span>
          </div>
        </section>

        <section className="setting-row sub">
          <label>不透明度</label>
          <div className="slider-group">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(background.opacity * 100)}
              disabled={!hasImage}
              onChange={(e) => update({ backgroundOpacity: Number(e.target.value) / 100 })}
            />
            <span className="slider-val">{Math.round(background.opacity * 100)}%</span>
          </div>
        </section>

        <section className="setting-row sub">
          <label>ぼかし</label>
          <div className="slider-group">
            <input
              type="range"
              min={0}
              max={12}
              value={background.blur}
              disabled={!hasImage}
              onChange={(e) => update({ backgroundBlur: Number(e.target.value) })}
            />
            <span className="slider-val">{background.blur}px</span>
          </div>
        </section>
      </div>
    </div>
  )
}
