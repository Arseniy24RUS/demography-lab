/** Exact-release resource addressing. Auth/API URLs never enter this map. */
const used = new Set();
const isRequest=value=>typeof Request!=='undefined'&&value instanceof Request;
export function getReleaseContext() { return globalThis.__RUDN_RELEASE__ || null; }
export function setReleaseContext(context) {
  if (!context || !/^[a-f0-9]{24,64}$/.test(context.buildId || '') || !context.resources) throw new Error('release/invalid-context');
  const previous = getReleaseContext();
  if (previous && previous.buildId !== context.buildId) throw new Error('release/context-already-bound');
  const entries = Object.fromEntries(Object.entries(context.resources).map(([key, value]) => [key, Object.freeze({...value})]));
  const contracts = context.contracts ? Object.freeze({...context.contracts,modules:Object.freeze({...context.contracts.modules})}) : null;
  globalThis.__RUDN_RELEASE__ = Object.freeze({...context, contracts, resources:Object.freeze(entries)});
  globalThis.dispatchEvent?.(new CustomEvent('rudn:release-context', {detail:{buildId:context.buildId}}));
  return globalThis.__RUDN_RELEASE__;
}
export function logicalResourcePath(input, moduleBase, context = getReleaseContext()) {
  const url = new URL(isRequest(input) ? input.url : input, moduleBase || globalThis.location?.href || import.meta.url);
  if (!context) return null;
  const root = new URL(context.siteRoot), runtime = new URL(context.runtimeRoot, root);
  if (url.origin !== root.origin) return null;
  if (url.pathname.startsWith(runtime.pathname)) return url.pathname.slice(runtime.pathname.length);
  if (url.pathname.startsWith(root.pathname)) return url.pathname.slice(root.pathname.length);
  return null;
}
export function resourceURL(input, moduleBase) {
  const original = new URL(isRequest(input) ? input.url : input, moduleBase || globalThis.location?.href || import.meta.url);
  const context = getReleaseContext(), path = logicalResourcePath(original, moduleBase, context);
  const entry = path && context?.resources?.[path];
  if (!entry) return original;
  used.add(path);
  const result = new URL(entry.url, context.siteRoot);
  // Queries used by application logic remain intact; the physical pathname pins bytes.
  result.search = original.search; result.hash = original.hash;
  return result;
}
export function usedReleaseResources({module} = {}) {
  const prefix = module ? `apps/${module}/` : null;
  return [...used].filter(path => !prefix || path.startsWith(prefix));
}
export function releaseFetch(input, options, moduleBase) {
  const url = resourceURL(input, moduleBase);
  return globalThis.fetch(isRequest(input) ? new Request(url, input) : url, options);
}
