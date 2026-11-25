// ================================================================
// panelDrawCore.js — 配電盤 静的描画コア（配電盤エディタ / 3次元図 共通）
//
// 【唯一の正】盤の「見た目」（色・輝度・アルファ・線幅・形状）を決める
// 定数とロジックはこのファイルだけで管理する。
// PanelCanvas3D.jsx（エディタ）から逐語抽出したもので、エディタ本体も
// 3次元図（App.jsx）も同じ関数を呼ぶ。見た目の変更は必ずここを編集する。
//
// カメラ規約の差（エディタ: panel-local az/el、3次元図: world camAz/camEl）は
// view オブジェクトで呼び出し側が吸収する:
//   view = {
//     proj(x_mm, y_mm, z_mm) -> {x, y, depth},   // 3D→2D投影
//     isBackFacing(normal) -> bool,               // 法線カリング（カメラ規約込み）
//     nearSign: +1 | -1,   // +1: depth大=手前（エディタ）, -1: depth大=奥（3次元図）
//     lwUnit: 1,           // CSS px 1本分の線幅係数（3次元図は dpr/canvasSc）
//   }
// 依存: solidModel.js（blockToSolid経由のsolid構造のみ。関数依存なし）
// ================================================================

// ── 外箱透明度の既定値（唯一の正・2026-08-02 追加）──
// panel.outerOpacity が未設定のときの解釈。エディタは元々80（ほぼ透明）だったが、
// 3次元図側は独自に0（不透明）をデフォルトにしており、outerOpacity未設定の盤で
// 「エディタは仕切りが透けて見えるが3次元図は仕切りが一切描画されない」という
// 見た目の乖離が生じていた。エディタ基準の80に統一する。
const PDC_DEFAULT_TRANSPARENCY = 80;
function pdcTransparency(panel) {
  return (panel && panel.outerOpacity) ?? PDC_DEFAULT_TRANSPARENCY;
}

// ── 色ヘルパー（PanelCanvas3D.jsx から移設）──
function _hexToRGB(hex) {
  const h = (hex || '#94A3B8').replace('#', '');
  return [
    parseInt(h.substr(0, 2) || '94', 16),
    parseInt(h.substr(2, 2) || 'A3', 16),
    parseInt(h.substr(4, 2) || 'B8', 16),
  ];
}

// ── 面輝度（PanelCanvas3D.jsx から移設）──
function panelFaceBrightness(normal) {
  const n = normal || {};
  // 主光源（右上前）
  const dot1 = Math.max(0, (n.nx || 0) * 0.3 + (n.ny || 0) * (-0.5) + (n.nz || 0) * 0.8);
  // 補助光（左下後 = 裏面でも真っ暗にならないフィル光）
  const dot2 = Math.max(0, (n.nx || 0) * (-0.2) + (n.ny || 0) * 0.3 + (n.nz || 0) * (-0.5));
  return 0.45 + 0.45 * dot1 + 0.15 * dot2;
}

// ── 外箱12辺の頂点インデックスペア（PanelCanvas3D.jsx から移設）──
const BOX_EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

// 各辺に隣接する2面の法線（インデックスはBOX_EDGESと対応）— 隠線除去用
const EDGE_FACE_NORMALS = [
  [{nx:0,ny:-1,nz:0},{nx:0,ny:0,nz:-1}], // [0,1] front+bottom
  [{nx:+1,ny:0,nz:0},{nx:0,ny:0,nz:-1}], // [1,2] right+bottom
  [{nx:0,ny:+1,nz:0},{nx:0,ny:0,nz:-1}], // [2,3] back+bottom
  [{nx:-1,ny:0,nz:0},{nx:0,ny:0,nz:-1}], // [3,0] left+bottom
  [{nx:0,ny:-1,nz:0},{nx:0,ny:0,nz:+1}], // [4,5] front+top
  [{nx:+1,ny:0,nz:0},{nx:0,ny:0,nz:+1}], // [5,6] right+top
  [{nx:0,ny:+1,nz:0},{nx:0,ny:0,nz:+1}], // [6,7] back+top
  [{nx:-1,ny:0,nz:0},{nx:0,ny:0,nz:+1}], // [7,4] left+top
  [{nx:0,ny:-1,nz:0},{nx:-1,ny:0,nz:0}], // [0,4] front+left
  [{nx:0,ny:-1,nz:0},{nx:+1,ny:0,nz:0}], // [1,5] front+right
  [{nx:0,ny:+1,nz:0},{nx:+1,ny:0,nz:0}], // [2,6] back+right
  [{nx:0,ny:+1,nz:0},{nx:-1,ny:0,nz:0}], // [3,7] back+left
];

// ── 扉の面別法線・開き方向（PanelCanvas3D.jsx useEffect内から移設）──
const PDC_DOOR_MOUNT_NORMALS = {
  front:{nx:0,ny:-1,nz:0}, back:{nx:0,ny:+1,nz:0},
  left:{nx:-1,ny:0,nz:0},  right:{nx:+1,ny:0,nz:0},
  top:{nx:0,ny:0,nz:+1},   bottom:{nx:0,ny:0,nz:-1},
};
const PDC_DOOR_OUT = {
  front:[0,-1,0], back:[0,+1,0], left:[-1,0,0], right:[+1,0,0], top:[0,0,+1], bottom:[0,0,-1]
};

// ── 面ローカルUV→盤ローカルxyz（扉・開口部で共用）──
function pdcFaceUV(face, u, v, panel) {
  const _W = panel.widthMm, _H = panel.heightMm, _D = panel.depthMm;
  switch (face) {
    case 'front': return [u, 0, v];    case 'back':  return [u, _D, v];
    case 'left':  return [0, u, v];    case 'right': return [_W, u, v];
    case 'top':   return [u, v, _H];   case 'bottom':return [u, v, 0];
    default: return [u, 0, v];
  }
}

// ── 外箱透明度→アルファ値（区間1 t=0-4: 0%→1%を4等分、区間2 t=4-100: 線形）──
function pdcSolidAlpha(transparency) {
  if (transparency === 0) return 1;
  const SPLIT = 4, EPS = 0.01;
  if (transparency <= SPLIT) return 1 - (transparency / SPLIT) * EPS;
  return 1 - (EPS + (transparency - SPLIT) / (100 - SPLIT) * (1 - EPS));
}

// ── 扉の4隅3D座標（開扉は110°回転）──
function pdcDoorCorners(door, panel) {
  const { face, uMm:u, vMm:v, widthMm:dw, heightMm:dh, isOpen, hingeSide } = door;
  const A = pdcFaceUV(face, u, v, panel), B = pdcFaceUV(face, u+dw, v, panel);
  const C = pdcFaceUV(face, u+dw, v+dh, panel), Dp = pdcFaceUV(face, u, v+dh, panel);
  if (!isOpen) return [A, B, C, Dp];
  const out = PDC_DOOR_OUT[face] || [0,0,0];
  const cosA = Math.cos(110*Math.PI/180), sinA = Math.sin(110*Math.PI/180);
  const rotFree = (hinge, free) => {
    const dx = free[0]-hinge[0], dy = free[1]-hinge[1], dz = free[2]-hinge[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    return [hinge[0]+dx*cosA+out[0]*len*sinA, hinge[1]+dy*cosA+out[1]*len*sinA, hinge[2]+dz*cosA+out[2]*len*sinA];
  };
  const _hFlip = new Set(['back','left','bottom']);
  const effSide = _hFlip.has(face) ? (hingeSide==='right' ? 'left' : 'right') : (hingeSide || 'left');
  if (effSide === 'right') return [rotFree(B,A), B, C, rotFree(C,Dp)];
  return [A, rotFree(A,B), rotFree(Dp,C), Dp];
}

// ── Step 1: 外箱の可視面を収集（遠→近ソート済み）──
// solids: panelToSolids(panel) の結果。_isOuter の面のみ対象
// 戻り値: [{ f, solid, pts, depth }]（fとsolidはZバッファ等の後段処理用に保持）
function pdcCollectOuterFaces(solids, view) {
  const outerFaces = [];
  solids.forEach(solid => {
    if (!solid._isOuter) return;
    (solid.faces || []).forEach(f => {
      if (!f.vertices || f.vertices.length < 3) return;
      if (view.isBackFacing(f.normal)) return;
      const pts = f.vertices.map(v => view.proj(v.x, v.y, v.z));
      const depth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
      outerFaces.push({ f, solid, pts, depth });
    });
  });
  const ns = view.nearSign || 1;
  outerFaces.sort((a, b) => (a.depth - b.depth) * ns); // 遠い面から描く
  return outerFaces;
}

// ── Step 1: 外箱面の描画（Painter's Algorithm）──
function pdcPaintOuterFaces(ctx, outerFaces, outerAlpha) {
  outerFaces.forEach(({ f, solid, pts }) => {
    const br = Math.min(panelFaceBrightness(f.normal), 1.5);
    const [ri, gi, bi] = _hexToRGB(solid.color || '#4A90D9');
    ctx.globalAlpha = outerAlpha;
    ctx.fillStyle = `rgb(${Math.min(255,Math.round(ri*br))},${Math.min(255,Math.round(gi*br))},${Math.min(255,Math.round(bi*br))})`;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.fill();
  });
  ctx.globalAlpha = 1;
}

// ── Step 3.4: 外箱ワイヤーフレーム（12辺）──
// transparency=0 のときのみ隠線除去（両隣接面がbackfacingの辺をスキップ）
function pdcPaintOuterWireframe(ctx, panel, view, transparency) {
  const { widthMm: PW, heightMm: PH, depthMm: PD } = panel;
  const cp = [
    [0,0,0],[PW,0,0],[PW,PD,0],[0,PD,0],
    [0,0,PH],[PW,0,PH],[PW,PD,PH],[0,PD,PH],
  ].map(([x,y,z]) => view.proj(x,y,z));
  ctx.strokeStyle = 'rgba(100,150,255,0.7)';
  ctx.lineWidth = 1.2 * (view.lwUnit || 1);
  BOX_EDGES.forEach(([a,b], i) => {
    if (transparency === 0) {
      const [n1, n2] = EDGE_FACE_NORMALS[i];
      if (view.isBackFacing(n1) && view.isBackFacing(n2)) return;
    }
    ctx.beginPath(); ctx.moveTo(cp[a].x, cp[a].y); ctx.lineTo(cp[b].x, cp[b].y); ctx.stroke();
  });
}

// ── Step 3.5前段: 扉の収集 ──
// doorHits: 全扉（クリック判定用・カリングなし）
// doorRenderList: 描画対象（閉扉はbackfacingならスキップ）遠→近ソート済み
// 各要素: { door, corners, pts, depth, depthKey }
function pdcCollectDoors(panel, view) {
  const ns = view.nearSign || 1;
  const doorHits = [];
  const doorRenderList = [];
  for (const door of (panel.doors || [])) {
    const corners = pdcDoorCorners(door, panel);
    const pts = corners.map(([x,y,z]) => view.proj(x,y,z));
    const depth = pts.reduce((s,p) => s+p.depth, 0) / pts.length;
    doorHits.push({ door, pts, depth });
    if (!door.isOpen) {
      const mountN = PDC_DOOR_MOUNT_NORMALS[door.face] || {nx:0,ny:-1,nz:0};
      if (view.isBackFacing(mountN)) continue;
    }
    // 閉扉は外箱面とのZ-fighting回避のためわずかに奥へ
    const depthKey = door.isOpen ? depth : depth - 0.1 * ns;
    doorRenderList.push({ door, corners, pts, depthKey });
  }
  doorRenderList.sort((a, b) => (a.depthKey - b.depthKey) * ns); // 遠い扉から描く
  return { doorHits, doorRenderList };
}

// ── Step 3.5: 扉の描画（半透明時 = Painter's Algorithm）──
// エディタの transparency>0 枝と同一。輝度補正なし・solidAlphaそのまま
function pdcPaintDoorsTranslucent(ctx, doorRenderList, panelColor, solidAlpha, view) {
  const _doorCol = panelColor || '#4A90D9';
  for (const { pts } of doorRenderList) {
    ctx.globalAlpha = solidAlpha;
    ctx.fillStyle = _doorCol;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(100,150,255,0.7)';
    ctx.lineWidth = 1.2 * (view.lwUnit || 1);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.stroke();
  }
}

// ── Step 3.5: 扉の描画（不透明時のPainter's近似・3次元図用）──
// エディタは transparency=0 のときZバッファで画素単位の前後判定を行う。
// 3次元図では負荷を抑えるためPainter'sで近似するが、色仕様（取り付け面輝度
// br適用の不透明fill・wireframe rgb(100,150,255)）はZバッファ枝と同一にする。
function pdcPaintDoorsOpaquePainter(ctx, doorRenderList, panelColor, view) {
  const [_dr0, _dg0, _db0] = _hexToRGB(panelColor || '#4A90D9');
  for (const { door, pts } of doorRenderList) {
    const mountN = PDC_DOOR_MOUNT_NORMALS[door.face] || {nx:0,ny:-1,nz:0};
    const br = Math.min(panelFaceBrightness(mountN), 1.5);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgb(${Math.min(255,Math.round(_dr0*br))},${Math.min(255,Math.round(_dg0*br))},${Math.min(255,Math.round(_db0*br))})`;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgb(100,150,255)';
    ctx.lineWidth = 1.0 * (view.lwUnit || 1);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.stroke();
  }
}

// ── 内部要素（仕切り・アイコン・配線）の合成アルファ ──
// エディタ仕様: 透明度>0 → 外箱の透明度に反比例（1-solidAlpha）、透明度0 → 100%
// （透明度0のときは開口部クリップとの併用が前提。クリップは呼び出し側で行う）
function pdcInteriorAlpha(transparency, solidAlpha) {
  return transparency > 0 ? 1 - solidAlpha : 1;
}

// ── X線モード（iconVisMode = semi / full）のアイコンBox最上層 合成アルファ ──
// semi/full では「アイコンBoxは仕切り・扉に遮蔽されず常に見える」ため、
// 全要素の描画後に最上層として一定の透け具合で重ねる。透明度には依存しない。
// エディタ（PanelCanvas3D）も3次元図（App.jsx）もこの値を参照すること。
const PDC_ICONONLY_COMPOSITE_ALPHA = 0.6;

// ── 仕切り面の塗り色RGB（エディタZバッファ枝 L1441-1445 と同一）──
// isSel: エディタの選択ハイライト（×1.3輝度）。3次元図は常にfalse
function pdcPartitionFaceRGB(color, normal, isSel) {
  const br = Math.min(panelFaceBrightness(normal) * (isSel ? 1.3 : 1), 1.5);
  const [ri, gi, bi] = _hexToRGB(color || '#94A3B8');
  return [
    Math.min(255, Math.round(ri * br)),
    Math.min(255, Math.round(gi * br)),
    Math.min(255, Math.round(bi * br)),
  ];
}

// ════════════════════════════════════════════════════════════════
// 仕切り交差の事前分割（BSP的アプローチ — 3次元図Painter's専用）
// 貫通交差する仕切り同士は、面の「平均depth」ソートでは視点により前後が
// 不連続に反転してチラつく。各仕切り面を「他の仕切りの中央平面」で事前に
// クリップ分割しておけば、断片はどの仕切り平面もまたがないため
// depthソートで常に正しい順序になる。
// ・分割は視点非依存（盤ローカルmm座標だけで決まる）→ 呼び出し側でキャッシュすること
// ・エッジ線（_pdcPartitionEdgeLoops系）には適用しない（分割線が輪郭に見えるため）
// ・エディタ（Zバッファ）は使わない。3次元図（App.jsx）からのみ呼ぶ
// ════════════════════════════════════════════════════════════════
const PDC_SPLIT_EPS_DIST = 0.01;  // mm: 平面距離の許容誤差（頂点を平面上とみなす閾値）
const PDC_SPLIT_EPS_AREA = 0.01;  // mm^2: これ未満の断片（スライバー）は棄却
const PDC_SPLIT_EPS_WELD = 1e-3;  // mm: 重複頂点の融合距離
const PDC_SPLIT_MAX_FRAGS_PER_FACE = 256;  // 1面あたりの断片数上限（暴走防止）
const PDC_SPLIT_MAX_FRAGS_TOTAL = 2048;    // 盤全体の断片数上限（暴走防止）

// Newell法の面積ベクトル（3D多角形の面積・法線計算の標準手法）
function _pdcNewellAreaVec(verts) {
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    ax += (a.y - b.y) * (a.z + b.z);
    ay += (a.z - b.z) * (a.x + b.x);
    az += (a.x - b.x) * (a.y + b.y);
  }
  return { x: ax / 2, y: ay / 2, z: az / 2 };
}
function _pdcFaceArea3D(verts) {
  const v = _pdcNewellAreaVec(verts);
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
function _pdcFaceCentroid3D(verts) {
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += v.x; cy += v.y; cz += v.z; }
  const n = verts.length || 1;
  return { x: cx / n, y: cy / n, z: cz / n };
}
// 3D多角形が凸かどうかの簡易判定（隣接辺の外積の向きが全て揃っているか）
function _pdcIsConvexPoly(verts, normal) {
  const n = verts.length;
  if (n < 3 || !normal) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n], c = verts[(i + 2) % n];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const dot = cx * normal.nx + cy * normal.ny + cz * normal.nz;
    if (Math.abs(dot) < 1e-9) continue; // ほぼ直線（縮退辺）はスキップ
    const s = dot > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// 仕切りsolidの中央平面を抽出（axis型・poly型を区別しない一般平面方式）
//   1. 最大面積の面 = 板の広い面。その単位法線 n が平面法線
//   2. 逆向き法線(dot<-0.99)かつ面積が近い(比0.5〜2倍)の面のうち最大面積のもの = 反対側の広い面
//   3. 両広面の重心間距離が「板厚として妥当」(0.01mm〜500mm)かどうかも確認
//   4. 条件を満たす反対面が見つからなければ null を返す（呼び出し側はこのsolidを分割対象から除外し、
//      従来通り分割なしで描画する安全なフォールバックとすること）
// 戻り値: { nx, ny, nz, d }（平面方程式 n・p = d）または null
function _pdcSolidMidPlane(solid) {
  let best = null, bestA = 0;
  for (const f of (solid.faces || [])) {
    if (!f.vertices || f.vertices.length < 3 || !f.normal) continue;
    const a = _pdcFaceArea3D(f.vertices);
    if (a > bestA) { bestA = a; best = f; }
  }
  if (!best || bestA < PDC_SPLIT_EPS_AREA) return null;
  const n = best.normal;
  let opp = null, oppA = 0;
  for (const f of (solid.faces || [])) {
    if (f === best || !f.vertices || f.vertices.length < 3 || !f.normal) continue;
    const dot = f.normal.nx * n.nx + f.normal.ny * n.ny + f.normal.nz * n.nz;
    if (dot < -0.99) {
      const a = _pdcFaceArea3D(f.vertices);
      // 面積が近い（広面同士の妥当性チェック。比が0.5〜2倍の範囲）
      if (a > oppA && a > bestA * 0.5 && a < bestA * 2) { oppA = a; opp = f; }
    }
  }
  if (!opp) return null; // 反対面が見つからない → 呼び出し側でフォールバック
  const c1 = _pdcFaceCentroid3D(best.vertices);
  const c2 = _pdcFaceCentroid3D(opp.vertices);
  const distC = Math.hypot(c1.x - c2.x, c1.y - c2.y, c1.z - c2.z);
  if (distC < 0.01 || distC > 500) return null; // 板厚として妥当な範囲外 → フォールバック
  const c0 = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2, z: (c1.z + c2.z) / 2 };
  return { nx: n.nx, ny: n.ny, nz: n.nz, d: n.nx * c0.x + n.ny * c0.y + n.nz * c0.z };
}

// solidのAABB（軸平行境界箱）。交差し得ない仕切りペアの無駄な分割を省く
function _pdcSolidAABB(solid) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity,
      x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const f of (solid.faces || [])) for (const v of (f.vertices || [])) {
    if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
    if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
    if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
  }
  return { x0, y0, z0, x1, y1, z1 };
}
function _pdcAABBOverlap(a, b, m) {
  return a.x0 <= b.x1 + m && b.x0 <= a.x1 + m &&
         a.y0 <= b.y1 + m && b.y0 <= a.y1 + m &&
         a.z0 <= b.z1 + m && b.z0 <= a.z1 + m;
}

// 分割後多角形のクリーンアップ: 連続重複頂点の融合 → 頂点数/面積チェック
function _pdcWeldPoly(verts) {
  const close = (a, b) =>
    Math.abs(a.x - b.x) < PDC_SPLIT_EPS_WELD &&
    Math.abs(a.y - b.y) < PDC_SPLIT_EPS_WELD &&
    Math.abs(a.z - b.z) < PDC_SPLIT_EPS_WELD;
  const out = [];
  for (const v of verts) {
    if (out.length > 0 && close(out[out.length - 1], v)) continue;
    out.push(v);
  }
  while (out.length >= 2 && close(out[0], out[out.length - 1])) out.pop();
  if (out.length < 3) return null;
  if (_pdcFaceArea3D(out) < PDC_SPLIT_EPS_AREA) return null;
  return out;
}

// 3D多角形を平面で表側(front)/裏側(back)に分割（Sutherland-Hodgman両側版）
// ・全頂点が片側（|dist|<=EPSは平面上扱い）なら null（分割不要）
// ・平面上の頂点は両側に登録（断片の欠けを防ぐ標準手法）
// ・交点補間は符号が異なる辺のみ実行 → |da-db| > 2*EPS が保証され0除算/NaNなし
function _pdcSplitPolyByPlane(verts, plane) {
  const n = verts.length;
  const dist = new Array(n);
  let hasF = false, hasB = false;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const d = v.x * plane.nx + v.y * plane.ny + v.z * plane.nz - plane.d;
    dist[i] = d;
    if (d > PDC_SPLIT_EPS_DIST) hasF = true;
    else if (d < -PDC_SPLIT_EPS_DIST) hasB = true;
  }
  if (!hasF || !hasB) return null;
  const front = [], back = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = verts[i], da = dist[i], db = dist[j];
    const sa = da > PDC_SPLIT_EPS_DIST ? 1 : (da < -PDC_SPLIT_EPS_DIST ? -1 : 0);
    const sb = db > PDC_SPLIT_EPS_DIST ? 1 : (db < -PDC_SPLIT_EPS_DIST ? -1 : 0);
    if (sa >= 0) front.push(a);
    if (sa <= 0) back.push(a);
    if (sa * sb < 0) {
      const b = verts[j];
      const t = da / (da - db);
      const p = { x: a.x + (b.x - a.x) * t,
                  y: a.y + (b.y - a.y) * t,
                  z: a.z + (b.z - a.z) * t };
      front.push(p); back.push(p);
    }
  }
  return { front: _pdcWeldPoly(front), back: _pdcWeldPoly(back) };
}

// ── 仕切り面の事前分割（視点非依存・キャッシュ推奨）──
// solids: panelToSolids(panel) の結果
// 戻り値: [{ color, normal, vertices, originSolid }] — pdcCollectPartitionFaces の第3引数に渡す
// ・各面は「他の仕切りの中央平面」でのみ分割する。自分のsolidの平面では絶対に
//   分割しない（solidオブジェクト同一性で除外。板の表裏2枚の面は自分の中央平面から
//   ±板厚/2 離れているが、平面値でなくsolid単位で除外するので板厚に関わらず安全）
// ・中央平面が求まらないsolid（凹形状・異常形状等）は分割対象から除外し、
//   そのsolidの面はそのまま（未分割）出力する安全なフォールバック
// ・凸多角形でない面（凹poly仕切り等）も分割せずそのまま出力する安全なフォールバック
// ・AABBが交差しない仕切りペアは分割しない（断片数の抑制。T字接触はEPSマージンで含む）
// ・同一平面上の仕切り同士は全頂点が平面上扱い → 分割されない（ゼロ面積断片なし）
// ・断片数が上限に達したら、それ以上の分割を打ち切り元の断片を残す（暴走防止）
function pdcBuildPartitionSplit(solids) {
  const parts = [];
  (solids || []).forEach(solid => {
    if (solid._isOuter) return;
    parts.push({ solid, plane: _pdcSolidMidPlane(solid), aabb: _pdcSolidAABB(solid) });
  });
  const out = [];
  let totalFrags = 0;
  for (const ps of parts) {
    for (const f of (ps.solid.faces || [])) {
      if (!f.vertices || f.vertices.length < 3) continue;
      // 凹多角形は分割せずそのまま出力（Sutherland-Hodgmanは凸多角形前提のため）
      const isConvex = _pdcIsConvexPoly(f.vertices, f.normal);
      let frags = [f.vertices];
      if (isConvex) {
        for (const other of parts) {
          if (other === ps || !other.plane) continue;
          if (!_pdcAABBOverlap(ps.aabb, other.aabb, PDC_SPLIT_EPS_DIST)) continue;
          if (frags.length >= PDC_SPLIT_MAX_FRAGS_PER_FACE || totalFrags >= PDC_SPLIT_MAX_FRAGS_TOTAL) break;
          const next = [];
          for (const fr of frags) {
            const sp = _pdcSplitPolyByPlane(fr, other.plane);
            if (!sp) { next.push(fr); continue; }
            if (sp.front) next.push(sp.front);
            if (sp.back) next.push(sp.back);
            if (!sp.front && !sp.back) next.push(fr); // 両側縮退時は元断片を残す（消失防止）
          }
          frags = next;
        }
      }
      totalFrags += frags.length;
      for (const fr of frags) {
        out.push({ color: ps.solid.color, normal: f.normal, vertices: fr, originSolid: ps.solid });
      }
    }
  }
  return out;
}

// ── 仕切り（非outer solid）の可視面を収集（遠→近ソート済み・3次元図Painter's用）──
// solids: panelToSolids(panel) の結果。axis型は薄板直方体、poly型（斜め仕切り）も面を持つ
// split : pdcBuildPartitionSplit(solids) の結果（省略可）。渡すと交差平面での事前分割済み
//         断片を使い、貫通交差した仕切りのPainter'sチラつきを解消する。
//         省略時は従来どおり solids の面をそのまま使う（完全後方互換）。
//         例: pdcCollectPartitionFaces(solids, view, pdcBuildPartitionSplit(solids))
// 戻り値: [{ solid, f, pts, depth, rgb:[r,g,b] }]
function pdcCollectPartitionFaces(solids, view, split) {
  const faces = [];
  if (split) {
    for (const sf of split) {
      if (!sf.vertices || sf.vertices.length < 3) continue;
      if (view.isBackFacing(sf.normal)) continue;
      const pts = sf.vertices.map(v => view.proj(v.x, v.y, v.z));
      const depth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
      faces.push({ solid: sf.originSolid, f: sf, pts, depth,
                   rgb: pdcPartitionFaceRGB(sf.color, sf.normal, false) });
    }
  } else {
    solids.forEach(solid => {
      if (solid._isOuter) return;
      (solid.faces || []).forEach(f => {
        if (!f.vertices || f.vertices.length < 3) return;
        if (view.isBackFacing(f.normal)) return;
        const pts = f.vertices.map(v => view.proj(v.x, v.y, v.z));
        const depth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
        faces.push({ solid, f, pts, depth, rgb: pdcPartitionFaceRGB(solid.color, f.normal, false) });
      });
    });
  }
  const ns = view.nearSign || 1;
  faces.sort((a, b) => (a.depth - b.depth) * ns); // 遠い面から描く
  return faces;
}

// ── 仕切り面の描画（Painter's・3次元図用。エディタはZバッファに同色でラスタライズ）──
// エディタのラスタライズは輪郭線なし（fillのみ）なのでstrokeは描かない
function pdcPaintPartitionFaces(ctx, faces, alpha) {
  ctx.globalAlpha = alpha;
  for (const { pts, rgb } of faces) {
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── 仕切り面エッジ（区画境界の視認性を作る薄い黒線）──
// 抽出元: エディタ Step 2b（PanelCanvas3D.jsx）。
// 【重要】エディタはこのエッジを「内部要素のオフスクリーン合成の“後”に、メインctxへ直描き」する。
// つまり内部合成アルファ（pdcInteriorAlpha）は掛からず、edgeAlpha がそのまま効く。
// 3次元図も同様にレイヤー合成の後でメインctxに描くこと（レイヤー内に入れると二重に薄くなる）。
const PDC_PARTITION_EDGE = { color: 'rgba(0,0,0,0.12)', lineWidth: 0.5 };

// エッジの不透明度: 透明度>0 → 内部合成アルファの半分 / 透明度0 → 100%
function pdcPartitionEdgeAlpha(transparency, solidAlpha) {
  return transparency > 0 ? (1 - solidAlpha) * 0.5 : 1;
}

// 可視面の輪郭ループ収集（stroke用とマスク用線分化で共有する唯一の収集ロジック）
function _pdcPartitionEdgeLoops(solids, view) {
  const loops = [];
  (solids || []).forEach(solid => {
    if (solid._isOuter) return;
    (solid.faces || []).forEach(f => {
      if (!f.vertices || f.vertices.length < 3) return;
      if (view.isBackFacing(f.normal)) return;
      loops.push(f.vertices.map(v => view.proj(v.x, v.y, v.z)));
    });
  });
  return loops;
}

// 輪郭ループ群を stroke（閉路ストローク。従来の pdcPaintPartitionEdges 描画部と同一）
function pdcStrokePartitionEdgeLoops(ctx, loops, view, edgeAlpha) {
  const _prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = edgeAlpha;
  ctx.strokeStyle = PDC_PARTITION_EDGE.color;
  ctx.lineWidth = PDC_PARTITION_EDGE.lineWidth * (view.lwUnit || 1);
  for (const pts of (loops || [])) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.stroke();
  }
  ctx.globalAlpha = _prevAlpha;
}

// 非outer solid の可視面を縁取る。ゲート条件・開口部クリップは呼び出し側の責任。
// （収集＋strokeの合成。呼び出しシグネチャ・描画結果は従来と完全互換）
function pdcPaintPartitionEdges(ctx, solids, view, edgeAlpha) {
  pdcStrokePartitionEdgeLoops(ctx, _pdcPartitionEdgeLoops(solids, view), view, edgeAlpha);
}

// エッジ線分の収集（深度マスク構築用。ループを辺単位の線分に分解して返す）
// 戻り値: [{x0,y0,d0, x1,y1,d1}, ...]
function pdcCollectPartitionEdgeSegments(solids, view) {
  const segs = [];
  for (const pts of _pdcPartitionEdgeLoops(solids, view)) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      segs.push({ x0: a.x, y0: a.y, d0: a.depth, x1: b.x, y1: b.y, d1: b.depth });
    }
  }
  return segs;
}

// ── 開扉の開口部（外壁上の矩形）を投影 ──
// 面の外向き法線がカメラ方向を向いている（前面）開扉のみ対象（エディタと同仕様）
// 戻り値: [{ door, corners:[[x,y,z]×4], pts:[{x,y,depth}×4] }]
function pdcDoorOpenings2D(panel, view) {
  return (panel.doors || [])
    .filter(d => d.isOpen)
    .filter(d => { const n = PDC_DOOR_MOUNT_NORMALS[d.face]; return n && !view.isBackFacing(n); })
    .map(d => {
      const { face, uMm: u, vMm: v, widthMm: dw, heightMm: dh } = d;
      const corners = [
        pdcFaceUV(face, u,      v,      panel),
        pdcFaceUV(face, u + dw, v,      panel),
        pdcFaceUV(face, u + dw, v + dh, panel),
        pdcFaceUV(face, u,      v + dh, panel),
      ];
      return { door: d, corners, pts: corners.map(([x, y, z]) => view.proj(x, y, z)) };
    });
}

// ================================================================
// Phase 3: アイコン（PanelCanvas3D.jsx から逐語抽出）
// ================================================================

// ── アイコンBoxのデフォルト色（インディゴブルー #1D4ED8）──
// 抽出元: _drawIconBox L104 / Zバッファ枝 L1499 / flatアイコン fill '#1D4ED8' L3263
const PDC_ICON_DEFAULT_RGB = [29, 78, 216];

// ── アイコンBoxの基準色（iconColor 未指定ならデフォルト）──
function pdcIconBaseRGB(iconColor) {
  return iconColor ? _hexToRGB(iconColor) : PDC_ICON_DEFAULT_RGB.slice();
}

// ── アイコンBox半幅（抽出元: _iconBoxHalfExtents L12-26）──
// 全6面から等距離のgap: min(W,D,H)*7.5%（最低5mm）を全方向に適用
function pdcIconHalfExtents(cellBox, face) {
  const MINH = 5;
  if (cellBox) {
    const W = cellBox.xMax - cellBox.xMin;
    const D = cellBox.yMax - cellBox.yMin;
    const H = cellBox.zMax - cellBox.zMin;
    const gap = Math.max(MINH, Math.min(W, D, H) * 0.075);
    return {
      hx: Math.max(MINH, W / 2 - gap),
      hy: Math.max(MINH, D / 2 - gap),
      hz: Math.max(MINH, H / 2 - gap),
    };
  }
  return { hx: 20, hy: 20, hz: 20 };
}

// ── アイコンBox 8頂点（抽出元: _drawIconBox L82-87）──
// 0=(x-,y-,z-) 1=(x+,y-,z-) 2=(x+,y+,z-) 3=(x-,y+,z-)
// 4=(x-,y-,z+) 5=(x+,y-,z+) 6=(x+,y+,z+) 7=(x-,y+,z+)
function pdcIconBoxCorners(proj, cx, cy, cz, hx, hy, hz) {
  return [
    proj(cx-hx, cy-hy, cz-hz), proj(cx+hx, cy-hy, cz-hz),
    proj(cx+hx, cy+hy, cz-hz), proj(cx-hx, cy+hy, cz-hz),
    proj(cx-hx, cy-hy, cz+hz), proj(cx+hx, cy-hy, cz+hz),
    proj(cx+hx, cy+hy, cz+hz), proj(cx-hx, cy+hy, cz+hz),
  ];
}

// ── アイコンBox 6面の頂点インデックスと法線（抽出元: _drawIconBox L88-95）──
const PDC_ICON_BOX_FACES = [
  { pts:[0,1,5,4], n:{nx:0,ny:-1,nz:0} },  // 前面 (y-)
  { pts:[2,3,7,6], n:{nx:0,ny:1,nz:0}  },  // 背面 (y+)
  { pts:[0,3,7,4], n:{nx:-1,ny:0,nz:0} },  // 左面 (x-)
  { pts:[1,2,6,5], n:{nx:1,ny:0,nz:0}  },  // 右面 (x+)
  { pts:[4,7,6,5], n:{nx:0,ny:0,nz:1}  },  // 上面 (z+)
  { pts:[0,1,2,3], n:{nx:0,ny:0,nz:-1} },  // 下面 (z-)
];

// ── アイコンBox 1面の塗り色RGB（抽出元: _drawIconBox L109-111 / Zバッファ枝 L1505-1507）──
// 輝度補正（×1.3や下限0.6）は掛けない。エディタは素の panelFaceBrightness を使う。
function pdcIconFaceRGB(baseRGB, normal) {
  const br = panelFaceBrightness(normal);
  return [
    Math.min(255, Math.round(baseRGB[0] * br)),
    Math.min(255, Math.round(baseRGB[1] * br)),
    Math.min(255, Math.round(baseRGB[2] * br)),
  ];
}

// ── アイコンBoxの可視面を収集（抽出元: _drawIconBox L96-103）──
// backface culling → depth 遠→近ソート（view.nearSign 準拠）
// zbCheck: エディタ専用の遮蔽判定（省略可）。コアは形状・色だけ扱う。
// 戻り値: [{ n, idx, pts, depth, bright, rgb }]
function pdcCollectIconBoxFaces(view, cx, cy, cz, cellBox, face, baseRGB, zbCheck) {
  const { hx, hy, hz } = pdcIconHalfExtents(cellBox, face);
  const c8 = pdcIconBoxCorners(view.proj, cx, cy, cz, hx, hy, hz);
  const base = baseRGB || PDC_ICON_DEFAULT_RGB;
  const ns = view.nearSign || 1;
  const out = [];
  for (const f of PDC_ICON_BOX_FACES) {
    if (view.isBackFacing(f.n)) continue;
    const pts = f.pts.map(i => c8[i]);
    if (zbCheck && pts.every(p => zbCheck(p))) continue;
    out.push({
      n: f.n, idx: f.pts, pts,
      depth: pts.reduce((s, p) => s + p.depth, 0) / pts.length,
      bright: panelFaceBrightness(f.n),
      rgb: pdcIconFaceRGB(base, f.n),
    });
  }
  out.sort((a, b) => (a.depth - b.depth) * ns); // 遠い面から描く
  return out;
}

// ── アイコンBoxの枠線スタイル（抽出元: _drawIconBox L112-113 の非選択枝）──
// 【重要】これは「Canvas 2D で直接Boxを描く場面」専用の枠線であり、静的表示の正ではない。
// エディタの静的表示（Zバッファ + _rasterTri）は塗りのみで枠線を描かない。
// 枠線が出るのはエディタの直描き経路（カメラドラッグ中 / ドラッグゴースト）だけなので、
// pdcPaintIconBoxFace は strokeStyle が明示指定されたときだけ stroke する。
const PDC_ICON_BOX_STROKE = { color: 'rgba(255,255,255,0.5)', lineWidth: 0.8 };

// ── アイコンBox 1面の描画 ──
// opts: { alpha, strokeStyle, lineWidth }
//   alpha       省略時は globalAlpha を触らない
//               （エディタは呼び出し元で 0.75/0.85 のゴーストアルファを掛けるため）
//   strokeStyle 省略時は枠線を描かない（＝エディタ静的表示・3次元図と同じ「塗りのみ」）
//               直描き経路で白枠が要るときは PDC_ICON_BOX_STROKE.color を明示指定すること
function pdcPaintIconBoxFace(ctx, f, view, opts) {
  const o = opts || {};
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  ctx.setLineDash([]);
  ctx.fillStyle = `rgb(${f.rgb[0]},${f.rgb[1]},${f.rgb[2]})`;
  ctx.beginPath(); ctx.moveTo(f.pts[0].x, f.pts[0].y);
  for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i].x, f.pts[i].y);
  ctx.closePath(); ctx.fill();
  if (!o.strokeStyle) return; // 枠線なしが既定（静的表示の正）
  ctx.strokeStyle = o.strokeStyle;
  ctx.lineWidth = (o.lineWidth != null ? o.lineWidth : PDC_ICON_BOX_STROKE.lineWidth) * (view.lwUnit || 1);
  ctx.stroke();
}

// ── アイコンBoxの可視面をまとめて描画 ──
function pdcPaintIconBoxFaces(ctx, faces, view, opts) {
  for (const f of faces) pdcPaintIconBoxFace(ctx, f, view, opts);
}

// ── flatアイコン（抽出元: L3141 half / L3174-3178 corners / L3263-3265 style）──
// エディタは flat の塗り色に iconColor を使わずデフォルト色固定。現挙動を正として据え置く。
const PDC_ICON_FLAT_STYLE = { fill: '#1D4ED8', stroke: '#FFFFFF', lineWidth: 1.5 };

function pdcIconFlatHalf(panel) {
  return Math.min(panel.widthMm, panel.heightMm, panel.depthMm) / 16;
}

// flatアイコンは前面(y-)向きの正方形。cx,cy,cz が中心
function pdcIconFlatCorners(view, cx, cy, cz, panel) {
  const h = pdcIconFlatHalf(panel);
  return [
    view.proj(cx - h, cy, cz - h),
    view.proj(cx + h, cy, cz - h),
    view.proj(cx + h, cy, cz + h),
    view.proj(cx - h, cy, cz + h),
  ];
}

// opts: { alpha, fillStyle, strokeStyle, lineWidth }
function pdcPaintIconFlat(ctx, pts, view, opts) {
  const o = opts || {};
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  ctx.setLineDash([]);
  ctx.fillStyle = o.fillStyle || PDC_ICON_FLAT_STYLE.fill;
  ctx.strokeStyle = o.strokeStyle || PDC_ICON_FLAT_STYLE.stroke;
  ctx.lineWidth = (o.lineWidth != null ? o.lineWidth : PDC_ICON_FLAT_STYLE.lineWidth) * (view.lwUnit || 1);
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// ── アイコンラベル（抽出元: L75-77 _drawIconBox / L3137-3139 Zバッファ枝）──
// エディタ: 白・bold 8px・不透明・name未設定は '?'・6文字で切る
// （3次元図は旧実装で 9〜14px可変・alpha 0.9・name未設定は非表示だった。
//   lwUnit でCSS px基準に揃えることで両者の見た目が一致する）
const PDC_ICON_LABEL = {
  fill: '#FFFFFF', selFill: '#FBBF24', fontPx: 8, weight: 'bold', maxChars: 6,
};

// ── ラベルのズーム追従（2026-08-02 追加／2026-08-02 しきい値見直し）──
// 旧実装は常に 8px 固定で、盤を小さく表示してもラベルだけが原寸のまま残り
// 「盤よりラベルが大きい」状態になっていた（3次元図で顕著）。
// ラベルは「盤の中で PDC_ICON_LABEL_SCALE_START_MM mm 相当」の実寸を持つものとして扱い、
// 実寸換算値が 8px を下回るときだけ縮小する（拡大側は 8px で頭打ち）。
// この値は「実際のラベル高さ」ではなく「盤全体を見渡す通常ズームで 8px を維持するための
// 縮小開始しきい値」。40mm は大型盤（幅4000mm超）で通常ズームでも縮小域に入ってしまい
// 判読不能になったため、120mm に引き上げた。
const PDC_ICON_LABEL_SCALE_START_MM = 120;
const PDC_ICON_LABEL_MIN_PX  = 4;   // これ未満は潰れて読めないので描かない（描画停止しきい値）

// view.pxPerMm = 1mm あたりの画面ピクセル数（CSS px 基準）。
//   エディタ: zoom（project3DPanel は mm × zoom で投影するため zoom 自体が px/mm）
//   3次元図 : _scaleR / devicePixelRatio（_scaleR は実px/mm なので CSS px 基準に戻す）
// 未指定なら従来どおり固定 8px（後方互換・パリティ試験も従来値のまま）。
function pdcIconLabelFontPx(view) {
  const ppm = view && view.pxPerMm;
  if (ppm == null || !isFinite(ppm)) return PDC_ICON_LABEL.fontPx;
  return Math.min(PDC_ICON_LABEL.fontPx, PDC_ICON_LABEL_SCALE_START_MM * ppm);
}

function pdcIconLabelText(icon) {
  return ((icon && icon.name) || '?').slice(0, PDC_ICON_LABEL.maxChars);
}

// pt: view.proj で得たアイコン中心の2D点。opts: { alpha, isSel }
function pdcPaintIconLabel(ctx, pt, text, view, opts) {
  if (!text) return;
  const fontEff = pdcIconLabelFontPx(view);
  if (fontEff < PDC_ICON_LABEL_MIN_PX) return; // 潰れ文字は描かない
  const o = opts || {};
  const _prevAlpha = ctx.globalAlpha; // 呼び出し元のalphaを壊さない
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  ctx.fillStyle = o.isSel ? PDC_ICON_LABEL.selFill : PDC_ICON_LABEL.fill;
  ctx.font = `${PDC_ICON_LABEL.weight} ${fontEff * (view.lwUnit || 1)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, pt.x, pt.y);
  ctx.globalAlpha = _prevAlpha;
}

// ================================================================
// Phase 4: 配線（PanelCanvas3D.jsx から逐語抽出）
// ================================================================

// 抽出元: _strokeCable 呼び出し群（L1744-1747 / L2320-2350 / L2403-2421 / L2482-2496）
const PDC_CABLE_DEFAULT_COLOR      = '#60A5FA'; // 外枠（ケーブル本体色）
const PDC_CABLE_DEFAULT_LINE_COLOR = '#000000'; // 中心線
const PDC_CABLE_DEFAULT_THICKNESS  = 3;         // 中心線の太さ
const PDC_CABLE_DEFAULT_OUTLINE    = 4;         // 外枠の追加太さ
// ── 配線のアルファは「オフスクリーンへのストローク」×「レイヤー合成」の2段 ──
// エディタ実装を調査した結果、モードごとに合成側の値が違う（2026-08-02 確定）:
//   通常モード（非X線・内部表示あり）: stroke 0.9 → 合成 1.0    ⇒ 実効 0.9
//     ※ 内部合成アルファ（pdcInteriorAlpha）は配線には掛からない。配線は別レイヤー。
//   X線モード（iconVisMode=semi/full）: stroke 0.9 → 合成 0.45  ⇒ 実効 0.405
// 3次元図も同じ2段構成にすること（要素ごとに実効値を直接与えると重なりでアルファが累積する）。
const PDC_CABLE_STROKE_ALPHA    = 0.9;
const PDC_CABLE_COMPOSITE_ALPHA = 0.45; // X線モードの合成側のみ
const PDC_CABLE_NORMAL_COMPOSITE_ALPHA = 1.0; // 通常モードの合成側

// ── 配線1本の色・太さ決定（唯一の正）──
// 戻り値: { color, lineColor, thickness, outlineThickness, outerWidth, innerWidth }
function pdcCableStyle(cable) {
  const c = cable || {};
  const thickness = c.thickness || PDC_CABLE_DEFAULT_THICKNESS;
  const outlineThickness = c.outlineThickness ?? PDC_CABLE_DEFAULT_OUTLINE;
  return {
    color: c.color || PDC_CABLE_DEFAULT_COLOR,
    lineColor: c.lineColor || PDC_CABLE_DEFAULT_LINE_COLOR,
    thickness, outlineThickness,
    outerWidth: thickness + outlineThickness,
    innerWidth: thickness,
  };
}

// ── 配線太さのズーム追従（2026-08-02 追加）──
// アイコンラベル（pdcIconLabelFontPx）と同じ「縮小開始しきい値」方式。
// 配線は「盤の中で PDC_CABLE_WIDTH_SCALE_START_MM mm 相当」の太さを持つものとして扱い、
// 実寸換算 px が既定の太さ（outerWidth基準）を下回るときだけ縮小する（拡大側は1倍で頭打ち）。
// ラベルと同じ基準値(120mm)を使うことで、同じズームレベルで両者が同時に縮み始め、
// 3次元図で盤を縮小しても配線だけ太いまま残る問題を解消する。
const PDC_CABLE_WIDTH_SCALE_START_MM = PDC_ICON_LABEL_SCALE_START_MM;

function pdcCableWidthFactor(view) {
  const ppm = view && view.pxPerMm;
  if (ppm == null || !isFinite(ppm)) return 1;
  const _baseW = PDC_CABLE_DEFAULT_THICKNESS + PDC_CABLE_DEFAULT_OUTLINE; // 既定の太さ(7px)を基準にする
  return Math.min(1, (PDC_CABLE_WIDTH_SCALE_START_MM * ppm) / _baseW);
}

// ── 折れ線1本を「部品1個だけのチェーン」に包む（チェーンAPIへの橋渡し）──
function _pdcSoloChains(pts2d) { return [[{ pts2d, pts3d: null }]]; }

// ── 折れ線のパス生成（lineJoin/lineCap は呼び出し側で設定済み前提）──
// 実体は pdcStrokeChainsPath（チェーン版）。パス生成ロジックの正はそちら1か所。
function pdcStrokePolyline(ctx, pts2d) {
  if (!pts2d || pts2d.length < 2) return;
  pdcStrokeChainsPath(ctx, _pdcSoloChains(pts2d));
}

// ── 配線1本の二重ストローク描画（外枠→中心線）──
// 実体は pdcPaintCableChains（チェーン版）。2パス描画の正はそちら1か所。
// エディタのオフスクリーン隠面処理（_collectRuns/_strokeRuns）はここには持ち込まない。
// エディタは自前の隠面パスで pdcCableStyle の色・太さ値だけを使う。
// opts: { widthScale=1（線幅係数。3次元図は lwUnit や _scaleR）, alpha, outerAlpha, innerAlpha }
function pdcPaintCablePolyline(ctx, pts2d, style, opts) {
  if (!pts2d || pts2d.length < 2) return;
  pdcPaintCableChains(ctx, _pdcSoloChains(pts2d), style, opts);
}

// ================================================================
// Phase 4b: 配線チェーン化（PanelCanvas3D.jsx から逐語抽出）
//   複数の cable オブジェクトが1本の配線を成している場合に、
//   「経路構築 → Wireセット自動グループ化 → 端点連結チェーン化 → 単一パス描画」
//   の4段階で継ぎ目のない1本の線として描く。
//   ここが唯一の正。エディタ・3次元図の双方が同じ関数を呼ぶこと。
// ================================================================

// 接続判定のしきい値: 3D距離 5mm 以内（5^2 = 25 mm^2）
// 抽出元: エディタ L1263 `_EPS2` / L1648 `_E2`（同値なので1定数に統一）
const PDC_CABLE_JOIN_EPS2 = 25;

// ── 点P から線分(A→B) への最短距離の2乗（抽出元: エディタ L1266-1273 `_ptSegDist2`）──
function _pdcPtSegDist2(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx*dx + dy*dy + dz*dz;
  if (len2 < 1e-10) { const ex = px-ax, ey = py-ay, ez = pz-az; return ex*ex + ey*ey + ez*ez; }
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy + (pz-az)*dz) / len2));
  const fx = ax + t*dx - px, fy = ay + t*dy - py, fz = az + t*dz - pz;
  return fx*fx + fy*fy + fz*fz;
}

// ── points の各点が segs のいずれかのセグメントに EPS 以内か（抽出元: エディタ L1275-1282）──
function _pdcPointHitsSegments(points, segs) {
  for (let p = 0; p < points.length; p++)
    for (let s = 0; s < segs.length - 1; s++)
      if (_pdcPtSegDist2(points[p].wx, points[p].wy, points[p].wz,
                         segs[s].wx, segs[s].wy, segs[s].wz,
                         segs[s+1].wx, segs[s+1].wy, segs[s+1].wz) < PDC_CABLE_JOIN_EPS2) return true;
  return false;
}

// ── 端点同士の3D距離の2乗（抽出元: エディタ L1649 `_endDist2`）──
function _pdcEndDist2(a, b) { const dx=a.wx-b.wx, dy=a.wy-b.wy, dz=a.wz-b.wz; return dx*dx+dy*dy+dz*dz; }

// ── チェーン部品の向き反転（抽出元: エディタ L1650 `_revPart`）──
function _pdcRevPart(p) { return { pts2d: [...p.pts2d].reverse(), pts3d: [...p.pts3d].reverse() }; }

// ── ケーブル1本の3D経路を構築（from → waypoints → to）──
// 抽出元: エディタ L1232-1253（`_cRouteMap` 構築ループの中身）
// waypoint が {wx,wy,wz} でない場合は chamberId 参照とみなし chambers から区画中心を解決する。
// chambers が未指定（3次元図で panelChambers.js 未ロード等）なら chamberId waypoint は無視する。
// 戻り値: [{wx,wy,wz}, ...]（2点未満なら null）
function pdcCableRoute3D(panel, cable, chambers) {
  if (!cable) return null;
  const icons = (panel && panel.placedIcons) || [];
  const pts3 = [];
  const _fi = icons.find(ic => ic.id === cable.fromIconId);
  const _fwx = cable.fromWx ?? _fi?.wx;
  if (_fwx != null) pts3.push({ wx: _fwx, wy: cable.fromWy ?? _fi?.wy ?? 0, wz: cable.fromWz ?? _fi?.wz ?? 0 });
  for (const _wp of (cable.waypoints || [])) {
    if (_wp && _wp.wx != null) pts3.push({ wx: _wp.wx, wy: _wp.wy, wz: _wp.wz });
    else {
      const _chId = typeof _wp === 'string' ? _wp : _wp?.chamberId;
      const _ch = (chambers || []).find(c => c.id === _chId);
      if (_ch && _ch.cells && _ch.cells.length) {
        const _xs = _ch.cells.flatMap(c => [c.xMin, c.xMax]);
        const _ys = _ch.cells.flatMap(c => [c.yMin, c.yMax]);
        const _zs = _ch.cells.flatMap(c => [c.zMin, c.zMax]);
        pts3.push({
          wx: (Math.min(..._xs) + Math.max(..._xs)) / 2,
          wy: (Math.min(..._ys) + Math.max(..._ys)) / 2,
          wz: (Math.min(..._zs) + Math.max(..._zs)) / 2,
        });
      }
    }
  }
  const _ti = icons.find(ic => ic.id === cable.toIconId);
  const _twx = cable.toWx ?? _ti?.wx;
  if (_twx != null) pts3.push({ wx: _twx, wy: cable.toWy ?? _ti?.wy ?? 0, wz: cable.toWz ?? _ti?.wz ?? 0 });
  return pts3.length >= 2 ? pts3 : null;
}

// ── 盤内全ケーブルの経路をまとめて構築 ──
// view（`{proj}` またはproj関数そのもの）を渡すと pts2d も同時に投影する。
// エディタは半解像度 projR、3次元図は proj を渡す（投影規約の差は view が吸収）。
// cableList: 省略時は panel.cables。エディタは panel とは別の cables プロップを持つため明示指定する。
// 戻り値: [{ cable, pts3d, pts2d }]（pts2d は view 未指定なら null）
function pdcBuildCableRoutes(panel, chambers, view, cableList) {
  const projFn = typeof view === 'function' ? view : (view && view.proj) || null;
  const out = [];
  for (const cable of (cableList || (panel && panel.cables) || [])) {
    const pts3d = pdcCableRoute3D(panel, cable, chambers);
    if (!pts3d) continue;
    out.push({ cable, pts3d, pts2d: projFn ? pts3d.map(p => projFn(p.wx, p.wy, p.wz)) : null });
  }
  return out;
}

// ── Wireセット自動グループ化（Union-Find による連結成分）──
// 抽出元: エディタ L1259-1302（`_wsAutoGroups` 構築ブロック）
// 各ケーブルの全通過点（始点+waypoints+終点）が他ケーブルの線分に 5mm 以内なら同一Wireセット。
// 3D座標のみを見るので投影・カメラに依存しない（view非依存）。
// 戻り値: Map<rootCableId, routes[]>
function pdcGroupCablesByWireSet(routes) {
  const groups = new Map();
  const entries = (routes || []).filter(e => e && e.pts3d && e.pts3d.length >= 2);
  if (entries.length === 0) return groups;
  const ufP = {};
  entries.forEach(e => { ufP[e.cable.id] = e.cable.id; });
  const ufFind = id => { while (ufP[id] !== id) { ufP[id] = ufP[ufP[id]]; id = ufP[id]; } return id; };
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const pA = entries[i].pts3d, pB = entries[j].pts3d;
      if (_pdcPointHitsSegments(pA, pB) || _pdcPointHitsSegments(pB, pA))
        ufP[ufFind(entries[i].cable.id)] = ufFind(entries[j].cable.id);
    }
  }
  for (const e of entries) {
    const root = ufFind(e.cable.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }
  return groups;
}

// ── グループ内のケーブルを端点連結して「チェーン」にする ──
// 抽出元: エディタ L1651-1672 `_buildChains`
// 端点が 5mm 以内なら順序調整・向き反転しながら1本の連続経路に繋ぐ。
// 戻り値: chains[] （chain = [{pts2d, pts3d}, ...] の連続部品列）
function pdcBuildCableChains(members) {
  const unused = (members || [])
    .filter(m => m && m.pts2d && m.pts2d.length >= 2 && m.pts3d && m.pts3d.length >= 2)
    .map(m => ({ pts2d: m.pts2d, pts3d: m.pts3d }));
  const chains = [];
  while (unused.length > 0) {
    const chain = [unused.shift()]; let changed = true;
    while (changed) {
      changed = false;
      const cs = chain[0].pts3d[0], ce = chain[chain.length - 1].pts3d[chain[chain.length - 1].pts3d.length - 1];
      for (let i = 0; i < unused.length; i++) {
        const p = unused[i], ps = p.pts3d[0], pe = p.pts3d[p.pts3d.length - 1];
        if      (_pdcEndDist2(ce, ps) < PDC_CABLE_JOIN_EPS2) chain.push(p);
        else if (_pdcEndDist2(ce, pe) < PDC_CABLE_JOIN_EPS2) chain.push(_pdcRevPart(p));
        else if (_pdcEndDist2(pe, cs) < PDC_CABLE_JOIN_EPS2) chain.unshift(p);
        else if (_pdcEndDist2(ps, cs) < PDC_CABLE_JOIN_EPS2) chain.unshift(_pdcRevPart(p));
        else continue;
        unused.splice(i, 1); changed = true; break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

// ── チェーン群を「1回の beginPath → 全チェーンぶんの moveTo/lineTo → 1回の stroke」で描く ──
// 抽出元: エディタ L1673-1681 `_strokeChains`
// 継ぎ目で lineJoin が効き、外枠が折れ点で途切れない（＝今回の不具合の直接の対策）。
// pdcStrokePolyline と同じく stroke() まで行う。色・太さ・alpha は呼び出し側で設定済み前提。
function pdcStrokeChainsPath(ctx, chains) {
  if (!chains || chains.length === 0) return;
  ctx.beginPath();
  for (const chain of chains) {
    if (!chain || chain.length === 0) continue;
    const first = chain[0].pts2d;
    ctx.moveTo(first[0].x, first[0].y);
    for (let i = 1; i < first.length; i++) ctx.lineTo(first[i].x, first[i].y);
    for (let c = 1; c < chain.length; c++) {
      const pts = chain[c].pts2d;
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
  }
  ctx.stroke();
}

// ── チェーン群の二重ストローク描画（外枠→中心線）: pdcPaintCablePolyline の複数チェーン版 ──
// 外枠を全チェーンまとめて1パスで描いてから中心線を描く。
// これによりチェーン内の隣接セグメント境界で外枠が中心線に上書きされない。
// opts は pdcPaintCablePolyline と同一: { widthScale, alpha, outerAlpha, innerAlpha }
function pdcPaintCableChains(ctx, chains, style, opts) {
  if (!chains || chains.length === 0) return;
  const o = opts || {};
  const ws = o.widthScale != null ? o.widthScale : 1;
  const aOut = o.outerAlpha != null ? o.outerAlpha : (o.alpha != null ? o.alpha : PDC_CABLE_STROKE_ALPHA);
  const aIn  = o.innerAlpha != null ? o.innerAlpha : (o.alpha != null ? o.alpha : PDC_CABLE_STROKE_ALPHA);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
  ctx.globalAlpha = aOut;
  ctx.strokeStyle = style.color; ctx.lineWidth = style.outerWidth * ws;
  pdcStrokeChainsPath(ctx, chains);
  ctx.globalAlpha = aIn;
  ctx.strokeStyle = style.lineColor; ctx.lineWidth = style.innerWidth * ws;
  pdcStrokeChainsPath(ctx, chains);
  ctx.restore();
}

// ================================================================
// Phase 6: 配線の隠面処理（ピクセル単位マスク）— 唯一の正
//   抽出元: PanelCanvas3D.jsx の `_rasterTri`（三角形ラスタライザ）と
//           「ケーブル可視マスクラスタライズ」ブロック。
//   エディタも3次元図も同じ関数を呼ぶ。仕切り・アイコンBoxの深度バッファを
//   作り、配線の各セグメントを補間深度で比較して「見える/見えない」の
//   バイナリマスクを作る。マスクは destination-in で配線レイヤーに合成する。
//
//   【深度の向き】この節の内部は「nearDepth = 大きいほど手前」で統一する。
//   呼び出し側の view.nearSign（エディタ +1 / 3次元図 -1）を掛けて正規化するので、
//   両規約で同じマスクが得られる。
// ================================================================

// ── Zバッファ三角形ラスタライザ（不透明・最大深度保持）──
// d        : 書き込み先RGBAバッファ（null なら深度だけ更新しピクセルは書かない）
// zb       : Float32Array(W*H)。nearDepth 空間。呼び出し側で -1e9 fill 済みであること
//            ※ 深度テストに合格した画素で zb[idx] が更新される（＝呼び出し側のバッファを書き換える）
// occludeZb: 別の遮蔽Zバッファ（マージン付き比較）。省略可
// occludeMargin: 遮蔽テストの許容値（depth単位）。省略時は従来どおり +1
//   ※ 既存呼び出し（11引数）は occludeMargin=undefined → 1 となり挙動は不変
function pdcRasterTri(d, zb, W, H, p0, p1, p2, r, g, b, occludeZb, occludeMargin) {
  const _ocMargin = occludeMargin != null ? occludeMargin : 1;
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;

  const denom = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if (Math.abs(denom) < 0.001) return;
  const inv = 1 / denom;
  const writePixels = d !== null; // d=nullのときZバッファのみ更新（ピクセル書き込みスキップ）

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

      // depth大 = カメラに近い → 最大値を保持
      const depth = w0 * p0.depth + w1 * p1.depth + (1 - w0 - w1) * p2.depth;
      const idx = row + px;
      if (depth <= zb[idx]) continue;
      if (occludeZb && occludeZb[idx] > depth + _ocMargin) continue; // 遮蔽Zbuf（仕切り等）に隠される
      zb[idx] = depth;
      if (writePixels) {
        const i4 = idx << 2;
        d[i4] = r; d[i4 + 1] = g; d[i4 + 2] = b; d[i4 + 3] = 255;
      }
    }
  }
}

// ── 配線を遮蔽する要素の種別（エディタの分岐と同じ規則が唯一の正）──
// iconVisMode='full'（機器全透過）: 仕切りは透過扱い → アイコンBoxのみが配線を遮る
// それ以外（opaque / semi）        : 仕切り＋アイコンBox の両方が配線を遮る
// ※ flatアイコンはエディタでもZバッファに載らないので、どちらのモードでも遮蔽しない。
function pdcCableOccluderKinds(iconVisMode) {
  return iconVisMode === 'full'
    ? { partitions: false, iconBoxes: true }
    : { partitions: true,  iconBoxes: true };
}

// ── 遮蔽側（仕切り・アイコンBox）の深度バッファを作る ──
// polys : [{ pts:[{x,y,depth}, ...] }]（投影済み・マスク座標系。3点以上の凸多角形）
// zb    : Float32Array(W*H)。呼び出し側で -1e9 fill 済みであること
// nearSign: view.nearSign（-1 なら depth を反転して nearDepth に揃える）
function pdcRasterizeOccluderDepth(polys, zb, W, H, nearSign) {
  const ns = nearSign || 1;
  for (const poly of (polys || [])) {
    const pts = (poly && poly.pts) || poly;
    if (!pts || pts.length < 3) continue;
    const q = pts.map(p => ({ x: p.x, y: p.y, depth: (p.depth || 0) * ns }));
    for (let i = 1; i < q.length - 1; i++) {
      pdcRasterTri(null, zb, W, H, q[0], q[i], q[i + 1], 0, 0, 0);
    }
  }
  return zb;
}

// マスク幅の余白（CSS px）: 線幅ぴったりだとアンチエイリアス端が削れるため +2 する
const PDC_CABLE_MASK_MARGIN_PX = 2;
// 丸キャップ／丸ジョイント部分の深度テスト許容（この分だけ手前側に甘くする）
const PDC_CABLE_MASK_DEPTH_EPS = 0.01;

// ── 配線可視マスクの構築 ──
// entries : [{ pts2d:[{x,y,depth}], outerWidth }]（マスク座標系。1エントリ＝ケーブル1本）
// occZb   : pdcRasterizeOccluderDepth で作った遮蔽深度バッファ（nearDepth 空間）
//           ※ この関数は occZb を書き換える（配線深度が書き込まれる）。エディタの
//             既存挙動をそのまま維持するため、意図的に逐語移植している。
// mask    : Uint8ClampedArray(W*H*4)。呼び出し側で 0 クリア済みであること（白=可視）
// widthScale: 「CSS px 1本ぶん」がマスク座標系で何単位か（エディタ=半解像度係数、3次元図=dpr×縮小率）
// nearSign  : view.nearSign
function pdcBuildCableVisMask(entries, occZb, mask, W, H, widthScale, nearSign) {
  const ns = nearSign || 1;
  const ws = widthScale != null ? widthScale : 1;
  const _defW = PDC_CABLE_DEFAULT_THICKNESS + PDC_CABLE_DEFAULT_OUTLINE;
  for (const ent of (entries || [])) {
    const pts2d = ent && ent.pts2d;
    if (!pts2d || pts2d.length < 2) continue;
    const _maskW = ((ent.outerWidth != null ? ent.outerWidth : _defW) + PDC_CABLE_MASK_MARGIN_PX) * ws;
    // 各セグメントを矩形（三角形2枚）としてラスタライズ → 補間深度で遮蔽判定
    for (let i = 0; i < pts2d.length - 1; i++) {
      const p0 = pts2d[i], p1 = pts2d[i + 1];
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;
      const nx = -dy / len * (_maskW / 2), ny = dx / len * (_maskW / 2);
      const d0 = (p0.depth || 0) * ns, d1 = (p1.depth || 0) * ns;
      const qA = { x: p0.x + nx, y: p0.y + ny, depth: d0 };
      const qB = { x: p0.x - nx, y: p0.y - ny, depth: d0 };
      const qC = { x: p1.x + nx, y: p1.y + ny, depth: d1 };
      const qD = { x: p1.x - nx, y: p1.y - ny, depth: d1 };
      pdcRasterTri(mask, occZb, W, H, qA, qB, qC, 255, 255, 255);
      pdcRasterTri(mask, occZb, W, H, qB, qD, qC, 255, 255, 255);
    }
    // lineJoin=round / lineCap=round のアーチ部分をマスク円で補完
    const _cr2 = _maskW / 2;
    for (let i = 0; i < pts2d.length; i++) {
      const pt = pts2d[i];
      const pd = (pt.depth || 0) * ns;
      const px0 = Math.max(0, Math.floor(pt.x - _cr2)), px1 = Math.min(W - 1, Math.ceil(pt.x + _cr2));
      const py0 = Math.max(0, Math.floor(pt.y - _cr2)), py1 = Math.min(H - 1, Math.ceil(pt.y + _cr2));
      for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
        const ddx = px - pt.x, ddy = py - pt.y;
        if (ddx * ddx + ddy * ddy <= _cr2 * _cr2) {
          const idx = (py * W + px) * 4;
          if (pd >= occZb[py * W + px] - PDC_CABLE_MASK_DEPTH_EPS) {
            mask[idx] = mask[idx + 1] = mask[idx + 2] = mask[idx + 3] = 255;
          }
        }
      }
    }
  }
  return mask;
}

// ================================================================
// 仕切りエッジの隠面処理（ピクセル単位マスク）— 唯一の正
//   配線マスク（pdcBuildCableVisMask）と同じ「遮蔽深度バッファと補間深度の比較で
//   バイナリマスクを作り destination-in で適用する」方式。違いは2点:
//   ① occZb（仕切り面深度）は読み取り専用。書き込み先はエッジ専用スクラッチ zb。
//      （配線は「配線同士も遮蔽し合う」ため occZb へ書き込むが、エッジで同じことを
//       するとエディタの partOnlyZb（後段のラベル可視判定で再利用）が汚染される上、
//       先に描いたエッジが後のエッジのバイアス付きテストを狂わせる）
//   ② 厳密比較ではなく depthBias 付き比較（pdcRasterTri の occludeMargin 経由）。
//      エッジは仕切り面の輪郭そのもの＝遮蔽面と共面なので、バイアスなしでは
//      自分自身の面に隠れて全消えする。
// ================================================================

// エッジマスク帯の余白（マスク座標px）: 0.5px線そのままではラスタライザが
// ピクセル中心を拾えず全消えするため、配線マスクと同様に広げる
const PDC_PARTITION_EDGE_MASK_MARGIN_PX = 2;

// 深度バイアス（mm）: 「自面・T字接合（共面 ≈0mm）＋自板シルエット（板厚 数mm〜十数mm）」
// は消えず、「明確に手前にある別仕切り（区画寸法 = 通常50mm以上の差）」だけが消える値。
// 呼び出し側で × view.depthPerMm して depth 単位に変換して渡すこと。
const PDC_PARTITION_EDGE_DEPTH_BIAS_MM = 15;

// ── 仕切りエッジ可視マスクの構築 ──
// segs      : pdcCollectPartitionEdgeSegments の結果（マスク座標系）
// occZb     : 仕切り面のみの遮蔽深度バッファ（nearDepth空間・読み取り専用）
// scratchZb : Float32Array(W*H)。呼び出し側で -1e9 fill 済みであること（エッジ専用・使い捨て）
// mask      : Uint8ClampedArray(W*H*4)。呼び出し側で 0 クリア済みであること（白=可視）
// widthScale: 「CSS px 1本ぶん」がマスク座標系で何単位か（エディタ=_scaleR、3次元図=dpr×縮小率）
// nearSign  : view.nearSign（-1 なら depth を反転して nearDepth に揃える）
// depthBias : 遮蔽許容値（depth単位 = mm × view.depthPerMm）
function pdcBuildPartitionEdgeVisMask(segs, occZb, scratchZb, mask, W, H, widthScale, nearSign, depthBias) {
  const ns = nearSign || 1;
  const ws = widthScale != null ? widthScale : 1;
  const lineW = (PDC_PARTITION_EDGE.lineWidth + PDC_PARTITION_EDGE_MASK_MARGIN_PX) * ws;
  const margin = depthBias != null ? depthBias : 1;
  for (const seg of (segs || [])) {
    const dx = seg.x1 - seg.x0, dy = seg.y1 - seg.y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;
    const nx = -dy / len * (lineW / 2), ny = dx / len * (lineW / 2);
    const d0 = (seg.d0 || 0) * ns, d1 = (seg.d1 || 0) * ns;
    const qA = { x: seg.x0 + nx, y: seg.y0 + ny, depth: d0 };
    const qB = { x: seg.x0 - nx, y: seg.y0 - ny, depth: d0 };
    const qC = { x: seg.x1 + nx, y: seg.y1 + ny, depth: d1 };
    const qD = { x: seg.x1 - nx, y: seg.y1 - ny, depth: d1 };
    pdcRasterTri(mask, scratchZb, W, H, qA, qB, qC, 255, 255, 255, occZb, margin);
    pdcRasterTri(mask, scratchZb, W, H, qB, qD, qC, 255, 255, 255, occZb, margin);
  }
  return mask;
}

// ── チェーンの代表depth（Painter's ソート用の平均深度）──
// 3次元図はZバッファを持たないため、他の内部要素と同じ depth ソートに載せる必要がある。
function pdcChainDepth(chain) {
  let s = 0, n = 0;
  for (const part of (chain || [])) for (const pt of (part.pts2d || [])) { s += pt.depth || 0; n++; }
  return n > 0 ? s / n : 0;
}

// ── 開扉の開口部矩形（閉じていたときの位置）を青線で描画 ──
function pdcPaintDoorOpenings(ctx, panel, view) {
  const openDoors = (panel.doors || []).filter(d => d.isOpen);
  if (openDoors.length === 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(100,150,255,0.95)';
  ctx.lineWidth = 2.0 * (view.lwUnit || 1);
  ctx.globalAlpha = 1;
  for (const od of openDoors) {
    const { face, uMm: ou, vMm: ov, widthMm: odw, heightMm: odh } = od;
    const corners3 = [
      pdcFaceUV(face, ou,       ov,       panel),
      pdcFaceUV(face, ou + odw, ov,       panel),
      pdcFaceUV(face, ou + odw, ov + odh, panel),
      pdcFaceUV(face, ou,       ov + odh, panel),
    ].map(([x, y, z]) => view.proj(x, y, z));
    ctx.beginPath();
    ctx.moveTo(corners3[0].x, corners3[0].y);
    for (let i = 1; i < corners3.length; i++) ctx.lineTo(corners3[i].x, corners3[i].y);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}
