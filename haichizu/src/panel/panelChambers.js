// ================================================================
// panelChambers.js — 配電盤内部の空間（Chamber）自動検出
// 仕切り(Partition)で区切られた閉領域をUnion-Findで検出する
// ================================================================

const CHAMBER_COLORS = [
  '#93C5FD', // blue
  '#6EE7B7', // green
  '#FCD34D', // yellow
  '#FCA5A5', // red
  '#C4B5FD', // purple
  '#F9A8D4', // pink
  '#7DD3FC', // sky
  '#86EFAC', // lime
  '#FB923C', // orange
  '#E879F9', // fuchsia
];

// パネルの仕切りに基づいてChamber（空間）を検出する
// 戻り値: [{ id, color, cells:[{xMin,xMax,yMin,yMax,zMin,zMax,ix,iy,iz}] }]
function deriveChambers(panel) {
  const W = panel.widthMm || 600, H = panel.heightMm || 1800, D = panel.depthMm || 400;
  const eps = 0.5;
  const parts = (panel.partitions || []).filter(p => p.type === 'axis');

  // 反復アルゴリズムで構造境界を決定
  // 両端が「外壁または既登録の構造境界」に接している仕切りのみグリッドに追加
  // sEps: 境界判定の許容誤差（リサイズ等によるmm誤差を吸収するため isBlocked より大きく取る）
  const sEps = 5.0;
  const structX = new Set([0, W]);
  const structY = new Set([0, D]);
  const structZ = new Set([0, H]);

  // 仕切りの範囲[lo,hi]が、構造境界セット s の中に少なくとも1つの
  // 完全な区間[xLo, xHi]（xLo < xHi）を内包するか判定する。
  // 旧ルール「両端が境界に接する」より広く、仕切りが途中から始まっていても
  // 構造列を完全にまたいでいれば構造境界と認める。
  const spansInterval = (lo, hi, s) => {
    const sorted = [...s].sort((a, b) => a - b);
    const xLo = sorted.find(x => x >= lo - sEps);
    const xHi = [...sorted].reverse().find(x => x <= hi + sEps);
    return xLo !== undefined && xHi !== undefined && xLo < xHi;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of parts) {
      const pos = p.posMm;
      if (pos == null) continue;
      if (p.axis === 'x') {
        if ([...structX].some(b => Math.abs(b - pos) <= sEps)) continue;
        const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? D; // u=Y方向
        const vMin = p.vMinMm ?? 0, vMax = p.vMaxMm ?? H; // v=Z方向
        if (spansInterval(uMin, uMax, structY) && spansInterval(vMin, vMax, structZ)) {
          structX.add(pos); changed = true;
        }
      } else if (p.axis === 'y') {
        if ([...structY].some(b => Math.abs(b - pos) <= sEps)) continue;
        const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? W; // u=X方向
        const vMin = p.vMinMm ?? 0, vMax = p.vMaxMm ?? H; // v=Z方向
        if (spansInterval(uMin, uMax, structX) && spansInterval(vMin, vMax, structZ)) {
          structY.add(pos); changed = true;
        }
      } else if (p.axis === 'z') {
        if ([...structZ].some(b => Math.abs(b - pos) <= sEps)) continue;
        const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? W; // u=X方向
        const vMin = p.vMinMm ?? 0, vMax = p.vMaxMm ?? D; // v=Y方向
        if (spansInterval(uMin, uMax, structX) && spansInterval(vMin, vMax, structY)) {
          structZ.add(pos); changed = true;
        }
      }
    }
  }

  // 構造境界のみをグリッドに使用（外壁は既に含まれている）
  const xSet = structX;
  const ySet = structY;
  const zSet = structZ;

  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);
  const zs = [...zSet].sort((a, b) => a - b);
  const NX = xs.length - 1, NY = ys.length - 1, NZ = zs.length - 1;
  const N = NX * NY * NZ;
  if (N <= 0) return [];

  // Union-Find（経路圧縮付き）
  const parent = Array.from({ length: N }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) { parent[find(a)] = find(b); }
  const idx = (ix, iy, iz) => ix * NY * NZ + iy * NZ + iz;

  // 指定位置の仕切り（複数可）がセル境界面を協力して完全に塞ぐかチェック
  // axis='x': u=Y方向, v=Z方向
  // axis='y': u=X方向, v=Z方向
  // axis='z': u=X方向, v=Y方向
  // つぎはぎ仕切り対応: u方向をカバーする全仕切りのv区間が連続してfaceLo2〜faceHi2を覆うか
  function isBlocked(axis, posMm, faceLo1, faceHi1, faceLo2, faceHi2) {
    const uBound = axis === 'x' ? D : W;
    const vBound = axis === 'z' ? D : H;
    const vIntervals = [];
    for (const p of parts) {
      if (p.axis !== axis) continue;
      const pos = p.posMm ?? uBound / 2;
      if (Math.abs(pos - posMm) > eps) continue;
      const uMin = p.uMinMm ?? 0, uMax = p.uMaxMm ?? uBound;
      if (uMin <= faceLo1 + sEps && uMax >= faceHi1 - sEps) {
        vIntervals.push([p.vMinMm ?? 0, p.vMaxMm ?? vBound]);
      }
    }
    if (vIntervals.length === 0) return false;
    vIntervals.sort((a, b) => a[0] - b[0]);
    let covered = faceLo2;
    for (const [a, b] of vIntervals) {
      if (a > covered + sEps) return false; // ギャップがあれば塞げない
      if (b > covered) covered = b;
      if (covered >= faceHi2 - sEps) return true;
    }
    return false;
  }

  // X境界: (ix, iy, iz) vs (ix+1, iy, iz) — x-axis仕切りがY×Z面を完全に塞ぐか
  for (let ix = 0; ix < NX - 1; ix++) {
    for (let iy = 0; iy < NY; iy++) {
      for (let iz = 0; iz < NZ; iz++) {
        if (!isBlocked('x', xs[ix + 1], ys[iy], ys[iy + 1], zs[iz], zs[iz + 1]))
          union(idx(ix, iy, iz), idx(ix + 1, iy, iz));
      }
    }
  }
  // Y境界: (ix, iy, iz) vs (ix, iy+1, iz) — y-axis仕切りがX×Z面を完全に塞ぐか
  for (let ix = 0; ix < NX; ix++) {
    for (let iy = 0; iy < NY - 1; iy++) {
      for (let iz = 0; iz < NZ; iz++) {
        if (!isBlocked('y', ys[iy + 1], xs[ix], xs[ix + 1], zs[iz], zs[iz + 1]))
          union(idx(ix, iy, iz), idx(ix, iy + 1, iz));
      }
    }
  }
  // Z境界: (ix, iy, iz) vs (ix, iy, iz+1) — z-axis仕切りがX×Y面を完全に塞ぐか
  for (let ix = 0; ix < NX; ix++) {
    for (let iy = 0; iy < NY; iy++) {
      for (let iz = 0; iz < NZ - 1; iz++) {
        if (!isBlocked('z', zs[iz + 1], xs[ix], xs[ix + 1], ys[iy], ys[iy + 1]))
          union(idx(ix, iy, iz), idx(ix, iy, iz + 1));
      }
    }
  }

  // ルート別にセルをグループ化
  const rootToGroup = {};
  for (let ix = 0; ix < NX; ix++) {
    for (let iy = 0; iy < NY; iy++) {
      for (let iz = 0; iz < NZ; iz++) {
        const root = find(idx(ix, iy, iz));
        if (!rootToGroup[root]) rootToGroup[root] = { root, cells: [] };
        rootToGroup[root].cells.push({
          xMin: xs[ix], xMax: xs[ix + 1],
          yMin: ys[iy], yMax: ys[iy + 1],
          zMin: zs[iz], zMax: zs[iz + 1],
          ix, iy, iz,
        });
      }
    }
  }

  return Object.values(rootToGroup).map((g, i) => ({
    id: 'chamber_' + g.root,
    color: CHAMBER_COLORS[i % CHAMBER_COLORS.length],
    cells: g.cells,
  }));
}

// 扉がどの Chamber に面しているかを返す（なければ null）
// 扉UV中心を3D点に変換し、その点を含む Chamber を探す
// UV座標系は chamberFaceRects と同一（u/v の向きが face ごとに異なる）
function doorToChamberId(door, chambers, panel) {
  if (!door || !chambers || chambers.length === 0) return null;
  const { face, uMm, vMm, widthMm, heightMm } = door;
  const W = panel.widthMm, H = panel.heightMm, D = panel.depthMm;
  const eps = 0.5;
  const uc = uMm + widthMm / 2;
  const vc = vMm + heightMm / 2;
  // face ごとに UV → 3D内部点（壁面から eps だけ内側）
  let x, y, z;
  switch (face) {
    case 'front':  x = uc;     y = eps;     z = H - vc; break;
    case 'back':   x = W - uc; y = D - eps; z = H - vc; break;
    case 'left':   x = eps;    y = D - uc;  z = H - vc; break;
    case 'right':  x = W - eps; y = uc;     z = H - vc; break;
    case 'top':    x = uc;     y = D - vc;  z = H - eps; break;
    case 'bottom': x = uc;     y = vc;      z = eps;    break;
    default: return null;
  }
  for (const ch of chambers) {
    for (const cell of ch.cells) {
      if (x >= cell.xMin - eps && x <= cell.xMax + eps &&
          y >= cell.yMin - eps && y <= cell.yMax + eps &&
          z >= cell.zMin - eps && z <= cell.zMax + eps) {
        return ch;
      }
    }
  }
  return null;
}

// 指定face上に投影した Chamber のSVGローカル矩形を返す
// 戻り値: [{ u, v, w, h }]（face SVG内のローカル座標; ox/oyはPanelSliceViews側で加算）
function chamberFaceRects(chamber, face, W, H, D) {
  const eps = 0.5;
  const rects = [];
  for (const cell of chamber.cells) {
    const { xMin, xMax, yMin, yMax, zMin, zMax } = cell;
    let r = null;
    switch (face) {
      case 'front':   // y=0側: x×z 投影
        if (yMin <= eps) r = { u: xMin, v: H - zMax, w: xMax - xMin, h: zMax - zMin };
        break;
      case 'back':    // y=D側: x反転
        if (yMax >= D - eps) r = { u: W - xMax, v: H - zMax, w: xMax - xMin, h: zMax - zMin };
        break;
      case 'left':    // x=0側: y反転(D-yMax)×z
        if (xMin <= eps) r = { u: D - yMax, v: H - zMax, w: yMax - yMin, h: zMax - zMin };
        break;
      case 'right':   // x=W側: y正方向×z
        if (xMax >= W - eps) r = { u: yMin, v: H - zMax, w: yMax - yMin, h: zMax - zMin };
        break;
      case 'top':     // z=H側: x×y反転(D-yMax)
        if (zMax >= H - eps) r = { u: xMin, v: D - yMax, w: xMax - xMin, h: yMax - yMin };
        break;
      case 'bottom':  // z=0側: x×y正方向
        if (zMin <= eps) r = { u: xMin, v: yMin, w: xMax - xMin, h: yMax - yMin };
        break;
    }
    if (r && r.w > eps && r.h > eps) rects.push(r);
  }
  return rects;
}

// ================================================================
// 区画カラーモード
// ================================================================

const GRAPH4_COLORS = ['#93C5FD', '#FCD34D', '#86EFAC', '#FCA5A5'];

// 隣接グラフ構築: セルインデックスが1違いで別Chamberなら隣接
function computeChamberAdjacency(chambers) {
  const cellMap = {};
  for (const ch of chambers) {
    for (const cell of ch.cells) {
      cellMap[`${cell.ix},${cell.iy},${cell.iz}`] = ch.id;
    }
  }
  const adj = {};
  for (const ch of chambers) {
    if (!adj[ch.id]) adj[ch.id] = new Set();
    for (const cell of ch.cells) {
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const key = `${cell.ix+dx},${cell.iy+dy},${cell.iz+dz}`;
        const adjId = cellMap[key];
        if (adjId && adjId !== ch.id) {
          adj[ch.id].add(adjId);
          if (!adj[adjId]) adj[adjId] = new Set();
          adj[adjId].add(ch.id);
        }
      }
    }
  }
  return adj;
}

// 仕切り変更がない限り不変のChamber識別キー（最小セルのmm座標）
function chamberStableKey(ch) {
  return ch.cells
    .map(c => `${c.xMin},${c.yMin},${c.zMin}`)
    .sort()[0];
}

// カラーモード適用
// mode: 'auto10' | 'graph4' | 'posHash' | 'manual'
// colorOverrides: { [stableKey]: hexColor } (manualモード用)
// graph4Colors: string[4] (graph4モード用カスタム色)
function applyColorMode(chambers, mode, colorOverrides, graph4Colors) {
  if (!chambers || chambers.length === 0) return chambers;

  if (mode === 'graph4') {
    const palette = (graph4Colors && graph4Colors.length === 4) ? graph4Colors : GRAPH4_COLORS;
    const adj = computeChamberAdjacency(chambers);
    const colorMap = {};
    for (const ch of chambers) {
      const used = new Set([...(adj[ch.id] || [])].map(id => colorMap[id]).filter(Boolean));
      colorMap[ch.id] = palette.find(c => !used.has(c)) || palette[0];
    }
    return chambers.map(ch => ({ ...ch, color: colorMap[ch.id] }));
  }

  if (mode === 'posHash') {
    return chambers.map(ch => {
      const cell = ch.cells.reduce((b, c) =>
        (c.xMin * 10000 + c.yMin * 100 + c.zMin < b.xMin * 10000 + b.yMin * 100 + b.zMin) ? c : b
      , ch.cells[0]);
      const h = Math.abs(Math.round(cell.xMin * 7 + cell.yMin * 13 + cell.zMin * 17)) % CHAMBER_COLORS.length;
      return { ...ch, color: CHAMBER_COLORS[h] };
    });
  }

  if (mode === 'manual') {
    const ov = colorOverrides || {};
    return chambers.map((ch, i) => {
      const key = chamberStableKey(ch);
      return { ...ch, color: ov[key] || CHAMBER_COLORS[i % CHAMBER_COLORS.length] };
    });
  }

  // auto10（デフォルト）: deriveChambers がインデックス順に割り当て済み
  return chambers;
}

// スクリーン上でヒットした face + UV座標 → Chamber を返す
// _hitTestFace の結果を受けて Chamber を特定する
function hitChamber(face, uMm, vMm, chambers, panel) {
  const W = panel.widthMm, H = panel.heightMm, D = panel.depthMm;
  const eps = 0.5;
  let x, y, z;
  switch (face) {
    case 'front':  x = uMm;     y = eps;     z = H - vMm; break;
    case 'back':   x = W - uMm; y = D - eps; z = H - vMm; break;
    case 'left':   x = eps;     y = D - uMm; z = H - vMm; break;
    case 'right':  x = W - eps; y = uMm;     z = H - vMm; break;
    case 'top':    x = uMm;     y = D - vMm; z = H - eps; break;
    case 'bottom': x = uMm;     y = vMm;     z = eps;     break;
    default: return null;
  }
  for (const ch of chambers) {
    for (const cell of ch.cells) {
      if (x >= cell.xMin - eps && x <= cell.xMax + eps &&
          y >= cell.yMin - eps && y <= cell.yMax + eps &&
          z >= cell.zMin - eps && z <= cell.zMax + eps) return ch;
    }
  }
  return null;
}

// カーソル射線上にある全区画を前→奥順で返す（Alt層サイクル用）
function hitAllChambers(face, uMm, vMm, chambers, panel) {
  const W = panel.widthMm, H = panel.heightMm, D = panel.depthMm;
  const eps = 0.5;
  const results = [];
  for (const ch of chambers) {
    for (const cell of ch.cells) {
      let matches = false, depth = 0;
      switch (face) {
        case 'front':
          matches = uMm >= cell.xMin-eps && uMm <= cell.xMax+eps &&
                    (H-vMm) >= cell.zMin-eps && (H-vMm) <= cell.zMax+eps;
          depth = cell.yMin; break;
        case 'back':
          matches = (W-uMm) >= cell.xMin-eps && (W-uMm) <= cell.xMax+eps &&
                    (H-vMm) >= cell.zMin-eps && (H-vMm) <= cell.zMax+eps;
          depth = D - cell.yMax; break;
        case 'left':
          matches = (D-uMm) >= cell.yMin-eps && (D-uMm) <= cell.yMax+eps &&
                    (H-vMm) >= cell.zMin-eps && (H-vMm) <= cell.zMax+eps;
          depth = cell.xMin; break;
        case 'right':
          matches = uMm >= cell.yMin-eps && uMm <= cell.yMax+eps &&
                    (H-vMm) >= cell.zMin-eps && (H-vMm) <= cell.zMax+eps;
          depth = W - cell.xMax; break;
        case 'top':
          matches = uMm >= cell.xMin-eps && uMm <= cell.xMax+eps &&
                    (D-vMm) >= cell.yMin-eps && (D-vMm) <= cell.yMax+eps;
          depth = H - cell.zMax; break;
        case 'bottom':
          matches = uMm >= cell.xMin-eps && uMm <= cell.xMax+eps &&
                    vMm >= cell.yMin-eps && vMm <= cell.yMax+eps;
          depth = cell.zMin; break;
      }
      if (matches) { results.push({ ch, depth }); break; }
    }
  }
  results.sort((a, b) => a.depth - b.depth);
  return results.map(r => r.ch);
}
