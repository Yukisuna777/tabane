#!/usr/bin/env bash
# tabane を GitHub Release の最新版から /Applications へ入れる。
#   curl -fsSL https://raw.githubusercontent.com/Yukisuna777/tabane/main/install.sh | bash
set -euo pipefail

REPO="Yukisuna777/tabane"
APP="tabane.app"
DEST="/Applications"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "tabane は macOS 専用です" >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "tabane は現在 Apple Silicon (arm64) のみ配布しています" >&2
  exit 1
fi

echo "🔎  最新リリースを確認中..."
tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "${tag:-}" ]; then
  echo "リリースが見つかりませんでした" >&2
  exit 1
fi
version="${tag#v}"
url="https://github.com/${REPO}/releases/download/${tag}/tabane-${version}-arm64.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "⬇  ${version} をダウンロード: $url"
curl -fsSL "$url" -o "$tmp/tabane.zip"

echo "📦  展開中..."
# ditto は macOS の .app バンドル（拡張属性・シンボリックリンク）を壊さず展開できる
ditto -x -k "$tmp/tabane.zip" "$tmp"

if [ ! -d "$tmp/${APP}" ]; then
  echo "展開後に ${APP} が見つかりませんでした" >&2
  exit 1
fi

echo "📁  ${DEST} へ配置..."
rm -rf "${DEST:?}/${APP}"
mv "$tmp/${APP}" "$DEST/"

# ネット由来の隔離属性を外す（未署名でも初回から開けるように）
xattr -dr com.apple.quarantine "$DEST/${APP}" 2>/dev/null || true

echo "✅  インストール完了: ${DEST}/${APP}"
echo "   起動:  open -a tabane"
