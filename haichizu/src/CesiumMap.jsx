// ══ 📷フォーカスの寄り方（唯一の実装・2026-08-30）══
// 【直した不具合】以前は BoundingSphere(cart, 0) ＋ range=300m 固定で、
//   **対象の大きさを一切見ていなかった**。幅0.6mの配電盤でも300m引きで止まる
//   （ユーザー報告 2026-08-30）。他のビュー（平面図・断面図・3次元図）は
//   focusGridPos から spanX/Y/Z を受け取って倍率を決めているのに、
//   Cesium にだけ大きさが渡っていなかったのが発生源。
// 【考え方】半径Rの球が画面の短い側の CM_FOCUS_FRACTION を占める距離を求める:
//   d = R / (fraction * sin(fov/2))
//   fov は縦横のうち**小さい方**を使う（窓が横長でも縦長でもはみ出さない）。
// 【半径の単位】必ずメートル。呼び出し側がグリッドpxを持っている場合は
//   METERS_PER_PX を掛けてから渡すこと（取り違えると桁で外れる）。
// 【コンポーネントの外に置く理由】純粋関数なので毎レンダー作り直す必要が無く、
//   node の検査（checks/focus_range.cjs）から直接呼べるようにするため。
const CM_FOCUS_FRACTION = 0.45;   // 対象が画面の短辺に占める割合
const CM_FOCUS_MIN_M = 3;         // 寄りすぎ防止（地面や対象へ突っ込まない）
const CM_FOCUS_MAX_M = 4000;      // 引きすぎ防止
const CM_FOCUS_LEGACY_M = 300;    // 半径が渡らない呼び出しは従来どおり（挙動を変えない）
// frustum は {fov, fovy} を持つオブジェクト（OrthographicFrustum には無い＝種別ガード）
function cmFocusRange(frustum, radiusM) {
  if (!Number.isFinite(radiusM) || radiusM <= 0) return CM_FOCUS_LEGACY_M;
  const cand = [frustum && frustum.fov, frustum && frustum.fovy]
    .filter(a => Number.isFinite(a) && a > 0.01);
  const fov = cand.length ? Math.min(...cand) : Math.PI / 3;   // 取れなければ60°相当
  const s = Math.sin(fov / 2) || 0.5;
  return Math.min(CM_FOCUS_MAX_M, Math.max(CM_FOCUS_MIN_M, radiusM / (CM_FOCUS_FRACTION * s)));
}
// 位置＋半径[m]で寄る唯一の入口。半径を渡さなければ従来の300m固定のまま
function cmFlyToFocus(v, center, radiusM) {
  const r = (Number.isFinite(radiusM) && radiusM > 0) ? radiusM : 0;
  v.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, r),
    { offset: new Cesium.HeadingPitchRange(
        v.camera.heading, v.camera.pitch, cmFocusRange(v.camera && v.camera.frustum, radiusM)),
      duration: 1.0 }
  );
}

// ══ 診断フック __panelDiag()（2026-09-01）══
// Cesium はこちら側でヘッドレス検証ができない（Ionトークンが要る）ので、
// 実機の状態を1行で取れるようにしておく。コンソールで `__panelDiag()` を呼ぶ。
// 【モジュール先頭に置く理由】盤描画エフェクトの中で定義していたら、
//   Cesiumビューア未作成のときエフェクトが早期returnして **__panelDiag 自体が undefined** になり、
//   「診断が動かない」という余計な往復を生んだ。ここなら常に存在し、
//   ビューアが無ければ「無い」と答える。
// 【本番の挙動は変えない】参照を読むだけ。
if (typeof window !== 'undefined') {
  window.__panelDiag = () => {
    const vs = (window.__cesiumViewers || []).filter(vv => vv && !vv.isDestroyed());
    if (!vs.length) return 'Cesiumビューアがまだ作られていない（CesiumJS 3D/2D の「表示する」を押してから再実行）';
    return vs.map((vv, i) => {
      const cv = vv.scene && vv.scene.canvas;
      let 画面中央のpick = null;
      try {
        if (cv) {
          const p = vv.scene.pick(new Cesium.Cartesian2(cv.clientWidth / 2, cv.clientHeight / 2));
          画面中央のpick = (p && p.id)
            ? { 盤: p.id._placedPanelId || null, 扉: !!p.id._panelDoor, 機器: p.id._buildingIconId || null }
            : 'なし';
        }
      } catch (err) { 画面中央のpick = 'pick例外: ' + err.message; }
      // _panelEntities は盤と建物機器で共有しているので種別ごとに数える。
      // 盤1台につき「本体+ラベル」で最低2個、3Dなら扉のぶんも増える。
      const es = vv._panelEntities || [];
      const 内訳 = { 盤本体: 0, 盤ラベル: 0, 扉: 0, 建物機器: 0, その他: 0 };
      let 拾えた盤id = null;
      for (const e2 of es) {
        if (!e2) { 内訳.その他++; continue; }
        if (e2._panelDoor) 内訳.扉++;
        else if (e2._buildingIconId) 内訳.建物機器++;
        else if (e2._placedPanelId) {
          if (e2.label) 内訳.盤ラベル++; else 内訳.盤本体++;
          拾えた盤id = e2._placedPanelId;
        } else 内訳.その他++;
      }
      const ctrl = vv.scene && vv.scene.screenSpaceCameraController;
      return {
        番号: i, モード: vv._diagMode || null,
        配置済み盤: vv._diagPlaced || [],
        エンティティ内訳: 内訳,
        盤エンティティ数: es.length,
        全エンティティ数: vv.entities ? vv.entities.values.length : null,
        画面中央のpick, 拾えた盤id,
        カメラ操作: ctrl ? { 回転: ctrl.enableRotate, 平行移動: ctrl.enableTranslate,
                            ズーム: ctrl.enableZoom, 傾き: ctrl.enableTilt } : null,
      };
    });
  };
}

// ══ 面をダブルクリックしたときの視点（唯一の実装・2026-08-31）══
// 【直した不具合】上面をダブルクリックして真上から覗いたあと、
//   中ボタン（tilt）が効かなくなる（ユーザー報告 2026-08-31）。
// 【真因】上面は法線 nz=1 なので `pitch = -asin(1)` が **厳密に −90°** になる。
//   中ボタンの tilt は tilt中心の ENU フレームで `constrainedAxis = UNIT_Z` を立てて回すが、
//   カメラ位置がその軸と平行（＝真上）だと Cesium の `Camera.rotateVertical` は
//   `(northParallel && angle<0) || (southParallel && angle>0)` のときしか回さず、
//   それ以外は**何もしない**。つまり極の特異点に座り込んで片方向にしか反応しなくなる。
// 【対処】±90°ちょうどを避ける。0.02rad（約1.15°）逃がすだけで特異点から外れ、
//   見た目は真上とほぼ変わらない。`constrainedAxis` を後から消す案は
//   Cesium の通常操作モデルを崩すので採らない（Codex監査）。
// 【なぜ共通関数にしたか】この計算は
//   ①canvas の LEFT_DOUBLE_CLICK ②DOMオーバーレイの onDoubleClick
//   の2箇所にまるごと重複していた。片方だけ直すともう片方が壊れたまま残る。
//   呼び出し側で取り方が違う blk / sel は引数で受け取り、差異をここへ閉じ込める。
// 中ボタンorbit が許す pitch の窓（天地逆転防止）。**orbit と飛び先で同じ値を使う**。
// 【なぜ共有するか】以前は orbit 側が -1.55、飛び先が -(π/2-0.02)=-1.5508 と
//   0.0008rad だけ食い違う別々のマジックナンバーだった。同じ概念は1箇所で持つ。
const CM_PITCH_MIN = -1.55;   // ほぼ真下
const CM_PITCH_MAX = -0.05;   // ほぼ水平（これより上は向かせない）
// 飛び先を厳密な±90°に置かない。真下ちょうどだと orbit の傾き軸
// `cross(地表法線, direction)` が 0 ベクトルに退化する（7248付近のフォールバック条件）。
// なお窓の外へ着地しても、上の「悪化したら取り消す」判定で自力復帰できる。
const CM_FACE_MAX_PITCH = Math.PI / 2 - 0.02;   // ±90°ちょうどに座らせない
function cmFaceFlyTarget(blk, sel, baseElev) {
  if (!blk || !sel) return null;
  let nx = 0, ny = 0, nz = 0, cx, cy, cz;
  if (sel._solidNormal && sel._faceCenterX != null) {
    const sn = sel._solidNormal;
    const len = Math.sqrt(sn.nx ** 2 + sn.ny ** 2 + sn.nz ** 2) || 1;
    nx = sn.nx / len; ny = sn.ny / len; nz = sn.nz / len;
    cx = sel._faceCenterX; cy = sel._faceCenterY; cz = sel._faceCenterZ;
  } else if (sel.face === 'zTop' || sel.face === 'zBottom') {
    const top = sel.face === 'zTop';
    nx = 0; ny = 0; nz = top ? 1 : -1;
    const pts = blk.points;
    cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    cz = top ? (blk.zTop || 40) : (blk.zBottom || 0);
  } else if (typeof sel.face === 'number') {
    // 側面: エッジから外向き法線を計算（nz=0 なので pitch は0のまま＝クランプの影響なし）
    const pts = blk.points, n = pts.length;
    const fi = sel.face;
    const p0 = pts[fi], p1 = pts[(fi + 1) % n];
    const ex = p1.x - p0.x, ey = p1.y - p0.y, elen = Math.sqrt(ex ** 2 + ey ** 2) || 1;
    let gnx = ey / elen, gny = -ex / elen;
    const cx0 = pts.reduce((s, p) => s + p.x, 0) / n, cy0 = pts.reduce((s, p) => s + p.y, 0) / n;
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - cx0) * gnx + (my - cy0) * gny < 0) { gnx = -gnx; gny = -gny; }
    nx = gnx; ny = gny; nz = 0;
    cx = mx; cy = my; cz = ((blk.zTop || 40) + (blk.zBottom || 0)) / 2;
  } else { return null; }

  const bldSize = Math.max(
    (blk.pxMaxX || 0) - (blk.pxMinX || 0), (blk.pxMaxY || 0) - (blk.pxMinY || 0),
    ((blk.zTop || 40) - (blk.zBottom || 0)) / METERS_PER_PX,
  );
  const dist = Math.max(80, bldSize * 1.8);
  const camGX = cx + nx * dist, camGY = cy + ny * dist;
  const camGZm = (baseElev || 0) + (cz + nz * dist) * METERS_PER_PX;
  const geo = gridToGeo(camGX, camGY);
  // heading: カメラが法線の逆向きを向く。グリッドX=東 / グリッドY=南 なので north=-ny
  const heading = Math.atan2(-nx, ny);
  const pitchRaw = -Math.asin(Math.max(-1, Math.min(1, nz)));
  const pitch = Math.max(-CM_FACE_MAX_PITCH, Math.min(CM_FACE_MAX_PITCH, pitchRaw));
  return { lng: geo.lng, lat: geo.lat, altM: camGZm, heading, pitch };
}
function cmFlyToFace(v, blk, sel, baseElev) {
  const t = cmFaceFlyTarget(blk, sel, baseElev);
  if (!t) return;
  v.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(t.lng, t.lat, t.altM),
    orientation: { heading: t.heading, pitch: t.pitch, roll: 0 },
    duration: 1.0,
  });
}

// ════════════════════════════════════════════════════════════════
// 描画ループはアプリが1か所で持つ ・2026-10-16（ユーザー報告／advisor監査）
// ════════════════════════════════════════════════════════════════
// 【ユーザー報告】CesiumJS 2D の窓に Cesium 標準の赤いパネル
//   「An error occurred while rendering. Rendering has stopped.」＋「[object Object]」が出た。
// 【なぜ既定のループだと困るか】Cesium は描画の例外を**2つの出口**に分ける：
//   (a) scene.render の中 → renderError を発火して飲み込む（1727 の購読はこれを見ていた）
//   (b) ループ側（preRender/postRender の購読者・resize・clock.tick）→ renderError は**発火しない**
//   ＝既定のままだと (b) は控えようがなく、どちらも赤いパネルが出て描画が止まる。
//   裁定 2026-09-23「配置図は Cesium が使えなくても機能を失わない構成にする」に反する。
//   ループを自前にすれば (a)(b) が**同じ受け口**に入り、控え・知らせ・間の空け方が1か所になる。
// 【[object Object] にしない】name も message も無い値が投げられることがある。そのまま
//   文字にすると発生源が消えるので、型・鍵・stack を分けて控える（window.__cesiumLastError）。
// 陽性対照: window.__CESIUM_OWN_LOOP = false で Cesium 既定のループ（赤いパネル）に戻す。
function _cesiumOwnLoopOn() {
  return !(typeof window !== 'undefined' && window.__CESIUM_OWN_LOOP === false);
}
function _cesiumNoteError(e, 出口, mode) {
  const 情報 = {
    とき: new Date().toISOString(), 窓: mode || '?', 出口: 出口,
    名: (e && e.name) || null,
    文: (e && e.message) ? String(e.message).slice(0, 300) : null,
    型: Object.prototype.toString.call(e),
    鍵: (e && typeof e === 'object') ? Object.keys(e).slice(0, 12) : null,
    文字列: (() => { try { return String(e).slice(0, 300); } catch (_) { return null; } })(),
    積: (e && e.stack) ? String(e.stack).split('\n').slice(0, 8).join('\n') : null,
  };
  if (typeof window !== 'undefined') {
    window.__cesiumLastError = 情報;
    const a = (window.__cesiumErrors = window.__cesiumErrors || []);
    a.push(情報); if (a.length > 20) a.shift();
  }
  console.warn('[Cesium] 描画の例外（' + 出口 + '・' + (mode || '?') + '）', 情報, e);
  return 情報;
}
// 控えた例外の「一目で分かる見出し」。名前も文も無い値のときは持っている鍵を見せる
//   （[object Object] とだけ出すと、利用者が伝えても発生源が絞れない）
function _cesiumErrLabel(情報) {
  if (!情報) return '不明';
  if (情報.名) return 情報.名 + (情報.文 ? '：' + 情報.文.slice(0, 90) : '');
  if (情報.文) return 情報.文.slice(0, 90);
  if (情報.鍵 && 情報.鍵.length) return '名前の無い値（' + 情報.鍵.slice(0, 4).join(',') + '）';
  const t = (情報.文字列 || 情報.型 || '');
  return (t && t !== '[object Object]') ? t.slice(0, 90) : '名前も中身も無い値';
}
// 窓の隅の小さな知らせ（Cesium の赤いパネルの代わり。作業は止めない）
function _cesiumShowNote(el, 文) {
  if (!el || typeof document === 'undefined') return;
  // 置き場が static だと absolute の基準が祖先に飛ぶ。ここで土台にしておく
  try { if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; }
  catch (_) {}
  let n = el.querySelector('[data-cesium-note]');
  if (!n) {
    n = document.createElement('div');
    n.setAttribute('data-cesium-note', '1');
    n.style.cssText = 'position:absolute;left:6px;bottom:6px;z-index:40;'
      + 'max-width:calc(100% - 12px);background:rgba(15,23,42,0.88);color:#FCA5A5;'
      + 'border:1px solid #DC2626;border-radius:4px;padding:3px 7px;font-size:10px;'
      + 'font-weight:700;pointer-events:none;white-space:pre-wrap';
    el.appendChild(n);
  }
  n.textContent = 文; n.style.display = '';
}
function _cesiumHideNote(el) {
  const n = el && el.querySelector && el.querySelector('[data-cesium-note]');
  if (n) n.style.display = 'none';
}
// 自前ループを始める。戻り値 true＝自前で回している
function _cesiumStartOwnLoop(viewer, el, mode) {
  if (!viewer || viewer.isDestroyed() || !_cesiumOwnLoopOn()) return false;
  viewer.useDefaultRenderLoop = false;
  // (a) の例外も外へ出す。出さないと renderError だけ発火して受け口（catch）に来ない
  try { viewer.scene.rethrowRenderErrors = true; } catch (_) {}
  viewer._ownLoop = true; viewer._ownLoopPaused = false;
  let 連続 = 0, 休み = 0;
  const tick = () => {
    if (!viewer || viewer.isDestroyed()) return;
    viewer._ownLoopRaf = requestAnimationFrame(tick);
    if (viewer._ownLoopPaused) return;
    if (休み > 0) { 休み--; return; }
    try {
      viewer.resize(); viewer.render();
      if (連続) { 連続 = 0; _cesiumHideNote(el); }
    } catch (e) {
      const 情報 = _cesiumNoteError(e, '描画', mode);
      連続++;
      // 【続けて落ちるなら間を空ける】毎フレーム投げ続けると操作まで重くなる。
      //   ただし長すぎると「地図が戻らない」に見えるので最大3秒（直ればすぐ元の速さに戻る）
      休み = Math.min(180, 20 * 連続);
      viewer._ownLoopErrCount = 連続;
      // 【2回目から知らせる】1回きりは初期化時の一時エラー（0×0キャンバス）で起きるので黙る。
      //   続くようなら黙っていても「地図が固まった」としか見えない
      if (連続 >= 2) _cesiumShowNote(el,
        '地図の描画でエラーが出ています（' + 連続 + '回）。作図は続けられます\n'
        + _cesiumErrLabel(情報));
    }
  };
  viewer._ownLoopRaf = requestAnimationFrame(tick);
  return true;
}
function _cesiumStopOwnLoop(viewer) {
  if (!viewer || !viewer._ownLoop) return;
  try { cancelAnimationFrame(viewer._ownLoopRaf); } catch (_) {}
  viewer._ownLoop = false;
}

// ===== CesiumMapコンポーネント =====
function CesiumMap({ winW, winH, mode, allMapPos, nodes, segs, segWp, wpZ, mapZ, onDropNode, onAddWp, onMoveWp, onDropWp, onRemoveWp, onMoveNode, onStartDragNode, onEndDragNode, hoverId, hoverSeg, setHoverId, setHoverSeg, setWireTip, routeFilter, routeSegs, setRouteFilter, focusNodeRef, focusPosRef, onFocusNode, dragUpdateRef, dragStateRef, cesiumRenderRef, cesiumQueryRef, movedNodeRef, blds, solids, setSolids, setSolidsDirect, hSections = [], onAddBuilding, onResizeBuilding, onMoveBldFace, onDeleteBuilding, onRotateBuilding, onMoveBuilding, onAddBlock, onSetBlockPoints, onDeleteBlock, onRevertExtrude, onMergeBlockIntoParent, onRenameBuilding = null, sharedBaseElev, onBaseElevChange, onBldUndo, onBldRedo, onBldPushUndo, onRemoveNodePos, setCurrentSSE = () => {}, plantNorthAngle = 0, setPlantNorthAngle, qualitySettings = null, sectionOverlays = [], onFocusBld = null, onDeleteBld = null, buildingsFull = [], floorFollow = true, onToggleFloorFollow = null, onAddFloor = null, onUpdateFloor = null, onDeleteFloor = null, onExportBuildings = null, onImportBuildings = null, onAddPartition = null, onUpdatePartition = null, onDeletePartition = null, onAddDoor = null, onDeleteDoor = null, onOpenBuildingEditor = null, winState = null,
  // ── 配置済み配電盤 ──
  // 盤のスキーマ（wx,wyが角／rotが絶対角／wzがグリッドpx）を知るのは panelPlacementCore.js だけ。
  // ここでは ppc* ヘルパー越しにしか触らない。ドロップ判定も App 側の関数を受け取って使う
  //（PANEL_DND_MIME や JSON 判定をこちらにコピーすると、受け口ごとに条件が食い違う）。
  placedPanels = [], selectedPlacedPanelId = null, onSelectPlacedPanel = null,
  readDroppedPanelTemplate = null, onDropPanelTemplate = null,
  selectedDoorKey = null, onDoorClick = null,
  // ドラッグで動かす。渡すのは世界座標(グリッドpx)と絶対角だけで、
  // placedPanels の書き換えは App 側が行う（スキーマをここに持ち込まない）
  onMovePlacedPanel = null, onRotatePlacedPanel = null }) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  // ===== 階（建物内部 Phase A）用のUI状態 =====
  const [floorAddZ, setFloorAddZ] = useState(0);      // 追加する階の床標高(m)
  const [floorAddH, setFloorAddH] = useState(3);      // 追加する階の階高(m)
  const [floorMsg, setFloorMsg] = useState(null);     // 階操作の検証エラー表示
  const [floorPanelOpen, setFloorPanelOpen] = useState(false); // 階パネルの開閉
  const bldImportInputRef = useRef(null);             // 建物json読込用の隠しinput
  // ===== 仕切り（建物内部 Phase B）用のUI状態 =====
  const [wallAddMode, setWallAddMode] = useState(null); // {buildingId, floorId, kind:'wall'|'clear', pts:[{x,y}]}
  const wallAddModeRef = useRef(null);
  useEffect(() => { wallAddModeRef.current = wallAddMode; }, [wallAddMode]);
  const qualitySettingsRef = useRef(null);
  const bldsLatestRef = useRef(blds);
  const solidsLatestRef = useRef(solids);
  const modeRef = useRef(mode);
  useEffect(() => { bldsLatestRef.current = blds; }, [blds]);
  useEffect(() => { solidsLatestRef.current = solids; }, [solids]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  // cesiumRenderRef: ドラッグ中のCesium rAFループ停止 + mouseUp後に再開
  useEffect(() => {
    if (!cesiumRenderRef) return;
    // 【止める／動かすの書き手は1つ・2026-10-16】自前ループのときは旗で止める。
    //   useDefaultRenderLoop を直に書くと、自前ループと二重に効いて戻せなくなる
    cesiumRenderRef.current = {
      pause:  () => { const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        if (v._ownLoop) v._ownLoopPaused = true; else v.useDefaultRenderLoop = false; },
      resume: () => { const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        if (v._ownLoop) v._ownLoopPaused = false; else v.useDefaultRenderLoop = true;
        v.scene.requestRender(); },
    };
  }, [cesiumRenderRef]);

  // dragUpdateRef: ドラッグ中のアイコン+wire直接更新（requestRenderは呼ばない）
  useEffect(() => {
    if (!dragUpdateRef) return;
    dragUpdateRef.current = (nodeId, gx, gy, gz, wireUpdates) => {
      const v = viewerRef.current; if (!v || v.isDestroyed()) return;
      const baseElev = v._siteBaseElevation || 0;
      const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
      // アイコン entity 更新
      const ent = nodeEntitiesRef.current[nodeId];
      if (ent) {
        const geo = gridToGeo(gx, gy);
        ent.position = new Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, baseElev + (gz || 0));
      }
      // 接続 wire entity 更新（wireUpdatesは{segId, path}の配列）
      if (wireUpdates && wireEntityMapRef.current.size > 0) {
        wireUpdates.forEach(({ segId, path }) => {
          const rec = wireEntityMapRef.current.get(segId); if (!rec) return;
          const degrees = [];
          path.forEach(p => {
            const g = gridToGeo(p.x, p.y);
            degrees.push(g.lng, g.lat, baseElev + (p.z || 0) * mpp);
          });
          const positions = Cesium.Cartesian3.fromDegreesArrayHeights(degrees);
          if (rec.eOut?.polyline) rec.eOut.polyline.positions = positions;
          if (rec.e?.polyline)    rec.e.polyline.positions    = positions;
        });
      }
      // postRenderのguardがtrueの間は描画コストゼロでアイコン/wire位置だけ更新
      v.scene.requestRender();
    };
  }, [dragUpdateRef]);

  // cesiumQueryRef: ドラッグオーバーレイ用クエリ
  useEffect(() => {
    if (!cesiumQueryRef) return;
    cesiumQueryRef.current = {
      // アイコンのスクリーン座標（canvas CSS px, 0,0=canvas左上）
      getIconScreenPos: (nodeId) => {
        // billboard entity 不使用 → postRenderが毎フレーム更新する _lastIconScreenRef を参照
        const ic = _lastIconScreenRef.current.get(nodeId);
        return ic ? { x: ic.x, y: ic.y } : null;
      },
      // 任意ワールド座標のスクリーン座標（drag 軸スケール計算用）
      getScreenPosForWorld: (wx, wy, wz) => {
        const v = viewerRef.current; if (!v || v.isDestroyed()) return null;
        const geo = gridToGeo(wx, wy);
        const baseElev = v._siteBaseElevation || 0;
        const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
        const pos = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, baseElev + (wz || 0) * mpp);
        return Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, pos);
      },
      // グリッド座標→地形標高換算Z（mapZ未設定アイコンのwireZ推定用）null=取得不能
      getGroundLocalZForWorld: (wx, wy) => {
        const v = viewerRef.current; if (!v || v.isDestroyed()) return null;
        const geo = gridToGeo(wx, wy);
        const carto = Cesium.Cartographic.fromDegrees(geo.lng, geo.lat);
        const h = v.scene.globe?.getHeight(carto);
        if (h == null || h < -500) return null;
        const baseElev = v._siteBaseElevation || 0;
        const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
        return (h - baseElev) / mpp;
      },
      // drag開始時: 接続wireのcanvas-spaceパスを返す（SVG overlay初期化に使用）
      getWirePathsForDrag: (connSegIds) => {
        const ids = new Set(connSegIds || []);
        return (_lastWirePathsRef.current || []).filter(w => ids.has(w.id));
      },
      // drag開始前: _lastWirePathsRef が空なら同期計算で初期化（初回ドラッグ時の背景wire消失防止）
      ensureWireCache: () => {
        if (_lastWirePathsRef.current.length > 0) return;
        const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        const baseElev = v._siteBaseElevation || 0;
        const prj2 = (c) => { const s = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, c); return s ? { x: s.x, y: s.y } : null; };
        const _segs = cbRef.current._segs || [];
        const _amap = cbRef.current._allMapPos || {};
        const _swp = cbRef.current._segWp || {};
        const _swpz = cbRef.current._wpZ || {};
        const _paths = [];
        _segs.forEach(seg => {
          const a = _amap[seg.from], b = _amap[seg.to]; if (!a || !b) return;
          const wps = (_swp[seg.id] || []).map((w, i) => ({ ...w, z: (_swpz[seg.id] || [])[i] || 0 }));
          const rawPts = [a, ...wps, b];
          const sprj2 = rawPts.map(p => {
            const g = gridToGeo(p.x, p.y);
            return prj2(Cesium.Cartesian3.fromDegrees(g.lng, g.lat, baseElev + (p.z || 0)));
          });
          const segs2 = [];
          for (let i = 0; i < sprj2.length - 1; i++) {
            const s1 = sprj2[i], s2 = sprj2[i + 1]; if (!s1 || !s2) continue;
            segs2.push({ x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, under: false, ss: 1.0 });
          }
          if (segs2.length > 0) _paths.push({ id: seg.id, isBus: seg.isBus || false, segs: segs2, strokeScale: 1.0 });
        });
        _lastWirePathsRef.current = _paths;
      },
      // drag開始時にwireCanvasをクリア（旧アイコン・旧wireの凍結を防ぐ）
      clearWireCanvas: () => {
        if (window._cesiumDebug) console.log(`[${mode}:clearWireCanvas] t=${performance.now().toFixed(1)}`);
        const cvs = wireCanvasRef.current; if (!cvs) return;
        const ctx = cvs.getContext('2d');
        ctx.clearRect(0, 0, cvs.width, cvs.height);
        // クリア後にpostRenderで即再描画（_canvasDirtyRef=falseのままだとスキップされ空白が残る）
        _canvasDirtyRef.current = true;
        viewerRef.current?.scene.requestRender();
      },
      // drag中: billboard entity 不使用 → requestRenderのみ（canvasはdragUpdateRefが管理）
      hideNodeEntity: (_nodeId) => {
        viewerRef.current?.scene.requestRender();
      },
      showNodeEntity: (_nodeId, _pos) => {
        viewerRef.current?.scene.requestRender();
      },
      // wireCanvas に drag中 wire+icon を直接描画（毎フレーム world座標→スクリーン投影）
      // world→Cesiumスクリーン変換はworldToWindowCoordinatesで正確に計算（透視投影・遠方縮小を含む）
      drawDragFrame: (nodeId, newWx, newWy, newWz, otherEnds) => {
        // newWx/Wy/Wz: drag中アイコンの新ワールド座標
        // otherEnds: [{wx,wy,wz,isBus}] 接続先（S2等）のワールド座標
        const cvs = wireCanvasRef.current; if (!cvs) return;
        const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        const cw = v.scene.canvas.clientWidth, ch = v.scene.canvas.clientHeight;
        if (cvs.width !== cw || cvs.height !== ch) { cvs.width = cw; cvs.height = ch; }
        const ctx = cvs.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        // ドラッグ中はpostRenderがスキップされるため、前フレームの全wireを補完描画
        // 接続wire(otherEndsのsegId)は後で新位置で描くため除外してゴースト防止
        const _dragSegIds = new Set((otherEnds || []).map(e => e.segId).filter(Boolean));
        const _bgPaths = (_lastWirePathsRef.current || []).filter(w => !_dragSegIds.has(w.id));
        if (_bgPaths.length > 0) {
          const _ugHL = cbRef.current._ugWireMode;
          // Pass 1a: アウトライン（通常postRenderと同じ bW+2、ugHL時は白ハロ追加）
          _bgPaths.forEach(w => {
            const _ssFallback = w.strokeScale ?? 1.0;
            const _hs = cbRef.current._hoverSeg, _hi = cbRef.current._hoverId;
            const isHL_w = _hs === w.id || (_hi && (cbRef.current._segs || []).some(s2 => s2.id === w.id && (s2.from === _hi || s2.to === _hi)));
            const outlineColor = isHL_w ? '#3B82F6' : '#E8ECF0';
            w.segs.forEach(s => {
              const _ss = s.ss !== undefined ? s.ss : _ssFallback;
              const _bW = Math.min(2.0, Math.max(0.5, (w.isBus ? 5 : 3) * _ss));
              ctx.globalAlpha = s.under ? 0.35 : 1.0;
              if (_ugHL && s.under) {
                ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
                ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = _bW + 8; ctx.lineCap = 'round'; ctx.stroke();
              }
              ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
              ctx.strokeStyle = outlineColor; ctx.lineWidth = _bW + 2; ctx.lineCap = 'round'; ctx.stroke();
            });
          });
          // Pass 1b: destination-out で芯部分を透明化（アウトライン枠だけ残す）
          try {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = 1.0;
            _bgPaths.forEach(w => {
              const _ssFallback = w.strokeScale ?? 1.0;
              w.segs.forEach(s => {
                const _ss = s.ss !== undefined ? s.ss : _ssFallback;
                const _bW = Math.min(2.0, Math.max(0.5, (w.isBus ? 5 : 3) * _ss));
                ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
                ctx.strokeStyle = '#000000'; ctx.lineWidth = _bW; ctx.lineCap = 'round'; ctx.stroke();
              });
            });
          } finally { ctx.globalCompositeOperation = 'source-over'; }
          // Pass 2: 黒コア
          _bgPaths.forEach(w => {
            const _ssFallback = w.strokeScale ?? 1.0;
            w.segs.forEach(s => {
              const _ss = s.ss !== undefined ? s.ss : _ssFallback;
              const _bW = Math.min(2.0, Math.max(0.5, (w.isBus ? 5 : 3) * _ss));
              ctx.globalAlpha = s.under ? 0.35 : 1.0;
              ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
              ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = _bW; ctx.lineCap = 'round'; ctx.stroke();
            });
          });
          ctx.globalAlpha = 1.0;
        }
        // ワールド座標→Cesiumスクリーン座標変換ヘルパー
        // wz単位はpostRenderの_iconCart3CacheRef/_wireC3CacheRefと同じ（baseElev+wzをmなし換算）
        const baseElev = v._siteBaseElevation || 0;
        const w2s = (wx, wy, wz) => {
          const geo = gridToGeo(wx, wy);
          const cP = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, baseElev + (wz||0));
          return Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, cP);
        };
        // drag中アイコンのスクリーン座標（毎フレーム正確に計算）
        const iconSP = w2s(newWx, newWy, newWz); if (!iconSP) return;
        // wire: ホバー時と同じスタイル（青アウトライン + ダークコア）、waypoints経由 / セグメントごと遠近感
        const _camWC = v.camera.positionWC;
        const _fov = v.camera.frustum?.fovy ?? v.camera.frustum?.fov ?? Cesium.Math.toRadians(60);
        const _chD = v.scene.canvas.clientHeight || 1;
        const _segSS = (wx1, wy1, wz1, wx2, wy2, wz2, isBus) => {
          const _mg = gridToGeo((wx1+wx2)/2, (wy1+wy2)/2);
          const _md = Cesium.Cartesian3.distance(_camWC,
            Cesium.Cartesian3.fromDegrees(_mg.lng, _mg.lat, baseElev + ((wz1+wz2)/2)));
          const _mpp = 2 * _md * Math.tan(_fov / 2) / _chD;
          const _ss = 1.0 / Math.max(0.001, _mpp);
          return Math.min(2.0, Math.max(0.5, (isBus ? 5 : 3) * _ss));
        };
        (otherEnds || []).forEach(({ wx, wy, wz, isBus, wps, isFrom }) => {
          const otherSP = w2s(wx, wy, wz); if (!otherSP) return;
          // waypoints を含めたスクリーン座標パスを構築（ワールド座標も保持）
          const wpSPs = (wps || []).map(p => ({ sp: w2s(p.x, p.y, p.z||0), wx: p.x, wy: p.y, wz: p.z||0 })).filter(d => d.sp);
          // [{ sp, wx, wy, wz }] の列
          const allPts3d = isFrom
            ? [{ sp: iconSP, wx: newWx, wy: newWy, wz: newWz||0 }, ...wpSPs, { sp: otherSP, wx, wy, wz: wz||0 }]
            : [{ sp: otherSP, wx, wy, wz: wz||0 }, ...wpSPs, { sp: iconSP, wx: newWx, wy: newWy, wz: newWz||0 }];
          if (allPts3d.length < 2) return;
          // セグメントごとに遠近感スケールで描画
          for (let _si = 0; _si < allPts3d.length - 1; _si++) {
            const _a = allPts3d[_si], _b = allPts3d[_si + 1];
            const _bW = _segSS(_a.wx, _a.wy, _a.wz, _b.wx, _b.wy, _b.wz, isBus);
            ctx.beginPath(); ctx.moveTo(_a.sp.x, _a.sp.y); ctx.lineTo(_b.sp.x, _b.sp.y);
            ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = _bW + 6;
            ctx.lineCap = 'round'; ctx.stroke();
            ctx.beginPath(); ctx.moveTo(_a.sp.x, _a.sp.y); ctx.lineTo(_b.sp.x, _b.sp.y);
            ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = _bW;
            ctx.lineCap = 'round'; ctx.stroke();
          }
        });
        // icon: wireの後に描いて前面に来るようにする
        const node = (cbRef.current._nodes || []).find(n => n.id === nodeId);
        if (!node) return;
        const iconUrl = makeSymbolIcon(node.shape, node.color, node.label);
        const ic = _iconImgCacheRef.current;
        let img = ic[iconUrl];
        if (!img) { img = new Image(); img.src = iconUrl; ic[iconUrl] = img; }
        if (!img.complete || !img.naturalWidth) return;
        // カメラ距離からアイコンサイズを計算（billboard scaleByDistance NearFarScalar(50,1.0,5000,0.15)と一致）
        const geo = gridToGeo(newWx, newWy);
        const cP = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, baseElev + (newWz||0));
        const r = Math.max(1, Cesium.Cartesian3.distance(v.camera.positionWC, cP));
        const _scT = Math.max(0, Math.min(1, (r - 50) / (5000 - 50)));
        const bW2 = Math.max(1, Math.round(30 * (1.0 + (0.15 - 1.0) * _scT)));
        if (bW2 < 1) return;
        const lH = node.label ? 14 : 0;
        const iW = Math.round(bW2), iH = Math.round(iW * (38 + lH) / 38);
        ctx.globalAlpha = 1.0;
        ctx.drawImage(img, Math.round(iconSP.x - iW/2), Math.round(iconSP.y - iH), iW, iH);
        // ドラッグ中はpostRenderがスキップされるため、他の全アイコンをここで補完描画
        // postRenderが最後に計算したスクリーン座標を直接使う（Z値計算の不整合を完全回避）
        const _allDragNodes = cbRef.current._nodes || [];
        _allDragNodes.forEach(n => {
          if (n.id === nodeId || n.kind !== 'symbol') return;
          const _ic = _lastIconScreenRef.current.get(n.id); if (!_ic) return;
          const _url2 = makeSymbolIcon(n.shape, n.color, n.label);
          const _icCache = _iconImgCacheRef.current;
          let _img2 = _icCache[_url2];
          if (!_img2) { _img2 = new Image(); _img2.src = _url2; _icCache[_url2] = _img2; }
          if (!_img2.complete || !_img2.naturalWidth) return;
          ctx.globalAlpha = 1.0;
          ctx.drawImage(_img2, Math.round(_ic.x - _ic.w / 2), Math.round(_ic.y - _ic.h), _ic.w, _ic.h);
        });
      },
      // drag中: wire entityを非表示（CSS SVG overlayが代わりに表示）
      hideWires: (segIds) => {
        const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        (segIds || []).forEach(sid => {
          const rec = wireEntityMapRef.current.get(sid); if (!rec) return;
          if (rec.e)    rec.e.show = false;
          if (rec.eOut) rec.eOut.show = false;
        });
        v.scene.requestRender();
      },
      // drag終了: wire entity を復元
      showWires: (segIds) => {
        const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        (segIds || []).forEach(sid => {
          const rec = wireEntityMapRef.current.get(sid); if (!rec) return;
          if (rec.e)    rec.e.show = true;
          if (rec.eOut) rec.eOut.show = true;
        });
        v.scene.requestRender();
      },
      // Cesiumコンテナ要素
      getContainer: () => containerRef.current,
      // drag終了時にcbRef._allMapPosを直接更新（postRenderより先に最終位置を確定する）
      updateMapPosForNode: (nodeId, pos) => {
        if (window._cesiumDebug) console.log(`[${mode}:updateMapPosForNode] nodeId=${nodeId} pos=${JSON.stringify(pos)} t=${performance.now().toFixed(1)}`);
        if (!cbRef.current._allMapPos) return;
        cbRef.current = { ...cbRef.current, _allMapPos: { ...cbRef.current._allMapPos, [nodeId]: pos } };
      },
      // drag終了直後、cbRef._allMapPos再更新までwire描画をブロックする（他の図からのドラッグ時の旧位置フラッシュ防止）
      blockWireDraw: () => {
        cbRef.current._readyToDrawWire = false;
      },
      // 平面図/断面図/側面図/矢視図ドラッグ中: wire polyline + wp entity + SVG rect を直接更新（React cycle待ちなし）
      updateWpDirect: (segId, path) => {
        const v = viewerRef.current; if (!v || v.isDestroyed()) return;
        const baseElev = v._siteBaseElevation || 0;
        // wire polyline 位置更新
        const rec = wireEntityMapRef.current.get(segId);
        if (rec) {
          const degrees = [];
          path.forEach(p => { const g = gridToGeo(p.x, p.y); degrees.push(g.lng, g.lat, baseElev + (p.z || 0)); });
          const positions = Cesium.Cartesian3.fromDegreesArrayHeights(degrees);
          if (rec.eOut?.polyline) rec.eOut.polyline.positions = positions;
          if (rec.e?.polyline) rec.e.polyline.positions = positions;
        }
        // wp marker entity位置更新（SVG rect位置はpostRenderが担当）
        path.slice(1, -1).forEach((wp, i) => {
          const key = `${segId}-${i}`;
          const ent = wpMarkerMapRef.current.get(key);
          if (ent) {
            const geo = gridToGeo(wp.x, wp.y);
            ent.position.setValue(Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, baseElev + (wp.z || 0)));
          }
        });
        // SVGゴーストrect除去: hoverSegを消してSVG rects(zIndex:8)を非表示にする
        cbRef.current.setHoverSeg?.(null);
        // 折れ点四角canvas描画用にパスを保存
        _wpDragCanvasRef.current = { segId, path };
        v.scene.requestRender();
      },
      // 平面図等wpドラッグ終了時: canvas overlay解除 + SVG即時更新
      clearWpDirect: () => {
        _wpDragCanvasRef.current = null;
        _svgLastUpdateRef.current = 0; // 次のpostRenderでSVGを即時更新
        const v = viewerRef.current;
        if (v && !v.isDestroyed()) v.scene.requestRender();
      },
    };
  }, [cesiumQueryRef]);

  // baseElev同期: sampleHeightMostDetailedが解決した際にnodeEntitiesを再配置するためのstate
  const [localBaseElev, setLocalBaseElev] = useState(0);

  // PN入力欄の文字列バッファ（外部から変更された場合も同期）
  const [pnInput, setPnInput] = useState(String(plantNorthAngle || 0));
  const plantNorthAngleRef = useRef(plantNorthAngle); // postRenderクロージャ用（stale closure回避）
  useEffect(() => { setPnInput(String(plantNorthAngle || 0)); plantNorthAngleRef.current = plantNorthAngle; }, [plantNorthAngle]);

  // 衛星透明度 + nearClipDist を1つのカスタムシェーダーに統合するヘルパー
  const _applyTilesetShader = (tileset, satAlpha, nearClip) => {
    if (!tileset || tileset.isDestroyed()) return;
    const sa = satAlpha ?? 1.0;
    const nc = nearClip ?? 0;
    const needsShader = nc > 0 || sa < 0.99;
    if (!needsShader) {
      try { tileset.customShader = undefined; } catch (_) {}
      return;
    }
    try {
      tileset.customShader = new Cesium.CustomShader({
        uniforms: {
          u_satAlpha: { type: Cesium.UniformType.FLOAT, value: sa },
          u_nearClip: { type: Cesium.UniformType.FLOAT, value: nc },
        },
        translucencyMode: sa < 0.99
          ? Cesium.CustomShaderTranslucencyMode.TRANSLUCENT
          : Cesium.CustomShaderTranslucencyMode.INHERIT,
        fragmentShaderText: `
          void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
            if (u_nearClip > 0.0 && length(fsInput.attributes.positionEC) < u_nearClip) discard;
            material.alpha *= u_satAlpha;
          }
        `,
      });
    } catch (_) {}
  };

  // 画質設定の適用（外部スライダーから変更されたとき）
  useEffect(() => {
    qualitySettingsRef.current = qualitySettings;
    if (!qualitySettings) return;
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.resolutionScale = qualitySettings.resolutionScale;
    if (viewer.scene.msaaSamples !== undefined) viewer.scene.msaaSamples = qualitySettings.msaa;
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = qualitySettings.skyAtmosphere;
    if (viewer._tileset3d && !viewer._tileset3d.isDestroyed()) {
      viewer._tileset3d.skipLevelOfDetail = qualitySettings.skipLOD;
      if (qualitySettings.sseManual) viewer._tileset3d.maximumScreenSpaceError = qualitySettings.sse;
    }
    // 衛星画像の透明度
    const satAlpha = qualitySettings.satelliteAlpha ?? 1.0;
    if (mode === '3d') {
      // 3Dモード: CustomShader で 3D Tiles の alpha を制御
      _applyTilesetShader(viewer._tileset3d, satAlpha, viewer._currentNearClipValue ?? 0);
    } else {
      // 2Dモード: imageryLayers の alpha を直接設定
      for (let i = 0; i < viewer.imageryLayers.length; i++) {
        try { viewer.imageryLayers.get(i).alpha = satAlpha; } catch (_) {}
      }
    }
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  }, [qualitySettings]);
  // 方位キューブ: カメラheading/pitchを追跡
  const [pnPanelOpen, setPnPanelOpen] = useState(false); // PN調整パネル表示/非表示
  const [cubeOrient, setCubeOrient] = useState({ h: 0, p: -Math.PI / 4 });
  const cubeOrientRef = useRef({ h: 0, p: -Math.PI / 4 });
  const cubeDragRef = useRef(null); // { startX, startY, startH, startP }
  const wireEntitiesRef = useRef([]); // 後方互換（一部参照が残るため保持）
  const wireEntityMapRef = useRef(new Map()); // seg.id → {eOut, e, posKey} 差分更新用
  const wpMarkerRef = useRef([]); // 折れ点マーカーEntity
  const wpMarkerMapRef = useRef(new Map()); // segId-wpIndex → entity（直接更新用）
  const _pickCacheRef = useRef(new Map()); // pickFromRay結果キャッシュ（座標キー→effectiveZ）
  const _underStatesRef = useRef(new Map()); // sampleHeightMostDetailedで事前計算したunder状態（geoKey→bool）
  const _underSamplePendingRef = useRef(false);  // カメラ移動中スキップ→停止後リトライ用
  const _underRetryCountRef = useRef(0);         // タイル未ロード時の自動リトライ回数
  const _underSampleInFlightRef = useRef(false); // sampleHeightMostDetailed実行中（二重呼び出し防止）
  const _wireHashRef = useRef(''); // 前回サンプリング時のwire座標ハッシュ（変化なし=スキップ）
  const _underSampleAllValidRef = useRef(false);  // 全ポジションで有効高さ取得済み→タイルロード時の再サンプル不要
  const _tileUpdateNeededRef = useRef(false);  // タイルロード完了による強制再サンプルフラグ（ハッシュクリア廃止の代替）
  const _sampleAbortRef = useRef(false);       // カメラ移動中にチャンクサンプリングを中断するフラグ
  const sampleTimerRef = useRef(null);     // sampleHeightMostDetailedデバウンス用タイマー
  const _runUnderSampleRef = useRef(null); // タイルロード完了時直接呼び出し（setStateによるReact再レンダー回避）
  const wireSVGPathsCacheRef = useRef(new Map()); // seg.id → pathエントリ（postRenderのキャッシュ）
  const _iconImgCacheRef = useRef({});        // canvas描画用 HTMLImageElement キャッシュ
  const _iconCanvasElemCacheRef = useRef({}); // canvas描画用 HTMLCanvasElement キャッシュ（同期描画）
  const _svgLastUpdateRef  = useRef(0);    // SVGスロットル: 最終更新timestamp
  const _camLastKeyRef    = useRef('');   // postRenderスキップ用: 前回カメラ状態ハッシュ
  const _canvasDirtyRef   = useRef(true); // canvas再描画フラグ: 位置/hover/filter変化時にtrue
  const _iconCart3CacheRef = useRef(new Map()); // nodeId → Cartesian3（毎フレームのgridToGeo+fromDegrees省略）
  const _iconCart3DirtyRef = useRef(true);      // allMapPos/nodes/baseElev変化時にtrue → 次postRenderで再構築
  const _wireC3CacheRef = useRef(new Map());    // segId → {c3s: Cartesian3[], pts: {x,y,z}[]} 位置変化時のみ再構築
  const _wireC3DirtyRef = useRef(true);         // allMapPos/segWp/wpZ/baseElev変化時にtrue
  const _lastWirePathsRef   = useRef([]);         // 直前フレームのwire screenパスキャッシュ
  const _lastIconScreenRef  = useRef(new Map()); // nodeId → {x,y,w,h} スクリーン座標（hover検出用）
  const _cameraMovingRef  = useRef(false); // カメラ移動中フラグ: postRenderとMOUSE_MOVEで共有（drillPickスキップ用）
  const _camStopRef       = useRef(null);  // カメラ停止処理の外部呼び出し口（pointerupで即時復帰用）
  const _pointerDownRef   = useRef(false); // ポインタ押下中フラグ: under高速パスをドラッグ中のみ有効化（慣性中は無効）
  const initDoneRef = useRef(false);
  const [initDone, setInitDone] = useState(false); // 初期化完了フラグ（useEffect依存用）
  const [coordInfo, setCoordInfo] = useState(null); // {lat, lng, alt}
  const [fieldDrawMode, setFieldDrawMode] = useState(false); // フィールド描画モード
  const [fieldDrawPts, setFieldDrawPts] = useState([]); // 描画中の頂点 [{lat,lng},...]
  const fieldDrawRef = useRef({ entities: [], lineEnt: null }); // Cesiumエンティティ参照
  const [bldAddMode, setBldAddMode] = useState(false); // 建屋追加モード
  const [bldAddPts, setBldAddPts] = useState([]); // クリック済み頂点 [{lat,lng},...]
  const bldAddRef = useRef({ entities: [], lineEnt: null }); // 描画中のCesiumエンティティ
  const bldAddPtsLatest = useRef([]); // MOUSE_MOVEクロージャ用の最新値
  const nearClipDist = qualitySettings?.nearClipDist ?? 0; // 建物近傍クリップ距離(m): qualitySettings から導出
  const [bldSelected, setBldSelected] = useState(null); // 選択中の建屋 {buildingId, blockIdx, face}
  // ── 配置済み配電盤のドラッグ（2026-09-01）──
  // 【宣言はここ】盤描画エフェクトの依存配列で使うので、**そのエフェクトより前**で宣言する。
  //   後ろに置くと依存配列の評価時に未初期化で ReferenceError になる。
  const panelDragRef = useRef(null);                    // ドラッグ状態（移動 / Shift+回転）
  const placedPanelsRef = useRef(placedPanels);         // 最新値。CallbackProperty が毎フレーム読む
  const [panelRebuildTick, setPanelRebuildTick] = useState(0); // 離した時に作り直しを1回促す
  // 直前のクリックが「動かしたドラッグ」だったか。空クリックの選択解除で使う
  const panelDragMovedRef = useRef(false);
  // 【必ず毎レンダー更新する】盤描画エフェクトはドラッグ中スキップするので、
  // そちらで更新すると CallbackProperty が古い値を読み続けて盤が動かなくなる
  useEffect(() => { placedPanelsRef.current = placedPanels; });
  const [selectedCarve, setSelectedCarve] = useState(null); // 選択中の削り出し {buildingId, childBlockIdx, parentFlatIdx}
  const [faceSketchPhase, setFaceSketchPhase] = useState(null); // null | 'draw' | 'extrude'
  const [faceSketchPts, setFaceSketchPts] = useState([]); // [{gx,gy,gz}] grid座標+メートル
  const [faceSketchDepth, setFaceSketchDepth] = useState(0); // 押し出し深さ(mm) ドラッグで変動
  const faceSketchRef = useRef({ entities: [], lineEnt: null, fillEnt: null });
  const [extrudeArrow, setExtrudeArrow] = useState(null); // {baseX,baseY,dirX,dirY} 画面座標
  const [arrowScreen, setArrowScreen] = useState(null); // {baseX,baseY,tipX,tipY,face} 画面座標
  const arrowScreenRef = useRef(null); // stale closure回避用
  const rotInputRef  = useRef(null); // 回転入力欄DOM
  const faceInputRef = useRef(null); // 面移動入力欄DOM
  const moveInputRef = useRef(null); // 建屋移動入力欄DOM
  // 面選択が変わったら入力欄をリセット
  useEffect(() => {
    if (rotInputRef.current)  rotInputRef.current.value  = '0';
    if (faceInputRef.current) faceInputRef.current.value = '0';
    if (moveInputRef.current) moveInputRef.current.value = '0';
  }, [bldSelected?.buildingId, bldSelected?.face]);
  const shaftDragOffsetRef = useRef(null); // シャフトドラッグ中の累積移動量 { dx, dy, dz }
  const movedBldsRef = useRef(null);       // shaft drag中のmovedBlds（矢印位置追従用）
  const arrowGroupRef = useRef(null);      // 矢印SVGグループ（ドラッグ中のDOM直接更新用）
  const isDraggingRef = useRef(false);     // ドラッグ中フラグ（React state更新を抑制）
  const originalBlockRef = useRef(null); // 面選択時の元のブロック状態（リセット用）
  // carve/protrude は faceSketchDepth の符号で自動判定（正=突起, 負=削り出し）
  const pushPullRef = useRef(null); // Push/Pull中の追跡 { lastX, lastY }
  const rectPullPendingRef = useRef(null); // 矩形追加後のPush/Pull待ち { buildingId, face }
  const [bldMoveAsSet, setBldMoveAsSet] = useState(true); // true=セット移動, false=単体移動
  const [bldScanMode, setBldScanMode] = useState(false); // ビルスキャンモード
  const [bldScanRes, setBldScanRes] = useState(2); // 解像度レベル 0=粗い 1=標準 2=細かい 3=最細
  const [bldScanProgress, setBldScanProgress] = useState(null); // スキャン進捗 {status, pct}
  const [bldScanConfirm, setBldScanConfirm] = useState(null); // 確認待ち {lat, lng, h, bldHeight}
  const scanningRef = useRef(false); // スキャン処理中フラグ（連打防止）
  const bldScanConfirmRef = useRef(null);
  useEffect(() => { bldScanConfirmRef.current = bldScanConfirm; }, [bldScanConfirm]);
  const updateArrowScreen = useCallback((val) => { arrowScreenRef.current = val; setArrowScreen(val); }, []);
  const bldDragRef = useRef(null); // ドラッグ中
  const bldDragHintRef = useRef(null); // ドラッグ距離ヒントDOM要素（React state不使用）

  // Cesiumビューア初期化（1回だけ）
  useEffect(() => {
    if (!containerRef.current || typeof Cesium === 'undefined') return;
    let destroyed = false;
    Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

    // コンテナが0×0のままViewerを作るとWebGLフレームバッファが壊れるため
    // DOMレイアウト確定（clientWidthが正値）まで待ってから初期化する
    const waitForSize = (cb) => {
      const el = containerRef.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        console.log(`[CESIUM_INIT ${mode}] コンテナサイズ確定: ${el.clientWidth}×${el.clientHeight}`);
        cb(); return;
      }
      console.log(`[CESIUM_INIT ${mode}] コンテナまだ0×0、次フレームで再試行`);
      requestAnimationFrame(() => waitForSize(cb));
    };

    const init = async () => {
      const el = containerRef.current;
      console.log(`[CESIUM_INIT ${mode}] init開始 コンテナ=${el?.clientWidth}×${el?.clientHeight}`);
      // テレイン読み込み（失敗してもビューアは表示する）
      let terrain;
      try {
        terrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
        console.log(`[CESIUM_INIT ${mode}] テレイン読み込みOK`);
      } catch (e) {
        console.warn('テレイン読み込み失敗(401等)、デフォルトで継続:', e.message);
        terrain = new Cesium.EllipsoidTerrainProvider();
      }
      const viewer = new Cesium.Viewer(containerRef.current, {
        terrainProvider: terrain,
        baseLayerPicker: false,
        geocoder: false,
        animation: false,
        timeline: false,
        sceneModePicker: false,
        homeButton: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        sceneMode: Cesium.SceneMode.SCENE3D,
      });
      if (destroyed) { viewer.destroy(); return; }
      viewerRef.current = viewer;
      // Viewer作成直後にcanvasサイズを強制セット（WebGLフレームバッファ0×0対策）
      {
        const cvs = viewer.scene.canvas;
        const el = containerRef.current;
        const dpr = window.devicePixelRatio || 1;
        if (cvs.width === 0 || cvs.height === 0) {
          cvs.width = Math.floor(el.clientWidth * dpr);
          cvs.height = Math.floor(el.clientHeight * dpr);
          viewer.resize();
        }
        console.log(`[CESIUM_INIT ${mode}] canvas=${cvs.width}×${cvs.height} client=${cvs.clientWidth}×${cvs.clientHeight}`);
      }

      // タイルキャッシュ拡大: 行き来の多い用途向け（デフォルト100→300）
      viewer.scene.globe.tileCacheSize = 300;
      // アンチエイリアス: FXAAを無効化してMSAA x4で滑らか描画（ジラつき軽減）
      viewer.scene.postProcessStages.fxaa.enabled = false;
      if (viewer.scene.msaaSamples !== undefined) viewer.scene.msaaSamples = 4;
      // 対数深度バッファ: Z-fighting（奥行き判定の競合によるジラつき）を大幅軽減
      viewer.scene.logarithmicDepthBuffer = true;
      // ズーム設定: Googleアース風「ぬるっと感」＋ウィンドウサイズ非依存
      // Cesiumはズーム量をcanvasHighで除算するため、大ウィンドウほどズームが遅くなる問題を
      // zoomFactor = BASE * (canvasH / REF_H) / (1-inertia) でキャンセル
      // inertia=0.7: 毎フレーム70%残留 → 約13フレーム(0.22秒)コースト（アース近似）
      // 実効ズーム量 = BASE_EFF に固定（ウィンドウサイズ・inertiaに依存しない）
      {
        const _INERTIA   = 0.8;  // Earth標準(0.8): 0.22秒→0.35秒コーストで「ぬるっと感」向上
        const _BASE_EFF  = 1.5;  // 目標実効ズーム量: 1.5/(1-0.8)=7.5 → Earth相当(zf=5.0)に近い
        const _REF_H     = 600;  // 基準高さ(px)
        const _updateZF  = () => {
          if (!viewer || viewer.isDestroyed()) return;
          const ch = Math.max(100, viewer.scene.canvas.clientHeight || _REF_H);
          const zf = _BASE_EFF * (ch / _REF_H) / (1 - _INERTIA);
          viewer.scene.screenSpaceCameraController.zoomFactor  = zf;
          viewer.scene.screenSpaceCameraController._zoomFactor = zf;
        };
        viewer.scene.screenSpaceCameraController.inertiaZoom     = _INERTIA;
        viewer.scene.screenSpaceCameraController.inertiaTranslate = 0;
        _updateZF();
        // FloatWinリサイズ時も再計算（windowリサイズより細かく検知）
        const _zfObs = new ResizeObserver(() => {
          _updateZF();
          if (!viewer.isDestroyed()) {
            // Cesiumのビューポートを新しいcanvasサイズに合わせる
            viewer.resize();
            // wireCanvasのpixel寸法をリサイズ直後に即時更新（旧サイズ内容を引き延ばさない）
            const _cvs = wireCanvasRef.current;
            const _cw = viewer.scene.canvas.clientWidth, _ch = viewer.scene.canvas.clientHeight;
            if (_cvs && (_cvs.width !== _cw || _cvs.height !== _ch)) {
              _cvs.width = _cw; _cvs.height = _ch;
            }
            // postRenderの早期リターンをバイパスして確実に再描画
            _canvasDirtyRef.current = true;
            viewer.scene.requestRender();
          }
        });
        _zfObs.observe(viewer.scene.canvas);
      }
      // 左ドラッグは回転しない — 平行移動は自前実装、回転は中ボタンのみ
      const _ctrl = viewer.scene.screenSpaceCameraController;
      // 中ボタンドラッグ = カスタムorbit（pickGlobe毎フレーム呼び出しを回避するため自前実装）
      // Shift+左 = 水平回転（Cesium内蔵）
      _ctrl.rotateEventTypes = [
        { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT },
      ];
      _ctrl.tiltEventTypes = [
        { eventType: Cesium.CameraEventType.PINCH, modifier: Cesium.KeyboardEventModifier.SHIFT },
      ];


      // ★地形標高: キャッシュ優先、なければサンプリング
      let baseElevation = getCachedElevation();
      if (baseElevation !== null && baseElevation > 0.01) {
        console.log(`地形GL: キャッシュから復元 ${baseElevation.toFixed(2)}m`);
      } else {
        baseElevation = null; // 無効なキャッシュをクリア
        const samplePoints = [];
        const NS = 5;
        for (let r = 0; r <= NS; r++) {
          for (let c = 0; c <= NS; c++) {
            const g = gridToGeo(TW * c / NS, TH * r / NS);
            samplePoints.push(Cesium.Cartographic.fromDegrees(g.lng, g.lat));
          }
        }
        baseElevation = 0;
        try {
          await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, samplePoints);
          const heights = samplePoints.map(p => p.height || 0).filter(h => h > -1000);
          if (heights.length > 0) {
            // フィールド内の最低標高をGL(0m)とする
            baseElevation = Math.min(...heights);
          }
          setCachedElevation(baseElevation);
          console.log(`地形GL: 最低標高基準 ${baseElevation.toFixed(2)}m (範囲: ${Math.min(...heights).toFixed(1)}m ～ ${Math.max(...heights).toFixed(1)}m)`);
        } catch (e) {
          console.warn('地形サンプリング失敗、GL=0mで継続:', e.message);
        }
      }

      // 3Dタイルは3Dモードのみ読み込む（2Dと同時読み込みによるWebGLコンテキスト競合を防ぐ）
      let using3DTiles = false;
      let tileset3d = null;

      if (mode === '2d') {
        // 2Dモード: Google衛星画像のみ（3Dタイル不使用）
        viewer.scene.globe.show = true;
        viewer.scene.globe.maximumScreenSpaceError = 0.5;
        viewer.scene.globe.depthTestAgainstTerrain = false;
        viewer.imageryLayers.removeAll();
        viewer.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            maximumLevel: 21,
          })
        );
      } else {
        // 3Dモード: Google Photorealistic 3D Tilesのみ
        // フォールバック関数（衛星画像Globe）
        const _fallbackToSatellite = () => {
          if (viewer.isDestroyed()) return;
          console.warn('[3DTiles] 衛星画像Globeにフォールバック');
          viewer.scene.globe.show = true;
          viewer.scene.globe.depthTestAgainstTerrain = false;
          viewer.imageryLayers.removeAll();
          viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
              url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              maximumLevel: 21,
            })
          );
          viewer.scene.requestRender();
        };

        try {
          console.log(`[CESIUM_INIT 3d] 3DTiles 読み込み開始...`);
          tileset3d = await Cesium.Cesium3DTileset.fromIonAssetId(2275207, {
            maximumScreenSpaceError: 8,
            maximumCacheOverflowBytes: 512 * 1024 * 1024,
            preloadWhenHidden: false,
            skipLevelOfDetail: false,
            dynamicScreenSpaceError: true,          // カメラ移動中: 画面内移動速度に応じてLOD自動削減
            dynamicScreenSpaceErrorDensity: 0.00278, // Cesiumデフォルト値
            dynamicScreenSpaceErrorFactor: 4.0,      // デフォルト(4.0)→移動中に少ないタイル数で済む
          });
          viewer.scene.primitives.add(tileset3d);
          viewer.scene.globe.show = false;
          viewer.scene.globe.depthTestAgainstTerrain = false;
          // カメラ移動中フォールバック用: Globeに衛星画像を設定して待機（globe.show=false維持）
          // スクロール中だけ globe.show=true にすることで3Dタイルより軽い衛星描画に切り替える
          viewer.imageryLayers.removeAll();
          viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
              url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              maximumLevel: 19,
            })
          );
          viewer.scene.globe.maximumScreenSpaceError = 4;
          viewer.scene.skyBox.show = false;
          viewer.scene.skyAtmosphere.show = true;
          viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#87CEEB').withAlpha(1.0);
          using3DTiles = true;
          console.log(`[CESIUM_INIT 3d] 3DTiles 読み込み成功`);

          // タイルロード時にrequestRender（100msデバウンス: 複数タイル連続ロードを1回のrenderに集約）
          // デバウンスなしだとtileLoad×N回 → requestRender×N回 → 462ms×N秒の連鎖フリーズが発生
          let _tileLoadTimer = null;
          tileset3d.tileLoad.addEventListener(() => {
            if (!viewer.isDestroyed()) {
              clearTimeout(_tileLoadTimer);
              _tileLoadTimer = setTimeout(() => { if (!viewer.isDestroyed()) viewer.scene.requestRender(); }, 100);
            }
          });
          // 全タイルロード完了時にwireUnder判定を再計算（タンク等が後からロードされても確実に薄線適用）
          // setTileVersion→React再レンダー(616ms)を廃止し、サンプル関数を直接呼び出す
          let _allTilesLoadedTimer = null;
          tileset3d.allTilesLoaded.addEventListener(() => {
            if (viewer.isDestroyed()) return;
            clearTimeout(_allTilesLoadedTimer);
            _allTilesLoadedTimer = setTimeout(() => {
              if (_underSampleInFlightRef.current) {
                // 自分が引き起こしたallTilesLoaded（無限ループ防止）: pendingのみセット
                _underSamplePendingRef.current = true;
                _tileUpdateNeededRef.current = true;
              } else if (!_underSampleAllValidRef.current) {
                // 全サンプル有効取得済みなら再サンプル不要。未完了のみ実行
                _tileUpdateNeededRef.current = true;
                if (_cameraMovingRef.current) {
                  // カメラ移動中: 停止後にまとめて実行（移動中に265点GPUパスを走らせない）
                  _underSamplePendingRef.current = true;
                } else {
                  _runUnderSampleRef.current?.();
                }
              }
            }, 500);
          });

          // 15秒後にタイルが1枚も読み込まれていなければ衛星画像にフォールバック
          const _fallbackTimer = setTimeout(() => {
            if (viewer.isDestroyed() || tileset3d.isDestroyed()) return;
            // _statistics (private) または statistics (public) でタイル読み込み数を取得
            const loaded = (tileset3d._statistics?.numberOfTilesLoaded)
              ?? (tileset3d.statistics?.numberOfTilesLoaded)
              ?? -1;
            console.log(`[3DTiles] 15秒後チェック: タイル読み込み数=${loaded}`);
            if (loaded === 0) {
              _fallbackToSatellite();
            }
          }, 15000);

        } catch (e) {
          console.warn('3D Tiles failed:', e.message);
          _fallbackToSatellite();
        }
      }
      viewer._tileset3d = tileset3d;
      // 【観測口は初期化の時点で開く・2026-10-12】
      //   登録が「盤の再計算の useEffect」の中だけにあると、盤が無いときは登録されず、
      //   外から viewer を一切見られない（実測: __cesiumViewers が常に空だった）。
      //   初期化が終わった時点で登録する。動きは変えない。
      if (typeof window !== 'undefined') {
        const _reg0 = (window.__cesiumViewers = window.__cesiumViewers || []);
        if (!_reg0.includes(viewer)) _reg0.push(viewer);
      }

      // 3D: sharedBaseElevがあれば優先（3DTiles基準）
      // 2D: 自身のテレインサンプリング結果をそのまま使用（3Dと地表モデルが異なるため）
      if (mode === '3d' && sharedBaseElev != null && sharedBaseElev > 0.01) {
        baseElevation = sharedBaseElev;
      }
      viewer._siteBaseElevation = baseElevation;
      viewer._using3DTiles = using3DTiles;
      viewer._mode = mode;
      if (onBaseElevChange) onBaseElevChange(baseElevation);

      // 建屋Entity構築ヘルパー（baseElev=地表面絶対高度、abs=絶対高度モード）
      // 共有壁を持つブロックはWallGraphicsで壁を個別レンダリングし、共有面を除外する
      // ============================================================
      // 面ベースレンダリング: solidModel.jsの面リストからCesiumエンティティを生成
      // 壁面・上面・下面を区別せず、全て同じパスで処理する
      // ============================================================
      // ============================================================
      // 面ベースレンダリング: 各面を3D頂点のpolygonとして直接描画
      // 壁面・上面・下面の区別なし。全面同一パス。
      // ============================================================
      const buildBldEntities = (v, bldList, baseElev, abs, passedSolids) => {
        // Per-solidキャッシュ初期化
        if (!v._solidCache) v._solidCache = new Map();
        const _solidFP = (s, base, absMode) => {
          const fStr = s.faces.map(f =>
            f.id + ':' + (f.vertices || []).map(vt => `${vt.x.toFixed(1)},${vt.y.toFixed(1)},${vt.z.toFixed(1)}`).join(';') +
            (f.holes ? ':h' + f.holes.map(h => h.map(vt => `${vt.x.toFixed(1)},${vt.y.toFixed(1)},${vt.z.toFixed(1)}`).join(';')).join('|') : '')
          ).join('|');
          return `${s.id}~${s.color || ''}~${s.label || ''}~${base.toFixed(2)}~${absMode}~${fStr}`;
        };
        // 削除されたsolidのキャッシュを除去
        const _activeIds = new Set((passedSolids || []).map(s => s.id));
        for (const [cid, cac] of v._solidCache) {
          if (!_activeIds.has(cid)) {
            if (cac.labelEnt && v.entities.contains(cac.labelEnt)) v.entities.remove(cac.labelEnt);
            (cac.extraEnts || []).forEach(e => { if (e && v.entities.contains(e)) v.entities.remove(e); });
            v._solidCache.delete(cid);
          }
        }
        // キャッシュにないレガシーエンティティを除去（初回キャッシュ前の残存）
        const _cachedEntitySet = new Set();
        for (const cac of v._solidCache.values()) {
          if (cac.labelEnt) _cachedEntitySet.add(cac.labelEnt);
          (cac.extraEnts || []).forEach(e => _cachedEntitySet.add(e));
        }
        if (v._bldEntities) {
          v._bldEntities.forEach(e => { if (e && !_cachedEntitySet.has(e) && v.entities.contains(e)) v.entities.remove(e); });
        }
        if (v._bldExtraEntities) {
          v._bldExtraEntities.forEach(e => { if (e && !_cachedEntitySet.has(e) && v.entities.contains(e)) v.entities.remove(e); });
        }
        v._bldEntities = [];
        v._bldExtraEntities = [];

        // solidOverride: CSG結果の面リストを保持。消費しない（再描画でも維持）
        // bldList変更時のみクリア
        if (window._csgOverride && window._csgOverrideBldCount != null && window._csgOverrideBldCount !== (bldList ? bldList.length : 0)) {
          window._csgOverride = null;
        }
        window._csgOverrideBldCount = bldList ? bldList.length : 0;

        // オーバーライドマップ構築（flatIdx → faces）
        const _overrideFaces = {};
        if (window._csgOverride) {
          window._csgOverride.forEach(s => { if (s.flatIdx != null) _overrideFaces[s.flatIdx] = s.faces; });
        }

        // 旧solidOverrideパス削除 — 通常パスで一括処理する
        if (false) { // ← 旧パス無効化
          const overrideSolids = [];
          overrideSolids.forEach((solid, solidIdx) => {
            const color = Cesium.Color.fromCssColorString(solid.color || '#6B7A8D');
            const mat = color.withAlpha(0.6);
            const localBaseElev = baseElev;
            v._bldEntities.push(null);
            const _earClip = (pts2d) => {
              const nn = pts2d.length;
              if (nn <= 3) return [pts2d];
              let areaSign = 0;
              for (let ii = 0; ii < nn; ii++) { const jj = (ii+1)%nn; areaSign += pts2d[ii].x*pts2d[jj].y - pts2d[jj].x*pts2d[ii].y; }
              const ccw = areaSign >= 0;
              let isAllConvex = true;
              for (let ii = 0; ii < nn; ii++) {
                const a = pts2d[ii], b = pts2d[(ii+1)%nn], c = pts2d[(ii+2)%nn];
                const cr = (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
                if (Math.abs(cr) < 0.01) continue;
                if (ccw ? cr < 0 : cr > 0) { isAllConvex = false; break; }
              }
              if (isAllConvex) return [pts2d];
              const rem = pts2d.map((_,i) => i);
              const res = [];
              const isEar = (idxs, k) => {
                const m = idxs.length;
                const pi = idxs[(k-1+m)%m], ci = idxs[k], ni = idxs[(k+1)%m];
                const a = pts2d[pi], b = pts2d[ci], c = pts2d[ni];
                const cr = (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
                if (ccw ? cr < 0.01 : cr > -0.01) return false;
                for (let i = 0; i < m; i++) {
                  const ti = idxs[i];
                  if (ti===pi||ti===ci||ti===ni) continue;
                  const p = pts2d[ti];
                  const d1=(a.x-p.x)*(b.y-a.y)-(a.y-p.y)*(b.x-a.x);
                  const d2=(b.x-p.x)*(c.y-b.y)-(b.y-p.y)*(c.x-b.x);
                  const d3=(c.x-p.x)*(a.y-c.y)-(c.y-p.y)*(a.x-c.x);
                  if ((d1>=0&&d2>=0&&d3>=0)||(d1<=0&&d2<=0&&d3<=0)) return false;
                }
                return true;
              };
              let safe = 0;
              while (rem.length > 3 && safe < nn*2) {
                safe++;
                let found = false;
                for (let i = 0; i < rem.length; i++) {
                  if (isEar(rem, i)) {
                    const m = rem.length;
                    res.push([pts2d[rem[(i-1+m)%m]], pts2d[rem[i]], pts2d[rem[(i+1)%m]]]);
                    rem.splice(i, 1);
                    found = true; break;
                  }
                }
                if (!found) break;
              }
              if (rem.length === 3) res.push([pts2d[rem[0]], pts2d[rem[1]], pts2d[rem[2]]]);
              else if (rem.length > 3) res.push(rem.map(i => pts2d[i]));
              return res;
            };

            solid.faces.forEach(face => {
              const verts = face.vertices;
              if (!verts || verts.length < 3) return;
              const allZ = verts.map(vt => vt.z);
              const isFlat = allZ.every(z => Math.abs(z - allZ[0]) < 0.01);

              if (isFlat) {
                // 平面: 耳切り法で凸分割（L字対応）
                const pts2d = verts.map(vt => ({ x: vt.x, y: vt.y }));
                const parts = _earClip(pts2d);
                parts.forEach(part => {
                  const faceEnt = v.entities.add({
                    polygon: {
                      hierarchy: Cesium.Cartesian3.fromDegreesArray(part.flatMap(p => { const g = gridToGeo(p.x, p.y); return [g.lng, g.lat]; })),
                      height: localBaseElev + allZ[0],
                      material: mat, outline: false,
                    },
                  });
                  faceEnt._faceInfo = { entIdx: solidIdx, solidIdx, faceId: face.id, solidFaceId: face.id, face: face.type, normal: face.normal, buildingId: solid.buildingId };
                  faceEnt._bldFlatIdx = solidIdx;
                  v._bldExtraEntities.push(faceEnt);
                });
              } else {
                // 壁面: 表面＋裏面（透過防止）
                const positions = verts.map(vt => { const g = gridToGeo(vt.x, vt.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + vt.z); });
                const faceEnt = v.entities.add({
                  polygon: { hierarchy: new Cesium.PolygonHierarchy(positions), perPositionHeight: true, material: mat, outline: false },
                });
                faceEnt._faceInfo = { entIdx: solidIdx, solidIdx, faceId: face.id, solidFaceId: face.id, face: face.type, normal: face.normal, buildingId: solid.buildingId };
                faceEnt._bldFlatIdx = solidIdx;
                v._bldExtraEntities.push(faceEnt);
                const backEnt = v.entities.add({
                  polygon: { hierarchy: new Cesium.PolygonHierarchy([...positions].reverse()), perPositionHeight: true, material: mat, outline: false },
                });
                backEnt._faceInfo = faceEnt._faceInfo;
                backEnt._bldFlatIdx = solidIdx;
                v._bldExtraEntities.push(backEnt);
              }
            });
            // 頂点マーカー
            const addedKeys = new Set();
            solid.faces.forEach(face2 => {
              face2.vertices.forEach((vt, vi) => {
                const key = `${vt.x.toFixed(1)}_${vt.y.toFixed(1)}_${vt.z.toFixed(1)}`;
                if (addedKeys.has(key)) return;
                addedKeys.add(key);
                const g = gridToGeo(vt.x, vt.y);
                v._bldExtraEntities.push(v.entities.add({
                  position: Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + vt.z),
                  point: { pixelSize: 1, color: Cesium.Color.CYAN.withAlpha(0.01), outlineColor: Cesium.Color.CYAN, outlineWidth: 0, disableDepthTestDistance: Number.POSITIVE_INFINITY },
                  _vertexInfo: { solidIdx, faceId: face2.id, vertIdx: vi, gx: vt.x, gy: vt.y, gz: vt.z },
                }));
              });
            });
          });
          return;
        }
        // ── Solid取得: passedSolidsがあればそのまま使う、なければbldListから変換 ──
        let currentSolids;
        if (passedSolids && passedSolids.length > 0) {
          // 面ベースSolidを直接使用（新方式）
          currentSolids = passedSolids;
        } else {
          // bldListから変換（旧互換）
          // 【ブロック→立体は唯一の入口 blockSolidsOf を通す・2026-10-03 Codex監査】
          //   ここで面を自前に組み立てていたので、上面の傾き（片流れ屋根）・掃引（らせん）・
          //   並べた部材（螺旋階段の段板）が落ちていた。passedSolids が間に合わない
          //   1コマだけ走る道だが、「新しい形の作り方を知らない道」を残すと必ず再発する
          currentSolids = [];
          if (!bldList || bldList.length === 0) return;
          bldList.forEach((blk, flatIdx) => {
            const pts = blk.points;
            if (!pts || pts.length < 3) return;
            // 旧名 height を zTop に吸収してから渡す（入口は zTop しか見ない）
            const _blk = Object.assign({}, blk, { zTop: blk.zTop != null ? blk.zTop : (blk.height || 40) });
            const _bld = { id: blk.buildingId, label: blk.label, color: blk.color || '#6B7A8D', blocks: [_blk] };
            (blockSolidsOf(_bld, _blk, 0) || []).forEach((sd, k) => {
              currentSolids.push(Object.assign({}, sd, {
                id: blk.buildingId + '_' + flatIdx + (k ? '#' + k : ''),
                label: blk.label, color: blk.color || '#6B7A8D',
                // 削り出し済みの面があればそれを優先（従来どおり。並べた複製には掛けない）
                faces: (k === 0 && _overrideFaces[flatIdx]) ? _overrideFaces[flatIdx] : sd.faces,
                flatIdx,
              }));
            });
          });
        }

        // solidsをviewerに保存（pushpull確定時に参照）
        v._solids = currentSolids;

        // solidsから描画
        currentSolids.forEach((solid, solidIdx) => {
          // ===== キャッシュチェック =====
          const _fp = _solidFP(solid, baseElev, abs);
          const _cac = v._solidCache.get(solid.id);
          if (_cac && _cac.fp === _fp) {
            v._bldEntities.push(_cac.labelEnt);
            (_cac.extraEnts || []).forEach(e => v._bldExtraEntities.push(e));
            return;
          }
          if (_cac) {
            if (_cac.labelEnt && v.entities.contains(_cac.labelEnt)) v.entities.remove(_cac.labelEnt);
            (_cac.extraEnts || []).forEach(e => { if (e && v.entities.contains(e)) v.entities.remove(e); });
          }
          // 配列を一時的にper-solidコレクターに差し替え（_addWallPolyなどの全pushが捕捉される）
          const _mainBldEnts = v._bldEntities;
          const _mainExtraEnts = v._bldExtraEntities;
          v._bldEntities = [];
          v._bldExtraEntities = [];
          // ===== キャッシュチェック終了 =====

          const color = Cesium.Color.fromCssColorString(solid.color || '#6B7A8D');
          const mat = color.withAlpha(0.6);

          // 2Dモード: globe地表面高サンプル
          let localBaseElev = baseElev;
          if (!abs && v.scene.globe && v.scene.globe.show && solid.faces.length > 0) {
            const firstFace = solid.faces[0];
            const vt0 = firstFace.vertices[0];
            if (vt0) {
              const g = gridToGeo(vt0.x, vt0.y);
              const carto = Cesium.Cartographic.fromDegrees(g.lng, g.lat);
              const gh = v.scene.globe.getHeight(carto);
              if (gh != null && gh > -500) localBaseElev = gh;
            }
          }

          // ラベル用エンティティ
          const topFace = solid.faces.find(f => f.type === 'top');
          if (topFace && topFace.vertices.length > 0) {
            const lv = topFace.vertices[0];
            const lg = gridToGeo(lv.x, lv.y);
            v._bldEntities.push(v.entities.add({
              name: solid.label,
              position: Cesium.Cartesian3.fromDegrees(lg.lng, lg.lat, localBaseElev + lv.z),
              label: {
                text: solid.label,
                font: '13px sans-serif',
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                outlineWidth: 2,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -5),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }));
          } else {
            v._bldEntities.push(null);
          }

          // ── 耳切り法凸分割（CSGのL字面対応） ──
          const _earClipMain = (pts2d) => {
            const nn = pts2d.length;
            if (nn <= 3) return [pts2d];
            let areaSign = 0;
            for (let ii = 0; ii < nn; ii++) { const jj = (ii+1)%nn; areaSign += pts2d[ii].x*pts2d[jj].y - pts2d[jj].x*pts2d[ii].y; }
            const ccw = areaSign >= 0;
            let isAllConvex = true;
            for (let ii = 0; ii < nn; ii++) {
              const a = pts2d[ii], b = pts2d[(ii+1)%nn], c = pts2d[(ii+2)%nn];
              const cr = (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
              if (Math.abs(cr) < 0.01) continue;
              if (ccw ? cr < 0 : cr > 0) { isAllConvex = false; break; }
            }
            if (isAllConvex) return [pts2d];
            const rem = pts2d.map((_,i) => i);
            const res = [];
            const isEar = (idxs, k) => {
              const m = idxs.length;
              const pi = idxs[(k-1+m)%m], ci = idxs[k], ni = idxs[(k+1)%m];
              const a = pts2d[pi], b = pts2d[ci], c = pts2d[ni];
              const cr = (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
              if (ccw ? cr < 0.01 : cr > -0.01) return false;
              for (let i = 0; i < m; i++) {
                const ti = idxs[i]; if (ti===pi||ti===ci||ti===ni) continue;
                const p = pts2d[ti];
                const d1=(a.x-p.x)*(b.y-a.y)-(a.y-p.y)*(b.x-a.x);
                const d2=(b.x-p.x)*(c.y-b.y)-(b.y-p.y)*(c.x-b.x);
                const d3=(c.x-p.x)*(a.y-c.y)-(c.y-p.y)*(a.x-c.x);
                if ((d1>=0&&d2>=0&&d3>=0)||(d1<=0&&d2<=0&&d3<=0)) return false;
              }
              return true;
            };
            let safe = 0;
            while (rem.length > 3 && safe < nn*2) {
              safe++; let found = false;
              for (let i = 0; i < rem.length; i++) {
                if (isEar(rem, i)) {
                  const m = rem.length;
                  res.push([pts2d[rem[(i-1+m)%m]], pts2d[rem[i]], pts2d[rem[(i+1)%m]]]);
                  rem.splice(i, 1); found = true; break;
                }
              }
              if (!found) break;
            }
            if (rem.length === 3) res.push([pts2d[rem[0]], pts2d[rem[1]], pts2d[rem[2]]]);
            else if (rem.length > 3) res.push(rem.map(i => pts2d[i]));
            return res;
          };

          // ── 全面を同一パスで描画 ──
          if (solid.faces.length > 8) {
            // 全面まとめて1個の文字列で出力（スクロールせずコピペできる）
            const dump = solid.faces.map(f => {
              const vs = f.vertices.map(v => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`).join(' ');
              return `${f.id}(${f.type}): ${vs}`;
            }).join('\n');
            console.warn(`[FACES_DUMP] ===全${solid.faces.length}面===\n${dump}\n===END===`);
          }
          solid.faces.forEach(face => {
            const verts = face.vertices;
            if (!verts || verts.length < 3) return;

            // 全頂点が同一Zかチェック
            const allZ = verts.map(vt => vt.z);
            const isFlat = allZ.every(z => Math.abs(z - allZ[0]) < 0.01);

            if (isFlat) {
              const _flatFaceInfo = { entIdx: solidIdx, solidIdx, faceId: face.id, solidFaceId: face.id, face: face.type === 'top' ? 'zTop' : face.type === 'bottom' ? 'zBottom' : face._edgeIdx, normal: face.normal, buildingId: solid.buildingId };
              const faceZ = localBaseElev + allZ[0];
              if (face.holes && face.holes.length > 0) {
                // 穴あき平面(ロ字等): Cesium PolygonHierarchy の holes で対応
                const outerPos = verts.map(vt => { const g = gridToGeo(vt.x, vt.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, faceZ); });
                const holePolygons = face.holes.map(hole =>
                  new Cesium.PolygonHierarchy(hole.map(vt => { const g = gridToGeo(vt.x, vt.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, faceZ); }))
                );
                const faceEnt = v.entities.add({ polygon: { hierarchy: new Cesium.PolygonHierarchy(outerPos, holePolygons), height: faceZ, material: mat, outline: false } });
                faceEnt._faceInfo = _flatFaceInfo;
                faceEnt._bldFlatIdx = solidIdx;
                faceEnt._solidFaceId = face.id;
                v._bldExtraEntities.push(faceEnt);
              } else {
              // 通常平面: 耳切り法で凸分割（L字等の凹ポリゴン対応）
              const pts2d = verts.map(vt => ({ x: vt.x, y: vt.y }));
              const parts = _earClipMain(pts2d);
              parts.forEach(part => {
                const faceEnt = v.entities.add({
                  polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(part.flatMap(p => { const g = gridToGeo(p.x, p.y); return [g.lng, g.lat]; })),
                    height: faceZ,
                    material: mat, outline: false,
                  },
                });
                faceEnt._faceInfo = _flatFaceInfo;
                faceEnt._bldFlatIdx = solidIdx;
                faceEnt._solidFaceId = face.id;
                v._bldExtraEntities.push(faceEnt);
              });
              }
            } else {
              // 非平面（壁面）: perPositionHeight
              const _faceInfoBase = { entIdx: solidIdx, solidIdx, faceId: face.id, solidFaceId: face.id, face: face._edgeIdx != null ? face._edgeIdx : face.type, normal: face.normal, buildingId: solid.buildingId };
              const _addWallPoly = (triVerts, holePolygons) => {
                const pos = triVerts.map(vt => { const g = gridToGeo(vt.x, vt.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + vt.z); });
                const hier = holePolygons ? new Cesium.PolygonHierarchy(pos, holePolygons) : new Cesium.PolygonHierarchy(pos);
                const fe = v.entities.add({ polygon: { hierarchy: hier, perPositionHeight: true, material: mat, outline: false } });
                fe._faceInfo = _faceInfoBase; fe._bldFlatIdx = solidIdx; fe._solidFaceId = face.id;
                v._bldExtraEntities.push(fe);
                const hierB = holePolygons ? new Cesium.PolygonHierarchy([...pos].reverse(), holePolygons.map(h => new Cesium.PolygonHierarchy([...h.positions].reverse()))) : new Cesium.PolygonHierarchy([...pos].reverse());
                const be = v.entities.add({ polygon: { hierarchy: hierB, perPositionHeight: true, material: mat, outline: false } });
                be._faceInfo = _faceInfoBase; be._bldFlatIdx = solidIdx; be._solidFaceId = face.id;
                v._bldExtraEntities.push(be);
              };
              if (face.holes && face.holes.length > 0) {
                // 穴あき壁面: PolygonHierarchy with holes + perPositionHeight
                const holePolygons = face.holes.map(hole =>
                  new Cesium.PolygonHierarchy(hole.map(vt => { const g = gridToGeo(vt.x, vt.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + vt.z); }))
                );
                _addWallPoly(verts, holePolygons);
              } else if (verts.length > 4) {
                // L字形壁面: 軸平行(Y固定or X固定)のみ水平ストリップで分解
                // 非軸平行は直接描画（ストリップ分解すると誤った細い棒が生成される）
                const _isYFixed = verts.every(v => Math.abs(v.y - verts[0].y) < 2.0);
                const _isXFixed = verts.every(v => Math.abs(v.x - verts[0].x) < 2.0);
                if (_isYFixed || _isXFixed) {
                  const _t = v => _isYFixed ? v.x : v.y;
                  const _fixedCoord = _isYFixed ? verts[0].y : verts[0].x;
                  const _zLevels = [...new Set(verts.map(v => Math.round(v.z*10)/10))].sort((a,b)=>a-b);
                  for (let zi=0; zi<_zLevels.length-1; zi++) {
                    const zLo=_zLevels[zi], zHi=_zLevels[zi+1], zMid=(zLo+zHi)/2;
                    const _tVals = [];
                    for (let vi=0;vi<verts.length;vi++) {
                      const va=verts[vi],vb=verts[(vi+1)%verts.length];
                      const za=va.z,zb=vb.z;
                      if ((za<=zMid&&zb>zMid)||(zb<=zMid&&za>zMid)) {
                        const k=(zMid-za)/(zb-za);
                        _tVals.push(_t(va)+k*(_t(vb)-_t(va)));
                      } else if (Math.abs(za-zMid)<0.05) _tVals.push(_t(va));
                    }
                    if (_tVals.length<2) continue;
                    const tLo=Math.min(..._tVals), tHi=Math.max(..._tVals);
                    if (Math.abs(tHi-tLo)<0.5) continue;
                    const _rv = (t,z) => _isYFixed ? {x:t,y:_fixedCoord,z} : {x:_fixedCoord,y:t,z};
                    _addWallPoly([_rv(tLo,zLo),_rv(tHi,zLo),_rv(tHi,zHi),_rv(tLo,zHi)]);
                  }
                } else {
                  // 非軸平行L字壁: 2矩形に分割して描画（直接描画は斜め三角形アーティファクトが出る）
                  if (verts.length === 6) {
                    // 構造判定: verts[2].z > verts[4].z → 構造1（左端カット）
                    //           verts[2].z < verts[4].z → 構造2（右端カット）
                    if (verts[2].z > verts[4].z) {
                      // 構造1: [p0(zB), p1(zB), p1(zT), rB(zT), rB(zS), p0(zS)]
                      const zS = verts[4].z;
                      const p1zS = {x:verts[1].x, y:verts[1].y, z:zS}; // p1縦線上のzS点
                      _addWallPoly([verts[0], verts[1], p1zS, verts[5]]); // 下: 全幅 zB..zS
                      _addWallPoly([verts[4], p1zS, verts[2], verts[3]]); // 上: 右部 zS..zT
                    } else {
                      // 構造2: [p0(zB), p1(zB), p1(zS), rA(zS), rA(zT), p0(zT)]
                      const zS = verts[2].z;
                      const p0zS = {x:verts[0].x, y:verts[0].y, z:zS}; // p0縦線上のzS点
                      _addWallPoly([verts[0], verts[1], verts[2], p0zS]); // 下: 全幅 zB..zS
                      _addWallPoly([p0zS, verts[3], verts[4], verts[5]]); // 上: 左部 zS..zT
                    }
                  } else {
                    _addWallPoly(verts);
                  }
                }
              } else {
                _addWallPoly(verts);
              }
            }
          });

          // 頂点マーカー
          const addedVertKeys = new Set();
          const _solidBaseZ = Math.min(...solid.faces.flatMap(f => f.vertices?.map(v=>v.z)||[]));
          const _solidTopZ  = Math.max(...solid.faces.flatMap(f => f.vertices?.map(v=>v.z)||[]));
          solid.faces.forEach(face => {
            face.vertices.forEach((vt, vi) => {
              if (!vt || vt.x == null || vt.y == null || vt.z == null) return;
              // wall面: 底辺(z≈base)と中間z（solidTopZでない）の頂点は非表示
              // → 段差操作で生じた外壁の途中高さ頂点（不要な頂点）をクリック不可にする
              if (face.type === 'wall') {
                if (Math.abs(vt.z - _solidBaseZ) < 0.5) return; // 底辺
                if (Math.abs(vt.z - _solidTopZ) > 0.5) return;  // 中間高さ
              }
              const key = `${vt.x.toFixed(1)}_${vt.y.toFixed(1)}_${vt.z.toFixed(1)}`;
              if (addedVertKeys.has(key)) return;
              addedVertKeys.add(key);
              const g = gridToGeo(vt.x, vt.y);
              const ptEnt = v.entities.add({
                position: Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + vt.z),
                point: {
                  pixelSize: 1,
                  color: Cesium.Color.CYAN.withAlpha(0.01),
                  outlineColor: Cesium.Color.CYAN,
                  outlineWidth: 0,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
                _vertexInfo: { solidIdx, flatIdx: solid.flatIdx, faceId: face.id, vertIdx: vi, gx: vt.x, gy: vt.y, gz: vt.z },
              });
              v._bldExtraEntities.push(ptEnt);
            });
          });

          // 頂点ラベル — 全面の全ユニーク頂点に表示（削り出し後の新頂点も含む）
          {
            // 全ユニーク3D頂点を収集
            const vtxMap = new Map(); // key -> {x,y,z}
            solid.faces.forEach(face => {
              face.vertices.forEach(vt => {
                if (!vt || vt.x == null || vt.y == null || vt.z == null) return;
                const key = `${vt.x.toFixed(1)}_${vt.y.toFixed(1)}_${vt.z.toFixed(1)}`;
                if (!vtxMap.has(key)) vtxMap.set(key, { x: vt.x, y: vt.y, z: vt.z });
              });
            });
            const allVerts = [...vtxMap.values()];
            if (allVerts.length >= 3) {
              // z値でグループ分け
              const zVals = [...new Set(allVerts.map(v => Math.round(v.z * 10) / 10))].sort((a, b) => b - a);
              const zTop = zVals[0];
              const zBot = zVals[zVals.length - 1];
              // 重心（xy平面）
              const cx = allVerts.reduce((s, p) => s + p.x, 0) / allVerts.length;
              const cy = allVerts.reduce((s, p) => s + p.y, 0) / allVerts.length;
              const OFF = 8;
              // z高い順にグループ化し、各グループ内は角度順
              const groups = zVals.map(z => {
                const pts = allVerts.filter(v => Math.abs(Math.round(v.z * 10) / 10 - z) < 0.05);
                pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
                return { z, pts };
              });
              // ラベル割当: 最上面=小文字a,b,c... 最下面=大文字A,B,C... 中間=小文字続き(g,h,...)
              let lowerIdx = 0; // 小文字カウンタ
              let upperIdx = 0; // 大文字カウンタ
              // 最上面グループ
              const topGroup = groups.find(g => g.z === zTop);
              if (topGroup) {
                topGroup.pts.forEach(pt => {
                  pt._label = String.fromCharCode(97 + lowerIdx++); // a, b, c...
                  pt._isBottom = false;
                });
              }
              // 中間グループ（あれば）
              groups.filter(g => g.z !== zTop && g.z !== zBot).forEach(grp => {
                grp.pts.forEach(pt => {
                  pt._label = String.fromCharCode(97 + lowerIdx++); // 小文字続き
                  pt._isBottom = false;
                });
              });
              // 最下面グループ
              const botGroup = groups.find(g => g.z === zBot);
              if (botGroup) {
                botGroup.pts.forEach(pt => {
                  pt._label = String.fromCharCode(65 + upperIdx++); // A, B, C...
                  pt._isBottom = true;
                });
              }
              // 全頂点にラベル描画
              // 【頂点の名称は出さない・2026-11-24 ユーザー指示「非常に重い」】
              //   頂点1つにつき Cesium のエンティティを1つ作るので、建物が増えるほど重くなる
              //   （取り込みで200件になると頂点は千単位）。必要なときだけ
              //   window.__CESIUM_VERTEX_LABELS = true で出せる（既定は出さない）。
              const _頂点名 = (typeof window !== 'undefined' && window.__CESIUM_VERTEX_LABELS === true);
              if (_頂点名) allVerts.forEach(pt => {
                if (!pt._label) return;
                const dx = pt.x - cx, dy = pt.y - cy;
                const d = Math.sqrt(dx * dx + dy * dy);
                const ox = d > 0.1 ? pt.x + dx / d * OFF : pt.x;
                const oy = d > 0.1 ? pt.y + dy / d * OFF : pt.y;
                const g = gridToGeo(ox, oy);
                const labelZ = pt._isBottom ? Math.abs(pt.z) + 1 : pt.z;
                v._bldExtraEntities.push(v.entities.add({
                  position: Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + labelZ),
                  label: {
                    text: pt._label,
                    font: pt._isBottom ? '11px sans-serif' : '12px sans-serif',
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  },
                }));
              });
            }
          }

          // ===== キャッシュ保存 =====
          const _newLabelEnt = v._bldEntities[0] || null;
          const _newExtraEnts = [...v._bldExtraEntities];
          v._bldEntities = _mainBldEnts;
          v._bldExtraEntities = _mainExtraEnts;
          v._bldEntities.push(_newLabelEnt);
          _newExtraEnts.forEach(e => v._bldExtraEntities.push(e));
          v._solidCache.set(solid.id, { fp: _fp, labelEnt: _newLabelEnt, extraEnts: _newExtraEnts });
          // ===== キャッシュ保存終了 =====
        });

        // solidsがない場合のフォールバック（旧bldListから描画）
        if (currentSolids.length === 0 && bldList && bldList.length > 0) {
          console.warn('[RENDER] solidsなし、bldListフォールバック');
        }
      };
      viewer._buildBldEntities = buildBldEntities;

      // 各建屋の周辺地表面高さをサンプルし、建屋ごとのローカル0mを設定
      const adjustBldGroundLevel = (v, bldList, baseElev) => {
        if (!v || v.isDestroyed() || !bldList || bldList.length === 0) return;
        // 各建屋の外周4方向にオフセットしたサンプル点を生成（3DTiles建物を避ける）
        const buildingInfo = {};
        const allPositions = [];
        const posMap = []; // { bid, sampleIdx }
        const OFFSET_M = 5; // 建屋外周から5m外側をサンプル
        const offsetPx = OFFSET_M / METERS_PER_PX;
        bldList.forEach((blk) => {
          const bid = blk.buildingId;
          if (buildingInfo[bid]) return;
          const pts = blk.points;
          const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const hw = (Math.max(...xs) - Math.min(...xs)) / 2 + offsetPx;
          const hh = (Math.max(...ys) - Math.min(...ys)) / 2 + offsetPx;
          buildingInfo[bid] = { flatIndices: [], startIdx: allPositions.length };
          // 4方向のサンプル点（建屋外側）
          const offsets = [
            [cx - hw, cy], [cx + hw, cy],
            [cx, cy - hh], [cx, cy + hh],
          ];
          offsets.forEach(([ox, oy]) => {
            const g = gridToGeo(ox, oy);
            allPositions.push(Cesium.Cartographic.fromDegrees(g.lng, g.lat));
            posMap.push(bid);
          });
        });
        bldList.forEach((blk, flatIdx) => {
          if (buildingInfo[blk.buildingId]) {
            buildingInfo[blk.buildingId].flatIndices.push(flatIdx);
          }
        });
        if (allPositions.length === 0) return;
        v.scene.sampleHeightMostDetailed(allPositions).then(sampled => {
          if (v.isDestroyed()) return;
          // 各建屋の4サンプルから最小値（＝地面）を取得
          const bidGroundH = {};
          sampled.forEach((pos, i) => {
            const bid = posMap[i];
            const h = pos.height;
            if (h == null || h < -500 || h > 10000) return;
            if (bidGroundH[bid] == null || h < bidGroundH[bid]) {
              bidGroundH[bid] = h;
            }
          });
          let adjustedCount = 0;
          Object.entries(bidGroundH).forEach(([bid, localGround]) => {
            const offset = localGround - baseElev;
            // console.log(`  建屋${bid}: localGround=${localGround.toFixed(2)}, baseElev=${baseElev.toFixed(2)}, offset=${offset.toFixed(2)}m`);
            if (Math.abs(offset) < 0.3) return;
            const { flatIndices } = buildingInfo[bid];
            flatIndices.forEach(fi => {
              const ent = v._bldEntities[fi];
              if (!ent || !ent.polygon) return;
              const now = Cesium.JulianDate.now();
              const curH = ent.polygon.height?.getValue?.(now);
              const curEH = ent.polygon.extrudedHeight?.getValue?.(now);
              if (curH != null) ent.polygon.height = curH + offset;
              if (curEH != null) ent.polygon.extrudedHeight = curEH + offset;
            });
            adjustedCount++;
          });
          v.scene.requestRender();
          // console.log(`建屋地盤補正: ${adjustedCount}棟のローカル地表面を個別設定`);
        }).catch(e => {
          console.warn('建屋地盤補正失敗:', e.message);
        });
      };
      viewer._adjustBldGroundLevel = adjustBldGroundLevel;

      // 初回建屋追加（2D: RELATIVE_TO_GROUND、3D: 仮配置→後でサンプルして再配置）
      const _blds = blds || INIT_BLDS;
      buildBldEntities(viewer, _blds, baseElevation, mode === '3d');

      // 3Dモード: 3D Tilesの実際の地表面を非同期サンプル → 建屋再配置
      if (mode === '3d' && using3DTiles) {
        // フィールド内側を密にサンプル（端は海面等を拾いやすいので margin 20% 内側）
        const samplePositions = [];
        const NS = 6;
        const margin = 0.2; // 端20%を除外
        for (let r = 0; r <= NS; r++) {
          for (let c = 0; c <= NS; c++) {
            const tx = margin + (1 - 2 * margin) * c / NS;
            const ty = margin + (1 - 2 * margin) * r / NS;
            const g = gridToGeo(TW * tx, TH * ty);
            samplePositions.push(Cesium.Cartographic.fromDegrees(g.lng, g.lat));
          }
        }
        viewer.scene.sampleHeightMostDetailed(samplePositions).then(updated => {
          if (destroyed || viewer.isDestroyed()) return;
          const heights = updated.map(p => p.height).filter(h => h != null && h > -500 && h < 10000);
          if (heights.length > 0) {
            // 中央値を使用（フィールド全体の代表高度）
            heights.sort((a, b) => a - b);
            const medianIdx = Math.floor(heights.length / 2);
            const groundH = heights[medianIdx];
            console.log(`3D Tiles地表面: 中央値=${groundH.toFixed(2)}m (${heights.length}点, 範囲:${heights[0].toFixed(1)}～${heights[heights.length - 1].toFixed(1)}m)`);
            viewer._siteBaseElevation = groundH;
            setLocalBaseElev(groundH); // nodeEntities useEffectを再トリガー → アイコン位置をwireに合わせる
            if (onBaseElevChange) onBaseElevChange(groundH);
            buildBldEntities(viewer, _blds, groundH, true);
            viewer.scene.requestRender();
            // 各建屋の周辺地表面をサンプルして個別に高さ補正
            adjustBldGroundLevel(viewer, _blds, groundH);
          } else {
            console.warn('3D Tiles地表面サンプル: 有効な高さなし');
          }
        }).catch(e => {
          console.warn('sampleHeightMostDetailed失敗:', e.message);
        });
      }

      // サイト範囲の境界線 — Primitive使用（viewer.entities polyline → GeometryVisualizerのフレームごと処理を排除）
      const savedPoly = getSavedFieldPolygon();
      const _bndH = baseElevation + 5; // 地表面より5m上固定（clampToGround不使用）
      const _mkBndPrim = (degsArr, color) => {
        const hArr = [];
        for (let i = 0; i < degsArr.length; i += 2) hArr.push(degsArr[i], degsArr[i + 1], _bndH);
        viewer.scene.primitives.add(new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.PolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(hArr),
              width: 2,
              vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
          }),
          appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
          asynchronous: false,
        }));
      };
      if (savedPoly) {
        const fieldDegs = [];
        savedPoly.forEach(p => { fieldDegs.push(p.lng, p.lat); });
        fieldDegs.push(savedPoly[0].lng, savedPoly[0].lat);
        _mkBndPrim(fieldDegs, Cesium.Color.YELLOW.withAlpha(0.5));
        const c00 = gridToGeo(0, 0), c10 = gridToGeo(TW, 0);
        const c11 = gridToGeo(TW, TH), c01 = gridToGeo(0, TH);
        _mkBndPrim([c00.lng, c00.lat, c10.lng, c10.lat, c11.lng, c11.lat, c01.lng, c01.lat, c00.lng, c00.lat], Cesium.Color.CYAN.withAlpha(0.6));
      } else {
        const c00 = gridToGeo(0, 0), c10 = gridToGeo(TW, 0);
        const c11 = gridToGeo(TW, TH), c01 = gridToGeo(0, TH);
        _mkBndPrim([c00.lng, c00.lat, c10.lng, c10.lat, c11.lng, c11.lat, c01.lng, c01.lat, c00.lng, c00.lat], Cesium.Color.YELLOW.withAlpha(0.5));
      }

      // カメラを敷地中心へ（標高・スケールに合わせた高度）
      const center = gridToGeo(TW / 2, TH / 2);
      const camAlt = Math.max(1200, TH * METERS_PER_PX * 1.5);
      if (mode === '2d') {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, baseElevation + camAlt),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-87), roll: 0 },
          duration: 0,
        });
        viewer.resolutionScale = window.devicePixelRatio || 1;
      } else {
        // 【3Dは敷地中心を斜めから注視する・2026-10-12 ユーザー報告／Codex監査 01a12e53】
        //   「明らかに2Dだね。ポリゴンで表示されないもん」
        //   調べると 3DTiles（Ion 2275207 = Google Photorealistic）は**出ていた**。
        //   tileset.show を false にすると画面が真っ黒になる（166KB→18KB）ので、
        //   あの絵はタイルそのもの。描画中20枚・読み込み済み176枚。
        //   つまり『出ていない』のではなく、**高度1200m・-70°だと立体メッシュが
        //   真上からの航空写真にしか見えない**だけだった（実測: -25°/350m で街並みと空が出る）。
        //   【lookAt は参照系に入る】直後に lookAtTransform(IDENTITY) で必ず解除する。
        //     忘れると以後の move/rotate/setView がその系に縛られる（Codex）。
        //   -40° は中ボタンorbitのクランプ窓（CM_PITCH_MIN 〜 CM_PITCH_MAX）の内側。
        //   2D の窓（-87°）は触らない。
        viewer.camera.lookAt(
          Cesium.Cartesian3.fromDegrees(center.lng, center.lat, baseElevation),
          new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), camAlt * 1.3));
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        viewer.resolutionScale = window.devicePixelRatio || 1;
        // 3D: タイルストリーミング開始を待って複数回レンダーをリクエスト
        [500, 1000, 2000, 3000, 5000].forEach(ms => setTimeout(() => {
          if (!viewer.isDestroyed()) {
            viewer.scene.requestRender();
            const n = viewer._tileset3d?.statistics?.numberOfTilesLoaded ?? 0;
            console.log(`[3D] ${ms}ms後 タイル読み込み数=${n}`);
          }
        }, ms));
      }

      initDoneRef.current = true;
      setInitDone(true);
      // 【描画ループはアプリが持つ・2026-10-16】例外の2つの出口を1つの受け口に集める
      _cesiumStartOwnLoop(viewer, containerRef.current, mode);

      // Cesiumレンダーエラーを捕捉して抑制（0×0キャンバス初期化時の一時的エラー）
      viewer.scene.renderError.addEventListener((scene, error) => {
        // 【控えるのはここ1か所・2026-10-16】message だけ出すと [object Object] になって
        //   発生源が消える。型・鍵・stack まで分けて控える
        _cesiumNoteError(error, 'renderError', mode);
        // 自前ループのときは、投げ直された同じ例外を catch 側が受けて面倒を見る
        if (viewer && viewer._ownLoop) return;
        // renderLoopを再起動（Cesiumはエラー後にrenderLoopを停止するため）
        if (viewer && !viewer.isDestroyed()) {
          viewer.useDefaultRenderLoop = false;
          setTimeout(() => {
            if (viewer && !viewer.isDestroyed()) {
              if (dragStateRef?.current) {
                console.warn('[CESIUM_RENDER_LOOP_BLOCKED] drag中のため再開しない');
              } else {
                console.warn('[CESIUM_RENDER_LOOP_RESUMED] renderError後に再開');
                viewer.useDefaultRenderLoop = true;
              }
            }
          }, 500);
        }
      });

      // キャンバスが0×0で初期化された場合の強制リサイズ
      // (FloatWin描画前にCesiumが初期化されるタイミング問題の対策)
      const _forceResize = () => {
        if (!viewer || viewer.isDestroyed()) return;
        const canvas = viewer.scene.canvas;
        if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
          viewer.resize();
          viewer.scene.requestRender();
        } else {
          // まだ0×0なら再試行
          requestAnimationFrame(_forceResize);
        }
      };
      requestAnimationFrame(_forceResize);

    };

    waitForSize(() => init().catch(e => console.error('Cesium init error:', e)));

    return () => {
      destroyed = true;
      _cesiumStopOwnLoop(viewerRef.current);   // 先に rAF を止める（2026-10-16）
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      initDoneRef.current = false;
      setInitDone(false);
    };
  }, []);

  // マウス座標表示
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction((movement) => {
      const scene = v.scene;
      let cartesian;
      if (scene.mode === Cesium.SceneMode.SCENE3D) {
        // 3Dモード: 3DTilesまたは地形からピック
        cartesian = scene.pickPosition(movement.endPosition);
        if (!cartesian) {
          const ray = v.camera.getPickRay(movement.endPosition);
          if (ray) cartesian = scene.globe.pick(ray, scene);
        }
      } else {
        const ray = v.camera.getPickRay(movement.endPosition);
        if (ray) cartesian = scene.globe.pick(ray, scene);
      }
      if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        setCoordInfo({
          lat: Cesium.Math.toDegrees(carto.latitude),
          lng: Cesium.Math.toDegrees(carto.longitude),
          alt: carto.height,
        });
      } else {
        setCoordInfo(null);
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    return () => handler.destroy();
  }, [initDoneRef.current]);

  // フィールド描画モードのクリックハンドラ
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || !fieldDrawMode) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const pickPos = (pos) => {
      let cartesian = v.scene.pickPosition(pos);
      if (!cartesian) {
        const ray = v.camera.getPickRay(pos);
        if (ray) cartesian = v.scene.globe.pick(ray, v.scene);
      }
      if (!cartesian) return null;
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      return { lat: Cesium.Math.toDegrees(c.latitude), lng: Cesium.Math.toDegrees(c.longitude) };
    };
    handler.setInputAction((click) => {
      const pt = pickPos(click.position);
      if (!pt) return;
      setFieldDrawPts(prev => {
        // 閉ループ判定: 3点以上で最初の点の画面上20px以内なら閉じる
        if (prev.length >= 3) {
          const first = prev[0];
          const firstCart = Cesium.Cartesian3.fromDegrees(first.lng, first.lat, 0);
          const firstScreen = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, firstCart);
          if (firstScreen) {
            const dx = click.position.x - firstScreen.x;
            const dy = click.position.y - firstScreen.y;
            if (Math.sqrt(dx * dx + dy * dy) < 20) {
              const poly = [...prev];
              saveFieldPolygon(poly);
              // 非同期で確認ダイアログ（setState内では直接使えないのでsetTimeoutで脱出）
              setTimeout(() => {
                if (window.confirm('３次元図の表示領域をフィールドに合わせますか？')) {
                  // 原点と縮尺の式は cesiumUtils.js の fieldFrameFromPolygon 1か所（2026-11-22）。
                  // ここに式を書き写さない（国土地理院の窓も同じ commitFieldPolygon を通る）。
                  commitFieldPolygon(poly);
                }
              }, 0);
              return [];
            }
          }
        }
        return [...prev, pt];
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  }, [fieldDrawMode, initDoneRef.current]);

  // フィールド描画中のマーカー・ライン表示を同期
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    const fdr = fieldDrawRef.current;
    // 既存マーカー削除
    fdr.entities.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
    if (fdr.lineEnt && v.entities.contains(fdr.lineEnt)) v.entities.remove(fdr.lineEnt);
    fdr.entities = [];
    fdr.lineEnt = null;
    if (!fieldDrawMode || fieldDrawPts.length === 0) return;
    // マーカー描画
    fieldDrawPts.forEach((p, i) => {
      const ent = v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 10),
        point: {
          pixelSize: i === 0 ? 10 : 7,
          color: i === 0 ? Cesium.Color.LIME : Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        },
      });
      fdr.entities.push(ent);
    });
    // ライン描画
    if (fieldDrawPts.length >= 2) {
      const degs = [];
      fieldDrawPts.forEach(p => { degs.push(p.lng, p.lat); });
      const lineEnt = v.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(degs),
          width: 2,
          material: Cesium.Color.LIME.withAlpha(0.8),
          clampToGround: true,
        },
      });
      fdr.lineEnt = lineEnt;
    }
  }, [fieldDrawPts, fieldDrawMode]);

  // ══ 配置済み配電盤：アウトライン＋名称ラベル ══
  // 【描くのは外形と名前だけ】盤の中身（仕切り・扉・アイコン・配線）は平面図/3次元図/
  // 配電盤エディタが描く。地図の役目は「どこに何があるか」なので、外形と名前に絞る。
  // 【色は共通コアから取る】pdcPanelColor が唯一の正。ここに固定色を書かない（CLAUDE.md）。
  // 【幾何は panelPlacementCore.js から取る】mm→ワールドの式をここに書かない。
  // 2D は平面のポリゴン、3D は extrudedHeight で高さを持たせる。根拠（寸法・位置・回転・色）は
  // 同じで、見せ方だけがモードで違う。
  useEffect(() => {
    placedPanelsRef.current = placedPanels;   // CallbackProperty が読む最新値を先に更新する
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    // ★ドラッグ中は作り直さない（2026-09-01）
    //   毎フレーム remove→add すると、ポリゴンの形状生成が非同期なため本体だけ追いつかず、
    //   位置が同期更新されるラベルだけが動いて「本体が置き去り」に見える。
    //   形状は下の CallbackProperty がフレームごとに追従するので、作り直す必要がない。
    if (panelDragRef.current) return;
    // 前回ぶんを必ず片付ける。建物の _bldEntities とは混ぜない（寿命が別）
    if (v._panelEntities) v._panelEntities.forEach(e => { if (e && v.entities.contains(e)) v.entities.remove(e); });
    v._panelEntities = [];
    if (typeof ppcFootprintPx !== 'function') return;   // コア未ロード時は何もしない
    const baseElev = v._siteBaseElevation || 0;
    const is3d = modeRef.current === '3d';
    for (const pp of (placedPanels || [])) {
      if (!pp || !isFinite(pp.wx) || !isFinite(pp.wy)) continue;
      const span = ppcHeightSpan(pp);
      const xf = ppcMakeXf(pp);
      const colHex = (typeof pdcPanelColor === 'function' ? pdcPanelColor(pp.panelData) : null) || '#94A3B8';
      const col = Cesium.Color.fromCssColorString(colHex);
      const sel = selectedPlacedPanelId === pp.id;
      // 常に最新の盤を読む。ドラッグ中はエフェクトが再実行されないので、
      // ここが唯一の追従経路になる（見つからなければ作成時の値で描く）
      const _ppId0 = pp.id;
      const _live = () => (placedPanelsRef.current || []).find(q => q.id === _ppId0) || pp;
      const _hierarchyOf = (lp) => {
        const dg = [];
        ppcFootprintPx(lp).forEach(q => { const g = gridToGeo(q.x, q.y); dg.push(g.lng, g.lat); });
        return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(dg));
      };
      const ent = v.entities.add({
        polygon: {
          // CallbackProperty にすると、形状を作り直さずフレームごとに評価される。
          // 第2引数 false = 毎フレーム変わり得る（true にすると1回しか読まれない）
          hierarchy: new Cesium.CallbackProperty(() => _hierarchyOf(_live()), false),
          material: col.withAlpha(sel ? 0.55 : 0.35),
          outline: true,
          outlineColor: sel ? Cesium.Color.fromCssColorString('#F59E0B') : col,
          outlineWidth: 2,
          // 3D は盤の高さぶん立ち上げる。2D は地表に貼る
          height: is3d ? baseElev + span.zMinM : undefined,
          extrudedHeight: is3d ? baseElev + span.zMaxM : undefined,
          heightReference: is3d ? undefined : Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      ent._placedPanelId = pp.id;   // ピック時に盤を特定するための最小メタ情報
      v._panelEntities.push(ent);
      // 名称ラベル。中心の求め方は panelPlacementCore.js（角ではなく回転中心）
      // 本体と同じく CallbackProperty で追従させる。片方だけ追従すると
      // 「ラベルだけ動いて本体が置き去り」になる（2026-09-01に実際に起きた症状）
      const lbl = v.entities.add({
        position: new Cesium.CallbackProperty(() => {
          const lp = _live();
          const p2 = ppcPivot(lp);
          const g2 = gridToGeo(p2.pivWx, p2.pivWy);
          return Cesium.Cartesian3.fromDegrees(g2.lng, g2.lat, baseElev + (is3d ? span.zMaxM : 0) + 0.5);
        }, false),
        label: {
          text: pp.instanceName || (pp.panelData && pp.panelData.name) || '配電盤',
          font: '12px sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -4),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: is3d ? undefined : Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      lbl._placedPanelId = pp.id;
      v._panelEntities.push(lbl);

      // 扉：クリックで開閉できるようピック可能な面を置く。
      // 【2Dには作らない】扉は垂直面なので真上から見る2Dでは線に潰れて掴めない。
      // 2Dは盤本体のクリック（選択）だけを受け持ち、開閉は3Dで行う。
      // 【扉非表示なら作らない】エディタで非表示にした扉が選択・開閉できてしまうのを防ぐ
      //（3次元図の _pde_panelSVGElems と同じ扱い）。
      if (is3d && typeof pdcDoorCorners === 'function'
          && pp.panelData && pp.panelData.doorsVisible !== false) {
        const doors = pp.panelData.doors || [];
        for (let di = 0; di < doors.length; di++) {
          const corners = pdcDoorCorners(doors[di], pp.panelData);
          if (!corners || corners.length < 3) continue;
          // 【扉は盤に乗っている】盤が動いたら扉も動かないと取り残される。
          // 本体・ラベルと同じく、乗り先（＝盤の最新値）を毎フレーム読む（14.41 と同じ型の話）
          const _doorHierarchy = () => {
            const lp = _live();
            const xf2 = ppcMakeXf(lp);
            const dh = [];
            for (const c of corners) {
              const w = xf2.toM(c[0], c[1], c[2]);   // 高さはメートル（Cesiumに渡す単位）
              if (!isFinite(w[0]) || !isFinite(w[1]) || !isFinite(w[2])) return null;
              const g = gridToGeo(w[0], w[1]);
              dh.push(g.lng, g.lat, baseElev + w[2]);
            }
            return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArrayHeights(dh));
          };
          if (!_doorHierarchy()) continue;   // 作成時点で壊れている扉は置かない
          const dSel = selectedDoorKey === (pp.id + '_' + di);
          const dEnt = v.entities.add({
            polygon: {
              hierarchy: new Cesium.CallbackProperty(() => _doorHierarchy(), false),
              perPositionHeight: true,   // 垂直面なので地表に貼らず、そのままの高さで描く
              material: dSel ? Cesium.Color.fromCssColorString('#F59E0B').withAlpha(0.5)
                             : col.withAlpha(doors[di].isOpen ? 0.15 : 0.45),
              outline: true,
              outlineColor: dSel ? Cesium.Color.fromCssColorString('#F59E0B') : col,
            },
          });
          dEnt._panelDoor = { panelId: pp.id, doorIdx: di };   // ピック時の最小メタ情報
          v._panelEntities.push(dEnt);
        }
      }
    }
    // ── 建物内部の機器（floor.icons）──
    // 【盤と同じ層に入れる】どちらも「建物に付随して地図に出る箱」で、寿命も同じ。
    // 別配列に分けると、片方だけ消し忘れる事故が起きる。
    // 幾何は buildingCore の bcIconAnchorGeom が唯一の実装。ここで壁の向きや寸法を再計算しない。
    // 【単位】bcIconAnchorGeom の z はメートル、x,y はグリッドpx。Cesium の高さはメートルなのでそのまま使う。
    if (typeof bcIconAnchorGeom === 'function') {
      for (const b of (buildingsFull || [])) {
        for (const fl of (b.floors || [])) {
          for (const ic of (fl.icons || [])) {
            let g = null;
            try { g = bcIconAnchorGeom(b, fl, ic); } catch (_) { g = null; }
            if (!g) continue;
            // 既定色は建屋エディタ・3次元図と同じ定義（床置き=水色／壁・扉付け=琥珀）。独自色を書かない
            const colHex = ic.color || (bcIsFloorIcon(ic) ? BC_FLOOR_ICON_DEFAULTS.color : BC_ICON_DEFAULTS.color);
            const col2 = Cesium.Color.fromCssColorString(colHex);
            let ent2 = null;
            if (g.poly && g.poly.length >= 3) {
              // 床置きも壁・扉付けも同じ箱＝底面の輪郭（poly）を zB〜zT に立ち上げる（2026-09-11）
              const dg = [];
              g.poly.forEach(p => { const q = gridToGeo(p.x, p.y); dg.push(q.lng, q.lat); });
              ent2 = v.entities.add({ polygon: {
                hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(dg)),
                // 【中身が透けない濃さにする】薄いと骨組みだけに見える（2026-08-31 ユーザー指摘）
                material: col2.withAlpha(0.95), outline: true, outlineColor: Cesium.Color.fromCssColorString('#0F172A'),
                height: is3d ? baseElev + (g.zB || 0) : undefined,
                extrudedHeight: is3d ? baseElev + (g.zT || 0) : undefined,
                heightReference: is3d ? undefined : Cesium.HeightReference.CLAMP_TO_GROUND,
              } });
            }
            if (ent2) { ent2._buildingIconId = ic.id; v._panelEntities.push(ent2); }
          }
        }
      }
    }
    if (v.scene) v.scene.requestRender();

    // ══ 診断フック（2026-08-31）══
    // Cesium はこちら側でヘッドレス検証ができない（Ionトークンが要る）ため、
    // 実機から状態を1行で取れるようにしておく。コンソールで `__panelDiag()` を呼ぶ。
    // 【本番の挙動は変えない】参照を置いて読み取るだけ。
    if (typeof window !== 'undefined') {
      v._diagMode = modeRef.current;
      // 「盤が何台あるか」が最重要。これが0なら掴む対象が無いので操作は全部できない
      v._diagPlaced = (placedPanels || []).map(p => ({
        id: p.id, 名前: p.instanceName || (p.panelData && p.panelData.name) || null,
        wx: p.wx, wy: p.wy, wz: p.wz, 寸法mm: p.panelData
          ? [p.panelData.widthMm, p.panelData.depthMm, p.panelData.heightMm] : null,
      }));
      const reg = (window.__cesiumViewers = window.__cesiumViewers || []);
      if (!reg.includes(v)) reg.push(v);
    }
  }, [placedPanels, selectedPlacedPanelId, selectedDoorKey, mode, buildingsFull, panelRebuildTick]);

  // ══ 配置済み配電盤のクリック ══
  // 扉なら開閉（判定と2段階の作法は App の handleDoorClick が唯一の実装）、盤本体なら選択。
  // 【既存のクリック処理を壊さない】拾った entity が盤・扉でなければ何もしないで抜ける。
  // 【必ず destroy する】Cesium のハンドラはコンポーネントの外に残るので、
  // 後片付けを忘れると盤を開き直すたびにハンドラが積み上がって多重発火する。
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;
    if (!onDoorClick && !onSelectPlacedPanel) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction((click) => {
      const picked = v.scene.pick(click.position);
      const ent = picked && picked.id;
      if (ent && ent._panelDoor && onDoorClick) {
        onDoorClick(ent._panelDoor.panelId, ent._panelDoor.doorIdx);
        v.scene.requestRender();
        return;
      }
      if (ent && ent._placedPanelId && onSelectPlacedPanel) {
        onSelectPlacedPanel(ent._placedPanelId);
        v.scene.requestRender();
        return;
      }
      // 【何もない所（または盤以外）をクリックしたら選択解除】2026-09-01
      //   解除する手段が無く「選択したら外せない」状態だった。
      //   ドラッグの直後は解除しない（動かした後に選択が消えると掴み直せない）。
      if (onSelectPlacedPanel && !panelDragMovedRef.current) {
        onSelectPlacedPanel(null);
        v.scene.requestRender();
      }
      panelDragMovedRef.current = false;
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  }, [onDoorClick, onSelectPlacedPanel, initDoneRef.current]);

  // 建屋追加モード: 3D建物の屋上をクリック → 屋上面=上面、地面=下面の箱を生成
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || !bldAddMode) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const baseElev = v._siteBaseElevation || 0;
    // 画面に映っている表面座標を取得（3D Tiles屋上含む）
    const pickSurface = (pos) => {
      // カメラレイとフィールド地面接平面（baseElev高さ）との交点を使用
      // globe.pick/pickEllipsoidを使わず、カーソルピクセル→レイ→平面交点の純粋な計算で
      // 3D構造物・楕円体高度オフセットによるズレを完全に排除する
      const ray = v.camera.getPickRay(pos);
      if (!ray) return null;
      const baseElev = v._siteBaseElevation || 0;
      // フィールド中心での地表接平面を基準平面とする
      const _cg = gridToGeo(TW / 2, TH / 2);
      const _cc = Cesium.Cartesian3.fromDegrees(_cg.lng, _cg.lat, baseElev);
      const _n = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(_cc);
      const _plane = Cesium.Plane.fromPointNormal(_cc, _n);
      const _hit = Cesium.IntersectionTests.rayPlane(ray, _plane);
      if (!_hit) return null;
      const c = Cesium.Cartographic.fromCartesian(_hit);
      return {
        lat: Cesium.Math.toDegrees(c.latitude),
        lng: Cesium.Math.toDegrees(c.longitude),
        alt: baseElev,
      };
    };
    const finalize = (pts) => {
      if (pts.length < 3 || !onAddBuilding) return;
      let zTop = 40; // デフォルト40m
      if (mode === '3d') {
        const avgAlt = pts.reduce((s, p) => s + p.alt, 0) / pts.length;
        const est = Math.round(avgAlt - baseElev);
        if (est >= 5) zTop = est;
      }
      // geo座標→グリッド座標（浮動小数点のまま保持）
      // ユーザーのクリック順をそのまま保持（角度ソートしない）
      const gridPts = pts.map(p => {
        const g = geoToGrid(p.lat, p.lng);
        return { x: g.x, y: g.y };
      });
      // CCW(反時計回り)に統一（面法線の一貫性のため）
      const area2 = gridPts.reduce((s, p, i) => {
        const q = gridPts[(i + 1) % gridPts.length];
        return s + (p.x * q.y - q.x * p.y);
      }, 0);
      if (area2 > 0) gridPts.reverse(); // CW→CCWに反転
      onAddBuilding(gridPts, zTop);
      setBldAddPts([]);
    };
    // Altキー状態をトラック（スナップ無効化用）
    let altDown = false;
    const onKeyDown = (e) => { if (e.key === 'Alt') { altDown = true; e.preventDefault(); } };
    const onKeyUp = (e) => { if (e.key === 'Alt') altDown = false; };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    // 始点スナップ: 画面上20px以内なら始点座標に吸い付く
    const SNAP_PX = 20;
    const snapToStart = (pt, prev, screenPos) => {
      // 【一時解除】判定は snapGate.js が唯一の実装。ここは1行見るだけ（2026-09-03）
      if (typeof snapSuppressed === 'function' && snapSuppressed()) return null;
      if (prev.length < 2) return null;
      const first = prev[0];
      // 実際の標高を使用（alt=0では地形高度がある場合にスクリーン座標がずれる）
      const fc = Cesium.Cartesian3.fromDegrees(first.lng, first.lat, first.alt || 0);
      const fs = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, fc);
      if (!fs) return null;
      const dx = screenPos.x - fs.x, dy = screenPos.y - fs.y;
      if (Math.sqrt(dx * dx + dy * dy) < SNAP_PX) {
        return { ...pt, lat: first.lat, lng: first.lng, _snappedStart: true };
      }
      return null;
    };
    // 【直角の吸い付きの規則は geometry.js の perpSnap2D 1つ・2026-11-28】
    //   国土地理院の窓で点をつないで範囲を決めるときも同じ規則を使う（同じ規則を2か所に書かない）。
    //   ここでは緯度経度を、直前の点を原点にしたメートルの平面（経度に cos(緯度) を掛ける）に直して渡すだけ。
    //   置き換え前と同じ答えになることは checks/perp_snap_same.cjs で突き合わせる。
    const computeSnap = (pt, prev) => {
      const result = { target: pt, snap90: false, snapClose90: false };
      // 【一時解除】判定は snapGate.js が唯一の実装。ここは1行見るだけ（2026-09-03）
      // 以前は呼び出し側の1箇所だけ isAlt を見ていたが、ホバー中の候補線は素通りしていた
      if (typeof snapSuppressed === 'function' && snapSuppressed()) return result;
      if (prev.length < 2) return result;
      const pB = prev[prev.length - 1];
      const cosLat = Math.cos(pB.lat * Math.PI / 180);
      const toM = (p) => ({ x: (p.lng - pB.lng) * cosLat, y: p.lat - pB.lat });
      const q = toM(pt);
      const r = perpSnap2D(prev.map(toM), q);
      if (r.target === q) return { ...result, snap90: r.snap90, snapClose90: r.snapClose90 };
      return { target: { ...pt, lat: pB.lat + r.target.y, lng: pB.lng + r.target.x / cosLat }, snap90: r.snap90, snapClose90: r.snapClose90 };
    };
    // L字マーク描画ヘルパー
    const drawPerpMark = (corner, edgeFrom, edgeTo, cosLat) => {
      const eX = (corner.lng - edgeFrom.lng) * cosLat, eY = corner.lat - edgeFrom.lat;
      const el = Math.sqrt(eX * eX + eY * eY);
      if (el < 1e-12) return null;
      const sz = el * 0.15;
      const uX = eX / el, uY = eY / el;
      const tX = (edgeTo.lng - corner.lng) * cosLat, tY = edgeTo.lat - corner.lat;
      const tl = Math.sqrt(tX * tX + tY * tY);
      if (tl < 1e-12) return null;
      const vX = tX / tl, vY = tY / tl;
      const m1 = { lat: corner.lat - uY * sz, lng: corner.lng - uX * sz / cosLat };
      const m2 = { lat: m1.lat + vY * sz, lng: m1.lng + vX * sz / cosLat };
      const m3 = { lat: corner.lat + vY * sz, lng: corner.lng + vX * sz / cosLat };
      const _h = v._siteBaseElevation || 0;
      const _mat = Cesium.Color.LIME;
      return v.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            m1.lng, m1.lat, _h, m2.lng, m2.lat, _h, m3.lng, m3.lat, _h,
          ]),
          width: 2, material: _mat,
          depthFailMaterial: _mat, // 建物を透過して常に表示
          perPositionHeight: true,
        },
      });
    };
    // マウス移動: カーソル追従ライン + スナップインジケータ
    const previewRef = { ents: [] };
    const clearPreview = () => {
      previewRef.ents.forEach(e => { if (e && v.entities.contains(e)) v.entities.remove(e); });
      previewRef.ents = [];
    };
    handler.setInputAction((move) => {
      const pt = pickSurface(move.endPosition);
      clearPreview();
      const pts = bldAddPtsLatest.current;
      if (!pt || pts.length === 0) return;
      const last = pts[pts.length - 1];
      const isAlt = altDown;
      const cosLat = Math.cos(last.lat * Math.PI / 180);
      // 始点スナップ判定
      const startSnap = snapToStart(pt, pts, move.endPosition);
      // 統合スナップ判定
      const snap = computeSnap(pt, pts);
      let target = pt;
      let isStart = false;
      if (startSnap) {
        isStart = true;
        if (!isAlt) target = startSnap;
      } else if (snap.snap90 || snap.snapClose90) {
        if (!isAlt) target = snap.target;
      }
      const anySnap = isStart || snap.snap90 || snap.snapClose90;
      // カーソル追従ライン: サイト地上0m（baseElev）に固定し建物を透過して常に表示
      const _gh = v._siteBaseElevation || 0;
      const _mkLine = (lngs_lats, w, mat) => {
        const _hArr = []; for (let i=0;i<lngs_lats.length;i+=2) _hArr.push(lngs_lats[i],lngs_lats[i+1],_gh);
        return v.entities.add({ polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(_hArr),
          width: w, material: mat,
          depthFailMaterial: mat,   // 建物の裏側でも同じ色で描画（透過表示）
          perPositionHeight: true,
        }});
      };
      previewRef.ents.push(_mkLine(
        [last.lng, last.lat, target.lng, target.lat],
        anySnap ? 3 : 1.5,
        anySnap ? Cesium.Color.LIME : Cesium.Color.CYAN.withAlpha(0.6)
      ));
      // 閉辺プレビューライン（target→始点）
      if (pts.length >= 2 && !isStart) {
        const pS = pts[0];
        previewRef.ents.push(_mkLine(
          [target.lng, target.lat, pS.lng, pS.lat],
          snap.snapClose90 ? 2.5 : 1,
          snap.snapClose90 ? Cesium.Color.LIME.withAlpha(0.6) : Cesium.Color.CYAN.withAlpha(0.3)
        ));
      }
      // 始点スナップ: 始点ハイライト
      if (isStart) {
        previewRef.ents.push(v.entities.add({
          position: Cesium.Cartesian3.fromDegrees(pts[0].lng, pts[0].lat, _gh),
          point: {
            pixelSize: 14, color: Cesium.Color.LIME.withAlpha(0.5),
            outlineColor: Cesium.Color.LIME, outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }));
      }
      // 直前辺90° L字マーク（角: last, from: second-to-last, to: target）
      if (snap.snap90 && pts.length >= 2) {
        const mark = drawPerpMark(last, pts[pts.length - 2], target, cosLat);
        if (mark) previewRef.ents.push(mark);
      }
      // 閉辺90° L字マーク（角: target, from: last, to: start）
      if (snap.snapClose90 && pts.length >= 2 && !isStart) {
        const mark = drawPerpMark(target, last, pts[0], cosLat);
        if (mark) previewRef.ents.push(mark);
      }
      // wireCanvasの早期returnを防ぎ、Cesiumプレビューラインを見えるようにする
      _canvasDirtyRef.current = true;
      if (!v.isDestroyed()) v.scene.requestRender();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((click) => {
      // UIボタン等のオーバーレイクリックを除外（canvas以外はスキップ）
      const _canvas = v.scene.canvas;
      const _rect = _canvas.getBoundingClientRect();
      const _el = document.elementFromPoint(click.position.x + _rect.left, click.position.y + _rect.top);
      if (_el && _el.tagName !== 'CANVAS') return;
      const pt = pickSurface(click.position);
      if (!pt) return;
      // 全頂点を地上0m（GL基準）に固定: 建物屋上等のクリックを地上座標として扱う
      pt.alt = v._siteBaseElevation || 0;
      const isAlt = altDown;
      setBldAddPts(prev => {
        // 始点スナップ → 閉ループ確定
        if (!isAlt && prev.length >= 2) {
          const startSnap = snapToStart(pt, prev, click.position);
          console.warn('[BLD_ADD_CLICK]', { ptCount: prev.length, startSnap: !!startSnap, pt: `(${pt.lat.toFixed(6)},${pt.lng.toFixed(6)})` });
          if (startSnap) {
            console.warn('[BLD_ADD_CLOSE]', { ptCount: prev.length, pts: prev.map((p,i) => `p${i}(${p.lat.toFixed(5)},${p.lng.toFixed(5)})`) });
            finalize(prev);
            bldAddPtsLatest.current = [];
            return [];
          }
        }
        // 統合スナップ（Alt時は無効）
        const snap = isAlt ? { target: pt } : computeSnap(pt, prev);
        const next = [...prev, snap.target];
        bldAddPtsLatest.current = next;
        return next;
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // 右クリックで確定（3点以上）
    handler.setInputAction(() => {
      setBldAddPts(prev => {
        if (prev.length >= 3) { finalize(prev); bldAddPtsLatest.current = []; return []; }
        return prev;
      });
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    return () => {
      handler.destroy();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      clearPreview();
    };
  }, [bldAddMode, initDoneRef.current, onAddBuilding]);

  // ビルスキャンモード: クリック → 確認 → サンプリング → 輪郭検出
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || !bldScanMode) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const baseElev = v._siteBaseElevation || 0;
    handler.setInputAction((click) => {
      if (scanningRef.current || bldScanConfirmRef.current) return;
      let cartesian = v.scene.pickPosition(click.position);
      if (!cartesian) {
        const ray = v.camera.getPickRay(click.position);
        if (ray) cartesian = v.scene.globe.pick(ray, v.scene);
      }
      if (!cartesian) return;
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      const lat = Cesium.Math.toDegrees(c.latitude);
      const lng = Cesium.Math.toDegrees(c.longitude);
      const h = c.height || 0;
      const bldH = h - baseElev;
      setBldScanConfirm({ lat, lng, h, bldHeight: bldH, baseElev });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => {
      if (bldScanConfirmRef.current) { setBldScanConfirm(null); return; }
      setBldScanMode(false); setBldScanProgress(null);
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    return () => handler.destroy();
  }, [bldScanMode, initDoneRef.current]);

  // ビルスキャン実行関数
  const executeBldScan = useCallback(async () => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !bldScanConfirm) return;
    const { lat: clickLat, lng: clickLng, bldHeight, baseElev } = bldScanConfirm;
    setBldScanConfirm(null);
    scanningRef.current = true;
    const resConfigs = [
      { radius: 60, step: 4 },
      { radius: 50, step: 2.5 },
      { radius: 40, step: 1.5 },
      { radius: 30, step: 1 },
    ];
    const conf = resConfigs[bldScanRes] || resConfigs[1];
    const { radius, step } = conf;
    setBldScanProgress({ status: 'サンプリング中...', pct: 10 });
    const gridW = Math.ceil(radius * 2 / step) + 1;
    const gridH = gridW;
    const positions = [];
    for (let iy = 0; iy < gridH; iy++) {
      for (let ix = 0; ix < gridW; ix++) {
        const dx = -radius + ix * step;
        const dy = -radius + iy * step;
        positions.push(Cesium.Cartographic.fromDegrees(
          clickLng + dx / M_PER_DEG_LNG,
          clickLat + dy / M_PER_DEG_LAT
        ));
      }
    }
    try {
      const sampled = await v.scene.sampleHeightMostDetailed(positions);
      setBldScanProgress({ status: '輪郭検出中...', pct: 60 });
      // 高さマップ
      const heightMap = [];
      for (let iy = 0; iy < gridH; iy++) {
        const row = [];
        for (let ix = 0; ix < gridW; ix++) {
          const h = sampled[iy * gridW + ix].height;
          row.push(h != null ? h : baseElev);
        }
        heightMap.push(row);
      }
      // 地面より2m以上高い = 建物の一部とみなす
      const groundThreshold = baseElev + 2;
      const binaryMap = heightMap.map(row => row.map(h => h >= groundThreshold ? 1 : 0));
      const cix = Math.round(radius / step), ciy = Math.round(radius / step);
      // フラッドフィルでクリック地点に連結する領域を抽出
      const visited = binaryMap.map(row => row.map(() => false));
      const queue = [[cix, ciy]];
      if (!binaryMap[ciy] || binaryMap[ciy][cix] !== 1) {
        setBldScanProgress({ status: '建物を検出できませんでした', pct: 0 });
        setTimeout(() => { setBldScanProgress(null); scanningRef.current = false; }, 2000);
        return;
      }
      visited[ciy][cix] = true;
      const region = [];
      while (queue.length > 0) {
        const [qx, qy] = queue.shift();
        region.push([qx, qy]);
        for (const [nx, ny] of [[qx-1,qy],[qx+1,qy],[qx,qy-1],[qx,qy+1]]) {
          if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH && !visited[ny][nx] && binaryMap[ny][nx] === 1) {
            visited[ny][nx] = true;
            queue.push([nx, ny]);
          }
        }
      }
      if (region.length < 3) {
        setBldScanProgress({ status: '建物領域が小さすぎます', pct: 0 });
        setTimeout(() => { setBldScanProgress(null); scanningRef.current = false; }, 2000);
        return;
      }
      setBldScanProgress({ status: 'ポリゴン生成中...', pct: 80 });
      // 領域内の最大高さを建物高さとして使用
      let maxH = 0;
      region.forEach(([x, y]) => { const h = heightMap[y][x] - baseElev; if (h > maxH) maxH = h; });
      // 境界セル検出
      const regionSet = new Set(region.map(([x, y]) => x + ',' + y));
      const edgeCells = region.filter(([x, y]) =>
        [[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([nx, ny]) =>
          nx < 0 || nx >= gridW || ny < 0 || ny >= gridH || !regionSet.has(nx + ',' + ny)
        )
      );
      // 角度順ソート
      const rcx = edgeCells.reduce((s, [x]) => s + x, 0) / edgeCells.length;
      const rcy = edgeCells.reduce((s, [, y]) => s + y, 0) / edgeCells.length;
      edgeCells.sort((a, b) => Math.atan2(a[1] - rcy, a[0] - rcx) - Math.atan2(b[1] - rcy, b[0] - rcx));
      // Douglas-Peucker簡略化
      const dpSimplify = (pts, eps) => {
        if (pts.length <= 2) return pts;
        let md = 0, mi = 0;
        const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
        const ddx = ex - sx, ddy = ey - sy, len = Math.sqrt(ddx * ddx + ddy * ddy);
        for (let i = 1; i < pts.length - 1; i++) {
          const d = len > 0 ? Math.abs(ddx * (sy - pts[i][1]) - ddy * (sx - pts[i][0])) / len
                            : Math.sqrt((pts[i][0] - sx) ** 2 + (pts[i][1] - sy) ** 2);
          if (d > md) { md = d; mi = i; }
        }
        if (md > eps) {
          const l = dpSimplify(pts.slice(0, mi + 1), eps);
          const r = dpSimplify(pts.slice(mi), eps);
          return l.slice(0, -1).concat(r);
        }
        return [pts[0], pts[pts.length - 1]];
      };
      const simplified = dpSimplify(edgeCells, 1.0);
      if (simplified.length < 3) {
        setBldScanProgress({ status: '輪郭が単純すぎます', pct: 0 });
        setTimeout(() => { setBldScanProgress(null); scanningRef.current = false; }, 2000);
        return;
      }
      const gridPts = simplified.map(([gx, gy]) => {
        const mx = -radius + gx * step, my = -radius + gy * step;
        return geoToGrid(clickLat + my / M_PER_DEG_LAT, clickLng + mx / M_PER_DEG_LNG);
      });
      const estHeight = Math.max(5, Math.round(maxH));
      if (onAddBuilding) onAddBuilding(gridPts, estHeight);
      setBldScanProgress({ status: '完了! (' + simplified.length + '頂点, 高さ' + estHeight + 'm)', pct: 100 });
      setTimeout(() => { setBldScanProgress(null); scanningRef.current = false; }, 3000);
    } catch (e) {
      setBldScanProgress({ status: 'エラー: ' + e.message, pct: 0 });
      setTimeout(() => { setBldScanProgress(null); scanningRef.current = false; }, 3000);
    }
  }, [bldScanConfirm, bldScanRes, onAddBuilding]);

  // 建屋追加モードのプレビューマーカー・ライン
  useEffect(() => {
    bldAddPtsLatest.current = bldAddPts; // MOUSE_MOVEクロージャ用に同期
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    const ref = bldAddRef.current;
    ref.entities.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
    if (ref.lineEnt && v.entities.contains(ref.lineEnt)) v.entities.remove(ref.lineEnt);
    ref.entities = [];
    ref.lineEnt = null;
    if (!bldAddMode || bldAddPts.length === 0) return;
    const _siteH = v._siteBaseElevation || 0; // サイト地上0m = terrain最低標高
    bldAddPts.forEach((p, i) => {
      const ent = v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat, _siteH),
        point: {
          pixelSize: i === 0 ? 10 : 7,
          color: i === 0 ? Cesium.Color.CYAN : Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, // 建物で隠れない
        },
      });
      ref.entities.push(ent);
    });
    if (bldAddPts.length >= 2) {
      const degsH = [];
      bldAddPts.forEach(p => { degsH.push(p.lng, p.lat, _siteH); });
      degsH.push(bldAddPts[0].lng, bldAddPts[0].lat, _siteH);
      const _mat = Cesium.Color.CYAN.withAlpha(0.8);
      ref.lineEnt = v.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(degsH),
          width: 2,
          material: _mat,
          depthFailMaterial: _mat, // 建物の裏側でも表示（透過表示）
          perPositionHeight: true,
        },
      });
    }
  }, [bldAddPts, bldAddMode]);

  // ── 建物近傍クリップ: frustum.near + 地下-20m地面 + 衝突無効 ──
  const _undergroundFloorRef = useRef(null);
  const _midClickHandlerRef = useRef(null);
  const _floorCollisionRef = useRef(null);
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    if (_undergroundFloorRef.current) {
      const _ents = Array.isArray(_undergroundFloorRef.current)
        ? _undergroundFloorRef.current : [_undergroundFloorRef.current];
      _ents.forEach(e => { try { v.entities.remove(e); } catch (_) {} });
      _undergroundFloorRef.current = null;
    }
    if (_midClickHandlerRef.current) {
      try { _midClickHandlerRef.current.destroy(); } catch (_) {}
      _midClickHandlerRef.current = null;
    }
    if (_floorCollisionRef.current) {
      try {
        const { ctrl, orig } = _floorCollisionRef.current;
        if (ctrl && orig) ctrl.update = orig;
      } catch (_) {}
      _floorCollisionRef.current = null;
    }
    const _satAlphaNow = qualitySettingsRef.current?.satelliteAlpha ?? 1.0;
    const _showUnderground = nearClipDist > 0 || _satAlphaNow < 0.99;

    if (nearClipDist > 0) {
      // 3Dタイルセット: nearClip + satAlpha を統合シェーダーで適用
      if (v._tileset3d && !v._tileset3d.isDestroyed()) {
        v._currentNearClipValue = nearClipDist;
        _applyTilesetShader(v._tileset3d, _satAlphaNow, nearClipDist);
      }
      // 2Dモード（imageryLayers）: nearClipDist に比例して透明化
      for (let i = 0; i < v.imageryLayers.length; i++) {
        try { v.imageryLayers.get(i).alpha = Math.max(0, 1 - nearClipDist / 50); } catch (_) {}
      }
      // カメラ衝突無効 + 地下クランプ
      v.scene.screenSpaceCameraController.enableCollisionDetection = false;
      const _baseElevClip = (v._siteBaseElevation || 0) - 10;
      const _floorAlt = _baseElevClip + 1.0;
      const _ctrl = v.scene.screenSpaceCameraController;
      const _origUpdate = _ctrl.update.bind(_ctrl);
      _ctrl.update = function() {
        _origUpdate();
        if (v.isDestroyed()) return;
        try {
          const carto = Cesium.Cartographic.fromCartesian(v.camera.positionWC, Cesium.Ellipsoid.WGS84);
          if (!carto) return;
          if (carto.height < _floorAlt) {
            const upDir = Cesium.Cartesian3.normalize(v.camera.positionWC, new Cesium.Cartesian3());
            v.camera.move(upDir, _floorAlt - carto.height + 0.1);
          }
        } catch (_) {}
      };
      _floorCollisionRef.current = { ctrl: _ctrl, orig: _origUpdate };
    } else {
      // nearClipDist=0 → nearClip を 0 にして satAlpha のみのシェーダーに更新
      if (v._tileset3d && !v._tileset3d.isDestroyed()) {
        v._currentNearClipValue = 0;
        _applyTilesetShader(v._tileset3d, _satAlphaNow, 0);
      }
      // 2Dモード: satelliteAlpha で復元（1.0 固定に戻さない）
      for (let i = 0; i < v.imageryLayers.length; i++) {
        try { v.imageryLayers.get(i).alpha = _satAlphaNow; } catch (_) {}
      }
      v.scene.camera.frustum.near = 0.1;
      v.scene.screenSpaceCameraController.enableCollisionDetection = true;
    }

    // 地下フィールド: nearClipDist>0 OR マップが半透明のとき表示
    let _gridCamRemove = null;
    if (_showUnderground) {
      const _qs = qualitySettingsRef.current;
      const _depth = _qs?.undergroundDepth ?? 10;
      const _floorColor = _qs?.undergroundColor ?? '#000000';
      const _showGrid = _qs?.undergroundGrid ?? true;
      const _gridColorStr = _qs?.undergroundGridColor ?? '#FFFFFF';
      const _baseElev = (v._siteBaseElevation || 0) - _depth;
      const _slabThick = Math.max(40, _depth * 4);
      const _floorPos = [[0,0],[TW,0],[TW,TH],[0,TH]].map(([x,y]) => {
        const g = gridToGeo(x, y);
        return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, _baseElev);
      });
      const _gx = Math.max(1, Math.round(TW * METERS_PER_PX / 10));
      const _gy = Math.max(1, Math.round(TH * METERS_PER_PX / 10));
      const _ent1 = v.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(_floorPos),
          perPositionHeight: true,
          extrudedHeight: _baseElev - _slabThick,
          material: Cesium.Color.fromCssColorString(_floorColor).withAlpha(1.0),
        },
      });
      const _floorTop = [[0,0],[TW,0],[TW,TH],[0,TH]].map(([x,y]) => {
        const g = gridToGeo(x, y);
        return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, _baseElev + 0.05);
      });
      const _gridColor = Cesium.Color.fromCssColorString(_gridColorStr);
      const _ent2 = v.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(_floorTop),
          perPositionHeight: true,
          material: _showGrid
            ? new Cesium.GridMaterialProperty({
                color: _gridColor.withAlpha(1.0),
                cellAlpha: 0.0,
                lineCount: new Cesium.Cartesian2(_gx, _gy),
                lineThickness: new Cesium.Cartesian2(1.0, 1.0),
              })
            : Cesium.Color.fromCssColorString(_floorColor).withAlpha(1.0),
          outline: true,
          outlineColor: _gridColor.withAlpha(0.8),
        },
      });
      _undergroundFloorRef.current = [_ent1, _ent2];

      // カメラ高度でグリッド表示/非表示を切替（DistanceDisplayConditionはバウンディング球距離で不正確なためheight直接判定）
      const GRID_MAX_H = 200; // この高度(m)以下でグリッド表示
      const _updateGridVis = () => {
        if (_ent2.isDestroyed && _ent2.isDestroyed()) return;
        const h = v.camera.positionCartographic?.height ?? 9999;
        _ent2.show = h < GRID_MAX_H;
        v.scene.requestRender();
      };
      _updateGridVis(); // 初期判定
      _gridCamRemove = v.camera.changed.addEventListener(_updateGridVis);
    }

    v.scene.requestRender();
    return () => { try { _gridCamRemove && _gridCamRemove(); } catch (_) {} };
  }, [initDone, qualitySettings]);

  // ── 面で作図: クリックを面上に投影 ──
  const projectClickToFace = useCallback((clickPos) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !bldSelected) return null;
    const blk = (blds || [])[bldSelected.entIdx];
    if (!blk) return null;
    const face = bldSelected.face;
    const ray = v.camera.getPickRay(clickPos);
    if (!ray) return null;
    // 建屋ごとのローカル地表面標高を使用（レンダリングと一致させる）
    let baseElev = v._siteBaseElevation || 0;
    if (v.scene.globe && v.scene.globe.show) {
      const _pts = blk.points;
      const _cx = _pts.reduce((s, p) => s + p.x, 0) / _pts.length;
      const _cy = _pts.reduce((s, p) => s + p.y, 0) / _pts.length;
      const _g = gridToGeo(_cx, _cy);
      const _c = Cesium.Cartographic.fromDegrees(_g.lng, _g.lat);
      const _gh = v.scene.globe.getHeight(_c);
      if (_gh != null && _gh > -500) baseElev = _gh;
    }

    // ── solidFaceIdの場合: solid面の頂点で平面構築 ──
    if (bldSelected.solidFaceId && typeof face === 'string' && face.startsWith('f')) {
      const cs = (v._currentSolids) || [];
      const ts = cs.find(s => s.faces && s.faces.some(f => f.id === bldSelected.solidFaceId));
      const tf = ts ? ts.faces.find(f => f.id === bldSelected.solidFaceId) : null;
      if (!tf || !tf.vertices || tf.vertices.length < 3) return null;
      const sv = tf.vertices;
      // 非退化な3頂点でECEF平面構築
      const _toEcef = (p) => {
        const _g = gridToGeo(p.x, p.y);
        return Cesium.Cartesian3.fromDegrees(_g.lng, _g.lat, p.z + baseElev);
      };
      let c0 = null, c1 = null, c2 = null, normalEC = null;
      for (let i = 0; i < sv.length - 2 && !normalEC; i++) {
        for (let j = i + 1; j < sv.length - 1 && !normalEC; j++) {
          for (let k = j + 1; k < sv.length && !normalEC; k++) {
            const a = _toEcef(sv[i]), b = _toEcef(sv[j]), cc = _toEcef(sv[k]);
            const e1 = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
            const e2 = Cesium.Cartesian3.subtract(cc, a, new Cesium.Cartesian3());
            const n = Cesium.Cartesian3.cross(e1, e2, new Cesium.Cartesian3());
            if (Cesium.Cartesian3.magnitude(n) > 1e-6) {
              c0 = a; c1 = b; c2 = cc;
              Cesium.Cartesian3.normalize(n, n);
              normalEC = n;
            }
          }
        }
      }
      if (!normalEC) return null;
      const plane = Cesium.Plane.fromPointNormal(c0, normalEC);
      const hit = Cesium.IntersectionTests.rayPlane(ray, plane);
      if (!hit) return null;
      const carto = Cesium.Cartographic.fromCartesian(hit);
      const hitGeo = { lat: Cesium.Math.toDegrees(carto.latitude), lng: Cesium.Math.toDegrees(carto.longitude) };
      const grid = geoToGrid(hitGeo.lat, hitGeo.lng);
      let hitGx = grid.x, hitGy = grid.y;
      let hitGz = carto.height - baseElev;
      // エッジスナップ: 面ポリゴンの辺
      const pn = sv.length;
      let totalLen = 0;
      for (let i = 0; i < pn; i++) {
        const a = sv[i], b = sv[(i + 1) % pn];
        totalLen += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
      }
      const snapDist = (totalLen / pn) * 0.10;
      let bestDist = Infinity, bestPx = hitGx, bestPy = hitGy, bestPz = hitGz;
      for (let i = 0; i < pn; i++) {
        const a = sv[i], b = sv[(i + 1) % pn];
        const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
        const el2 = ex * ex + ey * ey + ez * ez;
        if (el2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((hitGx - a.x) * ex + (hitGy - a.y) * ey + (hitGz - a.z) * ez) / el2));
        const px = a.x + t * ex, py = a.y + t * ey, pz = a.z + t * ez;
        const d = Math.sqrt((hitGx - px) ** 2 + (hitGy - py) ** 2 + (hitGz - pz) ** 2);
        if (d < bestDist) { bestDist = d; bestPx = px; bestPy = py; bestPz = pz; }
      }
      if (bestDist < snapDist) { hitGx = bestPx; hitGy = bestPy; hitGz = bestPz; }
      // 頂点スナップ（優先）
      for (let i = 0; i < pn; i++) {
        const d = Math.sqrt((grid.x - sv[i].x) ** 2 + (grid.y - sv[i].y) ** 2 + ((carto.height - baseElev) - sv[i].z) ** 2);
        if (d < snapDist) { hitGx = sv[i].x; hitGy = sv[i].y; hitGz = sv[i].z; break; }
      }
      // ── 面ポリゴン内クランプ: 面外なら最近辺境界点に止める ──
      // (u,v) 座標系: v = cross(face.normal, u軸) → 水平面・垂直壁どちらでも正常動作
      if (tf && tf.normal) {
        let cBestI = 0, cBestDz = Infinity;
        for (let i = 0; i < pn; i++) {
          const a = sv[i], b = sv[(i + 1) % pn];
          const dz = Math.abs(b.z - a.z);
          const dxy = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
          if (dxy > 1e-6 && dz < cBestDz) { cBestDz = dz; cBestI = i; }
        }
        const cea = sv[cBestI], ceb = sv[(cBestI + 1) % pn];
        const cedx = ceb.x - cea.x, cedy = ceb.y - cea.y;
        const celen = Math.sqrt(cedx * cedx + cedy * cedy);
        if (celen > 1e-6) {
          const cux = cedx / celen, cuy = cedy / celen;
          // v軸 = cross(face.normal, u軸): 垂直壁→z方向、水平面→第2水平方向
          const cfn = tf.normal;
          const cvx = -cfn.nz * cuy, cvy = cfn.nz * cux, cvz = cfn.nx * cuy - cfn.ny * cux;
          const cvlen = Math.sqrt(cvx*cvx + cvy*cvy + cvz*cvz);
          if (cvlen > 1e-6) {
            const nvx = cvx/cvlen, nvy = cvy/cvlen, nvz = cvz/cvlen;
            const poly2d = sv.map(v => ({
              x: (v.x - cea.x) * cux + (v.y - cea.y) * cuy,
              y: (v.x - cea.x) * nvx + (v.y - cea.y) * nvy + (v.z - cea.z) * nvz,
            }));
            const u_hit = (hitGx - cea.x) * cux + (hitGy - cea.y) * cuy;
            const v_hit = (hitGx - cea.x) * nvx + (hitGy - cea.y) * nvy + (hitGz - cea.z) * nvz;
            if (!_pip2d(u_hit, v_hit, poly2d)) {
              const cl = _nearestOnPoly2d(u_hit, v_hit, poly2d);
              hitGx = cea.x + cl.x * cux + cl.y * nvx;
              hitGy = cea.y + cl.x * cuy + cl.y * nvy;
              hitGz = cea.z            + cl.y * nvz;
            }
          }
        }
      }
      return { gx: hitGx, gy: hitGy, gz: hitGz };
    }

    if (face === 'zTop' || face === 'zBottom') {
      // 水平面との交差
      // solidFaceIdがある場合: solid面の実頂点(L字形など)を使う
      let faceZ = face === 'zTop' ? (blk.zTop || 40) : (blk.zBottom || 0);
      let pts = blk.points;
      if (bldSelected.solidFaceId) {
        const _cs = (v._currentSolids) || [];
        const _ts = _cs.find(s => s.buildingId === bldSelected.buildingId);
        const _tf = _ts && _ts.faces.find(f => f.id === bldSelected.solidFaceId);
        if (_tf && _tf.vertices && _tf.vertices.length >= 3) {
          faceZ = _tf.vertices[0].z;
          pts = _tf.vertices.map(vt => ({ x: vt.x, y: vt.y }));
        }
      }
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const geoC = gridToGeo(cx, cy);
      const planePoint = Cesium.Cartesian3.fromDegrees(geoC.lng, geoC.lat, faceZ + baseElev);
      const normal = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.clone(planePoint), new Cesium.Cartesian3()
      ); // ECEF原点→面中心 ≒ 地表法線(上向き)
      const plane = Cesium.Plane.fromPointNormal(planePoint, normal);
      const hit = Cesium.IntersectionTests.rayPlane(ray, plane);
      if (!hit) return null;
      const carto = Cesium.Cartographic.fromCartesian(hit);
      const hitGeo = { lat: Cesium.Math.toDegrees(carto.latitude), lng: Cesium.Math.toDegrees(carto.longitude) };
      const grid = geoToGrid(hitGeo.lat, hitGeo.lng);
      // エッジスナップ: 実際のポリゴン辺に近いとき吸い寄せ
      let snapGx = grid.x, snapGy = grid.y;
      const pn = pts.length;
      // ポリゴンの辺長の平均 × 10% をスナップ閾値とする
      let totalLen = 0;
      for (let i = 0; i < pn; i++) {
        const a = pts[i], b = pts[(i + 1) % pn];
        totalLen += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      }
      const snapDist = (totalLen / pn) * 0.10;
      // 各辺への最近傍点を計算し、最も近い辺にスナップ
      let bestDist = Infinity, bestPx = snapGx, bestPy = snapGy;
      for (let i = 0; i < pn; i++) {
        const a = pts[i], b = pts[(i + 1) % pn];
        const ex = b.x - a.x, ey = b.y - a.y;
        const el2 = ex * ex + ey * ey;
        if (el2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((grid.x - a.x) * ex + (grid.y - a.y) * ey) / el2));
        const px = a.x + t * ex, py = a.y + t * ey;
        const d = Math.sqrt((grid.x - px) ** 2 + (grid.y - py) ** 2);
        if (d < bestDist) { bestDist = d; bestPx = px; bestPy = py; }
      }
      if (bestDist < snapDist) { snapGx = bestPx; snapGy = bestPy; }
      // 頂点スナップ: 頂点に近いとき頂点に吸い付く（辺スナップより優先）
      for (let i = 0; i < pn; i++) {
        const d = Math.sqrt((grid.x - pts[i].x) ** 2 + (grid.y - pts[i].y) ** 2);
        if (d < snapDist) { snapGx = pts[i].x; snapGy = pts[i].y; break; }
      }
      // ── 面ポリゴン内クランプ ──
      {
        const poly2d = pts.map(p => ({ x: p.x, y: p.y }));
        if (!_pip2d(snapGx, snapGy, poly2d)) {
          const cl = _nearestOnPoly2d(snapGx, snapGy, poly2d);
          snapGx = cl.x; snapGy = cl.y;
        }
      }
      return { gx: snapGx, gy: snapGy, gz: faceZ };
    } else {
      // 側面: 面平面との交差
      const pts = blk.points;
      const n = pts.length;
      const fi = typeof face === 'number' ? face : parseInt(face, 10);
      const p0 = pts[fi], p1 = pts[(fi + 1) % n];
      const geo0 = gridToGeo(p0.x, p0.y);
      const geo1 = gridToGeo(p1.x, p1.y);
      const zB = blk.zBottom || 0, zT = blk.zTop || 40;
      // 面の4隅
      const c0 = Cesium.Cartesian3.fromDegrees(geo0.lng, geo0.lat, zB + baseElev);
      const c1 = Cesium.Cartesian3.fromDegrees(geo1.lng, geo1.lat, zB + baseElev);
      const c3 = Cesium.Cartesian3.fromDegrees(geo0.lng, geo0.lat, zT + baseElev);
      // 面の法線
      const edgeDir = Cesium.Cartesian3.subtract(c1, c0, new Cesium.Cartesian3());
      const upDir = Cesium.Cartesian3.subtract(c3, c0, new Cesium.Cartesian3());
      const faceNormal = Cesium.Cartesian3.cross(upDir, edgeDir, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(faceNormal, faceNormal);
      const plane = Cesium.Plane.fromPointNormal(c0, faceNormal);
      const hit = Cesium.IntersectionTests.rayPlane(ray, plane);
      if (!hit) return null;
      // 面ローカル座標に変換
      const hitRel = Cesium.Cartesian3.subtract(hit, c0, new Cesium.Cartesian3());
      const edgeLen = Cesium.Cartesian3.magnitude(edgeDir);
      const edgeUnit = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.clone(edgeDir), new Cesium.Cartesian3()
      );
      const upLen = Cesium.Cartesian3.magnitude(upDir);
      const upUnit = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.clone(upDir), new Cesium.Cartesian3()
      );
      let u = Cesium.Cartesian3.dot(hitRel, edgeUnit);
      let vv = Cesium.Cartesian3.dot(hitRel, upUnit);
      // 面範囲にクランプ
      u = Math.max(0, Math.min(edgeLen, u));
      vv = Math.max(0, Math.min(upLen, vv));
      // エッジスナップ: 面の端に近いとき吸い寄せ（辺長の10%以内）
      const snapU = edgeLen * 0.10;
      const snapV = upLen * 0.10;
      if (u < snapU) u = 0;
      else if (u > edgeLen - snapU) u = edgeLen;
      if (vv < snapV) vv = 0;
      else if (vv > upLen - snapV) vv = upLen;
      // grid座標と高さに逆変換
      const tParam = edgeLen > 0 ? u / edgeLen : 0;
      const gx = p0.x + tParam * (p1.x - p0.x);
      const gy = p0.y + tParam * (p1.y - p0.y);
      const gz = zB + (upLen > 0 ? vv / upLen : 0) * (zT - zB);
      return { gx, gy, gz };
    }
  }, [bldSelected, blds]);

  // ── 面で作図モード: クリックハンドラ ──
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || faceSketchPhase !== 'draw') return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const closePolygon = (pts) => {
      if (pts.length < 3) return;
      setFaceSketchPhase('extrude'); // 押し出しフェーズへ
    };
    handler.setInputAction((click) => {
      const pt = projectClickToFace(click.position);
      if (!pt) return;
      setFaceSketchPts(prev => {
        // 3点以上で最初の点付近クリック→閉じる
        if (prev.length >= 3) {
          const first = prev[0];
          const firstGeo = gridToGeo(first.gx, first.gy);
          const baseElev = v._siteBaseElevation || 0;
          const fc = Cesium.Cartesian3.fromDegrees(firstGeo.lng, firstGeo.lat, first.gz + baseElev);
          const fs = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, fc);
          if (fs) {
            const dx = click.position.x - fs.x, dy = click.position.y - fs.y;
            if (Math.sqrt(dx * dx + dy * dy) < 15) {
              closePolygon(prev);
              return prev; // そのまま保持（extrudeフェーズで使う）
            }
          }
        }
        return [...prev, pt];
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => {
      setFaceSketchPts(prev => {
        if (prev.length >= 3) { closePolygon(prev); return prev; }
        return prev;
      });
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    return () => handler.destroy();
  }, [faceSketchPhase, initDoneRef.current, projectClickToFace]);

  // ── 矩形で突起モード: 2クリックで矩形 → 側面は統合ポリゴン、上下面は別ブロック ──
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || faceSketchPhase !== 'rectdraw') return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    // スナップカーソル: マウス移動時に○を表示（辺・角に吸い寄せ）
    // ※ プレビューエンティティはstateコールバック外で直接管理
    let firstPt = null; // 1点目のキャッシュ
    // 矩形4辺にラベル（辺あ〜辺え）を表示するヘルパー
    const _addRectLabels = (corners4, baseElev) => {
      if (v._snapRectLabelEnts) { v._snapRectLabelEnts.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); }); }
      v._snapRectLabelEnts = [];
      const lbls = ['辺あ','辺い','辺う','辺え'];
      for (let i = 0; i < 4; i++) {
        const a = corners4[i], b = corners4[(i+1)%4];
        const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, mz=(a.z+b.z)/2;
        const geo = gridToGeo(mx, my);
        v._snapRectLabelEnts.push(v.entities.add({
          position: Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, mz + baseElev),
          label: { text: lbls[i], font:'bold 14px sans-serif', fillColor:Cesium.Color.WHITE,
            outlineColor:Cesium.Color.BLACK, outlineWidth:2,
            style:Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance:Number.POSITIVE_INFINITY,
            pixelOffset:new Cesium.Cartesian2(0,-8) }
        }));
      }
    };
    handler.setInputAction((e) => {
      const pt = projectClickToFace(e.endPosition);
      // 前のカーソルを削除
      if (v._snapCursorEnt && v.entities.contains(v._snapCursorEnt)) {
        v.entities.remove(v._snapCursorEnt); v._snapCursorEnt = null;
      }
      if (v._snapRectPreview && v.entities.contains(v._snapRectPreview)) {
        v.entities.remove(v._snapRectPreview); v._snapRectPreview = null;
      }
      if (v._snapRectLabelEnts) { v._snapRectLabelEnts.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); }); v._snapRectLabelEnts = []; }
      if (!pt) return;
      const baseElev = v._siteBaseElevation || 0;
      // 建物描画と同じlocalBaseElevを使用
      let _localBase = baseElev;
      const _blk = bldSelected ? (blds || [])[bldSelected.entIdx] : null;
      if (_blk && v.scene.globe && v.scene.globe.show) {
        const _pts = _blk.points;
        const _cx = _pts.reduce((s, p) => s + p.x, 0) / _pts.length;
        const _cy = _pts.reduce((s, p) => s + p.y, 0) / _pts.length;
        const _g = gridToGeo(_cx, _cy);
        const _c = Cesium.Cartographic.fromDegrees(_g.lng, _g.lat);
        const _gh = v.scene.globe.getHeight(_c);
        if (_gh != null && _gh > -500) _localBase = _gh;
      }
      const geo = gridToGeo(pt.gx, pt.gy);
      const pos = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, pt.gz + _localBase);
      // スナップ判定
      const blk = bldSelected ? (blds || [])[bldSelected.entIdx] : null;
      let isSnapped = false;
      if (blk) {
        const face = bldSelected.face;
        // solidFaceIdがある場合は常にsolid面の実頂点でスナップ判定（zTop/zBottomも含む）
        if (bldSelected.solidFaceId) {
          const _cs2 = (v._currentSolids) || [];
          const _ts2 = _cs2.find(s => s.faces && s.faces.some(f => f.id === bldSelected.solidFaceId));
          const _tf2 = _ts2 ? _ts2.faces.find(f => f.id === bldSelected.solidFaceId) : null;
          if (_tf2 && _tf2.vertices && _tf2.vertices.length >= 3) {
            const sv2 = _tf2.vertices;
            const pn2 = sv2.length;
            let minD2 = Infinity, totalLen2 = 0;
            for (let i = 0; i < pn2; i++) {
              const a = sv2[i], b = sv2[(i + 1) % pn2];
              const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
              const el2 = ex * ex + ey * ey + ez * ez;
              totalLen2 += Math.sqrt(el2);
              if (el2 < 1e-12) continue;
              const t = Math.max(0, Math.min(1, ((pt.gx - a.x) * ex + (pt.gy - a.y) * ey + (pt.gz - a.z) * ez) / el2));
              const px = a.x + t * ex, py = a.y + t * ey, pz = a.z + t * ez;
              const d = Math.sqrt((pt.gx - px) ** 2 + (pt.gy - py) ** 2 + (pt.gz - pz) ** 2);
              if (d < minD2) minD2 = d;
            }
            isSnapped = minD2 < (totalLen2 / pn2) * 0.02;
          }
        } else if (face === 'zTop' || face === 'zBottom') {
          const bpts = blk.points;
          const pn = bpts.length;
          let minEdgeDist = Infinity;
          for (let i = 0; i < pn; i++) {
            const a = bpts[i], b = bpts[(i + 1) % pn];
            const ex = b.x - a.x, ey = b.y - a.y;
            const el2 = ex * ex + ey * ey;
            if (el2 < 1e-12) continue;
            const t = Math.max(0, Math.min(1, ((pt.gx - a.x) * ex + (pt.gy - a.y) * ey) / el2));
            const px = a.x + t * ex, py = a.y + t * ey;
            const d = Math.sqrt((pt.gx - px) ** 2 + (pt.gy - py) ** 2);
            if (d < minEdgeDist) minEdgeDist = d;
          }
          let totalLen = 0;
          for (let i = 0; i < pn; i++) {
            const a = bpts[i], b = bpts[(i + 1) % pn];
            totalLen += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
          }
          isSnapped = minEdgeDist < (totalLen / pn) * 0.02;
        } else if (typeof face === 'string' && face.startsWith('f')) {
          // solid面: 各辺との3D距離で判定
          const cs = (v._currentSolids) || [];
          const ts = cs.find(s => s.faces && s.faces.some(f => f.id === bldSelected.solidFaceId));
          const tf = ts ? ts.faces.find(f => f.id === bldSelected.solidFaceId) : null;
          if (tf && tf.vertices && tf.vertices.length >= 3) {
            const sv = tf.vertices;
            const pn = sv.length;
            let minD = Infinity, totalLen = 0;
            for (let i = 0; i < pn; i++) {
              const a = sv[i], b = sv[(i + 1) % pn];
              const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
              const el2 = ex * ex + ey * ey + ez * ez;
              totalLen += Math.sqrt(el2);
              if (el2 < 1e-12) continue;
              const t = Math.max(0, Math.min(1, ((pt.gx - a.x) * ex + (pt.gy - a.y) * ey + (pt.gz - a.z) * ez) / el2));
              const px = a.x + t * ex, py = a.y + t * ey, pz = a.z + t * ez;
              const d = Math.sqrt((pt.gx - px) ** 2 + (pt.gy - py) ** 2 + (pt.gz - pz) ** 2);
              if (d < minD) minD = d;
            }
            const tol = (totalLen / pn) * 0.02;
            isSnapped = minD < tol;
          }
        } else {
          const bpts = blk.points;
          const n = bpts.length;
          const fi = typeof face === 'number' ? face : parseInt(face, 10);
          if (!isNaN(fi) && fi >= 0 && fi < n) {
            const bp0 = bpts[fi], bp1 = bpts[(fi + 1) % n];
            const ex = bp1.x - bp0.x, ey = bp1.y - bp0.y;
            const elen = Math.sqrt(ex * ex + ey * ey);
            const edgeUx = ex / elen, edgeUy = ey / elen;
            const u = (pt.gx - bp0.x) * edgeUx + (pt.gy - bp0.y) * edgeUy;
            const zB = blk.zBottom || 0, zT = blk.zTop || 40;
            const tol = Math.min(elen, zT - zB) * 0.02;
            isSnapped = Math.abs(u) < tol || Math.abs(u - elen) < tol ||
                        Math.abs(pt.gz - zB) < tol || Math.abs(pt.gz - zT) < tol;
          }
        }
      }
      // ── 矩形選択中の「選択した面の座標」をログ（throttle: 500ms） ──
      if (blk) {
        const _now = Date.now();
        if (!v._lastFaceMoveLog || _now - v._lastFaceMoveLog > 500) {
          v._lastFaceMoveLog = _now;
          const _fmMsg = {
            event: '矩形選択中_面座標',
            buildingId: blk.buildingId, blockIdx: blk.blockIdx,
            face: bldSelected.face,
            zBottom: (blk.zBottom || 0).toFixed(2),
            zTop: (blk.zTop || 40).toFixed(2),
            親頂点: blk.points.map((p,i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
            isChild: blk._parentBlockIdx != null,
            isChild: blk._parentBlockIdx != null,
          };
          console.warn('[FACE_DURING_RECT] 矩形選択中の選択面座標', _fmMsg);
          if (!window._diagLog) window._diagLog = [];
          window._diagLog.push('[FACE_DURING_RECT] ' + JSON.stringify(_fmMsg));
          if (window._diagLog.length > 500) window._diagLog.splice(0, 100);
        }
      }
      v._snapCursorEnt = v.entities.add({
        position: pos,
        point: {
          pixelSize: isSnapped ? 16 : 10,
          color: isSnapped ? Cesium.Color.CYAN : Cesium.Color.WHITE.withAlpha(0.8),
          outlineColor: isSnapped ? Cesium.Color.WHITE : Cesium.Color.CYAN,
          outlineWidth: isSnapped ? 3 : 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      // 1点目選択済みなら矩形プレビュー（state外で直接管理）
      if (firstPt) {
        const face = bldSelected?.face;
        if (face === 'zTop' || face === 'zBottom') {
          const fz = pt.gz;
          // solidFaceIdがある場合はsolid面の実頂点(L字形など)を使う
          let bpts = blk.points;
          if (bldSelected?.solidFaceId) {
            const _cs3 = (v._currentSolids) || [];
            const _ts3 = _cs3.find(s => s.buildingId === bldSelected.buildingId);
            const _tf3 = _ts3 && _ts3.faces.find(f => f.id === bldSelected.solidFaceId);
            if (_tf3 && _tf3.vertices && _tf3.vertices.length >= 3) {
              bpts = _tf3.vertices.map(vt => ({ x: vt.x, y: vt.y }));
            }
          }
          const pn = bpts.length;
          // 1点目に最も近い辺を検出 → その方向を矩形の軸にする
          let bestEdgeIdx = 0, bestEdgeDist = Infinity;
          for (let i = 0; i < pn; i++) {
            const a = bpts[i], b = bpts[(i + 1) % pn];
            const ex = b.x - a.x, ey = b.y - a.y;
            const el2 = ex * ex + ey * ey;
            if (el2 < 1e-12) continue;
            const t = Math.max(0, Math.min(1, ((firstPt.gx - a.x) * ex + (firstPt.gy - a.y) * ey) / el2));
            const px = a.x + t * ex, py = a.y + t * ey;
            const d = Math.sqrt((firstPt.gx - px) ** 2 + (firstPt.gy - py) ** 2);
            if (d < bestEdgeDist) { bestEdgeDist = d; bestEdgeIdx = i; }
          }
          const ea = bpts[bestEdgeIdx], eb = bpts[(bestEdgeIdx + 1) % pn];
          const edx = eb.x - ea.x, edy = eb.y - ea.y;
          const edl = Math.sqrt(edx * edx + edy * edy);
          const ux = edx / edl, uy = edy / edl; // 辺方向の単位ベクトル
          const vx = -uy, vy = ux; // 垂直方向
          // 2点を辺座標系に投影
          const u1 = (firstPt.gx - firstPt.gx) * ux + (firstPt.gy - firstPt.gy) * uy; // = 0
          const v1 = (firstPt.gx - firstPt.gx) * vx + (firstPt.gy - firstPt.gy) * vy; // = 0
          const u2 = (pt.gx - firstPt.gx) * ux + (pt.gy - firstPt.gy) * uy;
          const v2 = (pt.gx - firstPt.gx) * vx + (pt.gy - firstPt.gy) * vy;
          // 矩形の4隅（辺座標系）
          const corners = [
            [0, 0], [u2, 0], [u2, v2], [0, v2]
          ];
          const degList = [];
          corners.forEach(([cu, cv]) => {
            const gx = firstPt.gx + cu * ux + cv * vx;
            const gy = firstPt.gy + cu * uy + cv * vy;
            const g = gridToGeo(gx, gy); degList.push(g.lng, g.lat);
          });
          // 矩形の辺が建物の辺と平行（=90°整列）かチェック
          const rectDirLen = Math.sqrt(u2 * u2 + v2 * v2);
          let isAligned = false;
          if (rectDirLen > 1e-6) {
            // 矩形の辺方向(ux,uy)はすでに建物辺に沿っている → 常にaligned
            isAligned = true;
          }
          v._snapRectPreview = v.entities.add({
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(degList),
              height: fz + _localBase - 0.1, extrudedHeight: fz + _localBase + 0.1,
              material: isAligned ? Cesium.Color.LIME.withAlpha(0.2) : Cesium.Color.CYAN.withAlpha(0.25),
              outline: true, outlineColor: isAligned ? Cesium.Color.LIME : Cesium.Color.CYAN,
            },
          });
          {
            const _zCorners = corners.map(([cu,cv]) => ({
              x: firstPt.gx + cu*ux + cv*vx,
              y: firstPt.gy + cu*uy + cv*vy,
              z: fz,
            }));
            _addRectLabels(_zCorners, _localBase);
          }
        } else if (bldSelected?.solidFaceId && typeof face === 'string' && face.startsWith('f')) {
          // solid壁面: 最も水平な辺を矩形の軸とする
          const cs = (v._currentSolids) || [];
          const ts = cs.find(s => s.faces && s.faces.some(f => f.id === bldSelected.solidFaceId));
          const tf = ts ? ts.faces.find(f => f.id === bldSelected.solidFaceId) : null;
          if (tf && tf.vertices && tf.vertices.length >= 3) {
            const sv = tf.vertices;
            const pn = sv.length;
            let bestI = 0, bestDz = Infinity;
            for (let i = 0; i < pn; i++) {
              const a = sv[i], b = sv[(i + 1) % pn];
              const dz = Math.abs(b.z - a.z);
              const dxy = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
              if (dxy > 1e-6 && dz < bestDz) { bestDz = dz; bestI = i; }
            }
            const ea = sv[bestI], eb = sv[(bestI + 1) % pn];
            const edx = eb.x - ea.x, edy = eb.y - ea.y;
            const elen = Math.sqrt(edx * edx + edy * edy);
            if (elen > 1e-6) {
              const edgeUx = edx / elen, edgeUy = edy / elen;
              // v軸 = cross(face.normal, u軸): 垂直壁→z方向、水平面→第2水平方向
              const _pfn = tf.normal || { nx: 0, ny: 0, nz: 1 };
              let pvx = -_pfn.nz * edgeUy, pvy = _pfn.nz * edgeUx, pvz = _pfn.nx * edgeUy - _pfn.ny * edgeUx;
              const pvlen = Math.sqrt(pvx*pvx + pvy*pvy + pvz*pvz);
              if (pvlen > 1e-6) { pvx /= pvlen; pvy /= pvlen; pvz /= pvlen; }
              const u1 = (firstPt.gx - ea.x) * edgeUx + (firstPt.gy - ea.y) * edgeUy;
              const u2 = (pt.gx - ea.x) * edgeUx + (pt.gy - ea.y) * edgeUy;
              const vv1 = (firstPt.gx - ea.x) * pvx + (firstPt.gy - ea.y) * pvy + (firstPt.gz - ea.z) * pvz;
              const vv2 = (pt.gx - ea.x) * pvx + (pt.gy - ea.y) * pvy + (pt.gz - ea.z) * pvz;
              const uMin = Math.min(u1, u2), uMax = Math.max(u1, u2);
              const vvMin = Math.min(vv1, vv2), vvMax = Math.max(vv1, vv2);
              // 矩形4隅を3Dで構築（水平面・垂直壁どちらでも正しく表示）
              const _prCorners = [
                { x: ea.x + uMin*edgeUx + vvMin*pvx, y: ea.y + uMin*edgeUy + vvMin*pvy, z: ea.z + vvMin*pvz },
                { x: ea.x + uMax*edgeUx + vvMin*pvx, y: ea.y + uMax*edgeUy + vvMin*pvy, z: ea.z + vvMin*pvz },
                { x: ea.x + uMax*edgeUx + vvMax*pvx, y: ea.y + uMax*edgeUy + vvMax*pvy, z: ea.z + vvMax*pvz },
                { x: ea.x + uMin*edgeUx + vvMax*pvx, y: ea.y + uMin*edgeUy + vvMax*pvy, z: ea.z + vvMax*pvz },
              ];
              const _prDeg = [];
              [..._prCorners, _prCorners[0]].forEach(c => {
                const g = gridToGeo(c.x, c.y);
                _prDeg.push(g.lng, g.lat, c.z + _localBase);
              });
              v._snapRectPreview = v.entities.add({
                polyline: {
                  positions: Cesium.Cartesian3.fromDegreesArrayHeights(_prDeg),
                  width: 2, material: Cesium.Color.CYAN,
                  clampToGround: false, disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
              });
              _addRectLabels(_prCorners, _localBase);
            }
          }
        } else if (blk) {
          const bpts = blk.points;
          const n = bpts.length;
          const fi = typeof face === 'number' ? face : parseInt(face, 10);
          if (!isNaN(fi) && fi >= 0 && fi < n) {
            const bp0 = bpts[fi], bp1n = bpts[(fi + 1) % n];
            const ex = bp1n.x - bp0.x, ey = bp1n.y - bp0.y;
            const elen = Math.sqrt(ex * ex + ey * ey);
            const edgeUx = ex / elen, edgeUy = ey / elen;
            const u1 = (firstPt.gx - bp0.x) * edgeUx + (firstPt.gy - bp0.y) * edgeUy;
            const u2 = (pt.gx - bp0.x) * edgeUx + (pt.gy - bp0.y) * edgeUy;
            const uMin = Math.max(0, Math.min(u1, u2));
            const uMax = Math.min(elen, Math.max(u1, u2));
            const zMin = Math.min(firstPt.gz, pt.gz), zMax = Math.max(firstPt.gz, pt.gz);
            const c0 = gridToGeo(bp0.x + uMin * edgeUx, bp0.y + uMin * edgeUy);
            const c1 = gridToGeo(bp0.x + uMax * edgeUx, bp0.y + uMax * edgeUy);
            v._snapRectPreview = v.entities.add({
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                  c0.lng, c0.lat, zMin + _localBase, c1.lng, c1.lat, zMin + _localBase,
                  c1.lng, c1.lat, zMax + _localBase, c0.lng, c0.lat, zMax + _localBase,
                  c0.lng, c0.lat, zMin + _localBase,
                ]),
                width: 2, material: Cesium.Color.CYAN,
                clampToGround: false, disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
          }
        }
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((click) => {
      const pt = projectClickToFace(click.position);
      if (!pt) return;
      // スナップカーソル/プレビューを即座に削除
      if (v._snapCursorEnt && v.entities.contains(v._snapCursorEnt)) {
        v.entities.remove(v._snapCursorEnt); v._snapCursorEnt = null;
      }
      if (v._snapRectPreview && v.entities.contains(v._snapRectPreview)) {
        v.entities.remove(v._snapRectPreview); v._snapRectPreview = null;
      }
      if (v._snapRectLabelEnts) { v._snapRectLabelEnts.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); }); v._snapRectLabelEnts = []; }
      setFaceSketchPts(prev => {
        if (prev.length === 0) { firstPt = pt; return [pt]; }
        if (prev.length >= 1) {
          const p1 = prev[0], p2 = pt;
          const face = bldSelected?.face;
          const blk = bldSelected ? (blds || [])[bldSelected.entIdx] : null;
          if (!blk || !bldSelected) return prev;
          // ── 面を伸縮: 突起/削り出しはドラッグ方向で自動判定 ──
          // ── solid壁面: face頂点ベースで3D矩形を構築 → pushpullへ ──
          if (bldSelected.solidFaceId && typeof face === 'string' && face.startsWith('f')) {
            const cs = (v._currentSolids) || [];
            const ts = cs.find(s => s.faces && s.faces.some(f => f.id === bldSelected.solidFaceId));
            const tf = ts ? ts.faces.find(f => f.id === bldSelected.solidFaceId) : null;
            if (!tf || !tf.vertices || tf.vertices.length < 3) return prev;
            const sv = tf.vertices;
            // 最も水平な辺をu軸とする
            let bestI = 0, bestDz = Infinity;
            for (let i = 0; i < sv.length; i++) {
              const a = sv[i], b = sv[(i + 1) % sv.length];
              const dz = Math.abs(b.z - a.z);
              const dxy = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
              if (dxy > 1e-6 && dz < bestDz) { bestDz = dz; bestI = i; }
            }
            const ea = sv[bestI], eb = sv[(bestI + 1) % sv.length];
            const edx = eb.x - ea.x, edy = eb.y - ea.y;
            const elen = Math.sqrt(edx * edx + edy * edy);
            if (elen < 1e-6) return prev;
            const ux = edx / elen, uy = edy / elen;
            // v軸 = cross(face.normal, u軸) → 垂直壁→z方向、水平面→第2水平方向
            const _rfn = tf.normal || { nx: 0, ny: 0, nz: 1 };
            let rvx = -_rfn.nz * uy, rvy = _rfn.nz * ux, rvz = _rfn.nx * uy - _rfn.ny * ux;
            const rvlen = Math.sqrt(rvx*rvx + rvy*rvy + rvz*rvz);
            if (rvlen > 1e-6) { rvx /= rvlen; rvy /= rvlen; rvz /= rvlen; }
            // u/v 座標でクリック位置を計算
            const u1Raw = (p1.gx - ea.x) * ux + (p1.gy - ea.y) * uy;
            const u2Raw = (p2.gx - ea.x) * ux + (p2.gy - ea.y) * uy;
            const v1Raw = (p1.gx - ea.x) * rvx + (p1.gy - ea.y) * rvy + (p1.gz - ea.z) * rvz;
            const v2Raw = (p2.gx - ea.x) * rvx + (p2.gy - ea.y) * rvy + (p2.gz - ea.z) * rvz;
            // 面の (u,v) bbox でクランプ
            let uFaceMin = Infinity, uFaceMax = -Infinity;
            let vFaceMin = Infinity, vFaceMax = -Infinity;
            for (const v of sv) {
              const u = (v.x - ea.x) * ux + (v.y - ea.y) * uy;
              const vv = (v.x - ea.x) * rvx + (v.y - ea.y) * rvy + (v.z - ea.z) * rvz;
              if (u < uFaceMin) uFaceMin = u; if (u > uFaceMax) uFaceMax = u;
              if (vv < vFaceMin) vFaceMin = vv; if (vv > vFaceMax) vFaceMax = vv;
            }
            const uMin = Math.max(Math.min(u1Raw, u2Raw), uFaceMin);
            const uMax = Math.min(Math.max(u1Raw, u2Raw), uFaceMax);
            const vMin = Math.max(Math.min(v1Raw, v2Raw), vFaceMin);
            const vMax = Math.min(Math.max(v1Raw, v2Raw), vFaceMax);
            if (uMax <= uMin || vMax <= vMin) {
              console.warn('[SOLID_FACE_RECT] 矩形が面範囲外 → スキップ', {
                u: `[${u1Raw.toFixed(1)},${u2Raw.toFixed(1)}]`, faceU: `[${uFaceMin.toFixed(1)},${uFaceMax.toFixed(1)}]`,
                v: `[${v1Raw.toFixed(1)},${v2Raw.toFixed(1)}]`, faceV: `[${vFaceMin.toFixed(1)},${vFaceMax.toFixed(1)}]`,
              });
              return prev;
            }
            // rect3d: ea + u*u_hat + v*v_hat (水平面・垂直壁どちらでも正しく機能)
            const rect3d = [
              { x: ea.x + uMin*ux + vMin*rvx, y: ea.y + uMin*uy + vMin*rvy, z: ea.z + vMin*rvz },
              { x: ea.x + uMax*ux + vMin*rvx, y: ea.y + uMax*uy + vMin*rvy, z: ea.z + vMin*rvz },
              { x: ea.x + uMax*ux + vMax*rvx, y: ea.y + uMax*uy + vMax*rvy, z: ea.z + vMax*rvz },
              { x: ea.x + uMin*ux + vMax*rvx, y: ea.y + uMin*uy + vMax*rvy, z: ea.z + vMax*rvz },
            ];
            const wasClamped = (uMin !== Math.min(u1Raw, u2Raw)) || (uMax !== Math.max(u1Raw, u2Raw))
                            || (vMin !== Math.min(v1Raw, v2Raw)) || (vMax !== Math.max(v1Raw, v2Raw));
            console.warn('[SOLID_FACE_RECT] 矩形確定 → pushpullモード' + (wasClamped ? ' (面範囲にクランプ)' : ''), {
              solidFaceId: bldSelected.solidFaceId,
              rect3d: rect3d.map((p, i) => `c${i}(${p.x.toFixed(1)},${p.y.toFixed(1)},z=${p.z.toFixed(1)})`),
              faceVerts: sv.map((p, i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)},z=${p.z.toFixed(1)})`),
              userUV: wasClamped ? `u=[${u1Raw.toFixed(1)},${u2Raw.toFixed(1)}]→[${uMin.toFixed(1)},${uMax.toFixed(1)}] v=[${v1Raw.toFixed(1)},${v2Raw.toFixed(1)}]→[${vMin.toFixed(1)},${vMax.toFixed(1)}]` : undefined,
              userZ: wasClamped ? `[${zMinRaw.toFixed(1)},${zMaxRaw.toFixed(1)}] → [${zMin.toFixed(1)},${zMax.toFixed(1)}]` : undefined,
            });
            {const _ln=['辺あ','辺い','辺う','辺え'];console.warn('[RECT_SIDES]',Object.fromEntries(_ln.map((l,i)=>[l,`(${rect3d[i].x.toFixed(1)},${rect3d[i].y.toFixed(1)},z=${rect3d[i].z.toFixed(1)})→(${rect3d[(i+1)%4].x.toFixed(1)},${rect3d[(i+1)%4].y.toFixed(1)},z=${rect3d[(i+1)%4].z.toFixed(1)})`])));}
            originalBlockRef.current = {
              points: blk.points.map(p => ({ ...p })),
              zBottom: blk.zBottom || 0,
              zTop: blk.zTop != null ? blk.zTop : 40,
              _solidRect3d: rect3d,
              _solidFaceId: bldSelected.solidFaceId,
            };
            setFaceSketchPhase('pushpull');
            setFaceSketchDepth(0);
            pushPullRef.current = null;
            return [];
          }
          if (face === 'zTop' || face === 'zBottom') {
            // 上下面: 矩形選択 → 子ブロック不要。矩形情報を保存してpushpullへ直行
            const bpts = blk.points;
            const pn = bpts.length;
            let bestEdgeIdx = 0, bestEdgeDist = Infinity;
            for (let i = 0; i < pn; i++) {
              const a = bpts[i], b = bpts[(i + 1) % pn];
              const ex = b.x - a.x, ey = b.y - a.y;
              const el2 = ex * ex + ey * ey;
              if (el2 < 1e-12) continue;
              const t = Math.max(0, Math.min(1, ((p1.gx - a.x) * ex + (p1.gy - a.y) * ey) / el2));
              const px = a.x + t * ex, py = a.y + t * ey;
              const d = Math.sqrt((p1.gx - px) ** 2 + (p1.gy - py) ** 2);
              if (d < bestEdgeDist) { bestEdgeDist = d; bestEdgeIdx = i; }
            }
            const ea = bpts[bestEdgeIdx], eb = bpts[(bestEdgeIdx + 1) % pn];
            const edx = eb.x - ea.x, edy = eb.y - ea.y;
            const edl = Math.sqrt(edx * edx + edy * edy);
            const ux = edx / edl, uy = edy / edl;
            const vx = -uy, vy = ux;
            const u2 = (p2.gx - p1.gx) * ux + (p2.gy - p1.gy) * uy;
            const v2 = (p2.gx - p1.gx) * vx + (p2.gy - p1.gy) * vy;
            const footprint = [
              { x: p1.gx, y: p1.gy },
              { x: p1.gx + u2 * ux, y: p1.gy + u2 * uy },
              { x: p1.gx + u2 * ux + v2 * vx, y: p1.gy + u2 * uy + v2 * vy },
              { x: p1.gx + v2 * vx, y: p1.gy + v2 * vy },
            ];
            console.warn('[Z_FACE_RECT] 矩形確定 → 直接pushpullモード', {
              face, footprint: footprint.map((p,i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
              親pts: bpts.map((p,i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
            });
            {const _ln=['辺あ','辺い','辺う','辺え'];console.warn('[RECT_SIDES]',Object.fromEntries(_ln.map((l,i)=>[l,`(${footprint[i].x.toFixed(1)},${footprint[i].y.toFixed(1)})→(${footprint[(i+1)%4].x.toFixed(1)},${footprint[(i+1)%4].y.toFixed(1)})`])));}
            // 子ブロック作らず、矩形情報を保存してpushpullモードに入る
            originalBlockRef.current = {
              points: blk.points.map(p => ({ ...p })),
              zBottom: blk.zBottom || 0,
              zTop: blk.zTop != null ? blk.zTop : 40,
              _zPushRect: footprint, // pushpull確定時に使う矩形
            };
            setFaceSketchPhase('pushpull');
            setFaceSketchDepth(0);
            pushPullRef.current = null;
            return []; // マーカー不要（プレビューは_zPushRectで描画）
          } else {
            // 側面: Z範囲を見て統合 or 別ブロック判定
            const pts = blk.points;
            const n = pts.length;
            const fi = typeof face === 'number' ? face : parseInt(face, 10);
            if (isNaN(fi) || fi < 0 || fi >= n) return prev;
            const bp0 = pts[fi], bp1 = pts[(fi + 1) % n];
            const ex = bp1.x - bp0.x, ey = bp1.y - bp0.y;
            const elen = Math.sqrt(ex * ex + ey * ey);
            if (elen < 0.001) return prev;
            const edgeUx = ex / elen, edgeUy = ey / elen;
            const u1 = (p1.gx - bp0.x) * edgeUx + (p1.gy - bp0.y) * edgeUy;
            const u2 = (p2.gx - bp0.x) * edgeUx + (p2.gy - bp0.y) * edgeUy;
            const uMin = Math.max(0, Math.min(u1, u2));
            const uMax = Math.min(elen, Math.max(u1, u2));
            const zB = blk.zBottom || 0, zT = blk.zTop || 40;
            const zMin = Math.min(p1.gz, p2.gz);
            const zMax = Math.max(p1.gz, p2.gz);
            // 子ブロックでも部分高操作を許可（孫ブロック生成）
            const isChild = blk._parentBlockIdx != null;
            const isFullHeight = (zMin <= zB + 0.5) && (zMax >= zT - 0.5);

            // ★ ユーザーが選択した矩形2点のログ
            console.warn('[RECT_2PT] ユーザー選択矩形2点', {
              p1: `(gx=${p1.gx.toFixed(1)}, gy=${p1.gy.toFixed(1)}, gz=${p1.gz.toFixed(1)}m)`,
              p2: `(gx=${p2.gx.toFixed(1)}, gy=${p2.gy.toFixed(1)}, gz=${p2.gz.toFixed(1)}m)`,
              矩形Z範囲: `${zMin.toFixed(1)}m→${zMax.toFixed(1)}m (高さ=${(zMax - zMin).toFixed(1)}m)`,
              ブロックZ範囲: `${zB.toFixed(1)}m→${zT.toFixed(1)}m (全高=${(zT - zB).toFixed(1)}m)`,
              辺方向u: `u1=${u1.toFixed(1)}, u2=${u2.toFixed(1)} → uMin=${uMin.toFixed(1)}, uMax=${uMax.toFixed(1)}`,
              isChild,
              isFullHeight,
              全高判定理由: isFullHeight ? `全高: zMin(${zMin.toFixed(1)})<=zB+0.5(${(zB+0.5).toFixed(1)}) && zMax(${zMax.toFixed(1)})>=zT-0.5(${(zT-0.5).toFixed(1)})` : `部分高→子ブロック生成: 矩形Z(${zMin.toFixed(1)}→${zMax.toFixed(1)})がブロック全高(${zB.toFixed(1)}→${zT.toFixed(1)})をカバーしない`,
            });

            if (isFullHeight) {
              // 全高 → rectpullで統合ポリゴン変形（突起も削り出しも対応）
              const corners = [
                { gx: bp0.x + uMin * edgeUx, gy: bp0.y + uMin * edgeUy, gz: zB },
                { gx: bp0.x + uMax * edgeUx, gy: bp0.y + uMax * edgeUy, gz: zB },
                { gx: bp0.x + uMax * edgeUx, gy: bp0.y + uMax * edgeUy, gz: zT },
                { gx: bp0.x + uMin * edgeUx, gy: bp0.y + uMin * edgeUy, gz: zT },
              ];

              // ★ 実際に形成された四角 vs ユーザー矩形の差分
              console.warn('[RECT_CONFIRM] 矩形確定 → rectpull', {
                face: fi,
                isChild,
                ユーザー矩形Z: `${zMin.toFixed(1)}m→${zMax.toFixed(1)}m`,
                実際の四角Z: `${zB.toFixed(1)}m→${zT.toFixed(1)}m`,
                Z差分: zMin !== zB || zMax !== zT
                  ? `⚠️ ユーザー指定のZ範囲が無視されている! 下=${(zB - zMin).toFixed(1)}m差, 上=${(zT - zMax).toFixed(1)}m差`
                  : '✅ 一致',
                矩形座標_実際: corners.map((c, i) => `c${i}(${c.gx.toFixed(1)},${c.gy.toFixed(1)},z=${c.gz.toFixed(1)})`),
                選択辺上の範囲: `u=${uMin.toFixed(1)}..${uMax.toFixed(1)} / edgeLen=${elen.toFixed(1)}`,
                矩形幅: (uMax - uMin).toFixed(1) + 'grid',
              });
              setFaceSketchPhase('rectpull');
              setFaceSketchDepth(0);
              pushPullRef.current = null;
              return corners;
            } else {
              // 部分高 → 子ブロック追加 → Push/Pull
              if (!onAddBlock) return prev;
              let nx = ey / elen, ny = -ex / elen;
              const cx = pts.reduce((s, p) => s + p.x, 0) / n;
              const cy = pts.reduce((s, p) => s + p.y, 0) / n;
              const mx = (bp0.x + bp1.x) / 2, my = (bp0.y + bp1.y) / 2;
              if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
              const e0x = bp0.x + uMin * edgeUx, e0y = bp0.y + uMin * edgeUy;
              const e1x = bp0.x + uMax * edgeUx, e1y = bp0.y + uMax * edgeUy;
              const footprint = [
                { x: e0x, y: e0y },
                { x: e0x + nx * 0.01, y: e0y + ny * 0.01 },
                { x: e1x + nx * 0.01, y: e1y + ny * 0.01 },
                { x: e1x, y: e1y },
              ];
              onAddBlock(bldSelected.buildingId, footprint, zMin, zMax, {
                _parentBlockIdx: bldSelected.blockIdx,
                _sharedWall: {
                  wallIdx: 3,
                  parentBlockIdx: bldSelected.blockIdx,
                  parentEdge: fi,
                  uMin, uMax,
                },
              });
              rectPullPendingRef.current = { buildingId: bldSelected.buildingId, face };
              return [p1, p2];
            }
          }
          return [p1, p2];
        }
        return prev;
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // 右クリック: 面全体を選択 → 即座にrectpullへ
    handler.setInputAction(() => {
      const blk = bldSelected ? (blds || [])[bldSelected.entIdx] : null;
      if (!blk || !bldSelected) return;
      const face = bldSelected.face;
      // スナップカーソル/プレビューを削除
      if (v._snapCursorEnt && v.entities.contains(v._snapCursorEnt)) {
        v.entities.remove(v._snapCursorEnt); v._snapCursorEnt = null;
      }
      if (v._snapRectPreview && v.entities.contains(v._snapRectPreview)) {
        v.entities.remove(v._snapRectPreview); v._snapRectPreview = null;
      }
      if (v._snapRectLabelEnts) { v._snapRectLabelEnts.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); }); v._snapRectLabelEnts = []; }
      if (face === 'zTop' || face === 'zBottom') {
        // 上下面全体 → 直接pushpullモードに入る（子ブロック不要）
        originalBlockRef.current = {
          points: blk.points.map(p => ({ ...p })),
          zBottom: blk.zBottom || 0,
          zTop: blk.zTop != null ? blk.zTop : 40,
        };
        setFaceSketchPhase('pushpull');
        setFaceSketchDepth(0);
        pushPullRef.current = null;
        setFaceSketchPts([]);
      } else if (bldSelected.solidFaceId && typeof face === 'string' && face.startsWith('f')) {
        // solid壁面全体 → pushpullモードに入る（rectなし=全面pushPullFace）
        originalBlockRef.current = {
          points: blk.points.map(p => ({ ...p })),
          zBottom: blk.zBottom || 0,
          zTop: blk.zTop != null ? blk.zTop : 40,
        };
        setFaceSketchPhase('pushpull');
        setFaceSketchDepth(0);
        pushPullRef.current = null;
        setFaceSketchPts([]);
      } else {
        // 側面全体 → rectpullで統合ポリゴン変形
        const pts = blk.points;
        const n = pts.length;
        const fi = typeof face === 'number' ? face : parseInt(face, 10);
        if (isNaN(fi) || fi < 0 || fi >= n) return;
        const bp0 = pts[fi], bp1 = pts[(fi + 1) % n];
        const zB = blk.zBottom || 0, zT = blk.zTop || 40;
        const corners = [
          { gx: bp0.x, gy: bp0.y, gz: zB },
          { gx: bp1.x, gy: bp1.y, gz: zB },
          { gx: bp1.x, gy: bp1.y, gz: zT },
          { gx: bp0.x, gy: bp0.y, gz: zT },
        ];
        setFaceSketchPhase('rectpull');
        setFaceSketchDepth(0);
        pushPullRef.current = null;
        setFaceSketchPts(corners);
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    return () => {
      handler.destroy();
      // スナップカーソルのクリーンアップ
      if (v._snapCursorEnt && !v.isDestroyed() && v.entities.contains(v._snapCursorEnt)) {
        v.entities.remove(v._snapCursorEnt);
        v._snapCursorEnt = null;
      }
      if (v._snapRectPreview && !v.isDestroyed() && v.entities.contains(v._snapRectPreview)) {
        v.entities.remove(v._snapRectPreview);
        v._snapRectPreview = null;
      }
      if (v._snapRectLabelEnts) { v._snapRectLabelEnts.forEach(e => { if (!v.isDestroyed() && v.entities.contains(e)) v.entities.remove(e); }); v._snapRectLabelEnts = []; }
    };
  }, [faceSketchPhase, initDoneRef.current, projectClickToFace, bldSelected, blds, onAddBlock]);


  // 矩形で突起(別ブロック): 新ブロック追加後に自動選択 → Push/Pullへ
  useEffect(() => {
    if (!rectPullPendingRef.current) return;
    const { buildingId, face } = rectPullPendingRef.current;
    const _blds = blds || [];
    let lastIdx = -1;
    for (let i = _blds.length - 1; i >= 0; i--) {
      if (_blds[i].buildingId === buildingId) { lastIdx = i; break; }
    }
    if (lastIdx < 0) return;
    const blk = _blds[lastIdx];
    // Z面→Z面pushpull、側面→最長非共有壁pushpull
    let bestSideFace = 0;
    {
      const sw = blk._sharedWall ? blk._sharedWall.wallIdx : -1;
      let maxLen = 0;
      for (let fi = 0; fi < blk.points.length; fi++) {
        if (fi === sw) continue;
        const a = blk.points[fi], b = blk.points[(fi + 1) % blk.points.length];
        const len = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
        if (len > maxLen) { maxLen = len; bestSideFace = fi; }
      }
    }
    const newFace = (face === 'zTop' || face === 'zBottom') ? face : bestSideFace;
    console.warn('[AUTO_SELECT] pushpull auto-select', {
      buildingId: blk.buildingId, blockIdx: blk.blockIdx,
      entIdx: lastIdx, face: newFace, isChild: blk._parentBlockIdx != null,
      _sharedWall: !!blk._sharedWall, _parentBlockIdx: blk._parentBlockIdx,
      points: blk.points.map(p => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
    });
    const _autoEdge = typeof newFace === 'number' ? newFace : -1;
    const _autoCsg = _autoEdge >= 0 ? computeCSGNormal(blk, _autoEdge, _blds) : null;
    setBldSelected({
      buildingId: blk.buildingId, blockIdx: blk.blockIdx,
      entIdx: lastIdx, label: blk.label, face: newFace,
      ...(_autoCsg ? { csgNx: _autoCsg.nx, csgNy: _autoCsg.ny } : {}),
    });
    originalBlockRef.current = {
      points: blk.points.map(p => ({ ...p })),
      zBottom: blk.zBottom || 0,
      zTop: blk.zTop != null ? blk.zTop : 40,
    };
    setFaceSketchPts([]); // プレビュー線/マーカーのクリーンアップ
    setFaceSketchPhase('pushpull');
    setFaceSketchDepth(0);
    pushPullRef.current = null;
    rectPullPendingRef.current = null;
  }, [blds]);

  // 面で作図: プレビュー描画（面上のマーカー＋ライン）
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    // スナップカーソル/矩形プレビューのクリーンアップ（rectdraw→別フェーズ遷移時）
    if (faceSketchPhase !== 'rectdraw') {
      if (v._snapCursorEnt && v.entities.contains(v._snapCursorEnt)) {
        v.entities.remove(v._snapCursorEnt); v._snapCursorEnt = null;
      }
      if (v._snapRectPreview && v.entities.contains(v._snapRectPreview)) {
        v.entities.remove(v._snapRectPreview); v._snapRectPreview = null;
      }
      if (v._snapRectLabelEnts) { v._snapRectLabelEnts.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); }); v._snapRectLabelEnts = []; }
    }
    const ref = faceSketchRef.current;
    ref.entities.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
    if (ref.lineEnt && v.entities.contains(ref.lineEnt)) v.entities.remove(ref.lineEnt);
    if (ref.fillEnt && v.entities.contains(ref.fillEnt)) v.entities.remove(ref.fillEnt);
    ref.entities = [];
    ref.lineEnt = null;
    ref.fillEnt = null;
    if (!faceSketchPhase || faceSketchPts.length === 0) return;
    const baseElev = v._siteBaseElevation || 0;
    // マーカー
    faceSketchPts.forEach((p, i) => {
      const geo = gridToGeo(p.gx, p.gy);
      const ent = v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, p.gz + baseElev),
        point: {
          pixelSize: i === 0 ? 10 : 7,
          color: i === 0 ? Cesium.Color.LIME : Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      ref.entities.push(ent);
    });
    // ライン（閉じた輪郭）
    if (faceSketchPts.length >= 2) {
      const positions = faceSketchPts.map(p => {
        const geo = gridToGeo(p.gx, p.gy);
        return Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, p.gz + baseElev);
      });
      // 閉じる
      const firstGeo = gridToGeo(faceSketchPts[0].gx, faceSketchPts[0].gy);
      positions.push(Cesium.Cartesian3.fromDegrees(firstGeo.lng, firstGeo.lat, faceSketchPts[0].gz + baseElev));
      ref.lineEnt = v.entities.add({
        polyline: {
          positions,
          width: 2,
          material: Cesium.Color.LIME.withAlpha(0.9),
        },
      });
    }
    // extrudeフェーズ: 閉じたポリゴンを面上に塗りつぶし表示
    if (faceSketchPhase === 'extrude' && faceSketchPts.length >= 3) {
      const positions = faceSketchPts.map(p => {
        const geo = gridToGeo(p.gx, p.gy);
        return Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, p.gz + baseElev);
      });
      ref.fillEnt = v.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: Cesium.Color.LIME.withAlpha(0.35),
          perPositionHeight: true,
        },
      });
    }
  }, [faceSketchPts, faceSketchPhase]);

  // 面で作図: 選択面ハイライト表示
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    // 前回のハイライトと拡張プレビュー(側壁プレビュー)を削除
    if (v._faceHighlight) {
      if (v.entities.contains(v._faceHighlight)) v.entities.remove(v._faceHighlight);
      v._faceHighlight = null;
    }
    if (v._faceHighlightExtras) {
      v._faceHighlightExtras.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
      v._faceHighlightExtras = [];
    }
    if (!faceSketchPhase || !bldSelected) return;
    const blk = (blds || [])[bldSelected.entIdx];
    if (!blk) return;
    const baseElev = v._siteBaseElevation || 0;
    // 建物描画と同じlocalBaseElevを使用（2Dモード時のglobe地面高補正）
    let localBaseElev = baseElev;
    if (v.scene.globe && v.scene.globe.show) {
      const pts2 = blk.points;
      const cx2 = pts2.reduce((s, p) => s + p.x, 0) / pts2.length;
      const cy2 = pts2.reduce((s, p) => s + p.y, 0) / pts2.length;
      const g2 = gridToGeo(cx2, cy2);
      const carto2 = Cesium.Cartographic.fromDegrees(g2.lng, g2.lat);
      const gh = v.scene.globe.getHeight(carto2);
      if (gh != null && gh > -500) localBaseElev = gh;
    }
    const face = bldSelected.face;
    const zB = blk.zBottom || 0, zT = blk.zTop || 40;

    // solidFaceIdがある場合: face型に関わらず必ずsolid面の実頂点を使う
    // → L字上面・削り出し壁など実際の形状のみ緑色になる（blk.pointsを使わない）
    if (bldSelected.solidFaceId) {
      const cs = (v && v._currentSolids) || [];
      const ts = cs.find(s => s.buildingId === bldSelected.buildingId);
      const tf = ts && ts.faces.find(f => f.id === bldSelected.solidFaceId);
      if (tf && tf.vertices && tf.vertices.length >= 3) {
        const allZ = tf.vertices.map(p => p.z);
        const isFlat = allZ.every(z => Math.abs(z - allZ[0]) < 0.01);
        if (isFlat) {
          // 平面: height指定（穴あき面対応）
          const outerPos = Cesium.Cartesian3.fromDegreesArray(tf.vertices.flatMap(p => { const g = gridToGeo(p.x, p.y); return [g.lng, g.lat]; }));
          const holeHL = tf.holes ? tf.holes.map(hole => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(hole.flatMap(p => { const g = gridToGeo(p.x, p.y); return [g.lng, g.lat]; })))) : [];
          v._faceHighlight = v.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(outerPos, holeHL),
              height: localBaseElev + allZ[0],
              material: Cesium.Color.LIME.withAlpha(0.4),
              outline: true, outlineColor: Cesium.Color.LIME,
            },
          });
        } else {
          // 壁面: perPositionHeight（穴あき面対応）
          const positions = tf.vertices.map(p => { const g = gridToGeo(p.x, p.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + p.z); });
          const holeHW = tf.holes ? tf.holes.map(hole => new Cesium.PolygonHierarchy(hole.map(p => { const g = gridToGeo(p.x, p.y); return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBaseElev + p.z); }))) : [];
          v._faceHighlight = v.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions, holeHW),
              perPositionHeight: true,
              material: Cesium.Color.LIME.withAlpha(0.4),
              outline: true, outlineColor: Cesium.Color.LIME,
            },
          });
        }
      }
      return () => {
        if (v._faceHighlight && !v.isDestroyed() && v.entities.contains(v._faceHighlight)) {
          v.entities.remove(v._faceHighlight);
          v._faceHighlight = null;
        }
      };
    }

    // solidFaceIdなし（従来の buildings ベース）
    if (face === 'zTop' || face === 'zBottom') {
      const faceZ = face === 'zTop' ? zT : zB;
      const degreesList = [];
      blk.points.forEach(p => { const g = gridToGeo(p.x, p.y); degreesList.push(g.lng, g.lat); });
      v._faceHighlight = v.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(degreesList),
          height: localBaseElev + faceZ,
          material: Cesium.Color.LIME.withAlpha(0.4),
          outline: true, outlineColor: Cesium.Color.LIME,
        },
      });
    } else {
      // 側面: 四角形ポリゴン
      const pts = blk.points;
      const n = pts.length;
      const fi = typeof face === 'number' ? face : parseInt(face, 10);
      if (isNaN(fi) || fi < 0 || fi >= n) return; // 無効なedgeIdxはスキップ
      const p0 = pts[fi], p1 = pts[(fi + 1) % n];
      const g0 = gridToGeo(p0.x, p0.y), g1 = gridToGeo(p1.x, p1.y);
      const positions = [
        Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, localBaseElev + zB),
        Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, localBaseElev + zB),
        Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, localBaseElev + zT),
        Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, localBaseElev + zT),
      ];
      v._faceHighlight = v.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          perPositionHeight: true,
          material: Cesium.Color.LIME.withAlpha(0.4),
          outline: true, outlineColor: Cesium.Color.LIME,
        },
      });
    }
    return () => {
      if (v._faceHighlight && !v.isDestroyed() && v.entities.contains(v._faceHighlight)) {
        v.entities.remove(v._faceHighlight);
        v._faceHighlight = null;
      }
    };
  }, [faceSketchPhase, bldSelected, blds]);

  // 側面押し出し: 既存ポリゴンに突起を統合した新ポリゴンを計算
  const computeExtrudedPolygon = useCallback((blk, face, sketchPts, depthMm, verbose = false, csgNx, csgNy) => {
    if (!blk || !sketchPts || sketchPts.length < 3) return null;
    const pts = blk.points;
    const n = pts.length;
    const fi = typeof face === 'number' ? face : parseInt(face, 10);
    if (isNaN(fi) || fi < 0 || fi >= n) return null;
    const p0 = pts[fi], p1 = pts[(fi + 1) % n];
    const ex = p1.x - p0.x, ey = p1.y - p0.y;
    const elen = Math.sqrt(ex * ex + ey * ey);
    if (elen < 0.001) return null;
    const edgeUx = ex / elen, edgeUy = ey / elen;
    // 外向き法線（CSG補正済みが渡されていればそれを使う）
    let nx, ny;
    if (csgNx != null) {
      nx = csgNx; ny = csgNy;
    } else {
      nx = ey / elen; ny = -ex / elen;
      const cx = pts.reduce((s, p) => s + p.x, 0) / n;
      const cy = pts.reduce((s, p) => s + p.y, 0) / n;
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    }
    // スケッチのエッジ方向パラメータ範囲
    const uValues = sketchPts.map(p => (p.gx - p0.x) * edgeUx + (p.gy - p0.y) * edgeUy);
    const uMin = Math.max(0, Math.min(...uValues));
    const uMax = Math.min(elen, Math.max(...uValues));
    const depthGrid = (depthMm / 1000) / METERS_PER_PX;
    const e0x = p0.x + uMin * edgeUx, e0y = p0.y + uMin * edgeUy;
    const e1x = p0.x + uMax * edgeUx, e1y = p0.y + uMax * edgeUy;
    // 2D線分交差: lineA(ax,ay)+t*(dax,day) と lineB(bx,by)+s*(dbx,dby) の交点のtを返す
    const lineIsect = (ax, ay, dax, day, bx, by, dbx, dby) => {
      const denom = dax * dby - day * dbx;
      if (Math.abs(denom) < 1e-10) return null;
      return ((bx - ax) * dby - (by - ay) * dbx) / denom;
    };

    const isCarve = depthMm < 0;
    const atStart = uMin < 0.5;
    const atEnd = uMax > elen - 0.5;
    const nextIdx = (fi + 1) % n;
    const prevIdx = (fi - 1 + n) % n;
    const nextNextIdx = (fi + 2) % n;

    // ポリゴン面積計算（Shoelace formula）- 閉面積チェック用
    const polyArea = (points) => {
      let area = 0;
      for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        area += points[i].x * points[j].y - points[j].x * points[i].y;
      }
      return area / 2;
    };
    // 自己交差チェック
    const checkSelfIntersect = (points) => {
      const segIsect = (ax, ay, bx, by, cx, cy, dx, dy) => {
        const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-10) return false;
        const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
        const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
        return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
      };
      const nn = points.length;
      for (let i = 0; i < nn; i++) {
        for (let j = i + 2; j < nn; j++) {
          if (i === 0 && j === nn - 1) continue;
          const a = points[i], b = points[(i + 1) % nn];
          const c = points[j], d = points[(j + 1) % nn];
          if (segIsect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)) return { edgeA: i, edgeB: j };
        }
      }
      return null;
    };

    if (verbose) console.warn('[EXTRUDE_POLYGON] 入力', {
      face: fi, isCarve, depthMm: Math.round(depthMm),
      depthGrid: depthGrid.toFixed(2),
      atStart, atEnd,
      normal: `(${nx.toFixed(3)}, ${ny.toFixed(3)})`,
      selectedEdge: `v${fi}(${p0.x.toFixed(1)},${p0.y.toFixed(1)})→v${nextIdx}(${p1.x.toFixed(1)},${p1.y.toFixed(1)})`,
      sketchRange: `u=${uMin.toFixed(1)}..${uMax.toFixed(1)} / edgeLen=${elen.toFixed(1)}`,
      originalPts: pts.map((p, i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
    });

    if (isCarve) {
      // 削り出し深さの上限: 面から重心までの距離の90%
      const faceDist = Math.abs((mx - cx) * nx + (my - cy) * ny);
      const maxCarveGrid = faceDist * 0.9;
      const clampedDepthGrid = Math.max(depthGrid, -maxCarveGrid);
      // 削り出し: オフセット面と隣接面の交点で新頂点を計算
      // → 隣接面は元の方向のまま短くなるだけ
      const dg = clampedDepthGrid;
      const offX = p0.x + nx * dg; // オフセット面上の点
      const offY = p0.y + ny * dg;
      const newPoints = [];
      for (let i = 0; i < n; i++) {
        if (i === fi) {
          if (atStart) {
            // 始点到達: 前の辺とオフセット面の交点
            const prevDx = p0.x - pts[prevIdx].x;
            const prevDy = p0.y - pts[prevIdx].y;
            const t = lineIsect(pts[prevIdx].x, pts[prevIdx].y, prevDx, prevDy, offX, offY, ex, ey);
            if (t != null) {
              newPoints.push({ x: pts[prevIdx].x + t * prevDx, y: pts[prevIdx].y + t * prevDy });
            } else {
              newPoints.push({ x: p0.x + nx * dg, y: p0.y + ny * dg });
            }
          } else {
            newPoints.push({ x: pts[i].x, y: pts[i].y });
            if (uMin > 0.5) newPoints.push({ x: e0x, y: e0y });
            newPoints.push({ x: e0x + nx * dg, y: e0y + ny * dg });
          }
          if (atEnd) {
            // 終点到達: 次の辺とオフセット面の交点
            const nextDx = pts[nextNextIdx].x - pts[nextIdx].x;
            const nextDy = pts[nextNextIdx].y - pts[nextIdx].y;
            const t = lineIsect(pts[nextIdx].x, pts[nextIdx].y, nextDx, nextDy, offX, offY, ex, ey);
            if (t != null) {
              newPoints.push({ x: pts[nextIdx].x + t * nextDx, y: pts[nextIdx].y + t * nextDy });
            } else {
              newPoints.push({ x: p1.x + nx * dg, y: p1.y + ny * dg });
            }
          } else {
            newPoints.push({ x: e1x + nx * dg, y: e1y + ny * dg });
            if (uMax < elen - 0.5) newPoints.push({ x: e1x, y: e1y });
          }
        } else if (atStart && i === prevIdx) {
          // 始点到達時: 前の頂点はそのまま（交点が辺上に来るので）
          newPoints.push({ x: pts[i].x, y: pts[i].y });
        } else if (atEnd && i === nextIdx) {
          // 終点到達時: 次の頂点をスキップ（交点に置き換え済み）
        } else {
          newPoints.push({ x: pts[i].x, y: pts[i].y });
        }
      }
      {
        const area = polyArea(newPoints);
        const selfX = checkSelfIntersect(newPoints);
        if (verbose) console.warn('[EXTRUDE_POLYGON] 削り出し結果', {
          頂点数: newPoints.length,
          面積: area.toFixed(1),
          面積符号: area > 0 ? '反時計回り(正常)' : area < 0 ? '時計回り(正常)' : '⚠️面積ゼロ!',
          自己交差: selfX ? `⚠️ edge${selfX.edgeA}×edge${selfX.edgeB}` : 'なし(正常)',
          newPts: newPoints.map((p, i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
          各辺長: newPoints.map((p, i) => {
            const q = newPoints[(i + 1) % newPoints.length];
            const len = Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
            return `e${i}: ${len.toFixed(1)}`;
          }),
        });
        if (Math.abs(area) < 1) console.error('[EXTRUDE_POLYGON] ⚠️ 面積がほぼゼロ！ポリゴンが潰れています');
        if (selfX) console.error('[EXTRUDE_POLYGON] ⚠️ 自己交差検出！形状が不正です');
      }
      return newPoints;
    }

    // 突起: 従来のロジック
    const newPoints = [];
    for (let i = 0; i < n; i++) {
      if (i === fi) {
        newPoints.push({ x: pts[i].x, y: pts[i].y });
        if (uMin > 0.5) newPoints.push({ x: e0x, y: e0y });
        newPoints.push({ x: e0x + nx * depthGrid, y: e0y + ny * depthGrid });
        newPoints.push({ x: e1x + nx * depthGrid, y: e1y + ny * depthGrid });
        if (uMax < elen - 0.5) newPoints.push({ x: e1x, y: e1y });
      } else {
        newPoints.push({ x: pts[i].x, y: pts[i].y });
      }
    }
    {
      const area = polyArea(newPoints);
      const selfX = checkSelfIntersect(newPoints);
      if (verbose) console.warn('[EXTRUDE_POLYGON] 突起結果', {
        頂点数: newPoints.length,
        面積: area.toFixed(1),
        面積符号: area > 0 ? '反時計回り(正常)' : area < 0 ? '時計回り(正常)' : '⚠️面積ゼロ!',
        自己交差: selfX ? `⚠️ edge${selfX.edgeA}×edge${selfX.edgeB}` : 'なし(正常)',
        newPts: newPoints.map((p, i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
        各辺長: newPoints.map((p, i) => {
          const q = newPoints[(i + 1) % newPoints.length];
          const len = Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
          return `e${i}: ${len.toFixed(1)}`;
        }),
      });
      if (Math.abs(area) < 1) console.error('[EXTRUDE_POLYGON] ⚠️ 面積がほぼゼロ！ポリゴンが潰れています');
      if (selfX) console.error('[EXTRUDE_POLYGON] ⚠️ 自己交差検出！形状が不正です');
    }
    return newPoints;
  }, []);

  // 押し出しリアルタイムプレビュー
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    if (v._extrudePreview) {
      if (v.entities.contains(v._extrudePreview)) v.entities.remove(v._extrudePreview);
      v._extrudePreview = null;
    }
    if (v._extrudePreviewExtras) {
      v._extrudePreviewExtras.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
      v._extrudePreviewExtras = [];
    }
    const isExtrude = faceSketchPhase === 'extrude' && faceSketchPts.length >= 3;
    const isRectPull = faceSketchPhase === 'rectpull' && faceSketchPts.length >= 2;
    const isPushPull = faceSketchPhase === 'pushpull';

    if ((!isExtrude && !isRectPull && !isPushPull) || !bldSelected || faceSketchDepth === 0) return;
    const blk = (blds || [])[bldSelected.entIdx];
    if (!blk) return;
    const face = bldSelected.face;

    const baseElev = v._siteBaseElevation || 0;
    // 建物描画と同じlocalBaseElevを使用
    let localBase = baseElev;
    if (v.scene.globe && v.scene.globe.show) {
      const _p = blk.points;
      const _cx = _p.reduce((s, p) => s + p.x, 0) / _p.length;
      const _cy = _p.reduce((s, p) => s + p.y, 0) / _p.length;
      const _g = gridToGeo(_cx, _cy);
      const _c = Cesium.Cartographic.fromDegrees(_g.lng, _g.lat);
      const _gh = v.scene.globe.getHeight(_c);
      if (_gh != null && _gh > -500) localBase = _gh;
    }

    // ── Push/Pull プレビュー ──
    if (isPushPull) {
      const origBlk = originalBlockRef.current;
      if (!origBlk) return;
      const ppFace = face;
      // solidFaceIdの場合: solid面を法線方向に移動して緑のプレビューを表示
      if (typeof ppFace === 'string' && ppFace.startsWith('f') && bldSelected.solidFaceId) {
        const cs = (v && v._currentSolids) || [];
        const ts = cs.find(s => s.buildingId === bldSelected.buildingId);
        const tf = ts && ts.faces.find(f => f.id === bldSelected.solidFaceId);
        if (tf && tf.normal && tf.vertices && tf.vertices.length >= 3) {
          const depthM = faceSketchDepth / 1000;
          const sn = tf.normal;
          // ★ _solidRect3dがあれば矩形のみプレビュー、なければ面全体
          const previewVerts = (origBlk._solidRect3d && origBlk._solidRect3d.length >= 3)
            ? origBlk._solidRect3d
            : tf.vertices;
          // 元の頂点
          const origPos = previewVerts.map(p => {
            const g = gridToGeo(p.x, p.y);
            return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBase + p.z);
          });
          // 移動後の頂点
          const movPos = previewVerts.map(p => {
            const g = gridToGeo(p.x + sn.nx * depthM / METERS_PER_PX, p.y + sn.ny * depthM / METERS_PER_PX);
            return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, localBase + p.z + sn.nz * depthM);
          });
          // 移動後の面（緑色）— _extrudePreview を使用（Effect先頭クリーンアップに委譲）
          v._extrudePreview = v.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(movPos),
              perPositionHeight: true,
              material: Cesium.Color.LIME.withAlpha(0.5),
              outline: true, outlineColor: Cesium.Color.LIME,
            },
          });
          // 各辺ごとに側壁プレビュー
          if (!v._extrudePreviewExtras) v._extrudePreviewExtras = [];
          for (let i = 0; i < previewVerts.length; i++) {
            const j = (i + 1) % previewVerts.length;
            const wallPos = [origPos[i], origPos[j], movPos[j], movPos[i]];
            const wallEnt = v.entities.add({
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(wallPos),
                perPositionHeight: true,
                material: Cesium.Color.LIME.withAlpha(0.3),
                outline: true, outlineColor: Cesium.Color.LIME,
              },
            });
            v._extrudePreviewExtras.push(wallEnt);
          }
          v.scene.requestRender();
          return;
        }
        return;
      }
      const isZ = ppFace === 'zTop' || ppFace === 'zBottom';
      const depthM = faceSketchDepth / 1000;

      if (isZ) {
        // Z面pushpull統一規約: depthM>0=上方向, depthM<0=下方向
        // カーブ子: 上向き→zTop伸長, 下向き→zBottom伸長（常にカーブが厚くなる）
        // 親ブロック: クリックした面（zTop/zBottom）を移動
        const pts = origBlk.points;
        const zB = origBlk.zBottom || 0, zT = origBlk.zTop || 40;
        // Z面pushpullプレビュー
        const zPushRect = origBlk._zPushRect;
        const previewPts = zPushRect || pts; // 矩形pushpullならその矩形、全面なら全体
        // solidFaceIdがある場合は実際の面のz（削り出し後の面B等）を使用
        // blk.zTopを使うと面Aの高さになってしまう
        let zFace = ppFace === 'zTop' ? zT : zB;
        if (bldSelected.solidFaceId) {
          const _cs = (v && v._currentSolids) || [];
          const _ts = _cs.find(s => s.buildingId === bldSelected.buildingId);
          const _tf = _ts && _ts.faces.find(f => f.id === bldSelected.solidFaceId);
          if (_tf && _tf.vertices && _tf.vertices.length >= 3) {
            zFace = _tf.vertices[0].z;
          }
        }
        const zEnd = zFace + depthM;
        const previewZMin = Math.min(zFace, zEnd);
        const previewZMax = Math.max(zFace, zEnd);
        if (v._lastPpLogDepth !== faceSketchDepth) {
          v._lastPpLogDepth = faceSketchDepth;
          console.warn('[PP_PREVIEW] Z面プレビュー', {
            face: ppFace, isRect: !!zPushRect,
            depthMm: faceSketchDepth.toFixed(0) + 'mm',
            depthM: depthM.toFixed(3) + 'm',
            zFace: zFace.toFixed(2), zEnd: zEnd.toFixed(2),
          });
        }
        const degreesList = [];
        previewPts.forEach(p => { const g = gridToGeo(p.x, p.y); degreesList.push(g.lng, g.lat); });
        v._extrudePreview = v.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(degreesList),
            height: previewZMin + localBase,
            extrudedHeight: previewZMax + localBase,
            material: Cesium.Color.LIME.withAlpha(0.3),
            outline: true, outlineColor: Cesium.Color.LIME,
          },
        });
      } else {
        // 側面: 面の頂点を移動したプレビュー
        const pts = origBlk.points;
        const fi = typeof ppFace === 'number' ? ppFace : parseInt(ppFace, 10);
        const n = pts.length;
        if (isNaN(fi) || fi < 0 || fi >= n) return;
        const depthGrid = depthM / METERS_PER_PX;
        const p0 = pts[fi], p1 = pts[(fi + 1) % n];
        const ex = p1.x - p0.x, ey = p1.y - p0.y;
        const elen = Math.sqrt(ex * ex + ey * ey);
        if (elen < 0.001) return;
        // CSG補正済み法線を使用
        let nx, ny;
        if (bldSelected?.csgNx != null) {
          nx = bldSelected.csgNx; ny = bldSelected.csgNy;
        } else {
          nx = ey / elen; ny = -ex / elen;
          const cx = pts.reduce((s, p) => s + p.x, 0) / n;
          const cy = pts.reduce((s, p) => s + p.y, 0) / n;
          const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
          if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
        }
        const newPts = pts.map((p, pi) => {
          if (pi === fi || pi === (fi + 1) % n) {
            return { x: p.x + nx * depthGrid, y: p.y + ny * depthGrid };
          }
          return { ...p };
        });
        const degreesList = [];
        newPts.forEach(p => { const g = gridToGeo(p.x, p.y); degreesList.push(g.lng, g.lat); });
        const zB = (origBlk.zBottom || 0) + localBase;
        const zT = (origBlk.zTop || 40) + localBase;
        v._extrudePreview = v.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(degreesList),
            height: zB,
            extrudedHeight: zT,
            material: Cesium.Color.LIME.withAlpha(0.3),
            outline: true, outlineColor: Cesium.Color.LIME,
          },
        });
      }
      v.scene.requestRender();
      return;
    }

    const depthM = faceSketchDepth / 1000;
    const zB = blk.zBottom || 0, zT = blk.zTop || 40;
    // extrude/rectpull中は元の建物エンティティを非表示（プレビューが中に隠れるのを防止）
    if (v._bldEntities) {
      const origEnt = v._bldEntities[bldSelected.entIdx];
      if (origEnt) origEnt.show = false;
      // 壁グラフィックスの追加エンティティも非表示
      if (v._bldExtraEntities) {
        v._bldExtraEntities.forEach(e => {
          if (e && e._bldFlatIdx === bldSelected.entIdx) e.show = false;
        });
      }
    }

    if (face === 'zTop' || face === 'zBottom') {
      const zBase = face === 'zTop' ? zT : zB;
      const zEnd = face === 'zTop' ? zBase + depthM : zBase - depthM;
      const degreesList = [];
      faceSketchPts.forEach(p => { const g = gridToGeo(p.gx, p.gy); degreesList.push(g.lng, g.lat); });
      v._extrudePreview = v.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(degreesList),
          height: Math.min(zBase, zEnd) + localBase,
          extrudedHeight: Math.max(zBase, zEnd) + localBase,
          material: Cesium.Color.LIME.withAlpha(0.3),
          outline: true, outlineColor: Cesium.Color.LIME,
        },
      });
    } else {
      // 側面: rectpullは常に統合ポリゴン、extrudeはZ範囲で判定
      const useUnified = isRectPull || (() => {
        const sketchZMin = Math.min(...faceSketchPts.map(p => p.gz));
        const sketchZMax = Math.max(...faceSketchPts.map(p => p.gz));

        return (sketchZMin <= zB + 0.5) && (sketchZMax >= zT - 0.5);
      })();

      if (useUnified) {
        // 統合プレビュー: computeExtrudedPolygonの変形後ポリゴンの壁を全て描画
        const newPts = computeExtrudedPolygon(blk, face, faceSketchPts, faceSketchDepth, false, bldSelected?.csgNx, bldSelected?.csgNy);
        if (!newPts) return;
        const bldColor = blk.color ? Cesium.Color.fromCssColorString(blk.color) : Cesium.Color.GRAY;
        const previewMat = bldColor.withAlpha(0.6);
        const previewZBot = zB + localBase;
        const previewZTop = zT + localBase;


        // 上面（変形後のポリゴン）
        const previewDegrees = [];
        newPts.forEach(p => { const g = gridToGeo(p.x, p.y); previewDegrees.push(g.lng, g.lat); });
        v._extrudePreview = v.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(previewDegrees),
            height: previewZTop,
            material: previewMat,
          },
        });
        if (!v._extrudePreviewExtras) v._extrudePreviewExtras = [];

        // 変形後ポリゴンの全壁を描画（隣接壁も調整済み）
        const newGeos = newPts.map(p => { const g = gridToGeo(p.x, p.y); return { lng: g.lng, lat: g.lat }; });
        for (let j = 0; j < newPts.length; j++) {
          const g0 = newGeos[j], g1 = newGeos[(j + 1) % newPts.length];
          v._extrudePreviewExtras.push(v.entities.add({
            wall: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                g0.lng, g0.lat, previewZTop, g1.lng, g1.lat, previewZTop,
              ]),
              minimumHeights: [previewZBot, previewZBot],
              material: previewMat,
            },
          }));
        }
      } else {
        // 部分高 → 突起のみのフットプリント + スケッチZ範囲
        const sketchZMin = Math.min(...faceSketchPts.map(p => p.gz));
        const sketchZMax = Math.max(...faceSketchPts.map(p => p.gz));
        const pts = blk.points;
        const n = pts.length;
        const fi = typeof face === 'number' ? face : parseInt(face, 10);
        if (isNaN(fi) || fi < 0 || fi >= n) return;
        const p0 = pts[fi], p1 = pts[(fi + 1) % n];
        const ex = p1.x - p0.x, ey = p1.y - p0.y;
        const elen = Math.sqrt(ex * ex + ey * ey);
        if (elen < 0.001) return;
        const edgeUx = ex / elen, edgeUy = ey / elen;
        let nx, ny;
        if (bldSelected?.csgNx != null) {
          nx = bldSelected.csgNx; ny = bldSelected.csgNy;
        } else {
          nx = ey / elen; ny = -ex / elen;
          const cx = pts.reduce((s, p) => s + p.x, 0) / n;
          const cy = pts.reduce((s, p) => s + p.y, 0) / n;
          const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
          if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
        }
        const uValues = faceSketchPts.map(p => (p.gx - p0.x) * edgeUx + (p.gy - p0.y) * edgeUy);
        const uMin = Math.max(0, Math.min(...uValues));
        const uMax = Math.min(elen, Math.max(...uValues));
        const depthGrid = depthM / METERS_PER_PX;
        const e0x = p0.x + uMin * edgeUx, e0y = p0.y + uMin * edgeUy;
        const e1x = p0.x + uMax * edgeUx, e1y = p0.y + uMax * edgeUy;
        const overlap = 2.0 / METERS_PER_PX;
        const footprint = [
          { x: e0x - nx * overlap, y: e0y - ny * overlap },
          { x: e0x + nx * depthGrid, y: e0y + ny * depthGrid },
          { x: e1x + nx * depthGrid, y: e1y + ny * depthGrid },
          { x: e1x - nx * overlap, y: e1y - ny * overlap },
        ];
        const degreesList = [];
        footprint.forEach(p => { const g = gridToGeo(p.x, p.y); degreesList.push(g.lng, g.lat); });
        v._extrudePreview = v.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(degreesList),
            height: sketchZMin + localBase,
            extrudedHeight: sketchZMax + localBase,
            material: Cesium.Color.LIME.withAlpha(0.3),
            outline: true, outlineColor: Cesium.Color.LIME,
          },
        });
      }
    }
    v.scene.requestRender();
    return () => {
      if (v.isDestroyed()) return;
      if (v._extrudePreview && v.entities.contains(v._extrudePreview)) {
        v.entities.remove(v._extrudePreview);
        v._extrudePreview = null;
      }
      if (v._extrudePreviewExtras) {
        v._extrudePreviewExtras.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
        v._extrudePreviewExtras = [];
      }
      // 非表示にした元の建物エンティティを復元
      if (v._bldEntities && bldSelected) {
        const origEnt = v._bldEntities[bldSelected.entIdx];
        if (origEnt) origEnt.show = true;
        if (v._bldExtraEntities) {
          v._bldExtraEntities.forEach(e => {
            if (e && e._bldFlatIdx === bldSelected.entIdx) e.show = true;
          });
        }
      }
    };
  }, [faceSketchPhase, faceSketchDepth, faceSketchPts, bldSelected, blds, computeExtrudedPolygon]);

  // グリッド座標→画面座標変換ヘルパー
  const gridToScreen = useCallback((gx, gy, z) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return null;
    const geo = gridToGeo(gx, gy);
    const c3 = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, z);
    return Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, c3);
  }, []);

  // 辺の外向き法線を計算（グリッド座標空間 — カメラ非依存で安定）
  const edgeNormalGrid = useCallback((pts, edgeIdx) => {
    const n = pts.length;
    const p0 = pts[edgeIdx], p1 = pts[(edgeIdx + 1) % n];
    const ex = p1.x - p0.x, ey = p1.y - p0.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 0.001) return { nx: 0, ny: -1 };
    let nx = ey / len, ny = -ex / len;
    const cx = pts.reduce((s, p) => s + p.x, 0) / n;
    const cy = pts.reduce((s, p) => s + p.y, 0) / n;
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    return { nx, ny };
  }, []);

  // CSG補正済み外向き法線を計算（1回計算して全システムで共有する唯一の法線）
  // CSG結果(親-子)の箱の外側を向く法線を返す
  const computeCSGNormal = useCallback((blk, edgeIdx, allBlds) => {
    const pts = blk.points;
    if (!pts || pts.length < 3) return null;
    const n = pts.length;
    if (edgeIdx < 0 || edgeIdx >= n) return null;
    // edgeNormalGrid: ポリゴン重心から外向き
    const p0 = pts[edgeIdx], p1 = pts[(edgeIdx + 1) % n];
    const ex = p1.x - p0.x, ey = p1.y - p0.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 0.001) return { nx: 0, ny: -1 };
    let nx = ey / len, ny = -ex / len;
    const cx = pts.reduce((s, p) => s + p.x, 0) / n;
    const cy = pts.reduce((s, p) => s + p.y, 0) / n;
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const origNx = nx, origNy = ny;

    // 子ブロックの場合、CSG PIPで補正
    if (blk._parentBlockIdx != null && allBlds) {
      const siblings = allBlds.filter(b => b.buildingId === blk.buildingId);
      const parents = siblings.filter(b => b._parentBlockIdx == null);
      const children = siblings.filter(b => b._parentBlockIdx != null);
      const testPt = { x: mx + nx * 5, y: my + ny * 5 };
      const pip = (pt, poly) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) &&
              pt.x < (poly[j].x - poly[i].x) * (pt.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x)
            inside = !inside;
        }
        return inside;
      };
      let inAnyParent = false;
      for (const p of parents) { if (pip(testPt, p.points || [])) { inAnyParent = true; break; } }
      let inAnyChild = false;
      for (const c of children) { if (pip(testPt, c.points || [])) { inAnyChild = true; break; } }
      // 固体(親内部かつ子外部) → 法線が箱の内側を向いている → 反転
      if (inAnyParent && !inAnyChild) { nx = -nx; ny = -ny; }
    }
    return { nx, ny, origNx, origNy, reversed: (nx !== origNx || ny !== origNy) };
  }, []);

  // 矢印の画面座標を計算（グリッド空間の法線→画面座標変換でカメラ角度に依存しない方向）
  // verbose=true: クリック時のみ詳細ログ出力、false: カメラ移動時はログなし
  const computeArrowScreen = useCallback((blk, face, sel, verbose) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return null;

    // ★ solidFaceId対応: Solid面の法線から直接矢印を計算
    // solidFaceIdがある場合は必ずこのパスで処理（fallthroughすると旧パスでクラッシュ）
    if (sel && sel.solidFaceId && typeof sel.face === 'string' && sel.face.startsWith('f')) {
      if (!sel._solidNormal) return null; // 法線がない場合は矢印非表示
    }
    if (sel && sel.solidFaceId && sel._solidNormal) {
      // 現在のソリッド状態から面中心をライブ取得（伸縮後も正しい位置に追従）
      let cx = sel._faceCenterX, cy = sel._faceCenterY, cz = sel._faceCenterZ;
      let sn = sel._solidNormal;
      const _liveCs = v._currentSolids || [];
      const _liveTs = _liveCs.find(s => s.buildingId === sel.buildingId);
      // ①IDで直接検索 → ②面タイプで検索 → ③edgeIdxで検索（SOLID_SYNC再生成後のID変化に対応）
      let _liveTf = _liveTs && _liveTs.faces.find(f => f.id === sel.solidFaceId);
      if (!_liveTf && _liveTs) {
        const _ftype = sel.face === 'zTop' ? 'top' : sel.face === 'zBottom' ? 'bottom' : null;
        if (_ftype) _liveTf = _liveTs.faces.find(f => f.type === _ftype);
      }
      if (!_liveTf && _liveTs && typeof sel.face === 'number') {
        // 辺インデックスで対応する壁面を探す（辺移動後の面追従用）
        _liveTf = _liveTs.faces.find(f => f._edgeIdx === sel.face && f.type === 'wall');
      }
      if (_liveTf && _liveTf.vertices && _liveTf.vertices.length > 0) {
        const vv = _liveTf.vertices;
        cx = vv.reduce((s, p) => s + p.x, 0) / vv.length;
        cy = vv.reduce((s, p) => s + p.y, 0) / vv.length;
        cz = vv.reduce((s, p) => s + p.z, 0) / vv.length;
        sn = _liveTf.normal || sn;
      }
      if (cx == null || cy == null || cz == null || !sn) return null;
      let baseElev = v._siteBaseElevation || 0;
      if (v.scene.globe && v.scene.globe.show) {
        const g = gridToGeo(cx, cy);
        const c = Cesium.Cartographic.fromDegrees(g.lng, g.lat);
        const gh = v.scene.globe.getHeight(c);
        if (gh != null && gh > -500) baseElev = gh;
      }
      const ARROW_PX = 60;
      const arrowG = 30;
      const bS = gridToScreen(cx, cy, baseElev + cz);
      const tS = gridToScreen(cx + sn.nx * arrowG, cy + sn.ny * arrowG, baseElev + cz + sn.nz * arrowG);
      if (!bS || !tS) return null;
      const sdx = tS.x - bS.x, sdy = tS.y - bS.y;
      const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
      if (sLen < 1) return null;
      const scale = ARROW_PX / sLen;
      if (verbose) console.warn('[ARROW_SOLID] solid面法線で矢印計算', { solidFaceId: sel.solidFaceId, normal: sn, center: { cx, cy, cz } });
      return { baseX: bS.x, baseY: bS.y, tipX: bS.x + sdx * scale, tipY: bS.y + sdy * scale, face: sel.solidFaceId };
    }

    const pts = blk.points;
    if (!pts || pts.length < 3) return null;
    // 建屋ごとのローカル地表面標高を使用（レンダリングと一致させる）
    let baseElev = v._siteBaseElevation || 0;
    if (v.scene.globe && v.scene.globe.show) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const g = gridToGeo(cx, cy);
      const c = Cesium.Cartographic.fromDegrees(g.lng, g.lat);
      const gh = v.scene.globe.getHeight(c);
      if (gh != null && gh > -500) baseElev = gh;
    }
    const zT = (blk.zTop != null ? blk.zTop : 40);
    const zB = (blk.zBottom || 0);
    const zMid = (zB + zT) / 2;
    const ARROW_PX = 60;
    const z = baseElev + zMid;

    // zTop/zBottom面: 親箱の外側を向く
    // 親ブロック: zTop→上, zBottom→下
    // カーブ子ブロック: 面が親内部に接するなら逆転（CSG外向き）
    if (face === 'zTop' || face === 'zBottom') {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const zBase = baseElev + (face === 'zTop' ? zT : zB);
      let zDir = face === 'zTop' ? 30 : -30;
      // カーブ子: 親のZ範囲内にある面は内向き → 反転
      if (blk._parentBlockIdx != null && blds) {
        const parent = blds.find(b => b.buildingId === blk.buildingId && b.blockIdx === blk._parentBlockIdx);
        if (parent) {
          const pZB = parent.zBottom || 0, pZT = parent.zTop != null ? parent.zTop : 40;
          if (face === 'zBottom' && zB > pZB + 0.1 && zB < pZT - 0.1) zDir = 30;  // 親内部→上が外向き
          if (face === 'zTop' && zT < pZT - 0.1 && zT > pZB + 0.1) zDir = -30;    // 親内部→下が外向き
        }
      }
      const zTip = zBase + zDir;
      const bS = gridToScreen(cx, cy, zBase);
      const tS = gridToScreen(cx, cy, zTip);
      if (!bS || !tS) return null;
      const sdx = tS.x - bS.x, sdy = tS.y - bS.y;
      const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
      if (sLen < 2) return { baseX: bS.x, baseY: bS.y, tipX: bS.x, tipY: bS.y - ARROW_PX, face };
      const scale = ARROW_PX / sLen;
      return { baseX: bS.x, baseY: bS.y, tipX: bS.x + sdx * scale, tipY: bS.y + sdy * scale, face };
    }

    // 側面: グリッド空間の法線方向を画面座標に変換（カメラ角度に依存しない安定した方向）
    const edgeIdx = typeof face === 'number' ? face : parseInt(face, 10);
    if (isNaN(edgeIdx) || edgeIdx < 0 || edgeIdx >= pts.length) return null;
    const n = pts.length;
    const p0 = pts[edgeIdx], p1 = pts[(edgeIdx + 1) % n];
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    // CSG補正済み法線を取得（selに保存済みなら再利用、なければ再計算）
    let nx, ny;
    if (sel && sel.csgNx != null) {
      nx = sel.csgNx; ny = sel.csgNy;
    } else {
      const csgResult = computeCSGNormal(blk, edgeIdx, blds || []);
      if (!csgResult) return null;
      nx = csgResult.nx; ny = csgResult.ny;
    }
    if (verbose) {
      console.warn('[ARROW_FINAL] 矢印法線', `(${nx.toFixed(3)}, ${ny.toFixed(3)})`,
        blk._parentBlockIdx != null ? '子ブロック面' : '親ブロック面',
        sel?.csgNx != null ? '(sel.csgNx使用)' : '(再計算)');
    }
    // 法線方向の先端をグリッド座標で計算
    const arrowG = 30; // グリッド空間での矢印長さ
    const tipGX = mx + nx * arrowG, tipGY = my + ny * arrowG;
    // 基点と先端をそれぞれ画面座標に変換
    const bS = gridToScreen(mx, my, z);
    const tS = gridToScreen(tipGX, tipGY, z);
    if (!bS || !tS) return null;
    // 画面座標での方向を正規化してARROW_PXに固定
    const sdx = tS.x - bS.x, sdy = tS.y - bS.y;
    const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
    if (sLen < 1) return null;
    const scale = ARROW_PX / sLen;
    return { baseX: bS.x, baseY: bS.y, tipX: bS.x + sdx * scale, tipY: bS.y + sdy * scale, face };
  }, [mode, gridToScreen, edgeNormalGrid, computeCSGNormal, blds]);

  // 面で作図: 押し出し矢印の画面座標を計算＆カメラ追従
  const computeExtrudeArrowScreen = useCallback(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || faceSketchPhase !== 'extrude' || faceSketchPts.length < 3 || !bldSelected) return null;
    const blk = (blds || [])[bldSelected.entIdx];
    if (!blk) return null;
    const face = bldSelected.face;
    const baseElev = v._siteBaseElevation || 0;
    const cgx = faceSketchPts.reduce((s, p) => s + p.gx, 0) / faceSketchPts.length;
    const cgy = faceSketchPts.reduce((s, p) => s + p.gy, 0) / faceSketchPts.length;
    const cgz = faceSketchPts.reduce((s, p) => s + p.gz, 0) / faceSketchPts.length;
    const ARROW_PX = 70;
    if (face === 'zTop' || face === 'zBottom') {
      const dir = face === 'zTop' ? 1 : -1;
      const bS = gridToScreen(cgx, cgy, cgz + baseElev);
      const tS = gridToScreen(cgx, cgy, cgz + baseElev + dir * 30);
      if (!bS || !tS) return null;
      const sdx = tS.x - bS.x, sdy = tS.y - bS.y;
      const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
      if (sLen < 2) return null;
      const scale = ARROW_PX / sLen;
      return { baseX: bS.x, baseY: bS.y, dirX: sdx / sLen, dirY: sdy / sLen, tipX: bS.x + sdx * scale, tipY: bS.y + sdy * scale };
    } else {
      const pts = blk.points;
      const n = pts.length;
      const fi = typeof face === 'number' ? face : parseInt(face, 10);
      const p0 = pts[fi], p1 = pts[(fi + 1) % n];
      const ex = p1.x - p0.x, ey = p1.y - p0.y;
      const elen = Math.sqrt(ex * ex + ey * ey);
      if (elen < 0.001) return null;
      let nx = ey / elen, ny = -ex / elen;
      const cx = pts.reduce((s, p) => s + p.x, 0) / n;
      const cy = pts.reduce((s, p) => s + p.y, 0) / n;
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
      const bS = gridToScreen(cgx, cgy, cgz + baseElev);
      const tS = gridToScreen(cgx + nx * 30, cgy + ny * 30, cgz + baseElev);
      if (!bS || !tS) return null;
      const sdx = tS.x - bS.x, sdy = tS.y - bS.y;
      const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
      if (sLen < 2) return null;
      const scale = ARROW_PX / sLen;
      return { baseX: bS.x, baseY: bS.y, dirX: sdx / sLen, dirY: sdy / sLen, tipX: bS.x + sdx * scale, tipY: bS.y + sdy * scale };
    }
  }, [faceSketchPhase, faceSketchPts, bldSelected, blds, gridToScreen]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || faceSketchPhase !== 'extrude') {
      setExtrudeArrow(null);
      return;
    }
    const update = () => setExtrudeArrow(computeExtrudeArrowScreen());
    update();
    const remove = v.scene.postRender.addEventListener(update);
    return () => remove();
  }, [faceSketchPhase, computeExtrudeArrowScreen]);

  // 建屋クリック選択 & 面選択 & 矢印ドラッグ移動
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || bldAddMode || fieldDrawMode || faceSketchPhase) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const canvas = v.scene.canvas;

    // レイと三角形の交差判定（Möller-Trumbore）、交差距離を返す
    const rayTriIntersect = (ray, v0, v1, v2) => {
      const e1 = Cesium.Cartesian3.subtract(v1, v0, new Cesium.Cartesian3());
      const e2 = Cesium.Cartesian3.subtract(v2, v0, new Cesium.Cartesian3());
      const h = Cesium.Cartesian3.cross(ray.direction, e2, new Cesium.Cartesian3());
      const a = Cesium.Cartesian3.dot(e1, h);
      if (Math.abs(a) < 1e-10) return null;
      const f = 1.0 / a;
      const s = Cesium.Cartesian3.subtract(ray.origin, v0, new Cesium.Cartesian3());
      const u = f * Cesium.Cartesian3.dot(s, h);
      if (u < 0 || u > 1) return null;
      const q = Cesium.Cartesian3.cross(s, e1, new Cesium.Cartesian3());
      const vv = f * Cesium.Cartesian3.dot(ray.direction, q);
      if (vv < 0 || u + vv > 1) return null;
      const t = f * Cesium.Cartesian3.dot(e2, q);
      return t > 0 ? t : null;
    };

    // ブロックのローカル地表面標高を取得
    const getLocalBase = (pts) => {
      let localBase = v._siteBaseElevation || 0;
      if (v.scene.globe && v.scene.globe.show) {
        const n = pts.length;
        const cx = pts.reduce((s, p) => s + p.x, 0) / n;
        const cy = pts.reduce((s, p) => s + p.y, 0) / n;
        const g = gridToGeo(cx, cy);
        const c = Cesium.Cartographic.fromDegrees(g.lng, g.lat);
        const gh = v.scene.globe.getHeight(c);
        if (gh != null && gh > -500) localBase = gh;
      }
      return localBase;
    };

    // ear-clipping triangulation (任意多角形対応、自己交差にも頑健)
    const earClip = (pts2D) => {
      const n = pts2D.length;
      if (n < 3) return [];
      // 巻き方向確定 (CCW)
      let area = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts2D[i].x * pts2D[j].y - pts2D[j].x * pts2D[i].y;
      }
      const indices = area >= 0 ? pts2D.map((_, i) => i) : pts2D.map((_, i) => n - 1 - i);
      const tris = [];
      const verts = [...indices];
      const _isConvex = (a, b, c) => {
        const ax = pts2D[b].x - pts2D[a].x, ay = pts2D[b].y - pts2D[a].y;
        const bx = pts2D[c].x - pts2D[b].x, by = pts2D[c].y - pts2D[b].y;
        return ax * by - ay * bx > 0;
      };
      const _ptInTri = (p, a, b, c) => {
        const ax = pts2D[a].x, ay = pts2D[a].y;
        const bx = pts2D[b].x, by = pts2D[b].y;
        const cx = pts2D[c].x, cy = pts2D[c].y;
        const d1 = (p.x - bx) * (ay - by) - (ax - bx) * (p.y - by);
        const d2 = (p.x - cx) * (by - cy) - (bx - cx) * (p.y - cy);
        const d3 = (p.x - ax) * (cy - ay) - (cx - ax) * (p.y - ay);
        const hN = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hP = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(hN && hP);
      };
      let safety = n * n;
      while (verts.length > 3 && safety-- > 0) {
        let earFound = false;
        for (let i = 0; i < verts.length; i++) {
          const a = verts[(i - 1 + verts.length) % verts.length];
          const b = verts[i];
          const c = verts[(i + 1) % verts.length];
          if (!_isConvex(a, b, c)) continue;
          let hasPt = false;
          for (let k = 0; k < verts.length; k++) {
            const v = verts[k];
            if (v === a || v === b || v === c) continue;
            if (_ptInTri(pts2D[v], a, b, c)) { hasPt = true; break; }
          }
          if (hasPt) continue;
          tris.push([a, b, c]);
          verts.splice(i, 1);
          earFound = true;
          break;
        }
        if (!earFound) break;
      }
      if (verts.length === 3) tris.push([verts[0], verts[1], verts[2]]);
      return tris;
    };

    // ブロックの全面をレイキャストし、交差候補リストを返す
    const detectFaceCandidates = (ray, blk) => {
      const pts = blk.points;
      const n = pts.length;
      const baseElev = getLocalBase(pts);
      const zT = blk.zTop != null ? blk.zTop : 40;
      const zB = blk.zBottom || 0;
      const candidates = [];

      // ear-clipping で上面/下面を三角分割（自己交差/凹型に頑健）
      const _tris = earClip(pts);

      // 上面
      const topPts = pts.map(p => {
        const g = gridToGeo(p.x, p.y);
        return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, baseElev + zT);
      });
      for (const [a, b, c] of _tris) {
        const t = rayTriIntersect(ray, topPts[a], topPts[b], topPts[c]);
        if (t != null) { candidates.push({ face: 'zTop', dist: t }); break; }
      }

      // 下面
      const botPts = pts.map(p => {
        const g = gridToGeo(p.x, p.y);
        return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, baseElev + zB);
      });
      for (const [a, b, c] of _tris) {
        // 下面は逆順で(逆向き法線)
        const t = rayTriIntersect(ray, botPts[a], botPts[c], botPts[b]);
        if (t != null) { candidates.push({ face: 'zBottom', dist: t }); break; }
      }

      // 側面 (壁を平面として扱い、交点が辺範囲内かチェック)
      for (let i = 0; i < n; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % n];
        const g0 = gridToGeo(p0.x, p0.y);
        const g1 = gridToGeo(p1.x, p1.y);
        const c0b = Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, baseElev + zB);
        const c1b = Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, baseElev + zB);
        const c0t = Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, baseElev + zT);
        const c1t = Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, baseElev + zT);
        const t1 = rayTriIntersect(ray, c0b, c1b, c1t);
        const t2 = rayTriIntersect(ray, c0b, c1t, c0t);
        const t = (t1 != null && t2 != null) ? Math.min(t1, t2) : (t1 || t2);
        if (t == null) continue;
        // 交点を計算
        const _hx = ray.origin.x + ray.direction.x * t;
        const _hy = ray.origin.y + ray.direction.y * t;
        const _hz = ray.origin.z + ray.direction.z * t;
        // 交点を辺AB(c0b→c1b)に投影してパラメータ取得
        const _abx = c1b.x - c0b.x, _aby = c1b.y - c0b.y, _abz = c1b.z - c0b.z;
        const _ab2 = _abx * _abx + _aby * _aby + _abz * _abz;
        if (_ab2 < 1e-10) continue;
        const _u = ((_hx - c0b.x) * _abx + (_hy - c0b.y) * _aby + (_hz - c0b.z) * _abz) / _ab2;
        // 上下方向の投影
        const _upx = c0t.x - c0b.x, _upy = c0t.y - c0b.y, _upz = c0t.z - c0b.z;
        const _up2 = _upx * _upx + _upy * _upy + _upz * _upz;
        if (_up2 < 1e-10) continue;
        const _vv = ((_hx - c0b.x) * _upx + (_hy - c0b.y) * _upy + (_hz - c0b.z) * _upz) / _up2;
        // 厳密な辺範囲チェック (誤差0.01以内)
        if (_u < -0.01 || _u > 1.01) continue;
        if (_vv < -0.01 || _vv > 1.01) continue;
        candidates.push({ face: i, dist: t });
      }
      return candidates;
    };

    // クリック位置から最も近い面を判定（1ブロック対象）
    const detectFace = (clickPos, blk) => {
      const ray = v.camera.getPickRay(clickPos);
      if (!ray) return 0;
      const candidates = detectFaceCandidates(ray, blk);
      if (candidates.length === 0) return 0;
      candidates.sort((a, b) => a.dist - b.dist);
      return candidates[0].face;
    };

    // 全ブロック横断レイキャスト: 現在選択中の面をスキップし次に近い面を返す
    const detectFaceAllBlocks = (clickPos, buildingId, skipEntIdx, skipFace) => {
      const ray = v.camera.getPickRay(clickPos);
      if (!ray) return null;
      const _blds = blds || [];
      const allHits = [];
      for (let i = 0; i < _blds.length; i++) {
        const b = _blds[i];
        if (b.buildingId !== buildingId) continue;
        const candidates = detectFaceCandidates(ray, b);
        for (const c of candidates) {
          allHits.push({ entIdx: i, face: c.face, dist: c.dist });
        }
      }
      allHits.sort((a, b) => a.dist - b.dist);
      // 現在選択中の面と同一ブロック+同一面をスキップ
      for (const hit of allHits) {
        if (hit.entIdx === skipEntIdx && hit.face === skipFace) continue;
        return hit;
      }
      return allHits[0] || null;
    };

    // 建屋クリック選択/解除
    // クリックしたエンティティに_faceInfoがあれば直接そのブロック+面を選択
    // なければ従来のレイキャストで面を判定
    handler.setInputAction((click) => {
      if (dragStateRef?.current || draggingNodeRef.current || draggingAxisRef.current) return;
      const picked = v.scene.pick(click.position);
      // ピック結果 + 全ブロックレイキャスト診断
      const _ray = v.camera.getPickRay(click.position);
      let _rayHits = [];
      if (_ray && blds) {
        (blds || []).forEach((blk, i) => {
          const hits = detectFaceCandidates(_ray, blk);
          hits.forEach(h => _rayHits.push({ entIdx: i, blockIdx: blk.blockIdx, face: h.face, dist: h.dist.toFixed(1) }));
        });
        _rayHits.sort((a, b) => parseFloat(a.dist) - parseFloat(b.dist));
      }
      // 頂点クリック検出
      if (picked && picked.id && picked.id._vertexInfo) {
        const vi = picked.id._vertexInfo;
        console.warn('[VERTEX_CLICK] 頂点クリック', {
          flatIdx: vi.flatIdx,
          faceId: vi.faceId,
          vertIdx: vi.vertIdx,
          座標: `gx=${vi.gx.toFixed(1)} gy=${vi.gy.toFixed(1)} gz=${vi.gz.toFixed(1)}`,
        });
        // クリックした頂点のリストを蓄積（window._clickedVerts）
        if (!window._clickedVerts) window._clickedVerts = [];
        window._clickedVerts.push(vi);
        console.warn('[VERTEX_CLICK] 蓄積頂点数:', window._clickedVerts.length,
          window._clickedVerts.map((v2,i) => `${i}: (${v2.gx.toFixed(1)},${v2.gy.toFixed(1)},z=${v2.gz.toFixed(1)})`).join(' → ')
        );
      }
      if (window._cesiumDebug) console.warn('[CLICK] picked', {
        hasEntity: !!(picked && picked.id),
        _faceInfo_exists: !!(picked && picked.id && picked.id._faceInfo),
        _faceInfo: picked && picked.id && picked.id._faceInfo ? picked.id._faceInfo : null,
        _bldFlatIdx: picked && picked.id ? picked.id._bldFlatIdx : undefined,
        inBldEntities: !!(picked && picked.id && v._bldEntities && v._bldEntities.includes(picked.id)),
        面ヒット: _rayHits.length > 0 ? _rayHits.map(h => `blk#${h.blockIdx} face${h.face} d=${h.dist}`).join(' | ') : '⚠️なし(面が存在しない)',
      });
      // _faceInfoがあれば直接使用（上下面、側壁等）
      const _blds = blds || [];
      if (picked && picked.id && picked.id._faceInfo) {
        const fi = picked.id._faceInfo;
        const entIdx = fi.entIdx;
        const blk = _blds[entIdx];
        if (blk) {
          // ★ solidFaceId対応: Solid面を直接選択
          const solidFaceId = fi.solidFaceId || fi.faceId;
          const solidNormal = fi.normal;
          const currentSolids = (viewerRef.current && viewerRef.current._currentSolids) || solids || [];
          const targetSolid = currentSolids.find(s => s.faces && s.faces.some(f => f.id === solidFaceId));
          const solidFace = targetSolid ? targetSolid.faces.find(f => f.id === solidFaceId) : null;

          // face値: 従来互換('zTop','zBottom')またはsolidFaceId
          let face;
          if (solidFace) {
            if (solidFace.type === 'top') face = 'zTop';
            else if (solidFace.type === 'bottom') face = 'zBottom';
            else face = solidFaceId; // 壁面・段差壁等はsolidFaceIdをそのまま使用
          } else {
            face = fi.face != null ? fi.face : detectFace(click.position, blk);
          }

          // 面の重心を計算（矢印表示用）
          let _fcx = 0, _fcy = 0, _fcz = 0;
          if (solidFace) {
            const sv = solidFace.vertices;
            sv.forEach(p => { _fcx += p.x; _fcy += p.y; _fcz += p.z; });
            _fcx /= sv.length; _fcy /= sv.length; _fcz /= sv.length;
          }

          const n = blk.points.length;
          const edgeIdx = typeof face === 'number' ? face : -1;
          const csgN = edgeIdx >= 0 ? computeCSGNormal(blk, edgeIdx, _blds) : null;
          const sel = {
            buildingId: blk.buildingId, blockIdx: blk.blockIdx, entIdx, label: blk.label, face,
            solidFaceId,
            _solidNormal: solidNormal || (solidFace ? solidFace.normal : null),
            _faceCenterX: _fcx, _faceCenterY: _fcy, _faceCenterZ: _fcz,
            ...(csgN ? { csgNx: csgN.nx, csgNy: csgN.ny } : {}),
          };
          const faceLabel = solidFace
            ? `${solidFaceId}(${solidFace.type},${solidFace.vertices.length}v)`
            : (edgeIdx >= 0 ? `側面${edgeIdx}` : String(face));
          console.warn(`[FACE_SELECT] ★選択された面: ${faceLabel}`, {
            entIdx, face, solidFaceId, buildingId: blk.buildingId, blockIdx: blk.blockIdx,
            solidNormal: solidNormal ? `(${solidNormal.nx.toFixed(3)},${solidNormal.ny.toFixed(3)},${solidNormal.nz.toFixed(3)})` : 'N/A',
            faceType: solidFace?.type, faceVertices: solidFace?.vertices?.length,
          });
          setBldSelected(sel);
          originalBlockRef.current = { points: blk.points.map(p => ({ ...p })), zBottom: blk.zBottom || 0, zTop: blk.zTop != null ? blk.zTop : 40 };
          updateArrowScreen(computeArrowScreen(blk, face, sel, true));
          // ── 矢印方向の妥当性チェック: 箱の外/内 ──
          try {
            const _allBlds = blds || [];
            const _bid = blk.buildingId;
            const _siblings = _allBlds.filter(b => b.buildingId === _bid);
            const _parents = _siblings.filter(b => b._parentBlockIdx == null);
            const _children = _siblings.filter(b => b._parentBlockIdx != null);
            const _pip = (pt, poly) => {
              let inside = false;
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) &&
                    pt.x < (poly[j].x - poly[i].x) * (pt.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x)
                  inside = !inside;
              }
              return inside;
            };
            const _isSolidAt = (px, py, pz) => {
              let inAnyParent = false;
              for (const p of _parents) {
                if (!_pip({x: px, y: py}, p.points || [])) continue;
                const pZB = p.zBottom || 0, pZT = p.zTop != null ? p.zTop : 40;
                if (pz >= pZB - 0.01 && pz <= pZT + 0.01) { inAnyParent = true; break; }
              }
              if (!inAnyParent) return false;
              for (const c of _children) {
                // Z面子ブロック（_sharedWall無し）は親から切り取られた空間
                if (!c._sharedWall) {
                  if (!_pip({x: px, y: py}, c.points || [])) continue;
                  const cZB = c.zBottom || 0, cZT = c.zTop != null ? c.zTop : 40;
                  if (pz >= cZB - 0.01 && pz <= cZT + 0.01) return false;
                }
              }
              return true;
            };
            // 面中心 + 法線方向の小さなオフセット点
            const _zB = blk.zBottom || 0, _zT = blk.zTop != null ? blk.zTop : 40;
            let _testX, _testY, _testZ, _arrowDir;
            const OFF = 2.0; // 2m先をテスト
            if (face === 'zTop' || face === 'zBottom') {
              const _cx = blk.points.reduce((s, p) => s + p.x, 0) / blk.points.length;
              const _cy = blk.points.reduce((s, p) => s + p.y, 0) / blk.points.length;
              _testX = _cx; _testY = _cy;
              // 矢印が指している方向 (computeArrowScreenの規約)
              let _zSign = face === 'zTop' ? 1 : -1;
              if (blk._parentBlockIdx != null) {
                const _par = _allBlds.find(b => b.buildingId === _bid && b.blockIdx === blk._parentBlockIdx);
                if (_par) {
                  const pZB = _par.zBottom || 0, pZT = _par.zTop != null ? _par.zTop : 40;
                  if (face === 'zBottom' && _zB > pZB + 0.1 && _zB < pZT - 0.1) _zSign = 1;
                  if (face === 'zTop' && _zT < pZT - 0.1 && _zT > pZB + 0.1) _zSign = -1;
                }
              }
              _testZ = (face === 'zTop' ? _zT : _zB) + _zSign * OFF / METERS_PER_PX * METERS_PER_PX; // mで加算
              _testZ = (face === 'zTop' ? _zT : _zB) + _zSign * OFF;
              _arrowDir = _zSign > 0 ? '上(+Z)' : '下(-Z)';
            } else if (sel._solidNormal) {
              // solidFaceId面: solid面法線から方向を取得
              const sn = sel._solidNormal;
              _testX = sel._faceCenterX + sn.nx * OFF / METERS_PER_PX;
              _testY = sel._faceCenterY + sn.ny * OFF / METERS_PER_PX;
              _testZ = sel._faceCenterZ + sn.nz * OFF;
              _arrowDir = `solid(${sn.nx.toFixed(2)},${sn.ny.toFixed(2)},${sn.nz.toFixed(2)})`;
            } else {
              const _ei = typeof face === 'number' ? face : parseInt(face, 10);
              if (isNaN(_ei) || _ei < 0 || _ei >= blk.points.length) throw new Error('invalid edgeIdx');
              const _p0 = blk.points[_ei], _p1 = blk.points[(_ei + 1) % blk.points.length];
              const _mx = (_p0.x + _p1.x) / 2, _my = (_p0.y + _p1.y) / 2;
              const _nx = csgN ? csgN.nx : 0, _ny = csgN ? csgN.ny : 0;
              const _offGrid = OFF / METERS_PER_PX;
              _testX = _mx + _nx * _offGrid;
              _testY = _my + _ny * _offGrid;
              _testZ = (_zB + _zT) / 2;
              _arrowDir = `XY(${_nx.toFixed(2)},${_ny.toFixed(2)})`;
            }
            const _isSolid = _isSolidAt(_testX, _testY, _testZ);
            const _avMsg = {
              面: faceLabel,
              矢印が指す方向: _arrowDir,
              テスト点: `(${_testX.toFixed(1)},${_testY.toFixed(1)},z=${_testZ.toFixed(1)})_2m先`,
              判定結果: _isSolid ? '⚠️固体側_箱の内側_矢印が逆' : '✅空気側_箱の外側_正しい',
              ブロックZ範囲: `${_zB.toFixed(1)}→${_zT.toFixed(1)}`,
              isChild: blk._parentBlockIdx != null,
              isChild: blk._parentBlockIdx != null,
            };
            console.warn('[ARROW_VALIDATE] 矢印方向の妥当性', _avMsg);
            // 永続化
            if (!window._diagLog) window._diagLog = [];
            window._diagLog.push('[ARROW_VALIDATE] ' + JSON.stringify(_avMsg));
            if (window._diagLog.length > 200) window._diagLog.shift();
          } catch(e) { console.warn('[ARROW_VALIDATE] エラー', e.message); }
          v.scene.requestRender();
          return;
        }
      }

      // extraエンティティ（壁・上下面）がピックされた場合、対応するブロックのインデックスを取得
      let resolvedEntIdx = -1;
      if (picked && picked.id && v._bldEntities) {
        if (v._bldEntities.includes(picked.id)) {
          resolvedEntIdx = v._bldEntities.indexOf(picked.id);
        } else if (picked.id._bldFlatIdx != null) {
          resolvedEntIdx = picked.id._bldFlatIdx;
        }
      }
      if (resolvedEntIdx >= 0) {
        const entIdx = resolvedEntIdx;
        const blk = _blds[entIdx];
        if (!blk) return;
        const face = detectFace(click.position, blk);
        // レンダリング法線は子ブロック反転が不完全なため無効化
        let _outNx, _outNy;
        if (false && typeof face === 'number' && v._bldExtraEntities) {
          const _fp0 = blk.points[face], _fp1 = blk.points[(face + 1) % blk.points.length];
          const _fmx = (_fp0.x + _fp1.x) / 2, _fmy = (_fp0.y + _fp1.y) / 2;
          let _bestDist = Infinity;
          for (const ext of v._bldExtraEntities) {
            if (ext && ext._faceInfo && ext._faceInfo.outwardNx != null && ext._bldFlatIdx === entIdx) {
              _outNx = ext._faceInfo.outwardNx;
              _outNy = ext._faceInfo.outwardNy;
              _bestDist = 0;
              break;
            }
            // entIdxが違う場合でも、同じ辺上の壁なら法線を使う
            if (ext && ext._faceInfo && ext._faceInfo.outwardNx != null && ext._faceInfo.face === face) {
              // 法線方向が面辺と直交するか確認
              const _enx = ext._faceInfo.outwardNx, _eny = ext._faceInfo.outwardNy;
              const _edx = _fp1.x - _fp0.x, _edy = _fp1.y - _fp0.y;
              const _elen = Math.sqrt(_edx * _edx + _edy * _edy);
              if (_elen > 0.01) {
                const _dot = Math.abs((_edx / _elen) * _enx + (_edy / _elen) * _eny);
                if (_dot < 0.1 && _bestDist > 0) { // ほぼ直交 = 正しい法線
                  _outNx = _enx; _outNy = _eny;
                  _bestDist = 0;
                }
              }
            }
          }
        }
        const n = blk.points.length;
        const edgeIdx = typeof face === 'number' ? face : -1;
        // CSG補正済み法線を計算してselに格納
        const csgN2 = edgeIdx >= 0 ? computeCSGNormal(blk, edgeIdx, _blds) : null;
        const sel = { buildingId: blk.buildingId, blockIdx: blk.blockIdx, entIdx, label: blk.label, face,
          ...(csgN2 ? { csgNx: csgN2.nx, csgNy: csgN2.ny } : {}) };
        const faceLabel2 = edgeIdx >= 0
          ? `側面${edgeIdx} (v${edgeIdx}→v${(edgeIdx+1)%n}): (${blk.points[edgeIdx].x.toFixed(1)},${blk.points[edgeIdx].y.toFixed(1)})→(${blk.points[(edgeIdx+1)%n].x.toFixed(1)},${blk.points[(edgeIdx+1)%n].y.toFixed(1)})`
          : String(face);
        console.warn(`[FACE_SELECT] ★選択された面: ${faceLabel2}`, {
          entIdx, face, buildingId: blk.buildingId, blockIdx: blk.blockIdx,
          isChild: blk._parentBlockIdx != null,
          _sharedWall: blk._sharedWall,
          blockPoints: blk.points.map((p,i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
          zBottom: blk.zBottom || 0, zTop: blk.zTop != null ? blk.zTop : 40,
          CSG法線: csgN2 ? `(${csgN2.nx.toFixed(3)},${csgN2.ny.toFixed(3)})${csgN2.reversed ? ' [反転済]' : ''}` : 'N/A',
        });
        setBldSelected(sel);
        originalBlockRef.current = { points: blk.points.map(p => ({ ...p })), zBottom: blk.zBottom || 0, zTop: blk.zTop != null ? blk.zTop : 40 };
        v._bldEntities.forEach((e, i) => {
          if (e && e.polygon) {
            e.polygon.outlineWidth = (i === entIdx) ? 3 : 1;
            e.polygon.outlineColor = (i === entIdx)
              ? Cesium.Color.WHITE
              : Cesium.Color.fromCssColorString((_blds[i] || {}).color || '#888');
          }
        });
        updateArrowScreen(computeArrowScreen(blk, face, sel, true));
        v.scene.requestRender();
      } else {
        if (bldSelected) {
          setBldSelected(null);
          originalBlockRef.current = null;
          updateArrowScreen(null);
          v._bldEntities.forEach((e, i) => {
            if (e && e.polygon) {
              e.polygon.outlineColor = Cesium.Color.fromCssColorString(((blds || [])[i] || {}).color || '#888');
              e.polygon.outlineWidth = 1;
            }
          });
          v.scene.requestRender();
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 頂点ホバー: マウス移動で近くの頂点を水色丸で表示
    const vertHoverHandler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    vertHoverHandler.setInputAction((movement) => {
      // 前回のハイライトをリセット
      if (v._hoveredVertEnt && v._hoveredVertEnt.point) {
        v._hoveredVertEnt.point.pixelSize = 1;
        v._hoveredVertEnt.point.color = Cesium.Color.CYAN.withAlpha(0.01);
        v._hoveredVertEnt.point.outlineWidth = 0;
      }
      v._hoveredVertEnt = null;
      const picked = v.scene.pick(movement.endPosition);
      if (picked && picked.id && picked.id._vertexInfo && picked.id.point) {
        picked.id.point.pixelSize = 14;
        picked.id.point.color = Cesium.Color.CYAN.withAlpha(0.8);
        picked.id.point.outlineColor = Cesium.Color.WHITE;
        picked.id.point.outlineWidth = 2;
        v._hoveredVertEnt = picked.id;
        v.scene.requestRender();
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // カメラ移動時に矢印の画面座標を更新
    const updateArrowOnRender = () => {
      try {
        if (!bldSelected) return;
        if (isDraggingRef.current) return; // ドラッグ中は直接DOM更新なのでスキップ
        if (faceSketchPhase === 'pushpull') { updateArrowScreen(null); return; }
        const _blds = blds || [];
        if (bldSelected.entIdx < _blds.length) {
          const _off = shaftDragOffsetRef.current;
          // handle/shaft drag中: solidFaceでない通常面はmovedBldsから矢印位置をリアルタイム取得
          const _isSolidFaceDrag = _off && bldSelected._solidNormal;
          if (!_isSolidFaceDrag && movedBldsRef.current) {
            const _mb = movedBldsRef.current[bldSelected.entIdx];
            if (_mb) {
              updateArrowScreen(computeArrowScreen(_mb, bldSelected.face, bldSelected, false));
              return;
            }
          }
          // solidFace drag または通常表示: オフセット方式
          const _sel = _off ? {
            ...bldSelected,
            _faceCenterX: (bldSelected._faceCenterX || 0) + _off.dx,
            _faceCenterY: (bldSelected._faceCenterY || 0) + _off.dy,
            _faceCenterZ: (bldSelected._faceCenterZ || 0) + _off.dz,
          } : bldSelected;
          updateArrowScreen(computeArrowScreen(_blds[_sel.entIdx], _sel.face, _sel, false));
        }
      } catch(e) { /* solidFaceId等で旧パスが.xアクセスに失敗するケースを無視 */ }
    };
    const removeRenderListener = v.scene.postRender.addEventListener(updateArrowOnRender);

    return () => {
      handler.destroy();
      vertHoverHandler.destroy();
      removeRenderListener();
    };
  }, [bldAddMode, fieldDrawMode, faceSketchPhase, initDone, bldSelected, blds, computeArrowScreen, updateArrowScreen]);

  // 建屋同期: blds propが変わったらCesiumエンティティを再生成
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current || !v._buildBldEntities) return;
    // 3D: sharedBaseElevで更新、2D: 自身のテレイン標高をそのまま使用
    if (mode === '3d' && sharedBaseElev != null && sharedBaseElev > 0.01) {
      v._siteBaseElevation = sharedBaseElev;
    }
    const baseElev = v._siteBaseElevation || 0;
    const abs3d = (mode === '3d');
    const _rebuildBlds = blds || INIT_BLDS;
    // PP_CONFIRM後の期待値検証
    if (window._ppExpect && mode === '3d') {
      const exp = window._ppExpect;
      const _b = _rebuildBlds.find(b => b.buildingId === exp.buildingId && b.blockIdx === exp.blockIdx);
      if (_b) {
        const _actZB = _b.zBottom || 0, _actZT = _b.zTop || 40;
        const _zbMatch = Math.abs(_actZB - exp.expectedZB) < 0.1;
        const _ztMatch = Math.abs(_actZT - exp.expectedZT) < 0.1;
        const _verifyMsg = {
          期待zB: exp.expectedZB.toFixed(2), 実際zB: _actZB.toFixed(2), zBmatch: _zbMatch ? '✅' : `⚠️差${(_actZB-exp.expectedZB).toFixed(2)}`,
          期待zT: exp.expectedZT.toFixed(2), 実際zT: _actZT.toFixed(2), zTmatch: _ztMatch ? '✅' : `⚠️差${(_actZT-exp.expectedZT).toFixed(2)}`,
          元: `zB=${exp.origZB.toFixed(2)} zT=${exp.origZT.toFixed(2)}`,
          要求zDelta: exp.zDelta.toFixed(2), 実際変化: `zB=${(_actZB-exp.origZB).toFixed(2)} zT=${(_actZT-exp.origZT).toFixed(2)}`,
          結果: (_zbMatch && _ztMatch) ? '✅一致' : '⚠️不一致(クランプ等)',
        };
        console.warn('[PP_VERIFY] 確定後検証', _verifyMsg);
        if (!window._zfaceLog) window._zfaceLog = [];
        window._zfaceLog.push({ t: new Date().toLocaleTimeString(), event: 'PP_VERIFY', ..._verifyMsg });
        try { localStorage.setItem('_zfaceLog', JSON.stringify(window._zfaceLog.slice(-50))); } catch(e) {}
        window._ppExpect = null;
      }
    }
    // 側面pushpull確定後の実寸法検証
    if (window._ppExpectSide && mode === '3d') {
      const exp = window._ppExpectSide;
      const _b = _rebuildBlds.find(b => b.buildingId === exp.buildingId && b.blockIdx === exp.blockIdx);
      if (_b) {
        const _actPts = _b.points;
        const _actZB = _b.zBottom || 0, _actZT = _b.zTop || 40;
        // 面積/外接矩形/Z範囲
        let _area = 0;
        let _minX = Infinity, _maxX = -Infinity, _minY = Infinity, _maxY = -Infinity;
        for (let j = 0; j < _actPts.length; j++) {
          const k = (j+1) % _actPts.length;
          _area += _actPts[j].x * _actPts[k].y - _actPts[k].x * _actPts[j].y;
          _minX = Math.min(_minX, _actPts[j].x); _maxX = Math.max(_maxX, _actPts[j].x);
          _minY = Math.min(_minY, _actPts[j].y); _maxY = Math.max(_maxY, _actPts[j].y);
        }
        _area = Math.abs(_area / 2);
        const _vMsg = {
          ブロック: `${exp.buildingId}#${exp.blockIdx}`,
          実頂点: _actPts.map((p,i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
          外接矩形: `X[${_minX.toFixed(1)}..${_maxX.toFixed(1)}] Y[${_minY.toFixed(1)}..${_maxY.toFixed(1)}]`,
          外接幅m: `${((_maxX-_minX)*METERS_PER_PX).toFixed(2)} x ${((_maxY-_minY)*METERS_PER_PX).toFixed(2)}`,
          底面積m2: (_area * METERS_PER_PX * METERS_PER_PX).toFixed(1),
          高さm: (_actZT - _actZB).toFixed(2),
          zRange: `${_actZB.toFixed(2)}→${_actZT.toFixed(2)}`,
          要求depthM: exp.depthM.toFixed(2),
          頂点一致: JSON.stringify(_actPts.map(p=>[p.x.toFixed(1),p.y.toFixed(1)])) === JSON.stringify(exp.expectedPts.map(p=>[p.x.toFixed(1),p.y.toFixed(1)])) ? '✅' : '⚠️不一致',
        };
        console.warn('[PP_VERIFY_SIDE] 側面pushpull後の実箱寸法', _vMsg);
        if (!window._diagLog) window._diagLog = [];
        window._diagLog.push('[PP_VERIFY_SIDE] ' + JSON.stringify(_vMsg));
        if (window._diagLog.length > 200) window._diagLog.shift();
        window._ppExpectSide = null;
      }
    }
    // ──── 3D閉空間検証: 子ブロックを含む建屋の全面チェック ────
    if (abs3d) {
      // buildingId毎にブロックをグループ化
      const byBld = {};
      _rebuildBlds.forEach((b, i) => {
        if (!byBld[b.buildingId]) byBld[b.buildingId] = [];
        byBld[b.buildingId].push({ ...b, _flatIdx: i });
      });
      Object.entries(byBld).forEach(([bldId, blocks]) => {
        const hasChild = blocks.some(b => b._parentBlockIdx != null);
        if (!hasChild) return; // 子ブロック無しは検証スキップ

        console.warn(`[3D_AUDIT] ═══ 建屋${bldId} 全面検証 ═══`);
        let totalFaces = 0;
        let issues = [];

        blocks.forEach(blk => {
          const pts = blk.points || [];
          const n = pts.length;
          const zB = blk.zBottom || 0, zT = blk.zTop != null ? blk.zTop : 40;
          const height = zT - zB;
          const isChild = blk._parentBlockIdx != null;

          // 底面積(Shoelace)
          let area = 0;
          for (let j = 0; j < n; j++) { const k = (j+1)%n; area += pts[j].x * pts[k].y - pts[k].x * pts[j].y; }
          area /= 2;

          // 各側面
          const sideFaces = pts.map((p, i) => {
            const q = pts[(i + 1) % n];
            const len = Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
            const faceArea = len * height;
            return { idx: i, p, q, len, faceArea, zero: len < 0.01 };
          });

          const zeroEdges = sideFaces.filter(f => f.zero);
          // 重複頂点チェック
          const dups = [];
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              if (Math.abs(pts[i].x - pts[j].x) < 0.01 && Math.abs(pts[i].y - pts[j].y) < 0.01)
                dups.push(`v${i}=v${j}`);
            }
          }

          totalFaces += n + 2; // N側面 + top + bottom

          console.warn(`[3D_AUDIT] ブロック#${blk.blockIdx}${isChild ? '(CHILD)' : '(PARENT)'}`, {
            頂点数: n,
            底面積: area.toFixed(1),
            高さ: `${zB}m→${zT}m (${height}m)`,
            側面: sideFaces.map(f => `面${f.idx}: (${f.p.x.toFixed(1)},${f.p.y.toFixed(1)})→(${f.q.x.toFixed(1)},${f.q.y.toFixed(1)}) L=${f.len.toFixed(1)} A=${f.faceArea.toFixed(1)}${f.zero ? ' ⚠️ゼロ!' : ''}`),
            上面: `面積=${Math.abs(area).toFixed(1)}`,
            下面: `面積=${Math.abs(area).toFixed(1)}`,
          });

          if (Math.abs(area) < 1) issues.push(`ブロック#${blk.blockIdx}: 底面積ゼロ(穴あき)`);
          if (zeroEdges.length > 0) issues.push(`ブロック#${blk.blockIdx}: ゼロ長辺 ${zeroEdges.map(f => '面' + f.idx).join(',')}`);
          if (dups.length > 0) issues.push(`ブロック#${blk.blockIdx}: 重複頂点 ${dups.join(',')}`);

          // 子ブロックの場合: 親との共有辺チェック
          if (isChild && blk._sharedWall) {
            const sw = blk._sharedWall;
            const parent = blocks.find(b => b.blockIdx === sw.parentBlockIdx);
            if (parent && sw.parentEdge != null) {
              const pPts = parent.points || [];
              const pn = pPts.length;
              const pe = sw.parentEdge;
              if (pe < pn) {
                const pp0 = pPts[pe], pp1 = pPts[(pe + 1) % pn];
                // 子の共有壁(wallIdx)の辺
                const wi = sw.wallIdx;
                if (wi != null && wi < n) {
                  const cp0 = pts[wi], cp1 = pts[(wi + 1) % n];
                  // 共有辺が親の辺上にあるか確認
                  const parentEdgeDir = { x: pp1.x - pp0.x, y: pp1.y - pp0.y };
                  const parentLen = Math.sqrt(parentEdgeDir.x ** 2 + parentEdgeDir.y ** 2);
                  if (parentLen > 0.01) {
                    const ux = parentEdgeDir.x / parentLen, uy = parentEdgeDir.y / parentLen;
                    // 子の共有辺の始点・終点を親辺に投影
                    const t0 = (cp0.x - pp0.x) * ux + (cp0.y - pp0.y) * uy;
                    const t1 = (cp1.x - pp0.x) * ux + (cp1.y - pp0.y) * uy;
                    // 親辺への垂直距離
                    const d0 = Math.abs((cp0.x - pp0.x) * (-uy) + (cp0.y - pp0.y) * ux);
                    const d1 = Math.abs((cp1.x - pp0.x) * (-uy) + (cp1.y - pp0.y) * ux);
                    console.warn(`[3D_AUDIT] 共有辺チェック`, {
                      親辺: `面${pe}: (${pp0.x.toFixed(1)},${pp0.y.toFixed(1)})→(${pp1.x.toFixed(1)},${pp1.y.toFixed(1)}) L=${parentLen.toFixed(1)}`,
                      子壁: `面${wi}: (${cp0.x.toFixed(1)},${cp0.y.toFixed(1)})→(${cp1.x.toFixed(1)},${cp1.y.toFixed(1)})`,
                      親辺上の位置: `t0=${t0.toFixed(1)}, t1=${t1.toFixed(1)} / parentLen=${parentLen.toFixed(1)}`,
                      垂直距離: `d0=${d0.toFixed(2)}, d1=${d1.toFixed(2)}`,
                      辺上: (d0 < 1 && d1 < 1) ? '✅正常' : '⚠️親辺から外れている!',
                      範囲内: (Math.min(t0,t1) >= -1 && Math.max(t0,t1) <= parentLen + 1) ? '✅正常' : '⚠️親辺の範囲外!',
                    });
                    if (d0 >= 1 || d1 >= 1) issues.push(`ブロック#${blk.blockIdx}: 共有壁が親辺から外れている`);
                  }
                } else {
                  issues.push(`ブロック#${blk.blockIdx}: wallIdx=${wi}が頂点数${n}の範囲外`);
                }
              }
            }
          }
        });

        // 最終判定
        if (issues.length === 0) {
          console.warn(`[3D_AUDIT] ✅ 建屋${bldId}: 全${totalFaces}面 — 閉空間正常`);
        } else {
          console.error(`[3D_AUDIT] ⚠️ 建屋${bldId}: ${issues.length}件の問題!`);
          issues.forEach(iss => console.error(`  → ${iss}`));
        }
      });
    }
    // ──── 面トポロジー監査: 重複面検出 + 辺隣接チェック ────
    if (abs3d) {
      const byBld2 = {};
      _rebuildBlds.forEach((b, i) => {
        if (!byBld2[b.buildingId]) byBld2[b.buildingId] = [];
        byBld2[b.buildingId].push({ ...b, _flatIdx: i });
      });
      Object.entries(byBld2).forEach(([bldId, blocks]) => {
        if (!blocks.some(b => b._parentBlockIdx != null)) return;

        // ── 全面を列挙 ──
        // 面の種類: 'side'(側面), 'top', 'bottom'
        // 側面: 4点(p0,zBot), (p1,zBot), (p1,zTop), (p0,zTop)
        // 共有壁はスキップ
        const allFaces = [];
        blocks.forEach(blk => {
          const pts = blk.points || [];
          const n = pts.length;
          const zB = blk.zBottom || 0, zT = blk.zTop != null ? blk.zTop : 40;
          const sw = blk._sharedWall;
          const skipWall = sw ? sw.wallIdx : -1;

          // 側面
          for (let i = 0; i < n; i++) {
            if (i === skipWall) continue; // 共有壁スキップ
            const p0 = pts[i], p1 = pts[(i + 1) % n];
            allFaces.push({
              type: 'side', blockIdx: blk.blockIdx,
              corners: [
                { x: p0.x, y: p0.y, z: zB },
                { x: p1.x, y: p1.y, z: zB },
                { x: p1.x, y: p1.y, z: zT },
                { x: p0.x, y: p0.y, z: zT },
              ],
              label: `blk#${blk.blockIdx} 面${i} (${p0.x.toFixed(1)},${p0.y.toFixed(1)})→(${p1.x.toFixed(1)},${p1.y.toFixed(1)}) z=${zB.toFixed(1)}→${zT.toFixed(1)}`,
            });
          }
          // 上面・下面
          const topCorners = pts.map(p => ({ x: p.x, y: p.y, z: zT }));
          const botCorners = pts.map(p => ({ x: p.x, y: p.y, z: zB }));
          allFaces.push({ type: 'top', blockIdx: blk.blockIdx, corners: topCorners, label: `blk#${blk.blockIdx} 上面 z=${zT.toFixed(1)}` });
          allFaces.push({ type: 'bottom', blockIdx: blk.blockIdx, corners: botCorners, label: `blk#${blk.blockIdx} 下面 z=${zB.toFixed(1)}` });
        });

        // ── 1. 重複/統合可能面の検出 ──
        // 同一平面上にあり、Z方向またはU方向で隣接する面を検出
        const edgeKey = (p0, p1) => {
          // 2D辺の正規化キー（方向不問）
          const ax = Math.round(p0.x * 10) / 10, ay = Math.round(p0.y * 10) / 10;
          const bx = Math.round(p1.x * 10) / 10, by = Math.round(p1.y * 10) / 10;
          if (ax < bx || (ax === bx && ay < by)) return `${ax},${ay}-${bx},${by}`;
          return `${bx},${by}-${ax},${ay}`;
        };
        const sideFaces = allFaces.filter(f => f.type === 'side');
        const mergeIssues = [];
        // 同一2D辺の側面をグループ化
        const sideByEdge = {};
        sideFaces.forEach(f => {
          const k = edgeKey(f.corners[0], f.corners[1]);
          if (!sideByEdge[k]) sideByEdge[k] = [];
          sideByEdge[k].push(f);
        });
        Object.entries(sideByEdge).forEach(([k, faces]) => {
          if (faces.length < 2) return;
          // Z範囲でソート
          const sorted = [...faces].sort((a, b) => a.corners[0].z - b.corners[0].z);
          for (let i = 0; i < sorted.length - 1; i++) {
            const cur = sorted[i], next = sorted[i + 1];
            const curZTop = cur.corners[2].z;
            const nextZBot = next.corners[0].z;
            if (Math.abs(curZTop - nextZBot) < 0.1) {
              mergeIssues.push(`統合可能: ${cur.label} と ${next.label} — Z連続(${curZTop.toFixed(1)}で接続)→1面にすべき`);
            } else if (curZTop > nextZBot + 0.1) {
              mergeIssues.push(`重複: ${cur.label} と ${next.label} — Z範囲重複`);
            }
          }
        });

        if (mergeIssues.length > 0) {
          console.warn(`[FACE_TOPO] ⚠️ 建屋${bldId}: ${mergeIssues.length}件の統合可能/重複面`);
          mergeIssues.forEach(m => console.warn(`  → ${m}`));
        }

        // ── 2. 辺隣接チェック ──
        // 各面の各辺について、その辺を共有する他の面があるかチェック
        // 辺 = 3D上の線分 (x0,y0,z0)→(x1,y1,z1)
        const edge3dKey = (a, b) => {
          const ax = Math.round(a.x * 10) / 10, ay = Math.round(a.y * 10) / 10, az = Math.round(a.z * 10) / 10;
          const bx = Math.round(b.x * 10) / 10, by = Math.round(b.y * 10) / 10, bz = Math.round(b.z * 10) / 10;
          if (ax < bx || (ax === bx && (ay < by || (ay === by && az < bz))))
            return `${ax},${ay},${az}-${bx},${by},${bz}`;
          return `${bx},${by},${bz}-${ax},${ay},${az}`;
        };
        const edgeUsage = {}; // edge3dKey → [faceLabel, ...]
        allFaces.forEach(f => {
          const c = f.corners;
          const n = c.length;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const k = edge3dKey(c[i], c[j]);
            if (!edgeUsage[k]) edgeUsage[k] = [];
            edgeUsage[k].push(f.label);
          }
        });

        const openEdges = [];
        const allEdgeCount = Object.keys(edgeUsage).length;
        Object.entries(edgeUsage).forEach(([k, faces]) => {
          if (faces.length === 1) {
            openEdges.push({ edge: k, face: faces[0] });
          }
        });

        if (openEdges.length === 0) {
          console.warn(`[FACE_TOPO] ✅ 建屋${bldId}: 全${allEdgeCount}辺が隣接 — 完全閉空間`);
        } else {
          console.error(`[FACE_TOPO] ⚠️ 建屋${bldId}: ${openEdges.length}辺が開放（隣接面なし）— 穴あき!`);
          openEdges.forEach(oe => console.error(`  → 辺[${oe.edge}] 所属面: ${oe.face}`));
        }

        // 全面一覧
        console.warn(`[FACE_TOPO] 全面一覧 (${allFaces.length}面)`, allFaces.map(f => f.label));

        // ──── CSG面方向監査: 各面の法線が箱(CSG結果)の内側/外側どちらを向くか ────
        const parentBlocks = blocks.filter(b => b._parentBlockIdx == null);
        const childBlocks = blocks.filter(b => b._parentBlockIdx != null);
        if (childBlocks.length > 0) {
          // PIP (Point In Polygon) ヘルパー
          const pip = (pt, poly) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) &&
                  pt.x < (poly[j].x - poly[i].x) * (pt.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x)
                inside = !inside;
            }
            return inside;
          };
          // CSG判定: テスト点が「箱の外側(空気)」かどうか
          // CSG結果 = 親 - 子 → 固体 = 親内部 かつ 全子ブロック外部
          // 空気 = 親外部 OR いずれかの子ブロック内部
          const isAirCSG = (testPt) => {
            // いずれかの親の内部にあるか
            let inAnyParent = false;
            for (const p of parentBlocks) {
              if (pip(testPt, p.points || [])) { inAnyParent = true; break; }
            }
            if (!inAnyParent) return true; // 親の外 = 空気
            // いずれかの子の内部にあるか
            for (const c of childBlocks) {
              if (pip(testPt, c.points || [])) return true; // 子の中 = 削り取られた空間 = 空気
            }
            return false; // 親内部かつ全子外部 = 固体
          };

          const faceDirections = [];
          blocks.forEach(blk => {
            const pts = blk.points || [];
            const n = pts.length;
            const zB = blk.zBottom || 0, zT = blk.zTop != null ? blk.zTop : 40;
            const isChild = blk._parentBlockIdx != null;
            const sw = blk._sharedWall;
            const skipWall = sw ? sw.wallIdx : -1;

            // ポリゴン重心
            const cx = pts.reduce((s, p) => s + p.x, 0) / n;
            const cy = pts.reduce((s, p) => s + p.y, 0) / n;

            // 側面
            for (let i = 0; i < n; i++) {
              if (i === skipWall) {
                faceDirections.push(`  blk#${blk.blockIdx} 面${i}: [共有壁 — スキップ]`);
                continue;
              }
              const p0 = pts[i], p1 = pts[(i + 1) % n];
              const ex = p1.x - p0.x, ey = p1.y - p0.y;
              const len = Math.sqrt(ex * ex + ey * ey);
              if (len < 0.01) continue;
              // edgeNormalGrid相当: 辺に垂直な法線、重心から外向き
              let nx = ey / len, ny = -ex / len;
              const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
              if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
              // 法線方向のテスト点
              const testPt = { x: mx + nx * 5, y: my + ny * 5 };
              const air = isAirCSG(testPt);
              // 正しい外向き = テスト点が空気側。内側なら反転が必要。
              const correctNx = air ? nx : -nx;
              const correctNy = air ? ny : -ny;
              faceDirections.push(
                `  blk#${blk.blockIdx}${isChild ? '(子)' : '(親)'} 面${i}: ` +
                `(${p0.x.toFixed(1)},${p0.y.toFixed(1)})→(${p1.x.toFixed(1)},${p1.y.toFixed(1)}) ` +
                `edgeNormal=(${nx.toFixed(3)},${ny.toFixed(3)}) ` +
                `テスト点=(${testPt.x.toFixed(1)},${testPt.y.toFixed(1)}) ` +
                `${air ? '→空気側✅外向き正しい' : '→固体側⚠️反転必要'} ` +
                `正しい外向き法線=(${correctNx.toFixed(3)},${correctNy.toFixed(3)})`
              );
            }

            // 上面・下面
            const topTest = { x: cx, y: cy }; // 上面の法線は+z（上向き）
            const topAir = !isChild; // 親の上面は常に空気側、子の上面は親の内部
            // 子ブロック上面: 法線+zのテスト点はzT+5の高さ → 親のzTopより上なら空気
            const parentOfChild = isChild ? blocks.find(b => b.blockIdx === blk._parentBlockIdx) : null;
            const pZT = parentOfChild ? (parentOfChild.zTop != null ? parentOfChild.zTop : 40) : 999;
            const childTopIsAir = isChild ? (zT >= pZT - 0.1) : true; // 子の上面が親の上面と同じ高さなら空気
            const childBotIsAir = isChild ? (zB <= (parentOfChild ? (parentOfChild.zBottom || 0) : 0) + 0.1) : true;
            faceDirections.push(
              `  blk#${blk.blockIdx}${isChild ? '(子)' : '(親)'} 上面z=${zT}: 法線=(0,0,+1) ${childTopIsAir ? '→空気側✅' : '→固体側(親内部)⚠️'}`
            );
            faceDirections.push(
              `  blk#${blk.blockIdx}${isChild ? '(子)' : '(親)'} 下面z=${zB}: 法線=(0,0,-1) ${childBotIsAir ? '→空気側✅' : '→固体側(親内部)⚠️'}`
            );
          });

          console.warn(`[CSG_FACE_DIR] ═══ 建屋${bldId} CSG面方向一覧 ═══\n` +
            `  CSG = 親ブロック - 子ブロック(削り出し)\n` +
            `  「空気側」= 箱の外側（矢印がこちらを向くべき）\n` +
            `  「固体側」= 箱の内側（edgeNormalGridの向きが間違い→反転必要）\n` +
            faceDirections.join('\n'));
        }
        // ──── CSG面方向監査 終了 ────
      });
    }
    // ──── 面トポロジー監査 終了 ────
    // ──── 3D閉空間検証 終了 ────

    v._currentSolids = solids || [];
    // デバッグヘルパー: console から window._dumpSolids() で現在のSolid状態を見られる
    if (typeof window !== 'undefined') {
      window._dumpSolids = () => (v._currentSolids || []).map(s => ({
        id: s.id, label: s.label, faceCount: s.faces.length,
        hasHoles: s.faces.some(f => f.holes && f.holes.length > 0),
        faces: s.faces.map(f => ({
          id: f.id, type: f.type,
          normal: f.normal ? `(${f.normal.nx.toFixed(2)},${f.normal.ny.toFixed(2)},${f.normal.nz.toFixed(2)})` : null,
          vCount: f.vertices.length,
          verts: f.vertices.map(v => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`).join(' '),
          holes: f.holes ? f.holes.map(h => h.map(v => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`).join(' ')) : undefined,
        })),
      }));
    }
    v._buildBldEntities(v, blds || INIT_BLDS, baseElev, abs3d, solids);
    v.scene.requestRender();
    // 3Dモード: 各建屋の周辺地表面をサンプルして個別に高さ補正
    if (abs3d && v._adjustBldGroundLevel) {
      v._adjustBldGroundLevel(v, blds || INIT_BLDS, baseElev);
    }
  }, [blds, solids, initDone, sharedBaseElev]);

  // フォーカスノード登録（カメラアイコンクリック時にCesiumMapがそのノードにflyTo）
  useEffect(() => {
    if (!focusNodeRef) return;
    focusNodeRef.current = (nodeId, radiusM) => {
      const v = viewerRef.current;
      if (!v || v.isDestroyed()) return;
      const pos = allMapPos[nodeId]; if (!pos) return;
      const geo = gridToGeo(pos.x, pos.y);
      const baseElev = v._siteBaseElevation || 0;
      const alt = baseElev + (pos.z || 0);
      cmFlyToFocus(v, Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, alt), radiusM);
    };
    return () => { if (focusNodeRef) focusNodeRef.current = null; };
  }, [allMapPos, focusNodeRef]);

  // 建屋面・配電盤のカメラアイコン用: グリッド座標でflyTo
  // radiusM を渡すとその大きさに合わせて寄る（渡さなければ従来どおり300m固定）
  useEffect(() => {
    if (!focusPosRef) return;
    focusPosRef.current = (gx, gy, gz, radiusM) => {
      const v = viewerRef.current;
      if (!v || v.isDestroyed()) return;
      const geo = gridToGeo(gx, gy);
      const baseElev = v._siteBaseElevation || 0;
      cmFlyToFocus(v, Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, baseElev + (gz || 0)), radiusM);
    };
    return () => { if (focusPosRef) focusPosRef.current = null; };
  }, [focusPosRef]);

  // Deleteキーで選択中の建屋を削除
  useEffect(() => {
    if (!bldSelected || !onDeleteBuilding) return;
    const onKey = (e) => {
      if (e.key === 'Delete') {
        // 入力欄フォーカス中は文字消去が本来の意味なので横取りしない（spec 12.4）
        if (!bcCanHandleDeleteKey()) return;
        // 地図が最前面のときだけ建屋削除を受け付ける。
        // これが無いと建物エディタ作業中のDeleteで建屋ごと消える（発生源）
        if (!fwOwnsKeyboard(mode === '2d' ? 'cesium2d' : 'cesium3d', winState)) return;
        onDeleteBuilding(bldSelected.buildingId);
        setBldSelected(null);
        updateArrowScreen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bldSelected, onDeleteBuilding, updateArrowScreen, mode, winState]);

  // Ctrl+Z / Ctrl+Y: 建物undo/redo — 親コンポーネントで一元管理（2重発火防止）
  // ※ keydownハンドラは親のuseEffectで1つだけ登録する

  // Escapeキー: Push/Pull / 矩形で突起 / 面で作図 をキャンセル
  useEffect(() => {
    if (!faceSketchPhase) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (faceSketchPhase === 'pushpull' && bldSelected) {
          // solidFaceIdの場合: キャンセルは単純にundo snapshotから復元
          if (typeof bldSelected.face === 'string' && bldSelected.face.startsWith('f')) {
            setBldSelected(null); setFaceSketchPhase(null); setFaceSketchDepth(0); pushPullRef.current = null; originalBlockRef.current = null;
            e.preventDefault(); return;
          }
          const blk = (blds || [])[bldSelected.entIdx];
          if (originalBlockRef.current && blk) {
            // Push/Pullキャンセル: 元に戻す
            const orig = originalBlockRef.current;
            const face = bldSelected.face;
            const isZ = face === 'zTop' || face === 'zBottom';
            if (isZ && onMoveBldFace) {
              onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', orig.zTop - (blk.zTop != null ? blk.zTop : 40));
              onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', orig.zBottom - (blk.zBottom || 0));
            } else if (onSetBlockPoints) {
              onSetBlockPoints(bldSelected.buildingId, bldSelected.blockIdx, orig.points);
            }
          }
        }
        setFaceSketchPhase(null);
        setFaceSketchPts([]);
        setFaceSketchDepth(0);
        pushPullRef.current = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [faceSketchPhase, bldSelected, blds, onMoveBldFace, onSetBlockPoints, onDeleteBlock]);

  // ウィンドウリサイズ → Cesiumリサイズ
  useEffect(() => {
    const v = viewerRef.current;
    if (v && !v.isDestroyed()) requestAnimationFrame(() => v.resize());
  }, [winW, winH]);




  // ノードマーカー同期 → billboard entity 不使用（postRenderでcanvas描画、GPU overlay pass 排除）
  useEffect(() => {
    if (dragStateRef?.current) return;
    if (nodeEntityTimerRef.current) clearTimeout(nodeEntityTimerRef.current);
    nodeEntityTimerRef.current = setTimeout(() => {
      if (dragStateRef?.current) return;
      const v = viewerRef.current;
      if (!v || v.isDestroyed() || !initDoneRef.current) return;
      // 残留billboard entity を削除（移行期クリーンアップ。削除後は空になり以降はNOP）
      const existing = nodeEntitiesRef.current;
      const ids = Object.keys(existing);
      if (ids.length > 0) {
        v.entities.suspendEvents();
        ids.forEach(id => { try { v.entities.remove(existing[id]); } catch (_) {} delete existing[id]; });
        v.entities.resumeEvents();
      }
      v.scene.requestRender();
    }, 200);
  }, [allMapPos, nodes, localBaseElev]);

  // billboard状態スケール管理
  const _billStateRef = useRef({});

  const _applyBillScale = (nid, ent) => {
    if (!ent?.billboard) return;
    ent.billboard.scale = _billStateRef.current[nid] ?? 1.0;
  };

  // billboard幅管理: postRenderでワイヤー幅を距離に応じてスケール
  // アイコン自体はscaleByDistanceで制御（sizeInMeters:false固定ピクセル + NearFarScalar）
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;
    const remove = v.scene.postRender.addEventListener(() => {
      if (v.isDestroyed()) return;
      try {
        const resScale = v.resolutionScale || 1;
        const ch    = v.scene.canvas.clientHeight || 1;
        const fov   = v.camera.frustum?.fovy ?? v.camera.frustum?.fov ?? Cesium.Math.toRadians(60);
        // ワイヤー幅計算用: nadir距離ベース（従来通り）
        const h     = v.camera.positionCartographic?.height ?? 1000;
        const pitch = v.camera.pitch ?? -Math.PI / 2;
        const d_nadir = h / Math.max(0.05, -Math.sin(pitch));
        const metersPerPx_nadir = 2 * d_nadir * Math.tan(fov / 2) / ch;

        // 3DTilesetのSSEを高度に応じて動的変更（整数値のみ・変化時のみ更新）
        // カメラ移動中はスキップ（スクロール中にSSEが下がるたびタイルロードが発生して凍結するため）
        // → 停止400ms後に一括適用
        if (v._tileset3d && !v._tileset3d.isDestroyed() && !_cameraMovingRef.current) {
          const _qs = qualitySettingsRef.current;
          if (_qs?.sseManual) {
            if (v._tileset3d.maximumScreenSpaceError !== _qs.sse) v._tileset3d.maximumScreenSpaceError = _qs.sse;
          } else {
            const _h = v.camera.positionCartographic?.height ?? 200;
            // 高度に比例してSSEを大きく → 高高度ほど3Dタイルを粗く（タイル数削減 → GPU負荷軽減）
            // h=50m→8, h=200m→8, h=500m→13, h=1000m→25, h=2000m→32
            const _sse = Math.round(Math.max(8, Math.min(32, _h * 0.025)));
            if (v._tileset3d.maximumScreenSpaceError !== _sse) v._tileset3d.maximumScreenSpaceError = _sse;
          }
          const _curSSE = v._tileset3d.maximumScreenSpaceError;
          setCurrentSSE(prev => prev === _curSSE ? prev : _curSSE);
        }

        // ワイヤー幅: canvas描画が担当するため Cesium エンティティ(show:false)への幅更新は不要
        // （毎フレームの polyline.width 更新 → Cesium バッチテーブル dirty → GPU再構築 を防止）
      } catch (_) {}
    });

    return () => {
      try { remove(); } catch (_) {}
    };
  }, [initDoneRef.current]);

  // segs/nodes/segWp/wpZ/allMapPos/blds変化時にCesiumへ再描画要求（requestRenderMode対応）
  // bldsを含めることでビル検出ON/OFF切替が即座に薄線表示に反映される
  // segs/nodesを含めることでwire・アイコン追加時に即座に表示される
  useEffect(() => {
    const v = viewerRef.current;
    if (v && !v.isDestroyed()) v.scene.requestRender();
  }, [segs, nodes, segWp, wpZ, allMapPos, blds, qualitySettings?.ugWireHighlight]);

  // canvas dirty フラグ: 位置・wire・hover・filterが変化したときに再描画が必要
  useEffect(() => { _canvasDirtyRef.current = true; }, [allMapPos, segWp, wpZ, segs, nodes, localBaseElev, hoverId, hoverSeg, routeSegs, sectionOverlays]);
  // Cartesian3 位置キャッシュ dirty: 位置・高度・ノード変化時のみ再構築（ホバー変化では再構築不要）
  useEffect(() => { _iconCart3DirtyRef.current = true; }, [allMapPos, nodes, localBaseElev]);
  // ワイヤーCart3キャッシュ dirty: ノード位置・waypoint・baseElev変化時のみ
  useEffect(() => { _wireC3DirtyRef.current = true; }, [allMapPos, segWp, wpZ, localBaseElev]);


  // 水平断面エンティティ（hSections）: zPxの高さに半透明水平面を追加
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    // 既存hSectionエンティティを削除
    (v._hSecEntities || []).forEach(e => { try { v.entities.remove(e); } catch (_) {} });
    v._hSecEntities = [];
    if (!hSections || hSections.length === 0) { v.scene.requestRender(); return; }
    const baseElev = v._siteBaseElevation || 0;
    const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    const _defaultPts = (typeof FIELD_POLY_GRID !== 'undefined' && FIELD_POLY_GRID)
      ? FIELD_POLY_GRID
      : (typeof TW !== 'undefined' && typeof TH !== 'undefined')
        ? [{x:0,y:0},{x:TW,y:0},{x:TW,y:TH},{x:0,y:TH}]
        : [];
    if (_defaultPts.length < 3) return;
    hSections.forEach(hs => {
      // clipSecがある場合はそのOBBコーナーを使う（フィールド全体でなく矢視図範囲のみ）
      let _polyPts = _defaultPts;
      if (hs.clipSec) {
        const cs = hs.clipSec;
        if (cs.center !== undefined) {
          const { center: { x: cx, y: cy }, halfA, halfB, pnRad } = cs;
          const cP = Math.cos(pnRad), sP = Math.sin(pnRad);
          _polyPts = [
            { x: cx - halfA*cP - halfB*sP, y: cy - halfA*sP + halfB*cP },
            { x: cx + halfA*cP - halfB*sP, y: cy + halfA*sP + halfB*cP },
            { x: cx + halfA*cP + halfB*sP, y: cy + halfA*sP - halfB*cP },
            { x: cx - halfA*cP + halfB*sP, y: cy - halfA*sP - halfB*cP },
          ];
        } else if (cs.rect) {
          const { x1, y1, x2, y2 } = cs.rect;
          _polyPts = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
        }
      }
      const hM = hs.zPx * _mpp;
      const alt = baseElev + hM;
      // +0.15m offset: 建物エンティティポリゴンとのz-fightingを防ぎ、常に手前に表示
      const altDisp = alt + 0.15;
      const corners = _polyPts.map(p => {
        const g = gridToGeo(p.x, p.y);
        return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, altDisp);
      });
      const midG = gridToGeo(
        _polyPts.reduce((s,p) => s+p.x, 0) / _polyPts.length,
        _polyPts.reduce((s,p) => s+p.y, 0) / _polyPts.length
      );
      const ent = v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(midG.lng, midG.lat, altDisp),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(corners),
          material: Cesium.Color.fromCssColorString('#808080').withAlpha(0.18),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#1a1a1a').withAlpha(0.9),
          height: altDisp,
          perPositionHeight: false,
          // eyeOffset は polygon 非対応: ポリゴン後追加+高度オフセットで対処
        },
        label: {
          text: hs.label,
          font: '700 11px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#1a1a1a'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(4, -4),
          // アイコン/wireはcanvasオーバーレイで描画されるため常に最前面
          // labelのdisableDepthTestDistanceで建物に隠れないようにする
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          eyeOffset: new Cesium.Cartesian3(0, 0, -5),
        },
      });
      v._hSecEntities.push(ent);
    });
    v.scene.requestRender();
  }, [hSections, localBaseElev]);

  // ワイヤーSVGオーバーレイ: postRenderで3D座標→スクリーン座標に投影
  // Cesium深度バッファを一切使わないためポリゴン貫通表示が確実
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;
    let _dbgPrevDrag = null;
    // カメラ移動中フラグ: trueの間はSVG React再レンダリングをスキップ（カメラ操作の重さ軽減）
    let _camMoving = false;
    let _camMoveTimer = null;      // 停止検出タイマー（0ms: カメラ停止後即時slow-path復元）
    let _camActivateTimer = null;  // 2D切替遅延タイマー（150ms、チラチラ防止）
    let _cam2DActive = false;      // 現在Globe（衛星画像）が表示中か
    // _scrollLQActive: sampleHeight化で不要につき廃止

    // アイコン canvas 要素キャッシュ（同期描画 → Image.complete 待ち不要）
    const _getDrawCanvas = (shape, color, label) => {
      const key = `${shape}_${color}_${label}`;
      let cv = _iconCanvasElemCacheRef.current[key];
      if (!cv) {
        const size = 36, lblH = label ? 14 : 0;
        cv = document.createElement('canvas');
        cv.width = size + 2; cv.height = size + lblH + 2;
        const cx = cv.getContext('2d');
        const h = size / 2 + 1;
        cx.beginPath(); cx.roundRect(0, 0, size + 2, size + 2, 4);
        cx.fillStyle = 'rgba(255,255,255,1.0)'; cx.fill();
        cx.strokeStyle = 'rgba(0,0,0,0.12)'; cx.lineWidth = 0.8; cx.stroke();
        if (shape === 'gen') {
          cx.beginPath(); cx.arc(h, h, size / 2 - 2, 0, Math.PI * 2);
          cx.strokeStyle = color || '#999'; cx.lineWidth = 2.5; cx.stroke();
          cx.fillStyle = color || '#999'; cx.font = `bold ${Math.round(size * 0.42)}px sans-serif`;
          cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText('G', h, h + 0.5);
        } else {
          cx.beginPath(); cx.roundRect(2, 2, size - 2, size - 2, 2);
          cx.fillStyle = shape === 'cb_g' ? '#16A34A' : '#DC2626'; cx.fill();
          cx.fillStyle = '#FFF'; cx.font = `bold ${Math.round(size * 0.36)}px sans-serif`;
          cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText('52', h, h + 0.5);
        }
        if (label) {
          cx.font = 'bold 10px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'top';
          cx.strokeStyle = 'rgba(0,0,0,0.75)'; cx.lineWidth = 2.5; cx.strokeText(label, h, size + 3);
          cx.fillStyle = '#FFF'; cx.fillText(label, h, size + 3);
        }
        _iconCanvasElemCacheRef.current[key] = cv;
      }
      return cv;
    };

    const remove = v.scene.postRender.addEventListener(() => {
      if (v.isDestroyed()) return;
      const _isDrag = !!dragStateRef?.current;
      const _dragChanged = _isDrag !== _dbgPrevDrag;
      _dbgPrevDrag = _isDrag;
      // ドラッグ中はpostRenderの全wire投影をスキップ（canvas はブロック、billboard entityが表示を担当）
      if (_isDrag) return;
      // drag終了直後でcbRef._allMapPosがまだ旧位置の場合もスキップ（他の図ドラッグ→2D/3Dフラッシュ防止）
      // cbRefが毎レンダー後に_readyToDrawWire=trueでリセットされるまで待つ
      if (!cbRef.current._readyToDrawWire) {
        if (window._cesiumDebug && _dragChanged) console.log(`[${mode}:postRender] SKIP _readyToDrawWire=false t=${performance.now().toFixed(1)}`);
        return;
      }
      if (window._cesiumDebug && _dragChanged) {
        const _mid = movedNodeRef?.current;
        const _cvs = wireCanvasRef.current;
        let _cvState = '?';
        try { const _d = _cvs?.getContext('2d').getImageData(0,0,1,1); _cvState = _d?.data[3] === 0 ? 'empty' : 'has-content'; } catch(_) {}
        console.log(`[${mode}:postRender] DRAW t=${performance.now().toFixed(1)} movedNode=${_mid} cbMapPos=${JSON.stringify(cbRef.current._allMapPos?.[_mid])} canvas=${_cvState}`);
      }
      // カメラ・位置変化チェック: 変化なしならcanvas/SVG再描画をスキップ
      // タイルストリーミングやCesium内部の再描画による無駄な処理を防止
      {
        const _cPos = v.camera.position;
        const _ck = `${Math.round(_cPos.x)}_${Math.round(_cPos.y)}_${Math.round(_cPos.z)}_${v.camera.heading.toFixed(4)}_${v.camera.pitch.toFixed(4)}`;
        if (_ck === _camLastKeyRef.current && !_canvasDirtyRef.current && !_wpDragCanvasRef.current) return;
        // カメラが動いた場合: SVG更新を一時停止 + scroll2D=ONなら衛星Globe切替（ヒステリシス制御）
        if (_ck !== _camLastKeyRef.current) {
          _camMoving = true;
          _cameraMovingRef.current = true; // MOUSE_MOVEのdrillPickスキップに共有
          _sampleAbortRef.current = true;  // 移動中はチャンクサンプリングを中断（GPU競合防止）

          // 停止検出タイマーをリセット（80ms: 0msだとmicro-stop毎に切替フリッカーが出る）
          clearTimeout(_camMoveTimer);
          _camMoveTimer = setTimeout(() => {
            _camMoving = false;
            _cameraMovingRef.current = false;
            _sampleAbortRef.current = false; // 停止したらサンプリング再開可
            clearTimeout(_camActivateTimer); _camActivateTimer = null;
            if (_cam2DActive) {
              _cam2DActive = false;
              if (v._tileset3d && !v._tileset3d.isDestroyed()) {
                v.scene.globe.show = false;
                v._tileset3d.show = true;
              }
            }
            // カメラ移動中にスキップされたサンプリングをここで実行
            if (_underSamplePendingRef.current) {
              _underSamplePendingRef.current = false;
              _runUnderSampleRef.current?.();
            }
            // カメラ停止後: binary search精度の正確な薄線を再描画するためdirtyフラグを立て直す
            _canvasDirtyRef.current = true;
            if (!v.isDestroyed()) v.scene.requestRender();
          }, 80);

          // scroll2D=ON かつまだ2D未切替なら150ms後に切替（短い移動ではチラチラしない）
          const _qs2 = qualitySettingsRef.current;
          if (_qs2?.scroll2D && !_cam2DActive && !_camActivateTimer) {
            _camActivateTimer = setTimeout(() => {
              _camActivateTimer = null;
              if (_camMoving && !_cam2DActive && v._tileset3d && !v._tileset3d.isDestroyed()) {
                _cam2DActive = true;
                v._tileset3d.show = false;
                v.scene.globe.show = true;
              }
            }, 150);
          }
        }
        _camLastKeyRef.current = _ck;
        _canvasDirtyRef.current = false;
        // 移動中はSSEフォーミュラをスキップ（line 5159）するためSSEは変化しない。min保証は不要。
      }
      const _prT0 = performance.now();
      // セクション別タイム計測（原因特定用: _prDbg=trueのフレームのみconsole出力）
      let _tWire = 0, _tIconC3 = 0, _tIconDraw = 0;
      try {
        // baseElev: sampleHeightMostDetailedでpostRender開始より前に32.68mが設定済み
        const baseElev = v._siteBaseElevation || 0;

        const prj = (cart) => {
          const s = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, cart);
          return s ? { x: s.x, y: s.y } : null;
        };
        // アイコンと同じ zoom 基準でワイヤー太さをスケール
        const h_svg  = v.camera.positionCartographic?.height ?? 1000;
        const pitch_svg = v.camera.pitch ?? -Math.PI / 2;
        const d_svg  = h_svg / Math.max(0.05, -Math.sin(pitch_svg));
        const ch_svg = v.scene.canvas.height || 1;
        const fov_svg = v.camera.frustum?.fovy ?? v.camera.frustum?.fov ?? Cesium.Math.toRadians(60);
        const mpp_svg = 2 * d_svg * Math.tan(fov_svg / 2) / ch_svg;
        // 世界幅 1m が stroke 1px に相当する基準で自然スケール、上限1.0
        const strokeScale = 1.0 / Math.max(0.001, mpp_svg); // キャップなし: 近い側は太く、遠い側は細く

        const paths = [];
        const _segs = cbRef.current._segs || [];
        const _amap = cbRef.current._allMapPos || {};
        const _swp  = cbRef.current._segWp  || {};
        const _swpz = cbRef.current._wpZ    || {};
        // 動かしたアイコンの接続wireのみ再計算（他はキャッシュ流用）
        const _movedId2 = movedNodeRef?.current;
        const _connSegIds = _movedId2
          ? new Set(_segs.filter(s => s.from === _movedId2 || s.to === _movedId2).map(s => s.id))
          : null;

        // ── 地上/地下判定: bldsポリゴン OR sampleHeightMostDetailed事前計算マップ ──
        const _blds = cbRef.current._blds || [];

        const _pip = (px, py, poly) => {
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
            if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
          }
          return inside;
        };
        // ルール: ポリゴン内包を優先。ポリゴン外の場合のみ3Dタイル高さマップ参照
        const _uMap = _underStatesRef.current;
        const _geoKey = (lng, lat) => `${Math.round(lng * 2e4)}_${Math.round(lat * 2e4)}`;
        const _underAt = (gx, gy) => {
          // ①ユーザー定義ポリゴン内包判定（bld.points = [{x,y},...] グリッド座標）
          for (const bld of _blds) {
            if (Array.isArray(bld.points) && bld.points.length >= 3 && _pip(gx, gy, bld.points)) return true;
          }
          // ②3Dタイル建物（sampleHeightMostDetailed事前計算マップ）— 完全一致検索
          // _doSampleとpostRenderが同じSAMP_PX=20・cap=40を使うためt値が一致→キーが一致する
          const g = gridToGeo(gx, gy);
          const k = `${Math.round(g.lng * 2e4)}_${Math.round(g.lat * 2e4)}`;
          return _uMap.get(k) ?? false;
        };

        // グリッドpx単位でのサンプリング間隔（_doSampleと同値を維持: 変えるときは両方変える）
        const SAMP_PX = 20;
        const _camPosWC = v.camera.positionWC;

        // ワイヤーCart3キャッシュ: 位置変化時のみ再構築（毎フレームのgridToGeo+fromDegrees排除）
        const _wC3 = _wireC3CacheRef.current;
        if (_wireC3DirtyRef.current) { _wC3.clear(); _wireC3DirtyRef.current = false; }
        const _t0Wire = performance.now();

        _segs.forEach(seg => {
          const a = _amap[seg.from], b = _amap[seg.to];
          if (!a || !b) return;
          const wps = _swp[seg.id] || [];
          const wzs = _swpz[seg.id] || [];

          // Cartesian3キャッシュ取得/構築（位置変化時のみ計算）
          let _wc = _wC3.get(seg.id);
          if (!_wc) {
            const _rawPts = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
            const _c3s = _rawPts.map(p => {
              const _g = gridToGeo(p.x, p.y);
              return Cesium.Cartesian3.fromDegrees(_g.lng, _g.lat, baseElev + (p.z || 0));
            });
            _wc = { c3s: _c3s, pts: _rawPts };
            _wC3.set(seg.id, _wc);
          }
          const { c3s, pts } = _wc;

          // 毎フレーム: キャッシュ済みCart3→スクリーン投影（worldToWindowCoordinates）
          const sprj = c3s.map((c3, pi) => {
            const s = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, c3);
            if (!s) return null;
            const p = pts[pi];
            return { x: s.x, y: s.y, gx: p.x, gy: p.y, gz: p.z || 0, c3, pi };
          }).filter(Boolean);
          if (sprj.length < 2) return;

          const segs2 = [];
          for (let i = 0; i < sprj.length - 1; i++) {
            const p1 = sprj[i], p2 = sprj[i + 1];

            // キャッシュ済みCart3をECEF線形補間でtmid点距離計算（fromDegrees・trig不要）
            const _segSS = (tmid) => {
              const _mx = p1.c3.x + tmid*(p2.c3.x - p1.c3.x);
              const _my = p1.c3.y + tmid*(p2.c3.y - p1.c3.y);
              const _mz = p1.c3.z + tmid*(p2.c3.z - p1.c3.z);
              const _dx = _camPosWC.x - _mx, _dy = _camPosWC.y - _my, _dz = _camPosWC.z - _mz;
              const _d = Math.sqrt(_dx*_dx + _dy*_dy + _dz*_dz);
              return 1.0 / Math.max(0.001, 2 * _d * Math.tan(fov_svg / 2) / ch_svg);
            };

            const dgx = p2.gx - p1.gx, dgy = p2.gy - p1.gy;
            const dist = Math.sqrt(dgx * dgx + dgy * dgy);
            // 最大40ステップに制限（1km離れたワイヤーで dist が数千pxになりサンプル数が膨大になるのを防ぐ）
            const nStep = Math.min(40, Math.max(1, Math.ceil(dist / SAMP_PX)));

            // 等間隔サンプリング → under 列を取得（グリッド座標で判定）
            const samps = [];
            for (let s = 0; s <= nStep; s++) {
              const t = s / nStep;
              const gz_t = p1.gz + t * (p2.gz - p1.gz);
                samps.push({
                t,
                u: _underAt(
                  p1.gx + t * (p2.gx - p1.gx),
                  p1.gy + t * (p2.gy - p1.gy),
                ),
              });
            }

            // ECEF線形補間でスクリーン投影（fromDegrees不要）
            const _screenAtT = (t) => {
              if (t <= 0) return { x: p1.x, y: p1.y };
              if (t >= 1) return { x: p2.x, y: p2.y };
              const _iC3 = new Cesium.Cartesian3(
                p1.c3.x + t*(p2.c3.x - p1.c3.x),
                p1.c3.y + t*(p2.c3.y - p1.c3.y),
                p1.c3.z + t*(p2.c3.z - p1.c3.z)
              );
              const s = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, _iC3);
              return s ? { x: s.x, y: s.y } : { x: p1.x + t*(p2.x-p1.x), y: p1.y + t*(p2.y-p1.y) };
            };

            // 遷移点で分割 → 黒/薄セグメント生成（2分探索で境界を±0.2px精度に絞る）
            const crossTs = [0];
            for (let s = 0; s < nStep; s++) {
              if (samps[s].u !== samps[s + 1].u) {
                // 2分探索: 6回でSAMP_PX/2^6 ≈ 0.2px精度
                let lo = samps[s].t, hi = samps[s + 1].t;
                for (let iter = 0; iter < 6; iter++) {
                  const mid = (lo + hi) / 2;
                  const umid = _underAt(
                    p1.gx + mid * dgx,
                    p1.gy + mid * dgy,
                  );
                  if (umid === samps[s].u) lo = mid; else hi = mid;
                }
                crossTs.push((lo + hi) / 2);
              }
            }
            crossTs.push(1);
            for (let k = 0; k < crossTs.length - 1; k++) {
              const ta = crossTs[k], tb = crossTs[k + 1];
              const tmid = (ta + tb) / 2;
              const nearest = samps.reduce((a, b) =>
                Math.abs(b.t - tmid) < Math.abs(a.t - tmid) ? b : a);
              const s1 = _screenAtT(ta), s2 = _screenAtT(tb);
              segs2.push({ x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, under: nearest.u, ss: _segSS(tmid) });
            }
          }

          // midSegs（折れ点追加用中点）
          const midSegs = [];
          for (let _mi = 0; _mi < sprj.length - 1; _mi++) {
            const sA = sprj[_mi], sB = sprj[_mi + 1];
            const sdx = sB.x - sA.x, sdy = sB.y - sA.y;
            if (sdx * sdx + sdy * sdy < 400) continue;
            const pi_a = sA.pi, pi_b = sB.pi;
            midSegs.push({
              mx: (sA.x + sB.x) / 2, my: (sA.y + sB.y) / 2, si: _mi,
              aIsNode: _mi === 0, bIsNode: _mi === sprj.length - 2,
              fromId: seg.from, toId: seg.to,
              origAx: pts[pi_a].x, origAy: pts[pi_a].y, origAz: pts[pi_a].z || 0,
              origBx: pts[pi_b].x, origBy: pts[pi_b].y, origBz: pts[pi_b].z || 0,
            });
          }
          if (segs2.length > 0) paths.push({
            id: seg.id, isBus: seg.isBus, segs: segs2, strokeScale,
            wps: sprj.slice(1, sprj.length - 1).map((sp, i) => ({ x: sp.x, y: sp.y, wpIndex: i })),
            midSegs,
          });
        });

        // drag中用にwireパスをキャッシュ（drag中はここに入らないので前回フレームのパスが保存される）
        _lastWirePathsRef.current = paths;
        _tWire = performance.now() - _t0Wire;

        // ── Canvas直描き（同期・ちらつきなし）──
        const cvs = wireCanvasRef.current;
        if (cvs) {
          const cw = v.scene.canvas.clientWidth, ch2 = v.scene.canvas.clientHeight;
          if (cvs.width !== cw || cvs.height !== ch2) { cvs.width = cw; cvs.height = ch2; }
          const ctx = cvs.getContext('2d');
          ctx.clearRect(0, 0, cw, ch2);
          const _ugHL = cbRef.current._ugWireMode;
          // 3パス描画（Pass 1a: 白塊→Pass 1b: destination-out→Pass 2: 黒コア）
          // カメラ移動中も同一パスで描画（fast/slow切替による見た目変化を排除）
          // Pass 1a: 全wireのアウトライン（白/青枠）を描画 → 接続wires同士が白で融合
          paths.forEach(w => {
            const _ssFallback = w.strokeScale ?? 1.0;
            const _hs = cbRef.current._hoverSeg;
            const _hi = cbRef.current._hoverId;
            const isHL_w = _hs === w.id ||
              (_hi && (cbRef.current._segs || []).some(s => s.id === w.id && (s.from === _hi || s.to === _hi))) ||
              _wpDragCanvasRef.current?.segId === w.id;
            const outlineColor = isHL_w ? '#3B82F6' : '#E8ECF0';
            w.segs.forEach(s => {
              const _ss = s.ss !== undefined ? s.ss : _ssFallback;
              const _bW = Math.min(2.0, Math.max(0.5, (w.isBus ? 5 : 3) * _ss));
              ctx.globalAlpha = s.under ? 0.35 : 1.0;
              if (_ugHL && s.under) {
                ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
                ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = _bW + 8;
                ctx.lineCap = 'round'; ctx.stroke();
              }
              ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
              ctx.strokeStyle = outlineColor; ctx.lineWidth = _bW + 2;
              ctx.lineCap = 'round'; ctx.stroke();
            });
          });
          // Pass 1b: destination-outで融合白塊の内側を削除 → T字なら「T字外周」のみ残る
          try {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = 1.0;
            paths.forEach(w => {
              const _ssFallback = w.strokeScale ?? 1.0;
              w.segs.forEach(s => {
                const _ss = s.ss !== undefined ? s.ss : _ssFallback;
                const _bW = Math.min(2.0, Math.max(0.5, (w.isBus ? 5 : 3) * _ss));
                ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
                ctx.strokeStyle = '#000000'; ctx.lineWidth = _bW;
                ctx.lineCap = 'round'; ctx.stroke();
              });
            });
          } finally {
            ctx.globalCompositeOperation = 'source-over';
          }
          // Pass 2: コア（黒線）を描画
          paths.forEach(w => {
            const _ssFallback = w.strokeScale ?? 1.0;
            w.segs.forEach(s => {
              const _ss = s.ss !== undefined ? s.ss : _ssFallback;
              const _bW = Math.min(2.0, Math.max(0.5, (w.isBus ? 5 : 3) * _ss));
              ctx.globalAlpha = s.under ? 0.35 : 1.0;
              ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
              ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = _bW;
              ctx.lineCap = 'round'; ctx.stroke();
            });
          });
          ctx.globalAlpha = 1.0;
          // 平面図等wpドラッグ中: ドラッグ中wireを _wpDragCanvasRef から直接再投影して上書き
          // （pathsはcbRef経由でReactサイクル後に更新→1フレーム遅れる。wp四角と同ソースで描くと差が消える）
          const _wpDO = _wpDragCanvasRef.current;
          if (_wpDO) {
            const _cachedW = paths.find(pw => pw.id === _wpDO.segId);
            const _ss = Math.min(1.0, _cachedW?.strokeScale ?? 1.0);
            const _baseW = Math.max(1.0, (_cachedW?.isBus ? 5 : 3) * _ss);
            // ドラッグ中wireを新鮮なpath座標から再投影して上書き（stale pathsを覆う）
            const _wPts = _wpDO.path.map(p => {
              const _g = gridToGeo(p.x, p.y);
              return prj(Cesium.Cartesian3.fromDegrees(_g.lng, _g.lat, baseElev + (p.z || 0)));
            }).filter(Boolean);
            if (_wPts.length >= 2) {
              // outline (青)
              ctx.beginPath();
              ctx.moveTo(_wPts[0].x, _wPts[0].y);
              _wPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
              ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = _baseW + 2;
              ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.stroke();
              // inner line
              ctx.beginPath();
              ctx.moveTo(_wPts[0].x, _wPts[0].y);
              _wPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
              ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = _baseW;
              ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
            }
            // 折れ点四角（wireと同ソース→同フレームで同位置）
            const _wSz = 14;
            _wpDO.path.slice(1, -1).forEach(wp => {
              const _wg = gridToGeo(wp.x, wp.y);
              const _wC = Cesium.Cartesian3.fromDegrees(_wg.lng, _wg.lat, baseElev + (wp.z || 0));
              const _wS = prj(_wC);
              if (!_wS) return;
              ctx.fillStyle = '#FFFFFF';
              ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.rect(Math.round(_wS.x - _wSz/2), Math.round(_wS.y - _wSz/2), _wSz, _wSz);
              ctx.fill(); ctx.stroke();
            });
          }
        }

        // ── アイコン Cartesian3 位置キャッシュ再構築（allMapPos/nodes変化時のみ）──
        // カメラ移動中はここをスキップ → prj() だけが毎フレーム実行される
        const _t0IconC3 = performance.now();
        if (_iconCart3DirtyRef.current) {
          _iconCart3DirtyRef.current = false;
          const _nc = new Map();
          const _nmC = cbRef.current._nodes || [], _amC = cbRef.current._allMapPos || {};
          _nmC.forEach(n => {
            if (n.kind !== 'symbol') return;
            const p = _amC[n.id]; if (!p) return;
            const g = gridToGeo(p.x, p.y);
            _nc.set(n.id, Cesium.Cartesian3.fromDegrees(g.lng, g.lat, baseElev + (p.z || 0)));
          });
          _iconCart3CacheRef.current = _nc;
        }

        _tIconC3 = performance.now() - _t0IconC3;
        // ── アイコン canvas 描画（wire より後 → 常に前面）──
        // 距離スケール: billboard と同一式。遠いほど小さく・薄くなる
        const _t0IconDraw = performance.now();
        if (cvs) {
          const _hid = cbRef.current._hoverId;
          const _rSegs = cbRef.current._routeSegs;
          const _ctxI = cvs.getContext('2d'); // ループ外で1回だけ取得
          (cbRef.current._nodes || []).forEach(n => {
            if (n.kind !== 'symbol') return;
            const _ci = _iconCart3CacheRef.current.get(n.id); if (!_ci) return;
            const _si = prj(_ci); if (!_si) return;
            const _dxi = _camPosWC.x - _ci.x, _dyi = _camPosWC.y - _ci.y, _dzi = _camPosWC.z - _ci.z;
            const _ri = Math.sqrt(_dxi*_dxi + _dyi*_dyi + _dzi*_dzi);
            const _ti = Math.max(0, Math.min(1, (_ri - 50) / (5000 - 50)));
            const _wI = Math.max(4, Math.round(30 * (1.0 + (0.15 - 1.0) * _ti)));
            const _lHI = n.label ? 14 : 0;
            const _hI = Math.round(_wI * (38 + _lHI) / 38);
            const _isFiltered = _rSegs && !_rSegs.nodeIds?.has(n.id);
            const _baseAlpha = _isFiltered ? 0.25 : 1.0; // サイズフェードで十分 → alpha常に100%
            const _isHL = _hid === n.id;
            // ホバー時: 青枠をアイコンの周囲に描画
            if (_isHL) {
              _ctxI.globalAlpha = _baseAlpha;
              _ctxI.strokeStyle = '#3B82F6'; _ctxI.lineWidth = 3;
              const _px = Math.round(_si.x - _wI / 2), _py = Math.round(_si.y - _hI);
              _ctxI.strokeRect(_px - 3, _py - 3, _wI + 6, _hI + 6);
              _ctxI.globalAlpha = 1.0;
            }
            const _iconCv = _getDrawCanvas(n.shape, n.color, n.label);
            _ctxI.globalAlpha = _baseAlpha;
            // destination-out等で透明になった領域を白で塗り潰してからアイコンを重ねる
            _ctxI.fillStyle = '#FFFFFF';
            _ctxI.fillRect(Math.round(_si.x - _wI / 2), Math.round(_si.y - _hI), _wI, _hI);
            _ctxI.drawImage(_iconCv, Math.round(_si.x - _wI / 2), Math.round(_si.y - _hI), _wI, _hI);
            _ctxI.globalAlpha = 1.0;
            // hover検出用にスクリーン座標をキャッシュ
            _lastIconScreenRef.current.set(n.id, { x: _si.x, y: _si.y, w: _wI, h: _hI });
          });
          // 今フレームに描画されなかったアイコン（off-screen等）はキャッシュから除去
          const _drawnIds = new Set((cbRef.current._nodes || []).filter(n => n.kind === 'symbol').map(n => n.id));
          for (const _k of _lastIconScreenRef.current.keys()) { if (!_drawnIds.has(_k)) _lastIconScreenRef.current.delete(_k); }

          // 矢視図オーバーレイ: wireキャンバスに描画（Cesiumエンティティより綺麗）
          const _secOvs = cbRef.current._sectionOverlays || [];
          if (_secOvs.length > 0) {
            // destination-outが残留していないよう明示リセット
            _ctxI.globalCompositeOperation = 'source-over';
            _ctxI.globalAlpha = 1.0;
            const _H = baseElev + 2;
            const _g2c = (gx, gy) => {
              const g = gridToGeo(gx, gy);
              const c3 = Cesium.Cartesian3.fromDegrees(g.lng, g.lat, _H);
              return prj(c3);
            };
            _ctxI.save();
            _secOvs.forEach(ov => {
              const csPts = ov.corners.map(([gx, gy]) => _g2c(gx, gy));
              if (csPts.some(p => !p)) return;
              // fill
              _ctxI.beginPath();
              _ctxI.moveTo(csPts[0].x, csPts[0].y);
              csPts.slice(1).forEach(p => _ctxI.lineTo(p.x, p.y));
              _ctxI.closePath();
              _ctxI.fillStyle = 'rgba(128,128,128,0.10)';
              _ctxI.fill();
              // outline
              _ctxI.strokeStyle = 'rgba(26,26,26,0.40)';
              _ctxI.lineWidth = 1;
              _ctxI.stroke();
              // baseLine
              const bl = ov.baseLine.map(([gx, gy]) => _g2c(gx, gy));
              if (bl[0] && bl[1]) {
                _ctxI.beginPath();
                _ctxI.moveTo(bl[0].x, bl[0].y);
                _ctxI.lineTo(bl[1].x, bl[1].y);
                _ctxI.strokeStyle = 'rgba(26,26,26,0.50)';
                _ctxI.lineWidth = 1.5;
                _ctxI.stroke();
              }
              // arms + arrowhead
              ov.arms.forEach(([[bx, by], [tx, ty]]) => {
                const ps = _g2c(bx, by), pe = _g2c(tx, ty);
                if (!ps || !pe) return;
                const dx = pe.x - ps.x, dy = pe.y - ps.y;
                const len = Math.sqrt(dx * dx + dy * dy); if (len < 1) return;
                const ux = dx / len, uy = dy / len;
                _ctxI.beginPath();
                _ctxI.moveTo(ps.x, ps.y);
                _ctxI.lineTo(pe.x, pe.y);
                _ctxI.strokeStyle = 'rgba(26,26,26,0.50)';
                _ctxI.lineWidth = 1;
                _ctxI.stroke();
                // arrowhead triangle
                const ahl = 8, ahw = 4;
                _ctxI.beginPath();
                _ctxI.moveTo(pe.x, pe.y);
                _ctxI.lineTo(pe.x - ux * ahl - uy * ahw, pe.y - uy * ahl + ux * ahw);
                _ctxI.lineTo(pe.x - ux * ahl + uy * ahw, pe.y - uy * ahl - ux * ahw);
                _ctxI.closePath();
                _ctxI.fillStyle = 'rgba(26,26,26,0.50)';
                _ctxI.fill();
              });
            });
            _ctxI.restore();
          }
        }

        _tIconDraw = performance.now() - _t0IconDraw;

        // ホバーオーバーレイをカメラ移動に追従（React state更新なし・直接DOM操作）
        const _hoverIdNow = cbRef.current._hoverId;
        if (_hoverIdNow && hoverOverlayRef.current) {
          const _hic = _lastIconScreenRef.current.get(_hoverIdNow);
          if (_hic) {
            hoverOverlayRef.current.style.left = (_hic.x - 21) + 'px';
            hoverOverlayRef.current.style.top  = (_hic.y - 46) + 'px';
          }
        }
        // 建屋バッジオーバーレイ位置更新（選択中建屋の頂部に追従）
        const _bldSelNow = cbRef.current._bldSelected;
        if (_bldSelNow && bldBadgeOverlayRef.current) {
          const _bSelBlks = (cbRef.current._blds || []).filter(b => b.buildingId === _bldSelNow.buildingId);
          if (_bSelBlks.length > 0) {
            const _bBcx = _bSelBlks.reduce((s, b) => s + (b.pxMinX + b.pxMaxX) / 2, 0) / _bSelBlks.length;
            const _bBcy = _bSelBlks.reduce((s, b) => s + (b.pxMinY + b.pxMaxY) / 2, 0) / _bSelBlks.length;
            const _bBcz = Math.max(..._bSelBlks.map(b => b.zTop || 0));
            const _bGeo = gridToGeo(_bBcx, _bBcy);
            const _bC3  = Cesium.Cartesian3.fromDegrees(_bGeo.lng, _bGeo.lat, baseElev + _bBcz);
            const _bSp  = prj(_bC3);
            if (_bSp) {
              bldBadgeOverlayRef.current.style.left = _bSp.x + 'px';
              bldBadgeOverlayRef.current.style.top  = _bSp.y + 'px';
            }
          }
        }

        // SVGはホバー当たり判定・折れ点四角のみに使用（100msスロットル・カメラ移動中はスキップ）
        // カメラ操作中はReact再レンダリングを止め、カメラ移動の重さを軽減する
        const _now = Date.now();
        if (!_camMoving && _now - _svgLastUpdateRef.current > 100) {
          _svgLastUpdateRef.current = _now;
          setWireSVGPaths(paths);
        }
        // 計測ログ: postRenderの自前処理が5ms超えたらセクション別に出力
        const _prMs = performance.now() - _prT0;
        if (_prMs > 5) console.warn(`[postRender] total=${_prMs.toFixed(1)}ms  wire=${_tWire.toFixed(1)}ms  iconC3=${_tIconC3.toFixed(1)}ms  iconDraw=${_tIconDraw.toFixed(1)}ms`);
      } catch (_) {}
    });

    // _camMovingはこのuseEffectのローカル変数なのでここで_camStopRefを定義する
    _camStopRef.current = () => {
      if (!_camMoving) return;
      clearTimeout(_camMoveTimer); _camMoveTimer = null;
      clearTimeout(_camActivateTimer); _camActivateTimer = null;
      _camMoving = false;
      _cameraMovingRef.current = false;
      if (_cam2DActive) {
        _cam2DActive = false;
        if (v._tileset3d && !v._tileset3d.isDestroyed()) {
          v.scene.globe.show = false;
          v._tileset3d.show = true;
        }
      }
      if (_underSamplePendingRef.current) {
        _underSamplePendingRef.current = false;
        _runUnderSampleRef.current?.();
      }
      _canvasDirtyRef.current = true;
      if (!v.isDestroyed()) v.scene.requestRender();
    };

    const _onPointerDown = () => { _pointerDownRef.current = true; };
    const _onPointerUp = () => {
      _pointerDownRef.current = false; // 慣性中でもunder高速パスを即解除 → キャッシュ値で描画
      _camStopRef.current?.();         // pan(inertia=0)の場合はカメラも即停止
    };
    v.scene.canvas.addEventListener('pointerdown', _onPointerDown);
    v.scene.canvas.addEventListener('pointerup',   _onPointerUp);

    return () => {
      try { remove(); } catch (_) {}
      v.scene.canvas.removeEventListener('pointerdown', _onPointerDown);
      v.scene.canvas.removeEventListener('pointerup',   _onPointerUp);
      _camStopRef.current = null;
    };
  }, [initDoneRef.current]);

  // 配線Polyline同期（canvas overlay描画のみ。Cesium entityなし → GeometryVisualizer開銷ゼロ）
  const wireSyncTimer = useRef(null);
  useEffect(() => {
    if (dragStateRef?.current) return;
    if (wireSyncTimer.current) cancelAnimationFrame(wireSyncTimer.current);
    wireSyncTimer.current = requestAnimationFrame(() => {
      const v = viewerRef.current;
      if (!v || v.isDestroyed() || !initDoneRef.current) return;
      // posKeyだけ追跡（sampleHeight useEffectの変化検知 + dragUpdate guard用）
      const entityMap = wireEntityMapRef.current;
      const currentIds = new Set(segs.map(s => s.id));
      for (const id of entityMap.keys()) { if (!currentIds.has(id)) entityMap.delete(id); }
      segs.forEach(seg => {
        const a = allMapPos[seg.from], b = allMapPos[seg.to]; if (!a || !b) return;
        const wps = segWp[seg.id] || [], wzs = wpZ[seg.id] || [];
        const path = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
        const posKey = path.map(p => `${p.x},${p.y},${p.z||0}`).join('|');
        const rec = entityMap.get(seg.id);
        if (!rec || rec.posKey !== posKey) entityMap.set(seg.id, { posKey });
      });
      v.scene.requestRender();
    });
  }, [allMapPos, segs, segWp, wpZ]);

  // wire変化時にsampleHeightMostDetailedで3Dタイル建物を事前計算（カメラ非依存）
  // wireHashで「ワイヤーパスが変わった場合のみ」再サンプル。新規アイコン追加だけならスキップ。
  // _runUnderSampleRef経由でタイルロード完了時にも直接呼び出し可能（旧setTileVersion→再レンダー廃止）
  useEffect(() => {
    // wire位置・高度が変化 → 新エリアでタイル未ロードの可能性があるため再サンプル許可
    _underSampleAllValidRef.current = false;

    const _doSample = () => {
      if (sampleTimerRef.current) clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = setTimeout(() => {
        const v = viewerRef.current;
        if (!v || v.isDestroyed() || !initDoneRef.current) return;

        // カメラ移動中はスキップ: カメラ停止タイマーがpending確認後に再実行する
        if (_cameraMovingRef.current) {
          _underSamplePendingRef.current = true;
          return;
        }

        const baseElev = localBaseElev || v._siteBaseElevation || 0;

        // 動かしたアイコンの接続wireのみ対象（なければ全wire）
        const _movedId = movedNodeRef?.current;
        const targetSegs = _movedId
          ? segs.filter(s => s.from === _movedId || s.to === _movedId)
          : segs;

        // ワイヤー座標ハッシュ（対象segsのみ）
        const wireHash = targetSegs.map(seg => {
          const a = allMapPos[seg.from], b = allMapPos[seg.to];
          if (!a || !b) return '';
          const wps = segWp[seg.id] || [], wzs = wpZ[seg.id] || [];
          return [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b]
            .map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)},${(p.z || 0).toFixed(1)}`).join('>');
        }).join('|') + `|${baseElev.toFixed(2)}`;

        // 対象wireのパスに変化なし かつ タイルロードによる強制再サンプルもなし → スキップ
        if (_wireHashRef.current === wireHash && !_tileUpdateNeededRef.current) {
          v.scene.requestRender();
          return;
        }
        _tileUpdateNeededRef.current = false;
        _wireHashRef.current = wireHash;

        // localStorageキャッシュ確認: 同じwire配置なら即時復元してGPUサンプリング不要
        // キャッシュは _underSampleAllValidRef=true（全点有効）時のみ保存 → 常に完全なデータ
        try {
          const _c = JSON.parse(localStorage.getItem('cesium_under_v1'));
          if (_c?.hash === wireHash && Array.isArray(_c.data)) {
            _underStatesRef.current = new Map(_c.data);
            _underSampleAllValidRef.current = true;
            _canvasDirtyRef.current = true;
            if (!v.isDestroyed()) v.scene.requestRender();
            return; // キャッシュヒット: GPUサンプリング不要
          }
        } catch (_) {}

        // postRenderの_underAt呼び出しと同じSAMP_PX・同じnStepを使うことでgeoKeyが完全一致する
        // → 近傍検索不要。（postRender側のSAMP_PX=20・cap=40と必ず合わせること）
        const _mppS = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
        const SAMP_PX = 20; // ← postRenderのSAMP_PXと同値を維持（変えるときは両方変える）
        const MARGIN = 1.0;
        const positions = [], posInfo = [];

        targetSegs.forEach(seg => { // ← 全segsでなく接続wireのみ
          const a = allMapPos[seg.from], b = allMapPos[seg.to];
          if (!a || !b) return;
          const wps = segWp[seg.id] || [];
          const wzs = wpZ[seg.id] || [];
          const pts = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i], p2 = pts[i + 1];
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const nStep = Math.min(40, Math.max(1, Math.ceil(dist / SAMP_PX))); // postRender cap=40と一致
            // endpoint(s=0, s=nStep)も含めてサンプリング
            // → アイコン位置のunder判定が欠落して周辺wireが黒くなる問題を解消
            for (let s = 0; s <= nStep; s++) {
              const t = s / nStep;
              const gx = p1.x + t * dx, gy = p1.y + t * dy;
              const gz = (p1.z || 0) + t * ((p2.z || 0) - (p1.z || 0));
              const g = gridToGeo(gx, gy);
              const key = `${Math.round(g.lng * 2e4)}_${Math.round(g.lat * 2e4)}`;
              positions.push(Cesium.Cartographic.fromDegrees(g.lng, g.lat));
              posInfo.push({ key, wz: baseElev + gz });
            }
          }
        });

        if (positions.length === 0) {
          v.scene.requestRender(); return;
        }

        // 同時実行ガード: sampleHeightMostDetailedが実行中なら待機フラグを立てて終了
        if (_underSampleInFlightRef.current) {
          _underSamplePendingRef.current = true;
          return;
        }
        _underSampleInFlightRef.current = true;

        // チャンク分割サンプリング: 30点ずつ処理 → 部分結果を都度描画（大量drop時の体感待機を軽減）
        // 全部まとめると265点=720ms、30点なら~80ms毎に部分表示が出る
        (async () => {
          const CHUNK = 30;
          const MARGIN = 1.0;
          const _minValidH = Math.max(0.1, baseElev - 10);
          const newMap = new Map(_underStatesRef.current);
          let _dbgValid = 0, _dbgSkip = 0;

          for (let ci = 0; ci < positions.length; ci += CHUNK) {
            if (_wireHashRef.current !== wireHash || _sampleAbortRef.current) break; // wire位置変更 or カメラ移動で中断
            const chunkPos = positions.slice(ci, ci + CHUNK);
            const chunkInfo = posInfo.slice(ci, ci + CHUNK);
            let chunkRes;
            try {
              chunkRes = await v.scene.sampleHeightMostDetailed(chunkPos);
            } catch (_) {
              _wireHashRef.current = ''; break;
            }
            if (!chunkRes || v.isDestroyed() || _wireHashRef.current !== wireHash) break;
            chunkRes.forEach((cart, i) => {
              const { key, wz } = chunkInfo[i];
              const _h = cart?.height;
              if (_h != null && isFinite(_h) && _h > _minValidH) {
                newMap.set(key, wz < _h - MARGIN);
                _dbgValid++;
              } else {
                _dbgSkip++;
              }
            });
            // チャンク完了ごとに部分結果を即描画
            _underStatesRef.current = newMap;
            _canvasDirtyRef.current = true;
            if (!v.isDestroyed()) v.scene.requestRender();
          }

          if (v.isDestroyed() || _wireHashRef.current !== wireHash || _sampleAbortRef.current) return;

          const _underCount = [...newMap.values()].filter(Boolean).length;
          console.log(`[UNDER] SAMP_PX=${SAMP_PX} total=${positions.length} 有効=${_dbgValid} スキップ=${_dbgSkip} under=${_underCount}`);
          const _allValid = _dbgSkip === 0 && _dbgValid > 0;
          if (_wireHashRef.current === wireHash) {
            _underSampleAllValidRef.current = _allValid;
          }
          // 全点有効時のみlocalStorageに保存（次回同じ配置なら即時復元・GPUゼロ）
          if (_allValid) {
            try { localStorage.setItem('cesium_under_v1', JSON.stringify({ hash: wireHash, data: [...newMap.entries()] })); } catch (_) {}
          }
          if (_underCount === 0 && _dbgValid > 0 && (_underRetryCountRef.current ?? 0) < 2) {
            _underRetryCountRef.current = (_underRetryCountRef.current ?? 0) + 1;
            setTimeout(() => { _wireHashRef.current = ''; _doSample(); }, 3000);
          } else {
            _underRetryCountRef.current = 0;
          }
          if (_cameraMovingRef.current) {
            setTimeout(() => { _canvasDirtyRef.current = true; if (!v.isDestroyed()) v.scene.requestRender(); }, 450);
          }
        })().finally(() => {
          _underSampleInFlightRef.current = false;
          if (_underSamplePendingRef.current) {
            _underSamplePendingRef.current = false;
            if (!_underSampleAllValidRef.current) {
              _wireHashRef.current = '';
              _doSample();
            }
          }
        });
      }, 200);
    };

    // タイルロード完了時の直接呼び出しエントリを更新（最新のsegs/allMapPos等クロージャを保持）
    _runUnderSampleRef.current = () => {
      // ハッシュはクリアしない。_tileUpdateNeededRef=trueでのみハッシュをバイパスする
      _doSample();
    };

    if (dragStateRef?.current) return;
    _doSample();
  }, [segs, allMapPos, segWp, wpZ, initDone, localBaseElev]);

  // 全ビュー連動: ホバーハイライト + ルートフィルタ
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;

    const HL = Cesium.Color.fromCssColorString('#3B82F6');
    const FADED = 0.12; // フィルタ外の透明度
    const mats = getSharedMaterials();

    // ハイライト対象セグメントIDを計算
    const hlSegIds = new Set();
    if (hoverSeg) hlSegIds.add(hoverSeg);
    if (hoverId) {
      segs.forEach(s => { if (s.from === hoverId || s.to === hoverId) hlSegIds.add(s.id); });
    }

    // ノードハイライト対象ID
    const hlNodeIds = new Set();
    if (hoverId) hlNodeIds.add(hoverId);
    if (hoverSeg) {
      const seg = segs.find(s => s.id === hoverSeg);
      if (seg) { hlNodeIds.add(seg.from); hlNodeIds.add(seg.to); }
    }

    // ノードマーカー billboard entity 不使用（削除済み）

    // 配線ハイライト更新（アウトライン含む）
    wireEntitiesRef.current.forEach(ent => {
      if (!ent || !ent.polyline) return;
      const segId = ent._wireSegId;
      const isHL = hlSegIds.has(segId);
      const isFiltered = routeSegs && !routeSegs.segIds.has(segId);
      const seg2 = segs.find(s => s.id === segId);
      const isOut = ent._wireOutline;
      if (isFiltered) {
        ent.polyline.material = Cesium.Color.TRANSPARENT;
        ent._wireBaseWidth = 1;
        ent.polyline.depthFailMaterial = Cesium.Color.TRANSPARENT;
      } else if (isHL) {
        const mainW = seg2 && seg2.isBus ? 8 : 5;
        ent.polyline.material = isOut ? HL : Cesium.Color.TRANSPARENT;
        ent._wireBaseWidth = isOut ? mainW + 2 : mainW;
        ent.polyline.depthFailMaterial = isOut ? HL : HL.withAlpha(0.7);
      } else {
        const mainW = seg2 && seg2.isBus ? 5 : 3;
        ent.polyline.material = Cesium.Color.TRANSPARENT;
        ent._wireBaseWidth = isOut ? mainW + 2 : mainW;
        ent.polyline.depthFailMaterial = Cesium.Color.TRANSPARENT;
      }
    });

    // 折れ点マーカー: SVG overlay（白rect）が視覚表示を担当するため常に非表示
    wpMarkerRef.current.forEach(ent => { if (ent) ent.show = false; });

    v.scene.requestRender();
  }, [hoverId, hoverSeg, nodes, segs, routeSegs]);

  // Cesium画面座標 → グリッド座標変換（ドロップ用）
  const pickGridPos = useCallback((screenX, screenY) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return null;
    const canvas = v.scene.canvas;
    const rect = canvas.getBoundingClientRect();
    const cx = screenX - rect.left, cy = screenY - rect.top;
    // 地形上のピック
    const cartesian = v.scene.pickPosition(new Cesium.Cartesian2(cx, cy));
    if (!cartesian) {
      // フォールバック: 楕円体上のピック
      const ray = v.camera.getPickRay(new Cesium.Cartesian2(cx, cy));
      if (!ray) return null;
      const hit = v.scene.globe.pick(ray, v.scene);
      if (!hit) return null;
      const carto = Cesium.Cartographic.fromCartesian(hit);
      const grid = geoToGrid(
        Cesium.Math.toDegrees(carto.latitude),
        Cesium.Math.toDegrees(carto.longitude)
      );
      return { x: grid.x, y: grid.y, z: 0 };
    }
    const baseElev = v._siteBaseElevation || 0;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const grid = geoToGrid(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude)
    );
    return { x: grid.x, y: grid.y, z: Math.max(0, (carto.height - baseElev)) };
  }, []);

  // ドロップイベント処理
  const handleCesiumDrop = useCallback((e) => {
    e.preventDefault();
    // 【盤テンプレートを先に見る】単結ノードと配電盤で dataTransfer の形が違う。
    // 判定条件は App 側の readDroppedPanelTemplate が唯一の実装なので、ここにコピーしない。
    if (readDroppedPanelTemplate && onDropPanelTemplate && readDroppedPanelTemplate(e)) {
      const pos = pickGridPos(e.clientX, e.clientY);
      if (pos) onDropPanelTemplate(e, pos);
      return;
    }
    const id = e.dataTransfer?.getData("text/plain");
    if (!id || !onDropNode) return;
    const pos = pickGridPos(e.clientX, e.clientY);
    if (pos) onDropNode(id, pos);
  }, [onDropNode, pickGridPos, readDroppedPanelTemplate, onDropPanelTemplate]);

  // Cesium画面座標(Cartesian2)からグリッド座標を取得するヘルパー
  const pickGridFromCartesian2 = useCallback((c2) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return null;
    const cartesian = v.scene.pickPosition(c2);
    if (!cartesian) {
      const ray = v.camera.getPickRay(c2);
      if (!ray) return null;
      const hit = v.scene.globe.pick(ray, v.scene);
      if (!hit) return null;
      const carto = Cesium.Cartographic.fromCartesian(hit);
      return { x: geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude)).x,
               y: geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude)).y, z: 0 };
    }
    const baseElev = v._siteBaseElevation || 0;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const grid = geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
    return { x: grid.x, y: grid.y, z: Math.max(0, (carto.height - baseElev)) };
  }, []);

  // ギズモ選択状態 — 折れ点 { type:'wp', segId, wpIndex } またはノード { type:'node', nodeId }
  const gizmoTargetRef = useRef(null);
  const gizmoEntitiesRef = useRef([]);
  // SVGオーバーレイ用（CesiumMap内に閉じた管理）
  const cesiumGizmoWorldRef = useRef(null);
  const gizmoContRef      = useRef(null);  // CesiumMapの外側divのref
  const gizmoListenerRef  = useRef(null);  // postRenderリスナー解除関数
  const lastGizmoOriginRef = useRef(null); // prjがnullの時の最終有効スクリーン座標を保持
  const [cesiumGizmoSVG, setCesiumGizmoSVG] = useState(null);
  const cesiumGizmoSVGRef = useRef(null); // event handlerでのgizmo軸スクリーン座標参照（gizmo entity廃止後の代替）
  const [wireSVGPaths, setWireSVGPaths] = useState([]); // SVGオーバーレイ用ワイヤーパス（ホバー/折れ点四角の当たり判定用）
  const wireCanvasRef = useRef(null); // ワイヤー描画専用Canvas（postRenderで同期描画、ちらつきなし）
  const _wpDragCanvasRef = useRef(null); // 平面図等wpドラッグ中に折れ点四角をcanvas直描き用
  const [wpDragCes, setWpDragCes] = useState(null); // 2D/3Dモード折れ点ドラッグ
  const [segLineDragCes, setSegLineDragCes] = useState(null); // 2D/3Dモード線セグメント中点ドラッグ

  // 2D/3Dモード線セグメント中点ドラッグ（両端点を同量移動）
  useEffect(() => {
    if (!segLineDragCes) return;
    const { segId, si, aIsNode, bIsNode, fromId, toId,
            startClientX, startClientY, startPickGrid,
            origAx, origAy, origAz, origBx, origBy, origBz } = segLineDragCes;
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    const aWpIndex = aIsNode ? null : si - 1;
    const bWpIndex = bIsNode ? null : si;

    // セグメント方向（ワールド座標）
    const wdx = origBx - origAx, wdy = origBy - origAy;
    const wlen = Math.sqrt(wdx * wdx + wdy * wdy) || 1;
    const parX = wdx / wlen, parY = wdy / wlen;
    const perpX = -wdy / wlen, perpY = wdx / wlen;

    const pickGrid2 = (cx, cy) => {
      const pos = new Cesium.Cartesian2(cx, cy);
      let cart = v.scene.pickPosition(pos);
      if (!cart) { const ray = v.camera.getPickRay(pos); if (ray) cart = v.scene.globe.pick(ray, v.scene); }
      if (!cart) return null;
      const carto = Cesium.Cartographic.fromCartesian(cart);
      return geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
    };

    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    v.scene.screenSpaceCameraController.enableRotate = false;
    v.scene.screenSpaceCameraController.enableTranslate = false;
    v.scene.screenSpaceCameraController.enableZoom = false;
    v.scene.screenSpaceCameraController.enableTilt = false;

    const mv = (e) => {
      const rect = v.scene.canvas.getBoundingClientRect();
      const sg = pickGrid2(startClientX - rect.left, startClientY - rect.top) || startPickGrid;
      const cg = pickGrid2(e.clientX - rect.left, e.clientY - rect.top);
      if (!cg) return;
      let dx = cg.x - sg.x, dy = cg.y - sg.y;
      if (e.shiftKey) {
        const projPerp = Math.abs(dx * perpX + dy * perpY);
        const projPar  = Math.abs(dx * parX  + dy * parY);
        if (projPerp >= projPar) {
          const t = dx * perpX + dy * perpY;
          dx = t * perpX; dy = t * perpY;
        } else {
          const t = dx * parX + dy * parY;
          dx = t * parX; dy = t * parY;
        }
      }
      const cb = cbRef.current;
      const newAx = origAx + dx, newAy = origAy + dy;
      const newBx = origBx + dx, newBy = origBy + dy;
      if (aIsNode) cb.onMoveNode?.(fromId, { x: newAx, y: newAy, z: origAz });
      else cb.onMoveWp?.(segId, aWpIndex, { x: newAx, y: newAy, z: origAz });
      if (bIsNode) cb.onMoveNode?.(toId, { x: newBx, y: newBy, z: origBz });
      else cb.onMoveWp?.(segId, bWpIndex, { x: newBx, y: newBy, z: origBz });
    };

    const up = (e) => {
      grabOff();
      const rect = v.scene.canvas.getBoundingClientRect();
      const sg = pickGrid2(startClientX - rect.left, startClientY - rect.top) || startPickGrid;
      const cg = pickGrid2(e.clientX - rect.left, e.clientY - rect.top);
      if (cg) {
        let dx = cg.x - sg.x, dy = cg.y - sg.y;
        if (e.shiftKey) {
          const projPerp = Math.abs(dx * perpX + dy * perpY);
          const projPar  = Math.abs(dx * parX  + dy * parY);
          if (projPerp >= projPar) {
            const t = dx * perpX + dy * perpY;
            dx = t * perpX; dy = t * perpY;
          } else {
            const t = dx * parX + dy * parY;
            dx = t * parX; dy = t * parY;
          }
        }
        const cb = cbRef.current;
        const snap = (v) => Math.round(v / MINOR) * MINOR;
        const newAx = snap(origAx + dx), newAy = snap(origAy + dy);
        const newBx = snap(origBx + dx), newBy = snap(origBy + dy);
        if (aIsNode) cb.onMoveNode?.(fromId, { x: newAx, y: newAy, z: origAz });
        else cb.onDropWp?.(segId, aWpIndex, { x: newAx, y: newAy, z: origAz });
        if (bIsNode) cb.onMoveNode?.(toId, { x: newBx, y: newBy, z: origBz });
        else cb.onDropWp?.(segId, bWpIndex, { x: newBx, y: newBy, z: origBz });
      }
      const vv = viewerRef.current;
      if (vv && !vv.isDestroyed()) {
        vv.scene.screenSpaceCameraController.enableRotate = true;
        vv.scene.screenSpaceCameraController.enableTranslate = true;
        vv.scene.screenSpaceCameraController.enableZoom = true;
        vv.scene.screenSpaceCameraController.enableTilt = true;
      }
      setSegLineDragCes(null);
    };

    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
  }, [segLineDragCes]);

  // 2D/3Dモード折れ点ドラッグ（XY方向のみ）
  useEffect(() => {
    if (!wpDragCes) return;
    const { segId, wpIndex, startClientX, startClientY, startPickGrid, startWpX, startWpY, startWpZ } = wpDragCes;
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;

    const pickGrid = (cx, cy) => {
      const pos = new Cesium.Cartesian2(cx, cy);
      let cart = v.scene.pickPosition(pos);
      if (!cart) { const ray = v.camera.getPickRay(pos); if (ray) cart = v.scene.globe.pick(ray, v.scene); }
      if (!cart) return null;
      const carto = Cesium.Cartographic.fromCartesian(cart);
      return geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
    };

    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    // ドラッグ中はCesiumカメラ操作を無効化
    v.scene.screenSpaceCameraController.enableRotate = false;
    v.scene.screenSpaceCameraController.enableTranslate = false;
    v.scene.screenSpaceCameraController.enableZoom = false;
    v.scene.screenSpaceCameraController.enableTilt = false;

    const mv = (e) => {
      const rect = v.scene.canvas.getBoundingClientRect();
      const sg = pickGrid(startClientX - rect.left, startClientY - rect.top) || startPickGrid;
      const cg = pickGrid(e.clientX - rect.left, e.clientY - rect.top);
      if (!cg) return;
      const newX = startWpX + (cg.x - sg.x);
      const newY = startWpY + (cg.y - sg.y);
      cbRef.current.onMoveWp?.(segId, wpIndex, { x: newX, y: newY, z: startWpZ });
    };

    const up = () => {
      grabOff();
      const vv = viewerRef.current;
      if (vv && !vv.isDestroyed()) {
        vv.scene.screenSpaceCameraController.enableRotate = true;
        vv.scene.screenSpaceCameraController.enableTranslate = true;
        vv.scene.screenSpaceCameraController.enableZoom = true;
        vv.scene.screenSpaceCameraController.enableTilt = true;
      }
      setWpDragCes(null);
    };

    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
  }, [wpDragCes]);

  // 方位キューブ: postRenderでカメラheading/pitchを追跡
  useEffect(() => {
    if (!initDone) return;
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    const unsub = v.scene.postRender.addEventListener(() => {
      if (v.isDestroyed()) return;
      const h = v.camera.heading;
      const p = v.camera.pitch;
      if (cubeOrientRef.current.h !== h || cubeOrientRef.current.p !== p) {
        cubeOrientRef.current = { h, p };
        setCubeOrient({ h, p });
      }
    });
    return () => { try { unsub(); } catch {} };
  }, [initDone]);

  // 方位キューブ: ドラッグでカメラ回転
  useEffect(() => {
    const onMove = (e) => {
      if (!cubeDragRef.current) return;
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;
      const dx = e.clientX - cubeDragRef.current.startX;
      const dy = e.clientY - cubeDragRef.current.startY;
      const sens = 0.005;
      const newH = cubeDragRef.current.startH - dx * sens;
      const newP = Math.max(-Math.PI / 2 + 0.01, Math.min(0, cubeDragRef.current.startP - dy * sens));
      viewer.camera.setView({ destination: viewer.camera.position, orientation: { heading: newH, pitch: newP, roll: 0 } });
      viewer.scene.requestRender();
    };
    const onUp = () => {
      if (!cubeDragRef.current) return;
      cubeDragRef.current = null;
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) {
        const ctrl = viewer.scene.screenSpaceCameraController;
        if (ctrl) { ctrl.enableRotate = true; ctrl.enableTranslate = true; ctrl.enableZoom = true; ctrl.enableTilt = true; }
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ギズモ描画: SVGオーバーレイ（3次元図と同デザイン）+ 透明エンティティ（ピッキング用）
  const drawGizmoAt = useCallback((gridX, gridY, gridZ) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    cesiumGizmoWorldRef.current = { gridX, gridY, gridZ };
    const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    const baseElev = v._siteBaseElevation || 0;
    const geo = gridToGeo(gridX, gridY);
    const z = baseElev + (gridZ || 0);
    const origin = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, z);
    const getLen = () => { const h = v.camera.positionCartographic?.height ?? 1000; return Math.min(Math.max(h / mpp * 0.10, 100), 50000); };

    // postRenderリスナーを初回のみ設定（drawGizmoAt時点でviewerは確実に存在）
    if (!gizmoListenerRef.current) {
      const remove = v.scene.postRender.addEventListener(() => {
        const data = cesiumGizmoWorldRef.current;
        const cont = gizmoContRef.current;
        if (!data || !cont || v.isDestroyed()) { setCesiumGizmoSVG(null); return; }
        const { gridX: gx, gridY: gy, gridZ: gz } = data;
        const bElev = v._siteBaseElevation || 0;
        const mpp2 = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
        const geo0 = gridToGeo(gx, gy);
        const z0 = bElev + (gz || 0);
        const orig3d = Cesium.Cartesian3.fromDegrees(geo0.lng, geo0.lat, z0);
        const prj = (w) => { try { const s = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, w); return s ? { x: s.x, y: s.y } : null; } catch { return null; } };
        const rawO = prj(orig3d);
        const o = rawO || lastGizmoOriginRef.current;
        if (!o) return;
        if (rawO) lastGizmoOriginRef.current = rawO;
        const AXIS_SVG_LEN = 60; // ズームに関係なく固定ピクセル長
        const pnR = (plantNorthAngleRef.current || 0) * Math.PI / 180;
        // カメラのheading/pitchから各軸のスクリーン方向を解析的に計算
        // ECEFベース投影(prj)を使わないためカメラ近接時にtipがnullになる問題を根本解決
        //   X軸: (cos θ,  sin(p)·sin θ)
        //   Y軸: (−sin θ, sin(p)·cos θ)
        //   Z軸: (0,      −cos(p))
        const h = v.camera.heading;
        const p = v.camera.pitch;
        const theta = h - pnR;
        const sp = Math.sin(p), cp = Math.cos(p);
        const ct = Math.cos(theta), st = Math.sin(theta);
        const axs = [
          { axis:'x', color:'#EF4444', dx: ct,  dy:  sp * st },
          { axis:'y', color:'#22C55E', dx: -st, dy:  sp * ct },
          { axis:'z', color:'#3B82F6', dx: 0,   dy: -cp      },
        ].map(({ axis, color, dx, dy }) => {
          const d = Math.sqrt(dx * dx + dy * dy);
          const tip = d < 1e-9 ? null : { x: o.x + dx / d * AXIS_SVG_LEN, y: o.y + dy / d * AXIS_SVG_LEN };
          return { axis, color, tip };
        });
        const _gizData = { o, axes: axs };
        cesiumGizmoSVGRef.current = _gizData;
        setCesiumGizmoSVG(_gizData);
      });
      gizmoListenerRef.current = remove;
    }

    // ギズモ軸 entity を廃止（CallbackProperty + disableDepthTestDistance:Infinity → 毎フレーム$V180ms）
    // 代わりに cesiumGizmoSVGRef のスクリーン座標でクリック判定（postRenderが毎フレーム更新）
    v.scene.requestRender();
  }, []);

  const clearGizmo = useCallback(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    gizmoEntitiesRef.current.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
    gizmoEntitiesRef.current = [];
    gizmoTargetRef.current = null;
    cesiumGizmoWorldRef.current = null;
    // lastGizmoOriginRef.current はリセットしない — clearGizmo→drawGizmoAt の再描画ループで消去されるのを防ぐ
    cesiumGizmoSVGRef.current = null;
    setCesiumGizmoSVG(null);
    if (gizmoListenerRef.current) { try { gizmoListenerRef.current(); } catch {} gizmoListenerRef.current = null; }
    v.scene.requestRender();
  }, []);

  // 折れ点にギズモ表示
  const showGizmo = useCallback((segId, wpIndex) => {
    clearGizmo();
    gizmoTargetRef.current = { type: 'wp', segId, wpIndex };
    const wps = segWp[segId] || [];
    const wzs = wpZ[segId] || [];
    const wp = wps[wpIndex]; if (!wp) return;
    drawGizmoAt(wp.x, wp.y, wzs[wpIndex] || 0);
  }, [segWp, wpZ, drawGizmoAt, clearGizmo]);

  // ノードにギズモ表示
  const showNodeGizmo = useCallback((nodeId) => {
    clearGizmo();
    gizmoTargetRef.current = { type: 'node', nodeId };
    const pos = allMapPos[nodeId]; if (!pos) return;
    drawGizmoAt(pos.x, pos.y, pos.z || 0);
  }, [allMapPos, drawGizmoAt, clearGizmo]);

  // showGizmo/showNodeGizmo/clearGizmoをrefで保持
  const gizmoCbRef = useRef({ showGizmo, showNodeGizmo, clearGizmo });
  useEffect(() => { gizmoCbRef.current = { showGizmo, showNodeGizmo, clearGizmo }; });

  // PN変更時: ギズモ表示中ならPickingエンティティを再構築（古いPN方向を使わないように）
  useEffect(() => {
    const data = cesiumGizmoWorldRef.current;
    if (!data) return; // gizmo entity 廃止済み → gizmoEntitiesRef.current.length チェック不要
    clearGizmo();
    drawGizmoAt(data.gridX, data.gridY, data.gridZ);
  }, [plantNorthAngle, clearGizmo, drawGizmoAt]);

  // 折れ点マーカーの描画（バッチ更新）
  const wpColorNormal = useMemo(() => typeof Cesium !== 'undefined' ? Cesium.Color.WHITE : null, []);
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;

    const baseElev = v._siteBaseElevation || 0;
    // 既存entityをkeyで管理してposition直接更新（remove+addはチカチカの原因）
    const existMap = new Map();
    wpMarkerRef.current.forEach(e => { if (e._wpInfo) existMap.set(`${e._wpInfo.segId}-${e._wpInfo.wpIndex}`, e); });
    const nextEntities = [];
    v.entities.suspendEvents();
    segs.forEach(seg => {
      const wps = segWp[seg.id] || [];
      const wzs = wpZ[seg.id] || [];
      wps.forEach((wp, i) => {
        const geo = gridToGeo(wp.x, wp.y);
        const z = baseElev + (wzs[i] || 0);
        const key = `${seg.id}-${i}`;
        const newPos = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, z);
        const existing = existMap.get(key);
        if (existing && v.entities.contains(existing)) {
          // position直接更新（フリッカーなし）
          existing.position.setValue(newPos);
          nextEntities.push(existing);
          existMap.delete(key);
        } else {
          const marker = v.entities.add({
            position: newPos,
            point: { pixelSize: 1, color: Cesium.Color.TRANSPARENT, outlineWidth: 0, disableDepthTestDistance: Number.POSITIVE_INFINITY },
            _wpInfo: { segId: seg.id, wpIndex: i },
          });
          nextEntities.push(marker);
        }
      });
    });
    // 削除されたwpのentityを除去
    existMap.forEach(e => { if (v.entities.contains(e)) v.entities.remove(e); });
    wpMarkerRef.current = nextEntities;
    // O(1)直接アクセス用マップ更新
    const _wmap = new Map();
    nextEntities.forEach(e => { if (e._wpInfo) _wmap.set(`${e._wpInfo.segId}-${e._wpInfo.wpIndex}`, e); });
    wpMarkerMapRef.current = _wmap;
    v.entities.resumeEvents();
    v.scene.requestRender();

    // 選択中のギズモがあれば再描画
    if (gizmoTargetRef.current) {
      const gt = gizmoTargetRef.current;
      if (gt.type === 'wp') {
        const wps = segWp[gt.segId] || [];
        if (wps[gt.wpIndex]) gizmoCbRef.current.showGizmo(gt.segId, gt.wpIndex);
        else gizmoCbRef.current.clearGizmo();
      } else if (gt.type === 'node') {
        if (allMapPos[gt.nodeId]) gizmoCbRef.current.showNodeGizmo(gt.nodeId);
        else gizmoCbRef.current.clearGizmo();
      }
    }
  }, [segWp, wpZ, segs, allMapPos]);

  // 指定高度の水平面とレイの交差点をグリッド座標で返す（斜め視点ドラッグ対応）
  // localZ: アイコン/折れ点のローカルz座標（メートル）→ baseElev + localZ の高度で水平面を定義
  const pickOnHorizontalPlane = useCallback((c2, localZ) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return null;
    const ray = v.camera.getPickRay(c2);
    if (!ray) return null;
    const baseElev = v._siteBaseElevation || 0;
    const worldAlt = baseElev + (localZ || 0);
    // サイト中心点で水平面を定義（小規模エリアの平面近似）
    const refCart = Cesium.Cartesian3.fromDegrees(GEO_ORIGIN.lng, GEO_ORIGIN.lat, worldAlt);
    const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(refCart, new Cesium.Cartesian3());
    const plane = Cesium.Plane.fromPointNormal(refCart, normal);
    const hit = Cesium.IntersectionTests.rayPlane(ray, plane, new Cesium.Cartesian3());
    if (!hit) return null;
    const carto = Cesium.Cartographic.fromCartesian(hit);
    const grid = geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
    return { x: grid.x, y: grid.y };
  }, []);

  // 楕円体ベースのピック（後方互換用: z=0固定ドラッグ等）
  const pickOnEllipsoid = useCallback((c2) => pickOnHorizontalPlane(c2, 0), [pickOnHorizontalPlane]);

  // コールバックをrefで保持（handler再生成を防ぐ）
  const cbRef = useRef({ onAddWp, onMoveWp, onDropWp, onRemoveWp, onMoveNode, onFocusNode, _segWp: segWp, _wpZ: wpZ, _allMapPos: allMapPos, _mapZ: mapZ || {}, setHoverId, setHoverSeg, setWireTip: setWireTip || null, setRouteFilter, routeFilter, _bldSelected: null, _blds: blds, _mode: mode, _hoverSeg: null, _hoverId: null, _sectionOverlays: [], _readyToDrawWire: true });
  useEffect(() => { cbRef.current = { onAddWp, onMoveWp, onDropWp, onRemoveWp, onMoveNode, onFocusNode, onStartDragNode, onEndDragNode, _segWp: segWp, _wpZ: wpZ, _allMapPos: allMapPos, _mapZ: mapZ || {}, _segs: segs, _nodes: nodes, _routeSegs: routeSegs, setHoverId, setHoverSeg, setWireTip: setWireTip || null, setRouteFilter, routeFilter, _bldSelected: cbRef.current._bldSelected, _blds: blds, _mode: mode, _hoverSeg: hoverSeg, _hoverId: hoverId, _ugWireMode: qualitySettings?.ugWireHighlight ?? null, _sectionOverlays: sectionOverlays, _readyToDrawWire: true,
    // 配置済み配電盤のドラッグ用（実体化と判定は App が唯一の実装）
    _placedPanels: placedPanels, onMovePlacedPanel, onRotatePlacedPanel }; });
  useEffect(() => { cbRef.current._bldSelected = bldSelected; }, [bldSelected]);

  const nodeEntitiesRef = useRef({});
  const nodeEntityTimerRef = useRef(null); // ノードエンティティ更新デバウンス用タイマー
  const draggingAxisRef = useRef(null); // { segId, wpIndex, axis:'x'|'y'|'z', startScreen, startX/Y/Z }
  const draggingNodeRef = useRef(null); // { nodeId, startScreen, startZ } — フリードラッグ（axis拘束なし）
  const hoverNodeRef = useRef(null);    // MOUSE_MOVE で更新: 現在ホバー中のノードID
  const [hoverScreenPos, setHoverScreenPos] = useState(null); // アイコンホバー時のcanvas座標 {x,y}（初期表示用）
  const hoverOverlayRef    = useRef(null); // ×/📷 overlay div — postRenderで位置を直接更新（カメラ追従）
  const bldBadgeOverlayRef = useRef(null); // 建屋選択時の📷/× overlay div — postRenderで位置更新
  const [isDraggingIcon, setIsDraggingIcon] = useState(false); // アイコンドラッグ中フラグ（×/📷 overlay非表示用）
  const hoverClearTimerRef = useRef(null); // アイコン→ボタンへ移動中のちらつき防止デバウンスタイマー
  const cameraPanRef = useRef(null);    // 背景ドラッグ時のパン中フラグ { lastX, lastY }
  const orbitRef    = useRef(null);    // 中ボタンドラッグ: カスタムorbit { pivot, initH, initP, range, startX, startY }
  const downPosRef = useRef(null);
  const handlerRef = useRef(null);

  // ハンドラは初期化完了時に1回だけ作成
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !initDoneRef.current) return;
    if (handlerRef.current) return; // 既に作成済み

    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    handlerRef.current = handler;

    // 【止めると戻すは同じ顔ぶれで】以前は rotate/translate/zoom だけを止めており、
    //   Shift+左ドラッグ（このアプリでは rotateEventTypes、Cesium既定では lookEventTypes）が
    //   生き残って「盤も回るがカメラも動く」状態になった。tilt/look まで含めて対称に扱う。
    const disableCamera = () => {
      const c = v.scene.screenSpaceCameraController;
      c.enableRotate = false; c.enableTranslate = false; c.enableZoom = false;
      c.enableTilt = false; c.enableLook = false;
    };
    const restoreCamera = () => {
      v.scene.screenSpaceCameraController.enableTilt = true;
      v.scene.screenSpaceCameraController.enableLook = true;
      v.scene.screenSpaceCameraController.enableRotate = true;
      v.scene.screenSpaceCameraController.enableTranslate = true;
      v.scene.screenSpaceCameraController.enableZoom = true;
    };
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();

    // 左ボタンダウン
    // ★修飾キー付きは Cesium では**別チャンネル**（KeyboardEventModifier）。
    //   `setInputAction(fn, LEFT_DOWN)` だけでは修飾キー押下時に発火せず、既定のカメラ操作が走る。
    //   さらに Cesium が渡すイベントは {position} だけで **shiftKey/ctrlKey を持たない**ので、
    //   修飾キーの有無は「どちらのチャンネルで発火したか」で判断する（引数で渡す）。
    // ★盤の回転に **Ctrl** を使う理由（2026-09-01）:
    //   Shift+左ドラッグは **この画面のカメラ水平回転に既に割り当て済み**（rotateEventTypes）。
    //   さらに Cesium 既定の lookEventTypes も Shift+左なので二重に競合し、
    //   「盤も回るがカメラも動く」状態になった。Ctrl は未使用なので衝突しない。
    const _onLeftDown = (e, rotModifier) => {
      downPosRef.current = { x: e.position.x, y: e.position.y };
      // ══ 配置済み配電盤のドラッグ開始（2026-08-31）══
      // 【ここに置く理由】専用ハンドラを別に立てると、こちらの背景パン(cameraPanRef)が
      //   同時に走って盤とカメラが一緒に動く。ノード・ギズモと同じこの入口で捌く。
      // 【判定と実体化はAppが持つ】ここは「画面のどこを掴んだか」を世界座標にするだけ。
      //   盤のスキーマ（wx,wyが角／rotが絶対角）はこちらに持ち込まない。
      {
        const _cbD = cbRef.current;
        const _picked = v.scene.pick(e.position);
        const _ppId = _picked && _picked.id && _picked.id._placedPanelId;
        if (_ppId && (_cbD.onMovePlacedPanel || _cbD.onRotatePlacedPanel)) {
          const _pp = (_cbD._placedPanels || []).find(p => p.id === _ppId);
          if (_pp) {
            const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
            // 掴んだ点は盤の据付高さの水平面で拾う（地面で拾うと高い盤ほどズレる）
            const _g0 = pickOnHorizontalPlane(e.position, (_pp.wz || 0) * _mpp);
            if (_g0) {
              // 回転中心は盤の角(wx,wy)ではなく回転中心。求め方は panelPlacementCore が唯一の実装
              const _piv = (typeof ppcPivot === 'function') ? ppcPivot(_pp) : { pivWx: _pp.wx, pivWy: _pp.wy };
              panelDragRef.current = {
                id: _ppId, mode: rotModifier ? 'rot' : 'move',
                startWx: _pp.wx, startWy: _pp.wy, startRot: _pp.rot || 0,
                pivX: _piv.pivWx, pivY: _piv.pivWy,
                g0x: _g0.x, g0y: _g0.y, zM: (_pp.wz || 0) * _mpp,
                startScreen: { x: e.position.x, y: e.position.y }, moved: false,
              };
              disableCamera();
              grabOn();
              return;   // 背景パンを開始させない
            }
          }
        }
      }
      // ホバー中ノードがあれば即カメラ無効化（drillPickより先）
      if (hoverNodeRef.current) disableCamera();
      // ギズモ軸ヒット: cesiumGizmoSVGRefのスクリーン座標で判定（gizmo entity 廃止済み）
      let hitAxis = null; // 文字列 'x'|'y'|'z'
      const _gizLD = cesiumGizmoSVGRef.current;
      if (_gizLD) {
        const { o: _gO, axes: _gAxs } = _gizLD;
        for (const ax of _gAxs) {
          if (!ax.tip) continue;
          const _adx = ax.tip.x - _gO.x, _ady = ax.tip.y - _gO.y;
          const _al2 = _adx*_adx + _ady*_ady;
          if (_al2 < 0.01) continue;
          const _at = Math.max(0, Math.min(1, ((e.position.x-_gO.x)*_adx + (e.position.y-_gO.y)*_ady)/_al2));
          const _apx = _gO.x+_at*_adx-e.position.x, _apy = _gO.y+_at*_ady-e.position.y;
          if (Math.sqrt(_apx*_apx+_apy*_apy) < 14) { hitAxis = ax.axis; break; }
        }
      }

      // ノードアイコン優先: hoverNodeRef（MOUSE_MOVEのスクリーン座標判定済み）から取得
      const _hoverNid = hoverNodeRef.current;
      let hitNodeId = null;
      if (_hoverNid) {
        const _ic = _lastIconScreenRef.current.get(_hoverNid);
        if (_ic) {
          const _hw = _ic.w / 2 + 8;
          if (e.position.x >= _ic.x - _hw && e.position.x <= _ic.x + _hw &&
              e.position.y >= _ic.y - _ic.h - 8 && e.position.y <= _ic.y + 8) {
            hitNodeId = _hoverNid;
          }
        }
      }

      // フリードラッグ開始（axis拘束なし）
      if (hitNodeId) {
        const pos = cbRef.current._allMapPos ? cbRef.current._allMapPos[hitNodeId] : null;
        if (pos) {
          // グラブオフセット: カーソルとアイコン中心のワールド座標差（瞬間移動防止）
          const _grabPick = pickOnHorizontalPlane(e.position, pos.z || 0);
          const _grabOffX = _grabPick ? (pos.x - _grabPick.x) : 0;
          const _grabOffY = _grabPick ? (pos.y - _grabPick.y) : 0;
          draggingNodeRef.current = { nodeId: hitNodeId, startScreen: { x: e.position.x, y: e.position.y }, startZ: pos.z || 0, grabOffX: _grabOffX, grabOffY: _grabOffY, lastPos: null };
          // ドラッグ開始をApp.jsxに通知（命令型キャッシュ構築用）
          cbRef.current.onStartDragNode?.(hitNodeId, { x: pos.x, y: pos.y, z: pos.z || 0 });
          setIsDraggingIcon(true);
          disableCamera();
          grabOn();
        }
        return;
      }

      // 背景クリック → 自前パン開始
      if (!hitAxis) cameraPanRef.current = { lastX: e.position.x, lastY: e.position.y };

      // ギズモ軸ハンドルをクリック → 軸拘束ドラッグ開始（ノード・折れ点共通）
      if (hitAxis) {
        const gt = gizmoTargetRef.current;
        if (gt) {
          let startX, startY, startZ;
          if (gt.type === 'wp') {
            const wps = cbRef.current._segWp ? cbRef.current._segWp[gt.segId] : [];
            const wzs = cbRef.current._wpZ ? cbRef.current._wpZ[gt.segId] : [];
            const wp = (wps || [])[gt.wpIndex];
            if (!wp) return;
            startX = wp.x; startY = wp.y; startZ = (wzs || [])[gt.wpIndex] || 0;
          } else if (gt.type === 'node') {
            const pos = cbRef.current._allMapPos[gt.nodeId];
            if (!pos) return;
            startX = pos.x; startY = pos.y; startZ = pos.z || 0;
          }
          // つかんだ位置を記録（軸投影計算の基点: カーソル位置スナップ防止）
          const grabAxis = hitAxis; // gizmo entity廃止 → hitAxisが直接軸文字列
          let grabPickX = startX, grabPickY = startY;
          if (grabAxis !== 'z') {
            const grabPick = pickOnHorizontalPlane(e.position, startZ);
            if (grabPick) { grabPickX = grabPick.x; grabPickY = grabPick.y; }
          }
          draggingAxisRef.current = {
            ...gt,
            axis: grabAxis,
            startScreen: { x: e.position.x, y: e.position.y },
            startX, startY, startZ,
            grabPickX, grabPickY,
          };
          disableCamera();
        }
        return;
      }
    };
    // 修飾なしと Ctrl の両方へ登録する（修飾キーは別チャンネルなので登録漏れが起きやすい）
    handler.setInputAction((e) => _onLeftDown(e, false), Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((e) => _onLeftDown(e, true), Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.CTRL);

    // 中ボタンダウン: orbit開始（lookAt不使用 → 画面中央スナップなし）
    handler.setInputAction((click) => {
      let pivot = null;
      // pickPositionを試みる（3Dタイル建物の表面を取得できる）
      // ただし結果がカメラの5倍高度以上離れている場合は無効（大気層の偽ヒット対策）
      const _pp = v.scene.pickPosition(click.position);
      if (_pp) {
        const _camDist = Cesium.Cartesian3.distance(v.camera.positionWC, _pp);
        const _altM = Math.max(100, v.camera.positionCartographic.height);
        if (_camDist < _altM * 5) pivot = _pp;
      }
      if (!pivot) {
        const _ray = v.camera.getPickRay(click.position);
        pivot = v.scene.globe.pick(_ray, v.scene);
      }
      if (!pivot) return;
      orbitRef.current = { pivot, lastX: click.position.x, lastY: click.position.y };
    }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN);

    // マウス移動 — グローバルhover + 軸ドラッグ
    const _onMouseMove = (e) => {
      // ══ 配置済み配電盤のドラッグ中（2026-08-31）══
      // 移動は「掴んだ点からの差分」を盤の開始位置に足す（掴んだ場所が保たれる）。
      // Shift+ドラッグは回転。角度は盤の中心まわりのカーソル角の差分で決める。
      if (panelDragRef.current) {
        const pd = panelDragRef.current;
        const _cbM = cbRef.current;
        const _sx = e.endPosition.x, _sy = e.endPosition.y;
        if (!pd.moved) {
          const _dx = _sx - pd.startScreen.x, _dy = _sy - pd.startScreen.y;
          if (_dx * _dx + _dy * _dy < 25) return;   // 5px未満はまだクリック候補（選択を邪魔しない）
          pd.moved = true;
        }
        const g = pickOnHorizontalPlane(new Cesium.Cartesian2(_sx, _sy), pd.zM);
        if (!g || !isFinite(g.x) || !isFinite(g.y)) return;   // 汚染ガード
        if (pd.mode === 'rot') {
          if (_cbM.onRotatePlacedPanel) {
            // 盤の回転中心まわりのカーソル角の差分。中心は掴んだ時点で固定する
            const a0 = Math.atan2(pd.g0y - pd.pivY, pd.g0x - pd.pivX);
            const a1 = Math.atan2(g.y - pd.pivY, g.x - pd.pivX);
            _cbM.onRotatePlacedPanel(pd.id, pd.startRot + (a1 - a0));
          }
        } else if (_cbM.onMovePlacedPanel) {
          _cbM.onMovePlacedPanel(pd.id, pd.startWx + (g.x - pd.g0x), pd.startWy + (g.y - pd.g0y));
        }
        v.scene.requestRender();
        return;
      }
      // 中ボタンドラッグ: Quaternion orbit（lookAt不使用 → スナップなし、roll漂流なし）
      if (orbitRef.current) {
        const or = orbitRef.current;
        const ddx = e.endPosition.x - or.lastX;
        const ddy = e.endPosition.y - or.lastY;
        or.lastX = e.endPosition.x;
        or.lastY = e.endPosition.y;

        // pivot中心にaxis軸でangle回転（position/direction/up/rightを全更新）
        const _rotAround = (axis, angle) => {
          const _q   = Cesium.Quaternion.fromAxisAngle(axis, angle);
          const _rot = Cesium.Matrix3.fromQuaternion(_q, new Cesium.Matrix3());
          const _rel = Cesium.Cartesian3.subtract(v.camera.position, or.pivot, new Cesium.Cartesian3());
          v.camera.position  = Cesium.Cartesian3.add(or.pivot, Cesium.Matrix3.multiplyByVector(_rot, _rel, new Cesium.Cartesian3()), new Cesium.Cartesian3());
          v.camera.direction = Cesium.Matrix3.multiplyByVector(_rot, v.camera.direction, new Cesium.Cartesian3());
          v.camera.up        = Cesium.Matrix3.multiplyByVector(_rot, v.camera.up, new Cesium.Cartesian3());
          v.camera.right     = Cesium.Matrix3.multiplyByVector(_rot, v.camera.right, new Cesium.Cartesian3());
        };

        // 水平回転: pivot上のworld up軸まわり
        const _pivotUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(or.pivot, new Cesium.Cartesian3());
        _rotAround(_pivotUp, -ddx * 0.01);

        // 垂直回転: worldUp×directionの水平軸まわり（roll漂流ゼロ）
        // 真下向き（2Dビュー等）でdirectionとworldUpが反平行になり外積≈0 → cam.rightにフォールバック
        const _camUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(v.camera.positionWC, new Cesium.Cartesian3());
        const _hR = Cesium.Cartesian3.cross(_camUp, v.camera.direction, new Cesium.Cartesian3());
        const _tiltAxis = Cesium.Cartesian3.magnitude(_hR) > 0.01
          ? Cesium.Cartesian3.normalize(_hR, _hR)
          : v.camera.right; // 真下向き時はcam.rightを傾き軸として使う
        // ══ pitch制限（2026-08-31 全面改修）══
        // 【直した不具合】面ダブルクリックで視点が飛んだあと、中ボタンの縦回転が効かなくなる。
        // 旧実装は「窓の外へ出る操作を**棄却**する」だった:
        //     const _pitchAfter = v.camera.pitch + ddy * 0.007;
        //     if (!(_pitchAfter > -0.05 || _pitchAfter < -1.55)) { _rotAround(...); }
        //   飛び先が窓の外（側面=0 / 上面≈-1.55近傍）だと、1イベントの ddy は数px＝0.007rad程度
        //   しかないので **窓の中まで届かず毎回棄却**され、縦回転が永久に死ぬ。
        //   水平回転（上の _rotAround）は無条件なので生き残り、「片方向にしか回らない」になる。
        // 【新実装】棄却ではなく「**悪化したら取り消す**」。
        //   窓の外から始まっても、窓へ近づく操作は必ず通るので自力で復帰できる。
        //   さらに予測（pitch + ddy*0.007）ではなく**回してから実測**するので、
        //   回転角と pitch の符号の対応を仮定しない（仮定すると逆向きのとき両方向とも死ぬ）。
        const _pitchOut = (p) => Math.max(0, CM_PITCH_MIN - p, p - CM_PITCH_MAX); // 窓外へのはみ出し量
        const _pitchBefore = v.camera.pitch;
        const _tiltAng = ddy * 0.007;
        _rotAround(_tiltAxis, _tiltAng);
        if (_pitchOut(v.camera.pitch) > _pitchOut(_pitchBefore) + 1e-9) {
          _rotAround(_tiltAxis, -_tiltAng);   // はみ出しが増えたので取り消す
        }

        v.scene.requestRender();
        return;
      }

      // 背景左ドラッグ: 高度ベースの水平平行移動（回転なし）
      if (cameraPanRef.current && !draggingNodeRef.current && !draggingAxisRef.current) {
        const cp = cameraPanRef.current;
        const dx = e.endPosition.x - cp.lastX;
        const dy = e.endPosition.y - cp.lastY;
        cp.lastX = e.endPosition.x;
        cp.lastY = e.endPosition.y;
        const cam = v.camera;
        const height = cam.positionCartographic?.height ?? 1000;
        const ch = v.scene.canvas.clientHeight || 1;
        const fov = cam.frustum?.fov ?? Cesium.Math.toRadians(60);
        const scale = 2 * height * Math.tan(fov / 2) / ch;
        // カメラ右方向を水平面に投影
        const localUp = Cesium.Cartesian3.normalize(cam.positionWC, new Cesium.Cartesian3());
        const right = Cesium.Cartesian3.clone(cam.right);
        Cesium.Cartesian3.subtract(right, Cesium.Cartesian3.multiplyByScalar(localUp, Cesium.Cartesian3.dot(right, localUp), new Cesium.Cartesian3()), right);
        Cesium.Cartesian3.normalize(right, right);
        // カメラ前方向を水平面に投影
        // pitch≒-90°（真上から見下ろし）時はdirectionの水平成分がほぼ0になるため
        // cam.up（スクリーン上方向）を代わりに使う
        const fwd = Cesium.Cartesian3.clone(cam.direction);
        Cesium.Cartesian3.subtract(fwd, Cesium.Cartesian3.multiplyByScalar(localUp, Cesium.Cartesian3.dot(fwd, localUp), new Cesium.Cartesian3()), fwd);
        if (Cesium.Cartesian3.magnitude(fwd) < 0.3) {
          Cesium.Cartesian3.clone(cam.up, fwd);
          Cesium.Cartesian3.subtract(fwd, Cesium.Cartesian3.multiplyByScalar(localUp, Cesium.Cartesian3.dot(fwd, localUp), new Cesium.Cartesian3()), fwd);
        }
        Cesium.Cartesian3.normalize(fwd, fwd);
        cam.move(right, -dx * scale);
        cam.move(fwd, dy * scale);
        return;
      }

      // ノードフリードラッグ（axis拘束なし、XY平面移動）
      const dn = draggingNodeRef.current;
      if (dn) {
        // アイコンの実際の高度平面でピック（斜め視点でもカーソルと一致）
        const pos = pickOnHorizontalPlane(e.endPosition, dn.startZ);
        if (pos) {
          // グラブオフセットを加算してカーソルとアイコンのズレを維持
          const newPos = { x: pos.x + (dn.grabOffX || 0), y: pos.y + (dn.grabOffY || 0), z: dn.startZ };
          dn.lastPos = newPos; // mouseUp時の最終位置確定用
          cbRef.current.onMoveNode(dn.nodeId, newPos);
        }
        // ×・カメラマークをカーソルに追従させる
        setHoverScreenPos({ x: e.endPosition.x, y: e.endPosition.y });
        return;
      }

      const da = draggingAxisRef.current;

      // ドラッグ中 → 軸拘束移動（ノード・折れ点共通）
      if (da) {
        let newX = da.startX, newY = da.startY, newZ = da.startZ;
        if (da.axis === 'z') {
          const screenDY = e.endPosition.y - da.startScreen.y;
          newZ = da.startZ + (-screenDY * 0.5);
        } else {
          // ギズモ軸ドラッグ: PN軸方向に投影して移動（PN変更後も正しい方向）
          const pos = pickOnHorizontalPlane(e.endPosition, da.startZ);
          if (pos) {
            const _pnR = (plantNorthAngleRef.current || 0) * Math.PI / 180;
            // x軸: (cos pnR, sin pnR)、y軸: (sin pnR, -cos pnR)
            const axNx = da.axis === 'x' ? Math.cos(_pnR) : Math.sin(_pnR);
            const axNy = da.axis === 'x' ? Math.sin(_pnR) : -Math.cos(_pnR);
            const dx = pos.x - da.grabPickX;
            const dy = pos.y - da.grabPickY;
            const proj = dx * axNx + dy * axNy;
            newX = da.startX + proj * axNx;
            newY = da.startY + proj * axNy;
          }
        }
        const cb = cbRef.current;
        if (da.type === 'wp' && cb.onMoveWp) {
          cb.onMoveWp(da.segId, da.wpIndex, { x: newX, y: newY, z: newZ });
        } else if (da.type === 'node' && cb.onMoveNode) {
          cb.onMoveNode(da.nodeId, { x: newX, y: newY, z: newZ });
        }
        return;
      }

      // カメラ移動中はhover検出をスキップ
      if (_cameraMovingRef.current) return;

      // ホバー検出: scene.pick() 不使用（billboard/wire entity 除去済み → GPU pick buffer 廃止）
      // アイコン・ワイヤーともにスクリーン座標距離で判定
      const cb = cbRef.current;
      const bcrect = containerRef.current?.getBoundingClientRect();
      const clientX = bcrect ? bcrect.left + e.endPosition.x : e.endPosition.x;
      const clientY = bcrect ? bcrect.top + e.endPosition.y : e.endPosition.y;
      const mx = e.endPosition.x, my = e.endPosition.y;

      // アイコンhover: _lastIconScreenRef の矩形（BOTTOM origin → y は上端 ic.y-ic.h ～ ic.y）
      let hitNodeId = null;
      for (const [nid, ic] of _lastIconScreenRef.current) {
        const hw = ic.w / 2 + 4;
        if (mx >= ic.x - hw && mx <= ic.x + hw && my >= ic.y - ic.h - 4 && my <= ic.y + 4) {
          hitNodeId = nid; break;
        }
      }

      if (hitNodeId) {
        clearTimeout(hoverClearTimerRef.current);
        hoverNodeRef.current = hitNodeId;
        if (cb.setHoverId) cb.setHoverId(hitNodeId);
        const _ic = _lastIconScreenRef.current.get(hitNodeId);
        setHoverScreenPos(_ic ? { x: _ic.x, y: _ic.y } : { x: mx, y: my });
        if (cb.setHoverSeg) cb.setHoverSeg(null);
        if (cb.setWireTip) cb.setWireTip(null);
      } else {
        // ワイヤーhover: _lastWirePathsRef のセグメントに対するスクリーン座標距離
        let minDist = 8, hitSegId = null;
        for (const w of (_lastWirePathsRef.current || [])) {
          for (const s of w.segs) {
            const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
            const len2 = dx * dx + dy * dy;
            if (len2 < 0.01) continue;
            const t = Math.max(0, Math.min(1, ((mx - s.x1) * dx + (my - s.y1) * dy) / len2));
            const px = s.x1 + t * dx - mx, py = s.y1 + t * dy - my;
            const d = Math.sqrt(px * px + py * py);
            if (d < minDist) { minDist = d; hitSegId = w.id; }
          }
        }
        if (hitSegId) {
          clearTimeout(hoverClearTimerRef.current);
          if (cb.setHoverSeg) cb.setHoverSeg(hitSegId);
          if (cb.setHoverId) cb.setHoverId(null);
          setHoverScreenPos(null);
          if (cb.setWireTip) {
            const seg = cb._segs?.find(s => s.id === hitSegId);
            if (seg && cb._allMapPos) {
              const aP = cb._allMapPos[seg.from], bP = cb._allMapPos[seg.to];
              if (aP && bP) {
                const mpp = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
                const wps = (cb._segWp || {})[hitSegId] || [], wzs = (cb._wpZ || {})[hitSegId] || [];
                const _mz = cb._mapZ || {};
                const pts3d = [[aP.x,aP.y,_mz[seg.from]||0],...wps.map((wp,k)=>[wp.x,wp.y,wzs[k]||0]),[bP.x,bP.y,_mz[seg.to]||0]];
                let dist = 0;
                for (let k = 0; k < pts3d.length - 1; k++) { const dx=(pts3d[k+1][0]-pts3d[k][0])*mpp,dy=(pts3d[k+1][1]-pts3d[k][1])*mpp,dz=pts3d[k+1][2]-pts3d[k][2]; dist+=Math.sqrt(dx*dx+dy*dy+dz*dz); }
                cb.setWireTip({ x: clientX, y: clientY, dist });
              } else { cb.setWireTip(null); }
            } else { cb.setWireTip(null); }
          }
        } else {
          // アイコン→ボタン移動中のちらつき防止: 250ms後クリア
          clearTimeout(hoverClearTimerRef.current);
          hoverClearTimerRef.current = setTimeout(() => {
            hoverNodeRef.current = null;
            const _cb = cbRef.current;
            if (_cb.setHoverId) _cb.setHoverId(null);
            setHoverScreenPos(null);
          }, 250);
          if (cb.setHoverSeg) cb.setHoverSeg(null);
          if (cb.setWireTip) cb.setWireTip(null);
        }
      }
    };
    // Ctrl を押したままドラッグすると move/up も CTRL チャンネルへ流れる。両方に登録する
    handler.setInputAction(_onMouseMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(_onMouseMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      Cesium.KeyboardEventModifier.CTRL);

    // 中ボタン離す: orbit終了
    handler.setInputAction(() => {
      orbitRef.current = null;
      v.scene.requestRender();
    }, Cesium.ScreenSpaceEventType.MIDDLE_UP);

    // 左ボタン離す
    const _onLeftUp = (e) => {
      // ══ ボタンを離したらカメラ操作は必ず通常に戻す（2026-08-31）══
      // 【直した穴】LEFT_DOWN の disableCamera() は「ノードにホバーしていれば無条件」で走るのに、
      //   復帰は「実際にドラッグが始まったとき」だけだった。
      //   途中には `if (!wp) return;` / `if (!pos) return;` や背景パス（cameraPanRef を置いて抜ける）
      //   など**復帰を通らない離脱経路**が複数あり、enableRotate/Translate/Zoom が false のまま残る。
      //   enableTilt は触らないので中ボタンだけ生き残り「片方向にしか回らない」状態になっていた。
      //   ＝ 無効化が無条件なら、復帰も無条件でなければ釣り合わない。
      // 【方位キューブは別経路】あれはDOMオーバーレイなので canvas の LEFT_UP は飛ばない。
      //   ここで戻しても、キューブのドラッグ中の抑止は壊さない。
      restoreCamera();
      // 配置済み配電盤のドラッグ完了
      if (panelDragRef.current) {
        const pd = panelDragRef.current;
        panelDragRef.current = null;
        // 動かした直後の LEFT_CLICK では選択解除しない（掴み直せなくなるため）
        panelDragMovedRef.current = !!pd.moved;
        grabOff();
        // ドラッグ中は作り直しを止めていたので、離した時点で一度作り直させる。
        // 選択の強調色などはエフェクト側で決まるため、ここで反映させないと古い見た目が残る
        setPanelRebuildTick(t => t + 1);
        // 動かしていなければクリック扱い。選択は LEFT_CLICK 側の実装に任せる（二重管理しない）
        downPosRef.current = null;
        return;
      }
      // ノードフリードラッグ完了
      if (draggingNodeRef.current) {
        const dn = draggingNodeRef.current;
        draggingNodeRef.current = null;
        // ドラッグ終了をApp.jsxに通知（最終位置確定 + setMapPos）
        cbRef.current.onEndDragNode?.(dn.nodeId, dn.lastPos);
        setIsDraggingIcon(false);
        restoreCamera();
        grabOff();
        // ドラッグ後にホバー状態をリセット（古い座標のoverlay buttonがwheelを横取りするのを防ぐ）
        hoverNodeRef.current = null;
        setHoverScreenPos(null);
        cbRef.current.setHoverId?.(null);
        // 移動量が小さければクリック扱い → ギズモ表示
        if (downPosRef.current) {
          const dx = e.position.x - downPosRef.current.x, dy = e.position.y - downPosRef.current.y;
          if (Math.abs(dx) < 5 && Math.abs(dy) < 5) gizmoCbRef.current.showNodeGizmo(dn.nodeId);
        }
        downPosRef.current = null;
        return;
      }

      cameraPanRef.current = null;

      if (draggingAxisRef.current) {
        // 軸ドラッグ完了
        draggingAxisRef.current = null;
        restoreCamera();
        return;
      }

      if (downPosRef.current) {
        const dx = e.position.x - downPosRef.current.x;
        const dy = e.position.y - downPosRef.current.y;
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
          // クリック判定 — gizmoはスクリーン座標、WPはdrillPick、ノードはhoverNodeRef
          // ギズモ軸ヒット: スクリーン座標判定（gizmo entity 廃止済み → drillPickコスト不要）
          let hitGizmo = false;
          const _gizLU = cesiumGizmoSVGRef.current;
          if (_gizLU) {
            const { o: _luO, axes: _luAxs } = _gizLU;
            for (const ax of _luAxs) {
              if (!ax.tip) continue;
              const _udx = ax.tip.x - _luO.x, _udy = ax.tip.y - _luO.y;
              const _ul2 = _udx*_udx + _udy*_udy;
              if (_ul2 < 0.01) continue;
              const _ut = Math.max(0, Math.min(1, ((e.position.x-_luO.x)*_udx + (e.position.y-_luO.y)*_udy)/_ul2));
              const _upx = _luO.x+_ut*_udx-e.position.x, _upy = _luO.y+_ut*_udy-e.position.y;
              if (Math.sqrt(_upx*_upx+_upy*_upy) < 14) { hitGizmo = true; break; }
            }
          }
          // 折れ点ヒット: entity.point._wpInfo（WP markerが show:true の場合のみ pickable）
          let hitWp = null;
          if (!hitGizmo) {
            const _wpPicks = v.scene.drillPick(e.position, 5);
            for (const p of _wpPicks) { const ent = p && p.id; if (ent?._wpInfo && !hitWp) hitWp = ent; }
          }
          // ノードクリック: MOUSE_MOVEで設定した hoverNodeRef + bounds 確認
          const _hoverNidUp = hoverNodeRef.current;
          let hitNodeId = null;
          if (_hoverNidUp) {
            const _icUp = _lastIconScreenRef.current.get(_hoverNidUp);
            if (_icUp) {
              const _hwUp = _icUp.w / 2 + 8;
              if (e.position.x >= _icUp.x - _hwUp && e.position.x <= _icUp.x + _hwUp &&
                  e.position.y >= _icUp.y - _icUp.h - 8 && e.position.y <= _icUp.y + 8) {
                hitNodeId = _hoverNidUp;
              }
            }
          }

          // 優先順位: ギズモ > 折れ点 > ノード > 背景
          if (hitGizmo) {
            // nothing
          } else if (hitWp) {
            gizmoCbRef.current.showGizmo(hitWp._wpInfo.segId, hitWp._wpInfo.wpIndex);
          } else if (hitNodeId) {
            gizmoCbRef.current.showNodeGizmo(hitNodeId);
          } else {
            gizmoCbRef.current.clearGizmo();
          }
        }
      }
      // hoverNodeRef経由の先行disableCamera解除（ノードドラッグ以外でクリックした場合も必ず復元）
      restoreCamera();
      downPosRef.current = null;
    };
    handler.setInputAction(_onLeftUp, Cesium.ScreenSpaceEventType.LEFT_UP);
    handler.setInputAction(_onLeftUp, Cesium.ScreenSpaceEventType.LEFT_UP,
      Cesium.KeyboardEventModifier.CTRL);

    // 右クリック: 折れ点削除 or ルートフィルタ切替
    handler.setInputAction((e) => {
      // ギズモ軸右クリック: スクリーン座標判定（gizmo entity 廃止済み）
      const _gizRC = cesiumGizmoSVGRef.current;
      let _hitGizAxis = false;
      if (_gizRC) {
        const { o: _rcO, axes: _rcAxs } = _gizRC;
        for (const ax of _rcAxs) {
          if (!ax.tip) continue;
          const _rdx = ax.tip.x - _rcO.x, _rdy = ax.tip.y - _rcO.y;
          const _rl2 = _rdx*_rdx + _rdy*_rdy;
          if (_rl2 < 0.01) continue;
          const _rt = Math.max(0, Math.min(1, ((e.position.x-_rcO.x)*_rdx + (e.position.y-_rcO.y)*_rdy)/_rl2));
          const _rpx = _rcO.x+_rt*_rdx-e.position.x, _rpy = _rcO.y+_rt*_rdy-e.position.y;
          if (Math.sqrt(_rpx*_rpx+_rpy*_rpy) < 14) { _hitGizAxis = true; break; }
        }
      }
      // WP entity pick（show:trueの時のみpickable）
      const picked = v.scene.pick(e.position);
      const ent = picked && picked.id;

      // ギズモ上で右クリック → 選択中の折れ点を削除
      if (_hitGizAxis) {
        const gt = gizmoTargetRef.current;
        if (gt && gt.type === 'wp' && cbRef.current.onRemoveWp) {
          gizmoCbRef.current.clearGizmo();
          cbRef.current.onRemoveWp(gt.segId, gt.wpIndex);
        }
        return;
      }

      if (ent && ent._wpInfo && cbRef.current.onRemoveWp) {
        // 折れ点 → 削除
        gizmoCbRef.current.clearGizmo();
        cbRef.current.onRemoveWp(ent._wpInfo.segId, ent._wpInfo.wpIndex);
      } else {
        // ノードhover中 → ルートフィルタ切替（billboard entity 除去済み → hoverNodeRef で判定）
        const nodeId = hoverNodeRef.current;
        if (nodeId && cbRef.current.setRouteFilter) {
          cbRef.current.setRouteFilter(prev => prev === nodeId ? null : nodeId);
        } else if (cbRef.current.routeFilter) {
          // 背景右クリック → フィルタ解除
          cbRef.current.setRouteFilter(null);
        }
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    // Cesiumのデフォルト双クリック（ズームイン）を無効化
    v.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // ダブルクリック: 選択中の面に垂直な視点へ flyTo
    // 視点の計算は cmFaceFlyTarget が唯一の実装（DOM側の onDoubleClick と同じものを使う）。
    // ここに式をコピーし直さないこと。2026-08-31までコピーが2つあり、
    // 真上視点で中ボタンが効かなくなる不具合が両方に入っていた。
    handler.setInputAction(() => {
      const sel = cbRef.current._bldSelected;
      if (!sel) return;
      const blk = (cbRef.current._blds || [])[sel.entIdx];
      if (!blk) return;
      cmFlyToFace(v, blk, sel, v._siteBaseElevation || 0);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    return () => { handler.destroy(); handlerRef.current = null; };
  }, [initDoneRef.current, pickOnEllipsoid]);

  // ===== 床スラブ描画（建物内部 Phase A・buildingCore.js）=====
  // 床は solid.faces に混ぜない（_rebuildAllWalls が非wall面を外周壁生成の
  // 入力に使うため、混ぜると余計な壁が生える）。
  // buildings(floors) から bcFloorSlabGeoms で毎回導出して独立エンティティで描く。
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    (v._floorEntities || []).forEach(e => { if (e && v.entities.contains(e)) v.entities.remove(e); });
    v._floorEntities = [];
    const baseElev = v._siteBaseElevation || sharedBaseElev || 0;
    // 押し出しボックスを1つ追加する共通ヘルパー（床・仕切り・扉・部屋で共用）
    const addBox = (pts, zB, zT, material, outlineColor, info) => {
      if (!pts || pts.length < 3) return;
      const flat = pts.flatMap(p => { const geo = gridToGeo(p.x, p.y); return [geo.lng, geo.lat]; });
      const ent = v.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
          height: baseElev + zB,
          extrudedHeight: baseElev + zT,
          material,
          outline: !!outlineColor,
          ...(outlineColor ? { outlineColor } : {}),
        },
        ...info,
      });
      v._floorEntities.push(ent);
    };
    (buildingsFull || []).forEach(bld => {
      if (!bld.floors || bld.floors.length === 0) return;
      // 床スラブ
      bcFloorSlabGeoms(bld).forEach(g => {
        g.polys.forEach(poly => {
          addBox(poly.points, poly.zBottom, poly.zTop,
            Cesium.Color.fromCssColorString('#8B9AAB').withAlpha(0.9),
            Cesium.Color.fromCssColorString('#4B5563'),
            { _floorInfo: { buildingId: bld.id, floorId: g.floorId } });
        });
      });
      // 仕切り（壁=不透明・透明仕切り=見た目だけ透明。機能は同一: spec 7.2）
      // ＋扉（壁面上の色分け矩形）＋部屋オーバーレイ（認識結果の可視化）
      for (const floor of bld.floors) {
        bcPartitionGeoms(bld, floor).forEach(g => {
          const isClear = g.part.kind === 'clear';
          addBox(g.poly, g.zB, g.zT,
            Cesium.Color.fromCssColorString(g.part.color || (isClear ? '#7DD3FC' : '#C8CFDA')).withAlpha(isClear ? 0.15 : 0.95),
            Cesium.Color.fromCssColorString(isClear ? '#38BDF8' : '#6B7280'),
            { _partitionInfo: { buildingId: bld.id, floorId: floor.id, partId: g.part.id } });
        });
        bcDoorGeoms(bld, floor).forEach(g => {
          addBox(g.poly, g.zB, g.zT,
            Cesium.Color.fromCssColorString('#B45309').withAlpha(0.9),
            Cesium.Color.fromCssColorString('#78350F'),
            { _doorInfo: { buildingId: bld.id, floorId: floor.id, doorId: g.door.id } });
        });
        // 部屋: 仕切りが1枚以上ある階だけ描く（仕切りゼロで全床が1部屋色に塗られるのを避ける）
        if ((floor.partitions || []).length > 0) {
          bcDeriveRooms(bld, floor, plantNorthAngle).forEach(room => {
            room.cells.forEach(c => {
              addBox(
                c.corners, // PN回転後は軸平行でないため4隅頂点をそのまま使う
                floor.levelZ + 0.03, floor.levelZ + 0.06,
                Cesium.Color.fromCssColorString(room.color).withAlpha(0.35),
                null,
                { _roomInfo: { buildingId: bld.id, floorId: floor.id, roomKey: room.key } });
            });
          });
        }
      }
    });
    v.scene.requestRender();
  }, [buildingsFull, mode, localBaseElev, sharedBaseElev]);

  // ===== 壁追加モード（建物内部 Phase B）=====
  // 床上を2点クリック → 軸平行スナップして仕切りを作成。右クリックで終了。
  // クリック→グリッド座標変換は建屋追加モードと同じレイ・平面交点方式
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed() || !wallAddMode) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const pickGrid = (pos) => {
      const ray = v.camera.getPickRay(pos);
      if (!ray) return null;
      const baseElev = v._siteBaseElevation || 0;
      // クリック平面は対象階の床標高に置く（床の上をなぞって引けるように）
      const bld = (buildingsFull || []).find(b => b.id === wallAddMode.buildingId);
      const floor = bld && (bld.floors || []).find(f => f.id === wallAddMode.floorId);
      const planeZ = baseElev + (floor ? floor.levelZ : 0);
      const _cg = gridToGeo(TW / 2, TH / 2);
      const _cc = Cesium.Cartesian3.fromDegrees(_cg.lng, _cg.lat, planeZ);
      const _n = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(_cc);
      const _plane = Cesium.Plane.fromPointNormal(_cc, _n);
      const _hit = Cesium.IntersectionTests.rayPlane(ray, _plane);
      if (!_hit) return null;
      const c = Cesium.Cartographic.fromCartesian(_hit);
      const g = geoToGrid(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude));
      return { x: g.x, y: g.y };
    };
    handler.setInputAction((click) => {
      const wm = wallAddModeRef.current;
      if (!wm) return;
      const p = pickGrid(click.position);
      if (!p) return;
      if (wm.pts.length === 0) {
        setWallAddMode({ ...wm, pts: [p] });
      } else {
        const a = wm.pts[0];
        // 軸平行スナップ: 大きい変位の軸に沿わせる
        const b = Math.abs(p.x - a.x) >= Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y };
        const err = onAddPartition ? onAddPartition(wm.buildingId, wm.floorId, a, b, wm.kind) : '未接続';
        setFloorMsg(err);
        // 連続して引けるようptsだけリセットしてモード維持
        setWallAddMode({ ...wm, pts: [] });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => { setWallAddMode(null); setFloorMsg(null); }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    return () => handler.destroy();
  }, [wallAddMode, buildingsFull, onAddPartition]);

  return (
    <div ref={gizmoContRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* 方位キューブ + PN設定UI（右上）— 3次元図と連動 */}
      {setPlantNorthAngle && (
        <div style={{ position:'absolute', top:6, right:6, zIndex:30, display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, pointerEvents:'auto' }}>
          {/* 方位キューブSVG */}
          {(() => {
            const gc = 40, cs = 12, arL = 24;
            const { h, p } = cubeOrient;
            const pnR = (typeof plantNorthAngle === 'number' ? plantNorthAngle : 0) * Math.PI / 180;
            // ══ 幾何は orientationCubeCore.js（唯一の実装）へ寄せた・2026-09-01 ══
            // ここは4つ目の重複だった（App.jsxの4ビュー / OrientationCube.jsx / ここ）。
            // 【引数変換】この画面は heading/pitch、コアは az/el。採用は **(−pn, +heading, pitch)**。
            //
            // 【旧実装は左右が逆だった・2026-09-01 ユーザー実機報告】
            //   「2D/3Dどちらもキューブの左右の動きが逆」。他ビュー（App.jsx側）は正常。
            //   切り分け: **キューブをドラッグせず**中ボタン等でカメラを回しても逆
            //   → ドラッグ側（newH = startH − dx·sens）ではなく**描画側の符号**が原因と確定。
            //
            //   移植そのものは忠実だった（checks/cube_parity4_selfcheck.cjs）:
            //     ①手写しは git HEAD の原文と同値（72/72）
            //     ②(−pn, −heading, pitch) なら旧実装と頂点960/960・4方向160/160一致
            //   つまり**旧実装が元から逆**で、忠実に移すとバグごと引き継ぐ状態だった。
            //
            // 【なぜ符号1つで直るのか】heading=0 では ±0 で同じ絵になり、
            //   回すほど左右が開いていく。報告された「左右の"動き"が逆」と正確に一致する。
            //   静止時の見た目（面の並び・矢印の位置）は変わらない。
            //   ※ここは旧実装と**意図的に挙動を変えている**。cube_parity4 の
            //     「(−pn,−heading,pitch) で960/960一致」は"旧実装の記録"であって、正ではない。
            // 【明暗】コアの深さ規約は「大きいほど手前」。以前ここは `depth < midD` で
            //   判定していたが、規約が逆になるので **必ず ocIsNear を使う**（自前で書き直さない）。
            //   実測の差は引き分け5件のみで、いずれも面が真横＝画面上の面積0なので見た目に影響しない。
            // 【並び順】コアの faces は既に奥→手前。ここで sort し直さない。
            const _cc = ocCubeFaces(-pnR, h, p, gc, cs);
            const midD = _cc.midD;
            // 下のJSXが使っている名前（bright/dark/cxF/cyF）へ合わせるだけの詰め替え
            const faces = _cc.faces.map(f => ({ ...f, bright: f.b, dark: f.dk, cxF: f.cx, cyF: f.cy }));
            // 軸方向（スクリーン）。真北の式もコアが持つ（Cesium版が正だったのでそちらに揃えてある）
            const _cd = ocAxisDirs(-pnR, h, p);
            const [ax,ay] = _cd.x;
            const [bx,by] = _cd.pn;
            const [zx,zy] = _cd.z;
            const [nxN,nyN] = _cd.n;
            const arrHead = (dx,dy,col) => {
              const hx = gc + dx, hy = gc + dy;
              const l = Math.sqrt(dx*dx+dy*dy) || 1, ux = dx/l, uy = dy/l;
              return <polygon key={col} points={`${hx},${hy} ${hx-ux*6-uy*3},${hy-uy*6+ux*3} ${hx-ux*6+uy*3},${hy-uy*6-ux*3}`} fill={col} />;
            };
            return (
              <svg width={80} height={80} style={{ overflow:'visible', cursor: cubeDragRef.current ? 'grabbing' : 'grab', display:'block' }}
                onMouseDown={e => {
                  if (e.button !== 0) return;
                  e.preventDefault(); e.stopPropagation();
                  const viewer = viewerRef.current;
                  if (!viewer || viewer.isDestroyed()) return;
                  const ctrl = viewer.scene.screenSpaceCameraController;
                  if (ctrl) { ctrl.enableRotate = false; ctrl.enableTranslate = false; ctrl.enableZoom = false; ctrl.enableTilt = false; }
                  cubeDragRef.current = { startX: e.clientX, startY: e.clientY, startH: cubeOrientRef.current.h, startP: cubeOrientRef.current.p };
                }}
                onWheel={e => {
                  const canvas = viewerRef.current?.scene?.canvas;
                  if (!canvas) return;
                  canvas.dispatchEvent(new WheelEvent('wheel', { bubbles:false, cancelable:true, deltaX:e.deltaX, deltaY:e.deltaY, deltaMode:e.deltaMode, clientX:e.clientX, clientY:e.clientY, ctrlKey:e.ctrlKey, shiftKey:e.shiftKey, altKey:e.altKey }));
                }}
              >
                {faces.map((f,i) => (
                  <g key={i}>
                    <polygon points={f.pts} fill={ocIsNear(f.depth, midD) ? f.bright : f.dark} stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9} />
                    {f.label && ocIsNear(f.depth, midD) && (
                      <text x={f.cxF} y={f.cyF} fill="#FFF" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700">{f.label}</text>
                    )}
                  </g>
                ))}
                <circle cx={gc} cy={gc} r={2.5} fill="#FFF" stroke="#000" strokeWidth={0.8} />
                <line x1={gc} y1={gc} x2={gc+ax*arL} y2={gc+ay*arL} stroke="#EF4444" strokeWidth={1.8} strokeLinecap="round" />
                {arrHead(ax*arL, ay*arL, '#EF4444')}
                <text x={gc+ax*(arL+10)} y={gc+ay*(arL+10)} fill="#EF4444" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">X</text>
                <line x1={gc} y1={gc} x2={gc+nxN*arL} y2={gc+nyN*arL} stroke="#F97316" strokeWidth={1.8} strokeLinecap="round" />
                {arrHead(nxN*arL, nyN*arL, '#F97316')}
                <line x1={gc} y1={gc} x2={gc+bx*arL} y2={gc+by*arL} stroke="#22C55E" strokeWidth={2} strokeLinecap="round" />
                {arrHead(bx*arL, by*arL, '#22C55E')}
                {/* Nラベル: N矢印（橙）先端に固定 */}
                <text x={gc+nxN*(arL+11)} y={gc+nyN*(arL+11)} fill="#F97316" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">N</text>
                {/* PN/yラベル: PN矢印（緑）先端 */}
                <text x={gc+bx*(arL+11)} y={gc+by*(arL+11)-7} fill="#22C55E" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                  onClick={e => { e.stopPropagation(); setPnPanelOpen(v => !v); }} style={{ cursor:'pointer' }}>PN</text>
                <text x={gc+bx*(arL+11)} y={gc+by*(arL+11)+7} fill="#22C55E" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700">y</text>
                <line x1={gc} y1={gc} x2={gc+zx*arL} y2={gc+zy*arL} stroke="#60A5FA" strokeWidth={2} strokeLinecap="round" />
                {arrHead(zx*arL, zy*arL, '#60A5FA')}
                <text x={gc+zx*(arL+10)} y={gc+zy*(arL+10)} fill="#60A5FA" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">Z</text>
              </svg>
            );
          })()}
          {/* PN調整パネル（キューブ内PNラベルクリックで開閉） */}
          {pnPanelOpen && (
            <div style={{ background:'rgba(15,23,42,0.72)', borderRadius:4, padding:'3px 5px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:3 }}>
                <input
                  type="text" inputMode="numeric"
                  value={pnInput}
                  onChange={e => setPnInput(e.target.value)}
                  onBlur={e => {
                    const n = ((Number(e.target.value) % 360) + 360) % 360;
                    const safe = isNaN(n) ? 0 : n;
                    setPlantNorthAngle(safe); setPnInput(String(safe));
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const n = ((Number(e.target.value) % 360) + 360) % 360;
                      const safe = isNaN(n) ? 0 : n;
                      setPlantNorthAngle(safe); setPnInput(String(safe));
                    }
                  }}
                  style={{ width:36, fontSize:9, padding:'1px 3px', background:'rgba(255,255,255,0.18)', border:'1px solid rgba(255,255,255,0.35)', borderRadius:3, color:'#FCD34D', textAlign:'center' }}
                />
                <span style={{ fontSize:7, color:'#94A3B8' }}>°</span>
              </div>
              <div style={{ display:'flex', justifyContent:'center', gap:4, marginTop:2 }}>
                <button onClick={() => { const n=((plantNorthAngle+1)%360+360)%360; setPlantNorthAngle(n); setPnInput(String(n)); }}
                  style={{ fontSize:8, lineHeight:1, padding:'1px 8px', background:'rgba(255,255,255,0.15)', border:'none', borderRadius:2, color:'#FCD34D', cursor:'pointer' }}>▲</button>
                <button onClick={() => { const n=((plantNorthAngle-1+360)%360); setPlantNorthAngle(n); setPnInput(String(n)); }}
                  style={{ fontSize:8, lineHeight:1, padding:'1px 8px', background:'rgba(255,255,255,0.15)', border:'none', borderRadius:2, color:'#FCD34D', cursor:'pointer' }}>▼</button>
              </div>
            </div>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        onDragOver={e => e.preventDefault()}
        onDrop={handleCesiumDrop}
        style={{ width: '100%', height: '100%', cursor: (fieldDrawMode || bldAddMode || faceSketchPhase) ? 'crosshair' : undefined }}
      />
      {/* ワイヤー描画Canvas: postRenderで同期描画（ちらつきなし） */}
      <canvas ref={wireCanvasRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:7 }} />
      {/* アイコンホバーオーバーレイ: カメラ/×ボタン（ドラッグ中はcanvasに描画するため非表示） */}
      {hoverId && hoverScreenPos && !isDraggingIcon && (() => {
        const _n = nodes.find(n => n.id === hoverId);
        if (!_n || _n.kind !== 'symbol') return null;
        return (
          <div ref={hoverOverlayRef} style={{ position: 'absolute', left: hoverScreenPos.x - 21, top: hoverScreenPos.y - 46, width: 42, height: 46, zIndex: 20, pointerEvents: 'none', userSelect: 'none' }}>
            <div onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onRemoveNodePos?.(hoverId); }}
              onMouseEnter={() => clearTimeout(hoverClearTimerRef.current)}
              onWheel={e => { const cv = viewerRef.current?.scene?.canvas; if (cv) cv.dispatchEvent(new WheelEvent('wheel', { bubbles:false, cancelable:true, deltaX:e.deltaX, deltaY:e.deltaY, deltaMode:e.deltaMode, clientX:e.clientX, clientY:e.clientY, ctrlKey:e.ctrlKey })); }}
              style={{ position: 'absolute', top: -10, left: -10, width: 16, height: 16, borderRadius: '50%', background: '#EF4444', color: '#FFF', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', pointerEvents: 'auto', userSelect: 'none' }}>×</div>
            <div onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onFocusNode?.(hoverId); }}
              onMouseEnter={() => clearTimeout(hoverClearTimerRef.current)}
              onWheel={e => { const cv = viewerRef.current?.scene?.canvas; if (cv) cv.dispatchEvent(new WheelEvent('wheel', { bubbles:false, cancelable:true, deltaX:e.deltaX, deltaY:e.deltaY, deltaMode:e.deltaMode, clientX:e.clientX, clientY:e.clientY, ctrlKey:e.ctrlKey })); }}
              style={{ position: 'absolute', top: -10, right: -10, width: 16, height: 16, borderRadius: '50%', background: '#3B82F6', color: '#FFF', fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', pointerEvents: 'auto', userSelect: 'none' }}
              title="3D/2Dマップにフォーカス">📷</div>
          </div>
        );
      })()}
      {/* 建屋選択バッジオーバーレイ: 📷フォーカス / × 削除 */}
      {bldSelected && (
        <div ref={bldBadgeOverlayRef} style={{ position: 'absolute', pointerEvents: 'none', zIndex: 21, transform: 'translate(-50%, -100%)' }}>
          {/* 📷 フォーカス */}
          <div onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onFocusBld?.(bldSelected.buildingId); }}
            style={{ position: 'absolute', top: -30, left: 6, width: 22, height: 22, borderRadius: '50%',
              background: 'rgba(15,23,42,0.85)', fontSize: 13, display: 'flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer', pointerEvents: 'auto', userSelect: 'none',
              boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>📷</div>
          {/* × 削除 */}
          <div onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onDeleteBld?.(bldSelected.buildingId); setBldSelected(null); }}
            style={{ position: 'absolute', top: -30, left: -28, width: 22, height: 22, borderRadius: '50%',
              background: 'rgba(239,68,68,0.88)', color: '#fff', fontWeight: 700, fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              pointerEvents: 'auto', userSelect: 'none', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>×</div>
        </div>
      )}
      {/* SVGオーバーレイ: ホバー当たり判定・折れ点四角のみ（視覚描画はCanvas） */}
      {wireSVGPaths.length > 0 && (
        <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:8, overflow:'visible' }}>
          {wireSVGPaths.map(w => {
            const ss = Math.min(1.0, w.strokeScale ?? 1.0);
            const baseW = Math.max(1.0, (w.isBus ? 5 : 3) * ss);
            const isHovered = hoverSeg === w.id;
            // ホバー検出用の全点列（透明ヒット領域）
            const hitPts = w.segs.length > 0
              ? w.segs[0].x1.toFixed(1)+','+w.segs[0].y1.toFixed(1)+' '+w.segs.map(s => s.x2.toFixed(1)+','+s.y2.toFixed(1)).join(' ')
              : '';
            return (
              <g key={w.id}
                onMouseEnter={(ev) => {
                  setHoverSeg(w.id);
                  if (setWireTip) {
                    const seg = segs.find(s => s.id === w.id);
                    if (seg) {
                      const aP = allMapPos[seg.from], bP = allMapPos[seg.to];
                      if (aP && bP) {
                        const mpp = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
                        const wps = segWp[w.id] || [], wzs = wpZ[w.id] || [];
                        const _mz = mapZ || {};
                        const pts3d = [[aP.x,aP.y,_mz[seg.from]||0],...wps.map((wp,k)=>[wp.x,wp.y,wzs[k]||0]),[bP.x,bP.y,_mz[seg.to]||0]];
                        let dist = 0;
                        for (let k = 0; k < pts3d.length-1; k++) { const dx=(pts3d[k+1][0]-pts3d[k][0])*mpp,dy=(pts3d[k+1][1]-pts3d[k][1])*mpp,dz=pts3d[k+1][2]-pts3d[k][2]; dist+=Math.sqrt(dx*dx+dy*dy+dz*dz); }
                        setWireTip({ x: ev.clientX, y: ev.clientY, dist });
                      }
                    }
                  }
                }}
                onMouseMove={(ev) => { if (setWireTip) setWireTip(pr => pr ? { ...pr, x: ev.clientX, y: ev.clientY } : null); }}
                onMouseLeave={() => { setHoverSeg(null); if (setWireTip) setWireTip(null); }}
                onWheel={e => {
                  const canvas = viewerRef.current?.scene?.canvas;
                  if (!canvas) return;
                  canvas.dispatchEvent(new WheelEvent('wheel', {
                    bubbles: false, cancelable: true,
                    deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
                    clientX: e.clientX, clientY: e.clientY,
                    ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
                  }));
                }}>
                {/* 透明ホバー検出ポリライン: ワイヤー周辺に広い当たり判定 / Ctrl+クリックで折れ点追加 */}
                {hitPts && <polyline points={hitPts} fill="none" stroke="transparent" strokeWidth={baseW + 12} pointerEvents="stroke"
                  onClick={e => {
                    if (!e.ctrlKey) return;
                    e.stopPropagation();
                    const v = viewerRef.current;
                    if (!v || v.isDestroyed()) return;
                    const rect = v.scene.canvas.getBoundingClientRect();
                    const pos = pickOnHorizontalPlane(new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top), 0);
                    if (!pos) return;
                    // 最近接セグメントの垂直方向にオフセット（生成を視覚的に明確化）
                    const _segs2 = cbRef.current._segs || [];
                    const _amap = cbRef.current._allMapPos || {};
                    const _swp = cbRef.current._segWp || {};
                    const _seg = _segs2.find(s => s.id === w.id);
                    if (_seg) {
                      const _a = _amap[_seg.from], _b = _amap[_seg.to];
                      if (_a && _b) {
                        const _wps = _swp[w.id] || [];
                        const _path = [_a, ..._wps, _b];
                        let _bs = 0, _bd = Infinity;
                        for (let _i = 0; _i < _path.length - 1; _i++) {
                          const _dx = _path[_i+1].x - _path[_i].x, _dy = _path[_i+1].y - _path[_i].y, _l2 = _dx*_dx+_dy*_dy;
                          let _t = _l2===0?0:(((pos.x-_path[_i].x)*_dx+(pos.y-_path[_i].y)*_dy)/_l2);
                          _t = Math.max(0, Math.min(1, _t));
                          const _dd = (pos.x-(_path[_i].x+_t*_dx))**2+(pos.y-(_path[_i].y+_t*_dy))**2;
                          if (_dd < _bd) { _bd = _dd; _bs = _i; }
                        }
                        const _sdx = _path[_bs+1].x - _path[_bs].x, _sdy = _path[_bs+1].y - _path[_bs].y;
                        const _sl = Math.sqrt(_sdx*_sdx+_sdy*_sdy)||1;
                        pos.x += (-_sdy/_sl) * 30;
                        pos.y += (_sdx/_sl) * 30;
                      }
                    }
                    cbRef.current.onAddWp?.(w.id, { x: pos.x, y: pos.y, z: 0 });
                  }}
                />}
                {/* 折れ点区間別距離: 折れ点がある場合のみサブセグポリラインを追加（合計+部分距離を表示） */}
                {w.wps && w.wps.length > 0 && w.segs.length > 0 && (() => {
                  const _cseg = segs.find(s => s.id === w.id);
                  if (!_cseg) return null;
                  const _caP = allMapPos[_cseg.from], _cbP = allMapPos[_cseg.to];
                  if (!_caP || !_cbP) return null;
                  const _cwps = segWp[w.id] || [], _cwzs = wpZ[w.id] || [];
                  const _cmz = mapZ || {};
                  const _cmpp = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
                  const _cpts3d = [[_caP.x,_caP.y,_cmz[_cseg.from]||0],..._cwps.map((wp,k)=>[wp.x,wp.y,_cwzs[k]||0]),[_cbP.x,_cbP.y,_cmz[_cseg.to]||0]];
                  let _ctotal=0; for(let k=0;k<_cpts3d.length-1;k++){const dx=(_cpts3d[k+1][0]-_cpts3d[k][0])*_cmpp,dy=(_cpts3d[k+1][1]-_cpts3d[k][1])*_cmpp,dz=_cpts3d[k+1][2]-_cpts3d[k][2];_ctotal+=Math.sqrt(dx*dx+dy*dy+dz*dz);}
                  const screenPath = [
                    { x: w.segs[0].x1, y: w.segs[0].y1 },
                    ...w.wps,
                    { x: w.segs[w.segs.length-1].x2, y: w.segs[w.segs.length-1].y2 },
                  ];
                  return screenPath.slice(0,-1).map((p0, si) => {
                    const p1 = screenPath[si+1];
                    const q0 = _cpts3d[si], q1 = _cpts3d[si+1]; if (!q0 || !q1) return null;
                    const sdx=(q1[0]-q0[0])*_cmpp,sdy=(q1[1]-q0[1])*_cmpp,sdz=q1[2]-q0[2];
                    const segD=Math.sqrt(sdx*sdx+sdy*sdy+sdz*sdz);
                    return (<polyline key={`cssh${si}`}
                      points={`${p0.x.toFixed(1)},${p0.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`}
                      fill="none" stroke="transparent" strokeWidth={baseW + 12}
                      pointerEvents="stroke" style={{ cursor: 'pointer' }}
                      onMouseEnter={ev => { if (setWireTip) setWireTip({x:ev.clientX,y:ev.clientY,dist:_ctotal,segDist:segD}); }}
                      onMouseMove={ev => { if (setWireTip) setWireTip(pr => pr ? {...pr,x:ev.clientX,y:ev.clientY} : null); }}
                      onMouseLeave={() => { if (setWireTip) setWireTip(pr => pr ? {...pr,segDist:null} : null); }}
                    />);
                  });
                })()}
                {/* 視覚的ワイヤーはCanvasに描画（ちらつきなし）。ここはSVGの当たり判定のみ */}
                {/* 折れ点四角: ホバー中のみ表示、ドラッグでXY移動 */}
                {/* 線セグメント中点ハンドル: 黄色丸（ホバー時のみ） */}
                {isHovered && (w.wps || []).map(wp => {
                  const isSel = gizmoTargetRef.current?.type === 'wp'
                    && gizmoTargetRef.current?.segId === w.id
                    && gizmoTargetRef.current?.wpIndex === wp.wpIndex;
                  const sz = 14;
                  return (
                    <rect key={`${w.id}-${wp.wpIndex}`}
                      x={wp.x - sz/2} y={wp.y - sz/2} width={sz} height={sz}
                      fill={isSel ? '#60A5FA' : '#FFFFFF'}
                      stroke={'#3B82F6'}
                      strokeWidth={isSel ? 2 : 1.5} rx={1}
                      pointerEvents="auto" style={{ cursor: 'grab' }}
                      onMouseEnter={e => { e.currentTarget.setAttribute('fill', isSel ? '#93C5FD' : '#E0F0FF'); e.currentTarget.setAttribute('stroke', '#3B82F6'); e.currentTarget.setAttribute('stroke-width', '2'); }}
                      onMouseLeave={e => { e.currentTarget.setAttribute('fill', isSel ? '#60A5FA' : '#FFFFFF'); e.currentTarget.setAttribute('stroke', '#3B82F6'); e.currentTarget.setAttribute('stroke-width', isSel ? '2' : '1.5'); }}
                      onMouseDown={e => {
                        e.stopPropagation();
                        const v = viewerRef.current;
                        if (!v || v.isDestroyed()) return;
                        const rect = v.scene.canvas.getBoundingClientRect();
                        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
                        let startPickGrid = null;
                        try {
                          const pos = new Cesium.Cartesian2(cx, cy);
                          let cart = v.scene.pickPosition(pos);
                          if (!cart) { const ray = v.camera.getPickRay(pos); if (ray) cart = v.scene.globe.pick(ray, v.scene); }
                          if (cart) {
                            const carto = Cesium.Cartographic.fromCartesian(cart);
                            startPickGrid = geoToGrid(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
                          }
                        } catch (_) {}
                        const wps = cbRef.current._segWp?.[w.id] || [];
                        const wzs = cbRef.current._wpZ?.[w.id] || [];
                        const curWp = wps[wp.wpIndex] || { x: 0, y: 0 };
                        gizmoCbRef.current.showGizmo(w.id, wp.wpIndex);
                        setWpDragCes({
                          segId: w.id, wpIndex: wp.wpIndex,
                          startClientX: e.clientX, startClientY: e.clientY,
                          startPickGrid: startPickGrid || { x: curWp.x, y: curWp.y },
                          startWpX: curWp.x, startWpY: curWp.y,
                          startWpZ: wzs[wp.wpIndex] || 0,
                        });
                      }}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {/* XYZ軸 SVGオーバーレイ（3次元図と同一デザイン） */}
      {cesiumGizmoSVG && (() => {
        const { o, axes } = cesiumGizmoSVG;
        // SVGから直接ドラッグ開始（棒・先端どちらでも有効）
        const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
        const grabOff = () => document.getElementById('__gs')?.remove();
        const startAxisDrag = (e, axis) => {
          e.stopPropagation();
          const gt = gizmoTargetRef.current;
          if (!gt) return;
          let startX, startY, startZ;
          if (gt.type === 'wp') {
            const wps = cbRef.current._segWp?.[gt.segId] || [];
            const wzs = cbRef.current._wpZ?.[gt.segId] || [];
            const wp = wps[gt.wpIndex]; if (!wp) return;
            startX = wp.x; startY = wp.y; startZ = wzs[gt.wpIndex] || 0;
          } else if (gt.type === 'node') {
            const pos = cbRef.current._allMapPos?.[gt.nodeId]; if (!pos) return;
            startX = pos.x; startY = pos.y; startZ = pos.z || 0;
          } else return;
          const v = viewerRef.current;
          if (!v || v.isDestroyed()) return;
          const rect = v.scene.canvas.getBoundingClientRect();
          const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          // ドラッグ開始時のカーソルworld座標を記録（PN投影計算の基点: スナップ防止）
          const initPick = pickOnHorizontalPlane(new Cesium.Cartesian2(startScreen.x, startScreen.y), startZ);
          const grabPickX = initPick ? initPick.x : startX;
          const grabPickY = initPick ? initPick.y : startY;
          grabOn();
          v.scene.screenSpaceCameraController.enableRotate = false;
          v.scene.screenSpaceCameraController.enableTranslate = false;
          v.scene.screenSpaceCameraController.enableZoom = false;
          let lastMovePos = { x: startX, y: startY, z: startZ };
          const mv = (me) => {
            const r2 = v.scene.canvas.getBoundingClientRect();
            const cur = { x: me.clientX - r2.left, y: me.clientY - r2.top };
            let newX = startX, newY = startY, newZ = startZ;
            if (axis === 'z') {
              newZ = startZ + (-(cur.y - startScreen.y) * 0.5);
            } else {
              const pos = pickOnHorizontalPlane(new Cesium.Cartesian2(cur.x, cur.y), startZ);
              if (pos) {
                // PN軸方向に投影して移動（draggingAxisRefハンドラと同じ式）
                const _pnR = (plantNorthAngleRef.current || 0) * Math.PI / 180;
                const axNx = axis === 'x' ? Math.cos(_pnR) : Math.sin(_pnR);
                const axNy = axis === 'x' ? Math.sin(_pnR) : -Math.cos(_pnR);
                const ddx = pos.x - grabPickX;
                const ddy = pos.y - grabPickY;
                const prj = ddx * axNx + ddy * axNy;
                newX = startX + prj * axNx;
                newY = startY + prj * axNy;
              }
            }
            lastMovePos = { x: newX, y: newY, z: newZ };
            const cb = cbRef.current;
            if (gt.type === 'wp') cb.onMoveWp?.(gt.segId, gt.wpIndex, { x: newX, y: newY, z: newZ });
            else if (gt.type === 'node') cb.onMoveNode?.(gt.nodeId, { x: newX, y: newY, z: newZ });
          };
          const up = () => {
            grabOff();
            window.removeEventListener('mousemove', mv);
            window.removeEventListener('mouseup', up);
            // mouseup時にsnapした座標で確定（ドラッグ中は生座標で滑らか移動）
            const snapped = { x: Math.round(lastMovePos.x / MINOR) * MINOR, y: Math.round(lastMovePos.y / MINOR) * MINOR, z: lastMovePos.z };
            const cb2 = cbRef.current;
            if (gt.type === 'wp') cb2.onDropWp?.(gt.segId, gt.wpIndex, snapped);
            else if (gt.type === 'node') cb2.onMoveNode?.(gt.nodeId, snapped);
            const vv = viewerRef.current;
            if (vv && !vv.isDestroyed()) {
              vv.scene.screenSpaceCameraController.enableRotate = true;
              vv.scene.screenSpaceCameraController.enableTranslate = true;
              vv.scene.screenSpaceCameraController.enableZoom = true;
            }
          };
          window.addEventListener('mousemove', mv);
          window.addEventListener('mouseup', up);
        };
        return (
          <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:50 }}>
            <circle cx={o.x} cy={o.y} r={4} fill="#FFF" stroke="#000" strokeWidth={1.5} />
            {axes.map(({ axis, color, tip }) => {
              if (!tip) {
                const fb = { x:{dx:35,dy:0}, y:{dx:0,dy:-35}, z:{dx:-25,dy:-25} }[axis] || {dx:30,dy:0};
                return (
                  <text key={axis} x={o.x+fb.dx} y={o.y+fb.dy} textAnchor="middle" fontSize={13} fontWeight={700}
                    fill={color} stroke="#fff" strokeWidth={3} paintOrder="stroke"
                    pointerEvents="auto" style={{ cursor:'grab' }}
                    onMouseDown={e => startAxisDrag(e, axis)}
                    onWheel={e => { const canvas = viewerRef.current?.scene?.canvas; if (!canvas) return; canvas.dispatchEvent(new WheelEvent('wheel', { bubbles:false, cancelable:true, deltaX:e.deltaX, deltaY:e.deltaY, deltaMode:e.deltaMode, clientX:e.clientX, clientY:e.clientY, ctrlKey:e.ctrlKey, shiftKey:e.shiftKey, altKey:e.altKey })); }}>
                    {axis.toUpperCase()}
                  </text>
                );
              }
              const dx=tip.x-o.x, dy=tip.y-o.y, len=Math.sqrt(dx*dx+dy*dy);
              if (len < 2) return null;
              const ux=dx/len, uy=dy/len, arrL=18, arrW=9;
              const sx=tip.x-ux*arrL, sy=tip.y-uy*arrL;
              return (
                <g key={axis} pointerEvents="auto" style={{ cursor:'grab' }}
                  onMouseDown={e => startAxisDrag(e, axis)}
                  onWheel={e => { const canvas = viewerRef.current?.scene?.canvas; if (!canvas) return; canvas.dispatchEvent(new WheelEvent('wheel', { bubbles:false, cancelable:true, deltaX:e.deltaX, deltaY:e.deltaY, deltaMode:e.deltaMode, clientX:e.clientX, clientY:e.clientY, ctrlKey:e.ctrlKey, shiftKey:e.shiftKey, altKey:e.altKey })); }}>
                  {/* 棒部分（透明太め当たり判定を兼ねる） */}
                  <line x1={o.x} y1={o.y} x2={sx} y2={sy} stroke="transparent" strokeWidth={14} />
                  <line x1={o.x} y1={o.y} x2={sx} y2={sy} stroke={color} strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                  {/* 先端矢印（太め当たり判定付き） */}
                  <polygon points={`${tip.x},${tip.y} ${sx+uy*(arrW+4)},${sy-ux*(arrW+4)} ${sx-uy*(arrW+4)},${sy+ux*(arrW+4)}`} fill="transparent" />
                  <polygon points={`${tip.x},${tip.y} ${sx+uy*arrW},${sy-ux*arrW} ${sx-uy*arrW},${sy+ux*arrW}`} fill={color} pointerEvents="none" />
                  <text x={tip.x+ux*14} y={tip.y+uy*14+4} textAnchor="middle" fontSize={13} fontWeight={700} fill={color} stroke="#fff" strokeWidth={3} paintOrder="stroke" pointerEvents="none">{axis.toUpperCase()}</text>
                </g>
              );
            })}
          </svg>
        );
      })()}
      {/* 建屋操作オーバーレイ: 矢印 + 回転 + 入力UI（面作図中は非表示）*/}
      {arrowScreen && bldSelected && !faceSketchPhase && (() => { try {
        const { baseX, baseY, tipX, tipY, face } = arrowScreen;
        const dx = tipX - baseX, dy = tipY - baseY;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 2) return null;
        const color = '#EF4444';
        const nx = dx / len, ny = dy / len;
        const headLen = 14, headW = 7;
        const hx = tipX - nx * headLen, hy = tipY - ny * headLen;
        const perpX = -ny, perpY = nx;
        const h1x = hx + perpX * headW, h1y = hy + perpY * headW;
        const h2x = hx - perpX * headW, h2y = hy - perpY * headW;
        // 矢印の中間点（建屋移動テキストボックス配置用）
        const midAX = (baseX + tipX) / 2, midAY = (baseY + tipY) / 2;

        // ドラッグ中カーソル強制変更
        const setGrabbing = () => {
          if (!document.getElementById('__grab_style')) {
            const s = document.createElement('style');
            s.id = '__grab_style';
            s.textContent = '* { cursor: grabbing !important; }';
            document.head.appendChild(s);
          }
        };
        const clearGrabbing = () => {
          const s = document.getElementById('__grab_style');
          if (s) s.remove();
        };

        // カメラ操作無効化ヘルパー
        const disableCam = () => {
          const v = viewerRef.current;
          if (v && !v.isDestroyed()) {
            v.scene.screenSpaceCameraController.enableRotate = false;
            v.scene.screenSpaceCameraController.enableTranslate = false;
            v.scene.screenSpaceCameraController.enableZoom = false;
            v.scene.screenSpaceCameraController.enableTilt = false;
          }
        };
        const enableCam = () => {
          const v = viewerRef.current;
          if (v && !v.isDestroyed()) {
            v.scene.screenSpaceCameraController.enableRotate = true;
            v.scene.screenSpaceCameraController.enableTranslate = true;
            v.scene.screenSpaceCameraController.enableZoom = true;
            v.scene.screenSpaceCameraController.enableTilt = true;
          }
        };

        // ── スクリーンピクセル/グリッドピクセル変換率（ドラッグ開始時1回）──
        const calcPxPerGrid = () => {
          const v = viewerRef.current;
          if (!v || v.isDestroyed()) return 1;
          const blk = (blds || [])[bldSelected?.entIdx];
          if (!blk || !blk.points || blk.points.length < 2) return 1;
          const pts = blk.points;
          const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
          const baseElev = v._siteBaseElevation || 0;
          const zT = blk.zTop != null ? blk.zTop : 40;
          const z = baseElev + zT / 2;
          // 建屋中心で1グリッドピクセル離れた2点のスクリーン距離
          const g0 = gridToGeo(cx, cy);
          const g1 = gridToGeo(cx + 1, cy); // +1グリッドピクセル
          const s0 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, z));
          const s1 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, z));
          if (!s0 || !s1) return 1;
          const d = Math.sqrt((s1.x - s0.x) ** 2 + (s1.y - s0.y) ** 2);
          return d > 0.01 ? d : 1; // 1グリッドピクセルあたりのスクリーンピクセル数
        };

        // ── 面ドラッグ（矢印先端）──
        const onHandleDown = (e) => {
          console.warn('[HANDLE_DOWN_BEGIN]', {
            face: bldSelected?.face,
            solidFaceId: bldSelected?.solidFaceId,
            faceType: typeof bldSelected?.face,
            entIdx: bldSelected?.entIdx,
            blksLen: (blds || []).length,
          });
          e.preventDefault(); e.stopPropagation();
          if (!bldSelected || !onMoveBldFace) return;
          // solidFaceIdの面: ライブドラッグ → mouseupで確定（通常箱と同じ仕様）
          if (bldSelected.solidFaceId && typeof bldSelected.face === 'string' && bldSelected.face.startsWith('f')) {
            disableCam();
            setGrabbing();
            // undo snapshot保存
            if (onBldPushUndo) onBldPushUndo();
            const ppg = calcPxPerGrid();
            const startX = e.clientX, startY = e.clientY;
            let lastDM = 0;
            // 開始時のsolidをcapture（ドラッグ中の累積適用基準）
            const v0 = viewerRef.current;
            const cs0 = (v0 && v0._currentSolids) || solids || [];
            const baseSolid = cs0.find(s => s.buildingId === bldSelected.buildingId);
            if (!baseSolid) { clearGrabbing(); enableCam(); return; }
            const baseSolids = cs0.map(s => s); // 配列コピー（参照保持）
            const sFaceId = bldSelected.solidFaceId;
            const sNormal = bldSelected._solidNormal;
            const sCenter = { x: bldSelected._faceCenterX, y: bldSelected._faceCenterY, z: bldSelected._faceCenterZ };
            const onSolidMove = (me) => {
              try {
                const v = viewerRef.current;
                if (!v || v.isDestroyed() || !sNormal) return;
                // 法線方向の画面投影を計算
                const baseElev = v._siteBaseElevation || 0;
                const bS = gridToScreen(sCenter.x, sCenter.y, baseElev + sCenter.z);
                const tS = gridToScreen(sCenter.x + sNormal.nx * 10, sCenter.y + sNormal.ny * 10, baseElev + sCenter.z + sNormal.nz * 10);
                if (!bS || !tS) return;
                const ndx = tS.x - bS.x, ndy = tS.y - bS.y;
                const nLen = Math.sqrt(ndx * ndx + ndy * ndy);
                if (nLen < 0.5) return;
                const dmx = me.clientX - startX, dmy = me.clientY - startY;
                const proj = (dmx * ndx + dmy * ndy) / nLen;
                const depthM = proj / ppg * METERS_PER_PX;
                if (Math.abs(depthM - lastDM) < 0.01) return;
                lastDM = depthM;
                // pushPullFaceで累積deltaを適用
                const newSolid = pushPullFace(baseSolid, sFaceId, depthM);
                const updated = baseSolids.map(s => s.id === baseSolid.id ? newSolid : s);
                if (v._buildBldEntities) {
                  v._buildBldEntities(v, blds || [], v._siteBaseElevation || 0, mode === '3d', updated);
                  v.scene.requestRender();
                }
                if (setSolidsDirect) setSolidsDirect(updated);
              } catch(err) { console.warn('[SOLID_DRAG_MOVE] エラー', err.message); }
            };
            const onSolidUp = () => {
              window.removeEventListener('mousemove', onSolidMove);
              window.removeEventListener('mouseup', onSolidUp);
              clearGrabbing(); enableCam();
              // 選択を維持: 伸縮後の新しい面位置でbldSelectedを更新（再度突起伸縮できるように）
              try {
                const v = viewerRef.current;
                const cs = (v && v._currentSolids) || solids || [];
                const ts = cs.find(s => s.buildingId === bldSelected.buildingId);
                const tf = ts && ts.faces.find(f => f.id === sFaceId);
                if (tf) {
                  // 面の重心を再計算
                  let _fcx = 0, _fcy = 0, _fcz = 0;
                  tf.vertices.forEach(p => { _fcx += p.x; _fcy += p.y; _fcz += p.z; });
                  _fcx /= tf.vertices.length; _fcy /= tf.vertices.length; _fcz /= tf.vertices.length;
                  setBldSelected({
                    ...bldSelected,
                    _solidNormal: tf.normal,
                    _faceCenterX: _fcx, _faceCenterY: _fcy, _faceCenterZ: _fcz,
                  });
                }
              } catch(err) { console.warn('[SOLID_UP] 選択更新エラー', err.message); }
            };
            window.addEventListener('mousemove', onSolidMove);
            window.addEventListener('mouseup', onSolidUp);
            return;
          }
          disableCam();
          const ppg = calcPxPerGrid();
          const _csgN = bldSelected.csgNx != null ? { nx: bldSelected.csgNx, ny: bldSelected.csgNy } : null;
          const _isZsolid = bldSelected._solidNormal && Math.abs(bldSelected._solidNormal.nz) > 0.5;
          const _isZ = bldSelected.face === 'zTop' || bldSelected.face === 'zBottom' || _isZsolid;
          // ドラッグ開始時のblds深コピー（累積delta適用基準）
          const _bldSnap = (blds || []).map(blk => ({
            ...blk, points: blk.points ? blk.points.map(p => ({...p})) : blk.points
          }));
          let totalDelta = 0, lastX = e.clientX, lastY = e.clientY;
          // 矢印DOM直接更新用: 開始時の矢印基点を記録
          isDraggingRef.current = true;
          const _hOrigX = arrowScreenRef.current?.baseX ?? 0;
          const _hOrigY = arrowScreenRef.current?.baseY ?? 0;
          // v._buildBldEntitiesで直接entityを更新（React state更新なし→再レンダなし）
          const _applyDrag = (td) => {
            const vv = viewerRef.current;
            if (!vv || vv.isDestroyed() || !vv._buildBldEntities) return;
            let movedBlds;
            if (_isZ) {
              const face = bldSelected.face;
              movedBlds = _bldSnap.map((blk, i) => {
                if (blk.buildingId !== bldSelected.buildingId) return blk;
                if (!bldMoveAsSet && i !== bldSelected.entIdx) return blk;
                if (face === 'zTop')    return { ...blk, zTop:    (blk.zTop    != null ? blk.zTop    : (blk.height || 40)) + td };
                if (face === 'zBottom') return { ...blk, zBottom: (blk.zBottom != null ? blk.zBottom : 0) + td };
                return blk;
              });
            } else {
              // XY面: 面の2頂点を法線方向にtd移動
              const faceIdx = typeof bldSelected.face === 'number' ? bldSelected.face : 0;
              movedBlds = _bldSnap.map((blk, i) => {
                if (blk.buildingId !== bldSelected.buildingId) return blk;
                if (!bldMoveAsSet && i !== bldSelected.entIdx) return blk;
                if (!blk.points || blk.points.length < 2) return blk;
                const pts = blk.points, n = pts.length;
                let nx = _csgN?.nx, ny = _csgN?.ny;
                if (nx == null) {
                  const p0 = pts[faceIdx], p1 = pts[(faceIdx + 1) % n];
                  const ex = p1.x-p0.x, ey = p1.y-p0.y, el = Math.sqrt(ex*ex+ey*ey);
                  if (el < 0.001) return blk;
                  nx = ey/el; ny = -ex/el;
                  const cx = pts.reduce((s,p)=>s+p.x,0)/n, cy = pts.reduce((s,p)=>s+p.y,0)/n;
                  const mx = (p0.x+p1.x)/2, my = (p0.y+p1.y)/2;
                  if ((mx-cx)*nx+(my-cy)*ny < 0) { nx=-nx; ny=-ny; }
                }
                return { ...blk, points: pts.map((p, k) =>
                  (k === faceIdx || k === (faceIdx+1)%n)
                    ? { ...p, x: p.x + nx*td, y: p.y + ny*td }
                    : p
                )};
              });
            }
            // [] + _csgOverride一時無効化でbldListパス強制（movedBldsが確実に使われる）
            const _ov = window._csgOverride; window._csgOverride = null;
            movedBldsRef.current = movedBlds; // 矢印追従用（ハンドルドラッグ）
            vv._buildBldEntities(vv, movedBlds, vv._siteBaseElevation||0, mode==='3d', []);
            window._csgOverride = _ov;
            vv.scene.requestRender();
          };
          const onMove = (me) => {
            const dmx = me.clientX - lastX, dmy = me.clientY - lastY;
            lastX = me.clientX; lastY = me.clientY;
            const as = arrowScreenRef.current;
            let screenDelta;
            if (as) {
              const adx = as.tipX - as.baseX, ady = as.tipY - as.baseY;
              const alen = Math.sqrt(adx * adx + ady * ady);
              screenDelta = alen > 1 ? (dmx * adx + dmy * ady) / alen : (_isZ ? -dmy : dmx);
            } else {
              screenDelta = _isZ ? -dmy : dmx;
            }
            totalDelta += _isZ ? screenDelta / ppg * METERS_PER_PX : screenDelta / ppg;
            _applyDrag(totalDelta); // 直接entityを更新（Reactなし）。movedBldsRef.currentも設定される
            // 矢印をDOM直接更新（Reactを通さないので建屋と同速）
            const _mbH = movedBldsRef.current && movedBldsRef.current[bldSelected.entIdx];
            if (_mbH && arrowGroupRef.current) {
              const _aH = computeArrowScreen(_mbH, bldSelected.face, bldSelected, false);
              if (_aH) arrowGroupRef.current.setAttribute('transform', `translate(${_aH.baseX - _hOrigX},${_aH.baseY - _hOrigY})`);
            }
            // ヒントをDOMで直接更新（setBldDragHint不使用→React再レンダなし）
            const hEl = bldDragHintRef.current;
            if (hEl) {
              const dispMm = Math.round((_isZ ? totalDelta : totalDelta * METERS_PER_PX) * 1000);
              hEl.textContent = (_isZ ? '↕' : '↔') + ' ' + dispMm + 'mm';
              hEl.style.left = (me.clientX + 18) + 'px';
              hEl.style.top  = (me.clientY - 10) + 'px';
              hEl.style.display = 'block';
            }
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const hEl = bldDragHintRef.current;
            if (hEl) hEl.style.display = 'none';
            // ドラッグ終了: 最終位置でReact state更新してtransformをリセット
            const _finalBld = movedBldsRef.current && movedBldsRef.current[bldSelected.entIdx];
            isDraggingRef.current = false;
            movedBldsRef.current = null;
            if (arrowGroupRef.current) arrowGroupRef.current.setAttribute('transform', '');
            if (_finalBld) {
              const _finalArrow = computeArrowScreen(_finalBld, bldSelected.face, bldSelected, false);
              if (_finalArrow) updateArrowScreen(_finalArrow);
            }
            // mouseupで1回だけstate確定（→通常の再構築パスへ）
            if (Math.abs(totalDelta) > 0.001) {
              onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, bldSelected.face, totalDelta, bldMoveAsSet, _csgN);
            }
            clearGrabbing(); enableCam();
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };

        // ── 建屋全体ドラッグ（矢印棒）──
        const onShaftDown = (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!bldSelected || !onMoveBuilding) return;
          disableCam();
          const ppg = calcPxPerGrid();
          // ── ドラッグ開始時に法線・種別を1回だけ計算（blds変化させないので固定） ──
          let _gnx = 0, _gny = 0;
          let _isZShaft = false, _isSolidZ = false, _isSolidXY = false;
          let _solidDdx = 0, _solidDdy = 0;
          const blk = (blds || [])[bldSelected.entIdx];
          if (blk && typeof bldSelected.face === 'number') {
            const pts = blk.points, n = pts.length;
            const p0 = pts[bldSelected.face], p1 = pts[(bldSelected.face + 1) % n];
            const ex = p1.x - p0.x, ey = p1.y - p0.y, elen = Math.sqrt(ex * ex + ey * ey);
            if (elen > 0.001) {
              let gnx = ey / elen, gny = -ex / elen;
              const cx = pts.reduce((s, p) => s + p.x, 0) / n, cy = pts.reduce((s, p) => s + p.y, 0) / n;
              const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
              if ((mx - cx) * gnx + (my - cy) * gny < 0) { gnx = -gnx; gny = -gny; }
              _gnx = gnx; _gny = gny;
            }
          } else if (bldSelected.face === 'zTop' || bldSelected.face === 'zBottom') {
            _isZShaft = true;
          } else if (bldSelected.solidFaceId && bldSelected._solidNormal) {
            const sn = bldSelected._solidNormal;
            if (Math.abs(sn.nz) > 0.5) {
              _isSolidZ = true;
            } else {
              const xyLen = Math.sqrt(sn.nx * sn.nx + sn.ny * sn.ny);
              if (xyLen > 0.01) { _solidDdx = sn.nx / xyLen; _solidDdy = sn.ny / xyLen; _isSolidXY = true; }
            }
          }
          // ドラッグ開始時のblds深コピー（累積delta適用基準）
          const _bldSnap = (blds || []).map(blk => ({
            ...blk, points: blk.points ? blk.points.map(p => ({...p})) : blk.points
          }));
          let totalDelta = 0, lastX = e.clientX, lastY = e.clientY;
          shaftDragOffsetRef.current = { dx: 0, dy: 0, dz: 0 };
          // 矢印DOM直接更新用: 開始時の矢印基点を記録
          isDraggingRef.current = true;
          const _sOrigX = arrowScreenRef.current?.baseX ?? 0;
          const _sOrigY = arrowScreenRef.current?.baseY ?? 0;
          // v._buildBldEntitiesで直接entityを更新（React state更新なし→再レンダなし）
          const _applyShaftDrag = (td) => {
            const vv = viewerRef.current;
            if (!vv || vv.isDestroyed() || !vv._buildBldEntities) return;
            let movedBlds;
            if (_gnx !== 0 || _gny !== 0) {
              movedBlds = _bldSnap.map((blk, i) => {
                if (blk.buildingId !== bldSelected.buildingId) return blk;
                if (!bldMoveAsSet && i !== bldSelected.entIdx) return blk;
                return { ...blk, points: blk.points ? blk.points.map(p => ({...p, x: p.x + _gnx*td, y: p.y + _gny*td})) : blk.points };
              });
            } else if (_isZShaft || _isSolidZ) {
              const zDeltaM = td * METERS_PER_PX;
              movedBlds = _bldSnap.map((blk, i) => {
                if (blk.buildingId !== bldSelected.buildingId) return blk;
                if (!bldMoveAsSet && i !== bldSelected.entIdx) return blk;
                const _zT = blk.zTop    != null ? blk.zTop    : (blk.height || 40);
                const _zB = blk.zBottom != null ? blk.zBottom : 0;
                return { ...blk, zTop: _zT + zDeltaM, zBottom: _zB + zDeltaM };
              });
            } else if (_isSolidXY) {
              movedBlds = _bldSnap.map((blk, i) => {
                if (blk.buildingId !== bldSelected.buildingId) return blk;
                if (!bldMoveAsSet && i !== bldSelected.entIdx) return blk;
                return { ...blk, points: blk.points ? blk.points.map(p => ({...p, x: p.x + _solidDdx*td, y: p.y + _solidDdy*td})) : blk.points };
              });
            } else { return; }
            movedBldsRef.current = movedBlds; // 矢印追従用
            // [] + _csgOverride一時無効化でbldListパス強制（movedBldsが確実に使われる）
            const _ov = window._csgOverride; window._csgOverride = null;
            vv._buildBldEntities(vv, movedBlds, vv._siteBaseElevation||0, mode==='3d', []);
            window._csgOverride = _ov;
            vv.scene.requestRender();
          };
          const onMove = (me) => {
            const dmx = me.clientX - lastX, dmy = me.clientY - lastY;
            lastX = me.clientX; lastY = me.clientY;
            const as = arrowScreenRef.current;
            let screenDelta;
            if (as) {
              const adx = as.tipX - as.baseX, ady = as.tipY - as.baseY;
              const alen = Math.sqrt(adx * adx + ady * ady);
              screenDelta = alen > 1 ? (dmx * adx + dmy * ady) / alen : dmx;
            } else { screenDelta = dmx; }
            totalDelta += screenDelta / ppg;
            // shaftDragOffsetRef更新（矢印スライド用）
            if (_gnx !== 0 || _gny !== 0) {
              shaftDragOffsetRef.current = { dx: _gnx*totalDelta, dy: _gny*totalDelta, dz: 0 };
            } else if (_isZShaft || _isSolidZ) {
              shaftDragOffsetRef.current = { dx: 0, dy: 0, dz: totalDelta*METERS_PER_PX };
            } else if (_isSolidXY) {
              shaftDragOffsetRef.current = { dx: _solidDdx*totalDelta, dy: _solidDdy*totalDelta, dz: 0 };
            }
            _applyShaftDrag(totalDelta); // 直接entityを更新（Reactなし）。movedBldsRef.currentも設定される
            // 矢印をDOM直接更新（Reactを通さないので建屋と同速）
            const _mbS = movedBldsRef.current && movedBldsRef.current[bldSelected.entIdx];
            if (_mbS && arrowGroupRef.current) {
              const _aS = computeArrowScreen(_mbS, bldSelected.face, bldSelected, false);
              if (_aS) arrowGroupRef.current.setAttribute('transform', `translate(${_aS.baseX - _sOrigX},${_aS.baseY - _sOrigY})`);
            }
            // ヒントをDOMで直接更新
            const hEl = bldDragHintRef.current;
            if (hEl) {
              const dispMm = Math.round(totalDelta * METERS_PER_PX * 1000);
              const icon = (_isZShaft || _isSolidZ) ? '↕' : '↔';
              hEl.textContent = icon + ' ' + dispMm + 'mm';
              hEl.style.left = (me.clientX + 18) + 'px';
              hEl.style.top  = (me.clientY - 10) + 'px';
              hEl.style.display = 'block';
            }
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            clearGrabbing(); enableCam();
            // ドラッグ終了: 最終位置でReact state更新してtransformをリセット
            const _finalBldS = movedBldsRef.current && movedBldsRef.current[bldSelected.entIdx];
            isDraggingRef.current = false;
            shaftDragOffsetRef.current = null;
            movedBldsRef.current = null;
            if (arrowGroupRef.current) arrowGroupRef.current.setAttribute('transform', '');
            if (_finalBldS) {
              const _finalArrowS = computeArrowScreen(_finalBldS, bldSelected.face, bldSelected, false);
              if (_finalArrowS) updateArrowScreen(_finalArrowS);
            }
            const hEl = bldDragHintRef.current;
            if (hEl) hEl.style.display = 'none';
            // mouseupで1回だけstate確定
            if (Math.abs(totalDelta) > 0.001) {
              if (_gnx !== 0 || _gny !== 0) {
                onMoveBuilding(bldSelected.buildingId, bldSelected.blockIdx, _gnx*totalDelta, _gny*totalDelta);
              } else if (_isZShaft) {
                const zDelta = totalDelta*METERS_PER_PX;
                onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', zDelta, bldMoveAsSet);
                onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', zDelta, bldMoveAsSet);
              } else if (_isSolidZ) {
                const zDelta = totalDelta*METERS_PER_PX;
                onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', zDelta, bldMoveAsSet);
                onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', zDelta, bldMoveAsSet);
              } else if (_isSolidXY) {
                onMoveBuilding(bldSelected.buildingId, bldSelected.blockIdx, _solidDdx*totalDelta, _solidDdy*totalDelta);
              }
              const _shaftDxGrid = (_gnx !== 0||_gny !== 0) ? _gnx*totalDelta : (_isSolidXY ? _solidDdx*totalDelta : 0);
              const _shaftDyGrid = (_gnx !== 0||_gny !== 0) ? _gny*totalDelta : (_isSolidXY ? _solidDdy*totalDelta : 0);
              const _shaftDzM = (_isZShaft||_isSolidZ) ? totalDelta*METERS_PER_PX : 0;
              setBldSelected(prev => prev ? {
                ...prev,
                _faceCenterX: (prev._faceCenterX||0) + _shaftDxGrid,
                _faceCenterY: (prev._faceCenterY||0) + _shaftDyGrid,
                _faceCenterZ: (prev._faceCenterZ||0) + _shaftDzM,
              } : null);
            }
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };

        // ── 長押し加速ボタンヘルパー ──
        const startRepeat = (action) => {
          action();
          let count = 0, interval = 200;
          let timer = null;
          const tick = () => {
            count++;
            action(count);
            // 加速: 10回以上で100mm単位、20回以上で500mm
            if (count >= 20) interval = 30;
            else if (count >= 10) interval = 60;
            else if (count >= 5) interval = 100;
            timer = setTimeout(tick, interval);
          };
          timer = setTimeout(tick, 400); // 初回は長押し判定で少し待つ
          const stop = () => { if (timer) clearTimeout(timer); window.removeEventListener('mouseup', stop); window.removeEventListener('mouseleave', stop); };
          window.addEventListener('mouseup', stop);
          window.addEventListener('mouseleave', stop);
        };

        // mm→グリッドピクセル変換
        const mmToGrid = (mm) => mm / 1000 / METERS_PER_PX;

        // ── 面移動ボタン（ワンクリック1000mm、長押し加速）──
        const faceMoveBtn = (dir) => {
          if (!bldSelected || !onMoveBldFace) return;
          startRepeat((count = 0) => {
            let mm = 1000;
            if (count >= 20) mm = 10000;
            else if (count >= 10) mm = 5000;
            else if (count >= 5) mm = 2000;
            const isZ = bldSelected.face === 'zTop' || bldSelected.face === 'zBottom';
            let d = isZ ? dir * mm / 1000 : dir * mmToGrid(mm);
            const _blk = (blds || [])[bldSelected.entIdx];
            if (_blk && _blk._sharedWall && !isZ) d = -d;
            onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, bldSelected.face, d, bldMoveAsSet);
            if (faceInputRef.current) {
              const cur = parseFloat(faceInputRef.current.value) || 0;
              faceInputRef.current.value = String(cur + dir * mm);
            }
          });
        };

        // ── 建屋移動ボタン（ワンクリック1000mm、長押し加速）──
        const bldMoveBtn = (dir) => {
          if (!bldSelected || !onMoveBuilding) return;
          const blk = (blds || [])[bldSelected.entIdx];
          if (!blk) return;
          startRepeat((count = 0) => {
            let mm = 1000;
            if (count >= 20) mm = 10000;
            else if (count >= 10) mm = 5000;
            else if (count >= 5) mm = 2000;
            const isZ = bldSelected.face === 'zTop' || bldSelected.face === 'zBottom';
            if (isZ && onMoveBldFace) {
              const zDelta = dir * mm / 1000;
              onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', zDelta, bldMoveAsSet);
              onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', zDelta, bldMoveAsSet);
            } else if (typeof bldSelected.face === 'number') {
              const delta = dir * mmToGrid(mm);
              const pts = blk.points, n = pts.length;
              const p0 = pts[bldSelected.face], p1 = pts[(bldSelected.face + 1) % n];
              const ex = p1.x - p0.x, ey = p1.y - p0.y;
              const elen = Math.sqrt(ex * ex + ey * ey);
              if (elen > 0.001) {
                let gnx = ey / elen, gny = -ex / elen;
                const cx = pts.reduce((s, p) => s + p.x, 0) / n;
                const cy = pts.reduce((s, p) => s + p.y, 0) / n;
                const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                if ((mx - cx) * gnx + (my - cy) * gny < 0) { gnx = -gnx; gny = -gny; }
                onMoveBuilding(bldSelected.buildingId, bldSelected.blockIdx, gnx * delta, gny * delta);
              }
            }
            if (moveInputRef.current) {
              const cur = parseFloat(moveInputRef.current.value) || 0;
              moveInputRef.current.value = String(cur + dir * mm);
            }
          });
        };

        // ── 回転ボタン（入力欄も更新）──
        const rotateBtn = (dir) => {
          if (!bldSelected || !onRotateBuilding) return;
          const deg = dir;
          onRotateBuilding(bldSelected.buildingId, bldSelected.blockIdx, deg * Math.PI / 180);
          if (rotInputRef.current) {
            const cur = parseFloat(rotInputRef.current.value) || 0;
            rotInputRef.current.value = String(cur + dir);
          }
        };

        // ── 選択中の面に垂直な視点へ flyTo ──
        // 視点の計算は cmFaceFlyTarget が唯一の実装（canvas の LEFT_DOUBLE_CLICK と同じものを使う）
        const flyToSelectedFace = () => {
          const v = viewerRef.current;
          if (!v || v.isDestroyed() || !bldSelected) return;
          const blk = (blds || [])[bldSelected.entIdx];
          if (!blk) return;
          cmFlyToFace(v, blk, bldSelected, v._siteBaseElevation || 0);
        };

        // 入力フォームのスタイル
        const inputBoxStyle = {
          position: 'absolute', pointerEvents: 'auto', zIndex: 12,
          background: 'rgba(30,30,30,0.9)', borderRadius: 4, padding: '2px 3px',
          display: 'flex', alignItems: 'center', gap: 2,
          fontFamily: 'sans-serif', fontSize: 11, color: '#fff',
          border: '1px solid rgba(255,255,255,0.3)',
        };
        const btnStyle = {
          background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
          color: '#fff', borderRadius: 2, cursor: 'pointer', padding: '1px 5px',
          fontSize: 11, lineHeight: '16px', userSelect: 'none',
        };
        const inputStyle = {
          width: 52, background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.3)',
          color: '#fff', borderRadius: 2, padding: '1px 3px', fontSize: 11,
          textAlign: 'right', outline: 'none',
        };

        return (<>
          {/* SVG矢印 */}
          <svg style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: 10, overflow: 'visible',
          }}>
            <g ref={arrowGroupRef}>
            {/* 矢印の棒（ドラッグ → 建屋移動） */}
            <line x1={baseX} y1={baseY} x2={hx} y2={hy}
              stroke="transparent" strokeWidth={16}
              style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={(e) => { setGrabbing(); onShaftDown(e); }}
            />
            <line x1={baseX} y1={baseY} x2={hx} y2={hy}
              stroke="#000" strokeWidth={5} strokeLinecap="round" opacity={0.3} />
            <line x1={baseX} y1={baseY} x2={hx} y2={hy}
              stroke={color} strokeWidth={3} strokeLinecap="round" />
            {/* 矢じり（ドラッグ → 面伸縮） */}
            <polygon points={`${tipX},${tipY} ${h1x},${h1y} ${h2x},${h2y}`}
              fill="#000" opacity={0.3} transform="translate(0.5,0.5)" />
            <polygon points={`${tipX},${tipY} ${h1x},${h1y} ${h2x},${h2y}`}
              fill={color} stroke={color} strokeWidth={1}
              style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={(e) => { setGrabbing(); onHandleDown(e); }}
            />
            {/* 矢じり周囲の透明ヒットエリア（掴みやすく） */}
            <circle cx={tipX} cy={tipY} r={12}
              fill="transparent"
              style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={(e) => { setGrabbing(); onHandleDown(e); }}
            />
            <circle cx={baseX} cy={baseY} r={4}
              fill="#fff" stroke={color} strokeWidth={1.5} />
            {/* 回転ハンドル（基点に円弧矢印） */}
            {onRotateBuilding && (() => {
              const R = 24;
              const sa = -40 * Math.PI / 180, ea = 220 * Math.PI / 180;
              const x1r = baseX + R * Math.cos(sa), y1r = baseY + R * Math.sin(sa);
              const x2r = baseX + R * Math.cos(ea), y2r = baseY + R * Math.sin(ea);
              const arcPath = `M ${x1r} ${y1r} A ${R} ${R} 0 1 1 ${x2r} ${y2r}`;
              const at = ea + 0.15;
              const ax = baseX + R * Math.cos(at), ay = baseY + R * Math.sin(at);
              const bt = ea - 0.3;
              const bx = baseX + R * Math.cos(bt), by = baseY + R * Math.sin(bt);
              const onRotateDown = (re) => {
                re.preventDefault(); re.stopPropagation();
                if (!bldSelected || !onRotateBuilding) return;
                disableCam();
                const rect = containerRef.current.getBoundingClientRect();
                const centerX = rect.left + baseX, centerY = rect.top + baseY;
                let lastAngle = Math.atan2(re.clientY - centerY, re.clientX - centerX);
                const onRMove = (me) => {
                  const a = Math.atan2(me.clientY - centerY, me.clientX - centerX);
                  let da = a - lastAngle;
                  if (da > Math.PI) da -= 2 * Math.PI;
                  if (da < -Math.PI) da += 2 * Math.PI;
                  lastAngle = a;
                  onRotateBuilding(bldSelected.buildingId, bldSelected.blockIdx, da);
                };
                const onRUp = () => { window.removeEventListener('mousemove', onRMove); window.removeEventListener('mouseup', onRUp); clearGrabbing(); enableCam(); };
                window.addEventListener('mousemove', onRMove);
                window.addEventListener('mouseup', onRUp);
              };
              return (<g>
                <path d={arcPath} fill="none" stroke="#000" strokeWidth={4} opacity={0.3} />
                <path d={arcPath} fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth={2} />
                <polygon points={`${x2r},${y2r} ${ax},${ay} ${bx},${by}`} fill="rgba(255,255,255,0.8)" />
                <circle cx={baseX} cy={baseY} r={18}
                  fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.5)" strokeWidth={1} strokeDasharray="4,3"
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onMouseDown={(e) => { setGrabbing(); onRotateDown(e); }}
                  onDoubleClick={(e) => { e.stopPropagation(); flyToSelectedFace(); }}
                />
              </g>);
            })()}
            </g>
          </svg>

          {/* ── 操作パネル（左上固定 — コンテナと重ならないよう左配置）── */}
          <div style={{
            position: 'absolute', left: 8, top: 8,
            pointerEvents: 'auto', zIndex: 12,
            background: 'rgba(24,24,28,0.92)', borderRadius: 6, padding: '6px 8px',
            fontFamily: 'sans-serif', fontSize: 11, color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160,
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}>
            {/* 建屋名 */}
            {onRenameBuilding && bldSelected && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.15)', marginBottom: 0 }}>
                <span style={{ fontSize: 10, opacity: 0.6, whiteSpace: 'nowrap', flexShrink: 0 }}>名前</span>
                <input
                  style={{ flex: 1, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 3, color: '#fff', fontSize: 11, padding: '2px 5px', minWidth: 0, outline: 'none' }}
                  value={bldSelected.label || ''}
                  onChange={e => {
                    const v = e.target.value;
                    setBldSelected(prev => prev ? { ...prev, label: v } : null);
                    onRenameBuilding(bldSelected.buildingId, v);
                  }}
                />
              </div>
            )}
            {/* 回転 */}
            {onRotateBuilding && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 28, fontSize: 10, opacity: 0.6 }}>回転</span>
                <button style={btnStyle}
                  onMouseDown={(e) => { e.preventDefault(); startRepeat(() => rotateBtn(-1)); }}>◀</button>
                <input type="text" inputMode="numeric" ref={rotInputRef} style={inputStyle} defaultValue="0"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && bldSelected) {
                      const deg = parseFloat(rotInputRef.current?.value) || 0;
                      onRotateBuilding(bldSelected.buildingId, bldSelected.blockIdx, deg * Math.PI / 180);
                      if (rotInputRef.current) rotInputRef.current.value = '0';
                    }
                  }}
                />
                <span style={{ fontSize: 10, opacity: 0.6 }}>°</span>
                <button style={btnStyle}
                  onMouseDown={(e) => { e.preventDefault(); startRepeat(() => rotateBtn(1)); }}>▶</button>
              </div>
            )}
            {/* 面移動 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 28, fontSize: 10, opacity: 0.6 }}>面</span>
              <button style={btnStyle}
                onMouseDown={(e) => { e.preventDefault(); faceMoveBtn(-1); }}>◀</button>
              <input type="text" inputMode="numeric" ref={faceInputRef} style={inputStyle} defaultValue="0"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && bldSelected && onMoveBldFace) {
                    const mm = parseFloat(faceInputRef.current?.value) || 0;
                    const isZ = bldSelected.face === 'zTop' || bldSelected.face === 'zBottom';
                    let d = isZ ? mm / 1000 : mmToGrid(mm);
                    const _blk = (blds || [])[bldSelected.entIdx];
                    if (_blk && _blk._sharedWall && !isZ) d = -d;
                    onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, bldSelected.face, d, bldMoveAsSet);
                    if (faceInputRef.current) faceInputRef.current.value = '0';
                  }
                }}
              />
              <span style={{ fontSize: 10, opacity: 0.6 }}>mm</span>
              <button style={btnStyle}
                onMouseDown={(e) => { e.preventDefault(); faceMoveBtn(1); }}>▶</button>
            </div>
            {/* 建屋移動 */}
            {onMoveBuilding && (typeof face === 'number' || face === 'zTop' || face === 'zBottom') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 28, fontSize: 10, opacity: 0.6 }}>移動</span>
                <button style={btnStyle}
                  onMouseDown={(e) => { e.preventDefault(); bldMoveBtn(-1); }}>◀</button>
                <input type="text" inputMode="numeric" ref={moveInputRef} style={inputStyle} defaultValue="0"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && bldSelected && onMoveBuilding) {
                      const mm = parseFloat(moveInputRef.current?.value) || 0;
                      const blk = (blds || [])[bldSelected.entIdx];
                      if (!blk) return;
                      const isZ = bldSelected.face === 'zTop' || bldSelected.face === 'zBottom';
                      if (isZ && onMoveBldFace) {
                        onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', mm / 1000, bldMoveAsSet);
                        onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', mm / 1000, bldMoveAsSet);
                      } else if (typeof bldSelected.face === 'number') {
                        const pts = blk.points, n = pts.length;
                        const p0 = pts[bldSelected.face], p1 = pts[(bldSelected.face + 1) % n];
                        const ex = p1.x - p0.x, ey = p1.y - p0.y;
                        const elen = Math.sqrt(ex * ex + ey * ey);
                        if (elen > 0.001) {
                          let gnx = ey / elen, gny = -ex / elen;
                          const cx = pts.reduce((s, p) => s + p.x, 0) / n;
                          const cy = pts.reduce((s, p) => s + p.y, 0) / n;
                          const mx2 = (p0.x + p1.x) / 2, my2 = (p0.y + p1.y) / 2;
                          if ((mx2 - cx) * gnx + (my2 - cy) * gny < 0) { gnx = -gnx; gny = -gny; }
                          onMoveBuilding(bldSelected.buildingId, bldSelected.blockIdx, gnx * mmToGrid(mm), gny * mmToGrid(mm));
                        }
                      }
                      if (moveInputRef.current) moveInputRef.current.value = '0';
                    }
                  }}
                />
                <span style={{ fontSize: 10, opacity: 0.6 }}>mm</span>
                <button style={btnStyle}
                  onMouseDown={(e) => { e.preventDefault(); bldMoveBtn(1); }}>▶</button>
              </div>
            )}
            {/* 地上0mリセットボタン */}
            {onMoveBldFace && (face === 'zTop' || face === 'zBottom') && (() => {
              const blk = (blds || [])[bldSelected.entIdx];
              const currentZBottom = blk ? (blk.zBottom || 0) : 0;
              return currentZBottom !== 0 ? (
                <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2 }}
                  onClick={() => {
                    const resetDelta = -currentZBottom;
                    onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', resetDelta, bldMoveAsSet);
                    onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', resetDelta, bldMoveAsSet);
                  }}>地上0mに戻す</button>
              ) : null;
            })()}
            {/* 親の面に揃えるボタン */}
            {onMoveBldFace && (() => {
              const blk = (blds || [])[bldSelected.entIdx];
              if (!blk || blk._parentBlockIdx == null) return null;
              const bid = blk.buildingId;
              const siblings = (blds || []).filter(b => b.buildingId === bid);
              const parent = siblings.find(s => s.blockIdx === blk._parentBlockIdx);
              if (!parent) return null;
              const myZBot = blk.zBottom || 0;
              const myZTop = blk.zTop != null ? blk.zTop : 40;
              const pZBot = parent.zBottom || 0;
              const pZTop = parent.zTop != null ? parent.zTop : 40;
              const isZ = face === 'zTop' || face === 'zBottom';
              return (<>
                {face === 'zBottom' && Math.abs(myZBot - pZBot) > 0.01 && (
                  <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2 }}
                    onClick={() => {
                      const d = pZBot - myZBot;
                      onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', d);
                      onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', d);
                    }}>親の底面に揃える</button>
                )}
                {face === 'zTop' && Math.abs(myZTop - pZTop) > 0.01 && (
                  <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2 }}
                    onClick={() => {
                      const d = pZTop - myZTop;
                      onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', d);
                      onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', d);
                    }}>親の上面に揃える</button>
                )}
                {onMergeBlockIntoParent && (
                  <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2, background: '#2563eb' }}
                    onClick={() => {
                      const bid = bldSelected.buildingId, bi = bldSelected.blockIdx;
                      setBldSelected(null);
                      updateArrowScreen(null);
                      setTimeout(() => onMergeBlockIntoParent(bid, bi), 0);
                    }}>親ブロックに合体</button>
                )}
              </>);
            })()}
            {/* 面位置リセットボタン */}
            {originalBlockRef.current && (() => {
              const blk = (blds || [])[bldSelected.entIdx];
              if (!blk) return null;
              const orig = originalBlockRef.current;
              const isZ = face === 'zTop' || face === 'zBottom';
              let hasMoved = false;
              if (isZ) {
                hasMoved = (blk.zBottom || 0) !== orig.zBottom || (blk.zTop != null ? blk.zTop : 40) !== orig.zTop;
              } else {
                hasMoved = blk.points.some((p, i) => orig.points[i] && (Math.abs(p.x - orig.points[i].x) > 0.01 || Math.abs(p.y - orig.points[i].y) > 0.01));
              }
              if (!hasMoved) return null;
              return (
                <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2,
                  background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.6)' }}
                  onClick={() => {
                    if (isZ && onMoveBldFace) {
                      const dTop = orig.zTop - (blk.zTop != null ? blk.zTop : 40);
                      const dBot = orig.zBottom - (blk.zBottom || 0);
                      onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zTop', dTop, bldMoveAsSet);
                      onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, 'zBottom', dBot, bldMoveAsSet);
                    } else if (onSetBlockPoints) {
                      onSetBlockPoints(bldSelected.buildingId, bldSelected.blockIdx, orig.points);
                    }
                  }}>移動を元に戻す</button>
              );
            })()}
            {/* 突起を元に戻すボタン（統合変形で作成した突起） */}
            {onRevertExtrude && (() => {
              const blk = (blds || [])[bldSelected.entIdx];
              if (!blk || !blk._preExtrudePoints) return null;
              return (
                <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2,
                  background: 'rgba(249,115,22,0.25)', border: '1px solid rgba(249,115,22,0.6)' }}
                  onClick={() => {
                    onRevertExtrude(bldSelected.buildingId, bldSelected.blockIdx);
                  }}>突起を元に戻す</button>
              );
            })()}
            {/* ブロック削除ボタン（別ブロックとして追加された突起等） */}
            {onDeleteBlock && (() => {
              const blk = (blds || [])[bldSelected.entIdx];
              if (!blk || (blk._blockCount || 1) <= 1) return null;
              return (
                <button style={{ ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2,
                  background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.6)' }}
                  onClick={() => {
                    onDeleteBlock(bldSelected.buildingId, bldSelected.blockIdx);
                    setBldSelected(null);
                    updateArrowScreen(null);
                  }}>このブロックを削除</button>
              );
            })()}
            {/* 面を伸縮ボタン（突起/削り出し統合 — ドラッグ方向で自動判定） */}
            {onAddBlock && (
              <button style={{
                ...btnStyle, fontSize: 10, padding: '3px 8px', marginTop: 2,
                background: 'rgba(59,130,246,0.25)', border: '1px solid rgba(59,130,246,0.6)',
              }}
                onClick={() => {
                  setFaceSketchPhase('rectdraw');
                  setFaceSketchPts([]);
                  setFaceSketchDepth(0);
                }}>面を伸縮</button>
            )}
            {/* セット移動/単体移動 切替 */}
            {(() => {
              const blk = (blds || [])[bldSelected.entIdx];
              if (!blk || (blk._blockCount || 1) <= 1) return null;
              return (
                <button style={{
                  ...btnStyle, fontSize: 10, padding: '2px 6px', marginTop: 2,
                  background: bldMoveAsSet ? 'rgba(168,85,247,0.35)' : 'rgba(100,100,100,0.35)',
                  border: `1px solid ${bldMoveAsSet ? 'rgba(168,85,247,0.7)' : 'rgba(150,150,150,0.6)'}`,
                }}
                  onClick={() => setBldMoveAsSet(prev => !prev)}
                >{bldMoveAsSet ? 'セット移動中' : '単体移動中'}</button>
              );
            })()}
            {/* デバッグ: 親子関係表示 */}
            <div style={{ fontSize: 9, color: '#f97316', marginTop: 2 }}>
              {(() => {
                const blk = (blds || [])[bldSelected.entIdx];
                if (!blk) return null;
                const bid = blk.buildingId;
                const siblings = (blds || []).filter(b => b.buildingId === bid);
                return siblings.map((s, si) => (
                  <div key={si}>blk{s.blockIdx}: parent={String(s._parentBlockIdx)}</div>
                ));
              })()}
            </div>
          </div>
        </>);
      } catch(e) { console.error('[ARROW_BLOCK] レンダリングエラー', e.message); return null; }
      })()}
      {/* 押し出し矢印オーバーレイ */}
      {faceSketchPhase === 'extrude' && extrudeArrow && (() => {
        const { baseX, baseY, tipX, tipY, dirX, dirY } = extrudeArrow;
        const depthM = faceSketchDepth / 1000;
        // 深さに応じた矢印先端位置
        const ppg = (() => {
          const v = viewerRef.current;
          if (!v || v.isDestroyed() || faceSketchPts.length < 1) return 1;
          const p = faceSketchPts[0];
          const baseElev = v._siteBaseElevation || 0;
          const g0 = gridToScreen(p.gx, p.gy, p.gz + baseElev);
          const face = bldSelected?.face;
          if (face === 'zTop' || face === 'zBottom') {
            const g1 = gridToScreen(p.gx, p.gy, p.gz + baseElev + 1);
            if (g0 && g1) return Math.sqrt((g1.x - g0.x) ** 2 + (g1.y - g0.y) ** 2);
          } else {
            const g1 = gridToScreen(p.gx + 1, p.gy, p.gz + baseElev);
            if (g0 && g1) return Math.sqrt((g1.x - g0.x) ** 2 + (g1.y - g0.y) ** 2);
          }
          return 1;
        })();
        // 深さに応じた先端 (depthGrid = 深さをグリッドまたはメートル単位でppgを使い画面距離に変換)
        const face = bldSelected?.face;
        const isZ = face === 'zTop' || face === 'zBottom';
        const depthScreenPx = isZ ? depthM * ppg : (depthM / METERS_PER_PX) * ppg;
        const aTipX = baseX + dirX * depthScreenPx;
        const aTipY = baseY + dirY * depthScreenPx;
        // 矢印常に最低60px表示（方向を見せるため）
        const aLen = Math.sqrt((aTipX - baseX) ** 2 + (aTipY - baseY) ** 2);
        const showTipX = aLen > 20 ? aTipX : baseX + dirX * 60;
        const showTipY = aLen > 20 ? aTipY : baseY + dirY * 60;
        const headLen = 14, headW = 7;
        const aLenFinal = Math.sqrt((showTipX - baseX) ** 2 + (showTipY - baseY) ** 2);
        const anx = aLenFinal > 0 ? (showTipX - baseX) / aLenFinal : dirX;
        const any = aLenFinal > 0 ? (showTipY - baseY) / aLenFinal : dirY;
        const hx = showTipX - anx * headLen, hy = showTipY - any * headLen;
        const perpX = -any, perpY = anx;
        const h1x = hx + perpX * headW, h1y = hy + perpY * headW;
        const h2x = hx - perpX * headW, h2y = hy - perpY * headW;

        const setGrabbing = () => {
          if (!document.getElementById('__grab_style')) {
            const s = document.createElement('style');
            s.id = '__grab_style';
            s.textContent = '* { cursor: grabbing !important; }';
            document.head.appendChild(s);
          }
        };
        const clearGrabbing = () => { const s = document.getElementById('__grab_style'); if (s) s.remove(); };
        const disableCam = () => { const v = viewerRef.current; if (v && !v.isDestroyed()) { v.scene.screenSpaceCameraController.enableRotate = false; v.scene.screenSpaceCameraController.enableTranslate = false; v.scene.screenSpaceCameraController.enableZoom = false; } };
        const enableCam = () => { const v = viewerRef.current; if (v && !v.isDestroyed()) { v.scene.screenSpaceCameraController.enableRotate = true; v.scene.screenSpaceCameraController.enableTranslate = true; v.scene.screenSpaceCameraController.enableZoom = true; } };

        const onDragDown = (e) => {
          e.preventDefault(); e.stopPropagation();
          setGrabbing(); disableCam();
          const startX = e.clientX, startY = e.clientY;
          const startDepth = faceSketchDepth;
          const onMove = (ev) => {
            const mdx = ev.clientX - startX, mdy = ev.clientY - startY;
            // マウス移動を矢印方向に投影
            const proj = mdx * dirX + mdy * dirY;
            // 画面px → mm
            const mmPerPx = isZ ? (1000 / ppg) : (METERS_PER_PX * 1000 / ppg);
            setFaceSketchDepth(Math.round(startDepth + proj * mmPerPx));
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            clearGrabbing(); enableCam();
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };

        return (
          <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}>
            {/* 矢印軸 */}
            <line x1={baseX} y1={baseY} x2={showTipX} y2={showTipY}
              stroke="#000" strokeWidth={5} opacity={0.3} style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={onDragDown} />
            <line x1={baseX} y1={baseY} x2={showTipX} y2={showTipY}
              stroke="#22c55e" strokeWidth={3} style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={onDragDown} />
            {/* 矢印先端 */}
            <polygon points={`${showTipX},${showTipY} ${h1x},${h1y} ${h2x},${h2y}`}
              fill="#22c55e" stroke="#000" strokeWidth={1}
              style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={onDragDown} />
            {/* 基点マーカー */}
            <circle cx={baseX} cy={baseY} r={5} fill="#22c55e" stroke="#000" strokeWidth={1.5} />
            {/* 深さ表示 */}
            <text x={baseX + dirX * 20 + perpX * 18} y={baseY + dirY * 20 + perpY * 18}
              fill="#fff" stroke="#000" strokeWidth={3} paintOrder="stroke"
              fontSize={13} fontWeight={700} fontFamily="sans-serif" textAnchor="middle"
              style={{ pointerEvents: 'none' }}>
              {Math.round(faceSketchDepth)}mm
            </text>
          </svg>
        );
      })()}
      {/* ── Push/Pull モード ── */}
      {faceSketchPhase === 'pushpull' && bldSelected && (() => { try {
        const face = bldSelected.face;
        const _isZsolid2 = bldSelected._solidNormal && Math.abs(bldSelected._solidNormal.nz) > 0.5;
        const isZ = face === 'zTop' || face === 'zBottom' || _isZsolid2;
        // solidFaceId('f123'等)の場合はppFi=-1（edgeIdx不使用）
        const _isSolidFace = typeof face === 'string' && face.startsWith('f');
        const ppFi = (!isZ && !_isSolidFace) ? (typeof face === 'number' ? face : parseInt(face, 10)) : -1;
        // 内向きクランプ値を事前計算（親箱内部方向の最大深さ）
        let ppMinDepthMm = -Infinity; // 負方向の限界
        let ppMaxDepthMm = Infinity;  // 正方向の限界
        if (!isZ && !_isSolidFace) {
          const _blk = (blds || [])[bldSelected.entIdx];
          if (_blk && _blk._sharedWall && _blk._parentBlockIdx != null) {
            const sw = _blk._sharedWall;
            const parent = (blds || []).find(b => b.buildingId === _blk.buildingId && b.blockIdx === sw.parentBlockIdx);
            if (parent && sw.parentEdge != null) {
              const parPts = parent.points, parN = parPts.length;
              const pe = sw.parentEdge;
              const pe0 = parPts[pe], pe1 = parPts[(pe + 1) % parN];
              const pex = pe1.x - pe0.x, pey = pe1.y - pe0.y;
              const pelen = Math.sqrt(pex * pex + pey * pey);
              if (pelen > 0.001) {
                let pnx = pey / pelen, pny = -pex / pelen;
                const pcx = parPts.reduce((s, p) => s + p.x, 0) / parN;
                const pcy = parPts.reduce((s, p) => s + p.y, 0) / parN;
                const pmx = (pe0.x + pe1.x) / 2, pmy = (pe0.y + pe1.y) / 2;
                if ((pmx - pcx) * pnx + (pmy - pcy) * pny < 0) { pnx = -pnx; pny = -pny; }
                let maxDepthGrid = 0;
                for (let pi = 0; pi < parN; pi++) {
                  const d = -((parPts[pi].x - pe0.x) * pnx + (parPts[pi].y - pe0.y) * pny);
                  if (d > maxDepthGrid) maxDepthGrid = d;
                }
                // pushpullの面法線: CSG補正済みをbldSelectedから取得
                const pts_ = _blk.points, n_ = pts_.length;
                const p0_ = pts_[ppFi], p1_ = pts_[(ppFi + 1) % n_];
                const mx_ = (p0_.x + p1_.x) / 2, my_ = (p0_.y + p1_.y) / 2;
                let nx_, ny_;
                if (bldSelected && bldSelected.csgNx != null) {
                  nx_ = bldSelected.csgNx; ny_ = bldSelected.csgNy;
                } else {
                  nx_ = (p1_.y - p0_.y); ny_ = -(p1_.x - p0_.x);
                  const len_ = Math.sqrt(nx_ * nx_ + ny_ * ny_);
                  if (len_ > 0.01) { nx_ /= len_; ny_ /= len_; }
                  const cx_ = pts_.reduce((s, p) => s + p.x, 0) / n_;
                  const cy_ = pts_.reduce((s, p) => s + p.y, 0) / n_;
                  if ((mx_ - cx_) * nx_ + (my_ - cy_) * ny_ < 0) { nx_ = -nx_; ny_ = -ny_; }
                }
                // ルート親を取得
                let rootParent = parent;
                while (rootParent._parentBlockIdx != null) {
                  const rp = (blds || []).find(b => b.buildingId === _blk.buildingId && b.blockIdx === rootParent._parentBlockIdx);
                  if (rp) rootParent = rp; else break;
                }
                const rpPts = rootParent.points, rpN = rpPts.length;
                // CSG補正済み法線 = 箱の外向き → normalInward=false
                const normalInward = false;
                // 内向き方向の限界 = 現在の面からルート親の反対面までの距離
                // 法線が内向きなら nx_方向にルート親の全頂点を投影し、面中点からの最大距離を取得
                const inwardNx = normalInward ? nx_ : -nx_;
                const inwardNy = normalInward ? ny_ : -ny_;
                let maxInwardDist = 0;
                for (let pi = 0; pi < rpN; pi++) {
                  const d = (rpPts[pi].x - mx_) * inwardNx + (rpPts[pi].y - my_) * inwardNy;
                  if (d > maxInwardDist) maxInwardDist = d;
                }
                const limitMm = (maxInwardDist - 0.02) * METERS_PER_PX * 1000;
                if (normalInward) {
                  ppMaxDepthMm = limitMm;
                } else {
                  ppMinDepthMm = -limitMm;
                }
                console.warn('[PP_CLAMP] setup', { normalInward, limitMm: limitMm.toFixed(0), maxInwardDist: maxInwardDist.toFixed(1), ppMinDepthMm: ppMinDepthMm.toFixed(0), ppMaxDepthMm: ppMaxDepthMm.toFixed(0) });
              }
            }
          }
        }
        // ── solid面: 削り深度の最大値を計算（面の反対側の固体境界まで）──
        if (_isSolidFace && bldSelected.solidFaceId) {
          const _cs = (viewerRef.current && viewerRef.current._currentSolids) || [];
          const _ts = _cs.find(s => s.buildingId === bldSelected.buildingId);
          if (_ts) {
            const _tf = _ts.faces.find(f => f.id === bldSelected.solidFaceId);
            if (_tf && _tf.normal && _tf.vertices && _tf.vertices.length > 0) {
              const { nx, ny, nz } = _tf.normal;
              const M = METERS_PER_PX;
              const P0 = _tf.vertices[0];
              // 深さ方向ベクトル V = (nx/M, ny/M, nz) — pushPullRectの変位式 (nx*d/M, ny*d/M, nz*d) に対応
              const vx = nx/M, vy = ny/M, vz = nz;
              const vLen2 = vx*vx + vy*vy + vz*vz;
              if (vLen2 > 1e-10) {
                let minD = 0;
                for (const f2 of _ts.faces) {
                  if (f2.id === bldSelected.solidFaceId) continue;
                  for (const vv of f2.vertices) {
                    const dot = (vv.x - P0.x)*vx + (vv.y - P0.y)*vy + (vv.z - P0.z)*vz;
                    const dQ = dot / vLen2;
                    if (dQ < -0.01 && dQ < minD) minD = dQ;
                  }
                }
                if (minD < 0) {
                  ppMinDepthMm = minD * 1000; // 削り限界(mm) — 反対側の固体境界まで
                  console.warn('[PP_CLAMP_SOLID] setup', { solidFaceId: bldSelected.solidFaceId, ppMinDepthMm: ppMinDepthMm.toFixed(0) });
                }
              }
            }
          }
        }
        const onPPMove = (e) => {
          try {
          // デルタベース: 前回からのカーソル移動量で深さを変更
          if (!pushPullRef.current) {
            console.warn('[PP_MOVE] init pushPullRef', { clientX: e.clientX, clientY: e.clientY, face, bldSelected });
            pushPullRef.current = { lastX: e.clientX, lastY: e.clientY };
            return;
          }
          const dmx = e.clientX - pushPullRef.current.lastX;
          const dmy = e.clientY - pushPullRef.current.lastY;
          pushPullRef.current.lastX = e.clientX;
          pushPullRef.current.lastY = e.clientY;
          const v = viewerRef.current;
          if (!v || v.isDestroyed()) return;

          // ★ solidFaceId対応: solid面法線でドラッグ量を計算
          if (bldSelected.solidFaceId && bldSelected._solidNormal) {
            try {
              const sn = bldSelected._solidNormal;
              const fcx = bldSelected._faceCenterX, fcy = bldSelected._faceCenterY, fcz = bldSelected._faceCenterZ;
              if (fcx == null || fcy == null || fcz == null) return;
              const baseElev = v._siteBaseElevation || 0;
              const bS = gridToScreen(fcx, fcy, baseElev + fcz);
              const tS = gridToScreen(fcx + sn.nx * 10, fcy + sn.ny * 10, baseElev + fcz + sn.nz * 10);
              if (!bS || !tS) return;
              const ndx = tS.x - bS.x, ndy = tS.y - bS.y;
              const nLen = Math.sqrt(ndx * ndx + ndy * ndy);
              if (nLen < 0.5) return;
              const proj = (dmx * ndx + dmy * ndy) / nLen;
              const g0 = gridToGeo(fcx, fcy), g1 = gridToGeo(fcx + 1, fcy);
              const s0 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, baseElev + fcz));
              const s1 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, baseElev + fcz));
              if (!s0 || !s1) return;
              const ppg = Math.sqrt((s1.x - s0.x) ** 2 + (s1.y - s0.y) ** 2);
              if (ppg < 0.01) return;
              const depthDelta = proj / ppg * METERS_PER_PX;
              if (Math.abs(depthDelta) < 0.001) return;
              setFaceSketchDepth(prev => {
                const newD = prev + depthDelta * 1000;
                return Math.max(ppMinDepthMm, Math.min(ppMaxDepthMm, newD));
              });
            } catch(e) { console.warn('[PP_MOVE_SOLID] エラー', e.message); }
            return;
          }

          if (!onMoveBldFace) return;
          const blk = (blds || [])[bldSelected.entIdx];
          if (!blk) return;
          const pts = blk.points;
          const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
          const baseElev = v._siteBaseElevation || 0;
          const zMid = baseElev + ((blk.zTop != null ? blk.zTop : 40) + (blk.zBottom || 0)) / 2;
          const g0 = gridToGeo(cx, cy), g1 = gridToGeo(cx + 1, cy);
          const s0 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, zMid));
          const s1 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, zMid));
          if (!s0 || !s1) return;
          const ppg = Math.sqrt((s1.x - s0.x) ** 2 + (s1.y - s0.y) ** 2);
          if (ppg < 0.01) return;
          let screenDelta;
          if (isZ) {
            // Z面: マウス上=面が上に動く、マウス下=面が下に動く
            // 面の種類(zTop/zBottom)に依存しない統一規約
            screenDelta = -dmy;
          } else if (ppFi >= 0 && ppFi < pts.length) {
            // 面エッジの垂線にマウス移動を投影
            const _p0 = pts[ppFi], _p1 = pts[(ppFi + 1) % pts.length];
            const _ge0 = gridToGeo(_p0.x, _p0.y), _ge1 = gridToGeo(_p1.x, _p1.y);
            const _se0 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
              Cesium.Cartesian3.fromDegrees(_ge0.lng, _ge0.lat, zMid));
            const _se1 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
              Cesium.Cartesian3.fromDegrees(_ge1.lng, _ge1.lat, zMid));
            if (!_se0 || !_se1) { screenDelta = dmx; }
            else {
              const edx = _se1.x - _se0.x, edy = _se1.y - _se0.y;
              const eLen = Math.sqrt(edx * edx + edy * edy);
              if (eLen < 1) { screenDelta = dmx; }
              else {
                // CSG補正済み法線を使用（bldSelectedに保存済み）
                let nx, ny;
                if (bldSelected && bldSelected.csgNx != null) {
                  nx = bldSelected.csgNx; ny = bldSelected.csgNy;
                } else {
                  ({ nx, ny } = edgeNormalGrid(pts, ppFi));
                }
                // 法線方向の画面ベクトルを直接計算
                const _gmx = (_p0.x + _p1.x) / 2, _gmy = (_p0.y + _p1.y) / 2;
                const _gN = gridToGeo(_gmx + nx * 5, _gmy + ny * 5);
                const _sN = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
                  Cesium.Cartesian3.fromDegrees(_gN.lng, _gN.lat, zMid));
                const _sM = { x: (_se0.x + _se1.x) / 2, y: (_se0.y + _se1.y) / 2 };
                if (_sN) {
                  // 法線方向の画面ベクトル(_sM→_sN)の単位ベクトルにマウス移動を投影
                  const _ndx = _sN.x - _sM.x, _ndy = _sN.y - _sM.y;
                  const _nlen = Math.sqrt(_ndx * _ndx + _ndy * _ndy);
                  if (_nlen > 0.5) {
                    const _ux = _ndx / _nlen, _uy = _ndy / _nlen;
                    screenDelta = dmx * _ux + dmy * _uy;
                  } else {
                    screenDelta = dmx;
                  }
                } else {
                  screenDelta = dmx;
                }
              }
            }
          }
          const delta = isZ ? screenDelta / ppg * METERS_PER_PX : screenDelta / ppg;
          if (Math.abs(delta) < 0.005) return;
          // プレビュー方式: onMoveBldFaceは呼ばず、faceSketchDepthのみ更新
          // （確定時にまとめて適用する。毎フレームの全エンティティ再構築を回避）
          const deltaMm = isZ ? delta * 1000 : delta * METERS_PER_PX * 1000;
          setFaceSketchDepth(prev => {
            let newD = prev + deltaMm;
            // 内向き（削り出し）は親箱の端で停止、外向き（引き抜き）は自由
            if (newD < ppMinDepthMm) newD = ppMinDepthMm;
            if (newD > ppMaxDepthMm) newD = ppMaxDepthMm;
            return newD;
          });
          } catch(e) { console.warn('[PP_MOVE] エラー', e.message); }
        };
        const cancelPP = () => {
          const blk = (blds || [])[bldSelected.entIdx];
          // Z面pushpullはプレビューのみ（子ブロック不使用）なので復元不要
          setBldSelected(null);
          setFaceSketchPhase(null);
          setFaceSketchDepth(0);
          pushPullRef.current = null;
          originalBlockRef.current = null;
        };
        const confirmPP = () => {
          // _currentSolidsを確定直前に最新状態へ強制同期（タイミングズレによるSolid未発見の防止）
          const _v = viewerRef.current;
          if (_v && !_v.isDestroyed() && solids && solids.length > 0) {
            _v._currentSolids = solids;
          }
          const origBlk = originalBlockRef.current;
          const blk = (blds || [])[bldSelected.entIdx];
          console.warn('═══════ [PP_CONFIRM] 矩形伸縮 確定 ═══════');
          // 削り出し前のundo snapshotを保存（アンドゥで「削り出し前の箱」に戻れるように）
          if (onBldPushUndo) {
            onBldPushUndo();
            console.warn('[PP_UNDO] undo snapshot保存完了');
          } else {
            console.warn('[PP_UNDO] onBldPushUndoが未定義!');
          }
          const _ppMsg1 = {
            faceSketchDepthMm: Math.round(faceSketchDepth) + 'mm',
            faceSketchDepthM: (faceSketchDepth/1000).toFixed(3) + 'm',
            face, isZ, ppFi,
          };
          console.warn('[PP_CONFIRM] 距離', _ppMsg1);
          if (!window._diagLog) window._diagLog = [];
          window._diagLog.push('═══ [PP_CONFIRM] 矩形伸縮 確定 ═══');
          window._diagLog.push('[PP_CONFIRM] 距離 ' + JSON.stringify(_ppMsg1));
          if (window._diagLog.length > 200) window._diagLog.shift();
          console.warn('[PP_CONFIRM] 操作対象ブロック', {
            buildingId: bldSelected?.buildingId,
            blockIdx: bldSelected?.blockIdx,
            isChild: blk?._parentBlockIdx != null,
            isChild: blk?._parentBlockIdx != null,
            parentBlockIdx: blk?._parentBlockIdx,
            sharedWall: blk?._sharedWall ? `parentEdge=${blk._sharedWall.parentEdge} u=${blk._sharedWall.uMin?.toFixed(1)}..${blk._sharedWall.uMax?.toFixed(1)}` : null,
            現在zB: (blk?.zBottom||0).toFixed(2),
            現在zT: (blk?.zTop||40).toFixed(2),
            現在厚さ: ((blk?.zTop||40)-(blk?.zBottom||0)).toFixed(2),
            変形前pts: origBlk?.points?.map((p, i) => `v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})`),
          });
          if (faceSketchDepth !== 0 && origBlk && blk) {
            const depthM = Math.max(ppMinDepthMm / 1000, Math.min(ppMaxDepthMm / 1000, faceSketchDepth / 1000));
            const zPushRect = origBlk._zPushRect;
            try { // ── 全操作をtry-catchで保護 ──
            if (isZ && zPushRect) {
              // ═══ 矩形pushpull: pushPullRectでSolidを直接変形 ═══
              const rect2d = zPushRect;
              const zB = origBlk.zBottom, zT = origBlk.zTop;
              // solidFaceIdがある場合はsolid面のz値を使用
              let selZ;
              if (bldSelected.solidFaceId) {
                const _cs = (viewerRef.current && viewerRef.current._currentSolids) || solids || [];
                const _ts = _cs.find(s => s.buildingId === bldSelected.buildingId);
                const _tf = _ts && _ts.faces.find(f => f.id === bldSelected.solidFaceId);
                selZ = _tf ? _tf.vertices[0].z : (face === 'zTop' ? zT : zB);
              } else {
                selZ = face === 'zTop' ? zT : zB;
              }
              const rect3d = rect2d.map(p => ({ x: p.x, y: p.y, z: selZ }));

              const currentSolids2 = (viewerRef.current && viewerRef.current._currentSolids) || solids || [];
              const targetSolid2 = currentSolids2.find(s => s.buildingId === bldSelected.buildingId);
              if (targetSolid2) {
                // solidFaceIdが直接指定されていればそれを使う、なければ従来方式
                let targetFaceId2 = bldSelected.solidFaceId || null;
                // 面IDがSOLID_SYNC後に失効している場合はtypeでfallback
                if (targetFaceId2 && !targetSolid2.faces.some(f => f.id === targetFaceId2)) {
                  targetFaceId2 = null;
                }
                if (!targetFaceId2) {
                  if (face === 'zTop') {
                    const f = targetSolid2.faces.find(f => f.type === 'top');
                    if (f) targetFaceId2 = f.id;
                  } else if (face === 'zBottom') {
                    const f = targetSolid2.faces.find(f => f.type === 'bottom');
                    if (f) targetFaceId2 = f.id;
                  }
                }
                if (targetFaceId2) {
                  const newSolid2 = pushPullRect(targetSolid2, targetFaceId2, rect3d, depthM);
                  console.warn('[PP_RECT_SOLID] pushPullRect適用', {
                    face, depth: depthM.toFixed(3),
                    旧面数: targetSolid2.faces.length, 新面数: newSolid2.faces.length,
                  });
                  _dumpSolidFaces(newSolid2, depthM<0?'削り出し':'突起');
                  const updatedSolids = currentSolids2.map(s => s.id === targetSolid2.id ? newSolid2 : s);
                  // ① 即座に描画更新（React待たない）
                  try {
                    const v = viewerRef.current;
                    console.warn('[PP_RENDER] 直接描画', { v: !!v, solidCount: updatedSolids.length, bld4面数: newSolid2.faces.length });
                    if (v && v._buildBldEntities) {
                      v._buildBldEntities(v, blds || [], v._siteBaseElevation || 0, mode === '3d', updatedSolids);
                      v.scene.requestRender();
                    }
                  } catch(e) { console.warn('[PP_RENDER] エラー', e.message); }
                  // ② React state更新（次回render用）
                  try {
                    if (setSolidsDirect) setSolidsDirect(updatedSolids);
                    else setSolids(updatedSolids);
                  } catch(e) { console.warn('[PP_STATE] エラー', e.message); }
                } else {
                  console.warn('[PP_RECT_SOLID] 面ID特定失敗');
                }
              } else {
                console.warn('[PP_RECT_SOLID] Solid未発見');
              }
            } else if (origBlk._solidRect3d && bldSelected.solidFaceId) {
              // ═══ solid壁面 + 矩形 → pushPullRectで削り出し ═══
              const rect3d = origBlk._solidRect3d;
              const cs = (viewerRef.current && viewerRef.current._currentSolids) || solids || [];
              const ts = cs.find(s => s.faces && s.faces.some(f => f.id === bldSelected.solidFaceId));
              if (ts) {
                const newSolid = pushPullRect(ts, bldSelected.solidFaceId, rect3d, depthM);
                console.warn('[PP_SOLID_WALL_RECT] pushPullRect適用', {
                  faceId: bldSelected.solidFaceId, depth: depthM.toFixed(3),
                  旧面数: ts.faces.length, 新面数: newSolid.faces.length,
                  rect3d: rect3d.map((p, i) => `c${i}(${p.x.toFixed(1)},${p.y.toFixed(1)},z=${p.z.toFixed(1)})`),
                });
                _dumpSolidFaces(newSolid, depthM<0?'削り出し(壁面)':'突起(壁面)');
                const updatedSolids = cs.map(s => s.id === ts.id ? newSolid : s);
                try {
                  const v = viewerRef.current;
                  if (v && v._buildBldEntities) {
                    v._buildBldEntities(v, blds || [], v._siteBaseElevation || 0, mode === '3d', updatedSolids);
                    v.scene.requestRender();
                  }
                } catch(e) { console.warn('[PP_SOLID_WALL_RECT_RENDER] エラー', e.message); }
                try {
                  if (setSolidsDirect) setSolidsDirect(updatedSolids);
                  else setSolids(updatedSolids);
                } catch(e) { console.warn('[PP_SOLID_WALL_RECT_STATE] エラー', e.message); }
              } else {
                console.warn('[PP_SOLID_WALL_RECT] Solid未発見');
              }
            } else {
              // ═══ 全面pushpull統一パス: Z面も壁面もpushPullFaceで処理 ═══
              const currentSolids3 = (viewerRef.current && viewerRef.current._currentSolids) || solids || [];
              const targetSolid = currentSolids3.find(s => s.buildingId === bldSelected.buildingId);
              if (targetSolid) {
                // solidFaceIdが直接指定されていればそれを使う、なければ従来方式
                let targetFaceId = bldSelected.solidFaceId || null;
                if (!targetFaceId) {
                  if (face === 'zTop') {
                    const f = targetSolid.faces.find(f => f.type === 'top');
                    if (f) targetFaceId = f.id;
                  } else if (face === 'zBottom') {
                    const f = targetSolid.faces.find(f => f.type === 'bottom');
                    if (f) targetFaceId = f.id;
                  } else if (typeof face === 'number') {
                    const f = targetSolid.faces.find(f => f.type === 'wall' && f._edgeIdx === face);
                    if (f) targetFaceId = f.id;
                  }
                }
                if (targetFaceId) {
                  const newSolid = pushPullFace(targetSolid, targetFaceId, depthM);
                  console.warn('[PP_SOLID] pushPullFace完了', {
                    face, faceId: targetFaceId, depthM: depthM.toFixed(3),
                    旧面数: targetSolid.faces.length, 新面数: newSolid.faces.length,
                  });
                  _dumpSolidFaces(newSolid, '伸縮');
                  // solids stateを更新（_currentSolidsベースで構築→setSolidsDirect）
                  const updatedSolids3 = currentSolids3.map(s => s.id === targetSolid.id ? newSolid : s);
                  try {
                    const v = viewerRef.current;
                    if (v && v._buildBldEntities) {
                      v._buildBldEntities(v, blds || [], v._siteBaseElevation || 0, mode === '3d', updatedSolids3);
                      v.scene.requestRender();
                    }
                  } catch(e) { console.warn('[PP_RENDER] エラー', e.message); }
                  if (setSolidsDirect) setSolidsDirect(updatedSolids3);
                  else setSolids(updatedSolids3);
                } else {
                  console.warn('[PP_SOLID] 面ID特定失敗、旧方式にフォールバック', { face });
                  if (isZ && onMoveBldFace) {
                    onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, face, depthM);
                  }
                }
              } else {
                console.warn('[PP_SOLID] Solid未発見、旧方式にフォールバック');
                if (isZ && onMoveBldFace) {
                  onMoveBldFace(bldSelected.buildingId, bldSelected.blockIdx, face, depthM);
                }
              }
            }
            } catch (err) { // try-catch保護
              console.warn('[PP_CONFIRM] エラー発生', err.message, err.stack);
            }
          } else if (faceSketchDepth === 0) {
            // 深さ0 = 変更なし → 何もしない
          }
          // ── 後処理は必ず実行 ──
          setFaceSketchPhase(null);
          setFaceSketchDepth(0);
          pushPullRef.current = null;
          originalBlockRef.current = null;
          setBldSelected(null);
          updateArrowScreen(null);
        };
        const applyExactMm = (newMm) => {
          // プレビュー方式: faceSketchDepthの更新のみ（確定時に適用）
          // 内向きクランプ適用
          let clamped = newMm;
          if (clamped < ppMinDepthMm) clamped = ppMinDepthMm;
          if (clamped > ppMaxDepthMm) clamped = ppMaxDepthMm;
          setFaceSketchDepth(clamped);
        };
        return (<>
          {/* 透明オーバーレイ: マウス移動で面を動かす（中ボタン/右クリックでカメラ回転可能） */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            cursor: isZ ? 'ns-resize' : 'ew-resize',
            zIndex: 15, pointerEvents: 'auto',
          }}
            onMouseMove={(e) => {
              if (e.buttons & 6) return;
              onPPMove(e);
            }}
            onClick={(e) => { e.stopPropagation(); confirmPP(); }}
            onMouseDown={(e) => {
              if (e.button === 1 || e.button === 2) {
                const el = e.currentTarget;
                el.style.pointerEvents = 'none';
                pushPullRef.current = null;
                const cv = viewerRef.current?.scene?.canvas;
                if (cv) {
                  cv.dispatchEvent(new PointerEvent('pointerdown', {
                    clientX: e.clientX, clientY: e.clientY,
                    button: e.button, buttons: e.buttons,
                    pointerId: 1, pointerType: 'mouse', bubbles: true,
                  }));
                }
                const restore = () => {
                  el.style.pointerEvents = 'auto';
                  pushPullRef.current = null;
                  document.removeEventListener('mouseup', restore);
                };
                document.addEventListener('mouseup', restore);
              }
            }}
            onWheel={(e) => {
              const cv = viewerRef.current?.scene?.canvas;
              if (cv) cv.dispatchEvent(new WheelEvent('wheel', {
                clientX: e.clientX, clientY: e.clientY,
                deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
                bubbles: true,
              }));
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* ステータスバー */}
          <div style={{
            position: 'absolute', top: 4, left: 4, right: 4,
            background: 'rgba(59,130,246,0.9)', color: '#fff',
            fontSize: 12, padding: '6px 10px', borderRadius: 4,
            pointerEvents: 'auto', fontFamily: 'sans-serif', zIndex: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Push/Pull: マウス移動で押し出し | ホイール押込/右クリック=回転 — 距離:
              <input type="number" value={Math.round(faceSketchDepth)} step={100}
                style={{ width: 80, background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.5)',
                  color: '#fff', borderRadius: 2, padding: '2px 4px', fontSize: 12 }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => applyExactMm(parseFloat(e.target.value) || 0)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); confirmPP(); } if (e.key === 'Escape') { e.stopPropagation(); cancelPP(); } }}
              />
              <span style={{ fontSize: 10, opacity: 0.8 }}>mm</span>
            </span>
            <span style={{ display: 'flex', gap: 4 }}>
              <button onClick={(e) => { e.stopPropagation(); confirmPP(); }} style={{
                background: '#22c55e', color: '#fff', border: 'none', borderRadius: 2,
                padding: '3px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>確定</button>
              <button onClick={(e) => { e.stopPropagation(); cancelPP(); }} style={{
                background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
                padding: '2px 8px', cursor: 'pointer', fontSize: 11,
              }}>キャンセル</button>
            </span>
          </div>
        </>);
      } catch(e) { console.warn('[PP_RENDER_BLOCK] エラー', e.message); return null; }
      })()}
      {/* ── 矩形で突起モード ── */}
      {faceSketchPhase === 'rectdraw' && bldSelected && (
        <div style={{
          position: 'absolute', top: 4, left: 4, right: 4,
          background: 'rgba(59,130,246,0.85)', color: '#fff',
          fontSize: 12, padding: '6px 10px', borderRadius: 4,
          pointerEvents: 'auto', fontFamily: 'sans-serif', zIndex: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>面を伸縮: 対角2点を指定 ({faceSketchPts.length}/2点) | 右クリック=面全体 | ホイール押込=回転</span>
          <button onClick={() => { setFaceSketchPhase(null); setFaceSketchPts([]); }} style={{
            background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
            padding: '2px 8px', cursor: 'pointer', fontSize: 11,
          }}>キャンセル</button>
        </div>
      )}
      {/* ── 矩形で突起: Push/Pull (統合ポリゴン変形) ── */}
      {faceSketchPhase === 'rectpull' && bldSelected && (() => {
        // スナップカーソル/プレビューのクリーンアップ
        const _v = viewerRef.current;
        if (_v && !_v.isDestroyed()) {
          if (_v._snapCursorEnt && _v.entities.contains(_v._snapCursorEnt)) {
            _v.entities.remove(_v._snapCursorEnt); _v._snapCursorEnt = null;
          }
          if (_v._snapRectPreview && _v.entities.contains(_v._snapRectPreview)) {
            _v.entities.remove(_v._snapRectPreview); _v._snapRectPreview = null;
          }
          if (_v._snapRectLabelEnts) { _v._snapRectLabelEnts.forEach(e => { if (_v.entities.contains(e)) _v.entities.remove(e); }); _v._snapRectLabelEnts = []; }
        }
        const face = bldSelected.face;
        const fi = typeof face === 'number' ? face : parseInt(face, 10);
        // 面エッジの外向き垂線をスクリーン座標で計算するヘルパー
        const computeEdgePerp = (v, pts) => {
          const baseElev = v._siteBaseElevation || 0;
          const zMid = baseElev + ((pts[0]?.zTop || 40) + (pts[0]?.zBottom || 0)) / 2;
          const blk = (blds || [])[bldSelected.entIdx];
          if (!blk) return null;
          const bpts = blk.points;
          const zM = baseElev + ((blk.zTop || 40) + (blk.zBottom || 0)) / 2;
          const p0 = bpts[fi], p1 = bpts[(fi + 1) % bpts.length];
          const ge0 = gridToGeo(p0.x, p0.y), ge1 = gridToGeo(p1.x, p1.y);
          const se0 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(ge0.lng, ge0.lat, zM));
          const se1 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(ge1.lng, ge1.lat, zM));
          if (!se0 || !se1) return null;
          const edx = se1.x - se0.x, edy = se1.y - se0.y;
          const eLen = Math.sqrt(edx * edx + edy * edy);
          if (eLen < 1) return null;
          let perpX = -edy / eLen, perpY = edx / eLen;
          const { nx, ny } = edgeNormalGrid(bpts, fi);
          const gmx = (p0.x + p1.x) / 2, gmy = (p0.y + p1.y) / 2;
          const gN = gridToGeo(gmx + nx * 5, gmy + ny * 5);
          const sN = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(gN.lng, gN.lat, zM));
          const sM = { x: (se0.x + se1.x) / 2, y: (se0.y + se1.y) / 2 };
          if (sN) {
            if ((sN.x - sM.x) * perpX + (sN.y - sM.y) * perpY < 0) { perpX = -perpX; perpY = -perpY; }
          }
          // ppg計算
          const cx = bpts.reduce((s, p) => s + p.x, 0) / bpts.length;
          const cy = bpts.reduce((s, p) => s + p.y, 0) / bpts.length;
          const g0 = gridToGeo(cx, cy), g1 = gridToGeo(cx + 1, cy);
          const s0 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(g0.lng, g0.lat, zM));
          const s1 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,
            Cesium.Cartesian3.fromDegrees(g1.lng, g1.lat, zM));
          if (!s0 || !s1) return null;
          const ppg = Math.sqrt((s1.x - s0.x) ** 2 + (s1.y - s0.y) ** 2);
          if (ppg < 0.01) return null;
          return { perpX, perpY, ppg };
        };
        const onRPMove = (e) => {
          // デルタベース: 前回からのカーソル移動量を面エッジ垂線に投影
          if (!pushPullRef.current) {
            pushPullRef.current = { lastX: e.clientX, lastY: e.clientY };
            document.title = '[RP] init ' + face;
            return;
          }
          const dmx = e.clientX - pushPullRef.current.lastX;
          const dmy = e.clientY - pushPullRef.current.lastY;
          pushPullRef.current.lastX = e.clientX;
          pushPullRef.current.lastY = e.clientY;
          const v = viewerRef.current;
          if (!v || v.isDestroyed()) return;
          const blk = (blds || [])[bldSelected.entIdx];
          if (!blk) return;
          const ep = computeEdgePerp(v, blk.points);
          if (!ep) return;
          // マウス移動をエッジ垂線に投影（外向き=正=突起, 内向き=負=削り出し）
          const screenDelta = dmx * ep.perpX + dmy * ep.perpY;
          const deltaMm = screenDelta / ep.ppg * METERS_PER_PX * 1000;
          if (Math.abs(deltaMm) < 1) return;
          setFaceSketchDepth(prev => {
            const newD = prev + deltaMm;
            document.title = '[RP] depth=' + Math.round(newD) + 'mm';
            return newD;
          });
        };
        const confirmRP = () => {
          const blk = (blds || [])[bldSelected.entIdx];
          const depthM = faceSketchDepth / 1000;
          const depthGrid = depthM / METERS_PER_PX;
          console.warn('[RP_CONFIRM] ═══════════════════════════════════════');
          console.warn('[RP_CONFIRM] 開始', {
            faceSketchDepth: Math.round(faceSketchDepth) + 'mm (' + depthM.toFixed(3) + 'm)',
            depthGrid: depthGrid.toFixed(2) + 'grid',
            操作: faceSketchDepth > 0 ? '突起(外向き)' : faceSketchDepth < 0 ? '削り出し(内向き)' : '変更なし',
            face, entIdx: bldSelected?.entIdx,
            blockIdx: bldSelected?.blockIdx,
            isChild: blk?._parentBlockIdx != null,
            _sharedWall: blk?._sharedWall,
          });
          // 矩形座標ログ
          if (faceSketchPts.length > 0) {
            console.warn('[RP_CONFIRM] 選択矩形', {
              矩形頂点: faceSketchPts.map((p, i) => `c${i}(gx=${p.gx.toFixed(1)},gy=${p.gy.toFixed(1)},gz=${p.gz.toFixed(1)})`),
              矩形頂点数: faceSketchPts.length,
            });
          }
          if (faceSketchDepth !== 0 && onSetBlockPoints) {
            if (blk) {
              const newPts = computeExtrudedPolygon(blk, face, faceSketchPts, faceSketchDepth, true, bldSelected?.csgNx, bldSelected?.csgNy);
              if (newPts) {
                // Shoelace面積
                const calcArea = (pts) => {
                  let area = 0;
                  for (let i = 0; i < pts.length; i++) {
                    const j = (i + 1) % pts.length;
                    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
                  }
                  return area / 2;
                };
                const oldArea = calcArea(blk.points);
                const newArea = calcArea(newPts);
                const oldN = blk.points.length;
                const newN = newPts.length;

                // 変形前: 各面の情報
                console.warn('[RP_CONFIRM] 変形前ポリゴン', {
                  頂点数: oldN, 面積: oldArea.toFixed(1),
                  全面: blk.points.map((p, i) => {
                    const q = blk.points[(i + 1) % oldN];
                    const len = Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
                    return `面${i}: v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})→v${(i+1)%oldN}(${q.x.toFixed(1)},${q.y.toFixed(1)}) L=${len.toFixed(1)}`;
                  }),
                  zRange: `${(blk.zBottom||0).toFixed(1)}m→${(blk.zTop||40).toFixed(1)}m`,
                });

                // 変形後: 各面の情報
                console.warn('[RP_CONFIRM] 変形後ポリゴン', {
                  頂点数: newN, 面積: newArea.toFixed(1),
                  全面: newPts.map((p, i) => {
                    const q = newPts[(i + 1) % newN];
                    const len = Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
                    return `面${i}: v${i}(${p.x.toFixed(1)},${p.y.toFixed(1)})→v${(i+1)%newN}(${q.x.toFixed(1)},${q.y.toFixed(1)}) L=${len.toFixed(1)}`;
                  }),
                });

                // 3D閉空間チェック: 全面(側面+上下面)の面積合計
                const zB = blk.zBottom || 0, zT = blk.zTop != null ? blk.zTop : 40;
                const height = zT - zB;
                const sideArea = newPts.reduce((sum, p, i) => {
                  const q = newPts[(i + 1) % newN];
                  return sum + Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2) * height;
                }, 0);
                const topBottomArea = Math.abs(newArea) * 2;
                const totalSurfaceArea = sideArea + topBottomArea;
                // ゼロ長辺チェック
                const zeroEdges = newPts.filter((p, i) => {
                  const q = newPts[(i + 1) % newN];
                  return Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2) < 0.01;
                }).length;
                // 重複頂点チェック
                const dupVerts = newPts.filter((p, i) => {
                  for (let j = i + 1; j < newN; j++) {
                    if (Math.abs(p.x - newPts[j].x) < 0.01 && Math.abs(p.y - newPts[j].y) < 0.01) return true;
                  }
                  return false;
                }).length;

                console.warn('[RP_CONFIRM] 3D閉空間チェック', {
                  底面積: Math.abs(newArea).toFixed(1) + 'grid²',
                  高さ: height.toFixed(1) + 'm',
                  側面総面積: sideArea.toFixed(1),
                  上下面積: topBottomArea.toFixed(1),
                  全表面積: totalSurfaceArea.toFixed(1),
                  底面積チェック: Math.abs(newArea) > 1 ? '✅正常' : '⚠️面積ゼロ=穴あき!',
                  ゼロ長辺: zeroEdges > 0 ? `⚠️${zeroEdges}本の辺がゼロ長!` : '✅なし',
                  重複頂点: dupVerts > 0 ? `⚠️${dupVerts}個の重複頂点!` : '✅なし',
                  面積変化: `${oldArea.toFixed(1)} → ${newArea.toFixed(1)} (${(newArea > oldArea ? '+' : '') + (newArea - oldArea).toFixed(1)})`,
                });
                if (Math.abs(newArea) < 1) console.error('[RP_CONFIRM] ⚠️ 変形後の面積がほぼゼロ！箱に穴が開いています！');
                if (zeroEdges > 0) console.error('[RP_CONFIRM] ⚠️ ゼロ長の辺があります！面が潰れています！');
                if (dupVerts > 0) console.error('[RP_CONFIRM] ⚠️ 重複頂点があります！不正なポリゴンです！');

                console.warn('[RP_CONFIRM] ═══════════════════════════════════════');
                const origPts = blk._preExtrudePoints || blk.points;
                onSetBlockPoints(bldSelected.buildingId, bldSelected.blockIdx, newPts, origPts);
              } else {
                console.error('[RP_CONFIRM] ⚠️ computeExtrudedPolygon returned null!');
              }
            }
          }
          setFaceSketchPhase(null);
          setFaceSketchPts([]);
          setFaceSketchDepth(0);
          pushPullRef.current = null;
          document.title = '配置図 3Dマップ';
        };
        const cancelRP = () => {
          setFaceSketchPhase(null);
          setFaceSketchPts([]);
          setFaceSketchDepth(0);
          pushPullRef.current = null;
        };
        return (<>
          {/* 透明オーバーレイ（中ボタン/右クリックでカメラ回転可能） */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            cursor: 'ew-resize', zIndex: 15, pointerEvents: 'auto',
          }}
            onMouseMove={(e) => {
              // カメラ回転中（中ボタン or 右ボタン押下中）は深さ追従を停止
              if (e.buttons & 6) return; // 2=right, 4=middle
              onRPMove(e);
            }}
            onClick={(e) => { e.stopPropagation(); confirmRP(); }}
            onMouseDown={(e) => {
              if (e.button === 1 || e.button === 2) {
                const el = e.currentTarget;
                el.style.pointerEvents = 'none';
                pushPullRef.current = null;
                const cv = viewerRef.current?.scene?.canvas;
                if (cv) {
                  cv.dispatchEvent(new PointerEvent('pointerdown', {
                    clientX: e.clientX, clientY: e.clientY,
                    button: e.button, buttons: e.buttons,
                    pointerId: 1, pointerType: 'mouse', bubbles: true,
                  }));
                }
                const restore = () => {
                  el.style.pointerEvents = 'auto';
                  pushPullRef.current = null;
                  document.removeEventListener('mouseup', restore);
                };
                document.addEventListener('mouseup', restore);
              }
            }}
            onWheel={(e) => {
              const cv = viewerRef.current?.scene?.canvas;
              if (cv) cv.dispatchEvent(new WheelEvent('wheel', {
                clientX: e.clientX, clientY: e.clientY,
                deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
                bubbles: true,
              }));
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* ステータスバー */}
          <div style={{
            position: 'absolute', top: 4, left: 4, right: 4,
            background: faceSketchDepth < 0 ? 'rgba(6,182,212,0.9)' : 'rgba(34,197,94,0.9)', color: '#fff',
            fontSize: 12, padding: '6px 10px', borderRadius: 4,
            pointerEvents: 'auto', fontFamily: 'sans-serif', zIndex: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              面を伸縮: 外=突起 / 内=削り出し | ホイール押込/右クリック=回転 ({faceSketchDepth < 0 ? '削り出し中' : faceSketchDepth > 0 ? '突起中' : 'マウス移動'}) 深さ:
              <input type="number" value={Math.round(faceSketchDepth)} step={100}
                style={{ width: 80, background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.5)',
                  color: '#fff', borderRadius: 2, padding: '2px 4px', fontSize: 12 }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setFaceSketchDepth(parseFloat(e.target.value) || 0)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); confirmRP(); } if (e.key === 'Escape') { e.stopPropagation(); cancelRP(); } }}
              />
              <span style={{ fontSize: 10, opacity: 0.8 }}>mm</span>
            </span>
            <span style={{ display: 'flex', gap: 4 }}>
              <button onClick={(e) => { e.stopPropagation(); confirmRP(); }} style={{
                background: '#22c55e', color: '#fff', border: 'none', borderRadius: 2,
                padding: '3px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>確定</button>
              <button onClick={(e) => { e.stopPropagation(); cancelRP(); }} style={{
                background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
                padding: '2px 8px', cursor: 'pointer', fontSize: 11,
              }}>キャンセル</button>
            </span>
          </div>
        </>);
      })()}
      {/* フィールド描画中のステータスバー */}
      {fieldDrawMode && (
        <div style={{
          position: 'absolute', top: 4, left: 4, right: 4, zIndex: 50,
          background: 'rgba(0,180,0,0.85)', color: '#fff',
          fontSize: 12, padding: '6px 10px', borderRadius: 4,
          pointerEvents: 'auto', fontFamily: 'sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
          onMouseDown={e => e.stopPropagation()}
        >
          <span>
            フィールド描画中: マップをクリックして頂点を追加 ({fieldDrawPts.length}点)
            {fieldDrawPts.length >= 3 && ' — 最初の点(緑)付近をクリックで確定'}
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            {fieldDrawPts.length > 0 && (
              <button onClick={() => setFieldDrawPts(prev => prev.slice(0, -1))} style={{
                background: '#eab308', color: '#000', border: 'none', borderRadius: 2,
                padding: '2px 8px', cursor: 'pointer', fontSize: 11,
              }}>1点戻す</button>
            )}
            <button onClick={() => { setFieldDrawMode(false); setFieldDrawPts([]); }} style={{
              background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
              padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}>キャンセル</button>
          </span>
        </div>
      )}
      {/* 建屋追加モードのステータスバー */}
      {bldAddMode && (
        <div style={{
          position: 'absolute', top: 4, left: 4, right: 4, zIndex: 50,
          background: 'rgba(0,120,255,0.85)', color: '#fff',
          fontSize: 12, padding: '6px 10px', borderRadius: 4,
          pointerEvents: 'auto', fontFamily: 'sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
          onMouseDown={e => e.stopPropagation()}
        >
          <span>
            建屋追加: 建物の角をクリック ({bldAddPts.length}点)
            {bldAddPts.length >= 2 && ' [直角・始点スナップ / Alt: 解除]'}
            {bldAddPts.length >= 3 && ' — 最初の点付近クリック or 右クリックで確定'}
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            {bldAddPts.length > 0 && (
              <button onClick={() => setBldAddPts(prev => prev.slice(0, -1))} style={{
                background: '#eab308', color: '#000', border: 'none', borderRadius: 2,
                padding: '2px 8px', cursor: 'pointer', fontSize: 11,
              }}>1点戻す</button>
            )}
            <button onClick={() => { setBldAddMode(false); setBldAddPts([]); }} style={{
              background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
              padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}>終了</button>
          </span>
        </div>
      )}
      {/* ビルスキャン: 確認ダイアログ */}
      {bldScanConfirm && !scanningRef.current && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)', zIndex: 30, pointerEvents: 'all',
        }}>
          <div style={{
            background: 'rgba(60,40,120,0.95)', color: '#fff',
            padding: '20px 30px', borderRadius: 8, fontSize: 14,
            fontFamily: 'sans-serif', textAlign: 'center',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}>
            <div style={{ marginBottom: 12 }}>この点を中心にスキャンしますか？</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 12 }}>
              高さ: {bldScanConfirm.bldHeight.toFixed(1)}m（地面からの推定）
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => executeBldScan()} style={{
                background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4,
                padding: '6px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>スキャン開始</button>
              <button onClick={() => setBldScanConfirm(null)} style={{
                background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4,
                padding: '6px 16px', cursor: 'pointer', fontSize: 13,
              }}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
      {/* ビルスキャン: 処理中オーバーレイ */}
      {bldScanProgress && bldScanProgress.pct > 0 && bldScanProgress.pct < 100 && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.4)', zIndex: 30, pointerEvents: 'all',
        }}>
          <div style={{
            background: 'rgba(60,40,120,0.95)', color: '#fff',
            padding: '20px 40px', borderRadius: 8, fontSize: 16,
            fontFamily: 'sans-serif', textAlign: 'center',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}>
            <div style={{ marginBottom: 8 }}>建物サンプリング中</div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>{bldScanProgress.status}</div>
          </div>
        </div>
      )}
      {/* ビルスキャンモードのステータスバー */}
      {bldScanMode && (
        <div style={{
          position: 'absolute', top: 4, left: 4, right: 4,
          background: 'rgba(120,80,220,0.9)', color: '#fff',
          fontSize: 12, padding: '6px 10px', borderRadius: 4,
          pointerEvents: 'auto', fontFamily: 'sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>ビルスキャン: 建物をクリック</span>
            <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <span style={{ fontSize: 10, opacity: 0.8 }}>解像度:</span>
              {['粗', '標準', '細', '最細'].map((label, i) => (
                <button key={i} onClick={() => setBldScanRes(i)} style={{
                  background: bldScanRes === i ? '#fff' : 'rgba(255,255,255,0.2)',
                  color: bldScanRes === i ? '#333' : '#fff',
                  border: 'none', borderRadius: 2, padding: '1px 6px',
                  cursor: 'pointer', fontSize: 10, fontWeight: bldScanRes === i ? 600 : 400,
                }}>{label}</button>
              ))}
            </span>
            {bldScanProgress && (
              <span style={{ fontSize: 11, opacity: 0.9 }}>{bldScanProgress.status}</span>
            )}
          </span>
          <button onClick={() => { setBldScanMode(false); setBldScanProgress(null); }} style={{
            background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
            padding: '2px 8px', cursor: 'pointer', fontSize: 11,
          }}>終了</button>
        </div>
      )}
      {/* 面で作図モードのステータスバー */}
      {faceSketchPhase === 'draw' && (
        <div style={{
          position: 'absolute', top: 4, left: 4, right: 4,
          background: 'rgba(34,197,94,0.85)', color: '#fff',
          fontSize: 12, padding: '6px 10px', borderRadius: 4,
          pointerEvents: 'auto', fontFamily: 'sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>
            面で作図: 選択面をクリックして形状を描画 ({faceSketchPts.length}点)
            {faceSketchPts.length >= 3 && ' — 最初の点(緑)付近クリック or 右クリックで確定'}
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            {faceSketchPts.length > 0 && (
              <button onClick={() => setFaceSketchPts(prev => prev.slice(0, -1))} style={{
                background: '#eab308', color: '#000', border: 'none', borderRadius: 2,
                padding: '2px 8px', cursor: 'pointer', fontSize: 11,
              }}>1点戻す</button>
            )}
            <button onClick={() => { setFaceSketchPhase(null); setFaceSketchPts([]); }} style={{
              background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
              padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}>キャンセル</button>
          </span>
        </div>
      )}
      {/* 押し出しフェーズ */}
      {faceSketchPhase === 'extrude' && (
        <div style={{
          position: 'absolute', top: 4, left: 4, right: 4,
          background: 'rgba(59,130,246,0.9)', color: '#fff',
          fontSize: 12, padding: '6px 10px', borderRadius: 4,
          pointerEvents: 'auto', fontFamily: 'sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            矢印をドラッグで押し出し — 深さ:
            <input type="number" value={faceSketchDepth} step={100}
              style={{ width: 80, background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.5)',
                color: '#fff', borderRadius: 2, padding: '2px 4px', fontSize: 12 }}
              onChange={(e) => setFaceSketchDepth(parseFloat(e.target.value) || 0)}
            />
            <span style={{ fontSize: 10, opacity: 0.8 }}>mm</span>
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => {
              // ── 押し出し確定 ──
              if (!bldSelected || faceSketchPts.length < 3 || faceSketchDepth === 0) return;
              const blk = (blds || [])[bldSelected.entIdx];
              if (!blk) return;
              const face = bldSelected.face;
              const depthM = faceSketchDepth / 1000;

              if (face === 'zTop' || face === 'zBottom') {
                // 上面/下面: 別ブロックとして追加
                if (!onAddBlock) return;
                const footprint = faceSketchPts.map(p => ({ x: p.gx, y: p.gy }));
                const zBase = face === 'zTop' ? (blk.zTop || 40) : (blk.zBottom || 0);
                onAddBlock(bldSelected.buildingId, footprint,
                  depthM > 0 ? zBase : zBase + depthM,
                  depthM > 0 ? zBase + depthM : zBase,
                  { _parentBlockIdx: bldSelected.blockIdx });
              } else {
                // 側面: スケッチZ範囲を尊重
                const zB = blk.zBottom || 0, zT = blk.zTop || 40;
                const sketchZMin = Math.min(...faceSketchPts.map(p => p.gz));
                const sketchZMax = Math.max(...faceSketchPts.map(p => p.gz));
                const isFullHeight = (sketchZMin <= zB + 0.5) && (sketchZMax >= zT - 0.5);
                if (isFullHeight && onSetBlockPoints) {
                  // 全高 → 既存ブロックのポリゴンを変形（一体物）+ 元のpointsを保存
                  const newPts = computeExtrudedPolygon(blk, face, faceSketchPts, faceSketchDepth, true, bldSelected?.csgNx, bldSelected?.csgNy);
                  if (!newPts) return;
                  const origPts = blk._preExtrudePoints || blk.points; // 既に突起があれば元を維持
                  onSetBlockPoints(bldSelected.buildingId, bldSelected.blockIdx, newPts, origPts);
                } else {
                  // 部分高 → 別ブロックとして追加（突起のフットプリント）
                  if (!onAddBlock) return;
                  const pts = blk.points;
                  const n = pts.length;
                  const fi = typeof face === 'number' ? face : parseInt(face, 10);
                  if (isNaN(fi) || fi < 0 || fi >= n) return;
                  const p0 = pts[fi], p1 = pts[(fi + 1) % n];
                  const ex = p1.x - p0.x, ey = p1.y - p0.y;
                  const elen = Math.sqrt(ex * ex + ey * ey);
                  if (elen < 0.001) return;
                  const edgeUx = ex / elen, edgeUy = ey / elen;
                  let nx = ey / elen, ny = -ex / elen;
                  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
                  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
                  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                  if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
                  const uValues = faceSketchPts.map(p => (p.gx - p0.x) * edgeUx + (p.gy - p0.y) * edgeUy);
                  const uMin = Math.max(0, Math.min(...uValues));
                  const uMax = Math.min(elen, Math.max(...uValues));
                  const depthGrid = depthM / METERS_PER_PX;
                  const e0x = p0.x + uMin * edgeUx, e0y = p0.y + uMin * edgeUy;
                  const e1x = p0.x + uMax * edgeUx, e1y = p0.y + uMax * edgeUy;
                  // 共有壁なし: 親辺にフラッシュ配置、壁3→0は描画しない
                  const footprint = [
                    { x: e0x, y: e0y },
                    { x: e0x + nx * depthGrid, y: e0y + ny * depthGrid },
                    { x: e1x + nx * depthGrid, y: e1y + ny * depthGrid },
                    { x: e1x, y: e1y },
                  ];
                  // 親のZ境界に近ければスナップ（0.5m以内）
                  const snapZMin = Math.abs(sketchZMin - zB) < 0.5 ? zB : sketchZMin;
                  const snapZMax = Math.abs(sketchZMax - zT) < 0.5 ? zT : sketchZMax;
                  onAddBlock(bldSelected.buildingId, footprint, snapZMin, snapZMax, {
                    _parentBlockIdx: bldSelected.blockIdx,
                    _sharedWall: {
                      wallIdx: 3,
                      parentBlockIdx: bldSelected.blockIdx,
                      parentEdge: fi,
                      uMin: uMin,
                      uMax: uMax,
                    },
                  });
                }
              }
              setFaceSketchPhase(null);
              setFaceSketchPts([]);
              setBldSelected(null);
              updateArrowScreen(null);
            }} style={{
              background: '#22c55e', color: '#fff', border: 'none', borderRadius: 2,
              padding: '3px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
            }}>確定</button>
            <button onClick={() => {
              setFaceSketchPhase('draw');
              setFaceSketchPts([]);
              setFaceSketchDepth(0);
            }} style={{
              background: '#eab308', color: '#000', border: 'none', borderRadius: 2,
              padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}>描き直す</button>
            <button onClick={() => { setFaceSketchPhase(null); setFaceSketchPts([]); setFaceSketchDepth(0); }} style={{
              background: '#ef4444', color: '#fff', border: 'none', borderRadius: 2,
              padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}>キャンセル</button>
          </span>
        </div>
      )}
      {/* (削り出しUI廃止 — 子ブロックはクリック→Delete等で操作) */}
      {/* 建屋選択中バー */}
      {bldSelected && !bldAddMode && !fieldDrawMode && (() => {
        const _blds = blds || [];
        const blk = _blds[bldSelected.entIdx];
        const zT = blk ? (blk.zTop != null ? blk.zTop : blk.height) : '?';
        const zB = blk ? (blk.zBottom || 0) : '?';
        // ===== 階パネル（建物内部 Phase A）: 選択中構造体の階の一覧・追加・削除 =====
        const _floorBld = (buildingsFull || []).find(b => b.id === (blk && blk.buildingId));
        const _floors = _floorBld ? bcSortedFloors(_floorBld) : [];
        return (
          <>
          {floorPanelOpen && _floorBld && (
            <div style={{
              position: 'absolute', bottom: 58, left: 4, width: 300, maxHeight: 220, overflowY: 'auto',
              background: 'rgba(30,41,59,0.92)', color: '#fff',
              fontSize: 11, padding: '6px 8px', borderRadius: 3,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <b>{_floorBld.label} の階</b>
                <label style={{ cursor: 'pointer', fontSize: 10 }}>
                  <input type="checkbox" checked={!!floorFollow}
                    onChange={() => { if (onToggleFloorFollow) onToggleFloorFollow(); }}
                    style={{ verticalAlign: 'middle', marginRight: 3 }} />
                  変形に追従
                </label>
              </div>
              {_floors.length === 0 && <div style={{ opacity: 0.7 }}>階はまだありません</div>}
              {_floors.map(f => {
                const _parts = f.partitions || [];
                const _doors = f.doors || [];
                const _rooms = _parts.length > 0 ? bcDeriveRooms(_floorBld, f, plantNorthAngle) : [];
                const _wam = wallAddMode && wallAddMode.floorId === f.id ? wallAddMode : null;
                return (
                <div key={f.id} style={{ marginBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: 3 }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ width: 34 }}>{bcFloorLabel(_floorBld, f)}</span>
                  <span>床標高</span>
                  <input type="number" step="0.1" defaultValue={f.levelZ}
                    onBlur={(e) => {
                      const nv = parseFloat(e.target.value);
                      if (!isFinite(nv) || nv === f.levelZ) return;
                      const err = onUpdateFloor ? onUpdateFloor(_floorBld.id, f.id, { levelZ: nv }) : null;
                      setFloorMsg(err); if (err) e.target.value = f.levelZ;
                    }}
                    style={{ width: 48, fontSize: 10 }} />
                  <span>階高</span>
                  <input type="number" step="0.1" defaultValue={f.heightM}
                    onBlur={(e) => {
                      const nv = parseFloat(e.target.value);
                      if (!isFinite(nv) || nv <= 0 || nv === f.heightM) return;
                      const err = onUpdateFloor ? onUpdateFloor(_floorBld.id, f.id, { heightM: nv }) : null;
                      setFloorMsg(err);
                    }}
                    style={{ width: 42, fontSize: 10 }} />
                  <button onClick={() => { if (onDeleteFloor) onDeleteFloor(_floorBld.id, f.id); setFloorMsg(null); }}
                    style={{ background: 'rgba(239,68,68,0.8)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 5px', cursor: 'pointer', fontSize: 10 }}>×</button>
                </div>
                {/* Phase B: 壁・透明仕切りの追加と一覧、部屋数 */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 34, marginBottom: 2 }}>
                  <button onClick={() => { setWallAddMode(_wam && _wam.kind === 'wall' ? null : { buildingId: _floorBld.id, floorId: f.id, kind: 'wall', pts: [] }); setFloorMsg(null); }}
                    style={{ background: _wam && _wam.kind === 'wall' ? 'rgba(0,180,255,0.9)' : 'rgba(255,255,255,0.25)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 6px', cursor: 'pointer', fontSize: 10 }}>壁＋</button>
                  <button onClick={() => { setWallAddMode(_wam && _wam.kind === 'clear' ? null : { buildingId: _floorBld.id, floorId: f.id, kind: 'clear', pts: [] }); setFloorMsg(null); }}
                    style={{ background: _wam && _wam.kind === 'clear' ? 'rgba(0,180,255,0.9)' : 'rgba(255,255,255,0.25)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 6px', cursor: 'pointer', fontSize: 10 }}>透明仕切り＋</button>
                  {_parts.length > 0 && <span style={{ opacity: 0.85 }}>部屋: {_rooms.length}</span>}
                </div>
                {_wam && (
                  <div style={{ marginLeft: 34, color: '#7DD3FC', marginBottom: 2 }}>
                    床上を2点クリックで{_wam.kind === 'wall' ? '壁' : '透明仕切り'}を作成（軸平行スナップ・右クリックで終了）
                    {_wam.pts.length === 1 && ' — 始点OK、終点をクリック'}
                  </div>
                )}
                {_parts.map((p, pi) => (
                  <div key={p.id} style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 34, marginBottom: 1 }}>
                    <span style={{ width: 84 }}>{p.kind === 'wall' ? '壁' : '透明仕切り'} {pi + 1}（{bcPartitionLenM(p).toFixed(1)}m）</span>
                    <button title="壁⇔透明仕切りを切替（透明にするとその仕切りの扉は消えます）"
                      onClick={() => { if (onUpdatePartition) onUpdatePartition(_floorBld.id, f.id, p.id, { kind: p.kind === 'wall' ? 'clear' : 'wall' }); }}
                      style={{ background: 'rgba(255,255,255,0.25)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 5px', cursor: 'pointer', fontSize: 10 }}>⇄</button>
                    {p.kind === 'wall' && (
                      <button title="この壁の中央に扉を追加"
                        onClick={() => { const err = onAddDoor ? onAddDoor(_floorBld.id, f.id, p.id) : '未接続'; setFloorMsg(err); }}
                        style={{ background: 'rgba(180,83,9,0.85)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 5px', cursor: 'pointer', fontSize: 10 }}>扉＋</button>
                    )}
                    <span style={{ opacity: 0.75 }}>扉{_doors.filter(d => d.partitionId === p.id).length}</span>
                    <button onClick={() => { if (onDeletePartition) onDeletePartition(_floorBld.id, f.id, p.id); }}
                      style={{ background: 'rgba(239,68,68,0.8)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 5px', cursor: 'pointer', fontSize: 10 }}>×</button>
                  </div>
                ))}
                {_doors.map((d, di) => (
                  <div key={d.id} style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 46, marginBottom: 1, opacity: 0.9 }}>
                    <span style={{ width: 96 }}>扉 {di + 1}（幅{d.widthM}m）</span>
                    <span>位置</span>
                    <input type="number" step="0.1" defaultValue={d.uM.toFixed(1)}
                      onBlur={(e) => {
                        const nv = parseFloat(e.target.value);
                        if (!isFinite(nv)) return;
                        const nd = (f.doors || []).map(x => x.id === d.id ? { ...x, uM: nv } : x);
                        if (onUpdateFloor) onUpdateFloor(_floorBld.id, f.id, { doors: nd });
                      }}
                      style={{ width: 44, fontSize: 10 }} />
                    <span>m</span>
                    <button onClick={() => { if (onDeleteDoor) onDeleteDoor(_floorBld.id, f.id, d.id); }}
                      style={{ background: 'rgba(239,68,68,0.8)', color: '#fff', border: 'none', borderRadius: 2, padding: '0 5px', cursor: 'pointer', fontSize: 10 }}>×</button>
                  </div>
                ))}
                </div>
                );
              })}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 5, borderTop: '1px solid rgba(255,255,255,0.25)', paddingTop: 4 }}>
                <span>床標高</span>
                <input type="number" step="0.1" value={floorAddZ}
                  onChange={(e) => setFloorAddZ(e.target.value)} style={{ width: 48, fontSize: 10 }} />
                <span>階高</span>
                <input type="number" step="0.1" value={floorAddH}
                  onChange={(e) => setFloorAddH(e.target.value)} style={{ width: 42, fontSize: 10 }} />
                <button onClick={() => {
                  const z = parseFloat(floorAddZ), h = parseFloat(floorAddH);
                  if (!isFinite(z) || !isFinite(h) || h <= 0) { setFloorMsg('数値を入力してください'); return; }
                  const err = onAddFloor ? onAddFloor(_floorBld.id, z, h) : '未接続';
                  setFloorMsg(err);
                  if (!err) setFloorAddZ(String(Math.round((z + h) * 10) / 10)); // 次の階の床標高を先回り入力
                }} style={{ background: 'rgba(0,180,255,0.8)', color: '#fff', border: 'none', borderRadius: 2, padding: '1px 8px', cursor: 'pointer', fontSize: 10 }}>階を追加</button>
              </div>
              {floorMsg && <div style={{ color: '#FCA5A5', marginTop: 3 }}>{floorMsg}</div>}
            </div>
          )}
          <div style={{
            position: 'absolute', bottom: 30, left: 4, right: 4,
            background: 'rgba(59,130,246,0.85)', color: '#fff',
            fontSize: 11, padding: '4px 8px', borderRadius: 3,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>{bldSelected.label} | 高さ:{zB}～{zT}m | 面:{
              bldSelected.face === 'zTop' ? '上' : bldSelected.face === 'zBottom' ? '下' : `辺${bldSelected.face}`
            } (矢印をドラッグで移動)</span>
            <span style={{ display: 'flex', gap: 4 }}>
            {_floorBld && (
              <button onClick={() => { setFloorPanelOpen(o => !o); setFloorMsg(null); }} style={{
                background: floorPanelOpen ? 'rgba(0,180,255,0.9)' : 'rgba(255,255,255,0.3)', color: '#fff', border: 'none',
                borderRadius: 2, padding: '1px 6px', cursor: 'pointer', fontSize: 10,
              }}>階 ({(_floorBld.floors || []).length})</button>
            )}
            <button onClick={() => {
              setBldSelected(null);
              const v = viewerRef.current;
              if (v && !v.isDestroyed() && v._bldEntities) {
                v._bldEntities.forEach((e, i) => {
                  if (e && e.polygon) {
                    const col = (_blds)[i] ? (_blds)[i].color : '#888';
                    e.polygon.outlineColor = Cesium.Color.fromCssColorString(col);
                    e.polygon.outlineWidth = 1;
                  }
                });
                v.scene.requestRender();
              }
            }} style={{
              background: 'rgba(255,255,255,0.3)', color: '#fff', border: 'none',
              borderRadius: 2, padding: '1px 6px', cursor: 'pointer', fontSize: 10,
            }}>解除</button>
            </span>
          </div>
          </>
        );
      })()}
      {/* 座標バー */}
      <div style={{
        position: 'absolute', bottom: 4, left: 4, right: 4,
        background: 'rgba(0,0,0,0.65)', color: '#fff',
        fontSize: 11, padding: '3px 4px', borderRadius: 3,
        pointerEvents: 'auto', fontFamily: 'monospace',
        whiteSpace: 'nowrap', overflow: 'hidden',
        display: 'flex', alignItems: 'center',
      }}>
        {!fieldDrawMode && !bldAddMode && !bldScanMode && (
          <span style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => {
                setBldAddMode(true); setBldAddPts([]);
                // 建屋追加開始: ウィンドウ中央の地上座標の真上に移動（現在の高度を維持）
                const _v = viewerRef.current;
                if (_v && !_v.isDestroyed()) {
                  const _cvs = _v.scene.canvas;
                  const _ctr = new Cesium.Cartesian2(_cvs.clientWidth / 2, _cvs.clientHeight / 2);
                  const _ray = _v.camera.getPickRay(_ctr);
                  let _gnd = _ray ? _v.scene.globe.pick(_ray, _v.scene) : null;
                  if (!_gnd && _ray) {
                    const _hit = Cesium.IntersectionTests.rayEllipsoid(_ray, _v.scene.globe.ellipsoid);
                    if (_hit) _gnd = Cesium.Ray.getPoint(_ray, _hit.start);
                  }
                  if (_gnd) {
                    const _gc = Cesium.Cartographic.fromCartesian(_gnd);
                    const _alt = _v.camera.positionCartographic.height;
                    _v.camera.flyTo({
                      destination: Cesium.Cartesian3.fromDegrees(
                        Cesium.Math.toDegrees(_gc.longitude),
                        Cesium.Math.toDegrees(_gc.latitude),
                        _alt
                      ),
                      orientation: { heading: _v.camera.heading, pitch: Cesium.Math.toRadians(-87), roll: 0 },
                      duration: 1.2,
                    });
                  }
                }
              }}
              style={{
                background: 'rgba(0,180,255,0.7)', color: '#fff',
                border: 'none', borderRadius: 2, padding: '1px 8px',
                cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
              }}
            >構造体追加</button>
            {onOpenBuildingEditor && (
              <button onClick={() => onOpenBuildingEditor()} style={{
                background: 'rgba(99,102,241,0.85)', color: '#fff',
                border: 'none', borderRadius: 2, padding: '1px 8px',
                cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
              }}>建物エディタ</button>
            )}
            {/* 建物内部 Phase A: 建物データのjson保存/読込（spec 7.6） */}
            {onExportBuildings && (
              <button onClick={() => onExportBuildings()} style={{
                background: 'rgba(16,185,129,0.7)', color: '#fff',
                border: 'none', borderRadius: 2, padding: '1px 8px',
                cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
              }}>建物保存</button>
            )}
            {onImportBuildings && (
              <button onClick={() => { if (bldImportInputRef.current) bldImportInputRef.current.click(); }} style={{
                background: 'rgba(16,185,129,0.7)', color: '#fff',
                border: 'none', borderRadius: 2, padding: '1px 8px',
                cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
              }}>建物読込</button>
            )}
            <input ref={bldImportInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const err = onImportBuildings ? onImportBuildings(String(reader.result)) : '未接続';
                  if (err) console.warn('[BLD_IMPORT] ' + err);
                };
                reader.readAsText(f);
                e.target.value = '';
              }} />
            {getSavedFieldPolygon() && (
              <button
                onClick={() => {
                  clearFieldPolygon();
                }}
                style={{
                  background: 'rgba(239,68,68,0.7)', color: '#fff',
                  border: 'none', borderRadius: 2, padding: '1px 8px',
                  cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
                }}
              >フィールドリセット</button>
            )}
            <button
              onClick={() => { setFieldDrawMode(true); setFieldDrawPts([]); }}
              style={{
                background: 'rgba(255,255,255,0.15)', color: '#fff',
                border: 'none', borderRadius: 2, padding: '1px 8px',
                cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
              }}
            >フィールド設定</button>
            {mode === '3d' && (
              <button
                onClick={() => { setBldScanMode(true); setBldScanProgress(null); }}
                style={{
                  background: 'rgba(180,100,255,0.7)', color: '#fff',
                  border: 'none', borderRadius: 2, padding: '1px 8px',
                  cursor: 'pointer', fontSize: 11, fontFamily: 'sans-serif',
                }}
              >ビルスキャン</button>
            )}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
        {coordInfo && (() => {
          const copyBtn = (label, value, raw) => (
            <span
              key={label}
              title="クリックでコピー"
              onClick={() => navigator.clipboard.writeText(String(raw))}
              style={{
                cursor: 'pointer', padding: '1px 6px', borderRadius: 2,
                marginRight: 6, transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {label}: {value}
            </span>
          );
          return (<>
            {copyBtn('緯度', coordInfo.lat.toFixed(6) + '\u00B0', coordInfo.lat.toFixed(6))}
            {copyBtn('経度', coordInfo.lng.toFixed(6) + '\u00B0', coordInfo.lng.toFixed(6))}
            {copyBtn('標高', coordInfo.alt.toFixed(1) + 'm', coordInfo.alt.toFixed(1))}
          </>);
        })()}
        </span>
      </div>
      {/* ドラッグ距離ヒント（DOM refで直接操作、React再レンダなし） */}
      <div ref={bldDragHintRef} style={{
        display: 'none',
        position: 'fixed',
        background: 'rgba(0,0,0,0.72)',
        color: '#FFF',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 12,
        fontFamily: 'monospace',
        pointerEvents: 'none',
        zIndex: 200,
        whiteSpace: 'nowrap',
      }} />
    </div>
  );
}

