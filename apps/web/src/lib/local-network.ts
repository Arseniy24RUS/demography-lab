/** Classroom addresses allowed only by an explicit, same-origin offline configuration. */
export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host.endsWith('.local')) return true;
  if (/^\[(?:fc|fd|fe[89ab])[a-f0-9:]+\]$/u.test(host)) return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return false;
  const octets = host.split('.').map(Number);
  if (octets.some((value) => value > 255)) return false;
  return octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254);
}

export function isLoopbackHost(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname.toLowerCase());
}
