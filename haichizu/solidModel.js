// ================================================================
// 面ベースソリッドモデル: ブロック → Solid(faces[]) 変換
// ================================================================
let _solidFaceIdCounter = 0;
function _genFaceId() { return 'f' + (++_solidFaceIdCounter); }

// Solidの重心を計算（全面の全頂点の平均）
function _computeSolidCentroid(solid) {
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const f of solid.faces) {
    for (const v of f.vertices) {
      if (v && typeof v.x === 'number') { cx += v.x; cy += v.y; cz += v.z; n++; }
    }
  }
  if (n === 0) return { x: 0, y: 0, z: 0 };
  return { x: cx / n, y: cy / n, z: cz / n };
}
// 面の重心
function _faceCentroid(verts) {
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += v.x; cy += v.y; cz += v.z; }
  return { x: cx / verts.length, y: cy / verts.length, z: cz / verts.length };
}
// Solidの全面の法線を外向き（重心から離れる方向）に統一する
// 注意: 段差壁等の内部面は重心ベースでは判定できないため、
// 「面の重心」が「Solidの境界」に十分近い面のみ調整する
function _normalizeOutward(solid) {
  const sc = _computeSolidCentroid(solid);
  // bounding box計算（境界判定用）
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, minZ=Infinity, maxZ=-Infinity;
  for (const f of solid.faces) for (const v of f.vertices) {
    if (v && typeof v.x === 'number') {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
  }
  const TOL = 0.5;
  const newFaces = solid.faces.map(f => {
    const fc = _faceCentroid(f.vertices);
    const n = f.normal || _computeNormal(f.vertices);
    // 面が外周境界にあるか判定（境界外周面のみ重心ベースで正規化）
    const isOnBoundary = Math.abs(fc.x - minX) < TOL || Math.abs(fc.x - maxX) < TOL
                      || Math.abs(fc.y - minY) < TOL || Math.abs(fc.y - maxY) < TOL
                      || Math.abs(fc.z - minZ) < TOL || Math.abs(fc.z - maxZ) < TOL;
    if (!isOnBoundary) return f; // 内部面（段差壁等）は触らない（既に正しく向いていると信頼）
    const dx = fc.x - sc.x, dy = fc.y - sc.y, dz = fc.z - sc.z;
    const dot = n.nx * dx + n.ny * dy + n.nz * dz;
    if (dot < 0) {
      return {
        ...f,
        vertices: [...f.vertices].reverse(),
        normal: { nx: -n.nx, ny: -n.ny, nz: -n.nz },
        ...(f.holes ? { holes: f.holes.map(h => [...h].reverse()) } : {}),
      };
    }
    return f;
  });
  return { ...solid, faces: newFaces };
}

function _computeNormal(vertices) {
  let nx = 0, ny = 0, nz = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const cur = vertices[i], next = vertices[(i + 1) % n];
    nx += (cur.y - next.y) * (cur.z + next.z);
    ny += (cur.z - next.z) * (cur.x + next.x);
    nz += (cur.x - next.x) * (cur.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-10) return { nx: 0, ny: 0, nz: 1 };
  return { nx: nx / len, ny: ny / len, nz: nz / len };
}

// ── 面ポリゴン内クランプ用ヘルパー ──
// 2D ポイント・イン・ポリゴン（レイキャスティング法）
function _pip2d(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
// 2D ポリゴン境界上の最近傍点（面外カーソルを境界で止める）
function _nearestOnPoly2d(px, py, polygon) {
  let bestDist = Infinity, bx = px, by = py;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const ax = polygon[i].x, ay = polygon[i].y;
    const bpx = polygon[j].x, bpy = polygon[j].y;
    const ex = bpx - ax, ey = bpy - ay;
    const el2 = ex * ex + ey * ey;
    if (el2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / el2));
    const cx = ax + t * ex, cy = ay + t * ey;
    const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    if (d < bestDist) { bestDist = d; bx = cx; by = cy; }
  }
  return { x: bx, y: by };
}

// 1つのブロック(points+zBottom+zTop) → Solid(faces[])
function blockToSolid(buildingId, blockIdx, label, color, pts, zB, zT) {
  if (!pts || pts.length < 3) return null;
  // CCW正規化
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; area += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  const normPts = area >= 0 ? pts : [...pts].reverse();
  const n = normPts.length;
  const faces = [];

  // 上面 (CCW = 法線+Z)
  faces.push({
    id: _genFaceId(), type: 'top',
    vertices: normPts.map(p => ({ x: p.x, y: p.y, z: zT })),
    normal: { nx: 0, ny: 0, nz: 1 },
  });

  // 下面 (逆順 = 法線-Z)
  faces.push({
    id: _genFaceId(), type: 'bottom',
    vertices: normPts.map(p => ({ x: p.x, y: p.y, z: zB })).reverse(),
    normal: { nx: 0, ny: 0, nz: -1 },
  });

  // 側面 (各辺に1つの4角形壁: 下左→下右→上右→上左)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const wallVerts = [
      { x: normPts[i].x, y: normPts[i].y, z: zB },
      { x: normPts[j].x, y: normPts[j].y, z: zB },
      { x: normPts[j].x, y: normPts[j].y, z: zT },
      { x: normPts[i].x, y: normPts[i].y, z: zT },
    ];
    faces.push({
      id: _genFaceId(), type: 'wall',
      vertices: wallVerts,
      normal: _computeNormal(wallVerts),
      _edgeIdx: i,
    });
  }

  return {
    id: `${buildingId}_${blockIdx}`,
    buildingId, blockIdx, label,
    color: color || '#6B7A8D',
    faces,
    _normPts: normPts,
  };
}

// buildings配列 → Solid配列 (初期変換用)
function buildingsToSolids(buildings) {
  const result = [];
  buildings.forEach(bld => {
    bld.blocks.forEach((blk, bi) => {
      const s = blockToSolid(bld.id, bi, bld.label, bld.color, blk.points, blk.zBottom || 0, blk.zTop != null ? blk.zTop : 40);
      if (s) result.push(_normalizeOutward(s));
    });
  });
  return result;
}

// ================================================================
// 面ベースpushpull: 面を法線方向に移動（隣接面変形＋新壁面生成）
// ================================================================

// 2面の共有辺を検出（共有辺 = 同じ2点を逆順で持つ）
function _findSharedEdges(faceA, faceB, tolerance = 0.5) {
  const shared = [];
  const va = faceA.vertices, vb = faceB.vertices;
  for (let ai = 0; ai < va.length; ai++) {
    const aj = (ai + 1) % va.length;
    for (let bi = 0; bi < vb.length; bi++) {
      const bj = (bi + 1) % vb.length;
      // 逆向き共有: A[ai]≈B[bj] && A[aj]≈B[bi]
      const dRev = Math.abs(va[ai].x - vb[bj].x) + Math.abs(va[ai].y - vb[bj].y) + Math.abs(va[ai].z - vb[bj].z)
                 + Math.abs(va[aj].x - vb[bi].x) + Math.abs(va[aj].y - vb[bi].y) + Math.abs(va[aj].z - vb[bi].z);
      // 同方向共有: A[ai]≈B[bi] && A[aj]≈B[bj]（_normalizeOutwardで反転された面用）
      const dSame = Math.abs(va[ai].x - vb[bi].x) + Math.abs(va[ai].y - vb[bi].y) + Math.abs(va[ai].z - vb[bi].z)
                  + Math.abs(va[aj].x - vb[bj].x) + Math.abs(va[aj].y - vb[bj].y) + Math.abs(va[aj].z - vb[bj].z);
      if (dRev < tolerance * 2) {
        // 逆向き: edgeBは[bi, bj]のままだが、edgeA[0]がvb[bj]に対応
        shared.push({ edgeA: [ai, aj], edgeB: [bi, bj] });
      } else if (dSame < tolerance * 2) {
        // 同方向: edgeA[0]がvb[bi]に対応、edgeA[1]がvb[bj]に対応
        // pushPullFaceでedgeB[1]=movedVerts[edgeA[0]]を期待しているので、bjとbiを入れ替える
        shared.push({ edgeA: [ai, aj], edgeB: [bj, bi] });
      }
    }
  }
  return shared;
}

// ソリッドの全面間の隣接関係を構築
// 注意: 各エントリの edgeA は「自身の面の辺」、edgeB は「相手の面の辺」を指す
function _buildAdjacency(solid) {
  const adj = new Map();
  solid.faces.forEach(f => adj.set(f.id, []));
  for (let i = 0; i < solid.faces.length; i++) {
    for (let j = i + 1; j < solid.faces.length; j++) {
      const fa = solid.faces[i], fb = solid.faces[j];
      const shared = _findSharedEdges(fa, fb);
      if (shared.length > 0) {
        // fa側: edgeA=fa, edgeB=fb（_findSharedEdgesの返り値そのまま）
        adj.get(fa.id).push({ faceId: fb.id, edges: shared });
        // fb側: edgeA=fb, edgeB=fa（edgeAとedgeBを入れ替える）
        const swapped = shared.map(e => ({ edgeA: e.edgeB, edgeB: e.edgeA }));
        adj.get(fb.id).push({ faceId: fa.id, edges: swapped });
      }
    }
  }
  return adj;
}

// 全面座標をコンソールにダンプするユーティリティ
function _dumpSolidFaces(solid, label) {
  if (!solid || !solid.faces) return;
  const dump = solid.faces.map(f => {
    const vs = (f.vertices||[]).map(v=>`(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`).join(' ');
    return `${f.id}(${f.type},${(f.vertices||[]).length}v): ${vs}`;
  }).join('\n');
  console.warn(`[FACES_DUMP] ${label} ===全${solid.faces.length}面===\n${dump}\n===END===`);
}

// pushpull: 面を法線方向にd移動（全面統一アルゴリズム）
// solid: Solidオブジェクト, faceId: 移動する面のID, depth: 移動距離（正=外側）
// 戻り値: 新しいSolid
function pushPullFace(solid, faceId, depth) {
  try {
  if (Math.abs(depth) < 0.001) return solid;
  const face = solid.faces.find(f => f.id === faceId);
  if (!face) return solid;
  console.warn('[pushPullFace] 開始', { faceId, depth: depth.toFixed(2), 面数: solid.faces.length, 全faceID: solid.faces.map(f => `${f.id}(${f.type},${f.vertices.length}v)`) });

  const adj = _buildAdjacency(solid);
  const neighbors = adj.get(faceId) || [];
  console.warn('[pushPullFace] 隣接面', { count: neighbors.length, faces: neighbors.map(nb => `${nb.faceId}(辺${nb.edges.length})`) });
  const { nx, ny, nz } = face.normal;
  // x,yはgrid単位、zはmeters。depthはmeters → xyのみMETERS_PER_PXで変換
  const dx = nx * depth / METERS_PER_PX, dy = ny * depth / METERS_PER_PX, dz = nz * depth;

  // 1. 移動する面の頂点を移動（同じ面のIDを保持）
  const origVerts = face.vertices;
  const movedVerts = origVerts.map(v => ({ x: v.x + dx, y: v.y + dy, z: v.z + dz }));

  // 2. 新しい壁面は作らない。隣接面が共有頂点を移動して伸縮し、閉空間を維持する
  const newWalls = [];

  // 3. 移動する面の平面上にあり、かつ「辺の延長線上」にある頂点を移動
  // T字結合のスプリット点（範囲外でも辺の延長線上）も検出される
  const TOL = 0.5;
  const planeOffset = nx * origVerts[0].x + ny * origVerts[0].y + nz * origVerts[0].z;
  // 移動する面の各辺を「線分」として収集
  const edges = [];
  for (let i = 0; i < origVerts.length; i++) {
    const j = (i + 1) % origVerts.length;
    edges.push({ a: origVerts[i], b: origVerts[j] });
  }
  // 頂点が辺の延長線上にあるか判定
  const _onEdgeLine = (v) => {
    for (const e of edges) {
      const ax = e.b.x - e.a.x, ay = e.b.y - e.a.y, az = e.b.z - e.a.z;
      const vx = v.x - e.a.x, vy = v.y - e.a.y, vz = v.z - e.a.z;
      // クロス積=0なら共線
      const cx = ay * vz - az * vy;
      const cy = az * vx - ax * vz;
      const cz = ax * vy - ay * vx;
      const crossLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const edgeLen = Math.sqrt(ax * ax + ay * ay + az * az);
      if (edgeLen < 0.01) continue;
      // 距離 = |cross| / |edge|
      if (crossLen / edgeLen < TOL) {
        // 辺の端点から辺長の0.5倍を超えて離れた頂点は対象外
        // （削り出し境界の z=0 コーナー頂点が段差壁の無限延長で誤検出されるのを防ぐ）
        const t = (vx * ax + vy * ay + vz * az) / (edgeLen * edgeLen);
        if (t < -0.5 || t > 1.5) continue;
        return true;
      }
    }
    return false;
  };

  const updatedFaces = solid.faces.map(f => {
    if (f.id === faceId) {
      const movedHoles = f.holes ? f.holes.map(hole => hole.map(v => ({ x: v.x + dx, y: v.y + dy, z: v.z + dz }))) : undefined;
      return { ...f, vertices: movedVerts, ...(movedHoles ? { holes: movedHoles } : {}) };
    }
    const _moveV = v => {
      const distToPlane = nx * v.x + ny * v.y + nz * v.z - planeOffset;
      if (Math.abs(distToPlane) > TOL) return { ...v };
      if (!_onEdgeLine(v)) return { ...v };
      return { x: v.x + dx, y: v.y + dy, z: v.z + dz };
    };
    const newVerts = f.vertices.map(_moveV);
    const changed = newVerts.some((nv, i) => {
      const ov = f.vertices[i];
      return !ov || Math.abs(nv.x - ov.x) > 0.01 || Math.abs(nv.y - ov.y) > 0.01 || Math.abs(nv.z - ov.z) > 0.01;
    });
    // ホール頂点も同じ変換を適用（貫通穴の境界が隣接面のedgeLine上にある場合に追従）
    let newHoles = f.holes;
    let holesChanged = false;
    if (f.holes && f.holes.length > 0) {
      newHoles = f.holes.map(hole => hole.map(_moveV));
      holesChanged = newHoles.some((nh, hi) => nh.some((nv, vi) => {
        const ov = f.holes[hi][vi];
        return Math.abs(nv.x - ov.x) > 0.01 || Math.abs(nv.y - ov.y) > 0.01 || Math.abs(nv.z - ov.z) > 0.01;
      }));
    }
    if (changed || holesChanged) {
      return { ...f, vertices: newVerts, normal: _computeNormal(newVerts), ...(newHoles ? { holes: newHoles } : {}) };
    }
    return f;
  });

  const resultFaces = [...updatedFaces, ...newWalls];
  // 不正な頂点があれば、元の面の対応頂点で修復する（拒否はしない）
  const _isValid = (vt) => vt && typeof vt.x === 'number' && typeof vt.y === 'number' && typeof vt.z === 'number' && !isNaN(vt.x) && !isNaN(vt.y) && !isNaN(vt.z);
  let invalidCount = 0;
  for (const f of resultFaces) {
    if (!f.vertices) continue;
    const origFace = solid.faces.find(of => of.id === f.id);
    for (let vi = 0; vi < f.vertices.length; vi++) {
      if (!_isValid(f.vertices[vi])) {
        invalidCount++;
        if (origFace && origFace.vertices && origFace.vertices[vi] && _isValid(origFace.vertices[vi])) {
          f.vertices[vi] = { ...origFace.vertices[vi] };
        } else {
          f.vertices[vi] = { x: 0, y: 0, z: 0 };
        }
      }
    }
  }
  if (invalidCount > 0) console.warn('[pushPullFace] 不正な頂点を修復', { count: invalidCount });
  // 縮退面（面積ゼロや辺長ゼロ）を検出してログ
  const _degenerateFaces = [];
  for (const f of resultFaces) {
    if (!f.vertices || f.vertices.length < 3) continue;
    let degenerate = false;
    for (let i = 0; i < f.vertices.length; i++) {
      const j = (i + 1) % f.vertices.length;
      const dx = f.vertices[j].x - f.vertices[i].x;
      const dy = f.vertices[j].y - f.vertices[i].y;
      const dz = f.vertices[j].z - f.vertices[i].z;
      if (Math.sqrt(dx*dx + dy*dy + dz*dz) < 0.001) {
        degenerate = true; break;
      }
    }
    if (degenerate) _degenerateFaces.push({ id: f.id, type: f.type, verts: f.vertices.map(v => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`) });
  }
  if (_degenerateFaces.length > 0) console.warn('[pushPullFace] 縮退面検出', _degenerateFaces);
  console.warn('[pushPullFace] 結果', { 結果faceID: resultFaces.map(f => `${f.id}(${f.type},${f.vertices.length}v)`) });
  // 全面の法線を外向きに統一（親箱として一貫した法線方向を保証）
  return _normalizeOutward({ ...solid, faces: resultFaces });
  } catch(e) { console.error('[pushPullFace] クラッシュ回避', e.message, { faceId, depth }); return solid; }
}

// ================================================================
// pushPullRect: 面の矩形部分を選択して移動（辺共有→面リンク→変形方式）
// ================================================================
// 処理フロー:
//   Phase 1: 選択面をL字残り面 + 矩形面に分割
//   Phase 2: 矩形の各辺と全既存面の辺共有を検出
//   Phase 3: 共有の種類に応じて面を変形/新規生成
// 面の完全内部に矩形が描かれた場合: 面分割（4クワッド）+ 4壁+底面を作成
// face.holes は使用しない — 全面が単純クローズドポリゴンとして定義される

// ── 孤立壁除去: 設計思想「操作後に閉曲面として再定義」の実装 ──
// 他の面とxy辺を共有しない壁 = 孤立壁 → 除去する
// 対症療法ではなく、「接続のない面は存在しない」という原則を一律適用
function _removeOrphanWalls(faces) {
  const T = 2.5; // xy距離トレランス
  const _xyD2 = (a, b) => (a.x-b.x)**2 + (a.y-b.y)**2;
  const _edgeMatchXY = (ea, eb, a, b) =>
    (_xyD2(ea,a)<T*T && _xyD2(eb,b)<T*T) || (_xyD2(ea,b)<T*T && _xyD2(eb,a)<T*T);
  return faces.filter(f => {
    if (f.type !== 'wall' || !f.vertices || f.vertices.length < 4) return true;
    // _topFaceId リンク付き壁は座標マッチングではなく重複排除で管理 → ここでは除去しない
    if (f._topFaceId) return true;
    // 壁の両水平辺: v[0]→v[1](下辺) と v[2]→v[3](上辺)
    const checkEdges = [
      [f.vertices[0], f.vertices[1]],
      [f.vertices[2], f.vertices[3]],
    ];
    for (const [ea, eb] of checkEdges) {
      for (const other of faces) {
        if (other === f || !other.vertices) continue;
        const n = other.vertices.length;
        for (let i = 0; i < n; i++) {
          if (_edgeMatchXY(ea, eb, other.vertices[i], other.vertices[(i+1)%n])) return true;
        }
      }
    }
    // どの辺も他の面と共有されていない → 孤立壁
    console.warn('[ORPHAN_WALL] 孤立壁を除去', { id: f.id,
      v0: `(${f.vertices[0].x.toFixed(1)},${f.vertices[0].y.toFixed(1)})`,
      v1: `(${f.vertices[1].x.toFixed(1)},${f.vertices[1].y.toFixed(1)})` });
    return false;
  });
}

// ── 壁の完全再構築: 設計思想「操作後に閉曲面として再定義」 ──
// 同一直線（同y または同x）上の辺をグループ化し、段差プロファイルを1枚のL字ポリゴンで表現。
// これにより「段差境界点が z=0 に出現」「中間高さが元corners に出現」などの余計な頂点が生じない。
function _rebuildAllWalls(faces) {
  const nonWall = faces.filter(f => f.type !== 'wall' && f.vertices && f.vertices.length >= 3);
  let cx=0, cy=0, cnt=0;
  for (const f of nonWall) for (const v of f.vertices) { cx+=v.x; cy+=v.y; cnt++; }
  if (cnt>0) { cx/=cnt; cy/=cnt; }

  const _rnd = v => Math.round(v*2)/2;
  const minZ = Math.min(...nonWall.flatMap(f=>f.vertices.map(v=>v.z)));

  // 各辺を「直線キー」でグループ化: H:Y（水平・同y）、V:X（垂直・同x）
  // 閾値2.0: Cesiumクリック→グリッド変換の浮動小数誤差(最大~1.5px)を吸収
  const lineGroups = new Map();
  for (const face of nonWall) {
    const fz = face.vertices.reduce((s,v)=>s+v.z,0)/face.vertices.length;
    const n = face.vertices.length;
    for (let i=0;i<n;i++) {
      const a=face.vertices[i], b=face.vertices[(i+1)%n];
      if (Math.abs(a.z-b.z)>0.5) continue; // 非水平辺スキップ
      const ax=_rnd(a.x),ay=_rnd(a.y),bx=_rnd(b.x),by=_rnd(b.y);
      if (Math.sqrt((bx-ax)**2+(by-ay)**2)<1.0) continue;
      let lk, tMin, tMax;
      if (Math.abs(ay-by)<2.0) { lk=`H:${_rnd((ay+by)/2)}`; tMin=Math.min(ax,bx); tMax=Math.max(ax,bx); }
      else if (Math.abs(ax-bx)<2.0) { lk=`V:${_rnd((ax+bx)/2)}`; tMin=Math.min(ay,by); tMax=Math.max(ay,by); }
      else continue;
      if (!lineGroups.has(lk)) lineGroups.set(lk,[]);
      lineGroups.get(lk).push({z:fz, tMin, tMax});
    }
  }
  // lineGroups空でも後のnewWalls生成後に統合フォールバックで処理するためここでは何もしない

  const newWalls = [];
  const _mkW = (z1,z2,ax,ay,bx,by) => {
    if (Math.abs(z2-z1)<0.1) return;
    const verts=[{x:ax,y:ay,z:z1},{x:bx,y:by,z:z1},{x:bx,y:by,z:z2},{x:ax,y:ay,z:z2}];
    let n = _computeNormal(verts);
    const mx=(ax+bx)/2, my=(ay+by)/2;
    if (n.nx*(mx-cx)+n.ny*(my-cy)<0) { verts.reverse(); n={nx:-n.nx,ny:-n.ny,nz:-n.nz}; }
    newWalls.push({id:_genFaceId(),type:'wall',vertices:verts,normal:n});
  };

  for (const [lk, entries] of lineGroups) {
    const isH = lk.startsWith('H:');
    const fixedC = parseFloat(lk.split(':')[1]);

    // minZ 辺があるか（底面接続）
    const hasMinZ = entries.some(e => Math.abs(e.z-minZ)<0.5);
    const aboveEntries = entries.filter(e => Math.abs(e.z-minZ)>0.5);
    if (aboveEntries.length===0) continue;

    // 全境界t値を集めてセグメント化
    const tBounds = new Set(aboveEntries.flatMap(e=>[e.tMin,e.tMax]));
    if (hasMinZ) entries.filter(e=>Math.abs(e.z-minZ)<0.5).forEach(e=>{tBounds.add(e.tMin);tBounds.add(e.tMax);});
    const sortedT = [...tBounds].sort((a,b)=>a-b);

    // 各セグメントのzTop（上側の高さ）を計算
    // zTop = そのセグメントをカバーする aboveEntries の最大z
    // 覆っていないセグメントは壁不要（内部）
    const segs = [];
    for (let si=0;si<sortedT.length-1;si++) {
      const tMid = (sortedT[si]+sortedT[si+1])/2;
      const covers = aboveEntries.filter(e=>e.tMin<=tMid+0.01&&e.tMax>=tMid-0.01);
      if (covers.length===0) continue;
      segs.push({tMin:sortedT[si], tMax:sortedT[si+1], zTop:Math.max(...covers.map(e=>e.z))});
    }
    if (segs.length===0) continue;

    const tStart = segs[0].tMin, tEnd = segs[segs.length-1].tMax;
    const _v = (t,z) => isH ? {x:t,y:fixedC,z} : {x:fixedC,y:t,z};

    // L字ポリゴンとして1枚生成（描画もbuildBldEntitiesで直接1枚として処理）
    // → x_stepがz=0に出現せず、かつ不要な分割境界も発生しない
    let baseZ;
    if (hasMinZ) {
      baseZ = minZ;
    } else {
      const _allT = aboveEntries.flatMap(e => [e.tMin, e.tMax]);
      const _tLo = Math.min(..._allT), _tHi = Math.max(..._allT);
      const _minAboveZ = Math.min(...aboveEntries.map(e => e.z));
      const _distinctZ = [...new Set(aboveEntries.map(e => Math.round(e.z * 10) / 10))];
      if (_distinctZ.length > 1) {
        baseZ = _minAboveZ;
      } else {
        let _lowerZ = null;
        for (const nf of nonWall) {
          const nfz = nf.vertices.reduce((s, v) => s + v.z, 0) / nf.vertices.length;
          if (nfz >= _minAboveZ - 0.5) continue;
          let fixMin = Infinity, fixMax = -Infinity;
          let tMin2 = Infinity, tMax2 = -Infinity;
          for (const v of nf.vertices) {
            const fixV = isH ? v.y : v.x;
            const tV = isH ? v.x : v.y;
            if (fixV < fixMin) fixMin = fixV;
            if (fixV > fixMax) fixMax = fixV;
            if (tV < tMin2) tMin2 = tV;
            if (tV > tMax2) tMax2 = tV;
          }
          const TOL = 3.0;
          if (fixedC < fixMin - TOL || fixedC > fixMax + TOL) continue;
          if (tMax2 < _tLo - TOL || tMin2 > _tHi + TOL) continue;
          if (_lowerZ === null || nfz > _lowerZ) _lowerZ = nfz;
        }
        baseZ = _lowerZ !== null ? _lowerZ : _minAboveZ;
      }
    }
    const wallVerts = [];
    wallVerts.push(_v(segs[0].tMin, baseZ));                      // 底-左
    wallVerts.push(_v(segs[segs.length-1].tMax, baseZ));          // 底-右
    // 右上から左へプロファイル
    const _topR = segs[segs.length-1].zTop;
    if (Math.abs(_topR - baseZ) > 0.1) wallVerts.push(_v(segs[segs.length-1].tMax, _topR));
    for (let si=segs.length-1;si>=0;si--) {
      const seg=segs[si];
      const prevZTop = si>0 ? segs[si-1].zTop : null;
      if (prevZTop!==null && Math.abs(prevZTop-seg.zTop)>0.1) {
        wallVerts.push(_v(seg.tMin, seg.zTop));
        wallVerts.push(_v(seg.tMin, prevZTop));
      } else if (si===0) {
        wallVerts.push(_v(seg.tMin, seg.zTop));
      }
    }
    // 連続重複除去
    const _wvd = wallVerts.filter((v,i) => {
      if (i===0) return true;
      const p=wallVerts[i-1];
      return !(Math.abs(v.x-p.x)<0.1&&Math.abs(v.y-p.y)<0.1&&Math.abs(v.z-p.z)<0.1);
    });
    if (_wvd.length<4) continue;
    let _wn = _computeNormal(_wvd);
    const _wmx=_wvd.reduce((s,v)=>s+v.x,0)/_wvd.length, _wmy=_wvd.reduce((s,v)=>s+v.y,0)/_wvd.length;
    if (_wn.nx*(_wmx-cx)+_wn.ny*(_wmy-cy)<0) { _wvd.reverse(); _wn={nx:-_wn.nx,ny:-_wn.ny,nz:-_wn.nz}; }
    newWalls.push({id:_genFaceId(),type:'wall',vertices:_wvd,normal:_wn,_isLShape:_wvd.length>4});
  }

  // 壁生成0: Phase 2/3で生成した壁（L字壁含む）をそのまま保持
  // これにより非軸平行建物でも正しいL字壁が維持される
  // 底面辺数より少ないwallしか生成できない場合は非軸平行建物と判定 → 階段壁を直接生成
  // 条件: newWalls=0 (完全非H/V) OR newWalls < 底面辺数 (一部だけH/V通過=誤判定あり)
  const _bottomFaceForCheck = nonWall.find(f => f.type === 'bottom');
  const _bottomEdgeCount = _bottomFaceForCheck ? _bottomFaceForCheck.vertices.length : 0;
  if (newWalls.length < _bottomEdgeCount && nonWall.length > 0) {
    // 非軸平行建物: 底面辺＋nonWall面の投影から階段壁を直接生成（複数削り出しの段差も正確）
    const bottomFace = _bottomFaceForCheck;
    const topFaces = nonWall.filter(f => f.type !== 'bottom');
    const generalWalls = [];
    if (bottomFace && topFaces.length > 0) {
      const bv = bottomFace.vertices;
      const nb = bv.length;
      for (let bi=0;bi<nb;bi++) {
        const ea=bv[bi], eb=bv[(bi+1)%nb];
        const wallDx=eb.x-ea.x, wallDy=eb.y-ea.y;
        const wallLen=Math.sqrt(wallDx*wallDx+wallDy*wallDy);
        if (wallLen<1.0) continue;
        const wallUx=wallDx/wallLen, wallUy=wallDy/wallLen;
        const wallNx=wallUy, wallNy=-wallUx; // 外向き法線（候補）
        // topFace辺を壁平面に投影してカバレッジ収集
        const covs=[];
        for (const tf of topFaces) {
          const tfz=tf.vertices[0].z;
          const nTF=tf.vertices.length;
          for (let ti=0;ti<nTF;ti++) {
            const fa=tf.vertices[ti], fb=tf.vertices[(ti+1)%nTF];
            const dA=(fa.x-ea.x)*wallNx+(fa.y-ea.y)*wallNy;
            const dB=(fb.x-ea.x)*wallNx+(fb.y-ea.y)*wallNy;
            if (Math.abs(dA)<3.0&&Math.abs(dB)<3.0) {
              const uA=(fa.x-ea.x)*wallUx+(fa.y-ea.y)*wallUy;
              const uB=(fb.x-ea.x)*wallUx+(fb.y-ea.y)*wallUy;
              const uMin=Math.max(-0.1,Math.min(uA,uB)), uMax=Math.min(wallLen+0.1,Math.max(uA,uB));
              if (uMax-uMin>0.5) covs.push({uMin,uMax,z:tfz});
            }
          }
        }
        if (covs.length===0) continue;
        // uセグメントごとに最大zを求めて階段プロファイル生成
        const uBnds=new Set([0,wallLen]);
        for (const c of covs){uBnds.add(Math.max(0,c.uMin));uBnds.add(Math.min(wallLen,c.uMax));}
        const sortU=[...uBnds].sort((a,b)=>a-b);
        const segs=[];
        for (let si=0;si<sortU.length-1;si++){
          const uMid=(sortU[si]+sortU[si+1])/2;
          const zMaxArr=covs.filter(c=>c.uMin<=uMid+0.1&&c.uMax>=uMid-0.1).map(c=>c.z);
          if (zMaxArr.length>0) segs.push({u0:sortU[si],u1:sortU[si+1],zTop:Math.max(...zMaxArr)});
        }
        if (segs.length===0) continue;
        // 世界座標変換ヘルパー
        const wp=(u,z)=>({x:ea.x+u*wallUx,y:ea.y+u*wallUy,z});
        // 階段ポリゴン生成（底辺→右列→階段→左列）
        const wverts=[];
        wverts.push(wp(0,0));
        wverts.push(wp(wallLen,0));
        const topR=segs[segs.length-1].zTop;
        wverts.push(wp(wallLen,topR));
        for (let si=segs.length-1;si>=0;si--){
          const seg=segs[si];
          const prevZ=si>0?segs[si-1].zTop:null;
          if (prevZ!==null&&Math.abs(seg.zTop-prevZ)>0.1){
            wverts.push(wp(seg.u0,seg.zTop));
            wverts.push(wp(seg.u0,prevZ));
          } else if (si===0){
            wverts.push(wp(seg.u0,seg.zTop));
          }
        }
        // 重複頂点除去
        const wvd=wverts.filter((v,i)=>{
          if(i===0)return true;
          const p=wverts[i-1];
          return!(Math.abs(v.x-p.x)<0.1&&Math.abs(v.y-p.y)<0.1&&Math.abs(v.z-p.z)<0.1);
        });
        if(wvd.length<4) continue;
        let wn=_computeNormal(wvd);
        const wmx=wvd.reduce((s,v)=>s+v.x,0)/wvd.length, wmy=wvd.reduce((s,v)=>s+v.y,0)/wvd.length;
        if(wn.nx*(wmx-cx)+wn.ny*(wmy-cy)<0){wvd.reverse();wn={nx:-wn.nx,ny:-wn.ny,nz:-wn.nz};}
        generalWalls.push({id:_genFaceId(),type:'wall',vertices:wvd,normal:wn,_isLShape:wvd.length>4});
      }
    }
    if (generalWalls.length>0) {
      console.warn('[REBUILD_WALLS] 非軸平行階段壁生成完了', {壁数:generalWalls.length});
      return [...nonWall, ...generalWalls];
    }
    // フォールバック: 既存壁保持
    const existingWalls = faces.filter(f => f.type === 'wall' && f.vertices && f.vertices.length >= 3);
    console.warn('[REBUILD_WALLS] 壁生成0→既存壁保持フォールバック', {保持壁数:existingWalls.length});
    return [...nonWall, ...existingWalls];
  }
  console.warn('[REBUILD_WALLS] 再構築完了', {旧壁数:faces.filter(f=>f.type==='wall').length, 新壁数:newWalls.length, lineGroups数:lineGroups.size});
  return [...nonWall, ...newWalls];
}

function _pushPullRectInterior(solid, faceId, rect, depth) {
  if (Math.abs(depth) < 0.001) return solid;
  const face = solid.faces.find(f => f.id === faceId);
  if (!face || !rect || rect.length !== 4) return solid;
  const { nx, ny, nz } = face.normal;
  // x,yはgrid単位、zはmeters。depthはmeters → xyのみMETERS_PER_PXで変換
  const dx = nx * depth / METERS_PER_PX, dy = ny * depth / METERS_PER_PX, dz = nz * depth;
  // 移動後の矩形（cavity底面 or tower上面の位置）
  const movedRect = rect.map(v => ({ x: v.x + dx, y: v.y + dy, z: v.z + dz }));

  // 底面はface.normal方向（=空気側を向く）
  const _dotN = (a, b) => a.nx * b.nx + a.ny * b.ny + a.nz * b.nz;
  const _ensureSameAsN = (verts, targetN) => {
    const n = _computeNormal(verts);
    return _dotN(n, targetN) > 0 ? [...verts] : [...verts].reverse();
  };
  const bottomVerts = _ensureSameAsN(movedRect, face.normal);

  // 矩形中心（段差壁の法線を内向きに揃える基準）
  const rectCx = rect.reduce((s, p) => s + p.x, 0) / 4;
  const rectCy = rect.reduce((s, p) => s + p.y, 0) / 4;
  const rectCz = rect.reduce((s, p) => s + p.z, 0) / 4;

  // 4つの段差壁: rect[i]→rect[j]→movedRect[j]→movedRect[i]
  // depth<0 (削り出し=cavity): 法線はrect中心向き（=空気側）
  // depth>0 (突起=tower): 法線はrect中心の逆向き（=空気側）
  const orientSign = depth < 0 ? 1 : -1;
  const stepWalls = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    let verts = [rect[i], rect[j], movedRect[j], movedRect[i]];
    let n = _computeNormal(verts);
    const wcx = (rect[i].x + rect[j].x + movedRect[i].x + movedRect[j].x) / 4;
    const wcy = (rect[i].y + rect[j].y + movedRect[i].y + movedRect[j].y) / 4;
    const wcz = (rect[i].z + rect[j].z + movedRect[i].z + movedRect[j].z) / 4;
    const tx = (rectCx - wcx) * orientSign, ty = (rectCy - wcy) * orientSign, tz = (rectCz - wcz) * orientSign;
    if (n.nx * tx + n.ny * ty + n.nz * tz < 0) {
      verts = [...verts].reverse();
      n = { nx: -n.nx, ny: -n.ny, nz: -n.nz };
    }
    stepWalls.push({ id: _genFaceId(), type: 'wall', vertices: verts, normal: n });
  }

  // 底面/上面: 親面と同じtype（'top'/'bottom'/'wall'）にすることで
  // _rebuildAllWalls が非wall面のエッジを正しく収集できる
  const bottomFace = {
    id: _genFaceId(), type: face.type,
    vertices: bottomVerts,
    normal: { nx: face.normal.nx, ny: face.normal.ny, nz: face.normal.nz },
  };

  // ── 元面の処理 ──
  if (depth < 0) {
    // 削り出し: 元面 F を (F minus R) の4つのクワッドに分割
    // face.holes は使わない — 単純な閉じたポリゴンの集合として定義する
    const sv = face.vertices;
    const pn = sv.length;
    // face の最も水平な辺を u 軸とする（クリックハンドラと同じロジック）
    let bestI = 0, bestDz = Infinity;
    for (let i = 0; i < pn; i++) {
      const a = sv[i], b = sv[(i + 1) % pn];
      const dz = Math.abs(b.z - a.z);
      const dxy = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      if (dxy > 1e-6 && dz < bestDz) { bestDz = dz; bestI = i; }
    }
    const ea = sv[bestI], eb = sv[(bestI + 1) % pn];
    const edx2 = eb.x - ea.x, edy2 = eb.y - ea.y;
    const elen2 = Math.sqrt(edx2 * edx2 + edy2 * edy2);
    if (elen2 < 1e-6) {
      // 分割できない → 元面そのまま（フォールバック）
      const newFacesFB = solid.faces.filter(f => f.id !== faceId);
      newFacesFB.push(face, bottomFace, ...stepWalls);
      return { ...solid, faces: _rebuildAllWalls(newFacesFB) };
    }
    const qux = edx2 / elen2, quy = edy2 / elen2;

    // v軸 = cross(face.normal, u-axis) — 水平面では面内の第2水平方向、垂直壁では z方向
    // cross(n, u) = (ny*0-nz*quy, nz*qux-nx*0, nx*quy-ny*qux) (uz=0)
    const fn = face.normal;
    let qvx = -fn.nz * quy, qvy = fn.nz * qux, qvz = fn.nx * quy - fn.ny * qux;
    const qvlen = Math.sqrt(qvx * qvx + qvy * qvy + qvz * qvz);
    if (qvlen > 1e-6) { qvx /= qvlen; qvy /= qvlen; qvz /= qvlen; }

    // face 頂点の (u, v) 境界（v はeaからの相対座標）
    let uFaceMin = Infinity, uFaceMax = -Infinity, vFaceMin = Infinity, vFaceMax = -Infinity;
    for (const p of sv) {
      const u = (p.x - ea.x) * qux + (p.y - ea.y) * quy;
      const vv = (p.x - ea.x) * qvx + (p.y - ea.y) * qvy + (p.z - ea.z) * qvz;
      if (u < uFaceMin) uFaceMin = u; if (u > uFaceMax) uFaceMax = u;
      if (vv < vFaceMin) vFaceMin = vv; if (vv > vFaceMax) vFaceMax = vv;
    }
    // rect 頂点の (u, v) 境界
    let uRectMin = Infinity, uRectMax = -Infinity, vRectMin = Infinity, vRectMax = -Infinity;
    for (const p of rect) {
      const u = (p.x - ea.x) * qux + (p.y - ea.y) * quy;
      const vv = (p.x - ea.x) * qvx + (p.y - ea.y) * qvy + (p.z - ea.z) * qvz;
      if (u < uRectMin) uRectMin = u; if (u > uRectMax) uRectMax = u;
      if (vv < vRectMin) vRectMin = vv; if (vv > vRectMax) vRectMax = vv;
    }

    // (u, v) 空間でクワッドを生成し face.normal と同じ向きに揃える
    const _makeQuad = (u0, u1, v0, v1) => {
      const verts = [
        { x: ea.x + u0*qux + v0*qvx, y: ea.y + u0*quy + v0*qvy, z: ea.z + v0*qvz },
        { x: ea.x + u1*qux + v0*qvx, y: ea.y + u1*quy + v0*qvy, z: ea.z + v0*qvz },
        { x: ea.x + u1*qux + v1*qvx, y: ea.y + u1*quy + v1*qvy, z: ea.z + v1*qvz },
        { x: ea.x + u0*qux + v1*qvx, y: ea.y + u0*quy + v1*qvy, z: ea.z + v1*qvz },
      ];
      let n = _computeNormal(verts);
      if (_dotN(n, face.normal) < 0) { verts.reverse(); n = { nx: -n.nx, ny: -n.ny, nz: -n.nz }; }
      return { id: _genFaceId(), type: face.type, _edgeIdx: face._edgeIdx, vertices: verts, normal: n };
    };

    // 設計思想: 全面を単純クローズドポリゴンとして定義する
    // 元面を4枚のクワッドに分割（穴あき面は使わない）
    // 左/右/下/上の各ストリップ。0幅のクワッドはスキップ。
    const frameQuads = [];
    const _QW = 0.5; // 最小幅(grid単位)
    if (uRectMin - uFaceMin > _QW) frameQuads.push(_makeQuad(uFaceMin, uRectMin, vFaceMin, vFaceMax));
    if (uFaceMax - uRectMax > _QW) frameQuads.push(_makeQuad(uRectMax, uFaceMax, vFaceMin, vFaceMax));
    if (vRectMin - vFaceMin > _QW) frameQuads.push(_makeQuad(uRectMin, uRectMax, vFaceMin, vRectMin));
    if (vFaceMax - vRectMax > _QW) frameQuads.push(_makeQuad(uRectMin, uRectMax, vRectMax, vFaceMax));

    // 貫通チェック: bottomFaceが既存の反対面と同一平面上にあれば貫通
    const bn = bottomFace.normal;
    const bP0 = bottomFace.vertices[0];
    const COPLANAR_TOL = 0.15;
    let punchThrough = false;
    const baseFaces = solid.faces.filter(f => f.id !== faceId);
    const mappedFaces = baseFaces.map(f => {
      if (!f.normal || !f.vertices || f.vertices.length < 3) return f;
      const fn2 = f.normal;
      const dot = bn.nx * fn2.nx + bn.ny * fn2.ny + bn.nz * fn2.nz;
      if (dot > -0.9) return f;
      const fP0 = f.vertices[0];
      const dist = Math.abs(fn2.nx * bP0.x + fn2.ny * bP0.y + fn2.nz * bP0.z - (fn2.nx * fP0.x + fn2.ny * fP0.y + fn2.nz * fP0.z));
      if (dist > COPLANAR_TOL) return f;
      punchThrough = true;
      console.warn('[PUNCH_THROUGH] 貫通: 反対面に穴をあける', { faceId: f.id });
      return { ...f, holes: [...(f.holes || []), movedRect.map(v => ({ x: v.x, y: v.y, z: v.z }))] };
    });

    const newFaces = [...mappedFaces, ...frameQuads, ...stepWalls];
    if (!punchThrough) newFaces.push(bottomFace);
    console.warn('[INTERIOR_RECT] 削り出し(4クワッド)', {
      faceId, depth: depth.toFixed(3), 貫通: punchThrough,
      旧面数: solid.faces.length, 新面数_rebuild前: newFaces.length,
    });
    return { ...solid, faces: _rebuildAllWalls(newFaces) };
  } else {
    // 突起: topFaceToAdd + bottomFace → _rebuildAllWalls で壁を一元再構築
    const _on = face.vertices.length;
    // rect頂点が面辺上にあるか検出（L字topFaceToAdd計算に使用）
    const _rOFE = rect.map(rp => {
      for (let ei=0;ei<_on;ei++) {
        const a=face.vertices[ei], b=face.vertices[(ei+1)%_on];
        const abx=b.x-a.x,aby=b.y-a.y,abz=b.z-a.z,len2=abx*abx+aby*aby+abz*abz;
        if (len2<0.01) continue;
        const t=((rp.x-a.x)*abx+(rp.y-a.y)*aby+(rp.z-a.z)*abz)/len2;
        if (t<-0.02||t>1.02) continue;
        const dist=Math.sqrt((rp.x-a.x-t*abx)**2+(rp.y-a.y-t*aby)**2+(rp.z-a.z-t*abz)**2);
        if (dist<2.0) return {edge:ei, t:Math.max(0,Math.min(1,t))};
      }
      return null;
    });
    // L字残余面（topFaceToAdd）を計算
    let _topFaceToAdd = face;
    let _entryRI=-1, _exitRI=-1;
    for (let i=0;i<rect.length;i++) {
      const ni=(i+1)%rect.length;
      if (_rOFE[i]&&!_rOFE[ni]) _entryRI=i;
      if (!_rOFE[i]&&_rOFE[ni]) _exitRI=ni;
    }
    if (_entryRI>=0 && _exitRI>=0) {
      const _entryEdge=_rOFE[_entryRI].edge, _exitEdge=_rOFE[_exitRI].edge;
      const _det=[]; let _ci=(_entryRI+1)%rect.length;
      while (_ci!==_exitRI){_det.push(rect[_ci]);_ci=(_ci+1)%rect.length;}
      const _bldPath=(fromE,toE,sp,ep,det)=>{
        const r=[{...sp}];
        const _dup=(a,b)=>Math.abs(a.x-b.x)<1.0&&Math.abs(a.y-b.y)<1.0&&Math.abs(a.z-b.z)<1.0;
        let pi=(fromE+1)%_on, _stepped=false;
        for(let s=0;s<_on;s++){
          if(_stepped&&pi===(toE+1)%_on)break;
          _stepped=true;
          if(!_dup(face.vertices[pi],r[r.length-1]))r.push({...face.vertices[pi]});
          pi=(pi+1)%_on;
        }
        const _isOrig=face.vertices.some(ov=>Math.abs(ov.x-ep.x)<1.5&&Math.abs(ov.y-ep.y)<1.5);
        if(!_dup(ep,r[r.length-1])&&!_isOrig)r.push({...ep});
        if(fromE!==toE)det.forEach(dp=>r.push({...dp}));
        return r;
      };
      const _pA=_bldPath(_exitEdge,_entryEdge,rect[_exitRI],rect[_entryRI],_det);
      const _pB=_bldPath(_entryEdge,_exitEdge,rect[_entryRI],rect[_exitRI],[..._det].reverse());
      const _rv=_pA.length>=_pB.length?_pA:_pB;
      if (_rv.length>=3) {
        const _rvN=_computeNormal(_rv);
        let _rvFinal=_rv,_rvNFinal=_rvN;
        if(_rvN.nx*(face.normal.nx)+_rvN.ny*(face.normal.ny)+_rvN.nz*(face.normal.nz)<0){_rvFinal=[..._rv].reverse();_rvNFinal={nx:-_rvN.nx,ny:-_rvN.ny,nz:-_rvN.nz};}
        _topFaceToAdd={id:_genFaceId(),type:face.type,vertices:_rvFinal,normal:_rvNFinal};
      }
    }
    // _sortCollinear: 同一直線上の連続頂点を単調順にソート（自己交差防止）
    if (_topFaceToAdd !== face) {
      const _sortC = (verts) => {
        if (verts.length < 3) return verts;
        const result = [verts[0]]; let i = 1;
        while (i < verts.length) {
          let j = i; const prev = result[result.length-1];
          const isH = Math.abs(verts[i].y-prev.y)<2.0&&Math.abs(verts[i].x-prev.x)>0.1;
          const isV = Math.abs(verts[i].x-prev.x)<2.0&&Math.abs(verts[i].y-prev.y)>0.1;
          if (isH||isV) {
            const grp=[prev];
            while(j<verts.length){const cur=verts[j];const sH=isH&&Math.abs(cur.y-prev.y)<2.0;const sV=isV&&Math.abs(cur.x-prev.x)<2.0;if(!(sH||sV))break;grp.push(cur);j++;}
            const dst=j<verts.length?verts[j]:null;
            if(dst&&grp.length>2){const ax=isH?'x':'y';const asc=dst[ax]>grp[0][ax];grp.sort((a,b)=>asc?a[ax]-b[ax]:b[ax]-a[ax]);}
            for(let k=1;k<grp.length;k++)result.push(grp[k]);i=j;
          } else {result.push(verts[i]);i++;}
        }
        return result;
      };
      const sorted = _sortC(_topFaceToAdd.vertices);
      _topFaceToAdd = {..._topFaceToAdd, vertices: sorted, normal: _computeNormal(sorted)};
    }
    // 突起のstep walls（非軸平行建物で _rebuildAllWalls が生成できない）
    const _rcx=rect.reduce((s,p)=>s+p.x,0)/rect.length;
    const _rcy=rect.reduce((s,p)=>s+p.y,0)/rect.length;
    const _protrWalls=[];
    for (let _ii=0;_ii<rect.length;_ii++) {
      const _jj=(_ii+1)%rect.length;
      const _ri=_rOFE[_ii],_rj=_rOFE[_jj];
      if (_ri&&_rj&&_ri.edge===_rj.edge) continue; // 同一境界辺はスキップ
      const _wv=[rect[_ii],rect[_jj],movedRect[_jj],movedRect[_ii]];
      const _wn=_computeNormal(_wv);
      const _wcx=(_wv[0].x+_wv[1].x+_wv[2].x+_wv[3].x)/4;
      const _wcy=(_wv[0].y+_wv[1].y+_wv[2].y+_wv[3].y)/4;
      let _wfv=_wv,_wfn=_wn;
      if (_wn.nx*(_rcx-_wcx)+_wn.ny*(_rcy-_wcy)>0) {
        _wfv=[..._wv].reverse();_wfn={nx:-_wn.nx,ny:-_wn.ny,nz:-_wn.nz};
      }
      _protrWalls.push({id:_genFaceId(),type:'wall',vertices:_wfv,normal:_wfn});
    }
    // 非wall面のみ出力して _rebuildAllWalls で壁を一元再構築
    const newFaces = solid.faces.filter(f => f.id !== faceId);
    newFaces.push(_topFaceToAdd, bottomFace);
    console.warn('[INTERIOR_RECT] tower作成(突起)', {
      faceId, depth: depth.toFixed(3), 旧面数: solid.faces.length, 新面数: newFaces.length,
    });
    // 既存の内側壁（削り出し穴の壁など）を保存して再追加
    const _minSZ=Math.min(...solid.faces.flatMap(f=>f.vertices?f.vertices.map(v=>v.z):[0]));
    const _oldIW=solid.faces.filter(f=>f.type==='wall'&&f.id!==faceId&&f.vertices&&f.vertices.length>=3&&f.vertices.every(v=>v.z>_minSZ+1.0));
    const _rebuiltPP = _rebuildAllWalls(newFaces);
    return { ...solid, faces: [..._rebuiltPP, ..._oldIW, ..._protrWalls] };
  }
}

function pushPullRect(solid, faceId, rect, depth) {
  try {
  if (Math.abs(depth) < 0.001) return solid;
  const face = solid.faces.find(f => f.id === faceId);
  if (!face) return solid;

  const { nx, ny, nz } = face.normal;
  // x,yはgrid単位、zはmeters。depthはmeters → xyのみMETERS_PER_PXで変換
  const dx = nx * depth / METERS_PER_PX, dy = ny * depth / METERS_PER_PX, dz = nz * depth;
  const origVerts = face.vertices;
  const on = origVerts.length;
  const rn = rect.length;

  // rect中心（段差壁法線の向きを決める基準）
  const rectCx = rect.reduce((s, p) => s + p.x, 0) / rect.length;
  const rectCy = rect.reduce((s, p) => s + p.y, 0) / rect.length;
  // 段差壁の法線を空気側に向けるヘルパー
  // depth<0 (削り出し=cavity): rect中心側が空気 → 法線をrect中心向き
  // depth>0 (突起=protrusion): rect中心側がsolid → 法線をrect中心の逆向き
  const _orientStepWall = (verts) => {
    const wcx = verts.reduce((s, p) => s + p.x, 0) / verts.length;
    const wcy = verts.reduce((s, p) => s + p.y, 0) / verts.length;
    const sign = depth < 0 ? 1 : -1;
    const tx = (rectCx - wcx) * sign, ty = (rectCy - wcy) * sign;
    const n = _computeNormal(verts);
    if (n.nx * tx + n.ny * ty < 0) {
      // 法線が逆 → 反転
      return { vertices: [...verts].reverse(), normal: { nx: -n.nx, ny: -n.ny, nz: -n.nz } };
    }
    return { vertices: verts, normal: n };
  };

  // ── Phase 1: 選択面の分割（L字残り + 移動矩形） ──

  // 矩形頂点が元面のどの辺上にあるか検出
  const rectOnFaceEdge = rect.map(rp => {
    for (let ei = 0; ei < on; ei++) {
      const ej = (ei + 1) % on;
      const a = origVerts[ei], b = origVerts[ej];
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      if (len2 < 0.01) continue;
      const t = ((rp.x - a.x) * abx + (rp.y - a.y) * aby + (rp.z - a.z) * abz) / len2;
      if (t < -0.02 || t > 1.02) continue;
      const px = a.x + t * abx, py = a.y + t * aby, pz = a.z + t * abz;
      const dist = Math.sqrt((rp.x - px) ** 2 + (rp.y - py) ** 2 + (rp.z - pz) ** 2);
      if (dist < 2.0) return { edge: ei, t: Math.max(0, Math.min(1, t)) };
    }
    return null;
  });

  let entryRI = -1, exitRI = -1;
  for (let i = 0; i < rn; i++) {
    const ni = (i + 1) % rn;
    if (rectOnFaceEdge[i] && !rectOnFaceEdge[ni]) entryRI = i;
    if (!rectOnFaceEdge[i] && rectOnFaceEdge[ni]) exitRI = ni;
  }
  // ── 完全に面内部の矩形 → 穴を作成（4壁＋底面） ──
  const allInterior = rectOnFaceEdge.every(r => r === null);
  if (allInterior) {
    return _pushPullRectInterior(solid, faceId, rect, depth);
  }
  // ── 3辺被りケース: 全頂点が面の辺上にあるが面全体ではない ──
  // カット辺 = rect辺の中点が面辺上にない辺（_midOnEdgeで統一判定）
  // ※_midOnEdgeはこの後で定義されるが、ここで使用するためにインライン実装
  const _midOnEdgeEarly = (pa, pb) => {
    const mx=(pa.x+pb.x)/2, my=(pa.y+pb.y)/2, mz=(pa.z+pb.z)/2;
    for (let ei2=0;ei2<on;ei2++){
      const a=origVerts[ei2], b=origVerts[(ei2+1)%on];
      const abx=b.x-a.x, aby=b.y-a.y, abz=b.z-a.z, len2=abx*abx+aby*aby+abz*abz;
      if(len2<0.01) continue;
      const t=((mx-a.x)*abx+(my-a.y)*aby+(mz-a.z)*abz)/len2;
      if(t<-0.02||t>1.02) continue;
      if(Math.sqrt((mx-a.x-t*abx)**2+(my-a.y-t*aby)**2+(mz-a.z-t*abz)**2)<2.0) return true;
    }
    return false;
  };
  // 突起(depth>0): _pushPullRectInteriorに委譲（辺接触の壁拡張も内部で処理）
  if (depth > 0) {
    return _pushPullRectInterior(solid, faceId, rect, depth);
  }

  const allOnEdges = rectOnFaceEdge.every(r => r !== null);
  let _is3SideCase = false;
  const _cutSides = [];
  if (allOnEdges && entryRI < 0) {
    for (let i = 0; i < rn; i++) {
      const j = (i + 1) % rn;
      // カット辺 = 境界上を通らない（中点が面辺上にない）辺のみ
      if (!_midOnEdgeEarly(rect[i], rect[j])) {
        _cutSides.push(i);
      }
    }
    if (_cutSides.length >= 1) {
      entryRI = _cutSides[0];
      exitRI = (_cutSides[0] + 1) % rn;
      _is3SideCase = true;
    }
  }
  if (entryRI < 0 || exitRI < 0) return pushPullFace(solid, faceId, depth);
  if (!rect[exitRI] || !rect[entryRI]) return pushPullFace(solid, faceId, depth);

  const entryEdge = rectOnFaceEdge[entryRI].edge;
  const exitEdge = rectOnFaceEdge[exitRI].edge;

  const detour = [];
  let ci = (entryRI + 1) % rn;
  while (ci !== exitRI) { detour.push(rect[ci]); ci = (ci + 1) % rn; }

  const buildPath = (fromE, toE, startPt, endPt, det) => {
    const r = [{ ...startPt }];
    const _dup = (a, b) => Math.abs(a.x-b.x) < 1.0 && Math.abs(a.y-b.y) < 1.0 && Math.abs(a.z-b.z) < 1.0;
    let pi = (fromE + 1) % on;
    for (let step = 0; step < on; step++) {
      if (pi === (toE + 1) % on) break;
      // rect頂点がポリゴン頂点と一致する場合の重複を除去
      if (!_dup(origVerts[pi], r[r.length - 1])) {
        r.push({ ...origVerts[pi] });
      }
      pi = (pi + 1) % on;
    }
    // endPtが面頂点ならカット操作で消費された頂点 → 残余面に含めない
    // ループで既に追加済み(dup)なら自動スキップ。境界交点(新規点)は追加する
    const _isOrigVEndPt = origVerts.some(ov => Math.abs(ov.x-endPt.x)<1.5 && Math.abs(ov.y-endPt.y)<1.5);
    if (!_dup(endPt, r[r.length - 1]) && !_isOrigVEndPt) {
      r.push({ ...endPt });
    }
    det.forEach(dp => r.push({ ...dp }));
    return r;
  };
  // 残余面パスの構築
  // 同一辺ケース(entryEdge==exitEdge): face境界を「遠回り」してL字形を直接構築
  // 通常ケース: pathA/pathBの長い方を選ぶ
  let remainVerts;
  if (entryEdge === exitEdge) {
    const longPath = [{ ...rect[exitRI] }];
    const _dup3 = (a, b) => Math.abs(a.x-b.x)<1.0 && Math.abs(a.y-b.y)<1.0 && Math.abs(a.z-b.z)<1.0;
    const stopVi = (entryEdge + 1) % on;
    for (let k = 0; k < on; k++) {
      const vi = (exitEdge - k + on) % on;
      if (!_dup3(origVerts[vi], longPath[longPath.length-1])) longPath.push({...origVerts[vi]});
      if (vi === stopVi) break;
    }
    const ep = rect[entryRI];
    if (!_dup3(ep, longPath[longPath.length-1])) longPath.push({...ep});
    detour.forEach(dp => longPath.push({...dp}));
    remainVerts = longPath;
  } else {
    const pathA = buildPath(exitEdge, entryEdge, rect[exitRI], rect[entryRI], detour);
    const pathB = buildPath(entryEdge, exitEdge, rect[entryRI], rect[exitRI], [...detour].reverse());
    if (_is3SideCase) {
      const _isRV2 = (v) => rect.some(r => Math.abs(r.x-v.x)<1.0 && Math.abs(r.y-v.y)<1.0 && Math.abs(r.z-v.z)<1.0);
      const pANR = pathA.filter(v => !_isRV2(v)).length;
      const pBNR = pathB.filter(v => !_isRV2(v)).length;
      remainVerts = pBNR >= pANR ? pathB : pathA;
    } else {
      remainVerts = pathA.length >= pathB.length ? pathA : pathB;
    }
  }
  // 同一直線上の連続頂点を単調順にソートして自己交差を防ぐ
  const _sortCollinear = (verts) => {
    if (verts.length < 3) return verts;
    const result = [verts[0]];
    let i = 1;
    while (i < verts.length) {
      let j = i;
      const prev = result[result.length - 1];
      const isH = Math.abs(verts[i].y - prev.y) < 2.0 && Math.abs(verts[i].x - prev.x) > 0.1;
      const isV = Math.abs(verts[i].x - prev.x) < 2.0 && Math.abs(verts[i].y - prev.y) > 0.1;
      if (isH || isV) {
        const grp = [prev];
        while (j < verts.length) {
          const cur = verts[j];
          const sameH = isH && Math.abs(cur.y - prev.y) < 2.0;
          const sameV = isV && Math.abs(cur.x - prev.x) < 2.0;
          if (!(sameH || sameV)) break;
          grp.push(cur); j++;
        }
        const dst = j < verts.length ? verts[j] : null;
        if (dst && grp.length > 2) {
          const axis = isH ? 'x' : 'y';
          const asc = dst[axis] > grp[0][axis];
          grp.sort((a, b) => asc ? a[axis] - b[axis] : b[axis] - a[axis]);
        }
        for (let k = 1; k < grp.length; k++) result.push(grp[k]);
        i = j;
      } else { result.push(verts[i]); i++; }
    }
    return result;
  };
  remainVerts = _sortCollinear(remainVerts);
  const movedRect = rect.map(v => ({ x: v.x + dx, y: v.y + dy, z: v.z + dz }));
  const _newZ = movedRect[0].z;
  // 底面z: 建物の最下端。depth が底面に到達したら punch-through（f110不要、全高内壁）
  const _bottomFaces = solid.faces.filter(f => f.type === 'bottom');
  const _bottomZ2 = _bottomFaces.length > 0
    ? Math.min(..._bottomFaces.flatMap(f => f.vertices.map(v => v.z)))
    : Math.min(...solid.faces.flatMap(f => f.vertices ? f.vertices.map(v => v.z) : []));
  const _isPunchThrough = depth < 0 && _newZ <= _bottomZ2 + 1.0;
  // remainFace: 削り出し後の残余面（非矩形面にも正しく対応）
  const _rmN = _computeNormal(remainVerts);
  let _rmVerts = remainVerts, _rmNormal = _rmN;
  if (_rmN.nx*face.normal.nx + _rmN.ny*face.normal.ny + _rmN.nz*face.normal.nz < 0) {
    _rmVerts = [...remainVerts].reverse();
    _rmNormal = { nx: -_rmN.nx, ny: -_rmN.ny, nz: -_rmN.nz };
  }
  const remainFace = { id: _genFaceId(), type: face.type, vertices: _rmVerts, normal: _rmNormal };
  // bottomFace: 削り出し底面
  const bottomFace2 = {
    id: _genFaceId(), type: face.type,
    vertices: movedRect.slice().reverse(),
    normal: { nx: face.normal.nx, ny: face.normal.ny, nz: face.normal.nz }
  };
  // 内側の側面を明示生成（_rebuildAllWallsは非軸平行建物の内側壁を生成できない）
  const rcx = rect.reduce((s,p)=>s+p.x,0)/rn;
  const rcy = rect.reduce((s,p)=>s+p.y,0)/rn;
  // 点が面ポリゴン内部にあるか（ray casting 2D）
  const _isInFace=(px,py)=>{
    let inside=false;
    for(let ei=0,ej=on-1;ei<on;ej=ei++){
      const xi=origVerts[ei].x,yi=origVerts[ei].y;
      const xj=origVerts[ej].x,yj=origVerts[ej].y;
      if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;
    }
    return inside;
  };
  // 辺A→Bと面境界の交点（A側から最近）
  const _faceIsect=(ax,ay,az,bx,by,bz)=>{
    const dx=bx-ax,dy=by-ay,dz=bz-az;
    let bestT=Infinity,res=null;
    for(let ei=0;ei<on;ei++){
      const ex1=origVerts[ei].x,ey1=origVerts[ei].y;
      const ex2=origVerts[(ei+1)%on].x,ey2=origVerts[(ei+1)%on].y;
      const edx=ex2-ex1,edy=ey2-ey1;
      const denom=dx*edy-dy*edx;
      if(Math.abs(denom)<1e-6)continue;
      const t=((ex1-ax)*edy-(ey1-ay)*edx)/denom;
      const s=((ex1-ax)*dy-(ey1-ay)*dx)/denom;
      if(t>0.01&&t<0.99&&s>-0.01&&s<1.01&&t<bestT){bestT=t;res={x:ax+t*dx,y:ay+t*dy,z:az+t*dz};}
    }
    return res;
  };
  // 内側壁を生成するヘルパー
  const innerWalls = [];
  const _mkInnerWall=(pa,pb,pam,pbm)=>{
    if(!pa||!pb)return;
    const _d=(a,b)=>Math.abs(a.x-b.x)<0.1&&Math.abs(a.y-b.y)<0.1&&Math.abs(a.z-b.z)<0.1;
    const degA=_d(pa,pam),degB=_d(pb,pbm);
    if(degA&&degB)return;
    let wv;
    if(degA)      wv=[pb,pbm,pam];
    else if(degB) wv=[pa,pb,pam];
    else          wv=[pa,pb,pbm,pam];
    const wn=_computeNormal(wv);
    const wcx=wv.reduce((s,v)=>s+v.x,0)/wv.length;
    const wcy=wv.reduce((s,v)=>s+v.y,0)/wv.length;
    let wfv=wv,wfn=wn;
    if(wn.nx*(rcx-wcx)+wn.ny*(rcy-wcy)<0){wfv=[...wv].reverse();wfn={nx:-wn.nx,ny:-wn.ny,nz:-wn.nz};}
    innerWalls.push({id:_genFaceId(),type:'wall',vertices:wfv,normal:wfn});
  };
  for (let ii=0; ii<rn; ii++) {
    const jj=(ii+1)%rn;
    const _rii=rectOnFaceEdge[ii],_rjj=rectOnFaceEdge[jj];
    // 面境界辺（両端＋中点が面辺上） → 外側壁は _rebuildAllWalls が担当。内側壁は不要（建物外周）
    if (_rii&&_rjj&&_midOnEdgeEarly(rect[ii],rect[jj])) {
      continue;
    }
    // 各頂点が面内/辺上かを判定（面外はスキップ/クリップ）
    const inA = _rii!==null || _isInFace(rect[ii].x,rect[ii].y);
    const inB = _rjj!==null || _isInFace(rect[jj].x,rect[jj].y);
    if (!inA && !inB) continue; // 両方外側: スキップ
    const r0=rect[ii],r1=rect[jj],m0=movedRect[ii],m1=movedRect[jj];
    if (inA && inB) {
      // t≈0or1（面頂点上）のみtrim。辺上中間点は残余面に含まれるのでfull height維持
      // !(_rii&&_rjj)条件削除: _midOnEdgeEarlyが外周辺スキップを担当。
      // 段差境界辺（両端が別面辺上）でも内側壁を生成できるようにする
      const _atVtx=(r)=>r&&(r.t<0.02||r.t>0.98);
      if(!_rii&&_atVtx(_rjj)){
        // interior→exitRI(面頂点=建物角) → _faceIsectでv4を求めてc3→v4矩形
        const p=_faceIsect(r0.x,r0.y,r0.z,r1.x,r1.y,r1.z);
        if(p)_mkInnerWall(r0,p,m0,{x:p.x,y:p.y,z:m0.z});
      } else {
        // _rii!=nullの場合は刈り込みなし（全矩形）
        // exitRI・entryRI共に残余面に含まれるため刈り込み不要
        _mkInnerWall(r0,r1,m0,m1);
      }
    } else if (inA && !inB) {
      // A内側, B外側: 交点Pまでの壁
      const p=_faceIsect(r0.x,r0.y,r0.z,r1.x,r1.y,r1.z);
      if(p){
        _mkInnerWall(r0,p,m0,{x:p.x,y:p.y,z:m0.z});
      } else if(_rii){
        const ex=r1.x-r0.x,ey=r1.y-r0.y,elen2=ex*ex+ey*ey;
        if(elen2>0.01){
          let bestT=Infinity,bestV=null;
          for(let fi=0;fi<on;fi++){
            const fv=origVerts[fi];
            const ft=((fv.x-r0.x)*ex+(fv.y-r0.y)*ey)/elen2;
            if(ft<0.01||ft>0.99)continue;
            const fd=Math.hypot(fv.x-(r0.x+ft*ex),fv.y-(r0.y+ft*ey));
            if(fd<2.0&&ft<bestT){bestT=ft;bestV=fv;}
          }
          if(bestV)_mkInnerWall(r0,bestV,m0,{x:bestV.x,y:bestV.y,z:m0.z});
        }
      }
    } else {
      // A外側, B内側: 交点Pからの壁
      const p=_faceIsect(r0.x,r0.y,r0.z,r1.x,r1.y,r1.z);
      if(p){
        _mkInnerWall(p,r1,{x:p.x,y:p.y,z:m1.z},m1);
      } else if(_rjj){
        // r1が面頂点上でfaceIsectがmiss → rect辺方向の最近接面頂点で代替
        const ex=r0.x-r1.x,ey=r0.y-r1.y,elen2=ex*ex+ey*ey;
        if(elen2>0.01){
          let bestT=Infinity,bestV=null;
          for(let fi=0;fi<on;fi++){
            const fv=origVerts[fi];
            const ft=((fv.x-r1.x)*ex+(fv.y-r1.y)*ey)/elen2;
            if(ft<0.01||ft>0.99)continue;
            const fd=Math.hypot(fv.x-(r1.x+ft*ex),fv.y-(r1.y+ft*ey));
            if(fd<2.0&&ft<bestT){bestT=ft;bestV=fv;}
          }
          if(bestV)_mkInnerWall(bestV,r1,{x:bestV.x,y:bestV.y,z:m1.z},m1);
        }
      }
    }
  }
  // face境界辺のうち削り出し領域内に入っているものにも内側壁を生成
  const _onRectEdge=(px,py)=>{
    for(let ri=0;ri<rn;ri++){
      const a=rect[ri],b=rect[(ri+1)%rn];
      const abx=b.x-a.x,aby=b.y-a.y,len2=abx*abx+aby*aby;
      if(len2<0.01)continue;
      const t=((px-a.x)*abx+(py-a.y)*aby)/len2;
      if(t<-0.02||t>1.02)continue;
      if(Math.sqrt((px-a.x-t*abx)**2+(py-a.y-t*aby)**2)<2.0)return true;
    }
    return false;
  };
  const _isInRect=(px,py)=>{
    let inside=false;
    for(let ri=0,rj=rn-1;ri<rn;rj=ri++){
      const xi=rect[ri].x,yi=rect[ri].y,xj=rect[rj].x,yj=rect[rj].y;
      if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;
    }
    return inside;
  };
  {
    const mz=movedRect[0].z;
    for(let fi=0;fi<on;fi++){
      const fvi=origVerts[fi],fvj=origVerts[(fi+1)%on];
      if(!(_onRectEdge(fvi.x,fvi.y)||_isInRect(fvi.x,fvi.y)))continue;
      if(!(_onRectEdge(fvj.x,fvj.y)||_isInRect(fvj.x,fvj.y)))continue;
      // 両頂点が同一rect辺上 → ループ1で処理済みのrect辺と重複するためスキップ
      let onSameRectEdge=false;
      for(let ri=0;ri<rn;ri++){
        const a=rect[ri],b=rect[(ri+1)%rn];
        const abx=b.x-a.x,aby=b.y-a.y,len2=abx*abx+aby*aby;
        if(len2<0.01)continue;
        const ti=Math.max(0,Math.min(1,((fvi.x-a.x)*abx+(fvi.y-a.y)*aby)/len2));
        const tj=Math.max(0,Math.min(1,((fvj.x-a.x)*abx+(fvj.y-a.y)*aby)/len2));
        const di=Math.hypot(fvi.x-(a.x+ti*abx),fvi.y-(a.y+ti*aby));
        const dj=Math.hypot(fvj.x-(a.x+tj*abx),fvj.y-(a.y+tj*aby));
        if(di<2.0&&dj<2.0){onSameRectEdge=true;break;}
      }
      if(onSameRectEdge)continue;
      _mkInnerWall(fvi,fvj,{x:fvi.x,y:fvi.y,z:mz},{x:fvj.x,y:fvj.y,z:mz});
    }
  }
  // 非wall面のみ出力して _rebuildAllWalls で外側壁を再構築
  const newFaces2 = solid.faces.filter(f => f.id !== faceId);
  newFaces2.push(remainFace);
  if (!_isPunchThrough) newFaces2.push(bottomFace2);
  // 既存の内側壁（他の削り出し穴や突起壁など）を保存して再追加
  const _minSZ2=Math.min(...solid.faces.flatMap(f=>f.vertices?f.vertices.map(v=>v.z):[0]));
  const _oldIW2=solid.faces.filter(f=>f.type==='wall'&&f.id!==faceId&&f.vertices&&f.vertices.length>=3&&f.vertices.every(v=>v.z>_minSZ2+1.0));
  const rebuiltFaces = _rebuildAllWalls(newFaces2);
  return { ...solid, faces: [...rebuiltFaces, ..._oldIW2, ...innerWalls] };


  } catch(e) {
    console.error('[pushPullRect] クラッシュ回避', e.message, { faceId, rectLen: rect?.length, depth });
    return pushPullFace(solid, faceId, depth);
  }
}

// flatBlocks互換形式（モジュールレベル初期値: calcInitPan用）
function flattenBuildings(buildings) {
  const result = [];
  buildings.forEach(bld => {
    bld.blocks.forEach((blk, bi) => {
      // All blocks use plan-view coordinates points[{x,y}] + zBottom/zTop
      const pts = blk.points.filter(p => p.x != null && p.y != null);
      if (pts.length < 3) return;
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);
      result.push({
        points: pts,
        x: minX / MAJOR, y: minY / MAJOR,
        w: (maxX - minX) / MAJOR, h: (maxY - minY) / MAJOR,
        pxMinX: minX, pxMinY: minY, pxMaxX: maxX, pxMaxY: maxY,
        height: blk.zTop, zBottom: blk.zBottom || 0, zTop: blk.zTop,
        _preExtrudePoints: blk._preExtrudePoints || null,
        _sharedWall: blk._sharedWall || null,
        _parentBlockIdx: blk._parentBlockIdx != null ? blk._parentBlockIdx : null,
        _carvedFace: blk._carvedFace || null,
        _blockCount: bld.blocks.length,
        label: bld.label, color: bld.color, buildingId: bld.id, blockIdx: bi,
      });
    });
  });
  return result;
}
const INIT_BLDS = flattenBuildings(INIT_BUILDINGS);
const BLD_COLORS = ["#6B7A8D", "#7B8A9D", "#8896A8", "#5A6B7D", "#4E7A6D", "#7D5A6B", "#6B5A7D", "#7D6B5A"];

