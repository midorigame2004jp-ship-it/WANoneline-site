// bootCache.js — 起動時の Babel 変換の結果を貯めておく・2026-10-18
//
// 【なぜ要るか】配置図は 28ファイル・2.6MB を結合してブラウザで JSX 変換している。
//   実測でその変換だけに **2.2秒** かかっており、リロードのたびに毎回払っていた。
//   中身（結合した文字列）が1文字も変わっていなければ変換結果も同じなので、
//   IndexedDB に貯めて使い回す。
//
// 【安全側に倒す】貯めたものが読めない・壊れている・容量超過のときは、
//   黙って従来どおり変換する（起動できなくなるくらいなら遅い方がよい）。
//   貯める鍵は結合後の中身そのものから作るので、どれか1ファイルを編集すれば鍵が変わり、
//   古い結果を掴むことはない。
//
// 【入口が2つある】cesium-integrated.html と floating-three-view_3Dmap.html の
//   両方がこれを読む。同じ処理を HTML ごとに書くと必ず片方が古くなる（過去に何度も起きた）。

const BOOT_CACHE_DB = 'haichizu-boot';
const BOOT_CACHE_STORE = 'babel';

// 中身の印。djb2（2.6MB を走っても数ミリ秒）。長さも足して衝突を実質なくす
function bootCacheKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h * 33) ^ s.charCodeAt(i)) >>> 0);
  return s.length + '-' + h.toString(36);
}

function _bootDb() {
  return new Promise((ok, ng) => {
    if (typeof indexedDB === 'undefined') { ng(new Error('no indexedDB')); return; }
    const r = indexedDB.open(BOOT_CACHE_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(BOOT_CACHE_STORE)) db.createObjectStore(BOOT_CACHE_STORE);
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error || new Error('open failed'));
  });
}

// 貯めてある変換結果を読む。無ければ null（例外は投げない）
async function bootCacheGet(key) {
  try {
    const db = await _bootDb();
    return await new Promise((ok) => {
      const q = db.transaction(BOOT_CACHE_STORE, 'readonly').objectStore(BOOT_CACHE_STORE).get(key);
      q.onsuccess = () => ok(typeof q.result === 'string' ? q.result : null);
      q.onerror = () => ok(null);
    });
  } catch (e) { return null; }
}

// 変換結果を貯める。**古い版は消す**（溜め込むと容量を食うだけ）。失敗しても黙って進む
async function bootCachePut(key, code) {
  try {
    const db = await _bootDb();
    const tx = db.transaction(BOOT_CACHE_STORE, 'readwrite');
    const st = tx.objectStore(BOOT_CACHE_STORE);
    st.clear();
    st.put(code, key);
  } catch (e) { /* 容量超過・プライベートモード等。従来どおり毎回変換するだけ */ }
}

// 生のファイルたち → すぐ実行できるコード。
//   貯めてあれば**組み立て（strip）も変換も飛ばす**。無ければ作って貯める。
//
// 【なぜ組み立ても飛ばすか・2026-10-18 実測】
//   import/export を落とす stripModuleSyntax は**ファイルごとに Babel.transform を呼ぶ**。
//   28ファイル・2.7MB で約3.2秒かかっており、最後の JSX 変換 2.4秒と合わせて
//   起動のたびに Babel が2回ぶん走っていた。鍵を『生の中身』にすれば両方まとめて飛ばせる。
//
//   組み立て方そのものは入口HTMLごとに違う（<script> で実行する／eval で実行する）ので、
//   ここでは受け取った関数を呼ぶだけにして、仕組みだけを共有する。
//
//   texts … 取ってきた生のファイルの中身（srcFiles と同じ順）
//   組み立てる … () => combined を返す関数（strip と結合。貯めてあるときは呼ばれない）
//   戻り値 { code, 貯めから, 組み立てms, 変換ms, 貯め読みms }
async function bootBuild(texts, 組み立てる, Babel) {
  const t0 = performance.now();
  const key = bootCacheKey(texts.join('\u0000'));
  const 貯 = await bootCacheGet(key);
  const 貯め読みms = Math.round(performance.now() - t0);
  if (貯) return { code: 貯, 貯めから: true, 組み立てms: 0, 変換ms: 0, 貯め読みms };
  const t1 = performance.now();
  const combined = 組み立てる();
  const 組み立てms = Math.round(performance.now() - t1);
  const t2 = performance.now();
  const code = Babel.transform(combined, { presets: ['react'], filename: 'app.jsx' }).code;
  const 変換ms = Math.round(performance.now() - t2);
  bootCachePut(key, code);   // 待たない（次回に間に合えばよい）
  return { code, 貯めから: false, 組み立てms, 変換ms, 貯め読みms };
}
