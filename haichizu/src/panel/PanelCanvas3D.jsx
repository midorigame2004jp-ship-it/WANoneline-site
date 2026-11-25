// ================================================================
// PanelCanvas3D.jsx — Z-buffer（仕切り） + Canvas 2D（外箱半透明）
// 外箱: Canvas 2D 半透明面（視覚コンテキスト用）
// 仕切り: ソフトウェアZバッファで正確な交差描画（┼が┼に見える）
// ================================================================

// _hexToRGB / panelFaceBrightness は panelDrawCore.js（共通描画コア）に移設。
// 見た目に関わる定数・ロジックの変更は panelDrawCore.js で行うこと。

// アイコンBox半幅計算・6面定義・基準色・flatスタイルは panelDrawCore.js（共通描画コア）に移設。
//   pdcIconHalfExtents / pdcIconBoxCorners / PDC_ICON_BOX_FACES / pdcIconBaseRGB /
//   pdcCollectIconBoxFaces / pdcPaintIconBoxFace(s) / pdcIconFlatHalf / PDC_ICON_FLAT_STYLE
// 見た目の変更は panelDrawCore.js で行うこと。

// ── 3D直方体アイコン描画 ──
// cellBox (mm) を SHRINK 倍して等角投影で6面体を描く
// face: 配置面(front/back/left/right/top/bottom) → 法線方向は面内短辺の1/3（最大200mm）
// zbCheck: (screenPt) => boolean — 仕切りZバッファで遮蔽されていたらtrue（省略可）
// 可視辺のみワイヤーフレームとして描画（チェック選択時の枠線用）
function _drawIconBoxWireframe(ctx, proj, cx, cy, cz, cellBox, face, az, el, strokeColor, lineWidth) {
  const { hx, hy, hz } = pdcIconHalfExtents(cellBox, face);
  const c8 = pdcIconBoxCorners(proj, cx, cy, cz, hx, hy, hz);
  // 各面の可視フラグ
  const vis = {
    front:  !panelIsBackFacing({nx:0,ny:-1,nz:0}, az, el),
    back:   !panelIsBackFacing({nx:0,ny:1,nz:0},  az, el),
    left:   !panelIsBackFacing({nx:-1,ny:0,nz:0}, az, el),
    right:  !panelIsBackFacing({nx:1,ny:0,nz:0},  az, el),
    top:    !panelIsBackFacing({nx:0,ny:0,nz:1},  az, el),
    bottom: !panelIsBackFacing({nx:0,ny:0,nz:-1}, az, el),
  };
  // 12辺 → 隣接する2面のいずれかが可視なら描画
  const edges = [
    [0,1, vis.front  || vis.bottom],
    [1,2, vis.right  || vis.bottom],
    [2,3, vis.back   || vis.bottom],
    [3,0, vis.left   || vis.bottom],
    [4,5, vis.front  || vis.top   ],
    [5,6, vis.right  || vis.top   ],
    [6,7, vis.back   || vis.top   ],
    [7,4, vis.left   || vis.top   ],
    [0,4, vis.front  || vis.left  ],
    [1,5, vis.front  || vis.right ],
    [2,6, vis.back   || vis.right ],
    [3,7, vis.back   || vis.left  ],
  ];
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  for (const [a, b, show] of edges) {
    if (!show) continue;
    ctx.beginPath();
    ctx.moveTo(c8[a].x, c8[a].y);
    ctx.lineTo(c8[b].x, c8[b].y);
    ctx.stroke();
  }
}

function _drawIconBox(ctx, proj, cx, cy, cz, cellBox, face, az, el, isSel, isReordering, label, zbCheck, iconColor, isChecked, pxPerMm) {
  // 形状・カリング・面色は共通コア（panelDrawCore.js）。
  // 編集UI（選択/並び替えの基準色・枠線色）だけをここで上書きする。
  const _view = {
    proj,
    isBackFacing: (n) => panelIsBackFacing(n, az, el),
    nearSign: +1,
    lwUnit: 1,
    pxPerMm, // ラベルのズーム追従（未指定なら共通コア側で固定8px）
  };
  const base = isReordering ? [217,119,6] : (isSel ? [30,64,175] : pdcIconBaseRGB(iconColor));
  const visible = pdcCollectIconBoxFaces(_view, cx, cy, cz, cellBox, face, base, zbCheck);
  // 枠線: pdcPaintIconBoxFace は strokeStyle 未指定なら描かない（静的Zバッファ表示に合わせた既定）。
  // この直描き経路（カメラドラッグ中・ドラッグゴースト）は従来どおり枠線ありなので明示指定する。
  pdcPaintIconBoxFaces(ctx, visible, _view, {
    strokeStyle: isReordering ? '#FDE68A' : isSel ? '#FBBF24' : PDC_ICON_BOX_STROKE.color,
    lineWidth:   isSel ? 1.5 : PDC_ICON_BOX_STROKE.lineWidth,
  });
  pdcPaintIconLabel(ctx, proj(cx, cy, cz), label, _view);
}

// ── スナップ（吸い付き）ヘルパー ──
// dragAxisに沿ったスナップ候補値を収集（親箱面 + 他仕切り面/中心）
function _getSnapTargets(dragAxis, panel, partitionId) {
  const { widthMm: W, heightMm: H, depthMm: D, partitions } = panel;
  const targets = new Set();
  // 親箱の両端面
  if (dragAxis === 'x') { targets.add(0); targets.add(W); }
  else if (dragAxis === 'y') { targets.add(0); targets.add(D); }
  else { targets.add(0); targets.add(H); }

  (partitions || []).forEach(p => {
    if (p.id === partitionId || p.type !== 'axis') return;
    const half = (p.thicknessMm > 0 ? p.thicknessMm : 2) / 2;
    const defPos = p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2;
    const uAxis = p.axis === 'z' ? 'x' : p.axis === 'y' ? 'x' : 'y';
    const vAxis = p.axis === 'z' ? 'y' : 'z';
    const uDefault = [0, uAxis === 'x' ? W : D];
    const vDefault = [0, vAxis === 'z' ? H : D];

    // 仕切りの主軸位置（面・中心）
    if (p.axis === dragAxis) {
      const pos = p.posMm != null ? p.posMm : defPos;
      targets.add(pos - half); targets.add(pos); targets.add(pos + half);
    }
    // u方向の端点
    if (uAxis === dragAxis) {
      targets.add(p.uMinMm != null ? p.uMinMm : uDefault[0]);
      targets.add(p.uMaxMm != null ? p.uMaxMm : uDefault[1]);
    }
    // v方向の端点
    if (vAxis === dragAxis) {
      targets.add(p.vMinMm != null ? p.vMinMm : vDefault[0]);
      targets.add(p.vMaxMm != null ? p.vMaxMm : vDefault[1]);
    }
  });

  // 扉のエッジをスナップ対象に追加
  // 面ごとの UV → ワールド軸マッピング
  const DOOR_FACE_AXES = {
    front:  { uAxis: 'x', vAxis: 'z' },
    back:   { uAxis: 'x', vAxis: 'z' },
    left:   { uAxis: 'y', vAxis: 'z' },
    right:  { uAxis: 'y', vAxis: 'z' },
    top:    { uAxis: 'x', vAxis: 'y' },
    bottom: { uAxis: 'x', vAxis: 'y' },
  };
  (panel.doors || []).forEach(d => {
    const axes = DOOR_FACE_AXES[d.face];
    if (!axes) return;
    if (axes.uAxis === dragAxis) { targets.add(d.uMm); targets.add(d.uMm + d.widthMm); }
    if (axes.vAxis === dragAxis) { targets.add(d.vMm); targets.add(d.vMm + d.heightMm); }
  });

  return Array.from(targets);
}

// snap閾値内の候補に吸い付かせる
function _applySnap(value, targets, thresholdMm) {
  let best = null, bestDist = thresholdMm;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d < bestDist) { best = t; bestDist = d; }
  }
  return best !== null ? best : value;
}

// 点→線分の最短距離（px）
function _distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 外箱12辺（BOX_EDGES / EDGE_FACE_NORMALS）は panelDrawCore.js に移設。

// 配線上Ctrl押下時のカスタムカーソル（Excelの複製直前カーソルと同デザイン）
// 白矢印（黒縁）＋ 矢印先端の右下に点線四角＋中央に「＋」
const _CABLE_CTRL_CURSOR_URL = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="22">
    <path d="M4,1 L4,13 L7,10 L9,15 L11,14 L9,9 L13,9 Z" fill="#ffffff" stroke="#000000" stroke-width="1" stroke-linejoin="round"/>
    <line x1="16" y1="1" x2="16" y2="7" stroke="#000000" stroke-width="1.2"/>
    <line x1="13" y1="4" x2="19" y2="4" stroke="#000000" stroke-width="1.2"/>
    <rect x="6" y="11" width="12" height="8" fill="none" stroke="#000000" stroke-width="1" stroke-dasharray="1,2.5" stroke-linecap="round"/>
  </svg>`;
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}') 4 1, auto`;
})();

// 外箱6面の定義（法線+4頂点mm座標）。扉配置ホバー検出で使用
function _boxFaceDefs(W, D, H) {
  return [
    { id:'front',  normal:{nx:0,ny:-1,nz:0}, verts:[[0,0,0],[W,0,0],[W,0,H],[0,0,H]] },
    { id:'back',   normal:{nx:0,ny:+1,nz:0}, verts:[[0,D,0],[W,D,0],[W,D,H],[0,D,H]] },
    { id:'left',   normal:{nx:-1,ny:0,nz:0}, verts:[[0,0,0],[0,D,0],[0,D,H],[0,0,H]] },
    { id:'right',  normal:{nx:+1,ny:0,nz:0}, verts:[[W,0,0],[W,D,0],[W,D,H],[W,0,H]] },
    { id:'top',    normal:{nx:0,ny:0,nz:+1}, verts:[[0,0,H],[W,0,H],[W,D,H],[0,D,H]] },
    { id:'bottom', normal:{nx:0,ny:0,nz:-1}, verts:[[0,0,0],[W,0,0],[W,D,0],[0,D,0]] },
  ];
}

// 辺ハンドルドラッグ時に変更するパネル寸法の定義
// dim: 変更する寸法フィールド, worldAxis: ワールド軸, atMax: その辺がMax境界側か
// 頂点配置: [0]=(0,0,0)[1]=(W,0,0)[2]=(W,D,0)[3]=(0,D,0)
//            [4]=(0,0,H)[5]=(W,0,H)[6]=(W,D,H)[7]=(0,D,H)
const EDGE_DRAG_AXES = {
  '0,1': [{dim:'depthMm',  worldAxis:'y', atMax:false}, {dim:'heightMm', worldAxis:'z', atMax:false}],
  '1,2': [{dim:'widthMm',  worldAxis:'x', atMax:true},  {dim:'heightMm', worldAxis:'z', atMax:false}],
  '2,3': [{dim:'depthMm',  worldAxis:'y', atMax:true},  {dim:'heightMm', worldAxis:'z', atMax:false}],
  '3,0': [{dim:'widthMm',  worldAxis:'x', atMax:false}, {dim:'heightMm', worldAxis:'z', atMax:false}],
  '4,5': [{dim:'depthMm',  worldAxis:'y', atMax:false}, {dim:'heightMm', worldAxis:'z', atMax:true}],
  '5,6': [{dim:'widthMm',  worldAxis:'x', atMax:true},  {dim:'heightMm', worldAxis:'z', atMax:true}],
  '6,7': [{dim:'depthMm',  worldAxis:'y', atMax:true},  {dim:'heightMm', worldAxis:'z', atMax:true}],
  '7,4': [{dim:'widthMm',  worldAxis:'x', atMax:false}, {dim:'heightMm', worldAxis:'z', atMax:true}],
  '0,4': [{dim:'widthMm',  worldAxis:'x', atMax:false}, {dim:'depthMm',  worldAxis:'y', atMax:false}],
  '1,5': [{dim:'widthMm',  worldAxis:'x', atMax:true},  {dim:'depthMm',  worldAxis:'y', atMax:false}],
  '2,6': [{dim:'widthMm',  worldAxis:'x', atMax:true},  {dim:'depthMm',  worldAxis:'y', atMax:true}],
  '3,7': [{dim:'widthMm',  worldAxis:'x', atMax:false}, {dim:'depthMm',  worldAxis:'y', atMax:true}],
};

// 辺中点の3D座標(mm)を返す
function _edgeMidpointMm(edge, panel) {
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const v = [[0,0,0],[W,0,0],[W,D,0],[0,D,0],[0,0,H],[W,0,H],[W,D,H],[0,D,H]];
  const [a, b] = edge;
  return [(v[a][0]+v[b][0])/2, (v[a][1]+v[b][1])/2, (v[a][2]+v[b][2])/2];
}

// 辺ドラッグのスナップ候補（仕切りの面・端点）を収集
// dim: 変化するパネル寸法フィールド名 → その次元の仕切り位置/端点を返す
// nullデフォルト値（壁に密着）は自動追従するため除外し、明示設定値のみ対象
function _getEdgeSnapTargets(dim, panel) {
  const { widthMm: W, heightMm: H, depthMm: D, partitions } = panel;
  const targets = new Set();
  for (const p of (partitions || [])) {
    if (p.type !== 'axis') continue;
    const half = (p.thicknessMm > 0 ? p.thicknessMm : 2) / 2;
    if (dim === 'widthMm') {
      if (p.axis === 'x') {
        const pos = p.posMm != null ? p.posMm : W / 2;
        targets.add(pos - half); targets.add(pos); targets.add(pos + half);
      }
      if (p.axis === 'y' || p.axis === 'z') {
        if (p.uMinMm != null) targets.add(p.uMinMm);
        if (p.uMaxMm != null) targets.add(p.uMaxMm);
      }
    } else if (dim === 'depthMm') {
      if (p.axis === 'y') {
        const pos = p.posMm != null ? p.posMm : D / 2;
        targets.add(pos - half); targets.add(pos); targets.add(pos + half);
      }
      if (p.axis === 'x') {
        if (p.uMinMm != null) targets.add(p.uMinMm);
        if (p.uMaxMm != null) targets.add(p.uMaxMm);
      }
      if (p.axis === 'z') {
        if (p.vMinMm != null) targets.add(p.vMinMm);
        if (p.vMaxMm != null) targets.add(p.vMaxMm);
      }
    } else if (dim === 'heightMm') {
      if (p.axis === 'z') {
        const pos = p.posMm != null ? p.posMm : H / 2;
        targets.add(pos - half); targets.add(pos); targets.add(pos + half);
      }
      if (p.axis === 'x' || p.axis === 'y') {
        if (p.vMinMm != null) targets.add(p.vMinMm);
        if (p.vMaxMm != null) targets.add(p.vMaxMm);
      }
    }
  }
  return Array.from(targets);
}

// 辺ドラッグでパネル寸法変化時に、移動する面に接する仕切りの更新リストを返す
// dim: 変化した寸法フィールド名, oldMax: 変化前の値, newMax: 変化後の値
// 常に Max 側の面が動く: widthMm→x=W, depthMm→y=D, heightMm→z=H
// axis別のuAxis/vAxis対応:
//   axis='x': uAxis=y, vAxis=z
//   axis='y': uAxis=x, vAxis=z
//   axis='z': uAxis=x, vAxis=y
function _partitionsFollowingFace(partitions, dim, oldMax, newMax) {
  const eps = 0.5;
  const result = [];
  for (const p of (partitions || [])) {
    if (p.type !== 'axis') continue;
    const ch = {};
    if (dim === 'widthMm') {
      // x=W 面が動く
      if (p.axis === 'x' && p.posMm != null && Math.abs(p.posMm - oldMax) < eps) ch.posMm = newMax;
      if (p.axis === 'y' || p.axis === 'z') { // uAxis=x
        if (p.uMaxMm != null && Math.abs(p.uMaxMm - oldMax) < eps) ch.uMaxMm = newMax;
        if (p.uMinMm != null && Math.abs(p.uMinMm - oldMax) < eps) ch.uMinMm = newMax;
      }
    } else if (dim === 'depthMm') {
      // y=D 面が動く
      if (p.axis === 'y' && p.posMm != null && Math.abs(p.posMm - oldMax) < eps) ch.posMm = newMax;
      if (p.axis === 'x') { // uAxis=y
        if (p.uMaxMm != null && Math.abs(p.uMaxMm - oldMax) < eps) ch.uMaxMm = newMax;
        if (p.uMinMm != null && Math.abs(p.uMinMm - oldMax) < eps) ch.uMinMm = newMax;
      }
      if (p.axis === 'z') { // vAxis=y
        if (p.vMaxMm != null && Math.abs(p.vMaxMm - oldMax) < eps) ch.vMaxMm = newMax;
        if (p.vMinMm != null && Math.abs(p.vMinMm - oldMax) < eps) ch.vMinMm = newMax;
      }
    } else if (dim === 'heightMm') {
      // z=H 面が動く
      if (p.axis === 'z' && p.posMm != null && Math.abs(p.posMm - oldMax) < eps) ch.posMm = newMax;
      if (p.axis === 'x' || p.axis === 'y') { // vAxis=z
        if (p.vMaxMm != null && Math.abs(p.vMaxMm - oldMax) < eps) ch.vMaxMm = newMax;
        if (p.vMinMm != null && Math.abs(p.vMinMm - oldMax) < eps) ch.vMinMm = newMax;
      }
    }
    if (Object.keys(ch).length > 0) result.push({ id: p.id, changes: ch });
  }
  return result;
}

// 辺ドラッグでパネル寸法変化時に、移動する面に接する扉の更新リストを返す
// 近端固定・遠端追従: 扉の遠端が旧境界に接触していれば、近端固定のまま遠端を新境界へ移動（= サイズ変化）
function _doorsFollowingFace(doors, dim, oldMax, newMax) {
  const eps = 0.5;
  const result = [];
  for (const d of (doors || [])) {
    const ch = {};
    if (dim === 'widthMm' && ['front','back','top','bottom'].includes(d.face)) {
      if (Math.abs((d.uMm + d.widthMm) - oldMax) < eps)
        ch.widthMm = Math.max(1, newMax - d.uMm);
    }
    if (dim === 'depthMm') {
      if (['left','right'].includes(d.face) && Math.abs((d.uMm + d.widthMm) - oldMax) < eps)
        ch.widthMm = Math.max(1, newMax - d.uMm);
      if (['top','bottom'].includes(d.face) && Math.abs((d.vMm + d.heightMm) - oldMax) < eps)
        ch.heightMm = Math.max(1, newMax - d.vMm);
    }
    if (dim === 'heightMm' && ['front','back','left','right'].includes(d.face)) {
      if (Math.abs((d.vMm + d.heightMm) - oldMax) < eps)
        ch.heightMm = Math.max(1, newMax - d.vMm);
    }
    if (Object.keys(ch).length > 0) result.push({ id: d.id, changes: ch });
  }
  return result;
}

// スクリーン座標 → 面 (face) + UV座標 (uMm, vMm) の逆投影
// 各面の U=0/V=0 頂点(c0)、U=maxU/V=0(cu)、U=0/V=maxV(cv) を投影して線形逆解
function _hitTestFace(sx, sy, panel, az, el, zoom, panX, panY, canvW, canvH) {
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const prj = (wx, wy, wz) => project3DPanel(wx, wy, wz, W, H, D, az, el, zoom, panX, panY, canvW, canvH);
  const FACES = [
    { face: 'front',  n:{nx:0,ny:-1,nz:0}, c0:[0,0,H], cu:[W,0,H], cv:[0,0,0], maxU:W, maxV:H },
    { face: 'back',   n:{nx:0,ny:+1,nz:0}, c0:[W,D,H], cu:[0,D,H], cv:[W,D,0], maxU:W, maxV:H },
    { face: 'left',   n:{nx:-1,ny:0,nz:0}, c0:[0,D,H], cu:[0,0,H], cv:[0,D,0], maxU:D, maxV:H },
    { face: 'right',  n:{nx:+1,ny:0,nz:0}, c0:[W,0,H], cu:[W,D,H], cv:[W,0,0], maxU:D, maxV:H },
    { face: 'top',    n:{nx:0,ny:0,nz:+1}, c0:[0,D,H], cu:[W,D,H], cv:[0,0,H], maxU:W, maxV:D },
    { face: 'bottom', n:{nx:0,ny:0,nz:-1}, c0:[0,0,0], cu:[W,0,0], cv:[0,D,0], maxU:W, maxV:D },
  ];
  for (const fd of FACES) {
    if (panelIsBackFacing(fd.n, az, el)) continue;
    const p0 = prj(...fd.c0), pu = prj(...fd.cu), pv = prj(...fd.cv);
    const dux = pu.x - p0.x, duy = pu.y - p0.y;
    const dvx = pv.x - p0.x, dvy = pv.y - p0.y;
    const det = dux * dvy - dvx * duy;
    if (Math.abs(det) < 0.001) continue;
    const dx = sx - p0.x, dy = sy - p0.y;
    const uN = (dx * dvy - dy * dvx) / det;
    const vN = (dux * dy - duy * dx) / det;
    if (uN >= -0.01 && uN <= 1.01 && vN >= -0.01 && vN <= 1.01)
      return { face: fd.face, uMm: uN * fd.maxU, vMm: vN * fd.maxV };
  }
  return null;
}

// 空想仕切り（axis型）の3D四頂点 [[wx,wy,wz], ...] を返す（Canvas 2Dオーバーレイ用）
function _virtualPartitionCorners(p, panel) {
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const pos = p.posMm; if (pos == null) return null;
  switch (p.axis) {
    case 'y': { const x0=p.uMinMm??0,x1=p.uMaxMm??W,z0=p.vMinMm??0,z1=p.vMaxMm??H;
                return [[x0,pos,z0],[x1,pos,z0],[x1,pos,z1],[x0,pos,z1]]; }
    case 'x': { const y0=p.uMinMm??0,y1=p.uMaxMm??D,z0=p.vMinMm??0,z1=p.vMaxMm??H;
                return [[pos,y0,z0],[pos,y1,z0],[pos,y1,z1],[pos,y0,z1]]; }
    case 'z': { const x0=p.uMinMm??0,x1=p.uMaxMm??W,y0=p.vMinMm??0,y1=p.vMaxMm??D;
                return [[x0,y0,pos],[x1,y0,pos],[x1,y1,pos],[x0,y1,pos]]; }
    default: return null;
  }
}

// アイコン座標から各軸±方向にスキャンし「その点を実際に塞ぐ仕切り」で境界を決める
// grids/chambers を使わないため延長線グリッド汚染が起きない
// virtual含む全仕切りを対象。カバー判定: axis='x'→u=Y,v=Z / 'y'→u=X,v=Z / 'z'→u=X,v=Y
function _computeIconPhysicalCellBox(panel, wx, wy, wz) {
  if (wx == null || wy == null || wz == null) return null;
  const W = panel.widthMm, H = panel.heightMm, D = panel.depthMm;
  if (!W || !H || !D) return null;
  const eps = 0.5;
  let xMin = 0, xMax = W, yMin = 0, yMax = D, zMin = 0, zMax = H;
  for (const p of (panel.partitions || [])) {
    if (p.type !== 'axis' || p.posMm == null) continue;
    const pos = p.posMm;
    if (p.axis === 'x') {
      const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? D;
      const vMin = p.vMinMm ?? 0, vMax = p.vMaxMm ?? H;
      if (wy >= uMin - eps && wy <= uMax + eps && wz >= vMin - eps && wz <= vMax + eps) {
        if (pos < wx) xMin = Math.max(xMin, pos);
        else if (pos > wx) xMax = Math.min(xMax, pos);
      }
    } else if (p.axis === 'y') {
      const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? W;
      const vMin = p.vMinMm ?? 0, vMax = p.vMaxMm ?? H;
      if (wx >= uMin - eps && wx <= uMax + eps && wz >= vMin - eps && wz <= vMax + eps) {
        if (pos < wy) yMin = Math.max(yMin, pos);
        else if (pos > wy) yMax = Math.min(yMax, pos);
      }
    } else if (p.axis === 'z') {
      const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? W;
      const vMin = p.vMinMm ?? 0, vMax = p.vMaxMm ?? D;
      if (wx >= uMin - eps && wx <= uMax + eps && wy >= vMin - eps && wy <= vMax + eps) {
        if (pos < wz) zMin = Math.max(zMin, pos);
        else if (pos > wz) zMax = Math.min(zMax, pos);
      }
    }
  }
  return { xMin, xMax, yMin, yMax, zMin, zMax };
}

// 面ドロップ/ドラッグ移動のアイコン配置座標を計算
// 完全閉鎖空間（扉経由）→ 区画XYZ中心、開放空間 → 面内軸セル中心 + 奥行き最近傍y仕切り
function _computeIconPlacement(face, uMm, vMm, ch, panel, noYSlot = true, forceIy = null) {
  const PW = panel.widthMm, PH = panel.heightMm, PD = panel.depthMm;
  if (!ch.cells || ch.cells.length === 0) return null;
  let faceDist;
  switch (face) {
    case 'front':  faceDist = c => Math.hypot((c.xMin+c.xMax)/2 - uMm,    (c.zMin+c.zMax)/2 - (PH-vMm)); break;
    case 'back':   faceDist = c => Math.hypot((c.xMin+c.xMax)/2 - (PW-uMm),(c.zMin+c.zMax)/2 - (PH-vMm)); break;
    case 'left':   faceDist = c => Math.hypot((c.yMin+c.yMax)/2 - (PD-uMm),(c.zMin+c.zMax)/2 - (PH-vMm)); break;
    case 'right':  faceDist = c => Math.hypot((c.yMin+c.yMax)/2 - uMm,    (c.zMin+c.zMax)/2 - (PH-vMm)); break;
    case 'top':    faceDist = c => Math.hypot((c.xMin+c.xMax)/2 - uMm,    (c.yMin+c.yMax)/2 - (PD-vMm)); break;
    case 'bottom': faceDist = c => Math.hypot((c.xMin+c.xMax)/2 - uMm,    (c.yMin+c.yMax)/2 - vMm);      break;
    default: faceDist = () => 0;
  }
  const best = ch.cells.reduce((b, c) => faceDist(c) < faceDist(b) ? c : b);
  let sameCol, target;
  switch (face) {
    case 'front':  sameCol = ch.cells.filter(c => c.ix === best.ix && c.iz === best.iz); target = sameCol.reduce((b,c) => c.iy < b.iy ? c : b); break;
    case 'back':   sameCol = ch.cells.filter(c => c.ix === best.ix && c.iz === best.iz); target = sameCol.reduce((b,c) => c.iy > b.iy ? c : b); break;
    case 'left':   sameCol = ch.cells.filter(c => c.iy === best.iy && c.iz === best.iz); target = sameCol.reduce((b,c) => c.ix < b.ix ? c : b); break;
    case 'right':  sameCol = ch.cells.filter(c => c.iy === best.iy && c.iz === best.iz); target = sameCol.reduce((b,c) => c.ix > b.ix ? c : b); break;
    case 'top':    sameCol = ch.cells.filter(c => c.ix === best.ix && c.iy === best.iy); target = sameCol.reduce((b,c) => c.iz > b.iz ? c : b); break;
    case 'bottom': sameCol = ch.cells.filter(c => c.ix === best.ix && c.iy === best.iy); target = sameCol.reduce((b,c) => c.iz < b.iz ? c : b); break;
    default: target = best; sameCol = [best];
  }
  // face から見た「スロット」= アイコン1個分の配置領域
  // front/back: ix固定。Z境界付近(±60mm)なら全iz統合(上下統一)、それ以外iz単独
  // left/right: target.ix + best.iz 固定
  // top/bottom: ix + iy 固定 → Z方向のみ展開
  let slotCells;
  switch (face) {
    case 'front': case 'back': {
      const currentZ = PH - vMm;
      const currentX = face === 'back' ? PW - uMm : uMm;

      // Z方向の中央判定（iz統合）
      const MERGE_MM = 60;
      const ixCells = ch.cells.filter(c => c.ix === best.ix);
      const unifiedZMin = Math.min(...ixCells.map(c => c.zMin));
      const unifiedZMax = Math.max(...ixCells.map(c => c.zMax));
      const centerZ = (unifiedZMin + unifiedZMax) / 2;
      const nearCenterZ = Math.abs(currentZ - centerZ) < MERGE_MM;

      // X方向の中央判定（ix統合）
      const izCells = ch.cells.filter(c => c.iz === best.iz);
      const unifiedXMin = Math.min(...izCells.map(c => c.xMin));
      const unifiedXMax = Math.max(...izCells.map(c => c.xMax));
      const centerX = (unifiedXMin + unifiedXMax) / 2;
      const nearCenterX = Math.abs(currentX - centerX) < MERGE_MM;

      if (nearCenterZ && nearCenterX) {
        slotCells = ch.cells; // Z・X両方中央 → 区画全体
      } else if (nearCenterZ) {
        slotCells = ixCells;  // Z中央 → Z統合（ix固定）
      } else if (nearCenterX) {
        slotCells = izCells;  // X中央 → X統合（iz固定）
      } else {
        slotCells = ch.cells.filter(c => c.ix === best.ix && c.iz === best.iz);
      }
      // forceIy: Altサイクルで特定Y奥行きスロットが指定されたとき、iyでさらに絞る
      if (forceIy !== null) {
        const filtered = slotCells.filter(c => c.iy === forceIy);
        if (filtered.length > 0) slotCells = filtered;
      }
      break;
    }
    case 'left':  case 'right': {
      const chIyCount = new Set(ch.cells.map(c => c.iy)).size;
      const skipIyFilter = noYSlot && chIyCount > 1;
      const useIy = (forceIy !== null) ? forceIy : best.iy;
      slotCells = ch.cells.filter(c => c.ix === target.ix && c.iz === best.iz && (skipIyFilter || c.iy === useIy));
      break;
    }
    case 'top':   case 'bottom': slotCells = ch.cells.filter(c => c.ix === best.ix   && c.iy === best.iy);   break;
    default: slotCells = [target];
  }
  // front/back: cellBox X/Z はMERGE_MM統合スロット基準（上下左右区画統合機能を維持）
  // wy のみ target/forceIy セル基準（奥行き強制統合を排除）
  if (face === 'front' || face === 'back') {
    const baseYCells = ch.cells.filter(c => c.ix === best.ix && c.iz === best.iz);
    let wy;
    let yCellsForBox = [target];
    if (forceIy !== null) {
      const fc = baseYCells.find(c => c.iy === forceIy);
      if (fc) { yCellsForBox = [fc]; }
      wy = (Math.min(...yCellsForBox.map(c => c.yMin)) + Math.max(...yCellsForBox.map(c => c.yMax))) / 2;
    } else if (noYSlot) {
      yCellsForBox = baseYCells.length > 0 ? baseYCells : [target];
      wy = (Math.min(...yCellsForBox.map(c => c.yMin)) + Math.max(...yCellsForBox.map(c => c.yMax))) / 2;
    } else {
      wy = (target.yMin + target.yMax) / 2;
    }
    const cellBox = {
      xMin: Math.min(...slotCells.map(c => c.xMin)), xMax: Math.max(...slotCells.map(c => c.xMax)),
      yMin: Math.min(...yCellsForBox.map(c => c.yMin)), yMax: Math.max(...yCellsForBox.map(c => c.yMax)),
      zMin: Math.min(...slotCells.map(c => c.zMin)), zMax: Math.max(...slotCells.map(c => c.zMax)),
    };
    const wx = (cellBox.xMin + cellBox.xMax) / 2;
    const wz = (cellBox.zMin + cellBox.zMax) / 2;
    return { wx, wy, wz, cellBox, face };
  }

  // その他の面: slotCells（MERGE_MM適用済み）からcellBox・配置座標を計算
  const cellBox = {
    xMin: Math.min(...slotCells.map(c => c.xMin)), xMax: Math.max(...slotCells.map(c => c.xMax)),
    yMin: Math.min(...slotCells.map(c => c.yMin)), yMax: Math.max(...slotCells.map(c => c.yMax)),
    zMin: Math.min(...slotCells.map(c => c.zMin)), zMax: Math.max(...slotCells.map(c => c.zMax)),
  };
  const wy = (Math.min(...slotCells.map(c => c.yMin)) + Math.max(...slotCells.map(c => c.yMax))) / 2;
  return {
    wx: (cellBox.xMin + cellBox.xMax) / 2,
    wy,
    wz: (cellBox.zMin + cellBox.zMax) / 2,
    cellBox,
    face,
  };
}

// Altサイクル用スロットリストを構築
// 全面共通: 各奥行き区画を ySpecific(各iy) × N + yUnified に展開
// iy先頭: front→iyMin / back→iyMax / left/right→カーソルY最近傍
function buildAltSlots(face, uMm, vMm, allChs, panel) {
  const PD = panel.depthMm;
  const slots = [];
  for (let di = 0; di < allChs.length; di++) {
    const ch = allChs[di];
    const iyValues = [...new Set(ch.cells.map(c => c.iy))].sort((a, b) => a - b);
    if (iyValues.length <= 1) {
      slots.push({ ch, mode: 'standard', depthIdx: di });
      continue;
    }
    let iyFirst;
    if (face === 'front') {
      iyFirst = iyValues[0];
    } else if (face === 'back') {
      iyFirst = iyValues[iyValues.length - 1];
    } else {
      const cursorY = face === 'left' ? PD - uMm : uMm;
      const getIyCenter = (iy) => {
        const cs = ch.cells.filter(c => c.iy === iy);
        return (Math.min(...cs.map(c => c.yMin)) + Math.max(...cs.map(c => c.yMax))) / 2;
      };
      iyFirst = iyValues.reduce((b, iy) =>
        Math.abs(getIyCenter(iy) - cursorY) < Math.abs(getIyCenter(b) - cursorY) ? iy : b
      );
    }
    const ordered = [iyFirst, ...iyValues.filter(iy => iy !== iyFirst)];
    // デフォルト=統合(先頭)、Alt押下で分割を順に選択、最後にまた統合へ戻る
    slots.push({ ch, mode: 'yUnified', depthIdx: di });
    ordered.forEach((iy, k) =>
      slots.push({ ch, mode: 'ySpecific', iy, iyIdx: k + 1, iyTotal: ordered.length, depthIdx: di })
    );
  }
  return slots;
}

// スロットのオーバーレイラベル
function _slotLabel(slot) {
  if (slot.mode === 'ySpecific') return `Y${slot.iyIdx}/${slot.iyTotal}`;
  if (slot.mode === 'yUnified')  return 'Y統合';
  return `${slot.depthIdx + 1}層目`;
}

// 同一区画・同一面に複数アイコンがある場合のグリッド配置位置を計算（レンダリング専用）
// layoutName: 'h'=横並び, 'v'=縦並び, 't1b2'=上1下2(N=3), 't2b1'=上2下1(N=3), その他=auto
function _computeGroupLayout(N, layoutName, cb, face) {
  let a1min, a1max, a2min, a2max, mkPos, mkSub;
  if (face === 'left' || face === 'right') {
    a1min=cb.yMin; a1max=cb.yMax; a2min=cb.zMin; a2max=cb.zMax;
    const wx=(cb.xMin+cb.xMax)/2;
    mkPos=(a1,a2)=>({wx,wy:a1,wz:a2});
    mkSub=(s1n,s1x,s2n,s2x)=>({xMin:cb.xMin,xMax:cb.xMax,yMin:s1n,yMax:s1x,zMin:s2n,zMax:s2x});
  } else if (face === 'top' || face === 'bottom') {
    a1min=cb.xMin; a1max=cb.xMax; a2min=cb.yMin; a2max=cb.yMax;
    const wz=(cb.zMin+cb.zMax)/2;
    mkPos=(a1,a2)=>({wx:a1,wy:a2,wz});
    mkSub=(s1n,s1x,s2n,s2x)=>({xMin:s1n,xMax:s1x,yMin:s2n,yMax:s2x,zMin:cb.zMin,zMax:cb.zMax});
  } else { // front/back
    a1min=cb.xMin; a1max=cb.xMax; a2min=cb.zMin; a2max=cb.zMax;
    const wy=(cb.yMin+cb.yMax)/2;
    mkPos=(a1,a2)=>({wx:a1,wy,wz:a2});
    mkSub=(s1n,s1x,s2n,s2x)=>({xMin:s1n,xMax:s1x,yMin:cb.yMin,yMax:cb.yMax,zMin:s2n,zMax:s2x});
  }
  const at=(col,row,cols,rows)=>{
    const s1n=a1min+col*(a1max-a1min)/cols,     s1x=a1min+(col+1)*(a1max-a1min)/cols;
    const s2n=a2min+row*(a2max-a2min)/rows,     s2x=a2min+(row+1)*(a2max-a2min)/rows;
    return { ...mkPos((s1n+s1x)/2,(s2n+s2x)/2), subCellBox:mkSub(s1n,s1x,s2n,s2x) };
  };
  if (layoutName==='h') return Array.from({length:N},(_,i)=>at(i,0,N,1));
  if (layoutName==='v') return Array.from({length:N},(_,i)=>at(0,i,1,N));
  if (N===3 && layoutName==='t1b2') return [
    { ...mkPos((a1min+a1max)/2, a2min+0.25*(a2max-a2min)), subCellBox:mkSub(a1min,a1max,a2min,a2min+0.5*(a2max-a2min)) },
    at(0,1,2,2), at(1,1,2,2),
  ];
  if (N===3 && layoutName==='t2b1') return [
    at(0,0,2,2), at(1,0,2,2),
    { ...mkPos((a1min+a1max)/2, a2min+0.75*(a2max-a2min)), subCellBox:mkSub(a1min,a1max,a2min+0.5*(a2max-a2min),a2max) },
  ];
  const cols=Math.ceil(Math.sqrt(N)), rows=Math.ceil(N/cols);
  return Array.from({length:N},(_,i)=>at(i%cols,Math.floor(i/cols),cols,rows));
}

// 選択仕切りの前後距離情報を計算（前後の仕切り or 親箱面との clear span）
function _computePartitionDimInfo(selPart, panel) {
  if (!selPart || selPart.type !== 'axis') return null;
  const { widthMm: W, heightMm: H, depthMm: D, partitions } = panel;
  const axis = selPart.axis;
  const maxVal = axis === 'x' ? W : axis === 'y' ? D : H;
  const half = (selPart.thicknessMm > 0 ? selPart.thicknessMm : 2) / 2;
  const pos = selPart.posMm != null ? selPart.posMm : maxVal / 2;
  const faceLo = pos - half;
  const faceHi = pos + half;

  // 同軸の他仕切りから前後の最近傍面を求める
  let prevFace = 0, nextFace = maxVal;
  for (const p of (partitions || [])) {
    if (p.id === selPart.id || p.type !== 'axis' || p.axis !== axis) continue;
    const ph = (p.thicknessMm > 0 ? p.thicknessMm : 2) / 2;
    const pp = p.posMm != null ? p.posMm : maxVal / 2;
    if (pp + ph <= faceLo) prevFace = Math.max(prevFace, pp + ph);
    if (pp - ph >= faceHi) nextFace = Math.min(nextFace, pp - ph);
  }

  // ラベル配置用: 仕切り面の u-v 中心点
  let cu, cv;
  if (axis === 'x') {
    cu = ((selPart.uMinMm != null ? selPart.uMinMm : 0) + (selPart.uMaxMm != null ? selPart.uMaxMm : D)) / 2;
    cv = ((selPart.vMinMm != null ? selPart.vMinMm : 0) + (selPart.vMaxMm != null ? selPart.vMaxMm : H)) / 2;
  } else if (axis === 'y') {
    cu = ((selPart.uMinMm != null ? selPart.uMinMm : 0) + (selPart.uMaxMm != null ? selPart.uMaxMm : W)) / 2;
    cv = ((selPart.vMinMm != null ? selPart.vMinMm : 0) + (selPart.vMaxMm != null ? selPart.vMaxMm : H)) / 2;
  } else {
    cu = ((selPart.uMinMm != null ? selPart.uMinMm : 0) + (selPart.uMaxMm != null ? selPart.uMaxMm : W)) / 2;
    cv = ((selPart.vMinMm != null ? selPart.vMinMm : 0) + (selPart.vMaxMm != null ? selPart.vMaxMm : D)) / 2;
  }
  const toW = (axV) => axis === 'x' ? [axV, cu, cv] : axis === 'y' ? [cu, axV, cv] : [cu, cv, axV];

  return {
    beforeDist: faceLo - prevFace,
    afterDist: nextFace - faceHi,
    prevFace, nextFace, faceLo, faceHi, pos, half, maxVal,
    prevFaceW: toW(prevFace),
    selLoW:    toW(faceLo),
    selHiW:    toW(faceHi),
    nextFaceW: toW(nextFace),
    beforeMidW: toW((prevFace + faceLo) / 2),
    afterMidW:  toW((faceHi + nextFace) / 2),
  };
}

// 選択仕切りの端辺（uMin/uMax/vMin/vMax）と親箱壁のギャップ情報を計算
// 仕切りが親箱から離れている場合に表示するクリアランス距離
function _computeEdgeGapInfo(selPart, panel) {
  if (!selPart || selPart.type !== 'axis') return [];
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const { axis } = selPart;
  const pos = selPart.posMm != null ? selPart.posMm
    : (axis === 'x' ? W/2 : axis === 'y' ? D/2 : H/2);

  let uMin, uMax, vMin, vMax, uMaxW, vMaxW;
  if (axis === 'x') {
    uMin = selPart.uMinMm != null ? selPart.uMinMm : 0;
    uMax = selPart.uMaxMm != null ? selPart.uMaxMm : D;
    vMin = selPart.vMinMm != null ? selPart.vMinMm : 0;
    vMax = selPart.vMaxMm != null ? selPart.vMaxMm : H;
    uMaxW = D; vMaxW = H;
  } else if (axis === 'y') {
    uMin = selPart.uMinMm != null ? selPart.uMinMm : 0;
    uMax = selPart.uMaxMm != null ? selPart.uMaxMm : W;
    vMin = selPart.vMinMm != null ? selPart.vMinMm : 0;
    vMax = selPart.vMaxMm != null ? selPart.vMaxMm : H;
    uMaxW = W; vMaxW = H;
  } else {
    uMin = selPart.uMinMm != null ? selPart.uMinMm : 0;
    uMax = selPart.uMaxMm != null ? selPart.uMaxMm : W;
    vMin = selPart.vMinMm != null ? selPart.vMinMm : 0;
    vMax = selPart.vMaxMm != null ? selPart.vMaxMm : D;
    uMaxW = W; vMaxW = D;
  }
  const cu = (uMin + uMax) / 2;
  const cv = (vMin + vMax) / 2;
  const eps = 0.5;

  // axis → [wx, wy, wz] 変換
  const toW = (axVal, uVal, vVal) => {
    if (axis === 'x') return [axVal, uVal, vVal];
    if (axis === 'y') return [uVal, axVal, vVal];
    return [uVal, vVal, axVal];
  };

  const gaps = [];
  if (uMin > eps)
    gaps.push({ which: 'uMin', field: 'uMinMm', dist: uMin, wallVal: null,
      fromW: toW(pos, 0, cv), toW_: toW(pos, uMin, cv), midW: toW(pos, uMin/2, cv) });
  if (uMax < uMaxW - eps)
    gaps.push({ which: 'uMax', field: 'uMaxMm', dist: uMaxW - uMax, wallVal: uMaxW,
      fromW: toW(pos, uMax, cv), toW_: toW(pos, uMaxW, cv), midW: toW(pos, (uMax+uMaxW)/2, cv) });
  if (vMin > eps)
    gaps.push({ which: 'vMin', field: 'vMinMm', dist: vMin, wallVal: null,
      fromW: toW(pos, cu, 0), toW_: toW(pos, cu, vMin), midW: toW(pos, cu, vMin/2) });
  if (vMax < vMaxW - eps)
    gaps.push({ which: 'vMax', field: 'vMaxMm', dist: vMaxW - vMax, wallVal: vMaxW,
      fromW: toW(pos, cu, vMax), toW_: toW(pos, cu, vMaxW), midW: toW(pos, cu, (vMax+vMaxW)/2) });
  return gaps;
}

// 丸矩形ストローク/塗り（Canvas 2D の roundRect 互換実装）
function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// 距離ラベルを canvas に描画（active=編集中は青背景）
function _drawDimLabel(ctx, sx, sy, text, active) {
  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  const tw = ctx.measureText(text).width;
  const pw = 6, bh = 17, bw = tw + pw * 2;
  const bx = sx - bw / 2, by = sy - bh / 2;
  ctx.fillStyle = active ? 'rgba(59,130,246,0.95)' : 'rgba(15,23,42,0.88)';
  _rrect(ctx, bx, by, bw, bh, 3); ctx.fill();
  ctx.strokeStyle = active ? '#93C5FD' : 'rgba(148,163,184,0.5)';
  ctx.lineWidth = 1;
  _rrect(ctx, bx, by, bw, bh, 3); ctx.stroke();
  ctx.fillStyle = '#F1F5F9';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, sx, sy);
  ctx.restore();
}

// 寸法線の延長方向にラベル配置点を計算
// pFrom→pTo の方向に extPx だけ pTo を超えた点を返す
function _extendPt(pFrom, pTo, extPx) {
  const dx = pTo.x - pFrom.x, dy = pTo.y - pFrom.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: pTo.x + (dx / len) * extPx, y: pTo.y + (dy / len) * extPx };
}

// 2D 点ポリゴン内判定（レイキャスト法）
function _ptInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i].y, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && px < (pts[j].x - pts[i].x) * (py - yi) / (yj - yi) + pts[i].x)
      inside = !inside;
  }
  return inside;
}

// クリック点での正確な深度補間（三角形ファンで補間）
function _depthAtPoint(px, py, pts) {
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[0], p1 = pts[i], p2 = pts[i + 1];
    const denom = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
    if (Math.abs(denom) < 1e-6) continue;
    const inv = 1 / denom;
    const xd = px - p2.x, yd = py - p2.y;
    const w0 = ((p1.y - p2.y) * xd + (p2.x - p1.x) * yd) * inv;
    const w1 = ((p2.y - p0.y) * xd + (p0.x - p2.x) * yd) * inv;
    if (w0 >= -0.01 && w1 >= -0.01 && w0 + w1 <= 1.01)
      return w0 * p0.depth + w1 * p1.depth + (1 - w0 - w1) * p2.depth;
  }
  return pts.reduce((s, p) => s + p.depth, 0) / pts.length;
}

// Zバッファ三角形ラスタライザ（不透明・最大深度保持）
// 実体は panelDrawCore.js の pdcRasterTri（3次元図の配線マスクと共有するため移設済み）。
// 既存の多数の呼び出し箇所をそのまま残すための薄い転送ラッパ。ロジックの正はコア側。
function _rasterTri(d, zb, W, H, p0, p1, p2, r, g, b, occludeZb) {
  pdcRasterTri(d, zb, W, H, p0, p1, p2, r, g, b, occludeZb);
}

// Z-bufferのポリゴン内側ピクセルを無条件で value に設定（開口パンチアウト用）
function _clearZbTri(zb, W, H, p0, p1, p2, value = -1e9) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;
  const denom = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if (Math.abs(denom) < 0.001) return;
  const inv = 1 / denom;
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
      zb[row + px] = value;
    }
  }
}
function _clearZbPoly(zb, W, H, pts, value = -1e9) {
  for (let i = 1; i < pts.length - 1; i++) {
    _clearZbTri(zb, W, H, pts[0], pts[i], pts[i + 1], value);
  }
}

// Z-buffer付き線分ラスタライザ（扉ワイヤーフレーム用）
// zb は更新しない（塗りを上書きしない）。depth > zb の画素のみ描画
function _rasterLine(d, zb, W, H, p0, p1, r, g, b, bias = 0) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1) | 0;
  for (let t = 0; t <= steps; t++) {
    const frac = t / steps;
    const x = Math.round(p0.x + dx * frac);
    const y = Math.round(p0.y + dy * frac);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const depth = p0.depth + (p1.depth - p0.depth) * frac;
    const idx = y * W + x;
    if (depth <= zb[idx] + bias) continue;
    const i4 = idx << 2;
    d[i4] = r; d[i4 + 1] = g; d[i4 + 2] = b; d[i4 + 3] = 255;
  }
}

let _lastDragCellBoxKey = null; // [DEBUG] ドラッグログ重複抑制用

function PanelCanvas3D({
  panel, camera, setCamera, width, height,
  selectedPartitionIds = [], onSelectPartitions,
  updatePartition, addPartition, updatePanel,
  doors = [], doorsVisible = true, addDoor, updateDoor,
  doorPlaceMode = null, onSetDoorPlaceMode,
  onHoverFace = null,
  selectedDoorId = null, onSelectDoor,
  onSelectEdge = null,
  showChamberColors = true,
  hoverChamberId = null,
  onHoverChamber = null,
  onDropIcon = null,
  onMoveIcon = null,
  selectedIconId = null,
  selectedIconIds = null,
  onSelectIcon = null,
  onToggleIconCheck = null,
  showVirtual = true,
  noYSlot = true,
  iconVisMode = 'semi',
  iconLayouts = {},
  onReorderIcon = null,
  hoveredPartitionId = null,
  hoveredDoorId = null,
  hoveredIconId = null,
  hoveredCableId = null,
  selectedCableId = null,
  cablesVisible = true,
  onCableClick = null,
  cables = [],
  cableAddMode = null,
  onCablePoint = null,
  cableEditMode = null,
  onCableWpClick = null,
  onCableWpMove = null,
  onNewTap = null,
  dragResolution = 0.5,
  dragRestoreDelay = 50,
  onDeletePartitions = null,
  beginMerge = null,
  endMerge = null,
}) {
  // 複数選択のうち最後に選択した仕切りを「プライマリ」として各操作の基準にする
  const selectedPartitionId = selectedPartitionIds[selectedPartitionIds.length - 1] ?? null;

  const W = Math.max(200, width || 600);
  const H = Math.max(200, height || 500);
  const { az, el, zoom, panX, panY } = camera;
  const canvasRef = useRef(null);
  const offCanvasRef = useRef(null);
  const _cvMaskCvsRef = useRef(null);  // cable visibility mask canvas
  const _cvSmthCvsRef = useRef(null);  // smooth cable temp canvas
  const _iconMaskCvsRef = useRef(null); // icon box binary mask for cable destination-out
  // 仕切りエッジ深度マスク用（Step 2b）: partOnlyZb でエッジをZテストして透け見えを防ぐ
  const _edgeMaskCvsRef = useRef(null);   // エッジ可視マスク canvas（Wr×Hr）
  const _edgeStrokeCvsRef = useRef(null); // エッジ stroke 用オフスクリーン（Wr×Hr）
  const _edgeZbRef = useRef(null);        // エッジ専用スクラッチZバッファ（partOnlyZbを汚染しない）
  const _edgeVisRef = useRef(null);       // エッジ可視マスク RGBAバッファ
  const _iconOnlyModeRef = useRef(false); // drawing effectからonMouseDownへ共有
  const iconOffCanvasRef = useRef(null);
  // _iconOnlyMode用バッファを永続化（毎フレーム大量確保→GC圧力を回避）
  const _iconBufsRef = useRef(null);
  // X線モード用スナップショットcanvas（GPU-to-GPUコピーでCPU memcpy不要）
  const _snapCanvasRef = useRef(null);
  // opaque modeケーブル描画用offscreen（カット端destination-out消去のため）
  const _cableOffRef = useRef(null);
  // ケーブルクリック判定用データ（描画ループで更新→mousedownで参照）
  const _cableHitDataRef = useRef([]);
  const _cableClickRef = useRef(null); // mousedown時にヒットしたケーブルID
  // 仕切りラスタライズキャッシュ（panel/camera/選択状態が変わっていなければ再利用）
  const _partCacheRef = useRef(null);
  // { key, partDoorImg: Uint8ClampedArray, zb: Float32Array, partOnlyZb: Float32Array }
  // ※ 仕切りのラスタライズ結果は iconVisMode に依存しない（カラーは常に partDoorImg）
  // ギズモ（右上キューブ）のクリック判定用: [{pts, targetAz, targetEl}]
  const _gizmoHitRef = useRef([]);
  // ギズモmousedown記録（クリック=snap, ドラッグ=カメラ回転 に振り分け）
  const _gizmoDownRef = useRef(null); // {tAz, tEl, x0, y0}
  const dragRef = useRef(null);
  const gizmoDragRef = useRef(null);
  const edgeDragRef = useRef(null);
  const [selectedEdge, setSelectedEdge] = useState(null); // [idxA, idxB] or null
  const [dimEditing, setDimEditing] = useState(null);     // {which, sx, sy, initDist}
  const dimLabelRef = useRef(null);                        // 直近フレームの距離ラベル画面座標 + initDist
  const dimInputRef = useRef(null);                        // 入力欄のDOMRef（onMouseDownから値を取得するため）
  const iconHitRef = useRef([]);                            // アイコンクリック判定 [{icon, pts}]
  const iconClickRef = useRef(null);                        // mousedown時のアイコンヒット {icon, x0, y0}
  const iconMoveDragRef = useRef(null);                     // 選択済みアイコンのドラッグ移動 {icon, x0, y0, groupKey, originalSlotIdx}
  const _iconDragCursorRef = useRef(null);                  // アイコンドラッグ中カーソル {sx, sy}
  const [iconDragPreview, setIconDragPreview] = useState(null); // ドラッグ移動中の候補座標 {wx,wy,wz} or null
  const iconGroupRef = useRef(new Map());                   // groupKey -> {slotPositions, iconIds, chamberKey, face}
  const iconReorderPreviewRef = useRef(null);               // {groupKey, fromIdx, toIdx}
  const [iconReorderPreview, setIconReorderPreview] = useState(null); // 同一グループ内リオーダープレビュー
  const altCycleRef = useRef(0);                            // Alt層サイクル: 0=手前,1=奥,...
  const altKeyWasDownRef = useRef(false);                   // dragover用: 前フレームのAlt状態
  const altKeyRef = useRef(false);                          // スナップ無効化用: keydown/keyupで追跡
  const [_drawVersion, _setDrawVersion] = useState(0);      // mouseUp時の強制最終描画トリガー
  const altLastPosRef = useRef({ x: 0, y: 0 });            // dragover用: カーソル移動リセット
  const [altDepthInfo, setAltDepthInfo] = useState(null);  // {idx,total} オーバーレイ表示用
  const lastDragCursorRef = useRef({ clientX: 0, clientY: 0 }); // keydown Alt時に即再計算用
  const altSlotsRef = useRef([]);                           // mousemoveで構築済みのAltサイクルスロットリスト（keydownで再利用）
  const _cableCursorRef = useRef(null);                     // ケーブルルートモード: キャンバス上のカーソル座標 {x, y}
  const _cableAddModeRef = useRef(null);                    // ケーブルルートモード: 常に最新のcableAddModeを保持
  const _cableEditModeRef = useRef(null);                   // 配置編集モード: 常に最新のcableEditModeを保持
  const _editCursorRef = useRef(null);                      // 配置編集モード: キャンバス上のカーソル座標 {sx, sy}
  const _wpDragRef = useRef(null);                          // 配置編集モード: 折れ点ドラッグ中 {wpIdx, sx, sy}
  const _tapDragRef = useRef(null);                         // タップ作成ドラッグ中 {fromWx, fromWy, fromWz, fromChamberId}
  const _cablesRef = useRef(cables);                        // staleクロージャ対策: 常に最新のcablesを保持
  const _cableAltCycleRef = useRef(0);                      // ケーブルモードAltサイクルインデックス
  const _cableAltWasDownRef = useRef(false);                // Altキー前回状態（新規押下検出用）
  const _editAltCycleRef = useRef(0);                       // 配置編集/アイコンドラッグ中のAltサイクル(0=区画中央,1=手前セル,2=奥セル)
  const _editAltPrevKeyRef = useRef(null);                  // 直前のスナップ先識別キー（異なる点に移動したらリセット）
  const _cableAllChsRef = useRef([]);                       // 現在カーソル射線上の全区画（hitAllChambers結果）
  const _cableHitFaceRef = useRef(null);                    // 現在カーソルがヒットしたface情報 {face, uMm, vMm}
  const _cableHoverCellRef = useRef(null);                  // ホバー中区画の最近傍セル中心 {chamberId, wx, wy, wz}
  const _cableDotHitsRef = useRef([]);                      // 描画した丸リスト [{chamberId, wx, wy, wz, sx, sy}]（onMouseUpの近傍判定用）
  const _cableNearestDotRef = useRef(null);                 // 現在強調中の丸 {chamberId, wx, wy, wz, sx, sy}（描画ループが毎フレーム更新）
  const _cableLastClickRef = useRef(null);                  // 直前の区画クリック {chamberId, time} — ダブルクリック完了判定用
  const _cableMouseMovedRef = useRef(false);                // mousedown後にmousemoveが発生したか — trueならmouseupでケーブル点を登録しない
  const _cableYGroupCountRef = useRef(1);                   // 現在チャンバーのy深度グループ数（ステータスバー表示用）
  const altSelectedSlotRef = useRef(null);                  // Altキー押下時点で確定したスロット（mouseupで使用）
  const doorHitRef = useRef([]);                           // 扉クリック判定 [{door, pts, depth}]
  const doorCandidateRef = useRef([]);                     // 候補クリック判定 [{cell, pts, isStrict}]
  const [hoveredFace, setHoveredFace] = useState(null);    // 扉配置ホバーモードで強調する面
  const doorDragRef   = useRef(null);                       // {anchor:cell} ドラッグ選択中
  const doorAnchorRef = useRef(null);                       // アンカーセル(stale closure対策)
  const doorHoverRef  = useRef(null);                       // ホバーセル(stale closure対策)
  const doorPosDragRef = useRef(null);                      // {doorId,initUMm,initVMm,...} 扉位置ドラッグ
  const [doorSelAnchor, setDoorSelAnchor] = useState(null); // 再描画トリガー用アンカー
  const [doorSelHover,  setDoorSelHover]  = useState(null); // 再描画トリガー用ホバー
  // doorPlaceModeが'hover'以外に変わったらhovered状態をリセット
  useEffect(() => {
    if (doorPlaceMode !== 'hover') setHoveredFace(null);
    // 面切替時にドラッグ選択もリセット
    doorDragRef.current = null; doorAnchorRef.current = null; doorHoverRef.current = null;
    setDoorSelAnchor(null); setDoorSelHover(null);
  }, [doorPlaceMode]);
  // 扉候補ホバーを展開図に伝播（window イベント経由）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('panelEditorCellHover', {
      detail: (doorPlaceMode && doorPlaceMode !== 'hover' && doorSelHover)
        ? { face: doorPlaceMode, uMm: doorSelHover.uMm, vMm: doorSelHover.vMm, widthMm: doorSelHover.widthMm, heightMm: doorSelHover.heightMm }
        : null
    }));
  }, [doorSelHover, doorPlaceMode]);
  // selectedEdge が変化したら親に通知
  useEffect(() => { if (onSelectEdge) onSelectEdge(selectedEdge); }, [selectedEdge]); // eslint-disable-line

  const proj = useCallback((wx, wy, wz) =>
    project3DPanel(wx, wy, wz, panel.widthMm, panel.heightMm, panel.depthMm, az, el, zoom, panX, panY, W, H),
    [panel.widthMm, panel.heightMm, panel.depthMm, az, el, zoom, panX, panY, W, H]
  );

  const gizmoHandles = useMemo(() => {
    if (!selectedPartitionId || !panel) return [];
    const part = (panel.partitions || []).find(p => p.id === selectedPartitionId);
    return panelGizmoHandles(part, panel, proj);
  }, [panel, selectedPartitionId, proj]);

  // panelToSolids はレンダリング・クリック・ホバーで共用するため1か所でメモ化
  const solids = useMemo(() => panelToSolids(panel), [panel]);

  // Chamber 自動検出（仕切り構成が変わったときのみ再計算）
  const chambers = useMemo(() => {
    const chs = deriveChambers(panel);
    return applyColorMode(chs, panel.chamberColorMode || 'auto10', panel.chamberColorMap, panel.graph4Colors);
  }, [panel]);

  // RAFでバッチ化 — camera変化ごとにuseEffectが発火しても1フレーム1描画に抑える
  const _drawRafRef = useRef(null);
  const _isZoomingRef = useRef(false);
  const _zoomTimerRef = useRef(null);
  const _isCamMovingRef = useRef(false);   // マウス移動中のみtrue（静止したらfalse）
  const _camMoveTimerRef = useRef(null);
  useEffect(() => {
    if (_drawRafRef.current) cancelAnimationFrame(_drawRafRef.current);
    _drawRafRef.current = requestAnimationFrame(() => {
    _drawRafRef.current = null;
    const _isCameraMoving = _isCamMovingRef.current || _isZoomingRef.current;
    // 半減前提条件: 扉表示中 かつ (boxアイコン有 かつ 配線表示中) のときのみ重い → 半減効果あり
    const _panelDispMode0 = panel.iconDisplayMode || 'flat';
    const _hasBoxIconsForHR = (panel.placedIcons || []).some(ic => {
      const m = (ic.iconDisplayMode === 'flat' || ic.iconDisplayMode === 'box') ? ic.iconDisplayMode : _panelDispMode0;
      return m === 'box' && ic.wx != null;
    });
    const _needsLowRes = doorsVisible && _hasBoxIconsForHR && cablesVisible && (cables && cables.length > 0);
    const _isCameraDragging = _isCameraMoving && _needsLowRes;
    // 解像度半減: ドラッグ中は Wr×Hr(=W/2×H/2)でラスタライズ → ctx.drawImage で2倍拡大
    // projR: proj結果(W×H座標)を0.5倍スケールダウン → Wr×Hrバッファに正しく収まる
    const _scaleR = _isCameraDragging ? dragResolution : 1;
    const Wr = Math.ceil(W * _scaleR);
    const Hr = Math.ceil(H * _scaleR);
    const projR = _isCameraDragging
      ? (wx, wy, wz) => { const p = proj(wx, wy, wz); return { x: p.x * _scaleR, y: p.y * _scaleR, depth: p.depth }; }
      : proj;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#1E293B';
      ctx.fillRect(0, 0, W, H);

      const transparency = pdcTransparency(panel); // 共通コア: 0=不透明, 100=完全透過
      // 区間1 t=0-4: 0%→1%の透明度を4等分（ジャンプ防止）
      // 区間2 t=4-100: 1%→100%の透明度を線形
      const solidAlpha = (() => {
        if (transparency === 0) return 1;
        const SPLIT = 4, EPS = 0.01;
        if (transparency <= SPLIT) return 1 - (transparency / SPLIT) * EPS;
        return 1 - (EPS + (transparency - SPLIT) / (100 - SPLIT) * (1 - EPS));
      })();
      const outerAlpha = selectedPartitionId ? solidAlpha * 0.4 : solidAlpha;

      const _panelDispMode0 = panel.iconDisplayMode || 'flat';
      const _hasBoxIcons = (panel.placedIcons || []).some(ic => {
        const _m = (ic.iconDisplayMode === 'flat' || ic.iconDisplayMode === 'box') ? ic.iconDisplayMode : _panelDispMode0;
        return _m === 'box' && ic.wx != null && _panelDispMode0 !== 'hidden';
      });
      // 配線X線モード: box iconの有無を問わない（semi/fullなら配線は常にX線合成）
      // → 配線の見た目は iconDisplayMode(box/flat) に依存しない
      const _cableXrayMode = (iconVisMode === 'semi' || iconVisMode === 'full');
      // 機器半透過/全透過(iconVisMode=semi/full) + boxアイコン有 → アイコンBox透視モード
      // （外箱透明度0でも機器Boxを60%で透視）。扉表示ON/OFF に関わらず適用する。
      // ※アイコンBox専用に純化。配線の合成方式は _cableXrayMode を使うこと
      const _iconOnlyMode = _cableXrayMode && _hasBoxIcons;
      _iconOnlyModeRef.current = _iconOnlyMode; // onMouseDownから参照するため共有

      // ── 扉ユーティリティ（Step 3.5 共用）— 実体は panelDrawCore.js ──
      const _DOOR_MOUNT_NORMALS = PDC_DOOR_MOUNT_NORMALS;
      const _doorCorners3D = (door) => pdcDoorCorners(door, panel);

      // ── 共通描画コア用ビュー（エディタ規約: panel-local az/el, depth大=手前）──
      const pdcView = {
        proj,
        isBackFacing: (n) => panelIsBackFacing(n, az, el),
        nearSign: +1,
        lwUnit: 1,
        // project3DPanel は mm × zoom で投影するため zoom 自体が 1mm あたりのCSS px数
        pxPerMm: zoom,
        // project3DPanel の depth は mm 単位そのまま → 1mm = 1 depth
        depthPerMm: 1,
      };
      // 配線太さのズーム追従係数（共通コア pdcCableWidthFactor が唯一の正）。
      // 3次元図と同じ基準で、盤を縮小しても配線だけ太いまま残らないようにする。
      const _cableWidthFactor = pdcCableWidthFactor(pdcView);

      // ── Step 1: 外箱の面を Canvas 2D で半透明描画（panelDrawCore.js 共通コア）──
      const outerFaces = pdcCollectOuterFaces(solids, pdcView);
      pdcPaintOuterFaces(ctx, outerFaces, outerAlpha);

      // 外箱面の深度バッファ（Step 3.5 扉Z-buffer用）: transparency=0のみ構築
      // outerZb     : 取り付け面除外 → fill用（Z-fighting防止）
      // outerZbFull : 全面含む       → wireframe用（ヒンジ端が取り付け面で遮蔽される）
      let outerZb = null, outerZbFull = null;
      if (transparency === 0) {
        const _doorFaceNormalKeys = new Set(
          (panel.doors || []).map(d => {
            const n = _DOOR_MOUNT_NORMALS[d.face];
            return n ? `${n.nx},${n.ny},${n.nz}` : null;
          }).filter(Boolean)
        );
        outerZb     = new Float32Array(Wr * Hr).fill(-1e9);
        outerZbFull = new Float32Array(Wr * Hr).fill(-1e9);
        const _dummy = new Uint8ClampedArray(Wr * Hr * 4);
        // outerZb: 表向き面のみ + 取り付け面除外（fill Z-fighting防止）
        outerFaces.forEach(({ f }) => {
          const nk = `${Math.round(f.normal.nx)},${Math.round(f.normal.ny)},${Math.round(f.normal.nz)}`;
          if (_doorFaceNormalKeys.has(nk)) return;
          const ptsR = f.vertices.map(v => projR(v.x, v.y, v.z));
          for (let i = 1; i < ptsR.length - 1; i++) {
            _rasterTri(_dummy, outerZb, Wr, Hr, ptsR[0], ptsR[i], ptsR[i + 1], 0, 0, 0);
          }
        });
        // outerZbFull: 全6面（backface含む）→ wireframe深度テスト用
        // backfaceも含むことで後ろ向き面扉のヒンジ端を正しく遮蔽する
        solids.forEach(solid => {
          if (!solid._isOuter) return;
          (solid.faces || []).forEach(f => {
            if (!f.vertices || f.vertices.length < 3) return;
            const fpts = f.vertices.map(v => projR(v.x, v.y, v.z));
            for (let i = 1; i < fpts.length - 1; i++) {
              _rasterTri(_dummy, outerZbFull, Wr, Hr, fpts[0], fpts[i], fpts[i + 1], 0, 0, 0);
            }
          });
        });
      }

      // 開扉の開口部（外壁上の矩形）を事前投影（透明度0%時のクリップ用）
      // 前面向き判定含め panelDrawCore.js 共通コアに委譲
      const openDoorOpenings = pdcDoorOpenings2D(panel, pdcView).map(o => o.pts);
      // rasterizer用 (Wr×Hr座標) — _clearZbPolyで使用
      const openDoorOpeningsR = openDoorOpenings.map(pts =>
        pts.map(p => ({ x: p.x * _scaleR, y: p.y * _scaleR, depth: p.depth }))
      );

      // ── アイコン表示位置確定（グループ整列）: ZバッファパスとCanvas描画で共有 ──
      const _dispPos = new Map();
      {
        const _PW = panel.widthMm, _PH = panel.heightMm, _PD = panel.depthMm;
        const groups = {};
        (panel.placedIcons || []).forEach(icon => {
          if (icon.wx == null) return;
          const face = icon.face || (() => {
            const d = [
              ['front',icon.wy],['back',_PD-icon.wy],
              ['left',icon.wx],['right',_PW-icon.wx],
              ['bottom',icon.wz],['top',_PH-icon.wz],
            ];
            return d.reduce((a,b)=>a[1]<b[1]?a:b)[0];
          })();
          const gk = icon.chamberKey
            ? `${icon.chamberKey}:${face}`
            : `__solo__:${icon.id}`;
          if (!groups[gk]) groups[gk] = { face, chamberKey: icon.chamberKey, icons: [] };
          groups[gk].icons.push(icon);
        });
        const newGroupInfo = new Map();
        for (const [gk, g] of Object.entries(groups)) {
          if (g.icons.length <= 1) continue;
          const cbs = g.icons.map(ic => ic.cellBox).filter(Boolean);
          if (!cbs.length) continue;
          // 各アイコンが異なるcellBoxを持つ = 個別の区画セルに配置済み → グループ整列を強制しない
          const allSameCellBox = cbs.every(cb =>
            Math.abs(cb.xMin - cbs[0].xMin) < 1 && Math.abs(cb.xMax - cbs[0].xMax) < 1 &&
            Math.abs(cb.yMin - cbs[0].yMin) < 1 && Math.abs(cb.yMax - cbs[0].yMax) < 1 &&
            Math.abs(cb.zMin - cbs[0].zMin) < 1 && Math.abs(cb.zMax - cbs[0].zMax) < 1
          );
          if (!allSameCellBox) continue; // 個別配置優先 → 各自のcellBoxをそのまま使用
          const cb = {
            xMin:Math.min(...cbs.map(c=>c.xMin)), xMax:Math.max(...cbs.map(c=>c.xMax)),
            yMin:Math.min(...cbs.map(c=>c.yMin)), yMax:Math.max(...cbs.map(c=>c.yMax)),
            zMin:Math.min(...cbs.map(c=>c.zMin)), zMax:Math.max(...cbs.map(c=>c.zMax)),
          };
          const lname = (iconLayouts||{})[g.chamberKey] || 'auto';
          const positions = _computeGroupLayout(g.icons.length, lname, cb, g.face);
          newGroupInfo.set(gk, {
            slotPositions: positions.map(p => ({ ...p, screenX: 0, screenY: 0 })),
            iconIds: g.icons.map(ic => ic.id),
            chamberKey: g.chamberKey, face: g.face,
          });
          const rp = iconReorderPreview;
          const originalOrderIds = g.icons.map(ic => ic.id);
          let orderedIds = [...originalOrderIds];
          const isThisGroupPreview = rp && rp.groupKey === gk && rp.fromIdx !== rp.toIdx;
          if (isThisGroupPreview) {
            const reord = [...orderedIds];
            const [mv] = reord.splice(rp.fromIdx, 1);
            reord.splice(rp.toIdx, 0, mv);
            orderedIds = reord;
          }
          orderedIds.forEach((id, i) => {
            const ic = g.icons.find(x => x.id === id);
            if (ic) _dispPos.set(id, positions[i]);
          });
        }
        for (const [, info] of newGroupInfo) {
          info.slotPositions.forEach(sp => {
            const pp = proj(sp.wx, sp.wy, sp.wz);
            sp.screenX = pp.x; sp.screenY = pp.y;
          });
        }
        iconGroupRef.current = newGroupInfo;
      }

      let partZb = null;     // 仕切り＋アイコンBox両方を含むZバッファ
      let partOnlyZb = null; // 仕切りのみ（アイコンBox除外）: allOccludedチェック用
      let _deferIconBoxDraw = false; // boxZバッファ出力をStep3.5前に遅延するフラグ
      let _deferredOffscreen = null; // deferred出力用のoffscreen参照
      // ── Step 2: 仕切りをZバッファで描画（透明度0%でも開扉 or 扉非表示 or boxアイコン有なら描画）──
      let _iconBoxSnapshot = null; // X線モード用: アイコンBoxのZバッファ結果を扉描画後に合成
      let offscreen = offCanvasRef.current;
      if (!offscreen || offscreen.width !== Wr || offscreen.height !== Hr) {
        offscreen = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(Wr, Hr)
          : Object.assign(document.createElement('canvas'), { width: Wr, height: Hr });
        offCanvasRef.current = offscreen;
      } else {
        offscreen.width = Wr; // リセット
      }
      const offCtx = offscreen.getContext('2d');
      let _cableInPixelBuf = false;

      // ── ケーブル座標事前計算（big-if内でのマスクラスタライズ・滑らか描画に共用）──
      // 経路構築は共通コア（pdcBuildCableRoutes）が唯一の正。投影は半解像度 projR を渡す。
      const _cRouteMap = new Map(); // cableId → {pts2d:[{x,y,depth}], pts3d, cable}
      if (cablesVisible && cables && cables.length > 0) {
        for (const _r of pdcBuildCableRoutes(panel, chambers, { proj: projR }, cables)) {
          _cRouteMap.set(_r.cable.id, _r);
        }
      }
      // ケーブルクリック判定データをここで更新（big-if外、_cRouteMapが常に最新）
      _cableHitDataRef.current = Array.from(_cRouteMap.values()).map(e => ({ cableId: e.cable.id, pts2d: e.pts2d }));

      // ── Wireセット自動グループ化（共通コア pdcGroupCablesByWireSet）──
      // 各ケーブルの全通過点（始点+waypoints+終点）の3D座標が 5mm 以内なら同一Wireセット
      const _wsAutoGroups = pdcGroupCablesByWireSet([..._cRouteMap.values()]); // rootId → routes[]

      let _cvSmthCvsForDraw = null; // big-if外のctx描画で使用
      if (transparency > 0 || openDoorOpenings.length > 0 || !doorsVisible || _iconOnlyMode
          || (_cableXrayMode && _cRouteMap.size > 0)) {
      // ── 全バッファをrefで永続化（毎フレームの大型確保→GCを排除） ──
      const _n = Wr * Hr;
      let _bufs = _iconBufsRef.current;
      if (!_bufs || _bufs.n !== _n) {
        _bufs = {
          n: _n,
          img:      new Uint8ClampedArray(_n * 4), // imgData.dataの代わり
          zb:       new Float32Array(_n),           // メインZバッファ
          partOnlyZb: new Float32Array(_n),         // 仕切りのみZバッファ
          zbGroup:  new Float32Array(_n),
          dGroup:   new Uint8ClampedArray(_n * 4),
          zbSingle: new Float32Array(_n),
          dSingle:  new Uint8ClampedArray(_n * 4),
          cableVis: new Uint8ClampedArray(_n * 4), // ケーブル可視マスク（白=可視）
          zbIconOnly: new Float32Array(_n),        // アイコンBoxのみZバッファ（全透過モード用）
        };
        _iconBufsRef.current = _bufs;
      }
      // フレームリセット（fill/setのみ、確保なし）
      _bufs.img.fill(0);
      _bufs.zb.fill(-1e9);
      _bufs.cableVis.fill(0);
      const cableVis = _bufs.cableVis;
      const imgData = new ImageData(_bufs.img, Wr, Hr);
      const d = _bufs.img;
      const zb = _bufs.zb;

      // ── 仕切りラスタライズキャッシュ ──
      // panel参照（===）+ camera数値 + W/H + 選択状態が同じなら再利用
      // JSON.stringifyを避けて軽量比較
      // 仕切りのラスタライズ結果は iconVisMode に依存しない（常に partDoorImg + zb）ため
      // キャッシュキーから iconOnly を外してモード切替でも再利用できるようにする
      const _pc = _partCacheRef.current;
      const _partHit = _pc && _pc.n === _n
        && _pc.panel === panel
        && _pc.az === az && _pc.el === el
        && _pc.zoom === zoom && _pc.panX === panX && _pc.panY === panY
        && _pc.selParts === selectedPartitionIds.join(',');

      if (_partHit) {
        // ① キャッシュヒット: コピーのみ（最速）
        zb.set(_pc.zb);
        _bufs.partOnlyZb.set(_pc.partOnlyZb);
        _bufs.partDoorImg = _pc.partDoorImg; // 仕切り専用カラー画像（常に存在）
        // opaqueモードのみ仕切り色を統合バッファdへ合流（X線モードはdに混ぜない）
        if (!_iconOnlyMode) d.set(_bufs.partDoorImg);
      } else {
        // ③ キャッシュミス（停止後 or 初回）: 同期ラスタライズ
        // 仕切りは常に専用カラーバッファ partDoorImg に描く（深度は zb ＝ このあとアイコンBoxが乗る前なので仕切りのみ）。
        // opaqueモードではラスタライズ後に d へコピーして統合バッファに合流させる。
        // → 描画モードに関わらずラスタライズ内容が同一になり、キャッシュ・Zバッファ依存箇所が安定する
        if (!_bufs.partDoorImg || _bufs.partDoorImg.length !== _n * 4) {
          _bufs.partDoorImg = new Uint8ClampedArray(_n * 4);
        } else {
          _bufs.partDoorImg.fill(0);
        }
        const _partDoorD = _bufs.partDoorImg;
        solids.forEach(solid => {
          if (solid._isOuter) return;
          const isSel = !!(selectedPartitionIds.length && selectedPartitionIds.includes(solid._partitionId));
          (solid.faces || []).forEach(f => {
            if (!f.vertices || f.vertices.length < 3) return;
            if (panelIsBackFacing(f.normal, az, el)) return;
            const pts = f.vertices.map(v => projR(v.x, v.y, v.z));
            // 色計算は panelDrawCore.js 共通コア（3次元図と同一の見た目を保証）
            const [r, g, b] = pdcPartitionFaceRGB(solid.color, f.normal, isSel);
            for (let i = 1; i < pts.length - 1; i++) {
              _rasterTri(_partDoorD, zb, Wr, Hr, pts[0], pts[i], pts[i + 1], r, g, b);
            }
          });
        });
        _bufs.partOnlyZb.set(zb); // この時点の zb は仕切りのみ（アイコンBoxは後段）
        if (!_iconOnlyMode) d.set(_partDoorD);
        const _cacheZb       = new Float32Array(zb);
        const _cachePartOnly = new Float32Array(_bufs.partOnlyZb);
        _partCacheRef.current = {
          n: _n, panel, az, el, zoom, panX, panY,
          selParts: selectedPartitionIds.join(','),
          zb: _cacheZb, partOnlyZb: _cachePartOnly,
          partDoorImg: new Uint8ClampedArray(_partDoorD),
        };
      }
      partOnlyZb = _bufs.partOnlyZb;
      // ── アイコンBoxをZバッファにラスタライズ（統合/単体を分離レンダリング） ──
      // 分離理由: 深度バイアスなしで「単体区画は常に統合区画より手前」を実現しつつ
      //           仕切りによるオクルージョンを正しく保持する
      // _iconOnlyMode時: zbをpartOnlyZbではなく-1e9で初期化 → 仕切りでアイコンBoxを遮蔽しない
      // zbSingle は zbGroup の値を含まない → 統合区画アイコンが単体をオクルードしない
      // 最終合成: dGroup → dSingle の順でdに上書き → 単体が常に最前面
      {
        const _panelDispMode = panel.iconDisplayMode || 'flat';
        // 永続バッファを再利用（新規確保なし）
        const zbGroup  = _bufs.zbGroup;
        const dGroup   = _bufs.dGroup;
        const zbSingle = _bufs.zbSingle;
        const dSingle  = _bufs.dSingle;
        if (_iconOnlyMode || iconVisMode === 'full') {
          zbGroup.fill(-1e9); dGroup.fill(0);   // 全透過/X線時: 仕切りでBoxを遮蔽しない
          zbSingle.fill(-1e9); dSingle.fill(0);
        } else {
          zbGroup.set(partOnlyZb); dGroup.fill(0);
          zbSingle.set(partOnlyZb); dSingle.fill(0);
        }

        (panel.placedIcons || []).forEach(icon => {
          if (icon.wx == null) return;
          const _iMode = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box')
            ? icon.iconDisplayMode : _panelDispMode;
          if (_iMode !== 'box') return;
          const _isGroupIcon = _dispPos.has(icon.id);
          const _dTarget  = _isGroupIcon ? dGroup  : dSingle;
          const _zbTarget = _isGroupIcon ? zbGroup : zbSingle;
          const dp = _dispPos.get(icon.id) || icon;
          const icx = dp.wx, icy = dp.wy, icz = dp.wz;
          // semi/fullモードは仕切りに遮蔽されない新仕様（_iconOnlyMode前提でこの分岐に来ている
          // 時点でboxアイコンなので、旧来の「仕切りに隠れたらBox自体を非ラスタライズ」判定は撤去）
          const isSel = icon.id === selectedIconId || icon.id === hoveredIconId;
          const isChecked = selectedIconIds && selectedIconIds.has(icon.id);
          const isReord = iconReorderPreview && icon.id === selectedIconId;
          const base = isReord ? [217,119,6] : (isSel ? [59,130,246] : pdcIconBaseRGB(icon.iconColor));
          // 形状・カリング・面色は共通コア。Zバッファ枝は rgb だけ使い枠線は描かない
          const _zbView = {
            proj: projR,
            isBackFacing: (n) => panelIsBackFacing(n, az, el),
            nearSign: +1, lwUnit: 1,
          };
          const _zbFaces = pdcCollectIconBoxFaces(
            _zbView, icx, icy, icz, dp.subCellBox || icon.cellBox, icon.face || 'front', base);
          _zbFaces.forEach(f => {
            const pts = f.pts, r = f.rgb[0], g = f.rgb[1], b = f.rgb[2];
            _rasterTri(_dTarget, _zbTarget, Wr, Hr, pts[0], pts[1], pts[2], r, g, b);
            _rasterTri(_dTarget, _zbTarget, Wr, Hr, pts[0], pts[2], pts[3], r, g, b);
          });
        });

        // マージ+zbUpdate: 1ループで統合（ピクセルマージとzb更新を同時処理）
        for (let i = 0; i < _n; i++) {
          const i4 = i * 4;
          const hasG = dGroup[i4+3] > 0, hasS = dSingle[i4+3] > 0;
          if (hasG || hasS) {
            if (hasG && hasS) {
              const src = zbSingle[i] >= zbGroup[i] ? dSingle : dGroup;
              d[i4]=src[i4]; d[i4+1]=src[i4+1]; d[i4+2]=src[i4+2]; d[i4+3]=src[i4+3];
            } else if (hasG) {
              d[i4]=dGroup[i4]; d[i4+1]=dGroup[i4+1]; d[i4+2]=dGroup[i4+2]; d[i4+3]=dGroup[i4+3];
            } else {
              d[i4]=dSingle[i4]; d[i4+1]=dSingle[i4+1]; d[i4+2]=dSingle[i4+2]; d[i4+3]=dSingle[i4+3];
            }
          }
          const gz = zbGroup[i], sz = zbSingle[i];
          if (gz > zb[i]) zb[i] = gz;
          if (sz > zb[i]) zb[i] = sz;
        }
        // 全透過モード用: アイコンBoxのみのZバッファ（仕切り深度を含まない）
        if (iconVisMode === 'full') {
          const _zbIO = _bufs.zbIconOnly;
          for (let i = 0; i < _n; i++) {
            const gz = _bufs.zbGroup[i], sz = _bufs.zbSingle[i];
            _zbIO[i] = gz > sz ? gz : sz;
          }
        }
      }
      // ── アイコンBoxバイナリマスク生成（destination-out用: alpha=255のみ, CPU構築） ──
      // _iconOnlyMode/doorsVisible=false/transparency>0 いずれでも構築しケーブル遮蔽に使う
      if (true) {
        let _iMaskCvs = _iconMaskCvsRef.current;
        if (!_iMaskCvs || _iMaskCvs.width !== Wr || _iMaskCvs.height !== Hr) {
          _iMaskCvs = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(Wr, Hr)
            : Object.assign(document.createElement('canvas'), {width:Wr,height:Hr});
          _iconMaskCvsRef.current = _iMaskCvs;
        }
        const _maskBuf = new Uint8ClampedArray(_n * 4);
        const _dG = _bufs.dGroup, _dS = _bufs.dSingle;
        for (let i = 0; i < _n; i++) {
          if (_dG[i*4+3] > 0 || _dS[i*4+3] > 0) _maskBuf[i*4+3] = 255;
        }
        _iMaskCvs.getContext('2d').putImageData(new ImageData(_maskBuf, Wr, Hr), 0, 0);
      }

      // ── スナップドット Zバッファ直接ラスタライズ ──
      // putImageData前に描くことでアイコンBox/仕切りと同じ深度テストを受ける
      if ((_cableEditModeRef.current || iconMoveDragRef.current) && chambers.length > 0) {
        const _DOT_R = 4, _DR2 = _DOT_R * _DOT_R;
        const _iconPtsZb = (_panelDispMode0 === 'box')
          ? (panel.placedIcons || []).filter(ic => ic.wx != null) : [];
        const _blendDot = (pidx, a255) => {
          const i4 = pidx * 4, f = a255 / 255, fi = 1 - f;
          d[i4]   = Math.round(d[i4]   * fi + 251 * f);
          d[i4+1] = Math.round(d[i4+1] * fi + 191 * f);
          d[i4+2] = Math.round(d[i4+2] * fi +  36 * f);
          d[i4+3] = Math.min(255, d[i4+3] + a255);
        };
        const _drawDotZb = (wx, wy, wz, alpha) => {
          const _p = projR(wx, wy, wz);
          for (let dy = -_DOT_R; dy <= _DOT_R; dy++) {
            for (let dx = -_DOT_R; dx <= _DOT_R; dx++) {
              if (dx*dx + dy*dy > _DR2) continue;
              const px = Math.round(_p.x + dx), py = Math.round(_p.y + dy);
              if (px < 0 || px >= Wr || py < 0 || py >= Hr) continue;
              const pidx = py * Wr + px;
              if (_p.depth < zb[pidx]) continue; // Z-テスト失敗=遮蔽
              _blendDot(pidx, alpha);
            }
          }
        };
        for (const ch of chambers) {
          const _cells = ch.cells || [];
          if (!_cells.length) continue;
          const _cxMin = Math.min(..._cells.map(c => c.xMin));
          const _cxMax = Math.max(..._cells.map(c => c.xMax));
          const _cyMin = Math.min(..._cells.map(c => c.yMin));
          const _cyMax = Math.max(..._cells.map(c => c.yMax));
          const _czMin = Math.min(..._cells.map(c => c.zMin));
          const _czMax = Math.max(..._cells.map(c => c.zMax));
          if (_iconPtsZb.some(ic =>
            ic.wx >= _cxMin && ic.wx <= _cxMax &&
            ic.wy >= _cyMin && ic.wy <= _cyMax &&
            ic.wz >= _czMin && ic.wz <= _czMax
          )) continue;
          // 分割セル個別中心 — 薄いオレンジ●
          for (const cell of _cells) {
            _drawDotZb(
              (cell.xMin + cell.xMax) / 2, (cell.yMin + cell.yMax) / 2,
              (cell.zMin + cell.zMax) / 2, 40
            );
          }
          // 区画統合中心 — 強いオレンジ●
          _drawDotZb(
            (_cxMin + _cxMax) / 2, (_cyMin + _cyMax) / 2, (_czMin + _czMax) / 2, 120
          );
        }
        // 仮想Y統合スナップ点
        const _pYPos = (panel.partitions || [])
          .filter(pt => pt.axis === 'y' && pt.posMm != null &&
            (pt.uMinMm > 0 || (pt.uMaxMm != null && pt.uMaxMm < panel.widthMm)))
          .map(pt => pt.posMm);
        if (_pYPos.length > 0) {
          const _vcMapZb = new Map();
          for (const ch of chambers) {
            for (const cell of (ch.cells || [])) {
              const _vk = `${cell.xMin},${cell.xMax},${cell.zMin},${cell.zMax}`;
              if (!_vcMapZb.has(_vk)) _vcMapZb.set(_vk, []);
              _vcMapZb.get(_vk).push({ yMin: cell.yMin, yMax: cell.yMax });
            }
          }
          for (const py of _pYPos) {
            for (const [key, yCells] of _vcMapZb) {
              const _fc = yCells.find(c => c.yMax === py);
              const _bc = yCells.find(c => c.yMin === py);
              if (!_fc || !_bc) continue;
              const [_vxMin, _vxMax, _vzMin, _vzMax] = key.split(',').map(Number);
              _drawDotZb(
                (_vxMin + _vxMax) / 2, (_fc.yMin + _bc.yMax) / 2,
                (_vzMin + _vzMax) / 2, 120
              );
            }
          }
        }
      }
      // ── ケーブル可視マスクラスタライズ（共通コア pdcBuildCableVisMask が唯一の正）──
      // 仕切り/アイコンBoxのZバッファで配線セグメントの補間深度をテストし、cableVisに白を書く。
      // 遮蔽対象の選択規則も共通コア（pdcCableOccluderKinds）に持たせて3次元図と共有する。
      if (_cRouteMap.size > 0) {
        // 全透過モード: 仕切りは透過するためアイコンBoxのみでテスト。それ以外は仕切り+アイコンBox両方でテスト
        const _occKinds = pdcCableOccluderKinds(iconVisMode);
        const _zbCv = _occKinds.partitions ? zb : _bufs.zbIconOnly;
        const _skipCIdMask = (_wpDragRef.current && _cableEditModeRef.current) ? _cableEditModeRef.current.cableId : null;
        const _skipTIdMask = _wpDragRef.current?.tapCableId ?? null;
        const _maskEntries = [];
        for (const cable of cables) {
          if (cable.id === _skipCIdMask || cable.id === _skipTIdMask) continue;
          const _cr = _cRouteMap.get(cable.id); if (!_cr) continue;
          _maskEntries.push({ pts2d: _cr.pts2d, outerWidth: pdcCableStyle(cable).outerWidth });
        }
        // Wr×Hrキャンバス上のマスク幅: _scaleR倍してスケールアップ後に正しい太さになるようにする
        // エディタ規約は nearSign=+1（depth大=手前）なので depth 変換は恒等
        pdcBuildCableVisMask(_maskEntries, _zbCv, cableVis, Wr, Hr, _scaleR * _cableWidthFactor, +1);
      }
      partZb = zb; // 仕切り＋アイコンBox深度（ケーブル深度は含まない）
      offCtx.putImageData(imgData, 0, 0);
      // ── 滑らかケーブル合成（big-if実行時）──
      if (_cRouteMap.size > 0) {
        let _cvMaskCvs = _cvMaskCvsRef.current;
        if (!_cvMaskCvs || _cvMaskCvs.width !== Wr || _cvMaskCvs.height !== Hr) {
          _cvMaskCvs = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(Wr, Hr)
            : Object.assign(document.createElement('canvas'), {width:Wr,height:Hr});
          _cvMaskCvsRef.current = _cvMaskCvs;
        } else { _cvMaskCvs.width = Wr; }
        _cvMaskCvsRef.current.getContext('2d').putImageData(new ImageData(cableVis, Wr, Hr), 0, 0);
        let _cvSmthCvs = _cvSmthCvsRef.current;
        if (!_cvSmthCvs || _cvSmthCvs.width !== Wr || _cvSmthCvs.height !== Hr) {
          _cvSmthCvs = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(Wr, Hr)
            : Object.assign(document.createElement('canvas'), {width:Wr,height:Hr});
          _cvSmthCvsRef.current = _cvSmthCvs;
        } else { _cvSmthCvs.width = Wr; }
        const _cvSmthCtx = _cvSmthCvs.getContext('2d');
        _cvSmthCtx.lineJoin='round'; _cvSmthCtx.lineCap='round'; _cvSmthCtx.setLineDash([]);
        const _skipCIdSmth = (_wpDragRef.current && _cableEditModeRef.current) ? _cableEditModeRef.current.cableId : null;
        const _skipTIdSmth = _wpDragRef.current?.tapCableId ?? null;
        const _drawGroups = new Map();
        for (const [root, members] of _wsAutoGroups) {
          const filtered = members.filter(({cable}) => cable.id !== _skipCIdSmth && cable.id !== _skipTIdSmth);
          if (filtered.length > 0) _drawGroups.set(root, filtered);
        }
        // チェーン構築・パス生成・二重ストロークは共通コアが唯一の正（pdcBuildCableChains / pdcPaintCableChains）
        // 半解像度キャンバス上での線幅は _scaleR 倍して、スケールアップ後に正しい太さになるようにする
        for (const members of _drawGroups.values()) {
          pdcPaintCableChains(_cvSmthCtx, pdcBuildCableChains(members), pdcCableStyle(members[0].cable),
            { widthScale: _scaleR * _cableWidthFactor, alpha: PDC_CABLE_STROKE_ALPHA });
        }
        // cableVis: Zバッファ（仕切り＋アイコンBox深度）でテストしたピクセルのみ残す
        // → アイコンBoxより手前にある配線のみ描画される（真のZ位置関係）
        _cvSmthCtx.globalCompositeOperation='destination-in'; _cvSmthCtx.globalAlpha=1;
        _cvSmthCtx.drawImage(_cvMaskCvsRef.current,0,0); _cvSmthCtx.globalCompositeOperation='source-over';
        _cvSmthCvsForDraw = _cvSmthCvs;
      }
      // _iconOnlyMode: アイコンBoxをスナップショットcanvasにGPU-to-GPUコピーして保存
      // ※Step3.5の扉描画がoffscreenを上書きするため別canvasに退避が必要
      // ※CPU memcpy(3.2MB/frame)を避けるためGPU drawImageを使用
      if (_iconOnlyMode) {
        let snapC = _snapCanvasRef.current;
        if (!snapC || snapC.width !== Wr || snapC.height !== Hr) {
          snapC = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(Wr, Hr)
            : Object.assign(document.createElement('canvas'), { width: Wr, height: Hr });
          _snapCanvasRef.current = snapC;
        }
        const snapCtx2 = snapC.getContext('2d');
        snapCtx2.clearRect(0, 0, Wr, Hr);
        snapCtx2.drawImage(offscreen, 0, 0);
        _iconBoxSnapshot = snapC;
      }

      if (!_iconOnlyMode) {
        // ═══ opaqueモード（機器不透過）: 従来ロジックのまま（回帰防止のため一切変更しない）═══
        if (transparency > 0) {
          // 外箱の透明度に反比例: 外箱が99%不透明なら仕切りも1%しか見えない（共通コア）
          ctx.globalAlpha = pdcInteriorAlpha(transparency, solidAlpha);
          ctx.drawImage(offscreen, 0, 0, W, H);
          ctx.globalAlpha = 1;
        } else if (!doorsVisible) {
          // 扉非表示+透明度0%: クリップなしで内部全体を表示
          ctx.drawImage(offscreen, 0, 0, W, H);
        } else if (openDoorOpenings.length > 0) {
          // 透明度0%: 開扉の開口部だけにクリップして100%で合成
          ctx.save();
          ctx.beginPath();
          for (const pts of openDoorOpenings) {
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath();
          }
          ctx.clip();
          ctx.drawImage(offscreen, 0, 0, W, H);
          ctx.restore();
        } else if (!_cableXrayMode) {
          ctx.drawImage(offscreen, 0, 0, W, H);
        }
        // _cableXrayMode で密閉（透明度0・扉表示中・開扉なし）のときは何も描かない。
        // 配線のためだけにbig-ifへ入っているので、仕切りを100%で描くと密閉箱が透けて見える回帰になる
      } else {
        // ═══ X線モード（機器半透過/全透過）: 新仕様 ═══
        // 仕切りは透明度に関わらず「扉の開口部からしか見えない」。
        // 透明度は開口部内の濃さ（interiorA）だけに効く。
        // アイコンBoxはここでは描かず、扉描画後に最上層として合成する（層4）。
        // ※ _iconBoxSnapshot 退避は上で済ませてあるので offscreen を上書きしてよい
        offCtx.putImageData(new ImageData(_bufs.partDoorImg, Wr, Hr), 0, 0);
        const interiorA = pdcInteriorAlpha(transparency, solidAlpha); // 透明度0なら1.0
        if (!doorsVisible) {
          // 扉表示オフ: 開口部の概念が無いのでクリップなしで仕切り全体を表示
          ctx.globalAlpha = interiorA;
          ctx.drawImage(offscreen, 0, 0, W, H);
          ctx.globalAlpha = 1;
        } else if (openDoorOpenings.length > 0) {
          // 扉表示中 + 開扉あり: 透明度に関わらず常に開口部クリップ
          ctx.save();
          ctx.beginPath();
          for (const pts of openDoorOpenings) {
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath();
          }
          ctx.clip();
          ctx.globalAlpha = interiorA;
          ctx.drawImage(offscreen, 0, 0, W, H);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        // else: 扉表示中で開扉なし → 仕切りは完全に非表示（何も描かない）
      }
      } // if (transparency > 0 || openDoors) Step 2


      // ── ケーブル描画: offscreen（仕切り・外箱）の後に描くことで仕切りが前面に来る ──
      // 非X線モード: cableVisマスク済み配線をctxへ（Zバッファによる真の前後関係）
      if (_cvSmthCvsForDraw && !_cableXrayMode) {
        ctx.globalAlpha = 1;
        // transparency=0 + 開扉あり → 扉開口部のみにクリップ（壁越し非表示）
        if (transparency === 0 && openDoorOpenings.length > 0) {
          ctx.save();
          ctx.beginPath();
          for (const pts of openDoorOpenings) {
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath();
          }
          ctx.clip();
          ctx.drawImage(_cvSmthCvsForDraw, 0, 0, W, H);
          ctx.restore();
        } else {
          ctx.drawImage(_cvSmthCvsForDraw, 0, 0, W, H);
        }
      }

      // ── Step 1.5: Chamber 外壁面を区画色で半透明塗り ──
      // 仕切りZバッファ合成(drawImage)の後に描くことで、外壁が内部仕切りより前面に表示される
      // visWalls: hoverChamberId（amber）にも使うので showChamberColors 外で計算
      const _cableModeActive = !!_cableAddModeRef.current;
      const _needWalls = (showChamberColors || (hoverChamberId && !iconDragPreview && !_cableModeActive)) && chambers.length > 0;
      let visWalls = [];
      if (_needWalls) {
        const PW = panel.widthMm, PH = panel.heightMm, PD = panel.depthMm;
        const eps = 0.5;
        const WALLS = [
          { n:{nx:0,ny:-1,nz:0}, rep:{x:PW/2,y:0,   z:PH/2}, flt:c=>c.yMin<=eps,    pts:c=>[{x:c.xMin,y:0,  z:c.zMin},{x:c.xMax,y:0,  z:c.zMin},{x:c.xMax,y:0,  z:c.zMax},{x:c.xMin,y:0,  z:c.zMax}] },
          { n:{nx:0,ny:+1,nz:0}, rep:{x:PW/2,y:PD,  z:PH/2}, flt:c=>c.yMax>=PD-eps, pts:c=>[{x:c.xMin,y:PD, z:c.zMin},{x:c.xMax,y:PD, z:c.zMin},{x:c.xMax,y:PD, z:c.zMax},{x:c.xMin,y:PD, z:c.zMax}] },
          { n:{nx:-1,ny:0,nz:0}, rep:{x:0,  y:PD/2, z:PH/2}, flt:c=>c.xMin<=eps,    pts:c=>[{x:0,  y:c.yMin,z:c.zMin},{x:0,  y:c.yMax,z:c.zMin},{x:0,  y:c.yMax,z:c.zMax},{x:0,  y:c.yMin,z:c.zMax}] },
          { n:{nx:+1,ny:0,nz:0}, rep:{x:PW, y:PD/2, z:PH/2}, flt:c=>c.xMax>=PW-eps, pts:c=>[{x:PW, y:c.yMin,z:c.zMin},{x:PW, y:c.yMax,z:c.zMin},{x:PW, y:c.yMax,z:c.zMax},{x:PW, y:c.yMin,z:c.zMax}] },
          { n:{nx:0,ny:0,nz:-1}, rep:{x:PW/2,y:PD/2,z:0   }, flt:c=>c.zMin<=eps,    pts:c=>[{x:c.xMin,y:c.yMin,z:0  },{x:c.xMax,y:c.yMin,z:0  },{x:c.xMax,y:c.yMax,z:0  },{x:c.xMin,y:c.yMax,z:0  }] },
          { n:{nx:0,ny:0,nz:+1}, rep:{x:PW/2,y:PD/2,z:PH  }, flt:c=>c.zMax>=PH-eps, pts:c=>[{x:c.xMin,y:c.yMin,z:PH},{x:c.xMax,y:c.yMin,z:PH},{x:c.xMax,y:c.yMax,z:PH},{x:c.xMin,y:c.yMax,z:PH}] },
        ];
        visWalls = WALLS
          .filter(w => !panelIsBackFacing(w.n, az, el))
          .map(w => ({ ...w, depth: proj(w.rep.x, w.rep.y, w.rep.z).depth }))
          .sort((a, b) => a.depth - b.depth);
      }
      if (showChamberColors && chambers.length > 0) {
        for (const wall of visWalls) {
          const br = Math.min(panelFaceBrightness(wall.n), 1.3);
          for (const ch of chambers) {
            const [ri,gi,bi] = _hexToRGB(ch.color);
            const r = Math.min(255, Math.round(ri * br));
            const g = Math.min(255, Math.round(gi * br));
            const b = Math.min(255, Math.round(bi * br));
            for (const cell of ch.cells) {
              if (!wall.flt(cell)) continue;
              const pts = wall.pts(cell).map(v => proj(v.x, v.y, v.z));
              ctx.globalAlpha = 0.25;
              ctx.fillStyle = `rgb(${r},${g},${b})`;
              ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
              for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
              ctx.closePath(); ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
      }

      // ホバー区画ハイライト: amber枠 + 白半透明フィル（ドラッグ中・ケーブルモード中は非表示）
      if (hoverChamberId && !iconDragPreview && !_cableModeActive && chambers.length > 0) {
        const hch = chambers.find(c => c.id === hoverChamberId);
        if (hch) {
          for (const wall of visWalls) {
            for (const cell of hch.cells) {
              if (!wall.flt(cell)) continue;
              const pts = wall.pts(cell).map(v => proj(v.x, v.y, v.z));
              ctx.globalAlpha = 0.45;
              ctx.fillStyle = '#FFFFFF';
              ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
              for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
              ctx.closePath(); ctx.fill();
              ctx.globalAlpha = 1;
              ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 2;
              ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
              for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
              ctx.closePath(); ctx.stroke();
            }
          }
          ctx.globalAlpha = 1;
        }
      }

      // ── 選択/ホバーアイコンの住処セルワイヤーフレーム ──
      const _drawIconCellBox = (iconId) => {
        const ic = (panel.placedIcons || []).find(x => x.id === iconId);
        if (!ic || !ic.cellBox) return;
        const iCell = ic.cellBox;
        const bc = [
          proj(iCell.xMin,iCell.yMin,iCell.zMin), proj(iCell.xMax,iCell.yMin,iCell.zMin),
          proj(iCell.xMax,iCell.yMax,iCell.zMin), proj(iCell.xMin,iCell.yMax,iCell.zMin),
          proj(iCell.xMin,iCell.yMin,iCell.zMax), proj(iCell.xMax,iCell.yMin,iCell.zMax),
          proj(iCell.xMax,iCell.yMax,iCell.zMax), proj(iCell.xMin,iCell.yMax,iCell.zMax),
        ];
        const edges12 = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 2; ctx.globalAlpha = 1;
        for (const [a,b] of edges12) {
          ctx.beginPath(); ctx.moveTo(bc[a].x, bc[a].y); ctx.lineTo(bc[b].x, bc[b].y); ctx.stroke();
        }
      };
      if (selectedIconId && !iconDragPreview) _drawIconCellBox(selectedIconId);
      if (hoveredIconId && hoveredIconId !== selectedIconId && !iconDragPreview) _drawIconCellBox(hoveredIconId);

      // ── ドラッグ中の移動先セルワイヤーフレーム（配置計算が決定したcellBoxを直接使用）──
      if (iconDragPreview && iconDragPreview.cellBox) {
        const dCell = iconDragPreview.cellBox;
        const dc = [
          proj(dCell.xMin,dCell.yMin,dCell.zMin), proj(dCell.xMax,dCell.yMin,dCell.zMin),
          proj(dCell.xMax,dCell.yMax,dCell.zMin), proj(dCell.xMin,dCell.yMax,dCell.zMin),
          proj(dCell.xMin,dCell.yMin,dCell.zMax), proj(dCell.xMax,dCell.yMin,dCell.zMax),
          proj(dCell.xMax,dCell.yMax,dCell.zMax), proj(dCell.xMin,dCell.yMax,dCell.zMax),
        ];
        const dedges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 2.5; ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        for (const [a,b] of dedges) {
          ctx.beginPath(); ctx.moveTo(dc[a].x, dc[a].y); ctx.lineTo(dc[b].x, dc[b].y); ctx.stroke();
        }
      }

      // ── Step 2b: 仕切り面エッジ描画 ──
      // opaqueモード: 従来通り（透明度0%でも開扉 or 扉非表示なら描画・クリップは透明度0%時のみ）
      // X線モード:    Step 2 の仕切り本体と同じ可視条件（扉非表示 or 開扉あり）＋常に開口部クリップ
      const _edgeGate = _iconOnlyMode
        ? (!doorsVisible || openDoorOpenings.length > 0)
        : (transparency > 0 || openDoorOpenings.length > 0 || !doorsVisible);
      const _edgeClip = _iconOnlyMode
        ? (doorsVisible && openDoorOpenings.length > 0)
        : (transparency === 0 && doorsVisible);
      if (_edgeGate) {
      if (_edgeClip) {
        ctx.save();
        ctx.beginPath();
        for (const pts of openDoorOpenings) {
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
        }
        ctx.clip();
      }
      // 色・線幅・アルファ式・マスク構築は共通コア（panelDrawCore.js）が唯一の正。
      // 遮蔽側は既存の partOnlyZb（仕切りのみ深度・Wr×Hr）を読み取り専用で流用する。
      // 書き込み先Zバッファは partOnlyZb ではなくエッジ専用スクラッチ（_edgeZbRef）を使うこと。
      // partOnlyZb はこの後アイコン遮蔽・ラベル可視判定で再利用されるため
      // エッジ深度を書き込むと誤判定が起きる。
      const _edgeAlpha = pdcPartitionEdgeAlpha(transparency, solidAlpha);
      if (partOnlyZb) {
        const _nE = Wr * Hr;
        let _eZb = _edgeZbRef.current;
        if (!_eZb || _eZb.length !== _nE) { _eZb = new Float32Array(_nE); _edgeZbRef.current = _eZb; }
        _eZb.fill(-1e9);
        let _eVis = _edgeVisRef.current;
        if (!_eVis || _eVis.length !== _nE * 4) { _eVis = new Uint8ClampedArray(_nE * 4); _edgeVisRef.current = _eVis; }
        else _eVis.fill(0);
        const _edgeViewR = { proj: projR, isBackFacing: pdcView.isBackFacing, nearSign: +1, lwUnit: _scaleR };
        const _edgeSegs = pdcCollectPartitionEdgeSegments(solids, _edgeViewR);
        pdcBuildPartitionEdgeVisMask(
          _edgeSegs, partOnlyZb, _eZb, _eVis, Wr, Hr, _scaleR, +1,
          PDC_PARTITION_EDGE_DEPTH_BIAS_MM * (pdcView.depthPerMm || 1));
        let _eMaskCvs = _edgeMaskCvsRef.current;
        if (!_eMaskCvs || _eMaskCvs.width !== Wr || _eMaskCvs.height !== Hr) {
          _eMaskCvs = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(Wr, Hr)
            : Object.assign(document.createElement('canvas'), { width: Wr, height: Hr });
          _edgeMaskCvsRef.current = _eMaskCvs;
        }
        _eMaskCvs.getContext('2d').putImageData(new ImageData(_eVis, Wr, Hr), 0, 0);
        let _eCvs = _edgeStrokeCvsRef.current;
        if (!_eCvs || _eCvs.width !== Wr || _eCvs.height !== Hr) {
          _eCvs = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(Wr, Hr)
            : Object.assign(document.createElement('canvas'), { width: Wr, height: Hr });
          _edgeStrokeCvsRef.current = _eCvs;
        } else { _eCvs.width = Wr; } // 前フレームの内容をリセット
        const _eCtx = _eCvs.getContext('2d');
        pdcPaintPartitionEdges(_eCtx, solids, _edgeViewR, 1);
        _eCtx.globalCompositeOperation = 'destination-in';
        _eCtx.globalAlpha = 1;
        _eCtx.drawImage(_eMaskCvs, 0, 0);
        _eCtx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = _edgeAlpha;
        ctx.drawImage(_eCvs, 0, 0, W, H);
        ctx.globalAlpha = 1;
      } else {
        // 万一 partOnlyZb が無ければ従来動作（マスクなし）にフォールバック
        pdcPaintPartitionEdges(ctx, solids, pdcView, _edgeAlpha);
        ctx.globalAlpha = 1;
      }
      if (_edgeClip) ctx.restore();
      } // if (_edgeGate) Step 2b

      // ── Step 3: 選択中仕切りのアウトライン（全選択分）＋ ホバー仕切り ──
      const _drawPartOutline = (partId, style) => {
        solids.forEach(solid => {
          if (solid._isOuter || solid._partitionId !== partId) return;
          (solid.faces || []).forEach(f => {
            if (!f.vertices || f.vertices.length < 3) return;
            if (panelIsBackFacing(f.normal, az, el)) return;
            const pts = f.vertices.map(v => proj(v.x, v.y, v.z));
            ctx.strokeStyle = style.color; ctx.lineWidth = style.width; ctx.globalAlpha = 1;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath(); ctx.stroke();
          });
        });
      };
      if (selectedPartitionIds.length) {
        selectedPartitionIds.forEach(pid => _drawPartOutline(pid, { color: '#FBBF24', width: 2 }));
      }
      if (hoveredPartitionId && !selectedPartitionIds.includes(hoveredPartitionId)) {
        _drawPartOutline(hoveredPartitionId, { color: '#FBBF24', width: 2 });
      }

      // ── Step 3.4: 外箱ワイヤーフレーム（扉fillより前に描く / panelDrawCore.js 共通コア）──
      // 扉fillが上から塗ることで、ヒンジ位置のコーナー辺が扉fillに隠れる。
      // 扉wireframeはさらに上（Step 3.5）に描かれ、最終的な重ね順が正しくなる。
      pdcPaintOuterWireframe(ctx, panel, pdcView, transparency);

      // ── Step 3.5: 扉の描画 ──
      // 外箱面（Step 1）の後に描くことで、開扉は常に盤より手前に表示される。
      // 開扉は110°回転でy<0（前面y=0より前）に位置するため、
      // 外箱面より後に描くだけで正しく前面に出る。
      // transparency=0: Z-buffer描画（仕切りと同方式）→ 外箱面との正確な前後関係
      // transparency>0: Painter's Algorithm（半透明）
      const doorHits = [];
      if (doorsVisible) {
        // 収集・ソートは共通コア。ptsR（低解像度rasterizer用）はエディタ固有なので後付け
        const { doorHits: _pdcDoorHits, doorRenderList } = pdcCollectDoors(panel, pdcView);
        doorHits.push(..._pdcDoorHits);
        for (const it of doorRenderList) {
          it.ptsR = it.corners.map(([x,y,z]) => projR(x,y,z)); // rasterizer用(Wr×Hr)
        }
        const _doorCol = panel.color || '#4A90D9';
        const [_dr0, _dg0, _db0] = _hexToRGB(_doorCol);

        if (transparency === 0 && outerZb) {
          // Z-buffer描画: outerZbをベースに扉の前後関係を画素単位で判定
          // 扉ごとに取り付け面の輝度を適用してZ-fightingによる色ムラを防ぐ
          let offscreen = offCanvasRef.current;
          if (!offscreen || offscreen.width !== Wr || offscreen.height !== Hr) {
            offscreen = typeof OffscreenCanvas !== 'undefined'
              ? new OffscreenCanvas(Wr, Hr)
              : Object.assign(document.createElement('canvas'), { width: Wr, height: Hr });
            offCanvasRef.current = offscreen;
          } else {
            offscreen.width = Wr; // リセット
          }
          const offCtx = offscreen.getContext('2d');
          const doorImgData = offCtx.createImageData(Wr, Hr);
          const doorZb = new Float32Array(outerZb); // 外箱面深度をコピー（fill用: 更新あり）
          // 仕切りZバッファをマージ（仕切りが扉fillを遮蔽できるようにする）
          if (partZb) { for (let _i = 0; _i < doorZb.length; _i++) { if (partZb[_i] > doorZb[_i]) doorZb[_i] = partZb[_i]; } }
          // outerZbFullの開口部をパンチアウト（-1e9）:
          // 開口内ピクセルはwireframeが通過できるようにする（扉を通して見える輪郭）
          for (const openingPts of openDoorOpeningsR) {
            _clearZbPoly(outerZbFull, Wr, Hr, openingPts);
          }
          // wireZb: wireframe深度テスト用。パネル面+開口パンチアウト済みから出発し
          // 扉ごとのfillを積算 → 手前扉fillが奥扉wireframeを正しく遮蔽する
          const wireZb = new Float32Array(outerZbFull);
          // 仕切りのみのZバッファをマージ（仕切りがヒンジ線を遮蔽できるようにする）
          // partZb（icon boxes含む）ではなくpartOnlyZbを使用: icon boxが扉wireframeを遮蔽しないようにする
          const _zbForWire = partOnlyZb || partZb;
          if (_zbForWire) { for (let _i = 0; _i < wireZb.length; _i++) { if (_zbForWire[_i] > wireZb[_i]) wireZb[_i] = _zbForWire[_i]; } }
          const _zbDummy = new Uint8ClampedArray(Wr * Hr * 4);
          // fill → wireframe → wireZb更新 を扉ごとにインターリーブ
          // （奥→手前の順なので手前fill描画後にwireZbを更新すれば次の扉には影響しない）
          for (const { door: dItem, ptsR } of doorRenderList) {
            const n = ptsR.length;
            // 1. fill描画
            const mountN = _DOOR_MOUNT_NORMALS[dItem.face] || {nx:0,ny:-1,nz:0};
            const br = Math.min(panelFaceBrightness(mountN), 1.5);
            const dr = Math.min(255, Math.round(_dr0 * br));
            const dg = Math.min(255, Math.round(_dg0 * br));
            const db = Math.min(255, Math.round(_db0 * br));
            for (let i = 1; i < ptsR.length - 1; i++) {
              _rasterTri(doorImgData.data, doorZb, Wr, Hr, ptsR[0], ptsR[i], ptsR[i + 1], dr, dg, db);
            }
            // 2. wireframe描画（wireZb = パネル面 + この扉より奥のfill深度）
            if (dItem.isOpen) {
              // ヒンジ辺はパネル取り付け面と同一平面上にあるため wireZb と depth が一致し
              // 通常の深度テストでスキップされる。bias=-2 でz-ファイティングのみ回避（背面壁は正しく遮蔽）。
              // effSide='left' → ヒンジ辺 i=3 (ptsR[3]→ptsR[0])
              // effSide='right' → ヒンジ辺 i=1 (ptsR[1]→ptsR[2])
              const _hFlipO = new Set(['back','left','bottom']);
              const effSideO = _hFlipO.has(dItem.face)
                ? (dItem.hingeSide === 'right' ? 'left' : 'right')
                : (dItem.hingeSide || 'left');
              const hingeEdgeIdx = effSideO === 'right' ? 1 : 3;
              for (let i = 0; i < n; i++) {
                const bias = i === hingeEdgeIdx ? -2 : 1.0;
                _rasterLine(doorImgData.data, wireZb, Wr, Hr, ptsR[i], ptsR[(i + 1) % n], 100, 150, 255, bias);
              }
            } else {
              // 閉扉: 取り付け面除外のouterZbを使用（同一面上でwireframeが通過できる）
              for (let i = 0; i < n; i++) {
                _rasterLine(doorImgData.data, outerZb, Wr, Hr, ptsR[i], ptsR[(i + 1) % n], 100, 150, 255, 0);
              }
            }
            // 3. wireZbにこの扉のfill深度を積算（以降の扉はこの扉のfillで遮蔽される）
            for (let i = 1; i < ptsR.length - 1; i++) {
              _rasterTri(_zbDummy, wireZb, Wr, Hr, ptsR[0], ptsR[i], ptsR[i + 1], 0, 0, 0);
            }
          }
          offCtx.putImageData(doorImgData, 0, 0);
          ctx.drawImage(offscreen, 0, 0, W, H);
        } else {
          // 半透明: Painter's Algorithm（panelDrawCore.js 共通コア）
          pdcPaintDoorsTranslucent(ctx, doorRenderList, panel.color, solidAlpha, pdcView);
        }

        const _drawDoorOutline = (doorId) => {
          const hit = doorHits.find(dh => dh.door.id === doorId);
          if (!hit) return;
          ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 2; ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.moveTo(hit.pts[0].x, hit.pts[0].y);
          for (let i=1; i<hit.pts.length; i++) ctx.lineTo(hit.pts[i].x, hit.pts[i].y);
          ctx.closePath(); ctx.stroke();
        };
        if (selectedDoorId) _drawDoorOutline(selectedDoorId);
        if (hoveredDoorId && hoveredDoorId !== selectedDoorId) _drawDoorOutline(hoveredDoorId);

        // 開扉の開口部矩形（閉じていたときの位置）を青線で描画（panelDrawCore.js 共通コア）
        pdcPaintDoorOpenings(ctx, panel, pdcView);
      }
      doorHitRef.current = doorHits;

      // y軸仕切りによる遮蔽判定（スナップ点用・cellsを渡すとy結合区画チェックも行う）
      const _isOccluded3D = (wx, wy, wz, cells = null) => {
        for (const pt of (panel.partitions || [])) {
          if (pt.posMm == null || pt.axis !== 'y') continue;
          const _u0 = pt.uMinMm ?? 0, _u1 = pt.uMaxMm ?? panel.widthMm;
          const _v0 = pt.vMinMm ?? 0, _v1 = pt.vMaxMm ?? panel.heightMm;
          if (wx < _u0 || wx > _u1 || wz < _v0 || wz > _v1) continue;
          const _depthP = proj(wx, wy, wz).depth;
          const _depthW = proj(wx, pt.posMm, wz).depth;
          if (_depthP >= _depthW) continue;
          if (cells) {
            const _hasNearSide = cells.some(cell => {
              const _cellMidY = (cell.yMin + cell.yMax) / 2;
              return proj(wx, _cellMidY, wz).depth > _depthW;
            });
            if (_hasNearSide) continue;
          }
          return true;
        }
        return false;
      };

      // ── Step 3.7: ケーブルルート描画（黒線＋カラー枠線・WireSet単位で統一）──
      let _editCablePts3d = null;
      if (cablesVisible && cables && cables.length > 0) {
        // pts3d/pts2d を事前計算（経路構築は共通コア・こちらは全解像度 proj で投影）
        const _cEntry = new Map(); // cableId → { pts3d, pts2d, cable }
        for (const _r of pdcBuildCableRoutes(panel, chambers, { proj }, cables)) {
          _cEntry.set(_r.cable.id, _r);
          if (_cableEditModeRef.current?.cableId === _r.cable.id) _editCablePts3d = _r.pts3d;
        }

        // ドラッグ中は編集対象ケーブルをStep3.7の通常描画からスキップ（Step3.77の点線プレビューのみ表示）
        const _skipCableId = (_wpDragRef.current && _cableEditModeRef.current)
          ? _cableEditModeRef.current.cableId : null;

        ctx.setLineDash([]); ctx.globalAlpha = 1;

        // ラベル描画（枠線色で表示）
        for (const [, { pts3d, cable }] of _cEntry) {
          if (!cable.label) continue;
          if (cable.id === _skipCableId) continue;
          const _mid2 = proj(pts3d[Math.floor(pts3d.length / 2)].wx, pts3d[Math.floor(pts3d.length / 2)].wy, pts3d[Math.floor(pts3d.length / 2)].wz);
          ctx.save();
          ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
          ctx.lineWidth = 3; ctx.strokeStyle = '#1E293B';
          ctx.strokeText(cable.label, _mid2.x, _mid2.y - 7);
          ctx.fillStyle = pdcCableStyle(cable).color;
          ctx.fillText(cable.label, _mid2.x, _mid2.y - 7);
          ctx.restore();
        }

        // ── ホバー/選択ケーブルのハイライト描画（枠のみオレンジ）──
        // hoveredCableIdが削除済みの場合は無視してselectedCableIdを使う
        const _hovValid = hoveredCableId && _cRouteMap.has(hoveredCableId) ? hoveredCableId : null;
        const _highlightCableId = _hovValid || selectedCableId;
        if (_highlightCableId) {
          const _he = _cEntry.get(_highlightCableId) || (() => {
            // _cEntryにない場合は_cRouteMapからフォールバック
            const _r = _cRouteMap.get(_highlightCableId);
            if (!_r || !_r.pts2d || _r.pts2d.length < 2) return null;
            return { pts2d: _r.pts2d, cable: _r.cable };
          })();
          if (_he) {
            const _hcs = pdcCableStyle(_he.cable);
            const _outerW = _hcs.outerWidth;
            const _drawPath = (tCtx) => {
              tCtx.beginPath(); tCtx.moveTo(_he.pts2d[0].x, _he.pts2d[0].y);
              for (let _i = 1; _i < _he.pts2d.length; _i++) tCtx.lineTo(_he.pts2d[_i].x, _he.pts2d[_i].y);
              tCtx.stroke();
            };
            // 外側オレンジリング（+4px分だけ広い）
            ctx.save();
            ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = _outerW + 4;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
            ctx.globalAlpha = 1.0; _drawPath(ctx); ctx.restore();
            // ケーブル本来の枠線色で内側を上書き（枠のみオレンジに見せる）
            ctx.save();
            ctx.strokeStyle = _hcs.color; ctx.lineWidth = _outerW;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
            ctx.globalAlpha = PDC_CABLE_STROKE_ALPHA; _drawPath(ctx); ctx.restore();
            // 内側の線色
            ctx.save();
            ctx.strokeStyle = _hcs.lineColor; ctx.lineWidth = _hcs.innerWidth;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
            ctx.globalAlpha = 1.0; _drawPath(ctx); ctx.restore();
          }
        }

        // ── Step 3.75: 配置編集モード — 母線端点○ + タップ端点□ ──
        const _cem = _cableEditModeRef.current;
        if (_cem && _editCablePts3d && _editCablePts3d.length >= 2) {
          const _ecable = _cablesRef.current.find(c => c.id === _cem.cableId);
          const _editColor = pdcCableStyle(_ecable).color;
          // 母線の from/to 端点：白○
          const _fiE = (panel.placedIcons || []).find(ic => ic.id === _ecable?.fromIconId);
          const _fwxE = _ecable?.fromWx ?? _fiE?.wx;
          const _tiE = (panel.placedIcons || []).find(ic => ic.id === _ecable?.toIconId);
          const _twxE = _ecable?.toWx ?? _tiE?.wx;
          const _endpointIdxs = [];
          if (_fwxE != null) _endpointIdxs.push(0);
          if (_twxE != null) _endpointIdxs.push(_editCablePts3d.length - 1);
          if (_endpointIdxs.length > 0) {
            ctx.save();
            _endpointIdxs.forEach(_pi => {
              const _p2 = proj(_editCablePts3d[_pi].wx, _editCablePts3d[_pi].wy, _editCablePts3d[_pi].wz);
              const _HS = 5;
              ctx.fillStyle = '#FFFFFF'; ctx.fillRect(_p2.x - _HS, _p2.y - _HS, _HS*2, _HS*2);
              ctx.strokeStyle = _editColor; ctx.lineWidth = 2; ctx.strokeRect(_p2.x - _HS, _p2.y - _HS, _HS*2, _HS*2);
            });
            ctx.restore();
          }
          // 同wiresetId のタップ端点：白□
          if (_ecable?.wiresetId) {
            const _tapCables = _cablesRef.current.filter(c => c.wiresetId === _ecable.wiresetId && c.id !== _ecable.id);
            ctx.save();
            for (const _tc of _tapCables) {
              const _endPts = [];
              if (_tc.fromWx != null) _endPts.push({ wx: _tc.fromWx, wy: _tc.fromWy, wz: _tc.fromWz, endType: 'from', cableId: _tc.id });
              if (_tc.toWx != null)   _endPts.push({ wx: _tc.toWx,   wy: _tc.toWy,   wz: _tc.toWz,   endType: 'to',   cableId: _tc.id });
              for (const _ep of _endPts) {
                const _p2 = proj(_ep.wx, _ep.wy, _ep.wz);
                const _HS = 5;
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(_p2.x - _HS, _p2.y - _HS, _HS * 2, _HS * 2);
                ctx.strokeStyle = _editColor; ctx.lineWidth = 2;
                ctx.strokeRect(_p2.x - _HS, _p2.y - _HS, _HS * 2, _HS * 2);
              }
            }
            ctx.restore();
          }
        }
      }

      // ── partZb===null（big-if未実行）かつ非X線モード: ケーブル直接描画 ──
      // 機器3D:OFF/非表示 + 扉表示中 でbig-ifをスキップした場合
      // 透明度0かつ機器不透過モード(opaque): 外箱が完全不透過 → 配線は扉に隠れるべきなので描画しない
      // 機器半透過/全透過モード(semi/full): 箱の中を見る意図があるため透明度に関係なく表示
      if (partZb === null && !_cableXrayMode && cablesVisible && _cRouteMap.size > 0 && (transparency > 0 || iconVisMode !== 'opaque')) {
        const _tmpCv2 = new OffscreenCanvas(Wr, Hr);
        const _tmpCtx2 = _tmpCv2.getContext('2d');
        _tmpCtx2.lineJoin = 'round'; _tmpCtx2.lineCap = 'round'; _tmpCtx2.setLineDash([]);
        // Wireセット単位でチェーン化してから二重ストローク（共通コア）
        for (const members of _wsAutoGroups.values()) {
          pdcPaintCableChains(_tmpCtx2, pdcBuildCableChains(members), pdcCableStyle(members[0].cable),
            { widthScale: _scaleR * _cableWidthFactor, alpha: 1 });
        }
        ctx.save();
        ctx.globalAlpha = PDC_CABLE_COMPOSITE_ALPHA;
        ctx.drawImage(_tmpCv2, 0, 0, W, H);
        ctx.restore();
      }

      // ── partZb===null時のケーブルハイライト（_cRouteMapを使用、big-if未実行時） ──
      if (partZb === null && cablesVisible && _cRouteMap.size > 0) {
        const _hovValid2 = hoveredCableId && _cRouteMap.has(hoveredCableId) ? hoveredCableId : null;
        const _hlId2 = _hovValid2 || selectedCableId;
        if (_hlId2) {
          const _hlE2 = _cRouteMap.get(_hlId2);
          if (_hlE2 && _hlE2.pts2d && _hlE2.pts2d.length >= 2) {
            const _pts = _hlE2.pts2d;
            const _hcs2 = pdcCableStyle(_hlE2.cable);
            const _outerW2 = _hcs2.outerWidth * _scaleR;
            const _drawHL = (tCtx) => {
              tCtx.beginPath(); tCtx.moveTo(_pts[0].x, _pts[0].y);
              for (let _i = 1; _i < _pts.length; _i++) tCtx.lineTo(_pts[_i].x, _pts[_i].y);
              tCtx.stroke();
            };
            ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
            ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = _outerW2 + 4; ctx.globalAlpha = 1.0; _drawHL(ctx);
            ctx.strokeStyle = _hcs2.color; ctx.lineWidth = _outerW2; ctx.globalAlpha = PDC_CABLE_STROKE_ALPHA; _drawHL(ctx);
            ctx.strokeStyle = _hcs2.lineColor; ctx.lineWidth = _hcs2.innerWidth * _scaleR; ctx.globalAlpha = 1.0; _drawHL(ctx);
            ctx.restore();
          }
        }
      }

      // ── X線モード: 描画順 = アイコンBox(60%) → 配線(45%) ──
      // cableVisマスクでアイコンBoxより手前の配線のみ残っているため、真のZ位置関係で表現される
      // アイコンBoxより奥にある配線はcableVisで0にされており描画されない

      // 1) アイコンBoxを先に描画（奥にあるBoxは配線に隠れる）
      //    透明度・開扉の有無に関わらず常に合成（仕切り・扉に遮蔽されない＝新仕様）
      if (_iconOnlyMode && _iconBoxSnapshot) {
        ctx.globalAlpha = PDC_ICONONLY_COMPOSITE_ALPHA;
        ctx.drawImage(_iconBoxSnapshot, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }

      // 2) 配線をアイコンBoxの上に描画（手前にある配線だけcableVisで残っている）
      //    box iconの有無を問わず semi/full なら常にX線合成（配線の見た目は表示方式に依存しない）
      if (_cableXrayMode && cablesVisible && _cRouteMap.size > 0) {
        if (_cvSmthCvsForDraw) {
          ctx.save();
          ctx.globalAlpha = PDC_CABLE_COMPOSITE_ALPHA;
          ctx.drawImage(_cvSmthCvsForDraw, 0, 0, W, H);
          ctx.restore();
        } else {
          // fallback: smooth canvas未構築時もWireセット単位でチェーン化して二重ストローク（共通コア）
          const _tmpCv = new OffscreenCanvas(Wr, Hr);
          const _tmpCtx = _tmpCv.getContext('2d');
          _tmpCtx.lineJoin = 'round'; _tmpCtx.lineCap = 'round'; _tmpCtx.setLineDash([]);
          for (const members of _wsAutoGroups.values()) {
            pdcPaintCableChains(_tmpCtx, pdcBuildCableChains(members), pdcCableStyle(members[0].cable),
              { widthScale: _scaleR * _cableWidthFactor, alpha: 1 });
          }
          ctx.save();
          ctx.globalAlpha = PDC_CABLE_COMPOSITE_ALPHA;
          ctx.drawImage(_tmpCv, 0, 0, W, H);
          ctx.restore();
        }
      }

      // ── Step 3.76: 配置編集モード / アイコンドラッグ — オレンジ●常時表示 + 最近傍確定 ──
      {
        const _cemD = _cableEditModeRef.current;
        const _isIconDrag = !!iconMoveDragRef.current;
        const _cur = _isIconDrag ? _iconDragCursorRef.current : _editCursorRef.current;
        if ((_cemD || _isIconDrag) && chambers.length > 0) {
          const _modeA = iconVisMode === 'opaque' ? 1.0 : iconVisMode === 'full' ? 0.35 : 0.6;
          // アイコンボックスの3D範囲を事前収集（ジオメトリ判定用）
          const _boxExtents = (_panelDispMode0 === 'box')
            ? (panel.placedIcons || [])
                .filter(ic => ic.wx != null)
                .map(ic => _computeIconPhysicalCellBox(panel, ic.wx, ic.wy, ic.wz))
                .filter(Boolean)
            : [];
          // アイコンボックスによる遮蔽チェック
          // ①ジオメトリ: snap dotがBox3D範囲内（最も正確）
          // ②Z-buffer補完: 別区画Boxが前面に来るケース
          const _isOccByBox = (wx, wy, wz) => {
            // ① 3D範囲チェック（1mm余裕）
            for (const cb of _boxExtents) {
              if (wx >= cb.xMin - 1 && wx <= cb.xMax + 1 &&
                  wy >= cb.yMin - 1 && wy <= cb.yMax + 1 &&
                  wz >= cb.zMin - 1 && wz <= cb.zMax + 1) return true;
            }
            // ② Z-buffer補完（5サンプル中3点以上で遮蔽 → 非表示）
            if (!partZb) return false;
            const _p = projR(wx, wy, wz);
            const R = 3;
            const _pts = [[0,0],[R,0],[-R,0],[0,R],[0,-R]];
            let _hit = 0;
            for (const [dx,dy] of _pts) {
              const _px = Math.round(_p.x+dx), _py = Math.round(_p.y+dy);
              if (_px >= 0 && _px < Wr && _py >= 0 && _py < Hr
                  && partZb[_py*Wr+_px] > _p.depth + 5) _hit++;
            }
            return _hit >= 3;
          };
          // 区画にアイコンBoxが含まれるか判定するためのアイコン座標リスト（boxモード時のみ）
          const _iconPts = (_panelDispMode0 === 'box')
            ? (panel.placedIcons || []).filter(ic => ic.wx != null)
            : [];

          let _nearest = null, _nearDist = Infinity;
          for (const ch of chambers) {
            const _cells = ch.cells || [];
            if (_cells.length === 0) continue;

            // この区画にアイコンが配置されているか（区画XYZ範囲で判定）
            const _chXMin = Math.min(..._cells.map(c => c.xMin));
            const _chXMax = Math.max(..._cells.map(c => c.xMax));
            const _chYMin = Math.min(..._cells.map(c => c.yMin));
            const _chYMax = Math.max(..._cells.map(c => c.yMax));
            const _chZMin = Math.min(..._cells.map(c => c.zMin));
            const _chZMax = Math.max(..._cells.map(c => c.zMax));
            const _hasIconInCh = _iconPts.some(ic =>
              ic.wx >= _chXMin && ic.wx <= _chXMax &&
              ic.wy >= _chYMin && ic.wy <= _chYMax &&
              ic.wz >= _chZMin && ic.wz <= _chZMax
            );
            // アイコンがある区画はsnap dot不要（Box内に隠れているため）— 配線編集中は通過可能
            if (_hasIconInCh && !_cemD) continue;

            // 分割セル個別中心はZバッファラスタライズ済みのためCanvas2D描画なし
            // （_nearestはスナップ対象外なのでここでの追跡も不要）

            // 統合区画の中央: _nearestトラッキング（描画はZバッファ済み）
            const _xs = _cells.flatMap(c => [c.xMin, c.xMax]);
            const _ys = _cells.flatMap(c => [c.yMin, c.yMax]);
            const _zs = _cells.flatMap(c => [c.zMin, c.zMax]);
            const _mcx = (Math.min(..._xs) + Math.max(..._xs)) / 2;
            const _mcy = (Math.min(..._ys) + Math.max(..._ys)) / 2;
            const _mcz = (Math.min(..._zs) + Math.max(..._zs)) / 2;
            const _mcp = proj(_mcx, _mcy, _mcz);
            // アイコンBoX遮蔽チェック（配線編集中はスキップ — 配線はBoxを貫通可能）
            if (!_cemD && _isOccByBox(_mcx, _mcy, _mcz)) continue;
            // y結合判定: 部分仕切りのy境界をまたぎ、かつその仕切りのx範囲に区画セルが重なる場合のみ
            const _chamberYMin = Math.min(..._ys);
            const _chamberYMax = Math.max(..._ys);
            const _partialYParts = (panel.partitions || [])
              .filter(pt => pt.axis === 'y' && pt.posMm != null &&
                (pt.uMinMm > 0 || (pt.uMaxMm != null && pt.uMaxMm < panel.widthMm)));
            const _isYCombined = _partialYParts.some(pt => {
              if (_chamberYMin >= pt.posMm || _chamberYMax <= pt.posMm) return false;
              const _pu0 = pt.uMinMm ?? 0, _pu1 = pt.uMaxMm ?? panel.widthMm;
              return _cells.some(c => c.xMin < _pu1 && c.xMax > _pu0);
            });
            // 描画はZバッファラスタライズ済み → Canvas2D描画なし
            if (_cur) {
              const _d = Math.hypot(_mcp.x - _cur.sx, _mcp.y - _cur.sy);
              if (_d < _nearDist) {
                _nearDist = _d;
                const _fullBox = {
                  xMin: Math.min(..._xs), xMax: Math.max(..._xs),
                  yMin: Math.min(..._ys), yMax: Math.max(..._ys),
                  zMin: Math.min(..._zs), zMax: Math.max(..._zs),
                };
                // Altサイクル対象: depth順（手前→奥）でソート。Y統合チャンバーも含む（前後セル選択を可能にする）
                const _altCells = _cells.length <= 1 ? undefined : [..._cells].sort((a, b) => {
                  const da = proj((a.xMin+a.xMax)/2, (a.yMin+a.yMax)/2, (a.zMin+a.zMax)/2).depth;
                  const db = proj((b.xMin+b.xMax)/2, (b.yMin+b.yMax)/2, (b.zMin+b.zMax)/2).depth;
                  return db - da;
                });
                _nearest = { chamberId: ch.id, wx: _mcx, wy: _mcy, wz: _mcz, sx: _mcp.x, sy: _mcp.y, snapCell: _fullBox, altCells: _altCells };
              }
            }
          }
          // 仮想Y統合スナップ点: 部分y仕切りで分割された前後セル対の中央を追加生成
          const _partialYPos = (panel.partitions || [])
            .filter(pt => pt.axis === 'y' && pt.posMm != null &&
              (pt.uMinMm > 0 || (pt.uMaxMm != null && pt.uMaxMm < panel.widthMm)))
            .map(pt => pt.posMm);
          if (_partialYPos.length > 0) {
            // セルを(xMin,xMax,zMin,zMax)でグループ化
            const _vcMap = new Map();
            for (const ch of chambers) {
              for (const cell of (ch.cells || [])) {
                const _vk = `${cell.xMin},${cell.xMax},${cell.zMin},${cell.zMax}`;
                if (!_vcMap.has(_vk)) _vcMap.set(_vk, []);
                _vcMap.get(_vk).push({ yMin: cell.yMin, yMax: cell.yMax, chamberId: ch.id });
              }
            }
            for (const py of _partialYPos) {
              for (const [key, yCells] of _vcMap) {
                const _fc = yCells.find(c => c.yMax === py);
                const _bc = yCells.find(c => c.yMin === py);
                if (!_fc || !_bc) continue;
                const [_vxMin, _vxMax, _vzMin, _vzMax] = key.split(',').map(Number);
                const _vwx = (_vxMin + _vxMax) / 2;
                // Y結合空間の中央（前後セルを合わせたy範囲の中心）
                const _vwy = (_fc.yMin + _bc.yMax) / 2;
                const _vwz = (_vzMin + _vzMax) / 2;
                // 描画はZバッファラスタライズ済み
                const _vp = proj(_vwx, _vwy, _vwz);
                if (_cur) {
                  const _vd = Math.hypot(_vp.x - _cur.sx, _vp.y - _cur.sy);
                  if (_vd < _nearDist) {
                    _nearDist = _vd;
                    // altCells: 前後2セルをdepth順（手前→奥）で並べる
                    const _vAltCells = [
                      { xMin: _vxMin, xMax: _vxMax, yMin: _fc.yMin, yMax: _fc.yMax, zMin: _vzMin, zMax: _vzMax },
                      { xMin: _vxMin, xMax: _vxMax, yMin: _bc.yMin, yMax: _bc.yMax, zMin: _vzMin, zMax: _vzMax },
                    ].sort((a, b) => {
                      const da = proj((_vxMin+_vxMax)/2, (a.yMin+a.yMax)/2, (_vzMin+_vzMax)/2).depth;
                      const db = proj((_vxMin+_vxMax)/2, (b.yMin+b.yMax)/2, (_vzMin+_vzMax)/2).depth;
                      return db - da;
                    });
                    _nearest = { chamberId: _fc.chamberId, wx: _vwx, wy: _vwy, wz: _vwz, sx: _vp.x, sy: _vp.y,
                      snapCell: { xMin: _vxMin, xMax: _vxMax, yMin: _fc.yMin, yMax: _bc.yMax, zMin: _vzMin, zMax: _vzMax },
                      altCells: _vAltCells };
                  }
                }
              }
            }
          }
          // ケーブル折れ点ドラッグ中は距離制限なし（常に最近傍を表示）、それ以外は60px閾値
          const _wpDragging = !!_wpDragRef.current;
          let _resolvedNearest = _nearest ? (_wpDragging || _nearDist < 60 ? _nearest : null) : null;
          // Altサイクル適用: 緑丸/緑四角のスナップ中にAltで手前/奥セルに切り替え
          if (_resolvedNearest && _resolvedNearest.altCells) {
            // スナップ先が変わったらサイクルリセット
            const _snapKey = `${_resolvedNearest.chamberId}_${_resolvedNearest.wx.toFixed(1)}_${_resolvedNearest.wy.toFixed(1)}_${_resolvedNearest.wz.toFixed(1)}`;
            if (_snapKey !== _editAltPrevKeyRef.current) {
              _editAltCycleRef.current = 0;
              _editAltPrevKeyRef.current = _snapKey;
            }
            // サイクル: 0=緑丸, 1=手前オレンジ, 2=奥オレンジ, 3=緑丸（循環）
            const _total = _resolvedNearest.altCells.length + 1;
            const _cyclePos = _editAltCycleRef.current % _total;
            if (_cyclePos > 0 && _resolvedNearest.altCells.length > 0) {
              const _cellIdx = _cyclePos - 1;
              const _ac = _resolvedNearest.altCells[_cellIdx];
              const _awx = (_ac.xMin + _ac.xMax) / 2;
              const _awy = (_ac.yMin + _ac.yMax) / 2;
              const _awz = (_ac.zMin + _ac.zMax) / 2;
              const _ap = proj(_awx, _awy, _awz);
              _resolvedNearest = { ..._resolvedNearest, wx: _awx, wy: _awy, wz: _awz, sx: _ap.x, sy: _ap.y, snapCell: _ac, _altActive: true };
            }
          } else if (!_resolvedNearest) {
            _editAltPrevKeyRef.current = null;
            _editAltCycleRef.current = 0;
          }
          _cableNearestDotRef.current = _resolvedNearest;
        } else if (!_cemD && !_isIconDrag) {
          _cableNearestDotRef.current = null;
        }
      }

      // ── Step 3.77: 配置編集モード — 折れ点□（●の上に描画）+ ドラッグプレビュー ──
      {
        const _cemW = _cableEditModeRef.current;
        if (_cemW && _editCablePts3d && _editCablePts3d.length >= 2) {
          const _ecableW = _cablesRef.current.find(c => c.id === _cemW.cableId);
          const _editColorW = pdcCableStyle(_ecableW).color;
          const _drag = _wpDragRef.current;
          const _snapDot = _drag ? _cableNearestDotRef.current : null;
          // from端点がeps3dに含まれているかで折れ点インデックスのオフセットが変わる
          const _fiW = (panel.placedIcons || []).find(ic => ic.id === _ecableW?.fromIconId);
          const _fwxW = _ecableW?.fromWx ?? _fiW?.wx;
          const _fromOffW = (_fwxW != null) ? 1 : 0;

          // ドラッグ中: スナップ先区画のオレンジ枠（アイコン移動と同じエフェクト）
          if (_drag && _snapDot) {
            const _sc = _snapDot.snapCell;
            if (_sc) {
              const _sxMn=_sc.xMin,_sxMx=_sc.xMax;
              const _syMn=_sc.yMin,_syMx=_sc.yMax;
              const _szMn=_sc.zMin,_szMx=_sc.zMax;
              const _sdc=[
                proj(_sxMn,_syMn,_szMn),proj(_sxMx,_syMn,_szMn),
                proj(_sxMx,_syMx,_szMn),proj(_sxMn,_syMx,_szMn),
                proj(_sxMn,_syMn,_szMx),proj(_sxMx,_syMn,_szMx),
                proj(_sxMx,_syMx,_szMx),proj(_sxMn,_syMx,_szMx),
              ];
              ctx.save();
              ctx.strokeStyle='#FBBF24'; ctx.lineWidth=2.5; ctx.globalAlpha=1; ctx.setLineDash([]);
              for (const [a,b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) {
                ctx.beginPath(); ctx.moveTo(_sdc[a].x,_sdc[a].y); ctx.lineTo(_sdc[b].x,_sdc[b].y); ctx.stroke();
              }
              ctx.restore();
            }
          }
          // ドラッグ中: スナップ先で配線プレビューを再描画
          if (_drag) {
            // タップ端点ドラッグ中はタップケーブルのptsを使う（_cEntryはスコープ外なので直接計算）
            const _getTapPts3d = (_tapId) => {
              const _tc = _cablesRef.current.find(c => c.id === _tapId);
              if (!_tc) return null;
              const _pts = [];
              const _fI = (panel.placedIcons || []).find(ic => ic.id === _tc.fromIconId);
              const _fw = _tc.fromWx ?? _fI?.wx;
              if (_fw != null) _pts.push({ wx: _fw, wy: _tc.fromWy ?? _fI?.wy, wz: _tc.fromWz ?? _fI?.wz });
              for (const _wp of (_tc.waypoints || [])) { if (_wp?.wx != null) _pts.push({ wx: _wp.wx, wy: _wp.wy, wz: _wp.wz }); }
              const _tI = (panel.placedIcons || []).find(ic => ic.id === _tc.toIconId);
              const _tw = _tc.toWx ?? _tI?.wx;
              if (_tw != null) _pts.push({ wx: _tw, wy: _tc.toWy ?? _tI?.wy, wz: _tc.toWz ?? _tI?.wz });
              return _pts.length >= 2 ? _pts : null;
            };
            const _dragPts3d = (_drag.tapCableId ? _getTapPts3d(_drag.tapCableId) : null) ?? _editCablePts3d;
            if (!_dragPts3d || _dragPts3d.length < 2) { /* skip */ } else {
            // 端点ドラッグは特別処理: 'from'→0, 'to'→最後, 数値→waypoint位置
            const _dragEpsIdx = _drag.wpIdx === 'from' ? 0
              : _drag.wpIdx === 'to' ? _dragPts3d.length - 1
              : _drag.wpIdx + _fromOffW;
            const _snapPt = _snapDot
              ? proj(_snapDot.wx, _snapDot.wy, _snapDot.wz)
              : proj(_dragPts3d[_dragEpsIdx].wx, _dragPts3d[_dragEpsIdx].wy, _dragPts3d[_dragEpsIdx].wz);
            const _previewPts = _dragPts3d.map((p3, _pi) => {
              if (_pi === _dragEpsIdx) return _snapPt; // スナップ位置で上書き
              return proj(p3.wx, p3.wy, p3.wz);
            });
            ctx.save();
            ctx.strokeStyle = _editColorW;
            ctx.lineWidth = (_ecableW?.thickness || 3);
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.setLineDash([6, 4]);
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.moveTo(_previewPts[0].x, _previewPts[0].y);
            for (let _i = 1; _i < _previewPts.length; _i++) ctx.lineTo(_previewPts[_i].x, _previewPts[_i].y);
            ctx.stroke();
            ctx.restore();
            } // end if _dragPts3d
          }

          // 折れ点□を最前面に描画（ドラッグ中はスナップ先、通常は保存座標）
          _editCablePts3d.forEach((p3, _pi) => {
            const _tiW = (panel.placedIcons || []).find(ic => ic.id === _ecableW?.toIconId);
            const _hasTW = (_tiW?.wx != null);
            const _isEndpoint = (_fromOffW === 1 && _pi === 0) || (_hasTW && _pi === _editCablePts3d.length - 1);
            if (_isEndpoint) return;
            const _wpIdx = _pi - _fromOffW;
            let _p2;
            if (_drag && _drag.wpIdx === _wpIdx) {
              // ドラッグ中: スナップ先に表示
              _p2 = _snapDot ? proj(_snapDot.wx, _snapDot.wy, _snapDot.wz) : proj(p3.wx, p3.wy, p3.wz);
            } else {
              _p2 = proj(p3.wx, p3.wy, p3.wz);
            }
            const _hs = 6;
            ctx.save();
            ctx.fillStyle = _editColorW;
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.fillRect(_p2.x - _hs, _p2.y - _hs, _hs * 2, _hs * 2);
            ctx.strokeRect(_p2.x - _hs, _p2.y - _hs, _hs * 2, _hs * 2);
            ctx.restore();
          });
        }
      }

      // ── Step 3.775: タップ作成ドラッグ中プレビュー（水色四角＋点線） ──
      if (_tapDragRef.current) {
        const _td = _tapDragRef.current;
        const _fp = proj(_td.fromWx, _td.fromWy, _td.fromWz);
        const _nd = _cableNearestDotRef.current;
        const _tp = _nd ? proj(_nd.wx, _nd.wy, _nd.wz) : _editCursorRef.current;
        ctx.save();
        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 2;
        // 分岐点：水色四角
        const _SQ = 10;
        ctx.strokeRect(_fp.x - _SQ / 2, _fp.y - _SQ / 2, _SQ, _SQ);
        // プレビュー線：分岐点→スナップ先（点線）
        if (_tp) {
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(_fp.x, _fp.y);
          ctx.lineTo(_tp.sx ?? _tp.x, _tp.sy ?? _tp.y);
          ctx.stroke();
          ctx.setLineDash([]);
          // スナップ先の水色丸
          if (_nd) {
            ctx.beginPath();
            ctx.arc(_tp.x, _tp.y, 5, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // ── Step 3.78: アイコンドラッグ中 — 最近傍区画のオレンジ枠表示 ──
      if (iconMoveDragRef.current && _cableNearestDotRef.current) {
        const _sc = _cableNearestDotRef.current.snapCell;
        if (_sc) {
          const _sdc = [
            proj(_sc.xMin,_sc.yMin,_sc.zMin), proj(_sc.xMax,_sc.yMin,_sc.zMin),
            proj(_sc.xMax,_sc.yMax,_sc.zMin), proj(_sc.xMin,_sc.yMax,_sc.zMin),
            proj(_sc.xMin,_sc.yMin,_sc.zMax), proj(_sc.xMax,_sc.yMin,_sc.zMax),
            proj(_sc.xMax,_sc.yMax,_sc.zMax), proj(_sc.xMin,_sc.yMax,_sc.zMax),
          ];
          ctx.save();
          ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 2.5; ctx.globalAlpha = 1; ctx.setLineDash([]);
          for (const [a,b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) {
            ctx.beginPath(); ctx.moveTo(_sdc[a].x,_sdc[a].y); ctx.lineTo(_sdc[b].x,_sdc[b].y); ctx.stroke();
          }
          ctx.restore();
        }
      }

      // ── Step 3.8: ケーブルルートモード インタラクティブプレビュー ──
      const _cableMode = _cableAddModeRef.current;
      if (_cableMode && _cableCursorRef.current) {
        const _cursor = _cableCursorRef.current;
        if (_cableMode.step === 'waypoints') {
          const _pts2d = [];
          const _fromIc = (panel.placedIcons || []).find(ic => ic.id === _cableMode.fromIconId);
          // fromWx/fromWy/fromWzがある場合（ユーザーが丸を指してアイコンをクリックした場合）はその座標を使う
          // ない場合はアイコンの幾何学的中央にフォールバック
          const _fromStartWx = _cableMode.fromWx ?? _fromIc?.wx;
          const _fromStartWy = _cableMode.fromWy ?? _fromIc?.wy;
          const _fromStartWz = _cableMode.fromWz ?? _fromIc?.wz;
          if (_fromStartWx != null) _pts2d.push(proj(_fromStartWx, _fromStartWy, _fromStartWz));
          for (const _wp of (_cableMode.waypoints || [])) {
            // waypoint は {chamberId, wx, wy, wz} オブジェクト（セル中心座標付き）
            if (_wp && _wp.wx != null) {
              _pts2d.push(proj(_wp.wx, _wp.wy, _wp.wz));
            } else {
              // 旧フォーマット互換（文字列IDのみの場合は区画統合中心にフォールバック）
              const _chId = typeof _wp === 'string' ? _wp : _wp?.chamberId;
              const _ch = chambers.find(c => c.id === _chId);
              if (_ch && _ch.cells.length) {
                const _xs = _ch.cells.flatMap(c => [c.xMin, c.xMax]);
                const _ys = _ch.cells.flatMap(c => [c.yMin, c.yMax]);
                const _zs = _ch.cells.flatMap(c => [c.zMin, c.zMax]);
                _pts2d.push(proj((Math.min(..._xs)+Math.max(..._xs))/2,(Math.min(..._ys)+Math.max(..._ys))/2,(Math.min(..._zs)+Math.max(..._zs))/2));
              }
            }
          }
          _pts2d.push(_cursor);
          if (_pts2d.length >= 2) {
            ctx.save();
            ctx.strokeStyle = pdcCableStyle(_cableMode).color;
            ctx.lineWidth = pdcCableStyle(_cableMode).thickness + 1;
            ctx.setLineDash([8, 5]);
            ctx.lineCap = 'round';
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.moveTo(_pts2d[0].x, _pts2d[0].y);
            for (let _i = 1; _i < _pts2d.length; _i++) ctx.lineTo(_pts2d[_i].x, _pts2d[_i].y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = pdcCableStyle(_cableMode).color;
            ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.arc(_cursor.x, _cursor.y, 5, 0, Math.PI * 2); ctx.fill();
            // 始点アイコンにマーカー
            ctx.fillStyle = '#10B981';
            ctx.globalAlpha = 1;
            ctx.beginPath(); ctx.arc(_pts2d[0].x, _pts2d[0].y, 6, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
        }
        // ── Step 3.7: ケーブルモード中 — 最小セル単位で●クリック候補点を表示 ──
        // 透過状態を反映: 不透明(transparency=0)は可視面接触セルのみ / 透過時は全セル表示
        if (_cableMode.step === 'waypoints' || _cableMode.step === 'from') {
          const _hovId = hoverChamberId;
          const _wpSet = new Set((_cableMode.waypoints || []).map(w => (typeof w === 'string' ? w : w?.chamberId)));
          // 描画した丸リストをリセット（毎フレーム再構築）
          _cableDotHitsRef.current = [];
          if (_hovId) {
            const _hovCh = chambers.find(c => c.id === _hovId);
            if (_hovCh) {
              const _cur = _cableCursorRef.current;
              // icon dragと同じbuildAltSlotsでスロット構築 → カウント完全一致
              const _hfDraw = _cableHitFaceRef.current;
              const _altSlots = _hfDraw
                ? buildAltSlots(_hfDraw.face, _hfDraw.uMm, _hfDraw.vMm, _cableAllChsRef.current, panel)
                : (_cableAllChsRef.current.length > 0
                    ? _cableAllChsRef.current.map((ch, di) => ({ ch, mode: 'standard', depthIdx: di }))
                    : [{ ch: _hovCh, mode: 'standard', depthIdx: 0 }]);
              const _altTotal = Math.max(1, _altSlots.length);
              _cableYGroupCountRef.current = _altTotal;
              const _altSel = _cableAltCycleRef.current % _altTotal;
              const _selSlot = _altSlots[_altSel];
              const _selLabel = _selSlot ? _slotLabel(_selSlot) : '';

              // ゴースト描画:
              //   レイヤー1 (最背面): Y軸非選択スロット × 各(ix,iz)単位区画
              //   レイヤー2 (中間): アクティブスロット内の非アクティブ(ix,iz)区画
              //   レイヤー3 (最前面): _computeIconPlacementが選んだアクティブ位置 + 黄枠
              const _PW = panel.widthMm, _PH = panel.heightMm, _PD = panel.depthMm;
              const _half = pdcIconFlatHalf(panel); // flatアイコン半幅（共通コア）
              const _edges12 = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

              // スロットのiyフィルタ済みセル取得
              const _slotCells = (slot) => slot.mode === 'ySpecific'
                ? slot.ch.cells.filter(c => c.iy === slot.iy)
                : slot.ch.cells;

              // (ix,iz)グループごとの中心座標リスト
              const _ixizCenters = (cells) => {
                const map = new Map();
                cells.forEach(c => {
                  const k = `${c.ix}_${c.iz}`;
                  if (!map.has(k)) map.set(k, []);
                  map.get(k).push(c);
                });
                return [...map.values()].map(cs => ({
                  wx: (Math.min(...cs.map(c=>c.xMin)) + Math.max(...cs.map(c=>c.xMax))) / 2,
                  wy: (Math.min(...cs.map(c=>c.yMin)) + Math.max(...cs.map(c=>c.yMax))) / 2,
                  wz: (Math.min(...cs.map(c=>c.zMin)) + Math.max(...cs.map(c=>c.zMax))) / 2,
                }));
              };

              // フラットアイコン描画ヘルパー
              const _drawGhostIcon = (wx, wy, wz, alpha, lineW) => {
                const gc = [
                  proj(wx - _half, wy, wz - _half), proj(wx + _half, wy, wz - _half),
                  proj(wx + _half, wy, wz + _half), proj(wx - _half, wy, wz + _half),
                ];
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#1E40AF';
                ctx.strokeStyle = '#FBBF24';
                ctx.lineWidth = lineW;
                ctx.setLineDash([]);
                ctx.beginPath(); ctx.moveTo(gc[0].x, gc[0].y);
                for (let i = 1; i < gc.length; i++) ctx.lineTo(gc[i].x, gc[i].y);
                ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.restore();
              };

              // アクティブスロットの_computeIconPlacement（Z/X統合判定込み）
              let _activePlacement = null;
              if (_hfDraw && _selSlot) {
                _activePlacement = _computeIconPlacement(
                  _hfDraw.face, _hfDraw.uMm, _hfDraw.vMm,
                  _selSlot.ch, panel,
                  _selSlot.mode === 'yUnified',
                  _selSlot.mode === 'ySpecific' ? _selSlot.iy : null
                );
              }

              // レイヤー1: 非選択スロットの候補位置
              // _computeIconPlacementを呼んでカーソル位置に対応した実際の配置点を計算
              // （セル中心への直接描画ではなく、アイコンドラッグと同じコードパスで取得）
              for (let _si = 0; _si < _altSlots.length; _si++) {
                if (_si === _altSel) continue;
                if (!_hfDraw) continue;
                const _slot1 = _altSlots[_si];
                const _pl1 = _computeIconPlacement(
                  _hfDraw.face, _hfDraw.uMm, _hfDraw.vMm,
                  _slot1.ch, panel,
                  _slot1.mode === 'yUnified',
                  _slot1.mode === 'ySpecific' ? _slot1.iy : null
                );
                if (!_pl1) continue;
                const _l1alpha = 0.45;
                _drawGhostIcon(_pl1.wx, _pl1.wy, _pl1.wz, _l1alpha, 0.8);
                const _lp1 = proj(_pl1.wx, _pl1.wy, _pl1.wz);
                ctx.save();
                ctx.globalAlpha = _l1alpha;
                ctx.fillStyle = '#FFFFFF';
                ctx.font = 'bold 7px sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(_slotLabel(_slot1), _lp1.x, _lp1.y);
                ctx.restore();
              }

              // レイヤー2: アクティブスロット内の非アクティブ(ix,iz)区画
              if (_activePlacement) {
                const _activeCx = _activePlacement.wx, _activeCz = _activePlacement.wz;
                for (const { wx, wy, wz } of _ixizCenters(_slotCells(_selSlot))) {
                  // アクティブ位置と近い区画はスキップ（重複描画を避ける）
                  if (Math.abs(wx - _activeCx) < 1 && Math.abs(wz - _activeCz) < 1) continue;
                  _drawGhostIcon(wx, wy, wz, 0.45, 1.2);
                }
              }

              // レイヤー3: アクティブ位置（黄色ワイヤーフレーム + 明るいアイコン）
              _cableDotHitsRef.current = [];
              if (_activePlacement) {
                const { wx: gx, wy: gy, wz: gz, cellBox } = _activePlacement;
                const cp = proj(gx, gy, gz);
                // 黄色ワイヤーフレーム
                const dc = [
                  proj(cellBox.xMin,cellBox.yMin,cellBox.zMin), proj(cellBox.xMax,cellBox.yMin,cellBox.zMin),
                  proj(cellBox.xMax,cellBox.yMax,cellBox.zMin), proj(cellBox.xMin,cellBox.yMax,cellBox.zMin),
                  proj(cellBox.xMin,cellBox.yMin,cellBox.zMax), proj(cellBox.xMax,cellBox.yMin,cellBox.zMax),
                  proj(cellBox.xMax,cellBox.yMax,cellBox.zMax), proj(cellBox.xMin,cellBox.yMax,cellBox.zMax),
                ];
                ctx.save();
                ctx.strokeStyle = '#FDE68A'; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.setLineDash([]);
                for (const [a,b] of _edges12) {
                  ctx.beginPath(); ctx.moveTo(dc[a].x, dc[a].y); ctx.lineTo(dc[b].x, dc[b].y); ctx.stroke();
                }
                ctx.restore();
                // アクティブフラットアイコン
                _drawGhostIcon(gx, gy, gz, 0.85, 2.5);
                // ラベル
                if (_altTotal >= 2) {
                  ctx.save();
                  pdcPaintIconLabel(ctx, cp, _selLabel, pdcView, { alpha: 1 });
                  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                  ctx.restore();
                }
                _cableNearestDotRef.current = { chamberId: _selSlot.ch.id, wx: gx, wy: gy, wz: gz, sx: cp.x, sy: cp.y };
                _cableDotHitsRef.current = [{ chamberId: _selSlot.ch.id, wx: gx, wy: gy, wz: gz, sx: cp.x, sy: cp.y }];
              } else {
                _cableNearestDotRef.current = null;
              }
            }
          }
        }

        // ステータステキスト（下部バー）
        const _stAltTotal = _cableYGroupCountRef.current;
        const _altHint = _stAltTotal >= 2 ? ` [Alt]でy深度切替` : '';
        const _statusMsg = _cableMode.step === 'from'
          ? '始点アイコンをクリック　Escでキャンセル'
          : `区画●クリック=経由点追加 / アイコンクリック=確定 / Enter=確定${_altHint}　Escでキャンセル`;
        ctx.save();
        ctx.fillStyle = 'rgba(15,23,42,0.75)';
        ctx.fillRect(0, H - 26, W, 26);
        ctx.fillStyle = '#F59E0B';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(_statusMsg, W / 2, H - 8);
        ctx.restore();
        if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
      }

      // ── Step 3.6: 配置済みアイコンをXZ平面の3D板として描画 ──
      {
        const PW = panel.widthMm, PH = panel.heightMm, PD = panel.depthMm;
        const half = pdcIconFlatHalf(panel); // flatアイコン半幅（共通コア）
        const hits = [];

        // _dispPos / iconGroupRef はZバッファパスの前に計算済み

        // アイコンを奥行き昇順（遠い順）でソートして描画（Painterアルゴリズム）
        const _sortedIcons = [...(panel.placedIcons || [])].sort((a, b) => {
          const da = _dispPos.get(a.id) || a;
          const db = _dispPos.get(b.id) || b;
          return proj(da.wx||0, da.wy||0, da.wz||0).depth - proj(db.wx||0, db.wy||0, db.wz||0).depth;
        });
        _sortedIcons.forEach(icon => {
          if (icon.wx == null || icon.wy == null || icon.wz == null) return;
          if (iconDragPreview && icon.id === selectedIconId) return;

          // グループ整列オーバーライド後の表示位置
          const dp = _dispPos.get(icon.id) || { wx: icon.wx, wy: icon.wy, wz: icon.wz };
          const dwx = dp.wx, dwy = dp.wy, dwz = dp.wz;

          // ── 面カリング ──
          // full: なし / semi・opaque: 明示face優先 → なければ表示位置から推定
          if (iconVisMode !== 'full') {
            const _face = icon.face || (() => {
              const dists = [
                ['front', dwy],  ['back',   PD - dwy],
                ['left',  dwx],  ['right',  PW - dwx],
                ['bottom', dwz], ['top',    PH - dwz],
              ];
              return dists.reduce((a, b) => a[1] < b[1] ? a : b)[0];
            })();
            const _n = _DOOR_MOUNT_NORMALS[_face];
            if (_n && panelIsBackFacing(_n, az, el)) return;
          }
          const corners = [
            proj(dwx - half, dwy, dwz - half),
            proj(dwx + half, dwy, dwz - half),
            proj(dwx + half, dwy, dwz + half),
            proj(dwx - half, dwy, dwz + half),
          ];
          // _iconDispMode を allOccluded チェックの前に確定（Box モードで別Zbufを使うため）
          const _panelDispMode = panel.iconDisplayMode || 'flat';
          const _iconDispMode = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box')
            ? icon.iconDisplayMode : _panelDispMode;
          // hidden モードはアイコンを完全に非表示（クリック判定も無効）
          if (_iconDispMode === 'hidden') return;
          // ── 全コーナー遮蔽テスト ──
          // Boxモード: partOnlyZb（仕切りのみ）を使用 — Box自身の深度値で誤判定しないよう
          // Flatモード: partZb（仕切り+Box両方）を使用
          // 遮蔽テストを行うのは opaque（機器不透過）のときだけ。
          // semi/full は「外箱・扉・仕切りを透過して機器を見る」モードなので、
          // box アイコン（_iconOnlyMode）と同様に flat アイコンも遮蔽で消さない。
          const _flatIconOcclusionMode = (iconVisMode === 'opaque');
          if (_flatIconOcclusionMode) {
            const _useOuter = iconVisMode === 'opaque' && outerZbFull && doorsVisible;
            const _zbForOcclude = (_iconDispMode === 'box' && partOnlyZb) ? partOnlyZb : partZb;
            if (_zbForOcclude || _useOuter) {
              // Zバッファ座標系はWr×Hr → cornersをprojRでスケールダウンしてインデックス計算
              const cornersR = corners.map(p => ({ x: p.x * _scaleR, y: p.y * _scaleR, depth: p.depth }));
              const allOccluded = cornersR.every(p => {
                const px = Math.round(p.x), py = Math.round(p.y);
                if (px < 0 || px >= Wr || py < 0 || py >= Hr) return true;
                const idx = py * Wr + px;
                const zbDepth = Math.max(
                  _zbForOcclude ? _zbForOcclude[idx] : -1e9,
                  _useOuter ? outerZbFull[idx] : -1e9
                );
                return zbDepth > p.depth + 1;
              });
              if (allOccluded) return;
            }
          }
          const isSel = icon.id === selectedIconId || icon.id === hoveredIconId;
          const isChecked2 = selectedIconIds && selectedIconIds.has(icon.id);
          const isReordering = iconReorderPreview && icon.id === selectedIconId;
          ctx.globalAlpha = isReordering ? 0.75 : 1;
          const _label = pdcIconLabelText(icon);
          if (_iconDispMode === 'box' && partZb) {
            // Zバッファに焼き込み済み → ラベルのみCanvas 2D描画
            // ラベル可視チェック: partOnlyZb（仕切りのみ）でセンターが遮蔽されていないか確認
            const cp = proj(dwx, dwy, dwz);
            const cpx = Math.round(cp.x), cpy = Math.round(cp.y);
            let labelVisible = true;
            if (partOnlyZb && iconVisMode !== 'full') {
              // partOnlyZbはWr×Hr座標系 → projRで変換してインデックス計算
              const cpR = projR(dwx, dwy, dwz);
              const cpxR = Math.round(cpR.x), cpyR = Math.round(cpR.y);
              if (cpxR >= 0 && cpxR < Wr && cpyR >= 0 && cpyR < Hr) {
                labelVisible = partOnlyZb[cpyR * Wr + cpxR] <= cpR.depth + 5;
              }
            }
            // クリック判定: Boxの8頂点の2D バウンディングボックスを使用
            const { hx: _bHx, hy: _bHy, hz: _bHz } = pdcIconHalfExtents(dp.subCellBox || icon.cellBox, icon.face || 'front');
            const _b8 = pdcIconBoxCorners(proj, dwx, dwy, dwz, _bHx, _bHy, _bHz);
            const _bMinX = Math.min(..._b8.map(p=>p.x)), _bMaxX = Math.max(..._b8.map(p=>p.x));
            const _bMinY = Math.min(..._b8.map(p=>p.y)), _bMaxY = Math.max(..._b8.map(p=>p.y));
            const boxCorners = [
              {x:_bMinX,y:_bMinY,depth:cp.depth}, {x:_bMaxX,y:_bMinY,depth:cp.depth},
              {x:_bMaxX,y:_bMaxY,depth:cp.depth}, {x:_bMinX,y:_bMaxY,depth:cp.depth},
            ];
            hits.push({ icon, corners: boxCorners });
            if (!_deferIconBoxDraw && labelVisible) {
              // offscreenで描画済み（透明度>0 or 扉非表示）→ ラベルのみ（共通コア）
              pdcPaintIconLabel(ctx, cp, _label, pdcView, { alpha: ctx.globalAlpha, isSel });
            }
            // チェック済み → ワイヤーフレーム枠線オーバーレイ
            if (isChecked2) {
              _drawIconBoxWireframe(ctx, proj, dwx, dwy, dwz, dp.subCellBox || icon.cellBox, icon.face || 'front', az, el, '#FBBF24', 2.5);
            }
          } else if (_iconDispMode === 'box') {
            // カメラドラッグ中 or partZb=null: Canvas 2Dで直接Box描画
            hits.push({ icon, corners });
            if (_isCameraDragging || (openDoorOpenings.length > 0 && iconVisMode !== 'full')) {
              _drawIconBox(ctx, proj, dwx, dwy, dwz, dp.subCellBox || icon.cellBox, icon.face || 'front', az, el, isSel, isReordering, _label, null, icon.iconColor, false, zoom);
              if (isChecked2) _drawIconBoxWireframe(ctx, proj, dwx, dwy, dwz, dp.subCellBox || icon.cellBox, icon.face || 'front', az, el, '#FBBF24', 2.5);
            }
          } else {
            hits.push({ icon, corners });
            // flatアイコンの静的な色・枠は共通コア（PDC_ICON_FLAT_STYLE）。
            // 選択・並び替えの編集UI色だけをここで上書きする。
            pdcPaintIconFlat(ctx, corners, { lwUnit: 1 }, {
              fillStyle:   isReordering ? '#D97706' : (isSel ? '#1E40AF' : undefined),
              strokeStyle: isReordering ? '#FDE68A' : (isSel ? '#FBBF24' : undefined),
              lineWidth:   isReordering ? 2 : (isSel ? 2.5 : undefined),
            });
            if (isChecked2) _drawIconBoxWireframe(ctx, proj, dwx, dwy, dwz, dp.subCellBox || icon.cellBox, icon.face || 'front', az, el, '#FBBF24', 2.5);
            pdcPaintIconLabel(ctx, proj(dwx, dwy, dwz), _label, pdcView, { alpha: ctx.globalAlpha });
          }
        });
        iconHitRef.current = hits;

        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

        // ── ドラッグ移動プレビュー（候補位置にゴースト表示） ──
        if (iconDragPreview) {
          const { wx, wy, wz, cellBox, face: dragFace } = iconDragPreview;
          const gx = cellBox ? (cellBox.xMin + cellBox.xMax) / 2 : wx;
          const gy = cellBox ? (cellBox.yMin + cellBox.yMax) / 2 : wy;
          const gz = cellBox ? (cellBox.zMin + cellBox.zMax) / 2 : wz;
          const selIcon = (panel.placedIcons || []).find(ic => ic.id === selectedIconId);
          const _label = (selIcon?.name || '?').slice(0, 3);
          const _panelDispMode = panel.iconDisplayMode || 'flat';
          const _iconDispMode = selIcon
            ? ((selIcon.iconDisplayMode === 'flat' || selIcon.iconDisplayMode === 'box')
               ? selIcon.iconDisplayMode : _panelDispMode)
            : _panelDispMode;
          ctx.globalAlpha = 0.85;
          if (_iconDispMode === 'box') {
            _drawIconBox(ctx, proj, gx, gy, gz, cellBox, dragFace || selIcon?.face || 'front', az, el, true, false, _label, null, undefined, false, zoom);
          } else {
            const _gview = { proj, lwUnit: 1, pxPerMm: zoom };
            const gc = pdcIconFlatCorners(_gview, gx, gy, gz, panel);
            // ドラッグゴースト: 形状は共通コア、色は編集UI（黄枠）
            pdcPaintIconFlat(ctx, gc, _gview, {
              fillStyle: selIcon?.color || '#1E40AF',
              strokeStyle: '#FBBF24',
              lineWidth: 2.5,
            });
            pdcPaintIconLabel(ctx, proj(gx, gy, gz), _label, _gview, { alpha: ctx.globalAlpha });
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          }
          ctx.globalAlpha = 1;
        }
      }

      // ── Step 3.5: 空想仕切りオーバーレイ（半透明 + 選択時破線） ──
      // 外箱透明度0のときは空想仕切りも非表示（外箱越しに見えないため）
      if (showVirtual && transparency > 0) {
        for (const p of (panel.partitions || [])) {
          if (!p.virtual || p.type !== 'axis') continue;
          const corners = _virtualPartitionCorners(p, panel);
          if (!corners) continue;
          const pts = corners.map(([wx, wy, wz]) => proj(wx, wy, wz));
          const isSel = selectedPartitionIds.includes(p.id);
          ctx.setLineDash(isSel ? [6, 4] : []);
          ctx.lineWidth = isSel ? 1.5 : 0.8;
          ctx.strokeStyle = isSel ? '#FBBF24' : 'rgba(148,163,184,0.6)';
          ctx.fillStyle   = 'rgba(148,163,184,0.06)';
          ctx.globalAlpha = 1 - solidAlpha;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // ── Step 4: 選択エッジのグローハイライト ──
      if (selectedEdge) {
        // 外箱8頂点の投影（旧Step3.4のcp。ワイヤーフレーム共通コア化に伴いここで局所計算）
        const cp = [
          [0,0,0],[panel.widthMm,0,0],[panel.widthMm,panel.depthMm,0],[0,panel.depthMm,0],
          [0,0,panel.heightMm],[panel.widthMm,0,panel.heightMm],
          [panel.widthMm,panel.depthMm,panel.heightMm],[0,panel.depthMm,panel.heightMm],
        ].map(([x,y,z]) => proj(x,y,z));
        const [ea, eb] = selectedEdge;
        const pa = cp[ea], pb = cp[eb];
        ctx.lineCap = 'round';
        // 外側から内側へ3層でグロー（仕切り選択と同じオレンジ #FBBF24）
        [{ w: 9, a: 0.12 }, { w: 5, a: 0.35 }, { w: 2, a: 1.0 }].forEach(({ w, a }) => {
          ctx.strokeStyle = `rgba(251,191,36,${a})`;
          ctx.lineWidth = w;
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        });
        ctx.lineCap = 'butt';
        // 辺中点に●リサイズハンドル（仕切りギズモ●と同デザイン）
        const [emx, emy, emz] = _edgeMidpointMm(selectedEdge, panel);
        const emp = proj(emx, emy, emz);
        ctx.globalAlpha = 0.2; ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(emp.x + 0.5, emp.y + 1, 5.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#FBBF24';
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(emp.x, emp.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── Step 4.5: 扉配置モード ──
      const _FACE_JP = { front:'前面', back:'後面', left:'左面', right:'右面', top:'上面', bottom:'下面' };
      // 4.5a: 面ホバーモード — ホバー中の面を強調
      if (doorPlaceMode === 'hover') {
        const faceDefs = _boxFaceDefs(panel.widthMm, panel.depthMm, panel.heightMm);
        for (const face of faceDefs) {
          if (face.id !== hoveredFace) continue;
          if (panelIsBackFacing(face.normal, az, el)) continue;
          const pts = face.verts.map(([x,y,z]) => proj(x,y,z));
          ctx.fillStyle = 'rgba(251,191,36,0.12)';
          ctx.strokeStyle = 'rgba(251,191,36,0.9)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
          for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.fillStyle = hoveredFace ? 'rgba(251,191,36,0.95)' : 'rgba(148,163,184,0.8)';
        ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(
          hoveredFace ? `${_FACE_JP[hoveredFace]}面 — クリックで扉の区画を選択` : '面にカーソルを当ててください　Escでキャンセル',
          W/2, 18
        );
      }
      // 4.5b: 候補オーバーレイ（面ホバー後の区画選択モード）
      const doorCandidates = [];
      if (doorPlaceMode && doorPlaceMode !== 'hover') {
        const { strict, extended } = deriveFaceDoorCandidates(panel, doorPlaceMode);
        const _W=panel.widthMm, _H=panel.heightMm, _D=panel.depthMm;
        const faceUV=(u,v)=>{ switch(doorPlaceMode){
          case 'front': return[u,0,v];   case 'back':  return[u,_D,v];
          case 'left':  return[0,u,v];   case 'right': return[_W,u,v];
          case 'top':   return[u,v,_H];  case 'bottom':return[u,v,0];
          default: return[u,0,v];
        }};
        // 選択面をオレンジ点線枠で描画（展開図と同じ表現）
        const _selFaceDefs = _boxFaceDefs(panel.widthMm, panel.depthMm, panel.heightMm);
        for (const face of _selFaceDefs) {
          if (face.id !== doorPlaceMode) continue;
          if (panelIsBackFacing(face.normal, az, el)) continue;
          const pts = face.verts.map(([x,y,z]) => proj(x,y,z));
          ctx.fillStyle = 'rgba(251,191,36,0.06)';
          ctx.strokeStyle = 'rgba(251,191,36,0.75)';
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
          for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.setLineDash([]);
        }
        const _ck = (c) => c ? `${c.uMm}_${c.vMm}_${c.widthMm}_${c.heightMm}` : null;
        const anchorKey = _ck(doorSelAnchor);
        const hoverKey  = _ck(doorSelHover);
        // isExt=true: 面未到達の仕切りによる拡張セル → 点線・薄め
        const drawCells = (cells, isExt = false) => {
          for (const cell of cells) {
            const key = _ck(cell);
            const hilit = key === hoverKey || key === anchorKey;
            const { uMm: cu, vMm: cv, widthMm: cw, heightMm: ch } = cell;
            const pts = [[cu,cv],[cu+cw,cv],[cu+cw,cv+ch],[cu,cv+ch]]
              .map(([u,v]) => { const xyz=faceUV(u,v); return proj(xyz[0],xyz[1],xyz[2]); });
            if (isExt) {
              ctx.fillStyle = hilit ? 'rgba(251,191,36,0.22)' : 'rgba(251,191,36,0.07)';
              ctx.strokeStyle = hilit ? 'rgba(251,191,36,0.9)' : 'rgba(251,191,36,0.55)';
              ctx.setLineDash([4, 3]);
            } else {
              ctx.fillStyle = hilit ? 'rgba(251,191,36,0.35)' : 'rgba(251,191,36,0.15)';
              ctx.strokeStyle = 'rgba(251,191,36,0.85)';
              ctx.setLineDash([]);
            }
            ctx.lineWidth = hilit ? 2.5 : 1.5;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.setLineDash([]);
            doorCandidates.push({ cell, pts, isStrict: !isExt });
          }
        };
        drawCells(extended, true);  // 先に描画（外周borderはstrict実線で上書きされる）
        drawCells(strict, false);   // 後から描画（実線でextendedの外周を上書き）
        // ドラッグ選択プレビュー: アンカー+ホバーのマージ矩形
        if (doorSelAnchor && doorSelHover) {
          const a = doorSelAnchor, h = doorSelHover;
          const uMin = Math.min(a.uMm, h.uMm);
          const vMin = Math.min(a.vMm, h.vMm);
          const uMax = Math.max(a.uMm + a.widthMm,  h.uMm + h.widthMm);
          const vMax = Math.max(a.vMm + a.heightMm, h.vMm + h.heightMm);
          const mPts = [[uMin,vMin],[uMax,vMin],[uMax,vMax],[uMin,vMax]]
            .map(([u,v]) => { const xyz=faceUV(u,v); return proj(xyz[0],xyz[1],xyz[2]); });
          ctx.fillStyle = 'rgba(251,191,36,0.22)';
          ctx.strokeStyle = 'rgba(251,191,36,1.0)';
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(mPts[0].x, mPts[0].y);
          for (let i=1; i<mPts.length; i++) ctx.lineTo(mPts[i].x, mPts[i].y);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = 'rgba(251,191,36,0.9)';
        ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`${_FACE_JP[doorPlaceMode] || doorPlaceMode}の扉区画 — クリックまたはドラッグ範囲で設置 / 他の面クリックで切替 / Escでキャンセル`, W/2, 18);
      }
      doorCandidateRef.current = doorCandidates;

      // ── Step 5: ギズモハンドル ──
      gizmoHandles.forEach(h => {
        const isPos = h.type === 'pos';
        // 軽い影
        ctx.globalAlpha = 0.2; ctx.fillStyle = '#000';
        if (isPos) {
          ctx.beginPath(); ctx.arc(h.sx + 0.5, h.sy + 1, 5.5, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.save(); ctx.translate(h.sx + 0.5, h.sy + 1); ctx.rotate(Math.PI / 4);
          ctx.fillRect(-4, -4, 8, 8); ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = isPos ? '#FBBF24' : '#7DD3FC';
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
        if (isPos) {
          ctx.beginPath(); ctx.arc(h.sx, h.sy, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } else {
          ctx.save(); ctx.translate(h.sx, h.sy); ctx.rotate(Math.PI / 4);
          ctx.fillRect(-3.5, -3.5, 7, 7); ctx.strokeRect(-3.5, -3.5, 7, 7); ctx.restore();
        }
      });
      ctx.globalAlpha = 1;

      // ── Step 6: 選択仕切りの距離ガイド（前後 + 端辺ギャップ）──
      if (selectedPartitionId) {
        const selPart = (panel.partitions || []).find(p => p.id === selectedPartitionId);
        const di = selPart ? _computePartitionDimInfo(selPart, panel) : null;
        const labels = {};
        const LOFF_Y = -16;
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;

        if (di) {
          const pPrev   = proj(...di.prevFaceW);
          const pSelLo  = proj(...di.selLoW);
          const pSelHi  = proj(...di.selHiW);
          const pNext   = proj(...di.nextFaceW);
          // 前後点線（シアン）
          ctx.strokeStyle = 'rgba(6,182,212,0.75)';
          ctx.beginPath(); ctx.moveTo(pPrev.x, pPrev.y); ctx.lineTo(pSelLo.x, pSelLo.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(pSelHi.x, pSelHi.y); ctx.lineTo(pNext.x, pNext.y); ctx.stroke();
          ctx.fillStyle = 'rgba(6,182,212,0.85)';
          [pPrev, pSelLo, pSelHi, pNext].forEach(p => {
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
          });
          ctx.globalAlpha = 1;
          const beforeActive = dimEditing && dimEditing.which === 'before';
          const afterActive  = dimEditing && dimEditing.which === 'after';
          // ラベルは寸法線の延長線上（壁の外側）に配置
          const lBefore = _extendPt(pSelLo, pPrev, 14);
          const lAfter  = _extendPt(pSelHi, pNext, 14);
          _drawDimLabel(ctx, lBefore.x, lBefore.y, `${Math.round(di.beforeDist)}`, beforeActive);
          _drawDimLabel(ctx, lAfter.x,  lAfter.y,  `${Math.round(di.afterDist)}`,  afterActive);
          labels.before = { sx: lBefore.x, sy: lBefore.y, initDist: di.beforeDist };
          labels.after  = { sx: lAfter.x,  sy: lAfter.y,  initDist: di.afterDist };
        }

        // 端辺ギャップ（仕切りが親箱から離れている場合）— 緑系
        if (selPart) {
          const edgeGaps = _computeEdgeGapInfo(selPart, panel);
          edgeGaps.forEach(gap => {
            const pFrom = proj(...gap.fromW);
            const pTo   = proj(...gap.toW_);
            ctx.strokeStyle = 'rgba(34,197,94,0.75)';
            ctx.beginPath(); ctx.moveTo(pFrom.x, pFrom.y); ctx.lineTo(pTo.x, pTo.y); ctx.stroke();
            ctx.fillStyle = 'rgba(34,197,94,0.85)';
            [pFrom, pTo].forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI*2); ctx.fill(); });
            const active = dimEditing && dimEditing.which === gap.which;
            const lGap = _extendPt(pFrom, pTo, 14);
            _drawDimLabel(ctx, lGap.x, lGap.y, `${Math.round(gap.dist)}`, active);
            labels[gap.which] = { sx: lGap.x, sy: lGap.y, initDist: gap.dist };
          });
        }
        ctx.setLineDash([]);
        dimLabelRef.current = Object.keys(labels).length ? labels : null;
      } else if (selectedDoorId) {
        // ── 選択中の扉の寸法ガイド（面端からの距離 + 扉自体の幅・高さ）──
        const selDoor = (panel.doors || []).find(d => d.id === selectedDoorId);
        if (selDoor && doorsVisible) {
          const { uMm: du, vMm: dv, widthMm: dw, heightMm: dh, face } = selDoor;
          const _W = panel.widthMm, _H = panel.heightMm, _D = panel.depthMm;
          const fuv = (u, v) => { switch(face) {
            case 'front':  return [u, 0,   v]; case 'back':   return [u, _D, v];
            case 'left':   return [0, u,   v]; case 'right':  return [_W, u, v];
            case 'top':    return [u, v,  _H]; case 'bottom': return [u, v,  0];
            default: return [u, 0, v];
          }};
          const FACE_MAX = {
            front:{uM:_W,vM:_H}, back:{uM:_W,vM:_H},
            left:{uM:_D,vM:_H},  right:{uM:_D,vM:_H},
            top:{uM:_W,vM:_D},   bottom:{uM:_W,vM:_D},
          };
          const { uM, vM } = FACE_MAX[face] || { uM: _W, vM: _H };
          const midU = du + dw / 2, midV = dv + dh / 2;

          const drawGap = (pA, pB, dist, fromB) => {
            ctx.strokeStyle = 'rgba(251,191,36,0.75)';
            ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
            ctx.fillStyle = 'rgba(251,191,36,0.85)';
            [pA, pB].forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI*2); ctx.fill(); });
            const lp = fromB ? _extendPt(pB, pA, 16) : _extendPt(pA, pB, 16);
            _drawDimLabel(ctx, lp.x, lp.y, `${Math.round(dist)}`, false);
          };

          ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
          if (du > 1)                      drawGap(proj(...fuv(0,    midV)), proj(...fuv(du,       midV)), du,     true);
          const uRight = uM - (du + dw);
          if (uRight > 1)                  drawGap(proj(...fuv(du+dw,midV)), proj(...fuv(uM,       midV)), uRight, false);
          if (dv > 1)                      drawGap(proj(...fuv(midU, 0   )), proj(...fuv(midU,     dv   )), dv,    true);
          const vTop = vM - (dv + dh);
          if (vTop > 1)                    drawGap(proj(...fuv(midU, dv+dh)), proj(...fuv(midU,    vM   )), vTop,  false);

          ctx.setLineDash([]);
        }
        dimLabelRef.current = null;
      } else {
        dimLabelRef.current = null;
      }

      // ── 方位キューブ（右上コーナー：カメラ回転に追従）──
      // project3DPanel と同じ回転行列(az/el)を使い、固定ピクセルスケールで描画
      {
        const QS = 42;                       // キューブ半幅[px]
        const QCX = W - 92, QCY = 85;       // キューブ中心[px]
        const cosA = Math.cos(az), sinA = Math.sin(az);
        const sinE = Math.sin(el), cosE = Math.cos(el);
        // (ix,iy,iz)∈[0,1]³ → canvas座標。キューブ中心が(QCX,QCY)に来るよう補正
        const qProj = (ix, iy, iz) => {
          const vx = ix - 0.5, vy = iy - 0.5, vz = iz - 0.5;
          const rx = vx * cosA + vy * sinA;
          const ry = vx * sinA - vy * cosA;
          return {
            x: QCX + rx * QS,
            y: QCY + (-ry * sinE - vz * cosE) * QS,
            depth: ry * cosE - vz * sinE,
          };
        };
        // 6面定義: corners=頂点インデックス, cx/cy/cz=面中心(ソート/ラベル用)
        // tAz/tEl: クリック時の正対カメラ角度
        const CUBE_FACES = [
          { c:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]], label:'前面', fill:'rgb(29,78,216)',  str:'#93C5FD', tc:'#E0EAFF', cx:.5,cy:0, cz:.5, tAz:0,         tEl:0 },
          { c:[[0,1,0],[1,1,0],[1,1,1],[0,1,1]], label:'後面', fill:'rgb(23,60,172)',  str:'#3B82F6', tc:'#BFDBFE', cx:.5,cy:1, cz:.5, tAz:Math.PI,   tEl:0 },
          { c:[[1,0,0],[1,1,0],[1,1,1],[1,0,1]], label:'右面', fill:'rgb(4,108,78)',   str:'#6EE7B7', tc:'#D1FAE5', cx:1, cy:.5,cz:.5, tAz:Math.PI/2, tEl:0 },
          { c:[[0,0,0],[0,1,0],[0,1,1],[0,0,1]], label:'左面', fill:'rgb(3,84,63)',    str:'#10B981', tc:'#A7F3D0', cx:0, cy:.5,cz:.5, tAz:-Math.PI/2,tEl:0 },
          { c:[[0,0,1],[1,0,1],[1,1,1],[0,1,1]], label:'上面', fill:'rgb(146,100,0)',  str:'#FCD34D', tc:'#FEF3C7', cx:.5,cy:.5,cz:1, tAz:null,       tEl:-Math.PI/2+0.05 },
          { c:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]], label:'下面', fill:'rgb(113,76,0)',   str:'#F59E0B', tc:'#FDE68A', cx:.5,cy:.5,cz:0, tAz:null,       tEl:Math.PI/2-0.05 },
        ];
        // 面中心depthでソート → 奥から手前の順に描画（ペインターズアルゴリズム）
        const sorted = CUBE_FACES.map(f => ({ ...f, sd: qProj(f.cx,f.cy,f.cz).depth }))
                                  .sort((a,b) => a.sd - b.sd);
        ctx.save();
        ctx.setLineDash([]);
        const qFS = 9;
        const gizmoHits = [];
        for (const f of sorted) {
          const pts = f.c.map(([ix,iy,iz]) => qProj(ix,iy,iz));
          // 手前側（sd>0）の面のみクリック対象
          if (f.sd > 0) gizmoHits.push({ pts, tAz: f.tAz, tEl: f.tEl, label: f.label });
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
          ctx.closePath();
          ctx.fillStyle = f.fill; ctx.fill();
          ctx.strokeStyle = f.str; ctx.lineWidth = 0.8; ctx.stroke();
          const cp = qProj(f.cx, f.cy, f.cz);
          ctx.font = `bold ${qFS}px sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillStyle = f.tc; ctx.globalAlpha = 0.9;
          ctx.fillText(f.label, cp.x, cp.y);
        }
        _gizmoHitRef.current = gizmoHits;
        // 軸矢印（前面左下隅 = qProj(0,0,0) から外側へ）
        const qO = qProj(0, 0, 0);
        const qArrow = (tip, label, col, alpha) => {
          const dx = tip.x - qO.x, dy = tip.y - qO.y;
          const len = Math.sqrt(dx*dx + dy*dy); if (len < 1) return;
          const nx = dx/len, ny = dy/len;
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(qO.x, qO.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - nx*5 + ny*3, tip.y - ny*5 - nx*3);
          ctx.lineTo(tip.x - nx*5 - ny*3, tip.y - ny*5 + nx*3);
          ctx.closePath(); ctx.fill();
          ctx.font = `bold ${qFS}px sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(label, tip.x + nx * (qFS + 1), tip.y + ny * (qFS + 1));
        };
        ctx.globalAlpha = 1;
        qArrow(qProj(1.7, 0, 0), 'X', '#F87171', 1.0);
        qArrow(qProj(0, 0, 1.7), 'Z', '#4ADE80', 1.0);
        qArrow(qProj(0, 1.7, 0), 'Y', '#94A3B8', 0.35);
        // Y軸注記（奥行のみ・操作不可）
        const yTip = qProj(0, 1.7, 0);
        ctx.globalAlpha = 0.45;
        ctx.font = `${Math.max(7, qFS - 1)}px sans-serif`;
        ctx.fillStyle = '#94A3B8'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('奥行のみ', yTip.x + 3, yTip.y);
        ctx.restore();
      }

      ctx.fillStyle = 'rgba(148,163,184,0.7)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('ドラッグ: 移動　Ctrl+ドラッグ/中ボタン: 回転　ホイール: ズーム', W/2, H-8);
      if (gizmoHandles.length > 0) {
        ctx.fillStyle = 'rgba(251,191,36,0.85)';
        ctx.fillText('● 位置移動　◆ 端点/範囲変更', W/2, H-19);
      }
    } catch (err) {
      console.error('[PanelCanvas3D]', err);
      try {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1E293B'; ctx.fillRect(0,0,W,H);
        ctx.fillStyle = '#EF4444'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('描画エラー: ' + err.message, W/2, H/2);
      } catch(_) {}
    }
    }); // requestAnimationFrame
    return () => { if (_drawRafRef.current) { cancelAnimationFrame(_drawRafRef.current); _drawRafRef.current = null; } };
  }, [panel, camera, W, H, selectedPartitionIds, gizmoHandles, selectedEdge, dimEditing, doors, doorsVisible, doorPlaceMode, hoveredFace, selectedDoorId, doorSelAnchor, doorSelHover, showChamberColors, selectedIconId, selectedIconIds, hoverChamberId, iconDragPreview, showVirtual, hoveredPartitionId, hoveredDoorId, hoveredIconId, hoveredCableId, selectedCableId, cablesVisible, iconVisMode, iconLayouts, iconReorderPreview, cables, cableAddMode, cableEditMode, chambers, _drawVersion, dragResolution, dragRestoreDelay]);

  // カメラのref — タッチ・ホイールハンドラのクロージャで常に最新値を参照するため
  const cameraRef = useRef(camera);
  useEffect(() => { cameraRef.current = camera; }, [camera]);

  // ギズモ面クリック: 指定面に正対するようカメラをアニメーション
  const _gizmoAnimRef = useRef(null);
  const _snapToFace = useCallback((tAz, tEl) => {
    if (_gizmoAnimRef.current) cancelAnimationFrame(_gizmoAnimRef.current);
    const { az: sAz, el: sEl } = cameraRef.current;
    const targetAz = tAz ?? sAz; // null=上下面はaz維持
    const targetEl = tEl;
    // az差を[-π,π]に正規化（最短回転）
    let dAz = targetAz - sAz;
    while (dAz > Math.PI) dAz -= 2 * Math.PI;
    while (dAz < -Math.PI) dAz += 2 * Math.PI;
    const dEl = targetEl - sEl;
    const startTime = performance.now();
    const DURATION = 280;
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / DURATION);
      const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
      const newAz = sAz + dAz * ease;
      const newEl = sEl + dEl * ease;
      const fit = panelAutoFit(panel, newAz, newEl, W, H);
      setCamera(c => ({ ...c, az: newAz, el: newEl, zoom: fit.zoom * 0.78, panX: fit.panX, panY: fit.panY }));
      if (t < 1) _gizmoAnimRef.current = requestAnimationFrame(step);
      else _gizmoAnimRef.current = null;
    };
    _gizmoAnimRef.current = requestAnimationFrame(step);
  }, [panel, W, H, setCamera]);

  const touchRef = useRef(null);

  // 寸法入力確定: 入力した距離からposMmを逆算してupdatePartition
  const applyDimEdit = useCallback((newDist) => {
    if (!dimEditing || isNaN(newDist) || newDist < 0) return;
    const selPart = (panel.partitions || []).find(p => p.id === selectedPartitionId);
    if (!selPart || !updatePartition) return;
    const { which } = dimEditing;
    if (which === 'before' || which === 'after') {
      // 前後距離 → posMm を逆算
      const di = _computePartitionDimInfo(selPart, panel);
      if (!di) return;
      let newPos = which === 'before'
        ? di.prevFace + newDist + di.half
        : di.nextFace - newDist - di.half;
      newPos = Math.max(di.half, Math.min(di.maxVal - di.half, newPos));
      updatePartition(panel.id, selPart.id, { posMm: Math.round(newPos) }, { forceNew: true });
    } else {
      // 端辺ギャップ(uMin/uMax/vMin/vMax) → 対応フィールドを直接更新
      const { widthMm: W, heightMm: H, depthMm: D } = panel;
      const axis = selPart.axis;
      const uMaxW = axis === 'x' ? D : W;
      const vMaxW = axis === 'z' ? D : H;
      const ch = {};
      if (which === 'uMin') ch.uMinMm = Math.max(0, Math.round(newDist));
      else if (which === 'uMax') ch.uMaxMm = Math.min(uMaxW, Math.round(uMaxW - newDist));
      else if (which === 'vMin') ch.vMinMm = Math.max(0, Math.round(newDist));
      else if (which === 'vMax') ch.vMaxMm = Math.min(vMaxW, Math.round(vMaxW - newDist));
      if (Object.keys(ch).length) updatePartition(panel.id, selPart.id, ch, { forceNew: true });
    }
  }, [dimEditing, panel, selectedPartitionId, updatePartition]);

  const onMouseDown = useCallback((e) => {
    if (beginMerge) beginMerge();
    // 中央ボタンはカメラ回転専用 — アイコン・仕切り操作より優先
    if (e.button === 1) {
      e.preventDefault();
      const { az: az0, el: el0, panX: panX0, panY: panY0 } = cameraRef.current;
      dragRef.current = { type: 'rotate', x0: e.clientX, y0: e.clientY, az0, el0, panX0, panY0 };
      return;
    }
    // ギズモ（右上キューブ）クリック判定 — 左ボタンのみ
    // mousedownでは「面にヒットした」だけ記録し、スナップはmouseupで確定（ドラッグと区別）
    if (e.button === 0) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const gx = (e.clientX - rect.left) * (W / rect.width);
        const gy = (e.clientY - rect.top) * (H / rect.height);
        for (const { pts, tAz, tEl } of _gizmoHitRef.current) {
          if (_ptInPoly(gx, gy, pts)) {
            e.preventDefault();
            _gizmoDownRef.current = { tAz, tEl, x0: e.clientX, y0: e.clientY };
            return;
          }
        }
      }
    }
    if (_cableAddModeRef.current && e.button === 0) _cableMouseMovedRef.current = false;

    // ── ケーブルクリック判定（cableEditMode/cableAddMode未使用時） ──
    _cableClickRef.current = null;
    if (cablesVisible && !_cableEditModeRef.current && !_cableAddModeRef.current && e.button === 0) {
      const _cr = canvasRef.current?.getBoundingClientRect();
      if (_cr) {
        const _cmx = (e.clientX - _cr.left) * (W / _cr.width);
        const _cmy = (e.clientY - _cr.top) * (H / _cr.height);
        // 扉が手前にあるか確認（扉ポリゴン内なら扉優先）
        let _doorBlocks = false;
        for (const { pts } of doorHitRef.current) {
          let _inside = false;
          for (let _i = 0, _j = pts.length - 1; _i < pts.length; _j = _i++) {
            const _xi = pts[_i].x, _yi = pts[_i].y, _xj = pts[_j].x, _yj = pts[_j].y;
            if (((_yi > _cmy) !== (_yj > _cmy)) && (_cmx < (_xj - _xi) * (_cmy - _yi) / (_yj - _yi) + _xi))
              _inside = !_inside;
          }
          if (_inside) { _doorBlocks = true; break; }
        }
        // _iconOnlyMode: アイコンBoxの内側なら配線クリックを無効（アイコン優先）
        let _iconBlocks = false;
        if (_iconOnlyModeRef.current) {
          for (const { corners } of iconHitRef.current) {
            let _ins = false;
            for (let _i = 0, _j = corners.length - 1; _i < corners.length; _j = _i++) {
              const _xi = corners[_i].x, _yi = corners[_i].y, _xj = corners[_j].x, _yj = corners[_j].y;
              if (((_yi > _cmy) !== (_yj > _cmy)) && (_cmx < (_xj - _xi) * (_cmy - _yi) / (_yj - _yi) + _xi))
                _ins = !_ins;
            }
            if (_ins) { _iconBlocks = true; break; }
          }
        }
        let _bestId = null, _bestDist = 14; // 14px閾値
        if (!_doorBlocks && !_iconBlocks) {
          for (const { cableId, pts2d } of _cableHitDataRef.current) {
            for (let _i = 0; _i < pts2d.length - 1; _i++) {
              const _ax = pts2d[_i].x, _ay = pts2d[_i].y;
              const _bx = pts2d[_i+1].x, _by = pts2d[_i+1].y;
              const _dx = _bx - _ax, _dy = _by - _ay;
              const _len2 = _dx*_dx + _dy*_dy;
              let _t = _len2 > 0 ? ((_cmx-_ax)*_dx + (_cmy-_ay)*_dy) / _len2 : 0;
              _t = Math.max(0, Math.min(1, _t));
              const _dist = Math.hypot(_cmx - (_ax + _t*_dx), _cmy - (_ay + _t*_dy));
              if (_dist < _bestDist) { _bestDist = _dist; _bestId = cableId; }
            }
          }
        }
        if (_bestId) _cableClickRef.current = { cableId: _bestId, x0: e.clientX, y0: e.clientY };
      }
    }

    // ── 配置編集モード: 折れ点□ドラッグ開始判定 ──
    if (_cableEditModeRef.current && e.button === 0) {
      _cableMouseMovedRef.current = false;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const _sx = (e.clientX - rect.left) * (W / rect.width);
        const _sy = (e.clientY - rect.top)  * (H / rect.height);
        const _cem = _cableEditModeRef.current;
        const _ecable = _cablesRef.current.find(c => c.id === _cem.cableId);
        if (_ecable) {
          // waypointの2D座標を再計算して□・○ヒット判定（±8px）
          const _eps3d = [];
          const _fi = (panel.placedIcons || []).find(ic => ic.id === _ecable.fromIconId);
          const _fwx = _ecable.fromWx ?? _fi?.wx;
          if (_fwx != null) _eps3d.push({ wx: _fwx, wy: _ecable.fromWy ?? _fi?.wy, wz: _ecable.fromWz ?? _fi?.wz });
          for (const _wp of (_ecable.waypoints || [])) { if (_wp?.wx != null) _eps3d.push({ wx: _wp.wx, wy: _wp.wy, wz: _wp.wz }); }
          const _ti = (panel.placedIcons || []).find(ic => ic.id === _ecable.toIconId);
          const _tiwx = _ecable.toWx ?? _ti?.wx;
          if (_tiwx != null) _eps3d.push({ wx: _tiwx, wy: _ecable.toWy ?? _ti?.wy, wz: _ecable.toWz ?? _ti?.wz });
          const _hasFrom = (_fwx != null);
          const _hasTo = (_tiwx != null);
          const _fromOff = _hasFrom ? 1 : 0;
          const _toEnd = _hasTo ? _eps3d.length - 1 : _eps3d.length;
          // 同wiresetIdタップの端点□ヒット判定（Ctrlより前に判定）
          if (!e.ctrlKey && _ecable?.wiresetId) {
            const _tapCs = _cablesRef.current.filter(c => c.wiresetId === _ecable.wiresetId && c.id !== _ecable.id);
            let _tapHit = false;
            for (const _tc of _tapCs) {
              const _epList = [];
              // fromWx が null の場合はアイコン座標にフォールバック（アイコン接続タップ対応）
              const _tcFi = (panel.placedIcons || []).find(ic => ic.id === _tc.fromIconId);
              const _tcFwx = _tc.fromWx ?? _tcFi?.wx;
              if (_tcFwx != null) _epList.push({ wx: _tcFwx, wy: _tc.fromWy ?? _tcFi?.wy, wz: _tc.fromWz ?? _tcFi?.wz, endType: 'from', cableId: _tc.id });
              const _tcTi = (panel.placedIcons || []).find(ic => ic.id === _tc.toIconId);
              const _tcTwx = _tc.toWx ?? _tcTi?.wx;
              if (_tcTwx != null) _epList.push({ wx: _tcTwx, wy: _tc.toWy ?? _tcTi?.wy, wz: _tc.toWz ?? _tcTi?.wz, endType: 'to', cableId: _tc.id });
              for (const _ep of _epList) {
                const _p2 = proj(_ep.wx, _ep.wy, _ep.wz);
                if (Math.abs(_p2.x - _sx) <= 8 && Math.abs(_p2.y - _sy) <= 8) {
                  _wpDragRef.current = { wpIdx: _ep.endType, sx: _sx, sy: _sy, tapCableId: _ep.cableId };
                  dragRef.current = null;
                  _tapHit = true;
                  break;
                }
              }
              if (_tapHit) break;
            }
            if (_tapHit) return;
          }
          // Ctrl+スナップ点 → タップ作成ドラッグ（他ヒット判定より優先）
          if (e.ctrlKey) {
            const _nd = _cableNearestDotRef.current;
            if (_nd && Math.hypot(_sx - _nd.sx, _sy - _nd.sy) <= 8) {
              _tapDragRef.current = { fromWx: _nd.wx, fromWy: _nd.wy, fromWz: _nd.wz, fromChamberId: _nd.chamberId };
              dragRef.current = null;
              return;
            }
          }
          // from端点ヒット判定（白丸○）
          if (_hasFrom) {
            const _p2 = proj(_eps3d[0].wx, _eps3d[0].wy, _eps3d[0].wz);
            if (Math.abs(_p2.x - _sx) <= 8 && Math.abs(_p2.y - _sy) <= 8) {
              _wpDragRef.current = { wpIdx: 'from', sx: _sx, sy: _sy };
              dragRef.current = null;
              return;
            }
          }
          // to端点ヒット判定（白丸○）
          if (_hasTo) {
            const _lastIdx = _eps3d.length - 1;
            const _p2 = proj(_eps3d[_lastIdx].wx, _eps3d[_lastIdx].wy, _eps3d[_lastIdx].wz);
            if (Math.abs(_p2.x - _sx) <= 8 && Math.abs(_p2.y - _sy) <= 8) {
              _wpDragRef.current = { wpIdx: 'to', sx: _sx, sy: _sy };
              dragRef.current = null;
              return;
            }
          }
          // waypoint□ヒット判定（端点の内側のみ）
          for (let _pi = _fromOff; _pi < _toEnd; _pi++) {
            const _p2 = proj(_eps3d[_pi].wx, _eps3d[_pi].wy, _eps3d[_pi].wz);
            const _wpIdx = _pi - _fromOff;
            if (Math.abs(_p2.x - _sx) <= 8 && Math.abs(_p2.y - _sy) <= 8) {
              _wpDragRef.current = { wpIdx: _wpIdx, sx: _sx, sy: _sy };
              dragRef.current = null;
              return;
            }
          }
        }
      }
    }

    // 寸法入力中にキャンバスをクリックしたら入力確定して閉じる
    // e.preventDefault() が先に呼ばれると onBlur が発火しないため、ここで明示的に処理する
    if (dimEditing) {
      if (dimInputRef.current) applyDimEdit(parseFloat(dimInputRef.current.value));
      setDimEditing(null);
    }
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    // アイコンのmousedownヒットを記録（mouseupで小移動なら選択確定）
    // 複数重なる場合は depth 最大（最手前）を優先
    iconClickRef.current = null;
    iconMoveDragRef.current = null;
    {
      let bestIcon = null, bestDepth = -Infinity;
      for (const { icon, corners } of iconHitRef.current) {
        let inside = false;
        for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
          const xi = corners[i].x, yi = corners[i].y;
          const xj = corners[j].x, yj = corners[j].y;
          if (((yi > my) !== (yj > my)) && (mx < (xj - xi) * (my - yi) / (yj - yi) + xi))
            inside = !inside;
        }
        if (inside) {
          const depth = corners.reduce((s, p) => s + p.depth, 0) / corners.length;
          if (depth > bestDepth) { bestDepth = depth; bestIcon = icon; }
        }
      }
      if (bestIcon) {
        // 扉が手前にある場合はアイコンhitを無効化（扉優先）
        let doorBlocksIcon = false;
        for (const { pts, depth: dDepth } of doorHitRef.current) {
          let inside = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            if (((yi > my) !== (yj > my)) && (mx < (xj - xi) * (my - yi) / (yj - yi) + xi))
              inside = !inside;
          }
          if (inside && dDepth >= bestDepth) { doorBlocksIcon = true; break; }
        }
        if (!doorBlocksIcon) {
        if (bestIcon.id === selectedIconId) {
          // グループ内かどうかをrefから判定して記録
          let groupKey = null, originalSlotIdx = null;
          for (const [gk, info] of iconGroupRef.current) {
            const idx = info.iconIds.indexOf(bestIcon.id);
            if (idx !== -1) { groupKey = gk; originalSlotIdx = idx; break; }
          }
          iconMoveDragRef.current = { icon: bestIcon, x0: e.clientX, y0: e.clientY, groupKey, originalSlotIdx };
          // mousemove前にAltサイクルを有効化: mousedown位置で区画リストを即初期化
          {
            const { az: azD, el: elD, zoom: zD, panX: pxD, panY: pyD } = cameraRef.current;
            const hitD = _hitTestFace(e.clientX - rect.left, e.clientY - rect.top, panel, azD, elD, zD, pxD, pyD, W, H);
            if (hitD) {
              const allChs = hitAllChambers(hitD.face, hitD.uMm, hitD.vMm, chambers, panel);
              const slots0 = buildAltSlots(hitD.face, hitD.uMm, hitD.vMm, allChs, panel);
              altSlotsRef.current = slots0;
              altSelectedSlotRef.current = null;
              lastDragCursorRef.current = { clientX: e.clientX, clientY: e.clientY };
              if (slots0.length >= 2) setAltDepthInfo({ idx: 1, total: slots0.length, label: _slotLabel(slots0[0]) });
            }
          }
        } else {
          iconClickRef.current = { icon: bestIcon, x0: e.clientX, y0: e.clientY, _cableMode: !!_cableAddModeRef.current };
        }
        } // !doorBlocksIcon
      }
    }
    if (iconMoveDragRef.current) return;
    for (const h of gizmoHandles) {
      if (Math.hypot(mx - h.sx, my - h.sy) < 12) {
        const part = (panel.partitions || []).find(p => p.id === selectedPartitionId);
        if (!part) break;
        let targetPartId = part.id;
        const initVals = {};
        let _initUMinsOrig = null, _initUMaxsOrig = null; // Ctrl+drag時にShift追加でモード切替する用

        if (e.ctrlKey && e.shiftKey && h.type === 'pos' && addPartition) {
          // Ctrl+Shift+ドラッグ: 水平方向に複製（uMin/uMaxをシフト）
          const uHandle = gizmoHandles.find(gh => gh.type === 'uMax');
          const _uDragAxis = uHandle ? uHandle.dragAxis : (part.axis === 'z' ? 'x' : part.axis === 'x' ? 'y' : 'x');
          const _uDefaultMax = part.axis === 'x' ? panel.depthMm : panel.widthMm;
          const idMap = {};
          const initUMins = {}, initUMaxs = {};
          for (const selId of selectedPartitionIds) {
            const selPart = (panel.partitions || []).find(pt => pt.id === selId);
            if (!selPart) continue;
            const { id: _unused, ...partData } = selPart;
            const newId = addPartition(panel.id, partData);
            if (newId) {
              idMap[selId] = newId;
              initUMins[newId] = selPart.uMinMm ?? 0;
              initUMaxs[newId] = selPart.uMaxMm ?? _uDefaultMax;
            }
          }
          const primaryNewId = idMap[part.id];
          if (primaryNewId) {
            targetPartId = primaryNewId;
            if (onSelectPartitions) onSelectPartitions(Object.values(idMap));
          }
          if (canvasRef.current) canvasRef.current.style.cursor = 'copy';
          gizmoDragRef.current = {
            handle: h, initVal: part[h.field] ?? h.defaultVal, initVals,
            primaryAxis: part.axis,
            x0: e.clientX, y0: e.clientY, partitionId: targetPartId,
            _isDup: true, _dupIds: Object.values(idMap), _lastShift: true,
            _horizDup: true, _uDragAxis, initUMins, initUMaxs,
            _initUMinsOrig: { ...initUMins }, _initUMaxsOrig: { ...initUMaxs },
          };
          return;
        } else if (e.ctrlKey && h.type === 'pos' && addPartition) {
          // Ctrl+ドラッグ: 選択中の全仕切りを複製（複数選択対応）
          const idMap = {};
          _initUMinsOrig = {}; _initUMaxsOrig = {}; // Shift追加時のため複製元のuMin/uMaxを保存
          for (const selId of selectedPartitionIds) {
            const selPart = (panel.partitions || []).find(pt => pt.id === selId);
            if (!selPart) continue;
            const { id: _unused, ...partData } = selPart;
            const newId = addPartition(panel.id, partData);
            if (newId) {
              idMap[selId] = newId;
              initVals[newId] = selPart[h.field] ?? h.defaultVal;
              const _uDef = (selPart.axis === 'x') ? panel.depthMm : panel.widthMm;
              _initUMinsOrig[newId] = selPart.uMinMm ?? 0;
              _initUMaxsOrig[newId] = selPart.uMaxMm ?? _uDef;
            }
          }
          const primaryNewId = idMap[part.id];
          if (primaryNewId) {
            targetPartId = primaryNewId;
            if (onSelectPartitions) onSelectPartitions(Object.values(idMap));
          }
        } else {
          // 通常ドラッグ: 選択中の全仕切りの初期値を保存（同軸の仕切りに一括適用するため）
          selectedPartitionIds.forEach(id => {
            const p = (panel.partitions || []).find(pt => pt.id === id);
            if (p) initVals[id] = p[h.field] ?? h.defaultVal;
          });
        }

        if (canvasRef.current) canvasRef.current.style.cursor = (e.ctrlKey && h.type === 'pos') ? 'copy' : 'grabbing';
        const _isDupDrag = e.ctrlKey && h.type === 'pos';
        gizmoDragRef.current = {
          handle: h, initVal: part[h.field] ?? h.defaultVal, initVals,
          primaryAxis: part.axis,
          x0: e.clientX, y0: e.clientY, partitionId: targetPartId,
          _isDup: _isDupDrag, _dupIds: _isDupDrag ? Object.keys(initVals) : null,
          _initUMinsOrig: _isDupDrag ? (_initUMinsOrig || {}) : null,
          _initUMaxsOrig: _isDupDrag ? (_initUMaxsOrig || {}) : null,
          _lastShift: false,
        };
        return;
      }
    }
    // 親箱辺ハンドル（選択辺中点 ●）
    if (selectedEdge) {
      const [emx, emy, emz] = _edgeMidpointMm(selectedEdge, panel);
      const emp = proj(emx, emy, emz);
      if (Math.hypot(mx - emp.x, my - emp.y) < 12) {
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
        edgeDragRef.current = {
          edge: selectedEdge,
          x0: e.clientX, y0: e.clientY,
          initW: panel.widthMm, initH: panel.heightMm, initD: panel.depthMm,
        };
        return;
      }
    }
    // 選択中の扉を直接ドラッグで移動（配置モードでない場合）
    if (!doorPlaceMode && selectedDoorId && e.button === 0) {
      const DOOR_AXES = {
        front:{u:'x',v:'z'}, back:{u:'x',v:'z'},
        left:{u:'y',v:'z'},  right:{u:'y',v:'z'},
        top:{u:'x',v:'y'},   bottom:{u:'x',v:'y'},
      };
      const doorHit = doorHitRef.current.find(h => h.door.id === selectedDoorId);
      if (doorHit && _ptInPoly(mx, my, doorHit.pts)) {
        const d = doorHit.door;
        const axes = DOOR_AXES[d.face] || { u: 'x', v: 'z' };
        doorPosDragRef.current = {
          doorId: d.id, x0: e.clientX, y0: e.clientY,
          initUMm: d.uMm, initVMm: d.vMm, initWMm: d.widthMm, initHMm: d.heightMm,
          uAxis: axes.u, vAxis: axes.v,
        };
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
        return;
      }
    }
    // 扉配置モード（候補面選択後）: セル上でマウスダウン → ドラッグ選択開始（カメラドラッグを阻止）
    if (doorPlaceMode && doorPlaceMode !== 'hover') {
      const hit = doorCandidateRef.current.find(({pts}) => _ptInPoly(mx, my, pts));
      if (hit) {
        doorDragRef.current = { anchor: hit.cell };
        doorAnchorRef.current = hit.cell;
        doorHoverRef.current = hit.cell;
        setDoorSelAnchor(hit.cell);
        setDoorSelHover(hit.cell);
        return;
      }
    }
    const { az: az0, el: el0, panX: panX0, panY: panY0 } = cameraRef.current;
    // 方位キューブ領域ドラッグ → 視点回転（Ctrl不要）
    const QCX_HIT = W - 92, QCY_HIT = 85, QS_HIT = 42;
    if (e.button === 0 && Math.hypot(mx - QCX_HIT, my - QCY_HIT) < QS_HIT * 1.9) {
      dragRef.current = { type: 'rotate', x0: e.clientX, y0: e.clientY, az0, el0, panX0, panY0 };
      return;
    }
    const isRot = e.button === 1 || (e.button === 0 && e.ctrlKey);
    dragRef.current = { type: isRot ? 'rotate' : 'pan', x0: e.clientX, y0: e.clientY, az0, el0, panX0, panY0 };
  }, [gizmoHandles, panel, selectedPartitionId, selectedPartitionIds, selectedEdge, W, H, addPartition, onSelectPartitions, proj, dimEditing, applyDimEdit, doorPlaceMode, selectedDoorId, selectedIconId, cablesVisible]);

  const onMouseMove = useCallback((e) => {
    // ── 配置編集モード: カーソル位置追跡 + 折れ点ドラッグ追跡 ──
    if (_cableEditModeRef.current) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const _sx = (e.clientX - rect.left) * (W / rect.width);
        const _sy = (e.clientY - rect.top)  * (H / rect.height);
        _editCursorRef.current = { sx: _sx, sy: _sy };
        if (_wpDragRef.current && (e.buttons & 1)) {
          _wpDragRef.current = { ..._wpDragRef.current, sx: _sx, sy: _sy };
        }
        // 常に描画更新（スナップ点計算のため）
        _setDrawVersion(v => v + 1);
      }
    } else {
      _editCursorRef.current = null;
      _wpDragRef.current = null;
    }
    // ── ケーブルルートモード: カーソル位置更新 + 区画ホバー（Altで奥行きサイクル） ──
    if (_cableAddModeRef.current) {
      // ボタン押下中のmousemove → ドラッグ判定フラグを立てる（mouseupでのケーブル点登録を抑制）
      if (e.buttons & 1) _cableMouseMovedRef.current = true;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        _cableCursorRef.current = {
          x: (e.clientX - rect.left) * (W / rect.width),
          y: (e.clientY - rect.top)  * (H / rect.height),
        };
        const { az: _azC, el: _elC, zoom: _zC, panX: _pxC, panY: _pyC } = cameraRef.current;
        const _hf = _hitTestFace(e.clientX - rect.left, e.clientY - rect.top, panel, _azC, _elC, _zC, _pxC, _pyC, W, H);
        if (_hf) {
          const allChs = hitAllChambers(_hf.face, _hf.uMm, _hf.vMm, chambers, panel);
          // カーソルが20px以上動いたらサイクルリセット
          const _prevCur = _cableCursorRef._prev;
          const _curX = e.clientX, _curY = e.clientY;
          if (!_prevCur || Math.hypot(_curX - _prevCur.x, _curY - _prevCur.y) > 20) {
            _cableAltCycleRef.current = 0;
            _cableAltWasDownRef.current = false;
          }
          _cableCursorRef._prev = { x: _curX, y: _curY };
          _cableAllChsRef.current = allChs;
          _cableHitFaceRef.current = _hf;
          // チャンバーはカーソル位置で決定（Altはy深度に使う）
          const _hch = allChs[0] ?? null;
          if (onHoverChamber) onHoverChamber(_hch ? _hch.id : null);
          // y深度オーバーレイ表示（buildAltSlotsでicon dragと同じカウント）
          if (allChs.length > 0) {
            const _slots = buildAltSlots(_hf.face, _hf.uMm, _hf.vMm, allChs, panel);
            const _at = _slots.length;
            const _as = _cableAltCycleRef.current % Math.max(1, _at);
            const _sl = _slots[_as] ? _slotLabel(_slots[_as]) : '';
            if (_at >= 2) setAltDepthInfo({ idx: _as + 1, total: _at, label: _sl });
            else setAltDepthInfo(null);
          } else {
            setAltDepthInfo(null);
          }
          if (_hch) {
            const _cx = _cableCursorRef.current.x;
            const _cy = _cableCursorRef.current.y;
            let _nearCell = null, _nearDist = Infinity;
            for (const cell of _hch.cells) {
              const wcx = (cell.xMin + cell.xMax) / 2;
              const wcy = (cell.yMin + cell.yMax) / 2;
              const wcz = (cell.zMin + cell.zMax) / 2;
              const cp = project3DPanel(wcx, wcy, wcz, panel.widthMm, panel.heightMm, panel.depthMm, _azC, _elC, _zC, _pxC, _pyC, W, H);
              const d = Math.hypot(cp.x - _cx, cp.y - _cy);
              if (d < _nearDist) { _nearDist = d; _nearCell = { chamberId: _hch.id, wx: wcx, wy: wcy, wz: wcz }; }
            }
            _cableHoverCellRef.current = _nearCell;
          } else {
            _cableHoverCellRef.current = null;
          }
        } else {
          _cableAllChsRef.current = [];
          _cableAltCycleRef.current = 0;
          _cableAltWasDownRef.current = false;
          _cableHoverCellRef.current = null;
          if (onHoverChamber) onHoverChamber(null);
        }
        _setDrawVersion(v => v + 1);
      }
      // カメラドラッグ中・アイコンドラッグ中は通常のmousemove処理に続く
      if (!dragRef.current && !iconMoveDragRef.current) return;
    }
    // 選択済みアイコンのドラッグ移動中: ホバー区画 + プレビュー座標を更新
    if (iconMoveDragRef.current) {
      const { x0, y0, groupKey, originalSlotIdx } = iconMoveDragRef.current;
      if (Math.hypot(e.clientX - x0, e.clientY - y0) > 5) {
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
        const rect = canvasRef.current.getBoundingClientRect();
        const sx2 = W / rect.width, sy2 = H / rect.height;
        const mx2 = (e.clientX - rect.left) * sx2, my2 = (e.clientY - rect.top) * sy2;
        _iconDragCursorRef.current = { sx: mx2, sy: my2 };

        const { az: azM, el: elM, zoom: zM, panX: pxM, panY: pyM } = cameraRef.current;
        const hit = _hitTestFace(e.clientX - rect.left, e.clientY - rect.top, panel, azM, elM, zM, pxM, pyM, W, H);
        const hch = hit ? hitChamber(hit.face, hit.uMm, hit.vMm, chambers, panel) : null;

        // Altサイクル用: リオーダー/通常モード両方で常に更新（リオーダー中もAlt押下を有効にする）
        lastDragCursorRef.current = { clientX: e.clientX, clientY: e.clientY };
        if (hit) {
          const allChs = hitAllChambers(hit.face, hit.uMm, hit.vMm, chambers, panel);
          const builtSlots = buildAltSlots(hit.face, hit.uMm, hit.vMm, allChs, panel);
          altSlotsRef.current = builtSlots;
        } else {
          altSlotsRef.current = [];
        }

        // ── グループアイコン: 明示的に別区画に移った場合のみ通常移動、それ以外はリオーダーモード ──
        const info = groupKey ? iconGroupRef.current.get(groupKey) : null;
        const movedToOtherChamber = info && hch && chamberStableKey(hch) !== info.chamberKey;
        if (info && !movedToOtherChamber) {
          // リオーダーモード: 最近スロットを探す（スクリーン座標で近傍判定）
          let nearestIdx = originalSlotIdx, nearestDist = Infinity;
          info.slotPositions.forEach((sp, i) => {
            const d = Math.hypot(mx2 - sp.screenX, my2 - sp.screenY);
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
          });
          const newRp = nearestIdx !== originalSlotIdx
            ? { groupKey, fromIdx: originalSlotIdx, toIdx: nearestIdx }
            : null;
          if ((newRp?.toIdx ?? -1) !== (iconReorderPreviewRef.current?.toIdx ?? -1)) {
            iconReorderPreviewRef.current = newRp;
            setIconReorderPreview(newRp);
          }
          setIconDragPreview(null);
          if (onHoverChamber) onHoverChamber(hch ? hch.id : null);
          return;
        }

        // ── 通常移動モード（別区画に明示移動 or グループでない）──
        iconReorderPreviewRef.current = null;
        setIconReorderPreview(null);
        // スロットリストを参照してaltCycleRefが指すスロットの区画・モードでプレビュー計算（altSlotsRefはすでに更新済み）
        const slots = altSlotsRef.current;
        let targetSlot = null;
        let targetCh = hch;
        if (hit && slots.length > 0) {
          const idx = altCycleRef.current % slots.length;
          targetSlot = slots[idx];
          targetCh = targetSlot.ch;
          if (slots.length >= 2) {
            const _lbl = _slotLabel(targetSlot);
            setAltDepthInfo({ idx: idx + 1, total: slots.length, label: _lbl });
          } else {
            setAltDepthInfo(null);
          }
        } else {
          setAltDepthInfo(null);
        }
        if (onHoverChamber) onHoverChamber(targetCh ? targetCh.id : null);
        const preview = (hit && targetSlot) ? (
          targetSlot.mode === 'ySpecific'
            ? _computeIconPlacement(hit.face, hit.uMm, hit.vMm, targetSlot.ch, panel, false, targetSlot.iy)
            : _computeIconPlacement(hit.face, hit.uMm, hit.vMm, targetSlot.ch, panel, targetSlot.mode === 'yUnified')
        ) : null;
        setIconDragPreview(preview);
        window.dispatchEvent(new CustomEvent('panelIconDragPreview', { detail: preview }));
      }
      return;
    }
    // ドラッグ中でない場合: ハンドル・選択可能エリアのホバー時にカーソル更新
    if (!dragRef.current && !gizmoDragRef.current && !edgeDragRef.current && !doorPosDragRef.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = W / rect.width, sy = H / rect.height;
      const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;

      if (doorPlaceMode === 'hover') {
        // 扉配置ホバーモード: 外箱の最前面を検出してhoveredFaceを更新
        const { az: azH, el: elH } = cameraRef.current;
        const faceDefs = _boxFaceDefs(panel.widthMm, panel.depthMm, panel.heightMm);
        let newHoveredFace = null, bestFaceDepth = -Infinity;
        for (const face of faceDefs) {
          if (panelIsBackFacing(face.normal, azH, elH)) continue;
          const pts = face.verts.map(([x,y,z]) => proj(x,y,z));
          if (_ptInPoly(mx, my, pts)) {
            const depth = pts.reduce((s,p) => s+p.depth, 0) / pts.length;
            if (depth > bestFaceDepth) { bestFaceDepth = depth; newHoveredFace = face.id; }
          }
        }
        if (newHoveredFace !== hoveredFace) setHoveredFace(newHoveredFace);
        canvasRef.current.style.cursor = newHoveredFace ? 'pointer' : 'default';
      } else {
        // 通常ホバー処理
        let cur = null;
        // ギズモハンドル（優先）
        for (const h of gizmoHandles) {
          if (Math.hypot(mx - h.sx, my - h.sy) < 12) {
            cur = (e.ctrlKey && h.type === 'pos') ? 'copy' : 'grab';
            break;
          }
        }
        // 選択辺中点ハンドル（●）優先
        if (cur === null && selectedEdge) {
          const [emx, emy, emz] = _edgeMidpointMm(selectedEdge, panel);
          const emp = proj(emx, emy, emz);
          if (Math.hypot(mx - emp.x, my - emp.y) < 12) cur = 'grab';
        }
        // 親箱エッジ（8px以内 → 指差し）
        if (cur === null) {
          const { widthMm: PW, heightMm: PH, depthMm: PD } = panel;
          const cpH = [[0,0,0],[PW,0,0],[PW,PD,0],[0,PD,0],[0,0,PH],[PW,0,PH],[PW,PD,PH],[0,PD,PH]]
            .map(([x,y,z]) => proj(x,y,z));
          for (const [a, b] of BOX_EDGES) {
            if (_distToSegment(mx, my, cpH[a].x, cpH[a].y, cpH[b].x, cpH[b].y) < 8) {
              cur = 'pointer'; break;
            }
          }
        }
        // 仕切り面（ポリゴン内 → 指差し）
        if (cur === null) {
          const { az: azH, el: elH } = cameraRef.current;
          for (const solid of solids) {
            if (solid._isOuter) continue;
            for (const f of (solid.faces || [])) {
              if (!f.vertices || f.vertices.length < 3) continue;
              if (panelIsBackFacing(f.normal, azH, elH)) continue;
              const pts = f.vertices.map(v => proj(v.x, v.y, v.z));
              if (_ptInPoly(mx, my, pts)) { cur = 'pointer'; break; }
            }
            if (cur !== null) break;
          }
        }
        // cableEditMode中でCtrl+スナップ丸の表示面積内 → 複製カーソル。それ以外は通常カーソル
        if (_cableEditModeRef.current) {
          const _DOT_R = 8;
          const _snap = _cableNearestDotRef.current;
          const _onDot = _snap != null && mx != null &&
            Math.hypot(mx - _snap.sx, my - _snap.sy) <= _DOT_R;
          canvasRef.current.style.cursor = (e.ctrlKey && _onDot) ? _CABLE_CTRL_CURSOR_URL : (cur ?? 'grab');
        } else {
          canvasRef.current.style.cursor = cur ?? 'grab';
        }
        // 扉配置モード（候補面選択後）: セルホバー追跡（ドラッグ中も含む）
        if (doorPlaceMode && doorPlaceMode !== 'hover') {
          const hit = doorCandidateRef.current.find(({pts}) => _ptInPoly(mx, my, pts));
          const hoverCell = hit ? hit.cell : null;
          const prevKey = doorHoverRef.current
            ? `${doorHoverRef.current.uMm}_${doorHoverRef.current.vMm}_${doorHoverRef.current.widthMm}_${doorHoverRef.current.heightMm}` : null;
          const newKey = hoverCell
            ? `${hoverCell.uMm}_${hoverCell.vMm}_${hoverCell.widthMm}_${hoverCell.heightMm}` : null;
          if (prevKey !== newKey) {
            doorHoverRef.current = hoverCell;
            setDoorSelHover(hoverCell);
          }
          if (hit) canvasRef.current.style.cursor = 'crosshair';
        }
      }
    }
    if (gizmoDragRef.current) {
      // Shiftキーの変化を検出: 複製ドラッグ中に垂直/水平モードを切り替える
      if (gizmoDragRef.current._isDup && e.shiftKey !== gizmoDragRef.current._lastShift) {
        const gd = gizmoDragRef.current;
        // x0/y0・初期値はmousedown時点のまま保持し、モードフラグだけ切り替える
        // → 「mousedown位置から垂直/水平のどちらかで動かした場合」の位置になる
        const uHandle = gizmoHandles.find(gh => gh.type === 'uMax');
        const _uDragAxis = uHandle?.dragAxis ?? (gd.primaryAxis === 'z' ? 'x' : gd.primaryAxis === 'x' ? 'y' : 'x');
        // モード切替: 切替前に動かした分を物理的にリセットしてからモードを変える
        const _resetUMins = gd._initUMinsOrig || gd.initUMins || {};
        const _resetUMaxs = gd._initUMaxsOrig || gd.initUMaxs || {};
        if (e.shiftKey) {
          // vert→horiz: posMmをmousedown時点の値に戻す
          for (const id of (gd._dupIds || [])) {
            const iv = (gd.initVals || {})[id] ?? gd.initVal;
            if (updatePartition) updatePartition(panel.id, id, { [gd.handle.field]: iv });
          }
        } else {
          // horiz→vert: uMinMm/uMaxMmをmousedown時点の値に戻す
          for (const id of (gd._dupIds || [])) {
            if (updatePartition) updatePartition(panel.id, id, { uMinMm: _resetUMins[id] ?? 0, uMaxMm: _resetUMaxs[id] ?? panel.widthMm });
          }
        }
        gizmoDragRef.current = { ...gd, _horizDup: e.shiftKey, _uDragAxis, initUMins: _resetUMins, initUMaxs: _resetUMaxs, _lastShift: e.shiftKey };
        // フラグ更新後そのまま今フレームの移動も処理するためreturnしない
      }

      const { handle, initVal, initVals, primaryAxis, x0, y0, partitionId, _horizDup, _uDragAxis, initUMins, initUMaxs } = gizmoDragRef.current;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      const { az, el, zoom, panX, panY } = cameraRef.current;

      if (_horizDup) {
        // Ctrl+Shift+ドラッグ: uMin/uMaxを水平方向にシフト
        const av = panelAxisScreenVec(_uDragAxis, panel, az, el, zoom, panX, panY, W, H);
        if (av.len2 > 1 && updatePartition) {
          const delta = Math.round((dx * av.dx + dy * av.dy) / av.len2 * 100);
          for (const [id, initUMin] of Object.entries(initUMins)) {
            const initUMax = initUMaxs[id];
            updatePartition(panel.id, id, { uMinMm: initUMin + delta, uMaxMm: initUMax + delta });
          }
        }
        return;
      }

      const av = panelAxisScreenVec(handle.dragAxis, panel, az, el, zoom, panX, panY, W, H);
      if (av.len2 > 1) {
        let nv = Math.round(initVal + (dx * av.dx + dy * av.dy) / av.len2 * 100);
        if (!altKeyRef.current) {
          const targets = _getSnapTargets(handle.dragAxis, panel, partitionId);
          const threshMm = 800 / Math.sqrt(av.len2);
          nv = _applySnap(nv, targets, threshMm);
        }
        if (updatePartition) {
          updatePartition(panel.id, partitionId, { [handle.field]: nv });
          // 複数選択中の同軸仕切りに同じ差分(delta)を適用
          const delta = nv - initVal;
          for (const id of selectedPartitionIds) {
            if (id === partitionId) continue;
            const p = (panel.partitions || []).find(pt => pt.id === id);
            if (!p || p.axis !== primaryAxis) continue;
            const iv = initVals[id] ?? nv;
            updatePartition(panel.id, id, { [handle.field]: Math.round(iv + delta) });
          }
        }
      }
      return;
    }
    // 辺ハンドルドラッグ: 親箱の辺を引き伸ばしてパネル寸法を変更
    if (edgeDragRef.current) {
      const { edge, x0, y0, initW, initH, initD } = edgeDragRef.current;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      const { az: azD, el: elD, zoom: zD, panX: pxD, panY: pyD } = cameraRef.current;
      const dragAxes = EDGE_DRAG_AXES[edge.join(',')];
      if (dragAxes && updatePanel) {
        const initDims = { widthMm: initW, heightMm: initH, depthMm: initD };
        // 各軸のスクリーン投影ベクトルからワールドΔ(mm)を計算
        const worldDeltas = dragAxes.map(({ worldAxis }) => {
          const av = panelAxisScreenVec(worldAxis, panel, azD, elD, zD, pxD, pyD, W, H);
          if (av.len2 < 1) return 0;
          return (dx * av.dx + dy * av.dy) / av.len2 * 100;
        });
        const changes = {};
        if (e.shiftKey) {
          // Shift: 移動量が大きい1軸のみ適用
          const di = Math.abs(worldDeltas[0]) >= Math.abs(worldDeltas[1]) ? 0 : 1;
          const { dim, atMax } = dragAxes[di];
          changes[dim] = Math.max(1, Math.round(initDims[dim] + worldDeltas[di] * (atMax ? 1 : -1)));
        } else {
          // 両軸同時に適用
          dragAxes.forEach(({ dim, atMax }, i) => {
            changes[dim] = Math.max(1, Math.round(initDims[dim] + worldDeltas[i] * (atMax ? 1 : -1)));
          });
        }
        // スナップ: 仕切りの辺・面位置に吸い付き（ALTキーで無効）
        if (!altKeyRef.current) {
          for (const axInfo of dragAxes) {
            if (!(axInfo.dim in changes)) continue;
            const av = panelAxisScreenVec(axInfo.worldAxis, panel, azD, elD, zD, pxD, pyD, W, H);
            if (av.len2 > 1) {
              const targets = _getEdgeSnapTargets(axInfo.dim, panel);
              const threshMm = 800 / Math.sqrt(av.len2);
              changes[axInfo.dim] = Math.max(1, _applySnap(changes[axInfo.dim], targets, threshMm));
            }
          }
        }
        updatePanel(panel.id, changes);
        // 友連れ: 移動する面に接している仕切りを追従更新
        // oldMax に panel[dim] (直前フレーム確定値) を使うことで毎フレーム連続追従できる
        if (updatePartition && panel.partitions) {
          for (const [dim, newMax] of Object.entries(changes)) {
            const oldMax = panel[dim];
            if (newMax === oldMax) continue;
            for (const { id, changes: pc } of _partitionsFollowingFace(panel.partitions, dim, oldMax, newMax)) {
              updatePartition(panel.id, id, pc);
            }
          }
        }
      }
      return;
    }
    // ── 扉位置ドラッグ: 選択中の扉をU/V軸方向に移動 ──
    if (doorPosDragRef.current) {
      const { doorId, initUMm, initVMm, initWMm, initHMm, x0, y0, uAxis, vAxis } = doorPosDragRef.current;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      const { az: azD, el: elD, zoom: zD, panX: pxD, panY: pyD } = cameraRef.current;
      const avU = panelAxisScreenVec(uAxis, panel, azD, elD, zD, pxD, pyD, W, H);
      const avV = panelAxisScreenVec(vAxis, panel, azD, elD, zD, pxD, pyD, W, H);
      let newU = initUMm, newV = initVMm;
      if (avU.len2 > 1) newU = Math.round(initUMm + (dx * avU.dx + dy * avU.dy) / avU.len2 * 100);
      if (avV.len2 > 1) newV = Math.round(initVMm + (dx * avV.dx + dy * avV.dy) / avV.len2 * 100);
      if (!altKeyRef.current) {
        const targU = _getSnapTargets(uAxis, panel, null);
        const targV = _getSnapTargets(vAxis, panel, null);
        const thrU = avU.len2 > 1 ? 800 / Math.sqrt(avU.len2) : 10;
        const thrV = avV.len2 > 1 ? 800 / Math.sqrt(avV.len2) : 10;
        // 左端・右端のうち近い方でスナップ
        const sUL = _applySnap(newU,           targU, thrU), dUL = Math.abs(sUL - newU);
        const sUR = _applySnap(newU + initWMm, targU, thrU), dUR = Math.abs(sUR - (newU + initWMm));
        if (dUL <= dUR && dUL < thrU) newU = sUL;
        else if (dUR < thrU)          newU = sUR - initWMm;
        // 下端・上端のうち近い方でスナップ
        const sVB = _applySnap(newV,           targV, thrV), dVB = Math.abs(sVB - newV);
        const sVT = _applySnap(newV + initHMm, targV, thrV), dVT = Math.abs(sVT - (newV + initHMm));
        if (dVB <= dVT && dVB < thrV) newV = sVB;
        else if (dVT < thrV)          newV = sVT - initHMm;
      }
      if (updateDoor) updateDoor(panel.id, doorId, { uMm: newU, vMm: newV });
      return;
    }
    // ギズモdownからドラッグ距離が5pxを超えたらカメラ回転に昇格
    if (_gizmoDownRef.current) {
      const { x0, y0 } = _gizmoDownRef.current;
      if (Math.hypot(e.clientX - x0, e.clientY - y0) > 5) {
        const { az: az0, el: el0, panX: panX0, panY: panY0 } = cameraRef.current;
        dragRef.current = { type: 'rotate', x0, y0, az0, el0, panX0, panY0 };
        _gizmoDownRef.current = null;
      } else {
        return; // まだ小移動中 → 何もしない
      }
    }

    // setCamera のコールバックは非同期実行されるため、dragRef.current をローカルにキャプチャ
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (drag.type === 'rotate') {
      const { az0, el0 } = drag;
      setCamera(c => ({
        ...c,
        az: az0 - dx * 0.008,  // 符号反転: カーソル右→右回転
        el: Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, el0 - dy * 0.008)),
      }));
    } else {
      const { panX0, panY0 } = drag;
      setCamera(c => ({ ...c, panX: panX0 + dx, panY: panY0 + dy }));
    }
    // マウス移動中フラグ: 静止後dragRestoreDelay ms でフル解像度に戻す
    _isCamMovingRef.current = true;
    if (_camMoveTimerRef.current) clearTimeout(_camMoveTimerRef.current);
    _camMoveTimerRef.current = setTimeout(() => {
      _isCamMovingRef.current = false;
      _setDrawVersion(v => v + 1);
    }, dragRestoreDelay);
  }, [panel, solids, W, H, updatePartition, updatePanel, setCamera, gizmoHandles, selectedEdge, proj, selectedPartitionIds, doorPlaceMode, hoveredFace, updateDoor, selectedDoorId, chambers, onHoverChamber, _snapToFace, dragRestoreDelay, beginMerge]);

  const onMouseUp = useCallback((e) => {
    // ギズモクリック確定: 小移動(≤5px)でmouseupが来たらスナップ実行
    if (_gizmoDownRef.current) {
      const { tAz, tEl, x0, y0 } = _gizmoDownRef.current;
      _gizmoDownRef.current = null;
      if (Math.hypot(e.clientX - x0, e.clientY - y0) <= 5) {
        _snapToFace(tAz, tEl);
        return;
      }
    }
    // ── 配置編集モード: タップ作成ドラッグ確定 ──
    if (_tapDragRef.current && e.button === 0) {
      const _td = _tapDragRef.current;
      _tapDragRef.current = null;
      const _nearest = _cableNearestDotRef.current;
      if (_nearest) {
        const _cableId = _cableEditModeRef.current?.cableId;
        onNewTap?.({
          fromWx: _td.fromWx, fromWy: _td.fromWy, fromWz: _td.fromWz, fromChamberId: _td.fromChamberId,
          toWx: _nearest.wx, toWy: _nearest.wy, toWz: _nearest.wz, toChamberId: _nearest.chamberId,
          cableId: _cableId,
        });
      }
      _setDrawVersion(v => v + 1);
      return;
    }
    // ── 配置編集モード: 折れ点□ドラッグ確定（iconMoveDragRefより前に判定） ──
    if (_wpDragRef.current && e.button === 0) {
      const _wd = _wpDragRef.current;
      _wpDragRef.current = null;
      console.log('[WP-MOUSEUP] drag end wpIdx=', _wd.wpIdx, 'cableId=', _cableEditModeRef.current?.cableId);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect && chambers.length > 0) {
        // Step 3.76 の描画ループが更新した区画中心スナップ先を使う（個別セルではなく区画全体中心）
        const _nearest = _cableNearestDotRef.current;
        if (_nearest) {
          // tapCableId があればタップ端点ドラッグ、なければ通常の母線/waypoint
          const _cableId = _wd.tapCableId || _cableEditModeRef.current?.cableId;
          if (_wd.wpIdx === 'from' || _wd.wpIdx === 'to') {
            onCableWpMove?.('endpoint', {
              wx: _nearest.wx, wy: _nearest.wy, wz: _nearest.wz,
              chamberId: _nearest.chamberId,
              endType: _wd.wpIdx,
              cableId: _cableId,
            });
          } else {
            onCableWpMove?.('chamber', {
              wx: _nearest.wx, wy: _nearest.wy, wz: _nearest.wz,
              chamberId: _nearest.chamberId,
              wpIdx: _wd.wpIdx,
              cableId: _cableId,
            });
          }
        } else {
          console.log('[WP-MOUSEUP] no snap → cancelled');
        }
      }
      _setDrawVersion(v => v + 1);
      return;
    }
    // 選択済みアイコンのドラッグ移動確定
    if (iconMoveDragRef.current) {
      const { icon, x0, y0, groupKey } = iconMoveDragRef.current;
      iconMoveDragRef.current = null;
      _iconDragCursorRef.current = null;
      const rp = iconReorderPreviewRef.current;
      const altSlot = altSelectedSlotRef.current; // keydown時点で確定したスロット（mousemoveの再構築に影響されない）
      altSelectedSlotRef.current = null;
      altCycleRef.current = 0;
      iconReorderPreviewRef.current = null;
      setIconReorderPreview(null);
      setIconDragPreview(null);
      window.dispatchEvent(new CustomEvent('panelIconDragPreview', { detail: null }));
      if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
      if (onHoverChamber) onHoverChamber(null);
      setAltDepthInfo(null);
      // Altで層選択済み or カーソルを5px以上動かした場合に配置処理
      const didMove = e.button === 0 && Math.hypot(e.clientX - x0, e.clientY - y0) > 5;
      const altSelected = altSlot !== null;
      if (e.button === 0 && (didMove || altSelected)) {
        if (rp && onReorderIcon && rp.fromIdx !== rp.toIdx) {
          // 同一グループ内リオーダー確定: 並び替え後のidリストを渡す
          const info = iconGroupRef.current.get(rp.groupKey);
          if (info) {
            const reorderedIds = [...info.iconIds];
            const [mv] = reorderedIds.splice(rp.fromIdx, 1);
            reorderedIds.splice(rp.toIdx, 0, mv);
            onReorderIcon(reorderedIds);
          }
        } else if (onMoveIcon) {
          // 通常移動（別区画への移動）— Alt未使用はhitChamber優先、Alt使用時はaltSlot(keydown確定)を参照
          const rect = canvasRef.current.getBoundingClientRect();
          const { az: azU, el: elU, zoom: zU, panX: pxU, panY: pyU } = cameraRef.current;
          const hit = _hitTestFace(e.clientX - rect.left, e.clientY - rect.top, panel, azU, elU, zU, pxU, pyU, W, H);
          if (hit) {
            let ch, pos;
            if (altSlot) {
              // Alt選択済み: keydown時点で確定したスロット（mousemoveの再構築に影響されない）
              ch = altSlot.ch;
              pos = altSlot.mode === 'ySpecific'
                ? _computeIconPlacement(hit.face, hit.uMm, hit.vMm, ch, panel, false, altSlot.iy)
                : _computeIconPlacement(hit.face, hit.uMm, hit.vMm, ch, panel, altSlot.mode === 'yUnified');
            } else {
              // Alt未使用: mouseup時点でslots[0]を使用（プレビューと一致させる）
              const allChsUp = hitAllChambers(hit.face, hit.uMm, hit.vMm, chambers, panel);
              const slotsUp = buildAltSlots(hit.face, hit.uMm, hit.vMm, allChsUp, panel);
              const defaultSlot = slotsUp.length > 0 ? slotsUp[0] : null;
              if (defaultSlot) {
                ch = defaultSlot.ch;
                pos = defaultSlot.mode === 'ySpecific'
                  ? _computeIconPlacement(hit.face, hit.uMm, hit.vMm, ch, panel, false, defaultSlot.iy)
                  : _computeIconPlacement(hit.face, hit.uMm, hit.vMm, ch, panel, defaultSlot.mode === 'yUnified');
              } else {
                ch = hitChamber(hit.face, hit.uMm, hit.vMm, chambers, panel);
                if (ch) pos = _computeIconPlacement(hit.face, hit.uMm, hit.vMm, ch, panel, false);
              }
            }
            if (ch && pos) {
              // face導出:
              //   standard(奥行き区画サイクル)のみ物理位置から自動導出 → 背面区画はface='back'になりカリング正常
              //   ySpecific/yUnified(Y奥行き分割サイクル)はhit.faceを保持 → 正面から置いたアイコンは正面から見える
              const { wx: px, wy: py, wz: pz } = pos;
              const PW = panel.widthMm, PH = panel.heightMm, PD = panel.depthMm;
              const savedFace = (altSlot && altSlot.mode === 'standard')
                ? [['front',py],['back',PD-py],['left',px],['right',PW-px],['bottom',pz],['top',PH-pz]]
                    .reduce((a,b) => a[1]<b[1]?a:b)[0]
                : hit.face;
              onMoveIcon(icon.id, ch.id, chamberStableKey(ch), pos.wx, pos.wy, pos.wz, pos.cellBox, savedFace);
            }
          }
        }
      }
      // ケーブルモード中かつ実際に移動しなかった場合: cableクリックハンドラに続ける
      if (_cableAddModeRef.current && !didMove && !altSelected) {
        // fall through to cable handler below
      } else {
        return;
      }
    }
    // ── 配置編集モード: waypoint○クリック or 移動先区画クリック ──
    // ※ cableEditModeはdepsにないためrefから読む
    const _cemUp = _cableEditModeRef.current;
    if (_cemUp && e.button === 0 && !_cableMouseMovedRef.current) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const sx = W / rect.width, sy = H / rect.height;
        const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
        // 編集中配線の最新pts3dを再取得して○ヒット判定
        const _ecable = _cablesRef.current.find(c => c.id === _cemUp.cableId);
        if (_ecable) {
          const _eps3d = [];
          const _fi = (panel.placedIcons || []).find(ic => ic.id === _ecable.fromIconId);
          const _fwx = _ecable.fromWx ?? _fi?.wx; if (_fwx != null) _eps3d.push({ wx: _fwx, wy: _ecable.fromWy ?? _fi?.wy, wz: _ecable.fromWz ?? _fi?.wz });
          for (const _wp of (_ecable.waypoints || [])) { if (_wp?.wx != null) _eps3d.push({ wx: _wp.wx, wy: _wp.wy, wz: _wp.wz }); }
          const _ti = (panel.placedIcons || []).find(ic => ic.id === _ecable.toIconId);
          if (_ti?.wx != null) _eps3d.push({ wx: _ti.wx, wy: _ti.wy, wz: _ti.wz });
          // waypointインデックスをクリックヒット判定（from端点がない場合の補正込み）
          const _fromOffUp = (_fwx != null) ? 1 : 0;
          const _toEndUp = (_ti?.wx != null) ? _eps3d.length - 1 : _eps3d.length;
          let _hitWpIdx = null;
          for (let _pi = _fromOffUp; _pi < _toEndUp; _pi++) {
            const _p2 = proj(_eps3d[_pi].wx, _eps3d[_pi].wy, _eps3d[_pi].wz);
            if (Math.hypot(_p2.x - mx, _p2.y - my) < 12) { _hitWpIdx = _pi - _fromOffUp; break; }
          }
          if (_hitWpIdx !== null) {
            onCableWpClick?.(_hitWpIdx);
            dragRef.current = null;
            return;
          }
          // waypoint選択中に区画クリック → 移動
          if (_cemUp.selectedWpIdx != null) {
            const _nd = _cableNearestDotRef.current;
            if (_nd) {
              onCableWpMove?.('chamber', {
                wx: _nd.wx, wy: _nd.wy, wz: _nd.wz,
                chamberId: _nd.chamberId,
                wpIdx: _cemUp.selectedWpIdx,
                cableId: _cemUp.cableId,
              });
            }
            dragRef.current = null;
            return;
          }
        }
      }
      // cableEditMode中の空間クリック（waypoint未ヒット）→ 編集モード終了
      dragRef.current = null;
      if (onCableClick) onCableClick(null);
      return;
    }
    // ── ケーブルルートモード クリック確定 ──
    if (_cableAddModeRef.current && onCablePoint && e.button === 0) {
      dragRef.current = null; // ドラッグ/クリックいずれもdragRefをクリア
      // mousemoveがあった（ドラッグ）場合はケーブル点を登録しない
      if (_cableMouseMovedRef.current) {
        _cableMouseMovedRef.current = false;
        return;
      }
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const sx = W / rect.width, sy = H / rect.height;
        const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
        // waypoints ステップ中に丸（チャンバードット）とアイコンが重なっている場合、丸を優先する
        const _cmNow = _cableAddModeRef.current;
        const _iconDist = iconClickRef.current
          ? Math.hypot(e.clientX - iconClickRef.current.x0, e.clientY - iconClickRef.current.y0)
          : Infinity;
        const _nearDot = _cableNearestDotRef.current;
        const _dotNearClick = _nearDot
          ? Math.hypot(_nearDot.sx - mx, _nearDot.sy - my)
          : Infinity;
        const _iconShouldFire = !!(iconClickRef.current?._cableMode
          && _iconDist < 5
          && !(_cmNow.step === 'waypoints' && _dotNearClick < 40));
        if (_iconShouldFire) {
          const ic = iconClickRef.current.icon;
          iconClickRef.current = null;
          // step='from'でアイコンをクリックした時、ホバー中の丸の座標を始点として渡す
          // （アイコンの幾何学的中央でなく、ユーザーが指した点を始点にする）
          const _fromDotExtra = (_cmNow.step === 'from' && _nearDot)
            ? { wx: _nearDot.wx, wy: _nearDot.wy, wz: _nearDot.wz }
            : null;
          onCablePoint('icon', ic.id, _fromDotExtra);
          return;
        }
        iconClickRef.current = null;
        // 区画クリック判定（'from' / 'waypoints' ステップ）
        // 描画したセル中心ドット（2D座標）への最近傍マッチ — 統合区画代表点ではなくセル単位で判定
        const _cm = _cableAddModeRef.current;
        if (_cm.step === 'waypoints' || _cm.step === 'from') {
          // ① 最優先: 描画ループが強調した丸を直接使用（描画とクリックで同じ点になる唯一の保証）
          const _nd = _cableNearestDotRef.current;
          if (_nd) {
            // ダブルクリック判定: 同じ区画を400ms以内に2回クリック → ケーブル完了
            const _now = performance.now();
            const _lastCk = _cableLastClickRef.current;
            if (_lastCk && _lastCk.chamberId === _nd.chamberId && (_now - _lastCk.time) < 400) {
              _cableLastClickRef.current = null;
              onCablePoint('complete', null, null);
              return;
            }
            _cableLastClickRef.current = { chamberId: _nd.chamberId, time: _now };
            onCablePoint('chamber', _nd.chamberId, { wx: _nd.wx, wy: _nd.wy, wz: _nd.wz });
            return;
          }

          // ② フォールバック: _cableNearestDotRef が null → _cableDotHitsRef から最近傍
          let _best = null, _bestDist = Infinity;
          for (const dot of _cableDotHitsRef.current) {
            const d = Math.hypot(dot.sx - mx, dot.sy - my);
            if (d < _bestDist) { _bestDist = d; _best = { chamberId: dot.chamberId, wx: dot.wx, wy: dot.wy, wz: dot.wz }; }
          }

          // ③ 更なるフォールバック: _cableDotHitsRef も空 → _cableAllChsRef から再計算
          if (!_best) {
            const { az: _az, el: _el, zoom: _z, panX: _px, panY: _py } = cameraRef.current;
            const _allChs = _cableAllChsRef.current;
            const _idx = _allChs.length > 0 ? _cableAltCycleRef.current % _allChs.length : 0;
            const _hch = _allChs[_idx] ?? null;
            if (_hch) {
              const _PW = panel.widthMm, _PH = panel.heightMm, _PD = panel.depthMm;
              const _eps = 0.5;
              const _WALLS = [
                { n:{nx:0,ny:-1,nz:0}, flt:c=>c.yMin<=_eps },
                { n:{nx:0,ny:+1,nz:0}, flt:c=>c.yMax>=_PD-_eps },
                { n:{nx:-1,ny:0,nz:0}, flt:c=>c.xMin<=_eps },
                { n:{nx:+1,ny:0,nz:0}, flt:c=>c.xMax>=_PW-_eps },
                { n:{nx:0,ny:0,nz:-1}, flt:c=>c.zMin<=_eps },
                { n:{nx:0,ny:0,nz:+1}, flt:c=>c.zMax>=_PH-_eps },
              ];
              const _visW = _WALLS.filter(w => !panelIsBackFacing(w.n, _az, _el));
              _bestDist = Infinity;
              for (const cell of _hch.cells) {
                if (!_visW.some(w => w.flt(cell))) continue;
                const wcx = (cell.xMin + cell.xMax) / 2;
                const wcy = (cell.yMin + cell.yMax) / 2;
                const wcz = (cell.zMin + cell.zMax) / 2;
                const cp = project3DPanel(wcx, wcy, wcz, _PW, _PH, _PD, _az, _el, _z, _px, _py, W, H);
                const d = Math.hypot(cp.x - mx, cp.y - my);
                if (d < _bestDist) { _bestDist = d; _best = { chamberId: _hch.id, wx: wcx, wy: wcy, wz: wcz }; }
              }
            }
          }

          if (_best && _bestDist < 80) {
            onCablePoint('chamber', _best.chamberId, { wx: _best.wx, wy: _best.wy, wz: _best.wz });
            return;
          }
        }
      }
      return;
    }

    // ケーブルクリック確定: 移動量 < 5px ならケーブル選択
    // ただしアイコンも同時にヒットしている場合はアイコンを優先（手前表示のため）
    if (_cableClickRef.current && e.button === 0) {
      const { cableId, x0, y0 } = _cableClickRef.current;
      const _iconAlsoHit = iconClickRef.current
        && Math.hypot(e.clientX - iconClickRef.current.x0, e.clientY - iconClickRef.current.y0) < 5;
      _cableClickRef.current = null;
      if (!_iconAlsoHit && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) {
        dragRef.current = null;
        gizmoDragRef.current = null;
        edgeDragRef.current = null;
        if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
        if (onCableClick) onCableClick(cableId);
        return; // 仕切り等の選択処理に流れないようブロック
      }
    }
    // ケーブル未ヒットで空間クリック → 選択解除 / 編集モード終了
    if (!_cableClickRef.current && !_cableAddModeRef.current && e.button === 0) {
      if (onCableClick) onCableClick(null);
    }
    // アイコン選択確定: mousedown時にヒットし、移動量 < 5px ならクリック確定
    // 配置編集モード中はアイコン選択をブロック
    if (_cableEditModeRef.current && iconClickRef.current) { iconClickRef.current = null; }
    if (iconClickRef.current && e.button === 0) {
      const { icon, x0, y0 } = iconClickRef.current;
      iconClickRef.current = null;
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < 5) {
        dragRef.current = null;
        gizmoDragRef.current = null;
        edgeDragRef.current = null;
        if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
        setSelectedEdge(null);
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+クリック: チェックトグル（単体選択は変えない）
          if (onToggleIconCheck) onToggleIconCheck(icon.id);
        } else {
          if (onSelectPartitions) onSelectPartitions([]);
          if (onSelectDoor) onSelectDoor(null);
          if (onSelectIcon) onSelectIcon(icon.id);
        }
        return;
      }
    }
    // ── 扉位置ドラッグ終了 ──
    if (doorPosDragRef.current) {
      const { doorId, x0, y0 } = doorPosDragRef.current;
      doorPosDragRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
      // 移動量が小さければクリック扱い → 開閉トグル
      if (e.button === 0 && Math.hypot(e.clientX - x0, e.clientY - y0) < 3) {
        const d = (panel.doors || []).find(dd => dd.id === doorId);
        if (d && updateDoor) updateDoor(panel.id, doorId, { isOpen: !d.isOpen }, { forceNew: true });
      }
      return;
    }
    const gd = gizmoDragRef.current;
    const drag = dragRef.current;
    const ed = edgeDragRef.current;
    dragRef.current = null;
    gizmoDragRef.current = null;
    edgeDragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    // カメラドラッグ終了: 軽量描画していた → フル品質で再描画
    if (drag?.type === 'rotate' || drag?.type === 'pan') {
      if (_camMoveTimerRef.current) { clearTimeout(_camMoveTimerRef.current); _camMoveTimerRef.current = null; }
      _isCamMovingRef.current = false;
      _setDrawVersion(v => v + 1);
    }
    // 辺ハンドルドラッグ終了 → クリック判定に進まない
    if (ed) return;

    // ── 扉配置モード: ドラッグ選択確定 ──
    if (doorDragRef.current) {
      const anchorCell  = doorDragRef.current.anchor;
      const currentCell = doorHoverRef.current ?? anchorCell; // ホバーがnullならアンカー単体
      doorDragRef.current = null; doorAnchorRef.current = null; doorHoverRef.current = null;
      setDoorSelAnchor(null); setDoorSelHover(null);
      if (e.button === 0 && doorPlaceMode && doorPlaceMode !== 'hover') {
        const uMin = Math.min(anchorCell.uMm, currentCell.uMm);
        const vMin = Math.min(anchorCell.vMm, currentCell.vMm);
        const uMax = Math.max(anchorCell.uMm + anchorCell.widthMm,  currentCell.uMm + currentCell.widthMm);
        const vMax = Math.max(anchorCell.vMm + anchorCell.heightMm, currentCell.vMm + currentCell.heightMm);
        // 新規扉設置
        if (addDoor) addDoor(panel.id, {
          face: doorPlaceMode,
          uMm: uMin, vMm: vMin, widthMm: uMax - uMin, heightMm: vMax - vMin,
          isOpen: false, hingeSide: 'left',
        });
        if (onSetDoorPlaceMode) onSetDoorPlaceMode(null);
        return;
      }
      return;
    }

    // ギズモドラッグでなく、左ボタンで5px未満の移動 → クリック判定
    // 配置編集モード中は仕切り・扉の選択を完全にブロック
    if (_cableEditModeRef.current) { dragRef.current = null; return; }
    // Ctrl+左クリックは drag.type='rotate' になるが、5px未満ならクリック判定する
    if (!gd && drag && e.button === 0) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) {
        // アイコン以外をクリック → アイコン選択解除
        if (selectedIconId && onSelectIcon) onSelectIcon(null);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const sx = W / rect.width, sy = H / rect.height;
        const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
        const { az, el } = cameraRef.current;
        const clickTransparency = pdcTransparency(panel);

        // ── 距離ラベルクリック（最優先）: before/after + uMin/uMax/vMin/vMax ──
        if (dimLabelRef.current && selectedPartitionId) {
          for (const which of Object.keys(dimLabelRef.current)) {
            const lb = dimLabelRef.current[which];
            if (lb && Math.hypot(mx - lb.sx, my - lb.sy) < 20) {
              setDimEditing({ which, sx: lb.sx, sy: lb.sy, initDist: lb.initDist ?? 0 });
              return;
            }
          }
        }

        // ── 扉配置モード: 面ホバークリック → 候補モードへ遷移 ──
        if (doorPlaceMode === 'hover') {
          if (hoveredFace && onSetDoorPlaceMode) onSetDoorPlaceMode(hoveredFace);
          return;
        }

        // ── 扉配置モード: 候補クリック ──
        if (doorPlaceMode) {
          for (const { cell, pts } of doorCandidateRef.current) {
            if (_ptInPoly(mx, my, pts)) {
              if (addDoor) addDoor(panel.id, {
                face: doorPlaceMode,
                uMm: cell.uMm, vMm: cell.vMm,
                widthMm: cell.widthMm, heightMm: cell.heightMm,
                isOpen: false, hingeSide: 'left',
              });
              if (onSetDoorPlaceMode) onSetDoorPlaceMode(null);
              return;
            }
          }
          // 候補外クリック: 別の可視面をクリックしたら面切り替え
          {
            const _fds = _boxFaceDefs(panel.widthMm, panel.depthMm, panel.heightMm);
            let clickedFace = null, bestFD = -Infinity;
            for (const face of _fds) {
              if (panelIsBackFacing(face.normal, az, el)) continue;
              const pts = face.verts.map(([x,y,z]) => proj(x,y,z));
              if (_ptInPoly(mx, my, pts)) {
                const depth = pts.reduce((s,p) => s+p.depth, 0) / pts.length;
                if (depth > bestFD) { bestFD = depth; clickedFace = face.id; }
              }
            }
            if (clickedFace && clickedFace !== doorPlaceMode && onSetDoorPlaceMode) {
              onSetDoorPlaceMode(clickedFace);
            }
          }
          return;
        }

        // ── 扉ヒットテスト（深度比較のため先に収集） ──
        let bestDoorDepth = -Infinity, bestDoor = null;
        for (const { door, pts, depth } of doorHitRef.current) {
          if (_ptInPoly(mx, my, pts) && depth > bestDoorDepth) {
            bestDoorDepth = depth; bestDoor = door;
          }
        }

        // ── 仕切り面ヒットテスト ──
        let bestPartDepth = -Infinity, bestPartId = null;
        solids.forEach(solid => {
          if (solid._isOuter) return;
          (solid.faces || []).forEach(f => {
            if (!f.vertices || f.vertices.length < 3) return;
            if (panelIsBackFacing(f.normal, az, el)) return;
            const pts = f.vertices.map(v => proj(v.x, v.y, v.z));
            if (_ptInPoly(mx, my, pts)) {
              const depth = _depthAtPoint(mx, my, pts);
              if (depth > bestPartDepth) { bestPartDepth = depth; bestPartId = solid._partitionId; }
            }
          });
        });

        // ── 親箱エッジヒットテスト（8px以内・最前面） ──
        const { widthMm: PW2, heightMm: PH2, depthMm: PD2 } = panel;
        const cp2 = [[0,0,0],[PW2,0,0],[PW2,PD2,0],[0,PD2,0],
                     [0,0,PH2],[PW2,0,PH2],[PW2,PD2,PH2],[0,PD2,PH2]]
          .map(([x,y,z]) => proj(x,y,z));
        let bestEdge = null, bestEdgeDepth = -Infinity;
        BOX_EDGES.forEach(([a, b]) => {
          const pa = cp2[a], pb = cp2[b];
          const d = _distToSegment(mx, my, pa.x, pa.y, pb.x, pb.y);
          if (d < 8) {
            const dxe = pb.x - pa.x, dye = pb.y - pa.y;
            const len2 = dxe*dxe + dye*dye;
            const t = len2 > 1e-10 ? Math.max(0, Math.min(1, ((mx-pa.x)*dxe + (my-pa.y)*dye) / len2)) : 0;
            const edgeDepth = pa.depth*(1-t) + pb.depth*t;
            if (edgeDepth > bestEdgeDepth) { bestEdgeDepth = edgeDepth; bestEdge = [a, b]; }
          }
        });

        // ── 仕切り vs エッジ vs 扉を深度で統一比較 → 最前面を選択 ──
        const partWins = clickTransparency > 0 && bestPartId !== null &&
          (bestEdge === null || bestPartDepth >= bestEdgeDepth) &&
          (bestDoor === null || bestPartDepth >= bestDoorDepth);
        const edgeWins = !partWins && bestEdge !== null &&
          (bestDoor === null || bestEdgeDepth >= bestDoorDepth);
        const doorWins = !partWins && !edgeWins && bestDoor !== null;

        if (partWins) {
          if (e.ctrlKey) {
            const newIds = selectedPartitionIds.includes(bestPartId)
              ? selectedPartitionIds.filter(x => x !== bestPartId)
              : [...selectedPartitionIds, bestPartId];
            if (onSelectPartitions) onSelectPartitions(newIds, true);
          } else {
            if (onSelectPartitions) onSelectPartitions([bestPartId], false);
            if (onSelectDoor) onSelectDoor(null);
            if (onSelectIcon) onSelectIcon(null);
          }
          setSelectedEdge(null);
        } else if (edgeWins) {
          setSelectedEdge(bestEdge);
          if (onSelectPartitions) onSelectPartitions([]);
          if (onSelectDoor) onSelectDoor(null);
          if (onSelectIcon) onSelectIcon(null);
        } else if (doorWins) {
          if (selectedDoorId === bestDoor.id) {
            if (updateDoor) updateDoor(panel.id, bestDoor.id, { isOpen: !bestDoor.isOpen }, { forceNew: true });
          } else {
            if (onSelectDoor) onSelectDoor(bestDoor.id);
          }
          if (onSelectPartitions) onSelectPartitions([]);
          if (onSelectIcon) onSelectIcon(null);
          setSelectedEdge(null);
        } else {
          if (!e.ctrlKey) {
            if (onSelectPartitions) onSelectPartitions([]);
            if (onSelectDoor) onSelectDoor(null);
          }
          setSelectedEdge(null);
        }
      }
    }
  }, [panel, W, H, proj, onSelectPartitions, selectedPartitionId, selectedPartitionIds, doorPlaceMode, addDoor, updateDoor, onSetDoorPlaceMode, hoveredFace, selectedDoorId, onSelectDoor, onSelectIcon, onToggleIconCheck, selectedIconId, onMoveIcon, chambers, onHoverChamber, onCableWpMove, onCableWpClick, onNewTap, cables, _setDrawVersion]);

  // ホイール・タッチは passive:false で登録しないと preventDefault が効かない
  // React の onWheel/onTouchXxx は passive 登録なので useEffect で直接登録する
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // カーソル/ピンチ中心位置を基準にズーム
    // 投影式: sx_screen = rx*zoom + panX + W/2 より、基準点を固定する条件:
    //   panX_new = ox + (panX_old - ox) * factor  (ox = cursorX - W/2)
    const _zoomAtPoint = (cursorX, cursorY, cW, cH, factor, cam) => {
      const newZoom = Math.max(0.02, Math.min(50, cam.zoom * factor));
      const af = newZoom / cam.zoom; // クランプ後の実倍率
      const ox = cursorX - cW / 2, oy = cursorY - cH / 2;
      return { zoom: newZoom, panX: ox + (cam.panX - ox) * af, panY: oy + (cam.panY - oy) * af };
    };

    const handleWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cW = canvas.width, cH = canvas.height;
      const cx = (e.clientX - rect.left) * (cW / (rect.width  || 1));
      const cy = (e.clientY - rect.top)  * (cH / (rect.height || 1));
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      // ズーム中は低解像度モード: 最後のwheelから150ms後に解除
      _isZoomingRef.current = true;
      if (_zoomTimerRef.current) clearTimeout(_zoomTimerRef.current);
      _zoomTimerRef.current = setTimeout(() => {
        _isZoomingRef.current = false;
        setCamera(c => ({ ...c })); // フル解像度で再描画トリガー
      }, 150);
      setCamera(c => ({ ...c, ..._zoomAtPoint(cx, cy, cW, cH, factor, c) }));
    };

    const handleTouchStart = (e) => {
      e.preventDefault();
      const { az, el, zoom, panX, panY } = cameraRef.current;
      if (e.touches.length === 1) {
        touchRef.current = { type: 'rotate', x0: e.touches[0].clientX, y0: e.touches[0].clientY, az0: az, el0: el };
      } else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        // ピンチ中心点を記録（開始時の pan も保存して絶対計算に使う）
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        touchRef.current = { type: 'pinch', dist0: d, zoom0: zoom, midX, midY, panX0: panX, panY0: panY };
      }
    };

    const handleTouchMove = (e) => {
      e.preventDefault();
      const touch = touchRef.current;
      if (!touch) return;
      if (touch.type === 'rotate' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - touch.x0, dy = e.touches[0].clientY - touch.y0;
        const { az0, el0 } = touch;
        setCamera(c => ({ ...c, az: az0 - dx * 0.008, el: Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, el0 - dy * 0.008)) }));
      } else if (touch.type === 'pinch' && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const { zoom0, dist0, midX, midY, panX0, panY0 } = touch;
        const rect = canvas.getBoundingClientRect();
        const cW = canvas.width, cH = canvas.height;
        const cx = (midX - rect.left) * (cW / (rect.width  || 1));
        const cy = (midY - rect.top)  * (cH / (rect.height || 1));
        const newZoom = Math.max(0.02, Math.min(50, zoom0 * d / (dist0 || 1)));
        const factor = newZoom / zoom0;
        const ox = cx - cW / 2, oy = cy - cH / 2;
        setCamera(c => ({ ...c, zoom: newZoom, panX: ox + (panX0 - ox) * factor, panY: oy + (panY0 - oy) * factor }));
      }
    };

    const handleTouchEnd = () => { touchRef.current = null; };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd);
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
    };
  }, [setCamera]); // setCamera は安定参照なので実質1回のみ登録

  // Alt キー押下でアイコンドラッグ中の層サイクルを進める
  // altAllChsRef に mousemove で計算済みの区画リストを使い、ヒットテスト再計算を省く
  useEffect(() => {
    const onAltDown = (e) => {
      if (e.key !== 'Alt' || e.repeat) return;
      // 配置編集中のみ: 緑丸/緑四角スナップ先のAltサイクル（アイコンドラッグ中はSystem1=Yスロットサイクルを優先）
      if (_cableEditModeRef.current && _cableNearestDotRef.current?.altCells) {
        e.preventDefault();
        _editAltCycleRef.current++;
        _setDrawVersion(v => v + 1);
        return;
      }
      // ケーブルモード中: y深度サイクルをkeydownで即時更新
      if (_cableAddModeRef.current) {
        e.preventDefault();
        _cableAltCycleRef.current++;
        _cableAltWasDownRef.current = true;
        // altDepthInfoオーバーレイを更新（buildAltSlotsでicon dragと同じカウント）
        const _allChsAlt = _cableAllChsRef.current;
        if (_allChsAlt.length > 0) {
          const _hfAlt = _cableHitFaceRef.current;
          const _slotsAlt = _hfAlt
            ? buildAltSlots(_hfAlt.face, _hfAlt.uMm, _hfAlt.vMm, _allChsAlt, panel)
            : _allChsAlt.map((ch, di) => ({ ch, mode: 'standard', depthIdx: di }));
          const _at = _slotsAlt.length;
          const _as = _cableAltCycleRef.current % Math.max(1, _at);
          const _sl = _slotsAlt[_as] ? _slotLabel(_slotsAlt[_as]) : '';
          if (_at >= 2) setAltDepthInfo({ idx: _as + 1, total: _at, label: _sl });
        }
        _setDrawVersion(v => v + 1);
        return;
      }
      if (!iconMoveDragRef.current) return; // アイコンドラッグ中のみ
      e.preventDefault(); // ブラウザのAltメニュー処理を抑止
      const slots = altSlotsRef.current;
      if (slots.length < 2) return;        // サイクルできるスロットがない場所ではスキップ
      altCycleRef.current = (altCycleRef.current + 1) % slots.length;
      const idx = altCycleRef.current;
      const slot = slots[idx];
      altSelectedSlotRef.current = slot;
      if (onHoverChamber) onHoverChamber(slot.ch ? slot.ch.id : null);
      const { clientX, clientY } = lastDragCursorRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { az, el, zoom, panX, panY } = cameraRef.current;
      const hit = _hitTestFace(clientX - rect.left, clientY - rect.top, panel, az, el, zoom, panX, panY, W, H);
      const preview = (hit && slot.ch) ? (
        slot.mode === 'ySpecific'
          ? _computeIconPlacement(hit.face, hit.uMm, hit.vMm, slot.ch, panel, false, slot.iy)
          : _computeIconPlacement(hit.face, hit.uMm, hit.vMm, slot.ch, panel, slot.mode === 'yUnified')
      ) : null;
      setIconDragPreview(preview);
      window.dispatchEvent(new CustomEvent('panelIconDragPreview', { detail: preview }));
      setAltDepthInfo({ idx: idx + 1, total: slots.length, label: _slotLabel(slot) });
    };
    window.addEventListener('keydown', onAltDown);
    return () => window.removeEventListener('keydown', onAltDown);
  }, [panel, W, H, onHoverChamber]); // chambers/altSlotsRef は ref なので deps 不要

  // Altキー状態をrefで追跡（PointerEventはaltKeyが不安定なため）
  useEffect(() => {
    const onDown = (e) => { if (e.key === 'Alt') altKeyRef.current = true; };
    const onUp   = (e) => { if (e.key === 'Alt') altKeyRef.current = false; };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup',   onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, []);

  // Delete/Backspace: 選択中の仕切りを削除
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!onDeletePartitions || !selectedPartitionIds.length) return;
      // input/textarea にフォーカスが当たっている時は無視
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      onDeletePartitions(selectedPartitionIds);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedPartitionIds, onDeletePartitions]);

  // Ctrl押下/解放でcableEditMode中のカーソルを即時更新（マウス移動不要）
  useEffect(() => {
    const _DOT_R = 8; // スナップ丸の表示半径＋余裕
    const _updateCtrlCursor = (e) => {
      if (e.key !== 'Control' || !_cableEditModeRef.current || !canvasRef.current) return;
      const _snap = _cableNearestDotRef.current;
      const _cur  = _editCursorRef.current;
      if (!_snap || !_cur) return;
      const _dist = Math.hypot(_cur.sx - _snap.sx, _cur.sy - _snap.sy);
      const _onDot = _dist <= _DOT_R;
      canvasRef.current.style.cursor = (e.type === 'keydown' && _onDot) ? _CABLE_CTRL_CURSOR_URL : 'grab';
    };
    window.addEventListener('keydown', _updateCtrlCursor);
    window.addEventListener('keyup',   _updateCtrlCursor);
    return () => {
      window.removeEventListener('keydown', _updateCtrlCursor);
      window.removeEventListener('keyup',   _updateCtrlCursor);
    };
  }, []);

  // ケーブルルートモードの最新値をrefに保存（useCallbackの再生成なしに最新値へアクセス）
  useEffect(() => {
    _cableAddModeRef.current = cableAddMode;
    // step='done' または モード終了: ゴースト系refを即座にクリアして残像を消す
    if (!cableAddMode || cableAddMode.step === 'done') {
      _cableAllChsRef.current = [];
      _cableHitFaceRef.current = null;
      _cableNearestDotRef.current = null;
      _cableDotHitsRef.current = [];
      _cableLastClickRef.current = null;
      _cableMouseMovedRef.current = false;
      setAltDepthInfo(null);
      if (onHoverChamber) onHoverChamber(null);
      _setDrawVersion(v => v + 1);
    }
    if (!cableAddMode) {
      _cableCursorRef.current = null;
      _cableCursorRef._prev = null;
      _cableAltCycleRef.current = 0;
    }
  }, [cableAddMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // 配置編集モードの最新値をrefに保存（RAFループから参照するため）
  useEffect(() => {
    _cableEditModeRef.current = cableEditMode;
    _setDrawVersion(v => v + 1); // null化時も即座に再描画して○を消す
  }, [cableEditMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // cablesの最新値をrefに保存（onMouseDownのstaleクロージャ対策）
  useEffect(() => {
    _cablesRef.current = cables;
  }, [cables]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position:'relative', width:W, height:H, display:'block' }}>
      <canvas ref={canvasRef} width={W} height={H}
        style={{ display:'block', touchAction:'none', userSelect:'none', cursor:'grab' }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onMouseDown(e); }}
        onPointerMove={onMouseMove}
        onPointerUp={(e) => { onMouseUp(e); if (endMerge) endMerge(); }}
        onDragOver={e => {
          e.preventDefault();
          if (!onHoverChamber || !chambers.length) return;
          const rect = canvasRef.current.getBoundingClientRect();
          const hit = _hitTestFace(e.clientX - rect.left, e.clientY - rect.top, panel, az, el, zoom, panX, panY, W, H);
          if (!hit) { onHoverChamber(null); setAltDepthInfo(null); return; }
          // カーソルが大きく動いたらサイクルをリセット
          const mdx = e.clientX - altLastPosRef.current.x, mdy = e.clientY - altLastPosRef.current.y;
          if (Math.hypot(mdx, mdy) > 20) { altCycleRef.current = 0; altKeyWasDownRef.current = false; }
          altLastPosRef.current = { x: e.clientX, y: e.clientY };
          // 新規Altキー押下でサイクルを1つ進める
          if (e.altKey && !altKeyWasDownRef.current) altCycleRef.current++;
          altKeyWasDownRef.current = e.altKey;
          // 射線上の全区画を取得して層インジケーター更新
          const allChs = hitAllChambers(hit.face, hit.uMm, hit.vMm, chambers, panel);
          const total = allChs.length;
          const idx = total > 0 ? altCycleRef.current % total : 0;
          if (total >= 2) setAltDepthInfo({ idx: idx + 1, total });
          else { setAltDepthInfo(null); altCycleRef.current = 0; }
          const ch = allChs[idx] ?? null;
          onHoverChamber(ch ? ch.id : null);
        }}
        onDragLeave={() => {
          if (onHoverChamber) onHoverChamber(null);
          setAltDepthInfo(null);
          altCycleRef.current = 0;
          altKeyWasDownRef.current = false;
        }}
        onDrop={e => {
          e.preventDefault();
          if (onHoverChamber) onHoverChamber(null);
          setAltDepthInfo(null);
          if (!onDropIcon) return;
          const raw = e.dataTransfer.getData('application/panel-icon');
          if (!raw) return;
          const rect = canvasRef.current.getBoundingClientRect();
          const hit = _hitTestFace(e.clientX - rect.left, e.clientY - rect.top, panel, az, el, zoom, panX, panY, W, H);
          if (!hit) return;
          // 新規ドロップ: hitChamber + カーソル位置Y（ySpecific相当）
          const ch = hitChamber(hit.face, hit.uMm, hit.vMm, chambers, panel);
          altCycleRef.current = 0;
          if (ch) {
            const pos = _computeIconPlacement(hit.face, hit.uMm, hit.vMm, ch, panel, false);
            if (!pos) return;
            onDropIcon(ch.id, chamberStableKey(ch), pos.wx, pos.wy, pos.wz, { ...JSON.parse(raw), cellBox: pos.cellBox, face: hit.face });
          }
        }}
      />
      {altDepthInfo && (
        <div style={{
          position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
          background: '#1E293B', color: '#FCD34D', fontSize: 11, fontWeight: 700,
          padding: '3px 10px', borderRadius: 4, border: '1px solid #FCD34D',
          pointerEvents: 'none', zIndex: 20, whiteSpace: 'nowrap',
        }}>
          Alt ← {altDepthInfo.idx}/{altDepthInfo.total} : {altDepthInfo.label ?? '次のスロット'}
        </div>
      )}
      {dimEditing && (
        <input
          ref={dimInputRef}
          key={`${dimEditing.which}-${dimEditing.sx}-${dimEditing.sy}`}
          type="number"
          defaultValue={Math.round(dimEditing.initDist ?? 0)}
          style={{
            position:'absolute',
            left: dimEditing.sx - 28, top: dimEditing.sy - 9,
            width:56, height:18, fontSize:11, fontWeight:'bold',
            textAlign:'center', padding:'0 2px',
            border:'2px solid #3B82F6', borderRadius:3,
            background:'#EFF6FF', color:'#1E40AF',
            outline:'none', zIndex:10,
          }}
          autoFocus
          onFocus={e => e.target.select()}
          onKeyDown={e => {
            if (e.key === 'Enter') { applyDimEdit(parseFloat(e.target.value)); setDimEditing(null); e.stopPropagation(); }
            if (e.key === 'Escape') { setDimEditing(null); e.stopPropagation(); }
          }}
          onBlur={e => { applyDimEdit(parseFloat(e.target.value)); setDimEditing(null); }}
        />
      )}
    </div>
  );
}
