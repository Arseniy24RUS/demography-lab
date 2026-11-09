import { useEffect, useState } from 'react';

/** Keep desktop context open; put secondary context behind one tap on a phone. */
export function useResponsiveDisclosure() {
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 761px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 761px)');
    const update = () => setOpen(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return [open, setOpen] as const;
}
