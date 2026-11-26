// ================================================================
// 建物内部 共通コア（buildingCore.js）
// ================================================================
// 建物内部（階・部屋・扉・アイコン）の意味モデル導出を1箇所に集約する。
// panelDrawCore.js と同じ設計思想: Cesium3D と建物エディタ（将来新設）の
// 両方がここの bc* 関数を呼ぶ。個別ビューにロジックをコピーしない。
//
// 【座標系】
//   XY: 構造体 block.points と同じ平面グリッド座標
//   Z : sharedBaseElev 基準の相対m（block.zBottom / zTop と同じ系）
//
// 【設計上の制約（BUILDING_INTERIOR_SPEC.md 準拠）】
//   - 床スラブは solid.faces に混ぜない（_rebuildAllWalls が非wall面を
//     外周壁生成の入力に使うため、混ぜると余計な壁が生える）。
//     階は building.floors[] に持ち、描画時にここで導出する。
//   - openings（床開口部）は未決事項#7のため型を固定しない。
//     いまは空配列の予約のみ（bcAddFloor が openings:[] を必ず持たせる）。

// ── ID生成（共通IDモデル確定時にここ1箇所を差し替える）──
// 現状はコードベース全体の慣行（'xxx_'+Date.now()）に合わせる。
// 連続生成の衝突を避けるためカウンタを併用する。
let _bcIdCounter = 0;
function bcNewId(prefix) {
  return prefix + '_' + Date.now() + '_' + (++_bcIdCounter);
}

// ── 階のデフォルト値 ──
const BC_FLOOR_DEFAULTS = {
  heightM: 3.0,        // 階高（床面から次の床/天井までの高さ）
  slabThicknessM: 0.15 // 床版厚（描画上の床スラブ厚み）
};

// 階データを新規作成する（building.floors[] へ push する要素）
//   levelZ: 床標高（zBottom基準の相対m）
//   outline: null = 構造体の水平断面を継承（既定）。
//            将来セットバック対応時に [{x,y}] で上書き可能な予約フィールド。
function bcNewFloor(levelZ, opts) {
  const o = opts || {};
  return {
    id: bcNewId('floor'),
    name: o.name || '',
    levelZ: levelZ,
    heightM: o.heightM != null ? o.heightM : BC_FLOOR_DEFAULTS.heightM,
    slabThicknessM: o.slabThicknessM != null ? o.slabThicknessM : BC_FLOOR_DEFAULTS.slabThicknessM,
    outline: null,
    openings: [], // 床開口部（型は未確定・予約のみ。spec 8章#7）
    partitions: [], // 仕切り（壁/透明仕切り。Phase B）
    doors: [],      // 扉（壁に乗る。Phase B）
    icons: []       // 壁面の機器アイコン（壁の面に貼る。Phase C）
  };
}

// ── 階の外形導出 ──
// 指定Z高さでの構造体の水平断面ポリゴン群を返す。
// building は複数 blocks を持ち得るため、戻り値は「ポリゴンの配列」。
// （単一ポリゴン前提にすると複数block構造体で破綻する — Codex監査指摘）
// floor.outline が指定されていればそれを単一ポリゴンとして優先する。
// ブロックの「階が使える天井の高さ」・2026-10-03
// 【なぜ一番低い所か】上面を傾けると、場所によって天井の高さが変わる。
//   一番高い所で判定すると、低い側の屋根を階・機器・仕切りが**突き抜ける**（Codex監査）。
//   安全側に倒して、一番低い所を天井とみなす。
function _bcBlkTopZ(blk) {
  if (typeof blockMinTopZ === 'function') return blockMinTopZ(blk);
  return (blk && blk.zTop != null) ? blk.zTop : 40;
}

// ══════════════════════════════════════════════════════════════
// 形を出すもの（ホスト）の入口 ── 2026-11-05
// ══════════════════════════════════════════════════════════════
// 【なぜ1つにするか】形を作る系統が2つある。
//   ・建屋 … building.blocks[]（押し出し・掃引・回転体。面を同期で作れる）
//   ・立体 … bodies[].ops[]（箱・円柱・球を足す/くり抜く。manifold(WASM) で**非同期**）
//   「その高さに居る形を選ぶ」判定は 4 か所に手書きされていた
//   （bcFloorOutlines / bcValidateFloor / bcFloorOuterEdges / bcOuterFrame）。
//   bcFloorOuterEdges のコメントは「bcFloorOutlines と同じ選び方」と書いているが、
//   **実際は天井の取り方が違う**（床系＝blockMinTopZ で一番低い所＝安全側／
//   外壁系＝生の zTop）。片方を直すともう片方が残る型なので入口を1つにする。
//
// 【挙動を変えない】その差は意図的な可能性がある（傾いた屋根でも壁は上端まである）。
//   層に zTop（生）と zTopSafe（安全側）の**両方**を持たせ、各所が今まで読んでいた方を読む。
//
// 【tri-state・段1への備え】立体の面は非同期にできる。bcHostLayers が null を返すのは
//   「まだ計算していない」、[] は「形が無い」。この2つを混ぜると、読み込み直後に
//   「どのブロックの高さ範囲にも入っていません」と誤って拒否する（advisor 指摘）。

// ── 立体（CSG）の評価済みの面を読む口 ──
// 【なぜ登録か】buildingCore は純関数の集まりで App の state を知らない。
//   呼び口ごとに引数で渡すと、渡し忘れた呼び口が「立体を知らない」まま動く
//   （共有関数の除外を引数で渡すと残りの呼び口が全部規則を破る・2026-10-08 の型）。
//   App が起動時に1回だけ登録する。登録が無ければ「まだ計算していない」を返す。
let _bcBodySolidReader = null;
function bcSetBodySolidReader(fn) { _bcBodySolidReader = (typeof fn === 'function') ? fn : null; }

// その高さがこの層の範囲に入るか。床・外壁・機器の選び方はこの述語1つ。
//   下端ちょうどは含む（＝1階の床）／上端ちょうどは含まない（上の層に属する）
function bcSpanHoldsZ(zB, zT, z) {
  const b = (zB == null) ? 0 : zB;
  return z >= b - 1e-9 && z < zT - 1e-9;
}

// ホストを「層」に分けて返す。建屋はブロックごと、立体は（段1で）1つ。
//   [{ idx, blk, zB, zTop, zTopSafe }]
//   null = まだ計算していない（立体の非同期評価待ち） / [] = 形が無い
function bcHostLayers(host) {
  if (typeof window !== 'undefined' && window.__HOST_LAYERS === false) return null;  // 陽性対照
  if (!host) return [];
  if (Array.isArray(host.blocks)) {
    return host.blocks.map((blk, idx) => ({
      idx, blk,
      zB: blk.zBottom || 0,
      zTop: (blk.zTop != null) ? blk.zTop : 40,   // 生の上端（外壁はこちらを見ていた）
      zTopSafe: _bcBlkTopZ(blk),                  // 傾いた屋根なら一番低い所（床はこちら）
    }));
  }
  // ── 立体（CSG）── 2026-11-05
  // 層は1つ（ops を全部適用した結果が1つの形）。高さの範囲は評価済みの bbox から取る。
  // 【tri-state】評価は非同期なので、済んでいなければ null（＝まだ計算していない）。
  //   [] を返すと「形が無い」と区別できず、読み込み直後に階を誤って拒否する。
  if (Array.isArray(host.ops)) {
    if (!_bcBodySolidReader) return null;
    const sol = _bcBodySolidReader(host.id);
    if (!sol || !sol.bbox) return null;
    const zB = sol.bbox.minZ, zT = sol.bbox.maxZ;
    // 生の上端と安全側は立体では同じ（傾いた屋根のような「一番低い所」の概念が無い）
    return [{ idx: 0, blk: null, sol, zB, zTop: zT, zTopSafe: zT }];
  }
  return [];
}

function bcFloorOutlines(building, floor) {
  if (floor.outline && floor.outline.length >= 3) return [floor.outline];
  const z = floor.levelZ;
  const polys = [];
  const 層ら = bcHostLayers(building);
  if (!層ら) return [];               // まだ計算していない（形が無いのとは違う）
  for (const 層 of 層ら) {
    const bi = 層.idx, blk = 層.blk;
    // 【立体（CSG）・2026-11-05】床の形は manifold の水平断面（evalBody の outlineZ）。
    //   面を切ってつなぐやり方だと穴が消えるので、評価で作った輪郭をそのまま使う。
    //   その高さぶんがまだ無い（＝評価が追いついていない）ときは諦める＝空を返す
    if (!blk && 層.sol) {
      if (!bcSpanHoldsZ(層.zB, 層.zTopSafe, z)) continue;
      const zk = (typeof csgZKey === 'function') ? csgZKey(z) : String(z);
      const ps2 = (層.sol.outlineZ || {})[zk];
      if (Array.isArray(ps2)) for (const q of ps2) if (q && q.length >= 3) polys.push(q);
      continue;
    }
    // 床標高がこの層の高さ範囲内にあれば、その高さでの**足跡**を床の形にする。
    // 天井は安全側（傾いた屋根なら一番低い所）を見る＝階・機器が屋根を突き抜けない
    if (bcSpanHoldsZ(層.zB, 層.zTopSafe, z)) {
      // 【足跡であって断面ではない・2026-11-04】points は押し出しなら足跡だが、
      //   掃引・回転体では**断面**。そのまま使うとタンクの床が「半径×全高」になる
      //   （実測：胴6m＋鏡板2m のタンクの床が 3m×9m の縦長になっていた）。
      const fp = (typeof blockFootprintAtZ === 'function')
        ? blockFootprintAtZ(building, blk, bi, z) : null;
      const ps = (fp && fp.length >= 3) ? fp
        : ((blk.points && blk.points.length >= 3) ? blk.points : null);
      if (ps) polys.push(ps);
    }
  }
  return polys;
}

// ── 階の妥当性検証 ──
// 戻り値: { ok, errors: [文字列] }
//   - 床標高がどのblockの高さ範囲にも入らない → エラー
//   - 床標高+階高が構造体の最上端を超える → 警告扱いのエラー文字列
function bcValidateFloor(building, floor) {
  const errors = [];
  // 【まだ計算していないときは通す・2026-11-05 advisor 指摘】
  //   立体（CSG）の面は manifold(WASM) の非同期評価でできる。評価前は層が取れないが、
  //   それを「範囲外」として拒否すると**読み込み直後に階を足せない**。
  //   「まだ計算していない（null）」と「形が無い（[]）」を混ぜないのが肝。
  const 層ら = bcHostLayers(building);
  if (層ら === null) return { ok: true, errors: [], 未評価: true };
  // 【高さの範囲で判定する・2026-11-05】以前は「床の輪郭が出るか」で見ていた。
  //   立体（CSG）の床の輪郭は**階の高さの一覧から**作る（manifold の slice に渡す）ので、
  //   階を足す前は必ず空＝**階を足せない**という鶏と卵になっていた。
  //   本来の意味は「その高さに形があるか」なので、層の高さの範囲で判定する。
  //   建屋では同値（bcFloorOutlines は範囲に入る層だけを選んでから足跡を作り、
  //   作れなければ points に落ちるので、範囲に入れば必ず輪郭が出る）。
  if (!層ら.some(L => bcSpanHoldsZ(L.zB, L.zTopSafe, floor.levelZ))) {
    errors.push('床標高 ' + floor.levelZ + 'm はどのブロックの高さ範囲にも入っていません');
  }
  let maxTop = -Infinity;
  for (const 層 of 層ら) {
    if (層.zTopSafe > maxTop) maxTop = 層.zTopSafe;   // 安全側（傾いた屋根は一番低い所）
  }
  if (isFinite(maxTop) && floor.levelZ + floor.heightM > maxTop + 1e-9) {
    errors.push('床標高+階高 (' + (floor.levelZ + floor.heightM) + 'm) が構造体上端 (' + maxTop + 'm) を超えています');
  }
  // 既存の他の階と床標高が重複していないか
  for (const f of (building.floors || [])) {
    if (f.id !== floor.id && Math.abs(f.levelZ - floor.levelZ) < 1e-6) {
      errors.push('同じ床標高 ' + floor.levelZ + 'm の階が既にあります');
    }
  }
  return { ok: errors.length === 0, errors };
}

// ════════════════════════════════════════════════════════════════
// 抜く(void) — 吹き抜け・壁の開口 ・2026-10-04 Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【なぜブロックの立体に持たせないか】建屋の立体は「面の集合」でブーリアンを持たない。
//   manifold を使うと blockSolidsOf が**同期で呼べなくなる**（描画のたびに呼ぶので致命的）。
//   多角形ブーリアンで輪郭を割ると**面の名前が変わり、貼った機器が迷子**になる。
//   → 吹き抜けは床スラブ側、壁の開口は仕切り壁側に入れる（SHAPE_MODEL_SPEC.md §3.7）。
// 【形は Profile を共有】穴の形ごとに型・ボタンを増やさない。kind は BC_PROFILES の行名。
// 【割り方は carveCells を共有】ガワの壁（増築棟の穴）とまったく同じ処理を使う。

// 穴ひとつの記録。床にも仕切り壁にも**同じ型**を使う。
//   仕切り壁 … uM = 端点aからの距離[m]、zM = 床からの高さ[m]（どちらも穴の中心）
//   床       … x, y = グリッド座標（穴の中心）
// ※ 置き場所の意味だけがホストで変わる。形・寸法の読み方は同じ。
function bcNewOpening(kind, at, opts) {
  const o = opts || {}, p = at || {};
  return {
    id: bcNewId('open'),
    name: o.name || '',
    kind: kind || 'rect',          // BC_PROFILES の行（rect / circle / tri / hbeam）
    wM: o.wM != null ? o.wM : 0.9, // 幅[m]（circle は直径）
    hM: o.hM != null ? o.hM : 0.9, // 高さ[m]（circle は使わない）
    tM: o.tM != null ? o.tM : null,// hbeam の板厚[m]
    uM: p.uM != null ? p.uM : null,
    zM: p.zM != null ? p.zM : null,
    x: p.x != null ? p.x : null,
    y: p.y != null ? p.y : null,
  };
}

// 受け取った穴の列を安全な形に整える。床も壁も**ここ1つ**を通る。
// 【なぜ要るか】寸法が0や負だと帯が作れず、黙って穴が開かない（=ユーザーには『効かない』に見える）。
//   壊れた1件で列ぜんぶを捨てず、その1件だけ落とす（読み込みの bcNormalizeBodies と同じ構え）。
function bcNormalizeOpenings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const w = +o.wM, h = +o.hM;
    if (!(w > 0)) continue;                       // 幅（円なら直径）は要る
    const kind = (typeof profileKindOf === 'function') ? profileKindOf(o) : (o.kind || 'rect');
    if (kind !== 'circle' && !(h > 0)) continue;  // 円以外は高さも要る
    out.push({ ...o, kind, wM: w, hM: (h > 0 ? h : w) });
  }
  return out;
}

// 記録 → 穴の帯（**ここ1か所**）。ホストで『置き場所の読み方』だけが変わる。
//   where='partition' … a = u[m]、b = z[m]（階の床標高からの絶対m）
//   where='floor'     … a = x、b = y（どちらもグリッド）
// 段階フラグ window.__BLD_VOID = false で穴を開けない（従来＝陽性対照）
function bcOpeningBands(host, where, ctx) {
  if (typeof window !== 'undefined' && window.__BLD_VOID === false) return [];
  const ops = bcNormalizeOpenings(host && host.openings);
  if (!ops.length || typeof openingBands !== 'function') return [];
  const mpp = _bcMpp();
  const out = [];
  for (const op of ops) {
    if (!op || op.off) continue;
    const bands = openingBands(op, op.seg);   // メートル・中心が原点
    if (where === 'partition') {
      const cu = +op.uM || 0;
      const cz = ((ctx && ctx.zBase) || 0) + (+op.zM || 0);
      bands.forEach(h => out.push({ a0: cu + h.a0, a1: cu + h.a1,
                                    b0: cz + h.b0, b1: cz + h.b1, _op: op }));
    } else {
      const cx = +op.x || 0, cy = +op.y || 0;
      bands.forEach(h => out.push({ a0: cx + h.a0 / mpp, a1: cx + h.a1 / mpp,
                                    b0: cy + h.b0 / mpp, b1: cy + h.b1 / mpp, _op: op }));
    }
  }
  return out;
}

// 穴を足すとき「どこが空いているか」・2026-10-04
// 【なぜコア側に置くか】最初これを建物エディタの中に書いたら、実機で動かなかったのに
//   原因を切り分けられなかった（UI の中では検査から呼べない）。床と壁で書き分けも起きる。
// 【なぜ要るか】いつも真ん中に置くと、そこに扉や別の穴があったとき新しい穴が丸ごと
//   飲み込まれ、**押しても何も起きない**。ユーザーには「効かない」に見える。

// 壁：塞がっている区間を並べて隙間を出し、**一番広い隙間の中央**を返す。
//   既定の幅がどの隙間にも入らなければ、入る幅まで**穴を細くする**（置けないとは言わない）。
function bcFreeSpanOnPartition(floor, partId, 既定幅) {
  const w0 = (+既定幅 > 0) ? +既定幅 : 0.9;
  const part = floor && (floor.partitions || []).find(p => p.id === partId);
  if (!part) return { uM: w0 / 2, wM: w0, 理由: '壁が無い' };
  const L = bcPartitionLenM(part);
  const 既定 = { uM: Math.max(w0 / 2, L / 2), wM: w0, 理由: '塞がりなし' };
  const 塞ぐ = (bcOpeningBands(part, 'partition', { zBase: (floor.levelZ || 0) }) || [])
    .concat(bcDoorOpeningBands(floor, part) || []);
  if (!塞ぐ.length) return 既定;
  const 区間 = 塞ぐ.map(h => [Math.max(0, h.a0), Math.min(L, h.a1)])
    .filter(r => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  const 隙間 = []; let cur = 0;
  区間.forEach(r => { if (r[0] - cur > 1e-6) 隙間.push([cur, r[0]]);
                      cur = Math.max(cur, r[1]); });
  if (L - cur > 1e-6) 隙間.push([cur, L]);
  const 広い順 = (a, b) => (b[1] - b[0]) - (a[1] - a[0]);
  const 入る = 隙間.filter(g => g[1] - g[0] >= w0 - 1e-6).sort(広い順);
  if (入る.length) return { uM: (入る[0][0] + 入る[0][1]) / 2, wM: w0, 理由: '空きの中央' };
  const 広 = 隙間.slice().sort(広い順)[0];
  if (広 && 広[1] - 広[0] > 0.15)
    return { uM: (広[0] + 広[1]) / 2,
             wM: Math.round((広[1] - 広[0] - 0.05) * 100) / 100, 理由: '隙間に合わせて細く' };
  return Object.assign({}, 既定, { 理由: '空きが無い' });
}

// 床：既にある穴と重ならない所。芯から渦巻き状に当たる（床の外形は広いので大抵すぐ見つかる）
function bcFreeSpotOnFloor(building, floor, 幅M, 高M) {
  const mpp = _bcMpp();
  const outs = (typeof bcFloorOutlines === 'function') ? bcFloorOutlines(building, floor) : [];
  const pts = (outs && outs[0]) || [];
  const 芯 = pts.length
    ? { x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
        y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
    : { x: 0, y: 0 };
  const 塞ぐ = bcOpeningBands(floor, 'floor') || [];
  if (!塞ぐ.length) return 芯;
  const hw = (幅M / 2) / mpp, hh = (高M / 2) / mpp;
  const 空き = (x, y) => !塞ぐ.some(h => x + hw > h.a0 && x - hw < h.a1
                                      && y + hh > h.b0 && y - hh < h.b1);
  if (空き(芯.x, 芯.y)) return 芯;
  const d = (Math.max(幅M, 高M) + 1) / mpp;
  for (let 輪 = 1; 輪 <= 4; 輪++) {
    for (let k = 0; k < 12; k++) {
      const a = Math.PI * 2 * k / 12;
      const x = 芯.x + Math.cos(a) * d * 輪, y = 芯.y + Math.sin(a) * d * 輪;
      if (空き(x, y)) return { x, y };
    }
  }
  return 芯;
}

// 扉が壁に開ける穴 ・2026-10-04 Codex監査済み
// 【なぜ扉の記録に openings を持たせないか】扉の幾何の唯一の正は bcDoorFrame。
//   穴の位置を別に記録すると**正が2つ**になり、扉を動かしたとき穴だけ置いていかれる。
//   導出で出せば必ず一致する（幅・高さ・位置・取付面を変えても穴が追いてくる）。
// 【扉の板はこの穴を埋める】bcDoorGeoms が返す板と u・z の範囲はぴったり同じ。
//   壁の片面にフラッシュしているので、反対の面には壁厚と扉厚の差ぶんの窪みが見える
//   （実物の扉と同じ。今まで壁の板で隠れていたほうが不正確だった・Codex）。
// 段階フラグ window.__DOOR_OPENING = false で従来＝壁が抜けない（陽性対照）
function bcDoorOpeningBands(floor, part) {
  if (typeof window !== 'undefined' && window.__DOOR_OPENING === false) return [];
  if (!floor || !part || part.kind !== 'wall') return [];   // 透明仕切りに扉は乗らない
  const out = [];
  for (const d of (floor.doors || [])) {
    if (!d || d.partitionId !== part.id) continue;
    const fm = bcDoorFrame(floor, part, d);
    if (!fm) continue;
    out.push({ a0: fm.uLeftM, a1: fm.uRightM, b0: fm.zB, b1: fm.zT, _door: d });
  }
  return out;
}

// 多角形から穴を抜いて、残りを台形の列にする（床の吹き抜け）。
// 【なぜ台形か】床の外形は斜めの辺を持つ。x で刻んで各スライスを台形にすれば階段にならない。
//   スライスの境に『全頂点の x』と『穴の縁と辺の交点の x』を入れるので、
//   スライスの中で辺は直線のまま・穴の縁を跨がない（跨ぐと台形で表せない）。
// 【なぜ穴あきポリゴンにしないか】Cesium は holes を持てるが、3Dプレビューと2D平面図は
//   自前で描いている。台形の列にしておけば**描画側は無変更**で穴が開く（Codex監査）。
function _bcCarvePolygon(pts, bands) {
  const E = 1e-6;
  if (!pts || pts.length < 3) return [];
  const hs = (bands || []).filter(h => h.a1 - h.a0 > E && h.b1 - h.b0 > E);
  if (!hs.length) return [pts];
  const cuts = [];
  let xLo = Infinity, xHi = -Infinity;
  pts.forEach(p => { cuts.push(p.x); if (p.x < xLo) xLo = p.x; if (p.x > xHi) xHi = p.x; });
  hs.forEach(h => { cuts.push(h.a0); cuts.push(h.a1); });
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const dy = q.y - p.y;
    if (Math.abs(dy) < E) continue;
    hs.forEach(h => [h.b0, h.b1].forEach(yy => {
      const t = (yy - p.y) / dy;
      if (t > E && t < 1 - E) cuts.push(p.x + (q.x - p.x) * t);
    }));
  }
  const xs = [...new Set(cuts.map(v => +v.toFixed(5)))].sort((a, b) => a - b)
    .filter(v => v >= xLo - E && v <= xHi + E);
  const out = [];
  for (let k = 0; k < xs.length - 1; k++) {
    const x0 = xs[k], x1 = xs[k + 1];
    if (x1 - x0 < 1e-5) continue;
    // このスライスを完全に跨ぐ辺だけ集め、x0 / x1 での y を出す
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (Math.min(p.x, q.x) > x0 + E || Math.max(p.x, q.x) < x1 - E) continue;
      const dx = q.x - p.x;
      if (Math.abs(dx) < E) continue;   // 垂直な辺はスライスを跨がない
      segs.push({ y0: p.y + (q.y - p.y) * (x0 - p.x) / dx,
                  y1: p.y + (q.y - p.y) * (x1 - p.x) / dx });
    }
    if (segs.length < 2) continue;
    segs.sort((u, v) => (u.y0 + u.y1) - (v.y0 + v.y1));
    const xm = (x0 + x1) / 2;
    const here = hs.filter(h => xm > h.a0 - E && xm < h.a1 + E);
    for (let m = 0; m + 1 < segs.length; m += 2) {   // 偶奇で対にする（凹んだ床でも正しい）
      let tz = [{ yA0: segs[m].y0, yA1: segs[m + 1].y0,
                  yB0: segs[m].y1, yB1: segs[m + 1].y1 }];
      here.forEach(h => {
        const next = [];
        tz.forEach(t => {
          const dA = Math.max(t.yA0, Math.min(t.yA1, h.b0));
          const dB = Math.max(t.yB0, Math.min(t.yB1, h.b0));
          if (dA - t.yA0 > E || dB - t.yB0 > E)
            next.push({ yA0: t.yA0, yA1: dA, yB0: t.yB0, yB1: dB });
          const uA = Math.min(t.yA1, Math.max(t.yA0, h.b1));
          const uB = Math.min(t.yB1, Math.max(t.yB0, h.b1));
          if (t.yA1 - uA > E || t.yB1 - uB > E)
            next.push({ yA0: uA, yA1: t.yA1, yB0: uB, yB1: t.yB1 });
        });
        tz = next;
      });
      tz.forEach(t => {
        const poly = [];
        const push = (x, y) => { const q = poly[poly.length - 1];
          if (q && Math.abs(q.x - x) < 1e-9 && Math.abs(q.y - y) < 1e-9) return;
          poly.push({ x, y }); };
        push(x0, t.yA0); push(x1, t.yB0); push(x1, t.yB1); push(x0, t.yA1);
        while (poly.length >= 2
          && Math.abs(poly[0].x - poly[poly.length - 1].x) < 1e-9
          && Math.abs(poly[0].y - poly[poly.length - 1].y) < 1e-9) poly.pop();
        if (poly.length < 3) return;
        let ar = 0;   // 潰れた台形は落とす
        for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length];
          ar += p.x * q.y - q.x * p.y; }
        if (Math.abs(ar) / 2 < 1e-6) return;
        out.push(poly);
      });
    }
  }
  return out;
}

// ── 床スラブの描画用ジオメトリ導出 ──
// 各階について { floorId, polys: [{points, zTop, zBottom, holes}] } を返す。
// zTop = levelZ（床の歩行面）、zBottom = levelZ - slabThicknessM。
// holes は openings 由来（現状は常に空。型確定後にここへ実装を足す）。
function bcFloorSlabGeoms(building) {
  const out = [];
  const floors = (building && building.floors) || [];
  for (const floor of floors) {
    const outlines = bcFloorOutlines(building, floor);
    if (outlines.length === 0) continue;
    // 【吹き抜け・2026-10-04】外形から穴を抜いて台形の列にする。
    //   描画側は polys を forEach で回すだけなので、ここが増えればそのまま穴が開く。
    const bands = bcOpeningBands(floor, 'floor');
    const zT = floor.levelZ;
    const zB = floor.levelZ - (floor.slabThicknessM || BC_FLOOR_DEFAULTS.slabThicknessM);
    const polys = [];
    outlines.forEach(pts => {
      (bands.length ? _bcCarvePolygon(pts, bands) : [pts]).forEach(q => {
        if (q && q.length >= 3) polys.push({ points: q, zTop: zT, zBottom: zB, holes: [] });
      });
    });
    if (!polys.length) continue;   // 床ぜんぶが穴
    out.push({ floorId: floor.id, floor: floor, polys: polys });
  }
  return out;
}

// ── 階の並び（床標高昇順）──
function bcSortedFloors(building) {
  return [...((building && building.floors) || [])].sort((a, b) => a.levelZ - b.levelZ);
}

// ── 階の表示名（未命名なら下から数えて「N階」）──
function bcFloorLabel(building, floor) {
  if (floor.name) return floor.name;
  const sorted = bcSortedFloors(building);
  const idx = sorted.findIndex(f => f.id === floor.id);
  return (idx >= 0 ? (idx + 1) : '?') + '階';
}

// ── 構造体変形時の階追従（spec 7.5: 設定でユーザーが切替）──
// followMode: true = 追従する（既定）/ false = 追従しない
// 追従ONのとき: blockの高さ範囲が変わって範囲外に出た階を検出して返す
// （自動削除はしない。呼び出し側が警告表示に使う。spec 8章#9）
function bcFloorsOutOfRange(building) {
  const bad = [];
  for (const floor of (building && building.floors) || []) {
    const v = bcValidateFloor(building, floor);
    if (!v.ok) bad.push({ floor, errors: v.errors });
  }
  return bad;
}

// ── 永続化スキーマ（spec 7.6: 今後の新規データはjson）──
// エクスポート形式: { version: 2, kind: 'wanol_buildings', buildings: [...], bodies: [...] }
// バージョンフィールドを必ず持たせる（配電盤localStorageの反省: 版無しだと移行判定不能）
//
// 【v2・2026-09-27】CSGボディ（bodies）を足した。
//   bodies は「作り方の履歴」で形を持つ立体（円柱＋先端半球のタンク等）。
//   **buildings の下ではなく top-level** に置く。建屋の階・仕切りとは別の概念で、
//   建屋に属さない独立した立体（タンク・サイロ）も置けるため（Codex監査）。
//   v1 のデータを読むと bodies は空になる（後方互換）。
const BC_SCHEMA_VERSION = 2;
function bcExportBuildings(buildings, bodies) {
  return JSON.stringify({
    version: BC_SCHEMA_VERSION,
    kind: 'wanol_buildings',
    savedAt: new Date().toISOString(),
    buildings: buildings,
    bodies: Array.isArray(bodies) ? bodies : []
  }, null, 2);
}
// 読んだ bodies を安全な形に整える。壊れた段は落とす（読み込み全体を失敗させない）
function bcNormalizeBodies(raw) {
  if (!Array.isArray(raw)) return [];
  // extrude は「3次元図で面を掴んで押し引きした結果」。位置は基底(o/u/v/n)が持つので at は使わない
  const 種類 = { box: 1, cylinder: 1, sphere: 1, extrude: 1 };
  const 効き方 = { union: 1, subtract: 1, intersect: 1 };
  const out = [];
  for (const b of raw) {
    if (!b || !b.id || !Array.isArray(b.ops)) continue;
    const ops = b.ops.filter(o => o && 種類[o.kind]).map(o => (o.kind === 'extrude'
      ? { ...o, mode: 効き方[o.mode] ? o.mode : 'union' }
      : {
        ...o,
        at: { x: +(o.at && o.at.x) || 0, y: +(o.at && o.at.y) || 0, z: +(o.at && o.at.z) || 0 },
        mode: 効き方[o.mode] ? o.mode : 'union',
      }));
    if (!ops.length) continue;
    const 整 = { id: String(b.id), label: String(b.label || b.id),
                 color: b.color || '#6B7A8D', ops };
    // 【立体の階・2026-11-05】建屋と同じ形（bcNewFloor）で持つ。
    //   立体にも階・仕切り・扉・機器が付くようにする段1。
    if (Array.isArray(b.floors)) {
      整.floors = b.floors.filter(f => f && f.id && Number.isFinite(+f.levelZ)).map(f => ({
        ...f,
        id: String(f.id),
        levelZ: +f.levelZ,
        heightM: Math.max(0.1, +f.heightM || 3),
        partitions: Array.isArray(f.partitions) ? f.partitions : [],
        doors: Array.isArray(f.doors) ? f.doors : [],
        icons: Array.isArray(f.icons) ? f.icons : [],
        openings: Array.isArray(f.openings) ? f.openings : [],
      }));
    }
    // 【立体に貼った機器・2026-10-03】ここは「記録のフィールドを明示列挙する」作りなので、
    //   足したフィールドをここに書かないと**保存したのに読み直すと消える**（実測で消えた）。
    //   flattenBuildings と同じ落とし穴。
    if (Array.isArray(b.icons)) {
      整.icons = b.icons.filter(ic => ic && ic.id && ic.surfaceId).map(ic => ({
        id: String(ic.id), name: String(ic.name || '機器'),
        surfaceId: String(ic.surfaceId),
        sM: +ic.sM || 0, tM: +ic.tM || 0,
        wM: +ic.wM || 0.2, hM: +ic.hM || 0.2,
        side: ic.side < 0 ? -1 : 1,
        ...(ic.color ? { color: String(ic.color) } : {}),
      }));
    }
    out.push(整);
  }
  return out;
}

// ================================================================
// Phase B: 仕切り（壁/透明仕切り）・扉・部屋認識
// ================================================================
// 【設計原則（BUILDING_INTERIOR_SPEC.md 7.2/7.3 と Codex監査の必須修正）】
//   - 仕切りは kind: 'wall'（壁・不透明）| 'clear'（透明仕切り）の2種のみ。
//     違いは見た目の透明度だけで、部屋認識では【両方とも遮断】として扱う。
//     第3の型を作らない。
//   - 扉は壁(kind:'wall')にのみ乗る。部屋認識では扉は壁を分断しない
//     （扉があっても部屋同士は結合しない）。
//   - 外壁（ガワ）への扉は Phase B では対象外（partitionId必須のため置けない）。
//     対応する場合は別途 boundaryRef 等の設計が必要。
//   - 斜めの仕切りはデータとして置け、描画もされるが、部屋認識の境界としては
//     未対応（配電盤が type:'axis' のみ対象とするのと同じ割り切り）。
//
// 【単位】XY = グリッド座標（1グリッド = METERS_PER_PX m、既定0.1m）／
//         thicknessM・heightM・uM・widthM = メートル

function _bcMpp() {
  return (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
}
const BC_PARTITION_DEFAULTS = { thicknessM: 0.15 };
// minM = 扉の最小寸法。0以下や極小の扉を作らせないための下限（bcApplyDoorEdit で使う）
const BC_DOOR_DEFAULTS = { widthM: 0.9, heightM: 2.0, minM: 0.2 };
// 部屋認識の座標許容誤差（グリッド単位。0.5グリッド=既定5cm）
const BC_ROOM_EPS = 0.5;
const BC_ROOM_COLORS = ['#60A5FA', '#F59E0B', '#34D399', '#F472B6', '#A78BFA',
                        '#FBBF24', '#22D3EE', '#FB7185', '#4ADE80', '#C084FC'];
function _bcR1(v) { return Math.round(v * 10) / 10; } // 安定キー用の丸め（浮動小数の揺れ防止）

// 仕切りを新規作成（floor.partitions[] へ push する要素）
function bcNewPartition(a, b, kind, opts) {
  const o = opts || {};
  return {
    id: bcNewId('part'),
    name: o.name || '',
    kind: kind === 'clear' ? 'clear' : 'wall',
    a: { x: a.x, y: a.y },
    b: { x: b.x, y: b.y },
    thicknessM: o.thicknessM != null ? o.thicknessM : BC_PARTITION_DEFAULTS.thicknessM,
    heightM: o.heightM != null ? o.heightM : null, // null = 階高いっぱい
    // 【下端の高さ】床からの立ち上がり(m)。0=床に接する。
    // 天井際の壁・腰壁・垂れ壁のために持つ（2026-08-26 ユーザー要望）
    baseM: o.baseM != null ? o.baseM : 0,
    color: o.color || null,
    // 【抜く(void)・2026-10-04】窓・ダクト貫通。bcNewOpening の列（床の openings と同じ型）
    openings: [],
  };
}

// 扉を新規作成（floor.doors[] へ push する要素。uM = 端点aからの中心距離[m]）
function bcNewDoor(partitionId, uM, opts) {
  const o = opts || {};
  return {
    id: bcNewId('bdoor'),
    name: o.name || '扉',
    partitionId: partitionId,
    uM: uM,
    widthM: o.widthM != null ? o.widthM : BC_DOOR_DEFAULTS.widthM,
    heightM: o.heightM != null ? o.heightM : BC_DOOR_DEFAULTS.heightM,
    // 【扉の厚み・2026-09-02】null=壁の厚みに連動（後方互換）。数値=扉独立の厚み(m)。
    // 実消費は bcDoorFrame の1箇所だけ（そこが扉幾何の唯一の正）。
    thicknessM: o.thicknessM != null ? o.thicknessM : null,
    // 【扉の取付面・2026-09-03】±1。壁のどちらの面にフラッシュさせるか。既定+1。
    faceSide: (o.faceSide === -1 ? -1 : 1),
    hingeSide: o.hingeSide || 'left',
    isOpen: false,
  };
}

// ── 壁面アイコン（Phase C）──
// 配電盤は {chamberKey, face} で「どの区画のどの面か」を表し絶対座標を持たない。
// 建物での対応は「どの壁の・どちら側の面に・端点aから何m・床から何m」。
//
// 【side を ±1 にした理由】当初計画は roomKey（部屋の安定キー）で表裏を持つ案だった。
// だが roomKey を正にすると、アイコンの位置を出すたびに部屋認識を回すことになり、
// さらに壁を1本消すと部屋が併合されてキーが消える＝アイコンが迷子になる。
// a/b を入れ替える処理はコード上どこにも無いので、
// **壁自身の法線（a→bから作る）基準の ±1** を正にする（2026-08-28 監査OK）。
// 壁の厚み・長さ・高さが変わっても、実座標は bcIconAnchorGeom が毎回計算し直すので
// 保存データの書き換えは要らない。
const BC_ICON_DEFAULTS = { wM: 0.3, hM: 0.3, tM: 1.2, minM: 0.05, color: '#FBBF24' };
// 壁・扉に付けた機器の厚み[m]（取付面から外向きに押し出す）。全ビュー共通の唯一の定義・2026-09-11。
// ユーザー決定「建屋エディタでも他のも全部厚みあり。3次元図の形を正とする」。
// 以前は App.jsx の2Dだけがこの厚みを持ち、建屋エディタとCesiumは厚み0の板だった
const BC_ICON_PLATE_THICK_M = 0.05;
// 床置きの既定寸法（配電盤のような箱を想定）。平面 幅×奥行き、高さ
const BC_FLOOR_ICON_DEFAULTS = { wM: 0.8, dM: 0.6, hM: 1.8, color: '#38BDF8' };

// 機器の取付先は3種類ある。判定はこの3本だけを使い、
// partitionId / doorId を各所に直書きで比較しない（監査指摘）
//
// 【不変条件・2026-08-29】doorId を持つ機器は partitionId を**持たない**。
// 扉が既に partitionId を持っているので、両方に書くと同じ情報の二重管理になる。
// 万一両方持つ壊れたデータが来たら doorId を優先する（Codex監査の助言）。
//   扉の機器: doorId あり
//   壁の機器: doorId なし・partitionId あり
//   床置き  : どちらも無い
// 【2026-10-01 追加】4種目「外周壁の機器」。建屋のガワ（曲面を含む）に貼る。
//   outerKey を持つ。partitionId / doorId は持たない（同じ情報の二重管理を作らない）
function bcIsDoorIcon(icon)  { return !!(icon && icon.doorId); }
function bcIsOuterIcon(icon) { return !!(icon && !icon.doorId && icon.partitionId == null
                                          && icon.outerKey != null); }
function bcIsWallIcon(icon)  { return !!(icon && !icon.doorId && icon.partitionId != null); }
function bcIsCeilIcon(icon)  { return !!(icon && icon.surfaceId === 'ceil'); }
// 床置き＝どの面にも貼っていないもの。天井は面に貼るので床置きではない
function bcIsFloorIcon(icon) { return !icon || (!icon.doorId && icon.partitionId == null
                                                && icon.outerKey == null
                                                && icon.surfaceId !== 'ceil'); }

function bcNewIcon(partitionId, side, sM, tM, opts) {
  const o = opts || {};
  return {
    id: bcNewId('bicon'),
    name: o.name || '機器',
    iconType: o.iconType || 'generic',
    color: o.color || BC_ICON_DEFAULTS.color,
    partitionId: partitionId,     // null なら床置き（bcNewFloorIcon を使う）
    side: side < 0 ? -1 : 1,      // 壁のどちら側の面か
    sM: sM,                       // 端点aからの距離[m]
    tM: tM != null ? tM : BC_ICON_DEFAULTS.tM, // 床からの高さ[m]
    wM: o.wM != null ? o.wM : BC_ICON_DEFAULTS.wM,
    hM: o.hM != null ? o.hM : BC_ICON_DEFAULTS.hM,
  };
}

// ══ 建屋の外周壁に貼る機器 ・2026-10-01 ══
// 【なぜ要るか】機器の取付先が「内部の仕切り」と「扉」しか無く、**建屋のガワに貼れなかった**。
//   イオンモールの外周にコンセント、が入口で弾かれていた。
// 【outerKey】'b<ブロック番号>:<論理辺の名前>'。論理辺は blockOuterEdges が出す。
//   円・扇形は分割数によらず弧1本を 'arcO'（外）/'arcI'（内）と数えるので、
//   あとで分割数や半径を変えても機器は同じ辺に残る（辺番号で覚えると行方不明になる）
function bcOuterHostKey(blockIdx, edgeId) { return 'b' + blockIdx + ':' + edgeId; }
function bcParseOuterKey(key) {
  const m = /^b(\d+):(.+)$/.exec(String(key || ''));
  return m ? { blockIdx: +m[1], edgeId: m[2] } : null;
}
function bcNewOuterIcon(outerKey, side, sM, tM, opts) {
  const o = opts || {};
  return {
    id: bcNewId('bicon'),
    name: o.name || '機器',
    iconType: o.iconType || 'generic',
    color: o.color || BC_ICON_DEFAULTS.color,
    outerKey: outerKey,           // 唯一の所属情報
    side: side < 0 ? -1 : 1,      // 外周壁のどちら側の面か（+1=内側／CCWの左手）
    sM: sM,                       // 辺の始点からの距離[m]（円弧なら弧に沿った長さ）
    tM: tM != null ? tM : BC_ICON_DEFAULTS.tM,
    wM: o.wM != null ? o.wM : BC_ICON_DEFAULTS.wM,
    hM: o.hM != null ? o.hM : BC_ICON_DEFAULTS.hM,
  };
}

// 扉の面に貼る機器（Phase C）。壁面・床置きと**同じ icons[] に混ぜる**。
// 【なぜ扉ローカルの sM か】壁基準（端点aからの距離）のままだと、
// 扉を壁に沿ってスライドさせたときに機器が置き去りになる。
// 扉の左端を原点にすれば、保存値を1つも書き換えずに機器が扉へ追従する。
// 【partitionId を持たせない】扉が既に partitionId を持つので二重管理になる。
// 壁を消したときの道連れは bcPruneOrphanIcons が「壁→扉→扉の機器」の2段で面倒を見る
function bcNewDoorIcon(doorId, side, sM, tM, opts) {
  const o = opts || {};
  return {
    id: bcNewId('bicon'),
    name: o.name || '機器',
    iconType: o.iconType || 'generic',
    color: o.color || BC_ICON_DEFAULTS.color,
    doorId: doorId,               // 唯一の所属情報
    side: side < 0 ? -1 : 1,      // 扉のどちら側の面か（壁面機器と同じ規約）
    sM: sM,                       // 扉の左端（端点a寄りの端）からの距離[m]
    tM: tM != null ? tM : BC_ICON_DEFAULTS.tM, // 扉の下端からの中心高さ[m]
    wM: o.wM != null ? o.wM : BC_ICON_DEFAULTS.wM,
    hM: o.hM != null ? o.hM : BC_ICON_DEFAULTS.hM,
  };
}

// 床置きの機器（床の上に立つ箱）。壁面の機器と**同じ icons[] に混ぜる**。
// 「建物内に置く機器」という同じ概念なので、一覧・選択・削除・描画・ヒットを共通化できる
// 【向き rotDeg も真北基準】2026-08-29 修正。当初PN基準にしたが、
// PNを変えると**設置済みの機器まで世界に対して回ってしまう**（ユーザー指摘）。
// このプロジェクトの原則は「保存する座標は常に真北基準のまま変えない。
// PNは後から変更され得る設定値」。壁も部屋もPNを変えても動かないのに、
// 機器だけ動くのは前提違反だった。向きも真北基準にすればPN変更で何も動かない
function bcNewFloorIcon(gx, gy, opts) {
  const o = opts || {};
  const d = BC_FLOOR_ICON_DEFAULTS;
  return {
    id: bcNewId('bicon'),
    name: o.name || '機器',
    iconType: o.iconType || 'generic',
    color: o.color || d.color,
    partitionId: null,
    gx: gx, gy: gy,                                  // 床の上の位置（グリッド・真北基準）
    rotDeg: o.rotDeg != null ? o.rotDeg : 0,         // 向き（度・真北基準）
    tM: o.tM != null ? o.tM : 0,                     // 床からの立ち上がり[m]（0=床に接する）
    wM: o.wM != null ? o.wM : d.wM,                  // 平面の幅[m]
    dM: o.dM != null ? o.dM : d.dM,                  // 平面の奥行き[m]
    hM: o.hM != null ? o.hM : d.hM,                  // 高さ[m]
  };
}

// 天井に貼る機器（照明・火災感知器・スピーカー）。床置きと**同じ形**で持ち、
// 違うのは「どちらの面に貼っているか」だけ（surfaceId）。tM は天井からの下がり[m]
function bcNewCeilIcon(gx, gy, opts) {
  const o = opts || {};
  const ic = bcNewFloorIcon(gx, gy, o);
  ic.surfaceId = 'ceil';
  ic.tM = o.tM != null ? o.tM : 0;      // 0 = 天井にぴったり
  ic.hM = o.hM != null ? o.hM : 0.15;   // 器具の厚み（床置きの既定1.8mでは天井から落ちて見える）
  ic.color = o.color || '#FCD34D';
  return ic;
}

// 壁のどちら側にその点があるか（±1）。壁線へ射影する**前**の点で判定する。
// 射影後の点は壁の上に乗ってしまい左右が決まらない（監査指摘）
function bcSideOfPart(part, gridPt) {
  const fr = bcWallFrame(part);
  const d = (gridPt.x - part.a.x) * fr.nx + (gridPt.y - part.a.y) * fr.ny;
  return d < 0 ? -1 : 1;
}

// ════════════════════════════════════════════════════════════════
// 取付枠（面）の約束 ・2026-10-01 ユーザー裁定／Codex監査済み
// ════════════════════════════════════════════════════════════════
// 【ユーザー裁定 2026-10-01】
//   「形を作るもの」と「そこに付けるもの」を切り離し、**取付枠＝面だけで接着する**。
//   形のがわは「面を出す」ことだけ約束し、付けるがわは「面のどこに付くか」だけ持つ。
//   電気工事の取付枠と同じ発想：壁の材質が何であれ同じ枠が付くから、器具は壁を知らなくてよい。
//
// 【なぜ必要か】それまでは「壁にコンセント」「扉にコンセント」「床に盤」…と
//   組み合わせごとに処理が書かれていた。形6種 × 付ける物6種 = 最大36通りの手作り。
//   面を間に挟めば 6+6=12 で済み、組み合わせは自動で成立する。
//
// 【面が約束すること（これが契約。守らない面は作らない）】
//   id        … 面の名前。**保存される**。これで「同じ面」を指し続ける
//   kind      … 'wall' | 'door' | 'outer' | 'floor' | 'ceil'（将来 'body' | 'column'）
//   atUV(u,v) … 面の上の位置 → { x, y, z, ux,uy,uz, vx,vy,vz, nx,ny,nz }
//   projectPoint(pt) … その逆 → { u, v, side }
//   spanU, spanV … 面の広がり[m]
//
// 【単位・Codex指摘】**u・v は常にメートル。返る x,y はグリッド、z はメートル**
//   （この図面の既存の規約。XYはグリッド・Zはメートル）。
//   床置きの保存値 gx,gy はグリッドのままにし、ここで u=gx*mpp と読み替えるだけにする
//   （方位PNを変えても設置済み機器が動かない、という過去のユーザー裁定を守るため）。
//
// 【付ける物の寸法は面の種類で決めない・Codex指摘】
//   u方向の大きさ／v方向の大きさ／面から出る厚み、の3つで持つ。
//   垂直な壁では「幅・高さ・厚み」、水平な床では「幅・奥行き・高さ」になるが、同じ3つ。
// ════════════════════════════════════════════════════════════════

// 機器がどの面に付いているか。**保存の形は変えずに**面の名前を作る（Codex指摘の adapter）。
// 旧データ（partitionId / doorId / 床置き）もこの1本で面の名前が取れる
function bcSurfaceIdOf(icon) {
  if (!icon) return null;
  if (icon.surfaceId) return icon.surfaceId;             // これから増える面はこれを持つ
  if (icon.doorId) return 'door:' + icon.doorId;
  if (icon.outerKey) return 'outer:' + icon.outerKey;
  if (icon.partitionId != null) return 'wall:' + icon.partitionId;
  return 'floor';                                        // 床置き（階に1つ）
}

// ══ 面の上の座標 ・2026-10-01 Codex監査済み ══
// 【なぜ要るか】機器の取付先が「直線の仕切り」に固定されていて、建屋の外周壁にも
//   曲面（イオンモールのような扇形の壁）にも機器を貼れなかった。
//   取付先を **「面」＋「面の上の座標(s, t)」** に一般化する。
// 【面が持つ2つの向き】
//   atS(uM)          … 面の上の位置 uM[m] での {点(グリッド), 接線u, 法線n}
//   projectPoint(pt) … その逆。図面の点 → {uM, side(表裏)}
//   **平面では u も n も面内で一定**なので従来式と1ピクセルも変わらない。
//   曲面では uM ごとに接線・法線が回る。この差をここ1箇所に閉じ込める。
// 【なぜ逆変換も持たせるか・Codex指摘】置くとき（bcIconSpotAtFacePoint）と
//   掴んで動かすときで別々に射影を書くと、置いた位置と掴んだ位置がズレる。
//   往きと帰りを必ず同じ面の定義から作る。
const _BC_SURF_FLAG = '__ICON_SURFACE_FRAME';
function _bcSurfFrameOn() {
  return !(typeof window !== 'undefined' && window[_BC_SURF_FLAG] === false);
}
// ══ 円弧の面（曲面）・2026-10-01 ══
// 【これが扇形の壁にコンセントを貼れるようにする本体】
//   円筒面は**展開すると長方形**なので、弧に沿った長さ uM と高さ tM の2つで位置が決まる。
//   平らな面との違いは「進むと接線・法線が回る」ことだけ。そこを atS に閉じ込める。
// 【法線の向きは直線の壁と同じ規則】n =（進行方向の左手）。
//   外周を反時計回りにたどると左手が建屋の内側になるので、side=+1 が内側で一致する。
const _BC_ARC_FLAG = '__ICON_ARC_HOST';
function _bcArcHostOn() {
  return !(typeof window !== 'undefined' && window[_BC_ARC_FLAG] === false);
}
function _bcArcSurface(edge, base) {
  const mpp = _bcMpp();
  const R = edge.r;                                    // 半径（グリッド）
  const sgn = edge.sweep >= 0 ? 1 : -1;                // 回る向き
  const lenM = Math.abs(edge.sweep) * R * mpp;         // 弧の長さ[m]
  const atS = (uM) => {
    const th = edge.a0 + sgn * (uM / mpp) / R;
    const ux = -Math.sin(th) * sgn, uy = Math.cos(th) * sgn;
    return { x: edge.cx + R * Math.cos(th), y: edge.cy + R * Math.sin(th),
             ux, uy, nx: -uy, ny: ux };                // 法線＝進行方向の左手（直線と同じ規則）
  };
  const TAU = Math.PI * 2, swAbs = Math.abs(edge.sweep);
  const projectPoint = (gridPt) => {
    let d = (Math.atan2(gridPt.y - edge.cy, gridPt.x - edge.cx) - edge.a0) * sgn;
    d = ((d % TAU) + TAU) % TAU;
    // 弧の外（裏側の空き角）をクリックしたら近い方の端へ寄せる
    if (d > swAbs) d = (d - swAbs) < (TAU - d) ? swAbs : 0;
    const uM = Math.max(0, Math.min(lenM, d * R * mpp));
    const at = atS(uM);
    const side = ((gridPt.x - at.x) * at.nx + (gridPt.y - at.y) * at.ny) < 0 ? -1 : 1;
    return { uM, side };
  };
  const at0 = atS(0);
  return Object.assign({}, base, {
    curved: true, arc: edge, atS, projectPoint,
    // fr は「弧の始点での向き」。曲面では場所ごとに変わるので**これだけを見てはいけない**。
    // 残してあるのは、向きを1つだけ要る所（ラベルの並べ方など）が落ちないようにするため
    fr: { ux: at0.ux, uy: at0.uy, nx: at0.nx, ny: at0.ny, lenGrid: Math.abs(edge.sweep) * R },
    ax: { x: at0.x, y: at0.y },
    originSM: 0, spanSM: lenM,
  });
}

// 面を外へ出す前の仕上げ。**面を作る道が何本あっても、出口はここ1つ**。
// 名前(id)・種類(kind)・面の上の座標(atUV/projectUV)はここでしか付けない
function _bcFinishSurface(fm, id, kind) {
  if (!fm) return null;
  fm.id = id;
  fm.kind = kind || fm.host;
  // 【面の契約の一部・2026-10-04 Codex監査】「貼った物の背面を面からどれだけ離すか」は面が決める。
  //   扉だけ片面フラッシュで違う（扉の面が下で上書きする）。ここに既定を置くことで、
  //   機器の幾何から host==='door' の分岐を消せる。
  //   新しい面を足す人は atUV / projectUV だけ書けばよく、離れ方は既定のままでよい。
  //   返す nOff は**符号込みのグリッド**、faceSgn はその面の外向き（板を押し出す向き）
  if (typeof fm.mountOffsetGrid !== 'function') {
    fm.mountOffsetGrid = (sg) => ({ nOff: (fm.offGrid || 0) * sg, faceSgn: sg });
  }
  _bcAddUV(fm);
  return fm;
}

// 平らな面に atS / projectPoint を付ける（既に持っている面＝曲面はそのまま通す）
function _bcSurface(fm) {
  if (!fm || (fm.atS && fm.projectPoint)) return fm;
  const mpp = _bcMpp();
  const fr = fm.fr, ax = fm.ax, part = fm.part;
  fm.atS = (uM) => ({
    x: ax.x + fr.ux * (uM / mpp), y: ax.y + fr.uy * (uM / mpp),
    ux: fr.ux, uy: fr.uy, nx: fr.nx, ny: fr.ny,
  });
  fm.projectPoint = (gridPt) => ({
    uM: bcDoorUAtPoint(part, gridPt), side: bcSideOfPart(part, gridPt),
  });
  fm.curved = false;
  _bcAddUV(fm);
  return fm;
}

// 垂直な面（壁・扉・外周・円弧）に atUV / projectUV を足す。
// v は面の下端からの高さ[m]。u は面の上を沿って進んだ距離[m]（曲面なら弧長）
function _bcAddUV(fm) {
  if (!fm || fm.atUV) return fm;      // 水平面は自前で持っているので触らない
  fm.vertical = true;
  fm.spanU = fm.spanSM; fm.spanV = fm.spanTM;
  fm.atUV = (u, v) => {
    const a = fm.atS(fm.originSM + u);
    return { x: a.x, y: a.y, z: fm.baseZ + v,
             ux: a.ux, uy: a.uy, uz: 0,          // 面に沿う向き（水平）
             vx: 0, vy: 0, vz: 1,                // 面の上向き
             nx: a.nx, ny: a.ny, nz: 0 };        // 面から出る向き
  };
  fm.projectUV = (pt) => {
    const r = fm.projectPoint(pt);
    return { u: Math.max(0, Math.min(fm.spanU, r.uM - fm.originSM)),
             v: Number.isFinite(pt.z) ? Math.max(0, Math.min(fm.spanV, pt.z - fm.baseZ)) : null,
             side: r.side };
  };
  return fm;
}

// 水平な面（床・天井）。u,v は世界のX,Y[m]（方位PNに依存しない＝既存の床置きと同じ基準）。
// 【床と天井の違いは法線の向きだけ】床は上向き、天井は下向き（どちらも部屋の中を向く）
function _bcFlatSurface(base) {
  const mpp = _bcMpp();
  const up = base.kind === 'ceil' ? -1 : 1;
  return Object.assign({}, base, {
    vertical: false, horizontal: true, curved: false,
    atUV: (u, v) => ({ x: u / mpp, y: v / mpp, z: base.planeZ,
                       ux: 1, uy: 0, uz: 0, vx: 0, vy: 1, vz: 0,
                       nx: 0, ny: 0, nz: up }),
    projectUV: (pt) => ({ u: pt.x * mpp, v: pt.y * mpp, side: 1 }),
    // 垂直面と同じ名前でも呼べるようにしておく（呼び分けを各所に書かないため）
    atS: (u) => ({ x: u / mpp, y: 0, ux: 1, uy: 0, nx: 0, ny: 1 }),
    projectPoint: (pt) => ({ uM: pt.x * mpp, side: 1 }),
  });
}

// ════════════════════════════════════════════════════════════════
// 取付面（frame）— 機器がどこに貼られているかを解決する唯一の関数
// ════════════════════════════════════════════════════════════════
// 【2026-08-29 新設】機器の取付先が「壁に直接」と「扉の面」の2種になったので、
// その差をここ1箇所に閉じ込める。bcIconAnchorGeom・クランプ・収まり判定・
// 一覧の分類がすべてこの不変条件に従う形にすることで、分岐が各所へ散らない
// （Codex監査「壁と扉の基準差を吸収する関数ではなく、取付面を解決する唯一の関数と
//   位置づけた方が安全」）。
//
// 【将来 isOpen（扉が開いて壁から離れて回る）を入れるとき】
// ux/uy・nx/ny・原点を「扉面の今の姿勢」に差し替えるだけでよい形にしてある。
// 機器側（bcIconAnchorGeom 以下）は frame を読むだけなので無改造で済む
// ════════════════════════════════════════════════════════════════

// 扉が壁よりどれだけ厚いか（グリッド）。Zファイト（同一面のちらつき）を避けるための逃げ。
// 従来 bcDoorGeoms に直書きされていた 0.3 をここへ出した
const BC_DOOR_ZFIGHT_GRID = 0.3;

// 扉1枚の幾何を出す唯一の正。描画（bcDoorGeoms）と機器のアンカー（bcIconFrame）が
// 同じ値を読むので、扉の見た目と機器の乗る位置がズレようがない。
// 【baseM を足す・2026-08-29 修正】腰壁（baseM で浮かせた壁）に扉を付けると
// 扉だけ床まで落ちていた。壁も壁面機器も baseM を足しているのに扉だけ足していなかった
function bcDoorFrame(floor, part, door) {
  if (!floor || !part || part.kind !== 'wall' || !door) return null;
  const mpp = _bcMpp();
  const fr = bcWallFrame(part);
  if (!(fr.lenGrid > 1e-9)) return null;
  const lenM = bcPartitionLenM(part);
  const halfM = (door.widthM != null ? door.widthM : BC_DOOR_DEFAULTS.widthM) / 2;
  const uLeftM  = Math.max(0,    (door.uM || 0) - halfM);
  const uRightM = Math.min(lenM, (door.uM || 0) + halfM);
  // 判定はグリッドで行う（従来 bcDoorGeoms が c2-c1 をグリッドで見ていたのと同値にする）
  if ((uRightM - uLeftM) / mpp < 1e-9) return null;
  const wallH = part.heightM != null ? part.heightM : floor.heightM;
  const zB = floor.levelZ + (part.baseM || 0);
  const zT = zB + Math.min(door.heightM || BC_DOOR_DEFAULTS.heightM, wallH);
  // 【扉は壁の片面にフラッシュ・2026-09-03・Codex/7エージェント監査済み】
  // 対称配置(±halfThickGrid)は薄い扉を壁厚の中央に埋めてしまう。扉厚みと壁厚を分離し、
  // 選んだ面 s の壁面にフラッシュ（Z逃げで僅かに手前）・内側へ扉厚みぶん伸ばす統一式にする。
  // faceSide/thicknessM を持たない旧扉はここで既定(+1/壁厚)を補完（保存側にバックフィル無し
  // ＝素通り保存のため、コード側で読むのが後方互換の唯一の担保。旧扉のNaN欠落を防ぐ）。
  const wallThickM = (part.thicknessM || BC_PARTITION_DEFAULTS.thicknessM);
  const doorThickM = (door.thicknessM != null ? door.thicknessM : wallThickM);
  const wallHalfGrid = wallThickM / mpp / 2;
  const doorThickGrid = doorThickM / mpp;
  const Z = BC_DOOR_ZFIGHT_GRID;
  const s = (door.faceSide === -1 ? -1 : 1);            // 取付面（±1・既定+1）
  const pokeInner = (doorThickGrid >= 2 * wallHalfGrid) ? Z : 0; // 扉が壁を満たす/貫くときだけ裏面もZ逃げ
  return {
    door, part, fr,
    uLeftM, uRightM, spanSM: uRightM - uLeftM,
    zB, zT, spanTM: zT - zB,
    // 面sの壁面にフラッシュした外面／扉厚みぶん内側へ入った内面（いずれも符号込みグリッド）。
    // 扉厚=壁厚(既定)なら nOuter=+(wallHalf+Z)/nInner=-(wallHalf+Z) で従来の対称±に厳密一致。
    nOuterGrid: s * (wallHalfGrid + Z),
    nInnerGrid: s * (wallHalfGrid - doorThickGrid - pokeInner),
    faceMagGrid: wallHalfGrid + Z,   // 外面の大きさ（機器の壁面基準・既定で旧halfThickGridと同値）
    mountSide: s,                     // 取付面の符号（機器アンカーがこれに追従）
  };
}

// 機器が乗る取付面を解決する。壁か扉かの差はこの関数にだけ閉じる。
// icon は { doorId } / { partitionId } さえ入っていればよい（配置前の仮の物でも通る）
// 【第3引数 building・2026-10-01】外周壁のホストは建屋の形（blocks）を見ないと解けない。
//   壁・扉のときは使わないので、既存の呼び出し（2引数）はそのまま通る
function bcIconFrame(floor, icon, building) {
  if (!floor || bcIsFloorIcon(icon)) return null;   // 床置きは取付面を持たない
  if (bcIsCeilIcon(icon)) return bcFlatFrame(building, floor, 'ceil');
  const mpp = _bcMpp();
  if (bcIsOuterIcon(icon)) return bcOuterFrame(building, floor, icon.outerKey);
  const parts = floor.partitions || [];
  if (bcIsDoorIcon(icon)) {
    const door = (floor.doors || []).find(d => d.id === icon.doorId);
    if (!door) return null;
    const fm = bcDoorFrame(floor, parts.find(p => p.id === door.partitionId), door);
    if (!fm) return null;
    return _bcFinishSurface(_bcSurface({
      host: 'door', part: fm.part, door, fr: fm.fr, ax: fm.part.a,
      originSM: fm.uLeftM, spanSM: fm.spanSM,
      baseZ: fm.zB, spanTM: fm.spanTM,
      // 機器は扉の実面に乗せる。外面(nOuter)/内面(nInner)の両方を渡し、
      // bcIconAnchorGeom が icon.side と mountSide から乗る面を選ぶ（faceSideに追従）。
      // 対称扉(既定)では nOuter=-nInner なので従来の offGrid*sgn と一致（回帰なし）。
      nOuterGrid: fm.nOuterGrid, nInnerGrid: fm.nInnerGrid, mountSide: fm.mountSide,
      // 【離れ方は面が決める・2026-10-04】扉は片面フラッシュ。icon.side が取付面(mountSide)側なら
      //   外面(nOuter)、逆なら扉の内面(nInner)に乗せる。**式は従来のまま置き場所だけ面へ移した**
      //   （機器の幾何から種類の if を無くすため・Codex監査）
      mountOffsetGrid: (sg) => {
        const onOuter = (sg === fm.mountSide);
        const faceSgn = onOuter ? fm.mountSide : -fm.mountSide;   // その面の外向き
        return { nOff: (onOuter ? fm.nOuterGrid : fm.nInnerGrid) + faceSgn * (0.005 / mpp),
                 faceSgn };
      },
    }), 'door:' + door.id, 'door');
  }
  const part = parts.find(p => p.id === icon.partitionId);
  if (!part) return null;
  return _bcFinishSurface(_bcSurface({
    host: 'wall', part, door: null, fr: bcWallFrame(part), ax: part.a,
    originSM: 0, spanSM: bcPartitionLenM(part),
    baseZ: floor.levelZ + (part.baseM || 0),
    spanTM: part.heightM != null ? part.heightM : floor.heightM,
    offGrid: ((part.thicknessM || BC_PARTITION_DEFAULTS.thicknessM) / 2 + 0.005) / mpp,
  }), 'wall:' + part.id, 'wall');
}

// ══ 外周壁の面を解く ・2026-10-01 ══
// その階の高さにかかるブロックの論理辺を1本選び、機器を貼れる面にして返す。
// 【厚みの扱いは仕切り壁と同じ式】外形線を壁の中心線と見て、半厚＋0.005m 浮かせる。
//   厚み未設定（=0）の建屋では従来どおり面にぴったり貼る
const BC_OUTER_FLAG = '__ICON_OUTER_HOST';
function _bcOuterHostOn() {
  return !(typeof window !== 'undefined' && window[BC_OUTER_FLAG] === false);
}
// その階にかかるブロックの論理辺を全部返す（機器を置く先の一覧・当たり判定に使う）
function bcFloorOuterEdges(building, floor) {
  if (!_bcOuterHostOn()) return [];
  if (!building || !floor || typeof blockOuterEdges !== 'function') return [];
  const z = floor.levelZ, out = [];
  // 【選び方は述語1つ・2026-11-05】ここは**生の上端**を見る（床は安全側）。
  //   コメントで「bcFloorOutlines と同じ選び方」と書いていたが実際は違っていた。
  //   差は層が両方持つので、どちらを見ているかがここで分かる形にした
  (bcHostLayers(building) || []).forEach(({ idx: bi, blk, zB, zTop }) => {
    if (!bcSpanHoldsZ(zB, zTop, z)) return;
    blockOuterEdges(blk).forEach(e => {
      if (e.kind === 'arc' && !_bcArcHostOn()) return;   // 曲面ホストを切ったとき（陽性対照）
      out.push(Object.assign({}, e, {
        blockIdx: bi, key: bcOuterHostKey(bi, e.edgeId),
        lenM: e.kind === 'arc' ? Math.abs(e.sweep) * e.r * _bcMpp()
                               : Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) * _bcMpp(),
      }));
    });
  });
  return out;
}
function bcOuterFrame(building, floor, outerKey) {
  if (!_bcOuterHostOn() || !building || !floor) return null;
  const ref = bcParseOuterKey(outerKey);
  if (!ref) return null;
  const 層ら = bcHostLayers(building);
  if (!層ら) return null;             // まだ計算していない
  const 層 = 層ら.find(L => L.idx === ref.blockIdx);
  const blk = 層 && 層.blk;
  if (!blk || typeof blockOuterEdges !== 'function') return null;
  const edge = blockOuterEdges(blk).find(e => e.edgeId === ref.edgeId);
  if (!edge) return null;
  const mpp = _bcMpp();
  const zB = 層.zB, zT = 層.zTop;     // 外壁は生の上端（bcFloorOuterEdges と同じ）
  const baseZ = Math.max(floor.levelZ, zB);
  const spanTM = Math.max(0, Math.min(floor.levelZ + floor.heightM, zT) - baseZ);
  const base = {
    host: 'outer', part: null, door: null, blockIdx: ref.blockIdx, edge,
    outerKey, baseZ, spanTM,
    offGrid: ((blk.wallThicknessM || 0) / 2 + 0.005) / mpp,
  };
  if (edge.kind === 'arc') {
    if (!_bcArcHostOn()) return null;
    return _bcFinishSurface(_bcArcSurface(edge, base), 'outer:' + outerKey, 'outer');
  }
  // 直線の辺は仕切り壁とまったく同じ扱い（仮の part を作って既存の道を通す）
  const part = { id: outerKey, a: edge.a, b: edge.b,
                 thicknessM: blk.wallThicknessM || 0, kind: 'wall' };
  return _bcFinishSurface(_bcSurface(Object.assign({}, base, {
    part, fr: bcWallFrame(part), ax: part.a,
    originSM: 0, spanSM: bcPartitionLenM(part),
  })), 'outer:' + outerKey, 'outer');
}

// ══ 面の一覧（形のがわが出す取付枠の全部）・2026-10-01 ══
// 【これが供給の唯一の入口】付けるがわ（機器・盤・扉・ケーブル端）はここから面を貰い、
//   形の種類を一切知らない。形を増やすときはここに1行足すだけで、全部の設備が載る。
// opts.kinds で絞れる（既定は全部）
function bcSurfacesOf(building, floor, opts) {
  if (!floor) return [];
  const o = opts || {};
  const want = o.kinds ? new Set(o.kinds) : null;
  const 要る = (k) => !want || want.has(k);
  const out = [];
  if (要る('wall')) for (const part of (floor.partitions || [])) {
    const fm = bcIconFrame(floor, { partitionId: part.id }, building);
    if (fm) out.push(fm);
  }
  if (要る('door')) for (const d of (floor.doors || [])) {
    const fm = bcIconFrame(floor, { doorId: d.id }, building);
    if (fm) out.push(fm);
  }
  if (要る('outer')) for (const e of bcFloorOuterEdges(building, floor)) {
    const fm = bcOuterFrame(building, floor, e.key);
    if (fm) out.push(fm);
  }
  if (要る('floor')) { const fm = bcFlatFrame(building, floor, 'floor'); if (fm) out.push(fm); }
  if (要る('ceil'))  { const fm = bcFlatFrame(building, floor, 'ceil');  if (fm) out.push(fm); }
  return out;
}

// 床・天井の面。**天井は下向き**（どちらも部屋の中を向く）
function bcFlatFrame(building, floor, kind) {
  if (!floor) return null;
  const 天井 = kind === 'ceil';
  const planeZ = 天井 ? floor.levelZ + floor.heightM : floor.levelZ;
  // 広がりは床の外形の外接矩形（置ける範囲の目安。はみ出しは警告で見る＝床置きと同じ扱い）
  let 幅 = 0, 奥 = 0;
  const polys = bcFloorOutlines(building, floor);
  if (polys.length && polys[0].length) {
    const xs = polys[0].map(q => q.x), ys = polys[0].map(q => q.y);
    幅 = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * _bcMpp();
    奥 = (Math.max.apply(null, ys) - Math.min.apply(null, ys)) * _bcMpp();
  }
  return _bcFinishSurface(_bcFlatSurface({
    id: kind, kind, host: kind, part: null, door: null,
    planeZ, baseZ: planeZ, spanTM: floor.heightM,
    spanU: 幅, spanV: 奥, spanSM: 幅,
    originSM: 0, offGrid: 0,
  }), kind, kind);
}

// 面の名前（bcSurfaceIdOf が返すもの）から面を引く。保存された機器を解くときの唯一の道
function bcSurfaceById(building, floor, id) {
  if (!floor || !id) return null;
  if (id === 'floor' || id === 'ceil') return bcFlatFrame(building, floor, id);
  const i = String(id).indexOf(':');
  if (i < 0) return null;
  const 種 = id.slice(0, i), 名 = id.slice(i + 1);
  if (種 === 'wall')  return bcIconFrame(floor, { partitionId: 名 }, building);
  if (種 === 'door')  return bcIconFrame(floor, { doorId: 名 }, building);
  if (種 === 'outer') return bcOuterFrame(building, floor, 名);
  return null;
}

// ════════════════════════════════════════════════════════════════
// CSG立体（bodies）の平らな面を取付枠にする ・2026-10-03
// ════════════════════════════════════════════════════════════════
// 【なぜ要るか】実在の形を27通り掃引したら、**10件が「立体でなら形は作れるのに
//   設備が1つも付かない」**だった（配置図/checks/bld_shape_coverage.cjs）。
//   吹き抜け・壁の開口・ドーム・タンクの胴 … 形はあるのにコンセントが置けない。
//   形のがわが2系統（建屋／立体）あること自体より、
//   **設備を付ける契約が片方にしか無いこと**が本体（2026-10-03 Codex判定）。
//   ここで立体の面を建屋の壁と同じ約束にすれば、貼る側（bcIconAnchorGeom・盤の mount）は
//   1行も変えずに立体へも置ける。
//
// 【鉛直な面だけ出す】機器も盤も「立つ箱」としてしか置けない（変換器が yaw しか持たない）。
//   傾いた屋根面・水平な上面は、置き方の工事が別に要るので今は出さない。
//
// 【面の名前】三角形の番号で名付けると、押し引きのたびにメッシュが作り直されて
//   機器が迷子になる。**平面の向きと位置**で名付ける（同じ平面なら同じ名前）。
//   位置が動いたときに拾い直すのは bcRebindBodyIcon（下）。

// 面の名前のもとになる指紋。向き(法線)と、原点からその平面までの距離
function bcBodyFaceKey(grp) {
  if (!grp || !grp.n || !grp.o) return null;
  const r = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
  const d = grp.n[0] * grp.o[0] + grp.n[1] * grp.o[1] + grp.n[2] * grp.o[2];
  return 'n' + r(grp.n[0]) + '_' + r(grp.n[1]) + '_' + r(grp.n[2]) + '@' + r(d);
}
function bcBodySurfaceId(bodyId, grp) {
  const k = bcBodyFaceKey(grp);
  return k ? ('body:' + bodyId + ':' + k) : null;
}
// 'body:<立体id>:<指紋>' を分解する
function bcParseBodySurfaceId(id) {
  const m = /^body:([^:]+):(.+)$/.exec(String(id || ''));
  return m ? { bodyId: m[1], key: m[2] } : null;
}

// 平らな面のまとまり（csgPlanarFaces の group）→ 取付枠1枚。鉛直でなければ null
// 面の傾きの見分け（Codex: boolean でなく種類で持つ。水平面を足すときに曖昧にならない）
//   vertical-wall    … 立っている面。従来の壁と同じ道で機器を置く
//   tilted-plane     … 傾いた面（屋根）。面の3軸で板を作る別の道
//   horizontal-plane … 寝た面。**今は出さない**（床・天井と意味が重なるので後の工事）
function bcPlaneMountKind(nz) {
  const a = Math.abs(nz);
  if (a < 0.15) return 'vertical-wall';
  if (a > 0.95) return 'horizontal-plane';
  return 'tilted-plane';
}
// 傾きが急すぎる面は出さない。真上から見た外接の角柱で描くので、
// 立ちすぎた面だと機器が実物よりかなり太って見える（Codex助言: 60°を目安）
const BC_TILT_MAX_DEG = 60;

function bcBodySurfaceOf(bodyId, grp) {
  if (!grp || !grp.n || !grp.o || !grp.u || !grp.v) return null;
  const n = grp.n;
  const 種 = bcPlaneMountKind(n[2]);
  if (種 === 'horizontal-plane') return null;        // 寝た面は今は出さない
  if (種 === 'tilted-plane') {
    if (typeof window !== 'undefined' && window.__BODY_TILTED === false) return null;
    // 傾き（水平からの角度）。急すぎるものは出さない
    const 傾deg = Math.acos(Math.min(1, Math.abs(n[2]))) * 180 / Math.PI;
    if (傾deg > BC_TILT_MAX_DEG) return null;
    return bcBodyTiltedSurfaceOf(bodyId, grp);
  }
  const mpp = _bcMpp();
  // 面に沿った**水平**の向き（法線とZ軸の外積）。建屋の壁の ux,uy と同じ役
  let hx = -n[1], hy = n[0];
  const HL = Math.hypot(hx, hy);
  if (!(HL > 1e-9)) return null;
  hx /= HL; hy /= HL;
  // 輪郭（平面内の2D座標 a,b）を世界へ戻し、(水平距離, 高さ) の範囲を測る
  const o = grp.o, u = grp.u, v = grp.v;
  let sMin = Infinity, sMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  let ox = 0, oy = 0, 初 = true;
  (grp.contours || []).forEach(c2 => c2.forEach(([a, b]) => {
    const X = o[0] + u[0] * a + v[0] * b;
    const Y = o[1] + u[1] * a + v[1] * b;
    const Z = o[2] + u[2] * a + v[2] * b;
    const sv = X * hx + Y * hy;          // 水平方向の位置[m]（原点からの投影）
    if (sv < sMin) { sMin = sv; }
    if (sv > sMax) sMax = sv;
    if (Z < zMin) zMin = Z;
    if (Z > zMax) zMax = Z;
    if (初) { ox = X; oy = Y; 初 = false; }
  }));
  if (!(sMax > sMin + 1e-9 && zMax > zMin + 1e-9)) return null;
  // 面の水平方向の原点（sMin の位置にある面上の点）
  const p0x = ox + hx * (sMin - (ox * hx + oy * hy));
  const p0y = oy + hy * (sMin - (ox * hx + oy * hy));
  const fm = {
    host: 'body', bodyId,
    // 建屋の壁と同じ持ち物（bcIconAnchorGeom がこれを使う）
    fr: { ux: hx, uy: hy, nx: n[0], ny: n[1] },
    ax: { x: p0x / mpp, y: p0y / mpp },
    originSM: 0, spanSM: sMax - sMin,
    baseZ: zMin, spanTM: zMax - zMin,
    offGrid: 0.005 / mpp,            // 面から僅かに浮かせる（壁と同じ作法）
    atS: (sM) => ({ x: (p0x + hx * sM) / mpp, y: (p0y + hy * sM) / mpp,
                    ux: hx, uy: hy, nx: n[0], ny: n[1] }),
    projectPoint: (gridPt) => {
      const X = gridPt.x * mpp, Y = gridPt.y * mpp;
      const sv = (X - p0x) * hx + (Y - p0y) * hy;
      const 側 = ((X - p0x) * n[0] + (Y - p0y) * n[1]) >= 0 ? 1 : -1;
      return { uM: Math.max(0, Math.min(sMax - sMin, sv)), side: 側 };
    },
    curved: false,
    areaM2: grp.areaM2 || 0,
    centerG: grp.centerG || null,
  };
  return _bcFinishSurface(fm, bcBodySurfaceId(bodyId, grp), 'body');
}

// 曲面（鉛直な円筒）の名前。軸の位置・半径・高さ範囲で決める（三角形の番号は使わない）
function bcBodyCurvedId(bodyId, cyl) {
  const r = (v) => (Math.round(v * 100) / 100).toFixed(2);
  return 'body:' + bodyId + ':cyl' + r(cyl.cx) + '_' + r(cyl.cy) + '_' + r(cyl.r)
       + '@' + r(cyl.z0) + '-' + r(cyl.z1);
}

// 立体の曲面（鉛直な円筒）を取付枠にする ・2026-10-03
// 【なぜ既にある円弧の面を使うか】扇形の外壁の曲面にコンセントを貼る仕組み（_bcArcSurface）が
//   そのまま使える。曲面の面の実装を2つ持つと、片方だけ直る食い違いが必ず出る。
//   ここがやるのは「CSGが見つけた円筒を、その関数に渡せる形に直す」ことだけ。
function bcBodyCurvedSurfaceOf(bodyId, cyl) {
  if (!cyl || !(cyl.r > 0) || !(cyl.z1 > cyl.z0)) return null;
  const mpp = _bcMpp();
  const base = {
    host: 'body', bodyId, curvedBody: true,
    baseZ: cyl.z0, spanTM: cyl.z1 - cyl.z0,
    offGrid: 0.005 / mpp,                 // 面から僅かに浮かせる（壁と同じ作法）
    areaM2: Math.abs(cyl.sweep) * cyl.r * mpp * (cyl.z1 - cyl.z0),
  };
  const fm = _bcArcSurface({ cx: cyl.cx, cy: cyl.cy, r: cyl.r,
                             a0: cyl.a0, sweep: cyl.sweep }, base);
  return _bcFinishSurface(fm, bcBodyCurvedId(bodyId, cyl), 'body');
}

// 傾いた面（屋根）の取付枠 ・2026-10-03
// 【鉛直面と何が違うか】鉛直面は「面に沿った水平距離 u ・高さ v」で表せるが、
//   傾いた面はどちらの軸も水平でも鉛直でもない。**平面の基底 u,v をそのまま使う**。
//   u は「傾きを登る向きから見て横」、v は「斜面を登る向き」になるよう揃える。
function bcBodyTiltedSurfaceOf(bodyId, grp) {
  const mpp = _bcMpp();
  const n = grp.n, o = grp.o;
  // 面の中の2軸を「横（水平）」と「斜面を登る向き」に揃える。
  // 横 = n × z軸（必ず水平になる）、登る = n × 横
  let hx = -n[1], hy = n[0], hz = 0;
  const HL = Math.hypot(hx, hy);
  if (!(HL > 1e-9)) return null;                 // 真上を向いた面（ここには来ない）
  hx /= HL; hy /= HL;
  const ex = n[1] * hz - n[2] * hy, ey = n[2] * hx - n[0] * hz, ez = n[0] * hy - n[1] * hx;
  const EL = Math.hypot(ex, ey, ez);
  if (!(EL > 1e-9)) return null;
  const Ux = hx, Uy = hy, Uz = hz;                     // 横
  const Vx = ex / EL, Vy = ey / EL, Vz = ez / EL;      // 斜面を登る向き
  // 輪郭（平面内の a,b）を世界へ戻し、(横 U, 登り V) での範囲を測る
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  (grp.contours || []).forEach(c2 => c2.forEach(([a, b]) => {
    const X = o[0] + grp.u[0] * a + grp.v[0] * b;
    const Y = o[1] + grp.u[1] * a + grp.v[1] * b;
    const Z = o[2] + grp.u[2] * a + grp.v[2] * b;
    const uu = X * Ux + Y * Uy + Z * Uz, vv = X * Vx + Y * Vy + Z * Vz;
    if (uu < u0) u0 = uu; if (uu > u1) u1 = uu;
    if (vv < v0) v0 = vv; if (vv > v1) v1 = vv;
  }));
  if (!(u1 > u0 + 1e-9 && v1 > v0 + 1e-9)) return null;
  // 面の上の原点（u0,v0 の点を面へ落とした所）
  const d0 = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
  const 原点 = (() => {
    const px = Ux * u0 + Vx * v0, py = Uy * u0 + Vy * v0, pz = Uz * u0 + Vz * v0;
    const t = d0 - (n[0] * px + n[1] * py + n[2] * pz);
    return [px + n[0] * t, py + n[1] * t, pz + n[2] * t];
  })();
  const atUV = (uu, vv) => {
    const X = 原点[0] + Ux * uu + Vx * vv;
    const Y = 原点[1] + Uy * uu + Vy * vv;
    const Z = 原点[2] + Uz * uu + Vz * vv;
    return { x: X / mpp, y: Y / mpp, z: Z,
             ux: Ux, uy: Uy, uz: Uz, vx: Vx, vy: Vy, vz: Vz,
             nx: n[0], ny: n[1], nz: n[2] };
  };
  const projectUV = (pt) => {
    const X = pt.x * mpp, Y = pt.y * mpp;
    const Z = Number.isFinite(pt.z) ? pt.z : 原点[2];
    const dx = X - 原点[0], dy = Y - 原点[1], dz = Z - 原点[2];
    return { u: Math.max(0, Math.min(u1 - u0, dx * Ux + dy * Uy + dz * Uz)),
             v: Math.max(0, Math.min(v1 - v0, dx * Vx + dy * Vy + dz * Vz)),
             side: (dx * n[0] + dy * n[1] + dz * n[2]) >= 0 ? 1 : -1 };
  };
  const fm = {
    host: 'body', bodyId, mountKind: 'tilted-plane',
    vertical: false, horizontal: false, curved: false, tilted: true,
    spanU: u1 - u0, spanV: v1 - v0,
    atUV, projectUV,
    baseZ: atUV(0, 0).z, spanTM: v1 - v0,
    originSM: 0, spanSM: u1 - u0,
    offGrid: 0.005 / mpp,
    areaM2: grp.areaM2 || 0,
    傾deg: Math.acos(Math.min(1, Math.abs(n[2]))) * 180 / Math.PI,
    // 向きを1つだけ要る所（ラベルの並べ方など）が落ちないように代表値を置く
    fr: { ux: Ux, uy: Uy, nx: n[0], ny: n[1] },
    ax: { x: 原点[0] / mpp, y: 原点[1] / mpp },
    atS: (uM) => { const a = atUV(uM, 0);
                   return { x: a.x, y: a.y, ux: Ux, uy: Uy, nx: n[0], ny: n[1] }; },
    projectPoint: (gridPt) => { const r = projectUV(gridPt); return { uM: r.u, side: r.side }; },
  };
  return _bcFinishSurface(fm, bcBodySurfaceId(bodyId, grp), 'body');
}

// 輪郭の「始点」と「回る向き」をそろえる・2026-10-04
// 【なぜ要るか】凸包は始点も向きも実装まかせ。同じ形なのに辺の順が変わると、
//   見た目の比較・回帰検査・描画の対応付けが効かなくなる。
//   板の「面側の左下(p0) → 面側の右下(p1)」の並びに合わせて回し直す。
//   これで鉛直な壁では従来の [左下, 右下, 外右下, 外左下] と**完全に同じ並び**になる。
function _bcNormalizeOutlineStart(poly, p0, p1) {
  if (!poly || poly.length < 3) return poly;
  const d2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
  const n = poly.length;
  let k = 0;
  for (let i = 1; i < n; i++) if (d2(poly[i], p0) < d2(poly[k], p0)) k = i;
  const 次 = poly[(k + 1) % n], 前 = poly[(k - 1 + n) % n];
  const 逆 = d2(前, p1) < d2(次, p1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(poly[(((k + (逆 ? -i : i)) % n) + n) % n]);
  return out;
}

// 向きを持った板の8点 → 「真上から見た輪郭 × 高さ範囲」の角柱・2026-10-03
// 【なぜ角柱に直すか】平面図も3次元図も「底面の輪郭 × zB〜zT」の1つのリストで描いている。
//   傾いた板をそのまま描く道を足すと、窓ごとに描き方が増える。
//   **外側に接する角柱**で近似する（小さな機器なら見た目の差は小さい。急勾配は面の側で弾く）
function _bcOrientedBoxToPrism(pts) {
  if (!pts || pts.length < 3) return null;
  let zB = Infinity, zT = -Infinity;
  pts.forEach(q => { if (q.z < zB) zB = q.z; if (q.z > zT) zT = q.z; });
  // 真上から見た凸包（Andrew の方法）
  const ps = pts.map(q => ({ x: q.x, y: q.y }))
    .sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const 外 = (o2, a, b) => (a.x - o2.x) * (b.y - o2.y) - (a.y - o2.y) * (b.x - o2.x);
  const 下 = [], 上 = [];
  for (const p of ps) { while (下.length >= 2 && 外(下[下.length - 2], 下[下.length - 1], p) <= 0) 下.pop(); 下.push(p); }
  for (let i = ps.length - 1; i >= 0; i--) { const p = ps[i];
    while (上.length >= 2 && 外(上[上.length - 2], 上[上.length - 1], p) <= 0) 上.pop(); 上.push(p); }
  下.pop(); 上.pop();
  const poly = 下.concat(上);
  return { poly: poly.length >= 3 ? poly : ps, zB, zT };
}

// 立体ひとつ → 取付枠の一覧。sol は csgEvalBody の結果（planarFaces / curvedFaces を持つ）
// ══ 球面（ドーム・タンクの鏡板）を取付枠にする ・2026-10-04 ══
// 【これが抽象の効き目】ユーザー指摘「例を挙げるたびに個別で作っている」への答え。
//   ここで足したのは **atUV / projectUV を持つ面を1枚作ること** だけ。
//   近さの測り方（bcSurfaceOffsetOf）・機器の幾何（bcIconAnchorGeomOn）・
//   置く（bcPickSurfaceSpot）・収める（bcClampIcon）・直す（bcApplyIconEdit）・保存は
//   **1行も触っていない**。検査 bld_body_sphere.cjs がそれを数で示す。
// 面の上の座標:
//   u = 経度に沿った弧長[m]（半径Rの大円で測る）
//   v = 緯度に沿った弧長[m]（残っている範囲の下端から上へ）
//   どちらもメートル＝壁・扉・曲面と同じ単位（単位がそろっていないと機器の幅が化ける）
// 【極（真上・真下）は特異点】経度が決まらないので、面の範囲を極ぴったりまで取らない
//   （メッシュから測った lat0/lat1 は実際の三角形の範囲なので、通常そこまでは行かない・Codex）
function bcBodySphereId(bodyId, sph) {
  const r = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
  return 'body:' + bodyId + ':sph' + r(sph.cx) + '_' + r(sph.cy) + '_' + r(sph.cz)
       + '_r' + r(sph.r);
}
function bcBodySphereSurfaceOf(bodyId, sph) {
  if (!sph) return null;
  const mpp = _bcMpp();
  const R = sph.r;                                  // メートル
  if (!(R > 0.05)) return null;
  const cxM = sph.cx * mpp, cyM = sph.cy * mpp, czM = sph.cz;
  const sgn = sph.sweep >= 0 ? 1 : -1;
  const spanU = Math.abs(sph.sweep) * R;            // 経度の弧長[m]
  const spanV = Math.max(0, sph.lat1 - sph.lat0) * R;   // 緯度の弧長[m]
  if (!(spanU > 0.05) || !(spanV > 0.05)) return null;
  const atUV = (u, v) => {
    const th = sph.a0 + sgn * (u / R);              // 経度
    const ph = sph.lat0 + (v / R);                  // 緯度
    const cp = Math.cos(ph), sp2 = Math.sin(ph);
    const ct = Math.cos(th), st = Math.sin(th);
    const nx = cp * ct, ny = cp * st, nz = sp2;     // 法線（外向き）
    return { x: (cxM + R * nx) / mpp, y: (cyM + R * ny) / mpp, z: czM + R * nz,
             ux: -st * sgn, uy: ct * sgn, uz: 0,              // u が増える向き（横）
             vx: -sp2 * ct, vy: -sp2 * st, vz: cp,            // v が増える向き（登り）
             nx, ny, nz };
  };
  const TAU = Math.PI * 2, swAbs = Math.abs(sph.sweep);
  const projectUV = (pt) => {
    const X = pt.x * mpp - cxM, Y = pt.y * mpp - cyM;
    const Z = (Number.isFinite(pt.z) ? pt.z : czM) - czM;
    const L = Math.hypot(X, Y, Z);
    const ph = Math.atan2(Z, Math.hypot(X, Y));
    let d = (Math.atan2(Y, X) - sph.a0) * sgn;
    d = ((d % TAU) + TAU) % TAU;
    // 残っていない側（切れ目の向こう）を押したら近い方の端へ寄せる（円弧の壁と同じ作法）
    if (d > swAbs) d = (d - swAbs) < (TAU - d) ? swAbs : 0;
    return { u: Math.max(0, Math.min(spanU, d * R)),
             v: Math.max(0, Math.min(spanV, (ph - sph.lat0) * R)),
             side: (L >= R) ? 1 : -1 };
  };
  const 代表 = atUV(0, spanV / 2);
  const fm = {
    host: 'body', bodyId, mountKind: 'sphere',
    sphere: { cx: sph.cx, cy: sph.cy, cz: sph.cz, r: R },
    spanU, spanV, atUV, projectUV,
    baseZ: atUV(0, 0).z, spanTM: spanV, originSM: 0, spanSM: spanU,
    offGrid: 0.005 / mpp,                 // 面から僅かに浮かせる（壁と同じ作法）
    areaM2: spanU * spanV,
    // 向きを1つだけ要る所（ラベルの並べ方など）が落ちないように代表値を置く。
    // 球面では場所ごとに向きが変わるので**これだけを見てはいけない**（曲面と同じ注意）
    fr: { ux: 代表.ux, uy: 代表.uy, nx: 代表.nx, ny: 代表.ny },
    ax: { x: 代表.x, y: 代表.y },
    atS: (uM) => { const a = atUV(uM, spanV / 2);
                   return { x: a.x, y: a.y, ux: a.ux, uy: a.uy, nx: a.nx, ny: a.ny }; },
    projectPoint: (gridPt) => { const r = projectUV(gridPt); return { uM: r.u, side: r.side }; },
  };
  return _bcFinishSurface(fm, bcBodySphereId(bodyId, sph), 'body');
}

function bcBodySurfaces(sol) {
  if (!sol) return [];
  if (typeof window !== 'undefined' && window.__BODY_SURFACE === false) return [];
  const out = [];
  const 使った = new Set();
  (sol.planarFaces || []).forEach(g => {
    const fm = bcBodySurfaceOf(sol.id, g);
    if (!fm || !fm.id || 使った.has(fm.id)) return;   // 同じ平面が2つ出たら1つにする
    使った.add(fm.id);
    out.push(fm);
  });
  // 曲面（タンクの胴・曲がった廊下の壁）。2026-10-03
  (sol.curvedFaces || []).forEach(cyl => {
    const fm = bcBodyCurvedSurfaceOf(sol.id, cyl);
    if (!fm || !fm.id || 使った.has(fm.id)) return;
    使った.add(fm.id);
    out.push(fm);
  });
  // 球面（ドーム・タンクの鏡板）。2026-10-04
  // 【足したのはこの6行だけ】貼る側（近さ・幾何・置く・収める・保存）は1行も変えていない
  (sol.sphereFaces || []).forEach(sph => {
    const fm = bcBodySphereSurfaceOf(sol.id, sph);
    if (!fm || !fm.id || 使った.has(fm.id)) return;
    使った.add(fm.id);
    out.push(fm);
  });
  return out;
}

// 建屋の階 ＋ CSG立体 を**1つの口**から出す ・2026-10-03
// 【なぜ1本にするか】呼ぶ側が「建屋の面」と「立体の面」を別々に集めると、
//   片方だけ対応した窓が必ず出る（＝平面図では貼れるが3次元図では貼れない）
function bcSceneSurfaces(scene, opts) {
  const sc = scene || {};
  const out = [];
  if (sc.building && sc.floor) out.push(...bcSurfacesOf(sc.building, sc.floor, opts));
  (sc.bodies || []).forEach(sol => out.push(...bcBodySurfaces(sol)));
  return out;
}
// 名前から面を引く（建屋・立体のどちらでも）
function bcSceneSurfaceById(scene, id) {
  const sc = scene || {};
  const b = bcParseBodySurfaceId(id);
  if (b) {
    const sol = (sc.bodies || []).find(x => x && x.id === b.bodyId);
    if (!sol) return null;
    return bcBodySurfaces(sol).find(fm => fm.id === id) || null;
  }
  if (sc.building && sc.floor) return bcSurfaceById(sc.building, sc.floor, id);
  return null;
}
// 点 → どの面のどこか（建屋・立体のどちらでも）。近さの測り方は bcSurfaceOffsetOf 1本
function bcScenePickSpot(scene, pt, opts) {
  const o = opts || {};
  let best = null;
  for (const fm of bcSceneSurfaces(scene, o)) {
    if (Array.isArray(o.kinds) && o.kinds.indexOf(fm.kind) < 0) continue;
    const off = bcSurfaceOffsetOf(fm, pt, o);
    if (!off) continue;
    if (!best || off.distGrid < best.dist)
      best = { surface: fm, surfaceId: fm.id, kind: fm.kind,
               u: off.u, v: off.v, side: off.side, dist: off.distGrid };
  }
  if (!best) return null;
  if (o.maxDistGrid != null && best.dist > o.maxDistGrid) return null;
  return best;
}

// 面が消えた機器を拾い直す ・2026-10-03（Codex案: 一次ID＋幾何の指紋）
// 【なぜ要るか】立体を押し引きするとメッシュが作り直され、面の位置が変わる＝名前も変わる。
//   そのまま捨てると機器が消える。向きが同じで一番近い面へ**付け替える**。
//   どれにも寄れなければ消さずに「再割当待ち」にする（orphan）。
function bcRebindBodySurface(sol, 旧id, 旧) {
  const 面ら = bcBodySurfaces(sol);
  if (!面ら.length) return null;
  const そのまま = 面ら.find(fm => fm.id === 旧id);
  if (そのまま) return そのまま;
  const b = bcParseBodySurfaceId(旧id);
  if (!b) return null;
  // 曲面（円筒）は「軸がほぼ同じで半径が近いもの」へ付け替える
  const cm = /^cyl(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)@/.exec(b.key);
  if (cm) {
    const cx = +cm[1], cy = +cm[2], r = +cm[3];
    let best2 = null;
    面ら.forEach(fm => {
      if (!fm.curved || !fm.arc) return;
      const d = Math.hypot(fm.arc.cx - cx, fm.arc.cy - cy) + Math.abs(fm.arc.r - r);
      if (!best2 || d < best2.d) best2 = { fm, d };
    });
    // 軸も半径も大きく違うなら付け替えない（よそへ飛ばさない）
    return (best2 && best2.d < Math.max(1, r * 0.3)) ? best2.fm : null;
  }
  // 指紋から向きを取り出し、同じ向きの面だけを候補にする
  const m = /^n(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)@(-?[\d.]+)$/.exec(b.key);
  if (!m) return null;
  const nx = +m[1], ny = +m[2], d0 = +m[4];
  let best = null;
  面ら.forEach(fm => {
    const dot = fm.fr.nx * nx + fm.fr.ny * ny;
    if (!(dot > 0.98)) return;                       // 向きが違う面には移さない
    const mpp = _bcMpp();
    const d = fm.ax.x * mpp * fm.fr.nx + fm.ax.y * mpp * fm.fr.ny;
    const 差 = Math.abs(d - d0)
      + (旧 && Number.isFinite(旧.areaM2) ? Math.abs((fm.areaM2 || 0) - 旧.areaM2) * 0.1 : 0);
    if (!best || 差 < best.差) best = { fm, 差 };
  });
  return best ? best.fm : null;
}

// 図面の点（＋分かるなら高さ）→ 「どの面の、そのどこか」。面の種類を呼び出し側が選ばない。
// 【なぜ1本にするか】平面図・3次元図・建屋エディタが別々に最寄りを探すと、
//   同じ場所をクリックしても窓ごとに違う面に付く
// 点が面からどれだけ離れているか。**近さの測り方はここだけ**・2026-10-03
// 【なぜ1本にするか】「どの面が一番近いか」（bcPickSurfaceSpot）と
//   「まだその面に付いているか」（ppcMountStillOn）が別々の式で測ると、
//   置いた直後に剥がれている、引き離したのに付いたまま、という食い違いが出る。
//   distGrid   : 面の上の点までの直線距離[グリッド]。面の端から外れた分も含む＝「どの面が近いか」用
//   normalGrid : 面から出る向きの符号付き距離[グリッド]。自分がいる側が正＝「まだ付いているか」用
//   u, v, side : projectUV と同じ（面の上のどこか・どちらの側か）
// 【2026-10-04 面の種類で分けない】以前はここに
//   「傾いた面」「水平面」「それ以外（鉛直）」の3分岐があった。
//   ＝新しい面を足すたびにここへ分岐が増える作り（ユーザー指摘「例を挙げるたびに個別で作る」）。
//   どの面も atUV(u,v) で「点＋3つの向き(u軸・v軸・法線)」を返す契約なので、
//   近さは**3次元で1回測れば済む**。式は下の1本だけ。
//   ・鉛直面 : 法線のzが0・面の上の点のzが押した点と同じ → 従来と同値
//   ・水平面 : 面の上の点のx,yが押した点と同じ → |高さの差| ＝ 従来と同値
//   ・傾いた面: もともとこの式（従来と同値）
//   唯一変わるのは「鉛直面の、壁の天端より上／下端より下の点」。
//   従来は水平距離だけ、いまは上下のはみ出しも足す（最寄りの面としては新しい方が正しい・Codex監査）
function bcSurfaceOffsetOf(fm, pt, opts) {
  if (!fm || typeof fm.projectUV !== 'function') return null;
  if (typeof window !== 'undefined' && window.__BC_SURFACE_UNIFIED === false) {
    return _bcSurfaceOffsetLegacy(fm, pt, opts);   // 陽性対照（従来の3分岐）
  }
  const o = opts || {};
  const mpp = _bcMpp();
  const uv = fm.projectUV(pt);
  const vv = Number.isFinite(uv.v) ? uv.v : 0;
  const a = fm.atUV(uv.u, vv);
  const nx = a.nx || 0, ny = a.ny || 0, nz = a.nz || 0;
  const zKnown = Number.isFinite(pt.z);
  // 【高さが分からない点では、上を向いた面を選べない】床と天井は真上から見ると同じ場所にある。
  //   これを面の種類（horizontal）ではなく**法線が立っているか**で決める＝種類を増やさない
  if (!zKnown && Math.abs(nz) > 0.5) {
    return { u: uv.u, v: uv.v, side: uv.side,
             distGrid: o.preferFlat ? 0 : 1e9, normalGrid: 0 };
  }
  const dx = pt.x - a.x, dy = pt.y - a.y;
  const dz = zKnown ? ((pt.z - a.z) / mpp) : 0;   // z はメートル → グリッドへ揃える
  const sg = (uv.side < 0) ? -1 : 1;
  return { u: uv.u, v: uv.v, side: uv.side,
           distGrid: Math.hypot(dx, dy, dz),
           normalGrid: (dx * nx + dy * ny + dz * nz) * sg };
}

// 【陽性対照専用】従来の3分岐。__BC_SURFACE_UNIFIED=false のときだけ通る。
//   検査がこれと新しい式を突き合わせて「1件も食い違わない」ことを見る
function _bcSurfaceOffsetLegacy(fm, pt, opts) {
  const o = opts || {};
  const mpp = _bcMpp();
  const uv = fm.projectUV(pt);
  if (fm.mountKind === 'tilted-plane') {
    const a = fm.atUV(uv.u, uv.v);
    const dx = pt.x - a.x, dy = pt.y - a.y;
    const dz = Number.isFinite(pt.z) ? ((pt.z - a.z) / mpp) : 0;
    const sg = (uv.side < 0) ? -1 : 1;
    return { u: uv.u, v: uv.v, side: uv.side,
             distGrid: Math.hypot(dx, dy, dz),
             normalGrid: (dx * a.nx + dy * a.ny + dz * a.nz) * sg };
  }
  if (fm.horizontal) {
    const 差 = Number.isFinite(pt.z) ? (pt.z - fm.planeZ) : null;
    return { u: uv.u, v: uv.v, side: uv.side,
             distGrid: (差 == null) ? (o.preferFlat ? 0 : 1e9) : Math.abs(差) / mpp,
             normalGrid: (差 == null) ? 0 : (差 / mpp) * (fm.kind === 'ceil' ? -1 : 1) };
  }
  const a = fm.atUV(uv.u, 0);
  const dx = pt.x - a.x, dy = pt.y - a.y;
  const sg = (uv.side < 0) ? -1 : 1;
  return { u: uv.u, v: uv.v, side: uv.side,
           distGrid: Math.hypot(dx, dy),
           normalGrid: (dx * (a.nx || 0) + dy * (a.ny || 0)) * sg };
}

function bcPickSurfaceSpot(building, floor, pt, opts) {
  const o = opts || {};
  let best = null;
  for (const fm of bcSurfacesOf(building, floor, o)) {
    const off = bcSurfaceOffsetOf(fm, pt, o);
    if (!off) continue;
    if (!best || off.distGrid < best.dist) best = { surface: fm, surfaceId: fm.id, kind: fm.kind,
                                         u: off.u, v: off.v, side: off.side, dist: off.distGrid };
  }
  if (!best) return null;
  if (o.maxDistGrid != null && best.dist > o.maxDistGrid) return null;
  return best;
}

// 図面の点 → 「どの外壁の、その面のどこか」。見つからなければ null。
// 【なぜ1本にするか】平面図・3次元図・建屋エディタが別々に最寄りを探すと、
//   同じ場所をクリックしても窓ごとに違う壁に付く。述語は1つにする。
// maxDistGrid を省くと距離で弾かない（一番近い辺を必ず返す）
function bcPickOuterSpot(building, floor, gridPt, maxDistGrid, zM) {
  const edges = bcFloorOuterEdges(building, floor);
  let best = null;
  for (const e of edges) {
    const fm = bcOuterFrame(building, floor, e.key);
    if (!fm) continue;
    const pr = fm.projectPoint(gridPt);
    const at = fm.atS(pr.uM);
    const d = Math.hypot(gridPt.x - at.x, gridPt.y - at.y);
    if (!best || d < best.distGrid) {
      best = { outerKey: e.key, edgeId: e.edgeId, blockIdx: e.blockIdx, kind: e.kind,
               sM: Math.max(0, Math.min(fm.spanSM, pr.uM - fm.originSM)),
               side: pr.side, distGrid: d, frame: fm };
    }
  }
  if (!best) return null;
  if (maxDistGrid != null && best.distGrid > maxDistGrid) return null;
  // 高さも分かるなら（3次元図で面をクリックしたとき）そのまま返す
  if (Number.isFinite(zM)) {
    best.tM = Math.max(0, Math.min(best.frame.spanTM, zM - best.frame.baseZ));
  }
  return best;
}

// アイコンを3Dで描くための4隅（世界座標）と面の法線。
// 壁（または扉）の厚みの半分だけ外へ出す（面に貼り付いて見えるように、さらに僅かに浮かせる）。
// 壁と扉の違いは frame の originSM（面内の原点）と baseZ（面の下端）だけで、式は同じ
function bcIconAnchorGeom(building, floor, icon) {
  // 床・天井は水平な面。箱の作り方が垂直面と違うのでここで分ける
  //（面の供給と「面のどこか」は共通。違うのは箱の描き方だけ）
  if (bcIsFloorIcon(icon) || bcIsCeilIcon(icon)) return bcFloorIconGeom(floor, icon);
  const fm = bcIconFrame(floor, icon, building);
  if (!fm) return null;
  return bcIconAnchorGeomOn(fm, icon);
}

// 【面を直に受ける版・2026-10-03】上の関数から**中身をそのまま括り出しただけ**（式は1つも変えていない）。
// 【なぜ分けたか】機器の幾何が「階(floor)」を入口にしていたので、階に属さない
//   CSG立体の面には機器を置けなかった。取付枠の思想は「付けるがわは面しか知らない」なので、
//   面を受け取る形が本来の姿。建屋の壁も立体の面も、ここから先は同じ道を通る。
// 【2026-10-04 面の種類で分けない】以前はここに
//   「傾いた面なら別関数」「扉なら別の離れ方」の2つの分岐があった。
//   どの面も atUV(u,v) で「点＋3つの向き(u軸・v軸・法線)」を返し、
//   離れ方は mountOffsetGrid が返す契約なので、**板を作る式は1本で足りる**。
//   ・鉛直面 : u軸=(ux,uy,0) v軸=(0,0,1) 法線=(nx,ny,0) → 従来の式と同値
//   ・曲面   : 位置ごとに u軸と法線が回る（従来どおり）
//   ・傾いた面: u軸・v軸・法線が3次元で傾く（従来どおり）
//   新しい面（球・トーラス等）を足す人は atUV / projectUV を書くだけでよく、ここは触らない。
//   段階フラグ __BC_SURFACE_UNIFIED=false で従来の2分岐（陽性対照）
function bcIconAnchorGeomOn(fm, icon) {
  if (!fm || !icon) return null;
  if (typeof window !== 'undefined' && window.__BC_SURFACE_UNIFIED === false) {
    return _bcIconGeomLegacy(fm, icon);
  }
  const mpp = _bcMpp();
  const spanU = Number.isFinite(fm.spanU) ? fm.spanU : (fm.spanSM || 0);
  const uM = Math.max(0, Math.min(spanU, icon.sM || 0));
  const vM = (icon.tM || 0);                      // v は面の下端からの高さ[m]＝板の中心
  const a = fm.atUV(uM, vM);                      // 点＋3つの向き
  const sgn = (icon.side < 0) ? -1 : 1;
  // 面からどれだけ離すか・どちらが外向きかは**面が決める**（扉の片面フラッシュもここに入る）
  const mo = fm.mountOffsetGrid(sgn);
  const nOff = mo.nOff, faceSgn = mo.faceSgn;
  const nx = (a.nx || 0), ny = (a.ny || 0), nz = (a.nz || 0);
  // 面から離した中心（x,y はグリッド・z はメートル）
  const cx = a.x + nx * nOff, cy = a.y + ny * nOff, cz = a.z + nz * nOff * mpp;
  const hw = (icon.wM / 2) / mpp, hh = (icon.hM / 2) / mpp;
  const th = BC_ICON_PLATE_THICK_M / mpp;
  const oX = nx * faceSgn, oY = ny * faceSgn, oZ = nz * faceSgn;   // 板を押し出す向き
  const 点 = (su, sv, 厚) => ({
    x: cx + a.ux * hw * su + (a.vx || 0) * hh * sv + oX * 厚,
    y: cy + a.uy * hw * su + (a.vy || 0) * hh * sv + oY * 厚,
    z: cz + ((a.uz || 0) * hw * su + (a.vz || 0) * hh * sv + oZ * 厚) * mpp,
  });
  // 下辺左→下辺右→上辺右→上辺左（取付面側の4隅。ラベル位置の基準）
  const 面側 = [点(-1, -1, 0), 点(1, -1, 0), 点(1, 1, 0), 点(-1, 1, 0)];
  const 外側 = [点(-1, -1, th), 点(1, -1, th), 点(1, 1, th), 点(-1, 1, th)];
  const 角柱 = _bcOrientedBoxToPrism(面側.concat(外側));
  if (!角柱) return null;
  // 凸包まかせの並びを「面側の左下 → 右下」に合わせて回し直す（鉛直面で従来と同一になる）
  const 輪郭 = _bcNormalizeOutlineStart(角柱.poly, 面側[0], 面側[1]);
  const one = 1 / mpp;   // 1m ぶんのグリッド長
  return {
    icon, part: fm.part || null, door: fm.door || null, host: fm.host,
    corners: 面側,
    boxCorners8: 面側.concat(外側),
    planeAxes: { u: { x: a.ux, y: a.uy, z: a.uz || 0 },
                 v: { x: a.vx || 0, y: a.vy || 0, z: a.vz || 0 },
                 n: { x: oX, y: oY, z: oZ } },
    // 真上から見た角柱（底面の輪郭×zB〜zT）。床置きと同じ形なので全ビューが1本の描き方で扱える
    poly: 輪郭, zB: 角柱.zB, zT: 角柱.zT,
    center: { x: cx, y: cy, z: cz },
    // 【掴むための2軸】中心から「面に沿って横へ1m」「面を登る向きへ1m」
    axisS: { x: cx + a.ux * one, y: cy + a.uy * one, z: cz + (a.uz || 0) * one * mpp },
    axisT: { x: cx + (a.vx || 0) * one, y: cy + (a.vy || 0) * one, z: cz + (a.vz || 0) * one * mpp },
    normal: { nx: oX, ny: oY },
  };
}

// 【陽性対照専用】従来の2分岐（傾いた面は別関数・扉は別の離れ方）。
//   __BC_SURFACE_UNIFIED=false のときだけ通る。
//   検査がこれと新しい式を突き合わせて「何通り流して何件食い違ったか」を出す
function _bcIconGeomLegacy(fm, icon) {
  if (fm.mountKind === 'tilted-plane') return _bcIconGeomOnTiltedPlane(fm, icon);
  const mpp = _bcMpp();
  const fr = fm.fr;                             // ux,uy=壁方向 / nx,ny=法線
  // 面の上の位置[m]（ホスト素材の原点から。壁なら端点a、扉も乗っている壁の端点a）
  const uM = fm.originSM + Math.max(0, Math.min(fm.spanSM, icon.sM));
  const s = uM / mpp;                           // グリッドへ（フラグOFFの従来式で使う）
  const sgn = icon.side < 0 ? -1 : 1;
  // 【取付面の法線離れ・2026-09-03】壁は対称なので従来どおり offGrid*sgn。
  // 扉は片面フラッシュなので実面(外面nOuter/内面nInner)に乗せる：icon.side が取付面(mountSide)
  // 側なら外面、逆なら扉の内面。対称扉(既定)は nOuter=-nInner ゆえ従来の offGrid*sgn と一致。
  let nOff, faceSgn;
  if (fm.host === 'door') {
    const onOuter = (sgn === fm.mountSide);
    const nFace = onOuter ? fm.nOuterGrid : fm.nInnerGrid;   // 符号込みグリッド
    faceSgn = onOuter ? fm.mountSide : -fm.mountSide;         // その面の外向き
    nOff = nFace + faceSgn * (0.005 / mpp);                   // 面から僅かに浮かせる
  } else {
    faceSgn = sgn;
    nOff = fm.offGrid * sgn;
  }
  // 【向きは面から貰う・2026-10-01】平面ホストでは atS が定数の ux,uy,nx,ny を返すので
  // 従来式と完全に同値。曲面ホスト（円弧の壁）では位置ごとに接線・法線が回る
  const at = _bcSurfFrameOn() ? fm.atS(uM)
    : { x: fm.ax.x + fr.ux * s, y: fm.ax.y + fr.uy * s,
        ux: fr.ux, uy: fr.uy, nx: fr.nx, ny: fr.ny };
  const cx = at.x + at.nx * nOff;
  const cy = at.y + at.ny * nOff;
  const hw = (icon.wM / 2) / mpp;               // 面内の左右半幅（グリッド）
  const zB = fm.baseZ + icon.tM - icon.hM / 2;
  const zT = zB + icon.hM;
  const p = (k, z) => ({ x: cx + at.ux * hw * k, y: cy + at.uy * hw * k, z });
  const zc = (zB + zT) / 2;
  const one = 1 / mpp; // 1m ぶんのグリッド長
  // 【厚みを持つ箱・2026-09-11】取付面から外向きの法線へ BC_ICON_PLATE_THICK_M だけ押し出した底面。
  // 床置きの poly と同じ形（底面の輪郭×zB〜zT）なので、全ビューが床置きと同じ1本の描き方で扱える
  const nX = at.nx * faceSgn, nY = at.ny * faceSgn;
  const th = BC_ICON_PLATE_THICK_M / mpp;
  const bl = p(-1, zB), br = p(+1, zB);
  return {
    icon, part: fm.part, door: fm.door, host: fm.host,
    // 下辺左→下辺右→上辺右→上辺左（取付面側の面。ラベル位置の基準に使う）
    corners: [bl, br, p(+1, zT), p(-1, zT)],
    // 底面の輪郭（取付面側の2点→外側の2点）。形はこれ×zB〜zT
    poly: [{ x: bl.x, y: bl.y }, { x: br.x, y: br.y },
           { x: br.x + nX * th, y: br.y + nY * th }, { x: bl.x + nX * th, y: bl.y + nY * th }],
    center: { x: cx, y: cy, z: zc },
    // 【ドラッグ用の2軸】中心から「壁に沿って1m」「真上に1m」の点。
    // 3D側はこれを投影して引き算するだけでよく、壁の向きを知らなくて済む
    // （幾何の知識を2箇所に置かない）
    axisS: { x: cx + at.ux * one, y: cy + at.uy * one, z: zc },
    axisT: { x: cx, y: cy, z: zc + 1 },
    normal: { nx: nX, ny: nY },
    zB, zT,
  };
}

// 傾いた面に貼った機器の幾何 ・2026-10-03
// 面の3軸（横U・登りV・法線N）で板を作り、真上から見た角柱に直して返す。
// 返す形は鉛直面のときと同じ（corners / poly / zB / zT / center / axisS / axisT / normal）ので、
// 描く・掴む・選ぶ処理は1行も変えずに済む。
function _bcIconGeomOnTiltedPlane(fm, icon) {
  const mpp = _bcMpp();
  const uM = Math.max(0, Math.min(fm.spanU, icon.sM || 0));
  const vM = Math.max(0, Math.min(fm.spanV, icon.tM || 0));
  const a = fm.atUV(uM, vM);
  const sgn = (icon.side < 0) ? -1 : 1;
  const nx = a.nx * sgn, ny = a.ny * sgn, nz = a.nz * sgn;
  const off = (fm.offGrid || 0);                       // グリッド
  // 面から少し浮かせた中心（x,y はグリッド・z はメートル）
  const cx = a.x + nx * off, cy = a.y + ny * off, cz = a.z + nz * off * mpp;
  const hw = (icon.wM / 2) / mpp, hh = (icon.hM / 2) / mpp;
  const 点 = (su, sv, 厚) => ({
    x: cx + a.ux * hw * su + a.vx * hh * sv + nx * 厚,
    y: cy + a.uy * hw * su + a.vy * hh * sv + ny * 厚,
    z: cz + (a.uz * hw * su + a.vz * hh * sv + nz * 厚) * mpp,
  });
  const th = BC_ICON_PLATE_THICK_M / mpp;
  const 面側 = [点(-1, -1, 0), 点(1, -1, 0), 点(1, 1, 0), 点(-1, 1, 0)];
  const 外側 = [点(-1, -1, th), 点(1, -1, th), 点(1, 1, th), 点(-1, 1, th)];
  const 角柱 = _bcOrientedBoxToPrism(面側.concat(外側));
  if (!角柱) return null;
  const one = 1 / mpp;
  return {
    icon, part: null, door: null, host: fm.host,
    corners: 面側,                       // 取付面側の4隅（ラベルの基準）
    boxCorners8: 面側.concat(外側),      // 将来、傾いた板をそのまま描くときのために残す
    planeAxes: { u: { x: a.ux, y: a.uy, z: a.uz }, v: { x: a.vx, y: a.vy, z: a.vz },
                 n: { x: nx, y: ny, z: nz } },
    poly: 角柱.poly, zB: 角柱.zB, zT: 角柱.zT,
    center: { x: cx, y: cy, z: cz },
    // 掴むための2軸。面の中で「横へ1m」「斜面を登る向きへ1m」
    axisS: { x: cx + a.ux * one, y: cy + a.uy * one, z: cz + a.uz * one * mpp },
    axisT: { x: cx + a.vx * one, y: cy + a.vy * one, z: cz + a.vz * one * mpp },
    normal: { nx, ny },
    tilted: true,
  };
}

// 床置きの機器＝床の上に立つ箱。平面の4隅と上下のz、掴むための2軸を返す。
// 【PNに一切依存しない】rotDeg は真北基準なので、PNを変えても機器は動かない
// 【床と天井で同じ計算・2026-10-01】違うのは「面がどちら向きか」だけ。
//   床  : 面から上へ tM 持ち上げ、そこから高さ hM
//   天井: 面から下へ tM 下げ、そこから下へ高さ hM（照明器具の吊り下げ）
function bcFloorIconGeom(floor, icon) {
  const mpp = _bcMpp();
  const th = (icon.rotDeg || 0) * Math.PI / 180;
  const u0 = { x: Math.cos(th), y: Math.sin(th) };   // 幅の方向（世界のグリッド）
  const v0 = { x: -Math.sin(th), y: Math.cos(th) };  // 奥行きの方向
  const hw = (icon.wM / 2) / mpp, hd = (icon.dM / 2) / mpp;
  const c = { x: icon.gx, y: icon.gy };
  const p = (su, sv) => ({ x: c.x + u0.x * hw * su + v0.x * hd * sv,
                           y: c.y + u0.y * hw * su + v0.y * hd * sv });
  const 天井 = bcIsCeilIcon(icon);
  const planeZ = 天井 ? floor.levelZ + floor.heightM : floor.levelZ;
  const zT = 天井 ? planeZ - (icon.tM || 0) : planeZ + (icon.tM || 0) + icon.hM;
  const zB = zT - icon.hM;
  const one = 1 / mpp;
  return {
    icon, part: null, host: 天井 ? 'ceil' : 'floor',
    normal: { nx: 0, ny: 0 },                        // 水平面なので真上/真下
    poly: [p(-1,-1), p(+1,-1), p(+1,+1), p(-1,+1)], // 平面の4隅（グリッド）
    center: { x: c.x, y: c.y, z: (zB + zT) / 2 },
    // ドラッグ用の2軸（幅方向1m／奥行き方向1m）。床の上を動くので z は動かさない
    axisS: { x: c.x + u0.x * one, y: c.y + u0.y * one, z: (zB + zT) / 2 },
    axisT: { x: c.x + v0.x * one, y: c.y + v0.y * one, z: (zB + zT) / 2 },
    zB, zT,
  };
}

// ================================================================
// 床置きの箱（bcFloorBox）
// ================================================================
// 【この語彙を作った理由・2026-08-29】床の上に立つ直方体は、床置き機器
// （floor.icons の partitionId===null）だけではない。**配置済みの配電盤**も
// 同じ「床の上に立つ箱」である。ただし配電盤は placedPanels[] という別モデルで、
// floor.icons[] に混ぜてはいけない（BUILDING_INTERIOR_SPEC 10章「部屋と配電盤は別モデル」）。
//
// そこで、吸い付き・はみ出し警告のような**幾何だけで決まる処理**は
//   box = { id, gx, gy, rotDeg, wM, dM, hM, tM }
// という形だけを見る関数を正にし、隣接候補は呼び出し側がリストで渡す。
// こうすると「機器→盤」「盤→機器」「盤→盤」が全部同じ1関数で成立し、
// 建物コアは配電盤のスキーマを一切知らないままでいられる（Codex監査の指示）。
//
// bcSnapFloorIcon / bcFloorIconsOutside は floor.icons を渡すだけの薄いラッパとして残す。

// 床置きの箱を壁へ吸い付ける（Phase D の「吸い付きスナップ」）。
// 【許容量は画面px由来】呼び出し側が「画面10px 相当のグリッド長」に換算して渡す。
// メートル固定にすると、ズームアウト時に吸いすぎ・ズームイン時に吸いにくくなる
// （既存の作図の吸い付き _beGuidePoint が画面px基準なのと同じ思想）。
// 戻り値: { gx, gy, rotDeg, partId } | null
function bcSnapFloorBoxToWall(floor, icon, tolGrid) {
  if (!bcIsFloorIcon(icon) || !(tolGrid > 0)) return null;
  const mpp = _bcMpp();
  const halfD = (icon.dM / 2) / mpp;
  const halfW = (icon.wM / 2) / mpp;
  let best = null, bestGap = Infinity;
  for (const p of (floor.partitions || [])) {
    if (p.kind !== 'wall') continue;      // 透明仕切りは物理的な面ではないので吸わない
    const fr = bcWallFrame(p);
    const lenG = fr.lenGrid;
    const wallDeg = Math.atan2(fr.uy, fr.ux) * 180 / Math.PI;
    // 【どの面を壁に付けるか】今の向きから見て90°単位でいちばん近い姿勢を選ぶ。
    // こうすると「いま壁にいちばん近い面」がそのまま壁に付く。
    // 以前は常に奥行き面を壁に付けていたため、盤の向きを自分で決められなかった
    // （2026-08-29 ユーザー指摘）。壁と平行になること自体は変わらない。
    const cur = icon.rotDeg || 0;
    let bestK = 0, bestDA = Infinity;
    for (let k = 0; k < 4; k++) {
      const raw = (wallDeg + 90 * k) - cur;
      const da = Math.abs(((raw % 360) + 540) % 360 - 180);   // 0..180 に畳んだ角度差
      if (da < bestDA) { bestDA = da; bestK = k; }
    }
    // 90°回すと壁に沿う辺と法線側の辺が入れ替わる
    const alongHalf = (bestK % 2 === 0) ? halfW : halfD;   // 壁に沿う向きの半分
    const normHalf  = (bestK % 2 === 0) ? halfD : halfW;   // 壁の法線向きの半分
    // 壁が機器より短ければ吸い付かせない（勝手に縮めない）
    if (lenG < alongHalf * 2) continue;
    const rx = icon.gx - p.a.x, ry = icon.gy - p.a.y;
    const along = rx * fr.ux + ry * fr.uy;         // 壁に沿った位置
    const perp  = rx * fr.nx + ry * fr.ny;         // 法線方向の符号付き距離
    // 【壁の端からはみ出さない】壁に沿う辺の半分だけ内側に入っていることを求める
    if (along < alongHalf || along > lenG - alongHalf) continue;
    const wallHalf = ((p.thicknessM || BC_PARTITION_DEFAULTS.thicknessM) / 2) / mpp;
    const flush = wallHalf + normHalf;            // 密着したときの中心距離
    const sgn = perp < 0 ? -1 : 1;
    const gap = Math.abs(Math.abs(perp) - flush);
    if (gap > tolGrid || gap >= bestGap) continue;
    bestGap = gap;
    // 向きは壁と平行。rotDeg も壁も真北基準なので、そのまま角度を入れるだけ
    best = {
      gx: p.a.x + fr.ux * along + fr.nx * flush * sgn,
      gy: p.a.y + fr.uy * along + fr.ny * flush * sgn,
      rotDeg: wallDeg + 90 * bestK,
      partId: p.id,
    };
  }
  return best;
}

// 床置きの箱どうしを密着させる（並べて置く）。相手の局所座標系で4つの候補を作る:
//   中心 = 相手中心 ± 幅方向*(相手の幅/2 + 自分の幅/2)   … 横に並べる
//   中心 = 相手中心 ± 奥行方向*(相手の奥行/2 + 自分の奥行/2) … 前後に並べる
// 【向きを先に揃えてから寸法を使う】採用時は相手の向きに揃えるので、
// 候補を作る時点でも「揃えた後の幅・奥行」で計算しないと半分ずれる（監査指摘）
// 【neighbours は必須引数】floor.icons を暗黙に見に行くと、配電盤のような
// 別モデルの箱が候補から漏れる。誰を相手にするかは呼び出し側が決める
// ── 当たり判定（貫通させない）──
// 【壁も箱として扱う】箱は {gx,gy,rotDeg,wM,dM} の回転長方形、壁は「長さ×厚み」の回転長方形。
// 同じ形に直せば「箱↔箱」も「箱↔壁」も1つの重なり判定で済む。
// 建物コアは配電盤のスキーマを知らないままでいられる（bcSnapFloorBox と同じ約束）。
const BC_OBB_EPS = 1e-6;   // 密着（吸い付きの結果）を重なり扱いにしないための遊び
function _bcObbOfBox(gx, gy, rotDeg, wM, dM, mpp) {
  const th = (rotDeg || 0) * Math.PI / 180;
  return { cx: gx, cy: gy, ux: Math.cos(th), uy: Math.sin(th),
           hu: (wM / 2) / mpp, hv: (dM / 2) / mpp };
}
function _bcObbOfWall(p, mpp) {
  const fr = bcWallFrame(p);
  const half = ((p.thicknessM || BC_PARTITION_DEFAULTS.thicknessM) / 2) / mpp;
  return { cx: (p.a.x + p.b.x) / 2, cy: (p.a.y + p.b.y) / 2,
           ux: fr.ux, uy: fr.uy, hu: fr.lenGrid / 2, hv: half };
}
// 分離軸判定（SAT）。重なっていなければ null、重なっていれば
// 「A をどちらへ何だけ動かせば離れるか」＝最小移動ベクトル(MTV)を返す。
// 【押し出しに使う】重なったときに移動を打ち切るのではなく、
// 最小量だけ外へ出して障害物に密着させる。こうすると壁の中へカーソルを入れても
// 箱は直近の壁面に貼り付く（レイクランプ方式だと開始点まで戻ってしまう）
function _bcObbMtv(A, B) {
  const axes = [{ x: A.ux, y: A.uy }, { x: -A.uy, y: A.ux },
                { x: B.ux, y: B.uy }, { x: -B.uy, y: B.ux }];
  const dx = B.cx - A.cx, dy = B.cy - A.cy;
  const proj = (O, ax) => Math.abs(O.ux * ax.x + O.uy * ax.y) * O.hu
                        + Math.abs(-O.uy * ax.x + O.ux * ax.y) * O.hv;
  let bestDepth = Infinity, bestAx = null, bestSgn = 1;
  for (const ax of axes) {
    const d = dx * ax.x + dy * ax.y;
    const depth = proj(A, ax) + proj(B, ax) - Math.abs(d);
    if (depth <= BC_OBB_EPS) return null;          // この軸で離れている＝重なっていない
    if (depth < bestDepth) { bestDepth = depth; bestAx = ax; bestSgn = d > 0 ? -1 : 1; }
  }
  if (!bestAx) return null;
  return { nx: bestAx.x * bestSgn, ny: bestAx.y * bestSgn, depth: bestDepth };
}
function _bcObbOverlap(A, B) { return !!_bcObbMtv(A, B); }
// 高さ範囲が重なっているか。接しているだけ（上面と下面が一致）は重なり扱いにしない。
// これで「高い位置にある機器の下を、背の低い盤がくぐる」が成立する
function _bcZOverlap(aBot, aTop, bBot, bTop) {
  return aTop > bBot + BC_OBB_EPS && bTop > aBot + BC_OBB_EPS;
}
// 移動先が壁や他の箱に重なるなら、ぶつかる手前まで戻す。滑らせず「止める」。
// box   = 移動先の候補（吸い付き後の gx,gy,rotDeg を入れる）
// fromBox = ドラッグ開始時の姿勢。**救済判定だけ**これで見る。
//   吸い付きは向きも変えるので、開始点を「吸い付き後の向き」で判定すると
//   「開始時点で既にめり込んでいる」と誤診して当たり判定を丸ごと素通りさせてしまう（Codex監査の指摘）
const BC_PUSH_ITER = 8;   // 押し出しの反復回数。角で1回では抜けきらないことがある
function bcBlockFloorBoxMove(floor, box, fromGx, fromGy, neighbours, fromBox) {
  if (!bcIsFloorIcon(box)) return { gx: box.gx, gy: box.gy };
  // 【Alt押下中は貫通も許す・2026-09-03 ユーザー要望】
  // 壁をまたぐ形で盤を置くことが実際にある（壁埋め込み・壁貫通の盤）。
  // 「吸い付きを外す」と「当たり判定を外す」は同じ操作（Alt）でまとめて外れるのが自然なので、
  // 判定は snapGate.js の1本を共有する。ここは1行見るだけ
  if (typeof snapSuppressed === 'function' && snapSuppressed()) return { gx: box.gx, gy: box.gy };
  const mpp = _bcMpp();
  // 動かす箱が占める高さ。これと重ならない相手は障害物にしない。
  // 【高さで除く】高い位置にある機器の下を背の低い盤がくぐるのは当たり前の配置なので、
  // 平面だけで弾くと現実の使い方を邪魔する（2026-08-30 ユーザー指摘。
  // コンセントを塞ぐように物を置くのと同じ話）。壁付き機器はそもそも neighbours に入らない。
  const aBot = box.tM || 0, aTop = (box.tM || 0) + (box.hM || 0);
  const obs = [];
  for (const p of ((floor && floor.partitions) || [])) {
    // 壁は全高扱いで常に阻む。透明仕切りは物理的な面ではないので通り抜けてよい
    if (p.kind === 'wall') obs.push(_bcObbOfWall(p, mpp));
  }
  for (const o of (neighbours || [])) {
    if (!bcIsFloorIcon(o) || o.id === box.id) continue;
    const bBot = o.tM || 0, bTop = (o.tM || 0) + (o.hM || 0);
    if (!_bcZOverlap(aBot, aTop, bBot, bTop)) continue;   // 高さが重ならない＝ぶつからない
    obs.push(_bcObbOfBox(o.gx, o.gy, o.rotDeg, o.wM, o.dM, mpp));
  }
  if (!obs.length) return { gx: box.gx, gy: box.gy };
  const obbAt = (gx, gy) => _bcObbOfBox(gx, gy, box.rotDeg, box.wM, box.dM, mpp);
  const anyHit = (gx, gy) => { const A = obbAt(gx, gy); return obs.some(B => _bcObbOverlap(A, B)); };
  if (!anyHit(box.gx, box.gy)) return { gx: box.gx, gy: box.gy };
  // 既存データや直前の回転で開始点から既にめり込んでいるなら、動かすのを妨げない。
  // 【元の姿勢で見る】吸い付きは向きも変えるので、吸い付き後の向きで開始点を判定すると
  // 「最初からめり込んでいる」と誤診して当たり判定を丸ごと素通りさせる
  const f = fromBox || box;
  const A0 = _bcObbOfBox(fromGx, fromGy, f.rotDeg, box.wM, box.dM, mpp);
  if (obs.some(B => _bcObbOverlap(A0, B))) return { gx: box.gx, gy: box.gy };
  // 【押し出す】移動を打ち切るのではなく、候補位置から最小量だけ外へ出して密着させる。
  // 壁の中へカーソルを入れても、箱は直近の壁面に貼り付く
  let gx = box.gx, gy = box.gy;
  for (let i = 0; i < BC_PUSH_ITER; i++) {
    const A = obbAt(gx, gy);
    let worst = null;
    for (const B of obs) {
      const m = _bcObbMtv(A, B);
      if (m && (!worst || m.depth > worst.depth)) worst = m;
    }
    if (!worst) return { gx, gy };
    gx += worst.nx * (worst.depth + BC_OBB_EPS);
    gy += worst.ny * (worst.depth + BC_OBB_EPS);
  }
  // 押し出しきれず挟まった（狭い隙間など）。開始点ではなく、押し出した結果を返す。
  // 開始点へ戻すと画面上は瞬間移動に見える（それがレイクランプ方式の症状だった）
  return { gx, gy };
}

function bcSnapFloorBoxToBox(icon, neighbours, tolGrid) {
  if (!bcIsFloorIcon(icon) || !(tolGrid > 0)) return null;
  const mpp = _bcMpp();
  let best = null, bestGap = Infinity;
  for (const other of (neighbours || [])) {
    if (!bcIsFloorIcon(other) || other.id === icon.id) continue;  // 自分は候補にしない
    const th = (other.rotDeg || 0) * Math.PI / 180;
    const u = { x: Math.cos(th), y: Math.sin(th) };   // 相手の幅方向（真北基準）
    const v = { x: -Math.sin(th), y: Math.cos(th) };  // 相手の奥行方向
    // 【どの面を相手に付けるか】壁への吸い付きと同じ規則。相手の向きから90°単位で
    // いちばん近い姿勢を選び、いま相手にいちばん近い面を付ける。
    // 常に相手と同じ向きにすると、自分で決めた向きが消える（2026-08-29 ユーザー指摘）
    const oc = other.rotDeg || 0, cur = icon.rotDeg || 0;
    let bestK = 0, bestDA = Infinity;
    for (let k = 0; k < 4; k++) {
      const raw = (oc + 90 * k) - cur;
      const da = Math.abs(((raw % 360) + 540) % 360 - 180);
      if (da < bestDA) { bestDA = da; bestK = k; }
    }
    // 90°回すと自分の幅と奥行きが入れ替わる。候補の距離は「揃えた後の寸法」で作る
    const myU = (bestK % 2 === 0) ? icon.wM : icon.dM;   // 相手の幅方向に並ぶ長さ
    const myV = (bestK % 2 === 0) ? icon.dM : icon.wM;   // 相手の奥行方向に並ぶ長さ
    // 【接する辺どうしを揃える候補も出す・2026-09-03 ユーザー要望】
    //   幅の違う盤を並べるとき、中心合わせだけだと「大きい盤の端に小さい盤を寄せる」が
    //   できない。接する面に沿った方向（横ずれ）にも候補を置く:
    //     ・0            … 中心合わせ（従来）
    //     ・±(相手 − 自分)/2 … 接する辺どうしが同じ位置に来る（左端合わせ / 右端合わせ）
    //   幅が同じなら横ずれ0になり、従来と同じ1点に縮退する（候補が増えない）。
    // 【面ごとに軸が入れ替わる】相手の幅方向(u)に付けるときの横ずれは奥行方向(v)、
    //   奥行方向(v)に付けるときの横ずれは幅方向(u)。取り違えると別の辺に揃う。
    const cands = [];
    const pushSide = (mainDir, mainDistM, latDir, latOtherM, latMineM) => {
      const lat0 = (latOtherM - latMineM) / 2;            // 辺を揃えるための横ずれ[m]
      for (const lat of (Math.abs(lat0) < 1e-9 ? [0] : [0, lat0, -lat0])) {
        cands.push({ mainDir, mainDist: mainDistM / mpp, latDir, latDist: lat / mpp });
      }
    };
    pushSide(u,  (other.wM / 2 + myU / 2), v, other.dM, myV);
    pushSide(u, -(other.wM / 2 + myU / 2), v, other.dM, myV);
    pushSide(v,  (other.dM / 2 + myV / 2), u, other.wM, myU);
    pushSide(v, -(other.dM / 2 + myV / 2), u, other.wM, myU);
    for (const cd of cands) {
      const gx = other.gx + cd.mainDir.x * cd.mainDist + cd.latDir.x * cd.latDist;
      const gy = other.gy + cd.mainDir.y * cd.mainDist + cd.latDir.y * cd.latDist;
      const gap = Math.hypot(gx - icon.gx, gy - icon.gy);
      if (gap > tolGrid || gap >= bestGap) continue;
      bestGap = gap;
      best = { gx, gy, rotDeg: oc + 90 * bestK, iconId: other.id, gap };
    }
  }
  return best;
}

// 吸い付きの唯一の入口。壁と隣の箱の両方を試し、**ずれの小さい方**を返す。
// 同程度なら壁を優先する（壁沿いに並べるのが基本の配置なので、そちらが安定する）
const BC_SNAP_TIE_GRID = 0.5; // これ以内の差なら「同程度」と見なす
function bcSnapFloorBox(floor, icon, neighbours, tolGrid) {
  // 【一時解除】判定は snapGate.js が唯一の実装。ここは1行見るだけ（2026-09-03）
  if (typeof snapSuppressed === 'function' && snapSuppressed()) return null;
  const w = bcSnapFloorBoxToWall(floor, icon, tolGrid);
  const i = bcSnapFloorBoxToBox(icon, neighbours, tolGrid);
  if (!w) return i;
  if (!i) return w;
  const gw = Math.hypot(w.gx - icon.gx, w.gy - icon.gy);
  return (gw <= i.gap + BC_SNAP_TIE_GRID) ? w : i;
}

// 床置き機器だけを相手にする従来の入口（薄いラッパ）。
// 配電盤も相手にしたい呼び出し側は bcSnapFloorBox に結合済みリストを渡す
function bcSnapFloorIcon(floor, icon, tolGrid) {
  return bcSnapFloorBox(floor, icon, floor.icons || [], tolGrid);
}

// 床置きの箱が床の外形からはみ出しているか。**弾かずに警告するため**の判定。
// 中心だけでなく平面の4隅で見る（本体がはみ出していれば見た目どおり警告したい。監査指摘）
function bcFloorBoxesOutside(building, floor, boxes) {
  const outlines = bcFloorOutlines(building, floor);
  if (!outlines.length) return [];
  const inAny = (pt) => outlines.some(poly => _bcPip(pt.x, pt.y, poly));
  const out = [];
  for (const ic of (boxes || [])) {
    if (!bcIsFloorIcon(ic)) continue;
    const g = bcFloorIconGeom(floor, ic);
    if (!g.poly.every(inAny)) out.push(ic.id);
  }
  return out;
}

function bcFloorIconsOutside(building, floor) {
  return bcFloorBoxesOutside(building, floor, floor.icons || []);
}

// 床置きの箱がその階の高さに収まらないか（天井を突き抜ける）。
// 【弾かない】配電盤は建物側の都合で縮めてよいものではないので、
// clamp せず警告だけ出す（Codex監査の指示）。床外の警告と同じ扱い
function bcFloorBoxesTooTall(floor, boxes) {
  const h = floor.heightM != null ? floor.heightM : BC_FLOOR_DEFAULTS.heightM;
  const out = [];
  for (const ic of (boxes || [])) {
    if (!bcIsFloorIcon(ic)) continue;
    if ((ic.tM || 0) + ic.hM > h + 1e-9) out.push(ic.id);
  }
  return out;
}

// その階が、この平面位置・この高さの物を載せているか。
// 建物エディタに出す配電盤の選別に使う（別モデルの箱を階へ割り当てる唯一の判定）。
// 「中心が床の外形の内側」かつ「高さがこの階の範囲内」。
// 床にぴったり載っていない盤（据付台の上など）も、その階の範囲内なら載っているとする
function bcFloorHoldsPoint(building, floor, gx, gy, zM) {
  const outlines = bcFloorOutlines(building, floor);
  if (!outlines.length) return false;
  if (!outlines.some(poly => _bcPip(gx, gy, poly))) return false;
  const h = floor.heightM != null ? floor.heightM : BC_FLOOR_DEFAULTS.heightM;
  return zM >= floor.levelZ - 1e-6 && zM < floor.levelZ + h - 1e-6;
}

// 壁の長さ・高さが変わったとき、その壁に**ぶら下がっている物すべて**が収まるか。
// bcDoorsFitLength と同じ役割で、bcApplyPartEdit から同じように呼ぶ。
// 【対象は3階層】壁の機器 / その壁の扉 / その扉の機器。
// 扉の機器は partitionId を持たないので、partId で絞るだけでは取りこぼす（Codex監査指摘）
function bcIconsFitPartition(floor, partId, newLenM, newHeightM) {
  const errors = [];
  const nm = (x) => '「' + (x.name || '機器') + '」';
  for (const ic of (floor.icons || [])) {
    if (!bcIsWallIcon(ic) || ic.partitionId !== partId) continue;
    const lo = ic.sM - ic.wM / 2, hi = ic.sM + ic.wM / 2;
    if (lo < -1e-9 || hi > newLenM + 1e-9) errors.push(nm(ic) + 'が壁の範囲からはみ出します');
    if (newHeightM != null && ic.tM + ic.hM / 2 > newHeightM + 1e-9) {
      errors.push(nm(ic) + 'が壁の高さを超えます');
    }
  }
  // ── その壁の扉と、扉に付いている機器 ──
  for (const d of (floor.doors || [])) {
    if (d.partitionId !== partId) continue;
    const dw = d.widthM != null ? d.widthM : BC_DOOR_DEFAULTS.widthM;
    const dh = d.heightM != null ? d.heightM : BC_DOOR_DEFAULTS.heightM;
    // 【2026-08-29 ユーザー決定】壁を低くして扉が入らなくなる変更は拒否する。
    // 従来は黙って扉の描画だけが潰れていた（データは変わらないので気づけない）
    if (newHeightM != null && dh > newHeightM + 1e-9) {
      errors.push('「' + (d.name || '扉') + '」が壁の高さに入りません');
    }
    // 扉が壁の端でクランプされた後の実寸で、扉の機器が収まるかを見る
    const spanSM = Math.min(newLenM, (d.uM || 0) + dw / 2) - Math.max(0, (d.uM || 0) - dw / 2);
    const spanTM = newHeightM != null ? Math.min(dh, newHeightM) : dh;
    for (const ic of (floor.icons || [])) {
      if (!bcIsDoorIcon(ic) || ic.doorId !== d.id) continue;
      if (ic.sM + ic.wM / 2 > spanSM + 1e-9) errors.push(nm(ic) + 'が扉の範囲からはみ出します');
      if (ic.tM + ic.hM / 2 > spanTM + 1e-9) errors.push(nm(ic) + 'が扉の高さを超えます');
    }
  }
  return { ok: errors.length === 0, errors };
}

// 扉に載っている機器が収まる**最小の扉寸法**。扉を縮めるときの頭打ちの下限。
// 【2026-08-29 ユーザー決定】「限界の数値にいったら頭打ちするようにする」。
// はみ出すからエラーにするのではなく、機器が収まる所で寸法が止まる。
// 数値入力でもドラッグでも同じ挙動になり、操作が途中で止まらない
function bcDoorIconsMinSize(floor, doorId) {
  let minW = BC_DOOR_DEFAULTS.minM, minH = BC_DOOR_DEFAULTS.minM;
  for (const ic of (floor.icons || [])) {
    if (!bcIsDoorIcon(ic) || ic.doorId !== doorId) continue;
    minW = Math.max(minW, ic.sM + ic.wM / 2);   // 右端が扉の外へ出ない最小幅
    minH = Math.max(minH, ic.tM + ic.hM / 2);   // 上端が扉の外へ出ない最小高さ
  }
  return { minW, minH };
}

// 参照先が実在しない機器を落とす。扉削除・壁削除の道連れをこの1本にまとめる。
// 【なぜ1本にするか】壁を消すと「壁 → その壁の扉 → 扉の機器」の2段の道連れになる。
// フィルタ条件を呼び出し側ごとに書くと必ず漏れ、
// 「一覧にも3Dにも出ないのにデータには残る＝消せない機器」ができる（Codex監査指摘）
function bcPruneOrphanIcons(floor, building) {
  const partIds = new Set((floor.partitions || []).map(p => p.id));
  const doorIds = new Set((floor.doors || []).filter(d => partIds.has(d.partitionId)).map(d => d.id));
  // 外周壁は建屋の形を見ないと在る／無いが判定できない。
  // building を渡されないときは全部残す（判定できないものを消すと取り戻せない）
  const outerKeys = building ? new Set(bcFloorOuterEdges(building, floor).map(e => e.key)) : null;
  const src = floor.icons || [];
  const icons = src.filter(ic =>
    bcIsFloorIcon(ic) ? true
      : bcIsCeilIcon(ic) ? true
      : bcIsDoorIcon(ic) ? doorIds.has(ic.doorId)
      : bcIsOuterIcon(ic) ? (!outerKeys || outerKeys.has(ic.outerKey))
      : partIds.has(ic.partitionId));
  return icons.length === src.length ? floor : { ...floor, icons };
}

// 図面のクリック点 → その取付面の { sM, side }。
// 【なぜ1本にするか】機器を「置く」ときと「面の上をドラッグする」ときで別々に射影を書くと、
// 置いた位置と掴んだ位置がズレる（扉の bcDoorUAtPoint と同じ理由）。
// hostRef = { partitionId } | { doorId }（配置前の仮の物でよい）
// 【面の上の点から置き場所を出す・2026-09-06】
// gridPt が「取付面そのものの上の点」であるときに使う。3Dで扉・壁をクリックしたときの
// 交点がこれに当たる。zM（世界のm）も分かるので、高さ(tM)まで一度に決まる。
// 【なぜ床の点ではだめか】垂直な面をクリックすると、床の面へ落とした点は壁の
// **向こう側**に着地する。表裏が反転して裏面に付き、面に沿った位置もずれる（ユーザー報告）。
function bcIconSpotAtFacePoint(floor, hostRef, gridPt, zM, building) {
  const fm = bcIconFrame(floor, hostRef, building);
  if (!fm) return null;
  // 往き（atS）と同じ面の定義から帰りを作る。別々に書くと置いた位置と掴んだ位置がズレる
  const pr = _bcSurfFrameOn() ? fm.projectPoint(gridPt)
    : { uM: bcDoorUAtPoint(fm.part, gridPt), side: bcSideOfPart(fm.part, gridPt) };
  const spot = {
    sM: Math.max(0, Math.min(fm.spanSM, pr.uM - fm.originSM)),
    side: pr.side,                                         // 面の上の点なので表裏が正しく出る
    frame: fm,
  };
  // 高さ。icon.tM は「面の下端から機器の中心まで」（bcIconAnchorGeom の zB = baseZ + tM - hM/2）
  if (Number.isFinite(zM)) spot.tM = Math.max(0, Math.min(fm.spanTM, zM - fm.baseZ));
  return spot;
}

function bcIconSpotAtPoint(floor, hostRef, gridPt, building) {
  const fm = bcIconFrame(floor, hostRef, building);
  if (!fm) return null;
  const pr = _bcSurfFrameOn() ? fm.projectPoint(gridPt)
    : { uM: bcDoorUAtPoint(fm.part, gridPt), side: bcSideOfPart(fm.part, gridPt) };
  return {
    sM: Math.max(0, Math.min(fm.spanSM, pr.uM - fm.originSM)),  // 面ローカルへ
    side: pr.side,                              // 表裏は射影**前**の点で決める
    frame: fm,
  };
}

// 機器を壁の中へ収める。**確定時とドラッグ中のプレビューの両方がこれを呼ぶ**。
// 片方にしか無いと「ドラッグ中は壁からはみ出すのに、離すと端へ戻る」ことになる
// （2026-08-28 ユーザー指摘）。クランプの式を2箇所に書けば必ずズレる
// 【床置き】収めるのは寸法と立ち上がりだけ。
// 床の外形からのはみ出しは**弾かずに警告**する（既存の「⚠床の外」と同じ扱い）。
// 弾くと「床の形を後から変えたら機器が編集不能になる」ことになるため
function bcClampFloorIcon(floor, icon) {
  const mn = BC_ICON_DEFAULTS.minM;
  const wallH = floor.heightM;
  const hM = Math.max(mn, Math.min(wallH, icon.hM));
  return {
    wM: Math.max(mn, icon.wM),
    dM: Math.max(mn, icon.dM),
    hM,
    tM: Math.max(0, Math.min(Math.max(0, wallH - hM), icon.tM || 0)),
  };
}

// 取付面の中へ収める。壁でも扉でも「面の可動範囲(spanSM)×縦範囲(spanTM)」を見るだけで、
// 面の種類による分岐は無い（差は bcIconFrame が吸収済み）
function bcClampIconOnFrame(frame, icon) {
  const mn = BC_ICON_DEFAULTS.minM;
  const wM = Math.max(mn, Math.min(frame.spanSM, icon.wM));
  const hM = Math.max(mn, Math.min(frame.spanTM, icon.hM));
  const hw = wM / 2, hh = hM / 2;
  return {
    wM, hM,
    sM: Math.max(hw, Math.min(Math.max(hw, frame.spanSM - hw), icon.sM)),
    tM: Math.max(hh, Math.min(Math.max(hh, frame.spanTM - hh), icon.tM)),
  };
}

// 取付面（壁・扉）に置いた機器が「どれだけ動けるか」。唯一の定義。
// 【なぜ要るか】扉は幅0.9m程度しかないので、幅0.8mの機器は左右に0.1mしか動けない。
// これは clamp が正しく働いた結果だが、操作している人には「動かない＝壊れている」に見える。
// 可動域を collapse とセットで返して、理由をそのまま伝えられるようにする（2026-09-06）。
// clamp と別々に計算すると必ずズレるので、収める式（bcClampIconOnFrame）と同じ値を使う。
function bcIconRangeM(floor, icon, building) {
  if (!icon || bcIsFloorIcon(icon) || bcIsCeilIcon(icon)) return null;  // 水平面は面の幅で縛らない
  const fm = bcIconFrame(floor, icon, building);
  if (!fm) return null;
  const c = bcClampIconOnFrame(fm, icon);
  const hw = c.wM / 2, hh = c.hM / 2;
  const sMin = hw, sMax = Math.max(hw, fm.spanSM - hw);
  const tMin = hh, tMax = Math.max(hh, fm.spanTM - hh);
  return {
    host: fm.host, spanSM: fm.spanSM, spanTM: fm.spanTM,
    sMin, sMax, sRange: sMax - sMin,
    tMin, tMax, tRange: tMax - tMin,
    // 面より大きい機器は面の大きさへ縮められる。黙って縮むと気づけないので返す
    wM: c.wM, hM: c.hM,
    wShrunk: icon.wM != null && c.wM < icon.wM - 1e-9,
    hShrunk: icon.hM != null && c.hM < icon.hM - 1e-9,
  };
}
// 「動かない」理由を日本語1行で返す。動けるなら null。表示のしかたは呼び出し側の自由
function bcIconRangeMsg(floor, icon, building) {
  const r = bcIconRangeM(floor, icon, building);
  if (!r) return null;
  const face = r.host === 'door' ? '扉' : r.host === 'outer' ? '外壁' : '壁';
  const parts = [];
  if (r.sRange < 0.02) {
    parts.push(`${face}の幅${r.spanSM.toFixed(2)}mに対し機器の幅が${r.wM.toFixed(2)}mなので左右に動かせません`);
  } else if (r.sRange < 0.15) {
    parts.push(`${face}の幅${r.spanSM.toFixed(2)}mに対し機器の幅が${r.wM.toFixed(2)}mなので、左右は${r.sRange.toFixed(2)}mしか動きません`);
  }
  if (r.wShrunk) parts.push(`機器の幅を${face}の幅${r.spanSM.toFixed(2)}mに合わせて縮めました`);
  if (r.hShrunk) parts.push(`機器の高さを${face}の高さ${r.spanTM.toFixed(2)}mに合わせて縮めました`);
  return parts.length ? parts.join('。') : null;
}

// 機器を収める唯一の入口。床置き／取付面ありの分岐はここだけに置く。
// 確定時（bcApplyIconEdit）とドラッグ中のプレビューの両方がこれを呼ぶ
function bcClampIcon(floor, icon, building) {
  if (bcIsFloorIcon(icon) || bcIsCeilIcon(icon)) return bcClampFloorIcon(floor, icon);
  const fm = bcIconFrame(floor, icon, building);
  return fm ? bcClampIconOnFrame(fm, icon) : {};
}

// アイコン編集の唯一の出口（壁の bcApplyPartEdit・扉の bcApplyDoorEdit と同じ形）。
// patch = 壁面 { sM?, tM?, wM?, hM?, side? } / 床置き { gx?, gy?, rotDeg?, tM?, wM?, dM?, hM? }
//         共通 { name?, color?, iconType? }
function bcApplyIconEdit(building, floorId, iconId, patch) {
  const floors = building.floors || [];
  const fi = floors.findIndex(f => f.id === floorId);
  if (fi < 0) return { ok: false, errors: ['階が見つかりません'], building };
  const floor = floors[fi];
  const icons = floor.icons || [];
  const ii = icons.findIndex(x => x.id === iconId);
  if (ii < 0) return { ok: false, errors: ['機器が見つかりません'], building };
  const i0 = icons[ii];
  const p0 = patch || {};
  // ── 床置き ──（壁の長さ・高さの制約が無いので分けて扱う）
  if (bcIsFloorIcon(i0) || bcIsCeilIcon(i0)) {
    const cand = { ...i0 };
    // labelDx/labelDy は名称ラベルの画面上のずらし量（幾何ではなく表示状態）
    // labelOffset2D = 2Dビューごとの名称ラベルのずらし量（盤の labelOffset2D と同じ考え方）
    ['gx','gy','rotDeg','tM','wM','dM','hM','name','color','iconType','labelDx','labelDy','labelOffset','labelOffset2D'].forEach(k => {
      if (p0[k] != null) cand[k] = p0[k];
    });
    Object.assign(cand, bcClampFloorIcon(floor, cand));
    const nif = icons.slice(); nif[ii] = cand;
    const fsf = floors.slice(); fsf[fi] = { ...floor, icons: nif };
    return { ok: true, errors: [], building: { ...building, floors: fsf } };
  }
  // ── 取付面あり（壁の面 or 扉の面）──
  // 【patch に doorId / partitionId は入れない】取付先の付け替え（扉→壁など）は不可。
  // 置き直しで対応する（壁面機器も壁をまたぐ移動はできないので、既存の一貫性に合わせる）
  const fm = bcIconFrame(floor, i0, building);
  if (!fm) return { ok: false, errors: [bcIsDoorIcon(i0) ? '機器が乗る扉が見つかりません'
                                        : bcIsOuterIcon(i0) ? '機器が乗る外壁が見つかりません'
                                                            : '機器が乗る壁が見つかりません'], building };
  const p = patch || {};
  const cand = { ...i0 };
  // 【labelDx/labelDy を落とさない・2026-09-04】名称ラベルの画面上のずらし量。
  // 床置きの枝（930行）には入っていたが、こちらに入れ忘れていたため
  // 壁・扉に置いた機器のラベルだけ、動かしても保存されず元に戻っていた。
  ['wM','hM','sM','tM','name','color','iconType','labelDx','labelDy','labelOffset','labelOffset2D'].forEach(k => { if (p[k] != null) cand[k] = p[k]; });
  if (p.side != null) cand.side = p.side < 0 ? -1 : 1;
  // 取付面の中へ収める（幅・高さを変えたときも収め直す）。式は1箇所だけ
  Object.assign(cand, bcClampIconOnFrame(fm, cand));
  const ni = icons.slice(); ni[ii] = cand;
  const fs = floors.slice(); fs[fi] = { ...floor, icons: ni };
  return { ok: true, errors: [], building: { ...building, floors: fs } };
}

// 仕切りの長さ[m]
function bcPartitionLenM(part) {
  const dx = part.b.x - part.a.x, dy = part.b.y - part.a.y;
  return Math.sqrt(dx * dx + dy * dy) * _bcMpp();
}

// 多角形の符号なし面積
function _bcPolyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    s += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(s) / 2;
}

// 多角形を軸平行の矩形で切り取る（Sutherland–Hodgman）。
// 矩形（凸）を切り取り領域、多角形（凹でも可）を被切り取り側にすると交差が得られる。
// 【なぜ必要か】セルの内外を中心1点のPIPだけで決めると、外形が軸平行でない場合
// （斜めの建物、PN回転後の外形）に部屋の形が階段状のギザギザになり、面積も合わなくなる。
// セルを外形で正確に切り取ることで、形も面積も外形どおりになる
// 【半平面1枚で切る】Sutherland–Hodgman の中身をここへ分解した。
// 矩形クリップも、部屋認識で使う「壁の直線で切る」も、すべてこの1本から組み立てる。
// 別々に書くと境界(=0)の扱いがズレて、同じ点が片側では内・もう片側では外になる
// （＝セルの間に隙間や重なりができる）。
// 残すのは n·p <= d の側。境界ちょうどの点は**残す**（両側に現れて構わない）
function _bcClipHalfPlane(poly, nx, ny, d) {
  if (!poly || poly.length < 3) return [];
  const sd = (p) => nx * p.x + ny * p.y - d;
  const cut = (p, q, dp, dq) => {
    const t = dp / ((dp - dq) || 1e-12);
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i - 1 + poly.length) % poly.length];
    const dc = sd(cur), dp = sd(prev);
    const curIn = dc <= 0, prevIn = dp <= 0;
    if (curIn) {
      if (!prevIn) out.push(cut(prev, cur, dp, dc));
      out.push({ x: cur.x, y: cur.y });
    } else if (prevIn) {
      out.push(cut(prev, cur, dp, dc));
    }
  }
  return out.length >= 3 ? out : [];
}

// 軸平行の矩形で切りたくなったら _bcClipHalfPlane を4回呼べばよい:
//   (-1,0,-xMin) → (1,0,xMax) → (0,-1,-yMin) → (0,1,yMax)
// 部屋認識が軸平行グリッドをやめたので、専用の矩形クリップ関数は置かない
// （呼び出しゼロの関数を残すと、動作確認されないまま腐る）

// 2D点内包（レイキャスティング。solidModelの_pip2dと同一ロジックの自己完結コピー）
function _bcPip(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 点からポリゴン境界までの最短距離（グリッド単位）
function _bcDistToPolyEdge(px, py, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const ax = poly[i].x, ay = poly[i].y, bx = poly[j].x, by = poly[j].y;
    const ex = bx - ax, ey = by - ay;
    const el2 = ex * ex + ey * ey;
    if (el2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / el2));
    const cx = ax + t * ex, cy = ay + t * ey;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

// 仕切りの妥当性検証: 両端点が「階外形の内側 または 境界上（許容誤差つき）」にあるか
// 壁は外壁（ガワ）に接して引くのが通常の使い方なので、境界ちょうどの端点を弾かない
function bcValidatePartition(building, floor, part) {
  const errors = [];
  const outlines = bcFloorOutlines(building, floor);
  if (outlines.length === 0) { errors.push('階の外形がありません'); return { ok: false, errors }; }
  const TOL = 1.0; // 境界許容（グリッド単位。既定0.1m）
  const inAny = (p) => outlines.some(poly => _bcPip(p.x, p.y, poly) || _bcDistToPolyEdge(p.x, p.y, poly) <= TOL);
  if (!inAny(part.a) || !inAny(part.b)) errors.push('仕切りの端点が階の外形の外にあります');
  if (Math.hypot(part.b.x - part.a.x, part.b.y - part.a.y) < BC_ROOM_EPS) errors.push('仕切りが短すぎます');
  return { ok: errors.length === 0, errors };
}

// ── 部屋認識（panelChambers.deriveChambers の2D版）──
// 戻り値: [{ id, key(安定キー), color, area, isLargest, outlineIdx, cells:[{corners,...}] }]
//
// 【2026-08-28 一般化】以前は「PN軸に平行な壁だけ」を境界として軸平行グリッドに
// 切っていた。そのため斜めの壁が部屋を仕切らず、PN角度を変えると
// それまで軸平行だった壁が斜め扱いになって色分けが崩れた。
// **構造（セル分割 → 共有辺の遮断判定 → Union-Find）はそのままに、
//   「軸平行」という前提だけを外した**:
//   1. セル分割: 外形を **全ての壁の直線**で順に切る（軸平行グリッドの一般化）。
//      直線がセルを横切らなければ片側が空になるので、そのセルは割れない
//   2. 隣接判定: 内部の辺は必ずどれかの壁直線の上にあるので、
//      辺を「乗っている直線」ごとに集めて、同じ直線上で重なる辺どうしだけ突き合わせる
//   3. 遮断判定: 重なり区間が、その直線上の**実際の壁線分**の合併で覆われているか
//      （＝従来の covered() のギャップ検査を、直線上の1次元パラメータで行う）
//   4. Union-Find → 部屋
// 扉は分断に影響させない（扉があっても部屋同士は結合しない＝壁は壁のまま）

// セル分割の歯止め。壁がW本なら概ね O(W^2) 個で収まるが、
// 数値誤差で細片が増え続けたときに画面が固まらないようにする
const BC_ROOM_MAX_CELLS = 4000;
const BC_CELL_MIN_AREA = 1e-6; // これ未満の破片は「割れていない」と見なす

// 線分の乗る直線を正規形にする。向きを一意に決めないと、
// 同じ直線が2つのキーになって隣接判定が割れる（Codex監査の指摘）
function _bcLineOf(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  let nx = -dy / len, ny = dx / len;
  // 法線の向きを一意化（nx>0、nx≒0なら ny>0 の側にそろえる）
  if (nx < -1e-9 || (Math.abs(nx) <= 1e-9 && ny < 0)) { nx = -nx; ny = -ny; }
  return { nx, ny, d: nx * a.x + ny * a.y, ux: -ny, uy: nx };
}
// ── プラントノース(PN)回転ヘルパー ──
// 【設計】保存する座標は常に真北基準のグリッド座標のまま変えない（監査OK済み）。
// PNは後から変更され得る設定値なので、保存座標をPN基準にすると角度変更のたびに
// 全ジオメトリの書き換え＝データ移行が発生する。またCesium・blocks・配電盤は
// すべて真北基準なので、保存だけPNにすると変換箇所が全ビューに散る。
// そこで「保存は真北・作図と部屋認識のときだけ回す」という分離にする。
//   world→PN: u = x cosθ - y sinθ,  v = x sinθ + y cosθ
//   PN→world: x = u cosθ + v sinθ,  y = -u sinθ + v cosθ
function bcPnRot(pnDeg) {
  const t = ((pnDeg || 0) * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return {
    toPn: (p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }),
    toWorld: (p) => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c }),
    isIdentity: Math.abs(t) < 1e-12,
  };
}

// 部屋認識。pnDeg は「安定キーをどの座標系で作るか」にだけ効く（角度を変えても
// キーが揺れないようにするため）。**壁の角度は問わない**。
// 【セル形状について】戻り値のセルは `corners:[{x,y}]`（真北基準の世界座標）。
// 軸平行とは限らないので4値の矩形では表現できず、頂点列で持つ。
// 互換のため xMin/xMax/yMin/yMax も外接矩形として併記する
function bcDeriveRooms(building, floor, pnDeg) {
  const rot = bcPnRot(pnDeg);
  const outlinesW = bcFloorOutlines(building, floor);
  if (outlinesW.length === 0) return [];
  // 安定キーと面積計算をPN基準で行うため、いったんPN座標系へ回す
  const outlines = outlinesW.map(poly => poly.map(rot.toPn));
  const EPS = BC_ROOM_EPS;

  // ── 壁を「乗っている直線」ごとにまとめる（角度は問わない）──
  // 同じ直線に複数の壁が乗ることがある（一直線に並べて引いた壁）。
  // 遮断判定はその直線上で1次元の区間マージにするので、ここでまとめておく
  const lines = [];
  const lineFor = (L) => {
    for (const e of lines) {
      // 法線がほぼ同じで、直線までの距離もEPS内なら同じ直線と見なす。
      // 角度の許容は厳しく（本当に平行な壁だけ）、位置の許容はEPS
      if (Math.abs(e.nx - L.nx) < 1e-6 && Math.abs(e.ny - L.ny) < 1e-6 &&
          Math.abs(e.d - L.d) < EPS) return e;
    }
    const e = { nx: L.nx, ny: L.ny, d: L.d, ux: L.ux, uy: L.uy, ivs: [] };
    lines.push(e); return e;
  };
  for (const p of (floor.partitions || [])) {
    const a = rot.toPn(p.a), b = rot.toPn(p.b);
    if (Math.hypot(b.x - a.x, b.y - a.y) < EPS) continue; // 短すぎる壁は境界にしない
    const L = _bcLineOf(a, b);
    if (!L) continue;
    const e = lineFor(L);
    // 直線上の1次元パラメータ（t = p·u）。遮断判定はこの区間で行う
    const ta = a.x * e.ux + a.y * e.uy, tb = b.x * e.ux + b.y * e.uy;
    e.ivs.push([Math.min(ta, tb), Math.max(ta, tb)]);
  }

  // ── 1. セル分割: 外形を、全ての壁の直線で順に切る ──
  // 直線がセルを横切らなければ片側が空になるので、そのセルは割れない。
  // これが軸平行グリッドの一般化にあたる
  let cells = outlines.map((poly, oi) => ({ poly, oi }));
  for (const L of lines) {
    const next = [];
    for (const c of cells) {
      const pos = _bcClipHalfPlane(c.poly, L.nx, L.ny, L.d);
      const neg = _bcClipHalfPlane(c.poly, -L.nx, -L.ny, -L.d);
      const ap = pos.length ? _bcPolyArea(pos) : 0;
      const an = neg.length ? _bcPolyArea(neg) : 0;
      if (ap > BC_CELL_MIN_AREA && an > BC_CELL_MIN_AREA) {
        next.push({ poly: pos, oi: c.oi });
        next.push({ poly: neg, oi: c.oi });
      } else {
        next.push(c); // 実質割れていない（片側が空 or 破片）
      }
    }
    cells = next;
    if (cells.length > BC_ROOM_MAX_CELLS) break; // 歯止め（暴走で画面を固めない）
  }
  cells = cells.filter(c => _bcPolyArea(c.poly) > BC_CELL_MIN_AREA);
  if (cells.length === 0) return [];

  // ── 2. 隣接判定: 辺を「乗っている直線」ごとに集める ──
  // 内部の辺は必ずどれかの壁直線の上にあるので、同じ直線上で重なる辺どうしだけを
  // 突き合わせればよい（セル総当たりを避ける）
  // 【バケツのキーは「向き」だけにする】d まで量子化に混ぜると、同じ直線上の辺が
  // 刻みの境目で別のバケツに落ちて隣接が切れる。d は突き合わせの中でEPS比較する
  const buckets = new Map();
  const bucketKey = (L) => Math.round(L.nx * 1e4) + '/' + Math.round(L.ny * 1e4);
  cells.forEach((c, ci) => {
    for (let i = 0; i < c.poly.length; i++) {
      const p = c.poly[i], q = c.poly[(i + 1) % c.poly.length];
      const L = _bcLineOf(p, q);
      if (!L) continue;
      const t0 = p.x * L.ux + p.y * L.uy, t1 = q.x * L.ux + q.y * L.uy;
      const k = bucketKey(L);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ ci, L, lo: Math.min(t0, t1), hi: Math.max(t0, t1) });
    }
  });

  // 遮断判定: 重なり区間 [lo,hi] が、その直線上の実際の壁線分で覆われているか。
  // 覆われていなければ通れる＝同じ部屋（従来の covered() と同じギャップ検査）
  const coveredOnLine = (L, lo, hi) => {
    let best = null;
    for (const e of lines) {
      if (Math.abs(e.nx - L.nx) < 1e-6 && Math.abs(e.ny - L.ny) < 1e-6 &&
          Math.abs(e.d - L.d) < EPS) { best = e; break; }
    }
    if (!best) return false;
    const ivs = best.ivs.slice().sort((a, b) => a[0] - b[0]);
    let cur = lo;
    for (const [s, e2] of ivs) {
      if (s > cur + EPS) return false; // ギャップ → 通れる
      if (e2 > cur) cur = e2;
      if (cur >= hi - EPS) return true;
    }
    return cur >= hi - EPS;
  };

  // ── 3. Union-Find ──
  const parent = cells.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const A = arr[i], B = arr[j];
      if (A.ci === B.ci) continue;
      if (cells[A.ci].oi !== cells[B.ci].oi) continue; // 別の外形どうしはつなげない
      if (Math.abs(A.L.d - B.L.d) > EPS) continue;     // 平行だが別の直線
      const lo = Math.max(A.lo, B.lo), hi = Math.min(A.hi, B.hi);
      if (hi - lo <= EPS) continue;                    // 触れているだけ（点接触）は隣接ではない
      if (find(A.ci) === find(B.ci)) continue;
      // 【切り欠きをまたがない】Sutherland–Hodgman は凹んだ外形を切ると、
      // 離れた断片を切断線に沿った幅ゼロの橋でつなぐ。その橋を「共有辺」と
      // 誤認すると、外形の外を通って別の部屋がつながってしまう。
      // 重なり区間の中点が外形の内側にあることを確かめて弾く
      const tm = (lo + hi) / 2;
      const mid = { x: A.L.nx * A.L.d + A.L.ux * tm, y: A.L.ny * A.L.d + A.L.uy * tm };
      const op = outlines[cells[A.ci].oi];
      if (!_bcPip(mid.x, mid.y, op) && _bcDistToPolyEdge(mid.x, mid.y, op) > EPS) continue;
      if (!coveredOnLine(A.L, lo, hi)) union(A.ci, B.ci);
    }
  }

  // ── 4. グループ化 → 部屋 ──
  const groups = new Map();
  cells.forEach((c, ci) => {
    const root = find(ci);
    if (!groups.has(root)) groups.set(root, []);
    // 外形で切り取った後のポリゴン（PN座標系）を世界座標へ戻す。
    // 安定キーはPN座標系のセル左下、面積は切り取り後の実面積を使う
    const cornersW = c.poly.map(rot.toWorld);
    const wxs = cornersW.map(p => p.x), wys = cornersW.map(p => p.y);
    const pxs = c.poly.map(p => p.x), pys = c.poly.map(p => p.y);
    groups.get(root).push({
      corners: cornersW,          // ← 描画はこれを使う（軸平行とは限らない）
      pxMin: Math.min(...pxs), pyMin: Math.min(...pys), // PN座標系の左下（安定キー用）
      area: _bcPolyArea(c.poly),  // 切り取り後の実面積（回転不変）
      // 互換用の外接矩形（旧 {xMin..} を参照する箇所が残っていても壊れないように）
      xMin: Math.min(...wxs), xMax: Math.max(...wxs),
      yMin: Math.min(...wys), yMax: Math.max(...wys),
      outlineIdx: c.oi,
    });
  });
  const rooms = [];
  for (const [root, cells] of groups) {
    // 安定キー: **PN座標系**の最小セル座標を丸めたもの。
    // 世界座標で計算するとPN角度を変えるたびにキーが揺れてしまう（監査指摘）
    const key = cells.map(c => _bcR1(c.pxMin) + ',' + _bcR1(c.pyMin)).sort()[0];
    rooms.push({ id: 'room_' + root, key, outlineIdx: cells[0].outlineIdx, cells });
  }
  // 各部屋の実面積を持たせ、**面積の小さい順**に色を割り当てる。
  // 壁で囲んで作った狭い部屋にこそ目立つ色を付けたいため。
  // （従来は座標順だったので、外周に残った一番広い領域に先頭色が付き
  //   「壁で囲んだ部屋ではなく周囲が色付く」という見え方になっていた＝ユーザー指摘）
  // 面積は各セルの「外形で切り取った後の実面積」の合計（回転不変・外形どおり）
  rooms.forEach(r => {
    r.area = r.cells.reduce((s, c) => s + c.area, 0);
  });
  rooms.sort((a, b) => (a.area - b.area) || (a.key < b.key ? -1 : 1));
  rooms.forEach((r, i) => {
    r.color = BC_ROOM_COLORS[i % BC_ROOM_COLORS.length];
    r.isLargest = false;
  });
  if (rooms.length > 1) rooms[rooms.length - 1].isLargest = true; // 最大＝外周に残った領域
  return rooms;
}

// 仕切りの長さが変わった時、その仕切り上の扉が新しい長さに収まるか検証する
// （壁の端点ドラッグ・平行移動で短くなったとき、既存の扉がはみ出さないことを保証する。Codex監査指摘）
function bcDoorsFitLength(floor, partId, newLenM) {
  const errors = [];
  for (const d of (floor.doors || [])) {
    if (d.partitionId !== partId) continue;
    const lo = d.uM - d.widthM / 2, hi = d.uM + d.widthM / 2;
    if (lo < -1e-9 || hi > newLenM + 1e-9) errors.push('扉「' + (d.name || '扉') + '」が壁の範囲からはみ出します');
  }
  return { ok: errors.length === 0, errors };
}

// 点が多角形の内側か（レイキャスト）。2Dのヒット判定・3Dのヒット判定の両方が使う。
// 3D側(_bp3PointInPoly)にしか無かったため、2Dで扉を選ぶのに同じ式を書き足す寸前だった
function bcPointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

// 壁上の点 → 端点aからの距離[m]。
// 【なぜ1本にするか】扉を「置く」ときと「壁に沿ってスライドする」ときで
// 別々に射影を書くと、置いた位置と掴んだ位置がズレる。入口を1つにする。
// 壁から外れた所をクリックしても、壁の線へ下ろした足の位置を返す（0〜壁長にクランプ）
function bcDoorUAtPoint(part, gridPt) {
  const dx = part.b.x - part.a.x, dy = part.b.y - part.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return 0;
  const t = ((gridPt.x - part.a.x) * dx + (gridPt.y - part.a.y) * dy) / len2;
  return Math.max(0, Math.min(1, t)) * bcPartitionLenM(part);
}

// ── 扉編集の唯一の出口（壁の bcApplyPartEdit と同じ思想）──
// patch = { uM?, widthM?, heightM?, name? }
// building は変更せず、新しいオブジェクトを返す。
// 【役割分担】単体の扉の寸法クランプ（壁長・壁高に収める）はここ。
// 「壁に乗っている扉全部が収まるか」の幾何判定は bcDoorsFitLength に委ねる
// （同じ判定を2箇所に書かない。Codex監査指摘）
function bcApplyDoorEdit(building, floorId, doorId, patch) {
  const floors = building.floors || [];
  const fi = floors.findIndex(f => f.id === floorId);
  if (fi < 0) return { ok: false, errors: ['階が見つかりません'], building };
  const floor = floors[fi];
  const doors = floor.doors || [];
  const di = doors.findIndex(d => d.id === doorId);
  if (di < 0) return { ok: false, errors: ['扉が見つかりません'], building };
  const d0 = doors[di];
  const part = (floor.partitions || []).find(q => q.id === d0.partitionId);
  if (!part) return { ok: false, errors: ['扉が乗る壁が見つかりません'], building };
  const lenM = bcPartitionLenM(part);
  const wallH = part.heightM != null ? part.heightM : floor.heightM;
  const p = patch || {};
  const cand = { ...d0 };
  // 【頭打ち・2026-08-29 ユーザー決定】扉に機器が付いている場合、
  // 縮められるのは「機器が収まる限界」まで。そこで止まる（エラーにはしない）
  const mins = bcDoorIconsMinSize(floor, doorId);
  if (p.widthM != null) cand.widthM = Math.max(mins.minW, Math.min(lenM, p.widthM));
  if (p.heightM != null) cand.heightM = Math.max(mins.minH, Math.min(wallH, p.heightM));
  if (p.uM != null) cand.uM = p.uM;
  if (p.name != null) cand.name = p.name;
  // 【扉の厚み・2026-09-02】'in' 判定で空欄→null（壁連動へ戻す）を握りつぶさない。
  // 数値は極小の潰れ扉を防ぐため下限2cmでクランプ。
  if ('thicknessM' in p) cand.thicknessM = (p.thicknessM == null ? null : Math.max(0.02, p.thicknessM));
  // 【扉の取付面・2026-09-03】表裏の切替（±1）。
  if ('faceSide' in p) cand.faceSide = (p.faceSide < 0 ? -1 : 1);
  // 位置は必ず壁の中へ。幅を変えたときも収め直す（幅だけ広げて端からはみ出すのを防ぐ）
  const half = cand.widthM / 2;
  cand.uM = Math.max(half, Math.min(Math.max(half, lenM - half), cand.uM));
  const nd = doors.slice(); nd[di] = cand;
  const nf = { ...floor, doors: nd };
  const fit = bcDoorsFitLength(nf, part.id, lenM);
  if (!fit.ok) return { ok: false, errors: fit.errors, building };
  const fs = floors.slice(); fs[fi] = nf;
  return { ok: true, errors: [], building: { ...building, floors: fs } };
}

// ── 仕切りの描画用ジオメトリ ──
// 線分＋厚み → 平面4角形（グリッド座標）と z範囲。透明仕切りは kind で呼び出し側が透明度を変える
function bcPartitionGeoms(building, floor) {
  const mpp = _bcMpp();
  const out = [];
  for (const p of (floor.partitions || [])) {
    const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) continue;
    const ux = dx / len, uy = dy / len;  // 壁に沿った向き
    const nx = -dy / len, ny = dx / len; // 法線
    const ht = (p.thicknessM || BC_PARTITION_DEFAULTS.thicknessM) / mpp / 2; // 半厚（グリッド）
    const zB = floor.levelZ + (p.baseM || 0);
    const zT = zB + (p.heightM != null ? p.heightM : floor.heightM);
    // 【壁の開口（窓・ダクト貫通・扉）・2026-10-04】ガワの壁とまったく同じ carveCells で割る。
    //   開口が無ければセルは1枚で、従来と同じポリゴンになる（u=0..壁の長さ）。
    //   描画側は forEach で回すだけなので、ここが増えればそのまま穴が開く。
    //   扉のぶんは記録でなく bcDoorFrame からの**導出**（正を2つ持たない）。
    const bands = bcOpeningBands(p, 'partition', { zBase: floor.levelZ })
      .concat(bcDoorOpeningBands(floor, p));
    const cells = (bands.length && typeof carveCells === 'function')
      ? carveCells(0, len * mpp, zB, zT, bands)
      : [{ a0: 0, a1: len * mpp, b0: zB, b1: zT, edges: [true, true, true, true] }];
    for (const c of cells) {
      const c0 = c.a0 / mpp, c1 = c.a1 / mpp;   // メートル → グリッド
      out.push({
        part: p,
        poly: [
          { x: p.a.x + ux * c0 + nx * ht, y: p.a.y + uy * c0 + ny * ht },
          { x: p.a.x + ux * c1 + nx * ht, y: p.a.y + uy * c1 + ny * ht },
          { x: p.a.x + ux * c1 - nx * ht, y: p.a.y + uy * c1 - ny * ht },
          { x: p.a.x + ux * c0 - nx * ht, y: p.a.y + uy * c0 - ny * ht },
        ],
        zB: c.b0, zT: c.b1,
        // 分割で生まれた内部の辺（線を引かない辺）。開口が無いときは null＝従来のまま
        cell: cells.length > 1 ? { u0: c.a0, u1: c.a1, z0: c.b0, z1: c.b1, edges: c.edges } : null,
      });
    }
  }
  return out;
}

// ── 扉の描画用ジオメトリ（壁の中の色分け矩形。開閉表現はPhase C以降）──
// 幾何そのものは bcDoorFrame が正。ここはそれを4隅のポリゴンに直すだけにする
// （扉の見た目と、扉に貼った機器の位置が、別々の式から出ることを防ぐ）
function bcDoorGeoms(building, floor) {
  const mpp = _bcMpp();
  const out = [];
  const partById = new Map((floor.partitions || []).map(p => [p.id, p]));
  for (const d of (floor.doors || [])) {
    // 扉は壁のみ（透明仕切りには乗らない）。その判定も bcDoorFrame の中にある
    const fm = bcDoorFrame(floor, partById.get(d.partitionId), d);
    if (!fm) continue;
    // 【符号込み外面/内面を加算適用・2026-09-03】nOuter/nInner は既に取付面sの符号を含むので、
    // 従来の ±ht（減算）パターンを流用しない（符号付き内面へ減算を掛けると面が潰れる・監査指摘）。
    const p = fm.part, fr = fm.fr, nO = fm.nOuterGrid, nI = fm.nInnerGrid;
    const c1 = fm.uLeftM / mpp, c2 = fm.uRightM / mpp;
    out.push({
      door: d, part: p,
      poly: [
        { x: p.a.x + fr.ux * c1 + fr.nx * nO, y: p.a.y + fr.uy * c1 + fr.ny * nO },
        { x: p.a.x + fr.ux * c2 + fr.nx * nO, y: p.a.y + fr.uy * c2 + fr.ny * nO },
        { x: p.a.x + fr.ux * c2 + fr.nx * nI, y: p.a.y + fr.uy * c2 + fr.ny * nI },
        { x: p.a.x + fr.ux * c1 + fr.nx * nI, y: p.a.y + fr.uy * c1 + fr.ny * nI },
      ],
      zB: fm.zB, zT: fm.zT,
    });
  }
  return out;
}

// インポート: 文字列 → { ok, buildings, error }
function bcImportBuildings(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    if (!data || data.kind !== 'wanol_buildings' || !Array.isArray(data.buildings)) {
      return { ok: false, error: '建物データのjsonではありません（kind不一致）' };
    }
    if (data.version > BC_SCHEMA_VERSION) {
      return { ok: false, error: 'このデータは新しいバージョン(v' + data.version + ')で作られています' };
    }
    // floors/openings が無い旧データにも空配列を補う（後方互換）
    const buildings = data.buildings.map(b => ({
      ...b,
      blocks: b.blocks || [],
      floors: (b.floors || []).map(f => ({
        ...f,
        openings: f.openings || [],
        icons: f.icons || [], // Phase C で追加。旧データには無いので補う
        outlineCustom: !!f.outlineCustom, // 旧データ補完（カスタム床かどうかの区別）
      }))
    }));
    // 【v2】CSGボディ。v1 のデータには無いので空になる（後方互換）
    const bodies = bcNormalizeBodies(data.bodies);
    return { ok: true, buildings, bodies };
  } catch (e) {
    return { ok: false, error: 'jsonの読み込みに失敗: ' + e.message };
  }
}

// ════════════════════════════════════════════════════════════════
// 統一編集モデル — 床も壁も「同格の仕切り」として1つのリストで扱う
// ════════════════════════════════════════════════════════════════
// 【なぜ必要か】spec 7.10（確定・最上位）
//   「床も一つの仕切りとすることはできないのか？配電盤エディタで平面方向
//     （z軸垂直（水平））の機能はあり、これと同様にすることで高さも自由にスライドできる」
// 配電盤に「階」の概念は無く axis:'x'|'y'|'z' が完全同格。z仕切り＝水平板＝床に相当する。
// 床だけを特別扱いする階層構造は 7.10 に反する。
//
// 【保存構造は変えない】floors[] はそのまま。ここは編集のための投影層。
// spec 11章「保存する座標は常に真北基準のまま変えない」を守る。
//
// 【posM（中心線位置）は持たない】監査で却下された設計。
// スカラー1個で位置を表せるのは軸平行の壁だけで、12.10/12.18 で確定した
// 「軸平行前提を持たない」方針と矛盾する（斜めの壁には中心線位置が定義できない）。
//   - 床(axis:'z') は水平面なので levelZ で一意に決まる
//   - 壁(axis:'h') は端点 a,b をそのまま持ち、スライドは
//     「法線方向のオフセット(offsetM)」として表す。これなら任意角度で成立する
// ════════════════════════════════════════════════════════════════

const BC_EDIT_ID_SEP = ':';

// 編集単位のID。'floor:<floorId>' / 'part:<floorId>:<partId>'
function bcEditPartId(floorId, partId) {
  return partId == null ? ('floor' + BC_EDIT_ID_SEP + floorId)
                        : ('part' + BC_EDIT_ID_SEP + floorId + BC_EDIT_ID_SEP + partId);
}
function bcParseEditPartId(id) {
  const s = String(id || '').split(BC_EDIT_ID_SEP);
  if (s[0] === 'floor' && s.length === 2) return { floorId: s[1], partId: null };
  if (s[0] === 'part' && s.length === 3) return { floorId: s[1], partId: s[2] };
  return null;
}

// 壁の長さ・向き・法線（任意角度で成立する。軸には潰さない）
function bcWallFrame(part) {
  const dx = part.b.x - part.a.x, dy = part.b.y - part.a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    ux: dx / len, uy: dy / len,        // 壁に沿う向き
    nx: -dy / len, ny: dx / len,       // 法線（左手側が正）
    lenGrid: len,
  };
}

// ── 編集単位の一覧（床と壁が同じリストに並ぶ）──
// 並びは「下の階から順に、各階で 床 → 仕切り」
function bcEditableParts(building) {
  const mpp = _bcMpp();
  const out = [];
  bcSortedFloors(building).forEach(floor => {
    // 床（水平板）
    const outlines = bcFloorOutlines(building, floor);
    const pts = outlines.length ? outlines[0] : [];
    out.push({
      id: bcEditPartId(floor.id, null),
      ref: { floorId: floor.id, partId: null },
      kind: 'slab',
      axis: 'z',
      name: bcFloorLabel(building, floor) + 'の床',
      levelZ: floor.levelZ,
      heightM: floor.heightM,             // その階の階高
      thicknessM: floor.slabThicknessM,
      footprint: pts,
      isCustomOutline: !!(floor.outline && floor.outline.length >= 3),
      // 【抜く(void)・2026-10-04】吹き抜け。壁の開口と同じ型なので編集の部品も1つで足りる
      openings: bcNormalizeOpenings(floor.openings),
      color: null,
    });
    // 仕切り（垂直板）
    (floor.partitions || []).forEach(p => {
      const fr = bcWallFrame(p);
      out.push({
        id: bcEditPartId(floor.id, p.id),
        ref: { floorId: floor.id, partId: p.id },
        kind: p.kind === 'clear' ? 'clear' : 'wall',
        axis: 'h',
        name: p.name || '',
        a: { x: p.a.x, y: p.a.y },
        b: { x: p.b.x, y: p.b.y },
        lenM: fr.lenGrid * mpp,
        angleDeg: (Math.atan2(fr.uy, fr.ux) * 180) / Math.PI,
        openings: bcNormalizeOpenings(p.openings),   // 窓・ダクト貫通
        levelZ: floor.levelZ,
        heightM: p.heightM,               // null = 階高いっぱい
        effHeightM: p.heightM != null ? p.heightM : floor.heightM,
        baseM: p.baseM || 0,              // 床からの立ち上がり(m)。0=床に接する
        thicknessM: p.thicknessM,
        doorCount: (floor.doors || []).filter(d => d.partitionId === p.id).length,
        color: p.color || null,
      });
    });
  });
  return out;
}

// ── 編集の唯一の出口 ──
// bcApplyPartEdit(building, editPartId, patch) → { ok, errors, building }
// building は変更しない（新しいオブジェクトを返す）。
//
// 床(axis:'z') の patch: { levelZ?, heightM?, thicknessM?, footprint?, name? }
// 壁(axis:'h') の patch: { a?, b?, offsetM?, heightM?, thicknessM?, kind?, name?, color? }
//   offsetM: 壁を法線方向へ平行移動する距離[m]。任意角度で成立する「スライド」
function bcApplyPartEdit(building, editPartId, patch) {
  const ref = bcParseEditPartId(editPartId);
  if (!ref) return { ok: false, errors: ['編集対象が不正です: ' + editPartId], building };
  const floors = building.floors || [];
  const fi = floors.findIndex(f => f.id === ref.floorId);
  if (fi < 0) return { ok: false, errors: ['階が見つかりません'], building };
  const floor = floors[fi];
  const p = patch || {};
  const mpp = _bcMpp();

  const commit = (newFloor) => {
    const nf = floors.slice(); nf[fi] = newFloor;
    return { ...building, floors: nf };
  };

  if (ref.partId == null) {
    // ── 床（水平板）──
    const cand = { ...floor };
    if (p.levelZ != null) cand.levelZ = p.levelZ;
    if (p.heightM != null) cand.heightM = p.heightM;
    if (p.thicknessM != null) cand.slabThicknessM = p.thicknessM;
    if (p.name != null) cand.name = p.name;
    if (p.footprint !== undefined) {
      cand.outline = (p.footprint && p.footprint.length >= 3)
        ? p.footprint.map(q => ({ x: q.x, y: q.y })) : null;
    }
    // 【抜く(void)・2026-10-04】吹き抜け。壁の開口と同じ型・同じ述語を通す
    if (p.openings !== undefined) cand.openings = bcNormalizeOpenings(p.openings);
    const v = bcValidateFloor(building, cand);
    if (!v.ok) return { ok: false, errors: v.errors, building };
    return { ok: true, errors: [], building: commit(cand) };
  }

  // ── 壁（垂直板）──
  const parts = floor.partitions || [];
  const pi = parts.findIndex(q => q.id === ref.partId);
  if (pi < 0) return { ok: false, errors: ['仕切りが見つかりません'], building };
  const part = parts[pi];
  const cand = { ...part };
  if (p.a) cand.a = { x: p.a.x, y: p.a.y };
  if (p.b) cand.b = { x: p.b.x, y: p.b.y };
  if (p.offsetM != null && p.offsetM !== 0) {
    // 法線方向へ平行移動。壁の向きは変わらないので任意角度で成立する
    const fr = bcWallFrame(cand);
    const d = p.offsetM / mpp; // m → グリッド
    cand.a = { x: cand.a.x + fr.nx * d, y: cand.a.y + fr.ny * d };
    cand.b = { x: cand.b.x + fr.nx * d, y: cand.b.y + fr.ny * d };
  }
  if (p.heightM !== undefined) cand.heightM = p.heightM;
  if (p.baseM != null) cand.baseM = Math.max(0, p.baseM);
  if (p.thicknessM != null) cand.thicknessM = p.thicknessM;
  if (p.kind != null) cand.kind = p.kind === 'clear' ? 'clear' : 'wall';
  if (p.name != null) cand.name = p.name;
  if (p.color !== undefined) cand.color = p.color;
  // 【抜く(void)・2026-10-04】窓・ダクト貫通。床の吹き抜けと同じ型・同じ述語を通す
  if (p.openings !== undefined) cand.openings = bcNormalizeOpenings(p.openings);

  const v = bcValidatePartition(building, floor, cand);
  if (!v.ok) return { ok: false, errors: v.errors, building };
  // 端点が動いたら、その壁に乗っている扉・機器が収まるかを確認する
  const moved = (p.a || p.b || (p.offsetM != null && p.offsetM !== 0));
  const newLenM = bcPartitionLenM(cand);
  if (moved) {
    const fit = bcDoorsFitLength(floor, part.id, newLenM);
    if (!fit.ok) return { ok: false, errors: fit.errors, building };
  }
  // 機器アイコンは長さだけでなく高さにも収まる必要がある（壁を低くすると天井から出る）
  if (moved || p.heightM !== undefined) {
    const wallH = cand.heightM != null ? cand.heightM : floor.heightM;
    const fitI = bcIconsFitPartition(floor, part.id, newLenM, wallH);
    if (!fitI.ok) return { ok: false, errors: fitI.errors, building };
  }
  const np = parts.slice(); np[pi] = cand;
  return { ok: true, errors: [], building: commit({ ...floor, partitions: np }) };
}

