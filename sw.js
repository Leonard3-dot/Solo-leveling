/* LOUIS // CORE : service worker (hors ligne + rappels) */
const V = "louis-57da080bcb";            /* remplacé à la construction : change à chaque version */
const RT = "louis-rt";              /* cache durable : reconnaissance des mains (CDN) */
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./icon.svg"];
const CDN = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== V && k !== RT) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  if (d.type === "CHECK") e.waitUntil(checkDue());
});

/* page : réseau d'abord (4 s), sinon cache → l'app s'ouvre toujours, même sans réseau */
async function pageFirst(req) {
  const c = await caches.open(V);
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(req, { cache: "no-cache", signal: ctl.signal });
    clearTimeout(t);
    if (r && r.ok) c.put(req, r.clone());
    return r;
  } catch (_) {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match("./index.html")) || Response.error();
  }
}
async function stale(req) {
  const c = await caches.open(V), hit = await c.match(req);
  const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || new Response("", { status: 404 });
}
async function cdnFirst(req) {
  const c = await caches.open(RT), hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone());
  return r;
}
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (u.pathname.endsWith("/sw.js")) return;
    e.respondWith(req.mode === "navigate" || u.pathname.endsWith(".html") ? pageFirst(req) : stale(req));
  } else if (CDN.includes(u.hostname)) {
    e.respondWith(cdnFirst(req));
  }
});

/* ---------- rappels ---------- */
const idb = () => new Promise((ok, ko) => {
  const r = indexedDB.open("louis", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ko(r.error);
});
const kget = async k => { const d = await idb(); return new Promise(ok => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(undefined); }); };
const kset = async (k, v) => { const d = await idb(); return new Promise(ok => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => ok(); t.onerror = () => ok(); }); };
const show = (o, extra) => self.registration.showNotification(o.title || "LOUIS // CORE", Object.assign({
  body: o.body || "", tag: o.tag || o.id || "louis", icon: "icon-192.png", badge: "icon-192.png",
  vibrate: [200, 100, 200], renotify: true, data: { url: o.url || "./index.html?go=0" }
}, extra || {}));

/* Rappels du planning enregistré par l'app dont l'heure est passée (fenêtre de 3 h), une seule fois chacun. */
async function checkDue() {
  const list = (await kget("rem")) || [], now = Date.now();
  const sent = (await kget("sent")) || {};
  for (const k of Object.keys(sent)) if (now - sent[k] > 864e5) delete sent[k];
  let n = 0;
  for (const it of list) {
    if (!it || !it.id || it.at > now || now - it.at > 3 * 36e5 || sent[it.id + "@" + it.at]) continue;
    sent[it.id + "@" + it.at] = now; n++;
    await show(it);
  }
  await kset("sent", sent);
  return n;
}
self.addEventListener("periodicsync", e => { if (e.tag === "louis-rem") e.waitUntil(checkDue()); });
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let d = null;
    try { d = e.data && e.data.json(); } catch (_) {}
    if (d && (d.title || d.body)) {
      /* si l'app est déjà ouverte et visible, elle affiche elle-même ses rappels */
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some(w => w.visibilityState === "visible")) return;
      const sent = (await kget("sent")) || {};
      if (d.id) { sent[d.id + "@" + (d.at || 0)] = Date.now(); await kset("sent", sent); }
      return show(d);
    }
    if (!(await checkDue())) {      /* Chrome exige une notification visible pour chaque push */
      await self.registration.showNotification("LOUIS // CORE", { tag: "louis-bg", body: "Tes missions t’attendent.", icon: "icon-192.png", badge: "icon-192.png", data: { url: "./index.html?go=0" } });
    }
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./index.html?go=0";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { await c.focus(); c.postMessage({ type: "GO", url }); return; } }
    await self.clients.openWindow(url);
  })());
});
