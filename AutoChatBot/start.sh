#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 18.17 или новее и запустите bash start.sh снова."
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 18 || (major === 18 && minor >= 17) ? 0 : 1)'; then
  echo "Нужен Node.js 18.17 или новее (сейчас: $(node --version))."
  exit 1
fi

exec node scripts/src/telegram-business-bot/main.mjs "$@"
