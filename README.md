<div align="center">

# 束ね / Tabane

**複数の AI エージェントを、1画面で監督するためのターミナル。**

Claude Code / Codex / 任意の CLI をペインに並べ、名札を付けて、
返事待ちになったペインが光って教えてくれる Electron ターミナル。

</div>

---

複数の AI エージェントを同時に走らせると、「どれが入力待ちか」を目視で巡回する羽目になる。
既存のターミナルはペインに恒常的な名札を付けられず、返事待ちの可視化もない。

Tabane は **並べる・名札を付ける・待ちが光る** の3点に絞って、複数エージェント運用の認知負荷を下げる。

## 特徴

- 🪟 **1ウィンドウのペイン分割** — 縦/横に自由分割、ドラッグでリサイズ、クローズ。深くネストしても崩れない
- 🏷 **固定タイトルバー** — 各ペイン上部に自由入力の名札。「どのプロジェクトのどのエージェントか」が一目で分かる
- 🔔 **返事待ち検知で発光** — エージェントが入力待ちになったペインの枠が光り、ドットが点滅。フォーカスすると消灯。ベル / デスクトップ通知系 OSC を根拠にするので、暇なシェルは光らない
- 🧬 **分割でシェルを引き継ぐ** — 分割しても分割元のシェルは生きたまま。新ペインは分割元の作業ディレクトリで起動する
- 💾 **レイアウト復元** — 分割構成とタイトルを保存し、次回起動時に復元（設定でOFFも可）
- 🎨 **テーマとフォント** — ライト / ダーク切替、フォントサイズ調整、背景画像（端末に透けて映る）。すべて設定GUI（`⌘,`）から
- 🌏 日本語 UI ＋ 等幅日本語フォント（HackGen Console NF）同梱

## 技術構成

| 層 | 技術 |
|---|---|
| ガワ | Electron 33 + electron-vite |
| UI | React 18 + TypeScript |
| 端末描画 | @xterm/xterm（WebGL レンダラ、背景画像のため透過描画） |
| PTY | node-pty（main プロセス） |

**設計メモ**

- 返事待ち検知は **main プロセス側**で行う。非フォーカス（非表示）のペインでも検知が動く。
- xterm と PTY は React のマウント位置から切り離して**永続化**している。分割・リサイズでレイアウト木が
  組み変わってもシェルは死なない（破棄はペインを閉じたときだけ）。
- 配色は [yukisuna-brand](https://github.com/Yukisuna777/yukisuna-brand) のカラートークンに基づく。

## インストール（macOS / Apple Silicon）

**Homebrew:**

```bash
brew install --cask yukisuna777/tap/tabane
```

**または install スクリプト:**

```bash
curl -fsSL https://raw.githubusercontent.com/Yukisuna777/tabane/main/install.sh | bash
```

どちらも [GitHub Releases](https://github.com/Yukisuna777/tabane/releases) の最新版を `/Applications` に入れる。
現状 **Apple Silicon (arm64) のみ**。手動で入れたい場合は Releases の `.dmg` を開いてドラッグでも可。

> 未署名アプリのため、直接 `.dmg` から入れると初回に Gatekeeper で止まることがある。
> その場合は `.app` を右クリック →「開く」、または `xattr -dr com.apple.quarantine /Applications/tabane.app`。
> brew / install スクリプト経由なら隔離属性を自動で外すのでそのまま起動できる。

## 開発

```bash
npm install      # node-pty を Electron 向けに自動リビルド（postinstall）
npm run dev      # 開発起動
npm run build    # ビルド
npm run typecheck
```

配布物のビルド（`dist/` に `.dmg` / `.zip` を出力。arm64・未署名）:

```bash
npm run pack     # .app だけ（動作確認用・軽い）
npm run dist     # DMG + zip（配布用）
```

タグ `v*` を push すると GitHub Actions（`.github/workflows/release.yml`）が自動でビルドして
Release に添付する。Homebrew tap を自動更新するには、tap リポへ push できる PAT を
リポジトリ Secrets `HOMEBREW_TAP_TOKEN` に登録する（未登録なら tap 更新はスキップ）。

macOS (Apple Silicon) で開発・動作確認。構成上 Windows / Linux も動くはずだが未検証。

## ロードマップ

- プロセス状態監視ベースの、より正確な返事待ち検知
- Windows / Linux の動作確認
- ペインのタブ / ワークスペース

## ライセンス

MIT © yukisuna777 — 同梱フォント HackGen Console NF は SIL OFL 1.1（`src/renderer/src/assets/fonts/LICENSE.txt`）。

先行事例として [Wave Terminal](https://github.com/wavetermdev/waveterm)（Apache-2.0）のレイアウト設計を参考にした。
