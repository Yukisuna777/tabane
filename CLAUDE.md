# tabane — 開発ルール

エージェント監督特化ターミナル（Electron + React + xterm.js + node-pty）。

## 構成

```
src/
├─ main/       … Electron main。PTY 管理・返事待ち検知・設定永続化・メニュー・IPC
│  ├─ index.ts        … BrowserWindow・IPC 登録・背景/設定・ライフサイクル
│  ├─ ptyManager.ts   … PTY 生成/入出力/検知の中核。しきい値はここの定数
│  ├─ store.ts        … userData/config.json への設定永続化
│  └─ menu.ts         … アプリメニュー（設定・背景）
├─ preload/    … contextBridge で renderer に window.tabane を公開
├─ renderer/   … React UI
│  └─ src/
│     ├─ App.tsx              … レイアウト木・設定・状態集約
│     ├─ layout.ts            … 再帰分割木の純粋操作
│     ├─ terminalRegistry.ts  … xterm/PTY を React の外で永続化するレジストリ
│     └─ components/          … SplitView / Pane / TitleBar / Terminal / SettingsModal
└─ shared/     … main/preload/renderer 共有の型（IPC 契約）
```

## 設計の要点

- **返事待ち検知は main 側**（`ptyManager.ts`）。非表示ペインでも動く。
  glow（waiting）の根拠は BEL / 通知系 OSC のみ。出力静止は idle に戻すだけ（暇なシェルを光らせない）。
  しきい値は `BELL_SETTLE_MS` / `IDLE_AFTER_MS`。
- **端末は React のマウント位置から切り離して永続化**（`terminalRegistry.ts`）。分割・リサイズで
  木が組み変わっても PTY/xterm は死なない。破棄は layout 差分の prune 1経路のみ。
- レイアウトは `layout.ts` の純粋関数で操作し、木を丸ごと差し替える。
- 設定（背景画像・テーマ・フォント・レイアウト復元）は `store.ts` の config.json に集約。
- 配色は `styles.css` の CSS 変数。ライトは `[data-theme="light"]` で上書き。

## 進め方

- 仕様書は `docs/specs/`（承認まで実装しない）。
- 完了の定義は検証 green：`npm run typecheck` + 起動して主要動線を手で再現。
- 破壊的操作・スコープを広げる変更は、実行前に確認する。
