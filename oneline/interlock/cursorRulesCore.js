/* cursorRulesCore.js
   ★**カーソルの規則と絵の唯一の持ち主**（2026-10-25 ユーザー指示「『接続点にカーソルがある』という if で考えたとき、
     単線結線図・接点回路にかかわらずその場所なら表示を変える、というように統合して違いが出ないようにしろ」・advisor 監査済み）。
     単線結線図（jsx/src/js/ui/cursorRules.js が配り直す）も、インターロックの回路を描く画面も、**このファイルだけ**を読む。

   【置き場所】connectionJudgeCore.js と同じ理由（インターロックの画面は単体で開ける＝素の <script src> で読める所）。
   【読み方】・インターロック … <script src="cursorRulesCore.js"> → window.WAN_CURSOR_RULES
             ・単線結線図   … jsx/src/js/ui/cursorRules.js が import して配り直す
             どちらも読めなければ止まる（自前の写しに落ちない）。

   【場面（scene）】カーソルの下にある物の「役割」。画面ごとの部品名ではなく役割で決める。
     'empty'  … 何も無い所
     'body'   … 部品の本体（線・機器・接点・投入リレー・母線）。canCopy=false なら Ctrl でも複製を出さない（複製できない物）
     'handle'   … 線の端の白丸（伸ばす）
     'terminal' … 機器・接点・投入リレーの接続点の白丸
     'drag'     … 本体・黄色丸を押して動かしている最中
     'stretch'  … 白丸・接続点から引いている最中
     'center' … 黄色丸（線の中央）＝枝ごと平行移動
   表は単線結線図の実測（2026-10-25）そのもの:
     empty  … default
     body   … default＋十字矢印の絵　／ Ctrl … default＋複製の絵
     handle … nwse-resize（斜めの両矢印）／ Ctrl … nwse-resize＋複製の絵
     terminal … default＋十字矢印の絵　／ Ctrl … default＋複製の絵（2026-11-03 裁定・白丸から Ctrl＋ドラッグ＝配線が生える合図）
     center … none＋移動の矢印の絵　　 ／ Ctrl … none＋移動の矢印＋複製の絵
     drag   … none＋十字矢印の絵（OS のカーソルは消す・2026-10-26）／ Ctrl … none＋複製の絵
   ★押したまま動かしている最中（引いている間の細い十字など）はこの表の外。

   【絵（ART）】要素の並び（tag と属性）。画面ごとに自分の作り方で展開する（SVG の文字列を innerHTML で挿さない＝経路を1本に）。
     原点＝カーソルの先（押した点）。画面の px で 1:1 に描く。 */
(function (G) {
  'use strict';

  var SIZE = 9, AS = 3, LE = SIZE - AS;
  var ARROWS = [
    'M 0,-' + SIZE + ' L -' + AS + ',-' + LE + ' L ' + AS + ',-' + LE + ' Z',
    'M 0,' + SIZE + ' L -' + AS + ',' + LE + ' L ' + AS + ',' + LE + ' Z',
    'M -' + SIZE + ',0 L -' + LE + ',-' + AS + ' L -' + LE + ',' + AS + ' Z',
    'M ' + SIZE + ',0 L ' + LE + ',-' + AS + ' L ' + LE + ',' + AS + ' Z',
  ];
  var POINTER = 'M 0,0 L 0,14 L 3.7,9 L 9.9,9.9 Z';

  var ART = {
    /* 十字矢印（白い縁・黒い線と矢じり） */
    crosshair: [].concat(
      ARROWS.map(function (d) { return { tag: 'path', attrs: { d: d, fill: 'white', stroke: 'white', 'stroke-width': '2' } }; }),
      [
        { tag: 'line', attrs: { x1: '0', y1: '-' + LE, x2: '0', y2: String(LE), stroke: 'white', 'stroke-width': '4' } },
        { tag: 'line', attrs: { x1: '-' + LE, y1: '0', x2: String(LE), y2: '0', stroke: 'white', 'stroke-width': '4' } },
        { tag: 'line', attrs: { x1: '0', y1: '-' + LE, x2: '0', y2: String(LE), stroke: 'black', 'stroke-width': '1.5' } },
        { tag: 'line', attrs: { x1: '-' + LE, y1: '0', x2: String(LE), y2: '0', stroke: 'black', 'stroke-width': '1.5' } },
      ],
      ARROWS.map(function (d) { return { tag: 'path', attrs: { d: d, fill: 'black' } }; })
    ),
    /* 複製（普通の矢印＋右上に点線の四角とミニ十字＝Excel のオートシェイプと同じ） */
    copy: [
      { tag: 'path', attrs: { d: POINTER, fill: 'white', stroke: 'black', 'stroke-width': '1', 'stroke-linejoin': 'miter' } },
      { tag: 'rect', attrs: { x: '10', y: '1', width: '11', height: '7', fill: 'white', stroke: 'black', 'stroke-width': '1', 'stroke-dasharray': '1,1' } },
      { tag: 'line', attrs: { x1: '18', y1: '-7', x2: '18', y2: '-1', stroke: 'black', 'stroke-width': '1.5' } },
      { tag: 'line', attrs: { x1: '15', y1: '-4', x2: '21', y2: '-4', stroke: 'black', 'stroke-width': '1.5' } },
    ],
    /* 移動（黄色丸の上・OS のカーソルを消して描く普通の矢印） */
    move: [
      { tag: 'path', attrs: { d: POINTER, fill: 'white', stroke: 'black', 'stroke-width': '1', 'stroke-linejoin': 'miter' } },
    ],
    /* 細い十字（白丸から引いている間。表の外だが絵はここに置く） */
    simple: [
      { tag: 'line', attrs: { x1: '0', y1: '-10', x2: '0', y2: '10', stroke: 'black', 'stroke-width': '1.5' } },
      { tag: 'line', attrs: { x1: '-10', y1: '0', x2: '10', y2: '0', stroke: 'black', 'stroke-width': '1.5' } },
    ],
  };

  /** 場面 → { css, overlays:['crosshair'|'copy'|'move'|'simple', ...] }。知らない場面は 'empty' と同じ（fail-open）
      ★2026-10-25 ユーザー裁定: 斜めの両矢印は線の端だけ（線の端＋Ctrl＝複製の絵だけ）。機器の接続点は黒十字矢印（Ctrl は 2026-11-03 裁定で複製の絵に変更）。
        動かしている最中は黒十字矢印だけ（選択の丸は離した後に出す＝Excel と同じ）。 */
  function cursorFor(scene, opts) {
    var ctrl = !!(opts && opts.ctrl);
    var canCopy = !(opts && opts.canCopy === false);
    if (scene === 'body') return { css: 'default', overlays: (ctrl && canCopy) ? ['copy'] : ['crosshair'] };
    if (scene === 'handle') return ctrl ? { css: 'default', overlays: ['copy'] } : { css: 'nwse-resize', overlays: [] };
    /* ★2026-11-03 ユーザー裁定「選択したときに出る白丸上で Ctrl を押したら点線四角と右上十字。何のアイコンであれ
         Ctrl＋ドラッグで Wire が新しく生成される結果が同じなのだから、前段の表示も同じにしろ」＝線の端の白丸（handle）と同じ。
         canCopy は見ない（端子はどの部品でも配線を生やす口）。旗 __CURSOR_TERMINAL_CTRL_COPY=false で従来（Ctrl でも十字） */
    if (scene === 'terminal') {
      var tCopy = ctrl && !(typeof window !== 'undefined' && window.__CURSOR_TERMINAL_CTRL_COPY === false);
      return { css: 'default', overlays: tCopy ? ['copy'] : ['crosshair'] };
    }
    if (scene === 'center') return { css: 'none', overlays: ctrl ? ['move', 'copy'] : ['move'] };
    /* 押したまま動かしている最中（本体・黄色丸・凡例から運んでいる最中）。Ctrl＝複製しながら運ぶ。
       ★OS のカーソルは消す＝黒十字矢印だけ（2026-10-26 ユーザー指摘「カーソルと黒十字矢印が出るが」。
         2026-10-25 の裁定「動かしている間は黒十字矢印が出るのみ」の取りこぼし。複製の絵は自前の矢印を持つので同じく消す）。
         旗 __CURSOR_DRAG_HIDES_OS=false で従来（OS の矢印も出す） */
    if (scene === 'drag') {
      var hide = !(typeof window !== 'undefined' && window.__CURSOR_DRAG_HIDES_OS === false);
      return { css: hide ? 'none' : 'default', overlays: (ctrl && canCopy) ? ['copy'] : ['crosshair'] };
    }
    /* 白丸・接続点から引いている最中（線を伸ばす・生やす）＝細い十字だけ */
    if (scene === 'stretch') return { css: 'none', overlays: ['simple'] };
    return { css: 'default', overlays: [] };
  }

  G.WAN_CURSOR_RULES = { SCENES: ['empty', 'body', 'handle', 'terminal', 'center', 'drag', 'stretch'], ART: ART, cursorFor: cursorFor };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
