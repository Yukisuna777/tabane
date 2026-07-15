import os from 'node:os'
import { spawn, type IPty } from 'node-pty'
import type { PaneStatus, PtyCreateOptions } from '../shared/types.js'

/**
 * 返事待ち検知のしきい値（すべて仮。実運用でチューニングする）。
 * - QUIET_MS: 出力が止まってからこの時間 waiting とみなす（補助シグナル）
 * - BELL_SETTLE_MS: BEL/通知シーケンスを受けてから、追い出力が無ければ即 waiting にするまでの待ち
 */
const QUIET_MS = 5000
const BELL_SETTLE_MS = 400

/** 端末の注意喚起シグナル。BEL と主要なデスクトップ通知系 OSC。 */
function hasAttentionSignal(data: string): boolean {
  if (data.includes('\x07')) return true // BEL
  // OSC 9 (iTerm), OSC 777 (notify), OSC 99 (kitty) の通知
  if (data.includes('\x1b]9;')) return true
  if (data.includes('\x1b]777;notify')) return true
  if (data.includes('\x1b]99;')) return true
  return false
}

interface Session {
  id: string
  pty: IPty
  status: PaneStatus
  bellPending: boolean
  quietTimer: NodeJS.Timeout | null
  bellTimer: NodeJS.Timeout | null
}

type StatusListener = (id: string, status: PaneStatus) => void

export class PtyManager {
  private sessions = new Map<string, Session>()
  private seq = 0

  constructor(
    private onData: (id: string, data: string) => void,
    private onExit: (id: string, exitCode: number) => void,
    private onStatus: StatusListener
  ) {}

  create(opts: PtyCreateOptions): string {
    const id = `pty-${++this.seq}`
    const shell = process.env.SHELL || '/bin/zsh'
    // ログインシェル（-l）で起動する。Finder/Dock 起動時の Electron は PATH が最小構成のため、
    // これが無いと claude / codex を bare name で spawn できない（tabane の目的そのもの）。
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols),
      rows: Math.max(2, opts.rows),
      cwd: opts.cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    const session: Session = {
      id,
      pty,
      status: 'idle',
      bellPending: false,
      quietTimer: null,
      bellTimer: null
    }
    this.sessions.set(id, session)

    pty.onData((data) => {
      this.onData(id, data)
      this.handleActivity(session, data)
    })

    pty.onExit(({ exitCode }) => {
      this.clearTimers(session)
      this.sessions.delete(id)
      this.onExit(id, exitCode)
    })

    return id
  }

  /** PTY 出力を受けたときの状態遷移。busy にし、静止/BEL タイマーを仕込む。 */
  private handleActivity(session: Session, data: string): void {
    this.setStatus(session, 'busy')
    this.clearTimers(session)

    if (hasAttentionSignal(data)) {
      session.bellPending = true
      // 追い出力が無ければ即 waiting（エージェントが明示的に通知した合図）
      session.bellTimer = setTimeout(() => {
        this.setStatus(session, 'waiting')
      }, BELL_SETTLE_MS)
      return
    }

    // 補助シグナル：一定時間出力が止まったら waiting とみなす
    session.quietTimer = setTimeout(() => {
      this.setStatus(session, 'waiting')
    }, QUIET_MS)
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    // ユーザーがそのペインに入力した = 触っている。glow は解除。
    session.bellPending = false
    this.clearTimers(session)
    if (session.status === 'waiting') this.setStatus(session, 'idle')
    session.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty.resize(Math.max(2, cols), Math.max(2, rows))
    } catch {
      // リサイズは失敗しても致命的でないため握りつぶす
    }
  }

  /** ユーザーがそのペインを見た合図。waiting を解除する。 */
  focus(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.bellPending = false
    this.clearTimers(session)
    if (session.status === 'waiting') this.setStatus(session, 'idle')
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.clearTimers(session)
    try {
      session.pty.kill()
    } catch {
      // 既に死んでいる場合など
    }
    this.sessions.delete(id)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private setStatus(session: Session, status: PaneStatus): void {
    if (session.status === status) return
    session.status = status
    this.onStatus(session.id, status)
  }

  private clearTimers(session: Session): void {
    if (session.quietTimer) {
      clearTimeout(session.quietTimer)
      session.quietTimer = null
    }
    if (session.bellTimer) {
      clearTimeout(session.bellTimer)
      session.bellTimer = null
    }
  }
}
