#!/usr/bin/env bash
# 安装 commit-msg hook 到当前仓库
set -e

HOOK_SRC="$(dirname "$0")/scripts/commit-msg"
HOOK_DST="$(dirname "$0")/.git/hooks/commit-msg"

mkdir -p "$(dirname "$HOOK_DST")"
cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "✓ commit-msg hook 安装成功"
