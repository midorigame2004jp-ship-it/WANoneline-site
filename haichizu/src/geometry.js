// ===== 計算関数（純粋関数） =====
function snap(x, y) { return { x: Math.round(x / MINOR) * MINOR, y: Math.round(y / MINOR) * MINOR }; }
function snapV(v) { return Math.round(v / MINOR) * MINOR; }
// zoom依存スナップ: 画面上1pxが1ステップになるよう縮尺に追従
function snapStep(zoom) {
  const z = zoom || 1;
  if (z >= 1.5) return 1 / z;       // 1スクリーンpx = 1ステップ（拡大時は自動的に細かくなる）
  if (z >= 0.75) return MINOR / 2;  // 中間zoom
  return MINOR;                      // 縮小時は標準グリッド
}
function snapFineV(v, zoom) { const s = snapStep(zoom || 1); return Math.round(v / s) * s; }
function snapFine(x, y, zoom) { const s = snapStep(zoom || 1); return { x: Math.round(x / s) * s, y: Math.round(y / s) * s }; }
function lerp2(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: (a.z || 0) + ((b.z || 0) - (a.z || 0)) * t }; }
function projSeg(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; if (l2 === 0) return 0; return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)); }
function calcInitPan(az, el, zoom, blds) {
  const pts = [];
  const _blds = blds || INIT_BLDS;
  // 地面の頂点（フィールドポリゴンまたは矩形）
  const gndPts = FIELD_POLY_GRID
    ? FIELD_POLY_GRID.map(p => [p.x, p.y, 0])
    : [[0, 0, 0], [TW, 0, 0], [TW, TH, 0], [0, TH, 0]];
  gndPts.forEach(([x, y, z]) => pts.push(project3D(x, y, z, az, el, zoom, 0, 0)));
  // 建物の屋根の4角
  _blds.forEach(b => {
    const bx = b.pxMinX, by = b.pxMinY, bw = b.pxMaxX - b.pxMinX, bh = b.pxMaxY - b.pxMinY;
    const topZ = b.zTop != null ? b.zTop : b.height;
    [[bx, by, topZ], [bx + bw, by, topZ], [bx + bw, by + bh, topZ], [bx, by + bh, topZ]]
      .forEach(([x, y, z]) => pts.push(project3D(x, y, z, az, el, zoom, 0, 0)));
  });
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { x: CAB_W / 2 - cx, y: CAB_H / 2 - cy };
}
function project3D(wx, wy, wz, az, el, zoom, panX, panY) {
  // z（高さ）をメートルからグリッドpxに変換（x,yと同一スケールに統一）
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
  const cx = wx - TW / 2, cy = -(wy - TH / 2), cz = (wz || 0) / mpp; // Y反転: 画面下→3D手前
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const rx = cx * cosA - cy * sinA;
  const ry = cx * sinA + cy * cosA;
  const sx = rx * zoom + (panX || 0);
  const sy = (-ry * Math.sin(el) - cz * Math.cos(el)) * zoom + (panY || 0);
  const depth = ry * Math.cos(el) - cz * Math.sin(el);
  return { x: sx + CAB_W / 2, y: sy + CAB_H / 2, depth };
}
// 3次元図のズーム・パンを自動計算（地面+建物がウィンドウにフィット）
function calcAutoFit(az, el, blds) {
  const pts = [];
  const _blds = blds || INIT_BLDS;
  // フィールドポリゴンまたは矩形の頂点を投影
  const groundPts = FIELD_POLY_GRID
    ? FIELD_POLY_GRID.map(p => [p.x, p.y, 0])
    : [[0,0,0],[TW,0,0],[TW,TH,0],[0,TH,0]];
  groundPts.forEach(([x,y,z]) => pts.push(project3D(x,y,z,az,el,1,0,0)));
  _blds.forEach(b => {
    const bx = b.pxMinX, by = b.pxMinY, bw = b.pxMaxX - b.pxMinX, bh = b.pxMaxY - b.pxMinY;
    const topZ = b.zTop != null ? b.zTop : b.height;
    [[bx,by,topZ],[bx+bw,by,topZ],[bx+bw,by+bh,topZ],[bx,by+bh,topZ]]
      .forEach(([x,y,z]) => pts.push(project3D(x,y,z,az,el,1,0,0)));
  });
  const cxs = pts.map(p => p.x - CAB_W/2), cys = pts.map(p => p.y - CAB_H/2);
  const bboxW = Math.max(...cxs) - Math.min(...cxs), bboxH = Math.max(...cys) - Math.min(...cys);
  const margin = 60;
  const zoom = Math.max(0.3, Math.min(2, Math.min((CAB_W - margin) / bboxW, (CAB_H - margin) / bboxH)));
  const pan = calcInitPan(az, el, zoom, _blds);
  return { zoom, panX: pan.x, panY: pan.y };
}
function unproject3D(screenX, screenY, az, el, zoom, panX, panY) {
  const sx = (screenX - CAB_W / 2 - (panX || 0)) / zoom, sy = (screenY - CAB_H / 2 - (panY || 0)) / zoom;
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const sinE = Math.sin(el);
  const k = -sy / sinE;
  const cx = cosA * sx + sinA * k;
  const cy = cosA * k - sinA * sx;
  return { x: cx + TW / 2, y: -(cy - TH / 2) }; // Y反転を戻す
}

// ── 正投影レイ: 画面座標(screenX,screenY)に投影される3D点の集合 ──
// 3次元図は正投影(パースペクティブなし)のため、画面上の全点でレイ方向が同一になる。
// t=depth（project3D が返す depth と同じ量。3次元図規約 nearSign=-1 なので t小=手前）。
// origin=t:0 のワールド点、dir=t あたりの増分。
// 単位: ox,oy(グリッドpx) / ozM(メートル)、dx,dy(グリッドpx/t) / dzM(メートル/t)
// 導出: project3D の
//   -ry*sinE - cz*cosE = sy,  ry*cosE - cz*sinE = t  を ry,cz について解く
//   → ry = -sinE*sy + cosE*t,  cz = -cosE*sy - sinE*t （rx = sx は t に依らず一定）
// dir のグリッドpx長は sqrt(cos^2E + sin^2E) = 1（＝t はグリッドpx単位の弧長）。
function cabScreenRay(screenX, screenY, az, el, zoom, panX, panY) {
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
  const sx = (screenX - CAB_W / 2 - (panX || 0)) / zoom;
  const sy = (screenY - CAB_H / 2 - (panY || 0)) / zoom;
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const cosE = Math.cos(el), sinE = Math.sin(el);
  // t=0 の点（回転系→ワールド）
  const rx0 = sx, ry0 = -sinE * sy, cz0 = -cosE * sy;
  const cx0 = rx0 * cosA + ry0 * sinA, cy0 = -rx0 * sinA + ry0 * cosA;
  return {
    ox: cx0 + TW / 2, oy: TH / 2 - cy0, ozM: cz0 * mpp,
    dx: sinA * cosE, dy: -cosA * cosE, dzM: -sinE * mpp,
    sinE, cosE, sy,
  };
}

// ── レイ×配置盤OBB（slab法・盤ローカルmm系で軸平行化）──
// レイをローカルmm座標系に変換してから軸平行境界箱[0,W]x[0,D]x[0,H]との交差判定を行う
// （盤が pp.rot で回転していてもローカル座標系では常に軸平行になるため、通常のAABB slab法が使える）。
// ローカル変換は App.jsx の _pde_makeCabProj の逆変換。前進側は
//   wx = pivWx + ((cx-W/2)*cos + (cy-D/2)*sin) * PPM
//   wy = pivWy + ((cx-W/2)*sin - (cy-D/2)*cos) * PPM
// の 2x2 行列 [[cos,sin],[sin,-cos]] が対合（自分自身が逆行列）なので、同じ式で逆変換できる。
// 戻り値: tEnter（depth値。t<0 も有効＝正投影では原点深度面より手前なだけで画面に映る）| null（不交差）
function rayHitPlacedPanel(ray, pp) {
  const panel = pp && pp.panelData; if (!panel) return null;
  // 汚染データ(NaN/Infinity座標)を弾く早期ガード。
  // 真横視点での unproject3D 発散により NaN 座標の盤が placedPanels に混入していた場合、
  // slab法の比較が全て false になり誤ヒット/NaN pivot を生むため、ここで無効化する。
  if (!isFinite(pp.wx) || !isFinite(pp.wy) || !isFinite(pp.rot || 0)) return null;
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
  const PPM = 1 / (mpp * 1000); // グリッドpx / mm
  const W = panel.widthMm || 600, D = panel.depthMm || 400, H = panel.heightMm || 1000;
  const cos = Math.cos(pp.rot || 0), sin = Math.sin(pp.rot || 0);
  const pivWx = pp.wx + W / 2 * PPM, pivWy = pp.wy + D / 2 * PPM;
  // レイ原点をローカルmmへ（グリッドpx差→mm、_pde_makeCabProj と同じ鏡映行列で盤ローカルへ）
  const u0 = (ray.ox - pivWx) / PPM, v0 = (ray.oy - pivWy) / PPM;
  const ox = u0 * cos + v0 * sin + W / 2;
  const oy = u0 * sin - v0 * cos + D / 2;
  const oz = ray.ozM * 1000; // m → mm
  // レイ方向も同じ変換（平行移動は不要、線形部分のみ）
  const du = ray.dx / PPM, dv = ray.dy / PPM;
  const dxL = du * cos + dv * sin, dyL = du * sin - dv * cos, dzL = ray.dzM * 1000;
  // slab法: [0,W]×[0,D]×[0,H]
  let tMin = -Infinity, tMax = Infinity;
  const slabs = [[ox, dxL, W], [oy, dyL, D], [oz, dzL, H]];
  for (const [o, d, ext] of slabs) {
    if (Math.abs(d) < 1e-9) { if (o < 0 || o > ext) return null; continue; } // レイがこの軸に平行
    let t1 = (0 - o) / d, t2 = (ext - o) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null; // 交差なし
  }
  return tMin; // 手前側の面のt
}

// ── オービットpivot決定: 配置盤・地面のうち最手前(t最小)を採用 ──
// 配置盤と地面の候補を同じt空間で比較し、最も手前(t最小)のものを基準点として採用する。
// 正投影では depth の符号は「カメラの前後」ではなく原点深度面からの符号付き深さなので、
// t<0 の候補も画面に映っている。よって符号では捨てず、候補の有界性だけで発散を防ぐ:
//   ・地面は真横視点(|sinE|が小さい)だと交点が発散するため閾値未満なら候補から除外し、
//     さらに交点が場内bbox(旧クランプと同じ範囲)に入るときだけ採用する（今回のバグの直接対策）。
//   ・配置盤はOBB自体が有界。
// 全候補なしの場合は、レイ上でシーン中心に最も近い点をフォールバックとして採用し、
// 常に安定した基準点が得られるようにする（分母 dd は cos^2E+sin^2E=1 で0にならない）。
// 戻り値: { x, y(グリッドpx), z(メートル) }
const PICK_ORBIT_GROUND_SINE_EPS = 0.08; // 約4.6度未満(ほぼ真横)は地面候補を無効化する閾値
function pickOrbitPivot(screenX, screenY, az, el, zoom, panX, panY, panels) {
  const ray = cabScreenRay(screenX, screenY, az, el, zoom, panX, panY);
  let bestT = Infinity, hasHit = false;
  for (const pp of (panels || [])) {
    const t = rayHitPlacedPanel(ray, pp);
    if (t !== null && t < bestT) { bestT = t; hasHit = true; }
  }
  // 地面（cz=0平面との交点）。真横に近い視点では発散するため候補から除外する
  if (Math.abs(ray.sinE) > PICK_ORBIT_GROUND_SINE_EPS) {
    const tG = -ray.cosE * ray.sy / ray.sinE; // cz=0 のt
    const gx = ray.ox + ray.dx * tG, gy = ray.oy + ray.dy * tG;
    if (gx >= -TW * 0.5 && gx <= TW * 1.5 && gy >= -TH * 0.5 && gy <= TH * 1.5) {
      if (tG < bestT) { bestT = tG; hasHit = true; }
    }
  }
  // 注: z を 0 でクランプしてはいけない。pivot はレイ上（＝カーソルの真下）にある必要があり、
  // クランプするとレイから外れて orbit 開始時に画面が飛ぶ（真横視点で実測310pxのズレ）。
  // 地面ヒットは z=0、盤ヒットは z>0 なので、負になるのはフォールバック時のみ（地面下でも実害なし）。
  if (hasHit) {
    return { x: ray.ox + ray.dx * bestT, y: ray.oy + ray.dy * bestT,
             z: ray.ozM + ray.dzM * bestT };
  }
  // フォールバック: レイ上でシーン中心(TW/2,TH/2,0)に最も近い点（真横視点でも常に安定した値が得られる）
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
  const px = TW / 2 - ray.ox, py = TH / 2 - ray.oy, pz = (0 - ray.ozM) / mpp;
  const dzG = ray.dzM / mpp; // グリッドpx/t に統一
  const dd = ray.dx * ray.dx + ray.dy * ray.dy + dzG * dzG;
  const tC = dd > 0 ? (px * ray.dx + py * ray.dy + pz * dzG) / dd : 0;
  return { x: ray.ox + ray.dx * tC, y: ray.oy + ray.dy * tC,
           z: ray.ozM + ray.dzM * tC };
}

// ── 画面座標→地面座標（安全版）: unproject3Dの代替。sinE≈0での発散を防ぐ ──
// 真横視点(|sinE|が小さい)では、地面(z=0)との交点計算が発散するため、
// pickOrbitPivotと同じフォールバック(レイ上でシーン中心に最も近い点)を使う。
// 常に有限の{x,y}を返す(地面高さのワールド座標、グリッドpx単位)。
// 用途: カメラ目線表示(CAM)インジケーター、配電盤ドラッグ配置など、
// 「画面座標に対応する地面上の点」が必要な箇所全般(配置盤は対象にしない、地面のみ)。
const CAB_SCREEN_TO_GROUND_SINE_EPS = 0.08; // pickOrbitPivotと同じ閾値
function cabScreenToGroundPoint(screenX, screenY, az, el, zoom, panX, panY) {
  const ray = cabScreenRay(screenX, screenY, az, el, zoom, panX, panY);
  if (Math.abs(ray.sinE) > CAB_SCREEN_TO_GROUND_SINE_EPS) {
    const tG = -ray.cosE * ray.sy / ray.sinE; // cz=0 のt
    return { x: ray.ox + ray.dx * tG, y: ray.oy + ray.dy * tG };
  }
  // フォールバック: レイ上でシーン中心(TW/2,TH/2,0)に最も近い点（常に有限）
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
  const px = TW / 2 - ray.ox, py = TH / 2 - ray.oy, pz = (0 - ray.ozM) / mpp;
  const dzG = ray.dzM / mpp;
  const dd = ray.dx * ray.dx + ray.dy * ray.dy + dzG * dzG;
  const tC = dd > 0 ? (px * ray.dx + py * ray.dy + pz * dzG) / dd : 0;
  return { x: ray.ox + ray.dx * tC, y: ray.oy + ray.dy * tC };
}

// ── pivot固定回転の共通式: ワールド点pivotが画面上(anchorX,anchorY)に留まるpan値を返す ──
// az/elが変化しても、pivot(ワールド座標)の投影先が常にanchor(スクリーン座標)に一致するような
// panX/panYを求める。中ボタンオービット・ギズモドラッグ・ギズモ面クリックアニメーションが
// 共通で使う「pivot固定回転」の核となる計算式(pan計算ロジックの一本化)。
// pivZM: メートル単位の高さ(project3Dの第3引数と同じ)
function panForPivot(pivX, pivY, pivZM, az, el, zoom, anchorX, anchorY) {
  const p = project3D(pivX, pivY, pivZM || 0, az, el, zoom, 0, 0);
  return { panX: anchorX - p.x, panY: anchorY - p.y };
}
