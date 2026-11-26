// ================================================================
// buildingDrawCore.js — 建物エディタ 描画コア（見た目の定数と共通描画）
// ================================================================
// 【責務分離】buildingCore.js は「データ・幾何・部屋認識」のコア。
// 見た目（色・線幅・アルファ）は配電盤の panelDrawCore.js と同じ思想で
// **このファイルだけで管理する**。2D(BuildingEditor)・3D(BuildingPreview3D)の
// 両方がここを参照し、各ファイルに色をハードコードしない（二重管理の禁止）。
//
// 【操作規約の正】spec 12章「建物エディタ操作規約（配電盤エディタ準拠）」。
// 色・寸法はすべて配電盤エディタ(PanelCanvas3D.jsx / panelDrawCore.js)の実測値。
// ================================================================

// ── 画面に出す言葉（ボタン名・手順・理由）・2026-10-18 ──
// 【なぜ1つの表にするか】ボタンの名前と手順の文を各所に手書きしていたため、
//   2026-10-14 に〔⌁ 掃引〕を〔✏ 輪郭を描く〕へ改名したとき**1か所しか直らなかった**。
//   案内文・建物エディタの警告・ドキュメントが旧名のまま残り、利用者に
//   「掃引のボタンは消しただろ」と指摘された（ユーザー報告 2026-10-18）。
//   名前を置換するだけでは同じことが起きるので、**引く先を1つ**にする。
// 【内部の id は変えない】'sweep' / data-bld-sweep-* / blk.sweep は保存データまで同じ語族。
//   表示名だけをここで id から引く形にして、対応を1か所に見えるようにする。
// 【検査】checks/bld_ui_vocab.cjs が「画面に出る文字列の〔…〕引用」をこの表と突き合わせる。
const BC_WORDS = {
  // 作図の入口（ツールバー）。sweep が既定で、押さなくても輪郭が描ける
  入口: { sweep: '✏ 輪郭を描く', rect: '▭ 矩形', poly: '⬠ 多角形', circle: '◯ 円' },
  // ③操作＝動詞4つ。形の名前（ドリル・バネ…）のボタンは作らない（2026-10-06 裁定）
  操作: { twist: '⬆ 引き抜く', revolve: '⟳ 回す', path: '⌁ 沿わせる', helix: '🌀 らせん' },
  // その操作でできた棟の既定名。動詞と揃える（path だけ旧名「掃引」が残っていた）
  できた物: { twist: '引き抜き', revolve: '回転体', path: '沿わせ', helix: 'らせん' },
  // 作図中に出るボタン。〔✓ 作る〕は無い（2026-10-12 裁定・確定した時点で形になる）
  // 【〔✓ 作る〕とは別物】あれは『立体を作る』実行段で 2026-10-12 に廃止。
  //   こちらは『作図の層を閉じる』出口で、押すときには形はもう出来ている。
  ボタン: { 終える: '✓ 終える', 描き直す: '✕ 描き直す', 軸を置き直す: '⟳ 軸を置き直す',
            正回り: '↺ 正回り', 逆回り: '↻ 逆回り' },
  // 手順の文。**輪郭と通りは終わり方が違う**ので別の項目にする
  //   輪郭 … 閉じた形。始点をクリックして閉じる（2026-10-15 裁定。ダブルクリックも通る）
  //   通り … 開いた線。閉じないのでダブルクリックでしか終われない
  手順: {
    輪郭を閉じる: '始点をクリック（かダブルクリック）で面が完成',
    通りを確定:   'ダブルクリックで確定',
  },
  // 図の上で作図・作成できる状態に入るボタン（窓のヘッダ）。
  //   【2026-11-05】案内文が〔🏗 建屋〕を引用したとき、語彙表に無くて検査が落ちた。
  //   窓を開くボタン（⬡ 立体エディタ・🏠 建物エディタ）は窓の台帳 WIN_DEFS の icon+label。
  モード: { 建屋: '🏗 建屋', 建屋ON: '🏗 ON', 矢視: '✂ 矢視追加', 矢視ON: '✂ ON' },
  // 描いた形を何にするか（ツールバー左端のトグル）。
  //   建屋＝階・仕切り・扉が置ける／立体＝足す・くり抜く・面の押し引きができる。
  //   【2026-11-05】立体エディタの案内がここを引用するので表に入れた
  作る先: { 建屋: '建屋', 立体: '立体' },
  // 盤を壁に付ける（建物エディタ）。ボタンの名前と、案内文の中の引用が同じ所を見る
  壁付け: { 付ける: '壁に付ける', 付け替える: '別の壁に付け替える', 外す: '壁から外す' },
  // 使えないときの理由。**述語と同じ言葉で書く**（名前だけ直しても条件が違えば嘘になる）
  //   寸法の打ち直しは canResizeBlock（solidModel.js）＝「決まった形の断面（表 BC_PROFILES）で、
  //   作り直しの対応表 BC_RESIZE_MAKERS に作り手がある」（2026-11-20）。
  //   図に描いた輪郭（kind:'raw'・旧 'custom'）は幅・高さを持たないので、どの操作で作っても打ち直せない。
  //   旧文「〔⌁ 掃引〕〔⟳ 回す〕で作った棟ではないため」は**条件の説明が誤り**だった
  //   （〔✏ 輪郭を描く〕→〔⟳ 回す〕で作った棟にこそ出る）。
  //   【次の一手は2通り・2026-11-20】辺・頂点を直に直せる棟（押し出し）と、直せない棟
  //   （描いた輪郭を回した・沿わせた＝points が断面の点）で案内を分ける。
  //   1つの文で「辺の長さを直して」と出すと、直せない棟では入口の無い案内になる
  理由: {
    寸法を打ち直せない:
      'この棟は決まった形の断面（矩形・円・H形鋼など）で作っていないため、断面の寸法は打ち直せません。'
      + '形を変えるときは下の〔辺の長さ〕か〔頂点〕を直してください。',
    寸法を打ち直せない_描いた輪郭:
      'この棟は図に描いた輪郭を断面にしているため、幅・高さの欄はありません。'
      + '形を変えるときは輪郭を描き直して作り直してください（Ctrl+Z で今の棟は消せます）。',
  },
};
// ── 3次元図の面の見た目（2026-10-18）──
// 【なぜ1か所に置くか】CSG立体にだけ『光の当たり方で陰影を付ける』『継ぎ目に線を引かない』
//   『裏を向いた面を描かない』が入っていて、回したもの・掃引したものには入っていなかった。
//   ユーザー報告：「面を作って回したとききれいな円とならず円に見せかけた面の並びになる」。
//   **種類（CSGかどうか）で分けると、新しい作り方を足すたびに取りこぼす**ので、
//   『曲面を含むか』『不透明か』という**性質**で分ける（advisor 監査）。

// 曲面を含む立体か（小面の継ぎ目に線を引かず、光で陰影を付ける）
//   いまの中身は「CSG か 掃引（回す・沿わせる・らせん）」。
//   【将来】本当は**辺ごとの二面角**で決めるのが正しい（円筒の上縁は本物の稜線なので、
//     立体ひとまとめでは表せない）。そのときもここを書き換えれば全部が追随する。
//   【陽性対照】window.__SMOOTH_SURFACE = false で従来（CSGだけ）に戻る
function bcIsSmoothSolid(solid) {
  if (!solid) return false;
  if (typeof window !== 'undefined' && window.__SMOOTH_SURFACE === false) return !!solid._csg;
  return !!(solid._csg || solid._sweep);
}
// 不透明か（裏を向いた面を描かなくてよい）。
//   建屋の殻は**半透明のまま**：中に置いた盤・機器が見えなくなると使い物にならない。
function bcIsOpaqueSolid(solid) { return !!(solid && solid._csg); }
// 面の明るさ。斜め上からの平行光との内積（立体の種類で式を変えない）
const BC_LIGHT = { x: 0.40, y: -0.28, z: 0.87 };
function bcFaceShade(n) {
  if (!n) return 1;
  const d = Math.max(0, (n.nx || 0) * BC_LIGHT.x + (n.ny || 0) * BC_LIGHT.y
                      + (n.nz || 0) * BC_LIGHT.z);
  return Math.min(1, 0.62 + 0.42 * d);
}

// ── 選択・ホバー ──
// 【重要】配電盤は選択とホバーを**同じ色・同じ表現**で描く。
// ホバーは「選択のプレビュー」という思想で、isSel = (id===selectedId || id===hoveredId)
// と同値扱いにしている。建物エディタもこれに完全準拠する（2026-08-19 ユーザー確定）。
const BC_UI = {
  // 選択/ホバーの基準色（amber-400）。配電盤 PanelCanvas3D.jsx:1983,1986 と同一
  accent: '#FBBF24',
  // 仮・ゴースト（ドラッグ中の複製プレビュー等）。配電盤の #FDE68A
  ghost: '#FDE68A',
  // 選択辺の3層グロー。配電盤 PanelCanvas3D.jsx:3166 と同一
  // ギズモ（配電盤 PanelCanvas3D.jsx:3284-3303）
  gizmo: {
    posR: 4.5,             // ● 位置移動ハンドルの半径
    posFill: '#FBBF24',
    posStroke: 'rgba(255,255,255,0.85)',
    spanSize: 7,           // ◆ 範囲変更ハンドルの一辺
    spanFill: '#7DD3FC',
    shadowAlpha: 0.2,
    hitPx: 12,             // ヒット判定（見た目の約2.7倍の寛容さ）
  },
  // 画面の地色（配電盤と共通 slate-800 系）
  bg: '#1E293B',
  grid: '#334155',
  muted: '#94A3B8',
  // 建物の要素色
  shell: '#6B7A8D',
  shellStroke: '#94A3B8',
  shellAlpha: 0.16,
  floorFill: '#8B9AAB',
  floorStroke: '#4B5563',
  wallFill: '#94A3B8', // 配電盤 pdcPartitionFaceRGB のフォールバックと同一値（独自値にしない）
  wallStroke: '#6B7280',
  clearFill: '#7DD3FC',    // 透明仕切り
  clearStroke: '#38BDF8',
  clearAlpha: 0.25,
  doorFill: '#B45309',
  doorStroke: '#78350F',
  // 階の空間（床を選んだときだけ出す半透明の箱。天井の高さを見せるためのもの）・2026-10-01
  // 選択色と同じ琥珀にして「今これを選んでいる」と分かるようにする
  spaceFill: '#FBBF24',
  spaceStroke: '#FBBF24',
  spaceAlpha: 0.10,
  outlineEdit: '#34D399',  // 床の形を編集中の線
  warn: '#EF4444',
  warnText: '#FCA5A5',
};

// 選択/ホバーは同値。呼び出し側はこの関数だけを使い、各所で条件を書かない
function bcIsHot(id, selectedId, hoveredId) {
  return id != null && (id === selectedId || id === hoveredId);
}

// 選択辺の3層グローを引く（配電盤と同一表現）
// 選択/ホバー時の面の明るさ。配電盤 pdcPartitionFaceRGB の isSel と同じ係数。
// 【重要】配電盤にグロー（ぼんやり光る効果）は存在しない。
// 以前ここに3層グローを実装したが配電盤の実装を確認せずに創作したものであり、
// ユーザー指摘（2026-08-19）で撤去した。正は常に配電盤エディタの実装。
const BC_HOT_BRIGHTNESS = 1.3;

function _bcHexToRGB(hex) {
  const h = (hex || '#94A3B8').replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// 選択/ホバー中の塗り色。配電盤と同じく「元の色を明るくする」だけ
function bcHotFill(color) {
  const [r, g, b] = _bcHexToRGB(color);
  const f = BC_HOT_BRIGHTNESS;
  return `rgb(${Math.min(255, Math.round(r * f))},${Math.min(255, Math.round(g * f))},${Math.min(255, Math.round(b * f))})`;
}

// 太さを持つ線分の4隅。選択枠を「厚みのある矩形」として描くために使う。
// これが無いと lineWidth 固定の枠になり、壁の厚さが見えなくなる（ユーザー指摘）
function bcThickRectCorners(a, b, widthPx) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const hx = (-dy / len) * (widthPx / 2), hy = (dx / len) * (widthPx / 2);
  return [
    { x: a.x + hx, y: a.y + hy }, { x: b.x + hx, y: b.y + hy },
    { x: b.x - hx, y: b.y - hy }, { x: a.x - hx, y: a.y - hy },
  ];
}

// 選択/ホバー中の縁取り。配電盤の #FBBF24 枠と同じ（厚み矩形に沿わせる）
function bcStrokeHotOutline(ctx, a, b, widthPx) {
  const c = bcThickRectCorners(a, b, widthPx);
  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = BC_UI.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  c.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

// ギズモの●（位置移動）と◆（範囲変更）。配電盤と同じ影つき
function bcPaintGizmo(ctx, x, y, type) {
  const g = BC_UI.gizmo;
  ctx.save();
  ctx.globalAlpha = g.shadowAlpha; ctx.fillStyle = '#000';
  if (type === 'pos') { ctx.beginPath(); ctx.arc(x + 0.5, y + 1, g.posR + 1, 0, Math.PI * 2); ctx.fill(); }
  else { ctx.fillRect(x - g.spanSize / 2 + 0.5, y - g.spanSize / 2 + 1, g.spanSize + 1, g.spanSize + 1); }
  ctx.globalAlpha = 1;
  if (type === 'pos') {
    ctx.fillStyle = g.posFill; ctx.strokeStyle = g.posStroke; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, g.posR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    ctx.fillStyle = g.spanFill; ctx.strokeStyle = g.posStroke; ctx.lineWidth = 1;
    ctx.fillRect(x - g.spanSize / 2, y - g.spanSize / 2, g.spanSize, g.spanSize);
    ctx.strokeRect(x - g.spanSize / 2, y - g.spanSize / 2, g.spanSize, g.spanSize);
  }
  ctx.restore();
}

// ── 床の形の作図（頂点を順に打って閉じる）──
// 2Dでも3Dでも同じ見た目・同じ当たり判定にするため、ここに置く。
// 片方に直書きすると「2Dでは閉じられるのに3Dでは閉じられない」といったズレが必ず出る
const BC_OUTLINE_CLOSE_PX = 12;   // 始点の●をクリックしたと見なす距離（画面px）

// 打った頂点の●。始点だけ大きく accent 色にして「ここをクリックで閉じる」と示す
function bcPaintOutlinePts(ctx, screenPts) {
  (screenPts || []).forEach((p, i) => {
    ctx.fillStyle = i === 0 ? BC_UI.accent : BC_UI.outlineEdit;
    ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0F172A'; ctx.lineWidth = 1.2; ctx.stroke();
  });
}

// カーソル規約（配電盤 PanelCanvas3D.jsx:4160-4247 と同一）
const BC_CURSOR = {
  idle: 'grab',
  dragging: 'grabbing',
  gizmo: 'grab',
  duplicate: 'copy',   // Ctrl押下＋posハンドル上
  element: 'pointer',  // 稜線・面の上
  place: 'crosshair',  // 配置・作図モード
};

// キー操作を拾ってよいか（＝文字を打っている最中でないか）。INPUT等は必ず無視する
// （配電盤 PanelCanvas3D.jsx:5140-5153 の必須ガード）
// 【見る要素を渡せる・2026-10-18】既定は activeElement。Enter のように
//   『押した瞬間に欄が消える』キーでは、呼ぶ側が e.target を渡す。
//   React の離散イベントは同期で流れるので、window で受ける頃には activeElement が
//   body に戻っていて、同じ Enter が二重に効いてしまう（e.target は伝播中に変わらない）。
function bcCanHandleDeleteKey(el) {
  const t = el || (typeof document !== 'undefined' ? document.activeElement : null);
  if (!t) return true;
  const tag = (t.tagName || '').toUpperCase();
  return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable);
}
