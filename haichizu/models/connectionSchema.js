// connectionSchema.js
// 接続（どの機器のどの端子と、どの機器のどの端子がつながっているか）と、
// インピーダンスを持つ「区間」の形。全モジュール共通のスキーマ。
//
// 大事な約束:
//  - 参照は機器ID（equipmentId）と端子名で書く。画面の要素ID（DOM id）は使わない。
//  - この形は既存の台帳（connectionState の wire 台帳・terminalLedger）から**導出**する投影であり、
//    接続を作る・変える操作は今までどおり単線結線図の wire 操作だけ。台帳を3つ目に増やさない。
//  - 値を持つのは区間（インピーダンス・条数・経路）だけ。区間は両端＋枝キーで名前が決まるので、
//    wire を分割・結合しても値が消えない。

// ── 節点（区間の端） ────────────────────────────────
// 端子: 機器の端子。分岐点: 3本以上が集まる点・T字で刺さった点（座標では無くIDで識別する）
export const NODE_KIND = Object.freeze({ TERMINAL: 'terminal', JUNCTION: 'junction' });

export function terminalNode(equipmentId, terminalName) {
  return { kind: NODE_KIND.TERMINAL, equipmentId, terminalName };
}
export function junctionNode(junctionId) {
  return { kind: NODE_KIND.JUNCTION, junctionId };
}
export function nodeKey(node) {
  if (!node) return '';
  return node.kind === NODE_KIND.JUNCTION ? `J:${node.junctionId}` : `T:${node.equipmentId}:${node.terminalName}`;
}

// ── 回路の別（端子の属性。主回路か制御回路か） ──────────────
export const CIRCUIT = Object.freeze({ MAIN: 'main', CONTROL: 'control' });

// ── 接続レコード（節点と節点のつながり1つ分） ────────────────
export function createConnectionRecord({ a, b, circuit = CIRCUIT.MAIN, branchKey = '' }) {
  return { connectionId: segmentId(a, b, branchKey), a, b, circuit };
}

/**
 * 区間ID。両端の節点（順序によらない）＋枝キー。
 * 枝キーは「同じ2つの節点を結ぶ経路が2本以上あるとき」だけ効く区別子（ループ対策）。
 * 二条ケーブルは別の枝ではなく、1つの区間の parallelCount で表す。
 */
export function segmentId(a, b, branchKey = '') {
  const [x, y] = [nodeKey(a), nodeKey(b)].sort();
  return `SEG:${x}|${y}${branchKey ? `#${branchKey}` : ''}`;
}

// ── インピーダンス区間 ──────────────────────────────
// input: 'manual'     … R,X を直接入れる
//        'perLength'  … R_per_km,X_per_km × length_m で求める
// lengthSource: 'manual' … length_m を手入力
//               'route'  … 配置図で描いたケーブル経路の長さを使う（routeRef の経路長）
export const IMPEDANCE_INPUT = Object.freeze({ MANUAL: 'manual', PER_LENGTH: 'perLength' });
export const LENGTH_SOURCE = Object.freeze({ MANUAL: 'manual', ROUTE: 'route' });

export function createImpedanceSegment({
  segmentId: id, ends, input = IMPEDANCE_INPUT.MANUAL,
  R = null, X = null, R_per_km = null, X_per_km = null,
  length_m = null, lengthSource = LENGTH_SOURCE.MANUAL,
  parallelCount = 1, routeRef = null, circuit = CIRCUIT.MAIN,
}) {
  return { segmentId: id, ends, input, R, X, R_per_km, X_per_km, length_m, lengthSource, parallelCount, routeRef, circuit };
}

/** 区間の実効インピーダンス（Ω）。条数で割る。求められないときは null */
export function resolveImpedance(segment) {
  if (!segment) return null;
  const n = Math.max(1, Number(segment.parallelCount) || 1);
  let r, x;
  if (segment.input === IMPEDANCE_INPUT.PER_LENGTH) {
    const km = Number(segment.length_m);
    if (!Number.isFinite(km)) return null;
    r = Number(segment.R_per_km) * km / 1000;
    x = Number(segment.X_per_km) * km / 1000;
  } else {
    r = Number(segment.R); x = Number(segment.X);
  }
  if (!Number.isFinite(r) || !Number.isFinite(x)) return null;
  return { R: r / n, X: x / n };
}
