// ===== 定数定義 =====
const MAJOR = 36, MINOR = MAJOR / 5;
// 【図面の升目の数は選んだ範囲の縦横比に合わせる・2026-11-28 ユーザー要望】
//   「3次元図には今は固定で横長長方形となっているが、範囲選択したものが四角の場合はそれを描写範囲とし、
//    四角でなければそれが入るような四角を描写エリアの四角としてくれ」
//   範囲（localStorage の field_polygon）の外接する四角の縦横比で、長い辺を 160 升にする（升の数は従来の長い辺と同じ）。
//   範囲が無ければ従来どおり 160×112。縮尺（1升の実寸）は cesiumUtils.js の fieldFrameFromPolygon が
//   外接する四角がぴったり収まるように決める。旗 window.__FIELD_AREA_FIT = false で従来（160×112 固定・90%に収める）。
// 【以前に決めた範囲は従来の図面のまま・2026-11-28】図面の大きさと縮尺が変わると、その範囲で作って保存した図（座標は升目）が
//   地図とずれる。範囲に合わせるのは、この版以降に決めた範囲（commitFieldPolygon が field_fit=1 を残す）だけにする。
//   述語はここ1つ（升の数 fieldCellsFromPolygon と縮尺 fieldFrameFromPolygon が同じものを読む）。
function fieldAreaFitEnabled() {
  if (typeof window !== 'undefined' && window.__FIELD_AREA_FIT === false) return false;
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('field_fit') === '1'; } catch (e) { return false; }
}
function fieldCellsFromPolygon(poly) {
  const 既定 = { MC: 160, MR: 112 };
  if (!fieldAreaFitEnabled()) return 既定;
  if (!Array.isArray(poly) || poly.length < 3) return 既定;
  const lats = poly.map(p => p.lat), lngs = poly.map(p => p.lng);
  if (!lats.every(Number.isFinite) || !lngs.every(Number.isFinite)) return 既定;
  const 中lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const W = (Math.max(...lngs) - Math.min(...lngs)) * 111320 * Math.cos(中lat * Math.PI / 180);
  const H = (Math.max(...lats) - Math.min(...lats)) * 111320;
  if (!(W > 0 && H > 0)) return 既定;
  const 長 = 160, 短の下限 = 8;
  if (W >= H) return { MC: 長, MR: Math.max(短の下限, Math.min(長, Math.round(長 * H / W))) };
  return { MC: Math.max(短の下限, Math.min(長, Math.round(長 * W / H))), MR: 長 };
}
const _FIELD_CELLS = (() => {
  try { const s = (typeof localStorage !== 'undefined') ? localStorage.getItem('field_polygon') : null; return fieldCellsFromPolygon(s ? JSON.parse(s) : null); }
  catch (e) { return { MC: 160, MR: 112 }; }
})();
const MC = _FIELD_CELLS.MC, MR = _FIELD_CELLS.MR, TW = MC * MAJOR, TH = MR * MAJOR, MAX_Z = 8 * MAJOR;
const VIEW_PAD = 600; // 平面図・断面図・側面図の回転用余白（px）
const CAB_W = 900, CAB_H = 700;
const DEF_AZ = -0.21, DEF_EL = 0.26;
const ELEV_W = TW, MIN_Z = -4 * MAJOR, ELEV_H = MAX_Z - MIN_Z + 60;
const GL_Y = 30 + MAX_Z; // 断面図上の地面Y座標
const SIDE_W = TH, SIDE_H = ELEV_H; // 側面図: 横=Y軸, 縦=Z軸
const initNodes = [
  { id: "g1", kind: "symbol", label: "G1", shape: "gen", color: "#B45309", dPos: { x: 45, y: 30 } },
  { id: "g2", kind: "symbol", label: "G2", shape: "gen", color: "#B45309", dPos: { x: 160, y: 30 } },
  { id: "cb1", kind: "symbol", label: "52-1", shape: "cb_g", color: "#16A34A", dPos: { x: 50, y: 145 } },
  { id: "cb2", kind: "symbol", label: "52-2", shape: "cb_r", color: "#DC2626", dPos: { x: 155, y: 145 } },
  { id: "cb3", kind: "symbol", label: "52-3", shape: "cb_g", color: "#16A34A", dPos: { x: 40, y: 280 } },
  { id: "cb4", kind: "symbol", label: "52-4", shape: "cb_r", color: "#DC2626", dPos: { x: 120, y: 280 } },
  { id: "cb5", kind: "symbol", label: "52-5", shape: "cb_g", color: "#16A34A", dPos: { x: 200, y: 280 } },
  { id: "g3", kind: "symbol", label: "G3", shape: "gen", color: "#B45309", dPos: { x: 200, y: 345 } },
  { id: "y1", kind: "free", dPos: { x: 95, y: 65 } },
  { id: "b1l", kind: "free", dPos: { x: 25, y: 100 } },
  { id: "b1r", kind: "free", dPos: { x: 210, y: 100 } },
  { id: "b2l", kind: "free", dPos: { x: 25, y: 240 } },
  { id: "b2r", kind: "free", dPos: { x: 220, y: 240 } },
  { id: "t1", kind: "on_seg", segId: "bus1", t: 0.18, dPos: { x: 58, y: 100 } },
  { id: "t2", kind: "on_seg", segId: "bus1", t: 0.72, dPos: { x: 158, y: 100 } },
  { id: "t3", kind: "on_seg", segId: "bus2", t: 0.10, dPos: { x: 44, y: 240 } },
  { id: "t4", kind: "on_seg", segId: "bus2", t: 0.50, dPos: { x: 122, y: 240 } },
  { id: "t5", kind: "on_seg", segId: "bus2", t: 0.90, dPos: { x: 200, y: 240 } },
];
const initSegs = [
  { id: "s1", from: "g1", to: "y1" }, { id: "s2", from: "g2", to: "y1" }, { id: "s3", from: "y1", to: "t1" },
  { id: "bus1", from: "b1l", to: "b1r", isBus: true },
  { id: "s4", from: "t1", to: "cb1" }, { id: "s5", from: "t2", to: "cb2" },
  { id: "s6", from: "cb1", to: "t3" }, { id: "s7", from: "cb2", to: "t4" },
  { id: "bus2", from: "b2l", to: "b2r", isBus: true },
  { id: "s8", from: "t3", to: "cb3" }, { id: "s9", from: "t4", to: "cb4" },
  { id: "s10", from: "t5", to: "cb5" }, { id: "s11", from: "cb5", to: "g3" },
];
// 全ブロック統一: points[{x,y}] = 平面図座標, zBottom/zTop = 高さ範囲
// ══ 動作確認用の既定データ・2026-09-06（ユーザー要望）══
// 「毎回めんどいからデフォルトでこれしておいて → 床に1つ・壁に1つ・扉に1つ機器を置く」
// 建屋Aの1階に、壁1枚・扉1つ・機器3つ（床置き／壁付け／扉付け）を最初から入れておく。
// 【なぜ初期データに書くか】保存済みのレイアウトを読み込んだときは丸ごと差し替わるので、
// **これは「何も保存されていないときだけ」出る**。ユーザーの作ったデータを壊さない。
// 【単位】x,y = グリッドpx（1グリッド=0.1m）。壁の厚み・機器の寸法・高さ = メートル
const INIT_BLD_A_FLOOR = {
  id: 'floorA1', name: '', levelZ: 0, heightM: 3, slabThicknessM: 0.15,
  outline: null, openings: [],
  // 建屋Aの中を東西に横切る壁（20m〜50m の位置＝長さ30m）
  partitions: [
    { id: 'partA1', name: '', kind: 'wall',
      a: { x: 200, y: 260 }, b: { x: 500, y: 260 },
      thicknessM: 0.15, heightM: null, baseM: 0, color: null },
  ],
  // その壁の中央あたりに扉を1つ
  doors: [
    { id: 'doorA1', name: '扉', partitionId: 'partA1', uM: 15,
      widthM: 0.9, heightM: 2.0, thicknessM: null, faceSide: 1,
      hingeSide: 'left', isOpen: false },
  ],
  // 機器3つ。名前で区別できるようにしておく（動作確認でどれを触ったか言えるように）
  icons: [
    // ① 床置き（壁の手前・床の上に立つ箱）
    { id: 'iconFloorA', name: '床の機器', iconType: 'generic', color: '#38BDF8',
      partitionId: null, gx: 300, gy: 320, rotDeg: 0,
      tM: 0, wM: 0.8, dM: 0.6, hM: 1.8 },
    // ② 壁付け（壁の面に貼る板）
    { id: 'iconWallA', name: '壁の機器', iconType: 'generic', color: '#FBBF24',
      partitionId: 'partA1', side: 1, sM: 8, tM: 1.2, wM: 0.3, hM: 0.3 },
    // ③ 扉付け（扉の面に貼る板）
    { id: 'iconDoorA', name: '扉の機器', iconType: 'generic', color: '#FBBF24',
      doorId: 'doorA1', side: 1, sM: 0.45, tM: 1.2, wM: 0.3, hM: 0.3 },
  ],
};
const INIT_BUILDINGS = [
  { id: "bld1", label: "建屋A", color: "#6B7A8D", floors: [INIT_BLD_A_FLOOR], blocks: [
    { points: [{x:144,y:144},{x:576,y:144},{x:576,y:432},{x:144,y:432}], zBottom: 0, zTop: 15 }
  ]},
  { id: "bld2", label: "建屋B", color: "#7B8A9D", blocks: [
    { points: [{x:720,y:144},{x:1080,y:144},{x:1080,y:432},{x:720,y:432}], zBottom: 0, zTop: 10 }
  ]},
  { id: "bld3", label: "制御室", color: "#8896A8", blocks: [
    { points: [{x:1296,y:864},{x:1584,y:864},{x:1584,y:1080},{x:1296,y:1080}], zBottom: 0, zTop: 8 }
  ]},
];
