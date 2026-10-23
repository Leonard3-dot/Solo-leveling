// Cloudflare Worker : proxy DeepSeek pour Louis // Core
// Variables secrètes à créer dans Settings > Variables : ACCESS_CODE et DEEPSEEK_KEY
export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,x-access-code",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    };
    const json = { ...cors, "Content-Type": "application/json" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("Louis proxy DeepSeek OK", { headers: cors });
    if (req.headers.get("x-access-code") !== env.ACCESS_CODE)
      return new Response(JSON.stringify({ error: "code invalide" }), { status: 401, headers: json });
    let body;
    try { body = await req.json(); } catch (e) { return new Response(JSON.stringify({ error: "requete invalide" }), { status: 400, headers: json }); }
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.DEEPSEEK_KEY },
      body: JSON.stringify({ model: body.model || "deepseek-chat", messages: body.messages, stream: false, max_tokens: 1200 }),
    });
    return new Response(await r.text(), { status: r.status, headers: json });
  },
};
