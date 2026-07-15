# tabane — 開発ルール

エージェント監督特化ターミナル（Electron + React + xterm.js + node-pty）。

## このリポの構成

```
src/
├─ main/       … Electron main。PTY 管理（node-pty）・返事待ち検知・IPC
│  ├─ index.ts        … BrowserWindow 生成・IPC 登録・ライフサイクル
│  └─ ptyManager.ts   … PTY 生成/入出力/検知の中核。しきい値はここの定数
├─ preload/    … contextBridge で renderer に window.tabane を公開
├─ renderer/   … React UI
│  └─ src/
│     ├─ App.tsx           … レイアウト木・状態集約
│     ├─ layout.ts         … 再帰分割木の純粋操作
│     └─ components/       … SplitView / Pane / TitleBar / Terminal
└─ shared/     … main/preload/renderer 共有の型（IPC 契約）
```

## 設計の要点

- **返事待ち検知は main 側**に置く。renderer（非表示ペイン）に依存させない。
- 検知は BEL / 通知系 OSC を一次シグナル、出力静止タイマーを補助にするハイブリッド。
  しきい値は `ptyManager.ts` の `QUIET_MS` / `BELL_SETTLE_MS`（暫定値）。
- レイアウトは `layout.ts` の純粋関数で操作し、木を丸ごと差し替える。
- 色は暫定。`styles.css` の CSS 変数を後で yukisuna-brand トークンに差し替える前提。

## 進め方

- 開発フローは親アンブレラ（`~/develop/CLAUDE.md`）経由で `yukisuna-brand/flow/` に従う。
- 仕様書は `docs/specs/`（承認まで実装しない）。
- 完了の定義は検証 green：`npm run typecheck` + 起動して主要動線を手で再現。
- 破壊的操作・スコープ拡大は都度確認（最優先ゲート）。
