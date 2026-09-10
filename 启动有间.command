#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node.js。请安装 Node.js 22.13 或更新版本，再启动有间。'
  read '?按回车关闭。'
  exit 1
fi
node start.mjs
