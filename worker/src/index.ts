// worker/src/index.ts
import type { KVNamespace } from '@cloudflare/workers-types';

export interface Env {
  UPSTREAM_RPC: string;
  BACKUP_RPC?: string;
  ALLOWED_ORIGINS: string;    // Kommagetrennte Liste
  ALLOWED_HEADERS?: string;   // Kommagetrennt (optional)
  REMOTE_CLAIMS_URL?: string; // optional
  CLAIMS: KVNamespace;
}

/* ===================== CORS ===================== */

function parseList(v?: string) {
  return (v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function pickOrigin(req: Request, allowedList: string[]): string {
  const origin = req.headers.get('Origin') || '';
  if (!origin) return '*';
  if (allowedList.includes('*')) return origin;
  return allowedList.includes(origin) ? origin : (allowedList[0] || '*');
}

function buildCorsHeaders(origin: string, extraHeaders: Record<string, string> = {}) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    ...extraHeaders,
  };
}

function okJson(data: unknown, origin: string, more: Record<string,string> = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: buildCorsHeaders(origin, { 'content-type': 'application/json', ...more }),
  });
}

function text(body: string, origin: string, status = 200, more: Record<string,string> = {}) {
  return new Response(body, {
    status,
    headers: buildCorsHeaders(origin, { 'content-type': 'text/plain; charset=utf-8', ...more }),
  });
}

/* =============== RPC Proxy (Allowlist) =============== */

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

async function rpcOnce(endpoint: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function isRetryableStatus(s: number) {
  return s === 403 || s === 429 || (s >= 500 && s <= 599);
}

async function rpcWithFallback(env: Env, body: unknown): Promise<Response> {
  let r = await rpcOnce(env.UPSTREAM_RPC, body);
  if (!isRetryableStatus(r.status)) return r;

  if (env.BACKUP_RPC) {
    const r2 = await rpcOnce(env.BACKUP_RPC, body);
    if (r2.ok || !isRetryableStatus(r2.status)) return r2;
  }
  return r;
}

/* ===================== CLAIMS ===================== */

async function getClaims(env: Env): Promise<number[]> {
  // optionaler Remote-Reader
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const r = await fetch(env.REMOTE_CLAIMS_URL, { cf: { cacheTtl: 60, cacheEverything: true } as any });
      if (r.ok) {
        const j = await r.json() as any;
        if (Array.isArray(j)) return j as number[];
        if (Array.isArray(j?.claimed)) return j.claimed as number[];
      }
    } catch {}
  }
  const raw = await env.CLAIMS.get('claimed');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as number[];
    if (Array.isArray(parsed?.claimed)) return parsed.claimed as number[];
  } catch {}
  return [];
}

async function addClaim(env: Env, idx: number) {
  const arr = await getClaims(env);
  if (!arr.includes(idx)) arr.push(idx);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
}

/* ===================== Worker ===================== */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const allowHeaders = parseList(env.ALLOWED_HEADERS || 'content-type,solana-client,accept,accept-language');
    const origin = pickOrigin(req, allowedOrigins);

    // Preflight
    if (req.method === 'OPTIONS') {
      const h = buildCorsHeaders(origin, {
        'Access-Control-Allow-Headers': allowHeaders.join(','),
      });
      return new Response(null, { status: 204, headers: h });
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
        allowed: allowedOrigins,
      };
      try { info.upstreamHEAD = (await fetch(env.UPSTREAM_RPC, { method: 'HEAD' })).status; } catch { info.upstreamHEAD = 'ERR'; }
      try { info.backupHEAD = env.BACKUP_RPC ? (await fetch(env.BACKUP_RPC, { method: 'HEAD' })).status : 'N/A'; } catch { info.backupHEAD = 'ERR'; }
      return okJson(info, origin);
    }

    // RPC Proxy
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any;
      try { body = await req.json(); }
      catch { return text('Bad JSON', origin, 400); }

      const methods = Array.isArray(body) ? body.map((c) => c?.method) : [body?.method];
      if (methods.some((m) => !ALLOWED_METHODS.has(m))) {
        return text('RPC method not allowed', origin, 403);
      }

      const resp = await rpcWithFallback(env, body);
      const payload = await resp.text();
      return new Response(payload, {
        status: resp.status,
        headers: buildCorsHeaders(origin, {
          'content-type': 'application/json',
          'Access-Control-Allow-Headers': allowHeaders.join(','),
        }),
      });
    }

    // Claims
    if (url.pathname === '/claims') {
      if (req.method === 'GET') {
        const claimed = await getClaims(env);
        return okJson({ claimed }, origin);
      }
      if (req.method === 'POST') {
        try {
          const { index } = (await req.json()) as { index?: unknown };
          if (typeof index !== 'number' || index < 0) return text('Invalid index', origin, 400);
          await addClaim(env, index);
          return okJson({ ok: true }, origin);
        } catch { return text('Bad JSON', origin, 400); }
      }
      return text('Method not allowed', origin, 405);
    }

    return text('Not found', origin, 404);
  },
};