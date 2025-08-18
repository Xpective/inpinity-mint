export default {
  async fetch(req) {
    const upstream = "https://api.mainnet-beta.solana.com";
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (req.method !== "POST") {
      return new Response("Only POST", { status: 405, headers: cors });
    }

    const body = await req.arrayBuffer();
    const r = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });

    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: r.status,
      headers: { ...cors, "content-type": "application/json" }
    });
  }
};
