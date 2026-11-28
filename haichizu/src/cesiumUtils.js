// ===== Cesiumユーティリティ =====
const CESIUM_TOKEN = (typeof window !== 'undefined' && window._ENV && window._ENV.CESIUM_ION_TOKEN) || '';
const DEF_GEO_ORIGIN = { lat: 33.275, lng: 131.667 }; // デフォルト原点（大分臨海工業地帯付近）
const M_PER_DEG_LAT = 111320;

// フィールドポリゴン（ユーザー定義の敷地境界）
function getSavedFieldPolygon() {
  try {
    const s = localStorage.getItem('field_polygon');
    if (s) { const a = JSON.parse(s); if (Array.isArray(a) && a.length >= 3) return a; }
  } catch (_) {}
  return null;
}
function saveFieldPolygon(pts) {
  try { localStorage.setItem('field_polygon', JSON.stringify(pts)); } catch (_) {}
}

// ── フィールド多角形 → 図面の原点と縮尺（この式はここ1か所・2026-11-22 advisor監査）──
// 【なぜ1か所か】同じ式が「読み込み時の初期化」と「Cesium のフィールド確定」(CesiumMap.jsx) に
//   手書きで2つあり、国土地理院の窓が3つ目になるところだった。四角（2点で作る4点）も
//   多角形として同じここを通す＝形で分岐しない。
// 【意味】図面（TW×TH グリッド）にその多角形の外接矩形がぴったり収まるよう縮尺を決め（2026-11-28 以前は 90%）、
//   図面の中心が多角形の中心に重なるよう原点（南西の角）を逆算する。
function fieldFrameFromPolygon(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const lats = poly.map(p => p.lat), lngs = poly.map(p => p.lng);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const mPerDegLng = 111320 * Math.cos(centerLat * Math.PI / 180);
  const bboxW = (Math.max(...lngs) - Math.min(...lngs)) * mPerDegLng;
  const bboxH = (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT;
  // 【外接する四角がぴったり図面になる・2026-11-28】升の数（TW×TH）は constants.js が範囲の縦横比で決めている。
  //   旗 window.__FIELD_AREA_FIT = false で従来（図面の 90% に収める）
  //   以前に決めた範囲（field_fit が無い）は従来のまま＝保存した図がずれない（述語は constants.js の fieldAreaFitEnabled 1つ）
  const _ぴったり = (typeof fieldAreaFitEnabled === 'function') ? fieldAreaFitEnabled() : false;
  const mpp = _ぴったり ? Math.max(bboxW / TW, bboxH / TH, 0.001)
    : Math.max(bboxW / (TW * 0.9), bboxH / (TH * 0.9), 0.001);
  return {
    origin: {
      lat: centerLat - (TH / 2) * mpp / M_PER_DEG_LAT,
      lng: centerLng - (TW / 2) * mpp / mPerDegLng,
    },
    mpp,
    mPerDegLng,
  };
}

// GEO_ORIGIN & METERS_PER_PX: フィールドポリゴンから毎回再計算（TW/TH変更に対応）
let GEO_ORIGIN, METERS_PER_PX, M_PER_DEG_LNG;
(() => {
  const fr = fieldFrameFromPolygon(getSavedFieldPolygon());
  if (fr) {
    GEO_ORIGIN = fr.origin;
    METERS_PER_PX = fr.mpp;
    M_PER_DEG_LNG = fr.mPerDegLng;
    // localStorageも更新
    try { localStorage.setItem('geo_origin', JSON.stringify(GEO_ORIGIN)); } catch (_) {}
  } else {
    // フィールドポリゴンなし: デフォルト
    try {
      const s = localStorage.getItem('geo_origin');
      if (s) { const o = JSON.parse(s); if (o.lat && o.lng) { GEO_ORIGIN = o; } }
    } catch (_) {}
    if (!GEO_ORIGIN) GEO_ORIGIN = { ...DEF_GEO_ORIGIN };
    METERS_PER_PX = 0.1; // デフォルト: 1px=0.1m → 1 MAJORセル(36px)≈3.6m。3次元図の縦横比を適切に保つ
    M_PER_DEG_LNG = 111320 * Math.cos(GEO_ORIGIN.lat * Math.PI / 180);
  }
})();

function updateGeoOrigin(lat, lng) {
  GEO_ORIGIN = { lat, lng };
  M_PER_DEG_LNG = 111320 * Math.cos(lat * Math.PI / 180);
  try { localStorage.setItem('geo_origin', JSON.stringify(GEO_ORIGIN)); } catch (_) {}
}

// ── フィールドを確定する唯一の書き手（2026-11-22）──
// Cesium の多角形クリックも、国土地理院の窓の「3次元範囲を設定」（2点の四角）も、必ずここを通る。
// 【再読込する理由】GEO_ORIGIN・METERS_PER_PX・FIELD_POLY_GRID は読み込み時に1回だけ決まる
//   派生値で、読み手（App.jsx の useMemo 多数・geometry.js）が依存配列に入れていない。
//   既存の Cesium 側も location.reload() で合わせている。再読込しない反映は別の段で直す（負債）。
function commitFieldPolygon(poly, opts) {
  // この版以降に決めた範囲は、図面の大きさ・縮尺を範囲に合わせる（constants.js の fieldAreaFitEnabled が読む印）
  if (!(typeof window !== 'undefined' && window.__FIELD_AREA_FIT === false)) { try { localStorage.setItem('field_fit', '1'); } catch (_) {} }
  const fr = fieldFrameFromPolygon(poly);
  if (!fr) return false;
  saveFieldPolygon(poly);
  updateGeoOrigin(fr.origin.lat, fr.origin.lng);
  if (!(opts && opts.noReload)) location.reload();
  return true;
}

// フィールドの解除も同じ場所に置く（記録を消す所を散らさない）
function clearFieldPolygon(opts) {
  try { localStorage.removeItem('field_polygon'); } catch (_) {}
  try { localStorage.removeItem('field_fit'); } catch (_) {}
  try { localStorage.removeItem('geo_origin'); } catch (_) {}
  try { localStorage.removeItem(getElevCacheKey()); } catch (_) {}
  if (!(opts && opts.noReload)) location.reload();
}

// ── キャッシュ & パフォーマンス ──
function getElevCacheKey() { return `cesium_elev_min_${GEO_ORIGIN.lat}_${GEO_ORIGIN.lng}`; }
const ELEV_CACHE_KEY = getElevCacheKey();
function getCachedElevation() {
  try {
    const raw = localStorage.getItem(getElevCacheKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.ts < 86400000) return data.elev;
  } catch (_) {}
  return null;
}
function setCachedElevation(elev) {
  try { localStorage.setItem(getElevCacheKey(), JSON.stringify({ elev, ts: Date.now() })); } catch (_) {}
}

// 共有マテリアル（毎フレーム生成を避ける）
let _sharedMaterials = null;
function getSharedMaterials() {
  if (_sharedMaterials) return _sharedMaterials;
  const wireColor = Cesium.Color.fromCssColorString('#1a1a1a');
  const outlineColor = Cesium.Color.fromCssColorString('#E8ECF0');
  _sharedMaterials = {
    wireColor: wireColor.withAlpha(0.9),
    wireDepthFail: wireColor.withAlpha(0.9),
    wireOutline: outlineColor.withAlpha(0.95),
    wireOutlineDepthFail: outlineColor.withAlpha(0.95),
  };
  return _sharedMaterials;
}

// シンボルアイコン生成（Canvas→DataURL、キャッシュ付き）
const _iconCache = {};
function makeSymbolIcon(shape, color, label, size = 36) {
  const key = `${shape}_${color}_${label}_${size}`;
  if (_iconCache[key]) return _iconCache[key];
  const lblH = label ? 14 : 0;
  const c = document.createElement('canvas');
  c.width = size + 2; c.height = size + lblH + 2;
  const ctx = c.getContext('2d');
  const h = size / 2 + 1; // 1px padding
  // 白カード背景（HTMLビューのdivと統一）
  ctx.beginPath();
  ctx.roundRect(0, 0, size + 2, size + 2, 4);
  ctx.fillStyle = 'rgba(255,255,255,1.0)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  if (shape === 'gen') {
    // 発電機: 円(stroke only) + G — Symと同一スタイル
    ctx.beginPath(); ctx.arc(h, h, size / 2 - 2, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.fillStyle = color; ctx.font = `bold ${size * 0.42}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('G', h, h + 0.5);
  } else {
    // 遮断器: 角丸矩形 + 52 — Symと同一スタイル
    const isG = shape === 'cb_g';
    const fc = isG ? '#16A34A' : '#DC2626';
    ctx.beginPath();
    ctx.roundRect(2, 2, size - 2, size - 2, 2);
    ctx.fillStyle = fc; ctx.fill();
    ctx.fillStyle = '#FFF'; ctx.font = `bold ${size * 0.36}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('52', h, h + 0.5);
  }
  // ラベル（アイコン下、白文字+黒縁）
  if (label) {
    ctx.font = `bold 10px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 2.5;
    ctx.strokeText(label, h, size + 3);
    ctx.fillStyle = '#FFF';
    ctx.fillText(label, h, size + 3);
  }
  _iconCache[key] = c.toDataURL();
  return _iconCache[key];
}

// サーバー側プロキシキャッシュ: Cesium Ionリクエストを /proxy 経由に書き換え
function installTileProxy() {
  if (typeof Cesium === 'undefined') return;
  const proxyDomains = ['assets.cesium.com', 'api.cesium.com'];
  const origFetch = Cesium.Resource._Implementations.loadWithXhr;
  if (!origFetch || Cesium.Resource._proxyInstalled) return;
  Cesium.Resource._proxyInstalled = true;

  Cesium.Resource._Implementations.loadWithXhr = function(url, responseType, method, data, headers, deferred, overrideMimeType) {
    let finalUrl = url;
    try {
      const parsed = new URL(url);
      if (proxyDomains.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
        // ローカルサーバー経由でプロキシ
        finalUrl = '/proxy?url=' + encodeURIComponent(url);
      }
    } catch (_) {}
    return origFetch.call(this, finalUrl, responseType, method, data, headers, deferred, overrideMimeType);
  };
  console.log('[TileProxy] サーバー側キャッシュプロキシ有効');
}
// プロキシサーバー稼働判定（/proxy が使えるか）
function detectAndInstallProxy() {
  // 国土地理院のタイルも同じ判定を使う（プロキシがあれば貯めが効く／無ければ直接取る）
  const 知らせる = (ok) => { try { if (typeof gsiSetProxyAvailable === 'function') gsiSetProxyAvailable(ok); } catch (_) {} };
  fetch('/stats').then(r => {
    if (r.ok) {
      installTileProxy();
      知らせる(true);
    } else {
      知らせる(false);
      console.log('[TileProxy] プロキシサーバー未検出、直接接続モード');
    }
  }).catch(() => {
    知らせる(false);
    console.log('[TileProxy] プロキシサーバー未検出、直接接続モード');
  });
}
detectAndInstallProxy();

function gridToGeo(x, y) {
  return {
    lng: GEO_ORIGIN.lng + x * METERS_PER_PX / M_PER_DEG_LNG,
    lat: GEO_ORIGIN.lat + (TH - y) * METERS_PER_PX / M_PER_DEG_LAT, // Y反転: 平面図の上=北
  };
}

function geoToGrid(lat, lng) {
  return {
    x: (lng - GEO_ORIGIN.lng) * M_PER_DEG_LNG / METERS_PER_PX,
    y: TH - (lat - GEO_ORIGIN.lat) * M_PER_DEG_LAT / METERS_PER_PX, // Y反転
  };
}

// フィールドポリゴンのグリッド座標変換（全ビュー共通）
const FIELD_POLY_GRID = (() => {
  const poly = getSavedFieldPolygon();
  if (!poly) return null;
  return poly.map(p => geoToGrid(p.lat, p.lng));
})();
// ── 描写範囲の形（グリッド座標）・2026-11-28 ──
// 範囲の形が四角でなければその形、四角（または範囲なし）なら null。四角の判定は「面積が外接する四角と同じ」。
//   3次元図・平面図の地面の塗りを切る形と、取り込んだ建物を切り取る形が同じこれを使う（判定を2か所に書かない）。
//   旗 window.__FIELD_CLIP = false で null（形で切らない）
function fieldPolyClipGrid() {
  if (typeof window !== 'undefined' && window.__FIELD_CLIP === false) return null;
  const P = FIELD_POLY_GRID;
  if (!Array.isArray(P) || P.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, a2 = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length];
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); a2 += p.x * q.y - q.x * p.y; }
  const 箱 = (x1 - x0) * (y1 - y0);
  return (箱 > 0 && Math.abs(a2 / 2) >= 箱 * 0.999) ? null : P;
}
// 描写範囲＝範囲の形（四角でなければ）／図面の四角（0,0〜TW,TH）
function drawAreaPolygonGrid() {
  return fieldPolyClipGrid() || [{ x: 0, y: 0 }, { x: TW, y: 0 }, { x: TW, y: TH }, { x: 0, y: TH }];
}

