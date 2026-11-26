/* connectionJudgeCore.js
   ★**接続判定の唯一の持ち主**（2026-10-03 ユーザー指示「接続の判定を共通にする」）。
     単線結線図（jsx/src/js/utils/connectionJudge.js）も、インターロックの回路エディタも、
     **このファイルだけ**を読む。写し（コピー）は作らない。

   【なぜここに置くか】
     インターロックの画面は**単体でも開ける**（ファイルを直接ダブルクリックしても動く）約束になっている。
     素の `<script src="connectionJudgeCore.js">` で読むには **同じフォルダ**に無いといけないので、
     ここに置いて単線結線図の側（jsx）がこのファイルを読む形にした。
     ＝置き場所の都合であって、中身は「単線結線図の接続判定の規則」そのもの。

   【読み方】
     ・インターロック（素のHTML）… `<script src="connectionJudgeCore.js"></script>` → `window.WAN_CONNECTION_JUDGE`
     ・単線結線図（jsx）          … `connectionJudge.js` がこれを読んで、今までと同じ名前で配り直す
     どちらも**読めなければ止まる**（黙って自前の値に落ちない＝fail-closed）。

   【中身の由来】
     もとは jsx/src/js/utils/connectionJudge.js（16ファイル・30箇所に散っていた判定を集約したもの）。
     インターロック側は同じ値（4px・T字4px）を**写して**持っていたので、片方を直しても
     もう片方が直らなかった。この1ファイルに寄せて、写しを無くす。 */
(function (G) {
  'use strict';

  /* ── 閾値 ─────────────────────────────────────────────── */
  /** 端点どうし・端点とアイコンの接続点が「繋がっている」とみなす距離 (px) */
  var CONNECTION_THRESHOLD = 4;
  /** 線の途中（T字）に乗っているとみなす距離 (px)。端の近くは除く */
  var T_JUNCTION_THRESHOLD = 4;
  /** 旧・切断の距離 (px)。統一前は 4px で繋がり 10px で切れる（ヒステリシス）だった */
  var DISCONNECT_THRESHOLD = 10;
  /** 接続点を**見せる**距離 (px) — 見た目だけ。判定には使わない */
  var VISUAL_PROXIMITY_DISTANCE = 15;

  /**
   * 段階フラグ: 接続・切断を 4px の1境界に一本化するか。
   *
   * ★**既定OFF へ差し戻した**（2026-10-03 ユーザー報告「**衝突回避全部無効になってるじゃねぇか**」）。
   *   T字の端点デッドゾーンを 10px→4px にしたことで、**線の端から4〜10pxにある接触が新たに接続扱い**になり、
   *   つながりの集合（wireSet）が広がって**画面のほぼ全部の線に黄色枠が付いた**（実機画像で確認）。
   *   `true` で有効（境界の単体検査 `jsx/check-connect-threshold.mjs` はこれを立てて流す）。
   */
  function isUnifiedConnectThreshold() {
    return (typeof G !== 'undefined') && G.__CONNECT_THRESHOLD_UNIFIED === true;
  }
  /** いま使う「切れている」の閾値（統一時は接続と同じ 4px） */
  function cutLimit() {
    return isUnifiedConnectThreshold() ? CONNECTION_THRESHOLD : DISCONNECT_THRESHOLD;
  }

  /* ── 距離 ─────────────────────────────────────────────── */
  function pointDistance(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
  }

  /**
   * 距離が「繋がっている」側か。
   * ★境界の書き分けをなくすための述語（2026-10-03 裁定「4px以内か、4pxより離れているか」）。
   *   各所に `距離 < 4` と直書きされていて、確定の端子台帳（`<= 4`）と 4px ちょうどで食い違っていた。
   */
  function isWithinConnectDistance(distance) {
    if (!(distance >= 0)) return false;
    return isUnifiedConnectThreshold() ? distance <= CONNECTION_THRESHOLD : distance < CONNECTION_THRESHOLD;
  }

  /** 端点どうしが接続距離にあるか（4px ちょうどは**繋がっている**＝端子台帳と同じ） */
  function isEndpointNear(x1, y1, x2, y2) {
    return pointDistance(x1, y1, x2, y2) <= CONNECTION_THRESHOLD;
  }

  /**
   * 端点が切断距離まで離れたか。
   * ★統一時は「**4pxより離れている**」で切る（4px ちょうどは接続のまま）。
   *   `>=` にすると 4px 境界の接続が切れて、確定の端子台帳（4px以下で接続）と食い違う。
   */
  function isBeyondDisconnectThreshold(x1, y1, x2, y2) {
    var distance = pointDistance(x1, y1, x2, y2);
    return isUnifiedConnectThreshold() ? distance > CONNECTION_THRESHOLD : distance >= DISCONNECT_THRESHOLD;
  }

  /** ピクセルの余白を t 空間（0〜1）の余白に直す */
  function pixelToTMargin(wireLength, pixelMargin) {
    var m = (pixelMargin === undefined) ? T_JUNCTION_THRESHOLD : pixelMargin;
    return wireLength > 0 ? m / wireLength : 0.5;
  }

  /**
   * T字: 点が線分の**途中**に乗っているか。端の近く（4px）は除く＝そこは端点どうしで見る。
   * @returns {{hit:boolean, x:number, y:number, t:number, distance:number}}
   */
  function checkTJunction(px, py, lsx, lsy, lex, ley) {
    var ldx = lex - lsx, ldy = ley - lsy;
    var len = Math.sqrt(ldx * ldx + ldy * ldy);
    if (len < 1) return { hit: false, x: lsx, y: lsy, t: 0, distance: pointDistance(px, py, lsx, lsy) };

    var t = Math.max(0, Math.min(1, ((px - lsx) * ldx + (py - lsy) * ldy) / (len * len)));
    var cx = lsx + t * ldx, cy = lsy + t * ldy;
    var distance = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));

    var tMargin = T_JUNCTION_THRESHOLD / len;      /* 端点の不感帯（px基準） */
    /* ★境界（4pxちょうど）は接続に含める。確定の端子台帳が `<=` なので、ここを `<` にすると
       「台帳では繋がっているのに枠や分割の判定では繋がっていない」が 4px ちょうどで起きる。 */
    var withinBand = isUnifiedConnectThreshold()
      ? distance <= T_JUNCTION_THRESHOLD
      : distance < T_JUNCTION_THRESHOLD;
    var hit = withinBand && t > tMargin && t < (1 - tMargin);
    return { hit: hit, x: cx, y: cy, t: t, distance: distance };
  }

  /**
   * T字の切断判定（ドラッグ中用）。
   * ★統一時は距離も端点の不感帯も 4px（`checkTJunction` と同じ値）。
   *   従来は 10px だったので、**線の端から4〜10pxに乗る胴タップ**が
   *   「ドラッグ中は切れている・離すと繋がっている」になっていた。
   * ★短い線には「端の近くを除いた胴」が無い。長さ 8px（＝4px×2）以下は胴接続を持てないので明示的に非接続。
   */
  function isTJunctionStillConnected(px, py, lsx, lsy, lex, ley) {
    var ldx = lex - lsx, ldy = ley - lsy;
    var len = Math.sqrt(ldx * ldx + ldy * ldy);
    if (len < 1) return false;

    var limit = cutLimit();
    if (isUnifiedConnectThreshold() && len <= CONNECTION_THRESHOLD * 2) return false;

    var t = Math.max(0, Math.min(1, ((px - lsx) * ldx + (py - lsy) * ldy) / (len * len)));
    var tMargin = limit / len;
    if (t <= tMargin || t >= (1 - tMargin)) return false;

    var cx = lsx + t * ldx, cy = lsy + t * ldy;
    var distance = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    return isUnifiedConnectThreshold() ? distance <= limit : distance < limit;
  }

  G.WAN_CONNECTION_JUDGE = {
    CONNECTION_THRESHOLD: CONNECTION_THRESHOLD,
    T_JUNCTION_THRESHOLD: T_JUNCTION_THRESHOLD,
    DISCONNECT_THRESHOLD: DISCONNECT_THRESHOLD,
    VISUAL_PROXIMITY_DISTANCE: VISUAL_PROXIMITY_DISTANCE,
    isUnifiedConnectThreshold: isUnifiedConnectThreshold,
    isWithinConnectDistance: isWithinConnectDistance,
    pointDistance: pointDistance,
    isEndpointNear: isEndpointNear,
    isBeyondDisconnectThreshold: isBeyondDisconnectThreshold,
    pixelToTMargin: pixelToTMargin,
    checkTJunction: checkTJunction,
    isTJunctionStillConnected: isTJunctionStillConnected,
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
