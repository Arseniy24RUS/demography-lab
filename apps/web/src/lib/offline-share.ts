import { isLocalNetworkHost, isLoopbackHost } from './local-network';
export interface LocalShareAddress { host: string; joinCode: string }
export const LOCAL_ADDRESS_EVENT = 'demography-local-address';
const storageKey = (instance: string) => `dw-local-share-v1:${instance}`;
let memory: { instance: string; address: LocalShareAddress } | null = null;
export function readLocalShareAddress(instance: string): LocalShareAddress | null {
  if (memory?.instance === instance) return memory.address;
  try {
    const text = localStorage.getItem(storageKey(instance));
    if (!text) return null;
    const value = JSON.parse(text) as LocalShareAddress;
    if (!isLocalNetworkHost(value.host) || isLoopbackHost(value.host) ||
      typeof value.joinCode !== 'string' || value.joinCode.length > 80) return null;
    return value;
  } catch { return null; }
}
export function selectLocalShareAddress(instance: string, address: LocalShareAddress) {
  if (!isLocalNetworkHost(address.host) || isLoopbackHost(address.host)) return;
  const previous = readLocalShareAddress(instance);
  if (previous?.host === address.host && previous.joinCode === address.joinCode) return;
  memory = { instance, address };
  try { localStorage.setItem(storageKey(instance), JSON.stringify(address)); } catch { /* In-memory still usable. */ }
  window.dispatchEvent(new Event(LOCAL_ADDRESS_EVENT));
}
export function localShareUrl(value: string, address: LocalShareAddress, includeNetwork = false): string {
  const url = new URL(value);
  if (!isLocalNetworkHost(url.hostname) || !isLocalNetworkHost(address.host) || isLoopbackHost(address.host))
    throw new Error('Приглашение должно вести на локальный сервер семинара.');
  url.hostname = address.host;
  if (includeNetwork) {
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set('network', address.joinCode);
    url.hash = hash.toString();
  }
  return url.href;
}
