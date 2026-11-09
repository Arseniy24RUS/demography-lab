#!/usr/bin/env node
/** Network inventory only: never contacts the Internet or changes host networking. */
import { networkInterfaces, platform } from 'node:os';
import { pathToFileURL } from 'node:url';

export function getNetworkInterfaces() {
  try { return networkInterfaces(); } catch { return {}; }
}

export function ipv4Kind(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  const [a, b] = parts.map(Number);
  if (a === 127 || a === 0 || a >= 224) return null;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  return 'public';
}

export function networkInventory(interfaces = getNetworkInterfaces(), port = 8787, surveyPort = 8788) {
  for (const value of [port, surveyPort]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Порт должен быть целым числом от 1024 до 65535.');
  }
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || !['IPv4', 4].includes(address.family)) continue;
      const kind = ipv4Kind(address.address);
      if (!kind) continue;
      candidates.push({ name, address: address.address, kind,
        likelyVirtual: /^(?:utun|tun|tap|docker|veth|vmnet|vbox|tailscale)/i.test(name),
        classroomUrl: `http://${address.address}:${port}/`,
        surveyOrigin: `http://${address.address}:${surveyPort}` });
    }
  }
  candidates.sort((a, b) => Number(a.likelyVirtual) - Number(b.likelyVirtual)
    || (a.kind === 'private' ? 0 : 1) - (b.kind === 'private' ? 0 : 1)
    || a.name.localeCompare(b.name));
  return { schemaVersion: 1, platform: platform(), port, surveyPort,
    hostUrl: `http://127.0.0.1:${port}/`, candidates,
    automaticHotspot: false, automaticCaptivePortal: false };
}

export function networkText(inventory) {
  const privateCandidates = inventory.candidates.filter((candidate) => candidate.kind === 'private');
  const lines = [
    'Локальная сеть семинара',
    '',
    `На компьютере преподавателя: ${inventory.hostUrl}`,
    'Адрес 127.0.0.1 работает только на самом Mac; слушателям нужен адрес сетевого интерфейса.',
    '',
  ];
  for (const candidate of inventory.candidates) {
    lines.push(`${candidate.name}: ${candidate.classroomUrl}${candidate.likelyVirtual ? ' (возможно VPN/виртуальная сеть)' : ''}`);
    lines.push(`  Отдельный адрес анкеты: ${candidate.surveyOrigin}`);
    if (candidate.kind === 'link-local') lines.push('  Самоназначенный адрес: DHCP не подтверждён; проверьте настройку локальной сети.');
    if (candidate.kind === 'public') lines.push('  Публичный адрес: не используйте его как адрес закрытой учебной Wi-Fi сети.');
  }
  if (!privateCandidates.length) lines.push('Частный IPv4-адрес пока не обнаружен. Подключите Mac к выбранной учебной сети и повторите проверку.');
  lines.push('',
    'Надёжная схема без интернета: отдельный Wi-Fi роутер с DHCP, WAN не подключён; Mac и слушатели в одной сети.',
    'Отключите изоляцию Wi-Fi клиентов/Guest isolation в настройках роутера: участники должны достигать Mac.',
    'Вариант точки доступа Mac: Системные настройки → Основные → Общий доступ → Общий интернет.',
    'Apple описывает раздачу с отдельного источника (например Ethernet) на Wi-Fi. Наличие такой конфигурации нужно проверить на вашем Mac заранее.',
    'Программа не превращает единственный Wi-Fi адаптер в гарантированную автономную точку доступа.',
    '',
    'После подключения телефона выберите «Использовать без интернета», если ОС спрашивает, затем откройте адрес/QR платформы в обычном браузере.',
    'Автоматическое открытие страницы зависит от captive portal роутера и поведения ОС; обычная точка доступа этого не гарантирует.',
    'Разрешите входящие подключения Node.js, если macOS показывает запрос; разрешение Local Network также должно быть включено.',
    'Порты приложения и отдельной анкеты должны быть доступны внутри выбранной сети; интернет и DNS для них не нужны.',
    'Все сведения получены с этого компьютера. Внешние сетевые запросы не выполнялись.');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = networkInventory(getNetworkInterfaces(), Number(process.env.DW_OFFLINE_PORT ?? 8787), Number(process.env.DW_OFFLINE_SURVEY_PORT ?? 8788));
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : networkText(result));
}
