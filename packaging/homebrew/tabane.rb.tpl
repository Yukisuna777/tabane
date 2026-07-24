# Homebrew Cask 雛形。release ワークフローがバージョンと sha256 を差し替えて
# homebrew-tap リポの Casks/tabane.rb として push する。手で差し替えて使ってもよい。
cask "tabane" do
  version "__VERSION__"
  sha256 "__SHA256__"

  url "https://github.com/Yukisuna777/tabane/releases/download/v#{version}/tabane-#{version}-arm64.zip"
  name "tabane"
  desc "エージェント監督特化ターミナル"
  homepage "https://github.com/Yukisuna777/tabane"

  # 現状 Apple Silicon のみ配布
  depends_on arch: :arm64

  app "tabane.app"

  # 未署名アプリ対策。Homebrew は DL 物に quarantine を付けるが、arm64 では未署名＋
  # quarantine だと「壊れているため開けません」になる。install.sh と同じく除去して開けるようにする。
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/tabane.app"]
  end

  # アンインストール時に消す設定・キャッシュ（store.ts の userData 配下）
  zap trash: [
    "~/Library/Application Support/tabane",
    "~/Library/Preferences/com.yukisuna.tabane.plist",
    "~/Library/Saved Application State/com.yukisuna.tabane.savedState",
  ]
end
