// functions/solana.js
export const onRequestOptions = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    },
  });
};

export const onRequestPost = async ({ request }) => {
  const upstream = "https://api.mainnet-beta.solana.com"; // originaler Solana RPC
  const body = await request.arrayBuffer();

  const resp = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });

  const buf = await resp.arrayBuffer();
  return new Response(buf, {
    status: resp.status,
    headers: {
      "content-type": resp.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
};
