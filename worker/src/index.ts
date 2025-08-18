// worker/src/index.ts
import type { KVNamespace, RequestInitCfProperties } from '@cloudflare/workers-types';

export interface Env {
  // Upstream RPC (kann 403 geben) + Backup
  UPSTREAM_RPC: string;
  BACKUP_RPC?: string;

  // CORS
  ALLOWED_ORIGINS?: string;    // z.B. "https://inpinity.online,https://inpinity-mint.pages.dev"
  ALLOWED_HEADERS?: string;    // z.B. "content-type,solana-client,accept,accept-language"

  // Claims persistiert in KV
  REMOTE_CLAIMS_URL?: string;
  CLAIMS: KVNamespace;
}

/* -------------------- CORS -------------------- */
function parseList(s?: string) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}
function pickOrigin(req: Request, allowedList: string[]) {
  const origin = req.headers.get('Origin') || '';
  if (!origin) return '*';
  return allowedList.includes(origin) ? origin : (allowedList[0] || '*');
}
function corsHeaders(origin: string, contentType = 'text/plain') {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin, Accept-Encoding',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    // wichtig für solana/web3.js:
    'Access-Control-Allow-Headers': 'content-type,solana-client,accept,accept-language',
    'Access-Control-Max-Age': '86400',
  };
}
function ok(data: unknown, origin: string) {
  return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders(origin, 'application/json') });
}
function text(msg: string, origin: string, status = 200) {
  return new Response(msg, { status, headers: corsHeaders(origin, 'text/plain') });
}

/* -------------------- JSON-RPC Forward -------------------- */
// Nicht mehr nach Methoden whitelisten → einfach durchlassen
async function forwardRpcOnce(endpoint: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function isRetryableStatus(s: number) {
  return s === 403 || s === 429 || (s >= 500 && s <= 599);
}
async function forwardRpcWithFallback(env: Env, body: unknown): Promise<Response> {
  // 1) Primär
  let resp: Response;
  try { resp = await forwardRpcOnce(env.UPSTREAM_RPC, body); }
  catch { resp = new Response('UPSTREAM error', { status: 599 }); }
  if (!isRetryableStatus(resp.status)) return resp;

  // 2) Backup
  const backup = env.BACKUP_RPC;
  if (backup) {
    try {
      const r2 = await forwardRpcOnce(backup, body);
      if (r2.ok || !isRetryableStatus(r2.status)) return r2;
      return r2;
    } catch {
      // ignoriere, gib primary zurück
    }
  }
  return resp;
}

/* -------------------- Claims in KV -------------------- */
async function getClaims(env: Env): Promise<number[]> {
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const init: RequestInit & { cf?: RequestInitCfProperties } = { cf: { cacheTtl: 60, cacheEverything: true } };
      const r = await fetch(env.REMOTE_CLAIMS_URL, init);
      if (r.ok) {
        const data = await r.json() as any;
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.claimed)) return data.claimed;
      }
    } catch {}
  }
  const raw = await env.CLAIMS.get('claimed');
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.claimed)) return j.claimed;
    return [];
  } catch { return []; }
}
async function addClaim(env: Env, i: number) {
  const arr = await getClaims(env);
  if (!arr.includes(i)) arr.push(i);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
}

/* -------------------- Worker Handler -------------------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const allow = parseList(env.ALLOWED_ORIGINS);
    const origin = pickOrigin(req, allow);

    // Preflight CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health
    if (url.pathname === '/' || url.pathname === '/health') {
      return text('OK: inpinity-rpc-proxy', origin);
    }

    // Debug
    if (url.pathname === '/debug') {
      const info: any = {
        upstream: env.UPSTREAM_RPC,
        backup: env.BACKUP_RPC || null,
        allowed: env.ALLOWED_ORIGINS || '',
      };
      return ok(info, origin);
    }

    // RPC
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any;
      try { body = await req.json(); }
      catch { return text('Bad JSON', origin, 400); }

      const resp = await forwardRpcWithFallback(env, body);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: corsHeaders(origin, 'application/json') });
    }

    // Claims
    if (url.pathname === '/claims') {
      if (req.method === 'GET') {
        const claimed = await getClaims(env);
        return ok({ claimed }, origin);
      }
      if (req.method === 'POST') {
        try {
          const { index } = (await req.json()) as { index?: unknown };
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
            return text('Invalid index', origin, 400);
          }
          await addClaim(env, index);
          return ok({ ok: true }, origin);
        } catch {
          return text('Bad JSON', origin, 400);
        }
      }
      return text('Method not allowed', origin, 405);
    }

    return text('Not found', origin, 404);
  }
};