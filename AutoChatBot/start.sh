#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 20 или новее и запустите bash start.sh снова."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Нужен Node.js 20 или новее (сейчас: $(node --version))."
  exit 1
fi

exec node scripts/src/telegram-business-bot/main.mjs "$@"
