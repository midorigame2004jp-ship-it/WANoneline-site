// ================================================================
// 面ベースソリッドモデル: ブロック → Solid(faces[]) 変換
// ================================================================
let _solidFaceIdCounter = 0;
function _genFaceId() { return 'f' + (++_solidFaceIdCounter); }
// ══ 面の id は「その面がどこの面か」で決める ・2026-09-22 Codex監査済み ══
// 立体は建屋の形が変わるたびに作り直される。id が通し番号だと作り直しのたびに総入れ替えになり、
// 押し引きの矢印が持っている faceId が迷子になって**2回目以降の操作が効かない**（ユーザー報告・実測で
// pushPullFace に渡した faceId の面が立体に無い＝押し出し 0 だった）。
// **形（頂点列）から決めるのも誤り**。押し引きで形が変われば id も変わり、同じ問題が残る。
// 正しくは「面の位置づけ」＝ ブロックの id ＋ 面の種類 ＋（側面なら）底面の何番目の辺か。
//   ・上面 / 下面 … ブロックに1つなので種類だけ
//   ・側面 … 辺の番号。柱を平行移動する押し引きでは辺の数が変わらないので安定する
// 対称な建屋の左右の壁は辺の番号が違うので衝突しない。保存・再読込でも points の順が同じなら同じ id。
// pushPullFace が新しく作る面は従来どおり通し番号（元からある面の id を保つことが目的）。
// 段階フラグ window.__FACE_ID_STABLE = false で通し番号に戻す（従来＝2回目が効かない）＝陽性対照。
function _faceIdOf(solidId, kind, edgeIdx, cell) {
  if (typeof window !== 'undefined' && window.__FACE_ID_STABLE === false) return _genFaceId();
  let id = String(solidId) + '|' + String(kind) + (edgeIdx != null ? '|' + edgeIdx : '');
  // 【2026-09-23 Codex監査】共有壁の開口で1つの辺が複数の壁セルに割れる。
  // 辺の番号だけだと id が衝突するので、**同じ幾何セルなら同じ id** になるよう u/z を入れる
  // （生成順や配列の位置には依存させない）。
  if (cell && cell.notch) {
    // 欠き込み（コの字）1枚。開口の並びを署名にして、同じ形なら同じ id にする
    id += '|notch|' + cell.notch;
  } else if (cell && cell.seg != null) {
    // 【掃引の側面・2026-10-03】経路に沿って段に割れるので、辺の番号＋段の番号で決める。
    // 取付枠として外へ出すときは「辺ぜんぶで1枚の面」にするので、ここが割れていても
    // コンセントの居場所（辺の名前）は変わらない
    id += '|seg:' + cell.seg;
  } else if (cell) {
    id += '|u:' + cell.u0.toFixed(3) + '-' + cell.u1.toFixed(3)
        + '|z:' + cell.z0.toFixed(3) + '-' + cell.z1.toFixed(3);
  }
  return id;
}
// ════════════════════════════════════════════════════════════════
// 抜く(void) — 領域から穴を引いて、残りをセルにする ・2026-10-04
// ════════════════════════════════════════════════════════════════
// 【なぜ1つにするか】同じ「穴を避けて残りを作る」を3か所でやる：
//   ガワの壁（増築棟がつながる穴）／仕切り壁（窓・ダクト貫通）／床（吹き抜け）。
//   場所ごとに書くと必ずどこかが漏れる（面の思想と同じ・SHAPE_MODEL_SPEC.md）。
// 【どこまで共有するか】帯への展開・切れ目集め・穴セルの除外・内部の辺の判定まで。
//   face の id・線を引くかどうか・ポリゴンの作り方はホスト側が持つ
//   （Codex監査: ガワ壁は『id が幾何から決まる』という別の制約を持っているので、
//    出力の整形まで寄せると壊れやすい）。
// 【軸の呼び方】a / b は場所で意味が変わる。
//   壁 … a = u（端点からの距離[m]）、b = z（高さ[m]）
//   床 … a = x、b = y（どちらもグリッド）

// 穴ひとつ → (a,b) 平面の矩形帯の列。中心は原点、**戻りは必ずメートル**。
//   （profilePoints はグリッドを返すのでここで直す。軸の単位は呼び手が合わせる：
//    仕切り壁は u も z もメートルなのでそのまま、床は x,y がグリッドなので / mpp する）
// 【形は BC_PROFILES を共有する】穴の形ごとに型を作らない（SHAPE_MODEL_SPEC.md §1）。
//   矩形は刻まずに1枚（＝余計な継ぎ目の線が出ない）。それ以外は a を帯に刻み、
//   各帯で輪郭の b の上下を取る（丸穴＝ダクト貫通はこれで出る）。
//   ※ 凹んだ断面（H形鋼など）は上下の包絡になる。穴としては外形で抜く扱い。
function openingBands(op, seg) {
  const o = op || {};
  const kind = o.kind || 'rect';
  if (kind === 'rect') {
    const w = +o.wM || 0, h = +o.hM || 0;
    if (!(w > 1e-9 && h > 1e-9)) return [];
    return [{ a0: -w / 2, a1: w / 2, b0: -h / 2, b1: h / 2 }];
  }
  const pts = (typeof profilePoints === 'function') ? profilePoints(o) : null;
  if (!pts || pts.length < 3) return [];
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
  pts.forEach(p => { if (p.x < xLo) xLo = p.x; if (p.x > xHi) xHi = p.x;
                     if (p.y < yLo) yLo = p.y; if (p.y > yHi) yHi = p.y; });
  if (!(xHi - xLo > 1e-9) || !(yHi - yLo > 1e-9)) return [];
  const cy = (yLo + yHi) / 2, cx = (xLo + xHi) / 2;   // 断面の芯を穴の中心に合わせる
  const n = Math.max(2, seg || 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a0 = xLo + (xHi - xLo) * k / n, a1 = xLo + (xHi - xLo) * (k + 1) / n;
    const am = (a0 + a1) / 2;
    // am を通る縦線と輪郭の交点
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if ((p.x <= am && q.x >= am) || (q.x <= am && p.x >= am)) {
        const dx = q.x - p.x;
        const y = Math.abs(dx) < 1e-12 ? p.y : p.y + (q.y - p.y) * (am - p.x) / dx;
        if (y < lo) lo = y; if (y > hi) hi = y;
        if (Math.abs(dx) < 1e-12) { if (q.y < lo) lo = q.y; if (q.y > hi) hi = q.y; }
      }
    }
    if (!(hi - lo > 1e-9)) continue;
    const mpp = _mwMpp();   // グリッド → メートル
    out.push({ a0: (a0 - cx) * mpp, a1: (a1 - cx) * mpp,
               b0: (lo - cy) * mpp, b1: (hi - cy) * mpp });
  }
  return out;
}

// 領域 (A0..A1, B0..B1) から帯を引いて、残ったセルを返す。
//   戻り: [{a0,a1,b0,b1, edges:[下,右,上,左]}]
//   edges[k] = true … その辺は外周か穴の縁（線を引く）／false … 分割で生まれた内部の辺
function carveCells(A0, A1, B0, B1, bands) {
  const out = [];
  if (!(A1 - A0 > 1e-9) || !(B1 - B0 > 1e-9)) return out;
  const hs = (bands || []).map(h => ({
    a0: Math.max(A0, h.a0), a1: Math.min(A1, h.a1),
    b0: Math.max(B0, h.b0), b1: Math.min(B1, h.b1),
  })).filter(h => h.a1 - h.a0 > 1e-6 && h.b1 - h.b0 > 1e-6);
  if (!hs.length) return [{ a0: A0, a1: A1, b0: B0, b1: B1, edges: [true, true, true, true] }];
  const _uniq = (arr, lo, hi) => [...new Set(arr.map(v => +v.toFixed(4)))]
    .filter(v => v >= lo - 1e-6 && v <= hi + 1e-6).sort((x, y) => x - y);
  const aa = _uniq([A0, A1, ...hs.flatMap(h => [h.a0, h.a1])], A0, A1);
  // その位置に実体があるか（領域の外＝無い／穴の中＝無い）
  const 居る = (ca, cb) => {
    if (ca < A0 - 1e-6 || ca > A1 + 1e-6 || cb < B0 - 1e-6 || cb > B1 + 1e-6) return false;
    return !hs.some(h => ca > h.a0 - 1e-6 && ca < h.a1 + 1e-6
                      && cb > h.b0 - 1e-6 && cb < h.b1 + 1e-6);
  };
  for (let k = 0; k < aa.length - 1; k++) {
    const a0 = aa[k], a1 = aa[k + 1];
    if (a1 - a0 < 1e-6) continue;
    const ca = (a0 + a1) / 2;
    // 【b を切るのは、そのスライスに掛かる穴だけ・2026-10-04】
    //   全部の穴の b 境界を全スライスへ配ると、無関係な場所にまで継ぎ目が入る。
    //   実測: 丸穴ひとつ（16帯）で壁が178枚に割れた → この形にして34枚。
    //   口の字も 8枚 → 4枚（窓の左・右・上・下）になり、見た目どおりの割れ方になる。
    const here = hs.filter(h => ca > h.a0 - 1e-6 && ca < h.a1 + 1e-6);
    const bb = _uniq([B0, B1, ...here.flatMap(h => [h.b0, h.b1])], B0, B1);
    for (let m = 0; m < bb.length - 1; m++) {
      const b0 = bb[m], b1 = bb[m + 1];
      if (b1 - b0 < 1e-6) continue;
      const cb = (b0 + b1) / 2;
      if (!居る(ca, cb)) continue;   // ここが穴
      const e = Math.min(a1 - a0, b1 - b0) * 0.25;
      out.push({ a0, a1, b0, b1, edges: [
        !居る(ca, b0 - e), !居る(a1 + e, cb), !居る(ca, b1 + e), !居る(a0 - e, cb),
      ] });
    }
  }
  return out;
}

// 【2026-09-23 Codex監査】壁と開口の関係を1つの述語で分類する。
// 'none'        開口なし＝1枚のまま（既存の見た目・id を変えない）
// 'full-open'   壁ぜんぶが開口＝壁を作らない
// 'notch-bottom' 開口が全部**下辺に接し**、上まで貫かない＝**コの字の1多角形**（線が出ない）
// 'split-grid'  それ以外＝u×z のグリッドに割る（内部に浮いた穴・上下を貫く開口）
function classifyWallOpeningTopology(elen, zB, zT, ops) {
  if (!ops || !ops.length) return 'none';
  if (ops.some(o => o.u0 <= 1e-6 && o.u1 >= elen - 1e-6
                 && o.z0 <= zB + 1e-6 && o.z1 >= zT - 1e-6)) return 'full-open';
  const allBottom = ops.every(o => Math.abs(o.z0 - zB) < 1e-6);
  const throughTop = ops.some(o => o.z1 >= zT - 1e-6);
  if (allBottom && !throughTop) return 'notch-bottom';
  return 'split-grid';
}
// コの字の輪郭（u,z の並び）。下辺から立ち上がる開口を順に欠き取る
function _wallNotchOutline(elen, zB, zT, ops) {
  const sorted = [...ops].map(o => ({ u0: Math.max(0, o.u0), u1: Math.min(elen, o.u1), z1: Math.min(zT, o.z1) }))
    .filter(o => o.u1 - o.u0 > 1e-6).sort((a, b) => a.u0 - b.u0);
  // 重なり・隣接をつなげる（1つの欠き込みにまとめる。境目に線を出さないため）
  const merged = [];
  sorted.forEach(o => {
    const last = merged[merged.length - 1];
    if (last && o.u0 <= last.u1 + 1e-6) { last.u1 = Math.max(last.u1, o.u1); last.z1 = Math.max(last.z1, o.z1); }
    else merged.push({ ...o });
  });
  const pts = [];
  const push = (u, z) => {
    const p = pts[pts.length - 1];
    if (p && Math.abs(p.u - u) < 1e-6 && Math.abs(p.z - z) < 1e-6) return;
    pts.push({ u, z });
  };
  push(0, zB);
  merged.forEach(o => { push(o.u0, zB); push(o.u0, o.z1); push(o.u1, o.z1); push(o.u1, zB); });
  push(elen, zB); push(elen, zT); push(0, zT);
  return { pts: pts, sig: merged.map(o => o.u0.toFixed(2) + '-' + o.u1.toFixed(2) + '@' + o.z1.toFixed(2)).join(',') };
}
// 段階フラグ: false で従来＝共有壁の穴を開けない（陽性対照）
function _sharedWallOpenOn() {
  return !(typeof window !== 'undefined' && window.__BLD_SHARED_WALL_OPEN === false);
}
// 点が辺 a→b の線上にあるとき、始点からの距離を返す（無ければ null）。
// 【なぜ辺の番号でなく実座標で受けるか】blockToSolid は points を CCW 正規化するので、
// 記録上の辺の番号と solid の辺の番号がずれる（向きも反転する）。座標で照合すれば取り違えない。
function _uOnEdge(px, py, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
  if (L2 < 1e-12) return null;
  const t = ((px - a.x) * ex + (py - a.y) * ey) / L2;
  const cx = a.x + t * ex, cy = a.y + t * ey;
  if (Math.hypot(px - cx, py - cy) > 0.5) return null;   // 辺から離れている
  return t * Math.sqrt(L2);
}
// 【共通述語・2026-09-23】親ブロックの壁に開く穴（増築棟が接している範囲）を実座標で返す。
// solid・平面図・断面図・側面図が **これ1つ** を見る（入口ごとに _sharedWall を解釈しない）。
function getSharedWallOpenings(blocks, parentBlockIdx) {
  const out = [];
  if (!Array.isArray(blocks)) return out;
  const parent = blocks[parentBlockIdx];
  if (!parent || !Array.isArray(parent.points)) return out;
  blocks.forEach((cb, ci) => {
    const sw = cb && cb._sharedWall;
    if (!sw) return;
    const pi = (sw.parentBlockIdx != null) ? sw.parentBlockIdx : cb._parentBlockIdx;
    if (pi !== parentBlockIdx) return;
    const q = parent.points, n = q.length;
    const ei = (((sw.parentEdge | 0) % n) + n) % n;
    const a = q[ei], b = q[(ei + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(L > 1e-6)) return;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    const u0 = Math.max(0, Math.min(sw.uMin, sw.uMax));
    const u1 = Math.min(L, Math.max(sw.uMin, sw.uMax));
    if (!(u1 - u0 > 1e-6)) return;
    out.push({
      ax: a.x + u0 * ux, ay: a.y + u0 * uy,
      bx: a.x + u1 * ux, by: a.y + u1 * uy,
      zMin: cb.zBottom || 0, zMax: cb.zTop != null ? cb.zTop : 40,
      childBlockIdx: ci,
    });
  });
  return out;
}
// 増築棟の側。親に接している壁（wallIdx の辺）は作らない＝その面も「開口」として扱う
function getOwnSharedWallOpening(blk) {
  const sw = blk && blk._sharedWall;
  if (!sw || sw.wallIdx == null || !Array.isArray(blk.points)) return null;
  const q = blk.points, n = q.length;
  const wi = (((sw.wallIdx | 0) % n) + n) % n;
  const a = q[wi], b = q[(wi + 1) % n];
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y,
           zMin: blk.zBottom || 0, zMax: blk.zTop != null ? blk.zTop : 40 };
}
// あるブロックを solid にするとき渡す開口の一式（親としての穴＋自分の共有壁）
function sharedWallOpeningsForBlock(blocks, blockIdx) {
  if (!_sharedWallOpenOn()) return [];
  const out = getSharedWallOpenings(blocks, blockIdx);
  const own = getOwnSharedWallOpening(blocks && blocks[blockIdx]);
  if (own) out.push(own);
  return out;
}

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
// ════════════════════════════════════════════════════════════════
// 上面の傾き（片流れ屋根・擁壁）・2026-10-03
// ════════════════════════════════════════════════════════════════
// 【なぜ平面を保つか】頂点ごとに自由な高さを持たせると、4点以上の上面が**平面でなくなり**、
//   描画・面の選択・押し引き・部屋認識がまとめて崩れる（Codex監査）。
//   1ブロック＝1つの傾いた平面。寄棟・入母屋は**ブロックを分けて**作る。
// 【slope の中身】{ ox, oy, dx, dy, pitch }
//   ox,oy … 基準点［グリッド］。ここで高さがちょうど zTop になる
//   dx,dy … 傾きが上がっていく水平の向き。**長さは見ない**（単位ベクトルに直す。Codex指摘：
//           直さないと向きベクトルの長さで勾配が変わる）
//   pitch … 勾配［m/m］。水平に1m進むと何m上がるか
// 【上面の高さを出すのはここだけ】呼ぶ側が式を書くと、上面と側面で食い違う
function blockTopZAt(blk, pt) {
  const zT = (blk && blk.zTop != null) ? blk.zTop : 40;
  const sl = blk && blk.slope;
  if (!sl || !sl.pitch) return zT;
  if (typeof window !== 'undefined' && window.__BLD_SLOPE === false) return zT;
  const L = Math.hypot(sl.dx || 0, sl.dy || 0);
  if (!(L > 1e-9)) return zT;
  const ux = (sl.dx || 0) / L, uy = (sl.dy || 0) / L;
  const d = ((pt.x - (sl.ox || 0)) * ux + (pt.y - (sl.oy || 0)) * uy) * _mwMpp();
  return zT + d * sl.pitch;
}
// そのブロックの上面の**一番低い所**。階の有効な天井に使う（Codex：
// 何もしないと、低い側の屋根を階・機器・仕切りが突き抜ける）
function blockMinTopZ(blk) {
  const pts = (blk && blk.points) || [];
  const zT = (blk && blk.zTop != null) ? blk.zTop : 40;
  if (!pts.length || !(blk && blk.slope && blk.slope.pitch)) return zT;
  let m = Infinity;
  pts.forEach(p => { const z = blockTopZAt(blk, p); if (z < m) m = z; });
  return isFinite(m) ? m : zT;
}
// 上面の一番高い所（立体の天端）
function blockMaxTopZ(blk) {
  const pts = (blk && blk.points) || [];
  const zT = (blk && blk.zTop != null) ? blk.zTop : 40;
  if (!pts.length || !(blk && blk.slope && blk.slope.pitch)) return zT;
  let m = -Infinity;
  pts.forEach(p => { const z = blockTopZAt(blk, p); if (z > m) m = z; });
  return isFinite(m) ? m : zT;
}
// 傾きを付けられるか。開口（増築棟とつなぐ穴）がある辺は上端が一定である前提で
// 組み立てているので、両方を同時には扱えない（v1 の割り切り・Codex：無視して乖離を作らない）
function blockSlopeBlockedReason(blk, openings) {
  if (Array.isArray(openings) && openings.length)
    return 'この棟は別の棟とつながっているので、上面を傾けられません（つなぎ目の穴と同時には扱えません）';
  return null;
}

// ════════════════════════════════════════════════════════════════
// 【低レベルの内部部品】blockToSolid を UI や描画から直に呼んではいけない・2026-10-03
//   これは「平面の輪郭を真上に押し出す」1種類しか作れない。
//   上面の傾き（slope）・掃引（らせん・斜路）・並べた部材（螺旋階段の段板）・
//   増築棟の穴・外向き法線の正規化は、**呼ぶ側 blockSolidOf / blockSolidsOf** が持っている。
//   直に呼ぶと「新しい形の作り方を知らない道」が1本増え、
//   「3次元図には出るのに建物エディタのプレビューには出ない」が起きる（実際に起きた）。
//   → ブロックから立体を作るときは必ず blockSolidsOf(bld, blk, bi) を使う。
//   破っていないかは checks/bld_single_entry.cjs が常設で掃引している
// ════════════════════════════════════════════════════════════════
// 【opts.shape を受け取ったら立体に印を残す・2026-11-24】
//   shape.type==='circle' なら solid._circle = { cx, cy, r, zB, zT }。
//   面（48角形）はこれまでどおり作る（当たり判定・押し引き・部屋認識が点列を前提にしているため）。
//   **描き手だけ**がこの印を見て、楕円と側面の帯で描く＝48面でなく数要素で済む。
function blockToSolid(buildingId, blockIdx, label, color, pts, zB, zT, opts) {
  if (!pts || pts.length < 3) return null;
  // CCW正規化
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; area += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  const normPts = area >= 0 ? pts : [...pts].reverse();
  const n = normPts.length;
  const faces = [];

  const _sid = `${buildingId}_${blockIdx}`;

  // 上面 (CCW = 法線+Z)。傾けるときは頂点ごとに高さを出す（式は blockTopZAt だけ）
  const _slope = (opts && opts.slope) || null;
  const _topZ = (p) => (_slope ? blockTopZAt({ zTop: zT, slope: _slope }, p) : zT);
  const _topVerts = normPts.map(p => ({ x: p.x, y: p.y, z: _topZ(p) }));
  faces.push({
    id: _faceIdOf(_sid, 'top'), type: 'top',
    vertices: _topVerts,
    // 傾いているときは法線を計算する（+Z のままだと陰影も押し引きの向きも嘘になる・Codex）。
    // 【メートルに揃えてから計算する】この立体の頂点は x,y がグリッド・z がメートルの**混ざった空間**。
    //   そのまま外積を取ると、高さ方向だけ 1/mpp 倍に潰れた向きになる
    //   （実測: 勾配0.5 の屋根の法線が (0,-0.05,0.999)＝ほぼ真上。正しくは (0,-0.447,0.894)）。
    //   csgMeshToFaces も同じ理由で換算前の値から法線を作っている。
    normal: _slope
      ? _computeNormal(_topVerts.map(v => ({ x: v.x * _mwMpp(), y: v.y * _mwMpp(), z: v.z })))
      : { nx: 0, ny: 0, nz: 1 },
  });

  // 下面 (逆順 = 法線-Z)
  faces.push({
    id: _faceIdOf(_sid, 'bottom'), type: 'bottom',
    vertices: normPts.map(p => ({ x: p.x, y: p.y, z: zB })).reverse(),
    normal: { nx: 0, ny: 0, nz: -1 },
  });

  // 側面 (各辺に1つの4角形壁: 下左→下右→上右→上左)
  // 【2026-09-23】opts.openings に重なる部分は壁を作らない＝増築棟とつながる穴になる。
  // 開口が無い辺は**従来どおり1枚**のまま（既存の見た目・face id を変えない）。
  const _openings = (opts && Array.isArray(opts.openings)) ? opts.openings : [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = normPts[i], b = normPts[j];
    const elen = Math.hypot(b.x - a.x, b.y - a.y);
    // この辺に乗っている開口だけを u 範囲に直す
    const ops = [];
    if (elen > 1e-6) {
      _openings.forEach(o => {
        const t0 = _uOnEdge(o.ax, o.ay, a, b), t1 = _uOnEdge(o.bx, o.by, a, b);
        if (t0 == null || t1 == null) return;
        const u0 = Math.max(0, Math.min(t0, t1)), u1 = Math.min(elen, Math.max(t0, t1));
        const z0 = Math.max(zB, Math.min(o.zMin, o.zMax)), z1 = Math.min(zT, Math.max(o.zMin, o.zMax));
        if (u1 - u0 < 1e-6 || z1 - z0 < 1e-6) return;
        ops.push({ u0, u1, z0, z1 });
      });
    }
    const _topo = classifyWallOpeningTopology(elen, zB, zT, ops);
    if (_topo === 'none') {
      const wallVerts = [
        { x: a.x, y: a.y, z: zB }, { x: b.x, y: b.y, z: zB },
        { x: b.x, y: b.y, z: _topZ(b) }, { x: a.x, y: a.y, z: _topZ(a) },
      ];
      faces.push({
        id: _faceIdOf(_sid, 'wall', i), type: 'wall',
        vertices: wallVerts,
        normal: _computeNormal(wallVerts),
        _edgeIdx: i,
      });
      continue;
    }
    if (_topo === 'full-open') continue;   // 壁ぜんぶが開口＝作らない
    const _ux0 = (b.x - a.x) / elen, _uy0 = (b.y - a.y) / elen;
    if (_topo === 'notch-bottom') {
      // 【ここが「余計な縦線」の対処】セルを並べず**欠き込み付きの1枚**にする。
      // 面が1つなので、増築棟との境目に線が出ない＝一体に見える
      const { pts: _np, sig: _sig } = _wallNotchOutline(elen, zB, zT, ops);
      const nv = _np.map(p2 => ({ x: a.x + p2.u * _ux0, y: a.y + p2.u * _uy0, z: p2.z }));
      if (nv.length >= 3) {
        faces.push({
          id: _faceIdOf(_sid, 'wall', i, { notch: _sig }), type: 'wall',
          vertices: nv,
          normal: _computeNormal(nv),
          _edgeIdx: i,
        });
      }
      continue;
    }
    // 開口がある辺は u・z の境界でグリッドに割り、開口に入るセルだけ作らない。
    // 子が複数あっても、全部の境界をまとめて集めてから割る（子ごとに4分割しない＝Codex）
    // 【2026-10-04】割り方そのものは carveCells が持つ（仕切り壁の窓・床の吹き抜けと同じ処理）。
    //   face の id と「線を引くか」だけはここ（ホスト側）が決める。
    const ux = (b.x - a.x) / elen, uy = (b.y - a.y) / elen;
    const _cells = carveCells(0, elen, zB, zT,
      ops.map(o => ({ a0: o.u0, a1: o.u1, b0: o.z0, b1: o.z1 })));
    for (const _c of _cells) {
      const u0 = _c.a0, u1 = _c.a1, z0 = _c.b0, z1 = _c.b1;
      const p0x = a.x + u0 * ux, p0y = a.y + u0 * uy;
      const p1x = a.x + u1 * ux, p1y = a.y + u1 * uy;
      const cellVerts = [
        { x: p0x, y: p0y, z: z0 }, { x: p1x, y: p1y, z: z0 },
        { x: p1x, y: p1y, z: z1 }, { x: p0x, y: p0y, z: z1 },
      ];
      // 【2026-09-23】隣にもセルがある辺＝**分割で生まれた内部の辺**なので線を引かない。
      // 引くのは壁の外周と開口の縁だけ。描画側の poly.edges（辺ごとに描くか）に渡す。
      // これで壁の途中に浮いた増築棟でも「上下左右のいらない線」が出ない（ユーザー実機報告）
      faces.push({
        id: _faceIdOf(_sid, 'wall', i, { u0, u1, z0, z1 }), type: 'wall',
        vertices: cellVerts,
        normal: _computeNormal(cellVerts),
        _edgeIdx: i,
        // 段階フラグ: false で全辺を引く＝内部の境目が線として出る（陽性対照）
        edges: (typeof window !== 'undefined' && window.__BLD_CELL_EDGES === false) ? null : _c.edges,
      });
    }
  }

  // 【円柱の印】描き手が「円として」描けるようにする（面はそのまま48角形で持つ）
  const _sh = opts && opts.shape;
  const _circleMark = (_sh && _sh.type === 'circle' && Number.isFinite(_sh.r) && _sh.r > 0)
    ? { cx: _sh.cx, cy: _sh.cy, r: _sh.r, zB, zT } : null;
  return {
    ...(_circleMark ? { _circle: _circleMark } : {}),
    id: `${buildingId}_${blockIdx}`,
    buildingId, blockIdx, label,
    color: color || '#6B7A8D',
    faces,
    _normPts: normPts,
  };
}

// ════════════════════════════════════════════════════════════════
// 掃引（断面 × 経路）・2026-10-03
// ════════════════════════════════════════════════════════════════
// 【なぜ要るか】これまで形は「平面の輪郭 × 一定の高さ範囲」だけだった（blockToSolid）。
//   z が位置によって変わる形 ― らせん・斜路・片流れ屋根・円錐 ― が**1つも作れず**、
//   「螺旋階段にコンセントを付けたい」に応えられなかった（2026-10-03 ユーザー指摘）。
//   押し出しは「経路が真上の直線」という特別な場合でしかないので、**経路を差し替えられる形**にする。
//
// 【経路の種類】blk.sweep.path.kind
//   line  … 真上へ h[m]                     ＝ 従来の押し出しと同じ結果になる
//   ramp  … 水平に dx,dy 進みながら rise 上がる（斜路・片流れ屋根）
//   helix … 中心(cx,cy)のまわりを sweepDeg 回りながら rise 上がる（らせん）
//   ※ arc（曲管）と revolve（ドーム・タンク）は次の段。濁らせないので kind を分ける
//
// 【断面】blk.points（平面の輪郭）をそのまま使う。経路に沿って scale0→scale1 で
//   拡縮できる（円錐・漏斗・テーパーダクト）。
//
// 【押し引きは掛けない】曲がった面・ねじれた面を法線方向に押すと断面と経路の意味が壊れる
//   （Codex監査）。掃引で作った形は path / 断面 / 拡縮 の**値を直して**変える。

// 経路を seg 等分して、各段の「断面の置き方」を返す
// ════════════════════════════════════════════════════════════════
// 経路（Curve）・2026-10-04 Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【なぜ作ったか】ユーザー指摘「例を挙げるたびに個別で作っている。
//   3D CAD は形の種類を持たず、経路は curveAt(t)→位置・接線 の1つの契約で扱う」。
//   実際ここには kind === 'helix' / 'ramp' / それ以外 の分岐が sweepFrames に3つ、
//   回転中心の決め方に **もう1つ**（_sweepOrigin）あった。経路を1つ足すたびに両方へ if が増える。
//
// 【契約】curveAt(path, t, 断面の重心) →
//   { ox, oy    回転・拡縮の中心［グリッド］
//     yaw       断面を水平に回す角［ラジアン］
//     dx, dy    水平の移動［グリッド］
//     dz        上がり［メートル］
//     t3        進む向き（**メートル空間の単位ベクトル**。断面を立てるときに使う） }
//   t は 0〜1。増やすのは**分岐ではなく表 BC_CURVES の行**（Codex: これは健全な抽象化）
//
// 【単位の注意】x,y はグリッド（1 = 0.1m）・z はメートルの混在空間。
//   向き（接線・面の軸）は必ず**メートルに揃えてから**作る。揃えないと高さだけ 1/mpp 倍に潰れる
//   （2026-10-03 に屋根の法線で同じ罠を踏んでいる）
const _CURVE_EPS = 1e-12;
function _curveNorm3(x, y, z) {
  const L = Math.hypot(x, y, z);
  return L > _CURVE_EPS ? { x: x / L, y: y / L, z: z / L } : { x: 0, y: 0, z: 1 };
}

// らせん／円弧。**式は共有**（水平に曲げる＝上がり0のらせん）
function _curveHelixAt(p, t, c) {
  const mpp = _mwMpp();
  const w = (p.sweepDeg != null ? p.sweepDeg : 360) * Math.PI / 180;
  const cx = p.cx || 0, cy = p.cy || 0, rise = p.rise || 0;
  // 断面の重心が回る半径と、そのときの角度（進む向きを出すのに要る）
  const r = Math.hypot(c.cx - cx, c.cy - cy);
  const th = Math.atan2(c.cy - cy, c.cx - cx) + w * t;
  // 【半径の変化・2026-10-06】r1 ＝ 終わりの半径が始めの何倍か（1 なら従来どおり一定）。
  //   これでドリルの先端・円錐バネ・渦巻きが出る。**新しい経路の種類は作らない**。
  //   半径がほぼ 0 の断面では『どちらが外か』が決まらないので効かせない（Codex）
  const r1 = (Number.isFinite(p.r1) && r > 1e-6) ? p.r1 : 1;
  const 新r = r * (1 + (r1 - 1) * t);
  const dr = r * (r1 - 1);                     // 半径の変わる速さ（dr/dt）
  return { ox: cx, oy: cy, yaw: w * t,
           // 回した後、径方向へ（新しい半径 − 元の半径）ぶんずらす
           dx: (新r - r) * Math.cos(th), dy: (新r - r) * Math.sin(th), dz: rise * t,
           // 進む向きは『円周方向 ＋ 径方向 ＋ 上がり』。径方向を入れないと断面の向きがずれる
           t3: _curveNorm3((-新r * w * Math.sin(th) + dr * Math.cos(th)) * mpp,
                           (新r * w * Math.cos(th) + dr * Math.sin(th)) * mpp, rise) };
}

// 折れ線。曲がり角は必ずサンプルする（等間隔に刻むと角を飛ばす）
function _curvePolyGeom(p) {
  const pts = (p && Array.isArray(p.pts) ? p.pts : [])
    .filter(q => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  const L = [0];
  for (let i = 1; i < pts.length; i++)
    L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, L, total: L.length ? L[L.length - 1] : 0 };
}
// 点ごとの高さがあるときは、区間の中も刻む（断面の向きが区間ごとに変わるため）
function _curvePolySamples(p, seg) {
  const g = _curvePolyGeom(p);
  if (!(g.total > 0)) return [0, 1];
  const 角 = g.L.map(v => v / g.total);
  if (seg <= 1) return 角;
  // 各区間をさらに刻む（曲がり角は必ず残る）
  const out = [0];
  for (let i = 1; i < 角.length; i++) {
    const n = Math.max(1, Math.round(seg * (角[i] - 角[i - 1])));
    for (let k = 1; k <= n; k++) out.push(角[i - 1] + (角[i] - 角[i - 1]) * (k / n));
  }
  return out;
}
// その位置での進む向き（曲がり角では前後の区間の平均。v1の割り切り）
function _curvePolyDir(g, s) {
  const n = g.pts.length;
  if (n < 2) return { ux: 1, uy: 0, i: 0 };
  const 区間 = (i) => { const a = g.pts[i], b = g.pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    return L > _CURVE_EPS ? { ux: (b.x - a.x) / L, uy: (b.y - a.y) / L } : { ux: 1, uy: 0 }; };
  let i = 0;
  while (i + 2 < n && s > g.L[i + 1]) i++;
  const d = 区間(i);
  // 曲がり角ちょうど（区間の継ぎ目）なら前後の平均にする
  if (i + 2 < n && Math.abs(s - g.L[i + 1]) < 1e-9) {
    const e = 区間(i + 1);
    const m = _curveNorm3(d.ux + e.ux, d.uy + e.uy, 0);
    return { ux: m.x, uy: m.y, i };
  }
  return { ux: d.ux, uy: d.uy, i };
}
function _curvePolyAt(p, t, c) {
  const mpp = _mwMpp();
  const g = _curvePolyGeom(p);
  const rise = p.rise || 0;
  if (!(g.total > 0) || g.pts.length < 2) {
    return { ox: c.cx, oy: c.cy, yaw: 0, dx: 0, dy: 0, dz: rise * t,
             t3: { x: 0, y: 0, z: 1 } };
  }
  const s = Math.max(0, Math.min(g.total, g.total * t));
  let i = 0; while (i + 2 < g.pts.length && s > g.L[i + 1]) i++;
  const a = g.pts[i], b = g.pts[i + 1];
  const seg長 = Math.max(_CURVE_EPS, g.L[i + 1] - g.L[i]);
  const u = (s - g.L[i]) / seg長;
  const x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u;
  const d = _curvePolyDir(g, s);
  const d0 = _curvePolyDir(g, 0);
  // 【点ごとの高さ・2026-10-06】通りの点が z を持っていれば、区間の両端を線形に結ぶ。
  //   持っていなければ従来どおり『全体を一定の勾配で上げる』（既存のデータを壊さない）。
  //   これで上下にうねるダクト・配管が出る。
  const 点に高さ = g.pts.some(q => Number.isFinite(q.z));
  const za = Number.isFinite(a.z) ? a.z : 0, zb = Number.isFinite(b.z) ? b.z : 0;
  const dz = 点に高さ ? (za + (zb - za) * u) : (rise * t);
  // 進む向きは**その区間の3次元の差分**。水平だけで出すと、うねった所で断面が立たない（Codex）
  const 区間dz = 点に高さ ? (zb - za) : (rise * (seg長 * mpp) / (g.total * mpp || 1));
  const t3 = 点に高さ
    ? _curveNorm3((b.x - a.x) * mpp, (b.y - a.y) * mpp, 区間dz)
    : _curveNorm3(d.ux * mpp, d.uy * mpp, rise / (g.total * mpp || 1) * mpp);
  return { ox: c.cx, oy: c.cy,
           yaw: Math.atan2(d.uy, d.ux) - Math.atan2(d0.uy, d0.ux),
           dx: x - g.pts[0].x, dy: y - g.pts[0].y, dz, t3 };
}

// 【表】増やすのは分岐ではなくこの行（Codex監査）
const BC_CURVES = {
  // 真上へ h[m]（＝従来の押し出しと同じ結果）
  line: { seg: 1, at: (p, t, c) => ({ ox: c.cx, oy: c.cy, yaw: 0, dx: 0, dy: 0,
      dz: (p.h || 0) * t, t3: { x: 0, y: 0, z: (p.h || 0) >= 0 ? 1 : -1 } }) },
  // 水平に dx,dy[グリッド] 進みながら rise[m] 上がる（斜路・片流れ）
  ramp: { seg: 1, at: (p, t, c) => ({ ox: c.cx, oy: c.cy, yaw: 0,
      dx: (p.dx || 0) * t, dy: (p.dy || 0) * t, dz: (p.rise || 0) * t,
      t3: _curveNorm3((p.dx || 0) * _mwMpp(), (p.dy || 0) * _mwMpp(), p.rise || 0) }) },
  // 中心(cx,cy)のまわりを sweepDeg 回りながら rise[m] 上がる（らせん）
  helix: { seg: 32, at: _curveHelixAt },
  // 水平に曲げる（曲がった廊下・曲がったラック）。式はらせんと同じで上がり0が既定
  arc: { seg: 24, at: _curveHelixAt },
  // 折れ線（ケーブルラック・配管の通り）
  poly: { seg: 1, samples: _curvePolySamples, at: _curvePolyAt },
};
function curveKindOf(path) {
  const k = (path && path.kind) || 'line';
  return BC_CURVES[k] ? k : 'line';
}
// 【ひねり（twist）・2026-10-06 Codex監査済み】
//   経路はそのままに、**断面だけ**を t に応じて回す＝ツイスト押し出し。
//   3DCADで「押し出しの矢印を引っ張りながらひねる」操作にあたる。
//   【なぜ経路の表に行を足さないか】twist は経路の種類ではなく『断面の姿勢の変化』。
//     行にすると twistedLine / twistedRamp / twistedPoly と増殖する（Codex）。
//     属性にしたので line・ramp・poly・helix すべてに同じ1つの規則で効く。
//   【helix との違い・これが紐か刃かの分かれ目】
//     helix … 断面を軸から**離して運ぶ**。軸は断面の外（バネ・スクリュー・らせん階段）
//     twist … 軸が断面の**中**にある（ドリルの刃・ねじれた柱・ねじ）
//     2026-10-06、ドリルに helix を使ったため『紐を巻いた形』になった。発生源はここ。
function curveAt(path, t, 断面の重心) {
  const a = BC_CURVES[curveKindOf(path)].at(path || {}, t, 断面の重心 || { cx: 0, cy: 0 });
  const tw = (path && Number.isFinite(path.twistDeg)) ? path.twistDeg : 0;
  if (!tw) return a;
  return Object.assign({}, a, { yaw: (a.yaw || 0) + tw * Math.PI / 180 * t });
}
function curveSamples(path, seg) {
  const d = BC_CURVES[curveKindOf(path)];
  let n = Math.max(1, Math.min(240, Math.round(seg || d.seg)));
  // 【ひねりの角度ぶんの段をここで確保する・2026-10-06】
  //   ひねりは段を刻まないと出ない（段が1つなら上下が平行なまま＝ただの柱）。
  //   make○○Sweep ごとに書いたら ramp と poly に漏れた（検査 T7 が 0.0°）。
  //   『同じ意味の判定を場所ごとに手書きしない』ので、経路の種類を問わずここ1か所で揃える
  const tw = (path && Number.isFinite(path.twistDeg)) ? Math.abs(path.twistDeg) : 0;
  if (tw > 0) n = Math.max(n, Math.min(240, Math.max(8, Math.round(tw / 7.5))));
  if (d.samples) return d.samples(path || {}, n);
  const out = []; for (let k = 0; k <= n; k++) out.push(k / n);
  return out;
}

// 断面の重心（回転・拡縮の基準。らせんだけは経路の中心を使うので curveAt が返す）
function _sectionCenter(np) {
  let cx = 0, cy = 0;
  (np || []).forEach(q => { cx += q.x; cy += q.y; });
  const n = (np && np.length) || 1;
  return { cx: cx / n, cy: cy / n };
}

// 断面の「どこを通りに合わせるか」・2026-10-27 ユーザー要望
//   「どこを基準にするかはその時々で変わる（下であっても下のどの場所を
//     沿わせ線とがっちするようにするかはその時次第）」
//   外枠の9点＋重心から選ぶ。名前で持つので、寸法を変えても同じ所に付いてくる。
//   'bottom'（下の中央）が既定＝従来と同じ結果（立体の最下点が下端Mに来る）。
const BC_ANCHORS = [
  ['bottomLeft', '左下'], ['bottom', '下の中央'], ['bottomRight', '右下'],
  ['left', '左の中央'], ['boxCenter', 'ど真ん中'], ['right', '右の中央'],
  ['topLeft', '左上'], ['top', '上の中央'], ['topRight', '右上'],
  ['center', '重心'],
];
function sectionAnchorPoint(pts, a) {
  const ps = (pts || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!ps.length) return { cx: 0, cy: 0 };
  let cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  ps.forEach(p => { cx += p.x; cy += p.y;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; });
  cx /= ps.length; cy /= ps.length;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  switch (a) {
    case 'center':      return { cx: cx, cy: cy };
    case 'boxCenter':   return { cx: mx, cy: my };
    case 'top':         return { cx: mx, cy: y1 };
    case 'left':        return { cx: x0, cy: my };
    case 'right':       return { cx: x1, cy: my };
    case 'bottomLeft':  return { cx: x0, cy: y0 };
    case 'bottomRight': return { cx: x1, cy: y0 };
    case 'topLeft':     return { cx: x0, cy: y1 };
    case 'topRight':    return { cx: x1, cy: y1 };
    default:            return { cx: mx, cy: y0 };   // 'bottom' 下の中央
  }
}
// この立体の「通りに乗っている点」。3つの呼び口が同じ値を見る（書き分けない）
function sweepAnchorOf(blk) {
  if (blk && blk._anchorPt && Number.isFinite(blk._anchorPt.cx))
    return { cx: blk._anchorPt.cx, cy: blk._anchorPt.cy };
  return _sectionCenter((blk && blk.points) || []);   // 旧データは重心
}

// 経路 → 各段の「断面の置き方」。
//   px,py,pz … 基準点の行き先（x,y はグリッド・z はメートル）
//   rx0,ry0  … 断面のどの点を基準にするか
//   a軸,b軸  … 断面の面内2軸（**メートル空間の単位ベクトル**）
// 【断面の向き sw.orient】
//   'flat'（既定）… 断面はXY平面に横たわったまま、水平に回るだけ。**従来と完全に同じ**
//   'frame'       … 断面を経路に**垂直に立てる**（配管・ケーブルラック・曲がった廊下）。
//                   これが無いと水平な経路では厚み0に潰れて使えない
// 段階フラグ __CURVE_UNIFIED=false で従来の3分岐（陽性対照）
function sweepFrames(sw, zB, 断面の重心) {
  // 【経路の始まりの高さ・2026-11-20 advisor監査】ふつうは zBottom が経路の始まり。
  //   面の反対側へ引き抜く（高さが負）と経路は下がるので、zBottom（＝立体の最も低い所）と
  //   始まりが別になる。そのときは掃引の記録 sw.startM が始まりを持つ（呼ぶ側3か所は zBottom を
  //   渡したままでよい＝ここ1か所で読む）。
  if (sw && Number.isFinite(sw.startM)) zB = sw.startM;
  const c0 = 断面の重心 || { cx: 0, cy: 0 };
  if (typeof window !== 'undefined' && window.__CURVE_UNIFIED === false)
    return _sweepFramesLegacy(sw, zB, c0);
  const p = (sw && sw.path) || {};
  const s0 = Number.isFinite(sw && sw.scale0) ? sw.scale0 : 1;
  const s1 = Number.isFinite(sw && sw.scale1) ? sw.scale1 : s0;
  const z0 = zB || 0;
  const 立てる = !!(sw && sw.orient === 'frame');
  // 【描いた面の向きを初期フレームにする・2026-10-25 advisor 監査】
  //   旧は t=0 の断面の向きを『進む向きの左（Z×T）』で**毎回勝手に**決めていた。
  //   ＝描いた面の向きが立体に伝わらず、通りの向き次第で 90° 回ったり鏡映したりする
  //   （ユーザー報告『平面をどう回転させてどう動かしたんだ？』）。
  //   呼ぶ側（沿わせるブロック）が、描いた作業平面の u を A0 として渡す。
  //   決まった断面（矩形・H形鋼…）は『幅×高さ』の定義なので渡さない＝従来のまま。
  //   【陽性対照】window.__SWEEP_FRAME0 = false で従来＝暗黙の向きに戻る
  const _初期A = (立てる && sw && sw.frame0 && sw.frame0.A
    && !(typeof window !== 'undefined' && window.__SWEEP_FRAME0 === false))
    ? sw.frame0.A : null;
  // 【退化の判定は面の法線で・2026-10-25 実測】
  //   『u を接線に垂直へ射影して長さが残るか』では足りない。平面図の枠（u=横／
  //   v=奥行き）は**水平面**なので、平面図で引いた通りは必ずその面の中を走るのに、
  //   u は接線に垂直な成分を持ってしまい退化と見なされない。
  //   その結果、従来と 180° 反対の向きになっていた（実測 A: (-0.55,0.83,0) → (0.55,-0.83,0)）。
  //   通りが断面の面の中にある＝面の法線 n と接線 T が垂直、で見る。
  const _初期N = (_初期A && sw.frame0 && sw.frame0.N) ? sw.frame0.N : null;
  const out = [];
  let 前A = _初期A;
  let _初回 = true;
  curveSamples(p, sw && sw.seg).forEach(t => {
    const a = curveAt(p, t, c0);
    const cs = Math.cos(a.yaw), sn = Math.sin(a.yaw);
    let 基x, 基y, ax, ay, az, bx, by, bz;
    if (立てる) {
      // 断面の重心を経路の点へ運び、面の2軸を進む向きから作る
      基x = c0.cx; 基y = c0.cy;
      const T = a.t3 || { x: 0, y: 0, z: 1 };
      let A = null;
      // 【前の向きを運ぶ（最小回転）・2026-10-25】初期フレームを渡されたときだけ。
      //   接線に垂直な成分だけ残す。断面が接線を含む（＝通りが断面の面の中にある
      //   退化した置き方）ときは成分が消えるので、下の従来の決め方へ落ちる。
      if (_初期A && 前A && _初回 && _初期N) {
        // 通りが断面の面の中を走る（n ⊥ T）なら、描いた向きでは断面を決められない。
        //   そのときは下の従来の決め方（進む向きの左／上）へ落とす
        const nd = Math.abs(_初期N.x * T.x + _初期N.y * T.y + _初期N.z * T.z);
        if (nd < 0.08) 前A = null;
      }
      _初回 = false;
      if (_初期A && 前A) {
        const d = 前A.x * T.x + 前A.y * T.y + 前A.z * T.z;
        const px = 前A.x - T.x * d, py = 前A.y - T.y * d, pz = 前A.z - T.z * d;
        if (Math.hypot(px, py, pz) > 1e-6) A = _curveNorm3(px, py, pz);
      }
      if (!A) {
        if (Math.hypot(T.x, T.y) < 1e-9) A = 前A || { x: 1, y: 0, z: 0 }; // 真上：前の向きを継ぐ
        else A = _curveNorm3(-T.y, T.x, 0);                               // Z×T（進む向きの左）
      }
      // ひっくり返りを防ぐ（Codex指摘：符号が反転すると断面が裏返る）
      if (前A && (A.x * 前A.x + A.y * 前A.y + A.z * 前A.z) < 0) A = { x: -A.x, y: -A.y, z: -A.z };
      前A = A;
      let B = _curveNorm3(T.y * A.z - T.z * A.y, T.z * A.x - T.x * A.z, T.x * A.y - T.y * A.x);
      // 【断面の縦は上を向かせる・2026-10-26 ユーザー報告】
      //   「なんで1234がこの順番になるように面を立てたの？」
      //   B = T×A は接線の**符号**で向きが変わるので、同じ面でも通りの行き先を逆にすると
      //   上下が入れ替わっていた（実測：通り +Y では描いた点1が上、-Y では下）。
      //   下を向いたら A と B を**両方**ひっくり返す＝断面を 180° 回す。
      //   片方だけ反転させると鏡映（裏返し）になるので必ず両方。
      //   真上へ進む通り（B がほぼ水平）は上下が決められないので触らない。
      //   【陽性対照】window.__SECTION_UP = false で従来＝通りの向きで上下が反転
      if (B.z < -1e-6
          && !(typeof window !== 'undefined' && window.__SECTION_UP === false)) {
        A = { x: -A.x, y: -A.y, z: -A.z };
        B = { x: -B.x, y: -B.y, z: -B.z };
        前A = A;
      }
      // 【断面を道のまわりに回す・2026-10-26 ユーザー要望】
      //   「その向きとか決められるようにしないとダメじゃないの？」
      //   運ぶ向き（前A）は回す**前**のものを保つ。回した後を運ぶと段ごとに重なって捩れる。
      const _roll = (sw && Number.isFinite(+sw.roll)) ? +sw.roll : 0;
      if (_roll) {
        const _r = _roll * Math.PI / 180, _c = Math.cos(_r), _s = Math.sin(_r);
        const A2 = { x: A.x * _c + B.x * _s, y: A.y * _c + B.y * _s, z: A.z * _c + B.z * _s };
        const B2 = { x: -A.x * _s + B.x * _c, y: -A.y * _s + B.y * _c, z: -A.z * _s + B.z * _c };
        A = A2; B = B2;
      }
      ax = A.x; ay = A.y; az = A.z; bx = B.x; by = B.y; bz = B.z;
    } else {
      基x = a.ox; 基y = a.oy;
      ax = cs; ay = sn; az = 0; bx = -sn; by = cs; bz = 0;
    }
    const rx = 基x - a.ox, ry = 基y - a.oy;
    out.push({ t, sc: s0 + (s1 - s0) * t,
               px: a.ox + rx * cs - ry * sn + a.dx,
               py: a.oy + rx * sn + ry * cs + a.dy,
               pz: z0 + a.dz,
               rx0: 基x, ry0: 基y, ax, ay, az, bx, by, bz });
  });
  return out;
}

// 【陽性対照専用】従来の3分岐＋回転中心の分岐。__CURVE_UNIFIED=false のときだけ通る。
//   返す形は新しい版と同じにしてあるので、検査が頂点をそのまま突き合わせられる
function _sweepFramesLegacy(sw, zB, c0) {
  const p = (sw && sw.path) || {};
  const kind = p.kind || 'line';
  const 既定段 = (kind === 'helix') ? 32 : 1;
  const seg = Math.max(1, Math.min(240, Math.round(sw && sw.seg ? sw.seg : 既定段)));
  const s0 = Number.isFinite(sw && sw.scale0) ? sw.scale0 : 1;
  const s1 = Number.isFinite(sw && sw.scale1) ? sw.scale1 : s0;
  const z0 = zB || 0;
  const ox = (kind === 'helix') ? (p.cx || 0) : c0.cx;
  const oy = (kind === 'helix') ? (p.cy || 0) : c0.cy;
  const out = [];
  for (let k = 0; k <= seg; k++) {
    const t = k / seg;
    const sc = s0 + (s1 - s0) * t;
    let rot = 0, dx = 0, dy = 0, z;
    if (kind === 'helix') {
      rot = (p.sweepDeg != null ? p.sweepDeg : 360) * Math.PI / 180 * t;
      z = z0 + (p.rise || 0) * t;
    } else if (kind === 'ramp') {
      dx = (p.dx || 0) * t; dy = (p.dy || 0) * t; z = z0 + (p.rise || 0) * t;
    } else {
      z = z0 + (p.h || 0) * t;
    }
    const cs = Math.cos(rot), sn = Math.sin(rot);
    out.push({ t, sc, px: ox + dx, py: oy + dy, pz: z, rx0: ox, ry0: oy,
               ax: cs, ay: sn, az: 0, bx: -sn, by: cs, bz: 0 });
  }
  return out;
}

// 断面の1点を、その段の置き方で動かす。**式はこれ1本**（横たえる／立てるの分岐は持たない）
function _sweepPt(pt, fr) {
  const mpp = _mwMpp();
  const a = (pt.x - fr.rx0) * fr.sc, b = (pt.y - fr.ry0) * fr.sc;   // グリッド
  return { x: fr.px + a * fr.ax + b * fr.bx,
           y: fr.py + a * fr.ay + b * fr.by,
           z: fr.pz + (a * fr.az + b * fr.bz) * mpp };
}

// 沿わせた形の、経路上の位置 t（0〜1）での**断面の3D点列**。
//   【下見は本物の描き手を呼ぶ・2026-10-25】ユーザー報告
//   「xy平面上に作った四角形をどう立てて沿わせてるのかわからんだろ」。
//   上から描いた形は 90° 起きて断面になるが、その回転が画面に出ていなかった。
//   下見用に別の式を書くと『見えている姿と出来る形が食い違う』ので、
//   立体を作るのと同じ sweepFrames / _sweepPt をそのまま通す。
function sweptSectionAt(blk, t) {
  const pts = ((blk && blk.points) || []).filter(p => p && p.x != null && p.y != null);
  if (pts.length < 3 || !blk.sweep) return null;
  const fr = sweepFrames(blk.sweep, blk.zBottom || 0, sweepAnchorOf(blk));
  if (!fr || !fr.length) return null;
  const i = Math.max(0, Math.min(fr.length - 1,
    Math.round((Number.isFinite(t) ? t : 0) * (fr.length - 1))));
  return pts.map(p => _sweepPt(p, fr[i]));   // x,y はグリッド／z はメートル
}

// 掃引した形の「天井の高さ」。zTop を記録に持たせるとき、作る側がこれで揃える
function sweepTopZ(blk) {
  const fr = sweepFrames(blk && blk.sweep, (blk && blk.zBottom) || 0,
                         sweepAnchorOf(blk));
  return fr[fr.length - 1].pz;
}

// 断面 × 経路 → 立体（面の集合）。blockToSolid と同じ形のものを返す
function sweepToSolid(bld, blk, bi) {
  const pts = (blk && blk.points || []).filter(p => p && p.x != null && p.y != null);
  if (pts.length < 3) return null;
  // CCW 正規化（押し出しと同じ作法。これを揃えないと法線の向きが逆になる）
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  const np = area >= 0 ? pts : [...pts].reverse();
  const n = np.length;
  const zB = blk.zBottom || 0;
  const sw = blk.sweep || {};
  const c0 = sweepAnchorOf(blk);   // 通りに乗っている点（基準点）
  const frames = sweepFrames(sw, zB, c0);
  const rings = frames.map(fr => np.map(p => _sweepPt(p, fr)));
  // 【向きはメートル空間で出す】x,y はグリッド・z はメートルの混在空間なので、
  //   そのまま外積を取ると高さだけ 1/mpp 倍に潰れる（2026-10-03 に屋根の法線で踏んだ罠）。
  //   立てた断面では面が傾くので、ここを間違えると陰影も押し引きの向きも嘘になる
  const _mp = _mwMpp();
  const _法線 = (vs) => _computeNormal(vs.map(v => ({ x: v.x * _mp, y: v.y * _mp, z: v.z })));
  // 水平なリングは従来どおり真上／真下に固定する（丸めで 1e-16 の傾きが出ないように）
  const _水平 = (ring) => {
    let lo = Infinity, hi = -Infinity;
    ring.forEach(v => { if (v.z < lo) lo = v.z; if (v.z > hi) hi = v.z; });
    return (hi - lo) < 1e-12;
  };
  const _sid = String(bld.id) + '_' + bi;
  const faces = [];
  // 下面（逆順＝法線 -Z）
  const _下 = rings[0].map(v => ({ x: v.x, y: v.y, z: v.z })).reverse();
  faces.push({ id: _faceIdOf(_sid, 'bottom'), type: 'bottom',
    vertices: _下,
    normal: _水平(rings[0]) ? { nx: 0, ny: 0, nz: -1 } : _法線(_下) });
  // 上面
  const 最後 = rings[rings.length - 1];
  const _上 = 最後.map(v => ({ x: v.x, y: v.y, z: v.z }));
  faces.push({ id: _faceIdOf(_sid, 'top'), type: 'top',
    vertices: _上,
    normal: _水平(最後) ? { nx: 0, ny: 0, nz: 1 } : _法線(_上) });
  // 側面：断面の辺 i × 経路の段 k（四角形）。辺の番号は段の数を変えても変わらない
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k + 1 < rings.length; k++) {
      const vs = [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]]
        .map(v => ({ x: v.x, y: v.y, z: v.z }));
      faces.push({ id: _faceIdOf(_sid, 'wall', i, { seg: k }), type: 'wall',
        vertices: vs, normal: _法線(vs), _edgeIdx: i, _segIdx: k });
    }
  }
  // 【経路が逆向きなら面を裏返す・2026-11-20 advisor監査】
  //   上の組み立ては「経路が断面の表側（CCW の法線の向き）へ進む」前提で頂点の順を決めている。
  //   経路が逆へ進む（引き抜く高さが負・らせんの上がりが負）と立体が鏡映になり、全部の面が内向きになる。
  //   _normalizeOutward（重心から離れる向き）は掃引では使えない（上のコメント）ので、
  //   **符号付き体積**（閉じた面の集まりの発散定理・メートル空間）で判定し、負なら全面の頂点順を反す。
  //   種類で分けない一般則。面の id は変えない。体積がほぼ0（潰れた形）なら何もしない（fail-closed）。
  //   【陽性対照】window.__SWEEP_FIX_INVERTED = false で従来（裏返ったまま）。
  if (!(typeof window !== 'undefined' && window.__SWEEP_FIX_INVERTED === false)) {
    let V = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const f of faces) {
      const vs = f.vertices.map(v => ({ x: v.x * _mp, y: v.y * _mp, z: v.z }));
      for (const v of vs) { if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x; if (v.y < y0) y0 = v.y;
        if (v.y > y1) y1 = v.y; if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z; }
      for (let i = 1; i + 1 < vs.length; i++) {
        const a = vs[0], b = vs[i], c = vs[i + 1];
        V += (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
      }
    }
    const 箱 = (x1 - x0) * (y1 - y0) * (z1 - z0);
    if (Number.isFinite(V) && 箱 > 0 && V < -1e-6 * 箱) {
      for (const f of faces) {
        f.vertices = f.vertices.slice().reverse();
        const n0 = f.normal || {};
        f.normal = { nx: -(n0.nx || 0), ny: -(n0.ny || 0), nz: -(n0.nz || 0) };
      }
    }
  }
  return {
    id: _sid,
    buildingId: bld.id, blockIdx: bi, label: bld.label,
    color: bld.color || '#6B7A8D',
    faces,
    _normPts: np,
    _sweep: sw,            // 形を直すときはこの値を変える（面を押し引きしない）
  };
}

// らせんの掃引を作る。半径は断面（points）が持つので、ここは中心・回る角度・上がりだけ
// r1 ＝ 終わりの半径が始めの何倍か（省略＝1＝一定）。ドリルの先端・円錐バネ・渦巻き
function makeHelixSweep(cx, cy, sweepDeg, riseM, seg, r1) {
  return { path: { kind: 'helix', cx, cy, sweepDeg: sweepDeg, rise: riseM,
                   ...(Number.isFinite(r1) ? { r1 } : {}) },
           seg: seg || Math.max(8, Math.min(240, Math.round(Math.abs(sweepDeg) / 7.5))) };
}
// 斜路（水平に dx,dy[グリッド] 進みながら rise[m] 上がる）
function makeRampSweep(dxGrid, dyGrid, riseM) {
  return { path: { kind: 'ramp', dx: dxGrid, dy: dyGrid, rise: riseM }, seg: 1 };
}
// 真上への掃引（＝従来の押し出しと同じ。経路を差し替える入口を1つにするため）
// twistDeg ＝ 上がりきるまでに断面を何度ひねるか（ドリルの刃・ねじれた柱）・2026-10-06
//   段の刻みは curveSamples が角度から決めるので、ここでは指定しない（二重に書かない）
function makeLineSweep(hM, twistDeg, seg) {
  const tw = Number.isFinite(twistDeg) ? twistDeg : 0;
  return { path: Object.assign({ kind: 'line', h: hM }, tw ? { twistDeg: tw } : {}),
           seg: seg || 1 };
}
// 【円を何度ごとに割るか・1か所・2026-10-18 advisor 監査】
//   回す＝11.25°(32分割)／沿わせる＝7.5°(48分割)／CSG＝48 と**3か所**にあり、
//   同じ『回す』なのに食い違っていた（ユーザー報告「円に見せかけた面の並びになる」）。
//   7.5°（1周48）に揃える。細かくするほど滑らかで重い。
const BC_SEG_DEG = 7.5;
// 水平に曲げる（曲がった廊下・曲がったラック）。らせんと同じ式で上がり0が既定・2026-10-04
function makeArcSweep(cx, cy, sweepDeg, riseM, seg) {
  return { path: { kind: 'arc', cx, cy, sweepDeg, rise: riseM || 0 },
           seg: seg || Math.max(6, Math.min(240, Math.round(Math.abs(sweepDeg) / BC_SEG_DEG))) };
}
// 折れ線（ケーブルラック・配管の通り）。pts はグリッドの通過点・2026-10-04
// 点に z があれば『その点の高さ』として使う（無ければ rise の一定勾配）・2026-10-06
function makePolySweep(pts, riseM, seg) {
  return { path: { kind: 'poly',
                   pts: (pts || []).map(p => (Number.isFinite(p.z)
                     ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y })),
                   rise: riseM || 0 },
           seg: seg || 1 };
}
// 断面を経路に**垂直に立てる**。これが無いと水平な経路では厚み0に潰れる・2026-10-04
// 【なぜ掃引の属性にするか】「曲がった廊下」「ケーブルラック」「配管」をそれぞれの形として
//   作らない。断面 × 経路 × 向き の組み合わせで出す（Codex監査・ユーザー指摘への答え）
function withUprightSection(sw, frame0, roll) {
  return Object.assign({}, sw, { orient: 'frame' },
    frame0 ? { frame0: frame0 } : null,
    (Number.isFinite(+roll) && +roll) ? { roll: +roll } : null);
}

// ════════════════════════════════════════════════════════════════
// 断面（Profile）・2026-10-04 Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【なぜ表にするか】「H形鋼を描く機能」「配管を描く機能」を1つずつ足さない。
//   断面は**原点を芯にした点列**を返すだけ。経路と向きは別の軸なので、
//   断面 × 経路 × 向き の掛け算で形が出る（＝形ごとの機能を作らない）。
//   任意の形は points をそのまま渡せばよく、この表は「よく使う断面の近道」でしかない。
// 【寸法はメートルで受ける】利用者が打つ数字と同じ単位。中でグリッドに直す。
// 【点列の約束】x は芯を 0 にして左右対称、y は**一番下が 0**（下端を合わせやすくするため）。
//   実際に経路へ乗るのは「断面の重心」なので、下端を合わせる計算は makeSweptBlock が持つ。
//   （Codex: 芯を重心にするか見た目の中心にするかは将来 anchor で選べる形にしておく）
const BC_PROFILES = {
  rect: { 名: '矩形', 要る: ['wM', 'hM'],
    makePoints: (o) => { const g = 1 / _mwMpp();
      const w = (o.wM || 1) * g / 2, h = (o.hM || 1) * g;
      return [{ x: -w, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: -w, y: h }]; } },
  circle: { 名: '円（配管・丸ダクト）', 要る: ['wM'],
    makePoints: (o) => { const g = 1 / _mwMpp();
      const r = (o.wM || 1) * g / 2, n = Math.max(8, Math.min(96, Math.round(o.seg || 24)));
      const out = [];
      for (let i = 0; i < n; i++) { const a = Math.PI * 2 * i / n;
        out.push({ x: r * Math.cos(a), y: r + r * Math.sin(a) }); }
      return out; } },
  hbeam: { 名: 'H形鋼・溝形', 要る: ['wM', 'hM', 'tM'],
    makePoints: (o) => { const g = 1 / _mwMpp();
      const w = (o.wM || 0.2) * g / 2, h = (o.hM || 0.4) * g;
      const t = Math.min((o.tM || 0.012) * g, w * 0.8, h * 0.4);   // 板厚（はみ出さないよう抑える）
      return [{ x: -w, y: 0 }, { x: w, y: 0 }, { x: w, y: t }, { x: t, y: t },
              { x: t, y: h - t }, { x: w, y: h - t }, { x: w, y: h }, { x: -w, y: h },
              { x: -w, y: h - t }, { x: -t, y: h - t }, { x: -t, y: t }, { x: -w, y: t }]; } },
  // 【2026-10-04】回転体のために足した2行。どちらも**左右対称のまま**（§3.4 の約束を守る）。
  //   回すときは makeRevolveBlock が左半分だけを取る。
  //   同じ断面を水平に掃引すれば かまぼこ屋根／横置きタンク になる（1行で2つの形が出る）
  dome: { 名: '半楕円（ドーム・かまぼこ屋根）', 要る: ['wM', 'hM'],
    makePoints: (o) => { const g = 1 / _mwMpp();
      const R = (o.wM || 6) * g / 2, H = (o.hM || 3) * g;
      const n = Math.max(4, Math.min(48, Math.round(o.seg || 12)));
      const p = [{ x: -R, y: 0 }, { x: R, y: 0 }];
      for (let i = n - 1; i >= 1; i--) { const a = Math.PI * i / n;
        p.push({ x: R * Math.cos(a), y: H * Math.sin(a) }); }
      return p; } },
  capsule: { 名: '胴＋丸み（タンク・ボンベ）', 要る: ['wM', 'hM', 'tM'],
    makePoints: (o) => { const g = 1 / _mwMpp();
      const R = (o.wM || 3) * g / 2, Hc = (o.hM || 6) * g;
      const Hd = Math.max(0, (o.tM != null ? o.tM : (o.wM || 3) / 4) * g);  // 鏡板の高さ
      const n = Math.max(3, Math.min(32, Math.round(o.seg || 8)));
      const p = [];
      // 下の鏡板（左→右）・胴・上の鏡板（右→左）。y の一番下を 0 にする
      for (let i = n; i >= 0; i--) { const a = Math.PI * i / n;
        p.push({ x: R * Math.cos(a), y: Hd - Hd * Math.sin(a) }); }
      p.push({ x: R, y: Hd + Hc });
      for (let i = 0; i <= n; i++) { const a = Math.PI * i / n;
        p.push({ x: R * Math.cos(a), y: Hd + Hc + Hd * Math.sin(a) }); }
      p.push({ x: -R, y: Hd });
      return p; } },
  tri: { 名: '三角（切妻屋根）', 要る: ['wM', 'hM'],
    makePoints: (o) => { const g = 1 / _mwMpp();
      const w = (o.wM || 6) * g / 2, h = (o.hM || 2) * g;
      return [{ x: -w, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }]; } },
};
function profileKindOf(pf) {
  const k = (pf && pf.kind) || 'rect';
  return BC_PROFILES[k] ? k : 'rect';
}
// ════════════════════════════════════════════════════════════════
// スケッチの円弧・段1-b・2026-11-21 advisor監査
// ════════════════════════════════════════════════════════════════
// 【記録】輪郭の頂点に任意の膨らみ b（その頂点から次の頂点までの区間）。DXF の bulge と同じ tan(中心角/4)。
//   正＝面の座標で u→v 回り（反時計回り）に進む円弧。閉じる区間（最後の頂点→始点）の膨らみは最後の頂点が持つ。
// 【展開は1か所】ここの sketchExpand。刻みは BC_SEG_DEG で、刻み数は中心角だけで決まる（最小2＝7.5° 未満の円弧が
//   直線1本に化けない）。描いた輪郭は App の1か所で先に展開してから回す・引き抜くへ渡す
//   （回す側らは点を鏡映し、軸をまたぐと切るので、膨らみを持ち込むと符号が反り区間が割れる）。
//   profilePoints は膨らみを展開しない（展開口を2つにしない）。
const BC_SKETCH_ARC_MAX_DEG = 350;   // 接線円弧で行き先が真後ろに近いと膨らみが発散する。これを超えたら作らない
function _sketchArc(P, Q, b) {
  if (!P || !Q || !Number.isFinite(b) || Math.abs(b) < 1e-9) return null;
  const dx = Q.x - P.x, dy = Q.y - P.y, c = Math.hypot(dx, dy);
  if (!(c > 1e-9)) return null;
  const th = 4 * Math.atan(b);
  const h = (c / 2) / Math.tan(th / 2);                // 弦の中点から中心まで（左の法線向き）
  const cx = (P.x + Q.x) / 2 - dy / c * h, cy = (P.y + Q.y) / 2 + dx / c * h;
  const n = Math.max(2, Math.ceil(Math.abs(th) * 180 / Math.PI / BC_SEG_DEG - 1e-9));
  return { cx, cy, r: Math.hypot(P.x - cx, P.y - cy), a0: Math.atan2(P.y - cy, P.x - cx), th, n };
}
// 展開。点ら＝展開した点、頂点の位置＝原本の i 番目の頂点が展開後の何番目か（番号・面の対応に使う）
function sketchExpandWithIndex(pts, opts) {
  const src = (pts || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const closed = !!(opts && opts.closed);
  const 点ら = [], 頂点の位置 = [];
  for (let i = 0; i < src.length; i++) {
    const P = src[i];
    頂点の位置.push(点ら.length);
    点ら.push({ x: P.x, y: P.y });
    const 次 = (i + 1 < src.length) ? src[i + 1] : (closed && src.length >= 2 ? src[0] : null);
    const a = 次 ? _sketchArc(P, 次, P.b) : null;
    if (!a) continue;
    for (let k = 1; k < a.n; k++) {
      const t = a.a0 + a.th * k / a.n;
      点ら.push({ x: a.cx + a.r * Math.cos(t), y: a.cy + a.r * Math.sin(t) });
    }
  }
  return { 点ら, 頂点の位置 };
}
function sketchExpand(pts, opts) { return sketchExpandWithIndex(pts, opts).点ら; }
// 3点（始点・通る点・終点）→ 膨らみ。一直線なら 0、弦がほぼ 0 なら null（作らない）
function sketchBulgeFrom3(P, M, Q) {
  if (!P || !M || !Q) return null;
  if (!(Math.hypot(Q.x - P.x, Q.y - P.y) > 1e-9)) return null;
  const ax = P.x, ay = P.y, bx = M.x, by = M.y, qx = Q.x, qy = Q.y;
  const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
  const 尺 = Math.max(1, Math.hypot(qx - ax, qy - ay) ** 2);
  if (Math.abs(d) < 1e-9 * 尺) return 0;               // 一直線
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, q2 = qx * qx + qy * qy;
  const cx = (a2 * (by - qy) + b2 * (qy - ay) + q2 * (ay - by)) / d;
  const cy = (a2 * (qx - bx) + b2 * (ax - qx) + q2 * (bx - ax)) / d;
  const 角 = (x, y) => Math.atan2(y - cy, x - cx);
  const 正 = (v) => { const T = 2 * Math.PI; return ((v % T) + T) % T; };
  const aP = 角(ax, ay), s = 正(角(qx, qy) - aP), m = 正(角(bx, by) - aP);
  const th = (m < s) ? s : s - 2 * Math.PI;           // 通る点を含む回りを選ぶ
  if (Math.abs(th) * 180 / Math.PI > BC_SKETCH_ARC_MAX_DEG) return null;
  return Math.tan(th / 4);
}
// 前の区間の終わりの向き t（単位ベクトル）に接して P から Q へ行く円弧の膨らみ。行けなければ null
function sketchBulgeTangent(t, P, Q) {
  if (!t || !P || !Q) return null;
  const dx = Q.x - P.x, dy = Q.y - P.y;
  if (!(Math.hypot(dx, dy) > 1e-9)) return null;
  const 外 = t.x * dy - t.y * dx, 内 = t.x * dx + t.y * dy;
  if (Math.abs(外) < 1e-12 * Math.hypot(dx, dy) && 内 > 0) return 0;   // まっすぐ前＝直線
  const th = 2 * Math.atan2(外, 内);
  if (Math.abs(th) * 180 / Math.PI > BC_SKETCH_ARC_MAX_DEG) return null;
  return Math.tan(th / 4);
}
// P→Q（膨らみ b）の区間の終点での進む向き（単位ベクトル）
function sketchEndTangent(P, Q, b) {
  if (!P || !Q) return null;
  const dx = Q.x - P.x, dy = Q.y - P.y, c = Math.hypot(dx, dy);
  if (!(c > 1e-9)) return null;
  const h = (Number.isFinite(b) && Math.abs(b) >= 1e-9) ? 2 * Math.atan(b) : 0;   // 中心角の半分
  const cs = Math.cos(h), sn = Math.sin(h);
  return { x: (dx * cs - dy * sn) / c, y: (dx * sn + dy * cs) / c };
}

// 断面の点列（グリッド）。x の芯 0・y の一番下 0
function profilePoints(pf) {
  // 【任意の輪郭（スケッチ）・2026-10-06 ユーザー裁定】
  //   『平面作図 → もう1軸について引き抜き』が3DCADの主手順。平面に描いた点列を
  //   **そのまま断面として**渡す入口。表（BC_PROFILES）に行は足さない＝形の種類ではなく、
  //   『決まった形を作る代わりに、もらった点列を使う』だけ。
  //   これが無いと、断面がプルダウンの6種に決め打ちになり汎用操作にならない。
  if (pf && pf.kind === 'raw' && Array.isArray(pf.pts) && pf.pts.length >= 3)
    return pf.pts.map(p => ({ x: p.x, y: p.y }));
  return BC_PROFILES[profileKindOf(pf)].makePoints(pf || {});
}

// ════════════════════════════════════════════════════════════════
// 回す（回転体）・2026-10-04 Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【新しい経路の種類を足さない】回転体＝「断面を水平に 360° 回す」＝
//   arc 経路（上がり0）× 断面を立てる。既にある2つの組み合わせで出る。
//   `revolve` という kind を作ると、同じことを2通りで書くことになる（Codex同意）。
// 【なぜ断面の半分だけ使うか】BC_PROFILES の断面は x の芯が 0 で左右対称（§3.4）。
//   回すのに要るのは軸の片側だけ。両側あると裏返った面が内側に残る。
// 【なぜ左半分か】断面を立てたときの横軸 A は unit(Z × T)（T＝接線）＝**径方向の内向き**。
//   つまり断面の**右端が軸に集まる**。左半分を取れば x=0（芯）が軸、x=-R が外周になる。
//   実測: 右半分を取ると裏返って内径が膨らんだ（x が ±58 に広がる・直径100のはずが116）。

// 軸をまたぐ断面 → 外形（ガワ）だけの片側断面・2026-10-19 ユーザー裁定
//   「重なりはガワだけができればいいんじゃないの？内部構造として存在する必要はない。」
//
// 【なぜ要るか】軸が輪郭の中を通るとき、左右を別々の立体にすると 180°を超えて回した時に
//   同じ体積を2回描く（重なって色が濃くなる）。外形だけでよいなら1つの断面にまとめられる。
//
// 【やり方】軸方向の各高さ h について、輪郭の境界上で**軸からいちばん遠い所**を拾う。
//   h の候補は「頂点の高さ」と「辺が軸(x=0)を横切る高さ」（そこで |x| が折れるため）。
//   返すのは x ≤ 0 側の多角形（makeRevolveBlock が左半分を切る約束に合わせる）。
//
// 【頂点だけ絶対値を取ってはいけない】対称な断面（四角の真ん中に軸＝円筒を作るいちばん
//   普通の操作）だと、畳んだ点が重なって 2点になり、何も作れない（2026-10-18 実測）。
//
// 【代償】軸に向いた凹み・溝・穴は埋まる。裁定どおり「内部構造は要らない」ので許容する。
function sectionEnvelopeLeft(rel) {
  if (!Array.isArray(rel) || rel.length < 3) return [];
  const 高さら = [];
  const 足す = (v) => { if (Number.isFinite(v)) 高さら.push(v); };
  for (const p of rel) 足す(p.y);
  for (let i = 0; i < rel.length; i++) {
    const a = rel[i], b = rel[(i + 1) % rel.length];
    // 辺が軸をまたぐ所。そこが |x| の折れ点なので高さの候補に入れる
    if ((a.x < 0) !== (b.x < 0) && Math.abs(b.x - a.x) > 1e-12) {
      足す(a.y + (b.y - a.y) * ((0 - a.x) / (b.x - a.x)));
    }
  }
  高さら.sort((p, q) => p - q);
  // 同じ高さをまとめる（頂点が重なっている所）
  const 列 = [];
  for (const h of 高さら) if (!列.length || Math.abs(h - 列[列.length - 1]) > 1e-9) 列.push(h);
  if (列.length < 2) return [];
  // 水平線 y=h での「軸からいちばん遠い所」。h は区間の内部に取るので交点だけで足りる
  const 半径 = (h) => {
    let r = -Infinity;
    for (let i = 0; i < rel.length; i++) {
      const a = rel[i], b = rel[(i + 1) % rel.length];
      if ((a.y <= h && b.y > h) || (b.y <= h && a.y > h)) {
        const t = (h - a.y) / (b.y - a.y);
        const x = a.x + (b.x - a.x) * t;
        if (Math.abs(x) > r) r = Math.abs(x);
      }
    }
    return r;
  };
  // 【区間ごとに両端で測る・2026-10-19 実測】高さの候補ごとに1点だけ出すと、
  //   段差（同じ高さで半径が変わる所）で上下の値が1つにまとまり**斜めに削れる**。
  //   区間の内部では輪郭の辺が直線なので、区間の端ぎりぎりで測れば極限として正しい。
  const 外 = [];
  const 点を足す = (x, y) => {
    const 前 = 外[外.length - 1];
    if (前 && Math.abs(前.x - x) < 1e-9 && Math.abs(前.y - y) < 1e-9) return;
    外.push({ x: x, y: y });
  };
  for (let i = 0; i < 列.length - 1; i++) {
    const y0 = 列[i], y1 = 列[i + 1];
    const e = Math.max(1e-9, (y1 - y0) * 1e-6);
    const r0 = 半径(y0 + e), r1 = 半径(y1 - e);
    if (!(r0 > -Infinity) || !(r1 > -Infinity)) continue;
    点を足す(-r0, y0);
    点を足す(-r1, y1);
  }
  if (外.length < 2) return [];
  // 外側の線（下から上へ）を引いたら、軸の上（x=0）を通って下へ戻って閉じる
  const 下 = 外[0].y, 上 = 外[外.length - 1].y;
  return 外.concat([{ x: 0, y: 上 }, { x: 0, y: 下 }]);
}
// 多角形を直線 x = x0 の左側で切る（Sutherland–Hodgman の半平面1枚ぶん）
function clipSectionLeft(pts, x0) {
  const out = [];
  if (!Array.isArray(pts) || pts.length < 3) return out;
  const 内 = (p) => p.x <= x0 + 1e-9;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ia = 内(a), ib = 内(b);
    if (ia) out.push({ x: a.x, y: a.y });
    if (ia !== ib && Math.abs(b.x - a.x) > 1e-12) {
      const t = (x0 - a.x) / (b.x - a.x);
      out.push({ x: x0, y: a.y + (b.y - a.y) * t });
    }
  }
  // 同じ点が続いたら1つにまとめる（軸の上に点が重なる）
  const q = [];
  out.forEach(p => { const r = q[q.length - 1];
    if (r && Math.abs(r.x - p.x) < 1e-9 && Math.abs(r.y - p.y) < 1e-9) return; q.push(p); });
  while (q.length >= 2 && Math.abs(q[0].x - q[q.length - 1].x) < 1e-9
         && Math.abs(q[0].y - q[q.length - 1].y) < 1e-9) q.pop();
  return q;
}

// 回転体のブロックを1つ作る。断面は BC_PROFILES の記録でも、点列でもよい。
//   opts.sweepDeg  回す角度（既定 360。180 なら半分だけ＝切った見せ方）
//   opts.seg       経路の分割（既定 32。Codex助言で控えめ。上げるほど滑らかで重い）
//   opts.at        軸を置くグリッド座標 {x,y}（既定は原点）
//   opts.half=false で切らずにそのまま回す（検査・特殊用途）
function makeRevolveBlock(断面, 下端M, opts) {
  const o = opts || {};
  const src = Array.isArray(断面) ? 断面 : profilePoints(断面);
  const pts = (o.half === false) ? src : clipSectionLeft(src, 0);
  if (!pts || pts.length < 3) return null;
  const c = _sectionCenter(pts);
  let xMax = -Infinity, lo = Infinity, hi = -Infinity;
  pts.forEach(p => { if (p.x > xMax) xMax = p.x;
                     if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; });
  const mpp = _mwMpp();
  const deg = (o.sweepDeg != null) ? o.sweepDeg : 360;
  // 【分割は BC_SEG_DEG に揃える・2026-10-18】旧 11.25°（1周32）。沿わせる(arc)は 7.5° で、
  //   同じ『回す』なのに粗かった。上限も 96 → 240 へ（arc と同じ）
  const seg = o.seg || Math.max(8, Math.min(240, Math.round(Math.abs(deg) / BC_SEG_DEG)));
  // 経路に乗るのは断面の重心なので、下端を合わせるぶんだけ経路を持ち上げる
  const zB = (下端M || 0) + (c.cy - lo) * mpp;
  // 【軸と断面は同じ平面にある】断面を動かしたら軸も同じだけ動かす。
  //   片方だけ動かすと半径が変わって形が崩れる
  const atX = (opts && opts.at && +opts.at.x) || 0;
  const atY = (opts && opts.at && +opts.at.y) || 0;
  const out = {
    points: pts.map(p => ({ x: p.x + atX, y: p.y + atY })),
    zBottom: zB, zTop: zB + (hi - lo) * mpp,
    // 【円弧の中心＝回す軸・2026-10-14 ユーザー裁定で軸をユーザーが決めるようになった】
    //   旧: xMax + atX（＝断面の右端）。断面の右端が軸であるという前提の式で、
    //   軸を断面から離して置くと半径が変わらなかった（実測: 軸を動かしても直径が同じ）。
    //   断面は at を原点とする相対座標で渡されるので、軸はいつも at そのもの。
    sweep: withUprightSection(makeArcSweep(atX, c.cy + atY, deg, 0, seg)),
    _profile: Array.isArray(断面) ? { kind: 'custom' } : Object.assign({}, 断面),
    _revolve: true,
    // 入力（打った値）。結果の zBottom / points からは戻せないので残す
    _baseM: 下端M || 0, _at: { x: atX, y: atY }, _sweepDeg: deg, _seg: seg,
  };
  // 【倒すなら、倒すのに要る値もここで付ける・2026-10-15】
  //   回転中心の y は内部の都合（断面の重心に合わせてある）。呼ぶ側に計算させない
  if (o.lay) out._lay = { ay: c.cy + atY, y0: +o.lay.y0 || 0, z0: +o.lay.z0 || 0 };
  // 【置くなら、正準での軸の位置をここで埋める】呼ぶ側は3Dの軸（点と向き）だけ渡す
  //   正準での軸は「arc の中心」＝(atX, c.cy + atY)。at そのものではない（断面の重心に
  //   合わせて y をずらしてあるため）。ここを間違えると置いた立体が断面の半分ぶんずれる
  if (o.place) out._place = Object.assign({}, o.place, { cx0: atX, cy0: c.cy + atY });
  return out;
}

// ════════════════════════════════════════════════════════════════
// 「通りを描いて、断面を沿わせる」ブロックを1つ作る・2026-10-04
// ════════════════════════════════════════════════════════════════
// 【これが作図の入口】形ごとのボタンを作らない。利用者が決めるのは
//   ① 通り（図の上のクリック列。2点なら直線）
//   ② 曲がり量[m]（2点のときだけ。0 でない＝その区間を円弧にする）
//   ③ 断面（上の表か、任意の点列）
//   ④ 下端の高さ[m]
//   ⑤ 向き（既定は経路に垂直に立てる）
// 戻り値は blocks に入れる記録そのもの。
// 【下端の合わせ方】経路に乗るのは**断面の重心**なので、
//   断面の一番下を 下端M に置くには zBottom を「重心までの高さ」ぶん上げる。
function makeSweptBlock(通り, 曲がり量M, 断面, 下端M, opts) {
  const o = opts || {};
  const mpp = _mwMpp();
  const pts = (通り || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const 生 = (Array.isArray(断面) && 断面.length >= 3) ? 断面 : profilePoints(断面);
  if (!生 || 生.length < 3) return null;
  let lo = Infinity, hi = -Infinity;
  生.forEach(q => { if (q.y < lo) lo = q.y; if (q.y > hi) hi = q.y; });
  // 【選んだ基準点が通りに乗る・2026-10-27 ユーザー要望】
  //   旧は重心を乗せてから『下端が下端Mに来る』よう持ち上げていた＝基準は2つに固定。
  //   「どこを基準にするかはその時々で変わる」ので、外枠の9点＋重心から選べるようにした。
  //   下の中央（既定）なら従来と同じ結果になる。
  const _寄せ = o.anchor || 'bottom';
  const 基 = sectionAnchorPoint(生, _寄せ);
  // 断面を経路の始点に重ねて置く（基準点が始点に来る）
  const p0 = pts[0];
  const points = 生.map(q => ({ x: p0.x + (q.x - 基.cx), y: p0.y + (q.y - 基.cy) }));
  // 【通りに乗せる点・2026-10-26 ユーザー要望】
  //   'bottom'（既定・従来）… 立体の**下端**が下端Mに来る（＝通りは断面の下を通る）
  //   'center'            … 断面の**重心**が下端Mに来る（＝通りが断面の真ん中を通る）
  //   ユーザー報告「中心（重心）とオレンジ点線が同じになるようにしないと描きにくい」。
  //   欄の意味が変わるので既定は従来のまま（裁定待ち）。
  // 基準点そのものが下端Mの高さに来る（基準点＝下の中央なら立体の最下点が下端M）
  const zB = (下端M || 0);
  const zT = (下端M || 0) + (hi - lo) * mpp;
  // 経路：2点＋曲がり量なら円弧、それ以外は折れ線
  let sw;
  const 曲 = Math.abs(曲がり量M || 0);
  if (pts.length === 2 && 曲 > 1e-6) {
    const a = pts[0], b = pts[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) * mpp;                 // 弦の長さ[m]
    const sg = (曲がり量M >= 0) ? 1 : -1;
    if (!(L > 1e-9)) return null;
    const S = Math.min(曲, L / 2 * 0.98);               // ふくらみ[m]（半円を超えさせない）
    const R = (L * L / 4 + S * S) / (2 * S);            // 半径[m]
    // 中心は弦の中点から、ふくらみの逆側へ (R - S)
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
    const nx = -uy * sg, ny = ux * sg;                  // 曲がる向き（左が正）
    const cxg = mx - nx * ((R - S) / mpp), cyg = my - ny * ((R - S) / mpp);
    // 弦の半分と半径から中心角を出す（S を L/2 以下に抑えてあるので R >= S・半円が上限）
    const 角 = 2 * Math.asin(Math.min(1, (L / 2) / R)) * 180 / Math.PI;
    // 回る向きは弦の向きと逆回り。
    //   曲がり量が正（左へふくらむ）とき中心は右側にできるので、始点→終点は**右回り**になる。
    //   ここを間違えると円弧が終点に届かず手前で止まる（実測: x が 100 まで行かず 55.9 で終わった）
    sw = makeArcSweep(cxg, cyg, -角 * sg, 0,
                      Math.max(6, Math.min(120, Math.round(角 / 5))));
  } else {
    sw = makePolySweep(pts, o.riseM || 0, o.seg || 1);
  }
  // 【置き方は束で持つ・2026-10-26 advisor 指摘】足すたびに呼び口へ手書きしない
  const _置き方 = { orient: (o.orient === 'flat') ? 'flat' : 'frame',
                    frame0: o.frame0 || null,
                    roll: Number.isFinite(+o.roll) ? +o.roll : 0,
                    anchor: _寄せ };
  if (o.orient !== 'flat') sw = withUprightSection(sw, o.frame0, _置き方.roll);
  return { points, zBottom: zB, zTop: zT, sweep: sw,
           _profile: Array.isArray(断面) ? { kind: 'custom' } : Object.assign({}, 断面),
           // 点ごとの高さ（z）も残す。落とすと、あとで打ち直したとき平らに戻る
           _route: pts.map(p => (Number.isFinite(p.z)
             ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y })),
           _bulgeM: 曲がり量M || 0,
           // 【入力と結果を分ける・2026-10-05 Codex助言】
           //   _baseM / _orient は**利用者が打った値**、zBottom / zTop は**それから出た結果**。
           //   zBottom は『経路に重心を乗せるぶん持ち上げた後』なので、ここから入力は戻せない。
           //   あとで寸法を打ち直すとき（rebuildSweptBlock）に要る
           _baseM: 下端M || 0, _orient: _置き方.orient,
           // 置き方は束で運ぶ（足したものを書き忘れない）
           _sweepOpts: _置き方,
           // 通りに乗っている点（points の中の座標）。回す・断面を取り出すが共用する
           _anchorPt: { cx: p0.x, cy: p0.y },
           // 【印の付いた入力は機械的に運ぶ】足したのに運び忘れると、寸法を打ち直した
           //   とたんに断面が暗黙の向きへ戻る（2026-10-05 の _baseM と同じ型）
           _frame0: o.frame0 || null };
}

// ════════════════════════════════════════════════════════════════
// 作った後に寸法を打ち直す ・2026-10-05 Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【points を直に変形しない】points は**結果**で、_profile / _route / _baseM が**意図**。
//   意図に patch を重ねて作り手（makeSweptBlock / makeRevolveBlock）を呼び直す。
//   直に変形すると、経路に沿って回した後の点を逆算することになり必ず崩れる（Codex）。
// 【寸法だけ】断面の**種類**は変えられない。矩形(4辺)→H形鋼(12辺)で辺の数が変わると
//   面の id（ブロックid＋種類＋辺の番号）が変わり、**その面に貼った機器が迷子**になる。
//   種類を変えたいときは作り直す（元に戻すがあるので捨てても困らない）。
// 【元の記録を引き継ぐ】作り直しは「新しいブロックを作ること」ではない（Codex）。
//   壁厚・増築棟の繋がり・操作の列などは残す。
// 戻り: 新しいブロック（元のフィールドを引き継いだもの）／できないときは null
// ════════════════════════════════════════════════════════════════
// 〔引き抜く〕〔🌀 らせん〕のブロックを作る・2026-11-20 App.jsx から移した
// ════════════════════════════════════════════════════════════════
// 【なぜここか】作り手が App.jsx の中（画面の状態を読むクロージャ）にあり、
//   作り直し（rebuildSweptBlock）から呼べなかった。作図・下見・作り直しが同じ関数を通るよう、
//   画面の状態は呼ぶ側で値にして渡す（ここは window も state も読まない）。
// 断面の点を、重心が at に来るように並べる（引き抜き・らせんの共通）
function _profileAround(断面, at, dx) {
  const 生 = (typeof profilePoints === 'function') ? profilePoints(断面) : null;
  if (!生 || 生.length < 3 || !at) return null;
  let cx = 0, cy = 0; 生.forEach(q => { cx += q.x; cy += q.y; });
  cx /= 生.length; cy /= 生.length;
  let lo = Infinity, hi = -Infinity;
  生.forEach(q => { if (q.y < lo) lo = q.y; if (q.y > hi) hi = q.y; });
  return { points: 生.map(q => ({ x: at.x + (dx || 0) + (q.x - cx), y: at.y + (q.y - cy) })),
           cy, lo, hi };
}
// 引き抜く。o = { riseM（解決済みの高さ・負なら面の反対側へ）, twistDeg, r1（先細り）,
//   baseM（下端）, place（作業平面に置く向きと原点。あれば正準の下端は0）}
function makeTwistBlock(断面, at, o) {
  o = o || {};
  const 並 = _profileAround(断面, at, 0); if (!並) return null;
  const 高さ = +o.riseM;
  if (!(Number.isFinite(高さ) && Math.abs(高さ) > 1e-6)) return null;   // 既定は呼ぶ側が決める（二重に持たない）
  const sw = makeLineSweep(高さ, o.twistDeg);
  sw.scale1 = (Number.isFinite(+o.r1) && +o.r1 > 0) ? +o.r1 : 1;   // 先細り
  const base = Number.isFinite(+o.baseM) ? +o.baseM : 0;
  // 置くときの下端は置き場所(o)が持つ。正準まで下端を入れると二重に足される
  const zB = o.place ? 0 : base;
  // 面の反対側へ（高さが負）: 経路の始まりは描いた面のまま。zBottom/zTop は最低・最高
  if (高さ < 0) sw.startM = zB;
  return Object.assign({ points: 並.points, zBottom: zB + Math.min(0, 高さ),
      zTop: zB + Math.max(0, 高さ), sweep: sw },
    { _profile: Object.assign({}, 断面), _twist: true, _baseM: base,
      _at: { x: at.x, y: at.y }, _turnDeg: o.twistDeg, _riseM: 高さ, _r1: o.r1 },
    o.place ? { _place: Object.assign({}, o.place, { cx0: at.x, cy0: at.y }) } : null);
}
// らせん。o = { turnDeg, riseM, r1, baseM, radius（軸から断面の重心まで・グリッド。無ければ断面の幅×1.5）}
function makeHelixBlock(断面, at, o) {
  o = o || {};
  const mpp = _mwMpp();
  const 半径 = (Number.isFinite(+o.radius) && +o.radius > 0) ? +o.radius
    : Math.max(1, ((断面 && 断面.wM) || 0.5) / mpp * 1.5);
  const 並 = _profileAround(断面, at, 半径); if (!並) return null;
  const turn = Number.isFinite(+o.turnDeg) ? +o.turnDeg : 0;
  const rise = Number.isFinite(+o.riseM) ? +o.riseM : 0;
  const sw = withUprightSection(makeHelixSweep(at.x, at.y, turn, rise,
    Math.max(16, Math.min(240, Math.round(Math.abs(turn) / 7.5))), o.r1));
  const base = Number.isFinite(+o.baseM) ? +o.baseM : 0;
  const zB = base + (並.cy - 並.lo) * mpp;
  return { points: 並.points, zBottom: zB, zTop: zB + (並.hi - 並.lo) * mpp + rise, sweep: sw,
    _profile: Object.assign({}, 断面), _helix: true, _baseM: base,
    _at: { x: at.x, y: at.y }, _turnDeg: o.turnDeg, _riseM: o.riseM, _r1: o.r1, _radius: 半径 };
}

// ── 作り直しの対応表（2026-11-20・advisor監査済み）──
// 【なぜ表にするか】「寸法の欄を出すか」（canResizeBlock）と「作り直せるか」（rebuildSweptBlock）が
//   別々の条件を持っていて食い違った。実測: 既定の操作〔引き抜く〕で作った棟は欄が出るのに、
//   作り直す側が引き抜き（_twist）を知らず null を返し、打っても何も起きなかった。らせん（_helix）も同じ。
//   ここに行を足せば、欄も作り直しも同時に対応する（片方だけ対応する、が起きない）。
// 各行: 印＝その作り方で作った棟が持つ記録の鍵／使える(blk)＝作り直しの入力が揃っているか／
//       作る(blk, 断面, p, 下端M)＝同じ作り手を記録＋patch で呼び直す
const BC_RESIZE_MAKERS = [
  { 印: '_revolve', 使える: () => true,
    作る: (blk, pf, p, base) => makeRevolveBlock(pf, base, {
      at: p.at || blk._at || { x: 0, y: 0 },
      sweepDeg: (p.sweepDeg != null) ? p.sweepDeg : (blk._sweepDeg != null ? blk._sweepDeg : 360),
      // 【置き方も作り直す・2026-10-18】cx0/cy0 は断面の**重心**から出ているので、
      //   寸法を変えたら更新しないと置いた立体が断面の半分ぶんずれる。
      //   軸・向き・位相(m)は古い記録のまま引き継がれる（変えたいのは寸法だけ）
      place: p.place || blk._place || null,
      seg: (p.seg != null) ? p.seg : blk._seg }) },
  { 印: '_twist', 使える: (blk) => !!blk._at,
    作る: (blk, pf, p, base) => makeTwistBlock(pf, blk._at, {
      riseM: blk._riseM, twistDeg: blk._turnDeg, r1: blk._r1,
      baseM: base, place: p.place || blk._place || null }) },
  { 印: '_helix', 使える: (blk) => !!blk._at,
    作る: (blk, pf, p, base) => makeHelixBlock(pf, blk._at, {
      turnDeg: blk._turnDeg, riseM: blk._riseM, r1: blk._r1, baseM: base,
      // 半径（軸から断面の重心まで）は保つ。断面の幅を変えてもコイルの径は変わらない
      // 旧データ（_radius が無い）は作図のときと同じ式（断面の幅×1.5）へ戻す
      radius: Number.isFinite(blk._radius) ? blk._radius : null }) },
  { 印: '_route', 使える: (blk) => Array.isArray(blk._route) && blk._route.length >= 2,
    作る: (blk, pf, p, base) => {
      const route = p.route || blk._route;
      if (!Array.isArray(route) || route.length < 2) return null;
      const bulge = (p.bulgeM != null && Number.isFinite(+p.bulgeM)) ? +p.bulgeM : (blk._bulgeM || 0);
      // 【置き方は束をそのまま渡す・2026-10-26 advisor 指摘】古い記録には束が無いので従来の鍵から組む
      const 旧置き方 = blk._sweepOpts
        || { orient: blk._orient || 'frame', frame0: blk._frame0 || null,
             roll: 0, anchor: 'bottom' };
      return makeSweptBlock(route, bulge, pf, base,
        Object.assign({}, 旧置き方, p.sweepOpts || {})); } },
];
// この棟を作り直す行（無ければ null）。canResizeBlock と rebuildSweptBlock の両方がここを読む
function _resizeMakerOf(blk) {
  if (!blk || !blk._profile) return null;          // 旧データ（入力を持たない）は対象外
  // 陽性対照（window.__RESIZE_ONE_TABLE = false）＝旧の作り直し（回す・沿わせるだけ）
  const 旧 = (typeof window !== 'undefined' && window.__RESIZE_ONE_TABLE === false);
  const m = BC_RESIZE_MAKERS.find(r => blk[r.印] && (!旧 || r.印 === '_revolve' || r.印 === '_route'));
  return (m && m.使える(blk)) ? m : null;
}
// 寸法を打ち直せる断面か。**決まった形**（表 BC_PROFILES にある）で、表が要るとする寸法が全部正。
//   描いた輪郭（raw）・旧い custom は幅の欄を持たないので対象外（欄は出さず理由の札を出す）
function _resizableProfile(pf) {
  if (!pf || !pf.kind || !BC_PROFILES[pf.kind]) return false;
  const 正 = (v) => Number.isFinite(+v) && +v > 0;
  return (BC_PROFILES[pf.kind].要る || ['wM']).every(k => k === 'tM' || 正(pf[k]))
    && 正(pf.wM);
}
function rebuildSweptBlock(blk, patch) {
  const 行 = _resizeMakerOf(blk);
  if (!行) return null;
  const p = patch || {};
  const pf = Object.assign({}, blk._profile, p.profile || {});
  if (pf.kind !== blk._profile.kind) return null;  // 種類は変えない（上の理由）
  // 寸法の検証（0 や負は作らない。黙って壊れた形を作らない）。欄を出す述語と同じ条件
  if (!_resizableProfile(pf)) return null;
  if (pf.tM != null && !(Number.isFinite(+pf.tM) && +pf.tM > 0)) return null;
  const base = (p.baseM != null && Number.isFinite(+p.baseM)) ? +p.baseM : (blk._baseM || 0);
  // 【置いた棟の下端は置き場所が持つ・2026-11-20 advisor 指摘】
  //   作業平面に置いた棟（_place）は、正準の下端が0で、下端は置き場所の原点（oz）にある。
  //   下端を打ち直したら、その差だけ原点を真上へ動かす（向きはそのまま）。
  //   正準の下端へ入れると、軸が横向きの棟では横へずれる／引き抜きでは何も起きない。
  const pl0 = p.place || blk._place || null;
  let 下端 = base, place = pl0;
  if (pl0) {
    const 差 = base - (blk._baseM || 0);
    place = Math.abs(差) > 1e-12
      ? Object.assign({}, pl0, { oz: (pl0.oz || 0) + 差 / _mwMpp() }) : pl0;
    下端 = blk._twist ? base : 0;                    // 回す（置く）は正準0で作られている
  }
  const 新 = 行.作る(blk, pf, Object.assign({}, p, { place }), 下端);
  if (!新) return null;
  const 結果 = Object.assign({}, blk, 新);
  if (pl0) 結果._baseM = base;                       // 欄に出す値は打った値
  return 結果;
}
// この棟の points を**直に**動かしてよいか ・2026-10-06 Codex監査済み
// 【なぜ要るか】掃引・回転体の points は「断面の点列」であって建屋の輪郭ではない。
//   辺の長さや頂点を直に動かすと**断面が壊れ**、回したとき別物になる。
//   実測（ユーザー報告）: 幅0.6m の矩形を回したのに**外形 9.19 × 12.26m のリング**になった
//   （辺の長さの欄に 8.67 / 12.64 と入っていた）。
// 【どこが使うか】建物エディタの辺・頂点の欄／平面図の頂点ハンドル／3次元図の押し引き。
//   入口ごとに判定を書かない（書き分けると必ずどこかが残る）。
function canEditPointsDirectly(blk) { return !(blk && blk.sweep && blk.sweep.path); }
// このブロックは寸法を打ち直せるか（UI が欄を出すかを決める・述語は1つ）
// 【作り直せる物だけ欄を出す・2026-11-20】作り直しと**同じ対応表と同じ寸法の条件**を読む。
//   旧: 「_profile.kind があり custom でない」だけを見ていたので、引き抜き・らせん・描いた輪郭（raw）で
//   欄が出るのに打っても効かなかった。陽性対照 window.__RESIZE_ONE_TABLE = false で旧の判定
function canResizeBlock(blk) {
  if (typeof window !== 'undefined' && window.__RESIZE_ONE_TABLE === false)
    return !!(blk && blk._profile && blk._profile.kind && blk._profile.kind !== 'custom');
  return !!_resizeMakerOf(blk) && _resizableProfile(blk._profile);
}

// ════════════════════════════════════════════════════════════════
// ブロック1つ → 立体。**形の作り方の分岐はここだけ**・2026-10-03
// 押し出し（従来）と掃引（経路に沿わせる）を呼び分ける。呼ぶ側は種類を知らなくてよい。
// 【なぜ1か所にするか】分岐を呼び出しごとに書くと、新しい形を足したとき片方だけ対応して
//   「平面図では出るのに3次元図では出ない」が起きる
function blockSolidOf(bld, blk, bi) {
  if (!bld || !blk) return null;
  const 掃引する = !!(blk.sweep && blk.sweep.path)
    && !(typeof window !== 'undefined' && window.__SWEEP_SOLID === false);
  if (掃引する) {
    // 【掃引は _normalizeOutward を通さない】あれは「立体の重心から離れる向き」で法線を揃えるので、
    //   らせんのように曲がった形だと**重心が形の外**（C字の内側の空洞）に来て、
    //   正しく外を向いている面まで裏返す（実測: 側面96枚のうち36枚が裏返った）。
    //   掃引は断面をCCWに正規化し、頂点の順を固定して作るので、その時点で既に外を向いている。
    return sweepToSolid(bld, blk, bi);
  }
  const _ops = sharedWallOpeningsForBlock(bld.blocks, bi);
  const s = blockToSolid(bld.id, bi, bld.label, bld.color, blk.points,
    blk.zBottom || 0, blk.zTop != null ? blk.zTop : 40,
    // 【つなぎ目の穴があるときは傾けない】開口は上端が一定である前提で組み立てている。
    //   同時に扱えないので、UI 側でも blockSlopeBlockedReason で理由を出して弾く
    // 【円の情報を立体まで運ぶ・2026-11-24 ユーザー指示「円を書く機能があるだろ」】
    //   ここまで blk.shape（円）を持っていたのに、立体には点列しか渡していなかったので、
    //   「◯ 円」ボタンで作った円柱も、地図から取り込んだタンクも、**どちらも48角形**になっていた。
    //   shape をそのまま渡し、立体に印を残す。描き手はそれを見て「円柱として」描ける。
    { openings: _ops, slope: (_ops && _ops.length) ? null : (blk.slope || null), shape: blk.shape || null });
  return s ? _normalizeOutward(s) : null;
}

// ════════════════════════════════════════════════════════════════
// パターン（同じ部材を並べる）・2026-10-03
// ════════════════════════════════════════════════════════════════
// 【なぜ要るか】螺旋階段は「扇形の段板を、角度と高さをずらして並べたもの」。
//   **新しい形を発明するのではなく、既にある形を並べる操作**として持つ。
//   柱列・ルーバー・フェンス・手すり子・エスカレーターの段も同じ操作で作れる。
// 【掃引との違い】掃引は連続した1つの形（らせんスロープ・手すり）、
//   パターンは離れた部材の集まり（段板）。螺旋階段は後者。

// 並べ方 → 各個体の「置き方」
function patternPlacements(pt) {
  const n = Math.max(1, Math.min(400, Math.round((pt && pt.count) || 1)));
  const out = [];
  for (let k = 0; k < n; k++) {
    if (pt && pt.kind === 'helix') {
      // 中心のまわりを stepDeg ずつ回しながら stepRise ずつ上げる（stepRise=0 なら円形に並ぶ）
      out.push({ k, rot: (pt.stepDeg || 0) * Math.PI / 180 * k,
                 cx: pt.cx || 0, cy: pt.cy || 0, dx: 0, dy: 0, dz: (pt.stepRise || 0) * k });
    } else {
      // まっすぐ並べる（柱列・フェンス）
      out.push({ k, rot: 0, cx: 0, cy: 0,
                 dx: ((pt && pt.dx) || 0) * k, dy: ((pt && pt.dy) || 0) * k,
                 dz: ((pt && pt.dz) || 0) * k });
    }
  }
  return out;
}

// 立体ひとつを、その置き方で動かした複製にする
function _applyPlacement(sd, pl) {
  const c = Math.cos(pl.rot), sn = Math.sin(pl.rot);
  const 動 = (v) => {
    const rx = v.x - pl.cx, ry = v.y - pl.cy;
    return { x: pl.cx + rx * c - ry * sn + pl.dx,
             y: pl.cy + rx * sn + ry * c + pl.dy,
             z: (v.z || 0) + pl.dz };
  };
  return Object.assign({}, sd, {
    id: sd.id + '#' + pl.k,
    faces: (sd.faces || []).map(fc => {
      const vs = (fc.vertices || []).map(動);
      return Object.assign({}, fc, { id: fc.id + '#' + pl.k, vertices: vs,
                                     normal: _computeNormal(vs) });
    }),
    _normPts: (sd._normPts || []).map(p => { const q = 動({ x: p.x, y: p.y, z: 0 });
                                             return { x: q.x, y: q.y }; }),
    // 【足し込む】並べる操作は2回以上重ねられる（格子）。
    //   「元の1つか」は**全部の k が0か**＝合計が0か で判る（k は0以上なので和で足りる）。
    //   建物エディタのプレビューは、ここが0のものだけ面を掴ませる
    _patternIdx: (sd._patternIdx || 0) + pl.k,
  });
}

// ════════════════════════════════════════════════════════════════
// 操作（Feature）の列・2026-10-04 Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【なぜ列にするか】形の作り方を slope / sweep / pattern という**並列のフィールド**で
//   持っていたので、
//     ・順序が持てない
//     ・**同じ操作を2回できない**（柱を縦横の格子に並べる、が書けなかった）
//     ・操作を足すたびにフィールドが1つ増える（＝ユーザー指摘「個別に作るな」の型）
// 【記録 → 列 の変換はここ1つだけ】旧データ（slope / sweep / pattern）は**ここでしか読まない**。
//   新しい記録は blk.features を直に持てる
//   （Codex: いきなり保存データを移行するより、まず評価系を列へ寄せる方が安全）
// ════════════════════════════════════════════════════════════════
// 倒す（lay）・2026-10-15 ユーザー裁定
// ════════════════════════════════════════════════════════════════
// 【なぜ要るか】「上から（X-Y）に描いた輪郭を回したい」。そのとき回転軸は**水平**になる。
//   makeRevolveBlock は鉛直軸専用なので、鉛直軸で作ってから 90° 倒す。
//   こうすると経路の表（BC_CURVES）も断面の表も増やさず、操作の列に1行足すだけで済む。
// 【式】倒す前の (x, y, z) は「軸が鉛直・断面の高さ u が z・回転が (x,y)」。
//   倒した後は「軸が y 方向の水平線・u が y・回転が (x,z)」なので
//     x' = x,  y' = y0 + z/mpp,  z' = z0 + (y - ay)*mpp
//   ay＝倒す前の回転中心の y、y0＝断面の下端を置く y、z0＝軸の高さ[m]
// 【法線はメートル空間で出す】x,y はグリッド・z はメートルの混在空間なので、
//   そのまま外積を取ると高さだけ 1/mpp 倍に潰れる（sweepToSolid と同じ作法）
// (0,0,1) → u の最短回転（ロドリゲス）。**位相を決めない**ので、これ単体で立体を置くと
//   軸まわりの向きが成り行きになる（2026-10-18 の不具合）。いまは旧データの位相を
//   復元するためだけに残している。
function _rodriguesZtoU(ux, uy, uz) {
  const kx = -uy, ky = ux, kz = 0;
  const sn = Math.hypot(kx, ky, kz), cs = uz;
  return (p) => {
    if (sn < 1e-9) return (cs >= 0) ? { x: p.x, y: p.y, z: p.z }
                                    : { x: p.x, y: -p.y, z: -p.z };   // 真上／真下
    const ex = kx / sn, ey = ky / sn, ez = kz / sn;
    const d = ex * p.x + ey * p.y + ez * p.z;
    const cxp = ey * p.z - ez * p.y, cyp = ez * p.x - ex * p.z, czp = ex * p.y - ey * p.x;
    return { x: p.x * cs + cxp * sn + ex * d * (1 - cs),
             y: p.y * cs + cyp * sn + ey * d * (1 - cs),
             z: p.z * cs + czp * sn + ez * d * (1 - cs) };
  };
}
// 【置く（place）・2026-10-15／位相を足した 2026-10-18】
//   正準（原点を通る鉛直軸の回転体）を、実際の軸へ合わせて置く。
//   f = { ox, oy, oz, ux, uy, uz, mx, my, mz, cx0, cy0 }  すべて**グリッド空間**（z もグリッド）
//     o … 軸の通る点 ／ u … 軸の向き（単位）／ c0 … 正準での軸の位置（at）
//     m … **正準の断面がある向き (-1,0,0) が実空間で向く先**（軸に垂直・単位）
//   【なぜ m が要るか・2026-10-18 ユーザー報告】
//     「回すの0度の位置は作った面だろ。180度の位置になってるぞ」
//     u だけでは軸**まわり**の向きが決まらない。(0,0,1)→u の最短回転で済ませていたので、
//     0°の位置が成り行きで決まっていた：鉛直軸で断面が左なら真反対、平面図の水平軸なら
//     真上（90°）、軸の方位を少し変えると帯が軸のまわりを滑る。
//     ＝**枠（軸1本＋断面の向き1本）で表すのが正しい契約**。
//   【正準の約束】断面は clipSectionLeft で x<=0 側だけを残す（1006行のコメント）。
//     だから正準の断面方向は (-1,0,0)。これを m に合わせれば 0° が描いた面に来る。
//   【右手系】e1 = -m, e2 = m×u, e3 = u。e1×e2 = (-m)×(m×u) = u で右手系になる。
//   【旧データ】m を持たない記録は、旧ロドリゲスで (-1,0,0) を写した像を m にする
//     ＝保存済みの図は1ビットも変わらない（陽性対照 window.__PLACE_PHASE = false で
//     いまの図も旧挙動に戻せる）。
//   【単位】x,y はグリッド・z はメートルの混在空間なので、回転はグリッド空間で行い、
//     最後に z を [m] へ戻す。法線はメートル空間で取り直す（sweepToSolid と同じ作法）
function _applyPlace(sd, f) {
  const mpp = _mwMpp();
  const L = Math.hypot(f.ux || 0, f.uy || 0, f.uz || 0) || 1;
  const ux = (f.ux || 0) / L, uy = (f.uy || 0) / L, uz = (f.uz || 0) / L;
  // 位相 m。記録に無ければ（＝2026-10-18 より前の図）旧ロドリゲスの像を使う
  let mx = +f.mx, my = +f.my, mz = +f.mz;
  const 旧 = (typeof window !== 'undefined' && window.__PLACE_PHASE === false);
  if (旧 || !(Number.isFinite(mx) && Number.isFinite(my) && Number.isFinite(mz)
             && Math.hypot(mx, my, mz) > 1e-9)) {
    const d = _rodriguesZtoU(ux, uy, uz)({ x: -1, y: 0, z: 0 });
    mx = d.x; my = d.y; mz = d.z;
  }
  // 軸に直交させて単位化（利用者が渡す m は軸に垂直とは限らない）
  const dt = mx * ux + my * uy + mz * uz;
  mx -= dt * ux; my -= dt * uy; mz -= dt * uz;
  let ml = Math.hypot(mx, my, mz);
  if (!(ml > 1e-9)) {   // m が軸と平行だった＝位相を決められない。旧の像へ逃がす
    const d = _rodriguesZtoU(ux, uy, uz)({ x: -1, y: 0, z: 0 });
    mx = d.x; my = d.y; mz = d.z;
    const dt2 = mx * ux + my * uy + mz * uz;
    mx -= dt2 * ux; my -= dt2 * uy; mz -= dt2 * uz;
    ml = Math.hypot(mx, my, mz) || 1;
  }
  mx /= ml; my /= ml; mz /= ml;
  // 第3軸 w = m × u
  const wx = my * uz - mz * uy, wy = mz * ux - mx * uz, wz = mx * uy - my * ux;
  // 正準の (x,y,z) を 枠 (-m, w, u) へ写す
  const R = (p) => ({ x: -p.x * mx + p.y * wx + p.z * ux,
                      y: -p.x * my + p.y * wy + p.z * uy,
                      z: -p.x * mz + p.y * wz + p.z * uz });
  const 動 = (v) => {
    const q = R({ x: v.x - (f.cx0 || 0), y: v.y - (f.cy0 || 0), z: (v.z || 0) / mpp });
    return { x: (f.ox || 0) + q.x, y: (f.oy || 0) + q.y, z: ((f.oz || 0) + q.z) * mpp };
  };
  return Object.assign({}, sd, {
    faces: (sd.faces || []).map(fc => {
      const vs = (fc.vertices || []).map(動);
      return Object.assign({}, fc, { vertices: vs,
        normal: _computeNormal(vs.map(v => ({ x: v.x * mpp, y: v.y * mpp, z: v.z }))) });
    }),
    // 【代表の輪郭は置いた後の頂点から作る】元の点を z=0 で写すと1本に潰れる
    _normPts: (() => { const vs = (sd.faces && sd.faces[0] && sd.faces[0].vertices) || [];
      return vs.map(v => { const q = 動(v); return { x: q.x, y: q.y }; }); })(),
    _placed: true,
  });
}

function _applyLay(sd, f) {
  const mpp = _mwMpp();
  const ay = (f && +f.ay) || 0, y0 = (f && +f.y0) || 0, z0 = (f && +f.z0) || 0;
  const 動 = (v) => ({ x: v.x, y: y0 + (v.z || 0) / mpp, z: z0 + (v.y - ay) * mpp });
  return Object.assign({}, sd, {
    faces: (sd.faces || []).map(fc => {
      const vs = (fc.vertices || []).map(動);
      return Object.assign({}, fc, { vertices: vs,
        normal: _computeNormal(vs.map(v => ({ x: v.x * mpp, y: v.y * mpp, z: v.z }))) });
    }),
    _normPts: (sd._normPts || []).map(p => { const q = 動({ x: p.x, y: p.y, z: 0 });
                                             return { x: q.x, y: q.y }; }),
    _laid: true,
  });
}

function blockFeatures(blk) {
  if (blk && Array.isArray(blk.features) && blk.features.length) return blk.features;
  const out = [{ kind: 'base' }];   // 断面・経路・向き・上面の傾き・増築棟の穴は base が持つ
  // 【置く】軸を実際の3D直線へ合わせる。記録は blk._place（2026-10-15）
  const pl = blk && blk._place;
  if (pl) out.push(Object.assign({ kind: 'place' }, pl));
  // 【旧い持ち方はここでしか読まない】倒す(lay)は place の特別な場合。別実装にしない
  const ly = (!pl && blk) ? blk._lay : null;
  if (ly) out.push({ kind: 'lay', ay: ly.ay, y0: ly.y0, z0: ly.z0 });
  const pt = blk && blk.pattern;
  // 【kind を混ぜない】並べ方の記録は自分の kind（line / helix）を持っているので、
  //   操作の kind と同じ名前にすると上書きされ、表 BC_FEATURES から引けなくなる。
  //   実測: 立体が1本しか出なくなった（＝並べる操作ごと落ちていた）
  if (pt && pt.count > 1) out.push({ kind: 'pattern', pattern: pt });
  return out;
}

// 【表】増やすのは分岐ではなくこの行（面 BC_SURFACES・経路 BC_CURVES と同じ作法）
// apply(いまある立体たち, 操作, { bld, blk, bi }) → 次の立体たち
const BC_FEATURES = {
  // 最初の立体を作る。いまの記録は points が blk の直下にあるので、
  // 断面・経路・向き・上面の傾き・増築棟の穴を**まとめてここが持つ**
  //（Codex: 粗いが、記録が sketch と feature に分かれていない今の構造では妥当）
  base: { apply: (ss, f, c) => { const s = blockSolidOf(c.bld, c.blk, c.bi); return s ? [s] : []; } },
  // 倒す。いまある立体ぜんぶを、軸が水平になるように90°倒す
  //   【陽性対照】window.__LAY_SOLID = false で倒さない（＝上から描いた回転体が
  //     鉛直軸のまま出る＝2026-10-15 以前の姿）
  // 置く。軸を実際の3D直線へ合わせる（倒すも斜めも同じ1行）
  //   【陽性対照】window.__PLACE_SOLID = false で置かない（＝正準のまま出る）
  place: { apply: (ss, f) => {
    if (typeof window !== 'undefined' && window.__PLACE_SOLID === false) return ss;
    return ss.map(s => _applyPlace(s, f));
  } },
  lay: { apply: (ss, f) => {
    if (typeof window !== 'undefined' && window.__LAY_SOLID === false) return ss;
    return ss.map(s => _applyLay(s, f));
  } },
  // 並べる。**いまある立体ぜんぶ**に掛かるので、2回重ねれば格子になる
  pattern: { apply: (ss, f) => {
    if (typeof window !== 'undefined' && window.__PATTERN_SOLID === false) return ss;
    // 並べ方は f.pattern に入れても、操作の上に直に書いてもよい
    //（直に書いたときの kind は 並べ方 ではなく 操作 の名前なので、まっすぐ並べる扱いになる）
    const p = (f && f.pattern) || f;
    if (!(p && p.count > 1)) return ss;
    const pls = patternPlacements(p);
    return ss.flatMap(s => pls.map(pl => _applyPlacement(s, pl)));
  } },
};

// ブロック1つ → 立体「たち」。**操作の列を順に適用するだけ**（種類の分岐は持たない）
// 段階フラグ __FEATURE_LIST=false で従来（並列のフィールドを直に読む）＝陽性対照
// ════ このブロックの、高さ zM での「足跡」・2026-11-04 ════
// 【なぜ要るか】blk.points は押し出しなら足跡だが、**掃引・回転体では断面の点列**。
//   階の床の形（bcFloorOutlines）がそれをそのまま使っていたので、
//   胴6m＋鏡板2m のタンクに階を置くと床が **3m × 9m の縦長**になっていた（実測）。
//   本来は直径6mの円。沿わせた物も「断面 0.6×2m」が床で、通り20mが無視されていた。
// 【形の種類で分けない】立体をその高さで**水平に切る**ので、
//   タンクでもドームでも沿わせでも同じ道を通る（形が増えてもここは変わらない）。
// 【陽性対照】window.__FLOOR_FOOTPRINT = false で従来＝points をそのまま
// 戻り: 点列（グリッド座標）／切れないときは null
// ════════════════════════════════════════════════════════════════
// 面 → 作業平面の枠 ・段0-c・2026-11-20 advisor監査
// ════════════════════════════════════════════════════════════════
// 枠 {o,u,v,n} は**全部グリッド空間**（z もグリッド）＝App の 作業平面の枠 と同じ約束。
//   n … 面の外向きの法線（単位）
//   u … unit(Z × n)。ほぼ水平な面（|n.z|≈1）だけ u=(1,0,0)
//   v … n × u（u × v = n の右手系）
//   o … **世界の原点をその面に下ろした点**（n × (n・p)）。面の重心にしない：
//       基本3面（上から・正面・横）の枠はちょうどこの形なので、軸に平行な面では
//       2D 座標が世界のグリッドと揃う（「y=TH/2 の正面を選んだ枠 ＝ 正面の枠」が完全一致する）。
// 【面の契約（atUV）から作らない理由】契約は建屋の階の壁・床・天井と CSG 立体の鉛直・傾いた面だけで、
//   建屋の立体の面と水平な面（屋根・上面）が無い。契約を広げると機器を貼る側まで波及するので、
//   0-c ではここで作る（負債として ROADMAP に記録）。
//   点と法線から作る口
function planeFrameFromPointNormal(pGrid, nIn) {
  if (!pGrid || !nIn) return null;
  let nx = +nIn.x, ny = +nIn.y, nz = +nIn.z;
  const L = Math.hypot(nx, ny, nz);
  if (!(L > 1e-9)) return null;
  nx /= L; ny /= L; nz /= L;
  let ux, uy, uz;
  if (Math.abs(nz) > 0.999) { ux = 1; uy = 0; uz = 0; }
  else { ux = -ny; uy = nx; uz = 0;                       // Z × n = (-ny, nx, 0)
         const UL = Math.hypot(ux, uy); ux /= UL; uy /= UL; }
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;   // n × u
  const d = pGrid.x * nx + pGrid.y * ny + pGrid.z * nz;
  return { o: { x: nx * d, y: ny * d, z: nz * d }, u: { x: ux, y: uy, z: uz },
           v: { x: vx, y: vy, z: vz }, n: { x: nx, y: ny, z: nz } };
}
//   立体の面（頂点は x,y グリッド・z メートル）から作る口。
//   法線は**グリッド空間に直してから**計算し直す（保存されている法線は混在空間なので傾いた面でずれる）。
//   向きの符号だけは面が持つ外向きの法線に合わせる。頂点が1平面に乗らなければ null。
function planeFrameFromFace(face) {
  const mpp = _mwMpp();
  const vs = ((face && face.vertices) || []).map(v => ({ x: v.x, y: v.y, z: (v.z || 0) / mpp }));
  if (vs.length < 3) return null;
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < vs.length; i++) { const a = vs[i], b = vs[(i + 1) % vs.length];
    nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
    cx += a.x; cy += a.y; cz += a.z; }
  const L = Math.hypot(nx, ny, nz); if (!(L > 1e-9)) return null;
  nx /= L; ny /= L; nz /= L; cx /= vs.length; cy /= vs.length; cz /= vs.length;
  // 平らか（重心から各頂点への法線方向のずれが面の大きさの 0.1% 以内）
  let 大 = 0; vs.forEach(v => { 大 = Math.max(大, Math.hypot(v.x - cx, v.y - cy, v.z - cz)); });
  if (vs.some(v => Math.abs((v.x - cx) * nx + (v.y - cy) * ny + (v.z - cz) * nz) > Math.max(1e-6, 大 * 1e-3)))
    return null;
  const fn = face.normal;
  if (fn && (fn.nx * nx + fn.ny * ny + fn.nz * nz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return planeFrameFromPointNormal({ x: cx, y: cy, z: cz }, { x: nx, y: ny, z: nz });
}
//   その面は**曲面の一部**か。型名（円柱・掃引）では分けず幾何で見る（SPEC §3.1）：
//   辺を共有する隣の面との折れ角が「ほぼ0（同じ平面の続き）」でも「はっきりした角」でもなく、
//   その間（1°〜20°）なら滑らかにつながる小面＝曲面の一部。円柱の48角形の側面（7.5°）はこれで除く。
function isFacetOfCurvedSurface(faces, idx) {
  const f = faces && faces[idx]; if (!f) return false;
  const mpp = _mwMpp();
  const 法 = (g) => { const fr = planeFrameFromFace(g); return fr ? fr.n : null; };
  const n0 = 法(f); if (!n0) return true;            // 平らでない面は曲面扱い（選ばせない）
  const 鍵 = (v) => v.x.toFixed(3) + ',' + v.y.toFixed(3) + ',' + (v.z / mpp).toFixed(3);
  const 辺 = new Set();
  const vs = f.vertices || [];
  for (let i = 0; i < vs.length; i++) { const a = 鍵(vs[i]), b = 鍵(vs[(i + 1) % vs.length]);
    辺.add(a < b ? a + '|' + b : b + '|' + a); }
  for (let j = 0; j < faces.length; j++) {
    if (j === idx) continue;
    const g = faces[j], ws = g.vertices || [];
    let 共有 = false;
    for (let i = 0; i < ws.length && !共有; i++) { const a = 鍵(ws[i]), b = 鍵(ws[(i + 1) % ws.length]);
      if (辺.has(a < b ? a + '|' + b : b + '|' + a)) 共有 = true; }
    if (!共有) continue;
    const n1 = 法(g); if (!n1) continue;
    const 角 = Math.acos(Math.max(-1, Math.min(1, n0.x * n1.x + n0.y * n1.y + n0.z * n1.z))) * 180 / Math.PI;
    if (角 > 1 && 角 < 20) return true;
  }
  return false;
}

function blockFootprintAtZ(bld, blk, bi, zM) {
  if (!blk) return null;
  const 生 = (blk.points && blk.points.length >= 3) ? blk.points : null;
  if (typeof window !== 'undefined' && window.__FLOOR_FOOTPRINT === false) return 生;
  // 押し出し（掃引でも回転でもない）は points がそのまま足跡
  if (!blk.sweep) return 生;
  const ss = blockSolidsOf(bld, blk, bi || 0) || [];
  const 線 = [];
  for (const sd of ss) for (const f of (sd.faces || [])) {
    const vs = f.vertices || []; if (vs.length < 3) continue;
    const 交 = [];
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      const da = a.z - zM, db = b.z - zM;
      if (da > 1e-9 && db > 1e-9) continue;          // 両端とも上
      if (da < -1e-9 && db < -1e-9) continue;        // 両端とも下
      if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) continue;   // 水平な辺は取らない
      const t = da / (da - db);
      if (!Number.isFinite(t) || t < -1e-9 || t > 1 + 1e-9) continue;
      交.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    if (交.length < 2) continue;
    const a0 = 交[0], a1 = 交[交.length - 1];
    if (Math.hypot(a1.x - a0.x, a1.y - a0.y) < 1e-6) continue;   // 長さ0は捨てる
    線.push([a0, a1]);
  }
  if (線.length < 3) return 生;    // 切れない（その高さに面が無い）ときは従来どおり
  // 線分を端点でつないで輪郭にする
  const 近い = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.5;
  const 残 = 線.slice();
  const 輪 = [残[0][0], 残[0][1]]; 残.splice(0, 1);
  let 回 = 0;
  while (残.length && 回++ < 20000) {
    const 末 = 輪[輪.length - 1];
    let 見 = -1, 反 = false;
    for (let i = 0; i < 残.length; i++) {
      if (近い(残[i][0], 末)) { 見 = i; 反 = false; break; }
      if (近い(残[i][1], 末)) { 見 = i; 反 = true; break; }
    }
    if (見 < 0) break;
    const s2 = 残.splice(見, 1)[0];
    輪.push(反 ? s2[0] : s2[1]);
  }
  if (輪.length >= 4 && 近い(輪[0], 輪[輪.length - 1])) 輪.pop();
  // 【つなぎ損ねたら外周だけを拾う・2026-11-04 実測】
  //   回転体は**軸を含む面**があるので、水平に切ると内部を横切る線分が混じる。
   //  端点でつなぐやり方だと軸から外周への1本を拾って終わり、
  //   タンクの足跡が「横3m × 奥0m」になっていた（本来は直径6mの円）。
  //   使えた線分が半分に満たないときは、重心まわりの角度で**外周**だけを拾う。
  //   （水平断面が星形なら正しい。タンク・ドーム・円筒はこれに当たる）
  if (輪.length * 2 >= 線.length) return (輪.length >= 3) ? 輪 : 生;
  const 点ら = [];
  線.forEach(l => { 点ら.push(l[0]); 点ら.push(l[1]); });
  let cx = 0, cy = 0;
  点ら.forEach(p => { cx += p.x; cy += p.y; });
  cx /= 点ら.length; cy /= 点ら.length;
  const 箱 = new Map();
  点ら.forEach(p => {
    const ang = Math.atan2(p.y - cy, p.x - cx);
    const k = Math.round(ang * 180 / Math.PI / 2);   // 2度きざみ
    const r = Math.hypot(p.x - cx, p.y - cy);
    const 旧 = 箱.get(k);
    if (!旧 || r > 旧.r) 箱.set(k, { p: p, r: r, a: ang });
  });
  const 外 = [...箱.values()].sort((u, v) => u.a - v.a).map(o => o.p);
  return (外.length >= 3) ? 外 : ((輪.length >= 3) ? 輪 : 生);
}

function blockSolidsOf(bld, blk, bi) {
  if (!bld || !blk) return [];
  if (typeof window !== 'undefined' && window.__FEATURE_LIST === false)
    return _blockSolidsLegacy(bld, blk, bi);
  let ss = [];
  for (const f of blockFeatures(blk)) {
    const d = BC_FEATURES[(f && f.kind) || 'base'];
    if (d) ss = d.apply(ss, f || {}, { bld, blk, bi });
  }
  return ss;
}

// 【陽性対照専用】従来の「押し出し→並べる」決め打ち。__FEATURE_LIST=false のときだけ通る。
//   検査がこれと列の版を突き合わせて「何通り流して何件食い違ったか」を出す
function _blockSolidsLegacy(bld, blk, bi) {
  const base = blockSolidOf(bld, blk, bi);
  if (!base) return [];
  const pt = blk && blk.pattern;
  const 並べる = !!(pt && pt.count > 1)
    && !(typeof window !== 'undefined' && window.__PATTERN_SOLID === false);
  if (!並べる) return [base];
  return patternPlacements(pt).map(pl => _applyPlacement(base, pl));
}

// 螺旋階段。**扇形の段板**を1段ずつ回しながら上げて並べる。
//   cx,cy  中心［グリッド］   rIn,rOut  内半径・外半径［グリッド］
//   steps  段数               totalDeg  全体で回る角度［度］
//   riseM  全体で上がる高さ［m］  treadM  段板の厚み［m］
// 返すのは blocks に入れる記録そのもの（points は呼ぶ側が blockShapePoints で作る）
function makeSpiralStair(cx, cy, rIn, rOut, steps, totalDeg, riseM, treadM) {
  const n = Math.max(2, Math.min(200, Math.round(steps || 16)));
  const 全角 = (totalDeg == null ? 360 : totalDeg);
  const stepDeg = 全角 / n;
  // 段板1枚＝1段ぶんの角度の扇形。隙間ができないよう、ほんの少し広げる
  const shape = makeSectorShape(cx, cy, rIn, rOut, 0, stepDeg * 1.02);
  return {
    shape,
    points: blockShapePoints(shape),
    zBottom: 0,
    zTop: (treadM == null ? 0.15 : treadM),
    pattern: { kind: 'helix', count: n, cx, cy, stepDeg,
               stepRise: (riseM == null ? 3 : riseM) / n },
  };
}

// buildings配列 → Solid配列 (初期変換用)
function buildingsToSolids(buildings) {
  const result = [];
  buildings.forEach(bld => {
    bld.blocks.forEach((blk, bi) => {
      blockSolidsOf(bld, blk, bi).forEach(s => result.push(s));
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
  _solidLog(`[FACES_DUMP] ${label} ===全${solid.faces.length}面===\n${dump}\n===END===`);
}

// pushpull: 面を法線方向にd移動（全面統一アルゴリズム）
// solid: Solidオブジェクト, faceId: 移動する面のID, depth: 移動距離（正=外側）
// 戻り値: 新しいSolid
// 【診断のログ・2026-10-06】無条件に出さない。この下の処理は押し引きのドラッグ中に
//   **毎フレーム**走るので、DevTools を開いた実機だけが重くなる。
//   ヘッドレスの検査では安いので気づけない（同じ型が過去に2回出た）。
//   window.__SOLID_TRACE = true のときだけ出す
function _solidLog() {
  if (typeof window !== 'undefined' && window.__SOLID_TRACE)
    console.warn.apply(console, arguments);
}
function pushPullFace(solid, faceId, depth) {
  try {
  if (Math.abs(depth) < 0.001) return solid;
  // 【掃引・回転体には掛けない・2026-10-06 Codex監査済み】断面×経路で作った立体の面を
  //   法線方向に押すと、断面と経路の意味が壊れる（曲面・ねじれ面では特に）。
  //   形を直すのは断面の寸法（rebuildSweptBlock）。入口が何本あってもここで止める
  if (solid && solid._sweep) return solid;
  const face = solid.faces.find(f => f.id === faceId);
  if (!face) return solid;
  _solidLog('[pushPullFace] 開始', { faceId, depth: depth.toFixed(2), 面数: solid.faces.length, 全faceID: solid.faces.map(f => `${f.id}(${f.type},${f.vertices.length}v)`) });

  const adj = _buildAdjacency(solid);
  const neighbors = adj.get(faceId) || [];
  _solidLog('[pushPullFace] 隣接面', { count: neighbors.length, faces: neighbors.map(nb => `${nb.faceId}(辺${nb.edges.length})`) });
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
  if (invalidCount > 0) _solidLog('[pushPullFace] 不正な頂点を修復', { count: invalidCount });
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
  if (_degenerateFaces.length > 0) _solidLog('[pushPullFace] 縮退面検出', _degenerateFaces);
  _solidLog('[pushPullFace] 結果', { 結果faceID: resultFaces.map(f => `${f.id}(${f.type},${f.vertices.length}v)`) });
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
    _solidLog('[ORPHAN_WALL] 孤立壁を除去', { id: f.id,
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
      _solidLog('[REBUILD_WALLS] 非軸平行階段壁生成完了', {壁数:generalWalls.length});
      return [...nonWall, ...generalWalls];
    }
    // フォールバック: 既存壁保持
    const existingWalls = faces.filter(f => f.type === 'wall' && f.vertices && f.vertices.length >= 3);
    _solidLog('[REBUILD_WALLS] 壁生成0→既存壁保持フォールバック', {保持壁数:existingWalls.length});
    return [...nonWall, ...existingWalls];
  }
  _solidLog('[REBUILD_WALLS] 再構築完了', {旧壁数:faces.filter(f=>f.type==='wall').length, 新壁数:newWalls.length, lineGroups数:lineGroups.size});
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
      _solidLog('[PUNCH_THROUGH] 貫通: 反対面に穴をあける', { faceId: f.id });
      return { ...f, holes: [...(f.holes || []), movedRect.map(v => ({ x: v.x, y: v.y, z: v.z }))] };
    });

    const newFaces = [...mappedFaces, ...frameQuads, ...stepWalls];
    if (!punchThrough) newFaces.push(bottomFace);
    _solidLog('[INTERIOR_RECT] 削り出し(4クワッド)', {
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
    _solidLog('[INTERIOR_RECT] tower作成(突起)', {
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

// ══════════ 断面の形（スケッチ）・2026-09-24 ══════════
// 【ユーザー要求】円柱（タンク・サイロ・煙突）を作りたい。
// 【方針・Codex監査】`points` に円弧を混ぜない（218箇所が「辺は直線」と仮定している）。
//   **円は shape として持ち、points には多角形近似をキャッシュする**。
//   既存処理（描画・押し引き・部屋認識・機器の吸い付き・壁厚）は points を見るだけなので
//   何も変えずに動く。shape は「円である」ことを保つためのもので、半径を後から変えるのに使う。
// 円を何角形で近似するか。
// 【48 → 16 にした・2026-11-23 ユーザー指示「やれよ43%減らせ」】
//   実測（大分・164件取り込み）: 円柱46件が3次元図の面の **67%**（2300/3421面）を占めていた。
//   円柱1件は 側面48＋上下2＝50面。16 なら 18面になり、全体 3421→1949面（**43%減**）。
//   誤差: 半径30mの円を16角形にすると、辺の中央が真円より 0.58m 内側（48なら6cm）。
//   タンクの見た目としては足りるが、**精度が要る作図では粗い**ので旗で戻せるようにする。
// 【16 でなく 20 にした理由＝曲面判定の境界・2026-11-23 監査の指摘】
//   isFacetOfCurvedSurface は「隣り合う面の折れ角が 1°〜20°」を曲面の一部とみなす。
//   正n角形の折れ角は 360/n なので、16角形は **22.5°** で曲面から外れ、
//   **円柱の側面が「平らな作業平面」として選べてしまう**（押し引きの対象が変わる＝実害）。
//   20角形なら 18° で曲面のまま。面は 側面20＋上下2＝22面（48のときは50面）。
//   ＝ 48→20 で円柱1件あたり **56%減**。全体では約38%減（164件の実測で 3421→約2100面）。
// 【旗】window.__BLD_CIRCLE_SEG = 48 で従来に戻る（陽性対照）。16 を入れると上の実害が出る。
const BLD_CIRCLE_SEG = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__BLD_CIRCLE_SEG))
  ? Math.max(6, Math.min(96, globalThis.__BLD_CIRCLE_SEG)) : 48;   // 【2026-11-23 ユーザー指示】分割を粗くして減らすのでなく「円は円として描く」で減らす
// 形 → 輪郭の点列。形を持たないブロック（従来の多角形）は null を返す
function blockShapePoints(shape) {
  if (!shape) return null;
  if (shape.type === 'circle') {
    const n = Math.max(8, Math.min(240, shape.segments || BLD_CIRCLE_SEG));
    const r = shape.r;
    if (!(r > 0)) return null;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push({ x: shape.cx + r * Math.cos(t), y: shape.cy + r * Math.sin(t) });
    }
    return pts;
  }
  // ══ 扇形 ・2026-10-01 ══
  // 【なぜ要るか】イオンモールのような「扇形の空間」。円（閉じた全周）しか作れなかった。
  // 【持ち方は円と同じ】points には多角形近似をキャッシュし、shape が正。
  //   こうすれば描画・押し引き・部屋認識・機器の吸い付きは1行も変えずに動く。
  //   円弧であることは shape にだけ残り、blockOuterEdges がそこから論理的な辺を出す。
  // cx,cy=中心 / rIn=内半径(0可) / rOut=外半径 / a0,a1=開始角・終了角[ラジアン・反時計回り]
  if (shape.type === 'sector') {
    const rO = shape.rOut, rI = Math.max(0, shape.rIn || 0);
    if (!(rO > 0) || rI >= rO) return null;
    const sw = _secSweep(shape);
    if (!(Math.abs(sw) > 1e-9)) return null;
    // 弧の分割数は「全周なら segments 個」に合わせる（弓なりの誤差を円と揃える）
    const full = Math.max(8, Math.min(240, shape.segments || BLD_CIRCLE_SEG));
    const n = Math.max(2, Math.ceil(full * Math.abs(sw) / (Math.PI * 2)));
    const pts = [];
    const P = (r, t) => ({ x: shape.cx + r * Math.cos(t), y: shape.cy + r * Math.sin(t) });
    if (rI > 0) pts.push(P(rI, shape.a0));
    else pts.push({ x: shape.cx, y: shape.cy });
    for (let i = 0; i <= n; i++) pts.push(P(rO, shape.a0 + sw * (i / n)));   // 外の弧
    if (rI > 0) for (let i = n; i >= 0; i--) pts.push(P(rI, shape.a0 + sw * (i / n)));  // 内の弧
    return pts;
  }
  return null;
}
// 扇形の回り角（a0→a1。反時計回りを正とし、0〜2πに正規化する）
function _secSweep(sh) {
  let sw = (sh.a1 - sh.a0) % (Math.PI * 2);
  if (sw <= 1e-9) sw += Math.PI * 2;
  return Math.min(sw, Math.PI * 2);
}
// 扇形の形を作る。角度は度で受ける（利用者が入力するのは度なので）
function makeSectorShape(cx, cy, rIn, rOut, a0Deg, a1Deg, segments) {
  if (!(rOut > 0) || Math.max(0, rIn || 0) >= rOut) return null;
  const d2r = Math.PI / 180;
  return { type: 'sector', cx, cy, rIn: Math.max(0, rIn || 0), rOut,
           a0: a0Deg * d2r, a1: a1Deg * d2r, segments: segments || BLD_CIRCLE_SEG };
}

// ══ 外周を「論理的な辺」に分ける ・2026-10-01 Codex監査済み ══
// 【なぜ点列の辺番号ではだめか】円・扇形は points に多角形近似をキャッシュしているので、
//   分割数を変えると辺番号が全部ずれる。機器の取付先を辺番号で覚えると分割数を変えた瞬間に
//   行方不明になる。**円弧は分割数によらず「1本の弧」**として数える（Codex指摘）。
// 戻り値: [{ edgeId, kind:'line'|'arc', ... }]
//   line: a, b（グリッド座標）
//   arc : cx, cy, r, a0, sweep（ラジアン。sweep>0 が反時計回り）
// edgeId は形の種類ごとに固定の名前なので、半径・角度を変えても機器は同じ辺に残る
function blockOuterEdges(blk) {
  const sh = blk && blk.shape;
  if (sh && sh.type === 'circle' && sh.r > 0) {
    return [{ edgeId: 'arcO', kind: 'arc', cx: sh.cx, cy: sh.cy, r: sh.r,
              a0: 0, sweep: Math.PI * 2, closed: true }];
  }
  if (sh && sh.type === 'sector') {
    const rO = sh.rOut, rI = Math.max(0, sh.rIn || 0);
    if (!(rO > 0) || rI >= rO) return [];
    const sw = _secSweep(sh);
    const P = (r, t) => ({ x: sh.cx + r * Math.cos(t), y: sh.cy + r * Math.sin(t) });
    const out = [];
    // 点列と同じ回り方（内側の始点 → 外へ → 外の弧 → 内へ → 内の弧）に並べる
    out.push({ edgeId: 'rad0', kind: 'line', a: rI > 0 ? P(rI, sh.a0) : { x: sh.cx, y: sh.cy },
               b: P(rO, sh.a0) });
    out.push({ edgeId: 'arcO', kind: 'arc', cx: sh.cx, cy: sh.cy, r: rO, a0: sh.a0, sweep: sw });
    out.push({ edgeId: 'rad1', kind: 'line', a: P(rO, sh.a0 + sw),
               b: rI > 0 ? P(rI, sh.a0 + sw) : { x: sh.cx, y: sh.cy } });
    if (rI > 0) out.push({ edgeId: 'arcI', kind: 'arc', cx: sh.cx, cy: sh.cy, r: rI,
                           a0: sh.a0 + sw, sweep: -sw });
    return out;
  }
  const pts = (blk && blk.points) || [];
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push({ edgeId: 'e' + i, kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
  }
  return out;
}

// ブロックの輪郭。shape があればそこから作り直す（半径を変えたときの唯一の入口）
function blockPointsFromShape(blk) {
  const p = blockShapePoints(blk && blk.shape);
  return p || (blk && blk.points) || [];
}
// 円の形を、外接する範囲（2点）から作る。中心＋半径で指定する
// 【輪郭から「決まった形」を見分ける・2026-11-23】
// 点列を見て、それが円なら shape（makeCircleShape）を返す。当てはまらなければ null＝点列のまま使う。
// 【形ごとの判定を呼び出し側に書かない】地図からの取り込みも、将来どこから点列が来ても
//   ここ1つを呼ぶ。形が増えたら（扇形など）**ここに足す**。SHAPE_MODEL_SPEC §1。
// 【3つとも満たすときだけ円】半径のばらつきだけだと、正方形も正八角形も円になる。
//   ① 頂点が8つ以上 ② 重心からの距離のばらつきが 6% 以下 ③ 面積が πr² の ±5% 以内
//   実測: 正八角形は面積が 2.83r²（πr² の 10% 下）なので ③ で弾かれる。
// 【判定せず円を当てはめる・2026-11-23 ユーザー指示「全部円柱でいいやつだが」】
//   shapeFromOutline は「円か」を見分ける関数。こちらは**円だと分かっている物**に使う。
//   地図のデータが「タンク」（ftCode 4302）と言っているなら、点列が多少いびつでも円柱でよい。
//   ＝ 形から推し量るのでなく、**データの意味を尊重する**。形ごとの分岐ではない。
//   中心は重心、半径は重心からの平均距離（外接円に相当）。
function circleFromOutline(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let cx = 0, cy = 0;
  for (const q of points) { cx += q.x; cy += q.y; }
  cx /= points.length; cy /= points.length;
  let r = 0;
  for (const q of points) r += Math.hypot(q.x - cx, q.y - cy);
  r /= points.length;
  if (!(r > 0) || !Number.isFinite(r)) return null;
  return makeCircleShape(cx, cy, r);
}
function shapeFromOutline(points) {
  // 【頂点9以上・2026-11-23】正八角形（折れ角45°）は「円」でなく多角形として残す。
  //   地図の円は粗くても9点以上で入っている（実測: 大分のタンクは 9〜35点）。
  if (!Array.isArray(points) || points.length < 9) return null;
  let cx = 0, cy = 0;
  for (const q of points) { cx += q.x; cy += q.y; }
  cx /= points.length; cy /= points.length;
  const ds = points.map(q => Math.hypot(q.x - cx, q.y - cy));
  const r = ds.reduce((a, b) => a + b, 0) / ds.length;
  if (!(r > 0) || !Number.isFinite(r)) return null;
  const sd = Math.sqrt(ds.reduce((a, b) => a + (b - r) * (b - r), 0) / ds.length);
  // 【ばらつきは 9% まで・2026-11-23 実測】大分のタンク43件のうち、円なのに落ちていた6件は
  //   0.066〜0.078 だった（1件だけ 0.203 で、これは本当に円でない＝落ちるのが正しい）。
  if (sd / r > 0.09) return null;
  let 面 = 0;
  for (let k = 0; k < points.length; k++) {
    const a = points[k], b = points[(k + 1) % points.length];
    面 += a.x * b.y - b.x * a.y;
  }
  面 = Math.abs(面) / 2;
  // 【面積は πr² でなく「正n角形の理論値と比べる」・2026-11-23 ユーザー指摘で判明】
  //   地図の円は、タイルの中では**粗い多角形**（実測で 9〜22点）で入っている。
  //   9角形の面積は πr² より 8% 小さいので、πr² と比べると「円でない」と落としてしまう。
  //   実測: 落ちていた7件は「正n角形との差」が -0.065〜+0.031＝**どれもきれいな円**だった。
  //   正n角形の面積 = (n/2)·sin(2π/n)·r²。これと比べれば、点数が少なくても円と分かる。
  //   （正方形・正六角形も理論値に一致するが、上の「頂点8以上」で弾いている）
  const 理論面 = (points.length / 2) * Math.sin(2 * Math.PI / points.length) * r * r;
  if (!(理論面 > 0) || Math.abs(面 - 理論面) / 理論面 > 0.05) return null;
  // segments は書かない（既定の 48 に任せる＝形の持ち方は makeCircleShape が唯一の正）
  return makeCircleShape(cx, cy, r);
}

function makeCircleShape(cx, cy, r, segments) {
  if (!(r > 0)) return null;
  return { type: 'circle', cx, cy, r, segments: segments || BLD_CIRCLE_SEG };
}
// 扇形を「中心から外へドラッグした2点」と開き角から作る（平面図の作図用）
function makeSectorFromDrag(cx, cy, px, py, sweepDeg, rInRatio) {
  const r = Math.hypot(px - cx, py - cy);
  if (!(r > 0)) return null;
  const mid = Math.atan2(py - cy, px - cx);
  const sw = (sweepDeg != null ? sweepDeg : 90) * Math.PI / 180;
  const rIn = r * (rInRatio != null ? rInRatio : 0);
  return { type: 'sector', cx, cy, rIn, rOut: r,
           a0: mid - sw / 2, a1: mid + sw / 2, segments: BLD_CIRCLE_SEG };
}

// ══════════ 増築棟（親の壁の一部を共有して生やす棟）を作る規則 ・2026-09-23 ══════════
// 【ユーザー裁定 2026-09-23】「Cesiumは使用できる人とできない人がいるので、できなくても
//   機能を失わないような構成にしろ」。それまで増築棟を作れるのは CesiumMap.jsx の
//   「面を伸縮」だけで、Cesium が使えない環境では作れなかった。
// 【Codex監査】幾何の規則をここへ出し、平面図・建屋エディタ・Cesium が同じ関数を呼ぶ。
//   切り出す粒度は「UIイベント」ではなく **幾何と編集意図の分類** まで。
//   u範囲・Zの判定・外向き法線・_sharedWall.wallIdx を同じ規則に寄せないと入口ごとにズレる。
function _mwMpp() {   // 1グリッド = 何メートルか（solidModel を単体で読む検査でも落ちない形）
  return (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
}
// 親ブロックの辺(parentEdge)の u0..u1 を外向きに depth だけ出した棟の形を作る。
// 戻り値は onAddBlock(bid, points, zBottom, zTop, extraProps) にそのまま渡せる形。
//   u は「辺の始点からの距離（グリッド）」。depthGrid を省くとほぼ厚み0（Cesium は
//   この形で作ってから push/pull で押し出す。数値入力・平面図は実寸を渡す）。
function makeSharedWallChildBlock(opts) {
  const { parentPoints, parentBlockIdx, parentEdge, uMin, uMax, depthGrid, zMin, zMax } = opts || {};
  if (!Array.isArray(parentPoints) || parentPoints.length < 3) return null;
  const q = parentPoints, n = q.length;
  const ei = ((parentEdge | 0) % n + n) % n;
  const a = q[ei], b = q[(ei + 1) % n];
  const ex = b.x - a.x, ey = b.y - a.y;
  const elen = Math.hypot(ex, ey);
  if (!(elen > 1e-6)) return null;
  const ux = ex / elen, uy = ey / elen;
  // 外向きの法線＝重心と反対側（凹形でも辺の中点と重心の向きで決める。Cesium と同じ規則）
  let nx = uy, ny = -ux;
  const cx = q.reduce((t, p2) => t + p2.x, 0) / n;
  const cy = q.reduce((t, p2) => t + p2.y, 0) / n;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
  const u0 = Math.max(0, Math.min(uMin, uMax));
  const u1 = Math.min(elen, Math.max(uMin, uMax));
  if (!(u1 - u0 > 1e-6)) return null;
  const d = (typeof depthGrid === 'number' && depthGrid > 0) ? depthGrid : 0.01;
  const e0x = a.x + u0 * ux, e0y = a.y + u0 * uy;
  const e1x = a.x + u1 * ux, e1y = a.y + u1 * uy;
  const z0 = Math.min(zMin || 0, zMax || 0), z1 = Math.max(zMin || 0, zMax || 0);
  return {
    // 並びは [辺上の始点, 外へ出た点, 外へ出た点, 辺上の終点]。
    // よって **辺3（終点→始点）が親の壁に接する辺** ＝ wallIdx: 3（Cesium と同じ）
    points: [
      { x: e0x, y: e0y },
      { x: e0x + nx * d, y: e0y + ny * d },
      { x: e1x + nx * d, y: e1y + ny * d },
      { x: e1x, y: e1y },
    ],
    zBottom: z0, zTop: z1,
    extraProps: {
      _parentBlockIdx: parentBlockIdx,
      _sharedWall: { wallIdx: 3, parentBlockIdx, parentEdge: ei, uMin: u0, uMax: u1 },
    },
    outward: { nx, ny }, edgeLen: elen,
  };
}
// その編集が「面いっぱい＝そのブロック自体の伸縮」か「面の一部＝増築棟」かを決める。
// ここを入口ごとに書くと、同じ操作なのに窓によって結果が変わる。
function classifyWallRangeEdit(opts) {
  const { parentBlock, parentEdge, uMin, uMax, zMin, zMax, tolM } = opts || {};
  if (!parentBlock || !Array.isArray(parentBlock.points)) return null;
  const q = parentBlock.points, n = q.length;
  const ei = ((parentEdge | 0) % n + n) % n;
  const a = q[ei], b = q[(ei + 1) % n];
  const elen = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(elen > 1e-6)) return null;
  const tol = (typeof tolM === 'number' && tolM >= 0) ? tolM : 0.5;   // メートル
  const mpp = _mwMpp();
  const u0 = Math.max(0, Math.min(uMin, uMax));
  const u1 = Math.min(elen, Math.max(uMin, uMax));
  const wholeWidth = (u0 * mpp <= tol) && ((elen - u1) * mpp <= tol);
  const zb = parentBlock.zBottom || 0;
  const zt = parentBlock.zTop != null ? parentBlock.zTop : 40;
  const z0 = Math.min(zMin || 0, zMax || 0), z1 = Math.max(zMin || 0, zMax || 0);
  const wholeHeight = (Math.abs(z0 - zb) <= tol) && (Math.abs(z1 - zt) <= tol);
  return {
    kind: (wholeWidth && wholeHeight) ? 'pushpull' : 'child',
    wholeWidth, wholeHeight,
    uMin: u0, uMax: u1, zMin: z0, zMax: z1, edgeLen: elen,
  };
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
        // ガワの厚み（2026-09-22）。ここは記録のフィールドを明示的に選ぶ作りなので、
        // blocks に足したフィールドは**ここにも足さないと平らにした時点で落ちる**
        wallThicknessM: blk.wallThicknessM != null ? blk.wallThicknessM : null,
        // 断面の形（2026-09-24）。円柱は points が48角形の近似なので、これが無いと
        // 平面図が「48頂点の多角形」として頂点ハンドル・ラベルを48個出してしまう
        shape: blk.shape || null,
        // 掃引（断面×経路）の記録・2026-10-03。これが無いと平面図・一覧が
        // 「ただの多角形」として扱い、らせん・斜路だと分からなくなる
        sweep: blk.sweep || null,
        // パターン（同じ部材を並べる）の記録・2026-10-03。螺旋階段の段板など
        pattern: blk.pattern || null,
        // 上面の傾き（片流れ屋根・擁壁）・2026-10-03
        slope: blk.slope || null,
        // 操作の列（Feature）・2026-10-04。上の slope / sweep / pattern は**旧い持ち方**で、
        //   これがあるときは blockFeatures がこちらを正として読む
        features: Array.isArray(blk.features) ? blk.features : null,
        label: bld.label, color: bld.color, buildingId: bld.id, blockIdx: bi,
      });
      // 【作図の入力は機械的に運ぶ・2026-10-05】`_` で始まるフィールド（_profile / _route /
      //   _bulgeM / _revolve / _baseM / _orient / _at / _sweepDeg / _seg …）は
      //   **あとで寸法を打ち直すため**の入力。1つずつ書き写すと足したものを必ず書き忘れる
      //   （実測: _baseM を書き忘れて、打ち直したとき下端が 3m → 0m に落ちた）。
      //   上で明示している _sharedWall などは null 補正があるので、そちらを勝たせる
      const _last = result[result.length - 1];
      Object.keys(blk).forEach(k => {
        if (k.charAt(0) === '_' && !(k in _last)) _last[k] = blk[k];
      });
    });
  });
  return result;
}
const INIT_BLDS = flattenBuildings(INIT_BUILDINGS);
const BLD_COLORS = ["#6B7A8D", "#7B8A9D", "#8896A8", "#5A6B7D", "#4E7A6D", "#7D5A6B", "#6B5A7D", "#7D6B5A"];

