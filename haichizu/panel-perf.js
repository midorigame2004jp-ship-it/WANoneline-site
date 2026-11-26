// 配電盤描画のコスト計測（重さの原因を数字で切り分けるための計測器）
//
// 使い方: コンソールで  __PANEL_PERF__.report()   と打つと内訳が表で出る。
//         __PANEL_PERF__.reset()  で計測をやり直す。
// 計測を止めたいときは __PANEL_PERF__.off() （以後オーバーヘッドゼロ）。
//
// 集計内容:
//  ・1フレームあたりの盤描画合計時間（移動中／静止後で分けて集計）
//  ・盤ごとの所要時間（どの盤が重いか）
//  ・その盤の中身の規模（仕切り・アイコン・配線・扉の数）→ 何が効いているかの手掛かり
(function () {
  if (window.__PANEL_PERF__) return;

  var frames = [];        // {ms, panels, moving, cap}
  var byPanel = new Map(); // name → {n, total, max, size}
  var MAX_SAMPLES = 600;

  function sizeOf(pd) {
    if (!pd) return null;
    return {
      仕切り: (pd.partitions || []).length,
      アイコン: (pd.placedIcons || []).length,
      配線: (pd.cables || []).length,
      扉: (pd.doors || []).length,
    };
  }

  var api = {
    enabled: true,
    addFrame: function (ms, panels, moving, cap) {
      if (!api.enabled) return;
      if (frames.length >= MAX_SAMPLES) frames.shift();
      frames.push({ ms: ms, panels: panels, moving: moving, cap: cap });
    },
    addPanel: function (name, ms, pd) {
      if (!api.enabled) return;
      var e = byPanel.get(name);
      if (!e) { e = { n: 0, total: 0, max: 0, size: null }; byPanel.set(name, e); }
      e.n++; e.total += ms; if (ms > e.max) e.max = ms;
      if (!e.size) e.size = sizeOf(pd);
    },
    reset: function () { frames = []; byPanel = new Map(); console.log('[PANEL-PERF] 計測をリセットしました'); },
    off: function () { api.enabled = false; console.log('[PANEL-PERF] 計測を停止しました'); },
    on: function () { api.enabled = true; console.log('[PANEL-PERF] 計測を再開しました'); },
    report: function () {
      if (!frames.length) { console.log('[PANEL-PERF] まだ描画が記録されていません。3次元図でカメラを動かしてから再度実行してください。'); return; }
      var mk = function (list, label) {
        if (!list.length) return null;
        var ms = list.map(function (f) { return f.ms; }).sort(function (a, b) { return a - b; });
        var sum = ms.reduce(function (a, b) { return a + b; }, 0);
        return {
          区分: label,
          回数: ms.length,
          平均ms: +(sum / ms.length).toFixed(1),
          中央値ms: +ms[Math.floor(ms.length / 2)].toFixed(1),
          最悪ms: +ms[ms.length - 1].toFixed(1),
          '16ms超の割合%': +(100 * ms.filter(function (v) { return v > 16; }).length / ms.length).toFixed(0),
        };
      };
      var rows = [
        mk(frames.filter(function (f) { return f.moving; }), '移動中（低品質）'),
        mk(frames.filter(function (f) { return !f.moving; }), '静止後（フル品質）'),
        mk(frames, '全体'),
      ].filter(Boolean);
      console.log('[PANEL-PERF] フレームあたりの盤描画時間');
      console.table(rows);

      var prows = [];
      byPanel.forEach(function (e, name) {
        prows.push({
          盤: name, 描画回数: e.n,
          平均ms: +(e.total / e.n).toFixed(1), 最悪ms: +e.max.toFixed(1),
          仕切り: e.size ? e.size.仕切り : '-',
          アイコン: e.size ? e.size.アイコン : '-',
          配線: e.size ? e.size.配線 : '-',
          扉: e.size ? e.size.扉 : '-',
        });
      });
      prows.sort(function (a, b) { return b.平均ms - a.平均ms; });
      console.log('[PANEL-PERF] 盤ごとの内訳（平均が大きい順）');
      console.table(prows);
      return { frames: rows, panels: prows };
    },
  };

  window.__PANEL_PERF__ = api;
  console.log('[PANEL-PERF] 計測を開始しました。カメラを動かした後 __PANEL_PERF__.report() で内訳を表示します。');

  // ── どの requestAnimationFrame が重いのかを特定する計測 ──
  // 盤の描画が軽いのに「rAF handler took 73ms」が出る場合、犯人は別のrAFにいる。
  // 登録元をスタックから記録し、所要時間とあわせて集計する。
  // 使い方: __RAF_PERF__.report() / .off()
  (function () {
    var stats = new Map();   // 登録元の要約 → {n, total, max, sample}
    var enabled = true;
    var orig = window.requestAnimationFrame.bind(window);

    function originOf() {
      // 登録元のスタック（このファイル自身とブラウザ内部行は除く）
      var lines = String(new Error().stack || '').split('\n').slice(2);
      for (var i = 0; i < lines.length; i++) {
        var s = lines[i].trim();
        if (!s || s.indexOf('panel-perf.js') !== -1) continue;
        return s.replace(/^at\s+/, '').slice(0, 120);
      }
      return '(不明)';
    }

    window.requestAnimationFrame = function (cb) {
      if (!enabled) return orig(cb);
      var where = originOf();
      return orig(function (t) {
        var s = performance.now();
        try { return cb(t); }
        finally {
          var d = performance.now() - s;
          var e = stats.get(where);
          if (!e) { e = { n: 0, total: 0, max: 0 }; stats.set(where, e); }
          e.n++; e.total += d; if (d > e.max) e.max = d;
        }
      });
    };

    window.__RAF_PERF__ = {
      reset: function () { stats = new Map(); console.log('[RAF-PERF] リセットしました'); },
      off: function () { enabled = false; console.log('[RAF-PERF] 停止しました'); },
      report: function () {
        var rows = [];
        stats.forEach(function (e, where) {
          rows.push({
            登録元: where, 実行回数: e.n,
            平均ms: +(e.total / e.n).toFixed(1),
            最悪ms: +e.max.toFixed(1),
            合計ms: +e.total.toFixed(0),
          });
        });
        rows.sort(function (a, b) { return b.合計ms - a.合計ms; });
        if (!rows.length) { console.log('[RAF-PERF] まだ記録がありません。'); return; }
        console.log('[RAF-PERF] requestAnimationFrame の登録元別コスト（合計が大きい順）');
        console.table(rows);
        return rows;
      },
    };
    console.log('[RAF-PERF] 計測を開始しました。重い操作の後 __RAF_PERF__.report() を実行してください。');
  })();
})();
