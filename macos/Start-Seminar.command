#!/bin/bash
set -euo pipefail
DW_MACOS_ENTRY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$DW_MACOS_ENTRY/../scripts/macos/common.sh"
dw_mac_only
dw_find_node
"$DW_NODE" "$DW_MACOS_SCRIPTS/manifest.mjs" check
"$DW_NODE" "$DW_MACOS_SCRIPTS/control.mjs" start
