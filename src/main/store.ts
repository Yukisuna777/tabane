import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// userData/config.json への素朴な設定永続化。背景画像・（将来）レイアウト保存・設定GUIで再利用する。

export interface TabaneConfig {
  backgroundImagePath?: string | null
  backgroundOpacity?: number
  /** 復元用のレイアウト木（renderer の LayoutNode を JSON 化したもの） */
  layout?: unknown
}

const configPath = (): string => join(app.getPath('userData'), 'config.json')

export function readConfig(): TabaneConfig {
  try {
    if (existsSync(configPath())) {
      return JSON.parse(readFileSync(configPath(), 'utf-8')) as TabaneConfig
    }
  } catch {
    // 壊れた設定は無視して空から始める
  }
  return {}
}

export function writeConfig(patch: Partial<TabaneConfig>): TabaneConfig {
  const next = { ...readConfig(), ...patch }
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2))
  } catch {
    // 書き込み失敗は致命的でないため握りつぶす
  }
  return next
}
