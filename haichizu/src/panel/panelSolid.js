// ================================================================
// panelSolid.js — パネルデータ → Solid[] 変換
// solidModel.js の blockToSolid を mm 座標でそのまま利用
// Zバッファレンダラが交差を正確に処理するため面クリップ不要
// ================================================================

function panelToSolids(panel) {
  if (!panel) return [];
  const { id, name, widthMm: W, heightMm: H, depthMm: D, color, partitions } = panel;
  const solids = [];

  const outerPts = [
    { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D },
  ];
  const outerSolid = blockToSolid(id, 0, name || '配電盤', color || '#4A90D9', outerPts, 0, H);
  if (outerSolid) { outerSolid._isOuter = true; solids.push(outerSolid); }

  (partitions || []).forEach((part, idx) => {
    if (part.virtual) return; // 空想仕切りはソリッド生成しない（Canvas 2Dオーバーレイで描画）
    let s = null;
    if (part.type === 'axis') s = _axisPartSolid(panel, part, idx);
    else if (part.type === 'poly') s = panelPolyToSolid(panel, part, idx);
    if (s) solids.push(s);
  });

  return solids;
}

function _axisPartSolid(panel, part, idx) {
  const { widthMm: W, heightMm: H, depthMm: D } = panel;
  const t = part.thicknessMm > 0 ? part.thicknessMm : 2;
  const c = part.color || '#94A3B8';
  const pid = `${panel.id}_part_${part.id || idx}`;
  const half = t / 2;
  let pts, zB, zT;

  if (part.axis === 'x') {
    const x = part.posMm != null ? part.posMm : W / 2;
    const yMin = part.uMinMm != null ? part.uMinMm : 0;
    const yMax = part.uMaxMm != null ? part.uMaxMm : D;
    zB = part.vMinMm != null ? part.vMinMm : 0;
    zT = part.vMaxMm != null ? part.vMaxMm : H;
    pts = [{ x: x - half, y: yMin }, { x: x + half, y: yMin }, { x: x + half, y: yMax }, { x: x - half, y: yMax }];
  } else if (part.axis === 'y') {
    const y = part.posMm != null ? part.posMm : D / 2;
    const xMin = part.uMinMm != null ? part.uMinMm : 0;
    const xMax = part.uMaxMm != null ? part.uMaxMm : W;
    zB = part.vMinMm != null ? part.vMinMm : 0;
    zT = part.vMaxMm != null ? part.vMaxMm : H;
    pts = [{ x: xMin, y: y - half }, { x: xMax, y: y - half }, { x: xMax, y: y + half }, { x: xMin, y: y + half }];
  } else if (part.axis === 'z') {
    const z = part.posMm != null ? part.posMm : H / 2;
    const xMin = part.uMinMm != null ? part.uMinMm : 0;
    const xMax = part.uMaxMm != null ? part.uMaxMm : W;
    const yMin = part.vMinMm != null ? part.vMinMm : 0;
    const yMax = part.vMaxMm != null ? part.vMaxMm : D;
    zB = z - half; zT = z + half;
    pts = [{ x: xMin, y: yMin }, { x: xMax, y: yMin }, { x: xMax, y: yMax }, { x: xMin, y: yMax }];
  } else {
    return null;
  }

  const s = blockToSolid(pid, idx, part.name || '仕切り', c, pts, zB, zT);
  if (s) s._partitionId = part.id;
  return s;
}

function panelPolyToSolid(panel, part, idx) {
  const verts = part.vertices;
  if (!verts || verts.length < 3) return null;
  const e1 = { x: verts[1].x - verts[0].x, y: verts[1].y - verts[0].y, z: verts[1].z - verts[0].z };
  const e2 = { x: verts[2].x - verts[0].x, y: verts[2].y - verts[0].y, z: verts[2].z - verts[0].z };
  const cnx = e1.y * e2.z - e1.z * e2.y, cny = e1.z * e2.x - e1.x * e2.z, cnz = e1.x * e2.y - e1.y * e2.x;
  const clen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);
  if (clen < 1e-9) return null;
  const ux = cnx / clen, uy = cny / clen, uz = cnz / clen;
  const t = (part.thicknessMm > 0 ? part.thicknessMm : 2) / 2;
  const c = part.color || '#94A3B8';
  const pid = `${panel.id}_part_${part.id || idx}`;
  const n = verts.length;
  const front = verts.map(v => ({ x: v.x + ux * t, y: v.y + uy * t, z: v.z + uz * t }));
  const back  = verts.map(v => ({ x: v.x - ux * t, y: v.y - uy * t, z: v.z - uz * t }));
  const faces = [
    { id: _genFaceId(), type: 'top',    vertices: [...front],          normal: { nx: ux,  ny: uy,  nz: uz  } },
    { id: _genFaceId(), type: 'bottom', vertices: [...back].reverse(), normal: { nx: -ux, ny: -uy, nz: -uz } },
  ];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const wv = [back[i], back[j], front[j], front[i]];
    const ex = wv[1].x-wv[0].x, ey = wv[1].y-wv[0].y, ez = wv[1].z-wv[0].z;
    const fx = wv[3].x-wv[0].x, fy = wv[3].y-wv[0].y, fz = wv[3].z-wv[0].z;
    const wx = ey*fz-ez*fy, wy = ez*fx-ex*fz, wz2 = ex*fy-ey*fx;
    const wlen = Math.sqrt(wx*wx+wy*wy+wz2*wz2);
    faces.push({ id: _genFaceId(), type: 'wall', vertices: wv,
      normal: wlen > 1e-9 ? { nx: wx/wlen, ny: wy/wlen, nz: wz2/wlen } : { nx:0, ny:0, nz:1 } });
  }
  const solid = { id: pid, buildingId: pid, blockIdx: idx, label: part.name || '仕切り', color: c, faces };
  solid._partitionId = part.id;
  return solid;
}
