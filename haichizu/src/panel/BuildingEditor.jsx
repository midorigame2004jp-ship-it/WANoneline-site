// ================================================================
// BuildingEditor.jsx — 建物エディタ（3Dビュー1本・spec 14章 段階D）
// App.jsx の FloatWin として埋め込む controlled component。
// 別HTML・localStorage同期は撤回済み（2026-08-16 ユーザー指摘・Codex監査）。
// buildings は App.jsx の state をそのまま props で受け取る「唯一の正」。
// CRUDハンドラも App.jsx が CesiumMap.jsx に渡しているものと同一関数を共有する
// （Cesium側と建物エディタが同じ関数で同じ state を書き換えるので、
//   保存・同期・revision管理が一切不要になる）。
//
// 【視点方式】3Dビュー1本（段階D・2026-08-28）。
//   段階Cで作図・床の形・扉・端点・高さ・階編集モードがすべて3Dで揃ったため、
//   2D平面図タブは表示しない。真上から見たい時は「○階を編集」で真上視点になる
//   （ユーザー確定の最終形:「2D3Dを切り替える必要がない」）。
//   2Dのコードは一拍置いてから削除する（Codex監査の助言）。戻すのは下の1行だけ。
// 【描画方式】Canvas2Dの単純な塗りつぶし
// 【操作感】配電盤エディタを踏襲: 左に一覧パネル、右にキャンバス、クリック選択→数値編集
// ================================================================

// ★★★ 2Dで編集したい際はここを戻す（false → true）★★★
//   true にすると画面右上に「2D（編集）／3D（確認）」のタブが戻り、2D平面図で編集できる。
//   2D用のコード（キャンバス・ヒット判定・ドラッグ・作図）は消さずに全部残してある。
//   探すときは「2Dで編集」で全文検索すればここに来る。

// ガイド線は【PNの2軸】。壁自身の向きではない。
// 壁の延長方向だけだと「PNに沿って引き直す」ができない（2026-08-20 ユーザー指摘）。
// 固定側の端点を通る PN-x / PN-y の2本を出し、近い方へ吸い付かせる。
// 【画面に出す言葉は1か所から引く・2026-10-18】buildingDrawCore.js の BC_WORDS。
//   ボタンの名前を案内文が引用している所が複数あり、改名したとき片方だけ古くなる
//   （実測：〔⌁ 掃引〕は 2026-10-14 に〔✏ 輪郭を描く〕へ改名したのに案内が残っていた）。
//   ローダーは buildingDrawCore.js を先に読むので必ず定義されるが、順が崩れた日に
//   画面が真っ白にならないよう空表の保険だけ置く（ここに実文は書かない）。
const _語 = (typeof BC_WORDS !== 'undefined') ? BC_WORDS
  : { 入口: {}, 操作: {}, できた物: {}, ボタン: {}, 手順: {}, 壁付け: {}, 理由: {} };
const BE_GUIDE_SNAP_PX = 10;

// 画面1px が何グリッドに当たるかを、投影を実測して求める。
// 「吸い付きの許容量は画面px」という既存の思想を、グリッド基準の幾何計算へ橋渡しする。
// 投影を親が自前で持つと二重管理になるので、渡された投影関数をそのまま使う
function _beGridPerPx(g2s, at) {
  const p0 = g2s(at.gx, at.gy);
  const p1 = g2s(at.gx + 10, at.gy);      // 10グリッド動かして画面で何px動くか
  const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  return d > 1e-6 ? 10 / d : 0;           // 投影が潰れているときは吸い付かせない
}
function _bePnAxes(pnRot) {
  const o = pnRot.toWorld({ x: 0, y: 0 });
  const ux = pnRot.toWorld({ x: 1, y: 0 }), uy = pnRot.toWorld({ x: 0, y: 1 });
  return [
    { x: ux.x - o.x, y: ux.y - o.y },  // PNのx軸
    { x: uy.x - o.x, y: uy.y - o.y },  // PNのy軸
  ];
}
// カーソル位置 g を、いずれかのガイド線に近ければ吸い付かせる。
// 判定は画面px（ズームしても掴み心地が変わらない。ヒット判定と同じ考え方）
function _beGuidePoint(fixed, dirs, g, gridToScreen) {
  // 【一時解除】判定は snapGate.js が唯一の実装。ここは1行見るだけ（2026-09-03）
  // 壁・扉・床の作図と、機器を置く位置のガイドが全部ここを通る
  if (typeof snapSuppressed === 'function' && snapSuppressed()) return { p: { ...g }, snappedIdx: -1 };
  const sg = gridToScreen(g.x, g.y);
  let best = null;
  (dirs || []).forEach((d, i) => {
    const t = (g.x - fixed.x) * d.x + (g.y - fixed.y) * d.y;
    const proj = { x: fixed.x + d.x * t, y: fixed.y + d.y * t };
    const sp = gridToScreen(proj.x, proj.y);
    const distPx = Math.hypot(sp.x - sg.x, sp.y - sg.y);
    if (distPx <= BE_GUIDE_SNAP_PX && (!best || distPx < best.distPx)) best = { p: proj, distPx, idx: i };
  });
  return best ? { p: best.p, snappedIdx: best.idx } : { p: { ...g }, snappedIdx: -1 };
}

function BuildingEditor({
  buildings, floorFollow, onToggleFloorFollow,
  bodies,                 // 【2026-11-05】立体（CSG）。階・仕切り・扉が付く「形を持つもの」
  onAddFloor, onUpdateFloor, onDeleteFloor,
  onAddPartition, onUpdatePartition, onDeletePartition,
  onAddDoor, onDeleteDoor,
  onApplyDoorEdit, // 【扉】編集の唯一の出口（bcApplyDoorEdit）。壁の onApplyPartEdit と同じ形
  onAddIcon, onAddFloorIcon, onAddOuterIcon, onAddCeilIcon, onDeleteIcon, onApplyIconEdit, // 【機器アイコン・Phase C】扉と同じ形
  onMountPanel, onUnmountPanel,   // 盤を壁（曲面を含む）に取り付ける／外す・2026-10-01
  onDropPanelOnFloor, // 【Phase D】配電盤テンプレートを床へドロップしたときの受け口
  // 【Phase D】配置済みの配電盤。floor.icons とは別モデルのまま、
  // 「床置きの箱」の形（gx,gy,rotDeg,wM,dM,hM,tM,floorId）に射影されて渡ってくる。
  // 盤のスキーマ（wx,wy が角／rot が絶対角）は App.jsx だけが知る
  panelBoxes = null,
  onMovePlacedPanel = null, // 箱の中心・向きで確定を返す。盤の保存形への変換はApp側
  // 建物エディタで選んだもの（盤・壁・扉・機器、または解除）を他のビューへ伝える唯一の口。
  // 以前は盤だけの onSelectPanel だった（2026-09-11 に種類をまたいで1本化）
  onSelectPart = null,
  // 他の窓で選んだもの { part: selBldPart, panelId } と、📷の寄せ先 { bounds, buildingId, seq }（2026-09-11）
  extSel = null, focusReq = null,
  onDeletePlacedPanel = null, // 置いた盤を消す（平面図の×と同じ入口）
  onFocusPlacedPanel = null,  // 📷: 置いた盤へ他のビューを寄せる（focusPlacedPanel が唯一の実装）
  onFocusFloorIcon = null,    // 📷: 建物内部の機器へ寄せる（focusGridPos が唯一の実装）
  plantNorthAngle = 0, // プラントノース(度)。作図のスナップ軸と部屋認識の基準になる
  setPlantNorthAngle = null, // 建物エディタ上でPNを変更できるようにする（Cesium側と同じUI）
  onSetFloorOutline, getPartitionsOutsideFloor, // 床のカスタム外形
  onApplyPartEdit, // 【統一編集モデル】床も壁も同格に編集する唯一の出口（bcApplyPartEdit）
  // 【ガワ（blocks）の編集・2026-09-22 ユーザー指示「建屋モードのプロパティは消して建屋エディタに集約」】
  // 単純な値の更新と、面移動と、追加削除でハンドラを分ける（Codex監査）。
  onUpdateBuilding = null, onUpdateBlock = null, onMoveBlockFace = null,
  onAddBlock = null, onDeleteBlock = null, onDeleteBuilding = null,
  bldColors = null,
}) {
  const pnDeg = plantNorthAngle || 0;
  const pnRot = bcPnRot(pnDeg);
  // 床の形を編集するモード。pts に頂点を溜め、確定で floor.outline に保存する
  const [floorEdit, setFloorEdit] = useState(null); // {pts:[{x,y}]} | null
  const [outsideWarn, setOutsideWarn] = useState([]); // 床の外に出た仕切りID
  const [selBuildingId, setSelBuildingId] = useState(null);
  const [beShell, setBeShell] = useState(false);   // ガワ（外壁）の折りたたみ
  const [beVerts, setBeVerts] = useState(null);    // 頂点の一覧を開いているブロック番号（null=閉じる）
  // 増築棟の入力 { [ブロック番号]: {edge,len,depth,h} }（2026-09-23）
  const [beAnnex, setBeAnnex] = useState({});
  // 図の上で選んだガワの面 { shellFaceId, blockIdx, faceType, edgeIdx }（2026-09-23）
  // 「辺0/辺1」を数値で選ばせるのをやめ、3Dプレビューで面をクリックして指す
  const [selShell, setSelShell] = useState(null);
  // 細かい数値（全辺の長さ・頂点一覧・6面ぶんの移動）を開いているブロック番号（2026-09-23）
  const [beAdv, setBeAdv] = useState(null);
  const [selFloorId, setSelFloorId] = useState(null);
  const [selPartId, setSelPartId] = useState(null);
  const [tool, setTool] = useState(null); // null | 'wall' | 'clear'
  // 【扉】選択中の扉と、扉の配置モード。
  // 配置モードは「どの壁に置くか」を持つ（扉＋を押した壁の行が対象）。
  // 元の作りは壁の中央固定で、置く位置を指定する手段が無かった
  const [selDoorId, setSelDoorId] = useState(null);
  const [hoverDoorId, setHoverDoorId] = useState(null);
  const [doorPlace, setDoorPlace] = useState(null); // {partId} | null
  // 【機器アイコン・Phase C】扉とまったく同じ構成にする
  const [selIconId, setSelIconId] = useState(null);
  const [hoverIconId, setHoverIconId] = useState(null);
  const [iconPlace, setIconPlace] = useState(null);   // {partId} | {floor:true} | null
  const [iconPreview, setIconPreview] = useState(null); // {iconId, sM, tM} | null
  const [drawPts, setDrawPts] = useState([]);
  const [cursorG, setCursorG] = useState(null); // 作図中のカーソル位置（候補線の表示用）
  const [msg, setMsg] = useState(null);
  // ══ 診断フック __editorDiag()（2026-09-01）══
  // 「壁の機器が置けているのか／置けたが動かないのか」を実機で1行で確かめるため。読み取り専用。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__editorDiag = () => ({
      いま何を置こうとしているか: iconPlace
        ? (iconPlace.floor ? '床置き' : (iconPlace.doorId ? '扉の面（doorId=' + iconPlace.doorId + '）'
                                                          : '壁の面（partId=' + iconPlace.partId + '）'))
        : 'なし（ボタンを押していない）',
      直近のメッセージ: msg,
      選択中の階: selFloorId,
      階の仕切り数: selFloor ? (selFloor.partitions || []).length : null,
      階の扉数: selFloor ? (selFloor.doors || []).length : null,
      階の機器: selFloor ? (selFloor.icons || []).map(ic => ({
        id: ic.id, 名前: ic.name,
        種別: ic.doorId ? '扉' : (ic.partitionId ? '壁' : '床置き'),
        partitionId: ic.partitionId || null, doorId: ic.doorId || null,
        位置: (ic.partitionId || ic.doorId) ? { sM: ic.sM, tM: ic.tM }
                                            : { gx: ic.gx, gy: ic.gy, rotDeg: ic.rotDeg },
        寸法: { wM: ic.wM, hM: ic.hM },
      })) : null,
      プレビュー中: iconPreview,
      選択中の機器: selIconId,
    });
    // ドラッグ経路のログ。__dragTrace() で採取開始 → 実際にドラッグ → __dragDump() で読む
    window.__dragTrace = (on) => {
      window.__dragLogOn = (on !== false);
      window.__dragLog = [];
      return window.__dragLogOn ? '採取開始。機器をドラッグしてから __dragDump() を実行' : '採取停止';
    };
    window.__dragDump = () => (window.__dragLog || []);
  });
  const [floorAddZ, setFloorAddZ] = useState('0');
  const [floorAddH, setFloorAddH] = useState('3');
  // 【spec 12章】ホバーは選択のプレビュー。配電盤と同じく選択と同値・同色で扱う
  const [dragPreview, setDragPreview] = useState(null); // F2: ドラッグ中の一時表示のみ。buildingsは変更しない
  // 扉のドラッグ中の一時表示。壁と同じく本体は mouseup まで変えない（undo履歴を汚さない）
  const [doorPreview, setDoorPreview] = useState(null); // {doorId, uM} | null
  // '2d' | '3d'。3d選択中だけBuildingPreview3Dをマウントする（Cesium Viewerを持ちっぱなしにしない）。
  const mppRef = useRef(_bcMpp());
  const dragRef = useRef(null); // {mode:'endpoint'|'move', which:'a'|'b', partId, origA, origB, startGrid, axis, moved}

  // ══ 形を持つもの（ホスト）の一覧 ── 2026-11-05 ══
  // 階・仕切り・扉・機器は「形を持つもの」に付く。建屋（blocks）だけでなく
  // 立体（CSG の ops）も階を持てるようにしたので、同じ一覧に並べる。
  // 【なぜ一覧に出すか】仕組みが付いても選べなければ「機能が無い」に見える。
  // 【立体を選んだとき】「ガワ」の欄は空になる（blocks が無いので）。
  //   立体の形は立体エディタ（⬡）で編集するので、これが正しい姿。
  const ホストら = React.useMemo(
    () => [...(buildings || []), ...(bodies || [])],
    [buildings, bodies]);
  // 初回・一覧が空→非空になった時に先頭を選択
  useEffect(() => {
    if (!selBuildingId && ホストら.length > 0) setSelBuildingId(ホストら[0].id);
  }, [ホストら, selBuildingId]);

  const selBuilding = ホストら.find(b => b.id === selBuildingId) || null;
  const sel立体 = !!(selBuilding && Array.isArray(selBuilding.ops));
  // ══ 面に描いた矩形 → 増築棟（CAD の「面にスケッチ → 押し出し」）・2026-09-23 ══
  // 【受け取り方】辺の番号でなく **実座標の2点**（ax,ay）〜（bx,by）で受ける。
  //   solid は points を CCW 正規化するので、solid の辺番号と記録の辺番号はずれる。
  //   座標で「どの辺の上か」を探せば取り違えない。
  // 【出幅】いまは既定 5m。作った後にその面を選んで「＋外へ／−内へ」で調整する
  //   （矢印ドラッグで出幅を決めるのは次の段階）。
  const _applyFaceSketch = (r) => {
    if (!r || !selBuilding || !onAddBlock) return;
    const blk = (selBuilding.blocks || [])[r.blockIdx];
    if (!blk || !Array.isArray(blk.points)) return;
    const q = blk.points, n = q.length;
    // 矩形の2点が乗っている辺を探す（両端とも辺の線上にある辺）
    let best = null;
    for (let i = 0; i < n; i++) {
      const a = q[i], b = q[(i + 1) % n];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(L > 1e-6)) continue;
      const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      const uOf = (px, py) => (px - a.x) * ux + (py - a.y) * uy;
      const dOf = (px, py) => {
        const tt = uOf(px, py);
        return Math.hypot(px - (a.x + tt * ux), py - (a.y + tt * uy));
      };
      const far = Math.max(dOf(r.ax, r.ay), dOf(r.bx, r.by));
      if (far < 0.6 && (!best || far < best.far)) {
        best = { i, far, u0: uOf(r.ax, r.ay), u1: uOf(r.bx, r.by), L };
      }
    }
    if (!best) { setMsg('その面には増築できません（壁を選んでください）'); return; }
    const made = (typeof makeSharedWallChildBlock === 'function') ? makeSharedWallChildBlock({
      parentPoints: q, parentBlockIdx: r.blockIdx, parentEdge: best.i,
      uMin: Math.min(best.u0, best.u1), uMax: Math.max(best.u0, best.u1),
      depthGrid: 5 / ((typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1),
      // 【2026-09-23】**ドラッグで指定した高さをそのまま使う**（浮かせたいときは浮く）。
      // 一度「線が出るから」と地面に揃えたが、それは私の都合でユーザーの指定を無視していた。
      // 線の方は描画側で消した（セルの内部の辺を引かない＝poly.edges）。
      zMin: r.zMin, zMax: r.zMax,
    }) : null;
    if (!made) { setMsg('その範囲には作れません'); return; }
    onAddBlock(selBuilding.id, made.points, made.zBottom, made.zTop, made.extraProps);
    setMsg('');
  };
  const selFloor = selBuilding && (selBuilding.floors || []).find(f => f.id === selFloorId) || null;
  // 【Phase D】この建物に載っている盤の箱。3Dへ渡すのも、吸い付きの相手にするのもこれ。
  // 【useMemo 必須】これを毎レンダー作り直すと 3D の scene（部屋認識を含む重い計算）の
  // deps が毎回変わって再計算が走る。配列は「中身が変わったときだけ」新しくする
  const bldPanelBoxes = useMemo(
    () => (panelBoxes || []).filter(b => b.buildingId === selBuildingId),
    [panelBoxes, selBuildingId]);
  // 床置きの箱＝床置き機器＋盤。吸い付きの相手・警告の対象はこの結合リストで見る。
  // 「機器→盤」「盤→機器」「盤→盤」が全部この1本で成立する
  const floorBoxesOf = useCallback((fl) => [
    ...((fl && fl.icons) || []).filter(bcIsFloorIcon),
    ...bldPanelBoxes.filter(b => b.floorId === (fl && fl.id)),
  ], [bldPanelBoxes]);

  useEffect(() => {
    if (!selBuilding) { setSelFloorId(null); return; }
    const floors = bcSortedFloors(selBuilding);
    if (!floors.find(f => f.id === selFloorId)) setSelFloorId(floors[0] ? floors[0].id : null);
  }, [selBuildingId, selBuilding && selBuilding.floors]);





  // 床の形を確定する。確定後、床の外に出てしまった仕切りを警告として列挙する
  // （自動削除はしない。消すかどうかはユーザーが決める＝spec 8章#9の方針）
  const commitFloorOutline = useCallback((pts) => {
    if (!selBuilding || !selFloor) return;
    const err = onSetFloorOutline ? onSetFloorOutline(selBuilding.id, selFloor.id, pts) : '未接続';
    setMsg(err);
    setFloorEdit(null);
    if (!err) {
      setTimeout(() => {
        const outs = getPartitionsOutsideFloor ? getPartitionsOutsideFloor(selBuilding.id, selFloor.id) : [];
        setOutsideWarn(outs);
        if (outs.length) setMsg(`床の外に出た仕切りが${outs.length}本あります（一覧で赤く表示）。不要なら削除してください`);
      }, 100);
    }
  }, [selBuilding, selFloor, onSetFloorOutline, getPartitionsOutsideFloor]);

  // 右クリック＝作図の確定/中断。2Dのcontextmenuと3Dのcontextmenuの両方から呼ぶ。
  // 片方にしか無いと「3Dでは中断できない」という差になる（段階C・一本化）
  const drawCancelOrCommit = useCallback(() => {
    if (iconPlace) { setIconPlace(null); setMsg(null); return; }
    if (doorPlace) { setDoorPlace(null); setMsg(null); return; }
    if (floorEdit) {
      // 3点以上あれば確定。それ未満は中断（面にならないため）
      if (floorEdit.pts.length >= 3) commitFloorOutline(floorEdit.pts);
      else { setFloorEdit(null); setMsg(null); }
      return;
    }
    setTool(null); setDrawPts([]); setMsg(null); dragRef.current = null; setDragPreview(null);
  }, [floorEdit, commitFloorOutline, doorPlace, iconPlace]);


  const floors = selBuilding ? bcSortedFloors(selBuilding) : [];
  const rooms = selFloor && (selFloor.partitions || []).length > 0 ? bcDeriveRooms(selBuilding, selFloor, pnDeg) : [];
  // 床の外へ出た床置きの箱（機器＋盤）。**弾かずに一覧で知らせる**だけ
  // （仕切りの「⚠床の外」と同じ扱い。盤は建物側の都合で縮めてよい物ではないので特にそう）
  const floorIconWarn = (selBuilding && selFloor)
    ? bcFloorBoxesOutside(selBuilding, selFloor, floorBoxesOf(selFloor)) : [];
  // 階高を突き抜ける箱。盤は clamp しないので、代わりにここで知らせる（Codex監査の指示）
  const floorIconTallWarn = selFloor ? bcFloorBoxesTooTall(selFloor, floorBoxesOf(selFloor)) : [];
  // 【階編集モード・段階B】true のとき、3Dはその階だけを見せる（ガワ・他階は非表示）。
  // 入ると真上視点へ移動するが、そのあとは中ボタンで自由に回せる（spec 14.2）
  const [floorEditMode, setFloorEditMode] = useState(false);
  // 【建物を切り替えたときだけ】解除する。
  // 階を切り替えたときに解除すると、編集中に別の階をクリックしただけで全体表示に
  // 戻ってしまい作業が中断される（ユーザー指摘）。階の切替はモードを保ったまま
  // 「その階の編集」へ移るのが自然
  useEffect(() => { setFloorEditMode(false); }, [selBuildingId]);

  // ── 作図（2Dと3Dで共通・段階C）──
  // 「グリッド座標の点が1つ来た」だけを入力にする。2Dは screenToGrid、
  // 3Dは床面への逆投影で点を作り、どちらもここへ流す。
  // ロジックを1本にしておかないと、2Dと3Dで吸い付きの挙動がズレる
  // （spec 12.16 で作図と編集の実装を揃えたのと同じ理由）
  const drawSnap = useCallback((a, g, g2s) => _beGuidePoint(a, _bePnAxes(pnRot), g, g2s).p, [pnRot]);
  // face = 3Dで「クリックした壁・扉の面そのもの」の上の点（{gx,gy,z,partId,doorId}）。
  // 2Dからは渡らない（2Dは真上から見ているので床の点で表裏が正しく出る）
  const drawClickAt = useCallback((g, g2s, face) => {
    if (!selBuilding || !selFloor) return;
    // 【機器の配置】壁のどちら側に置くかは、**壁線へ射影する前**のカーソル位置で決める。
    // 射影後の点は壁の上に乗るので左右が決まらない（監査指摘）
    if (iconPlace) {
      // 【盤を壁に取り付ける】押した場所に一番近い壁（曲面も可）へ付ける・2026-10-01
      if (iconPlace.panelId) {
        setMsg(onMountPanel
          ? onMountPanel(iconPlace.panelId, selBuilding.id, selFloor.id, g,
              Object.assign({}, face && Number.isFinite(face.z) ? { zM: face.z } : null))
          : '未接続');
        setIconPlace(null);
        return;
      }
      // 【天井】クリックした点の真上（天井面）に置く。照明・感知器
      if (iconPlace.ceil) {
        setMsg(onAddCeilIcon ? onAddCeilIcon(selBuilding.id, selFloor.id, g.x, g.y) : '未接続');
        setIconPlace(null);
        return;
      }
      // 【床置き】クリックした床の点にそのまま置く
      if (iconPlace.floor) {
        setMsg(onAddFloorIcon ? onAddFloorIcon(selBuilding.id, selFloor.id, g.x, g.y) : '未接続');
        setIconPlace(null);
        return;
      }
      // 【外壁の面・2026-10-01】建屋のガワ（曲面を含む）。どの辺に付くかは選ばせず、
      // クリック点から一番近い外壁へ付ける（bcPickOuterSpot が決める）。
      // 扇形の円弧も「1本の辺」なので、弧に沿った位置がそのまま決まる
      if (iconPlace.outer) {
        setMsg(onAddOuterIcon
          ? onAddOuterIcon(selBuilding.id, selFloor.id, g,
              Object.assign({}, face && Number.isFinite(face.z) ? { zM: face.z } : null))
          : '未接続');
        setIconPlace(null);
        return;
      }
      // 【壁の面 / 扉の面】どちらに置くかは iconPlace.doorId の有無だけで決まる。
      // クリック点 → 面ローカルの位置と表裏は bcIconSpotAtPoint の1本で出す
      // （置くときと掴むときで別々に射影を書くと、置いた位置と掴んだ位置がズレる）
      const hostRef = iconPlace.doorId ? { doorId: iconPlace.doorId }
                                       : { partitionId: iconPlace.partId };
      // 【3Dで面をクリックできたときは、その面の上の点で決める・2026-09-06】
      // 床の点へ落とすと、垂直な扉・壁では光線が向こう側へ抜けて
      // **裏面に付き・位置もずれる**（ユーザー報告）。面が取れたときだけそちらを使う。
      // 取れないとき（2Dからの呼び出し等）は従来どおり床の点で決める
      const useFace = face && ((iconPlace.doorId && face.doorId === iconPlace.doorId)
                            || (!iconPlace.doorId && face.partId === iconPlace.partId));
      const spot = useFace
        ? bcIconSpotAtFacePoint(selFloor, hostRef, { x: face.gx, y: face.gy }, face.z)
        : bcIconSpotAtPoint(selFloor, hostRef, g);
      if (!spot) { setIconPlace(null); setMsg(iconPlace.doorId ? '扉が見つかりません' : '壁が見つかりません'); return; }
      setMsg(onAddIcon ? onAddIcon(selBuilding.id, selFloor.id, iconPlace.partId,
                                   spot.sM, spot.side,
                                   Object.assign({},
                                     iconPlace.doorId ? { doorId: iconPlace.doorId } : null,
                                     Number.isFinite(spot.tM) ? { tM: spot.tM } : null)) : '未接続');
      setIconPlace(null);
      return;
    }
    // 【扉の配置】クリックした位置を対象の壁へ射影して、その位置に扉を置く。
    // 壁の中央固定だった元の作りを、位置を指定できる形に直したもの
    if (doorPlace) {
      const part = (selFloor.partitions || []).find(q => q.id === doorPlace.partId);
      if (!part) { setDoorPlace(null); setMsg('壁が見つかりません'); return; }
      const uM = bcDoorUAtPoint(part, g);
      setMsg(onAddDoor ? onAddDoor(selBuilding.id, selFloor.id, part.id, uM) : '未接続');
      setDoorPlace(null);
      return;
    }
    // 【床の形】頂点を順に打つ。始点の●（画面px）をクリックしたら閉じて確定。
    // 2Dのmousedownに直書きしていた分岐をここへ引き上げ、作図の入口を1本にした。
    // 閉じ判定は2Dのときと同じ「画面px」基準のまま（グリッド距離に変えると操作感が変わる）
    if (floorEdit) {
      if (floorEdit.pts.length >= 3) {
        const s0 = g2s(floorEdit.pts[0].x, floorEdit.pts[0].y);
        const sg = g2s(g.x, g.y);
        if (Math.hypot(sg.x - s0.x, sg.y - s0.y) < BC_OUTLINE_CLOSE_PX) {
          commitFloorOutline(floorEdit.pts); return;
        }
      }
      setFloorEdit({ pts: [...floorEdit.pts, g] });
      return;
    }
    if (!tool) return;
    if (drawPts.length === 0) { setDrawPts([g]); setCursorG(g); return; }
    const a = drawPts[0];
    const b = drawSnap(a, g, g2s);
    setMsg(onAddPartition ? onAddPartition(selBuilding.id, selFloor.id, a, b, tool) : '未接続');
    setDrawPts([]); setCursorG(null);
  }, [tool, selBuilding, selFloor, drawPts, drawSnap, onAddPartition, floorEdit, commitFloorOutline, doorPlace, onAddDoor, iconPlace, onAddIcon, onAddFloorIcon]);


  // 3D側の投影（吸い付き判定を2Dと同じ「画面px」基準にするため借りる）
  const proj3DRef = useRef(null);
  const gridToScreen3D = useCallback((gx, gy) =>
    (proj3DRef.current ? proj3DRef.current(gx, gy) : { x: 0, y: 0 }), []);

  // 3Dに出す作図の予告（候補線とPN2軸ガイド／床の形の頂点）。2Dの描画と同じ材料から作る
  const draw3D = useMemo(() => {
    const none = { ghost: null, guides: null, poly: null };
    if (!selFloor) return none;
    // 【床の形・段階C】打った頂点のポリラインを3Dにも出す。
    // 表示専用にとどめ、確定判定は drawClickAt / drawCancelOrCommit の1本に任せる
    if (floorEdit) return { ghost: null, guides: null, poly: { pts: floorEdit.pts, z: selFloor.levelZ } };
    if (!tool || drawPts.length !== 1) return none;
    const a = drawPts[0];
    const dirs = _bePnAxes(pnRot);
    const gp = cursorG ? _beGuidePoint(a, dirs, cursorG, gridToScreen3D) : null;
    const z = selFloor.levelZ;
    return {
      guides: { from: a, dirs, snappedIdx: gp ? gp.snappedIdx : -1, z },
      ghost: gp ? {
        a, b: gp.p, kind: tool,
        thicknessM: BC_PARTITION_DEFAULTS.thicknessM,
        zB: z, zT: z + selFloor.heightM,
      } : null,
      poly: null,
    };
  }, [tool, selFloor, drawPts, cursorG, pnRot, gridToScreen3D, floorEdit]);

  // 【3Dのギズモ・spec 7.10】配置は配電盤(panelGizmoHandles)と同じ規約にする:
  //   pos ● = 面の中心（板を法線方向へ動かす）
  //   範囲 ◆ = 各辺の中央（その方向の範囲を伸縮）
  // 角に置くと「何ができるか」が分からず、上辺・側辺をつかむ操作にもならない（ユーザー指摘）
  // 【主役の壁 id・2026-09-11】selPartId は「選んだ壁」と「選んだ機器・扉が乗っている壁」の2つの意味を兼ねる。
  // 機器・扉を選んでいるときにもそのまま使うと、3Dでは**乗っている壁全体が橙**になり、
  // 一覧の壁の行も選択色になり、壁の端点●まで出る（ユーザー報告「エディタでクリックしても橙が出ない」の一因・監査指摘）。
  // 見た目と壁の操作（3Dの強調・一覧の行・端点ギズモ）はこの1つの値を使う。selPartId 自体は回転の中心などで使うので残す
  const hotPartId = (selIconId || selDoorId) ? null : selPartId;
  const selWall3D = useMemo(() => {
    if (!selFloor || !hotPartId) return null;
    const p0 = (selFloor.partitions || []).find(q => q.id === hotPartId);
    if (!p0) return null;
    // ドラッグ中はプレビュー座標を使う。使わないとギズモだけ置き去りになる（ユーザー指摘）
    // ドラッグ中はプレビュー座標を使う。**高さ・下端も**プレビューから取らないと、
    // 上下のハンドルだけが元の位置に取り残される（2026-08-26 ユーザー指摘）
    const p = (dragPreview && dragPreview.partId === hotPartId)
      ? { ...p0, a: dragPreview.a, b: dragPreview.b,
          heightM: dragPreview.heightM !== undefined ? dragPreview.heightM : p0.heightM,
          baseM: dragPreview.baseM !== undefined ? dragPreview.baseM : p0.baseM }
      : p0;
    const zB = selFloor.levelZ + (p.baseM || 0);
    const zT = zB + (p.heightM != null ? p.heightM : selFloor.heightM);
    const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
    const zMid = (zB + zT) / 2;
    return {
      partId: p.id, a: p.a, b: p.b, z: zB, zT,
      // 【pos ● は置かない】平行移動は「面をドラッグ」で同じことができるので重複する
      // （ユーザー指摘）。配電盤は面をドラッグできないので pos が要るが、
      // 建物は面を掴めるようにしてあるため不要
      handles: [
        { type: 'a',   kind: 'span', x: p.a.x, y: p.a.y, z: zMid },  // 側辺の中央＝端点を伸縮
        { type: 'b',   kind: 'span', x: p.b.x, y: p.b.y, z: zMid },
        { type: 'top',  kind: 'span', x: mid.x, y: mid.y, z: zT },   // 上辺の中央＝天端
        { type: 'base',  kind: 'span', x: mid.x, y: mid.y, z: zB },  // 下辺の中央＝下端
        // 【中心の●】壁ごと上下に動かす（高さは変えない）。数値欄を増やす代わりに
        // ここで直感的に昇降させる（2026-08-26 ユーザー指示）
        { type: 'vmove', kind: 'pos', x: mid.x, y: mid.y, z: (zB + zT) / 2 },
      ],
    };
  }, [selFloor, hotPartId, dragPreview]);

  // 3Dのギズモ操作。2Dと同じくPN2軸ガイドへ吸い付き、確定時だけ検証を通す
  const grab3DRef = useRef(null); // 掴んだ瞬間の壁の姿（差分の基準）
  const [gizGuide, setGizGuide] = useState(null); // ドラッグ中に出すガイド
  const [gizDim, setGizDim] = useState(null);     // ドラッグ中に出す寸法 {handle, text}
  const onDragGizmo3D = useCallback((pid, handle, g, commit) => {
    if (!selFloor || !selBuilding) return;
    const cur = (selFloor.partitions || []).find(q => q.id === pid);
    if (!cur) return;
    if (!grab3DRef.current || grab3DRef.current.partId !== pid || commit === false && !grab3DRef.current.active) {
      grab3DRef.current = { partId: pid, a: { ...cur.a }, b: { ...cur.b },
                            heightM: cur.heightM != null ? cur.heightM : selFloor.heightM,
                            baseM: cur.baseM || 0, active: true };
    }
    const o = grab3DRef.current;
    if (handle === 'top') {
      const h = Math.max(0.1, o.heightM + (g.dM || 0));
      if (!commit) { setDragPreview({ partId: pid, a: o.a, b: o.b, heightM: h, mode: 'height' });
                       setGizDim({ handle: 'top', text: '高さ ' + h.toFixed(2) + ' m' }); return; }
      grab3DRef.current = null; setDragPreview(null); setGizGuide(null); setGizDim(null);
      setMsg(onApplyPartEdit ? onApplyPartEdit(selBuilding.id, bcEditPartId(selFloor.id, pid), { heightM: h }) : '未接続');
      return;
    }
    if (handle === 'vmove') {
      // 壁ごと昇降。高さは変えない
      const nb = Math.max(0, (o.baseM || 0) + (g.dM || 0));
      if (!commit) { setDragPreview({ partId: pid, a: o.a, b: o.b, baseM: nb, heightM: o.heightM, mode: 'vmove' });
                       setGizDim({ handle: 'vmove', text: '下端 ' + nb.toFixed(2) + ' m' }); return; }
      grab3DRef.current = null; setDragPreview(null); setGizGuide(null); setGizDim(null);
      setMsg(onApplyPartEdit ? onApplyPartEdit(selBuilding.id, bcEditPartId(selFloor.id, pid), { baseM: nb }) : '未接続');
      return;
    }
    if (handle === 'base') {
      // 下端を上げると壁が浮く。天端は動かさないので高さは同じ分だけ減る
      const nb = Math.max(0, (o.baseM || 0) + (g.dM || 0));
      const h = Math.max(0.1, o.heightM - (nb - (o.baseM || 0)));
      if (!commit) { setDragPreview({ partId: pid, a: o.a, b: o.b, baseM: nb, heightM: h, mode: 'base' });
                       setGizDim({ handle: 'base', text: '下端 ' + nb.toFixed(2) + ' m' }); return; }
      grab3DRef.current = null; setDragPreview(null); setGizGuide(null); setGizDim(null);
      setMsg(onApplyPartEdit ? onApplyPartEdit(selBuilding.id, bcEditPartId(selFloor.id, pid), { baseM: nb, heightM: h }) : '未接続');
      return;
    }
    const dirs = _bePnAxes(pnRot);
    // 【掴んだ点からの差分で動かす】カーソル位置をそのまま端点にすると、
    // ハンドル（側辺の中央）を掴んだのに端点がカーソルへ飛んでくる（ユーザー指摘）。
    // 掴んだ瞬間のカーソル位置を基準にした差分を足せば、掴んだ場所がずれない
    if (!o.grab) o.grab = { ...g };
    const moved = { x: g.x - o.grab.x, y: g.y - o.grab.y };
    const fixed = handle === 'a' ? o.b : o.a;
    const raw = handle === 'a' ? { x: o.a.x + moved.x, y: o.a.y + moved.y }
                               : { x: o.b.x + moved.x, y: o.b.y + moved.y };
    const gp = _beGuidePoint(fixed, dirs, raw, gridToScreen3D);
    const a = handle === 'a' ? gp.p : o.a;
    const b = handle === 'a' ? o.b : gp.p;
    const guide = { from: fixed, dirs, snappedIdx: gp.snappedIdx, z: selFloor.levelZ };
    if (!commit) { setDragPreview({ partId: pid, a, b, mode: 'gizmo' }); setGizGuide(guide);
      setGizDim({ handle, text: '長さ ' + (Math.hypot(b.x-a.x, b.y-a.y) * _bcMpp()).toFixed(2) + ' m' }); return; }
    grab3DRef.current = null; setDragPreview(null); setGizGuide(null); setGizDim(null);
    setMsg(onApplyPartEdit ? onApplyPartEdit(selBuilding.id, bcEditPartId(selFloor.id, pid), { a, b }) : '未接続');
  }, [selFloor, selBuilding, pnRot, gridToScreen3D, onApplyPartEdit]);

  // ── 3Dで壁を掴んで動かす（段階A）──
  // ドラッグ中は本体を変えず dragPreview だけ更新し、確定時に bcApplyPartEdit を通す。
  // 2DのF2と同じ考え方（ドラッグ中に検証を回すと重く、途中の無効な状態で弾かれる）
  const drag3DRef = useRef(null); // {floorId, partId, origA, origB}
  // 【「編集中の階」と「クリックで選んだ床」は別物】
  // 前者(selFloorId)は常に値があるので、これでハイライトすると床が永久にオレンジになり
  // 「何を選んだか」が分からなくなる（ユーザー指摘）。選択は排他で1つだけ光らせる
  const [selFloorHi, setSelFloorHi] = useState(null);
  // ══════════════════════════════════════════════════════════════════
  // 選択の入口はここ1つ・2026-09-11
  // ══════════════════════════════════════════════════════════════════
  // 【ユーザー報告】「建屋エディタ内でクリックしてオレンジにしたが、
  //   ほかのウインドウで同じ機器がオレンジにならない」
  // 【原因】このエディタの選択（selIconId / selPartId / selDoorId / selFloorHi）は
  //   内部だけに持っていて、平面図・3次元図などの選択（App の selBldPart）に伝わっていなかった。
  //   盤だけは onSelectPanel で別に伝えていた（橋が種類ごとに別々）。
  // 【なぜ useEffect で state を見張らないか】見張る方式だと「背景クリックで外した」
  //   「階を切り替えた」「削除した」の区別がつかず、他の窓の選択を勝手に消してしまう（監査指摘）。
  //   選ぶ操作そのものをこの1関数に通し、**意図と一緒に**知らせる。
  // next = { iconId, partId, doorId, floorHi, fId }（省略したものは null＝排他）
  // 知らせる ref: 盤 {kind:'panel'} / 機器 {kind:'icon'} / 扉 {kind:'door'} / 壁・透明仕切り {kind:'wall'}
  //   / 何も選ばない・床を選んだ null（App 側で選択解除）
  // 【削除後の片付けはここを通さない】消した物の id を外すだけで「選ぶ操作」ではないので、
  //   他の窓へは知らせない（その場の setSelXxx(null) のまま）
  // 【識別子を安定させる】建物・階・盤の箱は編集のたびに新しいオブジェクトになる。
  //   それを依存に入れるとこの関数が毎回作り直され、3Dへ渡す onSelectIcon 等も毎回変わって
  //   ドラッグ中に効果が張り直される。最新値は ref から読む
  const _selCtxRef = useRef({});
  _selCtxRef.current = { selBuilding, selFloor, bldPanelBoxes, onSelectPart,
    selBuildingId, selIconId, selPartId, selDoorId, panelBoxes, buildings };
  // 内部の選択 → 他の窓へ知らせる形（ref）。送るときと、逆方向の「今何を映しているか」の比較で同じ関数を使う
  const _refOfLocal = (n) => {
    const c = _selCtxRef.current;
    const bId = c.selBuilding ? c.selBuilding.id : null;
    const fId = n.fId || (c.selFloor ? c.selFloor.id : null);
    const fl = c.selBuilding && (c.selBuilding.floors || []).find(f => f.id === fId);
    const box = n.iconId && (c.bldPanelBoxes || []).find(b => b.id === n.iconId);
    if (box) return { kind: 'panel', id: box.panelId };
    if (n.iconId) return { kind: 'icon', id: n.iconId, bId, fId };
    if (n.doorId) return { kind: 'door', id: n.doorId, bId, fId };
    // 床の行は合成id（bcEditPartId）なので仕切りに無い。壁として送ると何も光らず他だけ消える
    if (n.partId && fl && (fl.partitions || []).some(q => q.id === n.partId))
      return { kind: 'wall', id: n.partId, bId, fId };
    return null;
  };
  const selectLocal = useCallback((next) => {
    const n = { iconId: null, partId: null, doorId: null, floorHi: null, fId: null, ...(next || {}) };
    setSelIconId(n.iconId); setSelPartId(n.partId); setSelDoorId(n.doorId); setSelFloorHi(n.floorHi);
    const c = _selCtxRef.current;
    if (c.onSelectPart) c.onSelectPart(_refOfLocal(n));
  }, []);
  // ══ 他の窓で選んだものをこのエディタにも映す・2026-09-11 ══
  // 【ユーザー報告】「ほかのウインドウで選択したときに建屋エディタで選択状態にならない」
  // 【こだまの判定】App から来た選択（extSel）と「今エディタが映している選択」を同じ形のキーで比べ、
  //   違うときだけ反映する。反映は通知しない（往復しない）。
  //   「最後に送ったキー」と比べる方式だと、他窓で X→Y→X と選び直したとき3回目を
  //   自分のこだまと取り違えて Y のまま残る（監査指摘）。今の状態と比べれば何度走っても同じ結果になる。
  // 【依存はキーだけ】盤の箱の配列などを依存に入れると、他窓で盤を動かすたびに再発火する
  // 【暫定】選択の正は App とこのエディタの2箇所に残っている。根本は選択を App へ持ち上げること
  const _keyOfRef = (r) => (!r ? 'none' : r.kind + ':' + r.id);
  const _extKey = !extSel ? 'none'
    : (extSel.panelId ? 'panel:' + extSel.panelId
       : (extSel.part ? extSel.part.kind + ':' + extSel.part.id : 'none'));
  useEffect(() => {
    const c = _selCtxRef.current;
    const local = _refOfLocal({ iconId: c.selIconId, partId: c.selPartId, doorId: c.selDoorId });
    if (_keyOfRef(local) === _extKey) return;
    const clear = () => { setSelIconId(null); setSelPartId(null); setSelDoorId(null); setSelFloorHi(null); };
    if (extSel && extSel.panelId) {
      // 盤は建物の箱の一覧（建物で絞る前）から引く。絞った後だと別の建物の盤が見つからない
      const box = (c.panelBoxes || []).find(b => b.panelId === extSel.panelId);
      if (!box) { clear(); return; }
      if (box.buildingId !== c.selBuildingId) setSelBuildingId(box.buildingId);
      if (box.floorId) setSelFloorId(box.floorId);
      setSelIconId(box.id); setSelPartId(null); setSelDoorId(null); setSelFloorHi(null);
      return;
    }
    const part = extSel && extSel.part;
    const b = part && (c.buildings || []).find(x => x.id === part.bId);
    const fl = b && (b.floors || []).find(f => f.id === part.fId);
    if (!part || !fl) { clear(); return; }
    if (part.bId !== c.selBuildingId) setSelBuildingId(part.bId);
    setSelFloorId(part.fId);
    setSelFloorHi(null);
    if (part.kind === 'icon') {
      const ic = (fl.icons || []).find(x => x.id === part.id);
      const dr = ic && ic.doorId ? (fl.doors || []).find(d => d.id === ic.doorId) : null;
      // 一覧の行と同じ partId を入れる（壁付け＝その壁、扉付け＝扉の壁、床置き＝床の行）
      const hostPart = ic ? (ic.partitionId || (dr && dr.partitionId) || bcEditPartId(part.fId, null)) : null;
      setSelIconId(part.id); setSelDoorId(null); setSelPartId(hostPart);
    } else if (part.kind === 'door') {
      const dr = (fl.doors || []).find(d => d.id === part.id);
      setSelIconId(null); setSelDoorId(part.id); setSelPartId(dr ? dr.partitionId : null);
    } else if (part.kind === 'wall') {
      setSelIconId(null); setSelDoorId(null); setSelPartId(part.id);
    } else clear();
  }, [_extKey]);
  // 📷の寄せ先が別の建物なら、その建物を表示する（カメラを寄せるのは3D側。建物が映るまで3D側が待つ）
  const _focusSeqRef = useRef(focusReq && focusReq.seq);
  useEffect(() => {
    if (!focusReq || focusReq.seq === _focusSeqRef.current) return;
    _focusSeqRef.current = focusReq.seq;
    if (focusReq.buildingId && focusReq.buildingId !== _selCtxRef.current.selBuildingId)
      setSelBuildingId(focusReq.buildingId);
  }, [focusReq && focusReq.seq]);
  // 掴めたかどうかを返す。掴めなかったら呼び出し側はカメラ操作に回す。
  // ここで黙って return すると「壁ドラッグ状態なのに何も動かず、カメラも動かない」
  // 袋小路になる（ユーザー報告「つかみが無効になる」の再発防止）
  const onGrabWall3D = useCallback((fid, pid) => {
    const fl = selBuilding && (selBuilding.floors || []).find(f => f.id === fid);
    const pt = fl && (fl.partitions || []).find(p => p.id === pid);
    if (!pt) return false;
    drag3DRef.current = { floorId: fid, partId: pid, origA: { ...pt.a }, origB: { ...pt.b } };
    // 選択は排他（床・扉・機器の選択は外れる）。入口は selectLocal 1つ
    selectLocal({ partId: pid, fId: fid });
    return true;
  }, [selBuilding, selectLocal]);
  // 【扉・3D】選ぶ / 壁に沿ってスライドする。2Dの mode:'door' と同じ計算を使う
  const onSelectDoor3D = useCallback((doorId, partId) => {
    selectLocal({ doorId, partId });
  }, [selectLocal]);
  // 【機器・3D】選ぶ / 壁の面の上を動かす（壁に沿って＋上下の2方向）
  // 盤の箱を選んだときも同じ入口（selectLocal が kind:'panel' として他の窓へ知らせる）
  const onSelectIcon3D = useCallback((iconId, partId) => {
    selectLocal({ iconId, partId });
  }, [selectLocal]);
  // ds/dt は3D側が「壁の面の上の2軸」で解いた移動量[m]。ここでは足すだけ
  // ds/dt は3D側が「その物が乗っている面の2軸」で解いた移動量[m]。
  // 壁面なら（壁に沿って・上下）、床置きなら（幅方向・奥行き方向）。式は同じ
  // 【盤も同じ経路を通る】掴む・動かす・吸い付くまでは機器と完全に同じ計算。
  // 分かれるのは確定の書き込み先だけ（floor.icons か placedPanels か）。Codex監査の指示
  const moveStartRef = useRef(null);   // 移動ドラッグ開始時の位置（二重加算の防止）
  const onDragIcon3D = useCallback((fid, pid, iconId, dsM, dtM, commit) => {
    const fl = selBuilding && (selBuilding.floors || []).find(f => f.id === fid);
    const ic = (fl && (fl.icons || []).find(x => x.id === iconId))
            || bldPanelBoxes.find(b => b.id === iconId);
    if (!fl || !ic) return;
    let raw, patch;
    if (bcIsFloorIcon(ic)) {
      // 【開始位置を覚える】ドラッグ中も本体へ書くので ic.gx/gy は毎回動く。
      // ds/dt は掴んだ瞬間から測った累積量なので、毎回 ic.gx に足すと二重に動く（回転と同じ罠）。
      // 【基底もドラッグ開始時に凍結する】2軸は ic.rotDeg から決まる「幅方向・奥行方向」。
      // 壁の吸い付きは向きを90°単位で変えるので、毎フレーム作り直すと、その瞬間に
      // 同じ (dsM,dtM) が別の世界座標へ写り、カーソルと箱がずれる（2026-08-31 ユーザー指摘）。
      // dsM/dtM が「開始からの差分」である以上、それを世界へ写す基底も開始時のものに固定する。
      // 向き自体は吸い付きで変わってよい（吸い付きの along 計算は現在の姿勢を使う。役割が違う）。
      // 【角度も開始時に凍結する・2026-09-01】位置と同じ理屈。吸い付きは rotDeg を
      // 書き換えて本体へ入るので、次のフレームの raw は「吸い付いた後の角度」を引き継ぐ。
      // すると壁から離れても角度が戻らず、さらに吸い付きの面選び（今の角度から90°単位で
      // 最も近い姿勢）も吸い付き後の角度を基準にしてしまい、履歴で結果が変わる。
      // 毎フレーム「開始時の角度」から作り直せば、離せば元に戻り、面選びも安定する。
      if (!moveStartRef.current || moveStartRef.current.iconId !== iconId) {
        const g0 = bcFloorIconGeom(fl, ic);
        moveStartRef.current = { iconId, gx0: ic.gx, gy0: ic.gy, rot0: ic.rotDeg || 0,
          ux: (g0.axisS.x - ic.gx), uy: (g0.axisS.y - ic.gy),   // 1m ぶんのグリッドベクトル
          vx: (g0.axisT.x - ic.gx), vy: (g0.axisT.y - ic.gy) };
      }
      const { gx0, gy0, rot0, ux, uy, vx, vy } = moveStartRef.current;
      raw = { ...ic, rotDeg: rot0,
                     gx: gx0 + ux * (dsM || 0) + vx * (dtM || 0),
                     gy: gy0 + uy * (dsM || 0) + vy * (dtM || 0) };
      // 【吸い付き】壁にも、他の機器にも、他の盤にも吸い付く。入口は bcSnapFloorBox の1本。
      // 相手のリストを渡すのは呼び出し側の責務（建物コアは盤を知らない）。
      // 許容量は画面px由来（作図の吸い付きと同じ思想）。
      // 画面10px が何グリッドに当たるかを、3Dの投影を借りて実測して渡す
      const sn = bcSnapFloorBox(fl, raw, floorBoxesOf(fl),
                                _beGridPerPx(gridToScreen3D, raw) * BE_GUIDE_SNAP_PX);
      if (sn) { raw.gx = sn.gx; raw.gy = sn.gy; raw.rotDeg = sn.rotDeg; }
      // 【貫通させない】壁や他の箱に当たったらその手前で止める。
      // 順番は「吸い付き → 当たり判定」。逆にすると、止めた後に吸い付きが
      // 壁へ引き寄せて結局めり込む（Codex監査の指示）。
      // 第6引数はドラッグ開始時の姿勢。吸い付きは向きも変えるので、
      // 「開始時点で既にめり込んでいる」の救済判定だけは元の向きで見る必要がある。
      // 【当たり判定の起点も開始位置】本体を毎フレーム更新した後の ic.gx を起点にすると、
      // 判定の移動元が毎回ずれて意図せず通過する（Codex監査の指摘）
      // 【開始時の姿勢は凍結した rot0 で作る】`ic` はドラッグ中に本体を書き換えているので、
      // そのまま渡すと「開始時の姿勢」ではなく「直前フレームの姿勢」になる（コメントの意図と食い違う）
      const bk = bcBlockFloorBoxMove(fl, raw, gx0, gy0, floorBoxesOf(fl), { ...ic, rotDeg: rot0 });
      raw.gx = bk.gx; raw.gy = bk.gy;
      patch = { gx: raw.gx, gy: raw.gy, rotDeg: raw.rotDeg };
    } else {
      raw = { ...ic, sM: ic.sM + (dsM || 0), tM: ic.tM + (dtM || 0) };
    }
    // 診断: 壁・扉の機器がどこで止まるかを実機で追う（__dragLog）
    const _dlg = (typeof window !== 'undefined' && window.__dragLogOn)
      ? (tag, extra) => {
          (window.__dragLog = window.__dragLog || []).push({ 所: tag, iconId,
            種別: bcIsCeilIcon(ic) ? '天井' : bcIsFloorIcon(ic) ? '床置き'
                  : (ic.doorId ? '扉' : ic.outerKey ? '外壁' : '壁'),
            受け取った差分: { dsM, dtM }, commit, ...extra });
          if (window.__dragLog.length > 200) window.__dragLog.shift();
        }
      : () => {};
    _dlg('編集:入口', { 元: bcIsFloorIcon(ic) ? { gx: ic.gx, gy: ic.gy } : { sM: ic.sM, tM: ic.tM },
                        clamp前: bcIsFloorIcon(ic) ? { gx: raw.gx, gy: raw.gy } : { sM: raw.sM, tM: raw.tM } });
    // ドラッグ中も確定時と**同じ関数**で収める。プレビューだけ生の値にすると、
    // カーソルにどこまでも付いていって離した瞬間に端へ戻る（2026-08-28 ユーザー指摘）
    // 【盤は収めない】盤の寸法・据付高さは建物側の都合で縮めてよいものではないので
    // clamp を通さず、天井を突き抜ける場合は一覧で警告するだけにする（Codex監査の指示）
    if (ic.source !== 'placedPanel') Object.assign(raw, bcClampIcon(fl, raw));
    if (!bcIsFloorIcon(ic)) patch = { sM: raw.sM, tM: raw.tM };
    // 【壁付きはプレビューのまま】壁面の機器は placedPanels ではないので他ウィンドウに出ない。
    // 床置きだけドラッグ中も本体へ書き、平面図・3次元図・Cesium を同時に追従させる
    if (!bcIsFloorIcon(ic)) {
      _dlg('編集:プレビュー', { patch });
      if (!commit) { setIconPreview({ iconId, patch }); return; }
      setIconPreview(null);
    } else {
      setIconPreview(null);
      if (commit) moveStartRef.current = null;
    }
    const moved = Object.keys(patch).some(k => Math.abs(patch[k] - ic[k]) > 1e-9);
    _dlg('編集:確定手前', { patch, moved });
    // 【動かないときは理由を出す・2026-09-06】扉は幅0.9m程度しかないので、
    // 幅0.8mの機器は左右に0.1mしか動けない。clamp が正しく効いた結果だが、
    // 操作している人には「壊れている」に見える。可動域の計算は buildingCore が唯一の定義
    if (commit && !bcIsFloorIcon(ic) && typeof bcIconRangeMsg === 'function') {
      const rm = bcIconRangeMsg(fl, raw);
      if (rm) { setMsg(rm); if (!moved) return; }
    }
    if (!moved) return; // クリックしただけ
    if (ic.source === 'placedPanel') {
      setMsg(onMovePlacedPanel ? onMovePlacedPanel(ic.panelId, patch) : '未接続');
      return;
    }
    setMsg(onApplyIconEdit ? onApplyIconEdit(selBuilding.id, fid, iconId, patch) : '未接続');
  }, [selBuilding, onApplyIconEdit, onMovePlacedPanel, gridToScreen3D, floorBoxesOf, bldPanelBoxes]);
  // 【回転】床置きの箱（機器・配置済み配電盤）を3Dで回す。移動（onDragIcon3D）とは別操作。
  // 【なぜ別操作が要るか】移動の吸い付きは向きも相手（壁・隣の箱）に合わせる仕様なので、
  // 移動の中に回転を混ぜると自分で決めた向きを保てない。掴む場所を分ける（2026-08-29 ユーザー判断）。
  // 【符号の決め方】画面上のカーソル角と、真上から見た向きの増える向きは、カメラが傾くと
  // 逆になることがある。向きを+1°したときに画面角がどちらへ動くかを実測して符号だけ合わせる。
  // 量は1:1（3次元図の盤の↻と同じ割り切り。正射影でも斜め視では厳密には一致しない）。
  // 【名称ラベルの移動】3次元図・平面図と同じくラベルを掴んで動かせるようにする。
  // ずらし量は幾何ではなく表示状態なので、盤は pp.labelOffset2D['bld3d']（既存のビュー別の入れ物）へ、
  // 機器は icon.labelDx/labelDy へ入れる。どちらも既存の書き込み口を通す（新しい経路を作らない）。
  const onDragLabel3D = useCallback((fid, pid, iconId, dx, dy, commit) => {
    const fl = selBuilding && (selBuilding.floors || []).find(f => f.id === fid);
    const ic = (fl && (fl.icons || []).find(x => x.id === iconId))
            || bldPanelBoxes.find(b => b.id === iconId);
    if (!fl || !ic) return;
    if (ic.source === 'placedPanel') {
      // 箱の形だけを見る約束なので、位置・向きはそのまま渡してラベルだけ足す
      setMsg(onMovePlacedPanel
        ? onMovePlacedPanel(ic.panelId, { gx: ic.gx, gy: ic.gy, rotDeg: ic.rotDeg, labelDx: dx, labelDy: dy })
        : '未接続');
      return;
    }
    setMsg(onApplyIconEdit ? onApplyIconEdit(selBuilding.id, fid, iconId, { labelDx: dx, labelDy: dy }) : '未接続');
  }, [selBuilding, onApplyIconEdit, onMovePlacedPanel, bldPanelBoxes]);

  // 【📷】選んでいる機器・盤へ他のビューを寄せる。
  // 寄せ方は既存の唯一の実装（盤＝focusPlacedPanel／機器＝focusGridPos）に委ねる。
  // ここで自前にパンやズームを書くと、建屋のカメラマークと挙動が食い違う。
  const onFocusIcon3D = useCallback((fid, pid, iconId) => {
    const fl = selBuilding && (selBuilding.floors || []).find(f => f.id === fid);
    const ic = (fl && (fl.icons || []).find(x => x.id === iconId))
            || bldPanelBoxes.find(b => b.id === iconId);
    if (!fl || !ic) return;
    if (ic.source === 'placedPanel') { onFocusPlacedPanel && onFocusPlacedPanel(ic.panelId); return; }
    // 【寄せ先は箱の外接枠1本・2026-09-11】床置きも壁・扉付けも bcIconAnchorGeom の
    // poly（底面）×zB〜zT の箱なので、同じ式で外接枠を作って同じ入口へ渡す（平面図の📷 _focusBldSolid と同じ）。
    // 以前は壁・扉付けだけ厚み0の板の4隅から作り、潰れないよう最小寸法を足していた
    const g = (typeof bcIconAnchorGeom === 'function')
      ? bcIconAnchorGeom(selBuilding, fl, ic) : null;
    if (!g || !g.poly || !g.poly.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of g.poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
                              if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    onFocusFloorIcon && onFocusFloorIcon(
      (x0 + x1) / 2, (y0 + y1) / 2, (g.zB + g.zT) / 2,
      (x1 - x0) * mpp, (y1 - y0) * mpp, g.zT - g.zB);
  }, [selBuilding, bldPanelBoxes, onFocusPlacedPanel, onFocusFloorIcon]);

  const rotStartRef = useRef(null);   // 回転ドラッグ開始時の向き（二重加算の防止）
  const onRotateIcon3D = useCallback((fid, pid, iconId, dDeg, commit) => {
    const fl = selBuilding && (selBuilding.floors || []).find(f => f.id === fid);
    const ic = (fl && (fl.icons || []).find(x => x.id === iconId))
            || bldPanelBoxes.find(b => b.id === iconId);
    if (!fl || !ic || !bcIsFloorIcon(ic)) return;   // 壁付きは面に貼ってあるので回さない
    const sAng = (deg) => {
      const g = bcFloorIconGeom(fl, { ...ic, rotDeg: deg });
      if (!g || !g.axisS) return null;
      const c = gridToScreen3D(ic.gx, ic.gy), s = gridToScreen3D(g.axisS.x, g.axisS.y);
      return (c && s) ? Math.atan2(s.y - c.y, s.x - c.x) : null;
    };
    const a0 = sAng(ic.rotDeg || 0), a1 = sAng((ic.rotDeg || 0) + 1);
    let k = 1;
    if (a0 != null && a1 != null) {
      let dd = a1 - a0;
      while (dd >  Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      if (dd < 0) k = -1;
    }
    // 【開始時の向きを覚える】ドラッグ中も本体へ書き込むので、ic.rotDeg は毎回動く。
    // 差分 dDeg は掴んだ瞬間から測った量なので、毎回 ic.rotDeg に足すと二重に回る。
    if (!rotStartRef.current || rotStartRef.current.iconId !== iconId) {
      rotStartRef.current = { iconId, rot0: ic.rotDeg || 0 };
    }
    // 【②・PN軸への角度吸い付き＋2軸ガイド・2026-09-02・Codex監査済み】
    // rotDeg は真北基準のグリッド角（bcFloorIconGeom）。壁作図と同じ _bePnAxes（グリッド空間の
    // PN-x/PN-y方向ベクトル）へ、+90°刻みの最近傍が±SNAP以内なら吸い付かせる。
    // screen角(sAng)は符号 k の決定にだけ使い、吸い付き判定はグリッド角どうしで行う。
    const _pnAxes = _bePnAxes(pnRot);
    const _pnAngleDeg = Math.atan2(_pnAxes[0].y, _pnAxes[0].x) * 180 / Math.PI;
    let rotDeg = rotStartRef.current.rot0 + k * dDeg;
    const ROT_SNAP_DEG = snapTol(6);        // 壁ガイドの10pxと同じ役割（回転は角度基準）。解除中は-1で不成立
    let _snapIdx = -1, _bestAbs = Infinity, _bestTarget = null, _bestM = 0;
    for (let m = 0; m < 4; m++) {
      const target = _pnAngleDeg + m * 90;
      const dd = Math.abs(((rotDeg - target) % 360 + 540) % 360 - 180); // 360°折り返し込み
      if (dd < _bestAbs) { _bestAbs = dd; _bestTarget = target; _bestM = m; }
    }
    if (_bestAbs <= ROT_SNAP_DEG) { rotDeg = _bestTarget; _snapIdx = _bestM % 2; }
    // 掴んだ瞬間から離すまでPN2軸ガイドを機器中心に出す（壁作図の永続state方式に倣う・drawGuides再利用）
    if (!commit) {
      setGizGuide({ from: { x: ic.gx, y: ic.gy }, dirs: _pnAxes, snappedIdx: _snapIdx, z: (fl.levelZ || 0) });
    }
    // 【掴んだ瞬間(dDeg===0)は表示専用・2026-09-03・監査済み】ガイドだけ出し、本体書き込み・吸い付き
    // ジャンプはしない（掴んだだけで機器が回る/undo履歴が汚れるのを防ぐ）。実回転(dDeg≠0)以降のみ書く。
    if (!commit && dDeg === 0) return;
    // 【ドラッグ中も本体へ書く】プレビューは3Dの中だけの仕組みなので、
    // 確定まで待つと平面図・3次元図・Cesium が mouseup まで動かない（2026-08-29 ユーザー指摘）。
    // 盤は placedPanels を持つ App が全ビューへ配るので、ここで書けば全部が同時に追従する。
    const patch = { gx: ic.gx, gy: ic.gy, rotDeg };
    setIconPreview(null);
    if (commit) { rotStartRef.current = null; setGizGuide(null); }
    if (ic.source === 'placedPanel') {
      setMsg(onMovePlacedPanel ? onMovePlacedPanel(ic.panelId, patch) : '未接続');
      return;
    }
    setMsg(onApplyIconEdit ? onApplyIconEdit(selBuilding.id, fid, iconId, patch) : '未接続');
  }, [selBuilding, onApplyIconEdit, onMovePlacedPanel, gridToScreen3D, bldPanelBoxes, pnRot]);

  const onDragDoor3D = useCallback((fid, pid, doorId, g0, g, commit) => {
    const fl = selBuilding && (selBuilding.floors || []).find(f => f.id === fid);
    const pt = fl && (fl.partitions || []).find(p => p.id === pid);
    const dr = fl && (fl.doors || []).find(x => x.id === doorId);
    if (!pt || !dr) return;
    // 掴んだ点からの差分だけ動かす（カーソル位置を中心にすると掴んだ瞬間に飛ぶ）
    const uM = dr.uM + (bcDoorUAtPoint(pt, g) - bcDoorUAtPoint(pt, g0));
    if (!commit) { setDoorPreview({ doorId, uM }); return; }
    setDoorPreview(null);
    if (Math.abs(uM - dr.uM) < 1e-9) return; // クリックしただけ＝選択のみ
    setMsg(onApplyDoorEdit ? onApplyDoorEdit(selBuilding.id, fid, doorId, { uM }) : '未接続');
  }, [selBuilding, onApplyDoorEdit]);
  const onDragWall3D = useCallback((fid, pid, dgx, dgy, commit) => {
    const d = drag3DRef.current;
    if (!d || d.partId !== pid) return;
    const a = { x: d.origA.x + dgx, y: d.origA.y + dgy };
    const b = { x: d.origB.x + dgx, y: d.origB.y + dgy };
    if (!commit) { setDragPreview({ partId: pid, a, b, mode: 'move' }); return; }
    drag3DRef.current = null;
    setDragPreview(null);
    const moved = Math.hypot(dgx, dgy) > 1e-9;
    if (!moved) return; // クリックしただけ＝選択のみ
    setMsg(onApplyPartEdit ? onApplyPartEdit(selBuilding.id, bcEditPartId(fid, pid), { a, b }) : '未接続');
  }, [selBuilding, onApplyPartEdit]);

  // 【統一編集モデル】床と壁を同格に並べた編集単位。選択中の階のぶんだけ取り出す
  const editParts = (selBuilding && selFloor)
    ? bcEditableParts(selBuilding).filter(ep => ep.ref.floorId === selFloor.id) : [];

  // ══════════════════════════════════════════════════════════════════
  // 左パネル（A: 一覧＋選択中 / B: 種類別タブ）・2026-09-17 ユーザー指示
  // ══════════════════════════════════════════════════════════════════
  // 【ユーザー報告】「左側のUIがわかりにくい。入れる場所多すぎ・選ぶ物多すぎ・色使い過ぎ」
  // 【旧】全要素の入力欄を同時に並べ、行ごとに「床機器＋/扉＋/機器＋/⇄種別/削除」を置き、
  //   ボタンを役割ごとに10色以上で塗り分け、カードが3段入れ子になっていた。
  // 【新】中身（一覧のまとめ beItems・選択中の入力欄 beProps・追加ボタン列・建物/階の選択欄）は1つだけ持ち、
  //   A と B は**並べ方だけ**違う（同じ部品を窓×種類ごとに書かない）。色は灰の濃淡＋水色1色（警告・削除の意味色は残す）。
  //   選ぶ処理は selectLocal / onSelectIcon3D、保存は onApplyPartEdit / onApplyIconEdit / onApplyDoorEdit と
  //   既存の削除処理をそのまま呼ぶ（新しい経路を作らない・Codex監査）。
  //   表示形式（A/B）だけ localStorage に保存する（選択や編集状態は保存しない）
  const BE = {
    text: '#E2E8F0', sub: '#94A3B8', muted: '#64748B', line: 'rgba(255,255,255,0.10)',
    field: 'rgba(15,23,42,0.55)', btn: 'rgba(255,255,255,0.07)',
    accent: '#38BDF8', accentBg: 'rgba(56,189,248,0.16)',
    danger: '#F87171', warn: BC_UI.warnText,
  };
  const BE_GLYPH = { floor: '▬', wall: '▮', clear: '▯', door: '▭', floorIcon: '■', faceIcon: '■', panel: '▤' };
  const BE_TABS = [
    { id: 'floor', label: '床',   kinds: ['floor'] },
    { id: 'wall',  label: '壁',   kinds: ['wall'] },
    { id: 'door',  label: '扉',   kinds: ['door'] },
    { id: 'icon',  label: '機器', kinds: ['floorIcon', 'panel', 'faceIcon'] },
  ];
  const [beLayout, setBeLayout] = useState(() => {
    try { return window.localStorage.getItem('bldEditorPanelLayout') === 'tabs' ? 'tabs' : 'list'; } catch (e) { return 'list'; }
  });
  const setBeLayoutKeep = (v) => { setBeLayout(v); try { window.localStorage.setItem('bldEditorPanelLayout', v); } catch (e) { /* 保存できなくても動く */ } };
  const [beTab, setBeTab] = useState('wall');
  const [beFloorMenu, setBeFloorMenu] = useState(false);

  // ── 一覧のまとめ（表示用だけ。元のデータ構造は変えない）──
  const beItems = [];
  if (selBuilding && selFloor) {
    for (const ep of editParts) {
      if (ep.axis === 'z') {
        beItems.push({ key: ep.id, kind: 'floor', depth: 0, ep, label: '床',
          sub: `${ep.levelZ}m・階高${ep.heightM}m`, warn: [],
          onSelect: () => selectLocal({ partId: ep.id }) });
        for (const ic of (selFloor.icons || []).filter(bcIsFloorIcon)) {
          beItems.push({ key: ic.id, kind: 'floorIcon', depth: 1, ep, ic, label: ic.name || '機器',
            sub: `${ic.wM}×${ic.dM}×${ic.hM}m`,
            warn: [floorIconWarn.includes(ic.id) && '床の外', floorIconTallWarn.includes(ic.id) && '階高超過'].filter(Boolean),
            onSelect: () => selectLocal({ iconId: ic.id, partId: ep.id }),
            onHover: (on) => setHoverIconId(on ? ic.id : null) });
        }
        for (const b of bldPanelBoxes.filter(bx => bx.floorId === selFloor.id)) {
          beItems.push({ key: b.id, kind: 'panel', depth: 1, ep, b, label: b.name || '盤',
            sub: b.mounted ? '盤・壁付け' : '盤',
            warn: [floorIconWarn.includes(b.id) && '床の外', floorIconTallWarn.includes(b.id) && '階高超過'].filter(Boolean),
            onSelect: () => onSelectIcon3D(b.id, null),
            onHover: (on) => setHoverIconId(on ? b.id : null) });
        }
      } else {
        const pid = ep.ref.partId;
        beItems.push({ key: ep.id, kind: 'wall', depth: 0, ep, label: ep.kind === 'wall' ? '壁' : '透明仕切り',
          sub: `${ep.lenM.toFixed(1)}m・${ep.angleDeg.toFixed(0)}°`,
          warn: outsideWarn.includes(pid) ? ['床の外'] : [],
          onSelect: () => selectLocal({ partId: pid }) });
        for (const d of (selFloor.doors || []).filter(dd => dd.partitionId === pid)) {
          beItems.push({ key: d.id, kind: 'door', depth: 1, ep, d, label: d.name || '扉',
            sub: `${Math.round(d.uM * 10) / 10}m`, warn: [],
            onSelect: () => selectLocal({ doorId: d.id, partId: pid }),
            onHover: (on) => setHoverDoorId(on ? d.id : null) });
          for (const ic of (selFloor.icons || []).filter(x => bcIsDoorIcon(x) && x.doorId === d.id)) {
            beItems.push({ key: ic.id, kind: 'faceIcon', face: 'door', depth: 2, ep, d, ic, label: ic.name || '機器',
              sub: ic.side > 0 ? '表' : '裏', warn: [],
              onSelect: () => selectLocal({ iconId: ic.id, partId: pid }),
              onHover: (on) => setHoverIconId(on ? ic.id : null) });
          }
        }
        for (const ic of (selFloor.icons || []).filter(x => bcIsWallIcon(x) && x.partitionId === pid)) {
          beItems.push({ key: ic.id, kind: 'faceIcon', face: 'wall', depth: 1, ep, ic, label: ic.name || '機器',
            sub: ic.side > 0 ? '表' : '裏', warn: [],
            onSelect: () => selectLocal({ iconId: ic.id, partId: pid }),
            onHover: (on) => setHoverIconId(on ? ic.id : null) });
        }
      }
    }
    // ══ 外壁（建屋のガワ）に貼った機器 ・2026-10-01 ══
    // 【なぜ editParts に入れないか】外壁は「形を編集する部品」ではない（形は棟の輪郭が決める）。
    //   取付先としてだけ使うので、一覧では独立した束として末尾に並べる（Codex指摘）
    // 天井の機器（床と同じく水平な面に貼る。形を編集する部品ではないので一覧の末尾）
    const _ceilIcons = (selFloor.icons || []).filter(
      x => typeof bcIsCeilIcon === 'function' && bcIsCeilIcon(x));
    for (const ic of _ceilIcons) {
      beItems.push({ key: ic.id, kind: 'floorIcon', face: 'ceil', depth: 0, ic, label: ic.name || '機器',
        sub: '天井・下がり' + (Math.round((ic.tM || 0) * 100) / 100) + 'm', warn: [],
        onSelect: () => selectLocal({ iconId: ic.id }),
        onHover: (on) => setHoverIconId(on ? ic.id : null) });
    }
    const _outerIcons = (selFloor.icons || []).filter(
      x => typeof bcIsOuterIcon === 'function' && bcIsOuterIcon(x));
    for (const ic of _outerIcons) {
      const _arc = /arc/.test(ic.outerKey || '');
      beItems.push({ key: ic.id, kind: 'faceIcon', face: 'outer', depth: 0, ic, label: ic.name || '機器',
        sub: '外壁' + (_arc ? '(曲面)' : '') + '・' + (ic.side > 0 ? '内' : '外')
             + '・' + (Math.round(ic.sM * 10) / 10) + 'm', warn: [],
        onSelect: () => selectLocal({ iconId: ic.id }),
        onHover: (on) => setHoverIconId(on ? ic.id : null) });
    }
  }
  // 選択中は1件だけ。優先順位は 機器(盤を含む) > 扉 > 壁・床（Codex条件）
  const beSelItem = selIconId ? (beItems.find(it => (it.ic && it.ic.id === selIconId) || (it.b && it.b.id === selIconId)) || null)
    : selDoorId ? (beItems.find(it => it.kind === 'door' && it.d.id === selDoorId) || null)
    : selPartId ? (beItems.find(it => (it.kind === 'floor' && it.ep.id === selPartId)
                                   || (it.kind === 'wall' && it.ep.ref.partId === hotPartId)) || null)
    : null;
  // B: 3D図や一覧で選んだら、その種類のタブへ移る
  const _beSelKey = beSelItem ? beSelItem.key : null;
  const _beSelKind = beSelItem ? beSelItem.kind : null;
  useEffect(() => {
    if (!_beSelKind) return;
    const t = BE_TABS.find(tb => tb.kinds.includes(_beSelKind));
    if (t) setBeTab(t.id);
  }, [_beSelKey]);
  const beKindName = (it) => (it.kind === 'floor' ? '床' : it.kind === 'wall' ? (it.ep.kind === 'wall' ? '壁' : '透明仕切り')
    : it.kind === 'door' ? '扉' : it.kind === 'panel' ? '盤' : '機器');

  // ── 部品（見た目はここだけ）──
  const beBtn = (label, onClick, o = {}) => (
    <button key={o.key || label} title={o.title}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      style={{ height: 24, padding: '0 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
               flex: o.flex ? 1 : undefined,
               border: '1px solid ' + (o.danger ? 'transparent' : (o.on ? BE.accent : BE.line)),
               background: o.danger ? 'transparent' : (o.on ? BE.accentBg : BE.btn),
               color: o.danger ? BE.danger : (o.on ? BE.accent : BE.text) }}>{label}</button>
  );
  const beInputStyle = { width: '100%', minWidth: 0, height: 24, boxSizing: 'border-box', background: BE.field,
    color: BE.text, border: '1px solid ' + BE.line, borderRadius: 4, padding: '0 6px', fontSize: 12 };
  const beNum = (val, step, onNum, o = {}) => (
    <input type="number" step={step} value={val} placeholder={o.ph} title={o.title}
      onClick={e => e.stopPropagation()} onChange={e => onNum(e.target.value)} style={beInputStyle} />
  );
  const beText = (val, onText) => (
    <input type="text" value={val || ''} onClick={e => e.stopPropagation()} onChange={e => onText(e.target.value)} style={beInputStyle} />
  );
  const beGrid = (rows) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: '6px 8px', alignItems: 'center' }}>
      {/* React.Fragment は使わない（このファイルは React を名前で参照していない）。3列をキー付きで平らに並べる */}
      {rows.flatMap(r => [
        <span key={r.label + ':l'} style={{ color: BE.sub }}>{r.label}</span>,
        <span key={r.label + ':v'} style={{ minWidth: 0 }}>{r.node}</span>,
        <span key={r.label + ':u'} style={{ color: BE.muted, minWidth: 10 }}>{r.unit === undefined ? 'm' : r.unit}</span>,
      ])}
    </div>
  );
  // 【作り方の名前は1か所・2026-11-20】寸法欄の見出しと、辺・頂点を出さない札が同じ名前を出す。
  //   旧: 両方に「回す／それ以外」の2択を手書きし、引き抜き・らせんの棟にも「沿わせた断面」と出ていた
  const _断面の名 = (blk) => ((blk._revolve ? _語.できた物.revolve : blk._twist ? _語.できた物.twist
    : blk._helix ? _語.できた物.helix : _語.できた物.path) || '沿わせ') + 'の断面';
  const _bePos = (v, f) => { const n = parseFloat(v); if (!isNaN(n) && n > 0) f(n); };
  const _beAny = (v, f) => { const n = parseFloat(v); if (!isNaN(n)) f(n); };

  // ══ 抜く(void)：吹き抜け・窓・ダクト貫通 ・2026-10-04 ══
  // 【なぜ床と壁で1つの部品か】置き場所の読み方（床=x,y／壁=端からの距離・床からの高さ）が
  //   違うだけで、記録も形（Profile）も同じ。場所ごとに書くと必ず片方だけ直す日が来る。
  // 【『外す』を同時に出す】付ける入口だけ作ると、やり直し・付け替えができなくなる。
  // 【穴が0個でも入口を見せる】対象が無いと入口ごと消えるのは「機能が無い」に見える。
  const _be芯 = (ep) => { const q = (ep && ep.footprint) || [];
    if (!q.length) return { x: 0, y: 0 };
    return { x: q.reduce((a, p) => a + p.x, 0) / q.length,
             y: q.reduce((a, p) => a + p.y, 0) / q.length }; };
  const be穴行 = (ep, 壁か, P) => {
    const ops = Array.isArray(ep.openings) ? ep.openings : [];
    const 直す = (i, patch) => P({ openings: ops.map((o, k) => (k === i ? { ...o, ...patch } : o)) });
    const 外す = (i) => P({ openings: ops.filter((_, k) => k !== i) });
    const 欄 = (v, step, f, title) => beNum(v, step, nv => _beAny(nv, f), { title });
    return ops.map((o, i) => ({
      label: '穴' + (i + 1), unit: '',
      node: (
        <div data-be-void={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <select value={o.kind || 'rect'} title="穴の形（断面の表をそのまま使う）"
            onClick={e => e.stopPropagation()}
            onChange={e => 直す(i, { kind: e.target.value })}
            style={{ ...beInputStyle, width: 58, flex: '0 0 58px' }}>
            <option value="rect">□ 角</option>
            <option value="circle">○ 丸</option>
          </select>
          {欄(o.wM, '0.1', n => { if (n > 0) 直す(i, { wM: n }); },
              o.kind === 'circle' ? '直径(m)' : '幅(m)')}
          {o.kind === 'circle' ? null
            : 欄(o.hM, '0.1', n => { if (n > 0) 直す(i, { hM: n }); }, '高さ(m)')}
          {壁か ? 欄(o.uM != null ? o.uM : 0, '0.1', n => 直す(i, { uM: n }), '壁の端からの位置(m)')
                : 欄(Math.round(o.x || 0), '1', n => 直す(i, { x: n }), '東西の位置（グリッド）')}
          {壁か ? 欄(o.zM != null ? o.zM : 0, '0.1', n => 直す(i, { zM: n }), '床からの高さ(m)')
                : 欄(Math.round(o.y || 0), '1', n => 直す(i, { y: n }), '南北の位置（グリッド）')}
          {beBtn('外す', () => 外す(i), { danger: true, title: 'この穴を埋める' })}
        </div>
      ),
    }));
  };
  // 【既定の置き場所は『空いている所』・2026-10-04】いつも真ん中に置くと、
  //   そこに扉や別の穴があったとき新しい穴が丸ごと飲み込まれ、**押しても何も起きない**。
  //   実機で踏んだ（壁の中央に扉がある図で、窓を足しても面の数が変わらなかった）。
  //   候補をいくつか当たって、どれも塞がっていれば真ん中に置く（置けないとは言わない）。
  // 置き場所を探すのは buildingCore 側（bcFreeSpanOnPartition / bcFreeSpotOnFloor）。
  //   ここに書いていたら実機で動かなかったときに切り分けられなかった（検査から呼べない）
  const be穴追加 = (ep, 壁か, P) => beBtn('＋穴を開ける', () => {
    const ops = Array.isArray(ep.openings) ? ep.openings : [];
    const 新 = 壁か
      ? (() => { const 場 = bcFreeSpanOnPartition(selFloor, ep.ref && ep.ref.partId, 0.9);
          return bcNewOpening('rect', { uM: 場.uM, zM: 1.2 }, { wM: 場.wM, hM: 1.2 }); })()
      : (() => { const p = bcFreeSpotOnFloor(selBuilding, selFloor, 2, 2);
          return bcNewOpening('rect', { x: Math.round(p.x), y: Math.round(p.y) }, { wM: 2, hM: 2 }); })();
    P({ openings: [...ops, 新] });
  }, { key: 'addvoid',
       title: 壁か ? '窓・ダクト貫通（○ 丸にすればダクト）' : '吹き抜け（床に穴）' });

  // ── 選択中の入力欄と操作（種類ごとの中身はここ1か所）──
  const beProps = (it) => {
    if (!it || !selBuilding || !selFloor) return null;
    const bid = selBuilding.id, fid = selFloor.id;
    const P = (patch) => setMsg(onApplyPartEdit ? onApplyPartEdit(bid, it.ep.id, patch) : '未接続');
    const I = (patch) => setMsg(onApplyIconEdit ? onApplyIconEdit(bid, fid, it.ic.id, patch) : '未接続');
    const D = (patch) => setMsg(onApplyDoorEdit ? onApplyDoorEdit(bid, fid, it.d.id, patch) : '未接続');
    let rows = [], acts = [], del = null, name = null;
    if (it.kind === 'floor') {
      const ep = it.ep;
      rows = [
        { label: '高さ', node: beNum(ep.levelZ, '0.1', v => _beAny(v, n => P({ levelZ: n })), { title: '床の標高(m)' }) },
        { label: '階高', node: beNum(ep.heightM, '0.1', v => _bePos(v, n => P({ heightM: n })), { title: 'この階の高さ(m)' }) },
        { label: '板厚', node: beNum(ep.thicknessM, '0.05', v => _bePos(v, n => P({ thicknessM: n })), { title: 'スラブ厚(m)' }) },
        ...be穴行(ep, false, P),   // 吹き抜け
      ];
      acts.push(be穴追加(ep, false, P));
      acts.push(beBtn(floorEdit ? '床の形を描いています' : '床の形を描く', () => {
        if (floorEdit) { setFloorEdit(null); return; }
        setFloorEdit({ pts: [] }); setTool(null); setDrawPts([]); setDoorPlace(null); setIconPlace(null);
      }, { on: !!floorEdit }));
      if (ep.isCustomOutline) acts.push(beBtn('建物断面に戻す', () => { P({ footprint: null }); setOutsideWarn([]); }));
    } else if (it.kind === 'wall') {
      const ep = it.ep;
      rows = [
        { label: '高さ', node: (
          <input type="number" step="0.1" placeholder={String(selFloor.heightM)} title="空欄なら階高いっぱい"
            value={ep.heightM != null ? ep.heightM : ''} onClick={e => e.stopPropagation()}
            onChange={e => { const v0 = e.target.value; if (v0 === '') { P({ heightM: null }); return; } _bePos(v0, n => P({ heightM: n })); }}
            style={beInputStyle} />) },
        { label: '厚み', node: beNum(ep.thicknessM, '0.05', v => _bePos(v, n => P({ thicknessM: n })), { title: '壁厚(m)' }) },
        ...be穴行(ep, true, P),    // 窓・ダクト貫通
      ];
      acts.push(be穴追加(ep, true, P));
      acts.push(beBtn(ep.kind === 'wall' ? '透明仕切りに変える' : '壁に変える', () => P({ kind: ep.kind === 'wall' ? 'clear' : 'wall' })));
      del = () => { onDeletePartition && onDeletePartition(bid, fid, ep.ref.partId); setSelPartId(null); };
    } else if (it.kind === 'floorIcon') {
      const ic = it.ic;
      name = beText(ic.name, v => I({ name: v }));
      rows = [
        { label: '幅',   node: beNum(ic.wM, '0.1', v => _bePos(v, n => I({ wM: n })), { title: '平面の幅(m)' }) },
        { label: '奥行', node: beNum(ic.dM, '0.1', v => _bePos(v, n => I({ dM: n })), { title: '平面の奥行き(m)' }) },
        { label: '高さ', node: beNum(ic.hM, '0.1', v => _bePos(v, n => I({ hM: n })), { title: '機器の高さ(m)' }) },
        { label: '向き', node: beNum(ic.rotDeg, '5', v => _beAny(v, n => I({ rotDeg: n })), { title: '向き(度・真北基準)。PNを変えても機器は動きません' }), unit: '°' },
      ];
      del = () => { onDeleteIcon && onDeleteIcon(bid, fid, ic.id); setSelIconId(null); };
    } else if (it.kind === 'panel') {
      const b = it.b;
      rows = [
        { label: '寸法', node: <span style={{ color: BE.sub }}>{b.wM.toFixed(2)}×{b.dM.toFixed(2)}×{b.hM.toFixed(2)}</span> },
        { label: '向き', node: beNum(Math.round(b.rotDeg * 10) / 10, '5',
            v => _beAny(v, n => { if (onMovePlacedPanel) setMsg(onMovePlacedPanel(b.panelId, { gx: b.gx, gy: b.gy, rotDeg: n })); }),
            { title: '向き(度・絶対角)。PNを変えても盤は動きません' }), unit: '°' },
      ];
      // 壁に付いている盤は向きが壁で決まるので、向きの入力は出さない（効かない欄を出さない）
      if (b.mounted) rows = [rows[0]];
      // 【壁に付いていても付け替えの入口を出す】消すと、一度付けた盤は外さないと動かせない
      //   ように見える（2026-10-03 ユーザー報告「すでに張り付いていると断られた」）
      // 【名前は語彙表から・2026-10-18】案内文(beMountPanelStart)が同じ名前を引用している
      acts.push(beBtn(b.mounted ? _語.壁付け.付け替える : _語.壁付け.付ける, () => beStartPanelMount(b),
        { on: !!(iconPlace && iconPlace.panelId === b.panelId),
          title: b.mounted ? '別の壁（曲面も可）へ移す。移す位置をクリック'
                           : '壁（曲面も可）に取り付ける。付ける位置をクリック' }));
      if (b.mounted) acts.push(beBtn(_語.壁付け.外す,
        () => { onUnmountPanel && onUnmountPanel(b.panelId); },
        { title: '床置きに戻す（今いる場所で止まります）' }));
      del = () => { onDeletePlacedPanel && onDeletePlacedPanel(b.panelId); setSelIconId(null); };
    } else if (it.kind === 'door') {
      const d = it.d, ep = it.ep;
      rows = [
        { label: '位置', node: beNum(Math.round(d.uM * 100) / 100, '0.1', v => _beAny(v, n => D({ uM: n })), { title: '端点aからの距離(m)' }) },
        { label: '幅',   node: beNum(d.widthM, '0.05', v => _bePos(v, n => D({ widthM: n })), { title: '扉の幅(m)' }) },
        { label: '高さ', node: beNum(d.heightM, '0.1', v => _bePos(v, n => D({ heightM: n })), { title: '扉の高さ(m)' }) },
        // 壁連動中は実効値（＝壁厚）を表示。数値を変えると扉独立で固定（2026-09-03 の規約のまま）
        { label: '厚み', node: beNum(d.thicknessM != null ? d.thicknessM
                                     : (ep.thicknessM != null ? Math.round(ep.thicknessM * 1000) / 1000 : ''), '0.01',
            v => _bePos(v, n => D({ thicknessM: n })),
            { title: d.thicknessM != null ? '扉の厚み(m)・固定中' : '扉の厚み(m)・壁連動中（壁厚を表示）' }) },
      ];
      if (d.thicknessM != null) acts.push(beBtn('厚みを壁に合わせる', () => D({ thicknessM: null }), { title: '壁の厚みに連動へ戻す' }));
      acts.push(beBtn(`取付面：${d.faceSide === -1 ? '裏' : '表'}`, () => D({ faceSide: d.faceSide === -1 ? 1 : -1 }),
        { title: '扉を壁のどちらの面に付けるか（表↔裏）。薄い扉のとき片面にフラッシュする' }));
      del = () => { onDeleteDoor && onDeleteDoor(bid, fid, d.id); setSelDoorId(null); };
    } else if (it.kind === 'faceIcon') {
      const ic = it.ic, onDoor = it.face === 'door', onOuter = it.face === 'outer';
      const _onArc = onOuter && /arc/.test(ic.outerKey || '');
      name = beText(ic.name, v => I({ name: v }));
      rows = [
        { label: '位置', node: beNum(Math.round(ic.sM * 100) / 100, '0.1', v => _beAny(v, n => I({ sM: n })),
            { title: _onArc ? '弧に沿った距離(m)' : onDoor ? '扉の左端からの距離(m)'
                     : onOuter ? '外壁の始点からの距離(m)' : '端点aからの距離(m)' }) },
        { label: '高さ', node: beNum(Math.round(ic.tM * 100) / 100, '0.1', v => _beAny(v, n => I({ tM: n })),
            { title: onDoor ? '扉の下端からの高さ(m)' : '床からの高さ(m)' }) },
        { label: '大きさ', node: beNum(ic.wM, '0.05', v => _bePos(v, n => I({ wM: n, hM: n })), { title: '一辺(m)' }) },
      ];
      acts.push(beBtn(`面：${onOuter ? (ic.side > 0 ? '内側' : '外側') : (ic.side > 0 ? '表' : '裏')}`,
        () => I({ side: -(ic.side || 1) }),
        { title: onOuter ? '外壁の内側↔外側へ移す' : onDoor ? '扉の反対側の面へ移す' : '壁の反対側の面へ移す' }));
      del = () => { onDeleteIcon && onDeleteIcon(bid, fid, ic.id); setSelIconId(null); };
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {it.warn && it.warn.length > 0 && <div style={{ color: BE.warn }}>⚠ {it.warn.join('・')}</div>}
        {name && (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: '6px 8px', alignItems: 'center' }}>
            <span style={{ color: BE.sub }}>名前</span>{name}<span style={{ minWidth: 10 }} />
          </div>
        )}
        {rows.length > 0 && beGrid(rows)}
        {(acts.length > 0 || del) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {acts}
            {del && <span style={{ marginLeft: 'auto' }}>{beBtn('削除', del, { danger: true })}</span>}
          </div>
        )}
      </div>
    );
  };

  // ── 追加ボタン列（入口はここ1か所。扉・機器は選択中の壁・床・扉に付ける）──
  const beAddDoor = () => {
    if (doorPlace) { setDoorPlace(null); setMsg(null); return; }
    const it = beSelItem;
    if (!it || !it.ep || it.ep.axis === 'z' || it.ep.kind !== 'wall') { setMsg('扉を付ける壁を、一覧か3D図で選んでください'); return; }
    setIconPlace(null); setTool(null); setDrawPts([]); setFloorEdit(null); setMsg(null);
    setDoorPlace({ partId: it.ep.ref.partId });
  };
  const beAddIcon = () => {
    if (iconPlace) { setIconPlace(null); setMsg(null); return; }
    const it = beSelItem;
    if (!it || !it.ep) { setMsg('機器を置く床・壁・扉を、一覧か3D図で選んでください（外壁は「＋外壁に機器」）'); return; }
    let target;
    if (it.kind === 'floor' || it.kind === 'floorIcon' || it.kind === 'panel') target = { floor: true };
    else if (it.d) target = { partId: it.ep.ref.partId, doorId: it.d.id };
    else target = { partId: it.ep.ref.partId };
    setDoorPlace(null); setTool(null); setDrawPts([]); setFloorEdit(null); setMsg(null);
    setIconPlace(target);
  };
  // 外壁に機器を置く。壁・扉と違い「どれに付けるか」を先に選ばせない
  //（建屋のガワは一続きなので、クリックした場所に一番近い辺に付けるのが自然）
  const beAddOuterIcon = () => {
    if (iconPlace) { setIconPlace(null); setMsg(null); return; }
    setDoorPlace(null); setTool(null); setDrawPts([]); setFloorEdit(null); setMsg(null);
    setIconPlace({ outer: true });
  };
  // 天井に機器を置く（照明・感知器）。床と同じく「どれに付けるか」は選ばせない
  const beAddCeilIcon = () => {
    if (iconPlace) { setIconPlace(null); setMsg(null); return; }
    setDoorPlace(null); setTool(null); setDrawPts([]); setFloorEdit(null); setMsg(null);
    setIconPlace({ ceil: true });
  };
  // ══ 盤を壁に付ける（入口）・2026-10-02 ══
  // 【なぜツールバーに置くか】盤を一覧で選んだときだけボタンが出る作りにしたら、
  //   盤が0台の建屋では「出る場所そのものが無い」ので見つけられなかった（ユーザー報告「てどこ」）。
  //   入口は常に見える所に置き、使えないときは**理由を出す**。
  // 【名前に「＋」を付けない・Codex指摘】隣の〔＋壁〕〔＋機器〕は新しく作る入口だが、
  //   これは既に置いてある盤の付け替えなので、同じ見た目にすると意味が混ざる。
  // 盤を壁に付ける／別の壁へ付け替える待ち状態に入る。
  // 入口はツールバーと機器の一覧の2つあるが、**中身はここ1つ**（書き分けると片方だけ直る）
  const beStartPanelMount = (b) => {
    if (!b) return;
    setDoorPlace(null); setTool(null); setDrawPts([]); setFloorEdit(null);
    setIconPlace({ panelId: b.panelId, remount: !!b.mounted });
    // 【赤い知らせは出さない】すぐ上の青い案内が「今なにを待っているか」を言うので二重になる。
    //   赤は困りごと（盤が無い・置けない）のときだけに取っておく
    setMsg(null);
  };
  const beMountPanelStart = () => {
    if (iconPlace && iconPlace.panelId) { setIconPlace(null); setMsg(null); return; }
    const 盤ら = bldPanelBoxes.filter(b => b.floorId === (selFloor && selFloor.id));
    if (!盤ら.length) {
      setMsg('この階に盤がありません。配電盤エディタの盤を図面へドラッグして置いてください');
      return;
    }
    // 【壁に付いている盤も対象】別の壁へ付け替えたいときも同じ入口を使う。
    //   床置きだけに絞ると「すべて壁に付いています」と断られ、付け替えができない（2026-10-03 報告）
    if (盤ら.length === 1) {
      // 1台しかないなら選ばせる手間を省き、そのまま壁クリック待ちにする
      const b = 盤ら[0];
      if (onSelectIcon3D) onSelectIcon3D(b.id, null);
      beStartPanelMount(b);
      return;
    }
    // 2台以上はどれを動かすか選んでもらう。一覧表示のままだとタブに切り替わらないので揃える
    setDoorPlace(null); setTool(null); setDrawPts([]); setFloorEdit(null); setMsg(null);
    setBeLayout('tabs'); setBeTab('icon');
    setMsg('機器の一覧で盤を選び、〔' + _語.壁付け.付ける + '〕か〔' + _語.壁付け.付け替える + '〕を押してください'
      + '（この階に盤が ' + 盤ら.length + '台）');
  };
  const beToolbar = selFloor && (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {beBtn('＋壁', () => { setTool(tool === 'wall' ? null : 'wall'); setDrawPts([]); setFloorEdit(null); setDoorPlace(null); setIconPlace(null); },
        { on: tool === 'wall', title: '図面上を2点クリックして壁を引く' })}
      {beBtn('＋透明仕切り', () => { setTool(tool === 'clear' ? null : 'clear'); setDrawPts([]); setFloorEdit(null); setDoorPlace(null); setIconPlace(null); },
        { on: tool === 'clear', title: '図面上を2点クリックして透明な仕切りを引く' })}
      {beBtn('＋扉', beAddDoor, { on: !!doorPlace, title: '選んだ壁に扉を付ける（壁の上をクリック）' })}
      {beBtn('＋機器', beAddIcon, { on: !!iconPlace && !iconPlace.outer, title: '選んだ床・壁・扉に機器を置く（置く位置をクリック）' })}
      {beBtn('＋天井に機器', beAddCeilIcon, { on: !!(iconPlace && iconPlace.ceil),
        title: '天井に機器を置く（照明・感知器）。置く位置をクリック' })}
      {beBtn('＋外壁に機器', beAddOuterIcon, { on: !!(iconPlace && iconPlace.outer),
        title: '建屋のガワ（曲面を含む）に機器を置く。一番近い外壁に付きます' })}
      {beBtn('盤を壁に付ける', beMountPanelStart, { on: !!(iconPlace && iconPlace.panelId),
        title: '図面に置いてある盤を、壁（曲面も可）に取り付ける' })}
    </div>
  );
  const beHints = selFloor && (tool || doorPlace || iconPlace || floorEdit || msg) && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {tool && (
        <div style={{ color: BE.accent }}>
          図面上を2点クリック（{pnDeg ? `PN(${pnDeg}°)基準の` : ''}軸平行スナップ・右クリックで中断）
          {drawPts.length === 1 && ' — 始点OK、終点をクリック'}
        </div>
      )}
      {/* 【案内と知らせを分ける】青＝今どういう操作待ちか（data-be-hint）、
          赤＝困りごと（data-be-msg）。同じことを2色で言わない（2026-10-03） */}
      {doorPlace && <div data-be-hint style={{ color: BE.accent }}>扉を置く位置を図面上でクリック（壁の線へ寄せて配置・右クリックで中断）</div>}
      {iconPlace && (
        <div data-be-hint style={{ color: BE.accent }}>
          {iconPlace.panelId ? (iconPlace.remount
              ? '盤を付け替える先の壁を、その近くでクリック（曲面にも付けられます・右クリックで中断）'
              : '盤を付ける位置を壁の近くでクリック（曲面にも付けられます・右クリックで中断）')
            : iconPlace.ceil ? '機器を置く位置を図面上でクリック（その真上の天井に付きます・右クリックで中断）'
            : iconPlace.outer ? '機器を置く位置を外壁の近くでクリック（曲面にも貼れます・右クリックで中断）'
            : iconPlace.floor ? '機器を置く位置を床の上でクリック（右クリックで中断）'
            : iconPlace.doorId ? '機器を置く位置を扉の上でクリック（右クリックで中断）'
            : '機器を置く位置を図面上でクリック。壁のどちら側を押したかで表裏が決まります（右クリックで中断）'}
        </div>
      )}
      {floorEdit && (
        <div data-be-hint style={{ color: BE.accent }}>
          図面上をクリックして頂点を置く（{floorEdit.pts.length}点）。始点の黄丸をクリック、または右クリックで確定
        </div>
      )}
      {/* 【名札を付ける理由】上の常設案内と文言が似るので、画面の文字で合否を決める検査が
          案内を拾って通ってしまう。知らせはここからだけ読めるようにする（2026-10-03） */}
      {msg && <div data-be-msg style={{ color: BE.danger }}>{msg}</div>}
    </div>
  );

  // ── ガワ（外壁）の編集 ・2026-09-22 ──
  // 建屋モードのプロパティ窓（App.jsx の bldProp）を廃止してここへ集約した。
  // 単位は記録に合わせる: points=グリッド座標（1グリッド=0.1m）／zBottom・zTop・wallThicknessM=メートル。
  // 面移動の delta はグリッドpx（MINOR=7.2）。上下面だけ App 側でメートルへ直して足す。
  const beShellPanel = (() => {
    if (!selBuilding) return null;
    const bks = selBuilding.blocks || [];
    const _mm = (v) => Math.round((v || 0) * 10) / 10;   // 0.1m 刻みで見せる
    // グリッド座標 ⇄ メートル（1グリッド = METERS_PER_PX m）。図の単位に合わせる
    const _mppB = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    const _toM = (g) => Math.round((g || 0) * _mppB * 100) / 100;
    // 頂点を1つだけ動かす（巻き添えにしない）
    const _setVert = (bi, blk, vi, axis, valGrid) => {
      if (!onUpdateBlock) return;
      onUpdateBlock(selBuilding.id, bi, {
        points: blk.points.map((p2, i2) => i2 === vi ? { ...p2, [axis]: valGrid } : p2),
      });
    };
    // 【2026-09-23 ユーザー裁定「Cesiumが使えなくても機能を失わない構成に」】
    // 増築棟＝親の壁の一部を共有して生やす棟。それまで Cesium の「面を伸縮」でしか作れなかった。
    // 形の規則は solidModel.js の makeSharedWallChildBlock ただ1つを呼ぶ（ここで幾何を書かない）。
    // 【2026-09-23】図で選んだ面を、人に見える名前と onMoveBlockFace のキーに直す。
    // 「辺0/辺1」を人に選ばせるのをやめ、図でクリックした面をそのまま操作対象にする
    const _faceLabel = (sh) => !sh ? '' :
      sh.faceType === 'top' ? '屋根（上の面）'
      : sh.faceType === 'bottom' ? '床（下の面）'
      : '壁' + (sh.edgeIdx != null ? '（' + _toM(Math.hypot(
          (blkOf(sh.blockIdx).points[(sh.edgeIdx + 1) % blkOf(sh.blockIdx).points.length].x - blkOf(sh.blockIdx).points[sh.edgeIdx].x),
          (blkOf(sh.blockIdx).points[(sh.edgeIdx + 1) % blkOf(sh.blockIdx).points.length].y - blkOf(sh.blockIdx).points[sh.edgeIdx].y))) + 'm）' : '');
    const blkOf = (i) => (bks[i] || { points: [] });
    const _faceKey = (sh) => !sh ? null :
      sh.faceType === 'top' ? 'zTop' : sh.faceType === 'bottom' ? 'zBottom' : sh.edgeIdx;
    // 【2026-09-24】円柱の半径を変える。**形（shape）を変えたら points を作り直す**。
    // points は既存の全処理（描画・押し引き・部屋認識・機器の吸い付き）が見る近似の多角形なので、
    // ここを通さずに shape だけ変えると図と記録がずれる。
    const _setRadiusM = (bi, blk, rM) => {
      if (!onUpdateBlock || !blk.shape || !(rM > 0)) return;
      const shape = { ...blk.shape, r: rM / _mppB };
      const points = (typeof blockShapePoints === 'function') ? blockShapePoints(shape) : null;
      if (!points) return;
      onUpdateBlock(selBuilding.id, bi, { shape, points });
    };
    // ══ 屋根の傾き（片流れ屋根・擁壁）・2026-10-03 ══
    // 【基準は低い側】高さ(m) の欄で入れた値が**軒（低い側）の高さ**になるよう、
    //   傾きの向きで一番手前の頂点を基準点にする。向きを変えるたびに取り直す。
    // 【1ブロック＝1つの傾いた平面】寄棟・入母屋は棟を分けて作る（頂点ごとの高さにすると
    //   上面が平面でなくなり、描画も押し引きも部屋認識も崩れる）
    const _slopeOf = (blk) => blk.slope || { dirDeg: 90, pitch: 0 };
    const _setSlope = (bi, blk, patch) => {
      if (!onUpdateBlock) return;
      const 穴 = (typeof sharedWallOpeningsForBlock === 'function')
        ? sharedWallOpeningsForBlock(bks, bi) : [];
      const 理由 = (typeof blockSlopeBlockedReason === 'function')
        ? blockSlopeBlockedReason(blk, 穴) : null;
      if (理由) { setMsg(理由); return; }
      const 今 = _slopeOf(blk);
      const 次 = Object.assign({}, 今, patch);
      const pitch = Number(次.pitch) || 0;
      if (!pitch) { onUpdateBlock(selBuilding.id, bi, { slope: null }); setMsg(null); return; }
      const rad = (Number(次.dirDeg) || 0) * Math.PI / 180;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      // 傾きの向きで一番手前（低い側）の頂点を基準にする
      let ox = 0, oy = 0, 最小 = Infinity;
      (blk.points || []).forEach(p2 => { const v = p2.x * dx + p2.y * dy;
        if (v < 最小) { 最小 = v; ox = p2.x; oy = p2.y; } });
      onUpdateBlock(selBuilding.id, bi, {
        slope: { ox, oy, dx, dy, pitch, dirDeg: Number(次.dirDeg) || 0 } });
      setMsg(null);
    };
    const _annexOf = (bi) => beAnnex[bi] || { edge: 0, len: '10', depth: '5', h: '5' };
    const _setAnnex = (bi, k, v) => setBeAnnex(prev => ({ ...prev, [bi]: { ..._annexOf(bi), [k]: v } }));
    const _addAnnex = (bi, blk) => {
      if (!onAddBlock) { setMsg('追加の入口が接続されていません'); return; }
      const a = _annexOf(bi);
      const lenM = parseFloat(a.len), depM = parseFloat(a.depth), hM = parseFloat(a.h);
      if (!(lenM > 0) || !(depM > 0) || !(hM > 0)) { setMsg('長さ・出幅・高さを入れてください'); return; }
      const q = blk.points, n2 = q.length;
      const ei = ((+a.edge | 0) % n2 + n2) % n2;
      const p0 = q[ei], p1 = q[(ei + 1) % n2];
      const elen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const wantU = lenM / _mppB;
      if (wantU > elen + 1e-6) { setMsg('辺' + ei + 'の長さ（' + _toM(elen) + 'm）より長くはできません'); return; }
      const u0 = (elen - wantU) / 2;   // まず辺の中央に作る（あとで頂点・辺の数値で動かせる）
      const made = (typeof makeSharedWallChildBlock === 'function') ? makeSharedWallChildBlock({
        parentPoints: q, parentBlockIdx: bi, parentEdge: ei,
        uMin: u0, uMax: u0 + wantU, depthGrid: depM / _mppB,
        zMin: blk.zBottom || 0, zMax: (blk.zBottom || 0) + hM,
      }) : null;
      if (!made) { setMsg('その辺には作れません'); return; }
      onAddBlock(selBuilding.id, made.points, made.zBottom, made.zTop, made.extraProps);
      setMsg('');
    };
    // 辺の長さをメートルで決める。**始点を固定して終点を動かす**（Codex「片側固定が一番予測できる」）。
    // 法線方向へずらすのは「辺の長さ」ではなく辺オフセット＝下の「面を動かす」が担う
    const _setEdgeLenM = (bi, blk, ei, lenM) => {
      if (!onUpdateBlock || !(lenM > 0)) return;
      const q = blk.points, n2 = q.length;
      const a = q[ei], b2 = q[(ei + 1) % n2];
      const ex = b2.x - a.x, ey = b2.y - a.y;
      const L = Math.hypot(ex, ey);
      if (!(L > 1e-6)) return;
      const want = lenM / _mppB;           // メートル → グリッド
      const ux = ex / L, uy = ey / L;
      onUpdateBlock(selBuilding.id, bi, {
        points: q.map((p2, i2) => i2 === (ei + 1) % n2
          ? { ...p2, x: a.x + ux * want, y: a.y + uy * want } : p2),
      });
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
                    border: '1px solid ' + BE.line, borderRadius: 6, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: BE.sub }}>名前</span>
          {beText(selBuilding.label, v => onUpdateBuilding && onUpdateBuilding(selBuilding.id, { label: v }))}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ color: BE.sub }}>色</span>
          {(bldColors || []).slice(0, 6).map(c => (
            <div key={c} onClick={() => onUpdateBuilding && onUpdateBuilding(selBuilding.id, { color: c })}
              style={{ width: 18, height: 18, background: c, borderRadius: 3, cursor: 'pointer',
                       border: c === selBuilding.color ? '2px solid ' + BE.accent : '1px solid ' + BE.line }} />
          ))}
        </div>
        <div style={{ color: BE.sub, borderTop: '1px solid ' + BE.line, paddingTop: 6 }}>
          ブロック（{bks.length}）
        </div>
        {bks.map((blk, bi) => {
          const xs = blk.points.map(p2 => p2.x), ys = blk.points.map(p2 => p2.y);
          const xMin = Math.min(...xs), xMax = Math.max(...xs);
          const yMin = Math.min(...ys), yMax = Math.max(...ys);
          return (
            <div key={bi} style={{ border: '1px solid ' + BE.line, borderRadius: 4, padding: 6,
                                   display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: BE.muted, fontSize: 11 }}>
                  {/* 【2026-09-24】円柱は48角形の近似。「頂点 48 個」は意味がないので形で言う */}
                  {blk.shape && blk.shape.type === 'circle'
                    ? '円（半径 ' + _toM(blk.shape.r) + 'm）'
                    : '頂点 ' + blk.points.length + ' 個'}
                </span>
                {bks.length > 1 && beBtn('削除', () => onDeleteBlock && onDeleteBlock(selBuilding.id, bi),
                  { danger: true, key: 'db' + bi })}
              </div>
              {beGrid([
                { label: '外形(m)', node: (
                  <span style={{ color: BE.muted, fontSize: 11, whiteSpace: 'nowrap' }}
                    title="外接の大きさ（表示だけ）。形そのものは下の「辺の長さ」と「頂点」で決めます">
                    {_toM(xMax - xMin)} × {_toM(yMax - yMin)}
                  </span>) },
                { label: '高さ(m)', node: (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {beNum(_mm(blk.zBottom || 0), '0.1',
                      v => onUpdateBlock && onUpdateBlock(selBuilding.id, bi, { zBottom: parseFloat(v) || 0 }))}
                    <span style={{ color: BE.muted }}>〜</span>
                    {beNum(_mm(blk.zTop), '0.1',
                      v => onUpdateBlock && onUpdateBlock(selBuilding.id, bi, { zTop: parseFloat(v) || 0 }))}
                  </div>) },
                { label: '穴', node: (
                  <span data-be-void-hint style={{ color: BE.muted, fontSize: 10, lineHeight: 1.4 }}>
                    吹き抜けは左の一覧で<b>床</b>、窓・ダクト貫通は<b>仕切り壁</b>を選ぶと開けられます
                  </span>), unit: '' },
                { label: '壁厚(m)', node: beNum(blk.wallThicknessM != null ? blk.wallThicknessM : '', '0.05',
                    v => { const raw = String(v).trim();
                           onUpdateBlock && onUpdateBlock(selBuilding.id, bi,
                             { wallThicknessM: raw === '' ? null : Math.max(0, parseFloat(raw) || 0) }); },
                    { ph: 'なし', title: '外壁の厚み（m）。空欄なら厚みなし' }) },
              ])}
              {/* 【2026-10-05】掃引・回転体で作った棟は、あとから寸法を打ち直せる。
                  points は『結果』なので直に触らず、作図のときの入力を差し替えて作り直す。
                  断面の**種類**は変えられない（辺の数が変わると面の名前が変わり、
                  貼った機器が迷子になる・Codex）。種類を変えたいときは作り直す */}
              {typeof canResizeBlock === 'function' && canResizeBlock(blk) && (() => {
                const pf = blk._profile || {};
                const R = (p) => onUpdateBlock && onUpdateBlock(selBuilding.id, bi, { _resize: p });
                const 名 = (typeof BC_PROFILES !== 'undefined' && BC_PROFILES[pf.kind])
                  ? BC_PROFILES[pf.kind].名 : pf.kind;
                const 丸 = (pf.kind === 'circle' || pf.kind === 'capsule');
                return (
                  <div data-be-resize={pf.kind}
                    style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: BE.sub, fontSize: 11 }}>
                      {_断面の名(blk)}
                    </span>
                    <span style={{ color: BE.muted, fontSize: 10 }} title="種類は変えられません（作り直してください）">
                      {名}
                    </span>
                    <span style={{ color: BE.muted, fontSize: 10 }}>{丸 ? '直径' : '幅'}</span>
                    <span style={{ width: 58 }} data-be-resize-w>
                      {beNum(pf.wM != null ? pf.wM : '', '0.05',
                        v => _bePos(v, n => R({ profile: { wM: n } })), { title: '断面の幅(m)' })}
                    </span>
                    {pf.kind !== 'circle' && <>
                      <span style={{ color: BE.muted, fontSize: 10 }}>
                        {pf.kind === 'hbeam' ? '成' : pf.kind === 'capsule' ? '胴' : '高さ'}
                      </span>
                      <span style={{ width: 58 }} data-be-resize-h>
                        {beNum(pf.hM != null ? pf.hM : '', '0.05',
                          v => _bePos(v, n => R({ profile: { hM: n } })), { title: '断面の高さ(m)' })}
                      </span>
                    </>}
                    {(pf.kind === 'hbeam' || pf.kind === 'capsule') && <>
                      <span style={{ color: BE.muted, fontSize: 10 }}>
                        {pf.kind === 'hbeam' ? '板厚' : '鏡板'}
                      </span>
                      <span style={{ width: 58 }} data-be-resize-t>
                        {beNum(pf.tM != null ? pf.tM : '', '0.01',
                          v => _bePos(v, n => R({ profile: { tM: n } })),
                          { title: pf.kind === 'hbeam' ? '板厚(m)' : '鏡板（丸み）の高さ(m)' })}
                      </span>
                    </>}
                    {beBtn('断面を作り直す', () => R({}), { key: 'rebuild',
                      title: '辺や頂点を直に動かして崩れた形を、作ったときの寸法から戻します' })}
                    <span style={{ color: BE.muted, fontSize: 10 }}>下端</span>
                    <span style={{ width: 58 }} data-be-resize-base>
                      {beNum(blk._baseM != null ? blk._baseM : 0, '0.1',
                        v => _beAny(v, n => R({ baseM: n })), { title: '下端の高さ(m)' })}
                    </span>
                    {!blk._revolve && blk._bulgeM != null && <>
                      <span style={{ color: BE.muted, fontSize: 10 }}>曲がり</span>
                      <span style={{ width: 58 }} data-be-resize-bulge>
                        {beNum(blk._bulgeM, '0.5',
                          v => _beAny(v, n => R({ bulgeM: n })),
                          { title: '点が2つのときだけ効きます（円弧のふくらみ・m）' })}
                      </span>
                    </>}
                  </div>
                );
              })()}
              {/* 【2026-10-06 ユーザー報告「確認方法がわからない」】
                  欄が出ないだけだと、機能そのものが無いように見える。
                  **入口は見せる、使えないときは理由と次の一手を出す**（裁定済みの原則） */}
              {typeof canResizeBlock === 'function' && !canResizeBlock(blk) && (
                <div data-be-resize="none"
                  style={{ color: BE.muted, fontSize: 10, lineHeight: 1.5,
                           background: BE.field, border: '1px solid ' + BE.line,
                           borderRadius: 4, padding: '4px 6px' }}>
                  {/* 【文は語彙表から引く・2026-10-18】旧文「〔⌁ 掃引〕〔⟳ 回す〕で作った棟では
                      ないため」は**名前も条件も誤り**だった。述語 canResizeBlock は
                      「_profile.kind があり custom でない」で、図に描いた輪郭は custom。
                      ＝〔✏ 輪郭を描く〕→〔⟳ 回す〕で作った棟にこそ「回すで作った棟ではない」
                      と出ていた。述語と説明を別々に手書きすると必ずこうなる（advisor 監査） */}
                  {(typeof canEditPointsDirectly === 'function' && !canEditPointsDirectly(blk)
                    && _語.理由.寸法を打ち直せない_描いた輪郭)
                    || _語.理由.寸法を打ち直せない}
                </div>
              )}
              {/* 【2026-10-03】屋根の傾き（片流れ屋根・擁壁）。
                  0 にすると平らに戻る。寄棟・入母屋は棟を分けて作る */}
              {(() => {
                const sl = _slopeOf(blk);
                const 低 = (typeof blockMinTopZ === 'function') ? blockMinTopZ(blk) : blk.zTop;
                const 高 = (typeof blockMaxTopZ === 'function') ? blockMaxTopZ(blk) : blk.zTop;
                return (
                  <div data-be-slope style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: BE.sub, fontSize: 11 }}>屋根の傾き</span>
                    <span style={{ color: BE.muted, fontSize: 10 }}>向き</span>
                    <span style={{ width: 62 }} data-be-slope-dir>
                      {beNum(sl.dirDeg != null ? sl.dirDeg : 90, '15',
                        v => _setSlope(bi, blk, { dirDeg: parseFloat(v) }),
                        { title: '上がっていく向き（度・真北基準）' })}
                    </span>
                    <span style={{ color: BE.muted, fontSize: 10 }}>°</span>
                    <span style={{ color: BE.muted, fontSize: 10 }}>勾配</span>
                    <span style={{ width: 62 }} data-be-slope-pitch>
                      {beNum(sl.pitch || 0, '0.05',
                        v => _setSlope(bi, blk, { pitch: parseFloat(v) }),
                        { title: '水平に1m進むと何m上がるか。0 で平らに戻る' })}
                    </span>
                    <span style={{ color: BE.muted, fontSize: 10 }}>
                      {sl.pitch ? ('軒 ' + _mm(低) + 'm → 棟 ' + _mm(高) + 'm') : '（0 で平ら）'}
                    </span>
                  </div>
                );
              })()}
              {/* 【2026-09-22】辺の長さ。変えると**始点を固定して終点が動く**（Codex）。
                  いびつな形でも辺ごとに効くので、矩形前提だった X/Y範囲の代わりになる */}
              {typeof canEditPointsDirectly === 'function' && !canEditPointsDirectly(blk) ? (
                /* 【2026-10-06 ユーザー報告・Codex監査済み】掃引・回転体の points は
                   「断面の点列」。辺や頂点を直に動かすと断面が壊れ、回したとき別物になる
                   （実測: 幅0.6m のはずが 外形 9.19×12.26m のリングになった）。
                   欄を出さず、どこで直すかを書く。崩れたら上の〔断面を作り直す〕で戻す */
                <div data-be-points="locked"
                  style={{ color: BE.muted, fontSize: 10, lineHeight: 1.5,
                           background: BE.field, border: '1px solid ' + BE.line,
                           borderRadius: 4, padding: '4px 6px' }}>
                  {/* 寸法欄が無い棟（描いた輪郭）では「上の欄で直して」と言わない。次の一手は上の理由の札が出す */}
                  {typeof canResizeBlock === 'function' && canResizeBlock(blk)
                    ? 'この棟の形は上の〔' + _断面の名(blk) + '〕の寸法で直してください。' : ''}
                  辺や頂点は断面の点なので、直に動かすと形が崩れます。
                </div>
              ) : blk.shape && blk.shape.type === 'circle' ? (
                /* 【2026-09-24】円柱。48角形の近似なので辺を1本ずつ出しても意味がない。
                   円の自由度は中心と半径だけ。半径を変えると points を作り直す */
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ color: BE.sub, fontSize: 11 }}>半径(m)</span>
                  <span style={{ width: 80 }} data-be-field="radius">
                    {beNum(_toM(blk.shape.r), '0.1', v => _setRadiusM(bi, blk, parseFloat(v)))}
                  </span>
                  <span style={{ color: BE.muted, fontSize: 10 }}>
                    直径 {_toM(blk.shape.r * 2)}m（円柱）
                  </span>
                </div>
              ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ color: BE.muted, fontSize: 11 }}>辺の長さ（m）— 始点を固定して終点が動く</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 4 }}>
                  {blk.points.map((a, ei) => {
                    const b2 = blk.points[(ei + 1) % blk.points.length];
                    const lenM = _toM(Math.hypot(b2.x - a.x, b2.y - a.y));
                    return (
                      <div key={'el' + ei} data-be-field="edgeLen" data-be-edge={ei}
                        style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                        <span style={{ color: BE.sub, fontSize: 11, whiteSpace: 'nowrap' }}>辺{ei}</span>
                        {beNum(lenM, '0.1', v => _setEdgeLenM(bi, blk, ei, parseFloat(v)))}
                      </div>
                    );
                  })}
                </div>
              </div>
              )}
              {/* 【2026-09-22】頂点の一覧。数が多い建屋では畳んでおく（Codex「主操作UIにすると重い」）。
                  1つずつ動かすので、他の頂点は巻き添えにならない */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {!blk.shape && beBtn((beVerts === bi ? '▾ ' : '▸ ') + '頂点 ' + blk.points.length + ' 個',
                  () => setBeVerts(v => v === bi ? null : bi), { key: 'vt' + bi })}
                {beVerts === bi && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) minmax(0,1fr) auto', gap: '4px 6px', alignItems: 'center' }}>
                    {blk.points.flatMap((v2, vi) => [
                      <span key={'vl' + vi} style={{ color: BE.sub, fontSize: 11 }}>#{vi}</span>,
                      <span key={'vx' + vi} data-be-field="vert" data-be-axis="x">{beNum(Math.round(v2.x), '1', nv => _setVert(bi, blk, vi, 'x', parseFloat(nv) || 0))}</span>,
                      <span key={'vy' + vi} data-be-field="vert" data-be-axis="y">{beNum(Math.round(v2.y), '1', nv => _setVert(bi, blk, vi, 'y', parseFloat(nv) || 0))}</span>,
                      <span key={'vm' + vi} style={{ color: BE.muted, fontSize: 10, whiteSpace: 'nowrap' }}>
                        {_toM(v2.x)},{_toM(v2.y)}m
                      </span>,
                    ])}
                  </div>
                )}
              </div>
              {/* 【2026-09-23】図で選んだ面の操作。CAD と同じで「面を選んで押し引き」が主。
                  選んでいないときは案内だけ出す（項目を増やさない） */}
              {selShell && selShell.blockIdx === bi ? (
                <div style={{ border: '1px solid ' + BE.accent, borderRadius: 4, padding: 6,
                              display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ color: BE.accent, fontSize: 11 }}>
                    選んでいる面：{_faceLabel(selShell)}
                  </span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    {beBtn('− 内へ', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, _faceKey(selShell), -MINOR), { key: 'sfm' })}
                    {beBtn('＋ 外へ', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, _faceKey(selShell), MINOR), { key: 'sfp' })}
                    {/* 【2026-09-23 ユーザー指示】「選択を外すボタンはいらない。
                        空間をクリックして解除できればいい」→ onSelectNone で外す */}
                    <span style={{ color: BE.muted, fontSize: 10 }}>何もない所をクリックで解除</span>
                  </div>
                </div>
              ) : (
                <span style={{ color: BE.muted, fontSize: 11 }}>
                  右の3D図で<b style={{ color: BE.sub }}>面をクリック</b>すると、その面を動かせます
                  （カーソルを当てると光ります）
                </span>
              )}
              {beBtn((beAdv === bi ? '▾ ' : '▸ ') + '細かい数値', () => setBeAdv(v => v === bi ? null : bi), { key: 'adv' + bi })}
              {beAdv === bi && (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: BE.muted, fontSize: 11 }}>面を動かす（辺を法線方向へ）</span>
                {blk.points.map((_, ei) => (
                  <span key={'e' + ei} style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                    {beBtn('−', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, ei, -MINOR),
                      { key: 'em' + ei, title: '辺' + ei + 'を内へ' })}
                    <span style={{ color: BE.sub, fontSize: 11 }}>辺{ei}</span>
                    {beBtn('＋', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, ei, MINOR),
                      { key: 'ep' + ei, title: '辺' + ei + 'を外へ' })}
                  </span>
                ))}
                <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                  {beBtn('−', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, 'zBottom', -MINOR), { key: 'zbm' })}
                  <span style={{ color: BE.sub, fontSize: 11 }}>底面</span>
                  {beBtn('＋', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, 'zBottom', MINOR), { key: 'zbp' })}
                </span>
                <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                  {beBtn('−', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, 'zTop', -MINOR), { key: 'ztm' })}
                  <span style={{ color: BE.sub, fontSize: 11 }}>上面</span>
                  {beBtn('＋', () => onMoveBlockFace && onMoveBlockFace(selBuilding.id, bi, 'zTop', MINOR), { key: 'ztp' })}
                </span>
              </div>
              )}
              {/* 【2026-09-23 ユーザー裁定「Cesiumは使用できる人とできない人がいるので、
                  できなくても機能を失わないような構成にしろ」】
                  増築棟＝この棟の壁の一部を共有して外へ生やす、背の低い棟（車庫・渡り廊下など）。
                  それまで Cesium の「面を伸縮」でしか作れなかったので、ここからも作れるようにした。 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
                            borderTop: '1px dashed ' + BE.line, paddingTop: 6 }}>
                <span style={{ color: BE.muted, fontSize: 11 }}>
                  増築棟を足す（この棟の壁からのばす。車庫・渡り廊下など）
                </span>
                {/* 【2026-09-23】幅260pxで横一列にすると折り返して読めなくなったので、
                    ラベル1列＋入力1列のグリッドにする（ユーザー実機報告の画像で「出幅」の値が
                    次の行に落ちていた）。ボタンは見出しと同じ言葉にする（「増築棟を足す」を
                    探して見つからない、という報告への対処）。 */}
                <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)',
                              gap: '4px 6px', alignItems: 'center' }}>
                  <span style={{ color: BE.sub, fontSize: 11 }}>のばす辺</span>
                  <select value={_annexOf(bi).edge} onChange={e2 => _setAnnex(bi, 'edge', e2.target.value)}
                    style={{ height: 24, width: '100%', minWidth: 0, boxSizing: 'border-box',
                             background: BE.field, color: BE.text,
                             border: '1px solid ' + BE.line, borderRadius: 4, fontSize: 11 }}>
                    {blk.points.map((_, ei) => (
                      <option key={'ae' + ei} value={ei}>
                        辺{ei}（{_toM(Math.hypot(
                          blk.points[(ei + 1) % blk.points.length].x - blk.points[ei].x,
                          blk.points[(ei + 1) % blk.points.length].y - blk.points[ei].y))}m）
                      </option>
                    ))}
                  </select>
                  <span style={{ color: BE.sub, fontSize: 11 }}>長さ(m)</span>
                  <span data-be-field="annex" data-be-annex="len">{beNum(_annexOf(bi).len, '0.1', v => _setAnnex(bi, 'len', v))}</span>
                  <span style={{ color: BE.sub, fontSize: 11 }}>出幅(m)</span>
                  <span data-be-field="annex" data-be-annex="depth">{beNum(_annexOf(bi).depth, '0.1', v => _setAnnex(bi, 'depth', v))}</span>
                  <span style={{ color: BE.sub, fontSize: 11 }}>高さ(m)</span>
                  <span data-be-field="annex" data-be-annex="h">{beNum(_annexOf(bi).h, '0.1', v => _setAnnex(bi, 'h', v))}</span>
                </div>
                {beBtn('＋ 増築棟を追加', () => _addAnnex(bi, blk), { key: 'ax' + bi, flex: true })}
                <span style={{ color: BE.muted, fontSize: 10 }}>
                  選んだ辺の中央に作ります。位置は作ったあとに「頂点」や「辺の長さ」で動かせます。
                </span>
              </div>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 6 }}>
          {beBtn('建屋を削除', () => onDeleteBuilding && onDeleteBuilding(selBuilding.id), { danger: true, flex: true })}
        </div>
        {/* 【2026-09-22 ユーザー指摘・Codex監査済み】「＋ブロック追加」はここから消した。
            ブロック＝親の壁をその範囲だけくり抜いて生やす増築棟なので、
            「どの面の、どこからどこまでを共有するか」を図の上で指さないと連結できない。
            数値UIから足すと連結情報の無い箱が増えるだけ＝建屋をもう1つ作るのと変わらなかった。 */}
        <div style={{ color: BE.muted, fontSize: 11, lineHeight: 1.7 }}>
          2D/3Dの図で建屋の面をクリックすると矢印が出て、直接ドラッグでも動かせます（🏗モード中）
          {/* 【2026-09-23 ユーザー裁定】「Cesiumは使用できる人とできない人がいるので、
              できなくても機能を失わないような構成にしろ」。増築棟は各ブロックの
              「増築棟を足す」から作れる。Cesium は同じものを図の上で作れる別の入口。 */}
          <div style={{ marginTop: 4 }}>
            <b style={{ color: BE.sub }}>増築棟</b>（同じ建屋の中の、壁を共有した背の低い棟。車庫・渡り廊下など）は
            上の各ブロックにある <b style={{ color: BE.sub }}>「＋ 増築棟を追加」</b> のボタンで作れます。
            <div style={{ marginTop: 3 }}>
              図を見ながら作りたいときは「CesiumJS 3D」の窓で、建屋の面をクリック →
              <b style={{ color: BE.sub }}>「面を伸縮」</b> → 面の上で対角2点 → 距離を決めて確定、でも同じものができます
              （Cesium が使えなくても上の入口だけで作れます）。
            </div>
          </div>
        </div>
      </div>
    );
  })();

  // ── 上部: 建物・階の選択、表示形式の切り替え、階の追加/削除 ──
  const beSelectStyle = { height: 26, background: BE.field, color: BE.text, border: '1px solid ' + BE.line, borderRadius: 4, fontSize: 12, minWidth: 0 };
  const beHeader = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select value={selBuildingId || ''} onChange={e => setSelBuildingId(e.target.value)} style={{ ...beSelectStyle, flex: 1 }}>
          {ホストら.length === 0 && <option value="">形がありません</option>}
          {ホストら.map(b => <option key={b.id} value={b.id}>
            {(Array.isArray(b.ops) ? "⬡ " : "") + b.label}</option>)}
        </select>
        {selBuilding && (
          <select value={selFloorId || ''} onChange={e => setSelFloorId(e.target.value)} style={{ ...beSelectStyle, width: 82 }}
            title={selFloor ? `${selFloor.levelZ}m〜、階高${selFloor.heightM}m` : ''}>
            {floors.length === 0 && <option value="">階なし</option>}
            {floors.map(f => <option key={f.id} value={f.id}>{bcFloorLabel(selBuilding, f)}</option>)}
          </select>
        )}
        {selBuilding && beBtn('🏗', () => setBeShell(v => !v), { on: beShell, title: 'ガワ（外壁）の形・高さ・壁厚' })}
        {selBuilding && beBtn('⋯', () => setBeFloorMenu(v => !v), { on: beFloorMenu, title: '階の追加・削除' })}
      </div>
      {beShell && selBuilding && beShellPanel}
      {ホストら.length === 0 && <div style={{ color: BE.muted }}>
        形がありません。3次元図の〔🏗 建屋〕で輪郭を描いて作ってください
        （〔⬡ 立体エディタ〕で作った立体も、ここに ⬡ 付きで並びます）</div>}
      {beFloorMenu && selBuilding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid ' + BE.line, borderRadius: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto minmax(0,1fr)', gap: 6, alignItems: 'center' }}>
            <span style={{ color: BE.sub }}>床標高</span>{beNum(floorAddZ, '0.1', v => setFloorAddZ(v))}
            <span style={{ color: BE.sub }}>階高</span>{beNum(floorAddH, '0.1', v => setFloorAddH(v))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {beBtn('階を追加', () => {
              const z = parseFloat(floorAddZ), h = parseFloat(floorAddH);
              if (!isFinite(z) || !isFinite(h) || h <= 0) { setMsg('数値を入力してください'); return; }
              const err = onAddFloor ? onAddFloor(selBuilding.id, z, h) : '未接続';
              setMsg(err);
              if (!err) setFloorAddZ(String(Math.round((z + h) * 10) / 10));
            })}
            {selFloor && <span style={{ marginLeft: 'auto' }}>{beBtn(`${bcFloorLabel(selBuilding, selFloor)}を削除`, () => {
              onDeleteFloor && onDeleteFloor(selBuilding.id, selFloor.id); setMsg(null);
            }, { danger: true })}</span>}
          </div>
          <label style={{ cursor: 'pointer', color: BE.sub }}>
            <input type="checkbox" checked={!!floorFollow} onChange={() => onToggleFloorFollow && onToggleFloorFollow()}
              style={{ verticalAlign: 'middle', marginRight: 4 }} />
            建物の変形に階を追従させる
          </label>
        </div>
      )}
      {selFloor && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'flex', border: '1px solid ' + BE.line, borderRadius: 4, overflow: 'hidden' }}>
            {[['list', '一覧'], ['tabs', '種類別']].map(([v, lb]) => (
              <button key={v} onClick={() => setBeLayoutKeep(v)}
                style={{ height: 22, padding: '0 10px', border: 'none', cursor: 'pointer', fontSize: 12,
                         background: beLayout === v ? BE.accentBg : 'transparent', color: beLayout === v ? BE.accent : BE.sub }}>{lb}</button>
            ))}
          </div>
          <span style={{ marginLeft: 'auto', color: BE.muted }}>部屋 {rooms.length}</span>
        </div>
      )}
    </div>
  );

  // ── 行（A も B も同じ行を使う）──
  const beRow = (it, o = {}) => {
    const sel = it === beSelItem;
    const glyph = BE_GLYPH[it.kind === 'wall' && it.ep.kind !== 'wall' ? 'clear' : it.kind];
    return (
      <div key={it.key} data-be-row={it.kind} onClick={it.onSelect}
        onMouseEnter={it.onHover ? () => it.onHover(true) : undefined}
        onMouseLeave={it.onHover ? () => it.onHover(false) : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 4,
                 padding: `5px 6px 5px ${6 + (o.flat ? 0 : it.depth * 14)}px`,
                 background: sel ? BE.accentBg : 'transparent', color: sel ? BE.accent : BE.text }}>
        <span style={{ width: 12, textAlign: 'center', color: sel ? BE.accent : BE.muted }}>{glyph}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
        {it.warn && it.warn.length > 0 && <span style={{ color: BE.warn }} title={it.warn.join('・')}>⚠</span>}
        <span style={{ color: sel ? BE.accent : BE.muted, fontSize: 11, whiteSpace: 'nowrap' }}>{o.hostSub ? o.hostSub : it.sub}</span>
      </div>
    );
  };
  const beEmptySel = <div style={{ color: BE.muted }}>一覧か3D図で選ぶと、ここで寸法を変えられます</div>;

  // A: 一覧（字下げ）＋ 下に選択中の欄を固定
  const beLayoutList = (
    <>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{beItems.map(it => beRow(it))}</div>
      <div style={{ flex: 'none', maxHeight: '48%', overflowY: 'auto', borderTop: '1px solid ' + BE.line, paddingTop: 8 }}>
        {beSelItem ? (
          <>
            <div style={{ marginBottom: 8, color: BE.text }}>
              <span style={{ color: BE.sub }}>{beKindName(beSelItem)}</span>　{beSelItem.label}
            </div>
            {beProps(beSelItem)}
          </>
        ) : beEmptySel}
      </div>
    </>
  );
  // B: 種類別タブ。選んだ行の真下に入力欄を開く
  const beHostOf = (it) => (it.kind === 'door' || it.kind === 'faceIcon')
    ? (it.face === 'outer' ? ('外壁' + (/arc/.test((it.ic && it.ic.outerKey) || '') ? '(曲面)' : ''))
      : `${it.d && it.kind === 'faceIcon' ? '扉' : (it.ep.kind === 'wall' ? '壁' : '透明仕切り')} ${it.ep.lenM.toFixed(1)}m`)
    : it.kind === 'floorIcon' ? (it.face === 'ceil' ? '天井' : '床')
    : it.kind === 'panel' ? '床' : null;
  const beCurTab = BE_TABS.find(t => t.id === beTab) || BE_TABS[1];
  const beLayoutTabs = (
    <>
      <div style={{ display: 'flex', borderBottom: '1px solid ' + BE.line, flex: 'none' }}>
        {BE_TABS.map(t => {
          const n = beItems.filter(it => t.kinds.includes(it.kind)).length;
          const on = t.id === beCurTab.id;
          return (
            <button key={t.id} onClick={() => setBeTab(t.id)}
              style={{ flex: 1, height: 28, border: 'none', cursor: 'pointer', fontSize: 12, background: 'transparent',
                       color: on ? BE.accent : BE.sub, borderBottom: '2px solid ' + (on ? BE.accent : 'transparent') }}>
              {t.label} <span style={{ color: BE.muted }}>{n}</span>
            </button>
          );
        })}
      </div>
      {/* minHeight は 0 でなく 120。0 だとガワを開いたとき一覧が消える（2026-09-23） */}
      <div style={{ flex: 1, minHeight: 120, overflowY: 'auto' }}>
        {beItems.filter(it => beCurTab.kinds.includes(it.kind)).map(it => (
          <div key={it.key} style={{ borderBottom: '1px solid ' + BE.line }}>
            {beRow(it, { flat: true, hostSub: beHostOf(it) ? `${beHostOf(it)}・${it.sub}` : null })}
            {it === beSelItem && <div style={{ padding: '4px 6px 10px' }}>{beProps(it)}</div>}
          </div>
        ))}
        {beItems.filter(it => beCurTab.kinds.includes(it.kind)).length === 0 && (
          <div style={{ color: BE.muted, padding: 6 }}>この階に{beCurTab.label}はありません</div>
        )}
      </div>
    </>
  );


  return (
    /* data-sel-shell: いま図で選んでいるガワの面（外から見える診断の印・2026-09-23） */
    <div data-sel-shell={selShell ? selShell.shellFaceId : undefined}
      style={{ width: '100%', height: '100%', display: 'flex', background: '#334155', color: '#E2E8F0', fontSize: 12 }}>
      {/* 左パネル（A: 一覧＋選択中 / B: 種類別タブ）。中身は上の beItems / beProps / beToolbar / beHeader の1組だけ */}
      {/* 【2026-09-23 ユーザー実機報告「スクロールがないので下部に行けない」】
          height:100% だけで overflow の指定が無く、ガワ（🏗）を開くと下が画面外で読めなかった。
          左パネル全体を1本のスクロールにする（中の一覧は下で最低の高さを持たせ、
          潰れきらずに余りを親のスクロールへ回す）。 */}
      <div data-bld-left-panel={beLayout}
        style={{ width: 260, borderRight: '1px solid ' + BE.line, padding: 8, boxSizing: 'border-box',
                 display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, height: '100%',
                 overflowY: 'auto', overflowX: 'hidden' }}>
        {beHeader}
        {beToolbar}
        {beHints}
        {selFloor && (beLayout === 'tabs' ? beLayoutTabs : beLayoutList)}
      </div>

      {/* 【3D一本】2D編集タブは 2026-09-01 に撤去した（spec 14.27 段階D-2）。
          2Dにしかない機能は無く、逆に3Dにしかない機能（壁の高さ・階編集・寸法表示・
          壁面/床置き機器・配置済み盤）が増えていたため。旧版は BuildingEditor.jsx.pre2Dremoval.bak */}
      <div style={{ flex: 1, position: 'relative' }}>
        {selBuilding
            ? <BuildingPreview3D building={selBuilding} floorId={selFloorId} pnDeg={pnDeg} setPnDeg={setPlantNorthAngle}
                onGrabWall={onGrabWall3D} onDragWall={onDragWall3D}
                previewPart={dragPreview && dragPreview.partId ? dragPreview : null}
                editFloorId={floorEditMode && selFloor ? selFloor.id : null}
                selPartId={hotPartId}
                selShellFaceId={selShell ? selShell.shellFaceId : null}
                onSelectShellFace={(sh) => setSelShell(sh)}
                /* 選んだ面の上でドラッグして描いた矩形 → 増築棟（CAD の「面にスケッチ」） */
                onFaceSketchRect={_applyFaceSketch}
                /* 🏗 を開いている間はガワの面を最優先で拾う（部屋の壁・床に邪魔されない） */
                shellMode={beShell}
                focusReq={focusReq}
                selFloorHiId={selFloorHi}
                selDoorId={selDoorId}
                hoverDoorId={hoverDoorId}
                previewDoor={doorPreview}
                onSelectDoor={onSelectDoor3D}
                onDragDoor={onDragDoor3D}
                selIconId={selIconId}
                hoverIconId={hoverIconId}
                previewIcon={iconPreview}
                onSelectIcon={onSelectIcon3D}
                onDragIcon={onDragIcon3D}
                onRotateIcon={onRotateIcon3D}
                onDragLabel={onDragLabel3D}
                onFocusIcon={onFocusIcon3D}
                /* 【Phase D】配置済みの盤を床置きの箱として同じループで描かせる */
                extraBoxes={bldPanelBoxes}
                /* 作図中はクリックを作図に回す。2Dは 機器＞扉＞床の形＞壁 の順で
                   優先するので、3Dも同じ順序にする（挙動を揃える） */
                drawTool={iconPlace ? 'icon' : (doorPlace ? 'door' : (floorEdit ? 'floor' : tool))}
                drawFloorZ={selFloor ? selFloor.levelZ : 0}
                onDrawClick={(g, face) => drawClickAt(g, gridToScreen3D, face)}
                onDrawHover={(g) => setCursorG(g)}
                onCancelDraw={drawCancelOrCommit}
                /* 【Phase D】配電盤エディタからテンプレートをドラッグして床へ落とす。
                   位置は3Dが床面へ逆投影した点、据付高さはその階の標高 */
                onDropOnFloor={onDropPanelOnFloor && selFloor ? ((e, g) => {
                  if (!g) { setMsg('床の上に落としてください'); return; }
                  onDropPanelOnFloor(e, g.x, g.y, selFloor.levelZ);
                  setMsg(null);
                }) : null}
                drawGhost={draw3D.ghost}
                drawGuides={gizGuide || draw3D.guides}
                drawPoly={draw3D.poly}
                projectorRef={proj3DRef}
                selWall={selWall3D}
                onDragGizmo={onDragGizmo3D}
                dimLabel={gizDim}
                onSelectFloor={(fid) => { setSelFloorId(fid); selectLocal({ floorHi: fid, fId: fid }); }}
                onSelectNone={() => { selectLocal({}); setSelShell(null); }}
                editHeader={selFloor && (
                  floorEditMode ? (
                    <>
                      <span style={{ background: 'rgba(15,23,42,0.72)', padding: '3px 8px', borderRadius: 4, fontSize: 11 }}>
                        {bcFloorLabel(selBuilding, selFloor)} を編集中
                      </span>
                      <button onClick={() => setFloorEditMode(false)}
                        style={{ background: 'rgba(239,68,68,0.85)', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}>
                        編集を解除
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setFloorEditMode(true)}
                      style={{ background: 'rgba(0,180,255,0.9)', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}>
                      {bcFloorLabel(selBuilding, selFloor)} を編集
                    </button>
                  )
                )} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94A3B8' }}>建物を選んでください</div>
        }
      </div>
    </div>
  );
}
