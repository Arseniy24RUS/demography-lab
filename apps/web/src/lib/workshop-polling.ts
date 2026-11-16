/** Spread classroom polling over time, including when the whole class opens a stage at once. */
export function startWorkshopPolling(interval: number, poll: () => void | Promise<void>) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    timer = setTimeout(async () => {
      try {
        if (document.visibilityState === 'visible') await poll();
      } finally {
        if (!cancelled) schedule(Math.round(interval * (.8 + .4 * Math.random())));
      }
    }, delay);
  };
  schedule(Math.round(interval * (.3 + .9 * Math.random())));
  return () => { cancelled = true; clearTimeout(timer); };
}
