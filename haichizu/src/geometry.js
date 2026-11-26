// ===== 計算関数（純粋関数） =====
// 格子への丸め。Alt 押下中（snapGate.js の判定）は丸めずに素の値を返す
function _snapOff() { return typeof snapSuppressed === 'function' && snapSuppressed(); }
function snap(x, y) { if (_snapOff()) return { x, y }; return { x: Math.round(x / MINOR) * MINOR, y: Math.round(y / MINOR) * MINOR }; }
function snapV(v) { if (_snapOff()) return v; return Math.round(v / MINOR) * MINOR; }
// zoom依存スナップ: 画面上1pxが1ステップになるよう縮尺に追従
function snapStep(zoom) {
  const z = zoom || 1;
  if (z >= 1.5) return 1 / z;       // 1スクリーンpx = 1ステップ（拡大時は自動的に細かくなる）
  if (z >= 0.75) return MINOR / 2;  // 中間zoom
  return MINOR;                      // 縮小時は標準グリッド
}
function snapFineV(v, zoom) { if (_snapOff()) return v; const s = snapStep(zoom || 1); return Math.round(v / s) * s; }
function snapFine(x, y, zoom) { if (_snapOff()) return { x, y }; const s = snapStep(zoom || 1); return { x: Math.round(x / s) * s, y: Math.round(y / s) * s }; }
// ── 矢視（断面）作図のスナップ刻み ──
// 固定グリッド(MINOR=0.72m相当)では配電盤(幅600mm程度)より粗く、拡大しても小さい範囲を作れない。
// そこで「実寸できりのよい候補」から、画面上で SNAP_TARGET_PX 以上になる最小のものを選ぶ。
// 拡大するほど細かい刻みが選ばれ、縮小すれば粗くなる（画面上の操作感は一定に保たれる）。
const SNAP_TARGET_PX = 8;
// 【候補の下限を粗くしない】0.05m始まりだと等倍では1m刻みまで飛んでしまい、
// 矢視図の枠のような細かい調整ができない。1cm刻みまで選べるようにしておく。
const SNAP_STEPS_M = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
// targetPx: 刻み1つが画面上でこの長さ以上になる候補を選ぶ。小さいほど細かく刻める。
function snapStepForZoom(zoom, targetPx) {
  const z = (Number.isFinite(zoom) && zoom > 0) ? zoom : 1;
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
  const t = (Number.isFinite(targetPx) && targetPx > 0) ? targetPx : SNAP_TARGET_PX;
  for (const m of SNAP_STEPS_M) {
    const stepPx = m / mpp;                       // 実寸m → グリッドpx
    if (stepPx * z >= t) return stepPx;
  }
  return SNAP_STEPS_M[SNAP_STEPS_M.length - 1] / mpp;
}
function snapAtZoom(x, y, zoom, targetPx) {
  const s = snapStepForZoom(zoom, targetPx);
  return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
}
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
// ══ 投影の係数を1回だけ作る・2026-11-24 ══
// 【なぜ要るか】地形は面ごとに4点を投影する。面40000 で16万回、細かさ401 なら64万回。
//   project3D は呼ぶたびに Math.cos/sin を4回計算するので、同じカメラで何万点も投影するときは
//   係数を使い回した方が速い。**式はここ1本**（project3D もこれを使う）。
// 使い方: const P = makeProjector(az, el, zoom, panX, panY); P(wx, wy, wz)
function makeProjector(az, el, zoom, panX, panY) {
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const sinE = Math.sin(el), cosE = Math.cos(el);
  const px = (panX || 0) + CAB_W / 2, py = (panY || 0) + CAB_H / 2;
  const hw = TW / 2, hh = TH / 2;
  return function (wx, wy, wz) {
    const cx = wx - hw, cy = -(wy - hh), cz = (wz || 0) / mpp;   // Y反転: 画面下→3D手前
    const rx = cx * cosA - cy * sinA;
    const ry = cx * sinA + cy * cosA;
    return { x: rx * zoom + px,
             y: (-ry * sinE - cz * cosE) * zoom + py,
             depth: ry * cosE - cz * sinE };
  };
}
// ══ 同じ投影を 4×4 行列にする（WebGL 用）・2026-11-24 ══
// 【式を2つ作らない】makeProjector と**同じ係数**から作る。向こうを直したらここも直す。
//   平行投影（アフィン）なので行列で厳密に表せる（検査 terrain_webgl.cjs で代表点を突き合わせる）。
// 【入力】wx, wy はグリッド座標、wz は**グリッドpx**（makeProjector と同じ約束）。
// 【出力】列優先の16要素。gl_Position = M * vec4(wx, wy, wz, 1) が **そのまま NDC**。
// 【画面への写り方】CAB 座標（CAB_W×CAB_H）を letterbox（sc・ox・oy）で canvas へ、
//   さらに NDC（中心原点・y上向き・-1..1）へ直す。ここを落とすと図が伸びる／上下が逆になる。
// 【depth】3次元図は depth が小さいほど手前。WebGL の既定（LESS）と向きは合うので、
//   [zNear, zFar] で -1..1 に正規化するだけ。範囲は呼ぶ側が地形の外接箱から毎フレーム出す。
function makeProjMatrix(az, el, zoom, panX, panY, opts) {
  const o = opts || {};
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const sinE = Math.sin(el), cosE = Math.cos(el);
  const hw = TW / 2, hh = TH / 2;
  const px = (panX || 0) + CAB_W / 2, py = (panY || 0) + CAB_H / 2;
  // letterbox（canvas の大きさと CAB の比）。省略なら CAB そのまま
  const cw = Number.isFinite(o.cw) ? o.cw : CAB_W, ch = Number.isFinite(o.ch) ? o.ch : CAB_H;
  const sc = Math.min(cw / CAB_W, ch / CAB_H);
  const ox = (cw - CAB_W * sc) / 2, oy = (ch - CAB_H * sc) / 2;
  const zN = Number.isFinite(o.zNear) ? o.zNear : -10000;
  const zF = Number.isFinite(o.zFar) ? o.zFar : 10000;
  // ── CAB 座標（makeProjector と同じ）──
  //   rx =  (wx-hw)*cosA + (wy-hh)*sinA          ← cy = -(wy-hh) なので符号に注意
  //   ry =  (wx-hw)*sinA - (wy-hh)*cosA
   //   X  =  rx*zoom + px
   //   Y  = (-ry*sinE - (wz/mpp)*cosE)*zoom + py
   //   D  =  ry*cosE - (wz/mpp)*sinE
  const Xx = zoom * cosA, Xy = zoom * sinA, Xz = 0;
  const X0 = px - zoom * (hw * cosA + hh * sinA);
  // Y = -zoom*sinE*ry - zoom*cosE*(wz/mpp) + py。ry の定数項は -(hw*sinA - hh*cosA)
  const Yx = -zoom * sinE * sinA, Yy = zoom * sinE * cosA, Yz = -zoom * cosE / mpp;
  const Y0b = py + zoom * sinE * (hw * sinA - hh * cosA);
  const Dx = cosE * sinA, Dy = -cosE * cosA, Dz = -sinE / mpp;
  const D0 = -cosE * (hw * sinA - hh * cosA);
  // ── 画面（canvas 画素）へ ──  sx = X*sc + ox,  sy = Y*sc + oy
  // ── NDC へ ──  ndcX = sx/cw*2 - 1,  ndcY = 1 - sy/ch*2
  const ax = 2 * sc / cw, bx = (2 * ox / cw) - 1;
  const ay = -2 * sc / ch, by = 1 - (2 * oy / ch);
  // ── depth を -1..1 へ ──  ndcZ = (D - zN)/(zF - zN)*2 - 1
  const az2 = 2 / ((zF - zN) || 1), bz = -2 * zN / ((zF - zN) || 1) - 1;
  // 列優先（gl.uniformMatrix4fv の既定 transpose=false）
  return new Float32Array([
    ax * Xx, ay * Yx, az2 * Dx, 0,
    ax * Xy, ay * Yy, az2 * Dy, 0,
    ax * Xz, ay * Yz, az2 * Dz, 0,
    ax * X0 + bx, ay * Y0b + by, az2 * D0 + bz, 1,
  ]);
}
function project3D(wx, wy, wz, az, el, zoom, panX, panY) {
  return makeProjector(az, el, zoom, panX, panY)(wx, wy, wz);
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
  // 据付高さ(pp.wz, グリッドpx)ぶん盤が持ち上がっている場合はレイ側を下げて相殺する
  const oz = ray.ozM * 1000 - (Number.isFinite(pp.wz) ? pp.wz : 0) * mpp * 1000; // m → mm
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

// ══════════════════════════════════════════════════════════════════════════
// 2Dビュー（平面図・断面図・側面図・矢視図・追加平面図）の座標変換
//
// これらのビューのコンテンツdivには、同一要素に CSS の
//   zoom: <倍率>  /  transform: rotate(<deg>deg)  /  transformOrigin: <ox>px <oy>px
// が掛かっている。マウスのclient座標をコンテンツ座標へ戻すとき、回転を無視して
//   (clientX - rect.left) / zoom
// と書くと、回転時にまったく別の点を指す（回転後のrectは軸並行バウンディングボックスに
// 変わるため、left/top はコンテンツ原点の像ではない）。
//
// 【一本化の原則】client↔コンテンツの変換は必ずこの2関数を通すこと。
// 各所で個別に (clientX - r.left)/z と書き下すのは禁止（2026-08-25 一本化）。
//
// 【数学的根拠】矩形を任意のtransformOriginで回転しても、回転後のAABBの中心は
// 「矩形中心を同じ変換で写した点」に一致する（4頂点の対称性による）。よって
// transformOrigin を知らなくても、rectの中心とコンテンツ中心(W/2, H/2)を
// 対応付ければ逆変換できる。
// ══════════════════════════════════════════════════════════════════════════

// client座標 → コンテンツ座標（回転・zoom対応）
//   rect : 要素の getBoundingClientRect()（回転後AABB）
//   W, H : コンテンツの論理サイズ（回転前・zoom前のpx。例: 平面図なら TW, TH）
//   zoom : 要素に掛けたCSS zoom
//   deg  : 要素に掛けた rotate() の角度（度。CSSと同じ符号＝時計回りが正）
function clientToContentRect(clientX, clientY, rect, W, H, zoom, deg) {
  const z = (Number.isFinite(zoom) && zoom > 0) ? zoom : 1;
  // 無回転なら rect.left/top がそのままコンテンツ原点の像。W/Hに依存しない式を使う
  // （中心基準の式と数学的には等価だが、W/Hの取り違えに影響されない分こちらが安全）。
  if (!deg) return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const r = -deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); // 逆回転
  return { x: W / 2 + (dx * c - dy * s) / z, y: H / 2 + (dx * s + dy * c) / z };
}

// コンテンツ座標 → 回転後のコンテンツ座標（順変換。スクロール位置の算出に使う）
// rotate(deg) を transformOrigin(ox, oy) 中心に掛けたとき、点(cx, cy)がどこへ写るか。
// clientToContentRect と対で管理すること（片方だけ符号を変えると必ず壊れる）。
function contentRotatePoint(cx, cy, deg, ox, oy) {
  if (!deg) return { x: cx, y: cy };
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: ox + (cx - ox) * c - (cy - oy) * s, y: oy + (cx - ox) * s + (cy - oy) * c };
}

// タッチ/マウス両対応で client 座標を取り出す
function eventClientXY(e) {
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
  return { clientX: t.clientX, clientY: t.clientY };
}
