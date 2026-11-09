import type { CloudConfig } from './cloud-config';

export interface WorkshopIdentitySession {
  access_token: string;
  expires_at?: number;
  user: { id: string; email?: string | null; user_metadata?: { full_name?: string } };
}
export interface EntryError { message: string; code?: string }
interface RpcResult { data: unknown; error: EntryError | null }
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu;
const token = /^[a-f\d]{64}$/u;

function parseSession(value: unknown): WorkshopIdentitySession {
  const session = (value as { session?: WorkshopIdentitySession } | null)?.session;
  if (!session || !token.test(session.access_token) || !session.user || !uuid.test(session.user.id) ||
    (session.user.email !== undefined && session.user.email !== null && typeof session.user.email !== 'string') ||
    typeof session.expires_at !== 'number' || !Number.isFinite(session.expires_at))
    throw new Error('Сервер вернул некорректные сведения о входе.');
  return session;
}

/** Declared email identifies educational work. Transport credentials are entirely automatic. */
export class DeclaredIdentity {
  private session: WorkshopIdentitySession | null = null;
  private generation = 0;
  private readonly storageKey: string;
  private readonly listeners = new Set<(session: WorkshopIdentitySession | null) => void>();
  constructor(private readonly config: CloudConfig, private readonly send: typeof fetch = fetch) {
    this.storageKey = `dw-entry-v1:${new URL(config.url).host}`;
    if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
      if (event.key === this.storageKey) {
        this.generation += 1;
        this.session = this.read();
        this.emit();
      }
    });
  }
  private read(): WorkshopIdentitySession | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const result = parseSession(JSON.parse(raw));
      return result.expires_at! * 1000 > Date.now() ? result : null;
    } catch { return null; }
  }
  private emit() { for (const listener of this.listeners) listener(this.session); }
  private set(session: WorkshopIdentitySession | null) {
    this.generation += 1;
    this.session = session;
    try {
      if (session) localStorage.setItem(this.storageKey, JSON.stringify({ session }));
      else localStorage.removeItem(this.storageKey);
    } catch { /* The current tab stays usable when durable browser storage is disabled. */ }
    this.emit();
  }
  onChange(listener: (session: WorkshopIdentitySession | null) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async request(method: string, args: Record<string, unknown>): Promise<RpcResult> {
    try {
      const send = this.send;
      const response = await send(`${this.config.url}/rest/v1/rpc/${method}`, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        headers: { apikey: this.config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(30000),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        return { data: null, error: { message: String(row.message ?? 'SERVER'), code: String(row.code ?? '') } };
      }
      return { data: body, error: null };
    } catch {
      return { data: null, error: { message: 'fetch: server unavailable', code: 'NETWORK' } };
    }
  }
  async identify(input: { email: string; fullName: string }) {
    const { data, error } = await this.request('dw_identify', {
      p_email: input.email.normalize('NFC').trim().toLowerCase(),
      p_full_name: input.fullName.normalize('NFC').trim().replace(/\s+/gu, ' '),
    });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    const session = parseSession(data);
    this.set(session);
    return session;
  }
  async getSession(): Promise<WorkshopIdentitySession | null> {
    const generation = this.generation;
    const saved = this.session ?? this.read();
    if (!saved) return null;
    const { data, error } = await this.request('dw_entry_session', { p_token: saved.access_token });
    // Neither a late success nor a late denial may replace a newer identity.
    if (this.generation !== generation) return this.session;
    if (error) {
      if (error.message === 'AUTH_REQUIRED' || error.message.startsWith('AUTH_REQUIRED:')) {
        this.set(null); return null;
      }
      throw new Error('Не удалось открыть вашу работу. Проверьте соединение и войдите снова.');
    }
    const session = parseSession(data);
    this.set(session);
    return session;
  }
  async acceptHostLink(accessToken: string): Promise<WorkshopIdentitySession> {
    if (!token.test(accessToken)) throw new Error('Ссылка преподавателя недействительна.');
    const { data, error } = await this.request('dw_entry_session', { p_token: accessToken });
    if (error) throw new Error('Ссылка преподавателя недействительна или срок её действия истёк.');
    const session = parseSession(data);
    this.set(session);
    return session;
  }
  async rpc(method: string, args: Record<string, unknown>): Promise<RpcResult> {
    const session = this.session ?? this.read();
    if (!session) return { data: null, error: { message: 'AUTH_REQUIRED' } };
    this.session = session;
    const result = await this.request('dw_entry_rpc', {
      p_token: session.access_token, p_method: method, p_args: args,
    });
    if (this.session?.access_token !== session.access_token)
      return { data: null, error: { message: 'AUTH_REQUIRED' } };
    if (result.error?.message === 'AUTH_REQUIRED') this.set(null);
    return result;
  }
  async signOut() {
    const saved = this.session ?? this.read();
    if (saved) {
      const { error } = await this.request('dw_entry_logout', { p_token: saved.access_token });
      if (error && error.message !== 'AUTH_REQUIRED')
        throw new Error('Не удалось завершить вход. Проверьте соединение и повторите действие.');
    }
    this.set(null);
  }
}
