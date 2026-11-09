#!/bin/bash
# Compatible with the macOS system Bash 3.2. No privileged commands or network changes.
set -euo pipefail

DW_MACOS_SCRIPTS="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DW_PROJECT_ROOT="$(CDPATH= cd -- "$DW_MACOS_SCRIPTS/../.." && pwd)"
export DW_OFFLINE_DATA_DIR="${DW_OFFLINE_DATA_DIR:-$HOME/Library/Application Support/DemographyLab}"

dw_fail() { printf '\n%s\n' "$*" >&2; return 1; }
dw_mac_only() {
  [ "$(uname -s)" = Darwin ] || dw_fail 'Эти ярлыки предназначены для macOS. На другой ОС используйте node scripts/offline/server.mjs.'
}
dw_error_pause() {
  local dw_exit_code=$?
  if [ "$dw_exit_code" -ne 0 ]; then
    printf '\nОперация не завершена. Текст ошибки выше; данные занятия не удалялись.\n' >&2
    if [ -t 0 ]; then read -r -p 'Нажмите Return, чтобы закрыть окно. ' || true; fi
  fi
  return "$dw_exit_code"
}
trap dw_error_pause EXIT

dw_find_node() {
  local dw_current_arch
  dw_current_arch="$(uname -m)"
  [ "$dw_current_arch" != x86_64 ] || dw_current_arch=x64
  if [ -x "$DW_PROJECT_ROOT/runtime/darwin-$dw_current_arch/bin/node" ]; then
    DW_NODE="$DW_PROJECT_ROOT/runtime/darwin-$dw_current_arch/bin/node"
  elif [ -x "$DW_PROJECT_ROOT/runtime/node/bin/node" ]; then
    DW_NODE="$DW_PROJECT_ROOT/runtime/node/bin/node"
  elif command -v node >/dev/null 2>&1; then
    DW_NODE="$(command -v node)"
  else
    dw_fail 'Node.js пока не подготовлен. Сначала откройте Prepare.command при наличии интернета либо используйте полный автономный архив для архитектуры вашего Mac.'
    return 1
  fi
  "$DW_NODE" --input-type=module -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<12)){console.error("Нужен Node.js 22.12 или новее.");process.exit(1);}' || return 1
  export DW_NODE
}

dw_download_node() {
  # Used by source Prepare only. Start never calls this function.
  local dw_arch dw_version dw_hash dw_filename dw_tmp dw_actual
  dw_arch="$(uname -m)"
  case "$dw_arch" in
    arm64) dw_hash="$(awk -F '"' '/"darwinArm64Sha256":/ { print $4; exit }' "$DW_MACOS_SCRIPTS/runtime-lock.json")" ;;
    x86_64) dw_arch=x64; dw_hash="$(awk -F '"' '/"darwinX64Sha256":/ { print $4; exit }' "$DW_MACOS_SCRIPTS/runtime-lock.json")" ;;
    *) dw_fail "Неизвестная архитектура Mac: $dw_arch"; return 1 ;;
  esac
  dw_version="$(awk -F '"' '/"nodeVersion":/ { print $4; exit }' "$DW_MACOS_SCRIPTS/runtime-lock.json")"
  [[ "$dw_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || dw_fail 'Некорректная версия Node.js в runtime-lock.json.'
  [[ "$dw_hash" =~ ^[0-9a-f]{64}$ ]] || dw_fail 'Не задана контрольная сумма Node.js.'
  dw_filename="node-$dw_version-darwin-$dw_arch.tar.gz"
  mkdir -p "$DW_PROJECT_ROOT/runtime"
  dw_tmp="$(mktemp -d "$DW_PROJECT_ROOT/runtime/.node-download.XXXXXX")"
  printf 'Загрузка официального Node.js %s (%s); это подготовительный этап.\n' "$dw_version" "$dw_arch"
  if ! /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --retry 2 \
    "https://nodejs.org/dist/$dw_version/$dw_filename" -o "$dw_tmp/node.tar.gz"; then
    rm -rf -- "$dw_tmp"; dw_fail 'Не удалось загрузить Node.js. Повторите подготовку при наличии интернета.'; return 1
  fi
  dw_actual="$(/usr/bin/shasum -a 256 "$dw_tmp/node.tar.gz" | awk '{print $1}')"
  if [ "$dw_actual" != "$dw_hash" ]; then
    rm -rf -- "$dw_tmp"; dw_fail 'Контрольная сумма Node.js не совпала. Архив не был установлен.'; return 1
  fi
  /usr/bin/tar -xzf "$dw_tmp/node.tar.gz" -C "$dw_tmp"
  if [ -e "$DW_PROJECT_ROOT/runtime/node" ]; then
    rm -rf -- "$dw_tmp"; dw_fail 'runtime/node уже существует. Проверьте существующую установку вручную.'; return 1
  fi
  mv "$dw_tmp/node-$dw_version-darwin-$dw_arch" "$DW_PROJECT_ROOT/runtime/node"
  rm -rf -- "$dw_tmp"
  dw_find_node
}
