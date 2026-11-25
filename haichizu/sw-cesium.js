// ============================================================
// Service Worker — CesiumJS タイル & アセットキャッシュ
// 商用マルチユーザー対応: ブラウザ側キャッシュで再訪問を高速化
// ============================================================
const CACHE_VERSION = 'cesium-v2';
const STATIC_CACHE = 'cesium-static-v2';   // Cesium JS/CSS（ほぼ不変）
const TILE_CACHE   = 'cesium-tiles-v2';     // 3Dタイル・地形データ（api.cesium.com除外）
const MAX_TILE_ENTRIES = 2000;              // タイルキャッシュ上限（約500MB想定）

// 静的アセット（バージョン固定なので長期キャッシュ可能）
const STATIC_URLS = [
  'https://cesium.com/downloads/cesiumjs/releases/1.124/Build/Cesium/Cesium.js',
  'https://cesium.com/downloads/cesiumjs/releases/1.124/Build/Cesium/Widgets/widgets.css',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.26.4/babel.min.js',
];

// タイルリクエスト判定パターン
// ※ api.cesium.com はキャッシュしない（短命トークンを含むためF5で期限切れになる）
const TILE_PATTERNS = [
  /assets\.cesium\.com/,         // Cesium Ion タイル・地形
  /tile\.googleapis\.com/,        // Google 3D Tiles
  /\.quantized-mesh/,             // 地形データ
  /\.b3dm/,                       // Batched 3D Model
  /\.pnts/,                       // Point Cloud
  /\.cmpt/,                       // Composite
  /\.glb/,                        // glTF Binary
  /\.terrain/,                    // 地形
];

function isTileRequest(url) {
  return TILE_PATTERNS.some(p => p.test(url));
}

function isStaticAsset(url) {
  return STATIC_URLS.some(s => url.startsWith(s));
}

// インストール: 静的アセットを事前キャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      console.log('[SW] 静的アセットをプリキャッシュ');
      return cache.addAll(STATIC_URLS);
    }).then(() => self.skipWaiting())
  );
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== TILE_CACHE && k !== CACHE_VERSION)
            .map(k => caches.delete(k))
      )
    ).then(() => {
      console.log('[SW] アクティブ化完了');
      return self.clients.claim();
    })
  );
});

// フェッチ: キャッシュ戦略
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // 静的アセット → Cache First（キャッシュ優先、なければネットワーク）
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(res => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // タイルリクエスト → Stale While Revalidate
  // （キャッシュがあればすぐ返し、裏でネットワーク更新）
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(res => {
            if (res.ok) {
              cache.put(event.request, res.clone());
              // キャッシュサイズ制限
              trimCache(cache, MAX_TILE_ENTRIES);
            }
            return res;
          }).catch(() => {
            // オフライン時はキャッシュから返す
            return cached;
          });
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // その他のリクエスト → 通常のネットワーク
});

// キャッシュエントリ数を制限（古いものから削除）
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}
