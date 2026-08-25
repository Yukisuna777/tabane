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
 * OSC 7（`ESC ] 7 ; file://host/path BEL`）。シェルが毎プロンプトで cwd を報告する事実上の標準。
 * starship / oh-my-zsh 等を入れていれば正確・即時・ゼロコストで cwd が分かる。
 */
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g
/** 正規表現を走らせる前の足切り用リテラル。 */
const OSC7_MARK = '\x1b]7;'

/**
 * エージェントが終了時に出す再開コマンド。行頭・末尾は問わず、末尾バッファ全体から
 * 最後の1件を採る（新しいものが常に古いものを上書きする）。
 */
const RESUME_RE = /(?:claude\s+--resume\s+[0-9a-f-]{36}|codex\s+resume\s+\S+)/gi
/** 同上の足切り。コマンド側は常に小文字なのでこれで拾える。 */
const RESUME_MARK = 'resume'

/** CSI / OSC / 単発エスケープ。resume 検出前に色や制御を落とすため。 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/**
 * 検出用に持つ末尾バッファの長さ。チャンク分割で UUID や URL が割れても拾えるようにする。
 * 長すぎると毎チャンクの正規表現が重くなるだけなので、数行ぶんあれば足りる。
 */
const TAIL_MAX = 2048

/** cwd ポーリングの間隔。出力のあったペインだけを引くので、暇なペインでは lsof を起動しない。 */
const CWD_POLL_MS = 10_000

/** OSC 7 で報告された cwd を取り出す（最後の1件）。無ければ undefined。 */
function parseOsc7(buf: string): string | undefined {
  let found: string | undefined
  for (const m of buf.matchAll(OSC7_RE)) found = m[1]
  if (found === undefined) return undefined
  try {
    // パスは URL エンコードされている（空白や日本語を含むフォルダ）。
    return decodeURIComponent(found)
  } catch {
    return found
  }
}

/** 末尾バッファから再開コマンドを取り出す（最後の1件）。無ければ undefined。 */
function parseResume(buf: string): string | undefined {
  const plain = buf.replace(ANSI_RE, '')
  let found: string | undefined
  for (const m of plain.matchAll(RESUME_RE)) found = m[0]
  // 改行や連続スペースで割れていても1行のコマンドとして扱えるよう畳む。
  return found?.replace(/\s+/g, ' ').trim()
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
  // OSC 7 の終端は BEL。cwd 報告のたびに glow すると「毎プロンプトで光る」ので先に除く。
  // 含まないチャンク（＝ほとんど）では文字列を作り直さない。
  const body = data.includes(OSC7_MARK) ? data.replace(OSC7_RE, '') : data
  if (body.includes('\x07')) return true // BEL
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
  /** 検出用の末尾バッファ（生の出力。OSC 7 を含むので ANSI は落とさない）。 */
  tail: string
  /** 最後に通知した cwd。変化したときだけ renderer に送る。 */
  cwd?: string
  /** 最後に通知した再開コマンド。 */
  resume?: string
  /** 前回のポーリング以降に出力があったか。false のペインには lsof を撃たない。 */
  dirty: boolean
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
    private getDefaultCwd: () => string | undefined = () => undefined,
    /** シェルの cwd が変わったときだけ呼ばれる。 */
    private onCwd: (id: string, cwd: string) => void = () => {},
    /** 再開コマンドを新たに観測したときだけ呼ばれる。 */
    private onResume: (id: string, resume: string) => void = () => {}
  ) {}

  /** cwd ポーリングのタイマー。セッションが1つも無い間は動かさない。 */
  private cwdTimer: NodeJS.Timeout | null = null
  /** ポーリングの多重実行を防ぐ（lsof が詰まったときに積み上がらないように）。 */
  private polling = false

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
      bellTimer: null,
      tail: '',
      // 起動直後の cwd も記憶対象。初回ポーリングで観測して通知する
      // （ここで通知すると renderer 側の ptyId 紐付けがまだ済んでいない）。
      dirty: true
    }
    this.sessions.set(id, session)
    this.ensureCwdPolling()

    pty.onData((data) => {
      this.onData(id, data)
      this.handleActivity(session, data)
    })

    pty.onExit(({ exitCode }) => {
      this.clearTimers(session)
      this.sessions.delete(id)
      this.stopCwdPollingIfIdle()
      this.onExit(id, exitCode)
    })

    return id
  }

  /** PTY 出力を受けたときの状態遷移。出力中は busy、止まれば idle。glow は BEL のみ。 */
  private handleActivity(session: Session, data: string): void {
    this.observe(session, data)
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
    this.stopCwdPollingIfIdle()
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

  // ===== ペイン状態の記憶（cwd / 再開コマンド）=====

  /**
   * 出力から cwd と再開コマンドを拾う。末尾バッファ方式なのは、チャンク境界で
   * UUID や URL が割れても取りこぼさないため。どちらも「変化したときだけ」通知する。
   */
  private observe(session: Session, data: string): void {
    session.dirty = true
    session.tail = (session.tail + data).slice(-TAIL_MAX)

    // ビルドログのような大量出力でもチャンクごとに正規表現を走らせないよう、
    // まず includes で足切りする（該当しないチャンクが圧倒的多数）。
    // 一次：OSC 7。シェルが報告してくれるなら lsof より速く正確。
    if (session.tail.includes(OSC7_MARK)) {
      const osc7 = parseOsc7(session.tail)
      if (osc7 && osc7 !== session.cwd && existsSync(osc7)) {
        session.cwd = osc7
        // 報告を受けた ＝ lsof で追う必要はない。
        session.dirty = false
        this.onCwd(session.id, osc7)
      }
    }

    if (session.tail.includes(RESUME_MARK)) {
      const resume = parseResume(session.tail)
      if (resume && resume !== session.resume) {
        session.resume = resume
        this.onResume(session.id, resume)
      }
    }
  }

  private ensureCwdPolling(): void {
    if (this.cwdTimer) return
    this.cwdTimer = setInterval(() => void this.pollCwds(), CWD_POLL_MS)
  }

  private stopCwdPollingIfIdle(): void {
    if (this.sessions.size > 0 || !this.cwdTimer) return
    clearInterval(this.cwdTimer)
    this.cwdTimer = null
  }

  /**
   * 二次：lsof。macOS 素の zsh は OSC 7 を出さないため、こちらが本命になる人も多い。
   * 出力のあったペインだけを引く（dirty フラグ）。暇なペインでは lsof を起動しない。
   */
  private async pollCwds(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const session of [...this.sessions.values()]) {
        if (!session.dirty) continue
        session.dirty = false
        const cwd = await getCwdOfPid(session.pty.pid)
        // await の間に閉じられている可能性がある。
        if (!cwd || !this.sessions.has(session.id)) continue
        if (cwd === session.cwd) continue
        session.cwd = cwd
        this.onCwd(session.id, cwd)
      }
    } finally {
      this.polling = false
    }
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
