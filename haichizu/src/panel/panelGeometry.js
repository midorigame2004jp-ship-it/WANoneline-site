// ================================================================
// panelGeometry.js — 3D投影・逆投影・オートフィット（配電盤／建物エディタ共有）
// geometry.js の project3D を TW/TH/METERS_PER_PX 非依存で再実装
// 単位: mm
//
// 【共有ファイルである】当初は「配電盤エディタ専用」だったが、
// 建物エディタの3Dプレビュー（BuildingPreview3D.jsx）も project3DPanel を使う。
// 投影と逆投影は同じ数式の表裏なので、必ずこのファイルで対にして管理すること
// （別ファイルに分けると az/el/zoom の規約や cy=-(wy-D/2) のY反転がズレる）
// ================================================================

// 3D投影（等角投影＋回転）
// wx: パネル内X座標(mm), wy: 奥行方向Y(mm), wz: 高さZ(mm)
// panelW/H/D: パネル外形寸法(mm)
// az: 水平回転(rad), el: 仰角(rad)
// zoom: 拡大率, panX/Y: 画面パン(px)
// canvW/H: キャンバスサイズ(px)
function project3DPanel(wx, wy, wz, panelW, panelH, panelD, az, el, zoom, panX, panY, canvW, canvH) {
  const cx = wx - panelW / 2;
  const cy = -(wy - panelD / 2); // Y反転: 手前(y=0)が正面
  const cz = wz - panelH / 2;   // Z中心: 下(z=0)〜上(z=H)
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const rx = cx * cosA - cy * sinA;
  const ry = cx * sinA + cy * cosA;
  const sx = rx * zoom + (panX || 0);
  const sy = (-ry * Math.sin(el) - cz * Math.cos(el)) * zoom + (panY || 0);
  const depth = ry * Math.cos(el) - cz * Math.sin(el);
  return { x: sx + (canvW || 600) / 2, y: sy + (canvH || 500) / 2, depth };
}

// ── 逆投影: 画面座標 →「高さ wz の水平面」上のワールド座標 ──
// project3DPanel の厳密な逆。wz を決めれば cz が定まるので一意に解ける。
// 用途: 3Dのまま壁を掴んで動かす／3Dで作図する／カーソル位置を拾う。
//
// 【特異点の扱い — geometry.js の作法に合わせる】
// el≈0（カメラが水平）だと水平面が真横を向き、交点計算が発散する。
// geometry.js は同じ問題に対して3世代かけて
//   「null や クランプではなく、**常に有限の値をフォールバックで返す**」
// という結論に達している（pickOrbitPivot / cabScreenToGroundPoint）。
// null を返すと「壁を掴んでいる途中で理由もなく動かなくなる」体験になり、
// 発散値を返すと NaN 座標が実データに混入する（geometry.js に実事故の記録あり）。
// ここも同じ方針: 閾値は同じ 0.08、フォールバックは
//   「視線レイ上で、その高さの面の中心にいちばん近い点」。
// さらに最後に isFinite を保証する（ドラッグ中のプレビューは
// bcApplyPartEdit の検証を通らないまま描画へ行くため、ここで止める必要がある）
const PANEL_UNPROJECT_SINE_EPS = 0.08; // geometry.js の PICK_ORBIT_GROUND_SINE_EPS と同値
function unproject3DPanelOnZ(screenX, screenY, wz, panelW, panelH, panelD, az, el, zoom, panX, panY, canvW, canvH) {
  const W = panelW, H = panelH, D = panelD;
  const zm = (zoom && isFinite(zoom) && Math.abs(zoom) > 1e-9) ? zoom : 1;
  const cosA = Math.cos(az), sinA = Math.sin(az);
  const cosE = Math.cos(el), sinE = Math.sin(el);
  const cz0 = wz - H / 2;
  // 画面座標を投影前の量へ戻す
  const rx = (screenX - (canvW || 600) / 2 - (panX || 0)) / zm;
  const sv = (screenY - (canvH || 500) / 2 - (panY || 0)) / zm; // = -ry*sinE - cz*cosE
  let ry;
  if (Math.abs(sinE) > PANEL_UNPROJECT_SINE_EPS) {
    // 面と交わる。depth を消去して ry を解く
    ry = -(sv + cz0 * cosE) / sinE;
  } else {
    // ほぼ真横。レイ上で「面の中心」にいちばん近い点を採る（常に有限）
    // レイ: P(d) = (rx, -sinE*sv + cosE*d, -cosE*sv - sinE*d) / 方向は単位ベクトル
    // 面の中心 R=(0,0,cz0) への最近点は d* = -sinE*cz0
    const d = -sinE * cz0;
    ry = -sinE * sv + cosE * d;
  }
  const cx = rx * cosA + ry * sinA;
  const cy = -rx * sinA + ry * cosA;
  const wx = cx + W / 2;
  const wy = D / 2 - cy;
  // NaN/Infinity を外へ出さない。壊れたら面の中心を返す
  if (!isFinite(wx) || !isFinite(wy)) return { x: W / 2, y: D / 2, degenerate: true };
  return { x: wx, y: wy, degenerate: Math.abs(sinE) <= PANEL_UNPROJECT_SINE_EPS };
}

// パネル8頂点を zoom=1 で投影しbboxからフィットパラメータを返す
// 戻り値: { zoom, panX, panY }
function panelAutoFit(panel, az, el, canvW, canvH) {
  const W = panel.widthMm || 600, H = panel.heightMm || 1800, D = panel.depthMm || 400;
  const cW = canvW || 600, cH = canvH || 500;
  const corners = [
    [0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0],
    [0, 0, H], [W, 0, H], [W, D, H], [0, D, H],
  ];
  // zoom=1, pan=0 で投影してbbox計算
  const pts1 = corners.map(([x, y, z]) =>
    project3DPanel(x, y, z, W, H, D, az, el, 1, 0, 0, cW, cH)
  );
  const cxs = pts1.map(p => p.x - cW / 2);
  const cys = pts1.map(p => p.y - cH / 2);
  const bboxW = (Math.max(...cxs) - Math.min(...cxs)) || 1;
  const bboxH = (Math.max(...cys) - Math.min(...cys)) || 1;
  const margin = 80;
  const zoom = Math.max(0.05, Math.min(20,
    Math.min((cW - margin) / bboxW, (cH - margin) / bboxH)
  ));
  // zoom確定後に再投影してセンタリング
  const pts2 = corners.map(([x, y, z]) =>
    project3DPanel(x, y, z, W, H, D, az, el, zoom, 0, 0, cW, cH)
  );
  const minX = Math.min(...pts2.map(p => p.x));
  const maxX = Math.max(...pts2.map(p => p.x));
  const minY = Math.min(...pts2.map(p => p.y));
  const maxY = Math.max(...pts2.map(p => p.y));
  const panX = cW / 2 - (minX + maxX) / 2;
  const panY = cH / 2 - (minY + maxY) / 2;
  return { zoom, panX, panY };
}

// 面の法線がカメラに対して後ろ向き（不可視側）かを判定
// true = back-facing（カメラから見えない側）、false = front-facing（見える側）
function panelIsBackFacing(normal, az, el) {
  const nx = normal.nx || 0, ny = normal.ny || 0, nz = normal.nz || 0;
  // cy = -(wy-D/2) 反転後に az 回転した法線 Y 成分:
  //   nyi = -ny → ry_n = nx*sin(az) - nyi*cos(az) = nx*sin(az) - ny*cos(az)
  // depthN = dot(normal_cam, depth_dir):
  //   depthN > 0 = カメラに向いている → front-facing → return false（描画）
  //   depthN < 0 = カメラ反対向き   → back-facing  → return true（カリング）
  const ry_n = nx * Math.sin(az) - ny * Math.cos(az);
  const depthN = ry_n * Math.cos(el) - nz * Math.sin(el);
  return depthN < 0;
}

// ────────────────────────────────────────────────────────────
// 扉候補矩形を生成する
// face: 'front'|'back'|'left'|'right'|'top'|'bottom'
// strict: 仕切りが実際にその面に到達する場合のみ境界として使用
// extended: 全仕切りの posMm を面全体に投影（重複は strict から除外）
// 戻り値: { strict: [{uMm,vMm,widthMm,heightMm}], extended: [...] }
function deriveFaceDoorCandidates(panel, face) {
  const W = panel.widthMm || 600, H = panel.heightMm || 1800, D = panel.depthMm || 400;
  const FACE_DEF = {
    front:  { depthAxis:'y', depthMin:true,  d1Axis:'x', d2Axis:'z', maxD1:W, maxD2:H },
    back:   { depthAxis:'y', depthMin:false, d1Axis:'x', d2Axis:'z', maxD1:W, maxD2:H },
    left:   { depthAxis:'x', depthMin:true,  d1Axis:'y', d2Axis:'z', maxD1:D, maxD2:H },
    right:  { depthAxis:'x', depthMin:false, d1Axis:'y', d2Axis:'z', maxD1:D, maxD2:H },
    top:    { depthAxis:'z', depthMin:false, d1Axis:'x', d2Axis:'y', maxD1:W, maxD2:D },
    bottom: { depthAxis:'z', depthMin:true,  d1Axis:'x', d2Axis:'y', maxD1:W, maxD2:D },
  };
  const fd = FACE_DEF[face];
  if (!fd) return { strict: [], extended: [] };
  const { depthAxis, depthMin, d1Axis, d2Axis, maxD1, maxD2 } = fd;
  const depthMax = { x: W, y: D, z: H }[depthAxis];
  const depthVal = depthMin ? 0 : depthMax;
  const eps = 0.5;

  const getRange = (p) => {
    const pos = p.posMm != null ? p.posMm : (p.axis==='x' ? W/2 : p.axis==='y' ? D/2 : H/2);
    const th = Math.max(0.5, (p.thicknessMm || 2) / 2);
    if (p.axis === 'x') return { x:[pos-th,pos+th], y:[p.uMinMm??0, p.uMaxMm??D], z:[p.vMinMm??0, p.vMaxMm??H] };
    if (p.axis === 'y') return { x:[p.uMinMm??0, p.uMaxMm??W], y:[pos-th,pos+th], z:[p.vMinMm??0, p.vMaxMm??H] };
    return { x:[p.uMinMm??0, p.uMaxMm??W], y:[p.vMinMm??0, p.vMaxMm??D], z:[pos-th,pos+th] };
  };
  const edgeTouchesface = (range) => {
    const r = range[depthAxis];
    return Math.abs(r[0] - depthVal) <= eps || Math.abs(r[1] - depthVal) <= eps;
  };
  const mergePos = (set, val) => {
    for (const v of set) { if (Math.abs(v - val) <= eps) return; }
    set.add(val);
  };
  const inSet = (val, set) => {
    for (const v of set) { if (Math.abs(v - val) <= eps) return true; }
    return false;
  };

  // d1軸: 面到達(strictD1) と 全位置(allD1) を別々に収集
  const strictD1 = new Set([0, maxD1]);
  const allD1 = new Set([0, maxD1]);
  for (const p of (panel.partitions || [])) {
    if (p.type !== 'axis' || p.axis !== d1Axis) continue;
    const pos = p.posMm != null ? p.posMm : (p.axis==='x' ? W/2 : p.axis==='y' ? D/2 : H/2);
    if (pos <= eps || pos >= maxD1 - eps) continue;
    const range = getRange(p);
    mergePos(allD1, pos);
    if (edgeTouchesface(range)) mergePos(strictD1, pos);
  }
  // d2軸仕切りの d1方向端点（直角方向の延長候補）
  for (const p of (panel.partitions || [])) {
    if (p.type !== 'axis' || p.axis !== d2Axis) continue;
    const pos = p.posMm != null ? p.posMm : (p.axis==='x' ? W/2 : p.axis==='y' ? D/2 : H/2);
    if (pos <= eps || pos >= maxD2 - eps) continue;
    const [rLo, rHi] = getRange(p)[d1Axis];
    if (rLo > eps) mergePos(allD1, rLo);
    if (rHi < maxD1 - eps) mergePos(allD1, rHi);
  }

  // depthAxis仕切り（選択面と平行）の辺を候補に追加、手前から処理して遮蔽を除外
  const _depParts = (panel.partitions || [])
    .filter(p => p.type === 'axis' && p.axis === depthAxis)
    .sort((a, b) => {
      const pa = a.posMm != null ? a.posMm : depthMax / 2;
      const pb = b.posMm != null ? b.posMm : depthMax / 2;
      return depthMin ? pa - pb : pb - pa;
    });
  const _covD1 = [], _covD2 = [];
  const _depD2Edges = [];
  const _hidD1 = (x) => _covD1.some(r => r.lo + eps < x && x < r.hi - eps);
  const _hidD2 = (z) => _covD2.some(r => r.lo + eps < z && z < r.hi - eps);
  for (const p of _depParts) {
    const range = getRange(p);
    const [d1Lo, d1Hi] = range[d1Axis];
    const [d2Lo, d2Hi] = range[d2Axis];
    if (d1Lo > eps && !_hidD1(d1Lo)) mergePos(allD1, d1Lo);
    if (d1Hi < maxD1 - eps && !_hidD1(d1Hi)) mergePos(allD1, d1Hi);
    if (d2Lo > eps && !_hidD2(d2Lo)) _depD2Edges.push({ pos: d2Lo, d1Lo, d1Hi });
    if (d2Hi < maxD2 - eps && !_hidD2(d2Hi)) _depD2Edges.push({ pos: d2Hi, d1Lo, d1Hi });
    _covD1.push({ lo: d1Lo, hi: d1Hi });
    _covD2.push({ lo: d2Lo, hi: d2Hi });
  }

  // 列ごとの strictD2 を構築（完全横断 かつ 面到達 のみ）
  const buildStrictD2 = (colLeft, colRight) => {
    const s = new Set([0, maxD2]);
    for (const p of (panel.partitions || [])) {
      if (p.type !== 'axis' || p.axis !== d2Axis) continue;
      const pos = p.posMm != null ? p.posMm : (p.axis==='x' ? W/2 : p.axis==='y' ? D/2 : H/2);
      if (pos <= eps || pos >= maxD2 - eps) continue;
      const range = getRange(p);
      const [rLo, rHi] = range[d1Axis];
      if (rLo <= colLeft + eps && rHi >= colRight - 3 && edgeTouchesface(range)) mergePos(s, pos);
    }
    return s;
  };

  // 列ごとの allD2 を構築（重なる全仕切り＋直角端点＋depth辺を含む）
  const buildAllD2 = (colLeft, colRight, strictD2) => {
    const a = new Set(strictD2); // strictD2 を必ず含む
    for (const p of (panel.partitions || [])) {
      if (p.type !== 'axis' || p.axis !== d2Axis) continue;
      const pos = p.posMm != null ? p.posMm : (p.axis==='x' ? W/2 : p.axis==='y' ? D/2 : H/2);
      if (pos <= eps || pos >= maxD2 - eps) continue;
      const [rLo, rHi] = getRange(p)[d1Axis];
      if (rHi > colLeft - eps && rLo < colRight + eps) mergePos(a, pos);
    }
    for (const p of (panel.partitions || [])) {
      if (p.type !== 'axis' || p.axis !== d1Axis) continue;
      const pos = p.posMm != null ? p.posMm : (p.axis==='x' ? W/2 : p.axis==='y' ? D/2 : H/2);
      if (pos <= eps || pos >= maxD1 - eps) continue;
      if (Math.abs(pos - colLeft) > eps && Math.abs(pos - colRight) > eps) continue;
      const [vLo, vHi] = getRange(p)[d2Axis];
      if (vLo > eps) mergePos(a, vLo);
      if (vHi < maxD2 - eps) mergePos(a, vHi);
    }
    for (const e of _depD2Edges) {
      if (e.d1Hi > colLeft - eps && e.d1Lo < colRight + eps) mergePos(a, e.pos);
    }
    return a;
  };

  const strictD1Sorted = [...strictD1].sort((a, b) => a - b);
  const allD1Sorted   = [...allD1].sort((a, b) => a - b);
  const strictCells = [], extCells = [];

  // ── Phase1: strictCells を strictD1×strictD2 グリッドから生成 ──
  // （allD1 に非strict位置が混入しても strict セルは分割されない）
  for (let ci = 0; ci < strictD1Sorted.length - 1; ci++) {
    const colLeft = strictD1Sorted[ci], colRight = strictD1Sorted[ci + 1];
    if (colRight - colLeft < 1) continue;
    const strictD2 = buildStrictD2(colLeft, colRight);
    const sArr = [...strictD2].sort((a, b) => a - b);
    for (let ri = 0; ri < sArr.length - 1; ri++) {
      const vLo = sArr[ri], vHi = sArr[ri + 1];
      if (vHi - vLo < 1) continue;
      strictCells.push({ uMm: colLeft, vMm: vLo, widthMm: colRight - colLeft, heightMm: vHi - vLo });
    }
  }

  // ── Phase2: extCells を allD1×allD2 グリッドから生成（Phase1と重複するセルは除外）──
  // colStrict && rowStrict のセルは Phase1 で生成済みなのでスキップ
  for (let ci = 0; ci < allD1Sorted.length - 1; ci++) {
    const colLeft = allD1Sorted[ci], colRight = allD1Sorted[ci + 1];
    if (colRight - colLeft < 1) continue;
    const colStrict = inSet(colLeft, strictD1) && inSet(colRight, strictD1);
    const strictD2 = buildStrictD2(colLeft, colRight);
    const allD2 = buildAllD2(colLeft, colRight, strictD2);
    const allD2Arr = [...allD2].sort((a, b) => a - b);
    for (let ri = 0; ri < allD2Arr.length - 1; ri++) {
      const vLo = allD2Arr[ri], vHi = allD2Arr[ri + 1];
      const h = vHi - vLo;
      if (h < 1) continue;
      const rowStrict = inSet(vLo, strictD2) && inSet(vHi, strictD2);
      if (colStrict && rowStrict) continue; // Phase1 で生成済み
      extCells.push({ uMm: colLeft, vMm: vLo, widthMm: colRight - colLeft, heightMm: h });
    }
  }

  return { strict: strictCells, extended: extCells };
}

// 指定した軸（'x'|'y'|'z'）のスクリーン投影ベクトルを返す
// ドラッグ量(Δpx)をこれで射影すると、Δmm を得られる（100mm 分の距離基準）
// 戻り値: { dx, dy, len2 }
function panelAxisScreenVec(axisName, panel, az, el, zoom, panX, panY, canvW, canvH) {
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const cx = W / 2, cy = D / 2, cz = H / 2;
  const ref = 100;
  const p0 = project3DPanel(cx, cy, cz, W, H, D, az, el, zoom, panX, panY, canvW, canvH);
  const p1 = axisName === 'x'
    ? project3DPanel(cx + ref, cy, cz, W, H, D, az, el, zoom, panX, panY, canvW, canvH)
    : axisName === 'y'
      ? project3DPanel(cx, cy + ref, cz, W, H, D, az, el, zoom, panX, panY, canvW, canvH)
      : project3DPanel(cx, cy, cz + ref, W, H, D, az, el, zoom, panX, panY, canvW, canvH);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  return { dx, dy, len2: dx * dx + dy * dy };
}

// 選択された axis 仕切りのギズモハンドル座標を計算
// projFn: (wx, wy, wz) => { x, y } のスクリーン投影関数
// 戻り値: [{type, field, dragAxis, defaultVal, sx, sy}]
function panelGizmoHandles(partition, panel, projFn) {
  if (!partition || partition.type !== 'axis') return [];
  const { axis } = partition;
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const pos = partition.posMm != null ? partition.posMm
    : (axis === 'x' ? W / 2 : axis === 'y' ? D / 2 : H / 2);

  let uMin, uMax, vMin, vMax;
  if (axis === 'x') {
    uMin = partition.uMinMm != null ? partition.uMinMm : 0;
    uMax = partition.uMaxMm != null ? partition.uMaxMm : D;
    vMin = partition.vMinMm != null ? partition.vMinMm : 0;
    vMax = partition.vMaxMm != null ? partition.vMaxMm : H;
  } else if (axis === 'y') {
    uMin = partition.uMinMm != null ? partition.uMinMm : 0;
    uMax = partition.uMaxMm != null ? partition.uMaxMm : W;
    vMin = partition.vMinMm != null ? partition.vMinMm : 0;
    vMax = partition.vMaxMm != null ? partition.vMaxMm : H;
  } else {
    uMin = partition.uMinMm != null ? partition.uMinMm : 0;
    uMax = partition.uMaxMm != null ? partition.uMaxMm : W;
    vMin = partition.vMinMm != null ? partition.vMinMm : 0;
    vMax = partition.vMaxMm != null ? partition.vMaxMm : D;
  }
  const cu = (uMin + uMax) / 2, cv = (vMin + vMax) / 2;

  const defs =
    axis === 'x' ? [
      { type: 'pos',  field: 'posMm',  dragAxis: 'x', defaultVal: W/2, wx: pos,  wy: cu,   wz: cv   },
      { type: 'uMin', field: 'uMinMm', dragAxis: 'y', defaultVal: 0,   wx: pos,  wy: uMin, wz: cv   },
      { type: 'uMax', field: 'uMaxMm', dragAxis: 'y', defaultVal: D,   wx: pos,  wy: uMax, wz: cv   },
      { type: 'vMin', field: 'vMinMm', dragAxis: 'z', defaultVal: 0,   wx: pos,  wy: cu,   wz: vMin },
      { type: 'vMax', field: 'vMaxMm', dragAxis: 'z', defaultVal: H,   wx: pos,  wy: cu,   wz: vMax },
    ] : axis === 'y' ? [
      { type: 'pos',  field: 'posMm',  dragAxis: 'y', defaultVal: D/2, wx: cu,   wy: pos,  wz: cv   },
      { type: 'uMin', field: 'uMinMm', dragAxis: 'x', defaultVal: 0,   wx: uMin, wy: pos,  wz: cv   },
      { type: 'uMax', field: 'uMaxMm', dragAxis: 'x', defaultVal: W,   wx: uMax, wy: pos,  wz: cv   },
      { type: 'vMin', field: 'vMinMm', dragAxis: 'z', defaultVal: 0,   wx: cu,   wy: pos,  wz: vMin },
      { type: 'vMax', field: 'vMaxMm', dragAxis: 'z', defaultVal: H,   wx: cu,   wy: pos,  wz: vMax },
    ] : [
      { type: 'pos',  field: 'posMm',  dragAxis: 'z', defaultVal: H/2, wx: cu,   wy: cv,   wz: pos  },
      { type: 'uMin', field: 'uMinMm', dragAxis: 'x', defaultVal: 0,   wx: uMin, wy: cv,   wz: pos  },
      { type: 'uMax', field: 'uMaxMm', dragAxis: 'x', defaultVal: W,   wx: uMax, wy: cv,   wz: pos  },
      { type: 'vMin', field: 'vMinMm', dragAxis: 'y', defaultVal: 0,   wx: cu,   wy: vMin, wz: pos  },
      { type: 'vMax', field: 'vMaxMm', dragAxis: 'y', defaultVal: D,   wx: cu,   wy: vMax, wz: pos  },
    ];

  return defs.map(d => {
    const p = projFn(d.wx, d.wy, d.wz);
    return { ...d, sx: p.x, sy: p.y };
  });
}
