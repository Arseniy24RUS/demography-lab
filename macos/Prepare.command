#!/bin/bash
set -euo pipefail
DW_MACOS_ENTRY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$DW_MACOS_ENTRY/../scripts/macos/common.sh"
dw_mac_only
cd "$DW_PROJECT_ROOT"

if [ -f "$DW_MACOS_ENTRY/bundle.json" ]; then
  dw_find_node
  "$DW_NODE" "$DW_MACOS_SCRIPTS/manifest.mjs" check
  printf '\nПолный автономный комплект: загрузки из интернета не требуются.\n'
else
  if ! dw_find_node; then
    dw_download_node
  fi
  printf '\nПодготовка исходного проекта: установка зафиксированных зависимостей и сборка.\n'
  export PATH="$(dirname -- "$DW_NODE"):$PATH"
  npm ci --no-audit --no-fund
  "$DW_NODE" "$DW_PROJECT_ROOT/scripts/cache-originals.mjs"
  npm run build
  "$DW_NODE" "$DW_MACOS_SCRIPTS/manifest.mjs" write
fi

"$DW_NODE" "$DW_PROJECT_ROOT/scripts/cache-originals.mjs" --check
"$DW_NODE" "$DW_MACOS_SCRIPTS/control.mjs" preflight

printf '\nПодготовка полной локальной базы. Не закрывайте окно до завершения.\n'
"$DW_NODE" "$DW_PROJECT_ROOT/scripts/offline/server.mjs" --prepare
"$DW_NODE" "$DW_MACOS_SCRIPTS/control.mjs" check
printf '\nПодготовка завершена. Откройте Network.command для сети, затем Start-Seminar.command.\n'
