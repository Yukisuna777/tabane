// 子 claude が hooks で申告してくる「エージェント状態」を保持し、決着を待たせる。
//
// ペインの状態（PtyManager が PTY 出力から推測する idle/busy/waiting）とは別軸で持つ。
// 出力の推測では「長考中」と「暇」、「完了」と「暇」が区別できず、指揮役が状態を
// 読み違えて次の作業を投げてしまうため、本人の申告を正とする。

import type { AgentState, WaitResult } from '../shared/types.js'

/** これらに達したら「決着」とみなし、wait を解く。 */
const SETTLED: readonly AgentState[] = ['done', 'needs_input', 'closed']

function isSettled(state: AgentState | undefined): boolean {
  return state !== undefined && SETTLED.includes(state)
}

interface Waiter {
  /** まだ決着していないペイン番号。 */
  pending: Set<number>
  /** 決着した順に積む（wait の出力順がそのまま完了順になる）。 */
  results: WaitResult[]
  resolve: (results: WaitResult[]) => void
  timer: NodeJS.Timeout
}

export class AgentStateStore {
  private states = new Map<number, AgentState>()
  private waiters = new Set<Waiter>()

  get(pane: number): AgentState | undefined {
    return this.states.get(pane)
  }

  /** 状態を更新し、決着していれば待っている wait を進める。 */
  set(pane: number, state: AgentState): void {
    this.states.set(pane, state)
    if (!isSettled(state)) return

    for (const waiter of [...this.waiters]) {
      if (!waiter.pending.delete(pane)) continue
      waiter.results.push({ id: pane, state })
      if (waiter.pending.size === 0) this.finish(waiter)
    }
  }

  /** ペインが閉じられたときに呼ぶ。待っている wait には closed として返る。 */
  forget(pane: number): void {
    if (this.states.has(pane) || this.isAwaited(pane)) this.set(pane, 'closed')
    this.states.delete(pane)
  }

  private isAwaited(pane: number): boolean {
    for (const w of this.waiters) if (w.pending.has(pane)) return true
    return false
  }

  /**
   * 指定ペインが決着するまで待つ。
   * - 既に決着済み、または一度も申告のないペイン（素のシェル等）は即座に結果へ入れる
   * - タイムアウトしてもエラーにはせず、その時点の状態を返す（「まだ走っている」も情報）
   */
  wait(panes: number[], timeoutMs: number): Promise<WaitResult[]> {
    const results: WaitResult[] = []
    const pending = new Set<number>()

    for (const pane of panes) {
      const state = this.states.get(pane)
      if (state === undefined) {
        // hooks を持たないペインを待っても永遠に決着しないため、待たずに返す。
        results.push({ id: pane, state: 'unknown' })
      } else if (isSettled(state)) {
        results.push({ id: pane, state })
      } else {
        pending.add(pane)
      }
    }

    if (pending.size === 0) return Promise.resolve(results)

    return new Promise<WaitResult[]>((resolve) => {
      const waiter: Waiter = {
        pending,
        results,
        resolve,
        timer: setTimeout(() => {
          // 打ち切り時は、まだ決着していないペインの現在値を添えて返す。
          for (const pane of waiter.pending) {
            waiter.results.push({ id: pane, state: this.states.get(pane) ?? 'unknown' })
          }
          this.finish(waiter)
        }, timeoutMs)
      }
      this.waiters.add(waiter)
    })
  }

  private finish(waiter: Waiter): void {
    clearTimeout(waiter.timer)
    this.waiters.delete(waiter)
    waiter.resolve(waiter.results)
  }
}
