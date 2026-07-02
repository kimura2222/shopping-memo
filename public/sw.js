// アプリ本体(HTML/JS/CSS/画像)をキャッシュして、電波が無くても起動できるようにする。
// データ(/api)はキャッシュせず、オフライン時はアプリ側が localStorage を使う。
const CACHE = "shopping-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // 書き込みはネットワークへ
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部(画像CDN等)はそのまま
  if (url.pathname.startsWith("/api/")) return; // データはアプリ側で制御

  // ネットワーク優先・失敗時はキャッシュ。成功したらキャッシュを更新。
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return new Response("オフラインです", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
  );
});
