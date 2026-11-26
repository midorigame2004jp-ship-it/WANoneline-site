// ================================================================
// 立体・面を Painter's で正しく塗る順に並べる（唯一の実装）
// ================================================================
// 【なぜ要るか】盤も床置き機器も「1単位でまとめて塗る」。1単位で塗る以上、
//   描画順は箱ごとに1つ決めるしかない。これまでは代表点1つの深度
//   （いちばん手前の面／中心）で並べていたが、**代表点の深度では前後は決まらない**。
//   隣り合う2つの箱は互いの奥行き範囲が重なるので、どの代表点を選んでも
//   「奥の箱が手前の箱を覆う」配置が必ず作れてしまう。
//
// 【正しい決め方】交差していない凸な立体どうしなら、前後は**必ず**決まる。
//   2つの箱の間に「分離平面」があれば、カメラはその平面のどちら側かに居るので、
//   カメラ側にある箱が手前。分離平面は分離軸定理（SAT）で見つける。
//   見つかった軸に沿って中心を比べ、視線方向の成分の符号で前後を決める。
//   これは正射影で厳密に正しい（透視投影では近似だが、この図法は正射影）。
//
// 【部品・2026-09-13】
//   bdoTopoOrder      … 「対ごとの前後」を受け取り、奥→手前の順を返す（循環・強制の辺もここ）。並べ方はこれ1つ
//   bdoPrismCompare   … 縦に立つ凸な柱×柱の前後（分離軸・最小めり込み軸）。立体どうしの比較はこれ1つ
//   bdoPolyPairOrder  … 平面の面×面の前後（相手の頂点が自分の平面のどちら側か）
//   bdoCompare / bdoOrderBoxes は直立した箱（OBB）を柱に直して上の2つを呼ぶだけの包み（比較の実装を持たない）
//   bdoSplitWallPrisms … 交差する壁を小片に分ける（3次元図）／bdoSeamEdgeFlags … 継ぎ目の辺を引かない規則（両窓）
//   bdoOwnsRegion     … 交点の空間をどちらの壁が持つか（両窓）
//   立体単位で並べる3次元図は bdoOrderPrisms（bdoTopoOrder＋bdoPrismCompare）、
//   面の断片単位で並べる建物エディタは bdoTopoOrder＋bdoPolyPairOrder を使う。
//
// 【見た目は変えない】この実装は「いつ塗るか」だけを決める。何をどう塗るかは
//   panelPaintCore.js（共通の統括）が唯一の正のまま。
//
// 【箱の形】OBB（向きを持つ直方体）で受ける:
//   { id, c:{x,y,z}, ax:[u,v,w]（単位ベクトル3本）, h:[hu,hv,hw]（半径3つ） }
// 【視線】dir = 「この向きに進むほど手前」という単位ベクトル（世界座標）。
//   呼び出し側のカメラ規約をここへ持ち込ませないための引数。

const BDO_EPS = 1e-9;

function _bdoDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

// 直立した箱（OBB。ax[2] が鉛直）を底面4点の柱に直す。比較の実装は bdoPrismCompare 1つだけにするための変換
// 【前提】この図法の箱はすべて bdoBoxFromUpright で作る直立箱（傾いた箱は無い）
function _bdoBoxToPrism(B) {
  const u = B.ax[0], v = B.ax[1], hu = B.h[0], hv = B.h[1];
  const P = (a, b) => ({ x: B.c.x + u.x * a + v.x * b, y: B.c.y + u.y * a + v.y * b });
  return { id: B.id, pts: [P(-hu, -hv), P(hu, -hv), P(hu, hv), P(-hu, hv)],
           zB: B.c.z - B.h[2], zT: B.c.z + B.h[2] };
}

// A と B の前後を決める（直立した箱の包み。判定の中身は bdoPrismCompare）。
// 戻り値: -1 = A が奥（A を先に塗る） / +1 = A が手前 / 0 = 決まらない（その軸で中心が一致）
function bdoCompare(A, B, dir) {
  return bdoPrismCompare(_bdoBoxToPrism(A), _bdoBoxToPrism(B), dir);
}

// ── 平面の面（多角形）どうしの前後 ────────────────────────────
// 面の平面（Newell 法で法線を取る。4点以上で少し歪んでも安定する）
function bdoPolyPlane(pts) {
  if (!pts || pts.length < 3) return null;
  let nx = 0, ny = 0, nz = 0, ext = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
    ext = Math.max(ext, Math.abs(a.x), Math.abs(a.y), Math.abs(a.z));
  }
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(l > 1e-12)) return null;
  nx /= l; ny /= l; nz /= l;
  let d = 0;
  for (const p of pts) d += nx * p.x + ny * p.y + nz * p.z;
  d /= pts.length;
  // 「平面の上に乗っている」とみなす許容。座標の大きさに比例させる（単位に依らない）
  return { nx, ny, nz, d, eps: 1e-7 * Math.max(1, ext) };
}
// pts が平面のどちら側か: +1 = 全部法線側 / -1 = 全部反対側 / 0 = 跨ぐ / 2 = 平面の上（同一平面）
function _bdoSideOf(pl, pts) {
  let pos = false, neg = false;
  for (const p of pts) {
    const s = pl.nx * p.x + pl.ny * p.y + pl.nz * p.z - pl.d;
    if (s > pl.eps) pos = true; else if (s < -pl.eps) neg = true;
    if (pos && neg) return 0;
  }
  return pos ? 1 : (neg ? -1 : 2);
}
// 面 A と面 B の前後。-1 = A を先に塗る / +1 = B を先に塗る / 0 = この幾何では決まらない
// 【なぜ正しいか】B の頂点が全部 A の平面の片側にあるなら、A が B を覆えるのは
//   カメラが A の平面の反対側にいるときだけ。カメラが B と同じ側なら B が手前（A が先）。
//   代表点の深度を一切使わないので、大きい面（長い壁の帯）が小さい面に勝つことはない。
//   正射影で厳密。plA/plB を渡せば平面を計算し直さない（カメラに依らないので呼び側でキャッシュできる）
function bdoPolyPairOrder(A, B, dir, plA, plB) {
  const pa = plA !== undefined ? plA : bdoPolyPlane(A);
  if (pa) {
    const s = _bdoSideOf(pa, B);
    if (s === 1 || s === -1) {
      const cam = (pa.nx * dir.x + pa.ny * dir.y + pa.nz * dir.z) > 0 ? 1 : -1;
      return s === cam ? -1 : 1;
    }
  }
  const pb = plB !== undefined ? plB : bdoPolyPlane(B);
  if (pb) {
    const s = _bdoSideOf(pb, A);
    if (s === 1 || s === -1) {
      const cam = (pb.nx * dir.x + pb.ny * dir.y + pb.nz * dir.z) > 0 ? 1 : -1;
      return s === cam ? 1 : -1;
    }
  }
  return 0;
}

// ── 対ごとの前後から「奥 → 手前」の順を作る（並べ方の唯一の実装）──────
// n       … 要素数
// decide  … (i, j) i<j について -1: i を先 / +1: j を先 / 0: 幾何では決まらない（near で補う） /
//            null: 前後を問わない（画面で重ならない等。辺を張らない）
// near    … 要素ごとの「手前度」。決まらない組・候補が複数あるとき・循環を切るときの基準（小さいほど奥）
// forced  … [[先のindex, 後のindex], ...]。幾何より優先し、循環を切るときも破らない
// 戻り値  … index の配列（奥→手前）
function bdoTopoOrder(n, decide, near, forced) {
  if (n < 2) { const r = []; for (let i = 0; i < n; i++) r.push(i); return r; }
  const _next = [];
  for (let i = 0; i < n; i++) _next.push([]);
  let _hasForced = false;
  for (const e of (forced || [])) {
    if (!e || e.length < 2) continue;
    const a = e[0], b = e[1];
    if (!(a >= 0 && a < n) || !(b >= 0 && b < n) || a === b) continue;
    _next[a].push(b); _hasForced = true;
  }
  // 【推移閉包を先に取る】取り付け先の取り付け先まで「必ず先」を伝える。
  // これをやらないと、扉の裏に貼った機器のように
  // 「幾何では壁の奥／規則では扉（＝壁より後）のさらに後」という物で強制と幾何が食い違い、
  // 循環が生まれる。循環を切るときには無関係な物の正しい前後まで巻き添えで壊れる（実測）。
  // 先に閉包を取っておけば、その組は最初から強制側で決まるので循環自体が生まれない。
  const _after = [];   // _after[i] = i より必ず後に塗る相手の集合
  for (let i = 0; i < n; i++) _after.push(null);
  if (_hasForced) {
    for (let i = 0; i < n; i++) {
      if (!_next[i].length) continue;
      const set = new Set(), stack = _next[i].slice();
      while (stack.length) {
        const v = stack.pop();
        if (v === i || set.has(v)) continue;   // 自分へ戻る（データ異常）なら広げない
        set.add(v);
        for (const w of _next[v]) stack.push(w);
      }
      _after[i] = set;
    }
  }
  // 「i を j より先に塗る（i が奥）」の関係を作る
  const before = [];
  for (let i = 0; i < n; i++) before.push([]);
  const indeg = new Array(n).fill(0);
  const indegF = new Array(n).fill(0);   // 強制の辺だけの入次数（循環を切るときに破らないため）
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const fi = !!(_after[i] && _after[i].has(j));   // i が必ず先
      const fj = !!(_after[j] && _after[j].has(i));   // j が必ず先
      let r;
      if (fi) r = -1;                                  // 強制の辺（閉包込み）は幾何より強い
      else if (fj) r = 1;
      else {
        r = decide(i, j);
        if (r === null || r === undefined) continue;   // 前後を問わない組には辺を張らない
        // 決まらない（交差・接触）→ 手前度で決める。同値なら元の並び順
        if (r === 0) r = (near[i] - near[j]) > 0 ? 1 : ((near[i] - near[j]) < 0 ? -1 : -1);
      }
      const isF = fi || fj;
      if (r < 0) { before[i].push({ to: j, forced: isF }); indeg[j]++; if (isF) indegF[j]++; }  // i が奥
      else { before[j].push({ to: i, forced: isF }); indeg[i]++; if (isF) indegF[i]++; }        // j が奥
    }
  }
  // トポロジカルソート。候補が複数あるときは「いちばん奥（near が小さい）」を選び、
  // それも同値なら元の並び順にする＝結果が一意に決まる
  const out = [];
  const used = new Array(n).fill(false);
  for (let k = 0; k < n; k++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (used[i] || indeg[i] > 0) continue;
      if (pick < 0 || near[i] < near[pick] - 1e-12) pick = i;
    }
    if (pick < 0) {
      // ── 循環したとき ──
      // 強制の辺と幾何の辺が食い違うと循環が生まれる。必ず起きる例:
      //   壁の裏に貼った機器は「幾何では壁の奥」だが「取り付け先より後に塗る」と決めてある。
      // ここで捨ててよいのは**循環の中にある幾何の辺**だけ。循環と無関係な物まで先に出すと、
      // 正しく決まっていた前後（壁にめり込ませた盤など）が壊れる。
      // 【選び方】残っている物のうち (1)強制の入次数が0 かつ (2)循環の中にいる もの。
      //   自分へ戻れるかを素直に辿って調べる
      const rest = [];
      for (let i = 0; i < n; i++) if (!used[i]) rest.push(i);
      const inCycle = new Set();
      for (const s of rest) {
        const seen = new Set([s]);
        const stack = [s];
        let loop = false;
        while (stack.length && !loop) {
          const v = stack.pop();
          for (const e of before[v]) {
            if (used[e.to]) continue;
            if (e.to === s) { loop = true; break; }
            if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
          }
        }
        if (loop) inCycle.add(s);
      }
      const free = rest.filter(i => indegF[i] === 0);
      const cand = free.filter(i => inCycle.has(i));
      for (const i of (cand.length ? cand : free)) {
        if (pick < 0 || near[i] < near[pick] - 1e-12) pick = i;
      }
      // 強制の辺そのものが循環しているとき（データ異常）は、止まらないことを優先する
      if (pick < 0) for (const i of rest) {
        if (pick < 0 || near[i] < near[pick] - 1e-12) pick = i;
      }
      if (pick < 0) break;
    }
    used[pick] = true;
    out.push(pick);
    for (const e of before[pick]) {
      if (indeg[e.to] > 0) indeg[e.to]--;
      if (e.forced && indegF[e.to] > 0) indegF[e.to]--;
    }
  }
  return out;
}

// 箱の集合を「奥 → 手前」に並べる（bdoTopoOrder＋bdoCompare の薄い包み）。
// mustFollow: 幾何では決まらない前後を外から与える辺の配列 [[先に塗るid, 後に塗るid], ...]。
// ここでは「なぜその順なのか」を知らない（種類の知識を持ち込まない）。呼び側が意味を持つ。
function bdoOrderBoxes(boxes, dir, mustFollow) {
  const n = (boxes || []).length;
  if (n < 2) return (boxes || []).slice();
  // 直立した箱を柱に直して bdoOrderPrisms へ渡すだけ（並べ方・比較・保険は柱版が唯一の実装）
  const prisms = boxes.map(_bdoBoxToPrism);
  const back = new Map(prisms.map((p, i) => [p, boxes[i]]));
  return bdoOrderPrisms(prisms, dir, mustFollow).map(p => back.get(p));
}

// ── 縦に立つ凸な柱（底面の凸多角形 × 高さ）どうしの前後 ─────────────
// 【なぜ要るか・2026-09-13】3次元図は壁を丸ごと1箱で並べていたので、十字・T字に交差する壁
// （片腕が手前・もう片腕が奥）を表せなかった。壁を「高さの帯 × 平面の凸な小片」に分けると
// 小片どうしは交差しないので、分離軸で前後が必ず決まる。小片は長方形とは限らない（斜めの壁に切られる）ので、
// 長方形の箱（bdoCompare）ではなく凸な柱として比べる。
// 【比べ方は bdoCompare と同じ】縦に立つ柱の分離軸は「両方の底面の辺の法線（水平）＋z軸」で全部
// （水平な辺×縦の辺＝水平な法線、水平×水平＝z、縦×縦＝0）。いちばん広く離れている
// （いちばん浅く食い込む）軸で決め、その軸で中心が一致すれば 0。長方形を渡すと bdoCompare と同じ答えになる
// （検査 box_draw_order.cjs で突き合わせ）。
// 柱の形: { id, pts:[{x,y}]（凸・向きは問わない）, zB, zT }
function _bdoPrismAxes(P, out) {
  const n = P.pts.length;
  for (let i = 0; i < n; i++) {
    const a = P.pts[i], b = P.pts[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey);
    if (l > 1e-9) out.push({ x: -ey / l, y: ex / l, z: 0 });
  }
}
function _bdoPrismSpan(P, L) {
  if (Math.abs(L.x) < 1e-12 && Math.abs(L.y) < 1e-12) {   // z軸
    const lo = Math.min(P.zB, P.zT) * L.z, hi = Math.max(P.zB, P.zT) * L.z;
    return { c: (lo + hi) / 2, r: Math.abs(hi - lo) / 2 };
  }
  let lo = Infinity, hi = -Infinity;
  for (const p of P.pts) { const s = p.x * L.x + p.y * L.y; if (s < lo) lo = s; if (s > hi) hi = s; }
  return { c: (lo + hi) / 2, r: (hi - lo) / 2 };
}
function bdoPrismCompare(A, B, dir) {
  const axes = [];
  _bdoPrismAxes(A, axes); _bdoPrismAxes(B, axes);
  axes.push({ x: 0, y: 0, z: 1 });
  let best = 0, bestGap = -Infinity;
  for (const L of axes) {
    const dv = _bdoDot(L, dir);
    if (Math.abs(dv) < 1e-9) continue;       // 視線と平行な平面＝画面上で重ならない向き
    const pa = _bdoPrismSpan(A, L), pb = _bdoPrismSpan(B, L);
    const gap = Math.abs(pa.c - pb.c) - (pa.r + pb.r);
    if (gap > bestGap) {
      bestGap = gap;
      best = Math.abs(pa.c - pb.c) < 1e-9 ? 0 : ((pa.c - pb.c) * dv > 0 ? 1 : -1);
    }
  }
  return best;
}
// 柱のいちばん手前の端（決まらない組の保険・循環を切る基準。bdoOrderBoxes の near と同じ意味）
function _bdoPrismNear(P, dir) {
  let m = -Infinity;
  for (const p of P.pts) {
    const s = p.x * dir.x + p.y * dir.y;
    m = Math.max(m, s + P.zB * dir.z, s + P.zT * dir.z);
  }
  return m;
}
// 柱の集合を「奥 → 手前」に並べる（bdoOrderBoxes の柱版。並べ方は bdoTopoOrder 1つ）。
// mustFollow: [[先のid, 後のid], ...]
// screenOverlap: 省略可。(i, j) → false なら画面で重ならない＝前後を問わない（辺を張らない・計算を省く）
function bdoOrderPrisms(prisms, dir, mustFollow, screenOverlap) {
  const n = (prisms || []).length;
  if (n < 2) return (prisms || []).slice();
  const near = prisms.map(P => _bdoPrismNear(P, dir));
  const _at = new Map();
  prisms.forEach((P, i) => { if (P && P.id != null && !_at.has(P.id)) _at.set(P.id, i); });
  const forced = [];
  for (const e of (mustFollow || [])) {
    if (!e || e.length < 2) continue;
    const a = _at.get(e[0]), b = _at.get(e[1]);
    if (a == null || b == null || a === b) continue;
    forced.push([a, b]);
  }
  const decide = screenOverlap
    ? (i, j) => (screenOverlap(i, j) ? bdoPrismCompare(prisms[i], prisms[j], dir) : null)
    : (i, j) => bdoPrismCompare(prisms[i], prisms[j], dir);
  return bdoTopoOrder(n, decide, near, forced).map(i => prisms[i]);
}
function bdoPrismFromUpright(id, cx, cy, rotDeg, w, d, zB, zT) {
  const th = (rotDeg || 0) * Math.PI / 180;
  const cs = Math.cos(th), sn = Math.sin(th);
  const hw = Math.abs(w) / 2, hd = Math.abs(d) / 2;
  const P = (u, v) => ({ x: cx + cs * u - sn * v, y: cy + sn * u + cs * v });
  return { id, pts: [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)], zB, zT };
}

// 交点の空間をどちらの壁が持つか（両窓で共通の唯一の述語）。持たない側の断片・小片は捨てる。
// 両方が譲ると交点に穴があき、両方が持つと二重に塗られるので、必ず片方だけが true になる比較にする
function bdoOwnsRegion(otherRank, myRank) { return String(otherRank) < String(myRank); }

// ── 交差する壁を「高さの帯 × 平面の凸な小片」に分ける（3次元図用）──────────
// 【建物エディタとの関係＝並行実装・正直に書く】
//   建物エディタ（BuildingPreview3D の runSplit）は**面**を分割し、3次元図は立体単位で並べるので**柱**を分割する。
//   入力の形（線分＋厚み／底面の多角形）が違うため、次の3つは別々に書いてある:
//     ・帯分け   … エディタ: _bp3SplitPartitions（中心線の交差 t、端から0.5グリッド以内は交差とみなさない）
//                   ここ   : 底面の多角形が面積をもって重なる相手の [max(zB), min(zT)]（端の除外なし）
//     ・埋もれ   … エディタ: insideOther＋_bp3InsideBody（断片の重心が持ち主の胴体の中）
//                   ここ   : buried（面の重心が持ち主の底面の中かつ高さの範囲内）
//   共有しているもの: 持ち主の述語 bdoOwnsRegion／継ぎ目の辺の規則 bdoSeamEdgeFlags／多角形を平面で切る _pdcSplitPolyByPlane。
//   帯分けや埋もれの条件を変えるときは、両方を並べて見ること（片方だけ変えると窓ごとに見え方がずれる）。
// 【切る処理は増やさない】多角形を平面で切るのは panelDrawCore.js の _pdcSplitPolyByPlane 1つ。
//   node の検査からも呼べるよう opts.clip で渡せる（既定はグローバルの同関数）。
// walls: [{ key, rank（重なりの持ち主を決める比較用の文字列）, poly:[{x,y}], zB, zT }]
// 戻り値: [{ id:`${key}#${k}`, wallKey, pts, zB, zT, faces:[{ pts:[{x,y,z}], edges:[bool] }] }]
//   faces は「描く面」だけ（元の壁の面で、持ち主の壁に埋もれていないもの）。edges は輪郭として引く辺
function bdoSplitWallPrisms(walls, opts) {
  const clip = (opts && opts.clip) || (typeof _pdcSplitPolyByPlane === 'function' ? _pdcSplitPolyByPlane : null);
  const EPS = (opts && opts.eps) || 1e-3;
  const W = (walls || []).filter(w => w && w.poly && w.poly.length >= 3 && w.zT - w.zB > EPS);
  const _span = (pts, ax) => { let lo = Infinity, hi = -Infinity;
    for (const p of pts) { const s = p.x * ax.x + p.y * ax.y; if (s < lo) lo = s; if (s > hi) hi = s; }
    return [lo, hi]; };
  const _axes = (pts) => { const o = []; _bdoPrismAxes({ pts }, o); return o; };
  // 平面で「面積をもって」重なるか（接しているだけは重ならない＝切らない）
  const _planOverlap = (A, B) => {
    for (const ax of _axes(A).concat(_axes(B))) {
      const a = _span(A, ax), b = _span(B, ax);
      if (a[1] <= b[0] + EPS || b[1] <= a[0] + EPS) return false;
    }
    return true;
  };
  const _inside = (p, poly) => {   // 凸多角形の内側（境界上も内側）
    let sgn = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const s = cr / l;
      if (Math.abs(s) <= EPS) continue;
      const g = s > 0 ? 1 : -1;
      if (sgn === 0) sgn = g; else if (g !== sgn) return false;
    }
    return true;
  };
  const _onBoundary = (a, b, poly) => {   // 辺 a-b が元の多角形のどれかの辺の上にあるか
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ex = q.x - p.x, ey = q.y - p.y, l = Math.hypot(ex, ey);
      if (!(l > 1e-12)) continue;
      const da = Math.abs(ex * (a.y - p.y) - ey * (a.x - p.x)) / l;
      const db = Math.abs(ex * (b.y - p.y) - ey * (b.x - p.x)) / l;
      if (da <= EPS && db <= EPS) return true;
    }
    return false;
  };
  const pairs = W.map(() => []);
  for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++) {
    if (!_planOverlap(W[i].poly, W[j].poly)) continue;
    // 高さが接しているだけ（上下に積んだ壁）も切る対象に含める＝継ぎ目の辺が両側で一致する
    if (Math.min(W[i].zT, W[j].zT) < Math.max(W[i].zB, W[j].zB) - EPS) continue;
    pairs[i].push(j); pairs[j].push(i);
  }
  const out = [];
  W.forEach((w, wi) => {
    const zs = [w.zB, w.zT];
    for (const j of pairs[wi]) {
      const v = W[j], lo = Math.max(w.zB, v.zB), hi = Math.min(w.zT, v.zT);
      if (hi - lo > EPS) { zs.push(lo, hi); }
    }
    zs.sort((a, b) => a - b);
    let k = 0;
    for (let bi = 0; bi < zs.length - 1; bi++) {
      const b0 = zs[bi], b1 = zs[bi + 1];
      if (b1 - b0 <= EPS) continue;
      // この帯に掛かる相手（接するだけの相手も含む＝切り口の位置を上下の帯でそろえる）
      const hits = pairs[wi].filter(j => W[j].zB <= b1 + EPS && W[j].zT >= b0 - EPS);
      let pieces = [w.poly.map(p => ({ x: p.x, y: p.y, z: 0 }))];
      if (clip) for (const j of hits) {
        const vp = W[j].poly;
        for (let e = 0; e < vp.length; e++) {
          const a = vp[e], b = vp[(e + 1) % vp.length];
          const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey);
          if (!(l > 1e-12)) continue;
          const pl = { nx: -ey / l, ny: ex / l, nz: 0, d: (-ey * a.x + ex * a.y) / l };
          const next = [];
          for (const pc of pieces) {
            const sp = clip(pc, pl);
            if (!sp) { next.push(pc); continue; }
            if (sp.front) next.push(sp.front);
            if (sp.back) next.push(sp.back);
            if (!sp.front && !sp.back) next.push(pc);
          }
          pieces = next;
        }
      }
      // 持ち主の壁（rank が小さい方）に埋もれた小片は捨てる。重なりが高さで帯を覆っているときだけ
      const owners = hits.filter(j => bdoOwnsRegion(W[j].rank, w.rank)
                                   && W[j].zB <= b0 + EPS && W[j].zT >= b1 - EPS);
      for (const pc of pieces) {
        let cx = 0, cy = 0;
        pc.forEach(p => { cx += p.x; cy += p.y; }); cx /= pc.length; cy /= pc.length;
        if (owners.some(j => _inside({ x: cx, y: cy }, W[j].poly))) continue;
        const pts = pc.map(p => ({ x: p.x, y: p.y }));
        // 描く面: 元の壁の面（切り口ではない）で、持ち主の壁の中に埋もれていないもの
        const buried = (fp) => {
          let fx = 0, fy = 0, fz = 0;
          fp.forEach(p => { fx += p.x; fy += p.y; fz += p.z; });
          fx /= fp.length; fy /= fp.length; fz /= fp.length;
          return W.some((v, vj) => vj !== wi && bdoOwnsRegion(v.rank, w.rank)
            && fz >= v.zB - EPS && fz <= v.zT + EPS && _inside({ x: fx, y: fy }, v.poly));
        };
        const faces = [];
        for (let e = 0; e < pts.length; e++) {
          const a = pts[e], b = pts[(e + 1) % pts.length];
          if (!_onBoundary(a, b, w.poly)) continue;
          const fp = [{ x: a.x, y: a.y, z: b0 }, { x: b.x, y: b.y, z: b0 },
                      { x: b.x, y: b.y, z: b1 }, { x: a.x, y: a.y, z: b1 }];
          if (!buried(fp)) faces.push({ pts: fp });
        }
        if (Math.abs(b1 - w.zT) <= EPS) {
          const fp = pts.map(p => ({ x: p.x, y: p.y, z: b1 }));
          if (!buried(fp)) faces.push({ pts: fp });
        }
        if (Math.abs(b0 - w.zB) <= EPS) {
          const fp = pts.slice().reverse().map(p => ({ x: p.x, y: p.y, z: b0 }));
          if (!buried(fp)) faces.push({ pts: fp });
        }
        out.push({ id: `${w.key}#${k++}`, wallKey: w.key, pts, zB: b0, zT: b1, faces });
      }
    }
  });
  // 継ぎ目の辺（同じ壁・同じ平面の2断片が共有）は引かない。規則は建物エディタと共通の1つ
  const flat = [];
  out.forEach(pc => pc.faces.forEach(f => flat.push({ key: pc.wallKey, pts: f.pts, face: f })));
  const flags = bdoSeamEdgeFlags(flat);
  flat.forEach((it, i) => { it.face.edges = flags[i]; });
  return out;
}

// ── 継ぎ目の辺を引かない規則（建物エディタ・3次元図で共通の唯一の実装）────
//   同じ壁（key）の・同じ平面の・2つ以上の断片が共有する辺 ＝ 分割で生まれた内部の継ぎ目 → 描かない。
//   それ以外はすべて輪郭 → 描く。（建物エディタ 2026-08-26 に6回の条件積み上げを捨てて1つにした規則）
// faces: [{ key, pts:[{x,y,z}] }] → 各面の辺ごとの「描く」フラグの配列
function bdoSeamEdgeFlags(faces) {
  const _q = (v) => Math.round(v * 1000) / 1000;
  const _planeKey = (pts) => {
    const pl = bdoPolyPlane(pts);
    if (!pl) return 'x';
    return _q(pl.nx) + ',' + _q(pl.ny) + ',' + _q(pl.nz) + ',' + _q(pl.d);
  };
  const _edgeKey = (a, b) => {
    const A = _q(a.x) + ',' + _q(a.y) + ',' + _q(a.z);
    const B = _q(b.x) + ',' + _q(b.y) + ',' + _q(b.z);
    return A < B ? A + '|' + B : B + '|' + A;
  };
  const shared = new Map();
  const pks = (faces || []).map(f => f.key + '#' + _planeKey(f.pts));
  (faces || []).forEach((f, fi) => {
    f.pts.forEach((p0, i) => {
      const key = pks[fi] + '#' + _edgeKey(p0, f.pts[(i + 1) % f.pts.length]);
      shared.set(key, (shared.get(key) || 0) + 1);
    });
  });
  return (faces || []).map((f, fi) => f.pts.map((p0, i) =>
    (shared.get(pks[fi] + '#' + _edgeKey(p0, f.pts[(i + 1) % f.pts.length])) || 0) < 2));
}

// 呼び出し側が持っている素の値から OBB を作るための補助。
// gx,gy = 平面の中心 / rotDeg = 真北基準の向き（度） / wM,dM = 平面の寸法[m]
// zB,zT = 高さの範囲。**単位は呼び出し側でそろえてから渡すこと**（混ぜない）。
function bdoBoxFromUpright(id, cx, cy, rotDeg, w, d, zB, zT) {
  const th = (rotDeg || 0) * Math.PI / 180;
  const cs = Math.cos(th), sn = Math.sin(th);
  return {
    id,
    c: { x: cx, y: cy, z: (zB + zT) / 2 },
    ax: [ { x: cs, y: sn, z: 0 }, { x: -sn, y: cs, z: 0 }, { x: 0, y: 0, z: 1 } ],
    h: [ Math.abs(w) / 2, Math.abs(d) / 2, Math.abs(zT - zB) / 2 ],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bdoCompare, bdoOrderBoxes, bdoBoxFromUpright,
                     bdoTopoOrder, bdoPolyPlane, bdoPolyPairOrder,
                     bdoPrismCompare, bdoOrderPrisms, bdoPrismFromUpright,
                     bdoSplitWallPrisms, bdoSeamEdgeFlags, bdoOwnsRegion };
}
