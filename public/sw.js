// アプリ本体(HTML/JS/CSS/画像)をキャッシュして、電波が無くても起動できるようにする。
// データ(/api)はキャッシュせず、オフライン時はアプリ側が localStorage を使う。
const CACHE = "shopping-shell-v3";
// デプロイのたびにファイル名の違うJS/CSSが増えるので、古いものから捨てて上限を保つ
const MAX_ENTRIES = 150;
// 回線が混雑して応答が来ないとき、この時間待ってキャッシュがあればそちらを出す
const NETWORK_TIMEOUT_MS = 4000;

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

// Cache.put は同じキーを消して末尾に追加するので、先頭ほど長く使われていないエントリ
async function trimCache() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  const excess = keys.length - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function putInCache(req, res) {
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
  await trimCache();
}

async function fromCache(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  if (req.mode === "navigate") return caches.match("/");
  return undefined;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // 書き込みはネットワークへ
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部(画像CDN等)はそのまま
  if (url.pathname.startsWith("/api/")) return; // データはアプリ側で制御

  // ネットワーク優先・失敗時はキャッシュ。成功したらキャッシュを更新。
  // 応答が遅いときは一定時間でキャッシュに切り替える(ネットワークの結果は後でキャッシュに入る)。
  event.respondWith(
    (async () => {
      const network = fetch(req).then((res) => {
        // エラー応答(401/500など)をキャッシュするとオフライン時にそれが出てしまうので除外。
        // ログイン画面へリダイレクトされた応答も、"/" の中身として保存しないよう除外。
        if (res.ok && res.type === "basic" && !res.redirected) {
          const saving = putInCache(req, res.clone()).catch(() => {});
          try {
            event.waitUntil(saving);
          } catch {
            // 既にキャッシュで応答済みだと waitUntil できないが、保存自体は進む
          }
        }
        return res;
      });
      network.catch(() => {}); // キャッシュで応答した後の失敗は無視

      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve("timeout"), NETWORK_TIMEOUT_MS)
      );

      try {
        const first = await Promise.race([network, timeout]);
        if (first !== "timeout") return first;
        const cached = await fromCache(req);
        return cached ?? (await network); // キャッシュが無ければネットワークを待ち続ける
      } catch {
        const cached = await fromCache(req);
        if (cached) return cached;
        return new Response("オフラインです", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })()
  );
});
