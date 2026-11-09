/** Retirement artifact: no imports, credentials, database connection or mutation. */
Deno.serve(() => new Response('Not found', {
  status: 404,
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
}));
