// ===== 国土地理院の窓 =====
// 2026-11-22 新設。ユーザー要望:
//   「新たにウインドウを設ける。そのウインドウ内に『地面を作る』ボタンを設け、押すと
//    国土地理院のDEMを取得し3次元図にも反映する。3次元図と国土地理院の座標をリンクさせる
//    必要があり、『3次元範囲を設定』で2点で作った四角をフィールドとする」
//
// 【設計】
// ・地図はライブラリを足さず、地理院タイル（std）を <img> で並べるだけ。Cesium に依存しない
//   （2026-09-23 裁定「Cesium が使えなくても機能を失わない」）。
// ・タイルの座標計算・標高の読み取りは src/gsiTiles.js（葉）1か所。ここには式を書き写さない。
// ・「3次元範囲を設定」は commitFieldPolygon（cesiumUtils.js）を呼ぶだけ。
//   原点と縮尺を決める式は fieldFrameFromPolygon 1か所で、Cesium の多角形と同じ道を通る。
// ・「地面を作る」は terrain.js の parseTerrainJSON が受ける形を作って onTerrain へ渡す。
//   3次元図は既存の terrainMesh の経路でそのまま描く（描き手を増やさない）。

function GsiMapPanel({ onTerrain, terrain, gridN, demSource, onClose, onBuildings, onRemoveBuildings, baseMap, importMax }) {
  const boxRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 480, h: 320 });
  const [view, setView] = React.useState(() => {
    const poly = (typeof getSavedFieldPolygon === 'function') ? getSavedFieldPolygon() : null;
    if (poly && poly.length >= 3) {
      const lats = poly.map(p => p.lat), lngs = poly.map(p => p.lng);
      return { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, z: 16, rot: 0 };
    }
    const o = (typeof GEO_ORIGIN !== 'undefined' && GEO_ORIGIN) ? GEO_ORIGIN : { lat: 33.275, lng: 131.667 };
    return { lat: o.lat, lng: o.lng, z: 15, rot: 0 };
  });
  // 地図を回している間の控え（中ボタン／Ctrl＋左ボタンのドラッグ）{ a0: 押した点の角度, rot0 }
  const rotRef = React.useRef(null);
  // Alt を押している間は直角に吸い付かない（印も出さない）。描き直しのために持つ
  const [alt, setAlt] = React.useState(false);
  const [shift, setShift] = React.useState(false);   // Shift を押している間は画面の垂直・水平に寄せる（点をつなぐとき）
  const [pickMode, setPickMode] = React.useState(false);
  // 【範囲の指定・2026-11-28 ユーザー要望】ドラッグ＝四角で囲む（離したら確認）／クリック＝点をつないでいき、
  //   始点をクリックすると閉じた形（建物を点で結んで作るときと同じ）。地面と建物の取り込みもその範囲の中だけ。
  const [pts, setPts] = React.useState([]);          // クリックでつないだ点 [{lat,lng}]
  const [hover, setHover] = React.useState(null);     // 範囲指定中のカーソル位置
  const [四角, set四角] = React.useState(null);       // ドラッグ中の四角 { a, b }（緯度経度）
  const pickRef = React.useRef(null);                  // 押した点 { sx, sy, p, 動いた }
  const 範囲の案内 = 'ドラッグで四角を囲む／クリックで点をつなぎ、始点をクリックか右クリックで閉じる（直角・始点に吸い付く・Shift で垂直水平・Alt で吸い付かない／Backspace で1点戻す・Esc でやめる）';
  const [busy, setBusy] = React.useState(null);       // 取得中の進捗の文字
  const [msg, setMsg] = React.useState('');
  // 取り込み対象が上限より多いときの確認（すべて読み込む／上限まで／やめる）。{ items, 情報, 超え: [{名, 数}], 上限 }
  const [取り込み確認, set取り込み確認] = React.useState(null);
  const dragRef = React.useRef(null);

  // 窓の大きさに合わせる
  React.useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(80, Math.round(r.width)), h: Math.max(80, Math.round(r.height)) });
    });
    ro.observe(el);
    const r0 = el.getBoundingClientRect();
    setSize({ w: Math.max(80, Math.round(r0.width)), h: Math.max(80, Math.round(r0.height)) });
    return () => ro.disconnect();
  }, []);

  const z = view.z;
  const 半W = size.w / 2, 半H = size.h / 2;
  const cx = gsiLngToTileX(view.lng, z);
  const cy = gsiLatToTileY(view.lat, z);

  // 【地図の回転・2026-11-28 ユーザー要望「国土地理院のマップは回転できないのか。北が上となっており形状によって範囲設定が難しい」】
  //   rot は地図を画面の上で時計回りに回す角度（度）。窓の真ん中を中心に回す。
  //   タイルは「北が上」の並びのまま、入れ物ごと CSS で回す。線・点（SVG）は下の 画面へ が回した位置を返す。
  //   変換はこの2つ（画面から・画面へ）だけ。押す・動かす・ホイール・範囲の確定は全部これを通る。
  const 回転 = Math.round(((view.rot || 0) % 360 + 360) % 360 * 10) / 10;
  const _角 = 回転 * Math.PI / 180, _cA = Math.cos(_角), _sA = Math.sin(_角);
  // 北が上の地図の中の座標 → 回した画面の座標（CSS の rotate と同じ向き）
  const _回す = (x, y) => { const dx = x - 半W, dy = y - 半H; return { x: 半W + dx * _cA - dy * _sA, y: 半H + dx * _sA + dy * _cA }; };
  // 画面の上の動き（ベクトル）→ 北が上の地図の中の動き
  const _戻すV = (dx, dy) => ({ x: dx * _cA + dy * _sA, y: -dx * _sA + dy * _cA });
  // 画面 ⇄ 緯度経度（この窓の中だけの変換。図面のグリッドとは別物）
  const 画面から = (sx, sy) => {
    const m = _戻すV(sx - 半W, sy - 半H);
    return { lat: gsiTileYToLat(cy + m.y / GSI_TILE_SIZE, z), lng: gsiTileXToLng(cx + m.x / GSI_TILE_SIZE, z) };
  };
  const 画面へ = (lat, lng) => _回す(
    (gsiLngToTileX(lng, z) - cx) * GSI_TILE_SIZE + 半W,
    (gsiLatToTileY(lat, z) - cy) * GSI_TILE_SIZE + 半H);

  // 観測（製品は読まない）: 検査が画面と緯度経度の変換・回転・つないだ点を読む
  React.useEffect(() => { if (typeof window !== 'undefined') window.__gsiMapForCheck = { 画面から, 画面へ, 回転, pts, w: size.w, h: size.h }; });
  // 並べるタイル（回しても窓の隅まで埋まるよう、真ん中から対角線の半分まで並べる）
  const タイルら = [];
  {
    const 半R = 回転 ? Math.hypot(半W, 半H) : null;
    const rx = 回転 ? 半R : 半W, ry = 回転 ? 半R : 半H;
    const x0 = Math.floor(cx - rx / GSI_TILE_SIZE), x1 = Math.floor(cx + rx / GSI_TILE_SIZE);
    const y0 = Math.floor(cy - ry / GSI_TILE_SIZE), y1 = Math.floor(cy + ry / GSI_TILE_SIZE);
    const 枚 = Math.pow(2, z);
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= 枚) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % 枚) + 枚) % 枚;
        タイルら.push({
          key: z + '/' + tx + '/' + ty,
          // 【地図の種類は歯車で選ぶ・2026-11-24】表は gsiTiles.js の GSI_BASEMAPS 1か所
          url: gsiTileUrl((typeof gsiBaseMapId === 'function') ? gsiBaseMapId(baseMap) : 'std', z, wx, ty),
          left: (tx - cx) * GSI_TILE_SIZE + 半W,
          top: (ty - cy) * GSI_TILE_SIZE + 半H,
        });
      }
    }
  }

  const タイルの重ね = (typeof window !== 'undefined' && window.__GSI_TILE_OVERLAP === false) ? 0 : 1;

  // いまのフィールド（図面の範囲）を枠で出す
  const 枠 = (() => {
    const poly = (typeof getSavedFieldPolygon === 'function') ? getSavedFieldPolygon() : null;
    if (!poly || poly.length < 3) return null;
    return poly.map(p => 画面へ(p.lat, p.lng));
  })();

  // 図面全体（TW×TH）が地球上のどこに当たるか＝地面を取る範囲。gridToGeo が正
  // 図面の4隅（左上・右上・右下・左下）。図面を回していれば（範囲を回した地図で決めた）4隅も回っている
  const 図面の隅 = () => {
    if (typeof gridToGeo !== 'function' || typeof TW === 'undefined' || typeof TH === 'undefined') return null;
    return [gridToGeo(0, 0), gridToGeo(TW, 0), gridToGeo(TW, TH), gridToGeo(0, TH)];
  };
  // 地面・建物を取る範囲＝図面の4隅が入る緯度経度の四角（回していなければ図面そのもの）
  const 図面の範囲 = () => {
    const 隅 = 図面の隅();
    if (!隅) return null;
    const lats = 隅.map(p => p.lat), lngs = 隅.map(p => p.lng);
    return { west: Math.min(...lngs), south: Math.min(...lats), east: Math.max(...lngs), north: Math.max(...lats) };
  };
  const 図面の枠 = (() => {
    const 隅 = 図面の隅();
    return 隅 ? 隅.map(p => 画面へ(p.lat, p.lng)) : null;
  })();

  // ── 建物を取り込む・2026-11-23 ──
  // 【ラスタの画像解析はしない】標準地図は基本測量成果で、しかも総描（デフォルメ）されている。
  //   ベクトルタイル（基本測量成果ではないと国土地理院が明記）を読むのが正しい。
  // 【変換は geoToGrid 1つ】ベクトルタイル側は緯度経度のまま返す。ここでグリッドへ直す。
  const 建物を取り込む = async () => {
    const b = 図面の範囲();
    if (!b) { setMsg('図面の範囲が決まっていません（先に「3次元範囲を設定」）'); return; }
    if (typeof gsiLoadBuildings !== 'function') { setMsg('ベクトルタイルの読み取りが読み込まれていません'); return; }
    if (typeof geoToGrid !== 'function') { setMsg('座標の変換が読み込まれていません'); return; }
    setBusy(true); setMsg('建物を取り寄せています…'); set取り込み確認(null);
    try {
      // 【まず全部数える・2026-11-28 ユーザー要望「読み込み対象の数が上限よりも多いという趣旨と、すべて読み込むかどうかのボタンを出す」】
      //   上限で途中止めにすると「本当は何件あるか」が分からない。読み取りは上限なしで行い（安全のため1種類 10万件で止める）、
      //   取り込む前に上限と比べて、多ければ聞く。
      const r = await gsiLoadBuildings(b, {
        上限: 100000,
        onProgress: (i, n, c) => setMsg('タイル ' + i + '/' + n + '…（' + c + '件）'),
      });
      // 【ring 以外は機械的に運ぶ・2026-11-24】
      //   以前は { key, ftCode, 種別, points } と**書き写していた**ので、gsiTiles.js が
      //   高さ・色・意図（中心線・幅員区分）を渡すようにしても**ここで落ちていた**。
      //   足したものを書き忘れない形にする（solidModel の _作図の入力 と同じ作法）。
      const _グ = (a) => a.map(q => { const g = geoToGrid(q.lat, q.lng); return { x: g.x, y: g.y }; });
      // 【範囲の中だけ取り込む・2026-11-28】範囲（フィールドの形）が四角でなくても、その中だけにする。
      //   建物＝重心が形の中／地面に塗る面（道路・水面）＝少しでも形にかかるもの（はみ出した分は描くときに形で切る）。
      //   旗 window.__GSI_IMPORT_IN_FIELD = false で従来（図面の四角の中を全部）
      let 範囲の外 = 0;
      const _形 = !(typeof window !== 'undefined' && window.__GSI_IMPORT_IN_FIELD === false) ? _範囲の形() : null;
      const _採る = (it) => {
        if (!_形) return true;
        const 点 = it.ring || it.輪 || it.中心線 || [];
        if (!点.length) return true;
        if (it.塗る) return 点.some(q => _中(_形, q));
        let la = 0, lo = 0; for (const q of 点) { la += q.lat; lo += q.lng; }
        return _中(_形, { lat: la / 点.length, lng: lo / 点.length });
      };
      // 【範囲の線をまたぐ建物は描写範囲で切り取る・2026-11-28 ユーザー裁定「描写範囲に従い建物を切り取って表現してくれ」】
      //   従来は「重心が範囲の中なら形のまま取り込む」ので、範囲の外へはみ出して描かれていた。
      //   建物の足元の形を描写範囲（範囲の形／四角なら図面の四角＝ cesiumUtils.js の drawAreaPolygonGrid）と重なる部分だけにする。
      //   重なりが2つに分かれたら2つの建物にする。重なりが無ければ取り込まない。
      //   旗 window.__GSI_CLIP_BUILDINGS_TO_AREA = false で従来（重心で決めて形は切らない）
      const _切る = !(typeof window !== 'undefined' && window.__GSI_CLIP_BUILDINGS_TO_AREA === false)
        && typeof drawAreaPolygonGrid === 'function' && typeof clipPolygonByPolygon === 'function';
      const _描写範囲 = _切る ? drawAreaPolygonGrid() : null;
      let 切り取った = 0;
      const _建物か = (it) => !it.塗る && Array.isArray(it.ring) && it.ring.length >= 3;
      const _中の = [];
      for (const it of r.items) {
        if (_切る && _建物か(it)) {
          const G = _グ(it.ring);
          // ★頂点が全部中でも、凹んだ範囲（L字など）では辺がくぼみを横切ることがあるので、必ず重なりを計算する
          const 片ら = clipPolygonByPolygon(G, _描写範囲);
          if (!片ら.length) { 範囲の外++; continue; }
          const _面積 = (P) => { let a = 0; for (let k = 0; k < P.length; k++) { const p = P[k], q = P[(k + 1) % P.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a / 2); };
          if (片ら.length === 1 && Math.abs(_面積(片ら[0]) - _面積(G)) <= 1e-6 * Math.max(1, _面積(G))) { _中の.push(Object.assign({}, it, { _G: G })); continue; }
          切り取った++;
          片ら.forEach((片, k) => _中の.push(Object.assign({}, it, { _G: 片, key: it.key + (片ら.length > 1 ? '#' + (k + 1) : '#切'),
            srcAdd: Object.assign({}, it.srcAdd || {}, { 範囲で切った: true }) })));
          continue;
        }
        if (_採る(it)) _中の.push(it); else 範囲の外++;
      }
      const items = _中の.map(it => {
        const 他 = Object.assign({}, it); delete 他.ring; delete 他.中心線;
        // 【塗る面は中心線＋幅で運ぶ・2026-11-24】輪（ring）を持たないので points も作らない。
        //   帯は描く側（地面の canvas・平面図）が地面の起伏に乗せて作る。
        if (it.塗る && Array.isArray(it.中心線)) return Object.assign(他, { 中心線: _グ(it.中心線) });
        // 【交差点の角は形（輪）で運ぶ・2026-11-27】道路縁の線から取った隅切りの面
        // 島（穴）も同じ変換でグリッドへ（2026-11-28）
        if (it.塗る && Array.isArray(it.輪)) return Object.assign(他, { 輪: _グ(it.輪) },
          Array.isArray(it.穴) && it.穴.length ? { 穴: it.穴.map(_グ) } : {});
        delete 他._G;
        return Object.assign(他, { points: it._G || _グ(it.ring || []) });
      });
      const 情報 = { r, 範囲の外, 切り取った };
      // 上限と比べる（1つの種類＝レイヤごと）
      // 検査用の口（製品は使わない）: window.__GSI_IMPORT_MAX_OVERRIDE に数を入れると上限をそれにする
      const _試 = (typeof window !== 'undefined' && Number.isFinite(window.__GSI_IMPORT_MAX_OVERRIDE)) ? window.__GSI_IMPORT_MAX_OVERRIDE : null;
      const 上限 = _試 != null ? _試 : ((Number.isFinite(importMax) || importMax === Infinity) ? importMax : 2000);
      const 数え = {};
      for (const it of items) 数え[it.layer] = (数え[it.layer] || 0) + 1;
      const 超え = Object.keys(数え).filter(k => 数え[k] > 上限).map(k => ({ 層: k, 名: _層の名前(k), 数: 数え[k] }));
      if (超え.length && !(typeof window !== 'undefined' && window.__GSI_IMPORT_ASK_OVER_MAX === false)) {
        set取り込み確認({ items, 情報, 超え, 上限, 合計: items.length });
        setMsg('');
        return;
      }
      _取り込みを仕上げる(items, 情報, null);
    } catch (e) { setMsg('取り込みに失敗: ' + (e && e.message)); }
    finally { setBusy(false); }
  };
  // 層の名前（知らせに出す）
  const _層の名前 = (k) => ({ building: '建物', structurea: '構造物（タンクなど）', waterarea: '水面', road: '道路' })[k] || k;
  // 上限まで: 1つの種類ごとに、図面の真ん中に近い順に上限の数だけ残す（取り寄せた順＝北西から並ぶので、順に切ると片寄る）
  const _上限まで = (items, 上限) => {
    const cx = (typeof TW !== 'undefined' ? TW : 0) / 2, cy = (typeof TH !== 'undefined' ? TH : 0) / 2;
    const 中心 = (it) => { const P = it.points || it.輪 || it.中心線 || []; if (!P.length) return 0;
      let x = 0, y = 0; for (const q of P) { x += q.x; y += q.y; } x /= P.length; y /= P.length; return (x - cx) * (x - cx) + (y - cy) * (y - cy); };
    const 層ごと = {};
    items.forEach((it, i) => { (層ごと[it.layer] = 層ごと[it.layer] || []).push({ it, i, d: 中心(it) }); });
    const 残す = new Set();
    for (const k of Object.keys(層ごと)) { const a = 層ごと[k].sort((p, q) => p.d - q.d); a.slice(0, 上限).forEach(e => 残す.add(e.i)); }
    return items.filter((_, i) => 残す.has(i));
  };
  const 確認に答える = (どれ) => {
    const c = 取り込み確認; if (!c) return;
    set取り込み確認(null);
    if (どれ === 'やめる') { setMsg('取り込みをやめました（読み込み対象 ' + c.合計 + ' 件）'); return; }
    const 選んだ = どれ === 'すべて' ? c.items : _上限まで(c.items, c.上限);
    _取り込みを仕上げる(選んだ, c.情報, どれ === 'すべて' ? null : { 上限: c.上限, 落とした: c.items.length - 選んだ.length });
  };
  // 取り込んで知らせを作る（上限の確認の後もここ1か所）
  const _取り込みを仕上げる = (items, 情報, 上限で削った) => {
    const { r, 範囲の外, 切り取った } = 情報;
    try {
      const res = (typeof onBuildings === 'function') ? onBuildings(items) : null;
      const 内訳 = {};
      for (const it of items) 内訳[it.種別] = (内訳[it.種別] || 0) + 1;
      const 明細 = Object.keys(内訳).map(k => k + ' ' + 内訳[k]).join('・');
      const 行 = [];
      行.push('取り込み ' + ((res ? res.足した : items.length) + (res && res.塗り ? res.塗り : 0)) + ' 件'
        + (明細 ? '（' + 明細 + '）' : ''));
      if (res && res.塗り) 行.push('そのうち ' + res.塗り + ' 件は**地面に塗る面**です（厚みを持たせず、地面の起伏に沿って色を置きます）');
      // 【地面に乗せたかを言う・2026-11-27】地面がある状態で取り込むと「乗せますか？」と聞く（App の importMapBuildings）
      if (res && res.地面に乗せた) 行.push(res.地面に乗せた + ' 件は地面の上に乗せました');
      if (res && res.地面に乗せなかった) 行.push(res.地面に乗せなかった + ' 件は地面に乗せず、高さ 0m の基準面に置きました');
      if (res && res.重複) 行.push('すでにある ' + res.重複 + ' 件は足していません');
      if (res && res.重なり) 行.push('手で作った建屋と重なる ' + res.重なり + ' 件は足していません');
      if (範囲の外) 行.push('範囲の形の外の ' + 範囲の外 + ' 件は取り込んでいません');
      if (切り取った) 行.push('範囲の線をまたぐ建物 ' + 切り取った + ' 件は範囲の中の部分だけに切り取りました');
      if (r.穴) 行.push('中庭などの穴 ' + r.穴 + ' 件は落としました');
      // 【道路の縁の線は取らない・2026-11-27】道路は中心線だけを帯にする（gsiTiles.js の GSI_IMPORT_LAYERS の ft範囲）
      // 【道路の面・2026-11-27】道路の縁の線で囲まれた形をそのまま面にした数（交差点も縁の線どおり）
      if (r.道路の面) 行.push('道路は道路の縁の線で囲まれた形をそのまま面にしました（' + r.道路の面 + ' 面・中心線 ' + (r.面に置き換えた線 || 0)
        + ' 本ぶん）。縁の線で閉じない道路だけ中心線の帯です');
      if (r.交差点の角) 行.push('交差点の角 ' + r.交差点の角 + ' か所は道路の縁の線から隅切りの形を取りました');
      if (r.道路の島 || r.水面の島) 行.push('島 ' + ((r.道路の島 || 0) + (r.水面の島 || 0)) + ' か所（道路の中 ' + (r.道路の島 || 0) + '・水面の中 ' + (r.水面の島 || 0) + '）は塗らずに抜きました');
      if (r.範囲外の種類 && !r.道路の面) 行.push('道路の縁の線など ' + r.範囲外の種類 + ' 本は取り込んでいません（道路は中心線だけを帯にします）');
      if (r.切れ) 行.push('タイルの境目で切れた形 ' + r.切れ + ' 件（端がまっすぐに見えます）');
      if (res && res.交差) 行.push('形が自分と交わっていた ' + res.交差 + ' 件は落としました');
      if (r.上限超過) 行.push('読み取りの安全上限（1種類 10万件）に達したので途中で止めました（範囲を狭めてください）');
      if (上限で削った) 行.push('上限（1種類 ' + 上限で削った.上限.toLocaleString() + ' 件）を超えた ' + 上限で削った.落とした + ' 件は取り込んでいません（図面の真ん中に近いものから残しました。上限は歯車で変えられます）');
      // 【高さの知らせは「実データの高さを持たないもの」だけに言う・2026-11-24】
      //   道路は 0.12m の板なので『高さは仮の10m』は嘘になる（Codex監査の指摘）。
      // 【地面に塗る面（道路・交差点の角）は高さを持たないので数えない・2026-11-27】
      const _仮の高さ = items.filter(it => !it.塗る && !(typeof it.height === "number" && it.height > 0)).length;
      if (_仮の高さ) 行.push('そのうち ' + _仮の高さ + ' 件は高さが分からないので仮の '
        + (typeof NEW_BLD_H_M !== 'undefined' ? NEW_BLD_H_M : 10) + 'm です。建物エディタで直してください');
      // 道路は幅員**区分**からの推定（実幅員は配信されていない）。ずれる幅を数で言う
      // 【幅の出所を分けて言う・2026-11-27】道路の縁の線から実際の幅を測れた道路と、測れず幅員区分の幅を使った道路
      const _実測 = items.filter(it => it.srcAdd && it.srcAdd.幅の出所 === '道路の縁の線から実測').length;
      const _幅推定 = items.filter(it => it.srcAdd && it.srcAdd.幅m && it.srcAdd.幅の出所 !== '道路の縁の線から実測').length;
      if (_実測) 行.push('道路 ' + _実測 + ' 件は道路の縁の線から実際の幅を測りました');
      if (_幅推定) 行.push('道路 ' + _幅推定 + ' 件は縁の線が無いので幅員区分からの推定です（区分の幅は最大 13m 幅なので±数mずれます）');
      行.push('出典: 国土地理院ベクトルタイル提供実験');
      setMsg(行.join('／'));
    } catch (e) { setMsg('取り込みに失敗: ' + (e && e.message)); }
  };
  // ── 操作 ──
  // 【点をつなぐ作図の直角の機能は Cesium の「建物を点で結ぶ」と同じ・2026-11-28 ユーザー指摘】
  //   「90度のマークはこれじゃねぇよ。cesiumで建物つくるときに…既存のコードを確認しろ」→「直角はできた。
  //   デザインはcesiumと同じにする必要はなくそのままにしろ。あくまで直角機能だけまねろ」
  //   ＝機能（直角の印＝角に入る辺の長さの 15%・始点へ戻る角の印・始点へ 20px で吸い付き押すと閉じる・Alt なら閉じずに置く・
  //   右クリックで閉じる）は src/CesiumMap.jsx の建屋追加と同じ。見た目（オレンジの線・緑の印・白い始点）はこの窓のまま。
  //   旗 __GSI_PICK_LIKE_CESIUM=false で従来（始点 10px・印 10px・右クリックで閉じない）＝陽性対照。
  // 【Shift で垂直・水平・2026-11-28 ユーザー要望「1点目から2点目の最中垂直水平ができるようにShiftを押しながらだと
  //   垂直水平モードになるようにしろ」】直角は2本目からしか効かないので、Shift を押している間はカーソルの線を
  //   **画面の**横か縦（近い方）に寄せる（地図を回していれば回した向きの縦横）。2本目以降でも Shift が優先。
  //   旗 __GSI_SHIFT_AXIS=false で効かない＝陽性対照。
  const _直角機能 = !(typeof window !== 'undefined' && window.__GSI_PICK_LIKE_CESIUM === false);
  const _軸モード = !(typeof window !== 'undefined' && window.__GSI_SHIFT_AXIS === false);
  const 閉じる距離px = _直角機能 ? 20 : 10;   // 始点からこの距離より近ければ始点に吸い付き、押すと閉じる（Cesium の SNAP_PX）
  const 印の割合 = 0.15;                       // L字の印の大きさ＝角に入る辺の長さの 15%（Cesium の drawPerpMark）
  const onDown = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    // 中ボタン（または Ctrl＋左ボタン）のドラッグで地図を回す（2026-11-28 ユーザー指示「中央ボタンで回るように。平面図と同じ操作に」）。
    //   どの入力で回すかは App.jsx の _図の回転入力か 1つ（平面図・3次元図と同じ述語。ここで書き分けない）
    const _回す入力 = (typeof _図の回転入力か === 'function') ? _図の回転入力か(e) : (e.button === 1 || (e.button === 0 && e.ctrlKey));
    if (_回す入力 && !(typeof window !== 'undefined' && window.__GSI_ROTATE === false)) {
      rotRef.current = { a0: Math.atan2(sy - 半H, sx - 半W), rot0: view.rot || 0 };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (pickMode) {
      // 押した時点では決めない（離したときに「ドラッグか・クリックか」で分ける）
      pickRef.current = { sx, sy, p: 画面から(sx, sy), 動いた: false, lat: view.lat, lng: view.lng };
      e.preventDefault();
      return;
    }
    dragRef.current = { sx, sy, lat: view.lat, lng: view.lng };
    e.preventDefault();
  };
  const onMove = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const 回 = rotRef.current;
    if (回) {
      // 押した点の角度からどれだけ回ったか。Shift を押していれば 15° 刻み
      let d = (Math.atan2(sy - 半H, sx - 半W) - 回.a0) * 180 / Math.PI;
      let nr = 回.rot0 + d;
      if (e.shiftKey) nr = Math.round(nr / 15) * 15;
      nr = ((nr % 360) + 360) % 360;
      setView(v => ({ ...v, rot: Math.round(nr * 10) / 10 }));
      return;
    }
    if (pickMode) {
      setHover(画面から(sx, sy));
      if (alt !== !!e.altKey) setAlt(!!e.altKey);
      if (shift !== !!e.shiftKey) setShift(!!e.shiftKey);
      const k = pickRef.current;
      if (k) {
        if (!k.動いた && Math.hypot(sx - k.sx, sy - k.sy) > 5) k.動いた = true;
        if (k.動いた) {
          if (pts.length === 0) set四角({ a: k.p, b: 画面から(sx, sy) });   // 最初の点の前のドラッグ＝四角で囲む
          else {
            // 点をつないでいる途中のドラッグは地図を動かす（つなぎかけの点は残す）
            const m = _戻すV(sx - k.sx, sy - k.sy);
            const fx = gsiLngToTileX(k.lng, z) - m.x / GSI_TILE_SIZE;
            const fy = gsiLatToTileY(k.lat, z) - m.y / GSI_TILE_SIZE;
            setView(v => ({ ...v, lng: gsiTileXToLng(fx, z), lat: gsiTileYToLat(fy, z) }));
          }
        }
      }
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const m = _戻すV(sx - d.sx, sy - d.sy);
    const fx = gsiLngToTileX(d.lng, z) - m.x / GSI_TILE_SIZE;
    const fy = gsiLatToTileY(d.lat, z) - m.y / GSI_TILE_SIZE;
    setView(v => ({ ...v, lng: gsiTileXToLng(fx, z), lat: gsiTileYToLat(fy, z) }));
  };
  // 点をつなぐときの直角の吸い付き（規則は geometry.js の perpSnap2D 1つ＝Cesium で建物を点で結ぶときと同じ）。
  //   画面の上で計算する（地図の投影は角度を保つので、画面の角度＝地面の角度）。吸い付かせないときは null
  const _直角 = (sx, sy, 止める) => {
    if (止める || typeof perpSnap2D !== 'function' || pts.length < 2) return null;
    const S = pts.map(p => 画面へ(p.lat, p.lng));
    const r = perpSnap2D(S, { x: sx, y: sy });
    return (r.snap90 || r.snapClose90) ? { ...r, S } : null;
  };
  // 次の点をどこに置くか（見せる線と、押したときに置く位置は必ずこの1つで決める）。
  //   種: 'start'（始点に寄る＝押すと閉じる）／'axis'（Shift の垂直・水平）／'90'（直角に吸い付く）／'free'
  const _置く先 = (sx, sy, 止める, 軸) => {
    const q = { x: sx, y: sy };
    if (!pts.length) return { 種: 'free', target: q };
    const S = pts.map(p => 画面へ(p.lat, p.lng)), last = S[S.length - 1];
    if (S.length >= 3 && (!_直角機能 || !止める)) {
      const d0 = Math.hypot(sx - S[0].x, sy - S[0].y);
      if (_直角機能 ? d0 < 閉じる距離px : d0 <= 閉じる距離px) return { 種: 'start', target: S[0] };
    }
    if (軸 && _軸モード) {
      const dx = sx - last.x, dy = sy - last.y;
      const T = Math.abs(dx) >= Math.abs(dy) ? { x: sx, y: last.y } : { x: last.x, y: sy };
      // 寄せた線が直前の辺・始点へ戻る辺とちょうど直角なら印を出す（画面に沿った長方形を描くとき）
      const 直 = (ax, ay, bx, by) => { const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by); return al > 1e-9 && bl > 1e-9 && Math.abs((ax * bx + ay * by) / (al * bl)) < 0.0175; };
      const A = S.length >= 2 ? S[S.length - 2] : null;
      return { 種: 'axis', target: T, snap90: !!(A && 直(last.x - A.x, last.y - A.y, T.x - last.x, T.y - last.y)),
        snapClose90: !!(S.length >= 3 && 直(T.x - last.x, T.y - last.y, S[0].x - T.x, S[0].y - T.y)) };
    }
    if (!(typeof window !== 'undefined' && window.__GSI_PERP_SNAP === false)) {
      const 吸 = _直角(sx, sy, 止める);
      if (吸) return { 種: '90', target: 吸.target, snap90: 吸.snap90, snapClose90: 吸.snapClose90 };
    }
    return { 種: 'free', target: q };
  };
  const onUp = (e) => {
    dragRef.current = null;
    if (rotRef.current) { rotRef.current = null; return; }
    const k = pickRef.current; pickRef.current = null;
    if (!pickMode || !k || !e || e.type === 'mouseleave') { if (e && e.type === 'mouseleave') set四角(null); return; }
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (k.動いた) {
      if (pts.length === 0) { set四角(null); 四角を確定(k.p, 画面から(sx, sy), { x: k.sx, y: k.sy }, { x: sx, y: sy }); }
      return;
    }
    // クリック: 始点の近くなら閉じる（Alt を押していれば閉じずに点を置く＝Cesium と同じ）。
    //   そうでなければ点を足す（Shift なら垂直・水平、でなければ直角に吸い付いた位置。Alt なら押した所のまま）
    const _止 = (typeof snapSuppressedFor === 'function') ? snapSuppressedFor(e) : !!e.altKey;
    const 先 = _置く先(k.sx, k.sy, _止, !!e.shiftKey);
    if (先.種 === 'start') { 多角形を確定(pts); return; }
    const 置く = 先.種 === 'free' ? k.p : 画面から(先.target.x, 先.target.y);
    setPts(prev => [...prev, 置く]);
  };
  // Backspace で1点戻す・Esc でやめる（範囲の指定中だけ）
  React.useEffect(() => {
    if (!pickMode) return undefined;
    const onKey = (e) => {
      // Alt: 押している間は直角に吸い付かない（Windows で Alt がメニューへ取られないよう既定の動きを止める）
      if (e.key === 'Alt') { setAlt(e.type === 'keydown'); e.preventDefault(); return; }
      if (e.key === 'Shift') { setShift(e.type === 'keydown'); return; }
      if (e.type !== 'keydown') return;
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') { setPts([]); set四角(null); setPickMode(false); setMsg('範囲の指定をやめました'); e.preventDefault(); }
      else if (e.key === 'Backspace') { setPts(prev => prev.slice(0, -1)); e.preventDefault(); }
    };
    const onBlur = () => { setAlt(false); setShift(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('blur', onBlur); };
  }, [pickMode]);
  const onWheel = (e) => {
    e.preventDefault();
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const 下 = 画面から(sx, sy);                 // カーソルの下の点を保つ
    const nz = Math.max(5, Math.min(18, z + (e.deltaY < 0 ? 1 : -1)));
    if (nz === z) return;
    const m = _戻すV(sx - 半W, sy - 半H);        // 回しているときは北が上の向きに直してから
    const ncx = gsiLngToTileX(下.lng, nz) - m.x / GSI_TILE_SIZE;
    const ncy = gsiLatToTileY(下.lat, nz) - m.y / GSI_TILE_SIZE;
    setView(v => ({ ...v, z: nz, lng: gsiTileXToLng(ncx, nz), lat: gsiTileYToLat(ncy, nz) }));
  };

  // ── 3次元範囲を設定（ドラッグの四角／クリックでつないだ形 → フィールド）──
  // 原点と縮尺を決める式は cesiumUtils.js の fieldFrameFromPolygon 1か所（Cesium の多角形クリックと同じ commitFieldPolygon を通る）。
  //   図面（平面図・3次元図）は形の外接する四角がぴったり収まる大きさ・縦横比になる（constants.js の fieldCellsFromPolygon）。
  const _外接 = (poly) => {
    const lats = poly.map(p => p.lat), lngs = poly.map(p => p.lng);
    const north = Math.max(...lats), south = Math.min(...lats), west = Math.min(...lngs), east = Math.max(...lngs);
    const mPerDegLng = 111320 * Math.cos(((north + south) / 2) * Math.PI / 180);
    return { north, south, west, east, 幅m: (east - west) * mPerDegLng, 高m: (north - south) * 111320, mPerDegLng };
  };
  // 回は図面の向き（地図を回して決めた範囲はその向きで図面を作る＝画面の上が図面の上。cesiumUtils.js の commitFieldPolygon）
  const _確かめて決める = (poly, 文, 回) => {
    setPickMode(false); setPts([]); set四角(null); setHover(null);
    setTimeout(() => {
      if (window.confirm(文)) commitFieldPolygon(poly, { rot: 回 || 0 });
      else setMsg('範囲の設定をやめました');
    }, 0);
  };
  const 四角を確定 = (p1, p2, s1, s2) => {
    // 地図を回しているときは、画面の上の四角＝地面の上で回した四角（4つの角を緯度経度に直す）
    if (回転 && s1 && s2 && !(typeof window !== 'undefined' && window.__GSI_ROTATE === false)) {
      const 角ら = [[s1.x, s1.y], [s2.x, s1.y], [s2.x, s2.y], [s1.x, s2.y]].map(([x, y]) => 画面から(x, y));
      const b2 = _外接(角ら);
      const 長さ = (a, c) => Math.hypot((c.lng - a.lng) * b2.mPerDegLng, (c.lat - a.lat) * 111320);
      const 辺1 = 長さ(角ら[0], 角ら[1]), 辺2 = 長さ(角ら[1], 角ら[2]);
      if (辺1 < 1 || 辺2 < 1) { setMsg('範囲が小さすぎます。もう少し大きく囲んでください'); return; }
      const _図面も回す = !(typeof window !== 'undefined' && window.__FIELD_ROTATE === false);
      _確かめて決める(角ら, 'この四角（地図を ' + Math.round(回転) + '° 回した向き）を3次元の範囲にしますか？\n'
        + '  辺の長さ ' + Math.round(辺1) + ' m × ' + Math.round(辺2) + ' m\n\n'
        + (_図面も回す ? '図面（平面図・3次元図）もこの四角の向きに回します（いまの地図の画面の上＝図面の上）。地面と建物はこの四角の中を取り込みます。\n'
          : '図面（平面図・3次元図）は北が上のまま、この四角が入る大きさになり、地面と建物はこの四角の中だけ取り込みます。\n')
        + '座標が合わせ直され、画面を読み込み直します。', 回転);
      return;
    }
    const poly0 = [p1, p2];
    const b = _外接(poly0);
    if (b.幅m < 1 || b.高m < 1) { setMsg('範囲が小さすぎます。もう少し大きく囲んでください'); return; }
    const poly = [
      { lat: b.north, lng: b.west }, { lat: b.north, lng: b.east },
      { lat: b.south, lng: b.east }, { lat: b.south, lng: b.west },
    ];
    _確かめて決める(poly, 'この四角を3次元の範囲にしますか？\n'
      + '  東西 ' + Math.round(b.幅m) + ' m ／ 南北 ' + Math.round(b.高m) + ' m\n\n'
      + '図面（平面図・3次元図）の範囲がこの四角になり、地面と建物もこの中を取り込みます。\n'
      + '座標が合わせ直され、画面を読み込み直します。');
  };
  const 多角形を確定 = (poly) => {
    const b = _外接(poly);
    if (b.幅m < 1 || b.高m < 1) { setMsg('範囲が小さすぎます'); return; }
    // 自分と交わる形は範囲にできない（中と外が決まらない）
    const P = poly.map(p => ({ x: (p.lng - b.west) * b.mPerDegLng, y: (b.north - p.lat) * 111320 }));
    const 交わる = (a, c, d, e) => { const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      return o(a, c, d) * o(a, c, e) < 0 && o(d, e, a) * o(d, e, c) < 0; };
    for (let i = 0; i < P.length; i++) for (let j = i + 2; j < P.length; j++) {
      if (i === 0 && j === P.length - 1) continue;
      if (交わる(P[i], P[(i + 1) % P.length], P[j], P[(j + 1) % P.length])) { setMsg('線が交わっている形は範囲にできません。Backspace で戻して描き直してください'); setPickMode(true); return; }
    }
    const _回す = 回転 && !(typeof window !== 'undefined' && window.__FIELD_ROTATE === false);
    _確かめて決める(poly, 'この形（' + poly.length + ' 点）を3次元の範囲にしますか？\n'
      + (_回す ? '' : '  外接する四角 東西 ' + Math.round(b.幅m) + ' m ／ 南北 ' + Math.round(b.高m) + ' m\n')
      + '\n'
      + (_回す ? '図面（平面図・3次元図）はいまの地図の向き（' + Math.round(回転) + '° 回した向き・画面の上＝図面の上）で、この形が入る四角になります。'
        : '図面（平面図・3次元図）の範囲はこの形が入る四角になり、') + '地面と建物はこの形の中だけ取り込みます。\n'
      + '座標が合わせ直され、画面を読み込み直します。', 回転);
  };
  // 取り込みを範囲の中だけにする（範囲＝保存されたフィールドの形）
  const _範囲の形 = () => { const p = (typeof getSavedFieldPolygon === 'function') ? getSavedFieldPolygon() : null; return p && p.length >= 3 ? p : null; };
  const _中 = (P, q) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j];
    if ((a.lat > q.lat) !== (b.lat > q.lat) && q.lng < (b.lng - a.lng) * (q.lat - a.lat) / (b.lat - a.lat) + a.lng) c = !c; } return c; };

  // ── 地面を作る（DEM を取得して3次元図へ）──
  const 地面を作る = async () => {
    const b = 図面の範囲();
    if (!b) { setMsg('図面の範囲が読めません'); return; }
    setMsg('');
    // 【格子の細かさ】面の数＝(格子-1)^2。回すたびに全部の面を投影し直す（1面4点）ので
    // ここが重さに直結する（格子 41 → 1600面／81 → 6400面）。
    // 値はメニューバー右端の歯車（SETTING_DEFS の「地形の細かさ」）から props で来る。
    // 範囲の丸めは App の uiSettingValue 1か所でやっているので、ここでは直さない。
    // 【取り込む格子は常に細かく・2026-11-23 ユーザー指摘】
    //   以前は歯車の「細かさ」をそのまま取り込む格子にしていたので、**取り込んだ格子より細かくは
    //   表示できず**、細かくするには「地面を作る」を押し直すしか無かった（荒くする方向だけ自由）。
    //   取り込みは1回なので常に上限で取り、**表示の細かさは歯車で後からいくらでも変えられる**ようにする。
    //   gridN（歯車の値）はここでは使わない＝表示側（App の terrainToMesh）が使う。
    // 範囲の長い辺（メートル）。点の数は標高データの細かさで割って決める（gsiFetchGridFor）
    const _長m = Math.max((b.east - b.west) * 111320 * Math.cos(((b.north + b.south) / 2) * Math.PI / 180), (b.north - b.south) * 111320);
    const 格子 = gsiFetchGridFor(demSource, _長m);
    // 精度の高い順に重ねて読む（dem5a が無い画素は dem から）。
    // 「1種類で1枚でも取れたら打ち切る」にすると、取れなかったタイルの範囲が
    // 丸ごと欠けて平らになる（2026-11-23 ユーザー実機報告）。
    // どの標高タイルを使うかは歯車の「標高データ」（0=自動）
    const 種類ら = gsiDemKindsFor(demSource);
    const reader = await gsiLoadElevationStack(b, 種類ら, (k, 済, 全, 取れた) => {
      setBusy(k.note + ' ' + 済 + '/' + 全 + ' 枚' + (取れた ? '（取れた ' + 取れた + '）' : ''));
    });
    if (!reader) {
      setBusy(null);
      setMsg('この範囲の標高データが取れませんでした（海の上か、通信が通っていない可能性）');
      return;
    }
    // 取れなかった画素は 0m（海面）で埋める。dem（10mメッシュ）は全国整備なので、
    // そこまで落として取れない所は海。山あいで欠けるのは dem へ落ちる前の話で、
    // それは gsiLoadElevationStack が埋める（2026-11-23）。
    // 図面を回しているときは、標高を図面の格子の点（図面の向き）で取る（地面の格子は図面に重ねて描くため）
    const _図面の点 = (typeof FIELD_CENTER !== 'undefined' && FIELD_CENTER)
      ? ((r, c, rows, cols) => gridToGeo(TW * (cols === 1 ? 0 : c / (cols - 1)), TH * (rows === 1 ? 0 : r / (rows - 1)))) : null;
    const data = gsiBuildElevationGrid(b, 格子, 格子, reader, { seaLevel: 0, sampleAt: _図面の点 });
    if (!data) {
      setBusy(null);
      setMsg('この範囲の標高データが取れませんでした');
      return;
    }
    setBusy(null);
    const 差 = (data.maxElevation - data.minElevation);
    const 内訳 = (reader.内訳 || []).map(x => x.note + ' ' + x.got + '/' + x.tiles).join('・');
    setMsg('地面を作りました：' + reader.kind + '／標高 '
      + data.minElevation.toFixed(1) + '〜' + data.maxElevation.toFixed(1) + ' m（高低差 ' + 差.toFixed(1) + ' m）'
      + '／3次元図の 0m ＝ この範囲の陸地の最低標高 ' + data.minElevation.toFixed(1) + ' m（海抜。海は基準に含めない）'
      + '／取り込み ' + 格子 + '×' + 格子 + ' 点（表示の細かさは設定で後から変えられます）'
      + '／タイル ' + 内訳
      + (data._gsi.missing ? '／取れなかった ' + data._gsi.missing + ' 点は 0m（海面）で埋めた' : ''));
    if (typeof onTerrain === 'function') onTerrain(data);
  };

  const ボタン = (色) => ({
    background: 色, color: '#fff', border: 'none', borderRadius: 3,
    padding: '3px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'sans-serif',
  });

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0f172a', color: '#e2e8f0' }}>
      {/* 道具 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 6px', background: '#1e293b', flexWrap: 'wrap' }}>
        <button data-gsi-btn="range" style={ボタン(pickMode ? 'rgba(234,88,12,0.95)' : 'rgba(59,130,246,0.85)')}
          onClick={() => { setPickMode(m => !m); setPts([]); set四角(null); setHover(null); setMsg(pickMode ? '' : 範囲の案内); }}>
          {pickMode ? '範囲の指定をやめる' : '3次元範囲を設定'}
        </button>
        <button data-gsi-btn="ground" style={ボタン(busy ? 'rgba(100,116,139,0.8)' : 'rgba(22,163,74,0.9)')}
          disabled={!!busy} onClick={地面を作る}>
          {busy ? '取得中…' : '地面を作る'}
        </button>
        {(typeof window === 'undefined' || window.__GSI_BUILDINGS !== false) && (
          <button data-gsi-btn="buildings"
            style={ボタン(busy ? 'rgba(100,116,139,0.8)' : 'rgba(139,92,246,0.9)')}
            disabled={!!busy} onClick={建物を取り込む}>
            {busy ? '取得中…' : '建物を取り込む'}
          </button>
        )}
        {(typeof onRemoveBuildings === 'function') && (
          <button data-gsi-btn="buildings-clear"
            style={ボタン('rgba(239,68,68,0.6)')}
            onClick={() => {
              const n = onRemoveBuildings();
              setMsg(n ? ('取り込んだ建物 ' + n + ' 件を消しました') : '取り込んだ建物はありません');
            }}>
            取り込んだ建物を消す
          </button>
        )}
        {terrain && (
          <button data-gsi-btn="clear" style={ボタン('rgba(239,68,68,0.75)')}
            onClick={() => { if (typeof onTerrain === 'function') onTerrain(null); setMsg('地面を消しました'); }}>
            地面を消す
          </button>
        )}
        <span style={{ fontSize: 11, opacity: 0.8, marginLeft: 'auto' }}>
          ズーム {z}／{view.lat.toFixed(5)}, {view.lng.toFixed(5)}
        </span>
      </div>

      {/* 地図 */}
      <div ref={boxRef} data-gsi-map="1" data-gsi-rot={回転}
        style={{ position: 'relative', flex: 1, overflow: 'hidden', cursor: pickMode ? 'crosshair' : 'grab', background: '#1e293b' }}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}
        onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
        onContextMenu={(e) => {
          // 右クリックで閉じる（3点以上・Cesium の建屋追加と同じ）。点をつないでいる間はブラウザのメニューを出さない
          if (!pickMode) return;
          e.preventDefault();
          if (_直角機能 && pts.length >= 3) 多角形を確定(pts);
        }}>
        {/* タイルは北が上の並びのまま、入れ物ごと回す（真ん中を中心に） */}
        <div data-gsi-tiles="1" style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          transform: 回転 ? 'rotate(' + 回転 + 'deg)' : undefined, transformOrigin: 半W + 'px ' + 半H + 'px' }}>
          {/* 【タイルの継ぎ目・2026-11-28 ユーザー報告「何この糸みたいなグリッド」】回すとタイルの縁がなめらかにぼかされ、
              隣どうしの縁が両方とも半透明になって下の地色が細い線で透けていた。各タイルを右と下へ 1px はみ出させて
              隣と重ねる（どの縁でもどちらかのタイルは不透明なので地色が透けない。1/256 の伸びは見た目に出ない）。
              旗 __GSI_TILE_OVERLAP=false で従来（陽性対照）。 */}
          {タイルら.map(t => (
            <img key={t.key} src={t.url} alt="" draggable={false} data-gsi-tile="1"
              style={{ position: 'absolute', left: t.left, top: t.top, width: GSI_TILE_SIZE + タイルの重ね, height: GSI_TILE_SIZE + タイルの重ね, userSelect: 'none', pointerEvents: 'none' }} />
          ))}
        </div>

        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {図面の枠 && (
            <polygon data-gsi="sheet" points={図面の枠.map(p => p.x + ',' + p.y).join(' ')}
              fill="rgba(56,189,248,0.10)" stroke="#38bdf8" strokeWidth={2} strokeDasharray="6 4" />
          )}
          {枠 && (
            <polygon data-gsi="field" points={枠.map(p => p.x + ',' + p.y).join(' ')}
              fill="rgba(250,204,21,0.08)" stroke="#facc15" strokeWidth={2} />
          )}
          {四角 && (() => {
            const a = 画面へ(四角.a.lat, 四角.a.lng), b = 画面へ(四角.b.lat, 四角.b.lng);
            return <rect data-gsi="pick" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)}
              width={Math.abs(a.x - b.x)} height={Math.abs(a.y - b.y)}
              fill="rgba(249,115,22,0.15)" stroke="#f97316" strokeWidth={2} />;
          })()}
          {pts.length > 0 && (() => {
            // 見た目はこの窓のまま（オレンジの線・緑の印・白い始点）。置く位置は _置く先 1つで決める（押したときと同じ）
            const S = pts.map(p => 画面へ(p.lat, p.lng));
            const last = S[S.length - 1];
            const h0 = hover ? 画面へ(hover.lat, hover.lng) : null;
            const 先 = h0 ? _置く先(h0.x, h0.y, alt, shift) : null;
            const h = 先 ? 先.target : null;
            const 閉じる = !!(先 && 先.種 === 'start');
            const 寄せた = !!(先 && (先.種 === '90' || 先.種 === 'axis'));
            const 線 = S.concat(h ? [h] : []);
            const L字 = (角, 元, 先2) => { const el = Math.hypot(角.x - 元.x, 角.y - 元.y);
              return el > 1e-9 ? perpMark2D(角, 元, 先2, _直角機能 ? el * 印の割合 : 10) : null; };
            const 印ら = [];
            if (寄せた && h && 先.snap90 && S.length >= 2) 印ら.push(L字(last, S[S.length - 2], h));
            if (寄せた && h && 先.snapClose90 && S.length >= 2) 印ら.push(L字(h, last, S[0]));
            return (<g data-gsi="pick-poly" data-gsi-snap={先 ? 先.種 : ''}>
              {pts.length >= 3 && <polygon points={S.map(q => q.x + ',' + q.y).join(' ')} fill="rgba(249,115,22,0.12)" stroke="none" />}
              <polyline data-gsi="pick-line" points={線.map(q => q.x + ',' + q.y).join(' ')} fill="none" stroke={寄せた ? '#22c55e' : '#f97316'} strokeWidth={2} />
              {/* 始点へ戻る辺（直角なら緑） */}
              {h && !閉じる && pts.length >= 2 && <line data-gsi="pick-close" x1={h.x} y1={h.y} x2={S[0].x} y2={S[0].y}
                stroke={寄せた && 先.snapClose90 ? '#22c55e' : '#f97316'} strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />}
              {印ら.filter(Boolean).map((m, i) => <polyline key={'p' + i} data-gsi="perp-mark" points={m.map(q => q.x + ',' + q.y).join(' ')}
                fill="none" stroke="#22c55e" strokeWidth={2} />)}
              {S.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={i === 0 ? (閉じる ? 8 : 6) : 4}
                data-gsi={i === 0 && 閉じる ? 'pick-start-snap' : undefined}
                fill={i === 0 ? (閉じる ? '#22c55e' : '#fff') : '#f97316'} stroke={i === 0 ? '#f97316' : '#fff'} strokeWidth={i === 0 ? 2.5 : 1.5} />)}
            </g>);
          })()}
        </svg>

        {/* 方位: 針は北を指す。押すと北を上に戻す（中ボタン／Ctrl＋左ボタンのドラッグで回す・Shift で 15° 刻み） */}
        {!(typeof window !== 'undefined' && window.__GSI_ROTATE === false) && (
          <div data-gsi-compass="1" title={'地図の向き ' + Math.round(回転) + '°（押すと北が上に戻る／中ボタンか Ctrl＋左ボタンのドラッグで回す・Shift で 15° 刻み）'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setView(v => ({ ...v, rot: 0 })); }}
            style={{ position: 'absolute', right: 6, top: 6, width: 34, height: 34, borderRadius: 17, cursor: 'pointer',
              background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="26" height="26" viewBox="-13 -13 26 26" style={{ transform: 'rotate(' + 回転 + 'deg)' }}>
              <polygon points="0,-11 4,0 -4,0" fill="#ef4444" />
              <polygon points="0,11 4,0 -4,0" fill="#e2e8f0" />
            </svg>
            {回転 !== 0 && <span style={{ position: 'absolute', top: 36, right: 0, fontSize: 10, background: 'rgba(15,23,42,0.8)', padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap' }}>{Math.round(回転)}°</span>}
          </div>
        )}

        {/* 出典（地理院タイルの利用条件） */}
        <div style={{ position: 'absolute', right: 4, bottom: 3, fontSize: 10, background: 'rgba(15,23,42,0.75)', padding: '1px 5px', borderRadius: 3 }}>
          出典：<a href={GSI_ATTR_URL} target="_blank" rel="noreferrer" style={{ color: '#93c5fd' }}>{GSI_ATTR_TEXT}</a>
        </div>
      </div>

      {/* 取り込み対象が上限より多いときの確認（2026-11-28） */}
      {取り込み確認 && (
        <div data-gsi-import-ask="1" style={{ fontSize: 12, padding: '6px 8px', background: '#422006', borderTop: '1px solid #f59e0b', lineHeight: '17px' }}>
          <div>読み込み対象が上限（1つの種類あたり {取り込み確認.上限.toLocaleString()} 件）より多くあります：
            {取り込み確認.超え.map(x => x.名 + ' ' + x.数.toLocaleString() + ' 件').join('・')}（合計 {取り込み確認.合計.toLocaleString()} 件）。
            すべて読み込むと3次元図が重くなることがあります。</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            <button data-gsi-import-ask-btn="all" style={ボタン('rgba(234,88,12,0.95)')} onClick={() => 確認に答える('すべて')}>すべて読み込む（{取り込み確認.合計.toLocaleString()} 件）</button>
            <button data-gsi-import-ask-btn="max" style={ボタン('rgba(59,130,246,0.9)')} onClick={() => 確認に答える('上限まで')}>上限まで読み込む</button>
            <button data-gsi-import-ask-btn="cancel" style={ボタン('rgba(100,116,139,0.9)')} onClick={() => 確認に答える('やめる')}>やめる</button>
          </div>
        </div>
      )}
      {/* 知らせ */}
      <div style={{ fontSize: 11, padding: '3px 6px', background: '#1e293b', minHeight: 18, lineHeight: '14px' }}>
        {busy ? busy : (msg || (pickMode ? 範囲の案内 : '水色の点線＝いまの図面の範囲／黄色＝フィールド／中ボタン（または Ctrl＋左ボタン）のドラッグで地図を回す'))}
      </div>
    </div>
  );
}
