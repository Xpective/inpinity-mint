// worker/src/index.ts
import type {
  KVNamespace,
  RequestInitCfProperties,
} from '@cloudflare/workers-types';

export interface Env {
  UPSTREAM_RPC: string;
  BACKUP_RPC?: string;
  ALLOWED_ORIGINS: string;
  REMOTE_CLAIMS_URL?: string;
  CLAIMS: KVNamespace;
}

function corsHeaders(origin: string, contentType: string) {
  return {
    'content-type': contentType,
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization',
    'access-control-max-age': '86400',
  };
}

const ok = (data: unknown, origin: string) =>
  new Response(JSON.stringify(data), { headers: corsHeaders(origin, 'application/json') });

const text = (txt: string, origin: string, status = 200) =>
  new Response(txt, { status, headers: corsHeaders(origin, 'text/plain') });

function pickOrigin(req: Request, allowed: string): string {
  const o = req.headers.get('origin') || '';
  const allow = allowed.split(',').map((s) => s.trim().toLowerCase());
  return allow.includes(o.toLowerCase()) ? o : '*';
}

// Eng gefasste Allowlist für JSON-RPC:
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
  let resp = await forwardRpcOnce(env.UPSTREAM_RPC, body);
  if (!isRetryableStatus(resp.status)) return resp;

  // 2) Fallback
  const backup = env.BACKUP_RPC;
  if (backup && backup.length > 0) {
    const resp2 = await forwardRpcOnce(backup, body);
    if (resp2.ok || !isRetryableStatus(resp2.status)) return resp2;
  }
  return resp;
}

async function getClaims(env: Env): Promise<number[]> {
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const init: RequestInit & { cf?: RequestInitCfProperties } = {
        cf: { cacheTtl: 60, cacheEverything: true },
      };
      const r = await fetch(env.REMOTE_CLAIMS_URL, init);
      if (r.ok) {
        const data = await r.json() as any;
        if (Array.isArray(data)) return data as number[];
        if (Array.isArray(data?.claimed)) return data.claimed as number[];
      }
    } catch {}
  }
  const raw = await env.CLAIMS.get('claimed');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as number[];
    if (Array.isArray(parsed?.claimed)) return parsed.claimed as number[];
    return [];
  } catch {
    return [];
  }
}

async function addClaim(env: Env, i: number) {
  const arr = await getClaims(env);
  if (!arr.includes(i)) arr.push(i);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = pickOrigin(req, env.ALLOWED_ORIGINS || '*');

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin, 'text/plain') });
    }

    if (url.pathname === '/') {
      return text('OK: inpinity-rpc-proxy', origin);
    }

    // ✨ Debug-Route: zeigt, ob BACKUP_RPC gesetzt ist
    if (url.pathname === '/debug') {
      const info: any = {
        hasUPSTREAM: !!env.UPSTREAM_RPC,
        hasBACKUP: !!env.BACKUP_RPC,
        allowed: env.ALLOWED_ORIGINS,
      };
      try { info.upstreamHEAD = (await fetch(env.UPSTREAM_RPC, { method: 'HEAD' })).status; } catch { info.upstreamHEAD = 'ERR'; }
      try { info.backupHEAD = env.BACKUP_RPC ? (await fetch(env.BACKUP_RPC, { method: 'HEAD' })).status : 'N/A'; } catch { info.backupHEAD = 'ERR'; }
      return ok(info, origin);
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any;
      try { body = await req.json(); }
      catch { return text('Bad JSON', origin, 400); }

      const methods = Array.isArray(body) ? body.map((c) => c?.method) : [body?.method];
      if (methods.some((m) => !ALLOWED_METHODS.has(m))) {
        return text('RPC method not allowed', origin, 403);
      }

      const resp = await forwardRpcWithFallback(env, body);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: corsHeaders(origin, 'application/json') });
    }

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