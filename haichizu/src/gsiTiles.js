// ===== 国土地理院（地理院タイル）の取得と計算 =====
// 2026-11-22 新設。ユーザー要望「国土地理院のウインドウを設け、地面を作る／3次元範囲を設定」。
//
// 【出典表示の義務】地理院タイルを使う画面には
//   「国土地理院」または「地理院タイル」等と記載し、一覧ページへのリンクを付ける。
//   https://maps.gsi.go.jp/development/ichiran.html
//
// 【仕様（2026-11-22 に公式ページで確認）】
//   背景地図 std（標準・z5〜18）／pale（淡色・z5〜18）／seamlessphoto（写真）
//   標高     dem（10mメッシュ・z1〜14・txt）／dem5a（5mメッシュ・z1〜15・txt）
//   txt は 256行×256列のカンマ区切り。標高はメートル（小数第2位）。
//   データが無い画素（海など）は "e"。
//
// 【このファイルの役割】タイルの座標計算・URL・txt の読み取り・標高の格子作り。
//   地図の見た目（GsiMap.jsx）と、3次元図へ渡す地形（terrain.js の形）が同じここを使う。
//   ＝「どのタイルを取るか」の計算を2か所に書かない。

const GSI_ATTR_TEXT = '国土地理院（地理院タイル）';
const GSI_ATTR_URL = 'https://maps.gsi.go.jp/development/ichiran.html';
const GSI_TILE_SIZE = 256;

// 取り込む標高の格子（縦横の点数）。表示の細かさ（歯車）とは別物で、**常にこの細かさで取り込む**。
// 取り込みは「地面を作る」の1回だけなので細かく取っておき、表示は歯車で後から自由に変えられる。
// 401 点＝図面の長辺を400分割（図面576m なら約1.4m間隔）。
const GSI_FETCH_GRID = 401;

// 取り込む格子は「元データの細かさ」に見合う量にする（2026-11-23）。
// 5mメッシュを 401 点（1.4m間隔）で取り込んでも、増えるのは補間の時間だけで情報は増えない。
// 実測: 401 点だと取り込みに約9秒（タイルの読み取り＋補間 160801 点）かかった。
function gsiFetchGridFor(選) {
  return (Number(選) === 1) ? GSI_FETCH_GRID : 201; // 1=1mメッシュのときだけ細かく
}

// 標高タイルの種類。精度の高い順。整備されていない地域があるので、取れなければ下へ落とす。
// png 版（dem1a_png）は 1mメッシュ。txt が無いので画素から標高を復号する。
const GSI_DEM_ALL = [
  { kind: 'dem1a_png', maxZ: 17, note: '1mメッシュ', png: true },
  { kind: 'dem5a', maxZ: 15, note: '5mメッシュ' },
  { kind: 'dem', maxZ: 14, note: '10mメッシュ' },
];
// 既定（自動）は 5m → 10m。1m はタイル数が多いので、歯車で選んだときだけ使う
const GSI_DEM_KINDS = GSI_DEM_ALL.filter(k => k.kind !== 'dem1a_png');
// 歯車の「標高データ」の選択肢（0=自動）。番号は SETTING_DEFS と合わせる
function gsiDemKindsFor(選) {
  const n = Number(選);
  if (n === 1) return GSI_DEM_ALL;                 // 1mメッシュから（無ければ 5m→10m）
  if (n === 2) return GSI_DEM_ALL.slice(1);        // 5mメッシュから
  if (n === 3) return GSI_DEM_ALL.slice(2);        // 10mメッシュだけ
  return GSI_DEM_KINDS;                            // 0=自動（5m→10m）
}

// 種類ごとの拡張子は表1つ（種類が増えてもここに1行。if を書き足さない）
const GSI_TILE_EXT = { dem: 'txt', dem5a: 'txt', dem5b: 'txt', experimental_bvmap: 'pbf' };
function gsiTileExt(kind) { return GSI_TILE_EXT[kind] || 'png'; }

// ══ 地図の種類（土地の凹凸を含む）・2026-11-24 ユーザー指示 ══
// 【表1つ】種類を増やすときはここに1行。選択肢も説明もここから作る（各所に if を書かない）。
// 【区分】どれも地理院タイル一覧の「■2. 基本測量成果以外で出典の記載のみで利用可能なもの」
//   （標準地図だけは■1の基本測量成果。詳しくは docs/ROADMAP.md「国土地理院のデータの区分」）。
// 【実測・2026-11-24】大分(z14/14185/6584) で 5種類とも 200 が返ることを確かめた。
const GSI_BASEMAPS = [
  // ★【2026-11-24 ユーザー裁定】「標準地図と淡色のみでよい。**ほかは精度がない**」
  //   色別標高図・陰影起伏図・傾斜量図・赤色立体地図・アナグリフは外した。
   //   どれも配信はされている（実測で200）が、**この用途（設備の配置を測る）には粗すぎる**。
   //   必要になったら id を1行足すだけで戻せる（各所に if を書いていないのはそのため）。
  { id: 'std',  label: '標準地図', 成果: true, 説明: 'ふつうの地図。建物や道路が見える' },
  { id: 'pale', label: '淡色地図', 成果: true, 説明: '薄い色。上に重ねるものが見やすい' },
];
function gsiBaseMapId(v) { const r = GSI_BASEMAPS.find(b => b.id === v); return r ? r.id : 'std'; }
function gsiTileUrl(kind, z, x, y) {
  return 'https://cyberjapandata.gsi.go.jp/xyz/' + kind + '/' + z + '/' + x + '/' + y + '.' + gsiTileExt(kind);
}

// ── 経度緯度 ⇄ タイル座標（Webメルカトル）──
// 小数で返すので「何枚目のタイルの、どこか」までそのまま表せる。
function gsiLngToTileX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
function gsiLatToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}
function gsiTileXToLng(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function gsiTileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// 1画素が地上で何メートルか（緯度による）。どのズームで標高を取るかを決めるのに使う
function gsiMetersPerPixel(lat, z) {
  return 156543.03392804097 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
}

// ── 標高タイル（txt）の読み取り ──
// 返すのは 256行×256列の配列。データが無い画素（"e"）は null。
function gsiParseDemTxt(text) {
  if (typeof text !== 'string' || !text) return null;
  const rows = text.trim().split('\n');
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].replace(/\r$/, '').split(',');
    const line = new Array(cells.length);
    for (let c = 0; c < cells.length; c++) {
      const s = cells[c];
      // "e" のほか、空文字・数でない物も「無い」として扱う
      if (s === 'e' || s === '') { line[c] = null; continue; }
      const v = Number(s);
      line[c] = Number.isFinite(v) ? v : null;
    }
    out.push(line);
  }
  return out.length ? out : null;
}

// ── 取り寄せ ──
// サーバー（server.js）のプロキシがあれば経由する（貯めが効いて2回目から速い）。
// 無ければ直接取る＝プロキシ必須にしない（Cesium が使えない環境でも機能を失わない・2026-09-23 裁定）。
let _gsiProxyOk = null; // null=未判定 / true=使える / false=使えない
function gsiSetProxyAvailable(ok) { _gsiProxyOk = !!ok; }
function gsiProxyAvailable() { return _gsiProxyOk === true; }

function gsiResolveUrl(url) {
  return gsiProxyAvailable() ? ('/proxy?url=' + encodeURIComponent(url)) : url;
}

// 1枚取る。取れなければ null（呼び手が「無い」として扱う）
async function gsiFetchText(url) {
  try {
    const res = await fetch(gsiResolveUrl(url));
    if (!res.ok) return null;
    const t = await res.text();
    // S3 がエラーXMLを返すことがあるので弾く（存在しないタイル）
    if (t.indexOf('<?xml') === 0 || t.indexOf('<Error') === 0) return null;
    return t;
  } catch (_) { return null; }
}

// ── 標高タイル（png）の読み取り ──
// 【公式の式】x = 2^16·R + 2^8·G + B、u = 0.01m
//   x <  2^23 … h = x·u ／ x === 2^23 … データ無し ／ x >  2^23 … h = (x − 2^24)·u
// 無効値は (R,G,B) = (128,0,0)。canvas で画素を読む（プロキシ経由なら同一オリジン）。
function gsiDecodeDemPixel(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;            // 2^23 = データ無し
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}
async function gsiLoadDemPng(url) {
  const 元 = gsiResolveUrl(url);
  const img = await new Promise((res) => {
    const im = new Image();
    // プロキシを通さないときは別オリジンなので、画素を読むために必要
    if (元 === url) im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = 元;
  });
  if (!img) return null;
  try {
    const cv = document.createElement('canvas');
    cv.width = GSI_TILE_SIZE; cv.height = GSI_TILE_SIZE;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, GSI_TILE_SIZE, GSI_TILE_SIZE);
    const d = cx.getImageData(0, 0, GSI_TILE_SIZE, GSI_TILE_SIZE).data;
    const out = [];
    for (let y = 0; y < GSI_TILE_SIZE; y++) {
      const line = new Array(GSI_TILE_SIZE);
      for (let x = 0; x < GSI_TILE_SIZE; x++) {
        const i = (y * GSI_TILE_SIZE + x) * 4;
        line[x] = (d[i + 3] === 0) ? null : gsiDecodeDemPixel(d[i], d[i + 1], d[i + 2]);
      }
      out.push(line);
    }
    return out;
  } catch (_) { return null; } // 画素が読めない（CORS 等）
}

// ── 標高の読み取り器 ──
// 範囲内のタイルをまとめて取り、「緯度経度 → 標高(m)」で引けるようにする。
// 同じタイルは1回しか取らない。取れなかったタイルは null のまま（読むと null が返る）。
async function gsiLoadElevationReader(bounds, z, kind, onProgress) {
  const x0 = Math.floor(gsiLngToTileX(bounds.west, z));
  const x1 = Math.floor(gsiLngToTileX(bounds.east, z));
  const y0 = Math.floor(gsiLatToTileY(bounds.north, z));
  const y1 = Math.floor(gsiLatToTileY(bounds.south, z));
  const tiles = new Map();
  const 全 = Math.max(0, (x1 - x0 + 1)) * Math.max(0, (y1 - y0 + 1));
  let 済 = 0, 取れた = 0;
  // 【まとめて取る・2026-11-23】1枚ずつ await していたので、8枚で約9秒かかっていた。
  //   タイルは互いに独立なので同時に投げる（同時数は 8 に抑える＝サーバーを詰まらせない）。
  const 仕事 = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) 仕事.push({ tx, ty });
  const 同時 = 8;
  for (let i = 0; i < 仕事.length; i += 同時) {
    await Promise.all(仕事.slice(i, i + 同時).map(async ({ tx, ty }) => {
      const u = gsiTileUrl(kind, z, tx, ty);
      const grid = (gsiTileExt(kind) === 'png')
        ? await gsiLoadDemPng(u)
        : await (async () => { const txt = await gsiFetchText(u); return txt ? gsiParseDemTxt(txt) : null; })();
      if (grid) 取れた++;
      tiles.set(tx + '/' + ty, grid);
      済++;
      if (typeof onProgress === 'function') onProgress(済, 全, 取れた);
    }));
  }
  // 画素を1つ取る（タイルをまたいでも引ける通し座標で指定する）
  const 画素 = (gx, gy) => {
    const tx = Math.floor(gx / GSI_TILE_SIZE), ty = Math.floor(gy / GSI_TILE_SIZE);
    const grid = tiles.get(tx + '/' + ty);
    if (!grid) return null;
    const line = grid[gy - ty * GSI_TILE_SIZE];
    if (!line) return null;
    const v = line[gx - tx * GSI_TILE_SIZE];
    return (v === undefined) ? null : v;
  };
  // 【双線形補間・2026-11-23 ユーザー報告「細かさを100以上にしても変化がない」】
  // 以前は画素を floor で1つ取るだけ（最近傍）だったので、格子を細かくしても**同じ値が並ぶ**＝
  // 階段状になり、細かさの設定が効かなかった。白黒がまだらにはっきり出るのも同じ原因
  //（隣の格子で標高が急に変わる＝傾きが極端になる）。
  // 周りの4画素から重みをつけて混ぜる。欠けている画素は重みから外す（端や海ぎわ）。
  const read = (lat, lng) => {
    const fx = gsiLngToTileX(lng, z) * GSI_TILE_SIZE - 0.5;
    const fy = gsiLatToTileY(lat, z) * GSI_TILE_SIZE - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    const 四 = [
      { v: 画素(x0, y0), w: (1 - ax) * (1 - ay) },
      { v: 画素(x0 + 1, y0), w: ax * (1 - ay) },
      { v: 画素(x0, y0 + 1), w: (1 - ax) * ay },
      { v: 画素(x0 + 1, y0 + 1), w: ax * ay },
    ];
    let 和 = 0, 重み = 0;
    for (const c of 四) {
      if (c.v === null || c.v === undefined || !Number.isFinite(c.v) || c.w <= 0) continue;
      和 += c.v * c.w; 重み += c.w;
    }
    if (重み > 0) return 和 / 重み;
    // 4つとも欠け → 一番近い画素だけ見る（それも無ければ null）
    return 画素(Math.round(fx), Math.round(fy));
  };
  return { read, tileCount: 全, got: 取れた, z, kind };
}

// ── 精度の違う標高タイルを重ねて読む（2026-11-23 ユーザー実機報告）──
// 【なぜ】dem5a（5mメッシュ）は整備済みの地域だけで、同じ範囲でも**取れるタイルと取れないタイルが混ざる**。
//   「1枚でも取れたら dem5a だけ使う」作りだと、取れなかったタイルの範囲が丸ごと欠けて
//   0m の真っ平らな面になっていた（実測: 福知山で 4/6 枚・残り2枚ぶんが平ら）。
// 【どうする】精度の高い順に全部の reader を作り、**画素ごとに**上から順に引く。
//   dem5a が無い画素は dem（10mメッシュ）から取る。
async function gsiLoadElevationStack(bounds, kinds, onProgress) {
  const 層 = [];
  const 全体 = [];
  for (const k of (kinds || GSI_DEM_KINDS)) {
    const z = gsiPickDemZoom(bounds, k.maxZ);
    const r = await gsiLoadElevationReader(bounds, z, k.kind, (済, 全, 取れた) => {
      if (typeof onProgress === 'function') onProgress(k, 済, 全, 取れた);
    });
    全体.push({ kind: k.kind, note: k.note, z, tiles: r.tileCount, got: r.got });
    if (r.got) 層.push({ k, r });
    // 全部のタイルが取れたなら、精度の低い方は要らない
    if (r.got && r.got === r.tileCount) break;
  }
  if (!層.length) return null;
  return {
    read: (lat, lng) => {
      for (const l of 層) { const v = l.r.read(lat, lng); if (v !== null && v !== undefined) return v; }
      return null;
    },
    kind: 層.map(l => l.k.note).join('＋'),
    z: 層[0].r.z,
    tileCount: 層.reduce((n, l) => n + l.r.tileCount, 0),
    got: 層.reduce((n, l) => n + l.r.got, 0),
    内訳: 全体,
  };
}

// ── 標高の格子を作る（3次元図へ渡す形）──
// 返すのは terrain.js の parseTerrainJSON がそのまま受ける形。
//   bounds / step / cols / rows / elevations[rows][cols] / minElevation / maxElevation
// 【並び】elevations[0] が**北の端**（タイルと同じ）。3次元図の Y は南向きなので
//   gridToGeo の Y 反転（平面図の上＝北）とそろう。
// 【データが無い画素】海などは null。ここでは 0m（海面）で埋める
//   ＝図面の既定原点が臨海部なので、穴にすると地面が欠ける。
//   1点も有効値が無ければ null を返す（呼び手が「取れなかった」と出す）。
function gsiBuildElevationGrid(bounds, cols, rows, reader, opts) {
  // 【欠けた画素の埋め方・2026-11-23】
  // 以前は 0m（海面）で埋めていたが、山あいの敷地だと「取れなかった所だけ標高0の真っ平ら」に
  // 化けて、本当の地形が潰れて見えた（ユーザー実機報告）。
  // いまは **2回に分けて**、①まず取れた値だけで読む ②欠けた所は「取れた中の最低標高」で埋める。
  //   海（本当にデータが無い所）も最低標高になるが、最低標高が 0m 付近なら結果は同じ。
  //   seaLevel を渡したときだけ従来どおりその値で埋める。
  const elevations = [];
  let min = Infinity, max = -Infinity, 有効 = 0, 欠け = 0;
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north + (bounds.south - bounds.north) * (rows === 1 ? 0 : r / (rows - 1));
    const line = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + (bounds.east - bounds.west) * (cols === 1 ? 0 : c / (cols - 1));
      const v = reader.read(lat, lng);
      if (v === null || v === undefined || !Number.isFinite(v)) { line[c] = null; 欠け++; }
      else { line[c] = v; 有効++; if (v < min) min = v; if (v > max) max = v; }
    }
    elevations.push(line);
  }
  if (!有効) return null;
  const 埋める値 = (opts && Number.isFinite(opts.seaLevel)) ? opts.seaLevel : min;
  if (欠け) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (elevations[r][c] === null) elevations[r][c] = 埋める値;
    // 【埋めた分は最低・最高に含めない・2026-11-23 ユーザー報告「建屋が地中に埋もれる」】
    //   海を 0m で埋めると、それが「この範囲の最低標高」になり 3次元図の 0m が海面になる。
    //   すると陸地（標高3〜5m）がまるごと浮き、GL=0 で作った建屋が地面の下に潜る。
    //   最低・最高は**実際に標高が取れた画素だけ**で決める。埋めた海は基準より低い所として描かれる。
  }
  const 海面 = 埋める値;
  return {
    bounds: bounds,
    step: null,
    cols: cols,
    rows: rows,
    elevations: elevations,
    minElevation: min,
    maxElevation: max,
    _gsi: { z: reader.z, kind: reader.kind, tiles: reader.tileCount, got: reader.got, valid: 有効, missing: 欠け },
  };
}

// 範囲の大きさから、標高タイルのズームを決める（細かすぎても取る枚数が増えるだけ）
function gsiPickDemZoom(bounds, kindMaxZ) {
  const lat = (bounds.north + bounds.south) / 2;
  const 幅m = Math.abs(bounds.east - bounds.west) * 111320 * Math.cos(lat * Math.PI / 180);
  const 高m = Math.abs(bounds.north - bounds.south) * 111320;
  const 長辺 = Math.max(幅m, 高m, 1);
  // 長辺を 1000画素くらいで覆えるズーム（＝1画素 長辺/1000 m）を上限まで
  let z = kindMaxZ;
  while (z > 1) {
    const mpp = gsiMetersPerPixel(lat, z);
    if (長辺 / mpp <= 1400) break; // 取るタイルが増えすぎない所で止める
    z--;
  }
  return Math.max(1, Math.min(kindMaxZ, z));
}


// ══════════════════════════════════════════════════════════════
// ベクトルタイル（建物・構造物）・2026-11-23
// ══════════════════════════════════════════════════════════════
// 【なぜラスタでなくこれを読むか】
//   ① 国土地理院が「本提供実験のベクトルタイルは**基本測量成果と位置付けているものでは
//      ありません**」と明記している（提供実験のREADME）。標準地図（ラスタ）は基本測量成果。
//   ② ラスタの建物は縮尺に応じて**総描（デフォルメ・記号化）**されており、画像解析で
//      取り出した寸法は実物の寸法ではない。ベクトルなら元の形がそのまま入っている。
//   ＝ ラスタから形を起こすのは、法的にも精度の上でも筋が悪い。
// 【出典】「国土地理院ベクトルタイル提供実験」と明示する（READMEの指定）。
// 【注意】提供実験中のため URL・データ構成・属性の名称が変わりうる。読む側は必ず既定値を持つ。
// 【高さは入っていない】実測（2026-11-23）: building の属性は orgGILvl / ftCode / lvOrder だけ。
const GSI_VECTOR_KIND = 'experimental_bvmap';
// 【取り込みのズーム・2026-11-24 ユーザー報告「かぎ型が2つの図形になってしまう」】
//   ベクトルタイルは**タイルごとに切って**配信される。1タイルに収まらない建物は
//   タイルの縁で切られた断片になり、3次元図では別々の立体に見える。
//   z16 は実データの最大だが、**タイルが小さい**ので切れる建物が多い。
//   実測（大分・約900m四方）:
//     z16 … 建物219件・**縁に乗る18件**（タイル4枚）
//     z15 … 建物218件・**縁に乗る2件**（タイル1枚）
//     z14 … 建物 26件（粗すぎて建物がほとんど無い）
//   z15 と z16 で**同じ建物の点数の差は中央値0・面積の差は0%**＝形は変わらない。
//   ＝ z15 にすると切れる建物が 18→2 に減り、精度は落ちない。タイルの枚数も 1/4 で軽い。
//   window.__GSI_VECTOR_ZOOM = 16 で戻せる（陽性対照）。
function gsiVectorZoom() { const v = (typeof window !== 'undefined') ? window.__GSI_VECTOR_ZOOM : null;
  return (Number.isFinite(v) && v >= 10 && v <= 16) ? v : 15; }
const GSI_VECTOR_ZOOM = 15;      // 既定。実際に使うのは gsiVectorZoom()
// 取り込む地物。種類を増やすときはここに1行足す（判定を各所に書かない）
const GSI_BUILDING_FT = { 3101: '普通建物', 3102: '堅ろう建物', 3103: '高層建物', 3111: '普通無壁舎', 3112: '堅ろう無壁舎' };
const GSI_STRUCTURE_FT = { 4302: 'タンク' };
// ══ 道路（線 → 幅を持たせて面に）・2026-11-24 ユーザー指示 ══
// 【事実（実測）】road レイヤの地物は **型2（線）**。面ではない。z16で46件・z15で94件・z14で169件
//   （z17 には road レイヤが無い）。属性 Width（実幅員）は仕様書にあるが**実データには1件も無い**
//   （z14/15/16 とも0件）ので、幅は区分 rnkWidth から決めるしかない。
// 【rnkWidth の仕様】出典 https://maps.gsi.go.jp/help/pdf/vector/attribute.pdf （地物等の属性一覧）
//   0=3m未満 1=3m以上5.5m未満 2=5.5m以上13m未満 3=13m以上19.5m未満 4=19.5m以上 5=その他 6=不明
//   代表幅は**範囲の中央**を採る。区分なので最大±3.5mずれる（_src.幅未確定 で印を立てる）。
const GSI_ROAD_WIDTH = { 0: 2.5, 1: 4.2, 2: 9.2, 3: 16.2, 4: 22, 5: 4, 6: 4 };
// 【rdCtg の仕様】同じ出典。0=国道 1=都道府県道 2=市区町村道 3=高速自動車国道等 5=その他 6=不明
const GSI_ROAD_CTG = { 0: '国道', 1: '都道府県道', 2: '市区町村道', 3: '高速自動車国道等', 5: 'その他', 6: '不明' };

// 【なぜ「掃引」を採らなかったか・実測して決めた（2026-11-24）】
//   SHAPE_MODEL_SPEC の正規の表現は掃引（断面 × 経路）で、折れ線の経路 poly も矩形断面 rect も
//   makeSweptBlock も既にあり、道路はそれで作れる（実測: 面10個の立体ができた）。
//   **採らなかった理由は平面図**。掃引のブロックの points は「始点に置いた断面」なので、
//   平面図・断面図・部屋認識・壁厚・寸法・当たり判定が読むのは幅9m×厚み0.1mの矩形1つだけ。
//   実測: makeSweptBlock(中心線,0,{kind:rect,wM:9,hM:0.1},0) の points の範囲は x:-41.9〜41.9 /
//   y:0〜0.9 ＝ **道路の形が平面図に出ない**（SPEC §3.10 の既知の負債）。
//   負債を直すには「1ブロック＝1ポリゴン」という平面図の契約を変える必要があり、影響が広い。
//   そこで段階1では**太らせた多角形**（＝ふつうの建屋と同じ blocks[].points）にする。
//   ★ただし中心線と幅は _src に残すので、負債が直ったら makeSweptBlock で作り直せる。
//   そのときこの関数を捨てればよい（形の型は増やしていないので捨てられる）。

// 折れ線を幅で太らせて輪にする（純関数・DOM も window も読まない）
// 【単位】タイル内座標でそのまま計算する。緯度経度のまま法線を取ると縦横の縮尺が違って幅が歪む。
// 【自己交差を作らない】急な折れでは内側が必ず折り返す（ミター上限では防げない）。
//   折れ角がしきい値より急な点、または区間が幅の半分より短い所で**折れ線を切る**。
//   切れ目は同じ幅・同じ色の帯が隣り合うだけなので見た目はつながる（面は別になる）。
// 戻り: [{ ring: 輪, core: その帯の中心線 }]（1本の線が複数の帯に割れることがある）
// ★**帯ごとに自分の中心線を返す**。割れたのに元の線の全点を付けると、どの帯も同じ中心線を
//   指すことになり「同じ場所に2つある」と見える（2026-11-24 の検査 R4 で実際に12件出た）。
function gsiThickenLine(pts, 幅) {
  if (!pts || pts.length < 2 || !(幅 > 0)) return [];
  const h = 幅 / 2;
  // 同じ点・ごく近い点を落とす（法線が出せない）
  const p = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i], r = p[p.length - 1];
    if (Math.hypot(q.x - r.x, q.y - r.y) > 1e-6) p.push(q);
  }
  if (p.length < 2) return [];
  // ── 切る位置を決める（折れが急／区間が短い／閉路）──
  const 区切 = [0];
  for (let i = 1; i < p.length - 1; i++) {
    const a = { x: p[i].x - p[i - 1].x, y: p[i].y - p[i - 1].y };
    const b = { x: p[i + 1].x - p[i].x, y: p[i + 1].y - p[i].y };
    const La = Math.hypot(a.x, a.y), Lb = Math.hypot(b.x, b.y);
    const cos = (a.x * b.x + a.y * b.y) / ((La * Lb) || 1);
    // cos < 0.2 ≒ 折れ角 78°以上。内側が折り返す（h/tan(θ/2) が区間長を超える）
    // ★**短い区間では切らない**（2026-11-24 ユーザー報告「海苔で弁当作ったみたい」）。
    //   曲がり角には 1〜5m の短い区間が並んでいるので、そこで切ると 0.6m の帯が量産される。
    //   短い区間は呼ぶ側が gsiThinLine(.., 幅*0.6) で**先に間引く**。ここで切るのは急な折れだけ。
    if (cos < 0.2) 区切.push(i);
  }
  区切.push(p.length - 1);
  // 閉路（始点＝終点）は必ず切る＝穴つきの輪を作らない（面は穴を持てない・SPEC §3.7）
  const 出 = [];
  for (let k = 0; k + 1 < 区切.length; k++) {
    const 部 = p.slice(区切[k], 区切[k + 1] + 1);
    if (部.length < 2) continue;
    // 自己交差したら真ん中で割って作り直す（2回まで）。それでも交わるなら捨てる（fail-closed）
    for (const 片 of _gsiSplitUntilSimple(部, h, 2)) {
      // 【幅より短い帯は出さない・2026-11-24】急な折れで切った残り（実測 0.6m・1.3m…）は
      //   道路に見えず、短い長方形が並んで「海苔」に見える元になる。隣の帯が繋がって見えるので捨ててよい。
      let _L = 0;
      for (let i = 1; i < 片.length; i++) _L += Math.hypot(片[i].x - 片[i - 1].x, 片[i].y - 片[i - 1].y);
      if (_L < 幅) continue;
      const 輪 = _gsiBand(片, h);
      if (輪 && !_gsiSelfCross(輪)) 出.push({ ring: 輪, core: 片 });
    }
  }
  return 出;
}
// 帯が自己交差するなら半分に割る（再帰）。葉なので csgPolyContour は呼べない（読み込み順）
function _gsiSplitUntilSimple(部, h, 残り) {
  const 輪 = _gsiBand(部, h);
  if (!輪 || !_gsiSelfCross(輪)) return [部];
  if (残り <= 0 || 部.length < 4) return [部];   // これ以上割れない（呼ぶ側が捨てる）
  const m = Math.floor(部.length / 2);
  return _gsiSplitUntilSimple(部.slice(0, m + 1), h, 残り - 1)
    .concat(_gsiSplitUntilSimple(部.slice(m), h, 残り - 1));
}
// 隣り合っていない辺どうしが交わっているか（csgPolyContour の③と同じ式。葉から呼べないので持つ）
function _gsiSelfCross(c) {
  const N = c.length;
  if (N < 4) return false;
  const d = (x1, y1, x2, y2, x3, y3) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  for (let i = 0; i < N; i++) {
    const a1 = c[i], a2 = c[(i + 1) % N];
    for (let j = i + 2; j < N; j++) {
      if (i === 0 && j === N - 1) continue;   // 隣り合う辺
      const b1 = c[j], b2 = c[(j + 1) % N];
      const d1 = d(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
      const d2 = d(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
      const d3 = d(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
      const d4 = d(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
  }
  return false;
}
// 折れ線を幅で太らせて**1つの輪**にする（切らない・捨てない）。**塗り専用**
// 【なぜ切らないか・2026-11-24】立体（面）は自己交差できないので gsiThickenLine は急な折れで
//   切っていた。その切れ目がユーザー報告の「帯が切れる」「海苔で弁当作ったみたい」。
//   **塗りなら自己交差は無害**（非ゼロ則で塗られる）ので、切る必要がそもそも無い。
function gsiBandRing(pts, 幅) {
  if (!pts || pts.length < 2 || !(幅 > 0)) return null;
  const p = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i], r = p[p.length - 1];
    if (Math.hypot(q.x - r.x, q.y - r.y) > 1e-6) p.push(q);
  }
  if (p.length < 2) return null;
  return _gsiBand(p, 幅 / 2);
}
// 1本の（折れの緩い）折れ線を帯にする
function _gsiBand(p, h) {
  const 左 = [], 右 = [];
  for (let i = 0; i < p.length; i++) {
    let dx = 0, dy = 0;
    if (i > 0) { const a = p[i].x - p[i - 1].x, b = p[i].y - p[i - 1].y, L = Math.hypot(a, b) || 1; dx += a / L; dy += b / L; }
    if (i < p.length - 1) { const a = p[i + 1].x - p[i].x, b = p[i + 1].y - p[i].y, L = Math.hypot(a, b) || 1; dx += a / L; dy += b / L; }
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) { dx = 1; dy = 0; } else { dx /= L; dy /= L; }
    // 角の外側は 1/cos(θ/2) 倍に伸びる。伸ばしすぎないよう上限（ミター）を付ける
    let 倍 = 1;
    if (i > 0 && i < p.length - 1) {
      const ax = p[i].x - p[i - 1].x, ay = p[i].y - p[i - 1].y, La = Math.hypot(ax, ay) || 1;
      const cos半 = Math.abs((ax / La) * dx + (ay / La) * dy);
      倍 = (cos半 > 0.5) ? 1 / cos半 : 2;
    }
    左.push({ x: p[i].x - dy * h * 倍, y: p[i].y + dx * h * 倍 });
    右.push({ x: p[i].x + dy * h * 倍, y: p[i].y - dx * h * 倍 });
  }
  const 輪 = 左.concat(右.reverse());
  return 輪.length >= 3 ? 輪 : null;
}
// 線をタイルの内側だけに切る（余白ぶん＝約10m が隣のタイルと重複するのを防ぐ）
// 【線は重心では絞れない】面と違い、1本の線は複数のタイルにまたがるのが普通。
//   「重心がタイル内」で絞ると、境界をまたぐ道路がどちらのタイルでも採られない／二重になる。
//   だから縁でクリップする。切れ目は同じ幅の帯が隣り合うだけなので見た目はつながる。
function gsiClipLineToTile(pts, ext) {
  const 内 = (q) => q.x >= 0 && q.x <= ext && q.y >= 0 && q.y <= ext;
  const 交 = (a, b) => {   // a（内）→ b（外）の、縁との交点
    let t = 1;
    const f = (num, den) => { if (Math.abs(den) > 1e-12) { const u = num / den; if (u >= 0 && u < t) t = u; } };
    f(0 - a.x, b.x - a.x); f(ext - a.x, b.x - a.x);
    f(0 - a.y, b.y - a.y); f(ext - a.y, b.y - a.y);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const 出 = []; let 今 = [];
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    if (内(q)) { 今.push(q); continue; }
    // 外の点：直前が内なら縁まで伸ばして区間を閉じる
    if (今.length) { 今.push(交(pts[i - 1], q)); 出.push(今); 今 = []; }
    // 次が内なら縁から始める
    if (i + 1 < pts.length && 内(pts[i + 1])) 今 = [交(pts[i + 1], q)];
  }
  if (今.length >= 2) 出.push(今);
  return 出.filter(a => a.length >= 2);
}
// 線の間引き（両端は必ず残す。輪用の gsiThinRing は始点と終点をつなげて見るので線には使えない）
// 【最小m は「この間隔より近い点は落とす」・2026-11-24】
//   道路では**幅の 0.6 倍**を渡す。幅 w の帯は、区間が w/2 より短いと内側が必ず折り返すので、
//   先に間引いて折り返しの種を無くす（折り返しを「切って」避けると短い帯が並ぶ＝海苔になる）。
function gsiThinLine(pts, 単位m, 最小m) {
  if (!pts || pts.length < 3) return pts || [];
  const 最小 = (Number.isFinite(最小m) ? 最小m : GSI_MIN_EDGE_M) / 単位m;
  const 出 = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const r = 出[出.length - 1];
    if (Math.hypot(pts[i].x - r.x, pts[i].y - r.y) >= 最小) 出.push(pts[i]);
  }
  出.push(pts[pts.length - 1]);
  return 出;
}
// 【レイヤごとの扱いは表1つ・2026-11-24】面か線かの旗ではなく、幅・高さ・色・上限まで
//   ここで持つ。取り込み先（App.jsx の importMapBuildings）に `if (種別==="道路")` を書かない。
//   ft: ftCode→種別名の表（null なら ftCode を見ない）／ftで絞らないときは 必須属性 で絞る。
const GSI_IMPORT_LAYERS = {
  // ★ 上限を省いた行は実行時に GSI_IMPORT_MAX を見る（この表は GSI_IMPORT_MAX より前に
  //   評価されるので、ここに書くと「初期化前に参照」で**モジュールごと止まる**。2026-11-24 に踏んだ）
  // ズーム: そのレイヤを読むタイルのズーム（省略＝既定 gsiVectorZoom()）。
  //   建物は z15（タイルが4倍広いので境目で切れにくい。形は z16 と同じ）、
  //   道路は z16（z15 では徒歩道・庭園路が配信されていない＝実測 81件→0件）。
  // 色: そのレイヤの建物の色（省略＝App 側が取り込みの通し番号で振る＝従来）。
  //   【通し番号で振ると1棟が2色になる・2026-11-25 ユーザー報告】地理院は1棟を
   //   「普通建物(3101)＋無壁舎(3111)」の2地物で配信することがある（実測 1291件中12組）。
   //   番号で色を振ると**その2つは必ず違う色**になり、3次元図で2つの箱に見える。
   //   レイヤごとに1色なら、同じレイヤの隣接は同じ色＝1棟に見える。
  building:   { ft: GSI_BUILDING_FT,  型: 3, ズーム: 15, 色: '#A8B2BD' },
  structurea: { ft: GSI_STRUCTURE_FT, 型: 3, ズーム: 15, 色: '#B3ACA2' },
  // 道路は線。幅は rnkWidth（無ければ既定）。高さは薄い板。色は灰色
  // 【中心線だけ取り込む・2026-11-27 ユーザー報告「なぜ幅を3つに分割するのか」】
  //   road レイヤには **27xx＝道路中心線**（区分 rdCtg・幅員 rnkWidth を持つ）のほかに
  //   **22xx＝道路縁**（道路の両側の線。幅員なし）と **24xx＝道路構成線**（トンネル内・分離帯）が同じレイヤで入っている
  //   （地理院地図Vector の標準地図スタイル data/std.json で確認: 27xx は「国道／都道府県道／市区町村道…」の
  //   幅員ごとの線、22xx・24xx は区分の無い細い灰色の線で、地図を拡大したときだけ描く道路の輪郭）。
  //   ftCode で絞らずに全部を帯にしていたので、1本の道路が「中心線の帯＋左右の縁の帯」の**3本**になっていた。
  //   中心線（徒歩道 2721〜・庭園路 2711〜・石段 2731〜 も中心線）だけを取る。範囲は ft範囲 1か所。
  //   旗 globalThis.__GSI_ROAD_CENTERLINE_ONLY = false で従来（縁の線も帯にする）＝陽性対照。
  road:       { ft: null, ft範囲: [2700, 2799], ft範囲の旗: '__GSI_ROAD_CENTERLINE_ONLY',
                型: 2, 名: '道路', 区分: GSI_ROAD_CTG, 幅の表: GSI_ROAD_WIDTH,
                既定幅m: 2, 高さm: 0.12, 色: '#9CA3AF', 上限: 300,
                // 段階フラグ（globalThis.__GSI_ROAD = false で道路を取らない＝陽性対照）
                // 【立体でなく地面に塗る・2026-11-24 ユーザー裁定「道の厚みは求めていない」】
                //   帯（輪）はここで作らない。**中心線と幅だけ**を渡し、描く側が地面の起伏に
                //   乗せて帯を作る。塗りなら自己交差は無害なので「急な折れで切る」が要らなくなり、
                //   ユーザー報告の「帯が切れる」「海苔で弁当」が構造的に消える（Codex監査の必須条件）。
                塗る: true,
                ズーム: 16,
                旗: '__GSI_ROAD' },
};
const GSI_IMPORT_MAX = 400;      // 一度に取り込む上限（3次元図が重くなるため）
const GSI_MIN_EDGE_M = 0.1;      // これより短い辺は落とす
const GSI_STRAIGHT_M = 0.05;     // 一直線とみなす許容

// ── 小さな protobuf 読み（MVT に要る分だけ）──
function gsiPbVarint(b, p) { let r = 0, s = 0, by; do { by = b[p++]; r |= (by & 0x7f) << s; s += 7; } while (by & 0x80); return [r >>> 0, p]; }

// Mapbox Vector Tile を読む。戻り: [{ name, keys, extent, feats:[{gtype, geom, props}] }]
function gsiDecodeVectorTile(buf) {
  const dec = new TextDecoder();
  const layers = [];
  let p = 0;
  while (p < buf.length) {
    let k; [k, p] = gsiPbVarint(buf, p);
    const tag = k >> 3, wt = k & 7;
    if (wt !== 2) {
      if (wt === 0) { let v; [v, p] = gsiPbVarint(buf, p); }
      else if (wt === 5) p += 4; else if (wt === 1) p += 8; else break;
      continue;
    }
    let len; [len, p] = gsiPbVarint(buf, p);
    if (tag === 3) layers.push(gsiDecodeLayer(buf.subarray(p, p + len), dec));
    p += len;
  }
  return layers.filter(Boolean);
}

function gsiDecodeLayer(sub, dec) {
  let q = 0, name = '', keys = [], vals = [], extent = 4096, raw = [];
  while (q < sub.length) {
    let k; [k, q] = gsiPbVarint(sub, q);
    const t = k >> 3, w = k & 7;
    if (w === 0) { let v; [v, q] = gsiPbVarint(sub, q); if (t === 5) extent = v; continue; }
    if (w !== 2) { if (w === 5) q += 4; else if (w === 1) q += 8; else break; continue; }
    let len; [len, q] = gsiPbVarint(sub, q);
    const seg = sub.subarray(q, q + len);
    if (t === 1) name = dec.decode(seg);
    else if (t === 3) keys.push(dec.decode(seg));
    else if (t === 4) vals.push(gsiDecodeValue(seg, dec));
    else if (t === 2) raw.push(gsiDecodeFeature(seg));
    q += len;
  }
  const feats = raw.map(f => {
    const props = {};
    for (let i = 0; i + 1 < f.tags.length; i += 2) props[keys[f.tags[i]]] = vals[f.tags[i + 1]];
    return { gtype: f.gtype, geom: f.geom, props };
  });
  return { name, keys, extent, feats };
}

function gsiDecodeValue(seg, dec) {
  let p = 0, v = null;
  while (p < seg.length) {
    let k; [k, p] = gsiPbVarint(seg, p);
    const t = k >> 3, w = k & 7;
    if (w === 2) { let l; [l, p] = gsiPbVarint(seg, p); if (t === 1) v = dec.decode(seg.subarray(p, p + l)); p += l; }
    else if (w === 0) { let n; [n, p] = gsiPbVarint(seg, p); if (t === 4 || t === 5) v = n; else if (t === 6) v = (n >> 1) ^ (-(n & 1)); else if (t === 7) v = !!n; }
    else if (w === 5) { v = new DataView(seg.buffer, seg.byteOffset + p, 4).getFloat32(0, true); p += 4; }
    else if (w === 1) { v = new DataView(seg.buffer, seg.byteOffset + p, 8).getFloat64(0, true); p += 8; }
    else break;
  }
  return v;
}

function gsiDecodeFeature(seg) {
  let p = 0, gtype = 0, geom = [], tags = [];
  while (p < seg.length) {
    let k; [k, p] = gsiPbVarint(seg, p);
    const t = k >> 3, w = k & 7;
    if (w === 0) { let v; [v, p] = gsiPbVarint(seg, p); if (t === 3) gtype = v; }
    else if (w === 2) {
      let l; [l, p] = gsiPbVarint(seg, p);
      const g = seg.subarray(p, p + l);
      if (t === 4) { let s = 0; while (s < g.length) { let v; [v, s] = gsiPbVarint(g, s); geom.push(v); } }
      else if (t === 2) { let s = 0; while (s < g.length) { let v; [v, s] = gsiPbVarint(g, s); tags.push(v); } }
      p += l;
    } else if (w === 5) p += 4; else if (w === 1) p += 8; else break;
  }
  return { gtype, geom, tags };
}

// コマンド列 → タイル内座標のリング配列（MoveTo=1 / LineTo=2 / ClosePath=7・ジグザグ）
function gsiMvtRings(geom) {
  const rings = []; let i = 0, x = 0, y = 0, cur = null;
  while (i < geom.length) {
    const c = geom[i++], id = c & 7, cnt = c >> 3;
    if (id === 1) {
      for (let k = 0; k < cnt; k++) {
        x += (geom[i] >> 1) ^ (-(geom[i] & 1)); i++;
        y += (geom[i] >> 1) ^ (-(geom[i] & 1)); i++;
        if (cur && cur.length) rings.push(cur);
        cur = [{ x, y }];
      }
    } else if (id === 2) {
      for (let k = 0; k < cnt; k++) {
        x += (geom[i] >> 1) ^ (-(geom[i] & 1)); i++;
        y += (geom[i] >> 1) ^ (-(geom[i] & 1)); i++;
        if (cur) cur.push({ x, y });
      }
    } else if (id === 7) { if (cur && cur.length) { rings.push(cur); cur = null; } }
    else break;
  }
  if (cur && cur.length) rings.push(cur);
  return rings;
}

// 符号付き面積（MVT v2: 外周は正、穴は負）
function gsiRingArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

// 短い辺・一直線上の点を落とす（押し引きや壁厚の帯が極小の辺で崩れるため）
function gsiThinRing(ring, 単位m) {
  const 最小 = GSI_MIN_EDGE_M / 単位m, 直 = GSI_STRAIGHT_M / 単位m;
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (q && Math.hypot(p.x - q.x, p.y - q.y) < 最小) continue;
    out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 最小) out.pop();
  if (out.length < 3) return out;
  const 残 = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const dx = c.x - a.x, dy = c.y - a.y, L = Math.hypot(dx, dy);
    if (L > 0) { const d = Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx) / L; if (d < 直) continue; }
    残.push(b);
  }
  return 残.length >= 3 ? 残 : out;
}

async function gsiFetchArrayBuffer(url) {
  try {
    const res = await fetch(gsiResolveUrl(url));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) { return null; }
}

// ══ タイルの境目で切れた形をつなぐ・2026-11-24 ══
// 【症状・ユーザー報告】「鍵のような構造物が3つに分かれている。国土地理院では1つの閉曲面だ」
// 【原因】ベクトルタイルは**タイルごとに切って**配信される。1タイル（z16で約511m）に
//   収まらない建物は、タイルの縁（余白ぶん外まで）で**直線に切られた断片**になる。
//   実測: 鍵型の19点のうち4点が同じ y に並んでいた＝切断面。
// 【直し方】隣のタイルの断片とは**切断面の点が完全に一致する**（同じ緯度経度）。
//   一致する点が2つ以上続く組を見つけ、その区間（＝切断面）を捨てて輪をつなぎ直す。
//   座標はタイルの縁で厳密に同じ値になるので、丸めずに突き合わせられる（念のため7桁で丸める）。
// 【つながらなければそのまま】無理につながない（fail-closed）。件数は知らせに出す。
function gsiRingKey(p) { return p.lat.toFixed(7) + '|' + p.lng.toFixed(7); }

// ══ 輪の融合は純関数1つ・2026-11-26（旧 gsiStitchPair を置き換え）══
// 【なぜ作り直したか】旧実装には次の5つの誤りがあり、実測で25点の建物が消えて既定OFFだった。
//   ①突き合わせが緯度経度の toFixed(7)（丸めの境目で外れる）
//   ②`試(1) || 試(-1)` で両向きを試す（外周は面積が正のものだけ採るので共有辺は**必ず逆向き**＝両試しは誤り）
//   ③同じ座標の「最初の出現」しか Map に持たない（重複点でずれる）
//   ④`if (位.has(…) && inB.includes(i)) { }` が**空のブロック**
//   ⑤融合後の検査（自己交差・面積・頂点の重複）が無い
// 【引数】A・B は `{x, y}` の**整数の通し座標**（`tx * ext + x`）。
//   既存の gsiRingArea / _gsiSelfCross / gsiThinRing はどれも {x,y} の配列を受けるのでそのまま通せる。
// 【戻り】{ 輪 } ／ できなければ { 理由 }（**fail-closed**。無理につながない。理由は知らせに出す）

// 2倍面積（符号付き・整数）。**先頭点を原点へ平行移動**してから計算する。
//   通し座標は z15・ext4096 で約1.3e8。そのまま掛けると積が 1.7e16 で 2^53(9e15) を超え、
//   整数として厳密に扱えない（監査の必須条件）。差にすれば建物の大きさ（数千）なので安全。
function gsiRingArea2(R) {
  if (!R || R.length < 3) return 0;
  const ox = R[0].x, oy = R[0].y;
  let a = 0;
  for (let i = 0; i < R.length; i++) {
    const q = R[i], r = R[(i + 1) % R.length];
    a += (q.x - ox) * (r.y - oy) - (r.x - ox) * (q.y - oy);
  }
  return a;
}

function gsiMergeRingPair(A, B) {
  if (!Array.isArray(A) || !Array.isArray(B) || A.length < 3 || B.length < 3) return { 理由: '点が足りない' };
  const 鍵 = (q) => q.x + ',' + q.y;
  // B の座標 → その座標が現れる位置の**全部**（③の修正。重複点があっても取りこぼさない）
  const 位 = new Map();
  B.forEach((q, i) => { const k = 鍵(q); if (!位.has(k)) 位.set(k, []); 位.get(k).push(i); });
  const inB = A.map(q => 位.has(鍵(q)));
  if (!inB.some(v => v)) return { 理由: '共有点なし' };
  if (inB.every(v => v)) return { 理由: 'A が丸ごと B の上' };
  // A の中で「B にもある点」が連続する区間を**全部**拾う（輪なので回り込む）
  const 区 = [];
  for (let s0 = 0; s0 < A.length; s0++) {
    if (!inB[s0]) continue;
    if (inB[(s0 - 1 + A.length) % A.length]) continue;   // 区間の先頭だけを見る
    let L = 0;
    while (L < A.length && inB[(s0 + L) % A.length]) L++;
    区.push({ 開: s0, 長: L });
  }
  // 【区間が2か所以上なら融合しない】コの字が相手を挟む形・ロの字を閉じる最後の1片では、
  //   1か所だけ捨てると輪が自分に触れる（＝自己交差）。2箱が0箱になるので触らない。
  if (区.length !== 1) return { 理由: '共有の区間が' + 区.length + 'か所' };
  const { 開, 長 } = 区[0];
  if (長 < 2) return { 理由: '1点だけ接している' };
  if (長 >= A.length || 長 >= B.length) return { 理由: '片方が片方に含まれる' };
  // 【共有列は一直線か】切断面はタイルの縁（直線）なので、共有列は必ず一直線に並ぶ。
  //   斜めの辺を共有する「隣り合う別の地物」をここで外せる（タイル番号でなく幾何で判る）。
  let 同x = true, 同y = true;
  for (let k = 1; k < 長; k++) {
    const q = A[(開 + k) % A.length], r = A[(開 + k - 1) % A.length];
    if (q.x !== r.x) 同x = false;
    if (q.y !== r.y) 同y = false;
  }
  if (!同x && !同y) return { 理由: '共有列が一直線でない' };
  // 外周の向きは揃っている（面積が正のものだけ採る）ので、共有列は B では**逆順**に現れる。
  //   A の共有列 a0..a_{L-1} に対し、B では a_{L-1} から順方向に並ぶ。向きは試さない（②の修正）。
  const a頭 = 開, a尾 = (開 + 長 - 1) % A.length;
  const 候補 = 位.get(鍵(A[a尾])) || [];
  let 最後の理由 = '向きが合う並びが無い';
  for (const b0 of 候補) {
    let 合 = true;
    for (let k = 0; k < 長; k++) {
      const bq = B[(b0 + k) % B.length];
      const aq = A[(a尾 - k + A.length * 2) % A.length];
      if (bq.x !== aq.x || bq.y !== aq.y) { 合 = false; break; }
    }
    if (!合) continue;
    // A の非共有側（a尾 から順方向に a頭 まで）＋ B の非共有側（b0+長 から b0 の手前まで）
    const 輪 = [];
    for (let k = 0; k < A.length; k++) {
      const i = (a尾 + k) % A.length;
      輪.push(A[i]);
      if (k > 0 && i === a頭) break;
    }
    for (let k = 長; k < B.length; k++) 輪.push(B[(b0 + k) % B.length]);
    if (輪.length < 3) { 最後の理由 = 'つないだ輪が3点未満'; continue; }
    // ── 検査（1つでも外れたら採らない＝fail-closed）──
    let 退 = false;
    for (let i = 0; i < 輪.length; i++) {
      const q = 輪[i], r = 輪[(i + 1) % 輪.length];
      if (q.x === r.x && q.y === r.y) { 退 = true; break; }
    }
    if (退) { 最後の理由 = '頂点が重なる'; continue; }
    if (typeof _gsiSelfCross === 'function' && _gsiSelfCross(輪)) { 最後の理由 = '自己交差'; continue; }
    // 【面積は2倍面積の整数で厳密に比べる】共有部分は面積0なので、つないだ輪は A と B の和になる。
    //   重なり・向き違い・誤った区間のどれでも崩れる＝**一番強い検査**（監査）。許容誤差は置かない。
    const 面2 = gsiRingArea2(輪), a2 = gsiRingArea2(A), b2 = gsiRingArea2(B);
    if (!(面2 > 0)) { 最後の理由 = '向きが反転した'; continue; }
    if (面2 !== Math.abs(a2) + Math.abs(b2)) { 最後の理由 = '面積が合わない(' + 面2 + ' ≠ ' + (Math.abs(a2) + Math.abs(b2)) + ')'; continue; }
    return { 輪 };
  }
  return { 理由: 最後の理由 };
}
// 切れた断片どうしをつなぐ。戻り: { items, つないだ, 試した, 理由 }
// 【突き合わせは間引き前の整数の通し座標】item の `_生` を使う。
//   間引き（gsiThinRing）の後だと片方の点だけが落ちて共有列の端がずれる（実測 5点→4点）。
// 【融合したら間引き直して緯度経度に戻す】ring の作り方を2通り持たない。
function gsiStitchCut(items) {
  const 生 = items.slice();
  let つないだ = 0, 試した = 0;
  const 理由 = {};
  const 数 = (r) => { 理由[r] = (理由[r] || 0) + 1; };
  // 【決定性】試す順は key 順に固定（並び順で結果が変わらないように）
  const 順 = 生.map((x, i) => i)
    .filter(i => 生[i] && 生[i].cut && Array.isArray(生[i]._生))
    .sort((a, b) => String(生[a].key).localeCompare(String(生[b].key)));
  if (順.length < 2) return { items, つないだ: 0, 試した: 0, 理由 };
  // 縁に乗る点が残っているか（融合後の cut を**再計算**する。引き継ぎでも一律解除でもない＝監査）
  const _縁 = (輪, ext) => 輪.some(q => (q.x % ext === 0) || (q.y % ext === 0));
  for (let 回 = 0; 回 < 4; 回++) {
    let 変 = false;
    for (const i of 順) {
      const a = 生[i]; if (!a || !Array.isArray(a._生)) continue;
      for (const j of 順) {
        if (j === i) continue;
        const b = 生[j]; if (!b || !Array.isArray(b._生)) continue;
        // 同じレイヤ・同じ種別コードだけ（普通建物と無壁舎を融合しない＝ユーザー裁定の担保）
        if (a.layer !== b.layer || a.ftCode !== b.ftCode) continue;
        // 同じ z・同じ ext・**別のタイル**だけ（同じタイル内の隣接は融合しない）
        if (a._z !== b._z || a._ext !== b._ext) continue;
        if (a._tx === b._tx && a._ty === b._ty) continue;
        試した++;
        const r = gsiMergeRingPair(a._生, b._生);
        if (!r.輪) { 数(r.理由 || '不明'); continue; }
        const 細 = gsiThinRing(r.輪, a._単位m || 1);
        if (細.length < 3) { 数('間引きで3点未満'); continue; }   // 融合を取り消す（監査）
        const ll = 細.map(q => ({
          lat: gsiTileYToLat(q.y / a._ext, a._z),
          lng: gsiTileXToLng(q.x / a._ext, a._z),
        }));
        // 【key は構成を全部持つ】融合後に新しい key だけにすると、取り込み済みの図で
        //   A・B の上に AB が重なる。どれか既存なら重複として弾けるようにする。
        const _ks = [...(a._keys || [a.key]), ...(b._keys || [b.key])];
        生[i] = { ...a, ring: ll, _生: r.輪, _keys: _ks, cut: _縁(r.輪, a._ext) };
        生[j] = null;
        つないだ++; 変 = true; 数('つないだ');
        break;
      }
    }
    if (!変) break;
  }
  return { items: 生.filter(Boolean), つないだ, 試した, 理由 };
}
// ══ 中心線を端点でつなぐ・2026-11-24 ══
// 【なぜ】ベクトルタイルは1本の道路を、属性の変わり目やタイルの境目で**複数の地物**に分けて配信する。
//   そのまま帯にすると「1つの道路が3つの帯」に見える（ユーザー報告）。
// 【つなぐ条件】①端点が一致 ②その点に**2本だけ**（3本以上＝分岐点なので切る）③幅が同じ
//   ＝交差点では切れたまま。塗りなので交差点は重なって1枚に見える。
// 【向き】つなぐときに向きをそろえる（端点がどちらに来るかで反転させる）。
function gsiJoinLines(items) {
  const 対象 = items.filter(x => x && x.塗る && Array.isArray(x.中心線) && x.中心線.length >= 2);
  if (対象.length < 2) return { items, つないだ: 0 };
  const 鍵 = (q) => q.lat.toFixed(6) + ',' + q.lng.toFixed(6);
  const 生 = 対象.slice();
  let つないだ = 0;
  // 【つなげなくなるまで回す・2026-11-26 ユーザー報告「相変わらず複数の面でぺたぺた」】
  //   1周で必ず1本減るので上限は本数＋余裕で足りる（以前は 8 固定で、長い道路が
   //   8本つないだ時点で打ち切られ、残りが別の帯のまま描かれていた）。
  //   旗 globalThis.__GSI_JOIN_MAX に数を入れるとその回数で打ち切る（8 で従来＝陽性対照）。
  const _上限 = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__GSI_JOIN_MAX))
    ? globalThis.__GSI_JOIN_MAX : (対象.length + 4);
  for (let 回 = 0; 回 < _上限; 回++) {
    // 端点 → その端点を持つ線の番号
    const 端 = new Map();
    生.forEach((s, i) => {
      if (!s) return;
      for (const k of [鍵(s.中心線[0]), 鍵(s.中心線[s.中心線.length - 1])]) {
        let a = 端.get(k); if (!a) { a = []; 端.set(k, a); }
        a.push(i);
      }
    });
    let 変 = false;
    for (const [k, v] of 端) {
      if (v.length !== 2) continue;                 // 分岐点・端っこは触らない
      const [i, j] = v;
      if (i === j) continue;                        // 自分で閉じている輪
      const A = 生[i], B = 生[j];
      if (!A || !B) continue;
      if (A.幅m !== B.幅m) continue;                // 幅が違う＝別の道路
      const a0 = 鍵(A.中心線[0]), a1 = 鍵(A.中心線[A.中心線.length - 1]);
      const b0 = 鍵(B.中心線[0]), b1 = 鍵(B.中心線[B.中心線.length - 1]);
      // A の終わりに B の始まりが来るよう向きをそろえる
      let 甲 = A.中心線.slice(), 乙 = B.中心線.slice();
      if (a0 === k) 甲.reverse();                   // A の「始まり」が継ぎ目なら反転
      else if (a1 !== k) continue;
      if (b1 === k) 乙.reverse();                   // B の「終わり」が継ぎ目なら反転
      else if (b0 !== k) continue;
      乙.shift();                                   // 継ぎ目の点は1つでよい
      生[i] = Object.assign({}, A, { 中心線: 甲.concat(乙) });
      生[j] = null;
      つないだ++; 変 = true;
      break;                                        // 端の表が古くなるので作り直す
    }
    if (!変) break;
  }
  const 残 = 生.filter(Boolean);
  const 他 = items.filter(x => !(x && x.塗る && Array.isArray(x.中心線) && x.中心線.length >= 2));
  return { items: 他.concat(残), つないだ };
}
// 範囲内の建物・構造物をベクトルタイルから取り出す（**緯度経度のまま**返す）
// 【グリッド座標へは直さない】gsiTiles.js は葉（他のファイルを呼ばない）。
//   geoToGrid は cesiumUtils.js にあり読み込み順でここからは呼べない。標高タイルと同じ分け方。
// 戻り: { items:[{ layer, ftCode, 種別, ring:[{lat,lng}], key }], 穴, 範囲外, タイル数, 上限超過 }
async function gsiLoadBuildings(bounds, opts) {
  const o = opts || {};
  const items = []; let 穴 = 0, 範囲外 = 0, 余白 = 0, 切れ = 0, 上限超過 = false;
  let 範囲外の種類 = 0;   // ft範囲の外で取らなかった地物（道路の縁の線など）
  // 【上限はレイヤごと・2026-11-24】建物と道路で枠を分ける。混ぜると道路が枠を食って建物が途中で止まる
  const 層数 = {};
  const 鍵 = new Set();
  let タイル総数 = 0;
  // 【レイヤごとにズームが違う・2026-11-24】表の「ズーム」でまとめ、ズームごとにタイルを読む。
  //   ここに `if (レイヤ名 === "road")` を書かない＝レイヤを足しても変えない（SPEC §1）。
  const _既定z = gsiVectorZoom();
  const _ズーム列 = [...new Set(Object.values(GSI_IMPORT_LAYERS).map(v => v.ズーム || _既定z))];
  for (const z of _ズーム列) {
  const _対象 = new Set(Object.keys(GSI_IMPORT_LAYERS)
    .filter(k => (GSI_IMPORT_LAYERS[k].ズーム || _既定z) === z));
  const x0 = Math.floor(gsiLngToTileX(bounds.west, z)), x1 = Math.floor(gsiLngToTileX(bounds.east, z));
  const y0 = Math.floor(gsiLatToTileY(bounds.north, z)), y1 = Math.floor(gsiLatToTileY(bounds.south, z));
  const タイル = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) タイル.push([tx, ty]);
  タイル総数 += タイル.length;
  for (let i = 0; i < タイル.length && !上限超過; i += 6) {
    const 組 = タイル.slice(i, i + 6);
    const bufs = await Promise.all(組.map(t => gsiFetchArrayBuffer(gsiTileUrl(GSI_VECTOR_KIND, z, t[0], t[1]))));
    for (let k = 0; k < 組.length && !上限超過; k++) {
      const buf = bufs[k]; if (!buf) continue;
      const tx = 組[k][0], ty = 組[k][1];
      const 緯 = gsiTileYToLat(ty + 0.5, z);
      const タイル幅m = 40075016.686 * Math.cos(緯 * Math.PI / 180) / Math.pow(2, z);
      for (const L of gsiDecodeVectorTile(buf)) {
        const 表 = GSI_IMPORT_LAYERS[L.name]; if (!表 || !_対象.has(L.name)) continue;
        // 旗を持つレイヤは false で止める（レイヤが増えても ここに if を足さない）
        if (表.旗 && typeof globalThis !== 'undefined' && globalThis[表.旗] === false) continue;
        const ext = L.extent || 4096;
        const 単位m = タイル幅m / ext;
        for (const f of L.feats) {
          // 【型の門はレイヤの表で決める】面（3）だけでなく線（2）も受ける
          if (f.gtype !== 表.型) continue;
          // 【ftCode の範囲で絞る・2026-11-27】表に ft範囲 があれば、その外の地物は取らない
          //   （道路は中心線 27xx だけ。縁の線 22xx・構成線 24xx を帯にしない）。旗が false なら絞らない。
          if (表.ft範囲 && !(表.ft範囲の旗 && typeof globalThis !== 'undefined' && globalThis[表.ft範囲の旗] === false)) {
            const _c = Number(f.props && f.props.ftCode);
            if (!(_c >= 表.ft範囲[0] && _c <= 表.ft範囲[1])) { 範囲外の種類++; continue; }
          }
          // 種別名: ft の表があればそれで絞る（無い ftCode は捨てる）。
          //   表が null のレイヤ（道路）は ftCode で絞らず、区分（rdCtg）があれば名前に添える。
          let 種別;
          if (表.ft) { 種別 = 表.ft[f.props && f.props.ftCode]; if (!種別) continue; }
          else {
            const _区 = 表.区分 && 表.区分[f.props && f.props.rdCtg];
            種別 = _区 ? (表.名 + '（' + _区 + '）') : 表.名;
          }
          // 線のときは太らせて輪にする（面のときは従来どおり）
          if (表.型 === 2) {
            const _rw = f.props && f.props.rnkWidth;
            const _幅m = (表.幅の表 && 表.幅の表[_rw] != null) ? 表.幅の表[_rw] : 表.既定幅m;
            const _幅未確定 = !(表.幅の表 && 表.幅の表[_rw] != null);
            let _n = 0;
            for (const 線 of gsiMvtRings(f.geom)) {
              if (線.length < 2) continue;
              for (const 片 of gsiClipLineToTile(線, ext)) {
                // 間引きは幅の 0.6 倍（描く側が地面の格子で刻み直すので、ここは粗くてよい）
                const 細 = gsiThinLine(片, 単位m, Math.max(GSI_MIN_EDGE_M, _幅m * 0.6));
                if (細.length < 2) continue;
                const 芯 = 細.map(pt => ({
                  lat: gsiTileYToLat(ty + pt.y / ext, z),
                  lng: gsiTileXToLng(tx + pt.x / ext, z),
                }));
                let la = 0, lo = 0; for (const q of 芯) { la += q.lat; lo += q.lng; }
                la /= 芯.length; lo /= 芯.length;
                if (la > bounds.north || la < bounds.south || lo < bounds.west || lo > bounds.east) { 範囲外++; continue; }
                const key = L.name + ':' + tx + '/' + ty + ':' + la.toFixed(6) + ',' + lo.toFixed(6) + ':' + (_n++);
                if (鍵.has(key)) continue;
                鍵.add(key);
                if ((層数[L.name] || 0) >= (表.上限 || GSI_IMPORT_MAX)) { 上限超過 = true; break; }
                層数[L.name] = (層数[L.name] || 0) + 1;
                // ★**輪（ring）を作らない**。中心線と幅だけ。帯は描く側が地面に乗せて作る
                items.push({ layer: L.name, ftCode: f.props.ftCode, 種別, key, 塗る: !!表.塗る,
                  中心線: 芯, 幅m: _幅m, color: 表.色,
                  srcAdd: { rnkWidth: _rw, rdCtg: f.props.rdCtg, 幅m: _幅m, 幅未確定: _幅未確定 } });
              }
              if (上限超過) break;
            }
            if (上限超過) break;
            continue;
          }
          for (const ring of gsiMvtRings(f.geom)) {
            if (ring.length < 3) continue;
            if (gsiRingArea(ring) < 0) { 穴++; continue; }
            const 細 = gsiThinRing(ring, 単位m); if (細.length < 3) continue;
            // 【タイルの余白にはみ出した分は採らない・2026-11-23 ユーザー報告「1つの建物が3つに分かれる」】
            //   ベクトルタイルは隣のタイルの地物を余白（buffer）ぶん含んでいる。実測では
            //   タイル境界の外 80単位（約10m）まで入っていた。そのまま採ると**同じ建物を
            //   2つのタイルから二重に取り込み**、しかも余白の端で切られた断片になるので、
            //   1つの建物が複数の構造物に見える（ユーザー報告の「鍵のような構造物が3つ」）。
            //   重心がそのタイルの内側にあるときだけ採る＝どの建物も「自分のタイル」で1回だけ採られる。
            let sx = 0, sy = 0; for (const q of 細) { sx += q.x; sy += q.y; }
            sx /= 細.length; sy /= 細.length;
            if (sx < 0 || sx >= ext || sy < 0 || sy >= ext) { 余白++; continue; }
            // 余白で切られた形は、辺がタイルの縁にぴったり乗る。知らせに出して気付けるようにする
            // タイルの縁に乗る点があれば「切れている」印（つなぎ直しの対象）
            // 【間引き前の輪で判定する・2026-11-26】間引き（gsiThinRing）は一直線上の点を落とすので、
            //   タイルの縁に乗る点が消えて `cut` が false になることがある。実測で、切られた組の
            //   片方（8点の断片）が false になり、つなぐ対象から外れていた。
            //   旗 globalThis.__GSI_CUT_BY_RAW = false で従来（間引き後で判定）＝陽性対照。
            const _切元 = !(typeof globalThis !== 'undefined' && globalThis.__GSI_CUT_BY_RAW === false) ? ring : 細;
            const _切 = _切元.some(q => q.x <= 0 || q.x >= ext || q.y <= 0 || q.y >= ext);
            if (_切) 切れ++;
            const ll = 細.map(pt => ({
              lat: gsiTileYToLat(ty + pt.y / ext, z),
              lng: gsiTileXToLng(tx + pt.x / ext, z),
            }));
            let la = 0, lo = 0; for (const q of ll) { la += q.lat; lo += q.lng; }
            la /= ll.length; lo /= ll.length;
            if (la > bounds.north || la < bounds.south || lo < bounds.west || lo > bounds.east) { 範囲外++; continue; }
            const key = L.name + ':' + la.toFixed(6) + ',' + lo.toFixed(6);
            if (鍵.has(key)) continue;
            鍵.add(key);
            if ((層数[L.name] || 0) >= (表.上限 || GSI_IMPORT_MAX)) { 上限超過 = true; break; }
            層数[L.name] = (層数[L.name] || 0) + 1;
            // 色は表から運ぶ（ここに `if (レイヤ名 === …)` を書かない＝SPEC §1）。
            //   旗 globalThis.__GSI_BLD_ONE_COLOR = false で渡さない＝App が通し番号で振る（従来・陽性対照）
            const _色 = !(typeof globalThis !== 'undefined' && globalThis.__GSI_BLD_ONE_COLOR === false)
              ? 表.色 : undefined;
            items.push({ layer: L.name, ftCode: f.props.ftCode, 種別, ring: ll, key, cut: _切,
              ...(_色 ? { color: _色 } : {}),
              // 【タイル切れをつなぐための生の座標・2026-11-26】間引き**前**の整数の通し座標。
               //   間引き後だと共有点が減って突き合わせが外れる（実測 5点→4点）。
               //   由来タイルも持つ（同じタイル内の隣接を融合しないため）。つなぎ終わったら捨てる。
              _生: ring.map(q => ({ x: tx * ext + q.x, y: ty * ext + q.y })),
              _z: z, _ext: ext, _単位m: 単位m, _tx: tx, _ty: ty });
          }
          if (上限超過) break;
        }
        if (上限超過) break;
      }
    }
    if (o.onProgress) o.onProgress(Math.min(i + 6, タイル.length), タイル.length, items.length);
  }
  }   // ズームごと
  // 【タイルの境目でつなぐ】切れた断片どうしを1つの輪に戻す（2026-11-24）
  // ★既定OFF（2026-11-24）: つなぎ方がまだ正しくない。実測で25点の建物が消えた（向きの扱いの誤り）。
  //   globalThis.__GSI_STITCH = true で試せる。直してから既定ONにする。
  // 【中心線を端点でつなぐ・2026-11-24】1本の道路が複数の地物に分かれて配信されるのを1本に戻す
  const _繋 = !(typeof globalThis !== 'undefined' && globalThis.__GSI_JOIN_LINES === false)
    ? gsiJoinLines(items) : { items, つないだ: 0 };
  // ★items を空にしてから自分を push しない（つながなかったとき _繋.items === items なので全部消える。
  //   2026-11-24 に実際に踏んだ＝陽性対照で建物まで0件になった）
  // 【既定ON・2026-11-26】整数の通し座標で突き合わせ、fail-closed の検査を付けて作り直した。
  //   globalThis.__GSI_STITCH = false で従来（つながない＝切れたまま2つの箱）＝陽性対照。
  const _縫 = (typeof globalThis !== 'undefined' && globalThis.__GSI_STITCH === false)
    ? { items: _繋.items, つないだ: 0, 試した: 0, 理由: {} } : gsiStitchCut(_繋.items);
  // 生の座標は取り込みの中だけで使う（App へ渡すと重いし、形の正は ring 1つにする）
  for (const it of _縫.items) {
    if (it && it._生) { delete it._生; delete it._z; delete it._ext; delete it._単位m; delete it._tx; delete it._ty; }
  }
  return { items: _縫.items, 穴, 範囲外, 余白, 切れ, つないだ: _縫.つないだ,
    縫いの試行: _縫.試した || 0, 縫いの理由: _縫.理由 || {},
    層数, 線をつないだ: _繋.つないだ, タイル数: タイル総数, 上限超過, 範囲外の種類 };
}
