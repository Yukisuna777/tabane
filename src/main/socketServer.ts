// tabane CLI からの接続を受ける Unix domain socket サーバ。
//
// PTY の中で動く claude は Electron の contextBridge に触れない（OS のプロセス境界の外）。
// そのため「ペインを開く/一覧する/待つ/止める」を外から叩ける口を socket として開ける。
// プロトコルは JSON Lines（1行 = 1メッセージ）。リクエスト1つにレスポンス1つを返す。
//
// wait は長時間ブロックするため、ハンドラの解決を待ってから書く（接続は開けたまま）。

import net from 'node:net'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import type { TabaneRequest, TabaneResponse } from '../shared/types.js'

/** 既存 socket の生存確認に使う接続タイムアウト。 */
const PROBE_TIMEOUT_MS = 300

/** 1行の上限。これを超えたら不正なクライアントとみなして切る（メモリ暴走の防止）。 */
const MAX_LINE_BYTES = 1024 * 64

export type RequestHandler = (req: TabaneRequest) => Promise<TabaneResponse>

/**
 * 既にそのパスで listen している tabane が居るかを調べる。
 * 繋がれば生存、繋がらなければ前回の異常終了で残った死骸。
 */
function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(path)
    const done = (alive: boolean): void => {
      probe.destroy()
      resolve(alive)
    }
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
    probe.on('connect', () => done(true))
    probe.on('error', () => done(false))
  })
}

export class SocketServer {
  private server: net.Server | null = null

  constructor(
    private readonly socketPath: string,
    private readonly handle: RequestHandler
  ) {}

  /**
   * listen を試みる。既に他のインスタンスが握っていれば false を返す（多重起動時は先勝ち）。
   * 死んだ socket ファイルが残っていれば unlink してから listen する。
   */
  async start(): Promise<boolean> {
    if (existsSync(this.socketPath)) {
      if (await isSocketAlive(this.socketPath)) return false
      try {
        unlinkSync(this.socketPath)
      } catch {
        return false
      }
    }

    const server = net.createServer((sock) => this.onConnection(sock))

    return new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(this.socketPath, () => {
        this.server = server
        // 既定では他ユーザーからも叩けてしまうため、所有者のみに絞る。
        try {
          chmodSync(this.socketPath, 0o600)
        } catch {
          // chmod 不可でも致命的ではない（socket は userData 配下にある）
        }
        resolve(true)
      })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
    } catch {
      // 終了時の後始末なので失敗しても黙る
    }
  }

  private onConnection(sock: net.Socket): void {
    let buf = ''

    const reply = (res: TabaneResponse): void => {
      if (sock.destroyed) return
      sock.write(JSON.stringify(res) + '\n')
    }

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (buf.length > MAX_LINE_BYTES) {
        reply({ ok: false, error: 'request too large' })
        sock.destroy()
        return
      }

      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) void this.dispatch(line, reply)
      }
    })

    // クライアントが切れた場合のエラーは握りつぶす（wait 中の Ctrl-C など）
    sock.on('error', () => sock.destroy())
  }

  private async dispatch(line: string, reply: (res: TabaneResponse) => void): Promise<void> {
    let req: TabaneRequest
    try {
      req = JSON.parse(line) as TabaneRequest
    } catch {
      reply({ ok: false, error: 'invalid JSON' })
      return
    }

    try {
      reply(await this.handle(req))
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
}
