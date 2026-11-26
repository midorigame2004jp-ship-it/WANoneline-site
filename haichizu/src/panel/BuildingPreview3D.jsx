// ================================================================
// BuildingPreview3D.jsx — 建物エディタの3D表示（配電盤エディタと同一方式）
// ================================================================
// 【設計思想（2026-08-16 ユーザー指摘により全面作り直し）】
//   建屋エディタは「その建屋だけを取り出して見る、単体で完結した空間」である。
//   Cesiumは一切関係ない。エディタで詳細をプロットし、その結果をCesiumに載せる、
//   という流れであって、エディタの空間をCesiumから持ってくるのは誤り。
//
//   旧実装はCesium Viewerを埋め込んでいたため、Cesiumのカメラ規約（heading/pitch、
//   ENU座標系、lookAt後のローカル参照フレーム）と配電盤の規約との変換が必要になり、
//   回転の向き・パンの基準がズレ続けた。**変換そのものをなくす**のが正しい解。
//
//   → 配電盤エディタ(PanelCanvas3D.jsx)と同じ Canvas2D + project3DPanel 投影を使う。
//     カメラも同じ {az, el, zoom, panX, panY} モデル。操作も同じ式をそのまま使うため、
//     回転方向・パン量・ズーム倍率は「変換なしで自動的に一致」する。
//
// 【描画】Painter's（面を奥から手前へ塗る）。配電盤のZバッファは重いので持ち込まない
//        （spec 11章「描画方式の決定」）。

// 配電盤エディタ(PanelCanvas3D.jsx)と完全に同一の操作パラメータ
const BP3_ROT_SPEED = 0.008;   // 回転感度（カメラ）
// 床置きの箱（機器・配置済み配電盤）を回す↻ハンドル。箱の画面中心からの距離と大きさ。
// 【壁への吸い付きとは別操作】吸い付きは移動時に向きを壁に合わせるが、
// それとは無関係に向きを決められる手段が要る（2026-08-29 ユーザー要望）
const BP3_ROT_HANDLE_DY = 46;  // 箱の中心から真上へ何px離すか
const BP3_ROT_HANDLE_R  = 9;   // ハンドルの丸の半径
const BP3_ROT_HIT_R     = 13;  // 掴める範囲（丸より少し広く）
const BP3_ZOOM_IN = 1.14;      // ホイール拡大倍率
const BP3_ZOOM_OUT = 0.88;     // ホイール縮小倍率
// zoom はほぼ「1mあたりの画面px」（toLocal が gx*mpp でメートルに直すため）。
// 【上限を50→400に上げた・2026-09-01】0.3m角の壁面機器は 50 だと画面上15pxしかなく、
// 掴めないうえラベルに埋もれる（ユーザー指摘）。400 なら 0.3m が約120pxになる。
// ※上げすぎると「図面全体が1本のプリミティブとして巨大化し、ラスタライズ上限
//   （約32,767デバイスpx）を超えて画面が塗り潰される」既知の破綻を招く
//   （App.jsx の断面図で実際に起きた。commit 08a8e9c 参照）。青天井にはしない。
const BP3_ZOOM_MIN = 0.02, BP3_ZOOM_MAX = 400;
// 📷で寄せるときの補間時間[ms]。他の窓の寄せ（App の focusWorldPos の DURATION）と同じ長さ
const BP3_FOCUS_MS = 600;
// 緩急（ease-in-out）。カメラの補間はすべてこれを使う（App の focusWorldPos と同じ式）
function _bp3EaseInOut(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }
// 建物エディタは機器名ラベルを**隠さない**（14.61 ユーザー決定）。
// 大きさ・色・フチは panelDrawCore.js の PDC_LABEL が唯一の定義で、全ウィンドウ共通。
// ここで違うのは「隠すか隠さないか」だけ
// 【2026-09-15 ユーザー裁定で撤回】旧「隠さない」（14.61）。全図共通で「近づいたら出す」（画面px/m で判定・core の PDC_LABEL.PPM_FULL）
const BP3_LABEL_ALWAYS_SHOW = false;
// 小さすぎる機器でも掴めるようにする、画面px基準の最低当たり判定。
// 【なぜ要るか】0.3m角の機器は通常の倍率で数pxしかなく、ポリゴン内判定では事実上掴めない。
// 「見える大きさ」と「掴める大きさ」を別に決める（盤ラベルで学んだのと同じ分け方）。
const BP3_ICON_MIN_HIT_PX = 14;

// 読み込まれているコードの版を確認するための目印。
// 3Dタブを開いたときにコンソールへ1行出る。これが出ない＝古いコードが動いている
const BP3_VERSION = 'BuildingPreview3D v17 (同じ壁の帯を交差扱いしない)';

// 壁を「高さの帯」に分ける（描画専用。データは変更しない）。
//
// 【平面方向の分割はここではやらない】
// 交差の前後関係は、配電盤と同じ「3Dの面を他の板の中央平面でクリップする」方式
// （pdcSplitFaceGroups）で解決する。2Dの線分をどれだけ精密に切っても、
// 1枚の面が奥行き方向に広がる限り平均depthでは順序が決まらないため
// 原理的に解決しない（2026-08-21 監査結論。3回作り直した末の結論）。
//
// 【高さ帯だけはここで分ける必要がある】
// 高さ4mの壁を高さ3mの壁が横切る場合、交差しているのは 0〜3m だけ。
// 中央平面クリップは平面の話なので高さを見ない。帯に分けておかないと
// 交差していない 3〜4m にも継ぎ目が生まれ、連続した壁に線が入る。
//
// 戻り値の仕切りに付く印:
//   _zB / _zT : この破片の高さ範囲（帯）
function _bp3SegIntersectT(p, q) {
  // 線分p上の位置t(0..1)を返す。交わらない/平行ならnull
  const rx = p.b.x - p.a.x, ry = p.b.y - p.a.y;
  const sx = q.b.x - q.a.x, sy = q.b.y - q.a.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null; // 平行または同一直線
  const qpx = q.a.x - p.a.x, qpy = q.a.y - p.a.y;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  const E = 1e-9;
  if (u < -E || u > 1 + E) return null;   // 相手の線分の外
  return t;
}

// 機器の局所座標での外接直方体。ラベルの大きさをその機器の「見かけの大きさ」に
// 追従させるために使う（描画時に8隅を投影して幅・高さを測る）。
// 面の断片から測ると、壁で分割されるたびにラベルの大きさが変わってしまう。
// {x,y,z} と {wx,wy,wz} の両方の書き方を受ける（床置きと壁付けで作り方が違うため）
function _bp3LocalBox(pts) {
  if (!pts || !pts.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    const x = p.x != null ? p.x : p.wx, y = p.y != null ? p.y : p.wy, z = p.z != null ? p.z : p.wz;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return Number.isFinite(x0) ? { x0, y0, z0, x1, y1, z1 } : null;
}
// 外接直方体の8隅（投影して画面上の大きさを測るため）
function _bp3BoxCorners(b) {
  const out = [];
  for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1])
    out.push({ wx: x, wy: y, wz: z });
  return out;
}

// ラベルを押して動かさずに離したら機器を選ぶか（段階フラグ。false で従来＝陽性対照）
function _bp3LabelClickSelects() {
  return !(typeof window !== 'undefined' && window.__BP3_LABEL_CLICK_SELECTS === false);
}

// 平らな面を、そのまま包む「向きを持つ直方体(OBB)」にする。
// 【なぜ軸に沿った外接箱では駄目か】壁は斜めを向くので、軸に沿った箱にすると
// 実際よりずっと太った箱になり、離れているのに「重なっている」と判定されて
// 前後が決まらなくなる（＝いちばん直したい「盤に接している壁」で効かない）。
// 面の法線を1軸、面内の辺を1軸に取れば、平面にぴったり張り付いた箱になる。
function _bp3FragOBB(pts) {
  if (!pts || pts.length < 3) return null;
  // 法線（Newell法）。drawList の点は wx/wy/wz なのでここで直に計算する
  // （_bp3FaceNormal は x/y/z 用。写し替えを毎フレーム作らない）
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a.wy - b.wy) * (a.wz + b.wz);
    ny += (a.wz - b.wz) * (a.wx + b.wx);
    nz += (a.wx - b.wx) * (a.wy + b.wy);
  }
  const nl = Math.hypot(nx, ny, nz);
  if (!(nl > 1e-12)) return null;
  const w = { x: nx / nl, y: ny / nl, z: nz / nl };
  // 面内の向きを1本取る（いちばん長い辺を使う＝数値に強い）
  let u = null, best = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = { x: b.wx - a.wx, y: b.wy - a.wy, z: b.wz - a.wz };
    const L = Math.hypot(d.x, d.y, d.z);
    if (L > best) { best = L; u = { x: d.x / L, y: d.y / L, z: d.z / L }; }
  }
  if (!u) return null;
  const v = { x: w.y * u.z - w.z * u.y, y: w.z * u.x - w.x * u.z, z: w.x * u.y - w.y * u.x };
  const vl = Math.hypot(v.x, v.y, v.z);
  if (vl < 1e-9) return null;
  v.x /= vl; v.y /= vl; v.z /= vl;
  const ax = [u, v, w];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      const t = p.wx * ax[k].x + p.wy * ax[k].y + p.wz * ax[k].z;
      if (t < lo[k]) lo[k] = t; if (t > hi[k]) hi[k] = t;
    }
  }
  const mid = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
  return {
    c: { x: mid[0] * ax[0].x + mid[1] * ax[1].x + mid[2] * ax[2].x,
         y: mid[0] * ax[0].y + mid[1] * ax[1].y + mid[2] * ax[2].y,
         z: mid[0] * ax[0].z + mid[1] * ax[1].z + mid[2] * ax[2].z },
    ax, h: [0, 1, 2].map(k => Math.max((hi[k] - lo[k]) / 2, 0)),
  };
}
// 画面上の外接矩形が重なるか。重ならない面とは前後を比べる意味が無いので先に捨てる
function _bp3SBOverlap(a, b) {
  return !!a && !!b && a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}
function _bp3ScreenBox(sp) {
  if (!sp || !sp.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sp) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
                        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

// ══ 立体の面を「対ごとの前後」で並べる（建物エディタの並べ方の本体）・2026-09-13 ══
// list: drawList の要素（{ sp: 画面座標, depth: 手前度（大きいほど手前）, poly, idx }）
// dir : 手前向きの単位ベクトル（局所座標 wx,wy,wz と同じ軸）
// 【面×面】bdoPolyPairOrder＝「相手の頂点が自分の平面のどちら側か」で確定する（正射影で厳密）。
//   代表点の深度は使わない。以前は面の中心の深度で並べており、壁に貼った機器の真後ろに残る
//   縦長の壁の帯（中心が機器より高い）が見下ろしで手前と判定され、機器の正面を覆っていた。
// 【決まらない組】跨ぐ・同一平面の組だけ、種類の順（床<部屋<壁<扉<機器）→ 深度で決める。
// 【強制の辺】扉は自分の壁の全ての面より後／壁・扉に貼った機器は取り付け先の全ての面より後。
//   3次元図の規則「取り付けた物は取り付け先に隠されない」（2026-09-13 ユーザー裁定）と同じ。
// 【間引き】画面の外接矩形が重ならない組は辺を張らない（前後が見た目に効かない）。
function _bp3PairOrder(list, dir) {
  const n = list.length;
  if (n < 2) return list.slice();
  const pts3 = new Array(n), planes = new Array(n), sbs = new Array(n), near = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = list[i], p = e.poly;
    // 頂点と平面はカメラに依らないので、面ごとに1回だけ作る（面は scene が作り直すまで同じ物）
    if (!p._p3) { p._p3 = (p.pts || []).map(q => ({ x: q.wx, y: q.wy, z: q.wz })); p._pl = bdoPolyPlane(p._p3); }
    pts3[i] = p._p3; planes[i] = p._pl; sbs[i] = _bp3ScreenBox(e.sp); near[i] = e.depth;
  }
  const wallFaces = new Map(), doorFaces = new Map();
  for (let i = 0; i < n; i++) {
    const p = list[i].poly;
    if (p.iconId != null) continue;
    const m = p.layer === LAYER.DOOR && p.doorId != null ? [doorFaces, p.doorId]
            : p.layer === LAYER.WALL && p.partId != null ? [wallFaces, p.partId] : null;
    if (!m) continue;
    if (!m[0].has(m[1])) m[0].set(m[1], []);
    m[0].get(m[1]).push(i);
  }
  const forced = [];
  for (let k = 0; k < n; k++) {
    const p = list[k].poly;
    if (p.iconId == null && p.layer === LAYER.DOOR && p.partId != null) {
      for (const w of (wallFaces.get(p.partId) || [])) forced.push([w, k]);
    }
    const h = p.mountHost;
    if (!h) continue;
    for (const w of ((h.kind === 'door' ? doorFaces : wallFaces).get(h.id) || [])) forced.push([w, k]);
  }
  const order = bdoTopoOrder(n, (i, j) => {
    if (!_bp3SBOverlap(sbs[i], sbs[j])) return null;
    const r = bdoPolyPairOrder(pts3[i], pts3[j], dir, planes[i], planes[j]);
    if (r !== 0) return r;
    const li = list[i].poly.layer || 0, lj = list[j].poly.layer || 0;
    if (li !== lj) return li < lj ? -1 : 1;
    return 0;
  }, near, forced);
  return order.map(i => list[i]);
}

// 3D多角形の外向き法線（Newell法）
function _bp3FaceNormal(verts) {
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    ax += (a.y - b.y) * (a.z + b.z);
    ay += (a.z - b.z) * (a.x + b.x);
    az += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(ax, ay, az) || 1;
  return { nx: ax / l, ny: ay / l, nz: az / l };
}

function _bp3SplitPartitions(parts, floor) {
  const ZE = 1e-6;
  const zRange = (p) => {
    // 下端の高さ(baseM)を持つ壁がある。床に接しているとは限らない
    const zB = (floor ? floor.levelZ : 0) + (p.baseM || 0);
    const h = p.heightM != null ? p.heightM : (floor ? floor.heightM : 0);
    return { zB, zT: zB + h };
  };
  const out = [];
  parts.forEach((p, pi) => {
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    const pz = zRange(p);
    if (len < 1e-9) { out.push(p); return; }
    const MIN_T = 0.5 / len;

    // 実際に交差している相手の「高さの重なり」を集める
    const zs = [pz.zB, pz.zT];
    parts.forEach((q, qi) => {
      if (qi === pi) return;
      const t = _bp3SegIntersectT(p, q);
      if (t == null || t <= MIN_T || t >= 1 - MIN_T) return;
      const qz = zRange(q);
      const lo = Math.max(pz.zB, qz.zB), hi = Math.min(pz.zT, qz.zT);
      if (hi - lo <= ZE) return; // 高さが重なっていない＝交差していない
      zs.push(lo); zs.push(hi);
    });
    if (zs.length === 2) { out.push({ ...p, _zB: pz.zB, _zT: pz.zT }); return; }

    zs.sort((m, n) => m - n);
    for (let i = 0; i < zs.length - 1; i++) {
      if (zs[i + 1] - zs[i] > ZE) out.push({ ...p, _zB: zs[i], _zT: zs[i + 1] });
    }
  });
  return out;
}

// 描画レイヤー。深度だけで並べると、床(z=levelZ)と部屋の色(z=levelZ+0.03)のように
// ほぼ同じ高さのものは、角度がわずかに変わるだけで前後が入れ替わり、
// 「見る角度によって色や壁の表示が切り替わる」不具合になる（ユーザー指摘）。
// 種類ごとに描く順番を固定し、同じレイヤー内だけ深度で並べることで安定させる。
// 【モジュール直下に置く】ヒット判定（_bp3HitWall）からも参照するため
// ICON は壁の面に貼るものなので、壁・扉より必ず手前でないと埋まって見えない
// SPACE = 階の空間（床を選んだときだけ出す半透明の箱）。床の上・部屋の下に描く。
// **小数のまま _rung に渡すと立体（壁・扉・機器）の段へ吸い込まれる**ので、
// 下の _rung にも必ず書く（Codex監査指摘）
const LAYER = { FLOOR: 0, SPACE: 0.5, ROOM: 1, WALL: 2, DOOR: 3, ICON: 4, SHELL: 5 };
const BP3_HOT_LINE_W = 3; // ホバー/選択の縁取りの太さ（壁も床も同じ）

// ── 3Dで壁を拾う ──
// 描画で作った画面座標(drawList)をそのまま使い、手前から順に point-in-polygon する。
// Zバッファは持ち込まない（spec 11章の確定方針）。
// 【WALLレイヤーだけを対象にする】描画順は「レイヤー→深度」なので、素朴に手前から
// 探すと半透明のガワや床の色分けが先に当たり、壁を掴めなくなる（監査指摘）
// 点が多角形の内側か。実体は buildingCore.js の bcPointInPoly（2Dのヒット判定と共用）
const _bp3PointInPoly = (pts, x, y) => bcPointInPoly(pts, x, y);
// 点と線分の距離（画面px）
function _bp3DistToSeg(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2));
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
}
// 真上から見ると壁は「厚み×長さ」のほぼ線になり、面の内側だけを判定すると
// 高い精度を要求されて掴めない（ユーザー指摘）。2Dと同じく**画面px の許容幅**を持たせる
const BP3_HIT_TOL_PX = 10; // 2D の HIT_TOL_PX と同値
// ギズモ（●/◆ハンドル）のヒット判定。12px以内でいちばん近いものを返す。
// 「押したとき」と「カーソルの形を決めるとき」の2箇所から呼ぶので1本にまとめる
// （pointerdown の中にだけ書いてあったため、ハンドルの上でも手の形にならなかった）
function _bp3HitGizmo(gz, mx, my) {
  if (!gz || !gz.list || !gz.list.length) return null;
  let best = null, bestD = BC_UI.gizmo.hitPx;
  gz.list.forEach(h => {
    const d = Math.hypot(mx - h.s.x, my - h.s.y);
    if (d <= bestD) { bestD = d; best = h; }
  });
  return best;
}
// 扉のヒット判定。扉は壁の中にあるので**壁より先に**見ないと永久に選べない
// （優先順位: ギズモ ＞ 扉 ＞ 壁 ＞ 床。2D側も同じ順序にしてある）
function _bp3HitDoor(cache, x, y) {
  if (!cache || !cache.list || !cache.list.length) return null;
  const L = cache.list;
  for (let i = L.length - 1; i >= 0; i--) { // 描画の逆順＝手前から
    const p = L[i].poly;
    if (p.layer !== LAYER.DOOR || p.doorId == null) continue;
    if (_bp3PointInPoly(L[i].sp, x, y)) {
      return { doorId: p.doorId, partId: p.partId, floorId: p.floorId, floorZ: p.floorZ };
    }
  }
  return null;
}
// 【押した点そのもの】投影された面の上のカーソル位置を、3Dのローカル座標へ戻す。
// 正射影なので、面の3頂点 P0,P1,P2 と その投影 S0,S1,S2 について
//   カーソル = S0 + a(S1-S0) + b(S2-S0)
// を解いた (a,b) をそのまま 3D 側へ当てれば厳密に求まる。
// 面が画面上で線に潰れている（行列式が小さい）ときは諦めて null を返す。
// 四角形以上は「S0を共有する三角形」を順に試し、カーソルが入るものを使う
const BP3_TRI_DET_EPS = 1e-6;
function _bp3PointOnPoly(item, x, y) {
  const S = item.sp, P = item.poly.pts;
  if (!S || S.length < 3) return null;
  for (let k = 1; k + 1 < S.length; k++) {
    const e1x = S[k].x - S[0].x, e1y = S[k].y - S[0].y;
    const e2x = S[k+1].x - S[0].x, e2y = S[k+1].y - S[0].y;
    const det = e1x * e2y - e1y * e2x;
    if (Math.abs(det) < BP3_TRI_DET_EPS) continue;
    const rx = x - S[0].x, ry = y - S[0].y;
    const a = (rx * e2y - ry * e2x) / det;
    const b = (e1x * ry - e1y * rx) / det;
    // その三角形の中（数値誤差ぶんだけ緩める）。四角形は2枚に割って両方試す
    if (a < -1e-6 || b < -1e-6 || a + b > 1 + 1e-6) continue;
    return {
      wx: P[0].wx + a * (P[k].wx - P[0].wx) + b * (P[k+1].wx - P[0].wx),
      wy: P[0].wy + a * (P[k].wy - P[0].wy) + b * (P[k+1].wy - P[0].wy),
      wz: P[0].wz + a * (P[k].wz - P[0].wz) + b * (P[k+1].wz - P[0].wz),
    };
  }
  return null;
}
// カーソルの下にある面の「その点」を返す。優先順位はヒット判定と同じ
function _bp3PivotUnderCursor(cache, x, y) {
  if (!cache || !cache.list) return null;
  const L = cache.list;
  for (const layer of [LAYER.ICON, LAYER.DOOR, LAYER.WALL, LAYER.FLOOR]) {
    for (let i = L.length - 1; i >= 0; i--) {
      const it = L[i];
      if (it.poly.layer !== layer) continue;
      if (!_bp3PointInPoly(it.sp, x, y)) continue;
      const p = _bp3PointOnPoly(it, x, y);
      if (p) return p;
    }
  }
  return null;
}

// 回転の中心（ピボット）。選んでいるものの頂点平均をローカル座標で返す。
// 【なぜ頂点平均か】描画リストは投影の元データ（ローカル座標）をそのまま持っているので、
// 幾何をもう1つ別に持たずに済む。優先順位は 機器 → 扉 → 壁 → 床。
// 何も選んでいなければ null を返し、従来どおり全体の中心まわりに回る
function _bp3PivotOf(cache, sel) {
  if (!cache || !cache.list || !sel) return null;
  const order = [
    ['iconId', (p) => p.iconId != null && p.iconId === sel.iconId],
    ['doorId', (p) => p.doorId != null && p.doorId === sel.doorId],
    ['partId', (p) => p.layer === LAYER.WALL && p.partId != null && p.partId === sel.partId],
    ['floorId', (p) => p.layer === LAYER.FLOOR && p.floorId != null && p.floorId === sel.floorId],
  ];
  for (const [key, match] of order) {
    if (sel[key] == null) continue;
    let wx = 0, wy = 0, wz = 0, n = 0;
    for (const it of cache.list) {
      if (!match(it.poly)) continue;
      for (const q of it.poly.pts) { wx += q.wx; wy += q.wy; wz += q.wz; n++; }
    }
    if (n) return { wx: wx / n, wy: wy / n, wz: wz / n };
  }
  return null; // 選択が消えた・非表示階などのときは従来の中心へ戻る
}

// 画面のドラッグ量Δを、面の上の2軸 U/V の成分（ds, dt）[m] に分解する。
//   Δ = ds*U + dt*V を解くだけ。正射影なのでこれで厳密にカーソルと一致する。
// 【なぜ1本にするか】1自由度のギズモは「軸の画面ベクトルへ内積で射影」している。
// 2自由度も同じ考え方の素直な拡張。別の方式（床面への逆投影）を混ぜると、
// 高さのあるものでカーソルとずれる（2026-08-28 ユーザー指摘）
// 2軸の張り具合。|det| = |U||V|sinθ なので、閾値も軸長で正規化して「角度」で見る
// （det の生の大きさはズーム倍率で変わるため、絶対値で比べると倍率依存になる）
const BP3_UV_DET_EPS = 1e-3; // 2軸がほぼ平行＝面が線に潰れている
// 画面上でこれ未満に潰れた軸は使わない。真上から見た壁の鉛直軸がこれに当たる。
// 1px 動かすと巨大な移動量になってしまうため、その軸は捨てて片軸で解く
const BP3_UV_MIN_AXIS_PX = 3;
function _bp3SolveUV(d, e) {
  const U = d.U, V = d.V;
  if (!U || !V) return null;
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  const det = U.x * V.y - U.y * V.x;
  const lu = Math.hypot(U.x, U.y), lv = Math.hypot(V.x, V.y);
  // 【片方が潰れていたら、その軸だけ捨てる・2026-09-01】
  //   階編集モードのカメラは el ≈ -90°（真上）。壁面の機器の2軸は
  //   「壁に沿って1m（水平）」と「真上に1m（鉛直）」なので、真上から見ると
  //   **鉛直軸が画面上でほぼ長さ0**に潰れる。
  //   このまま2軸で連立すると高さ側が発散し、壁沿いの成分はほぼ0になって
  //   「掴めるのに動かない」状態になった（ユーザー報告）。
  //   ★全部を棄却すると「動かせない」になる。生きている軸だけで解くこと
  //   （範囲外を棄却して永久ロックした中ボタンの件と同じ型の誤り）。
  // 2軸とも十分な長さがあり、かつ平行でなければ普通に連立して解く
  if (lu >= BP3_UV_MIN_AXIS_PX && lv >= BP3_UV_MIN_AXIS_PX
      && isFinite(det) && Math.abs(det) >= BP3_UV_DET_EPS * lu * lv) {
    return { ds: (dx * V.y - dy * V.x) / det, dt: (U.x * dy - U.y * dx) / det };
  }
  // 【閾値は「2軸で解くか1軸で解くか」の判断にだけ使う】
  //   これで移動そのものを棄却してはいけない。長い方の軸が少しでも使えるなら動かす。
  //   （低倍率で全部棄却すると、また「動かせない」に戻る）
  if (lu >= lv && lu > 1e-9) return { ds: (dx * U.x + dy * U.y) / (lu * lu), dt: 0 };
  if (lv > 1e-9) return { ds: 0, dt: (dx * V.x + dy * V.y) / (lv * lv) };
  return null;   // 2軸とも長さ0＝投影が縮退。ここは動かしようがない
}
// 壁面の機器アイコン。扉よりさらに手前にあるので、扉より先に見る
function _bp3HitIcon(cache, x, y) {
  if (!cache || !cache.list || !cache.list.length) return null;
  const L = cache.list;
  const ret = (p) => ({ iconId: p.iconId, partId: p.partId, floorId: p.floorId, floorZ: p.floorZ,
                        at: p.labelAt, axisSAt: p.axisSAt, axisTAt: p.axisTAt });
  // ① まずは素直にポリゴン内で判定する（重なりの前後を尊重するため手前から）
  for (let i = L.length - 1; i >= 0; i--) {
    const p = L[i].poly;
    if (p.layer !== LAYER.ICON || p.iconId == null) continue;
    if (_bp3PointInPoly(L[i].sp, x, y)) return ret(p);
  }
  // ② 画面上で小さすぎる機器は、ポリゴン内判定では事実上掴めない（0.3m角なら数px）。
  //    そういう機器に限り、中心からの距離で拾う。最も近いものを1つだけ返す。
  //    【小さいものだけに効かせる】大きい機器にも効かせると、隣を掴んだつもりが
  //    別の機器に持っていかれる。あくまで「クリックできない」を救うための下限。
  let best = null, bestD = Infinity;
  for (let i = L.length - 1; i >= 0; i--) {
    const p = L[i].poly;
    if (p.layer !== LAYER.ICON || p.iconId == null) continue;
    const sp = L[i].sp;
    if (!sp || !sp.length) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cx = 0, cy = 0;
    for (const q of sp) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      cx += q.x; cy += q.y;
    }
    cx /= sp.length; cy /= sp.length;
    if (Math.max(x1 - x0, y1 - y0) >= BP3_ICON_MIN_HIT_PX) continue;   // 十分大きい＝①で足りる
    const d = Math.hypot(x - cx, y - cy);
    if (d <= BP3_ICON_MIN_HIT_PX / 2 && d < bestD) { bestD = d; best = p; }
  }
  return best ? ret(best) : null;
}
// ── ガワ（建物の外殻）の面を拾う ──
// 半透明で大きいので **いちばん最後** に見る（先に見ると床・壁・扉・機器を掴めなくなる。
// 優先順位は ギズモ ＞ 機器 ＞ 扉 ＞ 壁 ＞ 床 ＞ ガワ）
function _bp3HitShell(cache, x, y) {
  if (!cache || !cache.list || !cache.list.length) return null;
  const L = cache.list;
  for (let i = L.length - 1; i >= 0; i--) {   // 描画の逆順＝手前から
    const p = L[i].poly;
    if (p.layer !== LAYER.SHELL || !p.shellFaceId) continue;
    if (_bp3PointInPoly(L[i].sp, x, y)) {
      return { shellFaceId: p.shellFaceId, blockIdx: p.blockIdx, faceType: p.faceType, edgeIdx: p.edgeIdx };
    }
  }
  return null;
}
// 選択中のガワの面の上の点を、グリッド座標(x,y)＋メートル(z)で返す。
// 画面→面の逆投影は _bp3PointOnFace（面の投影と3D頂点のアフィン対応）を使う。
function _bp3ShellPointAt(cache, x, y, faceId, requireInside) {
  if (!cache || !cache.list || !faceId) return null;
  const L = cache.list;
  for (let i = L.length - 1; i >= 0; i--) {
    const p = L[i].poly;
    if (p.layer !== LAYER.SHELL || p.shellFaceId !== faceId || !p.faceVerts) continue;
    // ドラッグ中は面の外へ出ても、その面の**平面上の点**として解く（矩形が途切れない）
    if (requireInside !== false && !_bp3PointInPoly(L[i].sp, x, y)) continue;
    const gv = p.faceVerts.map(v => ({ wx: v.x, wy: v.y, wz: v.z }));
    const r = _bp3PointOnFace(L[i].sp, gv, x, y);
    if (!r) return null;
    return { x: r.wx, y: r.wy, z: r.wz, poly: p };
  }
  return null;
}
// 壁の面の上で、対角2点から「辺に沿った矩形」の4隅を作る。
// 壁は [下左, 下右, 上右, 上左] の並びなので、u=辺の方向（水平）・v=高さ(z) で素直に取れる。
function _bp3WallRectCorners(faceVerts, a, b) {
  if (!faceVerts || faceVerts.length < 3 || !a || !b) return null;
  const o = faceVerts[0], q = faceVerts[1];
  const ex = q.x - o.x, ey = q.y - o.y, L = Math.hypot(ex, ey);
  if (!(L > 1e-6)) return null;                    // 水平な面（屋根・床）はここでは扱わない
  const ux = ex / L, uy = ey / L;
  const uOf = (p) => (p.x - o.x) * ux + (p.y - o.y) * uy;
  const u0 = Math.min(uOf(a), uOf(b)), u1 = Math.max(uOf(a), uOf(b));
  const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
  const Pt = (u, z) => ({ x: o.x + u * ux, y: o.y + u * uy, z });
  return { corners: [Pt(u0, z0), Pt(u1, z0), Pt(u1, z1), Pt(u0, z1)],
           u0, u1, z0, z1, edgeLen: L, origin: o, ux, uy };
}
function _bp3HitWall(cache, x, y) {
  if (!cache || !cache.list || !cache.list.length) return null; // 初回フレーム前・寸法未確定
  const L = cache.list;
  const ret = (p) => ({ floorId: p.floorId, partId: p.partId, floorZ: p.floorZ });
  for (let i = L.length - 1; i >= 0; i--) { // 描画の逆順＝手前から
    const p = L[i].poly;
    if (p.layer !== LAYER.WALL || p.partId == null) continue;
    if (_bp3PointInPoly(L[i].sp, x, y)) return ret(p);
  }
  // 面の内側で当たらなければ、許容幅の中でいちばん近い壁を拾う
  let best = null, bestD = BP3_HIT_TOL_PX;
  for (let i = L.length - 1; i >= 0; i--) {
    const p = L[i].poly;
    if (p.layer !== LAYER.WALL || p.partId == null) continue;
    const sp = L[i].sp;
    for (let k = 0; k < sp.length; k++) {
      const q0 = sp[k], q1 = sp[(k + 1) % sp.length];
      const d = _bp3DistToSeg(x, y, q0.x, q0.y, q1.x, q1.y);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best ? ret(best) : null;
}
// 床（スラブ）を拾う。3Dで階をクリックして選ぶために使う
function _bp3HitFloor(cache, x, y) {
  if (!cache || !cache.list || !cache.list.length) return null;
  const L = cache.list;
  for (let i = L.length - 1; i >= 0; i--) {
    const p = L[i].poly;
    if (p.layer !== LAYER.FLOOR || p.floorId == null) continue;
    if (_bp3PointInPoly(L[i].sp, x, y)) return { floorId: p.floorId };
  }
  return null;
}
// 点が壁の胴体（側面が囲む領域）の中にあるか。
// 【向きに依存させない】面の法線は頂点の巻き方向まかせで内向きにも外向きにもなる。
// 「すべて負なら内側」と決め打ちすると、内向きのときに一度も成立しない
// （2026-08-26 実測: 符号付き距離がすべて正で、交差部の重なりが消えなかった）。
// その壁自身の中心と同じ側にあるか、で判定すれば向きに依存しない
function _bp3InsideBody(pt, g, eps) {
  const c = g.bodyCenter;
  if (!c || !g.bodyPlanes) return false;
  return g.bodyPlanes.every(pl => {
    const dp = pt.x * pl.nx + pt.y * pl.ny + pt.z * pl.nz - pl.d;
    const dc = c.x * pl.nx + c.y * pl.ny + c.z * pl.nz - pl.d;
    if (Math.abs(dp) <= eps) return true;       // 面の上は「中」とみなす
    return (dp > 0) === (dc > 0);               // 中心と同じ側なら内側
  });
}

// 寸法ラベル。配電盤 PanelCanvas3D の _drawDimLabel と同じ見た目に揃える（spec 7.10）
function _bp3DrawDimLabel(ctx, sx, sy, text) {
  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  const tw = ctx.measureText(text).width;
  const pw = 6, bh = 17, bw = tw + pw * 2;
  const bx = sx - bw / 2, by = sy - bh / 2;
  const rr = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  };
  ctx.fillStyle = 'rgba(15,23,42,0.88)'; rr(bx, by, bw, bh, 3); ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,184,0.5)'; ctx.lineWidth = 1; rr(bx, by, bw, bh, 3); ctx.stroke();
  ctx.fillStyle = '#F1F5F9';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, sx, sy);
  ctx.restore();
}

// 図面を触ったら数値欄の編集を終える。
// 入力欄にフォーカスが残ったままだと Ctrl+Z / Delete が入力欄ガードに弾かれる
function _bp3BlurField() {
  const ae = document.activeElement;
  if (!ae || ae === document.body) return;
  const tag = (ae.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') ae.blur();
}

// カーソルを「高さ floorZ の水平面」へ逆投影してグリッド座標で返す
function _bp3CursorOnFloor(e, cv, cam, scene, floorZ) {
  const cW = cv.clientWidth, cH = cv.clientHeight;
  if (!cW || !cH) return null; // 寸法未確定（既知の罠: タブ切替直後は0）
  const rect = cv.getBoundingClientRect();
  const u = unproject3DPanelOnZ(
    e.clientX - rect.left, e.clientY - rect.top, scene.toLocalZ(floorZ),
    scene.W, scene.H, scene.D, cam.az, cam.el, cam.zoom, cam.panX, cam.panY, cW, cH);
  if (!u || u.degenerate) return null; // ほぼ真横。ここで掴ませない（掴めても直感に反する）
  return scene.toGrid(u.x, u.y);
}

// ══ クリックした「面の上の点」を出す・2026-09-06 ══
// 【症状】扉に機器を置くと手前の面ではなく**裏面**に付く。置いた位置もカーソルとずれる。
// 【原因】置く点をいつも「床の高さの水平面」へ逆投影していた（_bp3CursorOnFloor）。
//   扉のような**垂直な面**をクリックすると、光線はそのまま床まで抜けて
//   **壁の向こう側**に着地する。だから
//     ・表裏(side)が反転する → 裏面に付く
//     ・面に沿った位置(sM)もずれる → カーソル位置に置かれない
//   高い所をクリックするほど、カメラを倒すほど大きくずれる。1つの原因で2つの症状。
// 【直し方】クリックした面そのものとの交点を取る。正射影なので、面の3頂点と
//   その投影から一次の対応（アフィン）が作れ、逆に解けば厳密に求まる。
function _bp3PointOnFace(sp, pts, px, py) {
  if (!sp || sp.length < 3 || !pts || pts.length < 3) return null;
  // 面内で一次独立な3点を選ぶ（細長い面でも潰れないよう、いちばん広い組を採る）
  let bi = 1, ci = 2, best = -1;
  for (let i = 1; i < sp.length; i++) {
    for (let j = i + 1; j < sp.length; j++) {
      const d = Math.abs((sp[i].x - sp[0].x) * (sp[j].y - sp[0].y)
                       - (sp[j].x - sp[0].x) * (sp[i].y - sp[0].y));
      if (d > best) { best = d; bi = i; ci = j; }
    }
  }
  const det = (sp[bi].x - sp[0].x) * (sp[ci].y - sp[0].y)
            - (sp[ci].x - sp[0].x) * (sp[bi].y - sp[0].y);
  if (!(Math.abs(det) > 1e-9)) return null;      // 真横から見た面。ここでは置かせない
  const rx = px - sp[0].x, ry = py - sp[0].y;
  const u = (rx * (sp[ci].y - sp[0].y) - (sp[ci].x - sp[0].x) * ry) / det;
  const v = ((sp[bi].x - sp[0].x) * ry - rx * (sp[bi].y - sp[0].y)) / det;
  const A = pts[0], B = pts[bi], C = pts[ci];
  return {
    wx: A.wx + u * (B.wx - A.wx) + v * (C.wx - A.wx),
    wy: A.wy + u * (B.wy - A.wy) + v * (C.wy - A.wy),
    wz: A.wz + u * (B.wz - A.wz) + v * (C.wz - A.wz),
  };
}
// 画面のある点を覆っている「壁または扉の面」のうち、いちばん手前のものを返す
function _bp3FaceUnderCursor(list, px, py) {
  if (!list) return null;
  const inside = (sp) => {
    let c = false;
    for (let i = 0, j = sp.length - 1; i < sp.length; j = i++) {
      if (((sp[i].y > py) !== (sp[j].y > py))
        && (px < (sp[j].x - sp[i].x) * (py - sp[i].y) / (sp[j].y - sp[i].y) + sp[i].x)) c = !c;
    }
    return c;
  };
  // list は「奥→手前」に並んでいるので、後ろから見た最初の1枚がいちばん手前
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i], p = e.poly;
    if (!p || (!p.partId && !p.doorId)) continue;      // 壁・扉の面だけが対象
    if (p.layer !== LAYER.WALL && p.layer !== LAYER.DOOR) continue;
    if (!e.sp || e.sp.length < 3 || !inside(e.sp)) continue;
    const q = _bp3PointOnFace(e.sp, p.pts, px, py);
    if (!q) continue;
    return { ...q, partId: p.partId || null, doorId: p.doorId || null };
  }
  return null;
}

function BuildingPreview3D({ building, floorId, pnDeg = 0, setPnDeg = null,
                             onGrabWall = null, onDragWall = null, previewPart = null,
                             // 【扉】選択・ホバー・スライド中のプレビュー。壁と同じ扱いにする
                             selDoorId = null, hoverDoorId = null, previewDoor = null,
                             onSelectDoor = null, onDragDoor = null,
                             // 【機器アイコン・Phase C】扉とまったく同じ扱い
                             selIconId = null, hoverIconId = null, previewIcon = null,
                             onSelectIcon = null, onDragIcon = null,
                             // 【回転】床置きの箱を回す。移動（onDragIcon）とは別の操作にする。
                             // 渡すのは画面上のカーソル角の差分(度)だけ。向きへの変換と符号は親が決める
                             onRotateIcon = null,
                             // 【名称ラベルの移動】3次元図・平面図と同じくラベルを掴んで動かせるようにする。
                             // 渡すのは「画面px ÷ カメラzoom」のずらし量。保存先は親が決める
                             onDragLabel = null,
                             // 【📷】選んでいる機器・盤へ他のビューを寄せる。建屋のカメラマークと同じ役目
                             onFocusIcon = null,
                             // 【床置きの箱・Phase D】floor.icons には入らない別モデル（配置済み配電盤）を
                             // 「床置き機器と同じ形の箱」として受け取り、同じ1ループで描く。
                             // 各要素は floorId を持ち、どの階に載っているかは呼び出し側が決めている
                             extraBoxes = null,
                             // 【階編集モード】null=通常の3D / 階ID=その階だけを見せる（spec 14.2）
                             editFloorId = null, onSelectFloor = null, editHeader = null,
                             // 選択とホバーは同じ見た目にする（spec 12.1）。
                             // selFloorHiId は「クリックで選んだ床」であって「編集中の階」ではない。
                             // 混ぜると床が常にオレンジになり、何を選んだのか分からなくなる
                             selPartId = null, selFloorHiId = null, onSelectNone = null,
                             // ガワ（建物の外殻）の面の選択（2026-09-23）
                             selShellFaceId = null, onSelectShellFace = null,
                             // 選んだ面の上でドラッグして描いた矩形（CAD の「面にスケッチ」）
                             onFaceSketchRect = null,
                             // 🏗（ガワの編集）を開いている間は true。ガワの面を最優先で拾う
                             shellMode = false,
                             // 【作図・段階C】3Dのまま壁を引く。
                             // drawTool が入っている間はクリックが作図になり、選択・ドラッグはしない。
                             // drawGhost / drawGuides は「今クリックしたらこうなる」の予告
                             // 【Phase D】配電盤テンプレートのドロップ受け口。
                             // 新しい配置UIは作らず、既存のD&Dの受け口をここにも付ける。
                             // 3D側の責務は「ドロップ位置を床の点へ直す」ことだけ
                             onDropOnFloor = null,
                             drawTool = null, drawFloorZ = 0,
                             onDrawClick = null, onDrawHover = null, onCancelDraw = null,
                             drawGhost = null, drawGuides = null, drawPoly = null, projectorRef = null,
                             // 選択中の壁の端点（グリッド座標＋床の高さ）。2Dと同じ●を出して掴めるようにする
                             selWall = null, onDragGizmo = null,
                             // ドラッグ中に出す寸法（配電盤と同じ見た目）
                             dimLabel = null,
                             // 📷の寄せ先 { bounds(グリッドpx), buildingId, seq }。seq が変わったら今の角度のまま寄せる（2026-09-11）
                             focusReq = null }) {
  useEffect(() => { console.log('[建物エディタ3D] ' + BP3_VERSION); }, []);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  // 配電盤と同じカメラモデル
  // 初期カメラは配電盤エディタ(panelStore.js)とまったく同じ値を使う。
  // 【重要】el は【負】でなければならない（配電盤: el = -π/8「上面がほどよく見える等角投影」）。
  // 正の el は建物を下から見上げる向きになり、その状態では**左右の回転が逆に見える**。
  // ドラッグで el の符号が変わると向きが変わるため「時々まともに動く」ように見えていた
  const camRef = useRef({ az: -Math.PI / 5, el: -Math.PI / 8, zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef(null);
  // 描画時に作った画面座標を保持し、ヒット判定で読む（同じ投影を2度計算しない）
  const drawListRef = useRef(null);
  // 選択中の壁の端点●の画面座標（描画時に作り、ヒット判定で読む）
  const gizmoRef = useRef(null);
  // 選んでいる床置きの箱の回転ハンドル位置。描画で作った画面座標をそのまま当たり判定に使う
  const iconRotRef = useRef(null);
  // 名称ラベルの画面上の位置。掴んで動かすための当たり判定に使う
  const labelHitsRef = useRef([]);
  // 📷（選択中の機器のラベルの右）の押し判定 { cx, cy, r, iconId, partId, floorId }。↻（iconRotRef）とは責務を分ける・2026-09-16
  const camHitRef = useRef(null);
  const prRef = useRef(null); // 最新の投影関数（ポインタ処理から使う）
  // ══ 診断フック __iconDiag()（2026-09-01）══
  // 3Dプレビューは React + canvas でヘッドレス検証ができないので、
  // 実機から「機器を掴める状態か」を1行で取れるようにしておく。読み取り専用。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__iconDiag = () => {
      // ① データ側: この階に登録されている機器を種別ごとに出す
      const fl = ((building && building.floors) || []).find(f => f.id === floorId);
      const data = ((fl && fl.icons) || []).map(ic => ({
        iconId: ic.id, 名前: ic.name,
        種別: ic.doorId ? '扉' : (ic.partitionId ? '壁' : '床置き'),
        partitionId: ic.partitionId || null, doorId: ic.doorId || null,
        位置: ic.partitionId || ic.doorId ? { sM: ic.sM, tM: ic.tM } : { gx: ic.gx, gy: ic.gy, rotDeg: ic.rotDeg },
      }));
      // ② 描画側: 当たり判定に載っているものを iconId でまとめる（箱は複数面に分かれる）
      const L = (drawListRef.current && drawListRef.current.list) || [];
      const byId = new Map();
      for (const q of L) {
        const p = q.poly;
        if (!p || p.iconId == null) continue;
        const e = byId.get(p.iconId) || { iconId: p.iconId, 面数: 0, partId: p.partId,
          layerがICON: false, 掴める: false, 頂点数: [] };
        e.面数++;
        if (p.layer === LAYER.ICON) e.layerがICON = true;
        if (p.labelAt && p.axisSAt && p.axisTAt) e.掴める = true;
        e.頂点数.push((q.sp || []).length);
        byId.set(p.iconId, e);
      }
      const drawn = [...byId.values()];
      // ③ 突き合わせ: データにあるのに当たり判定に載っていない機器＝掴めない
      const missing = data.filter(d => !byId.has(d.iconId));
      return {
        データ上の機器: data,
        当たり判定に載っている機器: drawn,
        '★載っていない機器（掴めない）': missing,
        いまドラッグ中: dragRef.current ? { type: dragRef.current.type, iconId: dragRef.current.iconId,
                                            U: dragRef.current.U, V: dragRef.current.V } : null,
        onDragIconが渡っているか: typeof onDragIcon === 'function',
        投影関数: typeof prRef.current === 'function',
      };
    };
  });
  const lastBuildingIdRef = useRef(null);
  const needFitRef = useRef(true); // マウント直後は必ずフィットする
  // PNはカメラ効果の deps に入れない（PN変更でカメラを動かさない）。向きの計算にだけ使う
  const pnDegRef = useRef(pnDeg);
  pnDegRef.current = pnDeg;
  const keepAngleRef = useRef(false); // フィット時に角度を既定へ戻さない（真上視点の維持用）
  // 【spec 12.1】ホバーは選択のプレビュー。3Dでも「今クリックすると何が選ばれるか」を見せる。
  // sceneは作り直さず描画時に色だけ差し替える（ホバーのたびに再構築すると重い）
  const [hover, setHover] = useState(null); // {kind:'wall'|'floor', partId?, floorId}
  // 選んだ面の上に描いている矩形（CAD の「面にスケッチ」。2026-09-23）
  // {faceId, blockIdx, edgeIdx, a:{x,y,z}, b:{x,y,z}}
  const [faceSketch, setFaceSketch] = useState(null);
  const faceSketchRef = useRef(null);
  const [, forceTick] = useState(0);
  const redraw = useCallback(() => forceTick(t => t + 1), []);
  // 診断（__labelBox）から描き直しを頼めるようにする。読み取り専用の入口
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__bldRedraw = redraw;
    return () => { if (window.__bldRedraw === redraw) delete window.__bldRedraw; };
  }, [redraw]);

  // ── 建物データ → 描画用ポリゴン群（単位はメートルに統一）──
  const scene = useMemo(() => {
    if (!building) return null;
    const mpp = _bcMpp();
    // 【ブロック→立体は唯一の入口 blockSolidsOf を通す・2026-10-03】
    //   ここで blockToSolid を直に呼んでいたため、**このプレビューにだけ**
    //   上面の傾き（片流れ屋根）・掃引（らせん・斜路）・並べた部材（螺旋階段の段板）が
    //   出なかった。3次元図と Cesium は App.jsx の blockSolidsOf を通っていたので出ていた
    //   ＝「同じ意味の処理が2か所に書かれ、片方だけ新しい形を知らない」型の不具合。
    //   blockSolidOf が中で面倒を見るので、ここでは下の2つを**呼ばない**:
    //     ・増築棟の穴（sharedWallOpeningsForBlock）
    //     ・外向き法線の正規化（_normalizeOutward。掃引には掛けてはいけない）
    //   戻り値は配列。並べた部材は1ブロックから複数の立体になる
    const solids = (building.blocks || []).flatMap((blk, i) => blockSolidsOf(building, blk, i) || []);
    if (solids.length === 0) return null;

    // bbox（グリッド→メートル換算。zは既にメートル）
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    solids.forEach(s => s.faces.forEach(f => f.vertices.forEach(v => {
      const X = v.x * mpp, Y = v.y * mpp;
      if (X < minX) minX = X; if (X > maxX) maxX = X;
      if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    })));
    const W = Math.max(maxX - minX, 0.001), D = Math.max(maxY - minY, 0.001), H = Math.max(maxZ - minZ, 0.001);
    // 建物ローカル座標へ（配電盤の wx/wy/wz と同じ意味: 0..W, 0..D, 0..H）
    // 【重要】Y は反転して渡す。project3DPanel は内部で cy = -(wy - D/2) と反転する前提の
    // 座標系（wy=0 が手前）で作られている。建物のグリッドY（北が+）をそのまま渡すと
    // 鏡像になり、**左右の回転方向だけが逆**になる（上下は影響を受けない）。
    // ここで反転しておくことで、配電盤とまったく同じ回転の向きになる
    const toLocal = (gx, gy, z) => ({ wx: gx * mpp - minX, wy: maxY - gy * mpp, wz: z - minZ });

    const polys = []; // {pts:[{wx,wy,wz}], fill, stroke, alpha, layer}
    const addFlat = (points2d, z, fill, stroke, alpha, layer) => {
      if (!points2d || points2d.length < 3) return;
      polys.push({ pts: points2d.map(p => toLocal(p.x, p.y, z)), fill, stroke, alpha, layer });
    };
    // 平面footprintを zB..zT に押し出した角柱（上面＋側面）を追加する
    // alpha は角柱を構成する【全ての面】に適用する（以前は最後の1面にしか効いておらず、
    // 透明仕切りの側面が不透明のままだった）
    // noStroke: 側面のうち輪郭線を引かない辺のindex集合。
    // 交差分割で生まれた「切断端」は壁の輪郭ではないので線を引くと
    // 連続した壁の途中に縦線が入って不自然に見える（ユーザー指摘）
    // opts: 分割で生まれた「内部の辺」を描かないための指定。
    //   cutCorners     : 切断端になった頂点index（その頂点に立つ縦の辺を引かない）
    //   bottomInternal : 下端が高さ帯の切れ目（＝床ではない）→ 下の横辺を引かない
    //   topInternal    : 上端が高さ帯の切れ目（＝壁の天端ではない）→ 上の横辺を引かない
    const addPrism = (points2d, zB, zT, fill, stroke, alpha, layer, opts) => {
      if (!points2d || points2d.length < 3) return;
      const n = points2d.length;
      const o = opts || {};
      const bInt = !!o.bottomInternal, tInt = !!o.topInternal;
      const hasMask = bInt || tInt;
      // 掴むための識別子。壁が floorId/partId を poly に直接載せているのと同じ形にする
      // （ここだけ入れ子にするとヒット判定側が分岐する。Codex監査指摘）
      const ids = o.ids || null;
      for (let i = 0; i < n; i++) {
        const a = points2d[i], b = points2d[(i + 1) % n];
        // 側面の四角の辺: 0=下の横, 1=縦, 2=上の横, 3=縦。
        // 横の辺だけ「高さ帯の切れ目か」で抑制する。縦は交差部の稜線なので常に描く
        const edges = hasMask ? [!bInt, true, !tInt, true] : null;
        polys.push({ ...ids, pts: [toLocal(a.x, a.y, zB), toLocal(b.x, b.y, zB), toLocal(b.x, b.y, zT), toLocal(a.x, a.y, zT)], fill, stroke, edges, alpha, layer });
      }
      // 上面: 帯の切れ目（noCapTop）なら輪郭線を引かない。壁の天端なら引く
      // 上面: 帯の切れ目なら壁の天端ではないので輪郭線を引かない
      polys.push({ ...ids, pts: points2d.map(p => toLocal(p.x, p.y, zT)), fill, stroke: tInt ? null : stroke, alpha, layer });
    };

    // 建物の外殻。**背面カリングはしない**（6面すべて描く）。
    // ガワは半透明で内部が透けている前提なので、奥の辺の白線も見えるのが正しい。
    // 手前3面だけを描くと、どちらの面を見ているのか分からず立体が錯覚を起こす
    // （ユーザー指摘）。2枚重なるぶん濃くなるのでアルファは薄めにする
    // 【階編集モード】ガワは出さない。作業対象の階だけを見せる（spec 14.2）
    if (!editFloorId) {
      solids.forEach(s => {
        const col = s.color || BC_UI.shell;
        s.faces.forEach(f => {
          if (!f.vertices || f.vertices.length < 3) return;
          polys.push({
            pts: f.vertices.map(v => toLocal(v.x, v.y, v.z)),
            fill: col, alpha: BC_UI.shellAlpha, stroke: BC_UI.shellStroke, isShell: true, layer: LAYER.SHELL,
            // 【2026-09-23】面を選べるように識別子を載せる。壁・床・扉・機器と同じ扱いにする
            // 【2026-10-03 Codex監査】並べた部材（螺旋階段の段板など）の**2つ目以降の複製**は
            //   選択対象にしない。複製は元のブロックを回して動かした物なので、その面の
            //   座標・法線・辺番号をそのまま元のブロックへ押し引きすると形が壊れる
            //   （元へ戻す逆変換を持っていない）。見えるが掴めない状態にして入口で塞ぐ。
            //   **1つ目（k=0）は回転0・移動0＝元のブロックそのもの**なので掴める。
            //   ここを「複製すべて」にすると螺旋階段は16段とも掴めず、形を直す手段が消える。
            //   掴んだ1段を押し引きすれば全段が一緒に変わる（並べる操作の意味として正しい）。
            //   識別子を載せない面は _bp3ShellAt が弾く（shellFaceId が無ければ候補にしない）
            ...(s._patternIdx > 0 ? {} : {
              shellFaceId: f.id, blockIdx: s.blockIdx, faceType: f.type, edgeIdx: f._edgeIdx,
            }),
            // 辺ごとに描くか（分割で生まれた内部の辺は引かない）。開口のあるセル壁で使う
            edges: f.edges || null,
            // 面上の点を解くための元の3D頂点（グリッドx,y＋メートルz）。
            // 画面→面上の逆投影は _bp3PointOnFace が投影点との対応から厳密に解く
            faceVerts: f.vertices,
          });
        });
      });
    }

    // 【2026-09-23】選んだ面の上に描いている矩形。面より手前に出す（layer に小数を足す）
    if (faceSketch && faceSketch.corners && faceSketch.corners.length === 4) {
      const cs = faceSketch.corners.map(p2 => toLocal(p2.x, p2.y, p2.z));
      polys.push({ pts: cs, fill: 'rgba(56,189,248,0.28)', stroke: '#38BDF8',
                   lineW: 2, layer: LAYER.SHELL + 0.5, isSketch: true });
    }

    // 階（床スラブ・仕切り・扉・部屋）
    (building.floors || []).forEach(floor0 => {
      // 階編集モード中は、その階以外は描かない。
      // 【重要】これは「何を見せるか」の話なのでここ(scene)に置く。
      // 「どう見るか」(カメラ)とは別処理にする — 混ぜると解除時に片方のリセットを忘れる
      if (editFloorId && floor0.id !== editFloorId) return;
      // ドラッグ中の物は、確定前の位置で描く（本体データはまだ変えない）。
      // 2Dの dragPreview と同じ考え方を3Dにも通す。
      //
      // 【プレビューは1本の連鎖で当てる・2026-08-30】以前は壁用・扉用・機器用に
      // 別々の floor を作っていた。すると「扉をドラッグしても、その扉に貼った機器は
      // 元の扉の位置に取り残される」（機器から見える floor.doors がプレビュー前だから）。
      // 何かに乗っている物は、乗り先のプレビューを必ず見なければならない。
      // ここで全部当ててしまい、以降は全員この floor だけを読む
      const _pvPart = (f) => (previewPart && (f.partitions || []).some(p => p.id === previewPart.partId))
        ? { ...f, partitions: f.partitions.map(p =>
            p.id === previewPart.partId
              ? { ...p, a: previewPart.a, b: previewPart.b,
                  // 高さのギズモを掴んでいる間は高さもプレビューする
                  heightM: previewPart.heightM != null ? previewPart.heightM : p.heightM,
                  baseM: previewPart.baseM != null ? previewPart.baseM : p.baseM }
              : p) }
        : f;
      const _pvDoor = (f) => (previewDoor && (f.doors || []).some(d => d.id === previewDoor.doorId))
        ? { ...f, doors: f.doors.map(d =>
            d.id === previewDoor.doorId ? { ...d, uM: previewDoor.uM } : d) }
        : f;
      const floor = _pvDoor(_pvPart(floor0));
      bcFloorSlabGeoms(building).filter(g => g.floorId === floor.id).forEach(g => {
        const before = polys.length;
        g.polys.forEach(p => addPrism(p.points, p.zBottom, p.zTop, BC_UI.floorFill, BC_UI.floorStroke, 1, LAYER.FLOOR));
        // 3Dで階をクリックして選べるように、床の面にどの階かを記録する
        for (let i = before; i < polys.length; i++) polys[i].floorId = floor.id;
      });
      // ══ 階の空間 ・2026-10-01 ユーザー要望 ══
      // 【なぜ要るか】「天井がどこか見た目ではわからないため浮いているように見える」。
      //   床から天井までを薄い箱で見せると、階の高さと天井の位置が一目で分かる
      //   （天井に貼った機器がどこに付いているかも、これで読める）。
      // 【床を選んだときだけ】常時出すと壁・部屋・機器が見づらくなる。
      // 【クリックには混ぜない】floorId を付けないので当たり判定の対象外のまま
      //   （当たり判定は ICON/DOOR/WALL/FLOOR の4層だけを見る）。
      // 【段階フラグ】window.__BP3_FLOOR_SPACE = false で出さない（陽性対照）
      // 【形は常に作る・出すかどうかは描く時に決める】
      //   この scene（形の組み立て）は**選択に依存しない**構造になっている
      //   （useMemo の依存に選択が入っていない＝選ぶたびに形を作り直さないための設計）。
      //   そこへ「選んでいるときだけ作る」を書くと、初回の値のまま永久に作られない。
      //   選択で見た目が変わるものは、描画側（isHot と同じ層）で出し分ける。
      if (floor.heightM > 0 && typeof bcFloorOutlines === 'function') {
        // 複数の輪郭（棟が分かれている建屋）はそれぞれ別の箱にする
        bcFloorOutlines(building, floor).forEach(pts => {
          if (pts && pts.length >= 3) {
            const _b0 = polys.length;
            addPrism(pts, floor.levelZ, floor.levelZ + floor.heightM,
                     BC_UI.spaceFill, BC_UI.spaceStroke, BC_UI.spaceAlpha, LAYER.SPACE);
            // どの階の空間かを記録する。**floorId は付けない**（当たり判定に混ざるため）
            for (let i = _b0; i < polys.length; i++) polys[i].spaceFloorId = floor.id;
          }
        });
      }
      // ── 交差する壁の描画（spec 12.18）──
      // Painter's は面の平均depthで前後を決めるため、他の壁を貫く面は
      // 奥行き方向に広がっていて1つの代表depthでは順序が決まらない。
      // 2Dの線分をどれだけ精密に切っても解決しない原理的な限界なので、
      // **配電盤と同じ「3Dの面を他の板の中央平面でクリップする」方式**に統一した
      // （pdcSplitFaceGroups。spec 7.10「組み立て方も配電盤と同じ」）。
      //
      // 高さの帯分け（12.13）は前段として残す。中央平面クリップは平面の話なので、
      // 「交差していない高さでは継ぎ目を出さない」は帯分けでしか担保できない。
      const bandParts = _bp3SplitPartitions(floor.partitions || [], floor);
      // 【壁と床置きの箱を同じ1回の分割に通す】面の平均depthでは前後が決まらないのは
      // 壁だけの話ではない。床置きの箱どうし・箱と壁でも同じ破綻が起きる
      // （2026-08-30 ユーザー指摘。盤を並べると前後が入れ替わる）。
      // 別々に分割してから深度で並べても、互いの交差は未分割のままなので直らない。
      const splitGroups = [];
      bcPartitionGeoms(building, { ...floor, partitions: bandParts }).forEach(g => {
        // 【開口で割れた壁・2026-10-04】高さ帯（_zB/_zT）とセル（g.zB/g.zT）の**共通部分**。
        //   丸ごと上書きすると、窓で上下に割れたセルが全部同じ高さになって重なる。
        const zB = Math.max(g.zB, g.part._zB != null ? g.part._zB : -Infinity);
        const zT = Math.min(g.zT, g.part._zT != null ? g.part._zT : Infinity);
        if (!(zT > zB)) return;
        const isClear = g.part.kind === 'clear';
        // クリップ処理は {x,y,z} を期待するので、ローカル座標をその形で作る
        const L = (gx, gy, z) => { const v = toLocal(gx, gy, z); return { x: v.wx, y: v.wy, z: v.wz }; };
        const n = g.poly.length;
        const faces = [];
        for (let i = 0; i < n; i++) {
          const a = g.poly[i], b = g.poly[(i + 1) % n];
          faces.push({ vertices: [L(a.x, a.y, zB), L(b.x, b.y, zB), L(b.x, b.y, zT), L(a.x, a.y, zT)] });
        }
        // 【高さ帯の境目にフタを作らない】上下のフタは「壁の本当の天端／床際」だけ。
        // 帯の境目に作ると、上下の帯のフタが同じ高さで重なり、その輪郭が
        // 壁を横切る線になる（2026-08-26 ユーザー指摘）。
        // 見えない面なので作らないのが正しい（作ってから消すのではなく）
        const EZ = 1e-6;
        if (Math.abs(zT - g.zT) < EZ) faces.push({ vertices: g.poly.map(p => L(p.x, p.y, zT)) });           // 天端
        if (Math.abs(zB - g.zB) < EZ) faces.push({ vertices: g.poly.map(p => L(p.x, p.y, zB)).reverse() }); // 床際
        faces.forEach(f => { f.normal = _bp3FaceNormal(f.vertices); });
        // 切る平面: 中央平面（前後関係のため）＋壁の両側の面（見える稜線のため）。
        // 中央平面だけで切ると、その辺は必ず相手の壁の内部に埋もれて見えない。
        // 交差部で実際に見える縦線は「相手の壁の面」の位置にある（ユーザー指摘の赤線）
        const _pl = (f) => { const n = f.normal, v = f.vertices[0];
          return { nx: n.nx, ny: n.ny, nz: n.nz, d: n.nx * v.x + n.ny * v.y + n.nz * v.z }; };
        const surf = [faces[0], faces[2]].filter(f => f && f.normal).map(_pl);
        const bodyPlanes = faces.slice(0, n).filter(f => f && f.normal).map(_pl); // 側面4枚＝胴体
        const midp = _pdcSolidMidPlane({ faces });
        splitGroups.push({
          faces,
          // 同じ壁を高さの帯で分けた破片同士では切らない（自分の中央平面で切ると
          // 壁の厚みの中央に線が入る。2026-08-26 ユーザー指摘）
          key: g.part.id,
          planes: midp ? [midp, ...surf] : surf,
          surfPlanes: surf,
          bodyPlanes,
          // 胴体の中心。面の法線が内向き/外向きどちらでも「内側」を判定できるようにする
          bodyCenter: (() => {
            let sx = 0, sy = 0; g.poly.forEach(p => { const v = L(p.x, p.y, 0); sx += v.x; sy += v.y; });
            return { x: sx / g.poly.length, y: sy / g.poly.length, z: (L(0,0,zB).z + L(0,0,zT).z) / 2 };
          })(),
          bodyZ: [L(0, 0, zB).z, L(0, 0, zT).z],
          midPlane: midp,
          meta: {
            gkey: g.part.id,   // 断片の継ぎ目判定用のグループ識別（箱と共通の名前）
            wallId: g.part.id, // 高さ帯で分かれても同じ壁だと分かるようにする
            fill: g.part.color || (isClear ? BC_UI.clearFill : BC_UI.wallFill),
            stroke: isClear ? BC_UI.clearStroke : BC_UI.wallStroke,
            alpha: isClear ? BC_UI.clearAlpha : 1,
            // 壁「本来の」上下端。帯の切れ目で生まれた水平の辺は輪郭ではないので描かない
            realZB: L(0, 0, g.zB).z, realZT: L(0, 0, g.zT).z,
          },
        });
      });
      // 交点の空間をどちらの壁が持つか。3次元図（bdoSplitWallPrisms）と同じ述語1つを使う
      const ownsRegion = bdoOwnsRegion;
      const insideOther = (v, myIdx) => {
        // 断片の重心が他の壁の胴体（側面4枚の内側＋z範囲）に入っていれば見えない
        let cx = 0, cy = 0, cz = 0;
        v.forEach(q => { cx += q.x; cy += q.y; cz += q.z; });
        cx /= v.length; cy /= v.length; cz /= v.length;
        const EPS = 1e-3;
        const me = splitGroups[myIdx];
        // 【箱には適用しない】この「相手の胴体に埋もれた断片を捨てる」処理は、
        // 壁どうしが交差部の空間をどちらが持つかを決めるための仕組み（ownsRegion）。
        // 箱は当たり判定でめり込まないので埋もれる断片が出ず、通すと面が消える危険だけが残る
        if (!me || me.isBox) return false;
        const myKey = me.key;
        return splitGroups.some((g, gi) => {
          if (gi === myIdx || g.isBox || !g.bodyPlanes || g.bodyPlanes.length < 3) return false;
          if (g.key === myKey) return false; // 同じ壁の帯どうしは対象外
          // 相手が交点の空間を持つ側のときだけ譲る。両方が譲ると交点に穴があく
          if (!ownsRegion(g.key, myKey)) return false;
          if (cz < g.bodyZ[0] - EPS || cz > g.bodyZ[1] + EPS) return false;
          return _bp3InsideBody({ x: cx, y: cy, z: cz }, g, EPS);
        });
      };
      // ── 輪郭線の判定（2026-08-26 全面作り直し）──
      // 【これまで】「中央平面の辺か」「相手の面の辺か」「胴体の中か」「どちらが高いか」…と
      // 条件を積み上げた結果、辺が消えたり余計な線が出たりを繰り返した（6回修正）。
      // 条件を1つ足すたびに「外れた場合にどこへ落ちるか」を間違え、症状が入れ替わった。
      //
      // 【設計を変える】幾何だけで決まる**1つの規則**にする:
      //
      //   同じ壁の・同じ平面の・2つ以上の断片が共有する辺 ＝ 分割で生まれた内部の継ぎ目
      //   → 描かない。それ以外はすべて輪郭 → 描く。
      //
      // これで以下が自動的に正しくなる（個別の条件が要らない）:
      //   ・中央平面/面での切り口 … 同じ壁の同じ平面で隣り合う2断片が共有 → 消える
      //   ・高さ帯の境目          … 同上 → 消える
      //   ・交差部の稜線          … 相手に食われた側の切り口は1回しか現れない → 残る
      //   ・壁の端部・天端・床際  … 1回しか現れない → 残る
      // 【規則の実装は boxDrawOrder.js の bdoSeamEdgeFlags 1つ・2026-09-13】
      // 3次元図も交差する壁を小片に分けて同じ規則で輪郭を引くので、ここに写しを持たない。
      // 【分割の実行はこの下（床置きの箱を集めたあと）】壁と箱を1つの配列で渡す必要があるため、
      // 箱を splitGroups に積む機器ループより後ろで走らせる。
      const runSplit = () => {
        const frags = pdcSplitFaceGroups(splitGroups)
          .filter(fr => !insideOther(fr.vertices, fr.groupIndex)); // 隠れて見えない断片は捨てる
        const seam = bdoSeamEdgeFlags(frags.map(fr => ({ key: fr.meta.gkey, pts: fr.vertices })));
        // 箱のラベルは上面に1回だけ出す。分割で上面が複数の断片に割れるので、
        // 「いちばん高くて広い断片」を1つ選んでそこに載せる（側面ごとに出すと4重になる）
        const topPick = new Map();
        frags.forEach((fr, fi) => {
          const m = fr.meta, v = fr.vertices;
          const edges = seam[fi];
          const pts = v.map(p => ({ wx: p.x, wy: p.y, wz: p.z }));
          if (m.kind === 'box') {
            // 盤は pdcDrawPanel が自分で外箱まで描くので、ここでは塗らない（掴むためだけに残す）
            // 【isSolidBox】これは床の上に立つ「立体」の面。壁と同じ1回の分割を通してある。
            // 壁付け・扉付けの機器（1枚の板・壁と同一平面）とは前後の決め方が違うので、
            // 描画順のソートで見分けられるように印を付ける（下の _sortLayer）。
            polys.push({ ...m.ids, pts, layer: LAYER.ICON, isSolidBox: true,
                         paintPanel: m.paintPanel || null,
                         fill: m.paintPanel ? null : m.fill,
                         stroke: m.paintPanel ? null : m.stroke,
                         edges: m.paintPanel ? null : edges, alpha: m.alpha });
            let z = 0, a2 = 0;
            for (const p of v) z += p.z;
            z /= v.length;
            for (let i = 0; i < v.length; i++) { const q = v[(i + 1) % v.length];
              a2 += v[i].x * q.y - q.x * v[i].y; }
            const area = Math.abs(a2) / 2;
            const cur = topPick.get(m.gkey);
            if (!cur || z > cur.z + 1e-6 || (Math.abs(z - cur.z) <= 1e-6 && area > cur.area)) {
              let cx2 = 0, cy2 = 0;
              for (const p of v) { cx2 += p.x; cy2 += p.y; }
              topPick.set(m.gkey, { idx: polys.length - 1, z, area, text: m.labelText,
                                    // 壁付けの箱は「板の上辺より上」の位置を持っている（本体を覆わない）
                                    at: m.labelDrawAt || { wx: cx2 / v.length, wy: cy2 / v.length, wz: z } });
            }
            return;
          }
          polys.push({
            pts, fill: m.fill, stroke: m.stroke, edges, alpha: m.alpha, layer: LAYER.WALL,
            // 3Dで掴むための識別子。どの階のどの仕切りの面かが分かるようにする。
            // floorZ はドラッグ時の「投影先の水平面」の高さ
            floorId: floor.id, partId: m.wallId, floorZ: floor.levelZ,
          });
        });
        // 【labelAt は書き換えない】labelAt はヒット判定(_bp3HitIcon の ih.at)で
        // ドラッグ2軸解法の原点として axisSAt/axisTAt と対で使われ、↻ハンドルの位置にも使う。
        // 上面へ動かすと原点と軸の対応が崩れて移動ドラッグが壊れる（Codex監査の指摘）。
        // 描画専用の labelDrawAt を別に持たせ、ラベルの表示位置だけ上面中心にする。
        topPick.forEach(t => {
          if (!polys[t.idx]) return;
          polys[t.idx].labelText = t.text;
          polys[t.idx].labelDrawAt = t.at;
        });
      };

      // 扉も掴めるようにする。識別子の載せ方は壁と同じ（poly に直接）。
      // スライド中の位置は floor に当て済み（上の _pvDoor）。ここでは読むだけ
      bcDoorGeoms(building, floor).forEach(g => addPrism(
        g.poly, g.zB, g.zT, BC_UI.doorFill, BC_UI.doorStroke, 1, LAYER.DOOR,
        { ids: { doorId: g.door.id, partId: g.part.id, floorId: floor.id, floorZ: floor.levelZ } }));

      // 【壁面の機器アイコン・Phase C】壁の面に貼る平らな板。厚みを持たないので
      // addPrism（押し出し）ではなく1枚のポリゴンとして積む。
      // ラベルは投影後に pdcPaintIconLabel で描く（配電盤と同じ見た目・複製しない）
      // 【1リストに束ねる】壁面の機器・床置きの機器・配置済みの配電盤を同じ1ループで描く。
      // 盤は floor.icons には入っていない別モデルだが、箱の形に射影されて渡ってくるので
      // ここから先は区別しない（描画・ヒット・ドラッグ量計算を二重に持たないため）。
      // ドラッグ中のプレビューも、束ねた後のリストへ一律に当てる。
      // 壁面(sM/tM)も床置き(gx/gy)も渡された項目をそのまま上書きする（型ごとに分岐を作らない）
      const baseIcons = [...(floor.icons || []),
                         ...(extraBoxes || []).filter(b => b.floorId === floor.id)];
      const shownIcons = previewIcon
        ? baseIcons.map(x => x.id === previewIcon.iconId ? { ...x, ...previewIcon.patch } : x)
        : baseIcons;
      const iconFloor = { ...floor, icons: shownIcons };
      shownIcons.forEach(ic => {
        const g = bcIconAnchorGeom(building, iconFloor, ic);
        if (!g) return;
        // 識別子とドラッグ用の2軸は、壁面でも扉でも床置きでも同じ形で載せる。
        // 【partId は幾何から取る】扉に貼った機器は partitionId を持たない（扉が持っている）ので、
        // ic.partitionId をそのまま載せると選択しても壁が光らない
        const ids = {
          iconId: ic.id, partId: g.part ? g.part.id : ic.partitionId,
          // 取り付け先（壁か扉）。並べ替えで「取り付け先の全ての面より後に塗る」強制の辺を作る。床置きは無し
          mountHost: bcIsFloorIcon(ic) ? null
            : (g.door ? { kind: 'door', id: g.door.id } : { kind: 'wall', id: g.part ? g.part.id : ic.partitionId }),
          floorId: floor.id, floorZ: floor.levelZ,
          labelAt: toLocal(g.center.x, g.center.y, g.center.z),
          // 名称ラベルの画面上のずらし量。カメラzoomで割った値を持つので、拡大しても相対位置が保たれる
          labelDx: ic.labelDx || 0, labelDy: ic.labelDy || 0,
          axisSAt: toLocal(g.axisS.x, g.axisS.y, g.axisS.z),
          axisTAt: toLocal(g.axisT.x, g.axisT.y, g.axisT.z),
        };
        // 【形は全員「底面の輪郭 poly × zB〜zT」の箱・2026-09-11】
        // ユーザー決定「壁・扉の機器は建屋エディタでも他のも全部厚みあり。3次元図の形を正とする」。
        // bcIconAnchorGeom が壁・扉付けにも poly（取付面から外へ BC_ICON_PLATE_THICK_M 押し出した底面）を返す。
        // 以前はここだけ壁・扉付けを厚み0の板1枚で描き、3次元図の箱と形が食い違っていた
        if (!g.poly || g.poly.length < 3) return;
        const onFloor = bcIsFloorIcon(ic);
        // 【ラベルは本体の上に出す・2026-09-04】
        // ラベルの当たり判定は本体より**先に**見る（pointerdown の順序）。壁・扉の機器は
        // labelAt が本体の中心なので、ラベルが本体を丸ごと覆い、掴もうとすると必ず
        // ラベルの移動になっていた（＝壁・扉の機器がドラッグできない）。
        // 床置きの箱が「上面の中心」に出しているのと同じ考え方で、板の上辺の中央へ逃がす。
        // 床置きは分割後の上面の中心（下の topPick）が選ぶので、ここでは作らない
        const _lblAt = (() => {
          if (onFloor) return null;
          const cs = g.corners;
          if (!cs || !cs.length) return null;
          let zMax = -Infinity;
          for (const p of cs) if ((p.z || 0) > zMax) zMax = (p.z || 0);
          const top = cs.filter(p => Math.abs((p.z || 0) - zMax) < 1e-6);
          const src = top.length ? top : cs;
          let sx = 0, sy = 0;
          for (const p of src) { sx += p.x; sy += p.y; }
          // 上辺から少しだけ持ち上げて、本体の掴める面積を残す
          return toLocal(sx / src.length, sy / src.length, zMax + 0.1);
        })();
        const fill = ic.color || (onFloor ? BC_FLOOR_ICON_DEFAULTS.color : BC_ICON_DEFAULTS.color);
        const L2 = (gx, gy, z) => { const v = toLocal(gx, gy, z); return { x: v.wx, y: v.wy, z: v.wz }; };
        const nn = g.poly.length;
        const bfaces = [];
        for (let i = 0; i < nn; i++) {
          const a = g.poly[i], b = g.poly[(i + 1) % nn];
          bfaces.push({ vertices: [L2(a.x, a.y, g.zB), L2(b.x, b.y, g.zB), L2(b.x, b.y, g.zT), L2(a.x, a.y, g.zT)] });
        }
        bfaces.push({ vertices: g.poly.map(p => L2(p.x, p.y, g.zT)) });   // 上面
        // 底面: 床置きは床に接して見えない。壁・扉付けは宙に浮いているので下から見える
        if (!onFloor) bfaces.push({ vertices: g.poly.map(p => L2(p.x, p.y, g.zB)).reverse() });
        // ラベルの大きさの基準は「箱そのもの」。分割後の面の断片では大きさが安定しない
        ids.labelBox = _bp3LocalBox([].concat(...bfaces.map(f => f.vertices)));
        // 【扉付けも同じ分割に載せる・2026-09-13】以前は扉付けだけ分割に載せず LAYER.ICON の段に積んでいた
        // （扉が分割を通っていないので、壁と同じ段では扉に隠れるため）。並べ方を「対ごとの前後＋強制の辺」に
        // 作り直したので、取り付け先の扉より後に塗ることは強制の辺が保証する。種類ごとの例外は置かない。
        // 【床置き・壁付け】壁と同じ1回の分割へ載せる（面ごとの平均depthでは
        // 箱どうし・箱と壁の前後が決まらない。理由はファイル冒頭39-42行の結論と同じ）。
        // 壁付けの箱は壁の面から僅かに離して置いてある（bcIconFrame の offGrid）ので壁と交差しない
        bfaces.forEach(f => { f.normal = _bp3FaceNormal(f.vertices); });
        const _pl2 = (f) => { const nv = f.normal, v0 = f.vertices[0];
          return { nx: nv.nx, ny: nv.ny, nz: nv.nz, d: nv.nx * v0.x + nv.ny * v0.y + nv.nz * v0.z }; };
        const bodyPlanes = bfaces.slice(0, nn).filter(f => f && f.normal).map(_pl2);
        let sx = 0, sy = 0;
        g.poly.forEach(p => { const v = L2(p.x, p.y, 0); sx += v.x; sy += v.y; });
        splitGroups.push({
          faces: bfaces, key: 'box:' + ic.id, isBox: true,
          // 【切る平面は側面すべて】箱は壁のような薄板ではないので、中央平面1枚では
          // 厚みを表せない。側面の平面で切ると相手の面が箱の輪郭でちょうど分かれる
          planes: bodyPlanes,
          bodyPlanes,
          bodyCenter: { x: sx / g.poly.length, y: sy / g.poly.length,
                        z: (L2(0, 0, g.zB).z + L2(0, 0, g.zT).z) / 2 },
          bodyZ: [L2(0, 0, g.zB).z, L2(0, 0, g.zT).z],
          meta: { kind: 'box', gkey: 'box:' + ic.id, ids, labelText: ic.name,
                  fill, stroke: '#0F172A', alpha: 1,
                  // 壁付けのラベル位置（無ければ topPick が上面の中心を選ぶ）
                  labelDrawAt: _lblAt,
                  // 【盤は共通統括で描く】3次元図とまったく同じ見た目にするため、
                  // 面をここで塗らず panelPaintCore.js の pdcDrawPanel に1単位で描かせる。
                  // 箱の面は「前後関係の決定」と「掴む当たり判定」のためだけに残す。
                  paintPanel: ic.panelRef || null },
        });
      });
      // 壁と床置きの箱がそろったので、ここで1回だけ分割して面を積む
      runSplit();
      if ((floor.partitions || []).length > 0) {
        bcDeriveRooms(building, floor, pnDeg).forEach(room => {
          // 部屋は床の上に敷く「薄い色付け」。部屋は床全面を覆うため、濃いと床が
          // 完全に見えなくなる（実測で床の可視画素が0%になっていた＝「色分けが崩れる」の正体）。
          // 床のグレーが透けて見える濃さに抑える
          // 外周に残った最大の領域はさらに薄く（壁で囲んで作った部屋を目立たせる）
          const a = room.isLargest ? 0.07 : 0.22;
          room.cells.forEach(c => addFlat(
            c.corners, // PN回転後は軸平行でないため4隅頂点をそのまま使う
            floor.levelZ + 0.03, room.color, null, a, LAYER.ROOM
          ));
        });
      }
    });
    // 【作図の予告・段階C】1点目からカーソルまでの候補線と、PN2軸のガイド。
    // 2Dと同じものを3Dにも出す（spec 12.19）。床のすぐ上に薄く敷く
    if (drawGuides && drawGuides.from) {
      const z = drawGuides.z + 0.02;
      const FAR = 1e4;
      (drawGuides.dirs || []).forEach((dr, i) => {
        const on = drawGuides.snappedIdx === i;
        const a = { x: drawGuides.from.x - dr.x * FAR, y: drawGuides.from.y - dr.y * FAR };
        const b = { x: drawGuides.from.x + dr.x * FAR, y: drawGuides.from.y + dr.y * FAR };
        polys.push({ pts: [toLocal(a.x, a.y, z), toLocal(b.x, b.y, z)],
                     fill: null, stroke: on ? 'rgba(251,191,36,0.95)' : 'rgba(251,191,36,0.35)',
                     // 【部屋塗りに沈めない・2026-09-03】z ではなく layer で持ち上げる（設計原則:順序は
                     // layer で固定・zで争わない）。ROOM(1)+0.5=1.5 で部屋塗りの上・壁(2)の下。ソートは
                     // 1097行の減算式で小数layer可、ヒット判定はlayer整数完全一致ゆえガイド(id無し)は不一致。
                     lineW: on ? 2 : 1, dash: [6, 5], layer: LAYER.ROOM + 0.5 });
      });
    }
    if (drawGhost && drawGhost.a && drawGhost.b) {
      const g = { part: { ...drawGhost, id: '__ghost__', a: drawGhost.a, b: drawGhost.b },
                  poly: null, zB: drawGhost.zB, zT: drawGhost.zT };
      const geo = bcPartitionGeoms({ id: 'g', floors: [] },
        { id: 'g', levelZ: drawGhost.zB, heightM: drawGhost.zT - drawGhost.zB,
          partitions: [{ ...drawGhost, id: '__ghost__' }] })[0];
      if (geo) addPrism(geo.poly, geo.zB, geo.zT, BC_UI.ghost, BC_UI.accent, 0.75, LAYER.DOOR);
    }
    // 【床の形の作図・段階C】打った頂点を結ぶ破線。2Dと同じ見た目（BC_UI.outlineEdit・破線）。
    // 3点以上なら閉じ線も引く。頂点の●は投影後に bcPaintOutlinePts で描く
    if (drawPoly && drawPoly.pts && drawPoly.pts.length >= 2) {
      const z = drawPoly.z + 0.03;
      const P = drawPoly.pts;
      const n = P.length >= 3 ? P.length : P.length - 1; // 3点以上なら最後→最初も引く
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        polys.push({ pts: [toLocal(a.x, a.y, z), toLocal(b.x, b.y, z)],
                     fill: null, stroke: BC_UI.outlineEdit, lineW: 2, dash: [5, 4], layer: LAYER.DOOR });
      }
    }

    // toLocal の逆変換も一緒に返す。3Dで掴んだカーソル位置をグリッド座標へ戻すのに使う。
    // 変換と逆変換は必ず対にして同じ場所で管理する（別々に書くと minX/maxY の扱いがズレる）
    return {
      W, D, H, polys,
      toLocalZ: (z) => z - minZ,
      toWorldZ: (wz) => wz + minZ,          // toLocalZ の逆。対で持つ（片方だけだと必ずズレる）
      toLocal,
      toGrid: (wx, wy) => ({ x: (wx + minX) / mpp, y: (maxY - wy) / mpp }),
    };
  // faceSketch: 面に描いている矩形。作図のガイド drawGhost と同じ扱いで依存に入れる（2026-09-23）
  }, [building, floorId, pnDeg, previewPart, previewDoor, previewIcon, extraBoxes, editFloorId, drawGhost, drawGuides, drawPoly, faceSketch]);

  // カメラ処理は scene の中身に依存しないが、存在確認だけしたいので ref で持つ。
  // deps に scene を入れると階を切り替えるたびにカメラが動いてしまう
  const sceneRef = useRef(null);
  sceneRef.current = scene;
  const editing = !!editFloorId; // カメラが気にするのは「モードかどうか」だけ

  // 建物が変わったらオートフィットを「予約」する。実行は描画時にキャンバス寸法が
  // 確定してから行う（下記 fitIfNeeded）。
  // 【重要】2D↔3Dのタブ切替でこのコンポーネントは再マウントされる。マウント直後は
  // clientWidth/Height が 0 のことがあり、その寸法でフィット計算するとズーム倍率が
  // 異常値（下限0.02にクランプ）になって操作感が壊れる。壁を作って3Dへ戻したときに
  // 「操作感が崩れる」原因がこれだった
  useEffect(() => {
    if (!building) return;
    if (lastBuildingIdRef.current !== building.id) {
      lastBuildingIdRef.current = building.id;
      needFitRef.current = true;
      redraw();
    }
  }, [building, redraw]);

  // ══ カメラの補間は1本・2026-09-11 ══
  // 【ユーザー報告】「建屋エディタの拡大が拡大動作がなく一瞬で拡大されてしまう」（📷の寄せ）。
  // 他の窓（App の focusWorldPos）は 600ms・ease-in-out で寄る。ここも同じ長さ・同じ緩急にする。
  // 【1本にする理由】階編集モードの真上への回転も camRef を補間で書いている。
  //   別々に持つと、同時に走ったとき互いの途中値で上書きし合う。補間は常に1つだけ（新しい補間が古いのを止める）。
  // 【止め方】why='user'（ホイール・押下）: 利用者がカメラを取った。寄せはその場で止める。
  //   completeOnUser の補間（モード切替えの回転）は最終状態まで進めて後始末（フィット）を済ませる。
  //   why='replace': 何もせず止める（次の補間・アンマウント・フィットし直し）
  // 【保険】隠れた窓では requestAnimationFrame が発火しない（下の回転の説明と同じ罠）。
  //   期限の setTimeout で必ず行き先に着かせる
  const camAnimRef = useRef(null);
  const stopCamAnim = useCallback((why, onlyKind) => {
    const a = camAnimRef.current;
    if (!a || (onlyKind && a.kind !== onlyKind)) return;
    camAnimRef.current = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    clearTimeout(a.guard);
    if (why === 'user' && a.completeOnUser) { a.apply(1); if (a.onDone) a.onDone(); else redraw(); }
  }, [redraw]);
  const animateCam = useCallback((to, dur, opts) => {
    stopCamAnim('replace');
    const c = camRef.current, o = opts || {};
    const keys = Object.keys(to);
    const from = {};
    keys.forEach(k => { from[k] = c[k]; });
    const a = { kind: o.kind || null, completeOnUser: !!o.completeOnUser, onDone: o.onDone || null,
                raf: 0, guard: 0, t0: 0 };
    a.apply = (e) => { keys.forEach(k => { c[k] = from[k] + (to[k] - from[k]) * e; }); };
    const finish = () => {
      if (camAnimRef.current !== a) return;   // 止められた／次の補間に替わった
      camAnimRef.current = null;
      if (a.raf) cancelAnimationFrame(a.raf);
      clearTimeout(a.guard);
      a.apply(1);
      if (a.onDone) a.onDone(); else redraw();
    };
    const step = (ts) => {
      if (camAnimRef.current !== a) return;
      if (!a.t0) a.t0 = ts;
      const k = Math.min(1, (ts - a.t0) / dur);
      if (k >= 1) { finish(); return; }
      a.apply(_bp3EaseInOut(k));
      redraw();
      a.raf = requestAnimationFrame(step);
    };
    camAnimRef.current = a;
    a.raf = requestAnimationFrame(step);
    a.guard = setTimeout(finish, dur + 80);
  }, [redraw, stopCamAnim]);

  // オートフィット本体（配電盤の panelAutoFit と同一手順）。寸法が確定している時のみ実行
  const fitIfNeeded = useCallback((cW, cH) => {
    if (!needFitRef.current || !scene) return;
    if (!(cW > 0) || !(cH > 0)) return; // 寸法未確定なら次の描画まで持ち越す
    needFitRef.current = false;
    // 全体へフィットし直すなら、走っている📷の寄せは古い（建物が替わった等）。止めないと次のコマで上書きされる
    stopCamAnim('replace', 'focus');
    const c = camRef.current;
    // 視点を指定してフィットしたい場合（階編集モードの真上視点など）は角度を保つ。
    // ここで既定角度に戻すと、せっかく向けた真上視点が打ち消される
    if (keepAngleRef.current) { keepAngleRef.current = false; }
    else { c.az = -Math.PI / 5; c.el = -Math.PI / 8; } // 配電盤エディタと同一の初期アングル
    const corners = [
      [0,0,0],[scene.W,0,0],[scene.W,scene.D,0],[0,scene.D,0],
      [0,0,scene.H],[scene.W,0,scene.H],[scene.W,scene.D,scene.H],[0,scene.D,scene.H],
    ];
    const p1 = corners.map(([x,y,z]) => project3DPanel(x,y,z, scene.W, scene.H, scene.D, c.az, c.el, 1, 0,0, cW,cH));
    const bw = (Math.max(...p1.map(p=>p.x)) - Math.min(...p1.map(p=>p.x))) || 1;
    const bh = (Math.max(...p1.map(p=>p.y)) - Math.min(...p1.map(p=>p.y))) || 1;
    const margin = Math.min(80, cW * 0.15, cH * 0.15); // 小さい窓でも余白で潰れないように
    c.zoom = Math.max(BP3_ZOOM_MIN, Math.min(BP3_ZOOM_MAX, Math.min((cW-margin)/bw, (cH-margin)/bh)));
    const p2 = corners.map(([x,y,z]) => project3DPanel(x,y,z, scene.W, scene.H, scene.D, c.az, c.el, c.zoom, 0,0, cW,cH));
    c.panX = cW/2 - (Math.min(...p2.map(p=>p.x)) + Math.max(...p2.map(p=>p.x)))/2;
    c.panY = cH/2 - (Math.min(...p2.map(p=>p.y)) + Math.max(...p2.map(p=>p.y)))/2;
  }, [scene, stopCamAnim]);

  // ── 階編集モードの「どう見るか」（spec 14.2）──
  // 表示のフィルタ（scene側）とは**別処理**にする。
  // 混ぜると解除時に片方のリセットを忘れる結合バグになる（監査指摘）。
  // 入る: 真上視点へアニメーションで移動 → 見えている範囲にフィット
  // 出る: 既定のアングルへ戻してフィット
  // モード中でも中ボタンで自由に回せる（アニメーションが終われば普通のカメラに戻るだけ）
  // 【重要】deps に階IDや scene を入れてはいけない。
  // 入れると「編集モード中に別の階をクリックしただけ」でカメラ処理が走り、
  // フィットで建物全体を映す位置に飛ぶ（ユーザー指摘）。
  // カメラを動かすのは「モードに入る/出る」ときだけでよい。
  // 【pnDeg も同じ理由で deps に入れない】入れていたせいで、PNの数値を1つ変えるたびに
  // カメラが引きになって全体表示に戻っていた（2026-08-29 ユーザー指摘）。
  // 真上視点の向きを決めるのに PN は要るが、それは ref で読む
  useEffect(() => {
    if (!sceneRef.current) return;
    const c = camRef.current;
    const pnRad = (pnDegRef.current || 0) * Math.PI / 180;
    const target = editing
      ? { az: -pnRad, el: -Math.PI / 2 + 0.001 }   // 真上。PNを画面の上に向ける
      : { az: -Math.PI / 5, el: -Math.PI / 8 };    // 通常の3D（配電盤と同じ初期角）
    const from = { az: c.az, el: c.el };
    // 最短回り（±πを跨がない）
    let dAz = target.az - from.az;
    while (dAz > Math.PI) dAz -= 2 * Math.PI;
    while (dAz < -Math.PI) dAz += 2 * Math.PI;
    const dEl = target.el - from.el;
    if (Math.abs(dAz) < 1e-6 && Math.abs(dEl) < 1e-6) {
      keepAngleRef.current = true; needFitRef.current = true; redraw(); return;
    }
    // 補間はカメラ補間の1本（animateCam）に任せる。📷の寄せと別々に camRef を書き合わないため。
    // 目的の向きに必ず到達させる（隠れた窓でも期限の setTimeout で着く。
    // 実測: 非表示のペインでは rAF が 600ms で 0 回。CLAUDE.md にも既知の罠として記載）
    animateCam({ az: from.az + dAz, el: from.el + dEl }, 250, {
      kind: 'angle',
      // 途中で触られても「向けてフィット」は済ませる（モードの切替えそのものなので）
      completeOnUser: true,
      onDone: () => {
        keepAngleRef.current = true; // 向けた角度を保ったままフィットする
        needFitRef.current = true;
        redraw();
      },
    });
    return () => stopCamAnim('replace', 'angle');
  }, [editing, redraw]);

  // ══ 📷の寄せ先へカメラを寄せる・2026-09-11 ══
  // 【ユーザー報告】「カメラマークを押しても建屋エディタではフォーカスにならない」。
  // 📷は App の focusGridPos に集まるが、そこから各ビューは動かしてもこのエディタは入っていなかった。
  // 【寄せ方】今の角度のまま、対象の外接箱が画面の BP3_FOCUS_FILL を占めるよう zoom と pan を決める
  //   （fitIfNeeded と同じ手順。描画時にキャンバス寸法が確定してから行う）。
  // 【単位】bounds はすべてグリッドpx。高さは mpp を掛けてメートルにしてから toLocal へ渡す
  //   （高さだけ単位を取り違えると寄せ先が上下にずれる。立面図で一度起きた型）。
  // 【別の建物】buildingId があるなら、その建物が表示されるまで待つ（エディタ側が建物を切り替える）。
  //   無いなら表示中の建物の中にあるときだけ寄せる（空の空間へ飛ぶより動かない方が安全・監査指摘）
  const BP3_FOCUS_FILL = 0.55;
  const focusBoxRef = useRef(null);
  const focusSeqRef = useRef(focusReq && focusReq.seq); // マウント時点の古い依頼では寄せない
  const buildingIdRef = useRef(null);
  buildingIdRef.current = building ? building.id : null;
  // 診断: __focusLogOn=true のとき📷の経路を記録する（どこで止まったかを1回で分かるように）
  const _flog = (o) => { if (typeof window !== 'undefined' && window.__focusLogOn)
    (window.__focusLog = window.__focusLog || []).push(o); };
  useEffect(() => {
    _flog({ 所: 'BP3:受信', seq: focusReq && focusReq.seq, 前回seq: focusSeqRef.current,
            bounds有り: !!(focusReq && focusReq.bounds) });
    if (!focusReq || !focusReq.bounds || focusReq.seq === focusSeqRef.current) return;
    focusSeqRef.current = focusReq.seq;
    focusBoxRef.current = focusReq;
    redraw();
  }, [focusReq && focusReq.seq]);
  const focusIfNeeded = (cW, cH) => {
    const req = focusBoxRef.current;
    const sc = sceneRef.current;
    if (!req || !sc) { if (req) _flog({ 所: 'BP3:寄せず', 理由: 'sceneが無い' }); return; }
    if (!(cW > 0) || !(cH > 0)) { _flog({ 所: 'BP3:持ち越し', 理由: '寸法未確定', cW, cH }); return; }
    // 真上への回転（階編集モードの出入り）の最中は寄せない。回転の後始末のフィットが寄せを打ち消すので、
    // 回転が終わって再描画されたときに寄せる（依頼は消費せず持ち越す）
    if (camAnimRef.current && camAnimRef.current.kind === 'angle') { _flog({ 所: 'BP3:持ち越し', 理由: '回転アニメ中' }); return; }
    if (req.buildingId && req.buildingId !== buildingIdRef.current) {
      _flog({ 所: 'BP3:待機', 理由: '別の建物', 依頼: req.buildingId, 表示中: buildingIdRef.current }); return;
    }
    focusBoxRef.current = null;
    const b = req.bounds, mpp = _bcMpp();
    const pts = [];
    for (const gx of [b.bxMin, b.bxMax]) for (const gy of [b.byMin, b.byMax])
      for (const gz of [b.bzMin, b.bzMax]) pts.push(sc.toLocal(gx, gy, gz * mpp));
    if (!req.buildingId) {
      const cx = pts.reduce((a, v) => a + v.wx, 0) / pts.length;
      const cy = pts.reduce((a, v) => a + v.wy, 0) / pts.length;
      if (!(cx >= 0 && cx <= sc.W && cy >= 0 && cy <= sc.D)) {
        _flog({ 所: 'BP3:寄せず', 理由: '表示中の建物の外', cx, cy, W: sc.W, D: sc.D }); return;
      }
    }
    _flog({ 所: 'BP3:寄せる', 点: pts.slice(0, 2) });
    const c = camRef.current;
    const p1 = pts.map(v => project3DPanel(v.wx, v.wy, v.wz, sc.W, sc.H, sc.D, c.az, c.el, 1, 0, 0, cW, cH));
    const bw = (Math.max(...p1.map(q => q.x)) - Math.min(...p1.map(q => q.x))) || 1;
    const bh = (Math.max(...p1.map(q => q.y)) - Math.min(...p1.map(q => q.y))) || 1;
    const zoom = Math.max(BP3_ZOOM_MIN, Math.min(BP3_ZOOM_MAX,
      Math.min(cW * BP3_FOCUS_FILL / bw, cH * BP3_FOCUS_FILL / bh)));
    const p2 = pts.map(v => project3DPanel(v.wx, v.wy, v.wz, sc.W, sc.H, sc.D, c.az, c.el, zoom, 0, 0, cW, cH));
    // 【一瞬で飛ばない・2026-09-11】行き先だけ決めて補間の1本へ渡す（他の窓と同じ 600ms・同じ緩急）
    animateCam({
      zoom,
      panX: cW / 2 - (Math.min(...p2.map(q => q.x)) + Math.max(...p2.map(q => q.x))) / 2,
      panY: cH / 2 - (Math.min(...p2.map(q => q.y)) + Math.max(...p2.map(q => q.y))) / 2,
    }, BP3_FOCUS_MS, { kind: 'focus' });
  };

  // ── 描画（Painter's: 奥から手前へ）──
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const cW = cv.clientWidth, cH = cv.clientHeight;
    if (cv.width !== Math.floor(cW*dpr) || cv.height !== Math.floor(cH*dpr)) {
      cv.width = Math.floor(cW*dpr); cv.height = Math.floor(cH*dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle = BC_UI.bg;
    ctx.fillRect(0,0,cW,cH);
    if (!scene) {
      ctx.fillStyle = BC_UI.muted; ctx.font = '14px sans-serif';
      ctx.fillText('建物を選んでください', 16, 28);
      return;
    }
    fitIfNeeded(cW, cH); // 寸法が確定したこの時点でオートフィットする
    focusIfNeeded(cW, cH); // 📷の寄せ先があれば、フィットの後に今の角度のまま寄せる
    const c = camRef.current;
    const pr = (v) => project3DPanel(v.wx, v.wy, v.wz, scene.W, scene.H, scene.D, c.az, c.el, c.zoom, c.panX, c.panY, cW, cH);

    const drawList = [];
    scene.polys.forEach((poly, idx) => {
      // 背面カリングはしない。ガワは半透明なので奥の面・奥の辺も見えるのが正しい
      const sp = poly.pts.map(pr);
      let d = 0; for (const p of sp) d += p.depth;
      drawList.push({ sp, depth: d / sp.length, poly, idx });
    });
    // 描画順は「レイヤー → 深度 → 生成順」の3段階で決める。
    // ・レイヤー: 床→部屋→壁→扉→ガワ。ほぼ同じ高さに重なる要素（床と部屋の色など）は
    //   深度がわずかしか違わず、角度が変わるたびに前後が入れ替わって表示が切り替わる。
    //   種類ごとに順番を固定すれば角度によらず安定する（ユーザー指摘の対策）
    // ・深度: project3DPanel の depth は「大きいほど手前」（CLAUDE.md: エディタ nearSign=+1）。
    //   Painter'sは奥から塗るので【昇順】。降順にすると箱の内側が見える状態になる
    // ・生成順: 深度が完全に同値のとき（壁の交差部など）の並びを固定し、ちらつきを防ぐ
    //
    // ══ 立体は種類で固定せず深度で決める・2026-09-04 ══
    // 【症状】奥にある床置き機器が、手前の壁の上に描かれる（角度を変えると直る）。
    // 【原因】レイヤーを深度より**優先**していたため、LAYER.ICON(4) > LAYER.WALL(2) で
    //   機器が常に壁より後（＝手前）に塗られていた。深度で比べる余地が無かった。
    // 【なぜレイヤー優先が入っていたのか】上のコメントどおり「ほぼ同一平面に重なる要素」の
    //   ちらつき対策。床と部屋の色のように**本当に同一平面**なものは、深度が同値で
    //   角度ごとに前後が入れ替わる。そこは種類で固定するのが正しい。
    // 【切り分け】壁・扉・床置きの箱はどれも「立体」である（扉も addPrism で作る柱状体で、
    //   壁の開口を埋めている）。立体どうしの前後は**深度で決まる**のが物理的に正しい。
    //   壁と箱は同じ1回の分割も通してある（648-651行の意図）。
    //   → 立体は1つの段にまとめて深度で競わせ、**深度が同値のときだけ**種類で固定する。
    //     同値になるのは同一平面に重なっているとき（扉の手前面と壁の手前面など）で、
    //     そこでは扉(3)が壁(2)に勝つ＝従来どおりの見た目になる。
    // 【限界】Painter's なので、立体どうしが互いを貫くように交差する配置では正しくならない。
    // 【扉は巻き込まない・2026-09-04】いったん扉も同じ段に入れたが、実機で扉の表示が
    // 崩れた（ユーザー報告）。扉は壁の開口を埋める柱状体で、壁と面がほぼ重なるうえ
    // **壁と同じ分割を通っていない**ので、深度だけでは前後が決まらない。
    // 分割を通した立体（壁・床置きの箱）だけを同じ段にする。
    // ══ 描画順の作り直し・2026-09-13 ══
    // 【段】床(0)→部屋の色(1)→立体(2)→ガワ(5)。床と部屋の色は本当に同一平面、ガワは半透明で
    //   最後に被せるので、この3種だけは種類で固定する。壁・扉・機器・盤の面はすべて「立体」の段。
    // 【立体は対ごとの前後で並べる】_bp3PairOrder（boxDrawOrder.js の bdoTopoOrder＋bdoPolyPairOrder）。
    //   以前は立体の段の中を面の中心の深度で sort しており、壁に貼った機器の正面が、その真後ろに残る
    //   縦長の壁の帯に覆われて左右の側面だけ見えていた（ユーザー報告・画像あり）。
    //   扉付けの例外と isSolidBox での段の寄せは、この作り直しで不要になったので消した（書き手を1つに）。
    // 【段階フラグ】window.__BP3_PAIR_ORDER = false で旧い並べ方（陽性対照としてだけ残す）。
    const SOLID_RUNG = LAYER.WALL;   // 立体の段（壁・扉・機器・盤）
    const _rung = (p) => (p.layer === LAYER.FLOOR || p.layer === LAYER.SPACE
                          || p.layer === LAYER.ROOM || p.layer === LAYER.SHELL)
      ? p.layer : SOLID_RUNG;
    // 深度の同値判定。投影depthの絶対値に対する相対誤差で見る（座標の大きさに依らせない）
    const _sameDepth = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
    const _byDepth = (a, b) => (!_sameDepth(a.depth, b.depth) ? a.depth - b.depth : 0)
      || ((a.poly.layer || 0) - (b.poly.layer || 0)) || (a.idx - b.idx);
    const _tOrder0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    if (typeof window !== 'undefined' && window.__BP3_PAIR_ORDER === false) {
      // 旧: 段（床置きの箱を壁の段へ寄せる）→ 面の中心の深度
      const _rungOld = (p) => (p.isSolidBox || p.layer === LAYER.WALL) ? SOLID_RUNG : (p.layer || 0);
      drawList.sort((a, b) => (_rungOld(a.poly) - _rungOld(b.poly)) || _byDepth(a, b));
    } else {
      // 手前向きの視線は投影の depth の勾配から実測する（カメラ規約を推測しない）
      const _vo = pr({ wx: 0, wy: 0, wz: 0 });
      let _vd = { x: pr({ wx: 1, wy: 0, wz: 0 }).depth - _vo.depth,
                  y: pr({ wx: 0, wy: 1, wz: 0 }).depth - _vo.depth,
                  z: pr({ wx: 0, wy: 0, wz: 1 }).depth - _vo.depth };
      const _vl = Math.hypot(_vd.x, _vd.y, _vd.z);
      if (_vl > 1e-12) _vd = { x: _vd.x / _vl, y: _vd.y / _vl, z: _vd.z / _vl };
      const _groups = new Map();
      for (const e of drawList) {
        const r = _rung(e.poly);
        if (!_groups.has(r)) _groups.set(r, []);
        _groups.get(r).push(e);
      }
      const _sorted = [];
      for (const r of [..._groups.keys()].sort((x, y) => x - y)) {
        const grp = _groups.get(r);
        if (r === SOLID_RUNG && _vl > 1e-12 && typeof bdoTopoOrder === 'function') {
          for (const e of _bp3PairOrder(grp, _vd)) _sorted.push(e);
        } else {
          for (const e of grp.sort(_byDepth)) _sorted.push(e);
        }
      }
      drawList.length = 0;
      for (const e of _sorted) drawList.push(e);
    }
    // 並べ替えにかかった時間（ドラッグ中も毎フレーム走るので、重さを実測で確かめる窓口）
    if (typeof window !== 'undefined' && _tOrder0) {
      window.__bp3OrderMs = performance.now() - _tOrder0;
      window.__bp3OrderN = drawList.length;
    }
    // 【明示的な責務】ヒット判定は「描画で作った画面座標」をそのまま使う。
    // 同じ投影を2度計算しない（走査中に答えが出ているなら後処理で再計算しない）。
    // ここで ref に書き出すことがこの効果のもう1つの成果物である、と明示しておく
    drawListRef.current = { list: drawList, cW, cH };
    // 【診断・2026-09-04】画面のある1点を覆っている面を、実際に塗った順で並べて返す。
    // 前後関係の不具合を「推測でなく実データ」で切り分けるための唯一の窓口。
    // 使い方: 建物エディタの3Dで、重なりがおかしい場所の座標を渡す
    //   __bp3At(x, y)   x,y はキャンバス左上からのCSS px
    // 返す並びは描いた順（後ろほど手前に見える＝最後の要素が実際に見えているもの）
    if (typeof window !== 'undefined') {
      window.__bp3At = (x, y) => {
        const d = drawListRef.current;
        if (!d) return '3Dがまだ描かれていない';
        const inside = (sp) => {           // 画面座標での多角形内判定
          let c = false;
          for (let i = 0, j = sp.length - 1; i < sp.length; j = i++) {
            if (((sp[i].y > y) !== (sp[j].y > y))
              && (x < (sp[j].x - sp[i].x) * (y - sp[i].y) / (sp[j].y - sp[i].y) + sp[i].x)) c = !c;
          }
          return c;
        };
        const LN = { 0: '床', 1: '部屋の色', 2: '壁', 3: '扉', 4: '機器', 5: 'ガワ' };
        return d.list.filter(e => e.sp && e.sp.length >= 3 && inside(e.sp)).map((e, i) => ({
          塗った順: i,
          種類: LN[Math.floor(e.poly.layer || 0)] || ('layer' + e.poly.layer),
          立体の箱か: !!e.poly.isSolidBox,
          並べ替えの段: _rung(e.poly),
          深度: Number(e.depth.toFixed(4)),
          機器ID: e.poly.iconId || null, 仕切りID: e.poly.partId || null, 扉ID: e.poly.doorId || null,
        }));
      };
      window.__bp3Order = () => {
        const d = drawListRef.current;
        if (!d) return '3Dがまだ描かれていない';
        const n = { 床: 0, 部屋の色: 0, 壁: 0, 扉: 0, 機器: 0, ガワ: 0, 立体の箱: 0 };
        const LN = { 0: '床', 1: '部屋の色', 2: '壁', 3: '扉', 4: '機器', 5: 'ガワ' };
        d.list.forEach(e => { const k = LN[Math.floor(e.poly.layer || 0)]; if (k) n[k]++;
                              if (e.poly.isSolidBox) n.立体の箱++; });
        return { 面の数: d.list.length, 内訳: n };
      };
      // 【診断・2026-10-04】床が穴（吹き抜け）でどれだけ抜けたか。
      //   面の数だけでは、穴の大きさを変えても（丸の帯の数が同じなので）変わらない＝
      //   「寸法を打っても効いていない」のか「指標が鈍い」のかを分けられない。
      //   床の**水平な面の面積**を返す（穴が大きいほど小さくなる）。読み取り専用。
      //   checks/bld_void_live.cjs が使う
      window.__bp3Void = () => {
        const d = drawListRef.current;
        if (!d) return '3Dがまだ描かれていない';
        const 水平 = (pts) => pts && pts.length >= 3
          && pts.every(p => Math.abs(p.wz - pts[0].wz) < 1e-6);
        const 面積 = (pts) => { let a = 0;
          for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length];
            a += p.wx * q.wy - q.wx * p.wy; } return Math.abs(a) / 2; };
        const 床 = d.list.filter(e => e.poly && e.poly.floorId && 水平(e.poly.pts));
        return {
          床の板: 床.length,
          床の面積: +床.reduce((a, e) => a + 面積(e.poly.pts), 0).toFixed(3),
        };
      };
      // 【診断・2026-10-03】このプレビューが描いている「ガワ（建屋の立体）」の形を数で返す。
      //   「3次元図には出るのにこの窓だけ出ない」を推測でなく実データで突き合わせる窓口。
      //   読み取り専用。checks/bld_preview_shape_live.cjs が使う
      window.__bp3Shell = () => {
        const d = drawListRef.current;
        if (!d) return '3Dがまだ描かれていない';
        const sh = d.list.filter(e => e.poly && e.poly.isShell && e.poly.faceVerts);
        let zMin = Infinity, zMax = -Infinity, 傾いた上面 = 0;
        sh.forEach(e => {
          const zs = e.poly.faceVerts.map(v => v.z);
          zs.forEach(z => { if (z < zMin) zMin = z; if (z > zMax) zMax = z; });
          // 上面の中で高さが変わっている＝傾いている（片流れ屋根・掃引の天端）
          if (e.poly.faceType === 'top' && Math.max.apply(null, zs) - Math.min.apply(null, zs) > 0.01) 傾いた上面++;
        });
        return {
          ガワの面: sh.length,
          zMin: sh.length ? +zMin.toFixed(3) : null,
          zMax: sh.length ? +zMax.toFixed(3) : null,
          傾いた上面,
          // 並べた部材の複製は掴めない（押し引きで形が壊れるので入口で塞いでいる）
          掴める面: sh.filter(e => !!e.poly.shellFaceId).length,
        };
      };
    }
    // 【投影を外へ渡す】作図の吸い付き判定は「画面px」で行う（2Dと同じ基準にする）。
    // 投影を知っているのはここだけなので、関数の形で親に渡す。
    // 親が自前で投影式を持つと二重管理になり、カメラ規約がズレる
    if (projectorRef) projectorRef.current = (gx, gy) => pr(scene.toLocal(gx, gy, drawFloorZ));
    prRef.current = pr; // ギズモの軸投影（1自由度）で使う
    // 【盤は1単位でまとめて描く】3次元図とまったく同じ見た目にするため、面ごとに塗らず
    // panelPaintCore.js の pdcDrawPanel（3次元図と共通の統括）へ丸ごと任せる。
    // 描く位置は「その盤のいちばん手前の面」の順番。そこまでに奥のものが塗り終わっており、
    // 盤より手前のものはこの後に塗られるので、前後関係が保たれる。
    // 【既知の制限】盤が壁を貫くような配置では、貫通部の前後は正しくならない
    //（1単位で塗るため壁と交互に塗れない）。盤は壁付け機器として扱う前提（Codex監査の判断）。
    // ══ 盤を塗る位置＝その盤の「奥行きの真ん中」の面・2026-09-04 ══
    // 【症状】盤どうしが重なると、奥の盤が手前の盤の上に描かれる。角度で変わる。
    // 【原因】盤は1単位で塗るので「どの位置で塗るか」を1つ選ぶ必要がある。
    //   これまで**いちばん手前の面**の位置を選んでいた。すると相手の盤の面が
    //   自分の手前面より先に並ぶ限り、相手が実際は手前でも丸ごと覆ってしまう。
    //   隣り合う2台では相手の面が自分の奥行き範囲の中に入るので、必ずこれが起きる。
    // 【直し方】盤の奥行きの真ん中に当たる面の位置で塗る。こうすると盤どうしは
    //   中心の深度で並ぶ（3次元図の _cabBoxDrawOrder と同じ考え方）。
    // 【限界】1単位で塗る以上、盤が他の立体を貫く配置では正しくならない（Painter's の限界）。
    const _panelFaces = new Map();          // 盤 → その盤の面の index の配列
    for (let i = 0; i < drawList.length; i++) {
      const pp2 = drawList[i].poly.paintPanel;
      if (!pp2) continue;
      if (!_panelFaces.has(pp2)) _panelFaces.set(pp2, []);
      _panelFaces.get(pp2).push(i);
    }
    // 【盤どうしの前後は分離平面で決める】代表点1つの深度（手前の面でも中心でも）では
    // 隣り合う盤の前後は決まらない。判定は boxDrawOrder.js（3次元図と共通）に一本化する。
    // 【視線ベクトルは実測】カメラ規約を推測せず、投影の depth の勾配から取る。
    // project3DPanel は depth大=手前（エディタ規約 nearSign=+1）なので勾配がそのまま手前向き。
    const _panelPaintAt = new Map();
    if (_panelFaces.size) {
      const _o0 = pr({ wx: 0, wy: 0, wz: 0 });
      let _dir = { x: pr({ wx: 1, wy: 0, wz: 0 }).depth - _o0.depth,
                   y: pr({ wx: 0, wy: 1, wz: 0 }).depth - _o0.depth,
                   z: pr({ wx: 0, wy: 0, wz: 1 }).depth - _o0.depth };
      const _dl = Math.hypot(_dir.x, _dir.y, _dir.z);
      if (_dl > 1e-12) _dir = { x: _dir.x / _dl, y: _dir.y / _dl, z: _dir.z / _dl };
      const _panels = [...(_panelFaces.keys())];
      let _order = _panels;
      {
        // 盤の外形をローカル座標の OBB にする。盤の面はすべて drawList に載っているので、
        // その頂点から軸に沿った外接箱を作れば十分（盤は床に立つ直方体）。
        const _boxes = _panels.map((pp2, i) => {
          let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity;
          for (const idx of _panelFaces.get(pp2)) {
            for (const p of (drawList[idx].poly.pts || [])) {
              if (p.wx<x0) x0=p.wx; if (p.wx>x1) x1=p.wx;
              if (p.wy<y0) y0=p.wy; if (p.wy>y1) y1=p.wy;
              if (p.wz<z0) z0=p.wz; if (p.wz>z1) z1=p.wz;
            }
          }
          if (!isFinite(x0)) return null;
          return { id: i, c: { x:(x0+x1)/2, y:(y0+y1)/2, z:(z0+z1)/2 },
            ax: [{x:1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1}],
            h: [Math.max((x1-x0)/2,1e-6), Math.max((y1-y0)/2,1e-6), Math.max((z1-z0)/2,1e-6)] };
        });
        const _ok = _dl > 1e-12 && _boxes.every(Boolean);
        if (_ok && typeof bdoOrderBoxes === 'function') {
          _order = bdoOrderBoxes(_boxes, _dir).map(b => _panels[b.id]);
        }
        // ══ 盤を塗る位置は「周りの面との前後関係」で決める・2026-09-06 ══
        // 【症状】盤に接している壁が盤より手前に描かれる（ユーザー報告）。
        // 【原因】塗る位置を「その盤の奥行きの真ん中の面」にしていた。1単位で塗る以上
        //   どこか1点を選ぶしかないが、真ん中を選ぶと**盤の手前半分に接している面は
        //   必ず盤より後に塗られる**。真ん中にしたのは盤どうしの前後を直すためだったが、
        //   代表点を1つ選ぶ方式である限り、どこを選んでも別の配置が壊れる。
        //   ＝**代表点の深度で立体の前後を代用していること自体が発生源**。
        // 【直し方】盤どうしで既に使っている分離平面(SAT)の判定を、周りの面すべてに広げる。
        //   ・盤が手前と判定された面 i は盤より前に塗る  → at ≥ i+1
        //   ・面が手前と判定された面 j は盤より後に塗る  → at ≤ j
        //   両側から挟んで「入れてよい区間」を作る。片側だけでは、盤より手前の面の
        //   さらに後ろへ盤を差し込む事故を防げない（Codex監査）。
        // 【面の箱】平らな面にぴったり張り付く OBB。軸に沿った外接箱だと斜めの壁が
        //   太って「重なっている」と誤判定され、いちばん直したい接触面で効かない。
        const _canSAT = _ok && typeof bdoCompare === 'function';
        const _fragOBB = [], _fragSB = [];
        // ══ 比べる相手は「立体の段」の面だけ・2026-09-17 ══
        // 【症状】壁の奥に置いた盤が、手前の壁より上に描かれる（ユーザー報告・画像あり）。
        // 【原因】床・部屋の色・ガワの面とも前後を比べていた。この3種は段で順番が固定
        //   （床→部屋→立体→ガワ）なので、「床の面が手前→その前に塗れ」「ガワの奥の面より
        //   盤が手前→その後に塗れ」という満たせない条件が必ず出て（実測 lo=51〜81 > hi=3〜6）、
        //   そのとき盤を最後＝ガワの後に塗っていた。手前の壁面より後になるので壁を透けて見える。
        // 【直し方】段の規則と同じ規則にそろえる。深度で比べるのは同じ立体の段の面だけにし、
        //   塗る位置は立体の段の範囲 [先頭, 末尾の次] に収める。
        // 【段階フラグ】window.__BP3_PANEL_SOLID_ONLY = false で従来（陽性対照）。
        const _solidOnly = !(typeof window !== 'undefined' && window.__BP3_PANEL_SOLID_ONLY === false);
        let _solidLo = 0, _solidHi = drawList.length;
        if (_solidOnly) {
          let a = -1, b = -1;
          for (let i = 0; i < drawList.length; i++) if (_rung(drawList[i].poly) === SOLID_RUNG) { if (a < 0) a = i; b = i; }
          if (a >= 0) { _solidLo = a; _solidHi = b + 1; }
        }
        if (_canSAT) {
          for (let i = 0; i < drawList.length; i++) {
            const e = drawList[i];
            // 盤自身の面は相手にしない（盤どうしの順は bdoOrderBoxes が決めている）
            if (e.poly.paintPanel) { _fragOBB.push(null); _fragSB.push(null); continue; }
            // 段で順が決まっている面（床・部屋の色・ガワ）は深度で比べない
            if (_solidOnly && _rung(e.poly) !== SOLID_RUNG) { _fragOBB.push(null); _fragSB.push(null); continue; }
            _fragOBB.push(_bp3FragOBB(e.poly.pts));
            _fragSB.push(_bp3ScreenBox(e.sp));
          }
        }
        // 求めた順を保ったまま塗る位置を決める。前の盤より必ず後に来るようにする
        let _prev = -1;
        // 【診断】盤ごとの塗る位置と「盤より手前と判定した面」（検査 bld_panel_behind_wall.cjs が読む）
        const _paintDiag = [];
        for (const pp2 of _order) {
          const idxs = _panelFaces.get(pp2);
          // 前後が決められないときの落としどころ＝奥行きの真ん中の面（従来の決め方）
          let dMin = Infinity, dMax = -Infinity;
          for (const i of idxs) { const d = drawList[i].depth;
            if (d < dMin) dMin = d; if (d > dMax) dMax = d; }
          const mid = (dMin + dMax) / 2;
          let midAt = idxs[idxs.length - 1], bestD = Infinity;
          for (const i of idxs) { const d = Math.abs(drawList[i].depth - mid);
            if (d < bestD) { bestD = d; midAt = i; } }
          let lo = _solidLo, hi = _solidHi;
          const _front = [];
          if (_canSAT) {
            const box = _boxes[_panels.indexOf(pp2)];
            let psb = null;   // 盤の画面上の外接矩形（重ならない面は比べる意味が無い）
            for (const i of idxs) {
              const sb = _bp3ScreenBox(drawList[i].sp);
              if (!sb) continue;
              psb = psb ? { x0: Math.min(psb.x0, sb.x0), y0: Math.min(psb.y0, sb.y0),
                            x1: Math.max(psb.x1, sb.x1), y1: Math.max(psb.y1, sb.y1) } : sb;
            }
            for (let i = 0; i < drawList.length; i++) {
              const fb = _fragOBB[i];
              if (!fb || !_bp3SBOverlap(psb, _fragSB[i])) continue;
              const r = bdoCompare(box, fb, _dir);
              if (r > 0) { if (i + 1 > lo) lo = i + 1; }   // 盤が手前 → 相手を先に塗る
              else if (r < 0) { if (i < hi) hi = i; _front.push({ i, layer: drawList[i].poly.layer || 0 }); } // 相手が手前 → 相手を後に塗る
            }
          }
          // 盤どうしの順は絶対に守る（矛盾したときもここだけは崩さない・Codex監査）
          lo = Math.max(lo, _prev + 1);
          const at = (lo <= hi) ? Math.min(Math.max(midAt, lo), hi) : lo;
          _panelPaintAt.set(pp2, at);
          _prev = at;
          _paintDiag.push({ id: pp2.id, at, front: _front, solid: [_solidLo, _solidHi], n: drawList.length });
        }
        if (typeof window !== 'undefined') window.__bp3PanelPaint = _paintDiag;
      }
    }
    const _paintPanelUnit = (placed) => {
      if (typeof pdcDrawPanel !== 'function' || typeof ppcMakeXf !== 'function') return;
      const pd = placed.panelData; if (!pd) return;
      const xfp = ppcMakeXf(placed);
      const projMm = (xMm, yMm, zMm) => {
        const w = xfp.toM(xMm, yMm, zMm);
        return pr(scene.toLocal(w[0], w[1], w[2]));
      };
      // 【裏面判定は投影から導く】カメラ規約を推測せず、depthの勾配＝視線方向を実測する。
      // depthが増える向きが手前(nearSign=+1)なので、法線とその内積の符号で表裏が決まる。
      const o0 = projMm(0, 0, 0);
      const gx = projMm(1, 0, 0).depth - o0.depth;
      const gy = projMm(0, 1, 0).depth - o0.depth;
      const gz = projMm(0, 0, 1).depth - o0.depth;
      const NS = 1;   // project3DPanel は depth大=手前（エディタ規約）
      try {
        pdcDrawPanel(ctx, pd, {
          proj: projMm,
          isBackFacing: (n) => (((n.nx || 0) * gx + (n.ny || 0) * gy + (n.nz || 0) * gz) * NS) <= 0,
          nearSign: NS,
          canvasSc: dpr,
        }, {
          iconVisMode: pd.iconVisMode ?? 'semi',
          cablesVisible: pd.showWires ?? true,
          doorsVisible: pd.doorsVisible ?? true,
        });
      } catch (e) { /* 盤1つの描画失敗で建物全体を落とさない */ }
    };
    // 【塗る予定を index 単位で持つ】盤を塗る位置は「その盤自身の面がある index」とは
    // 限らない（前の盤より後ろへずらすため）。面の paintPanel を見て判定すると
    // ずらした盤が一度も塗られずに消える。予定表を別に持って必ず全部塗る。
    const _paintAtIndex = new Map();
    _panelPaintAt.forEach((idx, pp2) => {
      const k = Math.min(idx, drawList.length - 1);
      if (!_paintAtIndex.has(k)) _paintAtIndex.set(k, []);
      _paintAtIndex.get(k).push(pp2);
    });
    const _painted = new Set();
    for (let _i = 0; _i < drawList.length; _i++) {
      const item = drawList[_i];
      const { sp, poly } = item;
      const _due = _paintAtIndex.get(_i);
      if (_due) for (const pp2 of _due) { _paintPanelUnit(pp2); _painted.add(pp2); }
      if (poly.paintPanel) continue;   // 箱の面自体は塗らない（掴む当たり判定にだけ使う）
      // 【spec 12.1】選択とホバーは同値扱いで同じ見た目にする（bcIsHot）。
      // ホバーだけを見ていると、クリックして選んだあとカーソルを外した瞬間に
      // オレンジが消えてしまい「何を選んでいるか」が分からない（ユーザー指摘）
      // ══ 階の空間（床を選んだときだけ描く）・2026-10-01 ══
      // 【「床を選んだ」の表し方が2つある】3Dで床をクリックすると selFloorHiId に入り、
      //   左の一覧で床の行を選ぶと selPartId（'floor:<階>' の形）に入る。
      //   どちらも同じ「床を選んだ」なので、判定はここ1つに吸収する
      //   （場所ごとに書き分けると、一覧から選んだときだけ出ない、という形で必ず漏れる）
      if (poly.layer === LAYER.SPACE) {
        const _on = !(typeof window !== 'undefined' && window.__BP3_FLOOR_SPACE === false);
        const _r = (selPartId && typeof bcParseEditPartId === 'function')
          ? bcParseEditPartId(selPartId) : null;
        const _sel = (selFloorHiId && selFloorHiId === poly.spaceFloorId)
                  || !!(_r && _r.partId == null && _r.floorId === poly.spaceFloorId);
        if (!_on || !_sel || editFloorId) continue;
      }
      const hoverWall = hover && hover.kind === 'wall' ? hover.partId : null;
      const hoverFloor = hover && hover.kind === 'floor' ? hover.floorId : null;
      const hoverDoor = hover && hover.kind === 'door' ? hover.doorId : hoverDoorId;
      const hoverIcon = hover && hover.kind === 'icon' ? hover.iconId : hoverIconId;
      const hoverShell = hover && hover.kind === 'shell' ? hover.shellFaceId : null;
      const isHot =
        (poly.layer === LAYER.ICON && bcIsHot(poly.iconId, selIconId, hoverIcon)) ||
        (poly.layer === LAYER.DOOR && bcIsHot(poly.doorId, selDoorId, hoverDoor)) ||
        (poly.layer === LAYER.WALL && bcIsHot(poly.partId, selPartId, hoverWall)) ||
        // 階編集モード中は床を光らせない（作業面であって選ぶ対象ではない）
        (!editFloorId && poly.layer === LAYER.FLOOR && bcIsHot(poly.floorId, selFloorHiId, hoverFloor)) ||
        // ガワの面（2026-09-23）。壁・床と同じ述語で強調する
        (poly.layer === LAYER.SHELL && bcIsHot(poly.shellFaceId, selShellFaceId, hoverShell));
      // 2点だけのものは「線」。閉じずに引く（作図のガイド線）
      if (sp.length === 2) {
        ctx.save();
        if (poly.dash) ctx.setLineDash(poly.dash);
        ctx.strokeStyle = poly.stroke || BC_UI.muted;
        ctx.lineWidth = poly.lineW || 1;
        ctx.beginPath(); ctx.moveTo(sp[0].x, sp[0].y); ctx.lineTo(sp[1].x, sp[1].y); ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.beginPath();
      sp.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.closePath();
      if (poly.fill) {
        ctx.globalAlpha = poly.alpha != null ? poly.alpha : 1;
        ctx.fillStyle = isHot ? bcHotFill(poly.fill) : poly.fill;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (isHot) {
        // 縁取りも**輪郭の抑制ルールに従う**。全周に引くと、交差で分割された断片の
        // 内部の辺（中央平面での切り口など）までオレンジで描かれ、
        // 交差部に無い線が入る（2026-08-25 ユーザー指摘）
        ctx.strokeStyle = BC_UI.accent; ctx.lineWidth = BP3_HOT_LINE_W;
        if (poly.edges) {
          ctx.beginPath();
          for (let kk = 0; kk < sp.length; kk++) {
            if (!poly.edges[kk]) continue;
            const q0 = sp[kk], q1 = sp[(kk + 1) % sp.length];
            ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y);
          }
          ctx.stroke();
        } else {
          ctx.stroke();
        }
      } else if (poly.stroke) {
        ctx.strokeStyle = poly.stroke; ctx.lineWidth = 1;
        if (poly.edges) {
          // 辺単位で描く。分割で生まれた内部の辺（帯の境目・切断端）は引かない。
          // 四角形まるごと stroke すると帯の境目に横線が出る（ユーザー指摘）
          ctx.beginPath();
          for (let k = 0; k < sp.length; k++) {
            if (!poly.edges[k]) continue;
            const q0 = sp[k], q1 = sp[(k + 1) % sp.length];
            ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y);
          }
          ctx.stroke();
        } else {
          ctx.stroke();
        }
      }
    }
    // 【塗り残しを出さない】予定した index が範囲外だった盤はここで必ず塗る。
    // 「1台も落とさない」ことをコード上で保証する（順序の都合で消えるのが最悪）
    _panelPaintAt.forEach((idx, pp2) => { if (!_painted.has(pp2)) _paintPanelUnit(pp2); });

    // 【選択中の壁の端点ギズモ】2Dと同じ●を最後に描く（面より手前に出す）。
    // 出すだけの飾りにしないため、画面座標を ref に残して掴めるようにする。
    // ヒット判定は drawList と同じく「描画で作った座標」を使う（投影を2度計算しない）
    // 【機器アイコンのラベル】面をすべて描き終えてから乗せる（面に隠れないように）。
    // 見た目は配電盤の pdcPaintIconLabel が唯一の正。建物側で別の描画を書かない
    // ══ ラベルは1枚ずつ独立・2026-09-04（ユーザー指示）══
    // 【なぜ整理をやめたか】重なりを避けるために「空いている段へ逃がす」方式にしたところ、
    //   1枚動かすと、その席が空いて別のラベルが繰り上がった。席を保持する形にしても
    //   「ラベルがラベルを押し出す」操作自体が残る。
    //   ユーザーの決定: **お互いのラベルは無視して独立させる。重なりは手で動かして直す。**
    // 【したがってここでは他のラベルを一切見ない】
    //   ・位置は「既定位置 ＋ 自分で動かしたぶん」だけで決まる
    //   ・他のラベルの有無・位置・選択状態に影響されない
    //   ・隠さない（読みたければ手で動かせる。勝手に消える方が困る）
    // 重なりが気になるときはラベルを掴んで動かす（labelDx/labelDy に保存される）。
    const _hoverIconNow2 = hover && hover.kind === 'icon' ? hover.iconId : hoverIconId;
    const _hits = [];
    for (const item of drawList) {
      const poly = item.poly;
      if (poly.layer !== LAYER.ICON || !poly.labelText || !(poly.labelDrawAt || poly.labelAt)) continue;
      // 表示位置は labelDrawAt が優先（床置きの箱は上面の中心・壁付けは板の上辺）。
      // labelAt は当たり判定・↻ハンドル用なので描画都合で動かさない
      const b0 = pr(poly.labelDrawAt || poly.labelAt);
      // ずらし量は「画面px ÷ zoom」で持つ。描くときに ×zoom して戻す（平面図・3次元図と同じ考え方）
      const put = { x: b0.x + (poly.labelDx || 0) * c.zoom, y: b0.y + (poly.labelDy || 0) * c.zoom };
      const txt = pdcIconLabelText({ name: poly.labelText });
      // 【大きさは機器の見かけの大きさに追従させる・2026-09-05】
      // 以前は view に大きさの情報を渡しておらず、core が固定8pxを返していた
      // （＝拡大しても文字が大きくならない）。外接直方体の8隅を投影して
      // 「幅と高さの大きい方」を測り、それを core の pdcLabelMetrics に渡す。
      // 1辺だけを見ると、その辺がカメラを向いた瞬間に0になってラベルが潰れる。
      // 【隠さない】14.61 のユーザー決定。方針名 'editor' を渡すと core は
      // 「出す・下限を確保する」に切り替わる（3次元図の"読めないなら出さない"とは別方針）
      let _span = 0;
      if (poly.labelBox) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const cn of _bp3BoxCorners(poly.labelBox)) {
          const s = pr(cn);
          if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
          if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
        }
        if (Number.isFinite(x0)) _span = Math.max(x1 - x0, y1 - y0);
      }
      const _sel = bcIsHot(poly.iconId, selIconId, _hoverIconNow2);   // 文字色（選択 or ホバー）
      // 遠景でも必ず出すのはホバー中・ドラッグ中だけ（全図共通の判定 pdcLabelPinned）
      const _dr = dragRef.current;
      const _pin = pdcLabelPinned({
        hover: _hoverIconNow2 != null && _hoverIconNow2 === poly.iconId,
        dragging: !!(_dr && _dr.iconId != null && _dr.iconId === poly.iconId),
        selected: selIconId != null && selIconId === poly.iconId,
      });
      const _lm = pdcPaintIconLabel(ctx, put, txt,
                        { lwUnit: 1, labelSpanPx: _span, labelScale: 1,
                          labelPinned: _pin, labelAlwaysShow: BP3_LABEL_ALWAYS_SHOW,
                          labelPxPerMeter: c.zoom },   // シーンはメートル・正射影＝画面px/m は zoom
                        { isSel: _sel });
      // 掴める範囲は**実際に描いた文字の外接矩形そのもの**（2026-09-08）。
      // 【直した中身】以前は Math.max(18, 幅/2)+4 と Math.max(10, 文字×0.75) だった。
      //   ・Math.max(18,…) と Math.max(10,…) は**固定px**なので、文字が小さくても
      //     36×20px の箱が残る（＝文字より広い場所で掴めてしまう）
      //   ・幅は pdcLabelWidth の概算、高さは 0.75em の当て推量
      //   ・+4 の余白ぶんだけ文字の外へはみ出す
      //   ユーザー報告「固定pxにしていないか？その時の文字の表示サイズに依存するんだぞ」。
      // core が measureText で実測した箱をそのまま使えば、書体・倍率・文字数が
      // どう変わっても必ず一致する（SVG側の getBBox 実測と同じ考え方）
      if (poly.iconId != null && _lm && _lm.box) {
        const _b = _lm.box;
        _hits.push({
          iconId: poly.iconId, partId: poly.partId, floorId: poly.floorId,
          x: (_b.x0 + _b.x1) / 2, y: (_b.y0 + _b.y1) / 2,
          hw: (_b.x1 - _b.x0) / 2, hh: (_b.y1 - _b.y0) / 2,
          text: txt, dx: poly.labelDx || 0, dy: poly.labelDy || 0,
        });
      }
    }
    labelHitsRef.current = _hits;
    // 【📷は選択したら・文字の右端から・2026-09-16】全図共通の判定 pdcCamBadgeOn・位置 pdcLabelCamBadge。
    // ラベルが出ている（＝当たり箱がある）ときだけ出す。大きさの情報は描いたときと同じ引数で core から取り直す
    camHitRef.current = null;
    if (onFocusIcon && !drawTool && selIconId != null && pdcCamBadgeOn({ selected: true, hover: false })) {
      const _sh = _hits.find(q => q.iconId === selIconId);
      if (_sh) {
        const _cm = pdcLabelMetrics(0, 1, true, { pxPerMeter: c.zoom });
        const { cx, cy, r } = pdcLabelCamBadge(_sh.x + _sh.hw, _sh.y, _cm, 1);
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
        ctx.strokeStyle = PDC_LABEL.TEXT; ctx.lineWidth = r * 0.12; ctx.stroke();
        ctx.fillStyle = PDC_LABEL.TEXT; ctx.font = `${r * 1.25}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('📷', cx, cy);
        ctx.restore();
        camHitRef.current = { cx, cy, r, iconId: _sh.iconId, partId: _sh.partId, floorId: _sh.floorId };
      }
    }
    if (typeof window !== 'undefined') window.__bldCamHit = camHitRef.current;   // 読み取り専用（検査用）
    // 【掴める範囲を目で見る】__labelBox() から立てる旗。数値の突き合わせより速い
    if (typeof window !== 'undefined') {
      window.__bldLabelHits = _hits;
      window.__bldLabelPpm = c.zoom;   // 読み取り専用: ラベル判定に使った画面px/m（checks/bld_label_ppm.cjs が突き合わせる）
      if (window.__BLD_LABEL_BOX) {
        ctx.save();
        ctx.strokeStyle = '#EF4444'; ctx.lineWidth = 1;
        ctx.fillStyle = 'rgba(239,68,68,0.12)';
        for (const q of _hits) {
          ctx.fillRect(q.x - q.hw, q.y - q.hh, q.hw * 2, q.hh * 2);
          ctx.strokeRect(q.x - q.hw, q.y - q.hh, q.hw * 2, q.hh * 2);
        }
        ctx.restore();
      }
    }
    // 【床の形の頂点●】面より手前に出す。2Dと同じ関数を使う（見た目は1箇所で管理）
    if (drawPoly && drawPoly.pts && drawPoly.pts.length) {
      bcPaintOutlinePts(ctx, drawPoly.pts.map(p => pr(scene.toLocal(p.x, p.y, drawPoly.z + 0.03))));
    }
    gizmoRef.current = null;
    if (selWall && selWall.handles && !drawTool) {
      const hs = selWall.handles.map(h => ({
        ...h, s: pr(scene.toLocal(h.x, h.y, h.z)),
      }));
      gizmoRef.current = { partId: selWall.partId, z: selWall.z, list: hs };
      hs.forEach(h => bcPaintGizmo(ctx, h.s.x, h.s.y, h.kind));
    }
    // 【床置きの箱の回転ハンドル】選んでいる箱の真上に↻を出す。
    // 平面図・3次元図の盤にある↻（App.jsx の panelRotDrag）と同じ操作感に揃える。
    // 位置はドラッグ判定と共有するので ref に書き出す（同じ投影を2度計算しない）。
    iconRotRef.current = null;
    if (selIconId && !drawTool && onRotateIcon) {
      const it = drawList.find(q => q.poly && q.poly.iconId === selIconId && q.poly.labelAt);
      if (it) {
        const c = pr(it.poly.labelAt);
        const hx = c.x, hy = c.y - BP3_ROT_HANDLE_DY;
        // 📷は↻の隣。他のビューを「この機器へ寄せる」ボタン（建屋のカメラマークと同じ役目）
        const fx = hx + BP3_ROT_HANDLE_R * 2 + 6, fy = hy;
        iconRotRef.current = { iconId: selIconId, partId: it.poly.partId, floorId: it.poly.floorId,
                               cx: c.x, cy: c.y, hx, hy, fx, fy };
        ctx.save();
        ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.beginPath(); ctx.arc(hx, hy, BP3_ROT_HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(15,23,42,0.85)'; ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#F59E0B'; ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('↻', hx, hy + 1);
        if (onFocusIcon && typeof window !== 'undefined' && window.__CAM_BADGE_ON_SELECT === false) {   // 旧: ↻の隣（陽性対照のときだけ）
          ctx.strokeStyle = '#38BDF8';
          ctx.beginPath(); ctx.arc(fx, fy, BP3_ROT_HANDLE_R, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(15,23,42,0.85)'; ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#38BDF8'; ctx.font = 'bold 11px sans-serif';
          ctx.fillText('📷', fx, fy + 1);
        }
        ctx.restore();
      }
    }
    // 【寸法表示】ドラッグ中は今の値を出す。配電盤が仕切りを動かすときに出すものと同じ見た目
    if (dimLabel && dimLabel.text && gizmoRef.current) {
      const h = gizmoRef.current.list.find(q => q.type === dimLabel.handle) || gizmoRef.current.list[0];
      if (h) _bp3DrawDimLabel(ctx, h.s.x, h.s.y - 22, dimLabel.text);
    }
  });

  // ── 操作（配電盤エディタと同じ割当て・同じ更新式）──
  // 中ボタン or Ctrl+左ドラッグ = 回転 / 左ドラッグ = パン / ホイール = カーソル基準ズーム
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    // 効果が張り直されるたびにカーソルを初期化するので、今の状態を必ず反映させる。
    // ・作図中は crosshair を保つ（作図の予告が出るたびに戻ってしまっていた）
    // ・**ドラッグ中は grabbing を保つ**。ドラッグ中は毎フレーム親のプレビュー状態が
    //   更新されてこの効果が張り直されるため、この1行が pointerdown で設定した
    //   grabbing を上書きし、動かし始めた瞬間に手が開いていた（2026-08-27 指摘）
    cv.style.cursor = dragRef.current ? BC_CURSOR.dragging
                    : (drawTool ? BC_CURSOR.place : BC_CURSOR.idle);
    const onDown = (e) => {
      const isRot = e.button === 1 || (e.button === 0 && e.ctrlKey);
      // 診断: 入口。ここが出ないなら pointerdown 自体が届いていない
      if (typeof window !== 'undefined' && window.__dragLogOn) {
        (window.__dragLog = window.__dragLog || []).push({
          所: '3D:down入口', button: e.button, ctrl: !!e.ctrlKey,
          作図中: !!drawTool, 回転操作: isRot });
        if (window.__dragLog.length > 200) window.__dragLog.shift();
      }
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      stopCamAnim('user');   // 押したら利用者がカメラを取った。寄せの補間が次のコマで上書きしないよう止める
      // 図面を触ったら数値欄の編集は終わり。フォーカスを外しておかないと
      // Ctrl+Z や Delete が入力欄ガード（bcCanHandleDeleteKey）に弾かれ、
      // 「3Dの編集がundoできない」ことになる（spec 12.8 と同じ構図）
      _bp3BlurField();
      const c = camRef.current;
      // 【作図中】左クリックは点を打つ。選択もドラッグもしない（2Dと同じ割当て）
      if (drawTool && e.button === 0 && !e.ctrlKey) {
        const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, drawFloorZ);
        // 【機器は「クリックした面」の上に置く】床の面へ落とすと、垂直な扉・壁では
        // 光線が向こう側へ抜けて裏面に付く（上の _bp3PointOnFace の説明）。
        // 壁・扉の面を掴めたときだけ、その面の上の点を一緒に渡す
        let face = null;
        if (drawTool === 'icon') {
          const r0 = cv.getBoundingClientRect();
          const d = drawListRef.current;
          const hit = d && _bp3FaceUnderCursor(d.list, e.clientX - r0.left, e.clientY - r0.top);
          if (hit) {
            const gp = scene.toGrid(hit.wx, hit.wy);
            face = { gx: gp.x, gy: gp.y, z: scene.toWorldZ ? scene.toWorldZ(hit.wz) : hit.wz,
                     partId: hit.partId, doorId: hit.doorId };
          }
        }
        if (g && onDrawClick) { onDrawClick(g, face); return; }
      }
      // 左ボタン単独なら、まず壁を掴めるか見る。掴めなければ従来どおりパン
      if (e.button === 0 && !e.ctrlKey) {
        const rect = cv.getBoundingClientRect();
        // 【判定の順序】機器・扉のように**面の内側にぴったり入った**ものを最優先にする。
        // ギズモは12pxの「寄せ」判定なので、壁のギズモが機器の上に重なると
        // 機器を一生掴めなくなる（2026-08-28 実測。壁の中央●が機器を覆っていた）。
        // 「ぴったり当たったもの」＞「寄せで当たるハンドル」の順にする
        // 【回転ハンドルを最優先】箱の上に浮いているので、箱本体・壁・ギズモより先に判定する。
        // 後回しにすると箱の当たり判定に食われて一生掴めない（壁の中央●が機器を覆っていたのと同じ罠）
        // 📷（ラベルの右）。↻より先に見る（ラベルの右に浮いているので箱・壁に食われないように）
        const _cmh = camHitRef.current;
        if (_cmh && onFocusIcon && !drawTool) {
          const _mx = e.clientX - rect.left, _my = e.clientY - rect.top;
          if ((_mx - _cmh.cx) * (_mx - _cmh.cx) + (_my - _cmh.cy) * (_my - _cmh.cy) <= _cmh.r * _cmh.r) {
            e.preventDefault();
            onFocusIcon(_cmh.floorId, _cmh.partId, _cmh.iconId);
            return;
          }
        }
        const irh = iconRotRef.current;
        if (irh && onFocusIcon && !drawTool && irh.fx != null
            && typeof window !== 'undefined' && window.__CAM_BADGE_ON_SELECT === false) {   // 旧: ↻の隣の📷
          const _mx = e.clientX - rect.left, _my = e.clientY - rect.top;
          if ((_mx - irh.fx) * (_mx - irh.fx) + (_my - irh.fy) * (_my - irh.fy) <= BP3_ROT_HIT_R * BP3_ROT_HIT_R) {
            e.preventDefault();
            onFocusIcon(irh.floorId, irh.partId, irh.iconId);
            return;
          }
        }
        if (irh && onRotateIcon && !drawTool) {
          const _mx = e.clientX - rect.left, _my = e.clientY - rect.top;
          if ((_mx - irh.hx) * (_mx - irh.hx) + (_my - irh.hy) * (_my - irh.hy) <= BP3_ROT_HIT_R * BP3_ROT_HIT_R) {
            const _ccx = irh.cx + rect.left, _ccy = irh.cy + rect.top;
            dragRef.current = { type: 'iconRot', iconId: irh.iconId, partId: irh.partId, floorId: irh.floorId,
                                cx: _ccx, cy: _ccy,
                                a0: Math.atan2(e.clientY - _ccy, e.clientX - _ccx), pointerId: e.pointerId };
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            cv.style.cursor = BC_CURSOR.dragging;
            // 【掴んだ瞬間からガイド表示・2026-09-03】dDeg=0 で1回呼ぶ。onRotateIcon3D 側は
            // dDeg===0 を表示専用に扱い、機器の書き込み・吸い付きはしない（壁ガイドの永続方式に倣う）。
            onRotateIcon(irh.floorId, irh.partId, irh.iconId, 0, false);
            return;
          }
        }
        // 【名称ラベル】面の上に乗せて描いてあるので、面より先に判定する。
        // 3次元図・平面図でラベルを動かせるのと同じ操作にそろえる
        if (onDragLabel && !drawTool) {
          const _lx = e.clientX - rect.left, _ly = e.clientY - rect.top;
          const lh = labelHitsRef.current.find(q =>
            Math.abs(_lx - q.x) <= q.hw && Math.abs(_ly - q.y) <= q.hh);
          if (lh) {
            dragRef.current = { type: 'iconLabel', iconId: lh.iconId, partId: lh.partId, floorId: lh.floorId,
                                sx: e.clientX, sy: e.clientY, dx0: lh.dx, dy0: lh.dy,
                                zoom: (camRef.current && camRef.current.zoom) || 1, pointerId: e.pointerId };
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            cv.style.cursor = BC_CURSOR.dragging;
            return;
          }
        }
        // 【2026-09-23】ガワの編集中は **ガワの面を最優先**。そうしないと部屋の壁・床が
        // 先に当たって、建物の外殻の面には永久にたどり着けない（ユーザー実機報告）
        if (shellMode) {
          const _sx = e.clientX - rect.left, _sy = e.clientY - rect.top;
          const sh0 = _bp3HitShell(drawListRef.current, _sx, _sy);
          if (sh0) {
            if (sh0.shellFaceId === selShellFaceId && onFaceSketchRect) {
              const p0 = _bp3ShellPointAt(drawListRef.current, _sx, _sy, sh0.shellFaceId);
              if (p0 && p0.poly && p0.poly.faceVerts) {
                faceSketchRef.current = {
                  faceId: sh0.shellFaceId, blockIdx: sh0.blockIdx, edgeIdx: sh0.edgeIdx,
                  faceVerts: p0.poly.faceVerts, a: p0, b: p0, pointerId: e.pointerId,
                };
                setFaceSketch({ ...faceSketchRef.current, corners: null });
                try { cv.setPointerCapture(e.pointerId); } catch (err) {}
                _bp3BlurField();
                return;
              }
            }
            if (onSelectShellFace) onSelectShellFace(sh0);
            return;
          }
          // 【2026-09-23 ユーザー報告「このモードの時に空間を握ってカメラ移動できない」】
          // ガワに当たらなければ選択を外すだけにして、**下へ落としてカメラ操作に任せる**。
          // ここで return するとカメラが動かせなくなる
          if (onSelectNone) onSelectNone();
        }
        const ihPre = _bp3HitIcon(drawListRef.current, e.clientX - rect.left, e.clientY - rect.top);
        const dhPre = ihPre ? null : _bp3HitDoor(drawListRef.current, e.clientX - rect.left, e.clientY - rect.top);
        // 端点ギズモは面より優先（2Dと同じく本体より端点を優先。ヒットは12px）
        const gz = gizmoRef.current;
        if (!ihPre && !dhPre && gz && onDragGizmo) {
          const best = _bp3HitGizmo(gz, e.clientX - rect.left, e.clientY - rect.top);
          if (best) {
            // 'top' は高さ＝1自由度。配電盤の panelAxisScreenVec と同じ考え方で
            // 「軸を画面へ投影し、ドラッグ量を内積で軸上の移動量に変換する」。
            // 平面への逆投影を1自由度に流用すると特異点の問題を持ち込むことになる（監査の布石）
            let axisPx = null;
            if (best.type === 'top' || best.type === 'base' || best.type === 'vmove') {
              const pr0 = prRef.current;
              const p0 = pr0 && pr0(scene.toLocal(best.x, best.y, best.z));
              const p1 = pr0 && pr0(scene.toLocal(best.x, best.y, best.z + 1)); // 1m 上
              axisPx = (p0 && p1) ? { dx: p1.x - p0.x, dy: p1.y - p0.y } : null;
            }
            dragRef.current = { type: 'gizmo', partId: gz.partId, handle: best.type,
                                floorZ: gz.z, sx: e.clientX, sy: e.clientY, axisPx, pointerId: e.pointerId };
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            cv.style.cursor = BC_CURSOR.dragging; // 掴んだら握った手にする
            return;
          }
        }
        // 【機器】壁の面に貼ってあるので、扉・壁より先に判定する（上で拾った結果を使う）
        const ih = ihPre;
        // 診断: 掴めたか／開始条件のどれが落ちたかを記録する（__dragLog）
        if (typeof window !== 'undefined' && window.__dragLogOn) {
          const _p0 = prRef.current;
          (window.__dragLog = window.__dragLog || []).push({
            所: '3D:down',
            機器を拾えたか: !!ih, iconId: ih ? ih.iconId : null, partId: ih ? ih.partId : null,
            開始条件: { onDragIconあり: !!onDragIcon, 投影関数あり: !!_p0,
                        at: !!(ih && ih.at), axisS: !!(ih && ih.axisSAt), axisT: !!(ih && ih.axisTAt) },
            当たり判定の件数: ((drawListRef.current && drawListRef.current.list) || [])
              .filter(q => q.poly && q.poly.iconId != null).length,
          });
          if (window.__dragLog.length > 200) window.__dragLog.shift();
        }
        if (ih) {
          if (onSelectIcon) onSelectIcon(ih.iconId, ih.partId);
          const pr0 = prRef.current;
          if (onDragIcon && pr0 && ih.at && ih.axisSAt && ih.axisTAt) {
            // 【カーソルと動きを合わせる】アイコンが乗っている**壁の面の上の2軸**で解く。
            // 以前は水平を「床面への逆投影」、垂直を「画面への内積射影」という
            // 別々の方式でやっていたため、高さのあるアイコンではカーソルとずれた。
            // U = 壁に沿って1m / V = 真上に1m の画面ベクトル。
            // 画面のドラッグ量Δを Δ = ds*U + dt*V として解けば正射影では厳密に一致する
            const c0 = pr0(ih.at), cS = pr0(ih.axisSAt), cT = pr0(ih.axisTAt);
            dragRef.current = { type: 'icon', iconId: ih.iconId, partId: ih.partId,
                                floorId: ih.floorId, floorZ: ih.floorZ,
                                U: { x: cS.x - c0.x, y: cS.y - c0.y },
                                V: { x: cT.x - c0.x, y: cT.y - c0.y },
                                sx: e.clientX, sy: e.clientY, pointerId: e.pointerId };
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            cv.style.cursor = BC_CURSOR.dragging;
          }
          return;
        }
        // 【扉】壁より先に判定する。扉は壁の中にあるので後回しだと永久に掴めない
        const dh = dhPre;
        if (dh) {
          if (onSelectDoor) onSelectDoor(dh.doorId, dh.partId);
          const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, dh.floorZ);
          if (g && onDragDoor) {
            dragRef.current = { type: 'door', doorId: dh.doorId, partId: dh.partId,
                                floorId: dh.floorId, floorZ: dh.floorZ, g0: g, pointerId: e.pointerId };
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            cv.style.cursor = BC_CURSOR.dragging;
          }
          return;
        }
        const hit = _bp3HitWall(drawListRef.current, e.clientX - rect.left, e.clientY - rect.top);
        if (hit && onGrabWall) {
          const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, hit.floorZ);
          // 掴めたと確認できたときだけ壁ドラッグに入る。
          // 掴めなければ下へ抜けてカメラ操作にする（無反応の袋小路を作らない）
          if (g && onGrabWall(hit.floorId, hit.partId) === true) {
            dragRef.current = {
              type: 'wall', floorId: hit.floorId, partId: hit.partId, floorZ: hit.floorZ,
              g0: g, pointerId: e.pointerId,
            };
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            cv.style.cursor = BC_CURSOR.dragging;
            return;
          }
        }
        // 壁でなければ床を拾って階を選ぶ（3Dで階をクリックして選べるようにする）。
        // 何も無い所なら選択を外す。選択は排他で、今クリックしたものだけが光る
        if (!hit) {
          const _mx = e.clientX - rect.left, _my = e.clientY - rect.top;
          const fh = _bp3HitFloor(drawListRef.current, _mx, _my);
          if (fh) { if (onSelectFloor) onSelectFloor(fh.floorId); }
          else {
            // 【2026-09-23】床でもなければガワの面。ここが「辺0/辺1」を選ばせずに
            // 図の上で面を指すための入口（ユーザー要求）
            const sh = _bp3HitShell(drawListRef.current, _mx, _my);
            if (sh && sh.shellFaceId === selShellFaceId && onFaceSketchRect) {
              // 【2026-09-23】**選んである面をもう一度押した**＝その面にスケッチを描く。
              // CAD の「面を選ぶ→面にスケッチ→押し出し」の2手目。
              const p0 = _bp3ShellPointAt(drawListRef.current, _mx, _my, sh.shellFaceId);
              if (p0 && p0.poly && p0.poly.faceVerts) {
                faceSketchRef.current = {
                  faceId: sh.shellFaceId, blockIdx: sh.blockIdx, edgeIdx: sh.edgeIdx,
                  faceVerts: p0.poly.faceVerts, a: p0, b: p0, pointerId: e.pointerId,
                };
                setFaceSketch({ ...faceSketchRef.current, corners: null });
                try { cv.setPointerCapture(e.pointerId); } catch (err) {}
                _bp3BlurField();
                return;   // カメラ回転に入らない
              }
            }
            if (sh && onSelectShellFace) onSelectShellFace(sh);
            else if (onSelectNone) onSelectNone();
          }
        }
      }
      // 【回転の中心】選んでいるものがあれば、その画面位置を固定したまま回す。
      // 全体の中心まわりに回すと、選んだ壁や機器が画面外へ流れていく（ユーザー指摘）
      let pivot = null, pivotS = null;
      if (isRot) {
        const rc = cv.getBoundingClientRect();
        // 【押した場所を中心にする】ユーザーの期待は「壁の上で押したらそこを中心に回る」。
        // 選択中のものの重心にすると、長い壁の端で押しても中央まわりに回って気持ち悪い
        pivot = _bp3PivotUnderCursor(drawListRef.current, e.clientX - rc.left, e.clientY - rc.top);
        // 何も無い所で押したときは、選んでいるものの重心 → それも無ければ全体の中心
        if (!pivot) pivot = _bp3PivotOf(drawListRef.current,
          { iconId: selIconId, doorId: selDoorId, partId: selPartId, floorId: selFloorHiId });
        if (pivot && prRef.current) pivotS = prRef.current(pivot);
        if (!pivotS) pivot = null;
      }
      dragRef.current = {
        type: isRot ? 'rotate' : 'pan',
        sx: e.clientX, sy: e.clientY,
        az0: c.az, el0: c.el, panX0: c.panX, panY0: c.panY,
        pivot, pivotS,
        pointerId: e.pointerId,
      };
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      cv.style.cursor = BC_CURSOR.dragging;
    };
    const onMove = (e) => {
      const d = dragRef.current;
      // 診断: 移動が届いているか／そのとき掴んでいる状態が残っているか。
      // 移動は毎フレーム来るので、記録は先頭12件までに絞る（ログが埋まると読めない）
      if (typeof window !== 'undefined' && window.__dragLogOn) {
        const L = (window.__dragLog = window.__dragLog || []);
        const n = L.filter(q => q.所 === '3D:移動が届いた').length;
        if (n < 12) L.push({ 所: '3D:移動が届いた', 掴んでいる: d ? d.type : 'なし（空）' });
      }
      if (!d) {
        // 作図中はカーソル位置を床面へ写して返す（候補線とガイドの更新用）
        if (drawTool) {
          const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, drawFloorZ);
          if (g && onDrawHover) onDrawHover(g);
          cv.style.cursor = BC_CURSOR.place;
          return;
        }
        // ドラッグしていない間は「今クリックすると何が選ばれるか」を見せる
        const rect = cv.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        // 判定の順序は押すときと同じ「機器 ＞ 扉 ＞ ギズモ ＞ 壁 ＞ 床」。
        // 順序を2箇所で食い違わせると「光る物と掴める物が違う」ことになる
        // 【ラベルに当てても、その機器にカーソルを当てた扱い・2026-09-16 ユーザー指示】
        // 旧: ラベルの上は面の判定だけで、ラベルに当ててもラベルを必ず出す扱いにならなかった。ラベルは面の上に描くので面より先に見る
        const _lh = (labelHitsRef.current || []).find(q => Math.abs(x - q.x) <= q.hw && Math.abs(y - q.y) <= q.hh);
        const ic = _lh ? { iconId: _lh.iconId, partId: _lh.partId, floorId: _lh.floorId }
                       : _bp3HitIcon(drawListRef.current, x, y);
        const dr = ic ? null : _bp3HitDoor(drawListRef.current, x, y);
        // ハンドルは壁より手前だが、面にぴったり当たった機器・扉には譲る
        const gzHit = (!ic && !dr && onDragGizmo) ? _bp3HitGizmo(gizmoRef.current, x, y) : null;
        const w = (ic || dr) ? null : _bp3HitWall(drawListRef.current, x, y);
        // 【階編集モード中は床を光らせない】その階を見ているのは自明で、
        // 床は「選ぶ対象」ではなく作業面だから（ユーザー指摘）
        // 【2026-09-23】ガワの編集中は、光る対象もガワの面にそろえる
        // （光る場所と選べる場所が違うと、どこを押せばよいか分からなくなる）
        if (shellMode && !faceSketchRef.current) {
          const sh2 = _bp3HitShell(drawListRef.current, x, y);
          const nx = sh2 ? { kind: 'shell', shellFaceId: sh2.shellFaceId, blockIdx: sh2.blockIdx } : null;
          setHover(prev => {
            const same = (!prev && !nx) || (prev && nx && prev.kind === nx.kind
              && prev.shellFaceId === nx.shellFaceId);
            return same ? prev : nx;
          });
          cv.style.cursor = sh2 ? BC_CURSOR.grab : BC_CURSOR.idle;
          return;
        }
        // 【2026-09-23】面にスケッチ中は矩形だけ更新する（ホバーの判定はしない）
        if (faceSketchRef.current) {
          const fsk = faceSketchRef.current;
          const p1 = _bp3ShellPointAt(drawListRef.current, x, y, fsk.faceId, false);
          if (p1) {
            fsk.b = p1;
            const rr = _bp3WallRectCorners(fsk.faceVerts, fsk.a, fsk.b);
            setFaceSketch({ ...fsk, corners: rr ? rr.corners : null });
          }
          return;
        }
        const f = (ic || dr || w || editFloorId) ? null : _bp3HitFloor(drawListRef.current, x, y);
        // ガワは最後（半透明で大きいので、先に見ると他が掴めなくなる）
        const sh = (ic || dr || w || f) ? null : _bp3HitShell(drawListRef.current, x, y);
        const next = ic ? { kind: 'icon', iconId: ic.iconId, partId: ic.partId, floorId: ic.floorId }
                   : dr ? { kind: 'door', doorId: dr.doorId, partId: dr.partId, floorId: dr.floorId }
                   : w ? { kind: 'wall', partId: w.partId, floorId: w.floorId }
                   : f ? { kind: 'floor', floorId: f.floorId }
                       : (sh ? { kind: 'shell', shellFaceId: sh.shellFaceId, blockIdx: sh.blockIdx } : null);
        setHover(prev => {
          const same = (!prev && !next) ||
            (prev && next && prev.kind === next.kind && prev.doorId === next.doorId &&
             prev.iconId === next.iconId && prev.partId === next.partId && prev.floorId === next.floorId &&
             prev.shellFaceId === next.shellFaceId);
          return same ? prev : next; // 同じなら状態を変えない（毎フレーム再描画しない）
        });
        cv.style.cursor = gzHit ? BC_CURSOR.gizmo : (next ? BC_CURSOR.element : BC_CURSOR.idle);
        return;
      }
      if (d.type === 'gizmo') {
        if (d.handle === 'top' || d.handle === 'base' || d.handle === 'vmove') {
          // 画面上のドラッグ量を「上方向の軸」へ内積で射影して m に直す
          const ax = d.axisPx, l2 = ax ? (ax.dx*ax.dx + ax.dy*ax.dy) : 0;
          const dm = l2 > 1e-9 ? ((e.clientX-d.sx)*ax.dx + (e.clientY-d.sy)*ax.dy) / l2 : 0;
          if (onDragGizmo) onDragGizmo(d.partId, d.handle, { dM: dm }, false);
          return;
        }
        const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, d.floorZ);
        if (g && onDragGizmo) onDragGizmo(d.partId, d.handle, g, false);
        return;
      }
      if (d.type === 'icon') {
        const st = _bp3SolveUV(d, e);
        // 診断: どこで止まっているかを実機で追えるようにする（__dragLog）
        if (typeof window !== 'undefined' && window.__dragLogOn) {
          (window.__dragLog = window.__dragLog || []).push({
            所: '3D:move', iconId: d.iconId,
            U: d.U && { x: +d.U.x.toFixed(2), y: +d.U.y.toFixed(2) },
            V: d.V && { x: +d.V.x.toFixed(2), y: +d.V.y.toFixed(2) },
            画面移動: { dx: e.clientX - d.sx, dy: e.clientY - d.sy },
            解: st ? { ds: +st.ds.toFixed(4), dt: +st.dt.toFixed(4) } : null,
            onDragIconあり: !!onDragIcon,
          });
          if (window.__dragLog.length > 200) window.__dragLog.shift();
        }
        if (st && onDragIcon) onDragIcon(d.floorId, d.partId, d.iconId, st.ds, st.dt, false);
        return;
      }
      if (d.type === 'iconLabel') {
        // 【5px 動くまではクリック候補・2026-09-17】判定は共通コア pdcBeyondClickSlop 1本（3次元図・平面図と同じ）。
        // 以前は1pxから即ラベルを動かし、離しても機器を選ばなかった。遠景では機器本体がホバーで出たラベルに
        // 覆われるので、機器を押しても一切選べなかった（ユーザー報告・実測: 3機器とも iconLabel 扱い）。
        // 段階フラグ window.__BP3_LABEL_CLICK_SELECTS = false で従来（陽性対照）。
        if (_bp3LabelClickSelects() && !d.moved) {
          if (!pdcBeyondClickSlop(e.clientX - d.sx, e.clientY - d.sy)) return;
          d.moved = true;
        }
        const z = d.zoom || 1;
        if (onDragLabel) onDragLabel(d.floorId, d.partId, d.iconId,
          d.dx0 + (e.clientX - d.sx) / z, d.dy0 + (e.clientY - d.sy) / z, false);
        return;
      }
      if (d.type === 'iconRot') {
        // 掴んだ瞬間からのカーソル角の差分だけ渡す。向きへの変換と符号は親が決める
        const _a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
        if (onRotateIcon) onRotateIcon(d.floorId, d.partId, d.iconId, (_a - d.a0) * 180 / Math.PI, false);
        return;
      }
      if (d.type === 'door') {
        // 掴んだ位置からの差分で壁に沿ってスライド。uM への変換は親（bcDoorUAtPoint）に任せる
        const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, d.floorZ);
        if (g && onDragDoor) onDragDoor(d.floorId, d.partId, d.doorId, d.g0, g, false);
        return;
      }
      if (d.type === 'wall') {
        // 【3Dのまま壁を掴んで動かす】カーソルを「その階の床の高さの水平面」へ逆投影し、
        // 掴んだ瞬間との差分だけ壁を平行移動する。カメラが斜めでも成立する。
        // 確定は mouseup（2DのF2と同じ: ドラッグ中は本体を変えない）
        const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, d.floorZ);
        if (g && onDragWall) onDragWall(d.floorId, d.partId, g.x - d.g0.x, g.y - d.g0.y, false);
        return;
      }
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      const c = camRef.current;
      if (d.type === 'rotate') {
        // 配電盤 PanelCanvas3D.jsx と同一式
        c.az = d.az0 - dx * BP3_ROT_SPEED;
        c.el = Math.max(-Math.PI/2 + 0.05, Math.min(Math.PI/2 - 0.05, d.el0 - dy * BP3_ROT_SPEED));
        // 【ピボット固定】回転後のピボットが押した瞬間と同じ画面位置に来るよう pan をずらす。
        // 毎回「押した瞬間の pan」から作り直すので、ドラッグを続けても誤差が積み上がらない
        if (d.pivot && prRef.current) {
          c.panX = d.panX0; c.panY = d.panY0;
          const s1 = prRef.current(d.pivot);
          c.panX = d.panX0 + (d.pivotS.x - s1.x);
          c.panY = d.panY0 + (d.pivotS.y - s1.y);
        }
      } else {
        c.panX = d.panX0 + dx;
        c.panY = d.panY0 + dy;
      }
      redraw();
    };
    const onUp = (e) => {
      // 【2026-09-23】面に描いた矩形を確定する。辺の番号でなく **実座標の2点** で渡す
      // （solid は points を CCW 正規化するので辺番号がずれる。座標なら取り違えない）
      if (faceSketchRef.current) {
        const fsk = faceSketchRef.current;
        faceSketchRef.current = null;
        setFaceSketch(null);
        try { cv.releasePointerCapture(fsk.pointerId); } catch (err) {}
        const rr = _bp3WallRectCorners(fsk.faceVerts, fsk.a, fsk.b);
        // あまりに小さい矩形は「クリックしただけ」とみなして何もしない
        if (rr && onFaceSketchRect && (rr.u1 - rr.u0) > 1 && (rr.z1 - rr.z0) > 0.2) {
          onFaceSketchRect({
            blockIdx: fsk.blockIdx, faceId: fsk.faceId,
            ax: rr.origin.x + rr.u0 * rr.ux, ay: rr.origin.y + rr.u0 * rr.uy,
            bx: rr.origin.x + rr.u1 * rr.ux, by: rr.origin.y + rr.u1 * rr.uy,
            zMin: rr.z0, zMax: rr.z1,
          });
        }
        redraw();
        return;
      }
      const d = dragRef.current;
      if (d && d.pointerId != null) { try { cv.releasePointerCapture(d.pointerId); } catch (err) {} }
      if (d && d.type === 'gizmo') {
        if (d.handle === 'top' || d.handle === 'base' || d.handle === 'vmove') {
          const ax = d.axisPx, l2 = ax ? (ax.dx*ax.dx + ax.dy*ax.dy) : 0;
          const dm = l2 > 1e-9 ? ((e.clientX-d.sx)*ax.dx + (e.clientY-d.sy)*ax.dy) / l2 : 0;
          if (onDragGizmo) onDragGizmo(d.partId, d.handle, { dM: dm }, true);
        } else {
          const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, d.floorZ);
          if (g && onDragGizmo) onDragGizmo(d.partId, d.handle, g, true);
        }
      }
      if (d && d.type === 'icon') {
        const st = _bp3SolveUV(d, e);
        // 確定。検証は親の bcApplyIconEdit の中だけで行う
        if (st && onDragIcon) onDragIcon(d.floorId, d.partId, d.iconId, st.ds, st.dt, true);
      }
      if (d && d.type === 'iconLabel') {
        // 動かさずに離した＝ラベルのクリック → その機器を選ぶ（3次元図の cab_icon_label_tail_click T2 と同じ決まり）。
        // 動かして離したときは選ばない（尻尾のクリックで選択が飛ばないように）
        const _labelClicked = _bp3LabelClickSelects() && !d.moved
          && !pdcBeyondClickSlop(e.clientX - d.sx, e.clientY - d.sy);
        if (_labelClicked) {
          if (onSelectIcon) onSelectIcon(d.iconId, d.partId);
        } else if (onDragLabel) {
          const z = d.zoom || 1;
          onDragLabel(d.floorId, d.partId, d.iconId,
            d.dx0 + (e.clientX - d.sx) / z, d.dy0 + (e.clientY - d.sy) / z, true);
        }
      }
      if (d && d.type === 'iconRot' && onRotateIcon) {
        const _a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
        onRotateIcon(d.floorId, d.partId, d.iconId, (_a - d.a0) * 180 / Math.PI, true);
      }
      if (d && d.type === 'door') {
        const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, d.floorZ);
        // 確定。検証は親の bcApplyDoorEdit の中だけで行う
        if (g && onDragDoor) onDragDoor(d.floorId, d.partId, d.doorId, d.g0, g, true);
      }
      if (d && d.type === 'wall') {
        const rect = cv.getBoundingClientRect();
        const g = _bp3CursorOnFloor(e, cv, camRef.current, scene, d.floorZ);
        // 確定。ここで初めて bcApplyPartEdit の検証を通す
        if (g && onDragWall) onDragWall(d.floorId, d.partId, g.x - d.g0.x, g.y - d.g0.y, true);
      }
      // 診断: どのイベントで終了したか（pointerup か pointercancel か）を残す
      if (typeof window !== 'undefined' && window.__dragLogOn) {
        (window.__dragLog = window.__dragLog || []).push({
          所: '3D:終了', イベント: e && e.type, ドラッグ種別: d ? d.type : null,
          移動量: d ? { dx: e.clientX - d.sx, dy: e.clientY - d.sy } : null });
        if (window.__dragLog.length > 200) window.__dragLog.shift();
      }
      dragRef.current = null;
      // 離したあとも作図中なら十字のまま。無条件に idle へ戻すと、
      // 1点目を打った瞬間に手のひらへ戻ってしまう（14.24 と同じ「状態を見ない初期化」）
      cv.style.cursor = drawTool ? BC_CURSOR.place : BC_CURSOR.idle;
    };
    const onWheel = (e) => {
      e.preventDefault();
      stopCamAnim('user');   // ホイールも同じ（寄せの途中で回したら、そこから利用者の操作にする）
      const rect = cv.getBoundingClientRect();
      const cW = cv.clientWidth, cH = cv.clientHeight;
      const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? BP3_ZOOM_OUT : BP3_ZOOM_IN;
      const c = camRef.current;
      // 配電盤 _zoomAtPoint と同一式（カーソル位置を固定してズーム）
      const newZoom = Math.max(BP3_ZOOM_MIN, Math.min(BP3_ZOOM_MAX, c.zoom * factor));
      const af = newZoom / c.zoom;
      const ox = curX - cW/2, oy = curY - cH/2;
      c.zoom = newZoom;
      c.panX = ox + (c.panX - ox) * af;
      c.panY = oy + (c.panY - oy) * af;
      redraw();
    };
    // 右クリック＝作図の確定/中断。2Dと同じ判定を親の1本の関数に任せる（段階C）
    const onCtx = (e) => { e.preventDefault(); if (onCancelDraw) onCancelDraw(); };
    const onLeave = () => { setHover(null); cv.style.cursor = drawTool ? BC_CURSOR.place : BC_CURSOR.idle; };
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', onCtx);
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('contextmenu', onCtx);
      cv.removeEventListener('pointerleave', onLeave);
    };
  }, [redraw, scene, onGrabWall, onDragWall, onSelectFloor, drawTool, drawFloorZ, onDrawClick, onDrawHover, onDragGizmo, onCancelDraw, onSelectDoor, onDragDoor, onSelectIcon, onDragIcon, onRotateIcon, onDragLabel, onFocusIcon,
      // 回転のピボットは「今選んでいるもの」から作るので、古い選択を掴まないよう依存に入れる
      selIconId, selDoorId, selPartId, selFloorHiId]);

  // ウィンドウリサイズ追従
  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  const cam = camRef.current;
  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onDragOver={onDropOnFloor ? (e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }) : undefined}
        onDrop={onDropOnFloor ? (e => {
          e.preventDefault();
          // ドロップ位置を「その階の床の水平面」へ逆投影する。
          // 作図・機器配置とまったく同じ経路（_bp3CursorOnFloor）を通す
          const g = _bp3CursorOnFloor(e, canvasRef.current, camRef.current, scene, drawFloorZ);
          onDropOnFloor(e, g);
        }) : undefined} />
      {/* 【階編集モード】の入口と出口。3Dの上に重ねる（spec 14.2） */}
      {editHeader && (
        <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 6, pointerEvents: 'auto',
                      display: 'flex', alignItems: 'center', gap: 6 }}>
          {editHeader}
        </div>
      )}
      {/* 方位インジケーター（他ウィンドウと同じデザイン）。3Dは現在のカメラ角度に追従する */}
      <div style={{ position: 'absolute', top: 10, right: 10, pointerEvents: 'auto', zIndex: 5 }}>
        <OrientationCube az={cam.az} el={cam.el} pnDeg={pnDeg} setPnDeg={setPnDeg} size={80}
          onRotate={(dAz, dEl) => {
            // キューブのドラッグでもキャンバスと同じようにカメラを回す。
            // 回転の中心も同じ（選んでいるものを画面に留める）。片方だけ違うと挙動差になる
            const c = camRef.current;
            const pivot = _bp3PivotOf(drawListRef.current,
              { iconId: selIconId, doorId: selDoorId, partId: selPartId, floorId: selFloorHiId });
            const s0 = (pivot && prRef.current) ? prRef.current(pivot) : null;
            c.az += dAz;
            c.el = Math.max(-Math.PI/2 + 0.05, Math.min(Math.PI/2 - 0.05, c.el + dEl));
            if (s0 && prRef.current) {
              const s1 = prRef.current(pivot);
              c.panX += s0.x - s1.x;
              c.panY += s0.y - s1.y;
            }
            redraw();
          }} />
      </div>
    </div>
  );
}
