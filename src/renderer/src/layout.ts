// 1ウィンドウ内の再帰分割レイアウトを表す木構造と、その純粋操作。
// tmux / Wave と同じく「ペイン or 分割」の二種ノードで任意分割を表現する。

import type { SplitDir } from '../../shared/types'

export type { SplitDir }

export interface PaneNode {
  kind: 'pane'
  id: string
  title: string
  /** このペイン生成時、分割元シェルの cwd を継ぐための元 PTY id（初回ペインは無し）。 */
  inheritCwdFromPtyId?: string
}

export interface SplitNode {
  kind: 'split'
  id: string
  dir: SplitDir
  children: LayoutNode[]
  /** children と同じ長さ。合計 100 のパーセンテージ。 */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

const uid = (): string => crypto.randomUUID()

export function createPane(title: string, inheritCwdFromPtyId?: string): PaneNode {
  return { kind: 'pane', id: uid(), title, inheritCwdFromPtyId }
}

/** 対象ペインを、その場で [元ペイン, 新ペイン] の分割に置き換える。 */
export function splitPane(
  node: LayoutNode,
  targetPaneId: string,
  dir: SplitDir,
  newTitle: string,
  inheritCwdFromPtyId?: string
): LayoutNode {
  if (node.kind === 'pane') {
    if (node.id !== targetPaneId) return node
    const fresh = createPane(newTitle, inheritCwdFromPtyId)
    return {
      kind: 'split',
      id: uid(),
      dir,
      children: [node, fresh],
      sizes: [50, 50]
    }
  }
  return {
    ...node,
    children: node.children.map((c) =>
      splitPane(c, targetPaneId, dir, newTitle, inheritCwdFromPtyId)
    )
  }
}

/** ペインを閉じる。親分割が子1つになったら畳む。全消しになったら新規1ペインを返す。 */
export function closePane(node: LayoutNode, targetPaneId: string): LayoutNode | null {
  if (node.kind === 'pane') {
    return node.id === targetPaneId ? null : node
  }
  const kept: LayoutNode[] = []
  const keptSizes: number[] = []
  node.children.forEach((child, i) => {
    const next = closePane(child, targetPaneId)
    if (next) {
      kept.push(next)
      keptSizes.push(node.sizes[i])
    }
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]
  return { ...node, children: kept, sizes: normalize(keptSizes) }
}

export function setSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.kind === 'pane') return node
  if (node.id === splitId) return { ...node, sizes }
  return { ...node, children: node.children.map((c) => setSizes(c, splitId, sizes)) }
}

export function setTitle(node: LayoutNode, paneId: string, title: string): LayoutNode {
  if (node.kind === 'pane') {
    return node.id === paneId ? { ...node, title } : node
  }
  return { ...node, children: node.children.map((c) => setTitle(c, paneId, title)) }
}

/** 復元データが妥当な LayoutNode の形か検証する（壊れた/旧形式の config で起動が死なないように）。 */
export function isLayoutNode(v: unknown): v is LayoutNode {
  if (!v || typeof v !== 'object') return false
  const n = v as Record<string, unknown>
  if (n.kind === 'pane') return typeof n.id === 'string' && typeof n.title === 'string'
  if (n.kind === 'split') {
    return (
      Array.isArray(n.children) &&
      n.children.length >= 2 &&
      Array.isArray(n.sizes) &&
      n.sizes.length === n.children.length &&
      n.children.every(isLayoutNode)
    )
  }
  return false
}

/** 復元したレイアウトから前セッションの inheritCwdFromPtyId を剥がす。
 *  再起動で main の PTY 採番がリセットされ、古い pty-N が新しい別ペインの pty-N と
 *  誤マッチして意図しない cwd 継承が起きるのを防ぐ。 */
export function stripInheritCwd(node: LayoutNode): LayoutNode {
  if (node.kind === 'pane') {
    const { inheritCwdFromPtyId: _drop, ...rest } = node
    return rest
  }
  return { ...node, children: node.children.map(stripInheritCwd) }
}

export function collectPaneIds(node: LayoutNode, acc: string[] = []): string[] {
  if (node.kind === 'pane') acc.push(node.id)
  else node.children.forEach((c) => collectPaneIds(c, acc))
  return acc
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total === 0) return sizes.map(() => 100 / sizes.length)
  return sizes.map((s) => (s / total) * 100)
}
