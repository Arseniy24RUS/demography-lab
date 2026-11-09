#!/bin/bash
set -euo pipefail
DW_MACOS_ENTRY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$DW_MACOS_ENTRY/../scripts/macos/common.sh"
dw_mac_only
dw_find_node
"$DW_NODE" "$DW_MACOS_SCRIPTS/network.mjs"
printf '\nОткрыть раздел «Общий доступ» в настройках macOS? Сама программа сеть не изменяет.\n'
if [ -t 0 ]; then
  read -r -p 'Введите y, чтобы открыть, либо нажмите Return: ' DW_OPEN_SETTINGS
  case "$DW_OPEN_SETTINGS" in y|Y|д|Д) /usr/bin/open 'x-apple.systempreferences:com.apple.Sharing-Settings.extension' ;; esac
fi
