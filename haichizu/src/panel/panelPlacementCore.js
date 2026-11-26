// ================================================================
// 配置済み配電盤の「置かれ方」コア（唯一の実装）
// ================================================================
// このファイルが持つのは **幾何と単位** だけ。色・アルファ・線幅などの見た目は
// panelDrawCore.js が唯一の正なので、ここにも呼び出し側にも書かない。
//
// 【なぜ分けたか】盤ローカルmm → ワールド の変換式が App.jsx の中だけで4か所に
// コピーされていた（_pde_panelSVGElems / _pde_makeCabProj / _renderPlacedPanels2D の
// toWorld / ppToFloorBox）。Cesium 2D・3D を対応させると5か所目になるため、
// 先に1本化した（2026-08-29 Codex監査の指示）。
// panelDrawCore.js に置かないのは、あちらが「見た目の正」であって、
// placedPanels の保存スキーマ（wx,wy が角・rot が絶対角・wz がグリッドpx）は別物だから。
//
// 【placedPanels のスキーマ】このファイルだけが知っていればよい。
//   pp.wx, pp.wy : 盤の**角**のワールド座標（グリッドpx）。中心ではない
//   pp.rot       : 絶対角（ラジアン）
//   pp.wz        : 据付高さ（グリッドpx）。省略時は0＝地面
//   pp.panelData : widthMm / depthMm / heightMm を持つ盤データ
//
// 【単位】ワールドの x,y は常にグリッドpx。z だけ2系統あるので必ず名前で区別する。
//   ...Px = グリッドpx（pp.wz や allMapPos.z と同じ単位）
//   ...M  = メートル（project3D や Cesium の高さに渡す単位）
// 取り違えると盤が地中や上空へ飛ぶ。名前のない z を返す関数をここに足さないこと。

function ppcMpp() {
  return (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
}

// 盤の寸法と換算係数。PPM = グリッドpx / mm
function ppcDims(pp) {
  const mpp = ppcMpp();
  const pd = (pp && pp.panelData) || {};
  return {
    mpp, PPM: 1 / (mpp * 1000),
    W: pd.widthMm || 600, H: pd.heightMm || 1800, D: pd.depthMm || 400,
  };
}

// 回転の中心（＝回転後の長方形の中心そのもの）。rot に依存しない。
// pp.wx,wy は角なので、中心は角 + 半分の寸法。
function ppcPivot(pp) {
  const { mpp, PPM, W, D } = ppcDims(pp);
  const wzPx = Number.isFinite(pp && pp.wz) ? pp.wz : 0;
  return {
    pivWx: (pp ? pp.wx : 0) + W / 2 * PPM,
    pivWy: (pp ? pp.wy : 0) + D / 2 * PPM,
    wzPx, wzM: wzPx * mpp,
  };
}

// 盤ローカルmm → ワールド の変換器。cos/sin と中心を前計算して返す。
// 毎頂点・毎フレーム呼ばれる経路（3次元図のカメラ投影）があるので、
// 1点ずつ関数呼び出しするのではなくこの変換器を1回作って使い回すこと。
//   toPx(xMm, yMm, zMm) -> [gx, gy, gzPx]   高さをグリッドpxで返す
//   toM (xMm, yMm, zMm) -> [gx, gy, gzM]    高さをメートルで返す
function ppcMakeXf(pp) {
  const d = ppcDims(pp);
  const p = ppcPivot(pp);
  const cs = Math.cos((pp && pp.rot) || 0), sn = Math.sin((pp && pp.rot) || 0);
  const W = d.W, D = d.D, PPM = d.PPM, mpp = d.mpp;
  const xy = (xMm, yMm) => {
    const lx = xMm - W / 2, ly = yMm - D / 2;
    return [
      p.pivWx + (lx * cs + ly * sn) * PPM,
      p.pivWy + (lx * sn - ly * cs) * PPM,
    ];
  };
  return {
    ...d, ...p, cs, sn,
    toPx: (xMm, yMm, zMm) => { const q = xy(xMm, yMm); return [q[0], q[1], p.wzPx + (zMm / 1000) / mpp]; },
    toM:  (xMm, yMm, zMm) => { const q = xy(xMm, yMm); return [q[0], q[1], p.wzM + zMm / 1000]; },
  };
}

// ══ 面に取り付けた盤 ・2026-10-01 ユーザー裁定／Codex監査済み ══
// 【取付枠の思想】形を作るもの（壁・外周・曲面）と付けるもの（盤）を、面だけで接着する。
//   盤は mount = { surfaceId, u, v, offN, side } を持ち、**wx/wy/wz/rot は毎回ここで導く**。
//   二重に持たない（壁を動かしたら盤も付いてくる）。
// 【u,v は盤の背面の中心】面の上の位置[m]。機器（コンセント）の持ち方と同じ規約にそろえる。
// 【鉛直な面だけ・Codex指摘】この変換器は yaw（Z軸まわりの回転）しか持たない＝盤は常に
//   地面に立つ箱。天井や傾いた面へ背中を付けるには変換器そのものを作り直す必要があるので、
//   今は受け付けない（水平な面・面が無い・mount が無い → 保存値のまま。迷子にしない）。
// 【曲面でも盤は曲げない】盤は箱なので、その位置の**接平面**に置く。
// 【向きの決め方】この変換器の規約は普通の回転行列ではない（Y側が反転している）ので、
//   atan2 を直感で入れると裏返る。盤ローカルの y=0 側を背面と決め、
//   その外向きが面の法線の逆（＝面を向く）になるよう rot を逆算する。
//     幅の向き  u_p = ( cos r,  sin r)
//     奥行の向き v_p = ( sin r, -cos r)
//     背面の外向き = -v_p = (-sin r, cos r) = -n  →  sin r = n.x, cos r = -n.y
function ppcResolveMount(pp, surface) {
  if (!pp || !pp.mount) return pp;
  const fm = surface;
  if (!fm || !fm.vertical || typeof fm.atUV !== 'function') return pp;
  const { PPM, W, D, H, mpp } = ppcDims(pp);
  const m = pp.mount;
  const a = fm.atUV(m.u || 0, m.v || 0);
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return pp;
  const sgn = (m.side < 0) ? -1 : 1;
  const nx = a.nx * sgn, ny = a.ny * sgn;        // 面から外へ出る向き（取り付けた側）
  // 面からの離れ。**壁の面に接させる**（atUV が返すのは壁の中心線なので、
  // 機器（bcIconAnchorGeom）と同じく半厚ぶん外へ出す）。offN は利用者が足す浮き
  // 面から盤の中心までの離れ。**式はここ1か所**（剥がれ判定 ppcMountStillOn も同じ値を見る）
  const gap = ppcMountGapGrid(pp, fm);
  const cx = a.x + nx * gap;
  const cy = a.y + ny * gap;
  const rot = Math.atan2(nx, -ny);
  const wzM = a.z - (H / 2) / 1000;             // v は背面の中心の高さなので、底面はその半分下
  return Object.assign({}, pp, {
    wx: cx - (W / 2) * PPM,
    wy: cy - (D / 2) * PPM,
    wz: wzM / mpp,
    rot,
    _mounted: true,                              // 解決済みの印（UI が「面に付いている」と分かるため）
  });
}

// 盤が面に付いているときの「面から盤の中心までの距離」[グリッド]・2026-10-03
// 【なぜ関数にするか】置かれ方を決める ppcResolveMount と、剥がれたかを決める ppcMountStillOn が
//   同じ値を見ないと「置いた直後にもう剥がれている」が起きる。
//   内訳＝利用者が足す浮き(offN) ＋ 壁の半厚(offGrid・atUV は中心線を返すため) ＋ 奥行きの半分
function ppcMountGapGrid(pp, fm) {
  const { PPM, D, mpp } = ppcDims(pp);
  const m = (pp && pp.mount) || {};
  return (m.offN || 0) / mpp + ((fm && fm.offGrid) || 0) + (D / 2) * PPM;
}

// 「引き離した」とみなす距離[m]。これより離れたら床置きに戻る
var PPC_MOUNT_TOL_M = 0.4;

// 壁に付いた盤を動かしたとき、**まだその面に付いているか**（＝面を滑るのか、剥がれるのか）
// 【なぜ今の面だけ見るか】「一番近い面」で取り直すと、建屋の中はどこも別の壁が数m以内にあるので
//   いくら引き離しても別の壁に付き直してしまい、ドラッグで床置きへ戻せない（2026-10-03 ユーザー報告）。
//   別の壁へ移すのは〔別の壁に付け替える〕の明示操作でやる。
// 【奥行きを含めて測る理由】盤の中心は面から D/2 離れた所にあるのが正しい姿なので、
//   固定値だけで測ると奥行きの大きい盤が「面を滑っているだけ」で剥がれてしまう。
// off は bcSurfaceOffsetOf(fm, 盤の中心) の結果。tolM を省くと既定 PPC_MOUNT_TOL_M[m]
function ppcMountStillOn(pp, fm, off, tolM) {
  if (!pp || !pp.mount || !fm || !off || !fm.vertical) return false;
  const m = pp.mount;
  // 面の裏へ回り込んだら剥がれ（表に付けた盤が裏へ出たら、もうその面の盤ではない）
  if (Number.isFinite(off.side) && Number.isFinite(m.side)
      && (off.side < 0) !== (m.side < 0)) return false;
  const tol = (Number.isFinite(tolM) ? tolM : PPC_MOUNT_TOL_M) / ppcMpp();
  return Math.abs(off.normalGrid - ppcMountGapGrid(pp, fm)) <= tol;
}

// 底面の4隅（ワールドのグリッドpx）。Cesium のポリゴンや当たり判定の外形に使う。
// 順序は盤ローカルで (0,0)→(W,0)→(W,D)→(0,D)。回転後も同じ回り方を保つ。
function ppcFootprintPx(pp) {
  const { W, D } = ppcDims(pp);
  const xf = ppcMakeXf(pp);
  return [[0, 0], [W, 0], [W, D], [0, D]].map(([a, b]) => {
    const q = xf.toPx(a, b, 0);
    return { x: q[0], y: q[1] };
  });
}

// 盤が占める高さの範囲。Cesium の extrudedHeight や断面判定に使う。
function ppcHeightSpan(pp) {
  const { mpp, H } = ppcDims(pp);
  const { wzPx, wzM } = ppcPivot(pp);
  return { zMinPx: wzPx, zMaxPx: wzPx + (H / 1000) / mpp, zMinM: wzM, zMaxM: wzM + H / 1000 };
}
