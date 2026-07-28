import os from 'node:os'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawn, type IPty } from 'node-pty'
import type { PaneStatus, PtyCreateOptions } from '../shared/types.js'

const execFileAsync = promisify(execFile)

/** 実行中シェル(pid)のカレントディレクトリを lsof で引く。取れなければ undefined。 */
async function getCwdOfPid(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 1000 }
    )
    // 出力は `p<pid>` / `fcwd` / `n<path>` の行。n 行の中身が cwd。
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) return line.slice(1)
    }
  } catch {
    // lsof 不在・タイムアウト等は継承をあきらめる
  }
  return undefined
}

/**
 * 返事待ち検知のしきい値（仮。実運用でチューニングする）。
 * - BELL_SETTLE_MS: BEL/通知シーケンスを受けてから、追い出力が無ければ waiting にするまでの待ち
 * - IDLE_AFTER_MS: 出力が止まってから busy を解いて idle に戻すまでの待ち
 *
 * 方針：glow（waiting）は BEL/通知シグナルだけを根拠にする。出力静止は「暇なシェル」でも
 * 起きるため waiting の根拠にしない（idle に戻すだけ）。これで誤発光を断つ。
 */
const BELL_SETTLE_MS = 400
const IDLE_AFTER_MS = 800

/** 端末の注意喚起シグナル。BEL と主要なデスクトップ通知系 OSC。 */
function hasAttentionSignal(data: string): boolean {
  if (data.includes('\x07')) return true // BEL
  // OSC 9 (iTerm), OSC 777 (notify), OSC 99 (kitty) の通知
  if (data.includes('\x1b]9;')) return true
  if (data.includes('\x1b]777;notify')) return true
  if (data.includes('\x1b]99;')) return true
  return false
}

/** main 内部の生成オプション。IPC で来る PtyCreateOptions に、CLI 起動用の指定を足したもの。 */
export interface PtySpawnOptions extends PtyCreateOptions {
  /**
   * シェル起動時に実行するコマンド。実行後は対話シェルに落ちるため、
   * コマンドが終わってもペインは生き残る（`tabane open --prompt` の claude 起動に使う）。
   */
  initialCommand?: string
}

/** ptyId（`pty-3`）からペイン番号（3）を取り出す。CLI が扱う ID はこの番号。 */
export function paneNumberOf(ptyId: string): number {
  return Number(ptyId.replace(/^pty-/, ''))
}

interface Session {
  id: string
  pty: IPty
  status: PaneStatus
  bellPending: boolean
  idleTimer: NodeJS.Timeout | null
  bellTimer: NodeJS.Timeout | null
}

type StatusListener = (id: string, status: PaneStatus) => void

export class PtyManager {
  private sessions = new Map<string, Session>()
  private seq = 0

  constructor(
    private onData: (id: string, data: string) => void,
    private onExit: (id: string, exitCode: number) => void,
    private onStatus: StatusListener,
    /** 明示 cwd も継承も無いときの起動フォルダ（設定値）。未指定なら undefined を返す。 */
    private getDefaultCwd: () => string | undefined = () => undefined
  ) {}

  async create(opts: PtySpawnOptions): Promise<string> {
    const paneNumber = ++this.seq
    const id = `pty-${paneNumber}`
    const shell = process.env.SHELL || '/bin/zsh'

    // 分割時の cwd 継承：明示 cwd が無ければ、元 PTY(シェル)の現在ディレクトリを引く。
    let cwd = opts.cwd
    if (!cwd && opts.inheritCwdFromPtyId) {
      const src = this.sessions.get(opts.inheritCwdFromPtyId)
      if (src) cwd = await getCwdOfPid(src.pty.pid)
    }
    // 消えたディレクトリを cwd にすると spawn が失敗するため存在チェックしてフォールバック
    if (cwd && !existsSync(cwd)) cwd = undefined

    // cwd 未確定なら「起動フォルダ」設定（存在すれば）→ ホームの順でフォールバック
    if (!cwd) {
      const configured = this.getDefaultCwd()
      if (configured && existsSync(configured)) cwd = configured
    }

    // ログインシェル（-l）で起動する。Finder/Dock 起動時の Electron は PATH が最小構成のため、
    // これが無いと claude / codex を bare name で spawn できない（tabane の目的そのもの）。
    //
    // initialCommand がある場合は -c で実行し、その後 exec で対話シェルに置き換える。
    // 「シェルを起こしてからプロンプトに文字を流し込む」方式だと、ログインシェルの
    // 初期化が終わる前に書いた文字が飲まれるため、起動引数として渡し切る。
    const args = opts.initialCommand
      ? ['-l', '-c', `${opts.initialCommand}; exec ${shell} -l`]
      : ['-l']

    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols),
      rows: Math.max(2, opts.rows),
      cwd: cwd || os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        // hooks が `tabane report --pane $TABANE_PANE_ID` で自分を名乗るために使う。
        TABANE_PANE_ID: String(paneNumber)
      }
    })

    const session: Session = {
      id,
      pty,
      status: 'idle',
      bellPending: false,
      idleTimer: null,
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

  /** PTY 出力を受けたときの状態遷移。出力中は busy、止まれば idle。glow は BEL のみ。 */
  private handleActivity(session: Session, data: string): void {
    this.clearTimers(session)
    this.setStatus(session, 'busy')

    if (hasAttentionSignal(data)) {
      session.bellPending = true
      // 追い出力が無ければ waiting（エージェントが明示的に通知した合図）
      session.bellTimer = setTimeout(() => {
        this.setStatus(session, 'waiting')
      }, BELL_SETTLE_MS)
      return
    }

    // 出力が止まったら idle に戻すだけ（暇なシェルを waiting にしない）
    session.idleTimer = setTimeout(() => {
      this.setStatus(session, 'idle')
    }, IDLE_AFTER_MS)
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

  // ===== `tabane list` 用のアクセサ =====

  /** 生存中の PTY id を採番順に返す。 */
  ids(): string[] {
    return [...this.sessions.keys()].sort((a, b) => paneNumberOf(a) - paneNumberOf(b))
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  statusOf(id: string): PaneStatus | undefined {
    return this.sessions.get(id)?.status
  }

  /** そのペインのシェルが今いるディレクトリ。取れなければ undefined。 */
  async cwdOf(id: string): Promise<string | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return getCwdOfPid(session.pty.pid)
  }

  private setStatus(session: Session, status: PaneStatus): void {
    if (session.status === status) return
    session.status = status
    this.onStatus(session.id, status)
  }

  private clearTimers(session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    if (session.bellTimer) {
      clearTimeout(session.bellTimer)
      session.bellTimer = null
    }
  }
}
