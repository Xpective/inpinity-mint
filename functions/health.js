// functions/health.js
export const onRequestGet = async () => {
  const upstream = "https://api.mainnet-beta.solana.com";
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" });

  const resp = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });

  const json = await resp.json().catch(() => ({}));
  return new Response(JSON.stringify({ ok: resp.ok, health: json.result || json.error || null }), {
    headers: { "content-type": "application/json" },
    status: resp.ok ? 200 : 503,
  });
};
