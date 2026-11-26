/* interlockOpLog.js — インターロックの窓の操作ログ（2026-10-08 ユーザー要望・Codex監査済み）
 *
 * ■ 目的
 *   不具合を報告するときに手順を手で説明しなくて済むようにする。
 *   異常が出た時点で **コンソールに `ilLog()`** と打てば、そこまでに何をしたかが番号付きで出る。
 *   出た文をそのまま貼れば説明になる。
 *
 * ■ 作り（観測専用・ここは何も書き換えない）
 *   ・window の capture 段の mousedown / keydown（Ctrl+Z・Ctrl+Y）/ drop で「前の状態」を控える
 *   ・そのあと **状態が落ち着くまで待ってから**「後の状態」と比べる
 *     （300ms おきに読んで2回続けて同じなら締める。最長 20秒＝QM法の計算も拾う）
 *   ・差が無い操作（ただのクリック・カーソル移動）は数えない
 *   ・状態は読むだけの口 `window.__ilOpSnapshot()`（無ければ図のDOM）から取る
 *   ・発生元が `ilNote('…')` で事実を書き添えられる（判定はしない・ただのメモ）
 *   ・ログの失敗で操作を止めないよう、入口はすべて try/catch で握る
 *
 * ■ 使い方（ユーザー）
 *   F12 → Console →  ilLog()      … 今までの全操作を出す（コピーして貼る用）
 *                     ilLog(true)  … 最後の操作の「前後の状態」も細かく出す
 *                     ilLogClear() … 数え直す
 *   ★インターロックの窓は iframe なので、**単線結線図の画面のコンソールで `ilLog()`** と打てば
 *     中の窓へ聞きに行って同じものを出す（親側の口は jsx/src/js/interlock/interlockChannel.js）。
 *   止めたいとき: window.__IL_OP_LOG = false
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__ilOpLogInstalled) return;
  window.__ilOpLogInstalled = true;

  var TAG = '[操作ログ]';
  var MAX = 400;                 /* 行がたまりすぎないように */
  var SETTLE_MS = 300;           /* 状態を読み直す間隔 */
  var SETTLE_MAX = 20000;        /* これ以上は待たない（QM法の計算を拾える長さ） */
  var _no = 0;                   /* 数えた操作の数（変化があったものだけ） */
  var _seq = 0;                  /* 控えの通し番号 */
  var _pending = null;           /* { seq, before, きっかけ, closed } */
  var _notes = [];               /* この操作中に発生元が書き添えた文 */
  var _lines = [];               /* まとめて出す用 */
  var _last = null;              /* 最後の { before, after } */

  function _enabled() { return window.__IL_OP_LOG !== false; }

  /* ── 今の状態を読むだけで控える ───────────────────────────────── */
  function _snap() {
    var s = { 出どころ: '図から' };
    try {
      if (typeof window.__ilOpSnapshot === 'function') {
        var o = window.__ilOpSnapshot();
        if (o && typeof o === 'object') { s = o; s.出どころ = '窓の口から'; }
      }
    } catch (e) { /* 口が落ちても観測を止めない */ }

    /* 回路エディタの中身（既にある読むだけの口） */
    try {
      if (typeof window.__edNetDump === 'function') {
        var d = window.__edNetDump() || {};
        var es = d.edges || [];
        var cs = [];
        for (var i = 0; i < es.length; i++) {
          var e = es[i];
          if (!e || e.kind !== 'contact') continue;
          cs.push({ id: e.id, 型: e.inverted ? 'b' : 'a', 桁: (e.varIdx == null ? -1 : e.varIdx) });
        }
        s.回路 = { 接点: cs, 線数: es.length - cs.length, 節点数: (d.nodes || []).length };
        /* ★母線と投入リレーの位置（保存される値）。手で動かすと既定（S x=40 / B x=740）と変わる。 */
        if (d.bus) s.回路.母線 = { S: Math.round(d.bus.s && d.bus.s.x), B: Math.round(d.bus.b && d.bus.b.x) };
        if (d.coil) s.回路.投 = Math.round(d.coil.x) + ',' + Math.round(d.coil.y);
      } else s.回路 = null;
    } catch (e2) { s.回路 = null; }

    /* 線図のステップ数は図そのものから数える（口が無くても取れる） */
    try { s.線図 = document.querySelectorAll('svg[data-il-trace-step]').length; } catch (e3) { s.線図 = -1; }
    /* 開いている窓（見出し＋**大きさ**）。
       ★大きさを控えないと「窓のサイズを変えた」が1行も記録されない（2026-10-08 に気付いた）。
       ★親へ送っている float-rects でなく、**その瞬間の DOM** を読む（通知は「変わったとき」だけなので
         ログを取る時点の真実とは限らない＝Codex 条件）。 */
    try {
      var ws = document.querySelectorAll('[data-il-win]');
      var ts = [];
      for (var k = 0; k < ws.length; k++) {
        var wr = ws[k].getBoundingClientRect();
        var zz = ws[k].querySelector('[data-il-body-zoom]');
        ts.push({ 題: ws[k].getAttribute('data-il-window-title') || '',
                  w: Math.round(wr.width), h: Math.round(wr.height),
                  x: Math.round(wr.left), y: Math.round(wr.top),
                  倍率: zz ? Number(zz.getAttribute('data-il-body-zoom')) : 1 });
      }
      s.窓 = ts;
    } catch (e4) { s.窓 = null; }
    return s;
  }

  /* ── 接点の見え方を1つの文字にする（並べて差を見るため）────────── */
  function _contactsOf(s) {
    var r = [];
    try {
      var cs = (s && s.回路 && s.回路.接点) || [];
      var vn = (s && s.変数) || [];
      for (var i = 0; i < cs.length; i++) {
        var nm = (cs[i].桁 >= 0 && vn[cs[i].桁]) ? vn[cs[i].桁] : '?';
        r.push(nm + (cs[i].型 === 'b' ? "'" : ''));
      }
    } catch (e) {}
    return r;
  }

  function _key(s) { try { return JSON.stringify(s); } catch (e) { return String(s); } }
  function _eq(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } }
  function _join(a) { return (a && a.length) ? a.join('・') : 'なし'; }

  /* ── 前後の差を日本語にする（判定はしない・並べるだけ）───────────── */
  function _describe(b, a) {
    var out = [];
    if (!b || !a) return out;

    if (b.投入対象 !== a.投入対象)
      out.push('投入対象を ' + (a.投入対象 || '未設定') + ' にした（前は ' + (b.投入対象 || '未設定') + '）');

    if (!_eq(b.束ね, a.束ね)) {
      var bb = b.束ね || [], aa = a.束ね || [];
      var n = Math.max(bb.length, aa.length), 足 = [], 外 = [], 替 = [];
      for (var i = 0; i < n; i++) {
        var x = bb[i] || null, y = aa[i] || null;
        if (x === y) continue;
        var vn = (a.変数 && a.変数[i]) || ('変数' + i);
        if (!x && y) 足.push(y + '（' + vn + '）');
        else if (x && !y) 外.push(x + '（' + vn + '）');
        else 替.push(x + ' → ' + y + '（' + vn + '）');
      }
      if (足.length) out.push('機器を入力に束ねた: ' + 足.join('・'));
      if (外.length) out.push('★入力から外れた: ' + 外.join('・'));
      if (替.length) out.push('入力が入れ替わった: ' + 替.join('・'));
      if (!足.length && !外.length && !替.length) out.push('束ねの並びが変わった');
    }

    if (b.変数 && a.変数 && b.変数.length !== a.変数.length)
      out.push('変数の数が ' + b.変数.length + ' → ' + a.変数.length + ' になった');

    var bc = _contactsOf(b), ac = _contactsOf(a);
    if (!_eq(bc, ac)) {
      if (bc.length < ac.length) out.push('回路に接点が増えた: ' + _join(bc) + ' → ' + _join(ac));
      else if (bc.length > ac.length) out.push('★回路の接点が減った: ' + _join(bc) + ' → ' + _join(ac));
      else out.push('回路の接点が変わった: ' + _join(bc) + ' → ' + _join(ac));
    }
    var bl = (b.回路 && b.回路.線数) || 0, al = (a.回路 && a.回路.線数) || 0;
    if (bl !== al) out.push('回路の線が ' + bl + ' → ' + al + ' 本になった');
    if (!_eq(b.回路 && b.回路.母線, a.回路 && a.回路.母線))
      out.push('★母線が動いた: ' + JSON.stringify(b.回路 && b.回路.母線) + ' → ' + JSON.stringify(a.回路 && a.回路.母線));
    if ((b.回路 && b.回路.投) !== (a.回路 && a.回路.投))
      out.push('★投入リレーが動いた: ' + (b.回路 && b.回路.投) + ' → ' + (a.回路 && a.回路.投));

    if (b.表の行数 !== a.表の行数)
      out.push('真理値表が ' + (b.表の行数 || 0) + ' → ' + (a.表の行数 || 0) + ' 行になった');
    else if (b.表の可 !== a.表の可)
      out.push('真理値表の「可」が ' + (b.表の可 || 0) + ' → ' + (a.表の可 || 0) + ' 行になった');

    if (b.線図 !== a.線図 && b.線図 >= 0 && a.線図 >= 0)
      out.push('線図が ' + b.線図 + ' → ' + a.線図 + ' ステップになった');

    if (!_eq(b.窓, a.窓)) {
      var bw = b.窓 || [], aw = a.窓 || [];
      var 題B = bw.map(function (t) { return t && t.題; }), 題A = aw.map(function (t) { return t && t.題; });
      var 開 = 題A.filter(function (t) { return 題B.indexOf(t) < 0; });
      var 閉 = 題B.filter(function (t) { return 題A.indexOf(t) < 0; });
      if (開.length) out.push('窓を開いた: ' + 開.join('・'));
      if (閉.length) out.push('窓を閉じた: ' + 閉.join('・'));
      /* ★大きさ・位置・倍率が変わった窓を名指しで出す */
      aw.forEach(function (x) {
        var y = bw.find(function (q) { return q && x && q.題 === x.題; });
        if (!y) return;
        if (y.w !== x.w || y.h !== x.h)
          out.push(x.題 + ' の窓の大きさを変えた（' + y.w + 'x' + y.h + ' → ' + x.w + 'x' + x.h + '）');
        else if (y.x !== x.x || y.y !== x.y)
          out.push(x.題 + ' の窓を動かした（' + y.x + ',' + y.y + ' → ' + x.x + ',' + x.y + '）');
        if (y.倍率 !== x.倍率)
          out.push(x.題 + ' の中身の倍率を変えた（' + y.倍率 + ' → ' + x.倍率 + '）');
      });
    }
    return out;
  }

  /* ── 締め（状態が落ち着いてから後の状態を読む）─────────────────────
     ★一定時間で締めると、重い計算（QM法）や窓の作り直しに間に合わず差を取り逃す（実測）。
       300ms おきに読み、2回続けて同じなら締める。最長 SETTLE_MAX。 */
  function _afterSettled(p, fn) {
    var t0 = Date.now(), prev = null;
    var tick = function () {
      if (p.closed) return;
      var now;
      try { now = _key(_snap()); } catch (e) { now = String(Date.now()); }
      if (prev !== null && now === prev) { fn(); return; }
      if (Date.now() - t0 > SETTLE_MAX) { fn(); return; }
      prev = now;
      setTimeout(tick, SETTLE_MS);
    };
    setTimeout(tick, 120);        /* まず React が描き終わるのを待つ */
  }

  function _close(p) {
    if (!p || p.closed) return;
    p.closed = true;
    var after = _snap();
    var diff = _describe(p.before, after);
    var notes = _notes.slice(); _notes.length = 0;
    _last = { before: p.before, after: after, きっかけ: p.きっかけ };
    if (!diff.length && !notes.length) return;    /* 変化が無ければ数えない */
    _no++;
    var head = _no + '回目: ' + (p.きっかけ || '操作') + ' → ' + (diff.length ? diff.join(' ／ ') : '（記録だけ）');
    var line = head + (notes.length ? ('\n      ※ ' + notes.join('\n      ※ ')) : '');
    _lines.push(line);
    while (_lines.length > MAX) _lines.shift();
    try { console.log(TAG + ' ' + line); } catch (e) {}
  }

  function _open(きっかけ) {
    if (!_enabled()) return;
    try {
      if (_pending) _close(_pending);          /* 前の操作が締まっていなければここで締める */
      _seq++;
      var p = { seq: _seq, before: _snap(), きっかけ: きっかけ, closed: false };
      _pending = p;
      _afterSettled(p, function () { _close(p); if (_pending === p) _pending = null; });
    } catch (e) {}
  }

  /* ── 拾う入口（capture 段・ここでしか見ない）───────────────────── */
  function _where(t) {
    try {
      var w = t && t.closest && t.closest('[data-il-window-title]');
      if (w) return w.getAttribute('data-il-window-title');
    } catch (e) {}
    return null;
  }
  function _label(t) {
    try {
      var b = t && t.closest && t.closest('button');
      if (b && b.textContent) return '「' + b.textContent.trim().slice(0, 24) + '」を押した';
      if (t && t.closest && t.closest('select')) return 'プルダウンを操作した';
      if (t && t.closest && t.closest('tr')) return '表の行を押した';
      if (t && t.closest && t.closest('svg')) return '図の上を押した';
    } catch (e) {}
    return null;
  }

  window.addEventListener('mousedown', function (ev) {
    var t = ev && ev.target;
    var w = _where(t), l = _label(t);
    _open((w ? ('［' + w + '］') : '') + (l || 'マウス操作'));
  }, true);

  window.addEventListener('keydown', function (ev) {
    if (!ev) return;
    var k = (ev.key || '').toLowerCase();
    /* Shift も書く（2026-10-19: Ctrl+Shift+Z はやり直しなのに「Ctrl+Z」と記録されていた） */
    if ((ev.ctrlKey || ev.metaKey) && (k === 'z' || k === 'y')) _open('取り消し／やり直し（Ctrl+' + (ev.shiftKey ? 'Shift+' : '') + k.toUpperCase() + '）');
  }, true);

  /* 単線結線図の窓からのドロップ（別の窓なので mousedown が来ない）*/
  window.addEventListener('drop', function (ev) {
    var w = _where(ev && ev.target);
    _open((w ? ('［' + w + '］') : '') + '単線結線図から機器を落とした');
  }, true);
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    /* 親（単線結線図）から「ログを出せ」と言われたら返す */
    try {
      if (d.ilOpLog === 'ask' && ev.source && ev.source.postMessage) {
        ev.source.postMessage({ ilOpLog: 'answer', text: window.ilLog(false, true) }, '*');
        return;
      }
      if (d.ilOpLog === 'clear') { window.ilLogClear(); return; }
    } catch (e) {}
    /* ★単線結線図（親）からの便りを1つの操作として数える。
       ここが**いちばん大事な入口**。単線結線図から機器を運ぶ操作は、押すのも離すのも親の画面なので
       この窓には mousedown も drop も来ない。便りだけが届く（実測で分かった）。
       合い言葉は interlockChannel.js の規約（protocol: 'wan-il'）。 */
    try {
      if (d.protocol === 'wan-il' && typeof d.kind === 'string') {
        if (d.kind === 'binding') {
          var _n = (d.bind && d.bind.length) || 0;
          var _a = d.assign || null;
          /* ★運ぶ・差し替えでない束ね（intent='sync'・assign/replace なし）は「運んだ」と書かない（2026-10-18・advisor 監査済み）。
             親は名前の変更・削除の知らせ・役割の変更などのたびに束ねを送り直すので、何も運んでいないのに
             「運んだ」が並んでいた（実機ログで6行連続）。見出しには**便りが持っている事実だけ**を書く
             （原因は推測で書かない。本文の差分が理由を補う）。 */
          var _運ばない = (d.intent || 'sync') === 'sync' && !_a && !d.replace;
          _open((_運ばない ? '単線結線図から束ねを受け取った（運ぶ・差し替えではない）' : '単線結線図から機器を運んだ')
                + (_a && _a.intoCircuit ? '（落とし先＝回路）' : '')
                + (_a && _a.contactId ? '（落とし先＝接点）' : '')
                + (d.targetId ? '（投入対象あり）' : '')
                + '／入力 ' + _n + ' 個');
        } else if (d.kind === 'set-target' || d.kind === 'set-role') {
          _open('単線結線図の窓で役割を変えた（' + d.kind + '）');
        } else if (d.kind === 'show-pane') {
          _open('閉じた窓を戻した');
        }
        /* faults（地絡の走査の結果）・zones・ready は観測の便りなので数えない */
      }
    } catch (e2) {}
  }, true);

  /* ── 発生元から事実を書き添える口（判定はしない）───────────────── */
  window.ilNote = function (text) {
    if (!_enabled() || !text) return;
    try { _notes.push(String(text)); } catch (e) {}
  };

  /* ── まとめて出す（ユーザーがコピーして貼る用）───────────────── */
  window.ilLog = function (詳しく, 黙って) {
    var s = '===== インターロックの操作ログ（' + _lines.length + '件）=====\n'
          + (_lines.length ? _lines.join('\n') : '（まだ数えた操作がありません）')
          + '\n===== ここまで =====';
    if (!黙って) { try { console.log(s); } catch (e) {} }
    if (詳しく && _last) {
      try {
        console.log('--- 最後の操作の前後 ---');
        console.log('前:', _last.before);
        console.log('後:', _last.after);
      } catch (e) {}
    }
    return s;
  };
  window.ilLogClear = function () { _no = 0; _lines.length = 0; _notes.length = 0; _last = null; return '数え直しました'; };
  window.__ilOpLines = function () { return _lines.slice(); };

  try { console.log(TAG + ' 動いています。異常が出たら コンソールに  ilLog()  と打ってください。'); } catch (e) {}
})();
