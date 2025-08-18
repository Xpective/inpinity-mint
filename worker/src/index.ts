// worker/src/index.ts
import type { KVNamespace } from '@cloudflare/workers-types';

export interface Env {
  UPSTREAM_RPC: string;
  BACKUP_RPC?: string;
  ALLOWED_ORIGINS: string;   // CSV
  ALLOWED_HEADERS?: string;  // CSV
  REMOTE_CLAIMS_URL?: string;
  CLAIMS: KVNamespace;
}

/* ---------- CORS ---------- */
function parseCsv(v: string | undefined) {
  return (v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function pickOrigin(req: Request, allowedCsv: string) {
  const origin = req.headers.get('Origin') || '';
  const allowed = parseCsv(allowedCsv);
  if (allowed.length === 0) return '*';
  return allowed.includes(origin) ? origin : allowed[0];
}

function corsHeaders(origin: string, contentType = 'text/plain') {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    // Wichtig: solana-client zulassen (für @solana/web3.js)
    'Access-Control-Allow-Headers': 'content-type,solana-client,accept,accept-language',
    'Access-Control-Max-Age': '86400',
    'Content-Type': contentType,
    'Vary': 'Origin',
  };
}

function ok(json: unknown, origin: string) {
  return new Response(JSON.stringify(json), {
    headers: corsHeaders(origin, 'application/json'),
  });
}

function text(msg: string, origin: string, status = 200) {
  return new Response(msg, { status, headers: corsHeaders(origin, 'text/plain') });
}

/* ---------- RPC Forward ---------- */
const ALLOWED_METHODS = new Set<string>([
  'getLatestBlockhash',
  'getBalance',
  'getAccountInfo',
  'getSignatureStatuses',
  'sendTransaction',
  'simulateTransaction',
  'getMinimumBalanceForRentExemption',
  'getBlockHeight',
  'getRecentPrioritizationFees',
]);

function isRetryableStatus(s: number) {
  return s === 403 || s === 429 || (s >= 500 && s <= 599);
}

async function forwardOnce(endpoint: string, body: unknown) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function forwardWithFallback(env: Env, body: unknown) {
  let r = await forwardOnce(env.UPSTREAM_RPC, body);
  if (!isRetryableStatus(r.status)) return r;

  if (env.BACKUP_RPC) {
    const r2 = await forwardOnce(env.BACKUP_RPC, body);
    if (r2.ok || !isRetryableStatus(r2.status)) return r2;
  }
  return r;
}

/* ---------- Claims ---------- */
async function getClaims(env: Env): Promise<number[]> {
  // optional remote
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const r = await fetch(env.REMOTE_CLAIMS_URL, { cf: { cacheTtl: 60, cacheEverything: true } as any });
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
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.claimed)) return parsed.claimed;
  } catch {}
  return [];
}

async function addClaim(env: Env, i: number) {
  const arr = await getClaims(env);
  if (!arr.includes(i)) arr.push(i);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
}

/* ---------- Worker ---------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = pickOrigin(req, env.ALLOWED_ORIGINS || '*');

    // CORS Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health
    if (url.pathname === '/') {
      return text('OK: inpinity-rpc-proxy', origin);
    }

    // Debug
    if (url.pathname === '/debug') {
      const info: any = {
        hasUPSTREAM: !!env.UPSTREAM_RPC,
        hasBACKUP: !!env.BACKUP_RPC,
        allowed: env.ALLOWED_ORIGINS,
      };
      try { info.upstreamHEAD = (await fetch(env.UPSTREAM_RPC, { method: 'HEAD' })).status; } catch { info.upstreamHEAD = 'ERR'; }
      try { info.backupHEAD  = env.BACKUP_RPC ? (await fetch(env.BACKUP_RPC,  { method: 'HEAD' })).status : 'N/A'; } catch { info.backupHEAD = 'ERR'; }
      return ok(info, origin);
    }

    // RPC
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any;
      try { body = await req.json(); }
      catch { return text('Bad JSON', origin, 400); }

      const methods = Array.isArray(body) ? body.map((c) => c?.method) : [body?.method];
      if (methods.some((m) => !ALLOWED_METHODS.has(m))) {
        return text('RPC method not allowed', origin, 403);
      }

      const resp = await forwardWithFallback(env, body);
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
          if (typeof index !== 'number' || index < 0) return text('Invalid index', origin, 400);
          await addClaim(env, index);
          return ok({ ok: true }, origin);
        } catch { return text('Bad JSON', origin, 400); }
      }
      return text('Method not allowed', origin, 405);
    }

    return text('Not found', origin, 404);
  },
};