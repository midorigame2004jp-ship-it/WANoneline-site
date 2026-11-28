// ================================================================
// 方位キューブの幾何コア（唯一の実装）
// ================================================================
// ここが持つのは **幾何と面定義だけ**。JSXは持たない。
// 描画は2か所に分かれたままにしてある（2026-08-30 Codex監査で妥当と判定）:
//   - App.jsx の 平面図・断面図・側面図・矢視図 … 矢印をビューごとに選ぶ／面をその場で2D回転
//   - OrientationCube.jsx（建物エディタ）      … 面ラベル・中心の白丸・PN調整パネル・ドラッグ・可変size
// UI要件が違うものを1コンポーネントへ寄せるとpropsの条件分岐が増えて責務が濁るため、
// **重複の本体であった投影・depth・明暗判定だけ**をここへ集約した。
//
// 【深さ規約】depth が大きいほど手前（project3DPanel ＝ OrientationCube 側の規約）。
//   spec 12.9 が「共通コンポーネントは project3DPanel 側に合わせる」と既に宣言している。
//   App.jsx の project3D は **逆規約**（小さいほど手前）なので、
//   App 側は必ず ocFromWorldCam() を通してから呼ぶこと。
//
// 【引き分け】|depth - midD| < OC_DEPTH_EPS のときは far（暗）に倒す。
//   引き分け＝面が真横を向いている＝画面上の面積が0。明色で塗る意味が無く、
//   OrientationCube は手前面にラベル文字を描くので、**見えない面にラベルが出るのを防ぐ**。
//   統合前は App が `<`（暗）、OrientationCube が `>`（明）で、
//   どちらに倒すかがそもそも決まっていなかった（実測で5/960件が食い違っていた）。
//
// 【EPSの大きさ】実測の食い違いは 1e-17 桁（checks/cube_parity2.cjs）。
//   1e-12 なら十分拾えるうえ、斜め近傍の薄い面まで far へ誤判定するほど大きくはない
//   （Codex指摘: 1e-10 だと薄い面を巻き込む恐れがある）。

const OC_DEPTH_EPS = 1e-12;

// 明暗の判定はこの1行だけ。呼び出し側で `depth > midD` などと書き直さないこと
// （書き直した瞬間に引き分けの扱いが2通りに戻る。それが統合前の状態だった）
function ocIsNear(depth, midD) { return (depth - midD) > OC_DEPTH_EPS; }

// 6面の定義（頂点index・明色・暗色・ラベル）。色は統合前から両実装で同一だった
const OC_FACE_DEFS = [
  { vi: [1,3,7,5], b: '#EF4444', dk: '#991B1B', label: 'X'   },
  { vi: [0,4,6,2], b: '#7F1D1D', dk: '#450A0A', label: '-X'  },
  { vi: [2,3,7,6], b: '#22C55E', dk: '#14532D', label: 'PN'  },
  { vi: [0,1,5,4], b: '#166534', dk: '#052E16', label: '-PN' },
  { vi: [4,5,7,6], b: '#3B82F6', dk: '#1E3A8A', label: 'Z'   },
  { vi: [0,1,3,2], b: '#1E3A8A', dk: '#0F172A', label: '-Z'  },
];

// App.jsx（project3D＝world規約）のカメラを、キューブの規約へ直す。
// 【なぜ符号を3つとも反転するのか】総当たり実測（checks/cube_parity2.cjs・960面）で、
// 8通りの符号の組み合わせのうち **これだけが頂点960/960で完全一致**した（他は最大640/960）。
// 2実装は別物ではなく、同じ立方体を逆向きの引数規約で受けていただけである。
// 反転をコアの中に隠さないのは、隠すと「呼び出し規約が2つある」状態に戻るため。
function ocFromWorldCam(pnRad, az, el) {
  return { pnRad: -pnRad, az: -az, el: -el };
}

// 単位キューブのローカル(a, b, c) → 画面。gc=中心px / cs=半辺px
// 三角関数は毎頂点で使い回すので、投影器を1回作って渡す形にしている
function ocMakeProj(pnRad, az, el, gc, cs) {
  const cosP = Math.cos(pnRad), sinP = Math.sin(pnRad);
  const cosA = Math.cos(az),    sinA = Math.sin(az);
  const cosE = Math.cos(el),    sinE = Math.sin(el);
  return (a, b0, c) => {
    // 画面のyは下向きが正。グリッドyをそのまま投影すると PN/y の矢印が下を向くので反転する
    const b = -b0;
    const wx =  a * cosP + b * sinP;
    const wy = -a * sinP + b * cosP;
    const rx = wx * cosA - wy * sinA;
    const ry = wx * sinA + wy * cosA;
    return {
      x: gc + rx * cs,
      y: gc + (-ry * sinE - c * cosE) * cs,
      d: ry * cosE - c * sinE,          // 大きいほど手前
    };
  };
}

// 6面ぶんのポリゴン素材・明暗しきい値・明暗判定を返す。faces は奥→手前の順
function ocCubeFaces(pnRad, az, el, gc, cs) {
  const proj = ocMakeProj(pnRad, az, el, gc, cs);
  const v = [
    proj(-1,-1,-1), proj(+1,-1,-1), proj(-1,+1,-1), proj(+1,+1,-1),
    proj(-1,-1,+1), proj(+1,-1,+1), proj(-1,+1,+1), proj(+1,+1,+1),
  ];
  const faces = OC_FACE_DEFS.map(f => ({
    ...f,
    depth: f.vi.reduce((s,i) => s + v[i].d, 0) / 4,
    pts:   f.vi.map(i => v[i].x.toFixed(1) + ',' + v[i].y.toFixed(1)).join(' '),
    cx:    f.vi.reduce((s,i) => s + v[i].x, 0) / 4,
    cy:    f.vi.reduce((s,i) => s + v[i].y, 0) / 4,
  })).sort((a, b) => a.depth - b.depth);          // 奥→手前（depth大=手前）
  const midD = (Math.min(...faces.map(f => f.depth)) + Math.max(...faces.map(f => f.depth))) / 2;
  // 引き分けは far（暗）。上の【引き分け】参照
  return { faces, midD, isNear: (f) => ocIsNear(f.depth, midD) };
}

// 4本の軸の向き（画面上の単位ベクトル）。矢印用なので gc/cs は要らない
//   x  … プラント座標のX軸
//   n  … 真北。ENU(0,1,0) を Plant系へ戻した向き
//   pn … プラントノース（＝キューブのb軸／グリッドy）
//   z  … 鉛直上
//
// ★真北の式は OrientationCube.jsx から**直して**持ってきた（2026-08-30・実測で発覚）:
//   Cesium版（正）の proj は b をそのまま使うので `Plant(-sin, cos)` で正しい。
//   OrientationCube.jsx は「PN/y の矢印が下を向く」のを直すために `b = -b0` を足したが、
//   **真北ベクトルを直し忘れた**。その結果、真北が PN 角の**2倍**で回っていた
//   （PN=0°/180° でだけ偶然正しいので気づかれなかった。PN=90° では真逆を向く）。
//   b を反転する規約では正しい局所ベクトルは `(+sin(pnRad), cos(pnRad), 0)` になる。
//   これで真北は world (0,-1) 固定＝PNに依存しない。真北は動かず、
//   PN側（キューブ）がその下で回る、という物理どおりの姿になる。
//   検査: checks/cube_parity3.cjs「真北は PN に依存しない」（陽性対照つき）
// nOffRad: 真北が図面の上から時計回りにどれだけ回っているか（図面を範囲の向きに回したとき・2026-11-28）。
//   符号は project3D のグリッドで (sinθ, −cosθ) を投影した向きと一致することを数値で確かめた（0 なら従来）。
function ocAxisDirs(pnRad, az, el, nOffRad) {
  const _nOff = Number.isFinite(nOffRad) ? nOffRad : 0;
  const proj = ocMakeProj(pnRad, az, el, 0, 1);
  const p0 = proj(0, 0, 0);
  const nrm = (p) => {
    const dx = p.x - p0.x, dy = p.y - p0.y;
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  return {
    x:  nrm(proj(1, 0, 0)),
    n:  nrm(proj(Math.sin(pnRad + _nOff), Math.cos(pnRad + _nOff), 0)),
    pn: nrm(proj(0, 1, 0)),
    z:  nrm(proj(0, 0, 1)),
  };
}
