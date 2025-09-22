#!/bin/zsh
set -euo pipefail

# すべて絶対パス（launchdではPATHがほぼ空）
APP_DIR="/Users/nakamichikota/panasonic-checker"
NODE_BIN="/opt/homebrew/bin/node"   # Intelなら /usr/local/bin/node

# 念のため改行コードが混じっても動くように
cd "$APP_DIR"

# 実行（ログも絶対パス）
exec "$NODE_BIN" "$APP_DIR/check-stock.js" \
  >> "$APP_DIR/stock.log" \
  2>> "$APP_DIR/stock-error.log"

