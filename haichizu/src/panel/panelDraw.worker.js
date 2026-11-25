// ================================================================
// panelDraw.worker.js — 仕切りZバッファ計算専用Workerスレッド
// メインスレッドから solids + カメラパラメータを受け取り、
// d (色バッファ) / zb / partOnlyZb を計算して返す。
// TypedArray を transfer して main → worker → main のゼロコピー転送。
// ================================================================

// ── 必要な純粋関数（panelGeometry.js / PanelCanvas3D.jsx からコピー）──

function project3DPanel(wx, wy, wz, panelW, panelH, panelD, az, el, zoom, panX, panY, canvW, canvH) {
  const cx = wx - panelW / 2;
  const cy = -(wy - panelD / 2);
  const cz = wz - panelH / 2;
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const rx = cx * cosA - cy * sinA;
  const ry = cx * sinA + cy * cosA;
  const sx = rx * zoom + (panX || 0);
  const sy = (-ry * Math.sin(el) - cz * Math.cos(el)) * zoom + (panY || 0);
  const depth = ry * Math.cos(el) - cz * Math.sin(el);
  return { x: sx + (canvW || 600) / 2, y: sy + (canvH || 500) / 2, depth };
}

function panelIsBackFacing(normal, az, el) {
  const nx = normal.nx || 0, ny = normal.ny || 0, nz = normal.nz || 0;
  const ry_n = nx * Math.sin(az) - ny * Math.cos(az);
  const depthN = ry_n * Math.cos(el) - nz * Math.sin(el);
  return depthN < 0;
}

function panelFaceBrightness(normal) {
  const n = normal || {};
  const dot1 = Math.max(0, (n.nx || 0) * 0.3 + (n.ny || 0) * (-0.5) + (n.nz || 0) * 0.8);
  const dot2 = Math.max(0, (n.nx || 0) * (-0.2) + (n.ny || 0) * 0.3 + (n.nz || 0) * (-0.5));
  return 0.45 + 0.45 * dot1 + 0.15 * dot2;
}

function _hexToRGB(hex) {
  const h = (hex || '#94A3B8').replace('#', '');
  return [
    parseInt(h.substr(0, 2) || '94', 16),
    parseInt(h.substr(2, 2) || 'A3', 16),
    parseInt(h.substr(4, 2) || 'B8', 16),
  ];
}

function _rasterTri(d, zb, W, H, p0, p1, p2, r, g, b) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;
  const denom = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if (Math.abs(denom) < 0.001) return;
  const inv = 1 / denom;
  const writePixels = d !== null;
  for (let py = minY; py <= maxY; py++) {
    const row = py * W;
    const yd = py - p2.y;
    for (let px = minX; px <= maxX; px++) {
      const xd = px - p2.x;
      const w0 = ((p1.y - p2.y) * xd + (p2.x - p1.x) * yd) * inv;
      if (w0 < -0.001) continue;
      const w1 = ((p2.y - p0.y) * xd + (p0.x - p2.x) * yd) * inv;
      if (w1 < -0.001) continue;
      if (w0 + w1 > 1.001) continue;
      const depth = w0 * p0.depth + w1 * p1.depth + (1 - w0 - w1) * p2.depth;
      const idx = row + px;
      if (depth <= zb[idx]) continue;
      zb[idx] = depth;
      if (writePixels) {
        const i4 = idx << 2;
        d[i4] = r; d[i4 + 1] = g; d[i4 + 2] = b; d[i4 + 3] = 255;
      }
    }
  }
}

// ── Workerローカルキャッシュ ──
// panel参照は転送不可なので cacheKey（文字列）で代用
let _wPartCache = null;

// ── メッセージハンドラ ──
self.onmessage = function({ data }) {
  if (data.type !== 'rasterize') return;

  const {
    solids,               // Solid[] — panelToSolids の結果
    az, el, zoom, panX, panY,
    W, H,
    panW, panH, panD,     // panel.widthMm/heightMm/depthMm
    selectedPartitionIds, // string[]
    iconOnlyMode,         // boolean
    cacheKey,             // "panel:az:el:zoom:panX:panY:selParts:iconOnly" のような文字列
    token,                // 単調増加のフレーム番号（古い応答を捨てるため）
  } = data;

  const n = W * H;

  // ── キャッシュヒット ──
  if (_wPartCache && _wPartCache.key === cacheKey && _wPartCache.n === n) {
    // キャッシュからコピーして返す（転送できないのでコピー）
    const d          = new Uint8ClampedArray(_wPartCache.img);
    const zb         = new Float32Array(_wPartCache.zb);
    const partOnlyZb = new Float32Array(_wPartCache.partOnlyZb);
    self.postMessage(
      { type: 'rasterized', d, zb, partOnlyZb, cacheHit: true, token },
      [d.buffer, zb.buffer, partOnlyZb.buffer]
    );
    return;
  }

  // ── フルラスタライズ ──
  const d  = new Uint8ClampedArray(n * 4);
  const zb = new Float32Array(n).fill(-1e9);

  // iconOnlyMode時は色バッファに書かない（Zbufferのみ）
  const partD = iconOnlyMode ? null : d;

  const proj = (wx, wy, wz) =>
    project3DPanel(wx, wy, wz, panW, panH, panD, az, el, zoom, panX, panY, W, H);

  (solids || []).forEach(solid => {
    if (solid._isOuter) return; // 外箱はスキップ
    const isSel = !!(selectedPartitionIds && selectedPartitionIds.length &&
                     selectedPartitionIds.includes(solid._partitionId));
    (solid.faces || []).forEach(f => {
      if (!f.vertices || f.vertices.length < 3) return;
      if (panelIsBackFacing(f.normal, az, el)) return;
      const pts = f.vertices.map(v => proj(v.x, v.y, v.z));
      const br = Math.min(panelFaceBrightness(f.normal) * (isSel ? 1.3 : 1), 1.5);
      const [ri, gi, bi] = _hexToRGB(solid.color || '#94A3B8');
      const r = Math.min(255, Math.round(ri * br));
      const g = Math.min(255, Math.round(gi * br));
      const b = Math.min(255, Math.round(bi * br));
      for (let i = 1; i < pts.length - 1; i++) {
        _rasterTri(partD, zb, W, H, pts[0], pts[i], pts[i + 1], r, g, b);
      }
    });
  });

  // 仕切りのみZバッファ（アイコン遮蔽チェック用）
  const partOnlyZb = new Float32Array(zb);

  // キャッシュ保存（次フレームで同じキーならコピーして返す）
  _wPartCache = {
    key:        cacheKey,
    n,
    img:        new Uint8ClampedArray(d),
    zb:         new Float32Array(zb),
    partOnlyZb: new Float32Array(partOnlyZb),
  };

  // TypedArrayをtransferして返す（ゼロコピー）
  self.postMessage(
    { type: 'rasterized', d, zb, partOnlyZb, cacheHit: false, token },
    [d.buffer, zb.buffer, partOnlyZb.buffer]
  );
};
