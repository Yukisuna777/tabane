import type { PaneStatus, SplitDir } from '../../../shared/types'

interface Props {
  title: string
  status: PaneStatus
  /** 最後に観測した再開コマンド。あればチップで提示する（実行はしない）。 */
  resume?: string
  onTitleChange: (title: string) => void
  onSplit: (dir: SplitDir) => void
  onClose: () => void
  /** チップのクリック。端末にコマンドを入力するだけで、改行は送らない。 */
  onResume: () => void
}

const STATUS_LABEL: Record<PaneStatus, string> = {
  idle: '待機',
  busy: '実行中',
  waiting: '要確認'
}

export function TitleBar({
  title,
  status,
  resume,
  onTitleChange,
  onSplit,
  onClose,
  onResume
}: Props): JSX.Element {
  return (
    <div className={`title-bar status-${status}`}>
      <span className={`status-dot status-${status}`} title={STATUS_LABEL[status]} />
      <input
        className="title-input"
        value={title}
        spellCheck={false}
        placeholder="タイトル"
        onChange={(e) => onTitleChange(e.target.value)}
        // タイトル編集中のキーは端末に流さない
        onKeyDown={(e) => e.stopPropagation()}
      />
      {resume && (
        <button
          className="resume-chip"
          // 完全な ID はツールチップで見せる（チップ本体は狭いので出さない）。
          title={`${resume}\n（クリックで端末に入力。実行はされない）`}
          onClick={onResume}
        >
          ⟲ resume
        </button>
      )}
      <div className="title-actions">
        <button title="縦に分割" onClick={() => onSplit('row')}>
          ▯▯
        </button>
        <button title="横に分割" onClick={() => onSplit('col')}>
          ▤
        </button>
        <button title="閉じる" className="close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  )
}
