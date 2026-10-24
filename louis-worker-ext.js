// LOUIS // CORE : extension du Worker Cloudflare (suggestions + accès temporaires)
// Prérequis : un KV lié sous le nom LOUIS_KV et un secret ADMIN_TOKEN.
// Utilisation : appelle handleLouis() tout au début de ton fetch actuel (voir le bas du fichier).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const isAdmin = (r, env) =>
  !!env.ADMIN_TOKEN && r.headers.get("Authorization") === "Bearer " + env.ADMIN_TOKEN;

// --- Sessions signées (secret SESSION_SECRET) ---
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const eq = (a, b) => a.length === b.length && [...a].reduce((r, c, i) => r | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
async function sign(data, secret, hex) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return hex ? Array.from(new Uint8Array(raw).slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("") : b64(raw);
}
async function mkToken(env, u) {
  const exp = Math.min(Date.now() + 12 * 36e5, u.exp > 0 ? u.exp : Infinity);
  const body = b64(enc.encode(JSON.stringify({ id: u.id, exp })));
  return { token: body + "." + (await sign(body, env.SESSION_SECRET)), texp: exp };
}
// À utiliser dans ton code existant pour protéger les routes IA : const who = await requireAuth(request, env); if (!who) return 401.
export async function requireAuth(request, env) {
  const t = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const [b, sg] = t.split(".");
  if (!b || !sg || !eq(sg, await sign(b, env.SESSION_SECRET))) return null;
  let q;
  try { q = JSON.parse(atob(b.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
  return q.exp > Date.now() ? q : null;
}

export async function handleLouis(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!["/suggest", "/suggestions", "/access", "/auth/salt", "/auth/login", "/auth/sync", "/auth/passwd"].includes(p)) return null; // route inconnue : ton code actuel prend le relais
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  // 1) Un joueur envoie une suggestion
  if (p === "/suggest" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch { return J({ error: "JSON invalide" }, 400); }
    const tx = String(b.tx || "").trim().slice(0, 600);
    if (tx.length < 10) return J({ error: "Message trop court" }, 400);
    const rk = "rl:" + (request.headers.get("CF-Connecting-IP") || "x");
    if (await env.LOUIS_KV.get(rk)) return J({ error: "Trop rapide" }, 429);
    await env.LOUIS_KV.put(rk, "1", { expirationTtl: 60 });
    const id = Date.now() + "-" + crypto.randomUUID().slice(0, 6);
    const item = { id, u: String(b.u || "?").slice(0, 40), ty: String(b.ty || "").slice(0, 30), tx, t: Date.now() };
    await env.LOUIS_KV.put("sg:" + id, JSON.stringify(item), { expirationTtl: 60 * 60 * 24 * 180 });
    return J({ ok: true });
  }

  // 2) L'admin lit ou supprime les suggestions
  if (p === "/suggestions") {
    if (!isAdmin(request, env)) return J({ error: "Non autorisé" }, 401);
    if (request.method === "DELETE") {
      await env.LOUIS_KV.delete("sg:" + url.searchParams.get("id"));
      return J({ ok: true });
    }
    const l = await env.LOUIS_KV.list({ prefix: "sg:", limit: 100 });
    const v = await Promise.all(l.keys.map((k) => env.LOUIS_KV.get(k.name, "json")));
    return J(v.filter(Boolean).sort((a, b) => b.t - a.t));
  }

  // 4) Comptes joueurs côté serveur
  // Le sel n'est donné que pour un nom saisi ; un nom inconnu reçoit un faux sel stable (aucune liste, aucune fuite d'existence)
  if (p === "/auth/salt" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch { return J({ error: "JSON invalide" }, 400); }
    const nm = String(b.name || "").trim().toLowerCase().slice(0, 40);
    const uid = nm ? await env.LOUIS_KV.get("un:" + nm) : null;
    const u = uid ? await env.LOUIS_KV.get("us:" + uid, "json") : null;
    return J({ salt: u ? u.salt : await sign("salt:" + nm, env.SESSION_SECRET, true) });
  }
  // Le joueur change lui-même son mot de passe (ancien hash exigé)
  if (p === "/auth/passwd" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch { return J({ error: "JSON invalide" }, 400); }
    const nm = String(b.name || "").trim().toLowerCase().slice(0, 40);
    const fk = "lf:" + (request.headers.get("CF-Connecting-IP") || "x") + nm;
    const n = Number(await env.LOUIS_KV.get(fk)) || 0;
    if (n >= 5) return J({ error: "Trop d'essais" }, 429);
    const uid = nm ? await env.LOUIS_KV.get("un:" + nm) : null;
    const u = uid ? await env.LOUIS_KV.get("us:" + uid, "json") : null;
    if (!u || !eq(String(b.oldHash || ""), u.hash)) {
      await env.LOUIS_KV.put(fk, String(n + 1), { expirationTtl: 300 });
      return J({ error: "Identifiants invalides" }, 401);
    }
    const salt = String(b.salt || ""), hash = String(b.hash || "");
    if (salt.length < 8 || salt.length > 100 || hash.length < 16 || hash.length > 200) return J({ error: "Format invalide" }, 400);
    u.salt = salt; u.hash = hash; u.pwt = Date.now();
    await env.LOUIS_KV.put("us:" + uid, JSON.stringify(u));
    return J({ ok: true });
  }

  if (p === "/auth/login" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch { return J({ error: "JSON invalide" }, 400); }
    const nm = String(b.name || "").trim().toLowerCase().slice(0, 40);
    const fk = "lf:" + (request.headers.get("CF-Connecting-IP") || "x") + nm;
    const n = Number(await env.LOUIS_KV.get(fk)) || 0;
    if (n >= 5) return J({ error: "Trop d'essais" }, 429);
    const uid = nm ? await env.LOUIS_KV.get("un:" + nm) : null;
    const u = uid ? await env.LOUIS_KV.get("us:" + uid, "json") : null;
    if (!u || !eq(String(b.hash || ""), u.hash)) {
      await env.LOUIS_KV.put(fk, String(n + 1), { expirationTtl: 300 });
      return J({ error: "Identifiants invalides" }, 401);
    }
    if (u.exp > 0 && u.exp <= Date.now()) return J({ expired: true, exp: u.exp });
    const { token, texp } = await mkToken(env, u);
    return J({ token, texp, id: u.id, exp: u.exp || 0, name: u.name });
  }
  if (p === "/auth/sync" && request.method === "POST") {
    if (!isAdmin(request, env)) return J({ error: "Non autorisé" }, 401);
    let b;
    try { b = await request.json(); } catch { return J({ error: "JSON invalide" }, 400); }
    for (const u of (b.users || []).slice(0, 100)) {
      if (!u.id || !u.name || !u.salt || !u.hash) continue;
      const uid2 = String(u.id).slice(0, 40);
      const old = await env.LOUIS_KV.get("us:" + uid2, "json");
      const keep = old && (old.pwt || 0) > (Number(u.pwt) || 0); // un mot de passe changé par le joueur n'est pas écrasé
      await env.LOUIS_KV.put("us:" + uid2, JSON.stringify({
        id: uid2, name: String(u.name).slice(0, 40), salt: keep ? old.salt : String(u.salt), hash: keep ? old.hash : String(u.hash),
        exp: Number(u.exp) || 0, pwt: keep ? old.pwt : Number(u.pwt) || 0,
      }));
    }
    for (const u of (b.users || []).slice(0, 100)) {
      if (u.id && u.name && u.salt && u.hash) await env.LOUIS_KV.put("un:" + String(u.name).trim().toLowerCase().slice(0, 40), String(u.id).slice(0, 40));
    }
    for (const id of (b.del || []).slice(0, 100)) {
      const old = await env.LOUIS_KV.get("us:" + id, "json");
      if (old) await env.LOUIS_KV.delete("un:" + String(old.name).trim().toLowerCase().slice(0, 40));
      await env.LOUIS_KV.delete("us:" + id);
      await env.LOUIS_KV.delete("ac:" + id);
    }
    return J({ ok: true });
  }

  // 3) Accès temporaires : lecture publique de l'échéance, écriture réservée à l'admin
  if (p === "/access") {
    if (request.method === "GET") {
      const id = url.searchParams.get("id") || "";
      return J({ exp: Number(await env.LOUIS_KV.get("ac:" + id)) || 0 });
    }
    if (request.method === "POST") {
      if (!isAdmin(request, env)) return J({ error: "Non autorisé" }, 401);
      let b;
      try { b = await request.json(); } catch { return J({ error: "JSON invalide" }, 400); }
      const id = String(b.id || "").slice(0, 40);
      const exp = Number(b.exp) || 0;
      if (!id) return J({ error: "id manquant" }, 400);
      if (exp > 0) await env.LOUIS_KV.put("ac:" + id, String(exp));
      else await env.LOUIS_KV.delete("ac:" + id);
      const us = await env.LOUIS_KV.get("us:" + id, "json");
      if (us) { us.exp = exp; await env.LOUIS_KV.put("us:" + id, JSON.stringify(us)); }
      return J({ ok: true });
    }
  }
  return J({ error: "Méthode non supportée" }, 405);
}

// --- Exemple d'intégration (Worker au format module) ---
// export default {
//   async fetch(request, env, ctx) {
//     const r = await handleLouis(request, env);
//     if (r) return r;
//     // ... ton code actuel (proxy Gemini / DeepSeek) ...
//   },
// };
