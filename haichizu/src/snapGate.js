// ================================================================
// 吸い付きの一時解除ゲート（唯一の実装）
// ================================================================
// 【役割】「いま吸い付きを止めるべきか」を1箇所で決める。
//   各吸い付き処理は入口で snapSuppressed() を1行見るだけでよい。
//   判定の条件（既定は Alt 押下中）を変えるときも、ここだけを直せば全部に効く。
//
// 【なぜキーだけで判定しないか】keydown/keyup だけを見ると取りこぼす:
//   ・Windows では Alt がメニューバーへ取られ、keyup が来ないことがある
//   ・ドラッグ中に別ウィンドウへフォーカスが移ると押しっぱなし判定が残る
//   ・キャンバスにフォーカスが無いと keydown 自体が来ない
//   マウス/ポインタイベントは **altKey を常に持っている**ので、そちらを主にする。
//   キーイベントは「マウスを動かさずに Alt を押した瞬間」を拾う補助として併用する。
//
// 【ドキュメントごとに独立】配電盤エディタは iframe（別ドキュメント）なので、
//   そちらでもこのファイルを読み込む。状態はそのドキュメント自身のイベントで決まる。

let _snapSuppressed = false;
let _snapGateBound = false;

// 押されているかを1つの式で決める。ここが唯一の判定
function _snapGateFromEvent(e) {
  if (!e) return;
  _snapSuppressed = !!e.altKey;
}

// 【使い方】アプリの起動時に1回呼ぶ。2回目以降は何もしない
function snapGateInit(doc) {
  if (_snapGateBound) return;
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return;
  _snapGateBound = true;
  // capture で拾う。途中で stopPropagation されても状態は追える
  const opt = { capture: true, passive: true };
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'wheel']) {
    d.addEventListener(t, _snapGateFromEvent, opt);
  }
  // マウスを動かさずに Alt を押した／離した瞬間を拾う補助
  d.addEventListener('keydown', _snapGateFromEvent, opt);
  d.addEventListener('keyup', _snapGateFromEvent, opt);
  // フォーカスを失ったら必ず解除する（押しっぱなし判定を残さない）
  const w = d.defaultView || (typeof window !== 'undefined' ? window : null);
  if (w) {
    w.addEventListener('blur', () => { _snapSuppressed = false; });
    // ウィンドウ外で離された Alt を取りこぼさない
    w.addEventListener('focus', () => { _snapSuppressed = false; });
  }
}

// 【各吸い付きの入口はこれ1行を見る】true なら吸い付かせない
function snapSuppressed() { return _snapSuppressed; }

// 【イベントを持っている場所ではこちらを使う】
//   ハンドラの中など「そのイベントの altKey」が確実に分かる場所では、
//   グローバル状態より e.altKey を優先したほうが取りこぼしが無い。
function snapSuppressedFor(e) {
  if (e && typeof e.altKey === 'boolean') return e.altKey;
  return _snapSuppressed;
}

// 【許容量を1行で無効化する】吸い付き判定が「距離 < 許容量」の形で
//   関数になっていない場所（App.jsx の SNAP_T など）はこれで包む。
//   解除中は -1 を返すので、どんな距離でも条件が成立せず吸い付かない。
function snapTol(tol) { return _snapSuppressed ? -1 : tol; }

// 【自動で張る】読み込まれた時点でそのドキュメントに監視を張る。
//   呼び出し側に「初期化を書き忘れる」余地を残さないため、ここで完結させる。
//   入口HTMLの読み込みリストにこのファイルを足すだけで全部の吸い付きに効く。
if (typeof document !== 'undefined') snapGateInit(document);

// 診断用。実機で「今どう判定されているか」を見る
if (typeof window !== 'undefined') {
  window.__snapGate = () => ({ 吸い付き解除中: _snapSuppressed, 監視を張った: _snapGateBound });
}
