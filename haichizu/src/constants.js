// ===== 定数定義 =====
const MAJOR = 36, MINOR = MAJOR / 5;
const MC = 160, MR = 112, TW = MC * MAJOR, TH = MR * MAJOR, MAX_Z = 8 * MAJOR;
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
const INIT_BUILDINGS = [
  { id: "bld1", label: "建屋A", color: "#6B7A8D", blocks: [
    { points: [{x:144,y:144},{x:576,y:144},{x:576,y:432},{x:144,y:432}], zBottom: 0, zTop: 15 }
  ]},
  { id: "bld2", label: "建屋B", color: "#7B8A9D", blocks: [
    { points: [{x:720,y:144},{x:1080,y:144},{x:1080,y:432},{x:720,y:432}], zBottom: 0, zTop: 10 }
  ]},
  { id: "bld3", label: "制御室", color: "#8896A8", blocks: [
    { points: [{x:1296,y:864},{x:1584,y:864},{x:1584,y:1080},{x:1296,y:1080}], zBottom: 0, zTop: 8 }
  ]},
];
