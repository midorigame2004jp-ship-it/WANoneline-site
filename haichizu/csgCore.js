// ══════════════════════════════════════════════════════════════════════════
// csgCore.js — ソリッドの組み立て（プリミティブ＋ブーリアン）・2026-09-26
// ══════════════════════════════════════════════════════════════════════════
// 【なぜ作るか・ユーザー指摘 2026-09-26】
//   「円柱って言ったからって円柱ができればいいと思ってるわけ？ 世の中の建物はそれで網羅できると
//     思ってるわけ？ ハシビロCAD と同様にできないと作りたい図形は作れないんじゃないの？
//     円柱で先端が半球のようになっているとかも要求したらどうすんの？」
//   形の型（circle / sphere / cone …）を1つずつ足す方式は破綻する。
//   **プリミティブ＋ブーリアン演算の組み合わせ**で任意の形を作れる基盤に載せ替える。
//
// 【設計・Codex監査】
//   ・本命は CSGツリー + manifold 系ブーリアン。BRep 自前は重すぎ、
//     既存 faces への自前メッシュブーリアンは壊れやすい。
//   ・既存の blocks[] は**捨てない**。別に bodies[] を持ち、複雑な形だけこちらへ逃がす。
//   ・最初は複雑ボディを部屋認識・壁吸着の対象外にする（描くことと内部の意味解析を
//     同時にやると破綻する）。
//
// 【単位の約束】
//   manifold の中は **すべてメートル**（体積・寸法が素直に出る）。
//   外へ返す faces は既存の solid と同じ **{ x: グリッド, y: グリッド, z: メートル }**。
//   グリッド ⇄ メートルは METERS_PER_PX（1グリッド = 0.1m）。ここで1回だけ換算する。
//
// 【読み込み】manifold は WASM。自作ローダー（fetch→結合→Babel→eval）のスコープでは
//   `import()` がそのまま書けないので `new Function` で包んで動的に読む。

// 【分割は solidModel.js の BC_SEG_DEG に揃える・2026-10-18】値は 48 のまま（360/7.5）。
//   3か所に別々の数字があると、同じ『丸み』なのに作り方で粗さが違う
const CSG_SEG = (typeof BC_SEG_DEG === 'number' && BC_SEG_DEG > 0)
  ? Math.round(360 / BC_SEG_DEG) : 48;               // 円・球の分割数
// ══ 見る向きの表し方 ・2026-09-27 ══
// 真上は 'top'。水平から見る図（断面図・側面図・矢視図）は **u軸（図の横軸）の向き**を
// ラジアンで持つ。キーは度に直して丸める（-0 や 2π・浮動小数の誤差で別キーにしないため）。
const CSG_DIR_STEP = 0.1;         // 度。キーの刻み
function csgDirKey(rad) {
  let d = ((rad || 0) * 180 / Math.PI) % 360;
  if (d < 0) d += 360;
  return (Math.round(d / CSG_DIR_STEP) * CSG_DIR_STEP).toFixed(1);
}
// ══ 階の床の高さの表し方 ・2026-11-05 ══
// 向きのキー（csgDirKey）と同じ考えで刻む。-0 や浮動小数の誤差で別キーにしないため。
// 階の床は建物エディタで 0.1m 刻みで入れるので、1mm まで見れば十分。
const CSG_Z_STEP = 0.001;        // メートル
function csgZKey(zM) {
  return (Math.round((zM || 0) / CSG_Z_STEP) * CSG_Z_STEP).toFixed(3);
}
let _csgModulePromise = null;

function _csgMpp() {
  return (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
}

// manifold（WASM）を1回だけ読む
function csgLoad() {
  if (_csgModulePromise) return _csgModulePromise;
  // eval されたスコープでは import() を直接書けない。Function で包むと動的インポートになる
  const dynImport = new Function('u', 'return import(u)');
  _csgModulePromise = dynImport('/node_modules/manifold-3d/manifold.js')
    .then(m => m.default({ locateFile: (f) => '/node_modules/manifold-3d/' + f }))
    .then(Module => { Module.setup(); return Module; })
    .catch(e => { _csgModulePromise = null; throw e; });
  return _csgModulePromise;
}
// 読み込み済みか（同期で知りたい場所用）
function csgReady() { return !!_csgModulePromise; }

// ── プリミティブ ──
// op は { kind, ...寸法, at:{x,y,z}, rotZ } のいずれか。寸法は**メートル**。
//   box      : w, d, h（幅・奥行き・高さ）
//   cylinder : r（半径）, h（高さ）, r2（上の半径。円錐台はこれを変える）
//   sphere   : r（半径）
// at は中心（box/sphere）または底面の中心（cylinder）。
function csgMakePrimitive(Manifold, op, keep) {
  if (!op) return null;
  // 【押し出し・2026-09-28】面を掴んで押し引きした結果はこの形で残す。
  //   contours … その面の平面の中での輪郭（メートル）。穴があれば2本目以降に入る
  //   o/u/v/n  … その平面の位置と向き（メートル）。o が原点、u×v が面内、n が押し出す向き
  //   h        … 押し出す厚み（メートル・正）
  // 位置はこの基底が持っているので at / rotZ は使わない。
  if (op.kind === 'extrude') {
    const cont = (op.contours || []).filter(c2 => c2 && c2.length >= 3);
    if (!cont.length || !(op.h > 0)) return null;
    const ex = Manifold.extrude(cont, op.h);
    keep.push(ex);
    const u = op.u || [1, 0, 0], v = op.v || [0, 1, 0], n = op.n || [0, 0, 1], o2 = op.o || [0, 0, 0];
    // 列優先の4x4（最後の行は無視される）。列は u / v / n / 原点
    const t2 = ex.transform([u[0], u[1], u[2], 0,
                             v[0], v[1], v[2], 0,
                             n[0], n[1], n[2], 0,
                             o2[0], o2[1], o2[2], 1]);
    keep.push(t2);
    return t2;
  }
  const at = op.at || { x: 0, y: 0, z: 0 };
  let s = null;
  if (op.kind === 'box') {
    s = Manifold.cube([op.w || 1, op.d || 1, op.h || 1], true);   // true = 原点中心
  } else if (op.kind === 'cylinder') {
    const r1 = op.r || 1, r2 = (op.r2 != null ? op.r2 : r1);
    s = Manifold.cylinder(op.h || 1, r1, r2, op.seg || CSG_SEG, false);   // false = 底面が z=0
  } else if (op.kind === 'sphere') {
    s = Manifold.sphere(op.r || 1, op.seg || CSG_SEG);
  }
  if (!s) return null;
  keep.push(s);
  if (op.rotZ) { const r = s.rotate([0, 0, op.rotZ]); keep.push(r); s = r; }
  const t = s.translate([at.x || 0, at.y || 0, at.z || 0]);
  keep.push(t);
  return t;
}

// ══ 陰影の色 ・2026-09-27 ══
// 【なぜ透明度でなく色か】半透明で明るさを表すと**裏側が透けて**、凹んだ立体では
//   裂けたように見える（2026-09-27 ユーザー報告）。不透明にして色の明るさで陰影を付ける。
// t は 0〜1 の明るさ。基準の色に掛ける。
function csgShadeColor(col, t) {
  const c = String(col == null ? '' : col).trim();
  const k = (t == null || !isFinite(t)) ? 1 : t;
  let r, g, b;
  const m = c.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
    } else {
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    }
  } else {
    // rgb(...) / rgba(...) も受ける（選択中の色は16進とは限らない）
    const m2 = c.match(/^rgba?\(([^)]+)\)$/i);
    if (!m2) return c || '#6B7A8D';            // 読めない形はそのまま（黒くしない）
    const a = m2[1].split(',').map(x => parseFloat(x));
    r = a[0]; g = a[1]; b = a[2];
  }
  if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return c || '#6B7A8D';
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
}

// ── メッシュ → faces（既存の描画・当たり判定がそのまま使える形）──
function _csgTriNormal(v) {
  const ax = v[1].x - v[0].x, ay = v[1].y - v[0].y, az = v[1].z - v[0].z;
  const bx = v[2].x - v[0].x, by = v[2].y - v[0].y, bz = v[2].z - v[0].z;
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const L = Math.hypot(nx, ny, nz);
  if (L > 1e-12) { nx /= L; ny /= L; nz /= L; }
  return { nx, ny, nz };
}
function csgMeshToFaces(mesh, bodyId) {
  const faces = [];
  const vp = mesh.vertProperties, tv = mesh.triVerts;
  const np = mesh.numProp || 3;
  const mpp = _csgMpp();
  const P = (k) => ({
    x: vp[k * np] / mpp,           // メートル → グリッド
    y: vp[k * np + 1] / mpp,
    z: vp[k * np + 2],             // 高さはメートルのまま（既存の solid と同じ約束）
  });
  // 【向きはメートルのまま計算する・2026-09-27】vertices は x,y をグリッドに直して返すが、
  //   その座標で法線を出すと**高さ方向だけ 1/mpp 倍に伸びた空間**の向きになり、
  //   斜面の明るさが実物と食い違う（陰影が平板に見える）。法線は換算前の値で作る。
  const M = (k) => ({ x: vp[k * np], y: vp[k * np + 1], z: vp[k * np + 2] });
  for (let i = 0; i < mesh.numTri; i++) {
    const a = tv[i * 3], b = tv[i * 3 + 1], c = tv[i * 3 + 2];
    const v = [P(a), P(b), P(c)];
    faces.push({
      id: String(bodyId) + '|t' + i, type: 'csg', vertices: v,
      normal: _csgTriNormal([M(a), M(b), M(c)]),
    });
  }
  return faces;
}

// ── メッシュ → 頂点配列＋三角形の頂点番号 ──
// 【なぜ faces と別に要るか】影の輪郭（csgSilhouette2D）は辺を**頂点番号**で突き合わせる。
// 面ごとに座標を配った faces では同じ点が別の値になり得て、辺が相殺されない。
// manifold のメッシュは隣り合う三角形が同じ頂点番号を共有する（閉じた多様体）ので、
// 番号で比べれば丸め誤差が一切入らない。
// 単位は faces と同じ { x: グリッド, y: グリッド, z: メートル }。
function csgMeshIndexed(mesh) {
  const vp = mesh.vertProperties, tv = mesh.triVerts;
  const np = mesh.numProp || 3;
  const nv = (mesh.numVert != null) ? mesh.numVert : Math.floor(vp.length / np);
  const mpp = _csgMpp();
  const verts = new Array(nv);
  for (let k = 0; k < nv; k++) {
    verts[k] = { x: vp[k * np] / mpp, y: vp[k * np + 1] / mpp, z: vp[k * np + 2] };
  }
  const tris = new Array(mesh.numTri);
  for (let i = 0; i < mesh.numTri; i++) tris[i] = [tv[i * 3], tv[i * 3 + 1], tv[i * 3 + 2]];
  return { verts, tris };
}

// ══ 保険の塗り（線には使わない）・2026-09-27 Codex監査済み ══
// 【これは正しい輪郭ではない】もとは影の輪郭を作るつもりだったが、
//   **凹んだ立体で嘘の線が出る**ことを実測で確認した（2026-09-27 ユーザー実機報告）:
//     ・横に箱で窪みを付けたタンク … 正解は輪郭1本（周313.9）なのに、余計な2本目（周164.3）が出る
//     ・中心に貫通穴 … 内側の輪郭が 正解48点・周125.6 に対し 104点・周188.4（ジグザグ）
//   原因は、凹だと手前向き三角形の投影どうしが重なり、打ち消されずに残る
//   「内部の折れ線」をそのまま線として描いてしまうこと。
// 【ただし塗りは正しい】面積は正解と完全に一致する（fill-rule="nonzero" で和集合になるため）。
//   そこで**塗り専用**に格下げした。名前も変えてある（silhouette のままだと将来また線に使われる）。
//   正しい輪郭は csgEvalBody が manifold の project() で作る（outline / outlineH）。
// 使うのは「その向きの輪郭がまだ計算されていない一瞬」だけ。線は引かないこと。
function csgFallbackFill2D(mi, toView) {
  if (!mi || !mi.verts || !mi.tris || !mi.verts.length || !mi.tris.length) return [];
  const V = mi.verts, T = mi.tris, N = V.length;
  const PX = new Float64Array(N), PY = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const q = toView(V[i].x, V[i].y, V[i].z);
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) return [];   // 投影できない立体は描かない
    PX[i] = q[0]; PY[i] = q[1];
  }
  // 有向辺 a→b（番号 a*N+b）→ 本数。逆向きが来たら打ち消す
  const dir = new Map();
  const add = (a, b) => {
    const rk = b * N + a, rc = dir.get(rk);
    if (rc) { if (rc === 1) dir.delete(rk); else dir.set(rk, rc - 1); return; }
    const k = a * N + b;
    dir.set(k, (dir.get(k) || 0) + 1);
  };
  // 真横を向いてつぶれて見える三角形は、影の内か外かを決められないので数えない
  const EPS = 1e-9;
  for (let i = 0; i < T.length; i++) {
    const a = T[i][0], b = T[i][1], c = T[i][2];
    const area = (PX[b] - PX[a]) * (PY[c] - PY[a]) - (PY[b] - PY[a]) * (PX[c] - PX[a]);
    if (!(area > EPS)) continue;
    add(a, b); add(b, c); add(c, a);
  }
  if (!dir.size) return [];
  const nexts = new Map();                  // 頂点 → そこから出ている辺の行き先
  for (const [k, c] of dir) {
    const a = Math.floor(k / N), b = k % N;
    let arr = nexts.get(a); if (!arr) { arr = []; nexts.set(a, arr); }
    for (let n = 0; n < c; n++) arr.push(b);
  }
  const loops = [];
  const limit = T.length * 3 + 8;           // 壊れたメッシュで無限に回らないための上限
  for (const s0 of [...nexts.keys()]) {
    for (;;) {
      const a0 = nexts.get(s0);
      if (!a0 || !a0.length) break;
      const idx = [s0];
      let cur = a0.pop(), n2 = 0;
      while (cur !== s0 && n2++ < limit) {
        idx.push(cur);
        const arr = nexts.get(cur);
        if (!arr || !arr.length) break;     // 開いた辺。例外にせずここで打ち切る
        cur = arr.pop();
      }
      // 閉じたものだけ採る（壊れたメッシュでも描画側を巻き込まない）
      if (cur === s0 && idx.length >= 3) loops.push(idx.map(i => ({ x: PX[i], y: PY[i] })));
    }
  }
  return loops;
}

// ══ 平らな面のまとまり（押し引きの対象）・2026-09-28 Codex監査済み ══
// 【なぜ要るか・ユーザー指摘】「3次元CADってこんなにUIわかりにくいっけ」。
//   CADは寸法を一覧に打ち込むのではなく、**面を掴んで押し引き**して形を作る。
//   三角形1枚では面にならないので、**同じ平面で隣り合う三角形**を1つの「面」にまとめる。
// 【平面だけを対象にする・Codex判定】円柱の側面・球は平面のまとまりにならない。
//   無理に掴ませると操作が破綻するので、段階1では平面だけ。曲面は半径・高さで直す。
// 【単位】判定はすべて**メートル空間**で行う（グリッドとメートルが混ざると同一平面の判定が壊れる）。
//   返す値は名前の末尾で単位を区別する（…M＝メートル／…G＝x,yグリッド・zメートル＝描画と同じ）。
// 返り値: { groups: [...], triGroup: Int32Array（三角形番号→まとまり番号。-1は対象外） }
const CSG_PLANAR_MIN_AREA = 0.02;    // これより小さい面は掴ませない（m2）
// 隣の面との角が これより浅い（内積が大きい）なら「曲面の続き」とみなす。
// cos(25度)=0.906。48分割の円柱・球は隣との角が 7.5度前後なので確実に外れる
const CSG_SMOOTH_COS = Math.cos(25 * Math.PI / 180);
function csgPlanarFaces(mi) {
  const 空 = { groups: [], triGroup: null };
  if (!mi || !mi.verts || !mi.tris || !mi.tris.length) return 空;
  const mpp = _csgMpp();
  const V = mi.verts, T = mi.tris;
  const M = V.map(q => [q.x * mpp, q.y * mpp, q.z]);      // メートル空間の頂点
  const nrm = new Array(T.length), off = new Array(T.length);
  for (let i = 0; i < T.length; i++) {
    const a = M[T[i][0]], b = M[T[i][1]], c = M[T[i][2]];
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) { nrm[i] = null; off[i] = 0; continue; }
    nx /= L; ny /= L; nz /= L;
    nrm[i] = [nx, ny, nz];
    off[i] = nx * a[0] + ny * a[1] + nz * a[2];
  }
  // 辺を共有し、かつ同じ平面を向いている三角形どうしをまとめる
  const par = new Int32Array(T.length);
  for (let i = 0; i < T.length; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  // 辺 → その辺を持つ三角形の一覧（曲面かどうかの判定にも使う）
  const em = new Map();
  for (let i = 0; i < T.length; i++) {
    if (!nrm[i]) continue;
    const tri = T[i];
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const k = Math.min(a, b) * V.length + Math.max(a, b);
      let arr = em.get(k); if (!arr) { arr = []; em.set(k, arr); }
      arr.push(i);
    }
  }
  for (const [, arr] of em) {
    for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
      const i = arr[x], j = arr[y];
      if (!nrm[i] || !nrm[j]) continue;
      const d = nrm[i][0] * nrm[j][0] + nrm[i][1] * nrm[j][1] + nrm[i][2] * nrm[j][2];
      if (d > 1 - 1e-6 && Math.abs(off[i] - off[j]) < 1e-4) {
        const ra = find(i), rb = find(j);
        if (ra !== rb) par[rb] = ra;
      }
    }
  }
  const 塊 = new Map();
  for (let i = 0; i < T.length; i++) {
    if (!nrm[i]) continue;
    const r = find(i);
    let g = 塊.get(r); if (!g) { g = []; 塊.set(r, g); }
    g.push(i);
  }
  const groups = [];
  const triGroup = new Int32Array(T.length).fill(-1);
  for (const [, tris] of 塊) {
    const n = nrm[tris[0]], d0 = off[tris[0]];
    // 平面の中の直交基底
    const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = ref[1] * n[2] - ref[2] * n[1], uy = ref[2] * n[0] - ref[0] * n[2], uz = ref[0] * n[1] - ref[1] * n[0];
    const UL = Math.hypot(ux, uy, uz);
    if (!(UL > 1e-12)) continue;
    ux /= UL; uy /= UL; uz /= UL;
    const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
    const o = [n[0] * d0, n[1] * d0, n[2] * d0];          // 原点から平面へ下ろした足
    const to2 = (k) => {
      const q = M[k];
      const dx = q[0] - o[0], dy = q[1] - o[1], dz = q[2] - o[2];
      return [dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz];
    };
    // まとまりの中だけで有向辺を打ち消す（平面内なので重なりが無く、これで正しい外周になる）
    const inG = new Set(tris);
    const dir = new Map(), N = V.length;
    const add = (a, b) => {
      const rk = b * N + a, rc = dir.get(rk);
      if (rc) { if (rc === 1) dir.delete(rk); else dir.set(rk, rc - 1); return; }
      const k = a * N + b;
      dir.set(k, (dir.get(k) || 0) + 1);
    };
    for (const i of inG) { const t = T[i]; add(t[0], t[1]); add(t[1], t[2]); add(t[2], t[0]); }
    const nexts = new Map();
    for (const [k, c] of dir) {
      const a = Math.floor(k / N), b = k % N;
      let arr = nexts.get(a); if (!arr) { arr = []; nexts.set(a, arr); }
      for (let m = 0; m < c; m++) arr.push(b);
    }
    const idxLoops = [];
    const limit = tris.length * 3 + 8;
    for (const s0 of [...nexts.keys()]) {
      for (;;) {
        const a0 = nexts.get(s0);
        if (!a0 || !a0.length) break;
        const lp = [s0];
        let cur = a0.pop(), g2 = 0;
        while (cur !== s0 && g2++ < limit) {
          lp.push(cur);
          const arr = nexts.get(cur);
          if (!arr || !arr.length) break;
          cur = arr.pop();
        }
        if (cur === s0 && lp.length >= 3) idxLoops.push(lp);
      }
    }
    if (!idxLoops.length) continue;
    // ══ 曲面のかけらは掴ませない ・2026-09-28 ══
    // 【症状】球や48分割の円柱は、facet 1枚ずつが「平らな面」になってしまう
    //   （実測: タンクで面積0.2〜0.4m2の面が何十枚も出た）。
    // 【見分け方】本物の面は、外周の辺で**隣の面と角がある**（箱の角＝90度、切り口＝鋭角）。
    //   曲面のかけらは隣とほぼ平ら（48分割なら7.5度）。
    //   外周の長さの半分以上が「平ら」なら、それは曲面の一部なので対象外にする。
    {
      let なめらか = 0, 全長 = 0;
      for (const lp of idxLoops) {
        for (let i = 0; i < lp.length; i++) {
          const a = lp[i], b = lp[(i + 1) % lp.length];
          const pa = M[a], pb = M[b];
          const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
          全長 += len;
          const arr = em.get(Math.min(a, b) * V.length + Math.max(a, b)) || [];
          let 最大内積 = -1;
          for (const j of arr) {
            if (inG.has(j) || !nrm[j]) continue;
            const d = n[0] * nrm[j][0] + n[1] * nrm[j][1] + n[2] * nrm[j][2];
            if (d > 最大内積) 最大内積 = d;
          }
          if (最大内積 > CSG_SMOOTH_COS) なめらか += len;   // 隣とほぼ平ら＝曲面の続き
        }
      }
      if (全長 > 0 && なめらか > 全長 * 0.5) continue;
    }
    const contours = idxLoops.map(lp => lp.map(to2));
    let area = 0;
    for (const c2 of contours) {
      for (let i = 0; i < c2.length; i++) {
        const a = c2[i], b = c2[(i + 1) % c2.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
    }
    area = Math.abs(area / 2);
    if (!(area >= CSG_PLANAR_MIN_AREA)) continue;
    // 面の重心（三角形の面積で重み付け）。矢印の根元に使う
    let wx = 0, wy = 0, wz = 0, wsum = 0;
    for (const i of tris) {
      const a = M[T[i][0]], b = M[T[i][1]], c = M[T[i][2]];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const w = Math.hypot(cr[0], cr[1], cr[2]) / 2;
      wx += (a[0] + b[0] + c[0]) / 3 * w; wy += (a[1] + b[1] + c[1]) / 3 * w;
      wz += (a[2] + b[2] + c[2]) / 3 * w; wsum += w;
    }
    if (!(wsum > 0)) continue;
    const gi = groups.length;
    for (const i of tris) triGroup[i] = gi;
    groups.push({
      idx: gi, tris,
      n, o, u: [ux, uy, uz], v: [vx, vy, vz],
      contours,                                   // 平面内の輪郭（メートル）
      areaM2: area,
      // 矢印の根元と向き（x,y はグリッド・z はメートル＝3次元図の描画と同じ約束）
      centerG: { x: (wx / wsum) / mpp, y: (wy / wsum) / mpp, z: wz / wsum },
      // 輪郭を3次元の点で（プレビューの描画用。同じ約束の単位）
      loopsG: contours.map(c2 => c2.map(([a, b]) => ({
        x: (o[0] + ux * a + vx * b) / mpp,
        y: (o[1] + uy * a + vy * b) / mpp,
        z: o[2] + uz * a + vz * b,
      }))),
    });
  }
  return { groups, triGroup };
}

// ════════════════════════════════════════════════════════════════
// 曲面（鉛直な円筒）を1枚の面として取り出す ・2026-10-03
// ════════════════════════════════════════════════════════════════
// 【なぜ要るか】タンクの胴・曲がった廊下の壁は曲面。csgPlanarFaces は曲面のかけらを
//   **意図して除外する**ので、設備を貼れる面が1枚も出なかった
//   （実在の形27通りを掃引したら、貼れない6件のうち4件が曲面だった）。
// 【三角形1枚ずつには貼らない】48分割の facet に貼ると、分割数を変えただけで機器が迷子になり、
//   向きも分割の刻みでカクつく（2026-10-03 Codex）。**円筒として認識し、
//   建屋の円弧の壁（_bcArcSurface）とまったく同じ面にする**＝曲面の実装を2つ持たない。
// 【元の作り方を先に見る】立体の ops に cylinder があれば、その中心・半径が正解そのもの。
//   メッシュから推定するより確実（Codex）。ただし**くり抜かれた後の範囲**はメッシュから取る。

// 点列を円に当てはめる（最小二乗）。x²+y²+Dx+Ey+F=0 を解いて中心と半径を出す
function _csgFitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (const p of pts) {
    const x = p[0], y = p[1], z = x * x + y * y;
    Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y;
    Sxz += x * z; Syz += y * z; Sz += z;
  }
  // [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy n] [D;E;F] = -[Sxz; Syz; Sz]
  const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const b = [-Sxz, -Syz, -Sz];
  // 3元の掃き出し
  for (let i = 0; i < 3; i++) {
    let p2 = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p2][i])) p2 = k;
    if (Math.abs(A[p2][i]) < 1e-12) return null;
    if (p2 !== i) { const t = A[i]; A[i] = A[p2]; A[p2] = t; const tb = b[i]; b[i] = b[p2]; b[p2] = tb; }
    for (let k = i + 1; k < 3; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const x3 = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let t = b[i];
    for (let j = i + 1; j < 3; j++) t -= A[i][j] * x3[j];
    x3[i] = t / A[i][i];
  }
  const cx = -x3[0] / 2, cy = -x3[1] / 2;
  const r2 = cx * cx + cy * cy - x3[2];
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  // 残差（半径のばらつき）
  let rms = 0;
  for (const p of pts) { const d = Math.hypot(p[0] - cx, p[1] - cy) - r; rms += d * d; }
  rms = Math.sqrt(rms / n);
  return { cx, cy, r, rms };
}

// 角度の集まり → 使われている区間 { a0, sweep }。一番大きい隙間を切れ目にする
function _csgAngleSpan(angs, 全周とみなす隙間) {
  if (!angs.length) return null;
  const a = angs.slice().sort((p, q) => p - q);
  const TAU = Math.PI * 2;
  let 最大 = -1, 位置 = 0;
  for (let i = 0; i < a.length; i++) {
    const g = (i === a.length - 1) ? (a[0] + TAU - a[i]) : (a[i + 1] - a[i]);
    if (g > 最大) { 最大 = g; 位置 = i; }
  }
  if (最大 <= 全周とみなす隙間) return { a0: a[0], sweep: TAU };   // 切れ目なし＝全周
  const a0 = a[(位置 + 1) % a.length];
  let sw = a[位置] - a0;
  sw = ((sw % TAU) + TAU) % TAU;
  return { a0, sweep: sw };
}

// メッシュの曲面 → 鉛直な円筒の一覧。triGroup は csgPlanarFaces が返すもの（-1＝平らな面でない）
function csgCurvedFaces(mi, triGroup, ops) {
  const out = [];
  if (!mi || !mi.verts || !mi.tris || !triGroup) return out;
  if (typeof window !== 'undefined' && window.__BODY_CURVED === false) return out;
  const mpp = _csgMpp();
  const V = mi.verts, T = mi.tris;
  const M = V.map(q => [q.x * mpp, q.y * mpp, q.z]);     // メートル空間
  // ① 曲面の三角形のうち、法線がほぼ水平なもの（＝立っている曲面）だけ集める
  const 面法線 = new Map();
  const 対象 = [];
  for (let i = 0; i < T.length; i++) {
    if (triGroup[i] >= 0) continue;
    const a = M[T[i][0]], b = M[T[i][1]], c = M[T[i][2]];
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;
    nx /= L; ny /= L; nz /= L;
    if (Math.abs(nz) > 0.2) continue;                    // 寝ている／傾いた曲面は今は扱わない
    面法線.set(i, [nx, ny, nz]);
    対象.push(i);
  }
  if (対象.length < 6) return out;
  // ② 辺の共有で連結成分にまとめる
  const idx = new Map(); 対象.forEach((t, k) => idx.set(t, k));
  const par = new Int32Array(対象.length);
  for (let i = 0; i < par.length; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const em = new Map();
  const N = V.length;
  対象.forEach(i => {
    const t = T[i];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const k = Math.min(a, b) * N + Math.max(a, b);
      let arr = em.get(k); if (!arr) { arr = []; em.set(k, arr); }
      arr.push(idx.get(i));
    }
  });
  for (const [, arr] of em) {
    for (let x = 1; x < arr.length; x++) {
      const ra = find(arr[0]), rb = find(arr[x]);
      if (ra !== rb) par[rb] = ra;
    }
  }
  const 塊 = new Map();
  for (let k = 0; k < 対象.length; k++) {
    const r = find(k);
    let g = 塊.get(r); if (!g) { g = []; 塊.set(r, g); }
    g.push(対象[k]);
  }
  // ③ 元の作り方にある円柱の中心・半径を候補にする（メッシュからの推定より確実）
  const 候補 = [];
  (ops || []).forEach(o => {
    if (o && o.kind === 'cylinder' && o.r > 0)
      候補.push({ cx: (o.at && o.at.x) || 0, cy: (o.at && o.at.y) || 0, r: o.r });
  });
  // ④ まとまりごとに円筒に当てはめる
  for (const [, tris] of 塊) {
    if (tris.length < 6) continue;
    const vs = new Set();
    tris.forEach(i => { vs.add(T[i][0]); vs.add(T[i][1]); vs.add(T[i][2]); });
    const pts = [...vs].map(k => [M[k][0], M[k][1]]);
    let fit = _csgFitCircle(pts);
    // 元の円柱の値が近ければ、そちらを正とする（丸め誤差で半径が揺れない）
    if (fit) {
      for (const c of 候補) {
        if (Math.hypot(c.cx - fit.cx, c.cy - fit.cy) < Math.max(0.05, fit.r * 0.02)
            && Math.abs(c.r - fit.r) < Math.max(0.05, fit.r * 0.02)) {
          fit = { cx: c.cx, cy: c.cy, r: c.r, rms: fit.rms, 元: true };
          break;
        }
      }
    }
    if (!fit || !(fit.r > 0.05)) continue;
    // 【当てはまったと言える条件】残差が小さい ＋ 法線が中心からの放射方向と揃う（Codex）
    if (!(fit.rms < Math.max(1e-3, fit.r * 0.02))) continue;
    let 揃い = 0;
    for (const i of tris) {
      const n = 面法線.get(i); if (!n) continue;
      const a = M[T[i][0]], b = M[T[i][1]], c = M[T[i][2]];
      const gx = (a[0] + b[0] + c[0]) / 3 - fit.cx, gy = (a[1] + b[1] + c[1]) / 3 - fit.cy;
      const gl = Math.hypot(gx, gy); if (!(gl > 1e-9)) continue;
      if (Math.abs((gx / gl) * n[0] + (gy / gl) * n[1]) > 0.9) 揃い++;
    }
    if (!(揃い > tris.length * 0.8)) continue;       // 放射方向を向いていない＝円筒ではない
    // 高さ・角度の範囲は**メッシュから**取る（くり抜かれた後の実際の範囲）
    let z0 = Infinity, z1 = -Infinity;
    const angs = [];
    for (const k of vs) {
      const q = M[k];
      if (q[2] < z0) z0 = q[2];
      if (q[2] > z1) z1 = q[2];
      angs.push(Math.atan2(q[1] - fit.cy, q[0] - fit.cx));
    }
    if (!(z1 - z0 > 0.05)) continue;                 // 薄すぎる帯は面にしない
    const sp = _csgAngleSpan(angs, Math.PI / 6);     // 30°より大きい隙間があれば切れ目
    if (!sp || !(sp.sweep > 0.05)) continue;
    // 外を向いているか（法線が中心から外向きなら sweep は正のまま）
    let 外 = 0;
    for (const i of tris) {
      const n = 面法線.get(i); if (!n) continue;
      const a = M[T[i][0]], b = M[T[i][1]], c = M[T[i][2]];
      const gx = (a[0] + b[0] + c[0]) / 3 - fit.cx, gy = (a[1] + b[1] + c[1]) / 3 - fit.cy;
      if (gx * n[0] + gy * n[1] > 0) 外++;
    }
    out.push({
      // 単位はグリッド（建屋の円弧の壁と同じ約束）。高さだけメートル
      cx: fit.cx / mpp, cy: fit.cy / mpp, r: fit.r / mpp,
      a0: sp.a0, sweep: sp.sweep,
      z0, z1,
      外向き: 外 > tris.length / 2,
      三角形: tris.length, 残差: fit.rms, 元の円柱: !!fit.元,
    });
  }
  return out;
}

// ══ 球面を取付枠として出す（ドーム・タンクの鏡板）・2026-10-04 ══
// 【これは「形の種類を足す」話ではない】ユーザー指摘のとおり、3D CAD は面の種類ごとに
//   処理を持たない。面が S(u,v)→点・法線 と その逆 を約束すれば、貼る側は種類を知らずに済む。
//   配置図でもその契約（atUV / projectUV）は既にできているので、
//   **ここでやるのは「メッシュの中から球を見つけて、残っている範囲を伝える」だけ**。
//   近さの測り方も機器の幾何も置く処理も1行も触っていない。
// 【作り方の履歴(ops)の球を候補にする】メッシュから中心と半径を推定するより確実（円筒と同じ作法）。
//   実際に残っている経度・緯度の範囲は**メッシュから**取る（くり抜かれた後の姿）。
// 戻り値: { cx, cy （グリッド）, cz, r （メートル）, lat0, lat1, a0, sweep, 外向き, 三角形 }
function csgSphereFaces(mi, triGroup, ops) {
  const out = [];
  if (!mi || !mi.verts || !mi.tris || !triGroup) return out;
  if (typeof window !== 'undefined' && window.__BODY_SPHERE === false) return out;
  const mpp = _csgMpp();
  const V = mi.verts, T = mi.tris;
  const M = V.map(q => [q.x * mpp, q.y * mpp, q.z]);     // メートル空間
  const 候補 = [];
  (ops || []).forEach(o => {
    if (o && o.kind === 'sphere' && o.r > 0)
      候補.push({ cx: (o.at && o.at.x) || 0, cy: (o.at && o.at.y) || 0,
                  cz: (o.at && o.at.z) || 0, r: o.r });
  });
  if (!候補.length) return out;
  for (const c of 候補) {
    const 許容 = Math.max(1e-3, c.r * 0.03);
    const tris = [];
    const vs = new Set();
    let 外 = 0;
    for (let i = 0; i < T.length; i++) {
      if (triGroup[i] >= 0) continue;                    // 平らな面に属している三角形は対象外
      const a = M[T[i][0]], b = M[T[i][1]], d = M[T[i][2]];
      // ① 3頂点とも球面に乗っているか
      let 乗る = true;
      for (const q of [a, b, d]) {
        const rr = Math.hypot(q[0] - c.cx, q[1] - c.cy, q[2] - c.cz);
        if (Math.abs(rr - c.r) > 許容) { 乗る = false; break; }
      }
      if (!乗る) continue;
      // ② 法線が中心からの放射方向と揃っているか（揃わないなら球面ではない）
      const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
      const bx = d[0] - a[0], by = d[1] - a[1], bz = d[2] - a[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const L = Math.hypot(nx, ny, nz);
      if (!(L > 1e-12)) continue;
      nx /= L; ny /= L; nz /= L;
      const gx = (a[0] + b[0] + d[0]) / 3 - c.cx;
      const gy = (a[1] + b[1] + d[1]) / 3 - c.cy;
      const gz = (a[2] + b[2] + d[2]) / 3 - c.cz;
      const gl = Math.hypot(gx, gy, gz);
      if (!(gl > 1e-9)) continue;
      const 内積 = (gx / gl) * nx + (gy / gl) * ny + (gz / gl) * nz;
      if (Math.abs(内積) < 0.85) continue;
      if (内積 > 0) 外++;
      tris.push(i);
      vs.add(T[i][0]); vs.add(T[i][1]); vs.add(T[i][2]);
    }
    if (tris.length < 8) continue;
    // 実際に残っている範囲（くり抜かれた後）を頂点から測る
    let lat0 = Infinity, lat1 = -Infinity;
    const 経度 = [];
    for (const k of vs) {
      const q = M[k];
      const dz = q[2] - c.cz;
      const la = Math.asin(Math.max(-1, Math.min(1, dz / c.r)));
      if (la < lat0) lat0 = la; if (la > lat1) lat1 = la;
      経度.push(Math.atan2(q[1] - c.cy, q[0] - c.cx));
    }
    if (!(lat1 - lat0 > 0.05)) continue;                 // 薄すぎる帯は面にしない
    const sp = _csgAngleSpan(経度, Math.PI / 6);
    if (!sp || !(sp.sweep > 0.05)) continue;
    out.push({
      cx: c.cx / mpp, cy: c.cy / mpp,     // x,y はグリッド（建屋の円弧の壁と同じ約束）
      cz: c.cz, r: c.r,                   // 高さと半径はメートル
      lat0, lat1, a0: sp.a0, sweep: sp.sweep,
      外向き: 外 > tris.length / 2,
      三角形: tris.length,
    });
  }
  return out;
}

// ══ 画面の点 → 面の中の座標(a,b) ・2026-09-28 Codex監査済み ══
// 【なぜ純関数にするか】同じ計算が建物エディタ（独自カメラ）と3次元図（proj）の両方に要る。
//   投影の仕方だけが違うので、**3D点を画面へ写す関数を引数で受ける**。窓ごとに式を書かない。
// projM(px, py, pz) … メートルの3D点 → { x, y }（画面の座標）
// 返り値 { a, b } は面の基底 u,v に沿った距離（メートル）。
//   面が画面上で線に潰れている（行列式がほぼ0）ときは null（そこに形は描けない）
function csgScreenToPlaneUV(o, u, v, projM, sx, sy) {
  if (!o || !u || !v || typeof projM !== 'function') return null;
  const S = 1;   // 1メートルぶん動かして、画面で何px動くかを見る
  const p0 = projM(o[0], o[1], o[2]);
  const pu = projM(o[0] + u[0] * S, o[1] + u[1] * S, o[2] + u[2] * S);
  const pv = projM(o[0] + v[0] * S, o[1] + v[1] * S, o[2] + v[2] * S);
  if (!p0 || !pu || !pv) return null;
  const ax = (pu.x - p0.x) / S, ay = (pu.y - p0.y) / S;
  const bx = (pv.x - p0.x) / S, by = (pv.y - p0.y) / S;
  const det = ax * by - ay * bx;
  if (!(Math.abs(det) > 1e-6)) return null;         // 真横から見ていて面が線になっている
  const dx = sx - p0.x, dy = sy - p0.y;
  return { a: (dx * by - dy * bx) / det, b: (ax * dy - ay * dx) / det };
}

// 面の中の座標(a,b) → メートルの3D点
function csgPlaneUVToPoint(o, u, v, a, b) {
  return [o[0] + u[0] * a + v[0] * b,
          o[1] + u[1] * a + v[1] * b,
          o[2] + u[2] * a + v[2] * b];
}

// その面の中で、輪郭が収まっている範囲（a,b の最小最大）。描いた形をここへ収める
function csgUvBounds(group) {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const c of (group && group.contours) || []) for (const [a, b] of c) {
    if (a < a0) a0 = a; if (a > a1) a1 = a;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  return isFinite(a0) ? { a0, a1, b0, b1 } : null;
}

// その点が面の中か（輪郭の巻き数で見る。穴は外と数える）
function csgPointInFace(group, a, b) {
  let w = 0;
  for (const c of (group && group.contours) || []) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const [xi, yi] = c[i], [xj, yj] = c[j];
      if ((yi > b) !== (yj > b)) {
        const t = (b - yi) / ((yj - yi) || 1e-12);
        if (a < xi + (xj - xi) * t) w += (yj > yi) ? 1 : -1;
      }
    }
  }
  return w !== 0;
}

// 面の中に描いた矩形 → 押し出せる輪郭（左回りに揃える）
function csgRectContour(a0, b0, a1, b1) {
  const x0 = Math.min(a0, a1), x1 = Math.max(a0, a1);
  const y0 = Math.min(b0, b1), y1 = Math.max(b0, b1);
  const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  let s2 = 0;
  for (let i = 0; i < 4; i++) { const p = c[i], q = c[(i + 1) % 4]; s2 += p[0] * q[1] - q[0] * p[1]; }
  return s2 >= 0 ? c : c.slice().reverse();
}

// ══ 面の上に描いた多角形 → 押し出せる輪郭 ・2026-09-29 Codex監査済み ══
// 【なぜここでやるか】掃除（重なった点を消す）・検査（自己交差を拒否）・向きの正規化を
//   描く側に書くと、矩形と多角形で二系統になる。**確定の1か所**で全部やる。
// 【なぜ自己交差を拒否するか】8の字のような輪郭は押し出すと立体が壊れる。
//   直せるふりをせず、はっきり作らない（null を返す）。
// pts は面の中の座標 [[a,b],...]（メートル）。返り値は左回りに揃えた輪郭、駄目なら null。
function csgPolyContour(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return null;
  // ① 重なった点・極端に短い辺を落とす
  const c = [];
  for (const q of pts) {
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
    const last = c[c.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-4) continue;
    c.push([q[0], q[1]]);
  }
  while (c.length >= 2 && Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 1e-4) c.pop();
  if (c.length < 3) return null;
  // ② 面積がほぼ0（一直線）なら駄目
  let s2 = 0;
  for (let i = 0; i < c.length; i++) { const a = c[i], b = c[(i + 1) % c.length]; s2 += a[0] * b[1] - b[0] * a[1]; }
  if (!(Math.abs(s2 / 2) > 1e-4)) return null;
  // ③ 隣り合っていない辺どうしが交わっていたら駄目（自己交差）
  const 交わる = (p1, p2, p3, p4) => {
    const d = (x1, y1, x2, y2, x3, y3) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    const d1 = d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
    const d2 = d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
    const d3 = d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    const d4 = d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  const N = c.length;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (i === j || (i + 1) % N === j || (j + 1) % N === i) continue;   // 隣どうしは端点を共有する
      if (交わる(c[i], c[(i + 1) % N], c[j], c[(j + 1) % N])) return null;
    }
  }
  // ④ 左回りに揃える（右回りだと manifold が「穴」と解釈する）
  return s2 >= 0 ? c : c.slice().reverse();
}

// 面を押し引きした結果を ops の1段にする。
//   depthM > 0 … 外向きに足す（union）／ < 0 … 内向きにくり抜く（subtract）
// **向きの符号はここ1か所**。呼ぶ側で n を反転させない（符号を2か所に置くと必ずずれる）
// contoursOverride を渡すと、**面まるごとでなくその形だけ**を押し出す
//   （面の上に矩形を描いて押し引きする操作。単位はメートル・面の基底 u,v に沿った座標）
function csgPushPullOp(group, depthM, contoursOverride) {
  if (!group || !isFinite(depthM) || Math.abs(depthM) < 1e-6) return null;
  const 外 = depthM > 0;
  const h = Math.abs(depthM);
  const n = group.n;
  // 【内向きは基底を裏返さない・2026-09-28 実測】裏返すと輪郭の回り方が逆になり、
  //   manifold が「穴」と解釈して立体が丸ごと消えた（体積 64 → 0）。
  //   代わりに**押し出す箱を厚みぶん手前へずらす**。向き(u,v,n)はそのままなので
  //   回り方が変わらず、面の裏側に同じ形の箱ができる。
  const o = 外 ? group.o
               : [group.o[0] - n[0] * h, group.o[1] - n[1] * h, group.o[2] - n[2] * h];
  const cont = (Array.isArray(contoursOverride) && contoursOverride.length)
    ? contoursOverride : group.contours;
  return {
    kind: 'extrude', contours: cont, h,
    o, u: group.u, v: group.v, n,
    mode: 外 ? 'union' : 'subtract',
  };
}

// ── ボディを評価して solid（既存と同じ形）にする ──
// body = { id, label, color, ops: [ {kind,...,mode}, ... ] }
//   mode は 2つ目以降に効く: 'union'（結合・既定）/ 'subtract'（切り取り）/ 'intersect'（共通部分）
// dirs = 水平から見る向き（ラジアン）の一覧。図面に存在する向きだけを渡す
//   （断面図=0 / 側面図=π/2 / 矢視図はその図の横軸の向き）。
// levels … 階の床の高さ［メートル］の一覧。水平断面（＝階の床の輪郭）を作るのに使う
async function csgEvalBody(body, dirs, levels) {
  if (!body || !Array.isArray(body.ops) || !body.ops.length) return null;
  const M = await csgLoad();
  const { Manifold } = M;
  const keep = [];
  let acc = null;
  try {
    for (const op of body.ops) {
      const s = csgMakePrimitive(Manifold, op, keep);
      if (!s) continue;
      if (!acc) { acc = s; continue; }
      const mode = op.mode || 'union';
      const next = mode === 'subtract' ? acc.subtract(s)
                 : mode === 'intersect' ? acc.intersect(s)
                 : acc.add(s);
      keep.push(next);
      acc = next;
    }
    if (!acc) return null;
    const mesh = acc.getMesh();
    const faces = csgMeshToFaces(mesh, body.id);
    // 2Dビュー（平面図・断面図・側面図・矢視図・追加平面図）が影の輪郭を作るのに使う
    const meshIdx = csgMeshIndexed(mesh);
    // 3次元図で掴んで押し引きできる「平らな面」
    const planar = csgPlanarFaces(meshIdx);
    // 曲面（鉛直な円筒）。タンクの胴・曲がった廊下の壁に設備を貼るため（2026-10-03）
    const curved = csgCurvedFaces(meshIdx, planar.triGroup, body.ops);
    // 球面（ドーム・タンクの鏡板）・2026-10-04。平らな面にも円筒にも足し算で増えるだけ
    const spheres = csgSphereFaces(meshIdx, planar.triGroup, body.ops);
    const mpp = _csgMpp();
    const bb = acc.boundingBox();
    // 【2026-09-26】平面図に出すための「上から見た影」。manifold の project() が
    // XY平面への投影（CrossSection）を返すので、その輪郭を点列でもらう。
    // 外形を凸包で近似すると凹形（L字・穴あき）が嘘になるので、必ずこれを使う。
    // 【正はここ・2026-09-27 Codex監査済み】影の輪郭は manifold の project() で作る。
    //   三角形から推定すると凹形で嘘の線が出る（csgFallbackFill2D の注記を参照）。
    const _polys = (m) => {
      const pr = m.project();
      const ps = pr.toPolygons();
      pr.delete();
      return (ps || []).filter(q => q && q.length >= 3);
    };
    let outline = [];
    try {
      outline = _polys(acc).map(poly => poly.map(v => ({ x: v[0] / mpp, y: v[1] / mpp })));
    } catch (e) { console.warn('[CSG] 真上からの投影に失敗', e && e.message); }
    // 水平から見た影。立体を回してから project() する
    //   rotate([0,0,-θ]) … 見る向きの横軸(u)をX軸に合わせる
    //   rotate([-90,0,0]) … (x,y,z) → (x, z, -y)。project() が落とすのは3番目なので (u, z) が残る
    // 返す点は { u, z } でどちらも**メートル**。u は世界の原点から測った距離。
    const outlineH = {};
    for (const rad of (Array.isArray(dirs) ? dirs : [])) {
      const key = csgDirKey(rad);
      if (outlineH[key]) continue;
      try {
        const r1 = acc.rotate([0, 0, -(rad * 180 / Math.PI)]); keep.push(r1);
        const r2 = r1.rotate([-90, 0, 0]); keep.push(r2);
        outlineH[key] = _polys(r2).map(poly => poly.map(v => ({ u: v[0], z: v[1] })));
      } catch (e) { console.warn('[CSG] 横からの投影に失敗', key, e && e.message); }
    }
    // 【階の床の輪郭・2026-11-05】欲しい高さごとに水平断面を取る。
    //   【なぜ面から推定しないか】三角形を切って端点でつなぐやり方は、つなぎ損ねたとき
    //   「重心まわりで外周を拾う」救済に落ちて**穴が消える**
    //   （solidModel.js の blockFootprintAtZ の注記。水平断面が星形でないと嘘になる）。
    //   CSG で作る形はまさに穴・L字・リングが目的なので、必ず slice() を使う。
    //   【slice の約束】下端ちょうどは底面を返し、上端ちょうどは空を返す。
    //   これは段0の bcSpanHoldsZ の「下端は含む・上端は含まない」と一致している。
    //   単位は outline（真上からの影）と同じ **グリッド**に直す（読み手が bcFloorOutlines）。
    const outlineZ = {};
    for (const zM of (Array.isArray(levels) ? levels : [])) {
      const zkey = csgZKey(zM);
      if (outlineZ[zkey]) continue;
      let cs = null;
      try {
        cs = acc.slice(zM);
        outlineZ[zkey] = (cs.toPolygons() || []).filter(q => q && q.length >= 3)
          .map(poly => poly.map(v => ({ x: v[0] / mpp, y: v[1] / mpp })));
      } catch (e) { console.warn('[CSG] 水平断面に失敗', zkey, e && e.message); }
      finally { if (cs) { try { cs.delete(); } catch (_) {} } }
    }
    return {
      id: body.id, bodyId: body.id, label: body.label || body.id,
      color: body.color || '#6B7A8D',
      faces,
      mesh: meshIdx,                     // 2Dビューの影づくり用（頂点番号つき）
      planarFaces: planar.groups,        // 3次元図で押し引きできる平らな面
      curvedFaces: curved,               // 設備を貼れる曲面（鉛直な円筒）
      sphereFaces: spheres,              // 設備を貼れる球面（ドーム・鏡板）・2026-10-04
      triGroup: planar.triGroup,         // 三角形番号 → 面のまとまり番号（-1は曲面など対象外）
      _normPts: (outline[0] || []),      // 平面図の当たり判定などが見る代表の輪郭
      outline,                           // 上から見た影（穴・凹みも含む全部の輪郭）
      outlineH,                          // 水平から見た影。キーは csgDirKey(向き)
      dirKeys: Object.keys(outlineH),    // どの向きぶんを持っているか（古い結果を混ぜないため）
      outlineZ,                          // 高さごとの水平断面（＝階の床の形）。キーは csgZKey(m)
      zKeys: Object.keys(outlineZ),      // どの高さぶんを持っているか（古い結果を混ぜないため）
      _csg: true,
      volume: acc.volume(),
      bbox: {                            // x,y はグリッド、z はメートル
        minX: bb.min[0] / mpp, maxX: bb.max[0] / mpp,
        minY: bb.min[1] / mpp, maxY: bb.max[1] / mpp,
        minZ: bb.min[2], maxZ: bb.max[2],
      },
    };
  } finally {
    // manifold は WASM のメモリを持つので、作った物は必ず解放する
    keep.forEach(s => { try { s.delete(); } catch (e) {} });
  }
}

// すべてのボディを評価する。読み込み前・失敗時は空を返す（既存の表示を壊さない）
async function csgEvalBodies(bodies, dirs, levels) {
  if (!Array.isArray(bodies) || !bodies.length) return [];
  const out = [];
  for (const b of bodies) {
    try {
      const s = await csgEvalBody(b, dirs, levels);
      if (s) out.push(s);
    } catch (e) {
      console.warn('[CSG] ボディの評価に失敗', b && b.id, e && e.message);
    }
  }
  return out;
}

// ══ 平面図で描いた輪郭 → 押し出しの段 ・2026-09-28 Codex監査済み ══
// points はグリッド座標（画面と同じで y は下向き）。厚み h と下端 z はメートル。
// 【向きはここで正す】左回り（面積が正）でないと manifold が「穴」と解釈して立体が消える。
//   画面の y は下向きなので、描いた順のままでは右回りになることがある。
//   App 側で気をつけるのではなく、**段を作るこの関数が必ず正規化する**。
function csgPlanOutlineOps(points, hM, zM) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const mpp = _csgMpp();
  const h = (hM > 0) ? hM : 1;
  let c = points.map(p => [p.x * mpp, p.y * mpp]);
  let s2 = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    s2 += a[0] * b[1] - b[0] * a[1];
  }
  if (!(Math.abs(s2 / 2) > 1e-6)) return null;      // つぶれた形は作らない
  if (s2 < 0) c = c.slice().reverse();
  return [{
    kind: 'extrude', contours: [c], h,
    o: [0, 0, zM || 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], mode: 'union',
  }];
}

// ══ 壁にする ・2026-09-30 Codex監査済み ══
// 【何をするか】立体を**真上から見た形**を内側へ厚みぶん縮め、その形でくり抜く段を1つ作る。
//   箱なら「4枚の壁（＋床）」になる。部屋・間取りはこれで一発。
// 【「シェル」と名乗らない・Codex指摘】本物のシェルは立体全体を薄くする。これは真上から見た形
//   でしか薄くできない（斜めの屋根がある立体だと屋根の下が抜ける）。できることだけを名乗る。
// 【2回押しても重ねがけしない】呼ぶ側は**壁の段を外した ops** を渡す。ここは毎回作り直すので、
//   厚みを変えても「壁にした後の形」をさらに縮める事故が起きない。
// 【できないときは黙って通さない】理由を返す（厚すぎ・高さ不足など）。
const CSG_WALL_MITER = 3;          // 角の尖りの上限。無制限だと鋭角でトゲが出る
async function csgWallifyOp(ops, opts) {
  const o = opts || {};
  const t = (o.thicknessM > 0) ? o.thicknessM : 0.2;
  let sol = null;
  try { sol = await csgEvalBody({ id: '_wall', label: '_wall', color: '#888', ops }, []); }
  catch (e) { return { ok: false, 理由: '立体を作れません: ' + (e && e.message) }; }
  if (!sol) return { ok: false, 理由: '立体を作れません' };
  const mpp = _csgMpp();
  // 真上から見た影（穴・離れた塊も全部）。1つの外周に潰さない
  const cont = (sol.outline || []).map(poly => poly.map(q => [q.x * mpp, q.y * mpp]))
    .filter(c => c.length >= 3);
  if (!cont.length) return { ok: false, 理由: '真上から見た形が取れません' };
  const M = await csgLoad();
  const { CrossSection } = M;
  const keep = [];
  let polys = null;
  try {
    const cs = CrossSection.ofPolygons(cont); keep.push(cs);
    const jt = (M.JoinType && M.JoinType.Miter != null) ? M.JoinType.Miter : null;
    const inner = (jt != null) ? cs.offset(-t, jt, CSG_WALL_MITER) : cs.offset(-t);
    keep.push(inner);
    const sim = inner.simplify(1e-4); keep.push(sim);
    polys = (sim.toPolygons() || []).filter(c => c && c.length >= 3).map(c => c.map(v => [v[0], v[1]]));
  } catch (e) {
    keep.forEach(x => { try { x.delete(); } catch (e2) {} });
    return { ok: false, 理由: '内側の形を作れません: ' + (e && e.message) };
  }
  keep.forEach(x => { try { x.delete(); } catch (e2) {} });
  if (!polys.length) return { ok: false, 理由: '厚みが大きすぎて内側が無くなります' };
  // 床・天井を残すならその厚みぶん内へ。残さないなら少しはみ出して貫通させる
  //（面がぴったり重なると演算が不安定になるため）
  const EPS = 0.05;
  const z0 = o.keepFloor ? sol.bbox.minZ + t : sol.bbox.minZ - EPS;
  const z1 = o.keepCeil ? sol.bbox.maxZ - t : sol.bbox.maxZ + EPS;
  if (!(z1 - z0 > 0.01)) return { ok: false, 理由: '厚みが立体の高さより大きいです' };
  return { ok: true, op: {
    kind: 'extrude', tool: 'wallify',            // この印で「壁の段」を見分けて置き換える
    thicknessM: t, keepFloor: !!o.keepFloor, keepCeil: !!o.keepCeil,
    contours: polys, h: z1 - z0,
    o: [0, 0, z0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], mode: 'subtract',
  } };
}

// ── よく使う形をひとまとめに作る（ユーザーが挙げた「円柱の先端が半球」もこれ）──
// 寸法はメートル、位置はグリッド座標で受けて中でメートルに直す
function csgPresetOps(kind, opts) {
  const o = opts || {};
  const mpp = _csgMpp();
  const cx = (o.cx || 0) * mpp, cy = (o.cy || 0) * mpp;   // グリッド → メートル
  const r = o.r != null ? o.r : 5;
  const h = o.h != null ? o.h : 10;
  const z = o.z || 0;
  if (kind === 'cylinder') {
    return [{ kind: 'cylinder', r, h, at: { x: cx, y: cy, z } }];
  }
  if (kind === 'domeTank') {
    // 円柱の先端が半球（タンク・サイロの鏡板）。
    // 【順番が意味を持つ・2026-09-27 実測で発覚】ops は**それまでの結果に対して**順に効く
    //   （csgEvalBody の acc）。木構造ではないので「球だけを切る」つもりで切り取りを
    //   最後に置くと、**円柱まで一緒に消える**。
    //   実測: [円柱, 球, 箱で切る] だと立体が z=10〜15.48m ＝ ドームだけが宙に浮いた。
    // 正しい順番は「球を置く → 下半分を切り落とす（＝半球になる） → 円柱を足す」。
    return [
      { kind: 'sphere', r, at: { x: cx, y: cy, z: z + h } },
      // 中心 z+h の球の、z+h より下を丸ごと落とす（箱の上面が z+h に来る）
      { kind: 'box', w: r * 4, d: r * 4, h: r * 2, at: { x: cx, y: cy, z: z + h - r }, mode: 'subtract' },
      { kind: 'cylinder', r, h, at: { x: cx, y: cy, z } },
    ];
  }
  if (kind === 'cone') {
    return [{ kind: 'cylinder', r, r2: (o.r2 != null ? o.r2 : r * 0.3), h, at: { x: cx, y: cy, z } }];
  }
  if (kind === 'box') {
    return [{ kind: 'box', w: (o.w != null ? o.w : 10), d: (o.d != null ? o.d : 10), h,
              at: { x: cx, y: cy, z: z + h / 2 } }];
  }
  return null;
}
