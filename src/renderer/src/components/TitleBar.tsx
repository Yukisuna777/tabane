import type { PaneStatus, SplitDir } from '../../../shared/types'

interface Props {
  title: string
  status: PaneStatus
  onTitleChange: (title: string) => void
  onSplit: (dir: SplitDir) => void
  onClose: () => void
}

const STATUS_LABEL: Record<PaneStatus, string> = {
  idle: '待機',
  busy: '実行中',
  waiting: '要確認'
}

export function TitleBar({ title, status, onTitleChange, onSplit, onClose }: Props): JSX.Element {
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
