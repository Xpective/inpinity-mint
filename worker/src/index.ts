// worker/src/index.ts
import type { KVNamespace, RequestInitCfProperties } from '@cloudflare/workers-types';

export interface Env {
  UPSTREAM_RPC: string;
  BACKUP_RPC?: string;
  ALLOWED_ORIGINS?: string;
  ALLOWED_HEADERS?: string;
  REMOTE_CLAIMS_URL?: string;
  CLAIMS: KVNamespace;
}

/* ---------- helpers: CORS ---------- */
const parseCsv = (s?: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean);
const pickOrigin = (req: Request, allowed: string[]) => {
  const o = req.headers.get('Origin') || '';
  return o && allowed.includes(o) ? o : (allowed[0] || '*');
};
const cors = (origin: string, ctype = 'text/plain') => ({
  'Content-Type': ctype,
  'Access-Control-Allow-Origin': origin,
  'Vary': 'Origin, Accept-Encoding',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  // solana-client MUSS erlaubt sein:
  'Access-Control-Allow-Headers': 'content-type,solana-client,accept,accept-language',
  'Access-Control-Max-Age': '86400',
});
const ok  = (data: unknown, origin: string) =>
  new Response(JSON.stringify(data), { status: 200, headers: cors(origin, 'application/json') });
const txt = (msg: string, origin: string, status = 200) =>
  new Response(msg, { status, headers: cors(origin, 'text/plain') });

/* ---------- RPC forward mit robustem Fallback ---------- */
const isRetryable = (s: number) => s === 403 || s === 429 || (s >= 500 && s <= 599);
const callRpc = (endpoint: string, body: unknown) =>
  fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function forwardRpc(env: Env, body: unknown): Promise<Response> {
  // Versuche zuerst BACKUP (weniger häufig geblockt), dann UPSTREAM.
  const order = [env.BACKUP_RPC, env.UPSTREAM_RPC].filter(Boolean) as string[];
  let last: Response | null = null;

  for (const ep of order) {
    try {
      const r = await callRpc(ep, body);
      if (!isRetryable(r.status)) return r; // ok oder harter Fehler (z.B. 400)
      last = r; // retryable → probiere nächsten
    } catch {
      // Netzfehler → versuche nächsten
    }
  }
  return last ?? new Response('No RPC reachable', { status: 599 });
}

/* ---------- Claims (GET/POST) ---------- */
async function getClaims(env: Env): Promise<number[]> {
  // optional Remote-Quelle
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const r = await fetch(env.REMOTE_CLAIMS_URL, {
        cf: { cacheTtl: 60, cacheEverything: true } as RequestInitCfProperties
      });
      if (r.ok) {
        const d = await r.json() as any;
        if (Array.isArray(d)) return d;
        if (Array.isArray(d?.claimed)) return d.claimed;
      }
    } catch {}
  }
  // KV-Fallback
  try {
    const raw = await env.CLAIMS.get('claimed');
    if (!raw) return [];
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.claimed)) return j.claimed;
  } catch {}
  return [];
}

async function addClaim(env: Env, i: number) {
  const arr = await getClaims(env);
  if (!arr.includes(i)) arr.push(i);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
}

/* ---------- Handler ---------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const allowed = parseCsv(env.ALLOWED_ORIGINS);
    const origin  = pickOrigin(req, allowed);

    // CORS Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Health
    if (url.pathname === '/' || url.pathname === '/health') {
      return txt('OK: inpinity-rpc-proxy', origin);
    }

    // Debug
    if (url.pathname === '/debug') {
      return ok({
        upstream: env.UPSTREAM_RPC,
        backup: env.BACKUP_RPC || null,
        allowed: env.ALLOWED_ORIGINS || ''
      }, origin);
    }

    // JSON-RPC
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: unknown;
      try { body = await req.json(); }
      catch { return txt('Bad JSON', origin, 400); }

      const resp = await forwardRpc(env, body);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: cors(origin, 'application/json') });
    }

    // Claims (GET/POST)
    if (url.pathname === '/claims') {
      if (req.method === 'GET') {
        const claimed = await getClaims(env);
        return ok({ claimed }, origin);
      }
      if (req.method === 'POST') {
        try {
          const { index } = await req.json() as { index?: unknown };
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
            return txt('Invalid index', origin, 400);
          }
          await addClaim(env, index);
          return ok({ ok: true }, origin);
        } catch {
          return txt('Bad JSON', origin, 400);
        }
      }
      return txt('Method not allowed', origin, 405);
    }

    return txt('Not found', origin, 404);
  }
};