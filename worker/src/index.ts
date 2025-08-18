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

/* ---------- CORS ---------- */
const parseList = (s?: string) => (s || '').split(',').map(x=>x.trim()).filter(Boolean);
const pickOrigin = (req: Request, list: string[]) => {
  const o = req.headers.get('Origin') || '';
  return o && list.includes(o) ? o : (list[0] || '*');
};
const corsHeaders = (origin: string, ctype='text/plain') => ({
  'Content-Type': ctype,
  'Access-Control-Allow-Origin': origin,
  'Vary': 'Origin, Accept-Encoding',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,solana-client,accept,accept-language',
  'Access-Control-Max-Age': '86400',
});
const ok  = (data: unknown, origin: string) => new Response(JSON.stringify(data), { status: 200, headers: corsHeaders(origin, 'application/json') });
const txt = (msg: string, origin: string, status=200) => new Response(msg, { status, headers: corsHeaders(origin, 'text/plain') });

/* ---------- RPC ---------- */
const forwardRpcOnce = (endpoint: string, body: unknown) =>
  fetch(endpoint, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });

const isRetryable = (s: number) => s===403 || s===429 || (s>=500 && s<=599);
const forwardRpc = async (env: Env, body: unknown) => {
  let r: Response;
  try { r = await forwardRpcOnce(env.UPSTREAM_RPC, body); } catch { r = new Response('UPSTREAM error', { status: 599 }); }
  if (!isRetryable(r.status)) return r;
  if (env.BACKUP_RPC) {
    try {
      const r2 = await forwardRpcOnce(env.BACKUP_RPC, body);
      if (r2.ok || !isRetryable(r2.status)) return r2;
      return r2;
    } catch {}
  }
  return r;
};

/* ---------- Claims ---------- */
const getClaims = async (env: Env): Promise<number[]> => {
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const r = await fetch(env.REMOTE_CLAIMS_URL, { cf:{ cacheTtl:60, cacheEverything:true } as RequestInitCfProperties });
      if (r.ok) {
        const d = await r.json() as any;
        if (Array.isArray(d)) return d;
        if (Array.isArray(d?.claimed)) return d.claimed;
      }
    } catch {}
  }
  const raw = await env.CLAIMS.get('claimed');
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.claimed)) return j.claimed;
  } catch {}
  return [];
};
const addClaim = async (env: Env, i: number) => {
  const arr = await getClaims(env);
  if (!arr.includes(i)) arr.push(i);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
};

/* ---------- Handler ---------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const allow = parseList(env.ALLOWED_ORIGINS);
    const origin = pickOrigin(req, allow);

    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/' || url.pathname === '/health')
      return txt('OK: inpinity-rpc-proxy', origin);

    if (url.pathname === '/debug')
      return ok({ upstream: env.UPSTREAM_RPC, backup: env.BACKUP_RPC||null, allowed: env.ALLOWED_ORIGINS||'' }, origin);

    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any; try { body = await req.json(); } catch { return txt('Bad JSON', origin, 400); }
      const resp = await forwardRpc(env, body);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: corsHeaders(origin, 'application/json') });
    }

    if (url.pathname === '/claims') {
      if (req.method === 'GET')  return ok({ claimed: await getClaims(env) }, origin);
      if (req.method === 'POST') {
        try {
          const { index } = await req.json() as { index?: unknown };
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return txt('Invalid index', origin, 400);
          await addClaim(env, index);
          return ok({ ok:true }, origin);
        } catch { return txt('Bad JSON', origin, 400); }
      }
      return txt('Method not allowed', origin, 405);
    }

    return txt('Not found', origin, 404);
  }
};