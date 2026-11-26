// SVG属性NaN診断プローブ（発生源特定用）
//
// 方式: React.createElement をラップし、SVG要素の座標propに非有限値が入った瞬間に
//       その要素の key と props を記録する。
//       DOMのsetAttributeを見る方式では、呼び出し元がreact-domの内部になってしまい
//       スタックからアプリ側の発生箇所が分からないため、生成時点で捕まえる。
//       このプロジェクトの <line> 等は key に "ug-gx3" "gnd-gy5" のような
//       固有名が付いているので、key が分かれば発生箇所を一意に特定できる。
// 読み込み位置: React（UMD）より後、アプリ本体より前でなければならない。
// 二重ラップ防止: window.__SVG_NAN_PROBE__
(function () {
  if (window.__SVG_NAN_PROBE__) return;
  var probe = { hits: [], max: 8, keys: {} };
  window.__SVG_NAN_PROBE__ = probe;

  var TAGS = { line: 1, rect: 1, circle: 1, text: 1, polygon: 1, polyline: 1, path: 1, ellipse: 1, image: 1, foreignObject: 1 };
  var ATTRS = ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'd'];

  function badProps(props) {
    if (!props) return null;
    var bad = [];
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!(a in props)) continue;
      var v = props[a];
      if (typeof v === 'number') { if (!isFinite(v)) bad.push(a); }
      else if (typeof v === 'string' && v.indexOf('NaN') !== -1) bad.push(a);
    }
    return bad.length ? bad : null;
  }

  var origCreate = React.createElement;
  React.createElement = function (type, props) {
    try {
      if (typeof type === 'string' && TAGS[type]) {
        var bad = badProps(props);
        if (bad) {
          var key = (props && props.key !== undefined) ? props.key : (arguments[1] && arguments[1].key);
          var kname = String(key);
          probe.keys[kname] = (probe.keys[kname] || 0) + 1;
          if (probe.hits.length < probe.max) {
            var cam = window.__CAM_STATE__ || null;
            var camBad = cam ? Object.keys(cam).filter(function (k) { return !isFinite(cam[k]); }) : null;
            var snap = {};
            for (var j = 0; j < ATTRS.length; j++) { if (props && ATTRS[j] in props) snap[ATTRS[j]] = props[ATTRS[j]]; }
            probe.hits.push({ tag: type, key: kname, badAttrs: bad, props: snap, cam: cam, camNaNKeys: camBad });
            console.warn('[NaN-PROBE] (' + (window.parent === window ? '3次元図本体' : '配電盤エディタiframe')
              + ' ' + location.pathname + ') <' + type + '> key=' + kname,
              '\nNaNになった属性:', bad.join(','),
              '\nカメラ状態のNaN項目:', (camBad && camBad.length) ? camBad.join(',') : '（なし）',
              '\nカメラ値:', JSON.stringify(cam));
            if (probe.hits.length === probe.max) {
              console.warn('[NaN-PROBE] 記録上限に達しました。window.__SVG_NAN_PROBE__.keys で key別の件数を確認できます。');
            }
          }
        }
      }
    } catch (_) { /* プローブ自身は決して例外を出さない */ }
    return origCreate.apply(this, arguments);
  };
})();
