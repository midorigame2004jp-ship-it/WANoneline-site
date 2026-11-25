// ================================================================
// 3次元図の配電盤描画 — 見た目は panelDrawCore.js（共通描画コア）が唯一の正。
// ここに残すのは3次元図固有の座標変換（盤の配置・回転・カメラ）と収集ロジックだけ。
// 色・輝度・アルファ・線幅・形状を触るときは panelDrawCore.js を編集すること。
// ================================================================
// カメラ規約: Y軸反転済みの effAz と -camEl を渡す（エディタは panel-local az/el）
function _pde_isBackFacing(normal, az, el) {
  const nx = normal.nx||0, ny = normal.ny||0, nz = normal.nz||0;
  const ry_n = nx * Math.sin(az) - ny * Math.cos(az);
  return (ry_n * Math.cos(el) - nz * Math.sin(el)) < 0;
}

// 描画はCanvasに移行。ここは扉クリック判定用の透明SVGポリゴンのみ返す
function _pde_panelSVGElems(pp, camAz, camEl, camZoom, camPanX, camPanY) {
  const panel = pp.panelData; if (!panel) return [];
  const mpp = (typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:0.1;
  const PPM = 1/(mpp*1000);
  const cos=Math.cos(pp.rot||0), sin=Math.sin(pp.rot||0);
  const W=panel.widthMm||600, H=panel.heightMm||1800, D=panel.depthMm||400;
  const pivWx = pp.wx + W/2*PPM;
  const pivWy = pp.wy + D/2*PPM;
  const proj=(cx,cy,cz)=>project3D(
    pivWx+((cx-W/2)*cos+(cy-D/2)*sin)*PPM,
    pivWy+((cx-W/2)*sin-(cy-D/2)*cos)*PPM,
    cz/1000, camAz, camEl, camZoom, camPanX, camPanY);
  const toPts=(pts2d)=>pts2d.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const avgDepth=(pts2d)=>pts2d.reduce((s,p)=>s+p.depth,0)/pts2d.length;

  // 扉非表示中はクリック判定も無効化する（エディタで非表示の扉が選択・開閉できないのと同じ）
  const doors = (panel.doorsVisible === false) ? [] : (panel.doors||[]);
  const elems = [];
  let ki = 0;

  // 扉クリック判定用透明ポリゴン（描画なし・クリックのみ）
  for (let di=0; di<doors.length; di++) {
    const door = doors[di];
    if (!door.isOpen) {
      const mn = PDC_DOOR_MOUNT_NORMALS[door.face]||{nx:0,ny:-1,nz:0};
      if (_pde_isBackFacing(mn, -(camAz - (pp.rot||0)), -camEl)) continue;
    }
    const corners = pdcDoorCorners(door, panel);
    const pts2d = corners.map(([x,y,z])=>proj(x,y,z));
    const depth = avgDepth(pts2d);
    elems.push({key:`d${ki++}`, kind:'polygon', pts:toPts(pts2d), fill:'transparent', opacity:1, stroke:'none', strokeW:0, depth, isDoor:true, doorIdx:di});
  }

  return elems;
}

// pivWx/pivWy方式のproj。法線カリングはcamAz-rotを渡して盤ローカル座標で判定
function _pde_makeCabProj(pp, camAz, camEl, camZoom, camPanX, camPanY) {
  const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
  const PPM = 1 / (mpp * 1000);
  const cos = Math.cos(pp.rot || 0), sin = Math.sin(pp.rot || 0);
  const W = (pp.panelData && pp.panelData.widthMm) || 600;
  const D = (pp.panelData && pp.panelData.depthMm) || 400;
  const pivWx = pp.wx + W/2*PPM;
  const pivWy = pp.wy + D/2*PPM;
  return (cx_mm, cy_mm, cz_mm) => project3D(
    pivWx + ((cx_mm - W/2)*cos + (cy_mm - D/2)*sin) * PPM,
    pivWy + ((cx_mm - W/2)*sin - (cy_mm - D/2)*cos) * PPM,
    cz_mm / 1000, camAz, camEl, camZoom, camPanX, camPanY);
}

// ── Chamber（区画）の遅延解決 ──
// 配線 waypoint が chamberId 参照のとき、区画中心座標の解決に必要。
// エディタは useMemo で1回だけ計算するので、3次元図も panel 参照をキーにキャッシュする。
// panelChambers.js 未ロード時は null（chamberId waypoint はスキップされ従来動作のまま）。
const _pde_chamberCache = new WeakMap();
function _pde_chambersOf(panel) {
  if (!panel || typeof deriveChambers !== 'function') return null;
  if (_pde_chamberCache.has(panel)) return _pde_chamberCache.get(panel);
  let chs = null;
  try { chs = deriveChambers(panel); } catch (e) { chs = null; }
  _pde_chamberCache.set(panel, chs);
  return chs;
}

// ── レイヤー合成用オフスクリーン（エディタの offCanvasRef 相当）──
// エディタは内部要素をZバッファ付きオフスクリーンに「不透明」でラスタライズしてから
// globalAlpha=pdcInteriorAlpha() で1回だけ合成する（1ピクセル1色＝アルファ累積なし）。
// 3次元図も同じ構造にするための共用レイヤー。毎フレーム確保するとGC圧になるので
// メインcanvasと同じデバイスピクセル寸法でモジュールレベルにキャッシュする。
let _pde_layerCvs = null;
function _pde_getLayerCanvas(w, h) {
  if (!_pde_layerCvs || _pde_layerCvs.width !== w || _pde_layerCvs.height !== h) {
    _pde_layerCvs = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  return _pde_layerCvs;
}

// ── 配線の隠面処理用 低解像度マスクcanvas＋バッファ（エディタの cableVis 相当）──
// エディタは半解像度Zバッファで「配線の各画素が仕切り・アイコンBoxより手前か」を判定し、
// destination-in で配線レイヤーを削る。3次元図も同じ方式にするための作業領域。
// 解像度は ocResLimit（既定512px）で頭打ちにして負荷を抑える。
let _pde_maskCvs = null, _pde_maskBuf = null, _pde_maskZb = null;
function _pde_getMaskWork(w, h) {
  if (!_pde_maskCvs || _pde_maskCvs.width !== w || _pde_maskCvs.height !== h) {
    _pde_maskCvs = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  const n = w * h;
  if (!_pde_maskBuf || _pde_maskBuf.length !== n * 4) _pde_maskBuf = new Uint8ClampedArray(n * 4);
  else _pde_maskBuf.fill(0);
  if (!_pde_maskZb || _pde_maskZb.length !== n) _pde_maskZb = new Float32Array(n);
  _pde_maskZb.fill(-1e9);
  return { cvs: _pde_maskCvs, buf: _pde_maskBuf, zb: _pde_maskZb };
}

// ── 仕切りエッジの隠面処理用 低解像度マスク作業領域（Step 2b専用）──
// 【重要】_pde_getMaskWork（配線用）と共用してはいけない。X線モード（semi/full）では
// 配線マスクcanvas（_pde_maskCvs）を層5（扉描画後 = Step 2bより後）で drawImage するため、
// Step 2b が同じ作業領域を上書きすると配線マスクが壊れる。
let _pde_edgeCvs = null, _pde_edgeBuf = null, _pde_edgeZb = null, _pde_edgeOccZb = null;
function _pde_getEdgeMaskWork(w, h) {
  if (!_pde_edgeCvs || _pde_edgeCvs.width !== w || _pde_edgeCvs.height !== h) {
    _pde_edgeCvs = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  const n = w * h;
  if (!_pde_edgeBuf || _pde_edgeBuf.length !== n * 4) _pde_edgeBuf = new Uint8ClampedArray(n * 4);
  else _pde_edgeBuf.fill(0);
  if (!_pde_edgeZb || _pde_edgeZb.length !== n) _pde_edgeZb = new Float32Array(n);
  _pde_edgeZb.fill(-1e9);
  if (!_pde_edgeOccZb || _pde_edgeOccZb.length !== n) _pde_edgeOccZb = new Float32Array(n);
  _pde_edgeOccZb.fill(-1e9);
  return { cvs: _pde_edgeCvs, buf: _pde_edgeBuf, zb: _pde_edgeZb, occZb: _pde_edgeOccZb };
}

// ── 仕切り交差の事前分割キャッシュ（盤ごと）──
// pdcBuildPartitionSplit（panelDrawCore.js）は視点非依存（盤ローカルmm座標だけで
// 決まる）なので、盤の寸法・仕切り構成が変わらない限り再計算しない。
// 3次元図は複数盤を扱うため WeakMap（キー = panelData オブジェクト）で盤ごとに保持し、
// 構成署名（寸法＋partitions）が一致する間だけ再利用する。WeakMapなので
// 削除された盤のキャッシュは自動回収される。
const _pde_partSplitCache = new WeakMap();
function _pde_partitionSplitOf(panel, solids) {
  const sig = JSON.stringify([
    panel.widthMm, panel.heightMm, panel.depthMm,
    (panel.partitions || []).map(p => [p.id, p.type, p.axis, p.posMm,
      p.uMinMm, p.uMaxMm, p.vMinMm, p.vMaxMm, p.thicknessMm, p.color,
      p.virtual, p.vertices]),
  ]);
  const hit = _pde_partSplitCache.get(panel);
  if (hit && hit.sig === sig) return hit.split;
  const split = pdcBuildPartitionSplit(solids);
  _pde_partSplitCache.set(panel, { sig, split });
  return split;
}

function _pde_drawPanelOnCab(ctx, pp, camAz, camEl, camZoom, camPanX, camPanY, fastMode, canvasSc, ocResLimit, iconVisMode='opaque', cablesVisible=true, doorsVisible=true) {
  canvasSc = canvasSc || 1;
  const panel = pp.panelData; if (!panel) return;
  const proj = _pde_makeCabProj(pp, camAz, camEl, camZoom, camPanX, camPanY);
  const _rot = pp.rot || 0;
  const effAz = -(camAz - _rot); // Y軸反転補正済み方位角（エディタと同じ符号）
  const W = panel.widthMm || 600, H = panel.heightMm || 1800, D = panel.depthMm || 400;
  const _transparency = pdcTransparency(panel); // 共通コア: 未設定時はエディタと同じ80(ほぼ透明)
  const solidAlpha = pdcSolidAlpha(_transparency); // panelDrawCore.js 共通コア
  const doors = panel.doors || [];
  // エディタ（PanelCanvas3D.jsx L1045〜）と同一判定にそろえる
  const _panelDispMode0 = panel.iconDisplayMode || 'flat';
  const _hasBoxIcons = (panel.placedIcons || []).some(ic => {
    const _m = (ic.iconDisplayMode === 'flat' || ic.iconDisplayMode === 'box') ? ic.iconDisplayMode : _panelDispMode0;
    return _m === 'box' && ic.wx != null && _panelDispMode0 !== 'hidden';
  });
  // 配線X線モード: box iconの有無を問わない（semi/fullなら配線は常にX線合成）
  const _cableXrayMode = (iconVisMode === 'semi' || iconVisMode === 'full');
  // アイコンBox透視モード（Box専用に純化）
  const _iconOnlyMode = _cableXrayMode && _hasBoxIcons;

  // 実キャンバスピクセルでの盤幅・高さを計算（canvasSc = ctx.scale値）
  const _ps0 = proj(0,0,H/2), _psW = proj(W,0,H/2);
  const _screenPanelW = Math.hypot(_psW.x-_ps0.x, _psW.y-_ps0.y) * canvasSc; // 実px（幅方向）
  const _ps0h = proj(0,0,0), _psHh = proj(0,0,H);
  const _screenPanelH = Math.hypot(_psHh.x-_ps0h.x, _psHh.y-_ps0h.y) * canvasSc; // 実px（高さ方向）
  const _scaleR = W > 0 ? _screenPanelW / W : 0.05; // 実px/mm

  const intElems = [];
  let _cableRoutes = []; // [{cable, pts3d, pts2d}] — 配線の隠面マスク構築に使う
  const INTERIOR_THRESHOLD_PX = 30;

  ctx.save();
  ctx.setLineDash([]);
  // CSS px 1px = CAB座標系での (dpr/canvasSc) 値。線幅をエディタのCSS px基準に統一する。
  const _lw_unit = (window.devicePixelRatio||1) / canvasSc;
  // 1mm あたりの depth 単位数。proj（_pde_makeCabProj → project3D）の depth はグリッドpx単位
  // （project3D が z をメートル→グリッドpx に変換して合成するため）。1mm = PPM グリッドpx。
  // PPM は _pde_makeCabProj のローカル変数なのでここで同式（フォールバックも同じ0.1）を再計算する。
  const _mppD = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
  // 共通描画コア（panelDrawCore.js）用ビュー。3次元図規約: effAz / -camEl、depth大=奥
  const _pdcView = {
    proj,
    isBackFacing: (n) => _pde_isBackFacing(n, effAz, -camEl),
    nearSign: -1,
    lwUnit: _lw_unit,
    // 1mm あたりのCSS px数。_scaleR は実（デバイス）px/mm なので dpr で割ってCSS px基準に揃える
    // （エディタの pxPerMm=zoom は CSS px/mm なので、これで両者の基準が一致する）
    pxPerMm: _scaleR / (window.devicePixelRatio || 1),
    depthPerMm: 1 / (_mppD * 1000),
  };

  // ── 外箱面（共通コア・panelToSolidsで実形状を反映）──
  const _solids = panelToSolids(panel);
  const outerFaces = pdcCollectOuterFaces(_solids, _pdcView);
  pdcPaintOuterFaces(ctx, outerFaces, solidAlpha);

  if (fastMode) {
    pdcPaintOuterWireframe(ctx, panel, _pdcView, _transparency);
    ctx.restore();
    return;
  }

  // エディタと同条件: 透明度>0 or 前面向き開扉あり or X線モード のとき内部を表示
  const _openings = pdcDoorOpenings2D(panel, _pdcView);
  // 構造物（仕切り）を見せる条件と、内部要素を集める条件を分離する。
  // 配線は semi/full なら密閉（透明度0・開扉なし）でもX線で見せるため showInterior に含める。
  const _showStructure = _transparency > 0 || _openings.length > 0 || _iconOnlyMode || !doorsVisible;
  const showInterior = _showStructure || _cableXrayMode;

  // ── 内部要素の収集（描画順はエディタ準拠: 外箱面→内部→ワイヤーフレーム→扉）──
    if (showInterior && _screenPanelW >= INTERIOR_THRESHOLD_PX) {
      // 仕切り: 貫通交差する仕切り同士のPainter'sチラつき対策として、
      // 他仕切りの中央平面で事前分割（キャッシュ済み）した断片を収集する。
      // 色はエディタと同一（pdcPartitionFaceRGB）・エッジ線には分割を適用しない
      const _partSplit = _pde_partitionSplitOf(panel, _solids);
      for (const pf of pdcCollectPartitionFaces(_solids, _pdcView, _partSplit)) {
        intElems.push({ type:'partitionFace', pts: pf.pts, depth: pf.depth, rgb: pf.rgb });
      }
      const _panelDispMode = panel.iconDisplayMode || 'flat';
      for (const icon of (panel.placedIcons||[])) {
        const iMode = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box' || icon.iconDisplayMode === 'hidden')
          ? icon.iconDisplayMode : _panelDispMode;
if (iMode==='hidden') continue;
        // wx/wy/wz が未設定の場合は cellBox 中心を使う（配電盤エディタと同じ計算）
        const cb0 = icon.cellBox;
        const icx = icon.wx ?? (cb0 ? (cb0.xMin+cb0.xMax)/2 : W/2);
        const icy = icon.wy ?? (cb0 ? (cb0.yMin+cb0.yMax)/2 : D/2);
        const icz = icon.wz ?? (cb0 ? (cb0.zMin+cb0.zMax)/2 : H/2);
        // 形状（半幅・6面）・基準色・面輝度は共通コア（panelDrawCore.js）に一本化
        const _iBase = pdcIconBaseRGB(icon.iconColor);
        if (iMode==='box') {
          const _iFaces = pdcCollectIconBoxFaces(
            _pdcView, icx, icy, icz, icon.cellBox, icon.face || 'front', _iBase);
          for (const f of _iFaces) {
            intElems.push({ type:'iconFace', pts:f.pts, depth:f.depth, rgb:f.rgb });
          }
        } else {
          if (!_pdcView.isBackFacing({nx:0,ny:-1,nz:0})) {
            const pts2d = pdcIconFlatCorners(_pdcView, icx, icy, icz, panel);
            intElems.push({ type:'iconFlat', pts:pts2d,
              depth: pts2d.reduce((s,pt)=>s+pt.depth,0)/pts2d.length });
          }
        }
      }
      // ── 配線: 経路構築 → Wireセットグループ化 → チェーン化（すべて共通コアが唯一の正）──
      // 複数の cable オブジェクトが1本の配線を成していても、チェーン単位で1本のパスとして
      // 描くため折れ点・継ぎ目で外枠が途切れない。
      if (cablesVisible) {
        const _routes = pdcBuildCableRoutes(panel, _pde_chambersOf(panel), _pdcView);
        // 隠面マスク構築用にケーブル単位の経路を保持（エディタの _cRouteMap 相当）
        _cableRoutes = _routes;
        for (const _members of pdcGroupCablesByWireSet(_routes).values()) {
          const _cs = pdcCableStyle(_members[0].cable);
          // 分岐(T字・十字)のあるWireセットはchainが複数本に分裂しうるが、
          // pdcPaintCableChainsは「外枠を全chain分先に描いてから中心線を全chain分描く」
          // ことで分岐点の継ぎ目を防ぐ設計なので、必ずグループ単位でまとめて渡す
          // （chainごとに個別に渡すと外枠→中心線が交互になり分岐点に継ぎ目が出る＝エディタとの乖離）
          const _chains = pdcBuildCableChains(_members);
          if (_chains.length > 0) {
            let _s = 0, _n = 0;
            for (const _ch of _chains) for (const _part of _ch) for (const _pt of (_part.pts2d||[])) { _s += _pt.depth||0; _n++; }
            intElems.push({ type:'cableChain', chains:_chains, depth: _n > 0 ? _s / _n : 0, style:_cs });
          }
        }
      }
    }

  // 開扉の開口部にクリップ（呼び出し側で ctx.save() 済みであること）
  const _clipToOpenings = () => {
    ctx.beginPath();
    for (const o of _openings) {
      ctx.moveTo(o.pts[0].x, o.pts[0].y);
      for (let i=1; i<o.pts.length; i++) ctx.lineTo(o.pts[i].x, o.pts[i].y);
      ctx.closePath();
    }
    ctx.clip();
  };

  // X線モード（semi/full）用: 扉描画後に最上層として描く要素と合成関数を持ち回る
  let _xrayIconElems = [], _xrayComposeLayer = null, _xrayPaintElem = null, _xrayHasCable = false;
  let _xrayCablePaint = null, _xrayCableFb = null;

  // Pass 2: 内部要素をdepth降順で描画（外箱の上に重ねる）
  if (showInterior) {
    // エディタ仕様: 透明度>0 → 1-solidAlpha で合成 / 透明度0 → 開口部クリップ内に100%
    const _intAlpha = pdcInteriorAlpha(_transparency, solidAlpha);
    intElems.sort((a,b) => b.depth - a.depth); // 遠い要素から描く
    const _hasCable = intElems.some(e => e.type === 'cableChain');

    // 内部要素1個の描画（色・線幅・アルファ規約は共通コア panelDrawCore.js が唯一の正）
    // tctx: レイヤー用オフスクリーン or メインctx（レイヤー不可時のフォールバック）
    const _paintIntElem = (tctx, e, alpha) => {
      if (e.type==='partitionFace') {
        // エディタZバッファ枝と同色・輪郭線なし（共通コアpdcPartitionFaceRGBで着色済み）
        tctx.globalAlpha=alpha; tctx.fillStyle=`rgb(${e.rgb[0]},${e.rgb[1]},${e.rgb[2]})`;
        tctx.beginPath(); tctx.moveTo(e.pts[0].x,e.pts[0].y);
        for (let i=1;i<e.pts.length;i++) tctx.lineTo(e.pts[i].x,e.pts[i].y);
        tctx.closePath(); tctx.fill();
      } else if (e.type==='iconFace') {
        // エディタ静的表示（Zバッファ）と同一 = 塗りのみ・枠線なし
        pdcPaintIconBoxFace(tctx, e, _pdcView, { alpha });
      } else if (e.type==='iconFlat') {
        // エディタ flat アイコンと同一（fill #1D4ED8・白枠1.5px）
        pdcPaintIconFlat(tctx, e.pts, _pdcView, { alpha });
      }
      tctx.globalAlpha = 1;
    };

    // ══════════════════════════════════════════════════════════════
    // レイヤー合成: エディタの「不透明ラスタライズ → 1回だけ合成」を再現する。
    // 要素ごとに globalAlpha を掛けて直描きすると、重なった領域で実効カバレッジが
    // 1-(1-a)^n に累積して3次元図だけ色が濃くなる（半透明時に顕著）。
    // ══════════════════════════════════════════════════════════════
    const _mainCv = ctx.canvas;
    const _xf = (typeof ctx.getTransform === 'function') ? ctx.getTransform() : null;
    // 合成範囲（デバイスピクセル）: 内部要素の外接矩形だけを clear / drawImage する
    let _bx0=Infinity, _by0=Infinity, _bx1=-Infinity, _by1=-Infinity, _maxCableW=0;
    if (_xf) {
      const _acc = (p) => {
        const dx = _xf.a*p.x + _xf.c*p.y + _xf.e, dy = _xf.b*p.x + _xf.d*p.y + _xf.f;
        if (dx<_bx0) _bx0=dx; if (dy<_by0) _by0=dy;
        if (dx>_bx1) _bx1=dx; if (dy>_by1) _by1=dy;
      };
      for (const e of intElems) {
        if (e.type==='cableChain') {
          if (e.style && e.style.outerWidth > _maxCableW) _maxCableW = e.style.outerWidth;
          for (const chain of e.chains) for (const part of chain) for (const p of (part.pts2d||[])) _acc(p);
        } else for (const p of e.pts) _acc(p);
      }
    }
    // 線幅ぶんの余白（配線の外枠は _lw_unit 倍でデバイスpxに乗るため dpr 換算で効く）
    const _mgn = (8 + _maxCableW) * ((window.devicePixelRatio||1));
    const _bx = Math.max(0, Math.floor(_bx0 - _mgn));
    const _by = Math.max(0, Math.floor(_by0 - _mgn));
    const _bw = Math.min(_mainCv ? _mainCv.width  : 0, Math.ceil(_bx1 + _mgn)) - _bx;
    const _bh = Math.min(_mainCv ? _mainCv.height : 0, Math.ceil(_by1 + _mgn)) - _by;
    const _useLayer = !!_xf && !!_mainCv && _mainCv.width > 0 && _bw > 0 && _bh > 0 && intElems.length > 0;

    // layerPaint(tctx)   : alpha=1 でレイヤーに描く
    // fallbackPaint(tctx, a): レイヤーが使えない環境で直接メインctxに描く（実効アルファ a）
    const _composeLayer = (compAlpha, layerPaint, fallbackPaint) => {
      if (!_useLayer) { (fallbackPaint || layerPaint)(ctx, compAlpha); return; }
      const lc = _pde_getLayerCanvas(_mainCv.width, _mainCv.height);
      const lctx = lc.getContext('2d');
      lctx.save();
      lctx.setTransform(1,0,0,1,0,0);
      lctx.globalCompositeOperation = 'source-over'; lctx.globalAlpha = 1;
      lctx.clearRect(_bx, _by, _bw, _bh);
      lctx.restore();
      lctx.save();
      lctx.setTransform(_xf);
      lctx.setLineDash([]); lctx.globalAlpha = 1;
      layerPaint(lctx, 1);
      lctx.restore();
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0); // クリップはデバイス空間に保持されるのでここでも有効
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = compAlpha;
      ctx.drawImage(lc, _bx, _by, _bw, _bh, _bx, _by, _bw, _bh);
      ctx.restore();
    };

    // ══════════════════════════════════════════════════════════════
    // ── 配線レイヤーの隠面処理（2026-08-02: ピクセル単位マスクへ統一）──
    // エディタは配線を専用オフスクリーンに 0.9 で描き、cableVis（仕切り＋アイコンBoxの
    // Zバッファと配線セグメントの補間深度を画素ごとに比較して作るマスク）で裏側を消してから
    // 合成する。3次元図も同じ方式にする（共通コア pdcRasterizeOccluderDepth /
    // pdcBuildCableVisMask が唯一の正）。
    //
    // 旧実装は「遠→近の並びで遮蔽要素を destination-out」する Painter's 近似だった。
    //   欠陥①: 深度テストが無いので、仕切りより手前を通る配線区間まで消えていた
    //   欠陥②: 配線チェーンの代表深度（全点平均）次第で仕切りの destination-out が
    //           配線描画の前後どちらに来るかが変わり、部分遮蔽を表現できなかった
    // ※ flatアイコンはエディタでもZバッファに載らないので遮蔽側に含めない。
    // ══════════════════════════════════════════════════════════════
    // 配線太さのズーム追従係数（共通コア pdcCableWidthFactor が唯一の正）。
    // 盤を縮小しても配線だけ太いまま残らないよう、マスク幅・実描画幅の両方に掛ける。
    const _cableWidthFactor = pdcCableWidthFactor(_pdcView);
    const _occKinds = pdcCableOccluderKinds(iconVisMode);
    // 低解像度マスクの縮小率（ocResLimit で頭打ち。既定512px）
    const _maskCap = Math.max(64, ocResLimit || 512);
    const _ms  = _useLayer ? Math.min(1, _maskCap / Math.max(_bw, _bh, 1)) : 1;
    const _mw  = Math.max(1, Math.ceil(_bw * _ms));
    const _mh  = Math.max(1, Math.ceil(_bh * _ms));
    const _dpr = (window.devicePixelRatio || 1);
    // CAB座標 → マスク座標（デバイスpx基準の外接矩形を _ms 倍したもの）
    const _toMask = (p) => ({
      x: ((_xf.a * p.x + _xf.c * p.y + _xf.e) - _bx) * _ms,
      y: ((_xf.b * p.x + _xf.d * p.y + _xf.f) - _by) * _ms,
      depth: p.depth,
    });

    // 配線マスクを構築して canvas 化（配線が無い/レイヤー不可なら null）
    let _cableMaskCvs = null;
    if (_useLayer && _hasCable) {
      const _wk = _pde_getMaskWork(_mw, _mh);
      // ① 遮蔽側（仕切り・アイコンBox）の深度をラスタライズ
      const _occPolys = [];
      for (const e of intElems) {
        if ((_occKinds.partitions && e.type === 'partitionFace') ||
            (_occKinds.iconBoxes  && e.type === 'iconFace')) {
          _occPolys.push({ pts: e.pts.map(_toMask) });
        }
      }
      pdcRasterizeOccluderDepth(_occPolys, _wk.zb, _mw, _mh, _pdcView.nearSign);
      // ② 配線セグメントを深度テストしながらマスクへ白を書く
      //    線幅係数: CAB座標での配線幅 = outerWidth * _lw_unit
      //    → デバイスpx = outerWidth * _lw_unit * canvasSc = outerWidth * dpr
      //    → マスク座標 = さらに _ms 倍
      const _maskEntries = [];
      for (const r of _cableRoutes) {
        if (!r.pts2d || r.pts2d.length < 2) continue;
        _maskEntries.push({
          pts2d: r.pts2d.map(_toMask),
          outerWidth: pdcCableStyle(r.cable).outerWidth,
        });
      }
      if (_maskEntries.length > 0) {
        pdcBuildCableVisMask(_maskEntries, _wk.zb, _wk.buf, _mw, _mh, _dpr * _ms * _cableWidthFactor, _pdcView.nearSign);
        const _mctx = _wk.cvs.getContext('2d');
        _mctx.putImageData(new ImageData(_wk.buf, _mw, _mh), 0, 0);
        _cableMaskCvs = _wk.cvs;
      }
    }

    const _paintCableLayer = (tctx) => {
      tctx.globalCompositeOperation = 'source-over';
      for (const e of intElems) if (e.type === 'cableChain') {
        pdcPaintCableChains(tctx, e.chains, e.style,
          { widthScale: _lw_unit * _cableWidthFactor, alpha: PDC_CABLE_STROKE_ALPHA });
      }
      // マスクで「仕切り・アイコンBoxより奥の区間」を削る（エディタ L1589 と同じ destination-in）
      if (_cableMaskCvs) {
        tctx.save();
        tctx.setTransform(1, 0, 0, 1, 0, 0); // マスクはデバイスpx空間
        tctx.globalCompositeOperation = 'destination-in';
        tctx.globalAlpha = 1;
        tctx.drawImage(_cableMaskCvs, 0, 0, _mw, _mh, _bx, _by, _bw, _bh);
        tctx.restore();
      }
      tctx.globalCompositeOperation = 'source-over';
    };
    // レイヤー不可時: マスクなしで実効アルファを直接与える（destination-inはメインctxに使えない）
    const _paintCableFallback = (tctx, compAlpha) => {
      for (const e of intElems) if (e.type === 'cableChain')
        pdcPaintCableChains(tctx, e.chains, e.style,
          { widthScale: _lw_unit * _cableWidthFactor, alpha: PDC_CABLE_STROKE_ALPHA * compAlpha });
    };

    if (!_iconOnlyMode) {
      // ═══ 通常モード ═══
      // 層1: 仕切り＋アイコン → レイヤーに alpha=1 で描いて 1回だけ _intAlpha で合成
      // ※ _cableXrayMode で密閉（透明度0・開扉なし）のときは配線のためだけにここへ来ているので
      //   仕切りは描かない（密閉箱が透けて見える回帰を防ぐ）。flatアイコンはエディタが
      //   semi/full で常に描くのに合わせて描く。
      ctx.save();
      if (doorsVisible && _transparency === 0 && _openings.length > 0) _clipToOpenings();
      _composeLayer(_intAlpha, (tctx, a) => {
        for (const e of intElems) {
          if (e.type === 'cableChain') continue;
          if (!_showStructure && e.type === 'partitionFace') continue;
          _paintIntElem(tctx, e, a);
        }
      });
      ctx.restore(); // 開口部クリップ解除
      // 層2: 配線 → エディタ L1669 は globalAlpha=1 で合成（実効 0.9・内部合成アルファは掛からない）
      // X線モード（semi/full）の配線は層5で合成するのでここでは描かない
      if (_hasCable && !_cableXrayMode) {
        ctx.save();
        if (_transparency === 0 && _openings.length > 0) _clipToOpenings();
        _composeLayer(PDC_CABLE_NORMAL_COMPOSITE_ALPHA, _paintCableLayer, _paintCableFallback);
        ctx.restore();
      }
    } else {
      // ═══ X線モード（semi/full）: レイヤー分離 ═══
      // 層1: 仕切り — 透明度に関わらず「開扉の開口部からしか見えない」。
      //      透明度は開口部内の濃さ（_intAlpha）だけに効く。開扉が無ければ一切描かない。
      //      扉非表示時は開口部の概念が無いのでクリップなしで仕切り全体を表示（エディタと同一）。
      if (!doorsVisible) {
        _composeLayer(_intAlpha, (tctx, a) => {
          for (const e of intElems) if (e.type === 'partitionFace') _paintIntElem(tctx, e, a);
        });
      } else if (_openings.length > 0) {
        ctx.save();
        _clipToOpenings();
        _composeLayer(_intAlpha, (tctx, a) => {
          for (const e of intElems) if (e.type === 'partitionFace') _paintIntElem(tctx, e, a);
        });
        ctx.restore();
      }
      // 層2/層3（外箱ワイヤーフレーム・扉・開口部）はこの直後の共通処理が担当。
      // 層4（アイコン最上層）・層5（配線最上層）は扉描画の後に実行する。
      _xrayIconElems    = intElems.filter(e => e.type === 'iconFace' || e.type === 'iconFlat');
      _xrayComposeLayer = _composeLayer;
      _xrayPaintElem    = _paintIntElem;
    }
    // 配線のX線層（層5）は box icon の有無を問わず semi/full なら必ず予約する。
    // → 配線の見た目が iconDisplayMode(box/flat) に依存しない
    if (_cableXrayMode) {
      _xrayComposeLayer = _composeLayer;
      _xrayPaintElem    = _paintIntElem;
      _xrayHasCable     = _hasCable;
      _xrayCablePaint   = _paintCableLayer;
      _xrayCableFb      = _paintCableFallback;
    }

    // ── Step 2b相当: 仕切り面エッジ（深度マスク付き）── ※エディタと同じくレイヤー合成の“後”
    // エディタ同様、エッジ自体は edgeAlpha で合成する（内部合成アルファは掛けない）。
    // ゲート条件・開口部クリップはエディタ Step 2b と同一。
    // ※ この位置（showInterior ブロック内末尾）にあるのは、マスク構築に必要な
    //   _composeLayer / _toMask / _mw / _mh / _useLayer / _dpr / intElems 等が
    //   このブロック内でしか定義されていないため。実行条件は従来と同じ。
    if (_screenPanelW >= INTERIOR_THRESHOLD_PX) {
      const _edgeGate = _iconOnlyMode ? (!doorsVisible || _openings.length > 0)
                                      : (_transparency > 0 || _openings.length > 0 || !doorsVisible);
      const _edgeClip = _iconOnlyMode ? (doorsVisible && _openings.length > 0)
                                      : (_transparency === 0 && doorsVisible);
      if (_edgeGate) {
        const _edgeAlpha = pdcPartitionEdgeAlpha(_transparency, solidAlpha);
        let _edgeMaskCvs = null;
        if (_useLayer) {
          const _edgeSegsCab = pdcCollectPartitionEdgeSegments(_solids, _pdcView);
          if (_edgeSegsCab.length > 0) {
            const _ew = _pde_getEdgeMaskWork(_mw, _mh);
            const _edgeOccPolys = [];
            for (const e of intElems) {
              if (e.type === 'partitionFace') _edgeOccPolys.push({ pts: e.pts.map(_toMask) });
            }
            pdcRasterizeOccluderDepth(_edgeOccPolys, _ew.occZb, _mw, _mh, _pdcView.nearSign);
            const _edgeSegsM = _edgeSegsCab.map(s => {
              const a = _toMask({ x: s.x0, y: s.y0, depth: s.d0 });
              const b = _toMask({ x: s.x1, y: s.y1, depth: s.d1 });
              return { x0: a.x, y0: a.y, d0: a.depth, x1: b.x, y1: b.y, d1: b.depth };
            });
            pdcBuildPartitionEdgeVisMask(
              _edgeSegsM, _ew.occZb, _ew.zb, _ew.buf, _mw, _mh, _dpr * _ms, _pdcView.nearSign,
              PDC_PARTITION_EDGE_DEPTH_BIAS_MM * _pdcView.depthPerMm);
            _ew.cvs.getContext('2d').putImageData(new ImageData(_ew.buf, _mw, _mh), 0, 0);
            _edgeMaskCvs = _ew.cvs;
          }
        }
        ctx.save();
        if (_edgeClip && _openings.length > 0) _clipToOpenings();
        if (_edgeMaskCvs) {
          _composeLayer(_edgeAlpha, (tctx) => {
            pdcPaintPartitionEdges(tctx, _solids, _pdcView, 1);
            tctx.save();
            tctx.setTransform(1, 0, 0, 1, 0, 0);
            tctx.globalCompositeOperation = 'destination-in';
            tctx.globalAlpha = 1;
            tctx.drawImage(_edgeMaskCvs, 0, 0, _mw, _mh, _bx, _by, _bw, _bh);
            tctx.restore();
            tctx.globalCompositeOperation = 'source-over';
          }, (tctx, a) => pdcPaintPartitionEdges(tctx, _solids, _pdcView, a));
        } else {
          pdcPaintPartitionEdges(ctx, _solids, _pdcView, _edgeAlpha);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ── 外箱ワイヤーフレーム・扉・開口部（panelDrawCore.js 共通コア）── ※X線モードの層3
  pdcPaintOuterWireframe(ctx, panel, _pdcView, _transparency);
  if (doorsVisible) {
    const { doorRenderList } = pdcCollectDoors(panel, _pdcView);
    if (_transparency === 0) pdcPaintDoorsOpaquePainter(ctx, doorRenderList, panel.color, _pdcView);
    else pdcPaintDoorsTranslucent(ctx, doorRenderList, panel.color, solidAlpha, _pdcView);
    pdcPaintDoorOpenings(ctx, panel, _pdcView);
  }

  // ── X線モード 層4→層5: アイコンBox → 配線 を扉の上に重ねる（エディタ L2144〜と同順）──
  // アイコン: レイヤーに alpha=1 → PDC_ICONONLY_COMPOSITE_ALPHA(0.6) で1回だけ合成
  // 配線   : レイヤーに stroke 0.9 → PDC_CABLE_COMPOSITE_ALPHA(0.45) で合成（実効0.405）
  if (_xrayComposeLayer) {
    if (_xrayIconElems.length > 0) {
      _xrayComposeLayer(PDC_ICONONLY_COMPOSITE_ALPHA, (tctx, a) => {
        for (const e of _xrayIconElems) _xrayPaintElem(tctx, e, a);
      });
    }
    if (_xrayHasCable) {
      _xrayComposeLayer(PDC_CABLE_COMPOSITE_ALPHA, _xrayCablePaint, _xrayCableFb);
    }
  }

  // アイコンラベル（全要素描画後）— 書体・色・文字数は共通コアが唯一の正
  if (showInterior) {
    const _panelDispModeL = panel.iconDisplayMode || 'flat';
    for (const icon of (panel.placedIcons||[])) {
      const iMode = (icon.iconDisplayMode === 'flat'||icon.iconDisplayMode === 'box'||icon.iconDisplayMode === 'hidden')
        ? icon.iconDisplayMode : _panelDispModeL;
      if (iMode === 'hidden') continue;
      const _lcb = icon.cellBox;
      const _lx = icon.wx ?? (_lcb ? (_lcb.xMin+_lcb.xMax)/2 : W/2);
      const _ly = icon.wy ?? (_lcb ? (_lcb.yMin+_lcb.yMax)/2 : D/2);
      const _lz = icon.wz ?? (_lcb ? (_lcb.zMin+_lcb.zMax)/2 : H/2);
      pdcPaintIconLabel(ctx, proj(_lx, _ly, _lz), pdcIconLabelText(icon), _pdcView);
    }
  }

  ctx.restore();
}

console.warn('[DEBUG] floating-three-view_3Dmap.jsx loaded at', new Date().toISOString());
// 全てのエラーを追跡
window.addEventListener('error', (ev) => {
  console.error('[GLOBAL_ERROR]', { msg: ev.message, line: ev.lineno, col: ev.colno, file: ev.filename, stack: ev.error?.stack });
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[GLOBAL_REJECTION]', { reason: ev.reason?.message || ev.reason, stack: ev.reason?.stack });
});
// console.errorも捕捉（Reactのrender errorはconsole.errorで出る）
const _origErr = console.error;
console.error = function(...args) {
  if (args[0] && typeof args[0] === 'string' && (args[0].includes("reading 'x'") || args[0].includes('Cannot read'))) {
    _origErr('[REACT_ERROR_CAPTURE]', ...args);
    _origErr('[REACT_STACK]', new Error().stack);
  }
  return _origErr.apply(console, args);
};

// ── 変化した要素のみ再レンダリング（stateKeyが同じなら renderFn() を呼ばない）──
const _MemoEl = React.memo(({ renderFn }) => renderFn(), (a, b) => a.stateKey === b.stateKey);

// ── ドラッグ中 midpoint circle を全ビューで更新する共通ヘルパー ──
// plan/elev/side は getElementById、cab は querySelectorAll（重複ID対策）
function _updateAllViewCircles(segId, path, mpp, camAz, camEl, camZoom, camPanX, camPanY) {
  if (!path || path.length < 2) return;
  const _applyCircles = (el, cxFn, cyFn) => {
    if (!el) return;
    const cs = Array.from(el.querySelectorAll('circle'));
    if (!cs.length) return;
    let ci = 0;
    for (let si = 0; si < path.length - 1 && ci < cs.length; si++) {
      const pa = path[si], pb = path[si + 1];
      const cx = cxFn(pa, pb), cy = cyFn(pa, pb);
      if (cs[ci]) { cs[ci].setAttribute('cx', cx); cs[ci].setAttribute('cy', cy); ci++; }
      if (cs[ci]) { cs[ci].setAttribute('cx', cx); cs[ci].setAttribute('cy', cy); ci++; }
    }
  };
  _applyCircles(document.getElementById('pw-' + segId), (a, b) => (a.x+b.x)/2, (a, b) => (a.y+b.y)/2);
  _applyCircles(document.getElementById('ew-' + segId), (a, b) => (a.x+b.x)/2, (a, b) => GL_Y - ((a.z||0)+(b.z||0))/2);
  _applyCircles(document.getElementById('sw-' + segId), (a, b) => (a.y+b.y)/2, (a, b) => GL_Y - ((a.z||0)+(b.z||0))/2);
  // cab: cabSortedSegsレイヤー(circles無し)とrenderSegsレイヤー(circles有り)の2つが同IDで存在
  Array.from(document.querySelectorAll('#cw-' + segId)).forEach(cwEl => {
    const cs = Array.from(cwEl.querySelectorAll('circle'));
    if (!cs.length) return;
    let ci = 0;
    for (let si = 0; si < path.length - 1 && ci < cs.length; si++) {
      const pa = path[si], pb = path[si + 1];
      const mx = (pa.x+pb.x)/2, my = (pa.y+pb.y)/2, mz = ((pa.z||0)+(pb.z||0))/2;
      const pr = project3D(mx, my, mz * mpp, camAz, camEl, camZoom, camPanX, camPanY);
      if (cs[ci]) { cs[ci].setAttribute('cx', pr.x); cs[ci].setAttribute('cy', pr.y); ci++; }
      if (cs[ci]) { cs[ci].setAttribute('cx', pr.x); cs[ci].setAttribute('cy', pr.y); ci++; }
    }
  });
}

window.App = function App() {
  const [nodes, setNodes] = useState(initNodes);
  const [segs] = useState(initSegs);
  const [currentSSE, setCurrentSSE] = useState(null); // 3DタイルSSE表示用
  const [mapPos, setMapPos] = useState({});
  const [mapZ, setMapZ] = useState({});
  const [terrainRaw, setTerrainRaw] = useState(null);
  const [terrain, setTerrain] = useState(null);
  const [terrainExag, setTerrainExag] = useState(3); // 標高強調倍率
  const [onSegT, setOnSegT] = useState(() => { const m = {}; initNodes.filter(n => n.kind === "on_seg").forEach(n => m[n.id] = n.t); return m; });
  const [segWp, setSegWp] = useState({});
  const [wpZ, setWpZ] = useState({});       // セグメント折れ点のZ値
  // 建屋データ（複数ブロック対応）
  const [buildings, setBuildings] = useState(INIT_BUILDINGS);
  const bldCounter = useRef(INIT_BUILDINGS.length);
  const [siteBaseElev, setSiteBaseElev] = useState(null); // 3Dビューから取得した地表標高
  const flatBlocks = useMemo(() => flattenBuildings(buildings), [buildings]);
  // 面ベースソリッドモデル: state管理。buildings変更時に再生成、pushpull時に直接更新
  const [solids, setSolids] = useState(() => buildingsToSolids(INIT_BUILDINGS));
  const solidsRef = useRef(solids);
  solidsRef.current = solids;
  // pushPullRect直接更新時: buildingsが変わるまで同期をブロック
  const _solidSyncBlockedForRef = useRef(null); // ブロック中のbuildings参照
  const _prevBuildingsRef = useRef(buildings);
  useEffect(() => {
    if (_solidSyncBlockedForRef.current === buildings) return; // ブロック中
    if (ppDragRef.current) return; // pushpullドラッグ中はsolids再生成禁止
    if (_prevBuildingsRef.current !== buildings) {
      const prevBuildings = _prevBuildingsRef.current;
      console.warn('[SOLID_SYNC] buildings変更検出 → solids再生成', { blocked: false, bldCount: buildings?.length });
      _prevBuildingsRef.current = buildings;
      _solidSyncBlockedForRef.current = null;

      // 削り出し済みSolid (face数 > 期待値) は再生成せずzTop/zBottomデルタだけ適用
      // face.holesは廃止 — 全面が単純クローズドポリゴンとして定義される
      const _isModified = (solid, blk) => {
        if (!solid || !blk?.points) return false;
        const expected = blk.points.length + 2;
        return solid.faces.length !== expected;
      };
      const _applyZDelta = (solid, oldZT, newZT, oldZB, newZB) => {
        const Z_TOL = 0.05;
        const _xform = (v) => {
          if (Math.abs(v.z - oldZT) < Z_TOL) return { ...v, z: newZT };
          if (Math.abs(v.z - oldZB) < Z_TOL) return { ...v, z: newZB };
          return { ...v };
        };
        const newFaces = solid.faces.map(f => ({
          ...f,
          vertices: f.vertices.map(_xform),
          ...(f.holes ? { holes: f.holes.map(hole => hole.map(_xform)) } : {}),
        }));
        return { ...solid, faces: newFaces };
      };

      const newSolids = [];
      buildings.forEach(bld => {
        bld.blocks.forEach((blk, bi) => {
          const expectedId = bld.id + '_' + bi;
          const existing = solidsRef.current.find(s => s.id === expectedId);
          const prevBlk = prevBuildings?.find(b => b.id === bld.id)?.blocks?.[bi];
          if (existing && prevBlk && _isModified(existing, blk)) {
            const oldZT = prevBlk.zTop != null ? prevBlk.zTop : 40;
            const newZT = blk.zTop != null ? blk.zTop : 40;
            const oldZB = prevBlk.zBottom || 0;
            const newZB = blk.zBottom || 0;
            if (Math.abs(oldZT - newZT) > 1e-4 || Math.abs(oldZB - newZB) > 1e-4) {
              console.warn('[SOLID_SYNC] 削り出し済みSolid保持 → zデルタ適用', {
                solidId: existing.id, oldZT, newZT, oldZB, newZB, faceCount: existing.faces.length,
              });
              newSolids.push(_applyZDelta(existing, oldZT, newZT, oldZB, newZB));
            } else {
              // z変更なし → そのまま保持
              newSolids.push(existing);
            }
          } else {
            // 新規 or 単純箱: 通常通り再生成
            const s = blockToSolid(bld.id, bi, bld.label, bld.color, blk.points, blk.zBottom || 0, blk.zTop != null ? blk.zTop : 40);
            if (s) newSolids.push(_normalizeOutward(s));
          }
        });
      });
      setSolids(newSolids);
    }
  });
  // CesiumMapから呼べるSolid直接更新関数（buildings同期をブロックする）
  const setSolidsDirect = useCallback((newSolids) => {
    _solidSyncBlockedForRef.current = buildings;
    setSolids(newSolids);
  }, [buildings]);

  // === 建物undo/redo ===
  // mousedown〜mouseupを1操作としてカウント。ドラッグ中の連続setBuildings→1undo
  const bldUndoRef = useRef([]);
  const bldRedoRef = useRef([]);
  const bldPrevRef = useRef(buildings);
  const bldSnapRef = useRef(null);
  const bldTimerRef = useRef(null);
  const bldIsUndoRedoRef = useRef(false);
  const bldMouseUpRef = useRef(null);   // mouseupリスナー解除用
  const buildingsRef = useRef(buildings);
  buildingsRef.current = buildings;

  // undo/redoエントリ: { bld: buildings[], sol: solids[]|null }
  // sol=null → buildings復元時にsolidsを自動再生成, sol有り → solidsも復元
  const _undoLog = (tag, extra) => {
    const _entryInfo = (e) => e?.bld ? `${e.bld.length}bld${e.sol ? '+sol' : ''}` : `${e?.length}(legacy)`;
    console.warn(`[UNDO_${tag}]`, {
      ...extra,
      undoStack: bldUndoRef.current.map(_entryInfo),
      redoStack: bldRedoRef.current.map(_entryInfo),
      current: buildingsRef.current?.length,
    });
  };
  const _makeEntry = (bld, sol) => ({ bld: JSON.parse(JSON.stringify(bld)), sol: sol ? JSON.parse(JSON.stringify(sol)) : null });
  const _restoreEntry = (entry) => {
    // legacy形式(配列)とnew形式({bld,sol})の両方に対応
    if (Array.isArray(entry)) return { bld: entry, sol: null };
    return entry;
  };
  const bldCommitSnap = useCallback(() => {
    if (bldSnapRef.current !== null) {
      bldUndoRef.current.push(bldSnapRef.current);
      if (bldUndoRef.current.length > 100) bldUndoRef.current.shift();
      bldSnapRef.current = null;
    }
    if (bldMouseUpRef.current) {
      window.removeEventListener('mouseup', bldMouseUpRef.current);
      bldMouseUpRef.current = null;
    }
    clearTimeout(bldTimerRef.current);
  }, []);

  useEffect(() => {
    const prev = bldPrevRef.current;
    bldPrevRef.current = buildings;
    if (bldIsUndoRedoRef.current) {
      bldIsUndoRedoRef.current = false;
      bldSnapRef.current = null;
      return;
    }
    if (prev === buildings) return;
    // バースト最初の変更: 変更前の状態を保存（solidsも含む → undoで完全復元）
    if (bldSnapRef.current === null) {
      bldSnapRef.current = _makeEntry(prev, solidsRef.current);
      const onUp = () => {
        bldMouseUpRef.current = null;
        bldTimerRef.current = setTimeout(() => bldCommitSnap(), 50);
      };
      bldMouseUpRef.current = onUp;
      window.addEventListener('mouseup', onUp, { once: true });
      clearTimeout(bldTimerRef.current);
      bldTimerRef.current = setTimeout(() => bldCommitSnap(), 200);
    } else {
      clearTimeout(bldTimerRef.current);
      bldTimerRef.current = setTimeout(() => bldCommitSnap(), 200);
    }
    bldRedoRef.current = [];
  }, [buildings, bldCommitSnap]);

  const bldUndo = useCallback(() => {
    bldCommitSnap();
    if (bldUndoRef.current.length === 0) { _undoLog('UNDO_EMPTY', {}); return; }
    const raw = bldUndoRef.current.pop();
    const entry = _restoreEntry(raw);
    // 現在の状態（solids含む）をredoに保存
    bldRedoRef.current.push(_makeEntry(buildingsRef.current, solidsRef.current));
    _undoLog('UNDO', { restored: `${entry.bld.length}bld${entry.sol ? '+sol' : ''}` });
    bldIsUndoRedoRef.current = true;
    _solidSyncBlockedForRef.current = null;
    setBuildings(entry.bld);
    if (entry.sol) {
      // solidsも復元 → SOLID_SYNCの再生成を防ぐ
      _solidSyncBlockedForRef.current = entry.bld;
      _prevBuildingsRef.current = entry.bld;
      setSolids(entry.sol);
    }
  }, [bldCommitSnap]);

  const bldRedo = useCallback(() => {
    bldCommitSnap();
    if (bldRedoRef.current.length === 0) { _undoLog('REDO_EMPTY', {}); return; }
    const raw = bldRedoRef.current.pop();
    const entry = _restoreEntry(raw);
    // 現在の状態（solids含む）をundoに保存
    bldUndoRef.current.push(_makeEntry(buildingsRef.current, solidsRef.current));
    _undoLog('REDO', { restored: `${entry.bld.length}bld${entry.sol ? '+sol' : ''}` });
    bldIsUndoRedoRef.current = true;
    _solidSyncBlockedForRef.current = null;
    setBuildings(entry.bld);
    if (entry.sol) {
      _solidSyncBlockedForRef.current = entry.bld;
      _prevBuildingsRef.current = entry.bld;
      setSolids(entry.sol);
    }
  }, [bldCommitSnap]);

  // 削り出し等の操作前にundo snapshotを明示的に保存する関数（solids付き）
  const bldPushUndo = useCallback(() => {
    bldCommitSnap();
    bldUndoRef.current.push(_makeEntry(buildingsRef.current, solidsRef.current));
    if (bldUndoRef.current.length > 100) bldUndoRef.current.shift();
    bldRedoRef.current = [];
    _undoLog('PUSH_CARVE', {});
  }, [bldCommitSnap]);

  // Ctrl+Z / Ctrl+Y: 建物undo/redo（親で一元管理、CesiumMap2インスタンスからの2重発火を防止）
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); bldUndo(); }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); bldRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bldUndo, bldRedo]);

  // 建屋エディタ状態
  const [cab3dArrow, setCab3dArrow] = useState(null); // 3次元図 法線矢印: {cx,cy,cz,nx,ny,nz,color,buildingId,faceId}
  const [ppDrag, setPPDrag] = useState(null); // pushpullドラッグ: {faceId,solidId,nx,ny,nz,cx,cy,cz,startClientX,startClientY,startSolid,svgPerUnit}
  const ppDragRef = useRef(null); // ppDragのref版（stale closure回避）
  const cab3dAnimCancelRef = useRef(null); // 3次元図ダブルクリックアニメーション中断用
  const focusAnimCancelRef = useRef(null); // カメラアイコンフォーカスアニメーション中断用
  const secFocusAnimCancelRef = useRef(null); // 矢視図フォーカスアニメーション中断用
  const [cabSecMode, setCabSecMode] = useState(false); // 3次元図での矢視図追加モード
  const cabSecModeRef = useRef(false); cabSecModeRef.current = cabSecMode;
  const [bldEditMode, setBldEditMode] = useState(false);
  const [hovBldId, setHovBldId] = useState(null); // hover building ID (non-edit mode)
  const [hovBldView, setHovBldView] = useState(null); // hover building のビューID（'plan'|'elev'|'side'|sec.id）
  const [hovNodeView, setHovNodeView] = useState(null); // hover node のビューID（'plan'|'elev'|'side'|'cab'|sec.id）
  const [selectedBldView, setSelectedBldView] = useState(null); // 建屋選択したビューID（'plan'|'elev'|'side'|sec.id）
  const [bldDraw, setBldDraw] = useState(null); // { startX, startY, curX, curY } (pixel coords for rect mode)
  const [selectedBld, setSelectedBld] = useState(null); // building id
  const [bldDrawMode, setBldDrawMode] = useState('rect'); // 'rect' | 'poly'
  const [polyPoints, setPolyPoints] = useState([]); // points being drawn in polygon mode
  const [polyMousePos, setPolyMousePos] = useState(null); // current mouse pos during polygon drawing
  const [bldDrawView, setBldDrawView] = useState('plan'); // which view draws
  const [bldAction, setBldAction] = useState(null); // {type:'move'|'resize', bid, bi, ...}

  const [hoverId, setHoverId] = useState(null);
  const [hoverSeg, setHoverSeg] = useState(null);
  const [jsCursorElev, setJsCursorElev] = useState(null); // JS判定カーソル(断面図)
  const [jsCursorSide, setJsCursorSide] = useState(null); // JS判定カーソル(側面図)
  const [jsHitDebug, setJsHitDebug] = useState(null); // {svgX,svgY,svgR,type:'fold'|'mid',view:'elev'|'side'}
  const [wireTip, setWireTip] = useState(null); // {x, y, dist} wireホバー時の距離表示
  const [wireTipLabels, setWireTipLabels] = useState([]); // [{x, y, text}] ドラッグ中セグメント距離
  // デバウンス付き hover更新（100ms）: 高速hover切り替えによる連続レンダリングを防ぐ
  const _hoverIdDebounceRef  = useRef(null);
  const _hoverSegDebounceRef = useRef(null);
  const wpDragActiveRef = useRef(false); // wpDrag/wpDragCab中はdebounceでhoverSegを再セットしない
  const setHoverIdDebounced = (id) => {
    clearTimeout(_hoverIdDebounceRef.current);
    // drag中にtimerが発火してReactが再描画→circleが旧座標に上書きされるのを防ぐ
    _hoverIdDebounceRef.current = setTimeout(() => { if (!iconDragging.current) setHoverId(id); }, 100);
  };
  const setHoverSegDebounced = (id, tip) => {
    clearTimeout(_hoverSegDebounceRef.current);
    _hoverSegDebounceRef.current = setTimeout(() => {
      if (!iconDragging.current && !wpDragActiveRef.current) { setHoverSeg(id); if (tip !== undefined) setWireTip(tip); }
    }, 100);
  };
  const [wpDrag, setWpDrag] = useState(null);
  const [wpDragCab, setWpDragCab] = useState(null); // 3次元図での折れ点ドラッグ
  useEffect(() => { wpDragActiveRef.current = !!(wpDrag || wpDragCab); }, [wpDrag, wpDragCab]);
  useEffect(() => { console.log('[WP_STATE] wpDrag=', JSON.stringify(wpDrag), 'wpDragCab=', JSON.stringify(wpDragCab)); }, [wpDrag, wpDragCab]);
  // ===== バッジ外クリックでバッジを閉じる =====
  useEffect(() => {
    let _downTarget = null;
    let _didMove = false;
    const onDown = (ev) => {
      if (hSecDragRef.current) return;
      _downTarget = ev.target;
      _didMove = false;
    };
    const onMove = () => { _didMove = true; };
    const onUp = (ev) => {
      if (hSecDragRef.current) return;
      if (_didMove) return; // ドラッグ（mousemoveあり）は閉じない
      if (!_downTarget) return;
      if (hSecBadgeRef.current && !hSecBadgeRef.current.contains(_downTarget)) {
        setHSecActiveDim(null);
        setHSecEditDim(null);
      }
      _downTarget = null;
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
  }, []);

  // ===== 管理表リアルタイムハイライト =====
  useEffect(() => {
    let _didMove = false;
    const winIdToRow = (winId) => {
      if (!winId) return null;
      if (winId === '__hSecInd') return 'hSecInd';
      if (winId === 'plan') return 'plan';
      if (winId === 'elev') return 'elev';
      if (winId === 'side') return 'side';
      if (winId === 'cab') return 'cab';
      if (winId === 'admin') return null;
      if (winId === 'diag') return 'diag';
      if (winId.startsWith('hSec')) return 'hSecDrag';
      return 'sec';
    };
    const onDown = (e) => {
      _didMove = false;
      if (e.target.getAttribute?.('data-hsecindicatorhit')) {
        _adminMouseWinRef.current = '__hSecInd';
      } else {
        const fw = e.target.closest?.('[data-floatwinid]');
        _adminMouseWinRef.current = fw?.dataset.floatwinid ?? null;
      }
      const row = winIdToRow(_adminMouseWinRef.current);
      if (row) setAdminHighlight({ row, phase: 'down' });
      else setAdminHighlight(null);
    };
    const onMove = (e) => {
      if (!_adminMouseWinRef.current) return;
      if (_didMove) return;
      _didMove = true;
      const row = winIdToRow(_adminMouseWinRef.current);
      if (row) setAdminHighlight({ row, phase: 'move' });
    };
    const onUp = () => {
      if (!_adminMouseWinRef.current) return;
      const row = winIdToRow(_adminMouseWinRef.current);
      if (row) setAdminHighlight({ row, phase: 'up' });
    };
    const onScroll = () => { setAdminHighlight(null); _adminMouseWinRef.current = null; };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const [camDrag, setCamDrag] = useState(null);
  const [gizmoTarget, setGizmoTarget] = useState(null);
  const [axisDrag, setAxisDrag] = useState(null);
  const axisDragDbgRef = useRef(null); // {_pnR, delta, _dx, _dy} デバッグ用最終値

  // ルートフィルタ（右クリックで接続ルートのみ表示）
  const [routeFilter, setRouteFilter] = useState(null); // nodeId or null
  const routeSegs = useMemo(() => {
    if (!routeFilter) return null;
    // BFS/DFSで接続されたセグメントを収集
    const visited = new Set(), segIds = new Set(), queue = [routeFilter];
    while (queue.length > 0) {
      const nid = queue.shift();
      if (visited.has(nid)) continue;
      visited.add(nid);
      segs.forEach(s => {
        if (s.from === nid || s.to === nid) {
          segIds.add(s.id);
          if (!visited.has(s.from)) queue.push(s.from);
          if (!visited.has(s.to)) queue.push(s.to);
        }
      });
    }
    return { nodeIds: visited, segIds };
  }, [routeFilter, segs]);

  // 3D直交作図モード
  const [drawMode, setDrawMode] = useState(false);
  const [drawState, setDrawState] = useState(null); // { sid, lastPos:{x,y,z} }
  const drawClickRef = useRef(null); // { x, y } mousedown位置（クリック判定用）

  // 範囲選択
  const [selected, setSelected] = useState(new Set());
  const [selRect, setSelRect] = useState(null);
  const selRectRef = useRef(null); // selRectの最新値（グローバルmouseupハンドラ用）
  useEffect(() => { selRectRef.current = selRect; }, [selRect]);

  // 単線結線図の動的サイズ（ノードが見切れないよう自動拡張）
  const diagW = useMemo(() => Math.max(220, Math.max(0, ...nodes.map(n => n.dPos.x)) + 25), [nodes]);
  const diagH = useMemo(() => Math.max(380, Math.max(0, ...nodes.map(n => n.dPos.y)) + 25), [nodes]);
  const diagWRef = useRef(220);
  const diagHRef = useRef(380);
  useEffect(() => { diagWRef.current = diagW; diagHRef.current = diagH; }, [diagW, diagH]);
  const nodesRef = useRef(nodes); // selRect確定時の最新ノード参照
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // Cesium 3D 画質設定
  const [cesiumQuality, setCesiumQuality] = useState({
    resolutionScale: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    sse: 8, msaa: 4, skipLOD: false, skyAtmosphere: false, sseManual: false, satelliteAlpha: 1.0,
    nearClipDist: 0, undergroundGrid: true, undergroundGridColor: '#FFFFFF', undergroundColor: '#000000', undergroundDepth: 10, ugWireHighlight: false,
    scroll2D: false,
    scrollLowQ: false,
    scrollLowQScale: 0.75,
    scrollLowQMaxAlt: 1000,
  });
  const [cesium3dGearOpen, setCesium3dGearOpen] = useState(false);
  const [cesium3dLoaded, setCesium3dLoaded] = useState(false);
  const [cesium2dLoaded, setCesium2dLoaded] = useState(false);
  const [cabGearOpen, setCabGearOpen] = useState(false);
  const [panelDragQuality, setPanelDragQuality] = useState(50);  // ドラッグ中OC品質 0-100%
  const [panelRestoreDelay, setPanelRestoreDelay] = useState(50); // 静止後に戻るまでの時間 ms
  // 地下床色ヘルパー（cesiumQuality.undergroundColor → rgba）
  const _ugFloor = cesiumQuality.undergroundColor ?? '#000000';
  const _ugC = (a) => { const r=parseInt(_ugFloor.slice(1,3),16)||0,g=parseInt(_ugFloor.slice(3,5),16)||0,b=parseInt(_ugFloor.slice(5,7),16)||0; return `rgba(${r},${g},${b},${a})`; };

  // 矢視
  const [sections, setSections] = useState([]); // [{ id, p1:{x,y}, p2:{x,y}, depth:150 }]
  const [secDrawing, setSecDrawing] = useState(null); // { p1:{x,y} } 描画中
  const [secMode, setSecMode] = useState(false); // 矢視描画モード
  const secCounter = useRef(0);
  const secRefs = useRef({});       // {secId: {el, fn}} — ホイールハンドラ管理
  const secCeilRef = useRef({});    // {secId: maxZ} — アイコンドラッグ到達ハイウォーターマーク
  const [secZooms, setSecZooms] = useState({}); // {secId: zoomValue}
  // 水平断面（高さごとの平面図）
  const [hSections, setHSections] = useState([]); // [{id, zPx, label}]
  const [hSecMode, setHSecMode] = useState(null); // null|'elev'|'side'|secId
  const hSecCounter = useRef(0);
  const hSectionsRef = useRef([]); // ドラッグ中クロージャからアクセス用
  const [hSecZooms, setHSecZooms] = useState({}); // {hSecId: zoomValue}
  const hSecZoomsRef = useRef({}); // ドラッグ中クロージャ用
  const hSecConRefs = useRef({}); // {hSecId: containerEl} アイコンドラッグ座標変換用
  const hSecScrollRefs = useRef({}); // {hSecId: scrollEl} 初期スクロール用
  // メニューバー開閉状態
  const [openMenu, setOpenMenu] = useState(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!openMenu) return;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenu(null); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  // 配電盤 配置 — useEffectより先に宣言必須（依存配列のTDZ回避）
  const [placedPanels, setPlacedPanels] = useState([]);
  // 配置盤Ref（useEffect closure の stale 防止。オービットpivotのレイキャストで参照する）
  const placedPanelsRef = useRef(placedPanels); placedPanelsRef.current = placedPanels;
  const [draggingPanel, setDraggingPanel] = useState(null);
  const draggingPanelRef = useRef(null);
  const [selectedPlacedPanelId, setSelectedPlacedPanelId] = useState(null);
  const [panelDetailOpen, setPanelDetailOpen] = useState(false);   // 制限UIパネル表示フラグ
  const [panelDetailOffset, setPanelDetailOffset] = useState({x:0, y:0}); // 制限UIパネルのドラッグオフセット
  const panelDetailDragRef = useRef(null); // {startMouseX, startMouseY, startOffX, startOffY}
  const [selectedDoorKey, setSelectedDoorKey] = useState(null);    // 'ppId_doorIdx' | null
  const [panelRotDrag, setPanelRotDrag] = useState(null); // {id, screenCx, screenCy, startAngle, startRot}
  const panelRotDragActiveRef = useRef(false); // nativeイベント抑制用
  // 配電盤 XY移動ドラッグ
  const [panelMoveDrag, setPanelMoveDrag] = useState(null);
  // {id, startClientX, startClientY, groundX0, groundY0, startWx, startWy}
  const panelMoveMovedRef = useRef(false); // 5px超えたか。ドラッグ後のclick(選択トグル)抑制用
  // 配電盤 名称ラベル移動ドラッグ（盤本体wx/wyは動かさず labelOffset だけを変える。盤移動とは完全に別系統）
  const [labelMoveDrag, setLabelMoveDrag] = useState(null);
  // {id, startClientX, startClientY, startSvgX, startSvgY, startDx, startDy}
  const labelMoveMovedRef = useRef(false);
  const labelMoveDragActiveRef = useRef(false); // nativeタッチ/マウスハンドラ用（panelMoveDragActiveRefの鏡像）
  // client座標 → CAB SVG座標（viewBox 0 0 CAB_W CAB_H / preserveAspectRatio="xMidYMid meet" 前提）
  const _clientToCabSvg = (clientX, clientY) => {
    const cab = cabRef.current; if (!cab) return null;
    const r = cab.getBoundingClientRect();
    const sc = Math.min(r.width / CAB_W, r.height / CAB_H);
    return { x: (clientX - r.left - (r.width - CAB_W * sc) / 2) / sc,
             y: (clientY - r.top  - (r.height - CAB_H * sc) / 2) / sc };
  };
  // 配電盤 XY移動ドラッグ中フラグ（nativeタッチハンドラ用。iconDraggingと同じref方式 —
  // タッチuseEffectの依存配列にpanelMoveDragが無くstate参照はstaleになるため）
  const panelMoveDragActiveRef = useRef(false);
  // 配電盤 XY移動ドラッグ開始 共通コア（マウス・タッチの両ラッパーから呼ぶ）
  const _beginPanelMoveDrag = (clientX, clientY, pp) => {
    panelMoveMovedRef.current = false;
    const p = _clientToCabSvg(clientX, clientY); if (!p) return;
    const g = cabScreenToGroundPoint(p.x, p.y, camAzRef.current, camElRef.current,
      camZoomRef.current, camPanXRef.current, camPanYRef.current);
    if (!isFinite(g.x) || !isFinite(g.y)) return;
    panelMoveDragActiveRef.current = true;
    setPanelMoveDrag({ id: pp.id, startClientX: clientX, startClientY: clientY,
      groundX0: g.x, groundY0: g.y, startWx: pp.wx, startWy: pp.wy });
  };
  // マウス用（天頂面ヒットpolygon・盤名称rect/textから呼ぶ）
  const _startPanelMoveDrag = (e, pp) => {
    if (e.button !== 0) return;   // 中ボタンorbitは奪わない
    e.stopPropagation();
    _beginPanelMoveDrag(e.clientX, e.clientY, pp);
  };
  // タッチ用（e.buttonが存在しないため別ラッパー。preventDefaultは呼ばない —
  // タップ後のclick合成を殺さないため。スクロール抑止は要素のtouchAction:'none'と
  // 移動useEffect側のtouchmove preventDefaultが担う）
  const _startPanelMoveDragTouch = (e, pp) => {
    if (!e.touches || e.touches.length !== 1) return; // 2本指はカメラ操作に譲る
    e.stopPropagation();
    const t = e.touches[0];
    _beginPanelMoveDrag(t.clientX, t.clientY, pp);
  };
  // 名称ラベル移動ドラッグ開始 共通コア。3Dレイキャスト不要（画面上の平行移動をそのままviewBox単位で加算）
  const _beginLabelMoveDrag = (clientX, clientY, pp) => {
    labelMoveMovedRef.current = false;
    const p = _clientToCabSvg(clientX, clientY); if (!p) return;
    const off = pp.labelOffset || { dx: 0, dy: 0 };
    labelMoveDragActiveRef.current = true;
    setLabelMoveDrag({ id: pp.id, startClientX: clientX, startClientY: clientY,
      startSvgX: p.x, startSvgY: p.y, startDx: off.dx || 0, startDy: off.dy || 0 });
  };
  // マウス用（盤名称text/ヒット拡大rectから呼ぶ）
  const _startLabelMoveDrag = (e, pp) => {
    if (e.button !== 0) return;   // 中ボタンorbitは奪わない
    e.stopPropagation();
    _beginLabelMoveDrag(e.clientX, e.clientY, pp);
  };
  // タッチ用（_startPanelMoveDragTouch と同じ理由でpreventDefaultは呼ばない）
  const _startLabelMoveDragTouch = (e, pp) => {
    if (!e.touches || e.touches.length !== 1) return; // 2本指はカメラ操作に譲る
    e.stopPropagation();
    const t = e.touches[0];
    _beginLabelMoveDrag(t.clientX, t.clientY, pp);
  };
  // 配電盤クリックでの選択トグル（ドラッグ後のclickは無視）
  const _togglePlacedPanelSelection = (e, pp, sel) => {
    e.stopPropagation();
    const _moved = panelMoveMovedRef.current || labelMoveMovedRef.current;
    panelMoveMovedRef.current = false; labelMoveMovedRef.current = false;
    if (_moved) return;
    if (sel) { setSelectedPlacedPanelId(null); setSelectedDoorKey(null); setPanelDetailOpen(false); }
    else { setSelectedPlacedPanelId(pp.id); setSelectedDoorKey(null); setPanelDetailOffset({x:0,y:0}); }
  };
  const panelEditorIframeRef = useRef(null);

  // 配電盤 D&D: iframeからpostMessageでドラッグ開始
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'PANEL_DRAG_START') {
        draggingPanelRef.current = e.data.panel;
        setDraggingPanel({ panelData: e.data.panel, sx: -999, sy: -999 });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!draggingPanel) return;
    const mv = (e) => setDraggingPanel(pr => pr ? { ...pr, sx: e.clientX, sy: e.clientY } : null);
    const up = (e) => {
      const panelToPlace = draggingPanelRef.current; // React更新より先に退避
      draggingPanelRef.current = null;
      setDraggingPanel(null);
      const cab = cabRef.current;
      if (cab && panelToPlace) {
        const r = cab.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const scale = Math.min(r.width / CAB_W, r.height / CAB_H);
          const offX = (r.width - CAB_W * scale) / 2, offY = (r.height - CAB_H * scale) / 2;
          const svgX = (e.clientX - r.left - offX) / scale;
          const svgY = (e.clientY - r.top - offY) / scale;
          // 旧: unproject3D は真横視点(sinE≈0)でNaN/Infinityを返し、汚染座標の盤がplacedPanelsに永続化されていた
          const wp = cabScreenToGroundPoint(svgX, svgY, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
          if (isFinite(wp.x) && isFinite(wp.y)) {
            setPlacedPanels(pr => [...pr, { id: 'pp_' + Date.now(), panelData: panelToPlace, wx: wp.x, wy: wp.y, rot: 0, labelOffset: { dx: 0, dy: 0 } }]);
          }
        }
      }
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, [draggingPanel]);

  // 配電盤 回転ドラッグ
  const rotatePlacedPanel = (id, dRad) =>
    setPlacedPanels(pr => pr.map(p => p.id === id ? { ...p, rot: (p.rot || 0) + dRad } : p));

  const updatePlacedPanel = (id, field, value) =>
    setPlacedPanels(prev => prev.map(p =>
      p.id !== id ? p : { ...p, panelData: { ...p.panelData, [field]: value } }));

  const toggleDoor = (id, doorIdx) =>
    setPlacedPanels(prev => prev.map(p => {
      if (p.id !== id) return p;
      const doors = (p.panelData.doors || []).map((d, i) => i === doorIdx ? { ...d, isOpen: !d.isOpen } : d);
      return { ...p, panelData: { ...p.panelData, doors } };
    }));

  useEffect(() => {
    if (!panelRotDrag) return;
    const mv = (e) => {
      const da = Math.atan2(e.clientY - panelRotDrag.screenCy, e.clientX - panelRotDrag.screenCx) - panelRotDrag.startAngle;
      setPlacedPanels(pr => pr.map(p => p.id === panelRotDrag.id ? { ...p, rot: panelRotDrag.startRot + da } : p));
    };
    const up = () => { panelRotDragActiveRef.current = false; setPanelRotDrag(null); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, [panelRotDrag]);

  // 配電盤 XY移動ドラッグ（天頂面を掴んで地面上をスライド）
  useEffect(() => {
    if (!panelMoveDrag) return;
    const applyMove = (clientX, clientY) => {
      const dxc = clientX - panelMoveDrag.startClientX;
      const dyc = clientY - panelMoveDrag.startClientY;
      if (!panelMoveMovedRef.current) {
        if (dxc * dxc + dyc * dyc < 25) return;      // 5px未満はまだクリック候補
        panelMoveMovedRef.current = true;            // ここで移動モード昇格
        setSelectedPlacedPanelId(panelMoveDrag.id);  // 未選択盤は掴んだ瞬間に選択
        setSelectedDoorKey(null);
      }
      const p = _clientToCabSvg(clientX, clientY); if (!p) return;
      const g = cabScreenToGroundPoint(p.x, p.y, camAzRef.current, camElRef.current,
        camZoomRef.current, camPanXRef.current, camPanYRef.current);
      if (!isFinite(g.x) || !isFinite(g.y)) return;  // 汚染ガード
      const dwx = g.x - panelMoveDrag.groundX0, dwy = g.y - panelMoveDrag.groundY0;
      setPlacedPanels(pr => pr.map(p2 => p2.id === panelMoveDrag.id
        ? { ...p2, wx: panelMoveDrag.startWx + dwx, wy: panelMoveDrag.startWy + dwy } : p2));
    };
    const mv = (e) => applyMove(e.clientX, e.clientY);
    const tmv = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault(); // ページスクロール/ピンチ抑止（passive:false登録が前提）
      applyMove(e.touches[0].clientX, e.touches[0].clientY);
    };
    const up = () => { panelMoveDragActiveRef.current = false; setPanelMoveDrag(null); }; // movedRefはここで消さない(直後のclickが読むため)
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', tmv, { passive: false });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', tmv);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [panelMoveDrag]);

  // 配電盤 名称ラベル移動ドラッグ（盤本体は動かさず labelOffset のみ更新）
  useEffect(() => {
    if (!labelMoveDrag) return;
    const applyMove = (clientX, clientY) => {
      const dxc = clientX - labelMoveDrag.startClientX;
      const dyc = clientY - labelMoveDrag.startClientY;
      if (!labelMoveMovedRef.current) {
        if (dxc * dxc + dyc * dyc < 25) return;      // 5px未満はまだクリック候補
        labelMoveMovedRef.current = true;            // 盤の選択状態には触れない（ラベルだけが動く）
      }
      const p = _clientToCabSvg(clientX, clientY); if (!p) return;
      const ndx = labelMoveDrag.startDx + (p.x - labelMoveDrag.startSvgX);
      const ndy = labelMoveDrag.startDy + (p.y - labelMoveDrag.startSvgY);
      if (!isFinite(ndx) || !isFinite(ndy)) return;  // 汚染ガード
      setPlacedPanels(pr => pr.map(p2 => p2.id === labelMoveDrag.id
        ? { ...p2, labelOffset: { dx: ndx, dy: ndy } } : p2));
    };
    const mv = (e) => applyMove(e.clientX, e.clientY);
    const tmv = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      applyMove(e.touches[0].clientX, e.touches[0].clientY);
    };
    const up = () => { labelMoveDragActiveRef.current = false; setLabelMoveDrag(null); }; // movedRefは直後のclickが読むため消さない
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', tmv, { passive: false });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', tmv);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [labelMoveDrag]);

  const hSecScrollUpdateRef = useRef(null); // {id, left, top} ズーム後スクロール更新用
  const [hSecHoverId, setHSecHoverId] = useState(null); // {nodeId, hSecId}
  const [hSecEditDim, setHSecEditDim] = useState(null); // {hSecId, refId} 寸法編集中
  const [hSecActiveDim, setHSecActiveDim] = useState(null); // {id} 寸法表示中のhSec（drag後も維持）
  const [hSecTick, setHSecTick] = useState(0); // ドラッグ中再描画トリガー
  const hSecTickRafRef = useRef(null);
  const [hSecDrag, setHSecDrag] = useState(null); // {id, view, startClientY, startZPx, zoomFactor}
  const hSecDragRef = useRef(null); // stale closure回避
  const hSecLiveZRef = useRef({}); // {id: zPx} ドラッグ中のライブZ値
  const hSecDragClientPos = useRef({ x: 0, y: 0 }); // ドラッグ中カーソル位置（fixed div表示用）
  const hSecActiveDimPos = useRef({ x: 0, y: 0 }); // mouseup後の最終カーソル位置
  const hSecBadgeRef = useRef(null); // バッジdiv参照（外クリック検知用）
  const [hSecShowBand, setHSecShowBand] = useState({}); // 厚み帯ON/OFF {[hSecId]: boolean}
  const [adminHighlight, setAdminHighlight] = useState(null); // {row, phase:'down'|'move'|'up'}
  const _adminMouseWinRef = useRef(null); // mousedown時のFloatWin ID
  const hSecDragStartWorld = useRef({ x: TW / 2, y: TH / 2 }); // ドラッグ開始点のworld座標（3次元図矢印用）
  const [hSecPreview, setHSecPreview] = useState(null); // {view:'elev'|'side'|secId, zPx, clipSec?}
  const terrainFileRef = useRef(null);

  // 地形JSONロード
  const loadTerrainFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        setTerrainRaw(data);
        const parsed = parseTerrainJSON(data);
        setTerrain(parsed);
      } catch (err) { alert("地形JSONの読み込みに失敗: " + err.message); }
    };
    reader.readAsText(file);
  };

  // 地形メッシュ（メモ化）
  const terrainMesh = useMemo(() => {
    if (!terrain) return null;
    return terrainToMesh(terrain, TW, TH, terrainExag);
  }, [terrain, terrainExag]);

  // ウィンドウ状態
  const [winState, setWinState] = useState(() => {
    const W = window.innerWidth;
    const MENU_H = 22;
    const H = window.innerHeight - 20 - MENU_H; // status bar + menu bar
    const gap = 2;
    const y0 = MENU_H + gap; // 全ウィンドウのy開始位置
    // Left column: diag (narrow)
    const diagW = Math.max(160, Math.round(W * 0.13));
    // Right column: cesium (wider)
    const cesiumW = Math.max(300, Math.round(W * 0.30));
    // Middle area
    const midW = W - diagW - cesiumW - gap * 4;
    // Split middle into plan (left) and elev/side (right)
    const planW = Math.round(midW * 0.55);
    const elevW = midW - planW - gap;
    // Top row height / bottom row height
    const topH = Math.round(H * 0.55);
    const botH = H - topH - gap;
    // Elev/side split vertically
    const elevH = Math.round((topH - gap) / 2);
    const sideH = topH - elevH - gap;
    // Cesium split vertically
    const ces3dH = Math.round(H * 0.55);
    const ces2dH = H - ces3dH - gap;

    return {
      diag:     { x: gap,                        y: y0, w: diagW,  h: topH,  z: 10, minimized: false },
      plan:     { x: diagW + gap * 2,            y: y0, w: planW,  h: topH,  z: 11, minimized: false },
      elev:     { x: diagW + planW + gap * 3,    y: y0, w: elevW,  h: elevH, z: 12, minimized: false },
      side:     { x: diagW + planW + gap * 3,    y: y0 + elevH + gap, w: elevW, h: sideH, z: 13, minimized: false },
      cab:      { x: gap,                        y: y0 + topH + gap, w: W - cesiumW - gap * 3, h: botH, z: 14, minimized: false },
      cesium3d: { x: W - cesiumW - gap,          y: y0, w: cesiumW, h: ces3dH, z: 15, minimized: false },
      cesium2d: { x: W - cesiumW - gap,          y: y0 + ces3dH + gap, w: cesiumW, h: ces2dH, z: 16, minimized: false },
      bldProp:  { x: W - 260,                    y: y0 + 180, w: 240, h: 380, z: 17, minimized: false },
      admin:      { x: Math.round(W * 0.2),        y: y0 + Math.round(H * 0.2), w: 680, h: 360, z: 18, minimized: true },
      panelEditor:{ x: Math.round(W * 0.15),       y: y0 + Math.round(H * 0.1), w: Math.min(960, Math.round(W * 0.6)), h: Math.min(700, Math.round(H * 0.8)), z: 19, minimized: true },
    };
  });
  const zCounter = useRef(19);
  const bringFront = useCallback((id) => {
    zCounter.current++;
    setWinState(pr => ({ ...pr, [id]: { ...pr[id], z: zCounter.current } }));
  }, []);

  // 建屋選択時にプロパティパネルを最前面に
  useEffect(() => {
    if (selectedBld && bldEditMode) bringFront('bldProp');
  }, [selectedBld, bldEditMode, bringFront]);

  // 建屋リサイズ useEffect は elevZoom/sideZoom/planZoom 定義後に配置（下方）

  const planRef = useRef(null);
  const cabRef = useRef(null);
  const panelCanvasRef = useRef(null);
  const _panelCamMovingRef = useRef(false);
  const _panelCamTimerRef = useRef(null);
  const _panelRafRef = useRef(null);
  const _cabGearBtnRef = useRef(null);
  const [cabGearPos, setCabGearPos] = useState({top:0, left:0});
  const elevRef = useRef(null);
  const sideRef = useRef(null);
  const dRef = useRef(null);

  const [mapDrag, setMapDrag] = useState(null);
  const [diagDrag, setDiagDrag] = useState(null);
  const [elevDrag, setElevDrag] = useState(null);
  const [sideDrag, setSideDrag] = useState(null);
  const [secNodeDrag, setSecNodeDrag] = useState(null); // { id, secId }
  const [segLineDrag, setSegLineDrag] = useState(null);    // 線セグメント中点ドラッグ(2D)
  const [segLineDragCab, setSegLineDragCab] = useState(null); // 線セグメント中点ドラッグ(3D)
  const [segLineDragSec, setSegLineDragSec] = useState(null); // 線セグメント中点ドラッグ(矢視図)
  const secViewDataRef = useRef({}); // { [secId]: { dynSecGLY, SPD, viewEdge, rect } }
  const [tDrag, setTDrag] = useState(null);
  const iconDragging = useRef(false); // アイコンドラッグ中フラグ
  const [faceDirect, setFaceDirect] = useState(null); // 直接ドラッグ {id, startX, startY, startPos, startZ, axA, axB}
  const [faceIconDown, setFaceIconDown] = useState(null); // mousedown中のノードid（grabbing表示用）
  // 3次元図回転・ズーム・パン
  const [camAz, setCamAz] = useState(DEF_AZ);
  const [camEl, setCamEl] = useState(DEF_EL);
  const [plantNorthAngle, setPlantNorthAngle] = useState(0); // PN角度(度、CW from grid North)
  const [plantNorthInput, setPlantNorthInput] = useState('0');  // 入力欄の文字列バッファ
  const [pnPanelOpen, setPnPanelOpen] = useState(false); // PN調整パネル表示/非表示（3次元図用）
  const [planPnOpen, setPlanPnOpen] = useState(false); // 平面図PN調整パネル
  const [sidePnOpen, setSidePnOpen] = useState(false); // 側面図PN調整パネル
  const [secPnOpenId, setSecPnOpenId] = useState(null); // 矢視図PN調整パネル（開いているsecのID）
  const [secRotates, setSecRotates] = useState({});   // 矢視図ビュー回転角 {secId: degrees}
  const [camZoom, setCamZoom] = useState(() => calcAutoFit(DEF_AZ, DEF_EL).zoom);
  const [camPanX, setCamPanX] = useState(() => calcAutoFit(DEF_AZ, DEF_EL).panX);
  const [camPanY, setCamPanY] = useState(() => calcAutoFit(DEF_AZ, DEF_EL).panY);
  // 3次元図SVGのviewBox→画面ピクセル変換スケール（viewBox=900×700、ウィンドウサイズで変化）
  const [cabSvgScale, setCabSvgScale] = useState(1);
  // カメラRef（useEffect closure の stale 防止）
  const camAzRef = useRef(camAz); camAzRef.current = camAz;
  const camElRef = useRef(camEl); camElRef.current = camEl;
  const camZoomRef = useRef(camZoom); camZoomRef.current = camZoom;
  const camPanXRef = useRef(camPanX); camPanXRef.current = camPanX;
  const camPanYRef = useRef(camPanY); camPanYRef.current = camPanY;


  // PN角度Ref（axisDragのmousemoveなどasyncコンテキストで常に最新値を参照するため）
  const plantNorthAngleRef = useRef(plantNorthAngle); plantNorthAngleRef.current = plantNorthAngle;
  const secRotatesRef = useRef(secRotates); secRotatesRef.current = secRotates;
  // 各図面のズーム
  const [planZoom, setPlanZoom] = useState(1);
  const [elevZoom, setElevZoom] = useState(1);
  const [sideZoom, setSideZoom] = useState(1);
  const [diagZoom, setDiagZoom] = useState(1);
  // zoom値を追跡するref（ホイールハンドラで最新値を即取得）
  const planZoomRef = useRef(1); planZoomRef.current = planZoom;
  const elevZoomRef = useRef(1); elevZoomRef.current = elevZoom;
  const sideZoomRef = useRef(1); sideZoomRef.current = sideZoom;
  const diagZoomRef = useRef(1); diagZoomRef.current = diagZoom;
  const secZoomsRef = useRef({}); secZoomsRef.current = secZooms;
  const wpSnapIconRef = useRef(null);  // 折れ点ドラッグ中にスナップしているアイコンID
  const wpPerpSnapRef = useRef(null); // 直角スナップ情報（null = スナップなし）
  const iconSnapWpRef = useRef(null);  // アイコンドラッグ中にスナップしている折れ点キー(sid_i)
  const iconPerpSnapRef = useRef(null); // アイコンドラッグ直角スナップ情報 { svgX, svgY, dAx, dAy, dBx, dBy }
  const wpPerpSecRef = useRef(null);   // 矢視図折れ点ドラッグ直角マーク
  // スクロール更新目標（useLayoutEffectで消費）
  const scrollUpdateRef = useRef(null);
  // 矢視図スクロール更新目標（secId → {el, left, top}、useLayoutEffectで消費）
  const secScrollUpdateRef = useRef({});
  // 各図面の回転角（度）と回転軸（コンテンツ座標、表示中央）
  const [planRotate, setPlanRotate] = useState(0);
  const [elevRotate, setElevRotate] = useState(0);
  const [sideRotate, setSideRotate] = useState(0);
  const [planRotateOrigin, setPlanRotateOrigin] = useState({ x: TW/2, y: TH/2 });
  const [elevRotateOrigin, setElevRotateOrigin] = useState({ x: 0, y: 0 });
  const [sideRotateOrigin, setSideRotateOrigin] = useState({ x: 0, y: 0 });
  // focusNode内のstale closure回避用ref
  const planRotateRef = useRef(0); planRotateRef.current = planRotate;
  const elevRotateRef = useRef(0); elevRotateRef.current = elevRotate;
  const sideRotateRef = useRef(0); sideRotateRef.current = sideRotate;
  const planRotOrgRef = useRef({ x: TW/2, y: TH/2 }); planRotOrgRef.current = planRotateOrigin;
  const elevRotOrgRef = useRef({ x: 0, y: 0 }); elevRotOrgRef.current = elevRotateOrigin;
  const sideRotOrgRef = useRef({ x: 0, y: 0 }); sideRotOrgRef.current = sideRotateOrigin;

  // 建屋リサイズ: window mousemove/mouseup でドラッグ処理
  useEffect(() => {
    if (!bldAction) return;
    const onMove = (e) => {
      if (bldAction.type === 'resize') {
        const zoom = bldAction.view === 'elev' ? elevZoom : bldAction.view === 'side' ? sideZoom : planZoom;
        let delta;
        if (bldAction.field === 'zTop' || bldAction.field === 'zBottom') {
          delta = -(e.clientY - bldAction.startMouse) / zoom;
        } else if (bldAction.view === 'plan' && (bldAction.field === 'yMin' || bldAction.field === 'yMax')) {
          delta = (e.clientY - bldAction.startMouse) / zoom;
        } else {
          delta = (e.clientX - bldAction.startMouse) / zoom;
        }
        const newVal = snapV(bldAction.origVal + delta);
        setBuildings(prev => prev.map(b => {
          if (b.id !== bldAction.bid) return b;
          return {...b, blocks: b.blocks.map((blk, bi) => {
            if (bi !== bldAction.bi) return blk;
            if (bldAction.field === 'zTop') return {...blk, zTop: Math.max(blk.zBottom + MINOR, newVal)};
            if (bldAction.field === 'zBottom') return {...blk, zBottom: Math.min(blk.zTop - MINOR, newVal)};
            if (bldAction.field === 'xMin' || bldAction.field === 'xMax') {
              const origPts = bldAction.origPoints;
              return {...blk, points: blk.points.map((p, pi) => {
                if (origPts && Math.abs(origPts[pi].x - bldAction.origVal) < 1) return {...p, x: newVal};
                return p;
              })};
            }
            if (bldAction.field === 'yMin' || bldAction.field === 'yMax') {
              const origPts = bldAction.origPoints;
              return {...blk, points: blk.points.map((p, pi) => {
                if (origPts && Math.abs(origPts[pi].y - bldAction.origVal) < 1) return {...p, y: newVal};
                return p;
              })};
            }
            return blk;
          })};
        }));
      }
      // 辺の部分押し出し（L字等の変形）
      if (bldAction.type === 'extrude') {
        const origPts = bldAction.origPoints;
        const n = origPts.length;
        const j = bldAction.edgeIdx;
        const j1 = (j + 1) % n;
        const P1 = origPts[j], P2 = origPts[j1];
        const edx = P2.x - P1.x, edy = P2.y - P1.y;
        const eIsVert = Math.abs(edx) < Math.abs(edy);
        const zoom = planZoom;
        const mouseDelta = (eIsVert ? (e.clientX - bldAction.startMouse) : (e.clientY - bldAction.startMouse)) / zoom;
        const d = snapV(mouseDelta);
        const offX = eIsVert ? d : 0;
        const offY = eIsVert ? 0 : d;
        // Split point
        const t = bldAction.splitT;
        const sx = snapV(P1.x + t * edx);
        const sy = snapV(P1.y + t * edy);
        let newPts;
        if (Math.abs(d) < 1) {
          newPts = origPts.map(p => ({...p}));
        } else if (bldAction.side === 'start') {
          newPts = [];
          for (let k = 0; k < n; k++) {
            if (k === j) {
              newPts.push({x: P1.x + offX, y: P1.y + offY});
              newPts.push({x: sx + offX, y: sy + offY});
              newPts.push({x: sx, y: sy});
            } else {
              newPts.push({...origPts[k]});
            }
          }
        } else {
          newPts = [];
          for (let k = 0; k < n; k++) {
            if (k === j1) {
              newPts.push({x: sx, y: sy});
              newPts.push({x: sx + offX, y: sy + offY});
              newPts.push({x: P2.x + offX, y: P2.y + offY});
            } else {
              newPts.push({...origPts[k]});
            }
          }
        }
        setBuildings(prev => prev.map(b => {
          if (b.id !== bldAction.bid) return b;
          return {...b, blocks: b.blocks.map((blk, bi) => {
            if (bi !== bldAction.bi) return blk;
            return {...blk, points: newPts};
          })};
        }));
      }
      // 頂点ドラッグ
      if (bldAction.type === 'vertex') {
        const zoom = planZoom;
        const dx = (e.clientX - bldAction.startMouse.x) / zoom;
        const dy = (e.clientY - bldAction.startMouse.y) / zoom;
        const origPts = bldAction.origPoints;
        const vi = bldAction.vertIdx;
        const newPts = origPts.map((p, i) => {
          if (i === vi) return {x: snapV(p.x + dx), y: snapV(p.y + dy)};
          return {...p};
        });
        setBuildings(prev => prev.map(b => {
          if (b.id !== bldAction.bid) return b;
          return {...b, blocks: b.blocks.map((blk, bi) => {
            if (bi !== bldAction.bi) return blk;
            return {...blk, points: newPts};
          })};
        }));
      }
    };
    const onUp = () => setBldAction(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [bldAction, elevZoom, sideZoom, planZoom]);

  // 初期スクロール: 最初のペイント前に同期設定（rAF不要 → 最初のホイール操作と競合しない）
  useLayoutEffect(() => {
    // 平面図: 描写エリア中央
    const planSc = planRef.current?.parentElement?.parentElement;
    if (planSc) {
      planSc.scrollLeft = VIEW_PAD + TW / 2 - planSc.clientWidth  / 2;
      planSc.scrollTop  = VIEW_PAD + TH / 2 - planSc.clientHeight / 2;
    }
    // 断面図・側面図: GL（地面）が表示領域の60%位置に来るよう設定
    [elevRef, sideRef].forEach(ref => {
      const sc = ref.current?.parentElement?.parentElement;
      if (!sc) return;
      sc.scrollLeft = VIEW_PAD;
      sc.scrollTop  = Math.max(0, VIEW_PAD + GL_Y - sc.clientHeight * 0.6);
    });
  }, []);

  // zoom変化後・ペイント前にスクロールを同期適用（バタつき防止）
  // scrollUpdateRef には単一オブジェクト or 配列を格納可（複数ビュー同時対応）
  useLayoutEffect(() => {
    const upd = scrollUpdateRef.current;
    if (!upd) return;
    scrollUpdateRef.current = null;
    const items = Array.isArray(upd) ? upd : [upd];
    items.forEach(u => { u.scrollEl.scrollLeft = u.left; u.scrollEl.scrollTop = u.top; });
  }, [planZoom, elevZoom, sideZoom, diagZoom]);

  // 矢視図: zoom変化後にスクロールを同期適用（plan/elev/sideと同方式）
  useLayoutEffect(() => {
    const updates = secScrollUpdateRef.current;
    const keys = Object.keys(updates);
    if (keys.length === 0) return;
    secScrollUpdateRef.current = {};
    keys.forEach(sid => {
      const u = updates[sid];
      if (u?.el) { u.el.scrollLeft = u.left; u.el.scrollTop = u.top; }
    });
  }, [secZooms]);

  // 90°スナップヘルパー
  const snapTo90 = (angle) => {
    const mod = ((angle % 360) + 360) % 360;
    const nearest = Math.round(mod / 90) * 90;
    return Math.abs(mod - nearest) < 3 ? nearest : angle;
  };

  // 図面ホイール=ズーム（Ctrl不要）、ドラッグ=パン、中ボタンドラッグ=回転
  const [viewPanDrag, setViewPanDrag] = useState(null); // {ref, startX, startY, scrollLeft, scrollTop}
  const viewPanDragRef = useRef(null);
  viewPanDragRef.current = viewPanDrag;
  const [viewRotateDrag, setViewRotateDrag] = useState(null); // {refId, startX, startRotate}
  const viewRotateDragRef = useRef(null);
  viewRotateDragRef.current = viewRotateDrag;
  useEffect(() => {
    // plan/elev/sideRef はラッパーdiv(VIEW_PAD)を挟むため parentElement×2 がスクロールコンテナ
    const handlers = [
      [planRef, setPlanZoom, 2, planZoomRef, 500],
      [elevRef, setElevZoom, 2, elevZoomRef, 500],
      [sideRef, setSideZoom, 2, sideZoomRef, 500],
      [dRef,    setDiagZoom, 1, diagZoomRef,  50],
    ];
    const fns = [];
    handlers.forEach(([ref, setZ, depth, zoomRef, maxZ]) => {
      const el = ref.current; if (!el) return;
      // ホイールはスクロールコンテナに登録（描写エリア外でもズームが効く）
      let scrollContainer = el;
      for (let i = 0; i < depth; i++) scrollContainer = scrollContainer?.parentElement;
      if (!scrollContainer) return;
      const pad = depth === 2 ? VIEW_PAD : 0;
      const fn = (e) => {
        e.preventDefault();
        const containerRect = scrollContainer.getBoundingClientRect();
        const mx = e.clientX - containerRect.left;
        const my = e.clientY - containerRect.top;
        // 前回の目標スクロール値を引き継ぐ（連続ホイールでの累積誤差を防ぐ）
        const pending = scrollUpdateRef.current;
        const scrollLeftBefore = (pending?.scrollEl === scrollContainer) ? pending.left : scrollContainer.scrollLeft;
        const scrollTopBefore  = (pending?.scrollEl === scrollContainer) ? pending.top  : scrollContainer.scrollTop;
        const prevZoom = zoomRef.current;
        const factor = e.deltaY > 0 ? (1 / 1.07) : 1.07;
        const newZoom = Math.max(0.05, Math.min(maxZ, prevZoom * factor));
        const ratio = newZoom / prevZoom;
        zoomRef.current = newZoom;
        // スクロール目標をrefに保存 → useLayoutEffect でReact DOM更新直後に適用
        scrollUpdateRef.current = {
          scrollEl: scrollContainer,
          left: (scrollLeftBefore + mx - pad) * ratio + pad - mx,
          top:  (scrollTopBefore  + my - pad) * ratio + pad - my,
        };
        setZ(newZoom); // React stateを更新 → レンダー → useLayoutEffect発火
      };
      scrollContainer.addEventListener("wheel", fn, { passive: false });
      fns.push([scrollContainer, fn]);
    });
    // パン: mousemove/mouseup はwindowで拾う
    const onMove = (e) => {
      const drag = viewPanDragRef.current;
      if (drag) {
        const parent = drag.scrollEl || drag.ref?.current?.parentElement;
        if (parent) {
          parent.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX);
          parent.scrollTop  = drag.scrollTop  - (e.clientY - drag.startY);
        }
      }
      const rot = viewRotateDragRef.current;
      if (rot) {
        const dx = e.clientX - rot.startX;
        const newAngle = snapTo90(rot.startRotate - dx * 0.4);
        if (rot.refId === 'plan')           setPlanRotate(newAngle);
        else if (rot.refId === 'elev')      setElevRotate(newAngle);
        else if (rot.refId === 'side')      setSideRotate(newAngle);
        else setSecRotates(prev => ({ ...prev, [rot.refId]: newAngle }));
      }
    };
    const onUp = () => {
      setViewPanDrag(null);
      const rot = viewRotateDragRef.current;
      if (rot) {
        if (rot.refId === 'plan' || rot.refId === 'elev' || rot.refId === 'side') {
          const setter = rot.refId === 'plan' ? setPlanRotate : rot.refId === 'elev' ? setElevRotate : setSideRotate;
          setter(prev => snapTo90(prev));
        } else {
          setSecRotates(prev => ({ ...prev, [rot.refId]: snapTo90(prev[rot.refId] || 0) }));
        }
        setViewRotateDrag(null);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      fns.forEach(([el, fn]) => el.removeEventListener("wheel", fn));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const [orbiting, setOrbiting] = useState(null);
  const orbitingRef = useRef(null); // stale closure回避: onMoveで常に最新値を参照
  orbitingRef.current = orbiting; // 毎レンダーで同期
  const [panning, setPanning] = useState(null);
  const panningRef = useRef(null); // stale closure回避: onMoveで常に最新値を参照
  panningRef.current = panning; // 毎レンダーで同期
  const faceAlignedRef = useRef(false); // 面クリック到達時true / 手動回転で即false
  const clickedFaceRef = useRef(null);  // 最後にクリックした面id ('px'|'mx'|'py'|'my'|'pz'|'mz')
  const lastCabUpRef = useRef({ x: CAB_W / 2, y: CAB_H / 2 }); // 直近mouseup座標（ギズモ回転のpivot用）
  const gizmoInteractionRef = useRef(null); // { startX, startY, faces, gc, svgEl, pnRad }
  const [gizmoGrabbing, setGizmoGrabbing] = useState(false);

  // 中ボタン=回転(カーソル位置中心)、左ボタン背景=パン、ホイール=ズーム
  useEffect(() => {
    const cabEl = cabRef.current;
    if (!cabEl) return;
    const onDown = (e) => {
      if (e.target.closest && e.target.closest('[data-panel-rot]')) return; // 配電盤回転ハンドル上はorbit/pan抑制
      if (e.button === 0 && e.target.closest && e.target.closest('[data-panel-move],[data-panel-label]')) return; // 配電盤天頂面=盤移動 / 名称ラベル=ラベル移動（中ボタンorbitは奪わない）
      if (e.target.closest && e.target.closest('[data-panel-detail-drag]')) return; // 制限UIパネルドラッグ中はカメラドラッグ抑制
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'LABEL' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return; // 配電盤制限UI操作はカメラドラッグ抑制
      if (cabSecMode && e.button === 1) return; // 矢視図描画中はorbit（中ボタン）のみ禁止、pan（左ボタン）は許可
      // ダブルクリックアニメーション中断（マウスダウン時に即座にキャンセル）
      if (cab3dAnimCancelRef.current) { cab3dAnimCancelRef.current(); cab3dAnimCancelRef.current = null; }
      if (e.button === 1) {
        if (e.target.closest && (e.target.closest("[data-gizmo]") || e.target.closest("[data-node]") || e.target.closest("[data-pn-gizmo]"))) return;
        if (axisDrag) return;
        faceAlignedRef.current = false; // 手動回転開始 → 直接ドラッグ無効化
        clickedFaceRef.current = null;
        e.preventDefault();
        const rect = cabEl.getBoundingClientRect();
        const _sx = CAB_W / (rect.width || CAB_W), _sy = CAB_H / (rect.height || CAB_H);
        const screenX = (e.clientX - rect.left) * _sx;
        const screenY = (e.clientY - rect.top) * _sy;
        // pivotはカーソル下のレイキャストで決定（配置盤OBB→地面の順に最手前を採用）。
        // 旧: unproject3D は地面z=0固定のため真横視点(sinE≈0)で交点が発散しpivotが遥か彼方になっていた。
        const piv = pickOrbitPivot(screenX, screenY, camAzRef.current, camElRef.current,
          camZoomRef.current, camPanXRef.current, camPanYRef.current, placedPanelsRef.current);
        setOrbiting({ startX: e.clientX, startY: e.clientY, startAz: camAzRef.current, startEl: camElRef.current, startPanX: camPanXRef.current, startPanY: camPanYRef.current, pivotX: piv.x, pivotY: piv.y, pivotZ: piv.z, screenX, screenY });
      } else if (e.button === 0) {
        if (ppDragRef.current) return; // pushpullドラッグ中は画面移動を無効化
        if (iconDragging.current) return;
        if (e.target.getAttribute && e.target.getAttribute("data-hsecindicatorhit")) return;
        if (e.target.closest && (e.target.closest("[data-gizmo]") || e.target.closest("[data-node]") || e.target.closest("[data-pn-gizmo]"))) return;
        if (drawMode && drawState) {
          drawClickRef.current = { x: e.clientX, y: e.clientY };
          e.preventDefault();
          setPanning({ startX: e.clientX, startY: e.clientY, startPanX: camPanXRef.current, startPanY: camPanYRef.current });
          return;
        }
        if (drawMode) {
          e.preventDefault();
          setPanning({ startX: e.clientX, startY: e.clientY, startPanX: camPanXRef.current, startPanY: camPanYRef.current });
          return;
        }
        e.preventDefault();
        setPanning({ startX: e.clientX, startY: e.clientY, startPanX: camPanXRef.current, startPanY: camPanYRef.current });
      }
    };
    const onMove = (e) => {
      if (ppDragRef.current) return; // pushpullドラッグ中はカメラ操作を全て無効化
      const _orb = orbitingRef.current; // refで常に最新値を取得（stale closure回避）
      if (_orb) {
        const dx = e.clientX - _orb.startX, dy = e.clientY - _orb.startY;
        const newAz = _orb.startAz + dx * 0.004;
        const newEl = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, _orb.startEl + dy * 0.004));
        const pan = panForPivot(_orb.pivotX, _orb.pivotY, _orb.pivotZ, newAz, newEl, camZoomRef.current, _orb.screenX, _orb.screenY);
        setCamAz(newAz); setCamEl(newEl);
        setCamPanX(pan.panX);
        setCamPanY(pan.panY);
      }
      const _pan = panningRef.current; // refで常に最新値を取得（stale closure回避）
      if (_pan && !iconDragging.current) {
        const _pr = cabEl.getBoundingClientRect();
        const cW2 = _pr.width || CAB_W, cH2 = _pr.height || CAB_H;
        const _sc2 = Math.min(cW2 / CAB_W, cH2 / CAB_H);
        const dx = (e.clientX - _pan.startX) / _sc2, dy = (e.clientY - _pan.startY) / _sc2;
        setCamPanX(_pan.startPanX + dx);
        setCamPanY(_pan.startPanY + dy);
      }
      if (_pan && iconDragging.current) setPanning(null);
    };
    const onUp = (e) => {
      if (e.button === 1) setOrbiting(null);
      if (e.button === 0) {
        setOrbiting(null); // gizmoドラッグ（左ボタン）のorbit解除
        setGizmoGrabbing(false);
        // gizmoクリック判定: 移動<5pxならクリックとしてカメラアニメーション
        const gi = gizmoInteractionRef.current;
        if (gi) {
          const dx = e.clientX - gi.startX, dy = e.clientY - gi.startY;
          if (dx*dx + dy*dy < 25) { // click (< 5px)
            const svgR = gi.svgEl.getBoundingClientRect();
            const svgX = (e.clientX - svgR.left) / svgR.width * 80;
            const svgY = (e.clientY - svgR.top) / svgR.height * 80;
            // 手前の面だけを対象にする（奥の反対面は除外 → 正面向き後の誤検知を防ぐ）
            const frontFaces = gi.faces.filter(f => f.depth < gi.midD);
            const candidates = frontFaces.length > 0 ? frontFaces : gi.faces;
            const hit = candidates.reduce((b, f) => {
              const d = (f.cxF-svgX)**2 + (f.cyF-svgY)**2;
              return d < b.d ? { f, d } : b;
            }, { f: null, d: Infinity }).f;
            if (hit && hit.id) {
              const pr = gi.pnRad;
              const _curEl = camElRef.current;
              // Z/-Z面視点のとき、端クリックで側面が誤選択される → 上下視点では側面を無視
              const _isTopBottom = Math.abs(Math.abs(_curEl) - Math.PI/2) < 0.15;
              const _isSideFace = hit.id !== 'pz' && hit.id !== 'mz';
              if (_isTopBottom && _isSideFace && clickedFaceRef.current !== null) {
                // 上下視点で側面が選ばれた = 端の誤クリック → 無視
                gizmoInteractionRef.current = null;
                return;
              }
              const faceAz = {
                'px': pr - Math.PI/2, 'mx': pr + Math.PI/2,
                'py': pr + Math.PI,   'my': pr,
                'pz': camAzRef.current, 'mz': camAzRef.current,
              }[hit.id] ?? camAzRef.current;
              const faceEl = { 'pz': Math.PI/2 - 0.02, 'mz': -Math.PI/2 + 0.02 }[hit.id] ?? 0;
              let dAz = faceAz - camAzRef.current;
              while (dAz > Math.PI) dAz -= 2*Math.PI;
              while (dAz < -Math.PI) dAz += 2*Math.PI;
              const dEl = faceEl - camElRef.current;
              if (Math.abs(dAz) < 0.08 && Math.abs(dEl) < 0.08) {
                // 既に向いている → 回転なしでそのままface-aligned状態を維持
                clickedFaceRef.current = hit.id;
                faceAlignedRef.current = true;
                return;
              }
              // アニメーション開始と同時にface-aligned確定（アニメーション中でも直接ドラッグ可）
              clickedFaceRef.current = hit.id;
              faceAlignedRef.current = true;
              const az0 = camAzRef.current, el0 = camElRef.current;
              // 回転前に画面中心に映っていた3D点をpivotとし、回転中〜回転後も画面中心に固定する
              // （中ボタンオービット・ギズモドラッグと同じ pickOrbitPivot + panForPivot パターン）
              const piv = pickOrbitPivot(CAB_W / 2, CAB_H / 2, az0, el0,
                camZoomRef.current, camPanXRef.current, camPanYRef.current, placedPanelsRef.current);
              // pivotは画面中心レイ上にあるため開始時の投影位置は厳密に画面中心（明示計算で堅牢化）
              const pivScr = project3D(piv.x, piv.y, piv.z, az0, el0,
                camZoomRef.current, camPanXRef.current, camPanYRef.current);
              const t0 = performance.now(), dur = 450;
              // 既存アニメーションのキャンセル機構に登録（中ボタンドラッグ・ホイール操作等で自動中断させる）
              if (cab3dAnimCancelRef.current) cab3dAnimCancelRef.current();
              let _cancelled = false;
              cab3dAnimCancelRef.current = () => { _cancelled = true; };
              const step = (now) => {
                if (_cancelled || panningRef.current) { cab3dAnimCancelRef.current = null; return; }
                const t = Math.min(1, (now - t0) / dur);
                const e2 = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
                const az = az0 + dAz * e2, el = el0 + dEl * e2;
                const pan = panForPivot(piv.x, piv.y, piv.z, az, el, camZoomRef.current, pivScr.x, pivScr.y);
                setCamAz(az); setCamEl(el);
                setCamPanX(pan.panX); setCamPanY(pan.panY);
                if (t < 1) requestAnimationFrame(step);
                else cab3dAnimCancelRef.current = null;
              };
              requestAnimationFrame(step);
            }
          }
          gizmoInteractionRef.current = null;
        }
        // 直近mouseup座標を記録（ギズモドラッグ回転のpivot用）
        const rect0 = cabEl.getBoundingClientRect();
        const _s0x = CAB_W / (rect0.width || CAB_W), _s0y = CAB_H / (rect0.height || CAB_H);
        lastCabUpRef.current = { x: (e.clientX - rect0.left) * _s0x, y: (e.clientY - rect0.top) * _s0y };
        // 背景クリック（ドラッグでない）→ ギズモ解除
        const _panSnap = panningRef.current;
        if (_panSnap && !gizmoInteractionRef.current) {
          const _pdx = e.clientX - _panSnap.startX, _pdy = e.clientY - _panSnap.startY;
          const isOnCanvas = !e.target.closest("button") && !e.target.closest("[data-node]") && !e.target.closest("[data-gizmo]") && !e.target.closest("[data-pn-gizmo]");
          if (_pdx*_pdx + _pdy*_pdy < 25 && isOnCanvas) setGizmoTarget(null);
        }
        if (drawClickRef.current) {
          const dx = e.clientX - drawClickRef.current.x;
          const dy = e.clientY - drawClickRef.current.y;
          const isOnCanvas = !e.target.closest("button") && !e.target.closest("[data-node]") && !e.target.closest("[data-gizmo]");
          if (Math.abs(dx) < 5 && Math.abs(dy) < 5 && isOnCanvas && drawState) {
            const rect = cabEl.getBoundingClientRect();
            const _dsx = CAB_W / (rect.width || CAB_W), _dsy = CAB_H / (rect.height || CAB_H);
            const sx = (e.clientX - rect.left) * _dsx, sy = (e.clientY - rect.top) * _dsy;
            const result = addWpOrtho(drawState.sid, sx, sy, drawState.lastPos);
            if (result) setDrawState(prev => prev ? { ...prev, lastPos: result } : prev);
          }
          drawClickRef.current = null;
        }
        setPanning(null);
      }
    };
    const onWheel = (e) => {
      e.preventDefault();
      // ダブルクリックアニメーション中断
      if (cab3dAnimCancelRef.current) { cab3dAnimCancelRef.current(); cab3dAnimCancelRef.current = null; }
      if (e.shiftKey) {
        // Shift+スクロール: 仰角変更（上スクロール=上から、下スクロール=下から）
        const elDelta = e.deltaY > 0 ? 0.08 : -0.08;
        setCamEl(prev => Math.max(-Math.PI / 2, Math.min(Math.PI, prev + elDelta)));
        return;
      }
      const rect = cabEl.getBoundingClientRect();
      // preserveAspectRatio="xMidYMid meet" のオフセットを正確に計算
      const cW = rect.width || CAB_W, cH = rect.height || CAB_H;
      const _scale = Math.min(cW / CAB_W, cH / CAB_H);
      const _offX = (cW - CAB_W * _scale) / 2;
      const _offY = (cH - CAB_H * _scale) / 2;
      const mx = ((e.clientX - rect.left) - _offX) / _scale;
      const my = ((e.clientY - rect.top)  - _offY) / _scale;
      const oldZoom = camZoomRef.current;
      const delta = e.deltaY > 0 ? -0.12 * oldZoom : 0.12 * oldZoom;
      const newZoom = Math.max(0.1, Math.min(500, oldZoom + delta));
      const ratio = newZoom / oldZoom;
      // カーソル位置を固定するようにpanを補正
      setCamPanX(mx - CAB_W / 2 - (mx - CAB_W / 2 - camPanXRef.current) * ratio);
      setCamPanY(my - CAB_H / 2 - (my - CAB_H / 2 - camPanYRef.current) * ratio);
      setCamZoom(newZoom);
    };
    cabEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cabEl.addEventListener("wheel", onWheel, { passive: false });
    const noCtx = (e) => { if (orbitingRef.current) e.preventDefault(); };
    cabEl.addEventListener("contextmenu", noCtx);
    return () => {
      cabEl.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cabEl.removeEventListener("wheel", onWheel);
      cabEl.removeEventListener("contextmenu", noCtx);
    };
  }, [panning, drawMode, drawState, axisDrag, cabSecMode]);

  // pushpull矢印ドラッグ: 矢印先端をドラッグして面をpushpull
  useEffect(() => {
    if (!ppDrag) return;
    let _lastNewSolid = null; // onMove内の最新solidをクロージャで保持（stateより確実）
    const onMove = (e) => {
      const _cab = cabRef.current;
      if (!_cab) return;
      const _rect = _cab.getBoundingClientRect();
      const _scaleX = CAB_W / (_rect.width || CAB_W);
      const _scaleY = CAB_H / (_rect.height || CAB_H);
      const _sdx = (e.clientX - ppDrag.startClientX) * _scaleX;
      const _sdy = (e.clientY - ppDrag.startClientY) * _scaleY;
      const _depth = ppDrag.len2 > 0
        ? (_sdx * ppDrag.dux + _sdy * ppDrag.duy) / ppDrag.len2
        : 0;
      const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
      const _depthM = _depth * _mpp;
      const _newSolid = pushPullFace(ppDrag.startSolid, ppDrag.faceId, _depthM);
      if (_newSolid !== ppDrag.startSolid) {
        _lastNewSolid = _newSolid; // mouseup時参照用に保存
        setSolidsDirect(solidsRef.current.map(s => s.id === ppDrag.solidId ? _newSolid : s));
        // ドラッグ中もbuildingsをリアルタイム同期（断面図・側面図・矢視図に即反映）
        const _allZ = _newSolid.faces.flatMap(f => f.vertices.map(v => v.z));
        if (_allZ.length > 0) {
          const _zTop = Math.max(..._allZ), _zBot = Math.min(..._allZ);
          setBuildings(prev => prev.map(bld => {
            if (bld.id !== ppDrag.startSolid.buildingId) return bld;
            return { ...bld, blocks: bld.blocks.map((blk, bi) =>
              bi === ppDrag.startSolid.blockIdx ? { ...blk, zTop: _zTop, zBottom: _zBot } : blk) };
          }));
        }
      }
    };
    const onUp = () => {
      // _lastNewSolidはstateと無関係にonMove内で確定している最新solid
      const _finalSolid = _lastNewSolid || ppDrag.startSolid;
      const _lf = _finalSolid.faces.find(f => f.id === ppDrag.faceId);
      if (_lf && _lf.vertices.length > 0) {
        const _v = _lf.vertices;
        setCab3dArrow(prev => prev ? {
          ...prev,
          cx: _v.reduce((s, v) => s + v.x, 0) / _v.length,
          cy: _v.reduce((s, v) => s + v.y, 0) / _v.length,
          cz: _v.reduce((s, v) => s + v.z, 0) / _v.length,
        } : prev);
      }
      bldUndoRef.current.push(_makeEntry(buildingsRef.current, solidsRef.current));
      bldRedoRef.current = [];
      ppDragRef.current = null;
      setPPDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [ppDrag]);

  // 3次元図SVGスケール追跡（viewBox=900×700のウィンドウへの投影倍率）
  useEffect(() => {
    const el = cabRef.current;
    if (!el) return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setCabSvgScale(Math.min(width / CAB_W, height / CAB_H));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 配電盤CanvasをcabRef基準で再描画（カメラ・パネル変更時）
  const _drawPanelCanvas = useCallback((isMoving) => {
    const canvas = panelCanvasRef.current;
    const cab = cabRef.current;
    if (!canvas || !cab) return;
    const rect = cab.getBoundingClientRect();
    // SVGのviewBox計算と一致させるためfloat基準で座標計算。バッファだけ整数。
    const cw = rect.width, ch = rect.height;
    if (cw <= 0 || ch <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (placedPanels.length === 0) return;
    const sc = Math.min(cw / CAB_W, ch / CAB_H);
    const ox = (cw - CAB_W * sc) / 2, oy = (ch - CAB_H * sc) / 2;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);
    // 移動中はOC_RES上限を品質設定に従って制限、静止後は512px — 内部は常に表示
    const _movingCap = Math.max(32, Math.round(512 * panelDragQuality / 100));
    for (const pp of placedPanels) {
      _pde_drawPanelOnCab(ctx, pp, camAz, camEl, camZoom, camPanX, camPanY, false, sc * dpr, isMoving ? _movingCap : 512,
        pp.panelData?.iconVisMode ?? 'semi',
        pp.panelData?.showWires ?? true,
        pp.panelData?.doorsVisible ?? true);
    }
    ctx.restore();
  }, [placedPanels, camAz, camEl, camZoom, camPanX, camPanY, panelDragQuality]);

  useEffect(() => {
    _panelCamMovingRef.current = true;
    clearTimeout(_panelCamTimerRef.current);
    _panelCamTimerRef.current = setTimeout(() => {
      _panelCamMovingRef.current = false;
      _drawPanelCanvas(false); // 静止後: OC_RES=512フル描画
    }, panelRestoreDelay);
    cancelAnimationFrame(_panelRafRef.current);
    _panelRafRef.current = requestAnimationFrame(() => {
      _drawPanelCanvas(_panelCamMovingRef.current); // 移動中=OC_RES=品質設定
    });
  }, [placedPanels, camAz, camEl, camZoom, camPanX, camPanY, panelRestoreDelay, cabSvgScale, _drawPanelCanvas]);

  // タッチ: 1本指背景=パン、2本指=回転+ピンチズーム
  const touchOrbitRef = useRef(null);
  const touchPanRef = useRef(null);
  useEffect(() => {
    const cabEl = cabRef.current;
    if (!cabEl) return;
    const getDist = (t) => Math.sqrt((t[0].clientX - t[1].clientX) ** 2 + (t[0].clientY - t[1].clientY) ** 2);
    const onTS = (e) => {
      if (e.touches.length === 2) {
        touchPanRef.current = null;
        // 盤移動ドラッグ中に2本目の指が置かれてもorbitに化けさせない
        if (panelMoveDragActiveRef.current || labelMoveDragActiveRef.current) { touchOrbitRef.current = null; return; }
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        touchOrbitRef.current = { startX: mx, startY: my, startAz: camAz, startEl: camEl, startDist: getDist(e.touches), startZoom: camZoom };
      } else if (e.touches.length === 1) {
        touchOrbitRef.current = null;
        if (iconDragging.current || panelMoveDragActiveRef.current || labelMoveDragActiveRef.current) { touchPanRef.current = null; return; }
        // 配電盤の天頂面/名称/回転ハンドル上のタッチはカメラパンを起動しない
        // （マウス側の data-panel-move ガードの鏡像。Reactハンドラの
        //   stopPropagationではこのnativeリスナーを止められないためここで判定する）
        if (e.target.closest && e.target.closest('[data-panel-move],[data-panel-rot],[data-panel-label]')) { touchPanRef.current = null; return; }
        touchPanRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, startPanX: camPanX, startPanY: camPanY };
      }
    };
    const onTM = (e) => {
      if (e.touches.length === 2 && touchOrbitRef.current) {
        e.preventDefault();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const dx = mx - touchOrbitRef.current.startX, dy = my - touchOrbitRef.current.startY;
        setCamAz(touchOrbitRef.current.startAz + dx * 0.008);
        setCamEl(Math.max(-Math.PI / 2, Math.min(Math.PI, touchOrbitRef.current.startEl + dy * 0.008)));
        const dist = getDist(e.touches);
        setCamZoom(Math.max(0.1, Math.min(500, touchOrbitRef.current.startZoom * (dist / touchOrbitRef.current.startDist))));
      } else if (e.touches.length === 1 && touchPanRef.current && !iconDragging.current && !panelMoveDragActiveRef.current && !labelMoveDragActiveRef.current) {
        e.preventDefault();
        const _tpr = cabRef.current ? cabRef.current.getBoundingClientRect() : null;
        const _tpsx = _tpr ? CAB_W / (_tpr.width || CAB_W) : 1;
        const _tpsy = _tpr ? CAB_H / (_tpr.height || CAB_H) : 1;
        setCamPanX(touchPanRef.current.startPanX + (e.touches[0].clientX - touchPanRef.current.startX) * _tpsx);
        setCamPanY(touchPanRef.current.startPanY + (e.touches[0].clientY - touchPanRef.current.startY) * _tpsy);
      }
      if (touchPanRef.current && (iconDragging.current || panelMoveDragActiveRef.current || labelMoveDragActiveRef.current)) touchPanRef.current = null;
    };
    const onTE = () => { touchOrbitRef.current = null; touchPanRef.current = null; };
    cabEl.addEventListener("touchstart", onTS, { passive: false });
    cabEl.addEventListener("touchmove", onTM, { passive: false });
    cabEl.addEventListener("touchend", onTE);
    return () => { cabEl.removeEventListener("touchstart", onTS); cabEl.removeEventListener("touchmove", onTM); cabEl.removeEventListener("touchend", onTE); };
  }, [camAz, camEl, camZoom, camPanX, camPanY]);

  // 面正面視点判定: cube面クリック または 手動で15°以内に向いたとき有効
  const _FACE_THR = 15 * Math.PI / 180;
  const _pnRad4 = plantNorthAngle * Math.PI / 180;
  const _faceChecks = [
    { id: 'px', az: _pnRad4 - Math.PI/2, el: 0 },
    { id: 'mx', az: _pnRad4 + Math.PI/2, el: 0 },
    { id: 'py', az: _pnRad4 + Math.PI,   el: 0 },
    { id: 'my', az: _pnRad4,             el: 0 },
    { id: 'pz', az: null, el:  Math.PI/2 },
    { id: 'mz', az: null, el: -Math.PI/2 },
  ];
  let _autoFace = null;
  for (const _fc of _faceChecks) {
    if (Math.abs(camEl - _fc.el) >= _FACE_THR) continue;
    if (_fc.az === null) { _autoFace = _fc.id; break; }
    let _dAz = camAz - _fc.az;
    while (_dAz >  Math.PI) _dAz -= 2 * Math.PI;
    while (_dAz < -Math.PI) _dAz += 2 * Math.PI;
    if (Math.abs(_dAz) < _FACE_THR) { _autoFace = _fc.id; break; }
  }
  const isFaceAligned = faceAlignedRef.current || _autoFace !== null;
  // 自動検出した面idをclickedFaceRefに反映（軸選択に使用）
  if (_autoFace !== null && !faceAlignedRef.current) {
    clickedFaceRef.current = _autoFace;
  }

  // ── Cesium drag表示ヘルパー（wireCanvas直接描画 / world座標→スクリーン正確投影方式）──
  // scr行列の線形近似ではなく毎フレームworldToWindowCoordinatesで正確計算
  // → 透視投影・遠方縮小・カメラ角度すべて正確に反映
  const _buildCesiumWireOverlay = (queryRef, connSegs, pos0) => {
    const q = queryRef?.current; if (!q) return null;

    // entity・wire非表示は必ず実行（getIconScreenPos失敗でもentityは隠す）
    q.clearWireCanvas?.();
    q.hideWires?.(connSegs.map(s => s.id));
    q.hideNodeEntity?.(pos0.nodeId);

    // 接続先（S2等）のワールド座標を保存（毎フレームdrawDragFrameに渡す）
    const otherEnds = [];
    connSegs.forEach(seg => {
      const otherNodeId = seg.from === pos0.nodeId ? seg.to : seg.from;
      const otherPos = allMapPosRef.current[otherNodeId]; if (!otherPos) return;
      const isFrom = seg.from === pos0.nodeId;
      const _wps = segWpRef.current[seg.id] || [];
      const _wzs = wpZRef.current[seg.id] || [];
      const wpPts = _wps.map((w, i) => ({ x: w.x, y: w.y, z: _wzs[i] || 0 }));
      // mapZRef優先 → allMapPos.z → Cesium地形標高推定 → 0 の順でフォールバック
      const _mapZVal = mapZRef.current[otherNodeId];
      const _posZVal = otherPos.z;
      let otherZ = _mapZVal != null ? _mapZVal : _posZVal != null ? _posZVal : (q.getGroundLocalZForWorld?.(otherPos.x, otherPos.y) ?? 0);
      if (otherZ == null) otherZ = 0;
      otherEnds.push({ segId: seg.id, wx: otherPos.x, wy: otherPos.y, wz: otherZ, isBus: seg.isBus||false, wps: wpPts, isFrom });
    });

    return { queryRef, nodeId: pos0.nodeId, connSegs, otherEnds };
  };
  // newWx/Wy/Wz: drag中アイコンの現在ワールド座標（毎フレーム正確なスクリーン位置に変換）
  const _updateCesiumWireOverlay = (ovState, newWx, newWy, newWz) => {
    if (!ovState) return;
    ovState.queryRef?.current?.drawDragFrame(ovState.nodeId, newWx, newWy, newWz, ovState.otherEnds);
  };
  const _teardownCesiumWireOverlay = (ovState, finalPos = null) => {
    ovState?.queryRef?.current?.showWires?.(ovState.connSegs?.map(s => s.id));
    ovState?.queryRef?.current?.showNodeEntity?.(ovState.nodeId, finalPos || undefined);
  };

  // 直接ドラッグのuseEffect
  useEffect(() => {
    if (!faceDirect) return;
    const cabEl2 = cabRef.current;
    const id = faceDirect.id;
    isDraggingRef.current = true;
    movedNodeRef.current = id;
    const _r = cabEl2?.getBoundingClientRect();
    const sc0 = _r ? Math.min(_r.width / CAB_W, _r.height / CAB_H) : 1;
    const _connSegs = connectedSegsMapRef.current[id] || [];
    const _pi = document.getElementById('pi-' + id);
    const cW = cabEl2?.clientWidth || CAB_W, cH = cabEl2?.clientHeight || CAB_H;
    const _sc0 = Math.min(cW / CAB_W, cH / CAB_H);
    const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
    _connSegs.forEach(seg => {
      const pw = document.getElementById('pw-' + seg.id), ew = document.getElementById('ew-' + seg.id);
      const sw = document.getElementById('sw-' + seg.id), cw = document.getElementById('cw-' + seg.id);
      const cwh = document.getElementById('cwh-' + seg.id);
      if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
      if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
      if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
      cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
    });
    _dragGeomCache.current = {
      piEl: _pi, eiEl: document.getElementById('ei-' + id),
      siEl: document.getElementById('si-' + id), ciEl: document.getElementById('ci-' + id),
      piHW: _pi ? _pi.offsetWidth / 2 : 21, piHH: _pi ? _pi.offsetHeight / 2 : 23,
      eiHW: 21, siHW: 21,
      cabHW: document.getElementById('ci-' + id)?.offsetWidth / 2 || 14,
      cabHH: document.getElementById('ci-' + id)?.offsetHeight / 2 || 15,
      cabOx: (cW - CAB_W * _sc0) / 2, cabOy: (cH - CAB_H * _sc0) / 2, cabSc: _sc0,
      connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
      elevRect: elevRef.current?.getBoundingClientRect() || null,
      sideRect: sideRef.current?.getBoundingClientRect() || null,
    };

    // Cesium wire SVG overlay（billboard entityがアイコンをGPU描画、wireはCSS SVGで仮表示）
    const _pos0 = allMapPosRef.current[id] || {};
    const _pos0WithId = { ..._pos0, nodeId: id };
    const _wireOv3d = _buildCesiumWireOverlay(cesium3dQueryRef, _connSegs, _pos0WithId);
    const _wireOv2d = _buildCesiumWireOverlay(cesium2dQueryRef, _connSegs, _pos0WithId);

    // hide後の空白フレーム防止: 初期位置で即時描画（次のmousemoveを待たずに表示を維持）
    const _initX = faceDirect.startPos.x, _initY = faceDirect.startPos.y;
    const _initGz = _pos0.z || 0;
    _applyDragDOM(id, _initX, _initY);
    _updateCesiumWireOverlay(_wireOv3d, _initX, _initY, _initGz);
    _updateCesiumWireOverlay(_wireOv2d, _initX, _initY, _initGz);

    let _rafId = null, _pendingEv = null;
    const mv = (e) => {
      e.preventDefault();
      _pendingEv = e;
      if (_rafId) return;
      _rafId = requestAnimationFrame(() => {
        _rafId = null;
        const ev2 = _pendingEv;
        const sdx = (ev2.clientX - faceDirect.startX) / sc0 / (faceDirect.zoom || 1);
        const sdy = (ev2.clientY - faceDirect.startY) / sc0 / (faceDirect.zoom || 1);
        const { axA, axB } = faceDirect;
        const det = axA.sx * axB.sy - axA.sy * axB.sx;
        if (Math.abs(det) < 0.001) return;
        const dA = (sdx * axB.sy - sdy * axB.sx) / det;
        const dB = (axA.sx * sdy - axA.sy * sdx) / det;
        const nx = faceDirect.startPos.x + axA.wx * dA + axB.wx * dB;
        const ny = faceDirect.startPos.y + axA.wy * dA + axB.wy * dB;
        // 平面図・断面図・側面図・3次元図の DOM 更新 + Cesium billboard 更新
        _applyDragDOM(id, nx, ny);
        _lastDragPosRef.current = { x: nx, y: ny };
        // hSec FloatWin リアルタイム更新
        if (hSectionsRef.current.length > 0 && !hSecTickRafRef.current) {
          hSecTickRafRef.current = requestAnimationFrame(() => { hSecTickRafRef.current = null; setHSecTick(n => n + 1); });
        }
        // Cesium wire overlay 更新（world座標を直接渡す→drawDragFrameで正確投影）
        const _gz = allMapPosRef.current[id]?.z || 0;
        _updateCesiumWireOverlay(_wireOv3d, nx, ny, _gz);
        _updateCesiumWireOverlay(_wireOv2d, nx, ny, _gz);
      });
    };
    const up = () => {
      if (_rafId) cancelAnimationFrame(_rafId);
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      const fp = _lastDragPosRef.current;
      _lastDragPosRef.current = null;
      if (fp) {
        const _gz = allMapPosRef.current[id]?.z || 0;
        _pendingNonCesiumTeardownRef.current = {
          ov3d: _wireOv3d, ov2d: _wireOv2d,
          finalPos: { x: fp.x, y: fp.y, z: _gz },
          nodeId: id
        };
        setMapPos(pr => ({ ...pr, [id]: { x: fp.x, y: fp.y } }));
      } else {
        _teardownCesiumWireOverlay(_wireOv3d);
        _teardownCesiumWireOverlay(_wireOv2d);
        isDraggingRef.current = false;
      }
      movedNodeRef.current = id;
      setTimeout(() => { movedNodeRef.current = null; }, 3000);
      setFaceDirect(null);
      setFaceIconDown(null);
      iconDragging.current = false;
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => {
      if (_rafId) cancelAnimationFrame(_rafId);
      _pendingNonCesiumTeardownRef.current = null;
      isDraggingRef.current = false;
      _teardownCesiumWireOverlay(_wireOv3d);
      _teardownCesiumWireOverlay(_wireOv2d);
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
  }, [faceDirect]);

  // 投影ヘルパー: pzはグリッドpx単位 → METERS_PER_PXでメートル変換してproject3Dへ
  const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
  const proj = useCallback((px, py, pz) => project3D(px, py, (pz||0) * _mpp, camAz, camEl, camZoom, camPanX, camPanY), [camAz, camEl, camZoom, camPanX, camPanY]);
  const unproj = useCallback((sx, sy) => unproject3D(sx, sy, camAz, camEl, camZoom, camPanX, camPanY), [camAz, camEl, camZoom, camPanX, camPanY]);
  const resetCam = () => { const fit = calcAutoFit(DEF_AZ, DEF_EL, flatBlocks); setCamAz(DEF_AZ); setCamEl(DEF_EL); setCamZoom(fit.zoom); setCamPanX(fit.panX); setCamPanY(fit.panY); };
  const lookDown = () => {
    setCamEl(Math.PI / 2);
    setCamPanX(0);
    setCamPanY(0);
  };

  // フォーカスノード（カメラアイコンクリック時）
  const focusNode3dRef = useRef(null); // CesiumMap 3D用
  const focusNode2dRef = useRef(null); // CesiumMap 2D用
  const focusPos3dRef  = useRef(null); // 建屋面グリッド座標用 3D
  const focusPos2dRef  = useRef(null); // 建屋面グリッド座標用 2D

  const toP = (ref, e) => {
    if (!ref.current) return { x: 0, y: 0 };
    const r = ref.current.getBoundingClientRect();
    const ev = e.touches ? e.touches[0] : e;
    // CSSズーム補正
    const z = ref === planRef ? planZoom : ref === elevRef ? elevZoom : ref === sideRef ? sideZoom : ref === dRef ? diagZoom : 1;
    return { x: (ev.clientX - r.left) / z, y: (ev.clientY - r.top) / z };
  };

  // 2D点→線分の最短距離（JS hit detection 用）
  const _d2seg = (p, a, b) => {
    const dx = b.x-a.x, dy = b.y-a.y, l2 = dx*dx+dy*dy;
    if (!l2) return Math.sqrt((p.x-a.x)**2+(p.y-a.y)**2);
    const t = Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/l2));
    return Math.sqrt((a.x+t*dx-p.x)**2+(a.y+t*dy-p.y)**2);
  };

  // elev/side: CSSズームバグ回避のためJSで画面座標ベースのhit判定
  // 優先順: 折れ点四角(5px) > 中点黄丸(6px) > wire(cappedHit/2)
  const _jsHitDetect = (ev, ref, zoom, transform, setCursor) => {
    const p = toP(ref, ev);
    const _mz = zoom;
    const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
    let foundSeg = null, foundCursor = null, foundTip = null;
    // 詳細ログ用: 検知理由・ターゲット座標・wire位置
    let _logReason = null, _logTargetSvg = null, _logWireLen = null, _logWirePct = null, _logDetail = '';
    for (const seg of segs) {
      const a = allMapPos[seg.from], b = allMapPos[seg.to];
      if (!a || !b) continue;
      const wps = segWp[seg.id] || [], wzs = wpZRef.current[seg.id] || [];
      const pts3 = [
        { x: a.x, y: a.y, z: a.z || 0 },
        ...wps.map((w, i) => ({ x: w.x, y: w.y, z: wzs[i] || 0 })),
        { x: b.x, y: b.y, z: b.z || 0 }
      ];
      const tp = pts3.map(transform);
      // セグが60screen px未満の場合はfold/mid検知をスキップ（wireが短い→wireBody検知に委ねる）
      const MIN_HIT_PX = 60;
      // 折れ点ヒット（最優先）: 画面上±5px以内
      for (let i = 0; i < wps.length; i++) {
        const tw = tp[i + 1];
        const segLenPrev = Math.sqrt((tp[i+1].x-tp[i].x)**2+(tp[i+1].y-tp[i].y)**2);
        const segLenNext = tp[i+2] ? Math.sqrt((tp[i+2].x-tp[i+1].x)**2+(tp[i+2].y-tp[i+1].y)**2) : Infinity;
        // 隣接セグのどちらかが60screen px未満ならスキップ
        if (segLenPrev * _mz < MIN_HIT_PX || (tp[i+2] && segLenNext * _mz < MIN_HIT_PX)) continue;
        if (Math.abs(p.x-tw.x) <= 5/_mz && Math.abs(p.y-tw.y) <= 5/_mz) {
          let tot = 0, prevSegDist = 0, nextSegDist = 0;
          for (let k = 0; k < pts3.length-1; k++) {
            const ddx=(pts3[k+1].x-pts3[k].x)*_mpp, ddy=(pts3[k+1].y-pts3[k].y)*_mpp, ddz=pts3[k+1].z-pts3[k].z;
            const d = Math.sqrt(ddx*ddx+ddy*ddy+ddz*ddz);
            if (k === i) prevSegDist = d;
            if (k === i+1) nextSegDist = d;
            tot += d;
          }
          foundSeg = seg.id; foundCursor = 'grab';
          foundTip = { x: ev.clientX, y: ev.clientY, dist: tot, prevSegDist, nextSegDist };
          _logReason = `fold(wp=${i})`; _logTargetSvg = tw; _logWireLen = tot; _logWirePct = null;
          _logDetail = `hitHalf=±5px[SVG±${(5/_mz).toFixed(4)}] prevSeg=${(segLenPrev*_mz).toFixed(0)}px nextSeg=${(segLenNext===Infinity?'end':(segLenNext*_mz).toFixed(0)+'px')}`;
          break;
        }
      }
      if (foundSeg) break;
      // 中点ヒット: 画面上6px半径以内
      for (let si = 0; si < tp.length-1 && !foundSeg; si++) {
        const pa = tp[si], pb = tp[si+1];
        const segLen2d = Math.sqrt((pb.x-pa.x)**2+(pb.y-pa.y)**2);
        if (segLen2d * _mz < MIN_HIT_PX) continue;
        const midX = (pa.x+pb.x)/2, midY = (pa.y+pb.y)/2;
        const dist2mid = Math.sqrt((p.x-midX)**2+(p.y-midY)**2);
        if (dist2mid <= 6/_mz) {
          let tot = 0;
          for (let k = 0; k < pts3.length-1; k++) {
            const ddx=(pts3[k+1].x-pts3[k].x)*_mpp, ddy=(pts3[k+1].y-pts3[k].y)*_mpp, ddz=pts3[k+1].z-pts3[k].z;
            tot += Math.sqrt(ddx*ddx+ddy*ddy+ddz*ddz);
          }
          foundSeg = seg.id; foundCursor = 'grab';
          foundTip = { x: ev.clientX, y: ev.clientY, dist: tot };
          _logReason = `mid(si=${si})`; _logTargetSvg = {x:midX, y:midY}; _logWireLen = tot; _logWirePct = 50;
          _logDetail = `hitR=6px[SVG ${(6/_mz).toFixed(4)}] dist2mid=${(dist2mid*_mz).toFixed(1)}px segLen=${(segLen2d*_mz).toFixed(0)}px`;
        }
      }
      if (foundSeg) break;
      // wireセグメントヒット: cappedHit(常に12画面px以上)の半幅以内
      const _st = seg.isBus ? 5 : 3;
      const _cs = (_mz > 1) ? Math.min(_st, _st/_mz) : _st;
      const _ch = Math.max(_cs + 6/_mz, 12/_mz);
      let tot = 0;
      for (let k = 0; k < pts3.length-1; k++) {
        const ddx=(pts3[k+1].x-pts3[k].x)*_mpp, ddy=(pts3[k+1].y-pts3[k].y)*_mpp, ddz=pts3[k+1].z-pts3[k].z;
        tot += Math.sqrt(ddx*ddx+ddy*ddy+ddz*ddz);
      }
      for (let si = 0; si < tp.length-1 && !foundSeg; si++) {
        const d2w = _d2seg(p, tp[si], tp[si+1]);
        if (d2w <= _ch/2) {
          foundSeg = seg.id; foundCursor = 'pointer';
          // si番セグメントの3D距離
          const _sddx=(pts3[si+1].x-pts3[si].x)*_mpp, _sddy=(pts3[si+1].y-pts3[si].y)*_mpp, _sddz=pts3[si+1].z-pts3[si].z;
          const _segLen3d = Math.sqrt(_sddx*_sddx+_sddy*_sddy+_sddz*_sddz);
          foundTip = { x: ev.clientX, y: ev.clientY, dist: tot, segDist: _segLen3d };
          const _midSvg = {x:(tp[si].x+tp[si+1].x)/2, y:(tp[si].y+tp[si+1].y)/2};
          _logReason = `body(si=${si})`; _logTargetSvg = _midSvg; _logWireLen = tot; _logWirePct = null;
          _logDetail = `d2wire=${(d2w*_mz).toFixed(1)}px hitHalf=${(_ch/2*_mz).toFixed(1)}px[SVG ${(_ch/2).toFixed(4)}]`;
        }
      }
      if (foundSeg) break;
    }
    const viewName = ref === elevRef ? 'elev' : ref === sideRef ? 'side' : '?';
    const _r = ref.current ? ref.current.getBoundingClientRect() : null;
    // grab判定時のみ: 折れ点四角/黄色丸の画面領域とカーソル位置を比較
    if (foundSeg && foundCursor === 'grab' && _r && _logTargetSvg) {
      const _cx = Math.round(ev.clientX), _cy = Math.round(ev.clientY);
      const _sx = Math.round(_r.left + _logTargetSvg.x * _mz);
      const _sy = Math.round(_r.top  + _logTargetSvg.y * _mz);
      if (_logReason.startsWith('fold')) {
        // 折れ点四角: 中心±5px正方形
        const _dx = _cx - _sx, _dy = _cy - _sy;
        const _in = Math.abs(_dx) <= 5 && Math.abs(_dy) <= 5;
        console.log(`[GRAB ${_logReason}] 折れ点四角領域: 画面[${_sx-5},${_sy-5}]〜[${_sx+5},${_sy+5}] | マウス画面:(${_cx},${_cy}) | dx=${_dx}px dy=${_dy}px → ${_in ? 'IN✓' : 'OUT✗'}`);
      } else if (_logReason.startsWith('mid')) {
        // 黄色丸: 中心から半径6px
        const _dist = Math.sqrt((_cx-_sx)**2+(_cy-_sy)**2);
        const _in = _dist <= 6;
        console.log(`[GRAB ${_logReason}] 黄色丸領域: 画面中心(${_sx},${_sy})半径6px | マウス画面:(${_cx},${_cy}) | 距離=${_dist.toFixed(1)}px → ${_in ? 'IN✓' : 'OUT✗'}`);
      }
    }
    // [HIT pointer(body)] と [MISS] はログ量が多いためコメントアウト
    // if (foundSeg) {
    //   console.log(`[HIT] ${viewName} seg=${foundSeg} cursor=${foundCursor} 理由=${_logReason} | ...`);
    // } else {
    //   console.log(`[MISS] ${viewName} マウスSVG=(${p.x.toFixed(3)},${p.y.toFixed(3)}) zoom=${_mz.toFixed(1)}`);
    // }
    // planビューのdebounce(100ms遅延)が後から setHoverSeg(null) を上書きしないようキャンセル
    clearTimeout(_hoverSegDebounceRef.current);
    setHoverSeg(foundSeg);
    setWireTip(foundSeg ? foundTip : null);
    setCursor(foundCursor);
    // デバッグ可視化: fold→青円、mid→黄円 (スクリーン固定座標で描画)
    if (foundSeg && foundCursor === 'grab' && _logTargetSvg && _r) {
      const _isFold = _logReason.startsWith('fold');
      // 検知中心のスクリーン座標
      const _scx = _r.left + _logTargetSvg.x * _mz;
      const _scy = _r.top  + _logTargetSvg.y * _mz;
      // 外円: JS検知範囲 (fold=5px正方形の外接円、mid=6px円)
      const _detectR = _isFold ? 5 * Math.SQRT2 : 6;
      // 内円: SVGのhit rect/circle サイズ (fold=5px半幅の正方形、mid=6px円) = 検知範囲と同一
      const _hitR = _isFold ? 5 : 6;
      setJsHitDebug({ scx: _scx, scy: _scy, detectR: _detectR, hitR: _hitR, type: _isFold ? 'fold' : 'mid' });
    } else {
      setJsHitDebug(null);
    }
  };

  // O(1)セグ検索Map（segs変化時のみ再計算）
  const segById = useMemo(() => { const m = {}; segs.forEach(s => { m[s.id] = s; }); return m; }, [segs]);
  // O(1)ノード検索Map（nodes変化時のみ再計算）- 単線結線図 segs.map内のnodes.findをO(1)化
  const nodeById = useMemo(() => { const m = {}; nodes.forEach(n => { m[n.id] = n; }); return m; }, [nodes]);
  // ノードID→接続セグリスト Map（perpSnapループを全segs→接続segsのみに絞る）
  const connectedSegsMap = useMemo(() => {
    const m = {};
    segs.forEach(s => {
      if (!m[s.from]) m[s.from] = [];
      if (!m[s.to])   m[s.to]   = [];
      m[s.from].push(s); m[s.to].push(s);
    });
    return m;
  }, [segs]);
  const connectedSegsMapRef = useRef(connectedSegsMap); connectedSegsMapRef.current = connectedSegsMap;

  const allMapPos = useMemo(() => {
    const r = {};
    nodes.forEach(n => { if (n.kind !== "on_seg" && mapPos[n.id]) r[n.id] = { ...mapPos[n.id], z: mapZ[n.id] || 0 }; });
    nodes.filter(n => n.kind === "on_seg").forEach(n => {
      const seg = segById[n.segId]; if (!seg) return;   // O(n)→O(1)
      const aP = r[seg.from], bP = r[seg.to]; if (!aP || !bP) return;
      const lp = lerp2(aP, bP, onSegT[n.id] != null ? onSegT[n.id] : n.t);
      r[n.id] = { ...lp, z: mapZ[n.id] != null ? mapZ[n.id] : lp.z };
    });
    return r;
  }, [nodes, segById, mapPos, mapZ, onSegT]);

  // useDeferredValueを廃止：遅延によりcbRef._allMapPosが旧位置で上書きされてpostRenderがフラッシュする問題を根本解決
  const cesiumAllMapPos = allMapPos;

  // stale-safe ref: elevDrag/sideDrag mv 関数がクロージャで最新値を参照するため
  const mapZRef = useRef(mapZ); mapZRef.current = mapZ;
  const segsRef = useRef(segs); segsRef.current = segs;
  const wpZRef  = useRef(wpZ);  wpZRef.current  = wpZ;
  const segWpRef = useRef(segWp); segWpRef.current = segWp;
  const onSegTRef = useRef(onSegT); onSegTRef.current = onSegT;
  // DOM直接操作用 ref
  const sectionsRef  = useRef([]); // 矢視図セクション一覧（ドラッグ中に参照）
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  const cesium3dUpdateRef = useRef(null); // Cesium 3D アイコン直接更新関数
  const cesium2dUpdateRef = useRef(null); // Cesium 2D アイコン直接更新関数
  const cesium3dQueryRef  = useRef(null); // Cesium 3D ドラッグオーバーレイ用クエリ関数
  const cesium2dQueryRef  = useRef(null); // Cesium 2D ドラッグオーバーレイ用クエリ関数
  // 直前に動かしたアイコンID（sampleHeightMostDetailedをそのwireのみに絞る）
  const movedNodeRef = useRef(null);
  const cesium3dRenderRef = useRef(null); // Cesium 3D requestRender（mouseUp時のみ使用）
  const cesium2dRenderRef = useRef(null); // Cesium 2D requestRender
  const isDraggingRef     = useRef(false); // ドラッグ中フラグ（CesiumMapの重いeffectをスキップ）
  const _lastDragPosRef   = useRef(null); // ドラッグ中の最終座標（mouseUp用）
  const _elevLivePosRef   = useRef(null); // elev drag中の座標（x,z）
  const _sideLivePosRef   = useRef(null); // side drag中の座標（y,z）
  const mapDragRef        = useRef(null); // 命令型drag管理（setMapDragのReact再描画を回避）
  // ドラッグ中にカーソルが重なっているアイコンID（snapの相手。setHoverId不使用でReact再描画なし）
  const nearbyIconRef = useRef(null);
  // ドラッグ開始時に1回だけ計算する定数キャッシュ（毎rAFでのoffsetWidth強制レイアウト防止）
  const _dragGeomCache = useRef(null);
  const _cesiumOvUpdateRef = useRef(null); // side/elevドラッグ中Cesiumオーバーレイ更新関数
  const _elevSegsRef  = useRef(null); // ドラッグ中フリーズ用キャッシュ
  const _sideSegsRef  = useRef(null);
  const _elevNodesRef = useRef(null);
  const _sideNodesRef = useRef(null);
  const _cabNodesRef  = useRef(null);
  const allMapPosRef = useRef(allMapPos); allMapPosRef.current = allMapPos;
  hSectionsRef.current = hSections;
  hSecDragRef.current = hSecDrag;
  hSecZoomsRef.current = hSecZooms;
  const planWpSnapRef   = useRef(null); // 平面図wpDrag: スナップアイコン {iconId, type:"pn"|"x"|"both"}
  const planIconSnapRef = useRef(null); // 平面図mapDrag: スナップアイコン {iconId, type}
  const wpPerpPlanRef   = useRef(null); // 平面図wpDrag直角マーク {svgX, svgY, dAx, dAy, dBx, dBy}
  const mapDragOffsetRef = useRef({ x: 0, y: 0 }); // ドラッグ開始時のカーソル-アイコン間オフセット

  // フォーカスノード（カメラアイコンクリック時） — 全ビューをアニメーション付きでフォーカス
  const focusNode = useCallback((nodeId) => {
    // 既存アニメーションをキャンセル
    if (cab3dAnimCancelRef.current) cab3dAnimCancelRef.current();
    if (focusAnimCancelRef.current) focusAnimCancelRef.current();

    const pos = allMapPos[nodeId]; if (!pos) return;

    // Cesium 3D/2D は自前のfly処理あり
    if (focusNode3dRef.current) focusNode3dRef.current(nodeId);
    if (focusNode2dRef.current) focusNode2dRef.current(nodeId);

    const DURATION = 600;
    const FOCUS_ZOOM = 3.0; // フォーカス時の最低zoom倍率（それ以上なら維持）

    // 3次元図: アイコンを中心にズーム維持（最低FOCUS_ZOOM）
    const targetCamZoom = Math.max(camZoomRef.current, FOCUS_ZOOM);
    const p3 = project3D(pos.x, pos.y, (pos.z||0) * _mpp, camAzRef.current, camElRef.current, targetCamZoom, 0, 0);
    const targetCamPanX = CAB_W / 2 - p3.x, targetCamPanY = CAB_H / 2 - p3.y;
    if (!isFinite(targetCamPanX) || !isFinite(targetCamPanY)) return;

    // スクロールコンテナ
    const planSc = planRef.current?.parentElement?.parentElement;
    const elevSc = elevRef.current?.parentElement?.parentElement;
    const sideSc = sideRef.current?.parentElement?.parentElement;

    // 各ビュー目標ズーム（アイコン自身を中心、最低FOCUS_ZOOM）
    const targetPlanZ = Math.max(planZoomRef.current, FOCUS_ZOOM);
    const targetElevZ = Math.max(elevZoomRef.current, FOCUS_ZOOM);
    const targetSideZ = Math.max(sideZoomRef.current, FOCUS_ZOOM);

    // 開始値スナップショット
    const z0cam = camZoomRef.current, px0 = camPanXRef.current, py0 = camPanYRef.current;
    const z0plan = planZoomRef.current, z0elev = elevZoomRef.current, z0side = sideZoomRef.current;

    // 初期スクロール位置 + 目標スクロール位置（最終ズームで計算）
    // ズーム変化がない2回目以降もスクロールを補間してアニメーションさせる
    const planSl0 = planSc ? planSc.scrollLeft : 0, planSt0 = planSc ? planSc.scrollTop : 0;
    const elevSl0 = elevSc ? elevSc.scrollLeft : 0, elevSt0 = elevSc ? elevSc.scrollTop : 0;
    const sideSl0 = sideSc ? sideSc.scrollLeft : 0, sideSt0 = sideSc ? sideSc.scrollTop : 0;
    // 回転を考慮した座標変換: rotate(deg)でコンテンツ点(cx,cy)がどこに見えるか
    const _rp = (cx, cy, deg, px, py) => {
      if (!deg) return { x: cx, y: cy };
      const r = deg * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
      return { x: px + (cx-px)*co - (cy-py)*si, y: py + (cx-px)*si + (cy-py)*co };
    };
    const _planRot = _rp(pos.x, pos.y, planRotateRef.current, planRotOrgRef.current.x, planRotOrgRef.current.y);
    const planSlT = planSc ? VIEW_PAD + _planRot.x * targetPlanZ - planSc.clientWidth  / 2 : 0;
    const planStT = planSc ? VIEW_PAD + _planRot.y * targetPlanZ - planSc.clientHeight / 2 : 0;
    const _elevRot = _rp(pos.x, GL_Y-(pos.z||0), elevRotateRef.current, elevRotOrgRef.current.x, elevRotOrgRef.current.y);
    const elevSlT = elevSc ? VIEW_PAD + _elevRot.x * targetElevZ - elevSc.clientWidth  / 2 : 0;
    const elevStT = elevSc ? VIEW_PAD + _elevRot.y * targetElevZ - elevSc.clientHeight / 2 : 0;
    const _sideRot = _rp(pos.y, GL_Y-(pos.z||0), sideRotateRef.current, sideRotOrgRef.current.x, sideRotOrgRef.current.y);
    const sideSlT = sideSc ? VIEW_PAD + _sideRot.x * targetSideZ - sideSc.clientWidth  / 2 : 0;
    const sideStT = sideSc ? VIEW_PAD + _sideRot.y * targetSideZ - sideSc.clientHeight / 2 : 0;

    // 矢視図: アニメーション対象を収集（ノードが含まれる断面のみ）
    const secTargets = [];
    sectionsRef.current.forEach(_sec => {
      const vd = secViewDataRef.current[_sec.id]; if (!vd) return;
      // vdにはレンダリング時のOBBパラメータが入っている → sectionsRefの保存時pnRadより信頼できる
      const sec = (vd.center !== undefined)
        ? { ..._sec, viewEdge: vd.viewEdge, center: vd.center, halfA: vd.halfA, halfB: vd.halfB, pnRad: vd.secPnRad }
        : _sec;
      const p = projectToSection(sec, pos.x, pos.y, pos.z || 0);
      if (p.depth < 0 || p.depth > p.totalDepth) return;
      const secEl = secRefs.current[_sec.id]?.el; if (!secEl) return;
      const scEl = secEl.parentElement; if (!scEl) return;
      const z0Sec = secZoomsRef.current[_sec.id] || 1;
      const tSecZ = Math.max(z0Sec, 1.0); // 矢視図: 現在倍率維持、最小等倍のみ保証
      const tX = vd.SPD + p.along, tY = vd.dynSecGLY - (pos.z || 0);
      // margin:auto + overflow → コンテンツは左端基準、標準スクロール式
      const _secDeg = -(secRotatesRef.current[_sec.id]||0);
      const _secPivX = (vd.dynSEC_W||300)/2, _secPivY = vd.dynSecGLY||0;
      const _secRp = _rp(tX, tY, _secDeg, _secPivX, _secPivY);
      secTargets.push({
        secId: _sec.id, secEl, scEl,
        z0Sec, targetSecZ: tSecZ,
        scroll0: { l: scEl.scrollLeft, t: scEl.scrollTop },
        slT: _secRp.x * tSecZ - scEl.clientWidth  / 2,
        stT: _secRp.y * tSecZ - scEl.clientHeight / 2,
      });
    });

    // 水平断面図: ノードが表示されているhSecを収集
    const hSecTargets = [];
    hSectionsRef.current.forEach(hs => {
      const liveZ = hSecLiveZRef.current[hs.id] ?? hs.zPx;
      if (Math.abs((pos.z || 0) - liveZ) > MAJOR / 2) return;
      const scEl = hSecScrollRefs.current[hs.id]; if (!scEl) return;
      const curZ = hSecZoomsRef.current[hs.id] || 1;
      hSecTargets.push({
        scEl, curZ,
        scroll0: { l: scEl.scrollLeft, t: scEl.scrollTop },
        slT: 40 + pos.x * curZ - scEl.clientWidth  / 2,
        stT: 40 + pos.y * curZ - scEl.clientHeight / 2,
      });
    });

    const ease = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    const t0 = performance.now();
    let _cancelled = false;
    focusAnimCancelRef.current = () => { _cancelled = true; };

    const step = (now) => {
      if (_cancelled) { focusAnimCancelRef.current = null; return; }
      const t = Math.min(1, (now - t0) / DURATION);
      const e = ease(t);

      // 3次元図
      setCamZoom(z0cam + (targetCamZoom - z0cam) * e);
      setCamPanX(px0   + (targetCamPanX - px0)   * e);
      setCamPanY(py0   + (targetCamPanY - py0)   * e);

      // 平面図・断面図・側面図:
      // スクロールは初期値→目標値を独立補間（ズーム変化なしの2回目以降も動くよう）
      const cPlanZ = z0plan + (targetPlanZ - z0plan) * e;
      const cElevZ = z0elev + (targetElevZ - z0elev) * e;
      const cSideZ = z0side + (targetSideZ - z0side) * e;
      if (planRef.current) planRef.current.style.zoom = cPlanZ;
      if (planSc) {
        planSc.scrollLeft = planSl0 + (planSlT - planSl0) * e;
        planSc.scrollTop  = planSt0 + (planStT - planSt0) * e;
      }
      if (elevRef.current) elevRef.current.style.zoom = cElevZ;
      if (elevSc) {
        elevSc.scrollLeft = elevSl0 + (elevSlT - elevSl0) * e;
        elevSc.scrollTop  = elevSt0 + (elevStT - elevSt0) * e;
      }
      if (sideRef.current) sideRef.current.style.zoom = cSideZ;
      if (sideSc) {
        sideSc.scrollLeft = sideSl0 + (sideSlT - sideSl0) * e;
        sideSc.scrollTop  = sideSt0 + (sideStT - sideSt0) * e;
      }
      setPlanZoom(cPlanZ); setElevZoom(cElevZ); setSideZoom(cSideZ);

      // 矢視図: DOM直接操作＋React state更新
      if (secTargets.length > 0) {
        const secZoomUpdates = {};
        secTargets.forEach(({ secId, secEl, scEl, z0Sec, targetSecZ, scroll0, slT, stT }) => {
          const cSecZ = z0Sec + (targetSecZ - z0Sec) * e;
          secEl.style.zoom = cSecZ;
          scEl.scrollLeft = scroll0.l + (slT - scroll0.l) * e;
          scEl.scrollTop  = scroll0.t + (stT - scroll0.t) * e;
          secZoomUpdates[secId] = cSecZ;
        });
        setSecZooms(prev => ({ ...prev, ...secZoomUpdates }));
      }

      // 水平断面図: スクロールアニメーション
      hSecTargets.forEach(({ scEl, scroll0, slT, stT }) => {
        scEl.scrollLeft = scroll0.l + (slT - scroll0.l) * e;
        scEl.scrollTop  = scroll0.t + (stT - scroll0.t) * e;
      });

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        focusAnimCancelRef.current = null;
      }
    };

    requestAnimationFrame(step);
  }, [allMapPos, sections]);

  // 建屋面カメラアイコン用: グリッド座標+建屋バウンディングボックスで各ビューをフォーカス
  // bounds = { bxMin, bxMax, byMin, byMax, bzMin, bzMax } (すべてグリッドpx)
  const focusGridPos = useCallback((gx, gy, gz, bounds) => {
    // 既存アニメーションをキャンセル
    if (cab3dAnimCancelRef.current) cab3dAnimCancelRef.current();
    if (focusAnimCancelRef.current) focusAnimCancelRef.current();

    const MARGIN = 0.65;
    const CAB_FOCUS_ZOOM = 2.5;
    const DURATION = 600;

    // Cesium 3D/2D は自前のfly処理あり → そのまま呼ぶ
    if (focusPos3dRef.current) focusPos3dRef.current(gx, gy, gz);
    if (focusPos2dRef.current) focusPos2dRef.current(gx, gy, gz);

    // 建屋中心
    const bcx = bounds ? (bounds.bxMin + bounds.bxMax) / 2 : gx;
    const bcy = bounds ? (bounds.byMin + bounds.byMax) / 2 : gy;
    const bcz = bounds ? (bounds.bzMin + bounds.bzMax) / 2 : (gz || 0);

    // スクロールコンテナ
    const planSc = planRef.current?.parentElement?.parentElement;
    const elevSc = elevRef.current?.parentElement?.parentElement;
    const sideSc = sideRef.current?.parentElement?.parentElement;

    // 目標ズーム算出
    const fitZoom = (vw, vh, bw, bh) =>
      Math.max(0.1, Math.min(8, Math.min(vw * MARGIN / (bw || 1), vh * MARGIN / (bh || 1))));
    const targetPlanZ = (planSc && bounds)
      ? fitZoom(planSc.clientWidth, planSc.clientHeight, bounds.bxMax - bounds.bxMin, bounds.byMax - bounds.byMin)
      : 2.0;
    const targetElevZ = (elevSc && bounds)
      ? fitZoom(elevSc.clientWidth, elevSc.clientHeight, bounds.bxMax - bounds.bxMin, bounds.bzMax - bounds.bzMin)
      : 2.0;
    const targetSideZ = (sideSc && bounds)
      ? fitZoom(sideSc.clientWidth, sideSc.clientHeight, bounds.byMax - bounds.byMin, bounds.bzMax - bounds.bzMin)
      : 2.0;

    // 3次元図目標（camRef使用: クロージャ汚染なし）
    const p = project3D(gx, gy, gz || 0, camAzRef.current, camElRef.current, CAB_FOCUS_ZOOM, 0, 0);
    const targetCamZoom = CAB_FOCUS_ZOOM;
    const targetCamPanX = CAB_W / 2 - p.x;
    const targetCamPanY = CAB_H / 2 - p.y;
    if (!isFinite(targetCamPanX) || !isFinite(targetCamPanY)) return;

    // 開始値スナップショット
    const z0cam = camZoomRef.current, px0 = camPanXRef.current, py0 = camPanYRef.current;
    const z0plan = planZoomRef.current, z0elev = elevZoomRef.current, z0side = sideZoomRef.current;
    const dCamZoom = targetCamZoom - z0cam;
    const dCamPX   = targetCamPanX - px0;
    const dCamPY   = targetCamPanY - py0;
    const dPlanZ   = targetPlanZ   - z0plan;
    const dElevZ   = targetElevZ   - z0elev;
    const dSideZ   = targetSideZ   - z0side;

    const ease = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    const t0 = performance.now();
    let _cancelled = false;
    focusAnimCancelRef.current = () => { _cancelled = true; };

    const step = (now) => {
      if (_cancelled) { focusAnimCancelRef.current = null; return; }
      const t = Math.min(1, (now - t0) / DURATION);
      const e = ease(t);

      // 3次元図: setCam系（React state → SVG再描画）
      setCamZoom(z0cam + dCamZoom * e);
      setCamPanX(px0   + dCamPX   * e);
      setCamPanY(py0   + dCamPY   * e);

      // 2Dビュー: DOM直接操作でスムーズに（React stateよりラグなし）
      const cPlanZ = z0plan + dPlanZ * e;
      const cElevZ = z0elev + dElevZ * e;
      const cSideZ = z0side + dSideZ * e;
      if (planRef.current) planRef.current.style.zoom = cPlanZ;
      if (planSc) {
        planSc.scrollLeft = VIEW_PAD + bcx          * cPlanZ - planSc.clientWidth  / 2;
        planSc.scrollTop  = VIEW_PAD + bcy          * cPlanZ - planSc.clientHeight / 2;
      }
      if (elevRef.current) elevRef.current.style.zoom = cElevZ;
      if (elevSc) {
        elevSc.scrollLeft = VIEW_PAD + bcx          * cElevZ - elevSc.clientWidth  / 2;
        elevSc.scrollTop  = VIEW_PAD + (GL_Y - bcz) * cElevZ - elevSc.clientHeight / 2;
      }
      if (sideRef.current) sideRef.current.style.zoom = cSideZ;
      if (sideSc) {
        sideSc.scrollLeft = VIEW_PAD + bcy          * cSideZ - sideSc.clientWidth  / 2;
        sideSc.scrollTop  = VIEW_PAD + (GL_Y - bcz) * cSideZ - sideSc.clientHeight / 2;
      }

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        // 完了: Reactステートをターゲット値に同期（useLayoutEffectはscrollUpdateRef=nullのため無動作）
        planZoomRef.current = targetPlanZ;
        elevZoomRef.current = targetElevZ;
        sideZoomRef.current = targetSideZ;
        setPlanZoom(targetPlanZ);
        setElevZoom(targetElevZ);
        setSideZoom(targetSideZ);
        focusAnimCancelRef.current = null;
      }
    };

    requestAnimationFrame(step);
  }, []);

  // 3次元図カメラを真上（el=90°）にアニメーション
  const focusCabTopView = useCallback(() => {
    if (focusAnimCancelRef.current) focusAnimCancelRef.current();
    const el0 = camElRef.current;
    const dEl = Math.PI / 2 - el0;
    if (Math.abs(dEl) < 0.01) return;
    const DURATION = 400;
    const ease = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    const t0 = performance.now();
    let _cancelled = false;
    focusAnimCancelRef.current = () => { _cancelled = true; };
    const step = (now) => {
      if (_cancelled) { focusAnimCancelRef.current = null; return; }
      const t = Math.min(1, (now - t0) / DURATION);
      setCamEl(el0 + dEl * ease(t));
      if (t < 1) requestAnimationFrame(step);
      else { camElRef.current = Math.PI / 2; focusAnimCancelRef.current = null; }
    };
    requestAnimationFrame(step);
  }, []);

  // 建屋IDからbounds+中心を計算してfocusGridPosを呼ぶ
  const focusBld = useCallback((bid) => {
    const blds = flatBlocks.filter(b => b.buildingId === bid);
    if (!blds.length) return;
    const bounds = {
      bxMin: Math.min(...blds.map(b => b.pxMinX)),
      bxMax: Math.max(...blds.map(b => b.pxMaxX)),
      byMin: Math.min(...blds.map(b => b.pxMinY)),
      byMax: Math.max(...blds.map(b => b.pxMaxY)),
      bzMin: Math.min(...blds.map(b => b.zBottom || 0)),
      bzMax: Math.max(...blds.map(b => b.zTop || 40)),
    };
    const cx = (bounds.bxMin + bounds.bxMax) / 2;
    const cy = (bounds.byMin + bounds.byMax) / 2;
    const cz = (bounds.bzMin + bounds.bzMax) / 2;

    // 矢視図: 建屋が含まれる sec にアニメーションでスクロール＆ズーム
    if (secFocusAnimCancelRef.current) secFocusAnimCancelRef.current();
    const secAnimTargets = [];
    sections.forEach(sec => {
      const vd = secViewDataRef.current[sec.id];
      if (!vd) return;
      const secEl = secRefs.current[sec.id]?.el;
      const scEl = secEl?.parentElement;
      if (!scEl) return;
      const validPts = [];
      blds.forEach(b => {
        [[b.pxMinX, b.pxMinY], [b.pxMaxX, b.pxMinY], [b.pxMaxX, b.pxMaxY], [b.pxMinX, b.pxMaxY]].forEach(([bx, by]) => {
          const p = projectToSection(sec, bx, by, 0);
          if (p.depth >= 0 && p.depth <= p.totalDepth)
            validPts.push({ along: p.along, zBot: b.zBottom || 0, zTop: b.zTop });
        });
      });
      if (validPts.length === 0) return;
      const minA = Math.min(...validPts.map(p => p.along));
      const maxA = Math.max(...validPts.map(p => p.along));
      const minZ = Math.min(...validPts.map(p => p.zBot));
      const maxZ = Math.max(...validPts.map(p => p.zTop));
      const cA = (minA + maxA) / 2, cZworld = (minZ + maxZ) / 2;
      const { SPD, dynSecGLY } = vd;
      const MARGIN = 0.65;
      const bw = maxA - minA || 1, bh = maxZ - minZ || 1;
      const tZ = Math.max(0.1, Math.min(8, Math.min(scEl.clientWidth * MARGIN / bw, scEl.clientHeight * MARGIN / bh)));
      const z0 = secZoomsRef.current[sec.id] || 1;
      secAnimTargets.push({ secId: sec.id, secEl, scEl, SPD, dynSecGLY, cA, cZworld, tZ, z0 });
    });
    if (secAnimTargets.length > 0) {
      const DURATION = 600;
      const ease = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      const t0sec = performance.now();
      let _secCancelled = false;
      secFocusAnimCancelRef.current = () => { _secCancelled = true; };
      const stepSec = (now) => {
        if (_secCancelled) { secFocusAnimCancelRef.current = null; return; }
        const t = Math.min(1, (now - t0sec) / DURATION);
        const e = ease(t);
        secAnimTargets.forEach(({ secEl, scEl, SPD, dynSecGLY, cA, cZworld, tZ, z0 }) => {
          const cZ = z0 + (tZ - z0) * e;
          secEl.style.zoom = cZ;
          scEl.scrollLeft = (SPD + cA) * cZ - scEl.clientWidth / 2;
          scEl.scrollTop  = (dynSecGLY - cZworld) * cZ - scEl.clientHeight / 2;
        });
        if (t < 1) {
          requestAnimationFrame(stepSec);
        } else {
          const updates = {};
          secAnimTargets.forEach(({ secId, tZ }) => { updates[secId] = tZ; });
          setSecZooms(prev => ({ ...prev, ...updates }));
          secFocusAnimCancelRef.current = null;
        }
      };
      requestAnimationFrame(stepSec);
    }

    focusGridPos(cx, cy, cz, bounds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatBlocks, focusGridPos, sections]);

  // 建屋選択バッジ（📷 / ×）をHTMLオーバーレイで描画
  // cssX/cssY: SVGと同じCSS px座標（zoom前）
  // invZoom = 1/viewZoom: CSS pxで逆補正 → 親のzoomで画面上は一定サイズに見える
  // zoom: CSS プロパティは使わず、width/height/fontSize を invZoom 倍にすることで対応
  // （zoom+transform の複合で position:absolute がずれるブラウザ挙動を回避）
  const renderBldBadgesHTML = (bid, cssX, cssY, invZoom) => {
    const sz = Math.round(22 * invZoom);
    const fs = Math.round(14 * invZoom);
    const gap = Math.round(6 * invZoom);
    const totalW = sz * 2 + gap;
    return (
      <div style={{
        position: 'absolute',
        left: cssX - totalW / 2,
        top: cssY - sz - Math.round(6 * invZoom),
        zIndex: 60, display: 'flex', gap: gap, pointerEvents: 'none'
      }}>
        <div onMouseDown={e => { e.stopPropagation(); e.preventDefault();
            setBuildings(bs => bs.filter(b => b.id !== bid));
            setSelectedBld(null); setSelectedBldView(null); setHovBldId(null); setHovBldView(null);
          }}
          style={{ width: sz, height: sz, borderRadius: '50%', background: 'rgba(239,68,68,0.85)',
            color: '#fff', fontWeight: 700, fontSize: fs, display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', pointerEvents: 'auto', userSelect: 'none',
            boxShadow: '0 1px 4px rgba(0,0,0,0.5)', flexShrink: 0 }}>×</div>
        <div onMouseDown={e => { e.stopPropagation(); e.preventDefault(); focusBld(bid); }}
          style={{ width: sz, height: sz, borderRadius: '50%', background: 'rgba(15,23,42,0.82)',
            fontSize: Math.round(13 * invZoom), display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', pointerEvents: 'auto', userSelect: 'none',
            boxShadow: '0 1px 4px rgba(0,0,0,0.5)', flexShrink: 0 }}>📷</div>
      </div>
    );
  };

  // auto free branch
  const prevAR = useRef("");
  useEffect(() => {
    // 配置済みsymbolの「数」が変わっていなければ早期リターン（drop/deleteがない限り変化しない）
    const posSymbols = nodes.filter(n => n.kind === "symbol" && mapPos[n.id]);
    const quickSk = posSymbols.length + ':' + posSymbols.map(n => n.id).sort().join(",");
    if (quickSk === prevAR.current) return; prevAR.current = quickSk;
    const up = {};
    nodes.filter(n => n.kind === "free" && !mapPos[n.id]).forEach(nd => {
      const nb = []; segs.forEach(s => { if (s.from === nd.id && mapPos[s.to]) nb.push(mapPos[s.to]); if (s.to === nd.id && mapPos[s.from]) nb.push(mapPos[s.from]); });
      if (nb.length >= 2) up[nd.id] = snap(nb.reduce((s, p) => s + p.x, 0) / nb.length, nb.reduce((s, p) => s + p.y, 0) / nb.length);
    });
    if (Object.keys(up).length > 0) setMapPos(prev => ({ ...prev, ...up }));
  }, [nodes, segs, mapPos]);

  // diagram drag
  useEffect(() => {
    if (!diagDrag) return;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const mv = ev => { const p = toP(dRef, ev); setNodes(pr => pr.map(n => n.id === diagDrag.id ? { ...n, dPos: { x: cl(p.x, 10, diagWRef.current - 10), y: cl(p.y, 10, diagHRef.current - 10) } } : n)); };
    const up = () => setDiagDrag(null);
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [diagDrag]);

  // 範囲選択: 範囲外でのmouseupを捕捉（dRef外でもmouseup時点の矩形で選択確定）
  useEffect(() => {
    if (!selRect) return;
    const mv = (e) => {
      const p = toP(dRef, e);
      setSelRect(prev => prev ? { ...prev, x2: p.x, y2: p.y } : null);
    };
    const up = () => {
      const sr = selRectRef.current;
      if (!sr) return;
      const x1 = Math.min(sr.x1, sr.x2), x2 = Math.max(sr.x1, sr.x2);
      const y1 = Math.min(sr.y1, sr.y2), y2 = Math.max(sr.y1, sr.y2);
      if (x2 - x1 > 5 || y2 - y1 > 5) {
        const sel = new Set();
        nodesRef.current.filter(n => n.kind !== "on_seg").forEach(n => {
          if (n.dPos.x >= x1 && n.dPos.x <= x2 && n.dPos.y >= y1 && n.dPos.y <= y2) sel.add(n.id);
        });
        setSelected(sel);
      } else {
        setSelected(new Set());
      }
      setSelRect(null);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
  }, [!!selRect]);

  // plan/cab/elev drop
  const handleDrop = (view) => (e) => {
    e.preventDefault(); const id = e.dataTransfer?.getData("text/plain"); if (!id) return;
    const ref = view === "plan" ? planRef : view === "cab" ? cabRef : view === "side" ? sideRef : elevRef;
    // plan: getBoundingClientRect のサイズ比からコンテンツ座標を算出（CSS zoom/scroll に依存しない）
    let p;
    if (view === "plan" && planRef.current) {
      const r = planRef.current.getBoundingClientRect();
      p = {
        x: (e.clientX - r.left) * TW / (r.width || TW),
        y: (e.clientY - r.top) * TH / (r.height || TH),
      };
    } else {
      p = toP(ref, e);
    }
    const ids = selected.size > 0 && selected.has(id) ? [...selected] : [id];
    const baseNode = nodes.find(n => n.id === id);
    if (!baseNode) return;

    // 選択ノードの単結上のバウンディングボックスを計算
    const selNodes = ids.map(nid => nodes.find(n => n.id === nid)).filter(n => n && n.kind !== "on_seg");
    if (selNodes.length === 0) return;
    const dxs = selNodes.map(n => n.dPos.x - baseNode.dPos.x);
    const dys = selNodes.map(n => n.dPos.y - baseNode.dPos.y);
    const spanX = Math.max(...dxs) - Math.min(...dxs);
    const spanY = Math.max(...dys) - Math.min(...dys);

    // ドロップ先ウィンドウの表示サイズ（スクロール含む表示領域）
    const winW = ref.current ? ref.current.clientWidth : 300;
    const winH = ref.current ? ref.current.clientHeight : 200;
    const margin = 0.7; // 表示領域の70%に収める

    // スケール: 単結のピクセル差 → ワールド座標差
    let scale = 1;
    if (selNodes.length > 1 && (spanX > 0 || spanY > 0)) {
      const fitW = spanX > 0 ? (winW * margin) / spanX : Infinity;
      const fitH = spanY > 0 ? (winH * margin) / spanY : Infinity;
      scale = Math.min(fitW, fitH, 3);
    }

    // 相対オフセット計算
    const offsets = selNodes.map(nd => ({
      id: nd.id,
      dx: (nd.dPos.x - baseNode.dPos.x) * scale,
      dy: (nd.dPos.y - baseNode.dPos.y) * scale,
    }));

    React.startTransition(() => { // ← ドロップ確定をlowPriorityに → UIが固まらない
    if (view === "plan" || view === "cab") {
      const pp = view === "cab" ? unproj(p.x, p.y) : p;
      let bx = pp.x, by = pp.y;
      // 全ノードのBBOXを計算してウィンドウ内にクランプ
      const xs = offsets.map(o => bx + o.dx), ys = offsets.map(o => by + o.dy);
      const pad = 20;
      if (Math.min(...xs) < pad) bx += pad - Math.min(...xs);
      if (Math.max(...xs) > TW - pad) bx -= Math.max(...xs) - (TW - pad);
      if (Math.min(...ys) < pad) by += pad - Math.min(...ys);
      if (Math.max(...ys) > TH - pad) by -= Math.max(...ys) - (TH - pad);
      setMapPos(pr => {
        const up = { ...pr };
        offsets.forEach(o => { up[o.id] = snapFine(bx + o.dx, by + o.dy, planZoom); });
        return up;
      });
      // 平面図・3次元図へのドロップは地上(z=0)に配置
      if (view === "plan") {
        setMapZ(pr => { const up = { ...pr }; selNodes.forEach(nd => { up[nd.id] = 0; }); return up; });
      }
    } else if (view === "elev") {
      let wx = snapFineV(p.x, elevZoom);
      const wz = Math.max(MIN_Z, Math.min(MAX_Z, snapFineV(GL_Y - p.y, elevZoom)));
      const xs = offsets.map(o => wx + o.dx);
      const pad = 20;
      if (Math.min(...xs) < pad) wx += pad - Math.min(...xs);
      if (Math.max(...xs) > TW - pad) wx -= Math.max(...xs) - (TW - pad);
      setMapPos(pr => {
        const up = { ...pr };
        offsets.forEach(o => {
          const wy = up[o.id] ? up[o.id].y : TH / 2;
          up[o.id] = { x: Math.max(0, Math.min(TW, snapFineV(wx + o.dx, elevZoom))), y: wy };
        });
        return up;
      });
      setMapZ(pr => { const up = { ...pr }; selNodes.forEach(nd => { up[nd.id] = wz; }); return up; });
    } else if (view === "side") {
      let wy = snapFineV(p.x, sideZoom);
      const wz = Math.max(MIN_Z, Math.min(MAX_Z, snapFineV(GL_Y - p.y, sideZoom)));
      const ys = offsets.map(o => wy + o.dy);
      const pad = 20;
      if (Math.min(...ys) < pad) wy += pad - Math.min(...ys);
      if (Math.max(...ys) > TH - pad) wy -= Math.max(...ys) - (TH - pad);
      setMapPos(pr => {
        const up = { ...pr };
        offsets.forEach(o => {
          const wx = up[o.id] ? up[o.id].x : TW / 2;
          up[o.id] = { x: wx, y: Math.max(0, Math.min(TH, snapFineV(wy + o.dy, sideZoom))) };
        });
        return up;
      });
      setMapZ(pr => { const up = { ...pr }; selNodes.forEach(nd => { up[nd.id] = wz; }); return up; });
    } else if (view.startsWith("sec")) {
      const sec = sections.find(s => s.id === view); if (!sec) return;
      const vd = secViewDataRef.current[view];
      const secGLY = vd ? vd.dynSecGLY : (30 + MAX_Z);
      const SPD_V = vd ? vd.SPD : 40;
      const el = secRefs.current[view]?.el;
      const zoom = secZooms[view] || 1;
      // content div の getBoundingClientRect（zoom・スクロール補正済み viewport 座標）
      const r2 = el ? el.getBoundingClientRect() : null;
      const px2 = r2 ? (e.clientX - r2.left) / zoom : 0;
      const py2 = r2 ? (e.clientY - r2.top)  / zoom : 0;
      const along = Math.max(0, px2 - SPD_V);
      const wz = snapV(Math.max(MIN_Z, Math.min(MAX_Z, secGLY - py2)));
      const { viewEdge, rect } = sec;
      const isXV = viewEdge === 'top' || viewEdge === 'bottom';
      // 奥行き軸（矢視図で見えない軸）は矩形中央に固定 → depth チェックを確実にパス
      const depthMid_X = snapV((rect.x1 + rect.x2) / 2);
      const depthMid_Y = snapV((rect.y1 + rect.y2) / 2);
      setMapPos(pr => {
        const up = { ...pr };
        offsets.forEach(o => {
          const base_along = along + (isXV ? o.dx : o.dy);
          let nx, ny;
          if (viewEdge === 'top')         { nx = snapV(Math.max(0, Math.min(TW, base_along + rect.x1))); ny = depthMid_Y; }
          else if (viewEdge === 'bottom') { nx = snapV(Math.max(0, Math.min(TW, rect.x2 - base_along))); ny = depthMid_Y; }
          else if (viewEdge === 'left')   { nx = depthMid_X; ny = snapV(Math.max(0, Math.min(TH, base_along + rect.y1))); }
          else                            { nx = depthMid_X; ny = snapV(Math.max(0, Math.min(TH, rect.y2 - base_along))); }
          up[o.id] = { x: nx, y: ny };
        });
        return up;
      });
      setMapZ(pr => { const up = { ...pr }; selNodes.forEach(nd => { up[nd.id] = wz; }); return up; });
    }
    setSelected(new Set());
    }); // startTransition close
  };

  // ── 全ビューDOMを直接更新（ドラッグ中 setMapPos 不要にする）──
  const _applyDragDOM = (id, nx, ny, _tipX, _tipY) => {
    const cur = allMapPosRef.current[id] || {};
    const gz = cur.z || 0;
    const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    _lastDragPosRef.current = { x: nx, y: ny };

    // キャッシュから全定数・DOM要素を取得（getElementById/querySelectorAll不要）
    const _gc = _dragGeomCache.current || {};
    const { piEl, eiEl, siEl, ciEl,
            piHW = 21, piHH = 23, eiHW = 21, siHW = 21,
            cabHW = 14, cabHH = 15, cabOx = 0, cabOy = 0, cabSc = 1,
            connSegs = [], planWires = {}, elevWires = {}, sideWires = {}, cabWires = {} } = _gc;

    const _mvIcon = (el, left, top) => {
      if (!el) return;
      if (left !== null) el.style.left = left + 'px';
      if (top  !== null) el.style.top  = top  + 'px';
    };
    const setPts = (pls, pts) => { if (pls) pls.forEach(pl => pl.setAttribute('points', pts)); };

    // hSecFloatWin リアルタイム更新用: 現在ドラッグ中のアイコン位置をrefに即反映
    allMapPosRef.current = { ...allMapPosRef.current, [id]: { x: nx, y: ny, z: gz } };

    // mapZRef.current を直接参照して Z 値を確実に最新化（allMapPosRef が stale になってもZ=0を防ぐ）
    const getPos = (nid) => {
      if (nid === id) return { x: nx, y: ny, z: gz };
      const pos = allMapPosRef.current[nid];
      if (!pos) return { x: 0, y: 0, z: 0 };
      const z = mapZRef.current[nid] != null ? mapZRef.current[nid] : (pos.z || 0);
      return { ...pos, z };
    };

    // Z変化等でReactが再レンダリングするとwire DOM要素が新しくなる（旧参照が切り離される）
    // cw-<segId>はcabSortedSegs(zIndex=14)とrenderSegs(zIndex=15)の2箇所に同IDで存在するため
    // getElementById（最初の1つ）でなくquerySelectorAllで全要素取得して両方更新する
    const _freshW = (cache, sid, qEl, extraEl) => {
      const ws = cache[sid];
      if (ws?.length > 0 && ws[0].isConnected) return ws;
      const allGs = Array.from(document.querySelectorAll('#' + qEl + sid));
      const fresh = allGs.flatMap(g => Array.from(g.querySelectorAll('polyline')));
      if (extraEl) {
        const ex = document.getElementById(extraEl + sid);
        if (ex?.isConnected) fresh.push(ex);
      }
      // 再取得成功時のみキャッシュ更新（空配列をキャッシュすると消えたまま固着する）
      if (fresh.length > 0) { cache[sid] = fresh; return fresh; }
      return ws; // 再取得失敗→古いキャッシュを継続使用
    };

    // buildPath を各segで1回だけ計算（全ビューで共有）
    const _sw = segWpRef.current, _wz = wpZRef.current;
    const pathCache = new Map();
    connSegs.forEach(seg => {
      const wps = _sw[seg.id] || [], wzs = _wz[seg.id] || [];
      const a = getPos(seg.from), b = getPos(seg.to);
      pathCache.set(seg.id, [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b]);
    });

    // ── plan ──
    _mvIcon(piEl, nx - piHW, ny - piHH);
    connSegs.forEach(seg => {
      const path = pathCache.get(seg.id);
      setPts(_freshW(planWires, seg.id, 'pw-'), path.map(p => p.x + ',' + p.y).join(' '));
    });

    // ── elev (X変化, Z固定) ──
    _mvIcon(eiEl, nx - eiHW, null);
    connSegs.forEach(seg => {
      const path = pathCache.get(seg.id);
      setPts(_freshW(elevWires, seg.id, 'ew-'), path.map(p => p.x + ',' + (GL_Y - (p.z || 0))).join(' '));
    });

    // ── side (Y変化, Z固定) ──
    _mvIcon(siEl, ny - siHW, null);
    connSegs.forEach(seg => {
      const path = pathCache.get(seg.id);
      setPts(_freshW(sideWires, seg.id, 'sw-'), path.map(p => p.y + ',' + (GL_Y - (p.z || 0))).join(' '));
    });

    // ── cab (3D projection) ──
    // ciElを毎フレームfreshに取得（isHL等変化によるDOM再作成でキャッシュが無効になっても対応）
    const freshCiEl = document.getElementById('ci-' + id) || ciEl;
    if (freshCiEl) {
      const pr = project3D(nx, ny, gz * _mpp, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
      _mvIcon(freshCiEl, cabOx + pr.x * cabSc - cabHW, cabOy + pr.y * cabSc - cabHH);
    }
    connSegs.forEach(seg => {
      const path = pathCache.get(seg.id);
      const pts = path.map(p => {
        // SVG polylineはviewBox座標系のまま使用（letterbox変換不要）
        const pr = project3D(p.x, p.y, (p.z || 0) * _mpp, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
        return pr.x + ',' + pr.y;
      }).join(' ');
      // cabは毎フレームquerySelectorAllで直接取得（_MemoElによるDOM再作成を確実に捕捉）
      const allCwGs = document.querySelectorAll('#cw-' + seg.id);
      const cabPls = Array.from(allCwGs).flatMap(g => Array.from(g.querySelectorAll('polyline')));
      const cwh = document.getElementById('cwh-' + seg.id);
      if (cwh?.isConnected) cabPls.push(cwh);
      setPts(cabPls, pts);
    });

    // ── 全ビュー midpoint circle 更新（plan/elev/side/cab）──
    connSegs.forEach(seg => {
      _updateAllViewCircles(seg.id, pathCache.get(seg.id), _mpp,
        camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
    });

    // ── 矢視図 ──
    sectionsRef.current.forEach(sec => {
      const vd = secViewDataRef.current?.[sec.id]; if (!vd) return;
      const _sRot = secRotatesRef.current?.[sec.id] || 0;
      const _rot = (tp) => {
        if (!_sRot) return tp;
        const rcx = (vd.dynSEC_W || 300) / 2, rcy = vd.dynSecGLY;
        const θ = -_sRot * Math.PI / 180, dx = tp.x - rcx, dy = tp.y - rcy;
        return { x: rcx + dx * Math.cos(θ) - dy * Math.sin(θ), y: rcy + dx * Math.sin(θ) + dy * Math.cos(θ) };
      };
      // アイコン更新: depth範囲内のみ（SVG外DIVのため_rot適用）
      const p = projectToSection(sec, nx, ny, gz);
      if (p.depth >= 0 && p.depth <= p.totalDepth) {
        const tp = _rot({ x: vd.SPD + p.along, y: vd.dynSecGLY - (gz || 0) });
        const secEl = document.getElementById(`sec-${sec.id}-${id}`);
        if (secEl) _mvIcon(secEl, tp.x - piHW, tp.y - piHH);
      }
      // wire更新: 常に実行。SVG回転グループ内のため_rot不要（SVGのtransformで自動回転）
      connSegs.forEach(seg => {
        const sg = document.getElementById(`sec-${sec.id}-w-${seg.id}`); if (!sg) return;
        const path = pathCache.get(seg.id);
        const pts = path.map(pt => {
          const pp = projectToSection(sec, pt.x, pt.y, pt.z || 0);
          return (vd.SPD + pp.along) + ',' + (vd.dynSecGLY - (pt.z || 0));
        }).join(' ');
        sg.querySelectorAll('polyline').forEach(pl => pl.setAttribute('points', pts));
        // 矢視図 midpoint circle 更新（SVG回転グループ内のため_rot不要）
        { const cs = Array.from(sg.querySelectorAll('circle'));
          let ci = 0;
          for (let si = 0; si < path.length - 1 && ci < cs.length; si++) {
            const pa = path[si], pb = path[si + 1];
            const mx = (pa.x+pb.x)/2, my = (pa.y+pb.y)/2, mz = ((pa.z||0)+(pb.z||0))/2;
            const pp2 = projectToSection(sec, mx, my, mz);
            if (cs[ci]) { cs[ci].setAttribute('cx', vd.SPD + pp2.along); cs[ci].setAttribute('cy', vd.dynSecGLY - mz); ci++; }
            if (cs[ci]) { cs[ci].setAttribute('cx', vd.SPD + pp2.along); cs[ci].setAttribute('cy', vd.dynSecGLY - mz); ci++; }
          }
        }
      });
    });
    // on_seg ノード（黄色丸）を接続wireのみ更新
    { const _oT = onSegTRef.current;
      const _onSegHalf = 12; // sz2=24 の半分（offsetWidth読み取りを避けて固定値）
      connSegs.forEach(seg => {
        const path = pathCache.get(seg.id);
        if (!path || path.length < 2) return;
        // seg.from と seg.to の現在位置でlerp（on_segのT値は from→to の0-1）
        const aPos = getPos(seg.from), bPos = getPos(seg.to);
        nodesRef.current.filter(n => n.kind === "on_seg" && n.segId === seg.id).forEach(n => {
          const t = _oT[n.id] != null ? _oT[n.id] : n.t;
          const lx = aPos.x + t * (bPos.x - aPos.x);
          const ly = aPos.y + t * (bPos.y - aPos.y);
          const planEl = document.getElementById('onseg-pi-' + n.id);
          if (planEl) { planEl.style.left = (lx - _onSegHalf) + 'px'; planEl.style.top = (ly - _onSegHalf) + 'px'; }
          const elevEl = document.getElementById('onseg-ei-' + n.id);
          if (elevEl) elevEl.style.left = (lx - _onSegHalf) + 'px';
          const sideEl = document.getElementById('onseg-si-' + n.id);
          if (sideEl) sideEl.style.left = (ly - _onSegHalf) + 'px';
        });
      });
    }

    // アイコンドラッグ中: 接続wire全長をwire中点付近に表示
    if (_tipX != null && connSegs.length > 0) {
      const _mppT = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
      const _fmtD = d => d < 1000 ? `${d.toFixed(1)} m` : `${(d/1000).toFixed(3)} km`;
      const rect = _gc.planRect;
      const _pz = planZoomRef.current || 1;
      const labels = connSegs.map(seg => {
        const path = pathCache.get(seg.id); if (!path || path.length < 2) return null;
        let dist = 0;
        for (let k = 0; k < path.length - 1; k++) {
          const dx2 = (path[k+1].x - path[k].x) * _mppT;
          const dy2 = (path[k+1].y - path[k].y) * _mppT;
          const dz2 = (path[k+1].z || 0) - (path[k].z || 0);
          dist += Math.sqrt(dx2*dx2 + dy2*dy2 + dz2*dz2);
        }
        const mid = path[Math.floor((path.length - 1) / 2)];
        const lx = rect ? rect.left + mid.x * _pz : _tipX + 20;
        const ly = rect ? rect.top  + mid.y * _pz : _tipY;
        return { x: lx, y: ly, text: _fmtD(dist) };
      }).filter(Boolean);
      setWireTipLabels(labels);
    }

    // Cesium: billboard entity を新座標に更新（GPU 描画、パース自動）
    const _wireUpdates = connSegs.map(seg => ({ segId: seg.id, path: pathCache.get(seg.id) }));
    if (cesium3dUpdateRef.current) cesium3dUpdateRef.current(id, nx, ny, gz, _wireUpdates);
    if (cesium2dUpdateRef.current) cesium2dUpdateRef.current(id, nx, ny, gz, _wireUpdates);
  };

  // map drag
  useEffect(() => {
    if (!mapDrag) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    let _rafId = null, _pendingEv = null, _lastDragPos = null;
    const mv = ev => {
      ev.preventDefault();
      _pendingEv = ev;
      if (_rafId) return; // 同一フレームの余分なmousemoveをスキップ
      _rafId = requestAnimationFrame(() => {
        _rafId = null;
        const ev = _pendingEv;
      const ref = mapDrag.view === "plan" ? planRef : cabRef;
      // plan: キャッシュ済みrectで座標変換（getBoundingClientRect強制レイアウト防止）
      let p;
      if (mapDrag.view === "plan" && _dragGeomCache.current?.planRect) {
        const r = _dragGeomCache.current.planRect;
        const z = planZoomRef.current || 1;
        p = { x: (ev.clientX - r.left) / z, y: (ev.clientY - r.top) / z };
      } else {
        p = toP(ref, ev);
      }
      const pp = mapDrag.view === "cab" ? unproj(p.x, p.y) : p;
      if (mapDrag.view === "plan") {
        let nx = pp.x + mapDragOffsetRef.current.x, ny = pp.y + mapDragOffsetRef.current.y;
        const _pz = planZoomRef.current || 1, SNAP_T = 15 / _pz;
        const _pnRad = plantNorthAngleRef.current * Math.PI / 180;
        const cosPn = Math.cos(_pnRad), sinPn = Math.sin(_pnRad);
        // PN/X軸スナップ: カーソルが重なっているアイコンのみ（O(N)ループ→O(1)）
        let sInfo = null;
        const _nearId = nearbyIconRef.current;
        if (_nearId && _nearId !== mapDrag.id) {
          const np2 = allMapPosRef.current[_nearId];
          if (np2) {
            const dx = nx - np2.x, dy = ny - np2.y;
            const dPN = Math.abs(dx * cosPn + dy * sinPn), dX = Math.abs(dx * sinPn - dy * cosPn);
            const sPN = dPN < SNAP_T, sX = dX < SNAP_T;
            if (sPN || sX) {
              const tPN = dx * sinPn - dy * cosPn, tX = dx * cosPn + dy * sinPn;
              if (sPN && sX) { nx = np2.x; ny = np2.y; sInfo = { iconId: _nearId, type: "both" }; }
              else if (sPN) { nx = np2.x + tPN * sinPn; ny = np2.y + tPN * (-cosPn); sInfo = { iconId: _nearId, type: "pn" }; }
              else { nx = np2.x + tX * cosPn; ny = np2.y + tX * sinPn; sInfo = { iconId: _nearId, type: "x" }; }
            }
          }
        }
        planIconSnapRef.current = sInfo;
        // 直角スナップ: 接続セグメントの最初の折れ点 (X-Y平面) — 接続segsのみ検索
        let perpInfo = null;
        const _connSegs = connectedSegsMapRef.current[mapDrag.id] || [];
        perpOuter: for (const seg of _connSegs) {
          let wpArr, wpIdx, farX, farY;
          if (seg.from === mapDrag.id) {
            wpArr = segWpRef.current[seg.id] || []; if (wpArr.length === 0) continue; wpIdx = 0;
            const fw = wpArr[1], fn = allMapPosRef.current[seg.to];
            farX = fw ? fw.x : (fn ? fn.x : null); farY = fw ? fw.y : (fn ? fn.y : null);
          } else if (seg.to === mapDrag.id) {
            wpArr = segWpRef.current[seg.id] || []; if (wpArr.length === 0) continue; wpIdx = wpArr.length - 1;
            const fw = wpArr.length > 1 ? wpArr[wpArr.length - 2] : null, fn = allMapPosRef.current[seg.from];
            farX = fw ? fw.x : (fn ? fn.x : null); farY = fw ? fw.y : (fn ? fn.y : null);
          } else continue;
          if (farX == null) continue;
          const wp = wpArr[wpIdx];
          const vAx = wp.x - nx, vAy = wp.y - ny, vBx = farX - wp.x, vBy = farY - wp.y;
          const lenA = Math.sqrt(vAx*vAx+vAy*vAy), lenB = Math.sqrt(vBx*vBx+vBy*vBy);
          if (lenA < 1 || lenB < 1) continue;
          if (Math.abs((vAx*vBx+vAy*vBy)/(lenA*lenB)) < 0.035) {
            const snpPos = sInfo ? allMapPosRef.current[sInfo.iconId] : null;
            if (!sInfo) {
              const div = vBx*vBx+vBy*vBy;
              if (div > 0) { const t=((nx-wp.x)*(-vBy)+(ny-wp.y)*vBx)/div; nx=wp.x+t*(-vBy); ny=wp.y+t*vBx; }
            } else if (sInfo.type === "pn" && snpPos) {
              const Ax=wp.x-snpPos.x, Ay=wp.y-snpPos.y, denom=sinPn*vBx-cosPn*vBy;
              if (Math.abs(denom) > 0.01) { const s=(Ax*vBx+Ay*vBy)/denom; nx=snpPos.x+s*sinPn; ny=snpPos.y+s*(-cosPn); }
            } else if (sInfo.type === "x" && snpPos) {
              const Ax=wp.x-snpPos.x, Ay=wp.y-snpPos.y, denom=cosPn*vBx+sinPn*vBy;
              if (Math.abs(denom) > 0.01) { const s=(Ax*vBx+Ay*vBy)/denom; nx=snpPos.x+s*cosPn; ny=snpPos.y+s*sinPn; }
            }
            const dAx_=wp.x-nx, dAy_=wp.y-ny, dBx_=farX-wp.x, dBy_=farY-wp.y;
            const dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1, dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            perpInfo={ svgX:wp.x, svgY:wp.y, dAx:dAx_/dAl, dAy:dAy_/dAl, dBx:dBx_/dBl, dBy:dBy_/dBl };
            break perpOuter;
          }
        }
        iconPerpSnapRef.current = perpInfo;
        // plan drag: setMapPosを呼ばずDOM直接更新 → React再描画ゼロ
        _applyDragDOM(mapDrag.id, nx, ny, ev.clientX, ev.clientY);
        // hSec FloatWinのリアルタイム更新（hSectionsがある場合のみRAFで再描画）
        if (hSectionsRef.current.length > 0 && !hSecTickRafRef.current) {
          hSecTickRafRef.current = requestAnimationFrame(() => {
            hSecTickRafRef.current = null;
            setHSecTick(n => n + 1);
          });
        }
      } else {
        // cab drag: 従来通りstate更新
        setMapPos(pr => ({ ...pr, [mapDrag.id]: { x: pp.x, y: pp.y } }));
      }
      }); // rAF close
    };
    const up = () => {
      grabOff();
      if (_rafId) cancelAnimationFrame(_rafId);
      planIconSnapRef.current = null; iconPerpSnapRef.current = null;
      iconDragging.current = false;
      isDraggingRef.current = false; // CesiumMapの重いeffectを再開
      setWireTipLabels([]);
      nearbyIconRef.current = null; // snap相手をクリア
      const fp = _lastDragPosRef.current;
      _lastDragPosRef.current = null;
      // React 18 auto-batchingで setMapPos + setMapDrag を1回のレンダリングにまとめる
      if (fp && mapDrag.view === 'plan') {
        setMapPos(pr => ({ ...pr, [mapDrag.id]: snapFine(fp.x, fp.y, planZoomRef.current) }));
      } else {
        setMapPos(pr => { const p = pr[mapDrag.id]; return p ? { ...pr, [mapDrag.id]: snapFine(p.x, p.y, planZoomRef.current) } : pr; });
      }
      setMapDrag(null);
      // mouseUp: CesiumのrAFを再開して最終位置を描画
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { grabOff(); if (_rafId) cancelAnimationFrame(_rafId); planIconSnapRef.current = null; iconPerpSnapRef.current = null; window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [mapDrag]); // segs/segWpはrefで参照するため依存不要

  // ── hSec ズーム後スクロール補正（カーソル下を固定）──
  useLayoutEffect(() => {
    const upd = hSecScrollUpdateRef.current;
    if (!upd) return;
    hSecScrollUpdateRef.current = null;
    const scEl = hSecScrollRefs.current[upd.id];
    if (scEl) { scEl.scrollLeft = upd.left; scEl.scrollTop = upd.top; }
  }, [hSecZooms]);

  // ── hSection高さドラッグ ──
  useEffect(() => {
    if (!hSecDrag) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:ns-resize!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    const mv = ev => {
      const drag = hSecDragRef.current;
      if (!drag) return;
      hSecDragClientPos.current = { x: ev.clientX, y: ev.clientY };
      const dy = ev.clientY - drag.startClientY;
      const rawZPx = drag.startZPx - dy * drag.dZPerPx;
      hSecLiveZRef.current[drag.id] = rawZPx; // ドラッグ中はスナップなし・連続的に変化
      if (!hSecTickRafRef.current) {
        hSecTickRafRef.current = requestAnimationFrame(() => {
          hSecTickRafRef.current = null;
          setHSecTick(n => n + 1);
        });
      }
    };
    const up = () => {
      grabOff();
      const drag = hSecDragRef.current;
      if (drag) {
        const newZPx = hSecLiveZRef.current[drag.id] ?? drag.startZPx;
        const newLabel = newZPx >= 0 ? `${Math.floor(newZPx / MAJOR) + 1}F` : `B${Math.ceil(-newZPx / MAJOR)}`;
        setHSections(prev => prev.map(hs => hs.id === drag.id ? { ...hs, zPx: newZPx, label: newLabel } : hs));
        delete hSecLiveZRef.current[drag.id];
        // mouseup後もバッジ表示継続
        hSecActiveDimPos.current = { ...hSecDragClientPos.current };
      }
      setHSecDrag(null);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => { grabOff(); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, [hSecDrag]);

  // ── elev/side drag 命令型起動関数（setElevDrag不使用でReact再描画なし）──
  const _startImperativeDrag = (nodeId, mode, buildMvFn) => {
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    iconDragging.current = true; isDraggingRef.current = true; movedNodeRef.current = nodeId;
    const _ciEl = document.getElementById('ci-' + nodeId);
    const _connSegs = connectedSegsMapRef.current[nodeId] || [];
    const _pi = document.getElementById('pi-' + nodeId);
    const _cab = cabRef.current;
    const cW = _cab?.clientWidth || CAB_W, cH = _cab?.clientHeight || CAB_H;
    const sc = Math.min(cW / CAB_W, cH / CAB_H);
    const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
    _connSegs.forEach(seg => {
      const pw = document.getElementById('pw-' + seg.id), ew = document.getElementById('ew-' + seg.id);
      const sw = document.getElementById('sw-' + seg.id), cw = document.getElementById('cw-' + seg.id);
      const cwh = document.getElementById('cwh-' + seg.id);
      if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
      if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
      if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
      cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
    });
    const elevRect = elevRef.current?.getBoundingClientRect() || null;
    const sideRect = sideRef.current?.getBoundingClientRect() || null;
    // ciEl:null → ci-{id}divをCesiumパネル外で誤移動させない（Cesiumはオーバーレイで表示）
    _dragGeomCache.current = {
      piEl: _pi, eiEl: document.getElementById('ei-' + nodeId),
      siEl: document.getElementById('si-' + nodeId), ciEl: _ciEl,
      piHW: _pi ? _pi.offsetWidth/2 : 21, piHH: _pi ? _pi.offsetHeight/2 : 23, eiHW: 21, siHW: 21,
      cabHW: _ciEl ? _ciEl.offsetWidth/2 : 14, cabHH: _ciEl ? _ciEl.offsetHeight/2 : 15,
      cabOx: (cW - CAB_W * sc) / 2, cabOy: (cH - CAB_H * sc) / 2, cabSc: sc,
      connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
      elevRect, sideRect,
    };

    // Cesium wire SVG overlay（billboard entityがアイコンをGPU描画、wireはCSS SVGで仮表示）
    const _p0 = allMapPosRef.current[nodeId] || {};
    const _pos0WithId = { ..._p0, nodeId };
    const _wOv3d = _buildCesiumWireOverlay(cesium3dQueryRef, _connSegs, _pos0WithId);
    const _wOv2d = _buildCesiumWireOverlay(cesium2dQueryRef, _connSegs, _pos0WithId);
    // rAF内からoverlayを更新するためのref（buildMvFn内のmv関数がアクセス）
    const _wireOvRef = { ov3d: _wOv3d, ov2d: _wOv2d, p0: _p0, nodeId };

    const mv = buildMvFn(_wireOvRef);
    const up = () => {
      grabOff();
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', mv); window.removeEventListener('touchend', up);
      const lp = mode === 'elev' ? _elevLivePosRef.current : _sideLivePosRef.current;
      if (mode === 'elev') _elevLivePosRef.current = null; else _sideLivePosRef.current = null;
      if (lp) {
        const sz = mode === 'elev' ? elevZoomRef.current : sideZoomRef.current;
        const snZ = snapFineV(lp.z, sz);
        const _cur = allMapPosRef.current[nodeId] || {};
        if (mode === 'elev') {
          const snX = snapFineV(Math.max(0, Math.min(TW, lp.x)), sz);
          _pendingNonCesiumTeardownRef.current = {
            ov3d: _wOv3d, ov2d: _wOv2d,
            finalPos: { x: snX, y: _cur.y || 0, z: snZ },
            nodeId
          };
          iconDragging.current = false;
          setMapPos(pr => { const p = pr[nodeId]; return p ? { ...pr, [nodeId]: { ...p, x: snX } } : pr; });
          setMapZ(pr => ({ ...pr, [nodeId]: snZ }));
        } else {
          const snY = snapFineV(Math.max(0, Math.min(TH, lp.y)), sz);
          _pendingNonCesiumTeardownRef.current = {
            ov3d: _wOv3d, ov2d: _wOv2d,
            finalPos: { x: _cur.x || 0, y: snY, z: snZ },
            nodeId
          };
          iconDragging.current = false;
          setMapPos(pr => { const p = pr[nodeId]; return p ? { ...pr, [nodeId]: { ...p, y: snY } } : pr; });
          setMapZ(pr => ({ ...pr, [nodeId]: snZ }));
        }
      } else {
        _teardownCesiumWireOverlay(_wOv3d);
        _teardownCesiumWireOverlay(_wOv2d);
        iconDragging.current = false; isDraggingRef.current = false;
      }
      nearbyIconRef.current = null; movedNodeRef.current = null;
      iconSnapWpRef.current = null; iconPerpSnapRef.current = null;
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', mv, { passive: false }); window.addEventListener('touchend', up);
  };

  const startElevDrag = (nodeId, startEvent) => {
    _startImperativeDrag(nodeId, 'elev', (_wireOvRef) => {
      return (ev) => {
        ev.preventDefault();
        // キャッシュ済みrectで座標変換（getBoundingClientRect強制レイアウト防止）
        const _gc2 = _dragGeomCache.current || {};
        const _er = _gc2.elevRect;
        const _ez = elevZoomRef.current || 1;
        const p = _er
          ? { x: (ev.clientX - _er.left) / _ez, y: (ev.clientY - _er.top) / _ez }
          : toP(elevRef, ev);
        let newZ = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - p.y));
        let nx = Math.max(0, Math.min(TW, p.x));
        const SNAP_T = 15 / _ez;
        let snapKey = null;
        // 全segsではなく接続segsの折れ点のみスキャン（O(all_segs)→O(connected_segs)）
        const _connSegs2 = connectedSegsMapRef.current[nodeId] || [];
        outer: for (const seg of _connSegs2) {
          const wps = segWpRef.current[seg.id] || [];
          for (let i = 0; i < wps.length; i++) {
            if (Math.abs(nx - wps[i].x) < SNAP_T) { nx = wps[i].x; snapKey = `${seg.id}_${i}`; break outer; }
          }
        }
        iconSnapWpRef.current = snapKey;
        // 直角スナップ（接続wireのみ、同じ_connSegs2を再利用）
        let perpInfo = null;
        perpOuter: for (const seg of _connSegs2) {
          const wpArr = segWpRef.current[seg.id] || []; if (wpArr.length === 0) continue;
          const wpZArr = wpZRef.current[seg.id] || [];
          let wpIdx, farX, farZ;
          if (seg.from === nodeId) { wpIdx = 0; const fw = wpArr[1], fn = allMapPosRef.current[seg.to]; farX = fw ? fw.x : (fn?.x ?? null); farZ = fw ? (wpZArr[1] ?? 0) : (fn?.z ?? null); }
          else if (seg.to === nodeId) { wpIdx = wpArr.length - 1; const fw = wpArr[wpArr.length - 2] || null, fn = allMapPosRef.current[seg.from]; farX = fw ? fw.x : (fn?.x ?? null); farZ = fw ? (wpZArr[wpArr.length - 2] ?? 0) : (fn?.z ?? null); }
          else continue;
          if (farX == null) continue;
          const wp = wpArr[wpIdx], wpZv = wpZArr[wpIdx] ?? 0;
          const vAx = wp.x - nx, vAy = wpZv - newZ, vBx = farX - wp.x, vBy = farZ - wpZv;
          const lenA = Math.sqrt(vAx*vAx+vAy*vAy), lenB = Math.sqrt(vBx*vBx+vBy*vBy);
          if (lenA < 1 || lenB < 1) continue;
          if (Math.abs((vAx*vBx+vAy*vBy)/(lenA*lenB)) < 0.035) {
            if (!snapKey) { const div=vBx*vBx+vBy*vBy; if(div>0){const t=((nx-wp.x)*(-vBy)+(newZ-wpZv)*vBx)/div; nx=wp.x+t*(-vBy); newZ=Math.max(MIN_Z,Math.min(MAX_Z,wpZv+t*vBx));} }
            const dAl=Math.sqrt((wp.x-nx)**2+(wpZv-newZ)**2)||1, dBl=Math.sqrt(vBx*vBx+vBy*vBy)||1;
            perpInfo={svgX:wp.x,svgY:GL_Y-wpZv,dAx:(wp.x-nx)/dAl,dAy:(wpZv-newZ)/dAl,dBx:vBx/dBl,dBy:vBy/dBl};
            break perpOuter;
          }
        }
        iconPerpSnapRef.current = perpInfo;
        _elevLivePosRef.current = { x: nx, z: newZ };
        _applyElevDragDOM(nodeId, nx, newZ);
        // Cesium wire overlay 更新（elev: X+Z変化、world座標で正確投影）
        if (_wireOvRef) {
          const _posY = _wireOvRef.p0.y||0;
          _updateCesiumWireOverlay(_wireOvRef.ov3d, nx, _posY, newZ);
          _updateCesiumWireOverlay(_wireOvRef.ov2d, nx, _posY, newZ);
        }
      };
    });
  };

  const startSideDrag = (nodeId, startEvent) => {
    _startImperativeDrag(nodeId, 'side', (_wireOvRef) => {
      return (ev) => {
        ev.preventDefault();
        // キャッシュ済みrectで座標変換
        const _gc2 = _dragGeomCache.current || {};
        const _sr = _gc2.sideRect;
        const _sz = sideZoomRef.current || 1;
        const p = _sr
          ? { x: (ev.clientX - _sr.left) / _sz, y: (ev.clientY - _sr.top) / _sz }
          : toP(sideRef, ev);
        let newY = Math.max(0, Math.min(TH, p.x));
        let newZ = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - p.y));
        const SNAP_T = 15 / _sz;
        let snapKey = null;
        const _connSegs2s = connectedSegsMapRef.current[nodeId] || [];
        outer: for (const seg of _connSegs2s) {
          const wps = segWpRef.current[seg.id] || [];
          for (let i = 0; i < wps.length; i++) {
            if (Math.abs(newY - wps[i].y) < SNAP_T) { newY = wps[i].y; snapKey = `${seg.id}_${i}`; break outer; }
          }
        }
        iconSnapWpRef.current = snapKey;
        iconPerpSnapRef.current = null;
        _sideLivePosRef.current = { y: newY, z: newZ };
        _applySideDragDOM(nodeId, newY, newZ);
        // Cesium wire overlay 更新（side: Y+Z変化、world座標で正確投影）
        if (_wireOvRef) {
          const _posX = _wireOvRef.p0.x||0;
          _updateCesiumWireOverlay(_wireOvRef.ov3d, _posX, newY, newZ);
          _updateCesiumWireOverlay(_wireOvRef.ov2d, _posX, newY, newZ);
        }
      };
    });
  };

  // ── side drag 用DOM直接更新（Y+Z両方変化）──
  const _applySideDragDOM = (id, ny, nz) => {
    const cur = allMapPosRef.current[id] || {};
    const posX = cur.x || 0; // X座標はside dragでは変化しない
    const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    const _gc = _dragGeomCache.current || {};
    const { piEl, eiEl, siEl, ciEl,
            piHW = 21, piHH = 23, eiHW = 21,
            cabHW = 14, cabHH = 15, cabOx = 0, cabOy = 0, cabSc = 1,
            connSegs = [], planWires = {}, elevWires = {}, sideWires = {}, cabWires = {} } = _gc;
    const _mvIcon = (el, left, top) => { if (!el) return; if (left !== null) el.style.left = left + 'px'; if (top !== null) el.style.top = top + 'px'; };
    const setPts = (pls, pts) => { if (pls) pls.forEach(pl => pl.setAttribute('points', pts)); };
    const getPos = (nid) => {
      if (nid === id) return { x: posX, y: ny, z: nz };
      const pos = allMapPosRef.current[nid];
      if (!pos) return { x: 0, y: 0, z: 0 };
      const z = mapZRef.current[nid] != null ? mapZRef.current[nid] : (pos.z || 0);
      return { ...pos, z };
    };
    const _sw2 = segWpRef.current, _wz2 = wpZRef.current;
    const pathCache = new Map();
    connSegs.forEach(seg => {
      const wps = _sw2[seg.id] || [], wzs = _wz2[seg.id] || [];
      const a = getPos(seg.from), b = getPos(seg.to);
      pathCache.set(seg.id, [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b]);
    });
    // plan (y変化→top変化)
    _mvIcon(piEl, null, ny - piHH);
    connSegs.forEach(seg => { const path = pathCache.get(seg.id); setPts(planWires[seg.id], path.map(p => p.x + ',' + p.y).join(' ')); });
    // side (y+z変化)
    _mvIcon(siEl, ny - (21), (GL_Y - nz) - piHH);
    connSegs.forEach(seg => { const path = pathCache.get(seg.id); setPts(sideWires[seg.id], path.map(p => p.y + ',' + (GL_Y - (p.z || 0))).join(' ')); });
    // elev (z変化→top変化)
    _mvIcon(eiEl, null, (GL_Y - nz) - piHH);
    connSegs.forEach(seg => { const path = pathCache.get(seg.id); setPts(elevWires[seg.id], path.map(p => p.x + ',' + (GL_Y - (p.z || 0))).join(' ')); });
    // cab (y+z変化→project3D)
    { const cabEl = ciEl;
      if (cabEl) {
        const pr = project3D(posX, ny, nz * _mpp, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
        _mvIcon(cabEl, cabOx + pr.x * cabSc - cabHW, cabOy + pr.y * cabSc - cabHH);
      }
    }
    connSegs.forEach(seg => {
      const path = pathCache.get(seg.id);
      const pts = path.map(p => { const pr = project3D(p.x, p.y, (p.z || 0) * _mpp, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current); return pr.x + ',' + pr.y; }).join(' ');
      setPts(cabWires[seg.id], pts);
    });
    // 全ビュー midpoint circle 更新（plan/elev/side/cab）
    connSegs.forEach(seg => {
      _updateAllViewCircles(seg.id, pathCache.get(seg.id), _mpp,
        camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
    });
    // 矢視図 polyline + circle 更新（SVG回転グループ内のため_rot不要）
    sectionsRef.current.forEach(sec => {
      const vd = secViewDataRef.current?.[sec.id]; if (!vd) return;
      connSegs.forEach(seg => {
        const sg = document.getElementById(`sec-${sec.id}-w-${seg.id}`); if (!sg) return;
        const path = pathCache.get(seg.id);
        const pts = path.map(pt => { const pp=projectToSection(sec,pt.x,pt.y,pt.z||0); return (vd.SPD+pp.along)+','+(vd.dynSecGLY-(pt.z||0)); }).join(' ');
        sg.querySelectorAll('polyline').forEach(pl => pl.setAttribute('points', pts));
        const cs = Array.from(sg.querySelectorAll('circle')); let ci = 0;
        for (let si = 0; si < path.length-1 && ci < cs.length; si++) {
          const pa=path[si],pb=path[si+1],mx=(pa.x+pb.x)/2,my=(pa.y+pb.y)/2,mz=((pa.z||0)+(pb.z||0))/2;
          const pp2=projectToSection(sec,mx,my,mz);
          if(cs[ci]){cs[ci].setAttribute('cx',vd.SPD+pp2.along);cs[ci].setAttribute('cy',vd.dynSecGLY-mz);ci++;}
          if(cs[ci]){cs[ci].setAttribute('cx',vd.SPD+pp2.along);cs[ci].setAttribute('cy',vd.dynSecGLY-mz);ci++;}
        }
      });
    });
    // Cesium billboard entity 更新
    const _wireUpdates = connSegs.map(seg => ({ segId: seg.id, path: pathCache.get(seg.id) }));
    if (cesium3dUpdateRef.current) cesium3dUpdateRef.current(id, posX, ny, nz, _wireUpdates);
    if (cesium2dUpdateRef.current) cesium2dUpdateRef.current(id, posX, ny, nz, _wireUpdates);
    // hSec FloatWin リアルタイム更新
    allMapPosRef.current = { ...allMapPosRef.current, [id]: { x: posX, y: ny, z: nz } };
    if (hSectionsRef.current.length > 0 && !hSecTickRafRef.current) {
      hSecTickRafRef.current = requestAnimationFrame(() => { hSecTickRafRef.current = null; setHSecTick(n => n + 1); });
    }
  };

  // ── elev drag 用DOM直接更新（X+Z両方変化）──
  const _applyElevDragDOM = (id, nx, nz) => {
    const cur = allMapPosRef.current[id] || {};
    const posY = cur.y || 0; // Y座標はelev dragでは変化しない
    const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
    const _sw = segWpRef.current, _wz = wpZRef.current;
    const _gc = _dragGeomCache.current || {};
    const { piHW = 21, piHH = 23, eiHW = 21, siHW = 21,
            cabHW = 14, cabHH = 15, cabOx = 0, cabOy = 0, cabSc = 1,
            connSegs = [], planWires = {}, elevWires = {}, sideWires = {}, cabWires = {} } = _gc;

    const _mvIcon = (el, left, top) => { if (!el) return; if (left !== null) el.style.left = left + 'px'; if (top !== null) el.style.top = top + 'px'; };
    const setPts = (pls, pts) => { if (pls) pls.forEach(pl => pl.setAttribute('points', pts)); };
    const getPos = (nid) => {
      if (nid === id) return { x: nx, y: posY, z: nz };
      const pos = allMapPosRef.current[nid];
      if (!pos) return { x: 0, y: 0, z: 0 };
      const z = mapZRef.current[nid] != null ? mapZRef.current[nid] : (pos.z || 0);
      return { ...pos, z };
    };
    const _sw2 = segWpRef.current, _wz2 = wpZRef.current;
    const pathCache = new Map();
    connSegs.forEach(seg => {
      const wps = _sw2[seg.id] || [], wzs = _wz2[seg.id] || [];
      const a = getPos(seg.from), b = getPos(seg.to);
      pathCache.set(seg.id, [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b]);
    });

    // plan (x変化)
    { const el = document.getElementById('pi-' + id); if (el) _mvIcon(el, nx - piHW, null); }
    connSegs.forEach(seg => { const path = pathCache.get(seg.id); setPts(planWires[seg.id], path.map(p => p.x + ',' + p.y).join(' ')); });

    // elev (x+z変化)
    { const el = document.getElementById('ei-' + id); if (el) _mvIcon(el, nx - eiHW, (GL_Y - nz) - piHH); }
    connSegs.forEach(seg => { const path = pathCache.get(seg.id); setPts(elevWires[seg.id], path.map(p => p.x + ',' + (GL_Y - (p.z || 0))).join(' ')); });

    // side (z変化→top変化。横軸=y、縦軸=z)
    { const el = document.getElementById('si-' + id); if (el) _mvIcon(el, null, (GL_Y - nz) - piHH); }
    connSegs.forEach(seg => { const path = pathCache.get(seg.id); setPts(sideWires[seg.id], path.map(p => p.y + ',' + (GL_Y - (p.z || 0))).join(' ')); });

    // cab (x+z変化→project3D)
    { const cabEl = document.getElementById('ci-' + id);
      if (cabEl) {
        const pr = project3D(nx, posY, nz * _mpp, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
        _mvIcon(cabEl, cabOx + pr.x * cabSc - cabHW, cabOy + pr.y * cabSc - cabHH);
      }
    }
    connSegs.forEach(seg => {
      const path = pathCache.get(seg.id);
      const pts = path.map(p => {
        const pr = project3D(p.x, p.y, (p.z || 0) * _mpp, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
        return pr.x + ',' + pr.y;
      }).join(' ');
      setPts(cabWires[seg.id], pts);
    });
    // 全ビュー midpoint circle 更新（plan/elev/side/cab）
    connSegs.forEach(seg => {
      _updateAllViewCircles(seg.id, pathCache.get(seg.id), _mpp,
        camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
    });
    // 矢視図 polyline + circle 更新（SVG回転グループ内のため_rot不要）
    sectionsRef.current.forEach(sec => {
      const vd = secViewDataRef.current?.[sec.id]; if (!vd) return;
      connSegs.forEach(seg => {
        const sg = document.getElementById(`sec-${sec.id}-w-${seg.id}`); if (!sg) return;
        const path = pathCache.get(seg.id);
        const pts = path.map(pt => { const pp=projectToSection(sec,pt.x,pt.y,pt.z||0); return (vd.SPD+pp.along)+','+(vd.dynSecGLY-(pt.z||0)); }).join(' ');
        sg.querySelectorAll('polyline').forEach(pl => pl.setAttribute('points', pts));
        const cs = Array.from(sg.querySelectorAll('circle')); let ci = 0;
        for (let si = 0; si < path.length-1 && ci < cs.length; si++) {
          const pa=path[si],pb=path[si+1],mx=(pa.x+pb.x)/2,my=(pa.y+pb.y)/2,mz=((pa.z||0)+(pb.z||0))/2;
          const pp2=projectToSection(sec,mx,my,mz);
          if(cs[ci]){cs[ci].setAttribute('cx',vd.SPD+pp2.along);cs[ci].setAttribute('cy',vd.dynSecGLY-mz);ci++;}
          if(cs[ci]){cs[ci].setAttribute('cx',vd.SPD+pp2.along);cs[ci].setAttribute('cy',vd.dynSecGLY-mz);ci++;}
        }
      });
    });

    // Cesium billboard entity 更新
    const _wireUpdates = connSegs.map(seg => ({ segId: seg.id, path: pathCache.get(seg.id) }));
    if (cesium3dUpdateRef.current) cesium3dUpdateRef.current(id, nx, posY, nz, _wireUpdates);
    if (cesium2dUpdateRef.current) cesium2dUpdateRef.current(id, nx, posY, nz, _wireUpdates);
    // hSec FloatWin リアルタイム更新
    allMapPosRef.current = { ...allMapPosRef.current, [id]: { x: nx, y: posY, z: nz } };
    if (hSectionsRef.current.length > 0 && !hSecTickRafRef.current) {
      hSecTickRafRef.current = requestAnimationFrame(() => { hSecTickRafRef.current = null; setHSecTick(n => n + 1); });
    }
  };

  // elev drag — 全ノードのZ調整。on_segはX方向をT-slideで処理
  useEffect(() => {
    if (!elevDrag) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    // elev drag開始: iconDragging + Cesiumポーズ + DOMキャッシュ構築
    iconDragging.current = true;
    isDraggingRef.current = true;
    cesium3dRenderRef.current?.pause?.();
    cesium2dRenderRef.current?.pause?.();
    movedNodeRef.current = elevDrag.id;
    { const _connSegs = connectedSegsMapRef.current[elevDrag.id] || [];
      const _pi = document.getElementById('pi-' + elevDrag.id);
      const _ci = document.getElementById('ci-' + elevDrag.id);
      const _cab = cabRef.current;
      const cW = _cab?.clientWidth || CAB_W, cH = _cab?.clientHeight || CAB_H;
      const sc = Math.min(cW / CAB_W, cH / CAB_H);
      const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
      _connSegs.forEach(seg => {
        const pw = document.getElementById('pw-' + seg.id), ew = document.getElementById('ew-' + seg.id);
        const sw = document.getElementById('sw-' + seg.id), cw = document.getElementById('cw-' + seg.id);
        const cwh = document.getElementById('cwh-' + seg.id);
        if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
        if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
        if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
        cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
      });
      _dragGeomCache.current = {
        piEl: _pi, eiEl: document.getElementById('ei-' + elevDrag.id),
        siEl: document.getElementById('si-' + elevDrag.id), ciEl: _ci,
        piHW: _pi ? _pi.offsetWidth/2 : 21, piHH: _pi ? _pi.offsetHeight/2 : 23,
        eiHW: 21, siHW: 21,
        cabHW: _ci ? _ci.offsetWidth/2 : 14, cabHH: _ci ? _ci.offsetHeight/2 : 15,
        cabOx: (cW - CAB_W * sc) / 2, cabOy: (cH - CAB_H * sc) / 2, cabSc: sc,
        connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
      };
    }
    const mv = ev => {
      ev.preventDefault();
      const p = toP(elevRef, ev);
      let newZ = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - p.y));

      const nd = nodes.find(n => n.id === elevDrag.id);
      if (nd && nd.kind === "on_seg") {
        // on_seg: X方向はT-slideで動かす
        iconPerpSnapRef.current = null;
        const seg = segs.find(s => s.id === nd.segId);
        if (seg) {
          const aP = mapPos[seg.from], bP = mapPos[seg.to];
          if (aP && bP) {
            const t = projSeg({ x: p.x, y: 0 }, aP, bP);
            setOnSegT(pr => ({ ...pr, [elevDrag.id]: t }));
          }
        }
        setMapZ(pr => ({ ...pr, [elevDrag.id]: newZ }));
      } else if (mapPos[elevDrag.id]) {
        // symbol/free: X方向は直接動かす（折れ点X列へスナップ）
        let nx = Math.max(0, Math.min(TW, p.x));
        const _ez = elevZoomRef.current || 1;
        const SNAP_T = 15 / _ez;
        let snapKey = null;
        outer: for (const [sid, wps] of Object.entries(segWp)) {
          for (let i = 0; i < wps.length; i++) {
            if (Math.abs(nx - wps[i].x) < SNAP_T) { nx = wps[i].x; snapKey = `${sid}_${i}`; break outer; }
          }
        }
        iconSnapWpRef.current = snapKey;

        // 直角スナップ: 接続セグメントの最初の折れ点との角度チェック (X-Z平面)
        let perpInfo = null;
        const _wpZ = wpZRef.current, _amp = allMapPosRef.current;
        perpOuter: for (const seg of segs) {
          let wpArr, wpZArr, wpIdx, farX, farZ;
          if (seg.from === elevDrag.id) {
            wpArr = segWpRef.current[seg.id] || [];
            if (wpArr.length === 0) continue;
            wpIdx = 0;
            wpZArr = _wpZ[seg.id] || [];
            const farWp = wpArr[1], farNode = _amp[seg.to];
            farX = farWp ? farWp.x : (farNode ? farNode.x : null);
            farZ = farWp ? (wpZArr[1] ?? 0) : (farNode ? farNode.z ?? 0 : null);
          } else if (seg.to === elevDrag.id) {
            wpArr = segWpRef.current[seg.id] || [];
            if (wpArr.length === 0) continue;
            wpIdx = wpArr.length - 1;
            wpZArr = _wpZ[seg.id] || [];
            const farWp = wpArr.length > 1 ? wpArr[wpArr.length - 2] : null;
            const farNode = _amp[seg.from];
            farX = farWp ? farWp.x : (farNode ? farNode.x : null);
            farZ = farWp ? (wpZArr[wpArr.length - 2] ?? 0) : (farNode ? farNode.z ?? 0 : null);
          } else { continue; }
          if (farX == null) continue;
          const wp = wpArr[wpIdx], wpZv = wpZArr[wpIdx] ?? 0;
          const vAx = wp.x - nx, vAy = wpZv - newZ;  // icon→wp (X-Z空間)
          const vBx = farX - wp.x, vBy = farZ - wpZv; // wp→far
          const lenA = Math.sqrt(vAx*vAx + vAy*vAy), lenB = Math.sqrt(vBx*vBx + vBy*vBy);
          if (lenA < 1 || lenB < 1) continue;
          const cosAng = (vAx*vBx + vAy*vBy) / (lenA * lenB);
          if (Math.abs(cosAng) < 0.035) {
            if (snapKey) {
              // 列スナップ中: X固定、Zのみ調整
              const bz = farZ - wpZv;
              if (Math.abs(bz) > 0.1) newZ = Math.max(MIN_Z, Math.min(MAX_Z, wpZv - (wp.x - nx) * (farX - wp.x) / bz));
            } else {
              // 非列スナップ: (nx,newZ)をwpを通るvB⊥線に投影 (X-Z空間)
              const div = vBx*vBx + vBy*vBy;
              if (div > 0) {
                const t = ((nx - wp.x)*(-vBy) + (newZ - wpZv)*vBx) / div;
                nx = wp.x + t*(-vBy);
                newZ = Math.max(MIN_Z, Math.min(MAX_Z, wpZv + t*vBx));
              }
            }
            // マーク情報: SVG座標でのdA(icon→wp), dB(wp→far)
            const dAx_ = wp.x - nx, dAy_ = newZ - wpZv;         // SVG: (wpX-iX, wpY-iY) where Y=GL_Y-Z
            const dBx_ = farX - wp.x, dBy_ = wpZv - farZ;        // SVG: (fX-wpX, fY-wpY)
            const dAl = Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1, dBl = Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            perpInfo = { svgX: wp.x, svgY: GL_Y - wpZv, dAx: dAx_/dAl, dAy: dAy_/dAl, dBx: dBx_/dBl, dBy: dBy_/dBl };
            break perpOuter;
          }
        }
        iconPerpSnapRef.current = perpInfo;
        // setMapPos/setMapZ不使用 → DOM直接更新（全ビューリアルタイム反映）
        _elevLivePosRef.current = { x: nx, z: newZ };
        _applyElevDragDOM(elevDrag.id, nx, newZ);
      }
    };
    const up = () => {
      grabOff();
      iconSnapWpRef.current = null; iconPerpSnapRef.current = null;
      iconDragging.current = false;
      isDraggingRef.current = false;
      const lp = _elevLivePosRef.current;
      _elevLivePosRef.current = null;
      if (lp) {
        const snappedX = snapFineV(Math.max(0, Math.min(TW, lp.x)), elevZoomRef.current);
        const snappedZ = snapFineV(lp.z, elevZoomRef.current);
        setMapPos(pr => { const p = pr[elevDrag.id]; return p ? { ...pr, [elevDrag.id]: { ...p, x: snappedX } } : pr; });
        setMapZ(pr => ({ ...pr, [elevDrag.id]: snappedZ }));
      } else {
        setMapZ(pr => { const z = pr[elevDrag.id]; return z !== undefined ? { ...pr, [elevDrag.id]: snapFineV(z, elevZoomRef.current) } : pr; });
        setMapPos(pr => { const p = pr[elevDrag.id]; return p ? { ...pr, [elevDrag.id]: { ...p, x: snapFineV(Math.max(0, Math.min(TW, p.x)), elevZoomRef.current) } } : pr; });
      }
      setElevDrag(null);
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { grabOff(); iconPerpSnapRef.current = null; window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [elevDrag, mapPos, nodes, segs, segWp]);

  // side drag — Y,Z調整（側面図）
  useEffect(() => {
    if (!sideDrag) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    iconDragging.current = true;
    isDraggingRef.current = true;
    cesium3dRenderRef.current?.pause?.();
    cesium2dRenderRef.current?.pause?.();
    movedNodeRef.current = sideDrag.id;
    { const _connSegs = connectedSegsMapRef.current[sideDrag.id] || [];
      const _pi = document.getElementById('pi-' + sideDrag.id);
      const _ci = document.getElementById('ci-' + sideDrag.id);
      const _cab = cabRef.current;
      const cW = _cab?.clientWidth || CAB_W, cH = _cab?.clientHeight || CAB_H;
      const sc = Math.min(cW / CAB_W, cH / CAB_H);
      const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
      _connSegs.forEach(seg => {
        const pw = document.getElementById('pw-' + seg.id), ew = document.getElementById('ew-' + seg.id);
        const sw = document.getElementById('sw-' + seg.id), cw = document.getElementById('cw-' + seg.id);
        const cwh = document.getElementById('cwh-' + seg.id);
        if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
        if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
        if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
        cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
      });
      _dragGeomCache.current = {
        piEl: _pi, eiEl: document.getElementById('ei-' + sideDrag.id),
        siEl: document.getElementById('si-' + sideDrag.id), ciEl: _ci,
        piHW: _pi ? _pi.offsetWidth/2 : 21, piHH: _pi ? _pi.offsetHeight/2 : 23,
        eiHW: 21, siHW: 21,
        cabHW: _ci ? _ci.offsetWidth/2 : 14, cabHH: _ci ? _ci.offsetHeight/2 : 15,
        cabOx: (cW - CAB_W * sc) / 2, cabOy: (cH - CAB_H * sc) / 2, cabSc: sc,
        connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
      };
    }
    const mv = ev => {
      ev.preventDefault();
      const p = toP(sideRef, ev);
      let newY = Math.max(0, Math.min(TH, p.x));
      let newZ = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - p.y));
      // 折れ点Y列へスナップ
      const _sz = sideZoomRef.current || 1;
      const SNAP_T = 15 / _sz;
      let snapKey = null;
      outer: for (const [sid, wps] of Object.entries(segWp)) {
        for (let i = 0; i < wps.length; i++) {
          if (Math.abs(newY - wps[i].y) < SNAP_T) { newY = wps[i].y; snapKey = `${sid}_${i}`; break outer; }
        }
      }
      iconSnapWpRef.current = snapKey;

      // 直角スナップ: 接続セグメントの最初の折れ点との角度チェック (Y-Z平面)
      let perpInfo = null;
      const _wpZ = wpZRef.current, _amp = allMapPosRef.current;
      perpOuter: for (const seg of segs) {
        let wpArr, wpZArr, wpIdx, farY, farZ;
        if (seg.from === sideDrag.id) {
          wpArr = segWp[seg.id] || [];
          if (wpArr.length === 0) continue;
          wpIdx = 0;
          wpZArr = _wpZ[seg.id] || [];
          const farWp = wpArr[1], farNode = _amp[seg.to];
          farY = farWp ? farWp.y : (farNode ? farNode.y : null);
          farZ = farWp ? (wpZArr[1] ?? 0) : (farNode ? farNode.z ?? 0 : null);
        } else if (seg.to === sideDrag.id) {
          wpArr = segWp[seg.id] || [];
          if (wpArr.length === 0) continue;
          wpIdx = wpArr.length - 1;
          wpZArr = _wpZ[seg.id] || [];
          const farWp = wpArr.length > 1 ? wpArr[wpArr.length - 2] : null;
          const farNode = _amp[seg.from];
          farY = farWp ? farWp.y : (farNode ? farNode.y : null);
          farZ = farWp ? (wpZArr[wpArr.length - 2] ?? 0) : (farNode ? farNode.z ?? 0 : null);
        } else { continue; }
        if (farY == null) continue;
        const wp = wpArr[wpIdx], wpZv = wpZArr[wpIdx] ?? 0;
        const vAx = wp.y - newY, vAy = wpZv - newZ;  // icon→wp (Y-Z空間)
        const vBx = farY - wp.y, vBy = farZ - wpZv;   // wp→far
        const lenA = Math.sqrt(vAx*vAx + vAy*vAy), lenB = Math.sqrt(vBx*vBx + vBy*vBy);
        if (lenA < 1 || lenB < 1) continue;
        const cosAng = (vAx*vBx + vAy*vBy) / (lenA * lenB);
        if (Math.abs(cosAng) < 0.035) {
          if (snapKey) {
            // 列スナップ中: Y固定、Zのみ調整
            const bz = farZ - wpZv;
            if (Math.abs(bz) > 0.1) newZ = Math.max(MIN_Z, Math.min(MAX_Z, wpZv - (wp.y - newY) * (farY - wp.y) / bz));
          } else {
            // 非列スナップ: (newY,newZ)をwpを通るvB⊥線に投影 (Y-Z空間)
            const div = vBx*vBx + vBy*vBy;
            if (div > 0) {
              const t = ((newY - wp.y)*(-vBy) + (newZ - wpZv)*vBx) / div;
              newY = Math.max(0, Math.min(TH, wp.y + t*(-vBy)));
              newZ = Math.max(MIN_Z, Math.min(MAX_Z, wpZv + t*vBx));
            }
          }
          // マーク情報: SVG座標でのdA(icon→wp), dB(wp→far) (side: svgX=worldY)
          const dAx_ = wp.y - newY, dAy_ = newZ - wpZv;
          const dBx_ = farY - wp.y, dBy_ = wpZv - farZ;
          const dAl = Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1, dBl = Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
          perpInfo = { svgX: wp.y, svgY: GL_Y - wpZv, dAx: dAx_/dAl, dAy: dAy_/dAl, dBx: dBx_/dBl, dBy: dBy_/dBl };
          break perpOuter;
        }
      }
      iconPerpSnapRef.current = perpInfo;
      // DOM直接更新（全ビューリアルタイム反映）
      _sideLivePosRef.current = { y: newY, z: newZ };
      _applySideDragDOM(sideDrag.id, newY, newZ);
    };
    const up = () => {
      grabOff();
      iconSnapWpRef.current = null; iconPerpSnapRef.current = null;
      iconDragging.current = false;
      isDraggingRef.current = false;
      const lp = _sideLivePosRef.current;
      _sideLivePosRef.current = null;
      if (lp) {
        const snappedY = snapFineV(Math.max(0, Math.min(TH, lp.y)), sideZoomRef.current);
        const snappedZ = snapFineV(lp.z, sideZoomRef.current);
        setMapPos(pr => { const p = pr[sideDrag.id]; return p ? { ...pr, [sideDrag.id]: { ...p, y: snappedY } } : pr; });
        setMapZ(pr => ({ ...pr, [sideDrag.id]: snappedZ }));
      } else {
        setMapPos(pr => { const p = pr[sideDrag.id]; return p ? { ...pr, [sideDrag.id]: { ...p, y: snapFineV(p.y, sideZoomRef.current) } } : pr; });
        setMapZ(pr => { const z = pr[sideDrag.id]; return z !== undefined ? { ...pr, [sideDrag.id]: snapFineV(z, sideZoomRef.current) } : pr; });
      }
      setSideDrag(null);
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { grabOff(); iconPerpSnapRef.current = null; window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [sideDrag, segWp, segs]);

  // secNodeDrag — 矢視図ノード移動（along軸+Z）＋直角スナップ
  useEffect(() => {
    if (!secNodeDrag) return;
    const { id: nid, secId } = secNodeDrag;

    // 断面図・側面図と同様: isDraggingRef=true でCesium重処理をブロック + wireCanvasオーバーレイ
    isDraggingRef.current = true;
    const _secConnSegs = connectedSegsMapRef.current[nid] || [];
    const _secPos0 = { ...(allMapPosRef.current[nid] || {}), nodeId: nid };
    const _secOv3d = _buildCesiumWireOverlay(cesium3dQueryRef, _secConnSegs, _secPos0);
    const _secOv2d = _buildCesiumWireOverlay(cesium2dQueryRef, _secConnSegs, _secPos0);

    const mv = ev => {
      ev.preventDefault();
      const vd = secViewDataRef.current[secId]; if (!vd) return;
      const el = secRefs.current[secId]?.el; if (!el) return;
      const r = el.getBoundingClientRect();
      const zoom = secZoomsRef.current[secId] || 1;
      let px = (ev.clientX - r.left) / zoom;
      let py = (ev.clientY - r.top) / zoom;
      const { viewEdge, rect, dynSecGLY, SPD: _spd, dynMaxZ: _dynMaxZ, dynSEC_W: _dSW } = vd;
      // YZ面回転中はカーソル座標を逆回転してからalong/Z変換
      const _sRot = secRotatesRef.current[secId] || 0;
      if (_sRot !== 0) {
        const θ = _sRot * Math.PI / 180;
        const rcx = (_dSW || 300) / 2, rcy = dynSecGLY;
        const dx = px - rcx, dy = py - rcy;
        px = rcx + dx * Math.cos(θ) - dy * Math.sin(θ);
        py = rcy + dx * Math.sin(θ) + dy * Math.cos(θ);
      }
      const isXView = viewEdge === 'top' || viewEdge === 'bottom';
      const toAlong = (wA) => viewEdge==='top' ? wA-rect.x1 : viewEdge==='bottom' ? rect.x2-wA : viewEdge==='left' ? wA-rect.y1 : rect.y2-wA;
      const toWorldA = (a) => viewEdge==='top' ? a+rect.x1 : viewEdge==='bottom' ? rect.x2-a : viewEdge==='left' ? a+rect.y1 : rect.y2-a;
      const _secLenMv = vd.halfA !== undefined
        ? ((vd.viewEdge==='top'||vd.viewEdge==='bottom') ? vd.halfA*2 : vd.halfB*2)
        : ((vd.viewEdge==='top'||vd.viewEdge==='bottom') ? (vd.rect?.x2-vd.rect?.x1||300) : (vd.rect?.y2-vd.rect?.y1||300));
      let along = Math.max(0, Math.min(_secLenMv, px - _spd)); // 上限もクランプ
      let newZ = Math.max(MIN_Z, Math.min(MAX_Z, dynSecGLY - py));

      // 直角スナップ（along-Z平面）
      let perpInfo = null;
      const _wpZ = wpZRef.current, _amp = allMapPosRef.current;
      perpOuter: for (const seg of segs) {
        let wpArr, wpZArr, wpIdx, farAlong, farZ;
        const iconIsFrom = seg.from === nid, iconIsTo = seg.to === nid;
        if (!iconIsFrom && !iconIsTo) continue;
        wpArr = segWp[seg.id] || [];
        wpZArr = _wpZ[seg.id] || [];
        if (wpArr.length === 0) continue;
        if (iconIsFrom) {
          wpIdx = 0;
          const fw = wpArr[1], fn = _amp[seg.to];
          const fwA = fw ? (isXView ? fw.x : fw.y) : (fn ? (isXView ? fn.x : fn.y) : null);
          farAlong = fwA != null ? toAlong(fwA) : null;
          farZ = fw ? (wpZArr[1] ?? 0) : (fn ? (mapZ[seg.to] ?? 0) : null);
        } else {
          wpIdx = wpArr.length - 1;
          const fw = wpArr.length > 1 ? wpArr[wpArr.length - 2] : null, fn = _amp[seg.from];
          const fwA = fw ? (isXView ? fw.x : fw.y) : (fn ? (isXView ? fn.x : fn.y) : null);
          farAlong = fwA != null ? toAlong(fwA) : null;
          farZ = fw ? (wpZArr[wpArr.length - 2] ?? 0) : (fn ? (mapZ[seg.from] ?? 0) : null);
        }
        if (farAlong == null) continue;
        const wp = wpArr[wpIdx], wpZv = wpZArr[wpIdx] ?? 0;
        const wpAlong = toAlong(isXView ? wp.x : wp.y);
        const vAx = wpAlong - along, vAy = wpZv - newZ;
        const vBx = farAlong - wpAlong, vBy = farZ - wpZv;
        const lenA = Math.sqrt(vAx*vAx + vAy*vAy), lenB = Math.sqrt(vBx*vBx + vBy*vBy);
        if (lenA < 1 || lenB < 1) continue;
        const cosAng = (vAx*vBx + vAy*vBy) / (lenA * lenB);
        if (Math.abs(cosAng) < 0.035) {
          const div = vBx*vBx + vBy*vBy;
          if (div > 0) {
            const t = ((along - wpAlong)*(-vBy) + (newZ - wpZv)*vBx) / div;
            along = wpAlong + t*(-vBy);
            newZ = Math.max(MIN_Z, Math.min(MAX_Z, wpZv + t*vBx));
          }
          const dAx_ = wpAlong - along, dAy_ = newZ - wpZv;
          const dBx_ = farAlong - wpAlong, dBy_ = wpZv - farZ;
          const dAl = Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1, dBl = Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
          perpInfo = { svgX: _spd + wpAlong, svgY: dynSecGLY - wpZv, dAx: dAx_/dAl, dAy: dAy_/dAl, dBx: dBx_/dBl, dBy: dBy_/dBl };
          break perpOuter;
        }
      }
      iconPerpSnapRef.current = perpInfo;

      let newX, newY;
      if (vd.center !== undefined) {
        // OBB矢視: plant座標系（pnRad回転）ベースで逆変換
        // along → pA/pB を算出し、DepthはOld位置から保持して world (x,y) を再構築
        const { center, halfA: _hA, halfB: _hB, secPnRad: _sPnR } = vd;
        const _c = Math.cos(_sPnR), _s = Math.sin(_sPnR);
        const _old = allMapPosRef.current[nid] || { x: TW / 2, y: TH / 2 };
        const _dx0 = _old.x - center.x, _dy0 = _old.y - center.y;
        const pA_old = _dx0 * _c + _dy0 * _s;
        const pB_old = _dx0 * _s - _dy0 * _c;
        let pA_new, pB_new;
        if (viewEdge === 'top')         { pA_new = _hA - along;  pB_new = pB_old; }
        else if (viewEdge === 'bottom') { pA_new = along - _hA; pB_new = pB_old; }
        else if (viewEdge === 'left')   { pB_new = _hB - along;  pA_new = pA_old; }
        else                            { pB_new = along - _hB;  pA_new = pA_old; }
        newX = center.x + pA_new * _c + pB_new * _s;
        newY = center.y + pA_new * _s - pB_new * _c;
      } else {
        // AABB矢視（旧形式、pnRad=0想定）
        const worldA = Math.max(0, Math.min(isXView ? TW : TH, toWorldA(along)));
        const _old = allMapPosRef.current[nid] || { x: TW / 2, y: TH / 2 };
        newX = isXView ? worldA : _old.x;
        newY = isXView ? _old.y : worldA;
      }
      newX = Math.max(0, Math.min(TW, newX));
      newY = Math.max(0, Math.min(TH, newY));
      // state更新（isDraggingRef=trueでCesium [allMapPos]エフェクトはブロック済み）
      setMapPos(pr => ({ ...pr, [nid]: { x: newX, y: newY } }));
      setMapZ(pr => ({ ...pr, [nid]: newZ }));
      // ドラッグ中アイコンをビューポート内に保つ自動スクロール
      { const _scrollEl = el?.parentElement;
        if (_scrollEl) {
          const _zoom = secZoomsRef.current[secId] || 1;
          const _iconPxY = (dynSecGLY - newZ) * _zoom;
          const _margin = 40 * _zoom;
          if (_iconPxY < _scrollEl.scrollTop + _margin)
            _scrollEl.scrollTop = Math.max(0, _iconPxY - _margin);
          else if (_iconPxY > _scrollEl.scrollTop + _scrollEl.clientHeight - _margin)
            _scrollEl.scrollTop = _iconPxY - _scrollEl.clientHeight + _margin;
        }
      }
      // Cesium wireCanvasに直接描画（断面図・側面図と同様）
      _updateCesiumWireOverlay(_secOv3d, newX, newY, newZ);
      _updateCesiumWireOverlay(_secOv2d, newX, newY, newZ);
    };
    const up = () => {
      iconPerpSnapRef.current = null;
      const _secZoom = secZoomsRef.current[secId] || 1;
      const _cur = allMapPosRef.current[nid] || {};
      const snX = snapFineV(_cur.x || 0, _secZoom);
      const snY = snapFineV(_cur.y || 0, _secZoom);
      const snZ = snapFineV(mapZRef.current[nid] || 0, _secZoom);
      _pendingNonCesiumTeardownRef.current = {
        ov3d: _secOv3d, ov2d: _secOv2d,
        finalPos: { x: snX, y: snY, z: snZ },
        nodeId: nid
      };
      setMapPos(pr => { const p = pr[nid]; return p ? { ...pr, [nid]: { x: snX, y: snY } } : pr; });
      setMapZ(pr => { const z = pr[nid]; return z !== undefined ? { ...pr, [nid]: snZ } : pr; });
      setSecNodeDrag(null); iconDragging.current = false;
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => {
      iconPerpSnapRef.current = null;
      _pendingNonCesiumTeardownRef.current = null;
      _teardownCesiumWireOverlay(_secOv3d);
      _teardownCesiumWireOverlay(_secOv2d);
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up);
    };
  }, [secNodeDrag, segs, segWp, mapZ]);

  // T drag
  useEffect(() => {
    if (!tDrag) return;
    const mv = ev => {
      ev.preventDefault();
      const ref = tDrag.view === "plan" ? planRef : tDrag.view === "cab" ? cabRef : elevRef;
      const p = toP(ref, ev); const pp = tDrag.view === "cab" ? unproj(p.x, p.y) : p;
      const seg = segs.find(s => s.id === tDrag.segId); if (!seg) return;
      const aP = mapPos[seg.from], bP = mapPos[seg.to]; if (!aP || !bP) return;
      setOnSegT(pr => ({ ...pr, [tDrag.brId]: projSeg(pp, aP, bP) }));
    };
    const up = () => { setTDrag(null); iconDragging.current = false; };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [tDrag, segs, mapPos]);

  // waypoint add (plan view - XY coords)
  const addWp = (sid, cx, cy, zoom) => {
    const _z = zoom || 1;
    setSegWp(prev => {
      const seg = segs.find(x => x.id === sid); const a = allMapPos[seg.from], b = allMapPos[seg.to]; if (!a || !b) return prev;
      const wps = prev[sid] || []; const path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) { const dx = path[i + 1].x - path[i].x, dy = path[i + 1].y - path[i].y, l2 = dx * dx + dy * dy; let t = l2 === 0 ? 0 : ((cx - path[i].x) * dx + (cy - path[i].y) * dy) / l2; t = Math.max(0, Math.min(1, t)); const dd = Math.sqrt((cx - (path[i].x + t * dx)) ** 2 + (cy - (path[i].y + t * dy)) ** 2); if (dd < bd) { bd = dd; bs = i; } }
      // 垂直オフセット: 画面上MAJOR px相当（zoom依存）
      const sdx = path[bs + 1].x - path[bs].x, sdy = path[bs + 1].y - path[bs].y;
      const slen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
      const off = MAJOR / _z;
      const nx = cx + (-sdy / slen) * off, ny = cy + (sdx / slen) * off;
      const nw = [...wps]; nw.splice(bs, 0, snapFine(nx, ny, _z)); return { ...prev, [sid]: nw };
    });
  };
  // waypoint add (elev view - X,Z coords)
  const addWpElev = (sid, cx, cy, zoom) => {
    const _z = zoom || 1;
    const wx = snapFineV(cx, _z);
    const wz = snapFineV(Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - cy + MAJOR / _z)), _z); // zoom依存オフセット（画面上MAJOR px）
    setSegWp(prev => {
      const seg = segs.find(x => x.id === sid); const a = allMapPos[seg.from], b = allMapPos[seg.to]; if (!a || !b) return prev;
      const wps = prev[sid] || []; const path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const dd = Math.abs((path[i].x + path[i + 1].x) / 2 - wx);
        if (dd < bd) { bd = dd; bs = i; }
      }
      // 平面Y座標は前後の中点を使う
      const midY = (path[bs].y + path[Math.min(bs + 1, path.length - 1)].y) / 2;
      const nw = [...wps]; nw.splice(bs, 0, { x: wx, y: midY }); return { ...prev, [sid]: nw };
    });
    setWpZ(prev => {
      const wps = segWp[sid] || [];
      // 新しく追加された分のZを設定（簡易的に末尾に追加）
      const zs = [...(prev[sid] || [])];
      // addWpで挿入されたindexと同じ位置にzを挿入
      const seg = segs.find(x => x.id === sid); const a = allMapPos[seg.from], b = allMapPos[seg.to];
      if (!a || !b) return prev;
      const path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const dd = Math.abs((path[i].x + path[i + 1].x) / 2 - wx);
        if (dd < bd) { bd = dd; bs = i; }
      }
      zs.splice(bs, 0, wz);
      return { ...prev, [sid]: zs };
    });
  };
  // waypoint add (side view - Y,Z coords)
  const addWpSide = (sid, cx, cy, zoom) => {
    const _z = zoom || 1;
    const wy = snapFineV(cx, _z);
    const wz = snapFineV(Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - cy + MAJOR / _z)), _z); // zoom依存オフセット（画面上MAJOR px）
    setSegWp(prev => {
      const seg = segs.find(x => x.id === sid); const a = allMapPos[seg.from], b = allMapPos[seg.to]; if (!a || !b) return prev;
      const wps = prev[sid] || []; const path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const dd = Math.abs((path[i].y + path[i + 1].y) / 2 - wy);
        if (dd < bd) { bd = dd; bs = i; }
      }
      const midX = (path[bs].x + path[Math.min(bs + 1, path.length - 1)].x) / 2;
      const nw = [...wps]; nw.splice(bs, 0, { x: midX, y: wy }); return { ...prev, [sid]: nw };
    });
    setWpZ(prev => {
      const wps = segWp[sid] || [];
      const zs = [...(prev[sid] || [])];
      const seg = segs.find(x => x.id === sid); const a = allMapPos[seg.from], b = allMapPos[seg.to];
      if (!a || !b) return prev;
      const path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const dd = Math.abs((path[i].y + path[i + 1].y) / 2 - wy);
        if (dd < bd) { bd = dd; bs = i; }
      }
      zs.splice(bs, 0, wz);
      return { ...prev, [sid]: zs };
    });
  };
  // waypoint add (sec view - along, Z coords)
  const addWpSec = (sec, sid, ev, dynSecGLY, SPD_s, segZ) => {
    const { rect, viewEdge } = sec;
    const isXView = viewEdge === 'top' || viewEdge === 'bottom';
    const secEl = secRefs.current[sec.id]?.el; if (!secEl) return;
    const r = secEl.getBoundingClientRect();
    const evC = ev.touches ? ev.touches[0] : ev;
    const svgX = (evC.clientX - r.left) / segZ;
    const svgY = (evC.clientY - r.top) / segZ;
    const along0 = svgX - SPD_s;
    const wz = snapFineV(Math.max(MIN_Z, Math.min(MAX_Z, dynSecGLY - svgY + MAJOR / segZ)), segZ);
    // OBBセクション（sec.center有）はtop/bottomの方向がAABBと逆
    const _aWsOBB = !!(sec.center);
    let worldA;
    if (viewEdge === 'top') worldA = _aWsOBB ? rect.x2 - along0 : along0 + rect.x1;
    else if (viewEdge === 'bottom') worldA = _aWsOBB ? along0 + rect.x1 : rect.x2 - along0;
    else if (viewEdge === 'left') worldA = along0 + rect.y1;
    else worldA = rect.y2 - along0;
    worldA = snapFineV(Math.max(0, Math.min(isXView ? TW : TH, worldA)), segZ);
    setSegWp(prev => {
      const seg_f = segs.find(x => x.id === sid); if (!seg_f) return prev;
      const a = allMapPos[seg_f.from], b = allMapPos[seg_f.to]; if (!a || !b) return prev;
      const wps = prev[sid] || [], path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const pA = isXView ? path[i].x : path[i].y, pB = isXView ? path[i+1].x : path[i+1].y;
        const dd = Math.abs((pA + pB) / 2 - worldA); if (dd < bd) { bd = dd; bs = i; }
      }
      const nw = [...wps];
      if (isXView) { const midY = (path[bs].y + path[Math.min(bs+1,path.length-1)].y)/2; nw.splice(bs, 0, {x:worldA,y:midY}); }
      else { const midX = (path[bs].x + path[Math.min(bs+1,path.length-1)].x)/2; nw.splice(bs, 0, {x:midX,y:worldA}); }
      return { ...prev, [sid]: nw };
    });
    setWpZ(prev => {
      const wps = segWp[sid] || [], zs = [...(prev[sid] || [])];
      const seg_f = segs.find(x => x.id === sid); if (!seg_f) return prev;
      const a = allMapPos[seg_f.from], b = allMapPos[seg_f.to]; if (!a || !b) return prev;
      const path = [a, ...wps, b];
      let bs = 0, bd = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const pA = isXView ? path[i].x : path[i].y, pB = isXView ? path[i+1].x : path[i+1].y;
        const dd = Math.abs((pA + pB) / 2 - worldA); if (dd < bd) { bd = dd; bs = i; }
      }
      zs.splice(bs, 0, wz);
      return { ...prev, [sid]: zs };
    });
  };
  // waypoint add (3D view - screen coords → world)
  const addWpCab = (sid, screenX, screenY) => {
    const seg = segs.find(x => x.id === sid);
    if (!seg) return;
    const a = allMapPos[seg.from], b = allMapPos[seg.to];
    if (!a || !b) return;
    const wps = segWp[sid] || [];
    const wzs = wpZ[sid] || [];
    const path = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
    // 画面上の各セグメントの中点との距離で挿入位置を決定
    const tPath = path.map(p => proj(p.x, p.y, p.z || 0));
    let bs = 0, bd = Infinity;
    for (let i = 0; i < tPath.length - 1; i++) {
      const mx = (tPath[i].x + tPath[i + 1].x) / 2;
      const my = (tPath[i].y + tPath[i + 1].y) / 2;
      const dd = (screenX - mx) ** 2 + (screenY - my) ** 2;
      if (dd < bd) { bd = dd; bs = i; }
    }
    // ワールド座標: unprojectでXY取得、Zは前後の中間 + オフセット（生成を視覚的に明確化）
    const wp = unproj(screenX, screenY);
    const z1 = path[bs].z || 0, z2 = path[Math.min(bs + 1, path.length - 1)].z || 0;
    const newZ = (z1 + z2) / 2;
    // 最近接セグメントの垂直方向にXYオフセット
    const _sdx = path[bs + 1].x - path[bs].x, _sdy = path[bs + 1].y - path[bs].y;
    const _sl = Math.sqrt(_sdx * _sdx + _sdy * _sdy) || 1;
    setSegWp(prev => { const w = [...(prev[sid] || [])]; w.splice(bs, 0, snap(wp.x + (-_sdy/_sl)*MAJOR, wp.y + (_sdx/_sl)*MAJOR)); return { ...prev, [sid]: w }; });
    setWpZ(prev => { const w = [...(prev[sid] || [])]; w.splice(bs, 0, newZ); return { ...prev, [sid]: w }; });
  };
  // 直交スナップ作図: lastPosからクリック位置への移動を最も支配的な軸にスナップ
  const addWpOrtho = (sid, screenX, screenY, lastPos) => {
    // 3軸方向の画面上ベクトル
    const o = proj(lastPos.x, lastPos.y, lastPos.z);
    const step = MAJOR; // 1グリッド単位
    const axes = [
      { axis: "x", tip: proj(lastPos.x + step, lastPos.y, lastPos.z) },
      { axis: "y", tip: proj(lastPos.x, lastPos.y + step, lastPos.z) },
      { axis: "z", tip: proj(lastPos.x, lastPos.y, lastPos.z + step) },
    ];
    // マウス移動ベクトル
    const mdx = screenX - o.x, mdy = screenY - o.y;
    const mlen = Math.sqrt(mdx * mdx + mdy * mdy);
    if (mlen < 5) return null;
    // 各軸への射影量を計算し、最大の軸を選択
    let bestAxis = null, bestProj = 0;
    axes.forEach(({ axis, tip }) => {
      const adx = tip.x - o.x, ady = tip.y - o.y;
      const alen = Math.sqrt(adx * adx + ady * ady);
      if (alen < 1) return;
      const ux = adx / alen, uy = ady / alen;
      const p = mdx * ux + mdy * uy;
      if (Math.abs(p) > Math.abs(bestProj)) { bestProj = p; bestAxis = axis; }
    });
    if (!bestAxis) return null;
    // 射影量をワールド座標の移動量に変換
    const chosenTip = axes.find(a => a.axis === bestAxis).tip;
    const adx = chosenTip.x - o.x, ady = chosenTip.y - o.y;
    const alen = Math.sqrt(adx * adx + ady * ady);
    const worldDelta = snapV(bestProj * (step / alen));
    // 新しい折れ点位置
    let nx = lastPos.x, ny = lastPos.y, nz = lastPos.z;
    if (bestAxis === "x") nx += worldDelta;
    else if (bestAxis === "y") ny += worldDelta;
    else nz += worldDelta;
    // セグメントの末尾に折れ点を追加
    setSegWp(prev => { const w = [...(prev[sid] || [])]; w.push({ x: nx, y: ny }); return { ...prev, [sid]: w }; });
    setWpZ(prev => { const w = [...(prev[sid] || [])]; w.push(nz); return { ...prev, [sid]: w }; });
    return { x: nx, y: ny, z: nz };
  };
  const rmWp = (sid, wi) => {
    setSegWp(prev => { const w = [...(prev[sid] || [])]; w.splice(wi, 1); return { ...prev, [sid]: w }; });
    setWpZ(prev => { const w = [...(prev[sid] || [])]; w.splice(wi, 1); return { ...prev, [sid]: w }; });
  };

  // wpDrag effect
  useEffect(() => {
    if (!wpDrag) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    // Cesiumのwire polyline + wp entity + SVG rect を直接更新（Reactサイクル待ちなし）
    const _cesiumWpUpdate = (newWpX, newWpY, newWpZ) => {
      const _seg = segsRef.current.find(s => s.id === wpDrag.sid); if (!_seg) return;
      const _wps = [...(segWpRef.current[wpDrag.sid] || [])];
      const _wzs = [...(wpZRef.current[wpDrag.sid] || [])];
      if (_wps[wpDrag.wi]) { _wps[wpDrag.wi] = { x: newWpX, y: newWpY }; }
      _wzs[wpDrag.wi] = newWpZ;
      const _fromP = allMapPosRef.current[_seg.from] || {};
      const _toP = allMapPosRef.current[_seg.to] || {};
      const _path = [
        { x: _fromP.x || 0, y: _fromP.y || 0, z: mapZRef.current[_seg.from] || 0 },
        ..._wps.map((w, i) => ({ x: w.x, y: w.y, z: _wzs[i] || 0 })),
        { x: _toP.x || 0, y: _toP.y || 0, z: mapZRef.current[_seg.to] || 0 }
      ];
      cesium3dQueryRef.current?.updateWpDirect?.(wpDrag.sid, _path);
      cesium2dQueryRef.current?.updateWpDirect?.(wpDrag.sid, _path);
    };
    const mv = ev => {
      ev.preventDefault();
      if (wpDrag.view.startsWith("sec")) {
        const secId = wpDrag.view;
        const vd = secViewDataRef.current[secId]; if (!vd) return;
        const { dynSecGLY: _dSGLY, SPD: _SPD, viewEdge, rect } = vd;
        const secEl = secRefs.current[secId]?.el; if (!secEl) return;
        const _sz = secZoomsRef.current[secId] || 1;
        const evC = ev.touches ? ev.touches[0] : ev;
        const elR = secEl.getBoundingClientRect();
        const svgX = (evC.clientX - elR.left) / _sz, svgY = (evC.clientY - elR.top) / _sz;
        const isXView = viewEdge === 'top' || viewEdge === 'bottom';
        // OBBセクション（sec.center有）はtop/bottomの方向がAABBと逆（OBBのalong軸がAABBと逆向き）
        const _hasOBB = !!(vd.center);
        const toAlong = (wA) => _hasOBB
          ? (viewEdge==='top' ? rect.x2-wA : viewEdge==='bottom' ? wA-rect.x1 : viewEdge==='left' ? wA-rect.y1 : rect.y2-wA)
          : (viewEdge==='top' ? wA-rect.x1 : viewEdge==='bottom' ? rect.x2-wA : viewEdge==='left' ? wA-rect.y1 : rect.y2-wA);
        const toWorldA = (a) => _hasOBB
          ? (viewEdge==='top' ? rect.x2-a : viewEdge==='bottom' ? a+rect.x1 : viewEdge==='left' ? a+rect.y1 : rect.y2-a)
          : (viewEdge==='top' ? a+rect.x1 : viewEdge==='bottom' ? rect.x2-a : viewEdge==='left' ? a+rect.y1 : rect.y2-a);
        let worldA = Math.max(0, Math.min(isXView ? TW : TH, toWorldA(svgX - _SPD)));
        let wz = Math.max(MIN_Z, Math.min(MAX_Z, _dSGLY - svgY));
        const SNAP_T = 15 / _sz;
        let snapId = null;
        for (const [nid, np] of Object.entries(allMapPos)) {
          const nA = isXView ? np.x : np.y;
          if (Math.abs(worldA - nA) < SNAP_T) { worldA = nA; snapId = nid; break; }
        }
        wpSnapIconRef.current = snapId;
        const pA = isXView ? wpDrag.prevX : wpDrag.prevY, pZ2 = wpDrag.prevZ ?? 0;
        const nA2 = isXView ? wpDrag.nextX : wpDrag.nextY, nZ2 = wpDrag.nextZ ?? 0;
        const ppA = isXView ? wpDrag.prevPrevX : wpDrag.prevPrevY, ppZ2 = wpDrag.prevPrevZ ?? 0;
        const nnA = isXView ? wpDrag.nextNextX : wpDrag.nextNextY, nnZ2 = wpDrag.nextNextZ ?? 0;
        const allMarks_sec = []; let secSnapped = false;
        // Check 1: 自コーナー
        if (pA!=null && nA2!=null) {
          const vAx=worldA-pA,vAz=wz-pZ2,vBx=nA2-worldA,vBz=nZ2-wz;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!secSnapped){secSnapped=true;}
            const sx=_SPD+toAlong(worldA),sy=_dSGLY-wz,sPx=_SPD+toAlong(pA),sPy=_dSGLY-pZ2,sNx=_SPD+toAlong(nA2),sNy=_dSGLY-nZ2;
            const dAx_=sx-sPx,dAy_=sy-sPy,dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=sNx-sx,dBy_=sNy-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_sec.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 2: 次コーナー
        if (nA2!=null && nnA!=null) {
          const vAx=nA2-worldA,vAz=nZ2-wz,vBx=nnA-nA2,vBz=nnZ2-nZ2;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!secSnapped){secSnapped=true;}
            const sx=_SPD+toAlong(nA2),sy=_dSGLY-nZ2,sWx=_SPD+toAlong(worldA),sWy=_dSGLY-wz,sNx=_SPD+toAlong(nnA),sNy=_dSGLY-nnZ2;
            const dAx_=sx-sWx,dAy_=sy-sWy,dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=sNx-sx,dBy_=sNy-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_sec.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 3: 前コーナー
        if (pA!=null && ppA!=null) {
          const vAx=pA-ppA,vAz=pZ2-ppZ2,vBx=worldA-pA,vBz=wz-pZ2;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!secSnapped){secSnapped=true;}
            const sx=_SPD+toAlong(pA),sy=_dSGLY-pZ2,sPPx=_SPD+toAlong(ppA),sPPy=_dSGLY-ppZ2,sWx=_SPD+toAlong(worldA),sWy=_dSGLY-wz;
            const dAx_=sx-sPPx,dAy_=sy-sPPy,dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=sWx-sx,dBy_=sWy-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_sec.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        wpPerpSecRef.current = allMarks_sec.length ? allMarks_sec : null;
        { const _mppW=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:0.1;
          const _fmtD=d=>d<1000?`${d.toFixed(1)} m`:`${(d/1000).toFixed(3)} km`;
          const _OFF=48, _secZ=secZoomsRef.current[wpDrag.view]||1;
          const _curWpS=(segWpRef.current[wpDrag.sid]||[])[wpDrag.wi]||{};
          const newX3S=isXView?worldA:(_curWpS.x||0), newY3S=isXView?(_curWpS.y||0):worldA;
          const pA_s=isXView?wpDrag.prevX:wpDrag.prevY, nA2_s=isXView?wpDrag.nextX:wpDrag.nextY;
          const pZ3=wpDrag.prevZ??0, nZ3=wpDrag.nextZ??0;
          const lbls=[];
          if(pA_s!=null){
            const dx3d=(newX3S-wpDrag.prevX)*_mppW,dy3d=(newY3S-(wpDrag.prevY||0))*_mppW,dz3d=wz-pZ3;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(pA_s-worldA)*_secZ, sdy=-(pZ3-wz)*_secZ;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          if(nA2_s!=null){
            const dx3d=(wpDrag.nextX-newX3S)*_mppW,dy3d=((wpDrag.nextY||0)-newY3S)*_mppW,dz3d=nZ3-wz;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(nA2_s-worldA)*_secZ, sdy=-(nZ3-wz)*_secZ;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          setWireTipLabels(lbls);
        }
        if (isXView) { setSegWp(prev => { const w=[...(prev[wpDrag.sid]||[])]; if(w[wpDrag.wi])w[wpDrag.wi]={...w[wpDrag.wi],x:worldA}; return {...prev,[wpDrag.sid]:w}; }); }
        else { setSegWp(prev => { const w=[...(prev[wpDrag.sid]||[])]; if(w[wpDrag.wi])w[wpDrag.wi]={...w[wpDrag.wi],y:worldA}; return {...prev,[wpDrag.sid]:w}; }); }
        setWpZ(prev => { const w=[...(prev[wpDrag.sid]||[])]; w[wpDrag.wi]=wz; return {...prev,[wpDrag.sid]:w}; });
        { const _curWp = segWpRef.current[wpDrag.sid]?.[wpDrag.wi] || {};
          _cesiumWpUpdate(isXView ? worldA : (_curWp.x || 0), isXView ? (_curWp.y || 0) : worldA, wz); }
        return;
      }
      const ref = wpDrag.view === "plan" ? planRef : wpDrag.view === "side" ? sideRef : elevRef;
      const p = toP(ref, ev);
      if (wpDrag.view === "plan") {
        let wx = p.x, wy = p.y;
        const _pz = planZoomRef.current || 1, SNAP_T = 15 / _pz;
        const _pnRad = plantNorthAngleRef.current * Math.PI / 180;
        const cosPn = Math.cos(_pnRad), sinPn = Math.sin(_pnRad);
        // PN/X軸スナップ: 各アイコン位置のライン
        let sInfo = null, minD = SNAP_T;
        for (const [nid, np] of Object.entries(allMapPos)) {
          const dx = wx - np.x, dy = wy - np.y;
          const dPN = Math.abs(dx * cosPn + dy * sinPn), dX = Math.abs(dx * sinPn - dy * cosPn);
          const sPN = dPN < SNAP_T, sX = dX < SNAP_T;
          if (sPN || sX) {
            const dist = Math.min(sPN ? dPN : SNAP_T, sX ? dX : SNAP_T);
            if (dist < minD) {
              minD = dist;
              const tPN = dx * sinPn - dy * cosPn, tX = dx * cosPn + dy * sinPn;
              if (sPN && sX) { wx = np.x; wy = np.y; sInfo = { iconId: nid, type: "both" }; }
              else if (sPN) { wx = np.x + tPN * sinPn; wy = np.y + tPN * (-cosPn); sInfo = { iconId: nid, type: "pn" }; }
              else { wx = np.x + tX * cosPn; wy = np.y + tX * sinPn; sInfo = { iconId: nid, type: "x" }; }
            }
          }
        }
        planWpSnapRef.current = sInfo;
        // 直角スナップ (X-Y平面) — 全コーナーを独立チェック、スナップは最初1回のみ
        const allPerps = [];
        let pSnapped = false;
        const pX = wpDrag.prevX, pY = wpDrag.prevY, nX = wpDrag.nextX, nY = wpDrag.nextY;
        const ppX2 = wpDrag.prevPrevX, ppY2 = wpDrag.prevPrevY;
        const nnX2 = wpDrag.nextNextX, nnY2 = wpDrag.nextNextY;
        // Check 1: 自コーナー
        if (pX != null && nX != null) {
          const vAx = wx - pX, vAy = wy - pY, vBx = nX - wx, vBy = nY - wy;
          const lenA = Math.sqrt(vAx*vAx+vAy*vAy), lenB = Math.sqrt(vBx*vBx+vBy*vBy);
          if (lenA > 1 && lenB > 1 && Math.abs((vAx*vBx+vAy*vBy)/(lenA*lenB)) < 0.035) {
            if (!pSnapped) {
              if (!sInfo) {
                const cX=(pX+nX)/2,cY=(pY+nY)/2,r=Math.sqrt((nX-pX)**2+(nY-pY)**2)/2;
                if(r>0){const ddx=wx-cX,ddy=wy-cY,dist=Math.sqrt(ddx*ddx+ddy*ddy)||1;wx=cX+ddx/dist*r;wy=cY+ddy/dist*r;}
              } else if (sInfo.type !== "both") {
                const snpPos = allMapPos[sInfo.iconId];
                if (snpPos) {
                  const aX=snpPos.x-pX,aY=snpPos.y-pY,bX_=nX-snpPos.x,bY_=nY-snpPos.y;
                  if (sInfo.type === "pn") {
                    const P=sinPn*(bX_-aX)+cosPn*(aY-bY_),Q=aX*bX_+aY*bY_,disc=P*P+4*Q;
                    if(disc>=0){const sc=(wx-snpPos.x)*sinPn+(wy-snpPos.y)*(-cosPn);const s1=(P+Math.sqrt(disc))/2,s2=(P-Math.sqrt(disc))/2;const s=Math.abs(s1-sc)<Math.abs(s2-sc)?s1:s2;wx=snpPos.x+s*sinPn;wy=snpPos.y+s*(-cosPn);}
                  } else {
                    const P=cosPn*(bX_-aX)+sinPn*(bY_-aY),Q=aX*bX_+aY*bY_,disc=P*P+4*Q;
                    if(disc>=0){const sc=(wx-snpPos.x)*cosPn+(wy-snpPos.y)*sinPn;const s1=(P+Math.sqrt(disc))/2,s2=(P-Math.sqrt(disc))/2;const s=Math.abs(s1-sc)<Math.abs(s2-sc)?s1:s2;wx=snpPos.x+s*cosPn;wy=snpPos.y+s*sinPn;}
                  }
                }
              }
              pSnapped = true;
            }
            const dAx_=wx-pX,dAy_=wy-pY,dBx_=nX-wx,dBy_=nY-wy;
            const dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allPerps.push({svgX:wx,svgY:wy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 2: 次コーナー (wp→next→nextNext)
        if (nX!=null && nnX2!=null) {
          const vAx=nX-wx,vAy=nY-wy,vBx=nnX2-nX,vBy=nnY2-nY;
          const lenA=Math.sqrt(vAx*vAx+vAy*vAy),lenB=Math.sqrt(vBx*vBx+vBy*vBy);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAy*vBy)/(lenA*lenB))<0.035) {
            if (!pSnapped) {
              if (!sInfo) {
                const div=vBx*vBx+vBy*vBy;
                if(div>0.001){const t=((wx-nX)*(-vBy)+(wy-nY)*vBx)/div;wx=nX+t*(-vBy);wy=nY+t*vBx;}
              } else if (sInfo.type!=="both") {
                const snpPos=allMapPos[sInfo.iconId];
                if (snpPos) {
                  const num=-(snpPos.x-nX)*vBx-(snpPos.y-nY)*vBy;
                  if(sInfo.type==="pn"){const div2=sinPn*vBx-cosPn*vBy;if(Math.abs(div2)>0.001){const s=num/div2;wx=snpPos.x+s*sinPn;wy=snpPos.y-s*cosPn;}}
                  else{const div2=cosPn*vBx+sinPn*vBy;if(Math.abs(div2)>0.001){const s=num/div2;wx=snpPos.x+s*cosPn;wy=snpPos.y+s*sinPn;}}
                }
              }
              pSnapped = true;
            }
            const dAx_=nX-wx,dAy_=nY-wy,dBx_=nnX2-nX,dBy_=nnY2-nY;
            const dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allPerps.push({svgX:nX,svgY:nY,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 3: 前コーナー (prevPrev→prev→wp)
        if (pX!=null && ppX2!=null) {
          const vAx=pX-ppX2,vAy=pY-ppY2,vBx=wx-pX,vBy=wy-pY;
          const lenA=Math.sqrt(vAx*vAx+vAy*vAy),lenB=Math.sqrt(vBx*vBx+vBy*vBy);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAy*vBy)/(lenA*lenB))<0.035) {
            if (!pSnapped) {
              if (!sInfo) {
                const div=vAx*vAx+vAy*vAy;
                if(div>0.001){const t=((wx-pX)*(-vAy)+(wy-pY)*vAx)/div;wx=pX+t*(-vAy);wy=pY+t*vAx;}
              } else if (sInfo.type!=="both") {
                const snpPos=allMapPos[sInfo.iconId];
                if (snpPos) {
                  const num=-(snpPos.x-pX)*vAx-(snpPos.y-pY)*vAy;
                  if(sInfo.type==="pn"){const div2=sinPn*vAx-cosPn*vAy;if(Math.abs(div2)>0.001){const s=num/div2;wx=snpPos.x+s*sinPn;wy=snpPos.y-s*cosPn;}}
                  else{const div2=cosPn*vAx+sinPn*vAy;if(Math.abs(div2)>0.001){const s=num/div2;wx=snpPos.x+s*cosPn;wy=snpPos.y+s*sinPn;}}
                }
              }
              pSnapped = true;
            }
            const dAx_=pX-ppX2,dAy_=pY-ppY2,dBx_=wx-pX,dBy_=wy-pY;
            const dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allPerps.push({svgX:pX,svgY:pY,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        wpPerpPlanRef.current = allPerps.length ? allPerps : null;
        { const _mppW=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:0.1;
          const _fmtD=d=>d<1000?`${d.toFixed(1)} m`:`${(d/1000).toFixed(3)} km`;
          const _OFF=48, _pz=planZoomRef.current||1;
          const curZ3=(wpZRef.current[wpDrag.sid]||[])[wpDrag.wi]||0;
          const pZ3=wpDrag.prevZ??0, nZ3=wpDrag.nextZ??0;
          const lbls=[];
          if(wpDrag.prevX!=null){
            const dx3d=(wx-wpDrag.prevX)*_mppW,dy3d=(wy-wpDrag.prevY)*_mppW,dz3d=curZ3-pZ3;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(wpDrag.prevX-wx)*_pz, sdy=(wpDrag.prevY-wy)*_pz;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          if(wpDrag.nextX!=null){
            const dx3d=(wpDrag.nextX-wx)*_mppW,dy3d=(wpDrag.nextY-wy)*_mppW,dz3d=nZ3-curZ3;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(wpDrag.nextX-wx)*_pz, sdy=(wpDrag.nextY-wy)*_pz;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          setWireTipLabels(lbls);
        }
        setSegWp(prev => { const w = [...(prev[wpDrag.sid] || [])]; w[wpDrag.wi] = { x: wx, y: wy }; return { ...prev, [wpDrag.sid]: w }; });
        _cesiumWpUpdate(wx, wy, (wpZRef.current[wpDrag.sid] || [])[wpDrag.wi] || 0);
      } else if (wpDrag.view === "side") {
        // side: X→世界Y, Y→世界Z
        let wy = Math.max(0, Math.min(TH, p.x));
        let wz = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - p.y));
        const _sz = sideZoomRef.current || 1;
        const SNAP_T = 15 / _sz;
        let snapId = null;
        for (const [nid, np] of Object.entries(allMapPos)) {
          if (Math.abs(wy - np.y) < SNAP_T) { wy = np.y; snapId = nid; break; }
        }
        wpSnapIconRef.current = snapId;
        const pY=wpDrag.prevY, pZ_s=wpDrag.prevZ??0, nY=wpDrag.nextY, nZ_s=wpDrag.nextZ??0;
        const ppY=wpDrag.prevPrevY, ppZ_s=wpDrag.prevPrevZ??0, nnY=wpDrag.nextNextY, nnZ_s=wpDrag.nextNextZ??0;
        const allMarks_s = [];
        let sSnapped = false;
        // Check 1: 自コーナー
        if (pY!=null && nY!=null) {
          const vAx=wy-pY,vAz=wz-pZ_s,vBx=nY-wy,vBz=nZ_s-wz;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!sSnapped){sSnapped=true;}
            const sx=wy,sy=GL_Y-wz;
            const dAx_=sx-pY,dAy_=sy-(GL_Y-pZ_s),dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=nY-sx,dBy_=(GL_Y-nZ_s)-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_s.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 2: 次コーナー
        if (nY!=null && nnY!=null) {
          const vAx=nY-wy,vAz=nZ_s-wz,vBx=nnY-nY,vBz=nnZ_s-nZ_s;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!sSnapped){sSnapped=true;}
            const sx=nY,sy=GL_Y-nZ_s;
            const dAx_=sx-wy,dAy_=sy-(GL_Y-wz),dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=nnY-sx,dBy_=(GL_Y-nnZ_s)-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_s.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 3: 前コーナー
        if (pY!=null && ppY!=null) {
          const vAx=pY-ppY,vAz=pZ_s-ppZ_s,vBx=wy-pY,vBz=wz-pZ_s;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!sSnapped){sSnapped=true;}
            const sx=pY,sy=GL_Y-pZ_s;
            const dAx_=sx-ppY,dAy_=sy-(GL_Y-ppZ_s),dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=wy-sx,dBy_=(GL_Y-wz)-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_s.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        wpPerpSnapRef.current = allMarks_s.length ? allMarks_s : null;
        { const _mppW=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:0.1;
          const _fmtD=d=>d<1000?`${d.toFixed(1)} m`:`${(d/1000).toFixed(3)} km`;
          const _OFF=48, _sz2=sideZoomRef.current||1;
          const curX3=(segWpRef.current[wpDrag.sid]||[])[wpDrag.wi]?.x||0;
          const pZ3=wpDrag.prevZ??0, nZ3=wpDrag.nextZ??0;
          const lbls=[];
          if(wpDrag.prevY!=null){
            const dx3d=(curX3-(wpDrag.prevX||0))*_mppW,dy3d=(wy-wpDrag.prevY)*_mppW,dz3d=wz-pZ3;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(wpDrag.prevY-wy)*_sz2, sdy=-(pZ3-wz)*_sz2;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          if(wpDrag.nextY!=null){
            const dx3d=((wpDrag.nextX||0)-curX3)*_mppW,dy3d=(wpDrag.nextY-wy)*_mppW,dz3d=nZ3-wz;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(wpDrag.nextY-wy)*_sz2, sdy=-(nZ3-wz)*_sz2;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          setWireTipLabels(lbls);
        }
        setSegWp(prev => { const w = [...(prev[wpDrag.sid] || [])]; if (w[wpDrag.wi]) w[wpDrag.wi] = { ...w[wpDrag.wi], y: wy }; return { ...prev, [wpDrag.sid]: w }; });
        setWpZ(prev => { const w = [...(prev[wpDrag.sid] || [])]; w[wpDrag.wi] = wz; return { ...prev, [wpDrag.sid]: w }; });
        _cesiumWpUpdate((segWpRef.current[wpDrag.sid] || [])[wpDrag.wi]?.x || 0, wy, wz);
      } else {
        // elev: X→世界X, Y→世界Z
        let wx = Math.max(0, Math.min(TW, p.x));
        let wz = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - p.y));
        const _ez = elevZoomRef.current || 1;
        const SNAP_T = 15 / _ez;
        let snapId = null;
        for (const [nid, np] of Object.entries(allMapPos)) {
          if (Math.abs(wx - np.x) < SNAP_T) { wx = np.x; snapId = nid; break; }
        }
        wpSnapIconRef.current = snapId;
        const pX=wpDrag.prevX, pZ_e=wpDrag.prevZ??0, nX=wpDrag.nextX, nZ_e=wpDrag.nextZ??0;
        const ppX=wpDrag.prevPrevX, ppZ_e=wpDrag.prevPrevZ??0, nnX=wpDrag.nextNextX, nnZ_e=wpDrag.nextNextZ??0;
        const allMarks_e = [];
        let eSnapped = false;
        // Check 1: 自コーナー
        if (pX!=null && nX!=null) {
          const vAx=wx-pX,vAz=wz-pZ_e,vBx=nX-wx,vBz=nZ_e-wz;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!eSnapped){eSnapped=true;}
            const sx=wx,sy=GL_Y-wz;
            const dAx_=sx-pX,dAy_=sy-(GL_Y-pZ_e),dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=nX-sx,dBy_=(GL_Y-nZ_e)-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_e.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 2: 次コーナー
        if (nX!=null && nnX!=null) {
          const vAx=nX-wx,vAz=nZ_e-wz,vBx=nnX-nX,vBz=nnZ_e-nZ_e;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!eSnapped){eSnapped=true;}
            const sx=nX,sy=GL_Y-nZ_e;
            const dAx_=sx-wx,dAy_=sy-(GL_Y-wz),dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=nnX-sx,dBy_=(GL_Y-nnZ_e)-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_e.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        // Check 3: 前コーナー
        if (pX!=null && ppX!=null) {
          const vAx=pX-ppX,vAz=pZ_e-ppZ_e,vBx=wx-pX,vBz=wz-pZ_e;
          const lenA=Math.sqrt(vAx*vAx+vAz*vAz),lenB=Math.sqrt(vBx*vBx+vBz*vBz);
          if (lenA>1&&lenB>1&&Math.abs((vAx*vBx+vAz*vBz)/(lenA*lenB))<0.035) {
            if (!eSnapped){eSnapped=true;}
            const sx=pX,sy=GL_Y-pZ_e;
            const dAx_=sx-ppX,dAy_=sy-(GL_Y-ppZ_e),dAl=Math.sqrt(dAx_*dAx_+dAy_*dAy_)||1;
            const dBx_=wx-sx,dBy_=(GL_Y-wz)-sy,dBl=Math.sqrt(dBx_*dBx_+dBy_*dBy_)||1;
            allMarks_e.push({svgX:sx,svgY:sy,dAx:dAx_/dAl,dAy:dAy_/dAl,dBx:dBx_/dBl,dBy:dBy_/dBl});
          }
        }
        wpPerpSnapRef.current = allMarks_e.length ? allMarks_e : null;
        { const _mppW=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:0.1;
          const _fmtD=d=>d<1000?`${d.toFixed(1)} m`:`${(d/1000).toFixed(3)} km`;
          const _OFF=48, _ez2=elevZoomRef.current||1;
          const curY3=(segWpRef.current[wpDrag.sid]||[])[wpDrag.wi]?.y||0;
          const pZ3=wpDrag.prevZ??0, nZ3=wpDrag.nextZ??0;
          const lbls=[];
          if(wpDrag.prevX!=null){
            const dx3d=(wx-wpDrag.prevX)*_mppW,dy3d=(curY3-(wpDrag.prevY||0))*_mppW,dz3d=wz-pZ3;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(wpDrag.prevX-wx)*_ez2, sdy=-(pZ3-wz)*_ez2;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          if(wpDrag.nextX!=null){
            const dx3d=(wpDrag.nextX-wx)*_mppW,dy3d=((wpDrag.nextY||0)-curY3)*_mppW,dz3d=nZ3-wz;
            const dist=Math.sqrt(dx3d*dx3d+dy3d*dy3d+dz3d*dz3d);
            const sdx=(wpDrag.nextX-wx)*_ez2, sdy=-(nZ3-wz)*_ez2;
            const sl=Math.sqrt(sdx*sdx+sdy*sdy)||1;
            lbls.push({x:ev.clientX+sdx/sl*_OFF, y:ev.clientY+sdy/sl*_OFF, text:_fmtD(dist)});
          }
          setWireTipLabels(lbls);
        }
        setSegWp(prev => { const w = [...(prev[wpDrag.sid] || [])]; if (w[wpDrag.wi]) w[wpDrag.wi] = { ...w[wpDrag.wi], x: wx }; return { ...prev, [wpDrag.sid]: w }; });
        setWpZ(prev => { const w = [...(prev[wpDrag.sid] || [])]; w[wpDrag.wi] = wz; return { ...prev, [wpDrag.sid]: w }; });
        _cesiumWpUpdate(wx, (segWpRef.current[wpDrag.sid] || [])[wpDrag.wi]?.y || 0, wz);
      }
    };
    const up = () => {
      // mouseup前にsnap先アイコン座標を確保（null代入前にキャプチャ）
      const _snapIconId = wpSnapIconRef.current;
      const _snapIconPt = _snapIconId ? (allMapPosRef.current[_snapIconId] || null) : null;
      const _wpNow = (segWpRef.current[wpDrag.sid] || [])[wpDrag.wi];
      const _wzNow = (wpZRef.current[wpDrag.sid] || [])[wpDrag.wi];
      console.log('[WP_UP] view:', wpDrag.view, 'wi:', wpDrag.wi,
        '| wp:', JSON.stringify(_wpNow), 'wz:', _wzNow,
        '| snapId:', _snapIconId, 'snapPt:', JSON.stringify(_snapIconPt));
      grabOff();
      setWireTipLabels([]);
      if (wpDrag.view.startsWith("sec")) {
        const secId = wpDrag.view;
        const vd = secViewDataRef.current[secId];
        const isXV = vd ? (vd.viewEdge === 'top' || vd.viewEdge === 'bottom') : true;
        if (isXV) { setSegWp(prev => { const w=[...(prev[wpDrag.sid]||[])]; if(w[wpDrag.wi])w[wpDrag.wi]={...w[wpDrag.wi],x:_snapIconPt?_snapIconPt.x:Math.round(w[wpDrag.wi].x)}; return {...prev,[wpDrag.sid]:w}; }); }
        else { setSegWp(prev => { const w=[...(prev[wpDrag.sid]||[])]; if(w[wpDrag.wi])w[wpDrag.wi]={...w[wpDrag.wi],y:_snapIconPt?_snapIconPt.y:Math.round(w[wpDrag.wi].y)}; return {...prev,[wpDrag.sid]:w}; }); }
        // Z: mousemoveで正確な値がセット済み。Math.roundは使わず連続値を保持
      } else if (wpDrag.view === "plan") {
        setSegWp(prev => { const w = [...(prev[wpDrag.sid] || [])]; if (w[wpDrag.wi]) { const p=w[wpDrag.wi]; w[wpDrag.wi] = _snapIconPt ? {x:_snapIconPt.x,y:_snapIconPt.y} : {x:Math.round(p.x),y:Math.round(p.y)}; } return { ...prev, [wpDrag.sid]: w }; });
      } else if (wpDrag.view === "side") {
        // side: Y軸方向のみ。アイコンsnap時はアイコンY、フリー時はzoom依存スナップ
        setSegWp(prev => { const w = [...(prev[wpDrag.sid] || [])]; if (w[wpDrag.wi]) w[wpDrag.wi] = { ...w[wpDrag.wi], y: _snapIconPt ? _snapIconPt.y : snapFineV(w[wpDrag.wi].y, sideZoomRef.current) }; return { ...prev, [wpDrag.sid]: w }; });
        // Z: mousemoveで正確な値がセット済み。スナップなしで連続値を保持
      } else {
        // elev: X軸方向のみ。アイコンsnap時はアイコンX、フリー時はzoom依存スナップ
        setSegWp(prev => { const w = [...(prev[wpDrag.sid] || [])]; if (w[wpDrag.wi]) w[wpDrag.wi] = { ...w[wpDrag.wi], x: _snapIconPt ? _snapIconPt.x : snapFineV(w[wpDrag.wi].x, elevZoomRef.current) }; return { ...prev, [wpDrag.sid]: w }; });
        // Z: mousemoveで正確な値がセット済み。スナップなしで連続値を保持
      }
      wpSnapIconRef.current = null; wpPerpSnapRef.current = null;
      planWpSnapRef.current = null; wpPerpPlanRef.current = null; wpPerpSecRef.current = null;
      cesium3dQueryRef.current?.clearWpDirect?.();
      cesium2dQueryRef.current?.clearWpDirect?.();
      setHoverSeg(wpDrag.sid); // ドラッグ終了後もカーソル位置のsegをhover維持
      setWpDrag(null);
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { grabOff(); setWireTipLabels([]); wpSnapIconRef.current = null; wpPerpSnapRef.current = null; planWpSnapRef.current = null; wpPerpPlanRef.current = null; wpPerpSecRef.current = null; window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [wpDrag, allMapPos]);

  // 線セグメント中点ドラッグ（plan/elev/side: 両端点を垂直方向に平行移動）
  useEffect(() => {
    if (!segLineDrag) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    const ref = segLineDrag.mode === "plan" ? planRef : segLineDrag.mode === "elev" ? elevRef : sideRef;
    const { perpX, perpY, parX, parY, startMouseX, startMouseY, origA, origB,
            aIsIcon, bIsIcon, aId, aWi, bId, bWi, mode } = segLineDrag;

    const applyEndpoint = (isIcon, id, wi, svgX, svgY) => {
      if (mode === "plan") {
        const wx = Math.max(0, Math.min(TW, svgX)), wy = Math.max(0, Math.min(TH, svgY));
        if (isIcon) setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: wx, y: wy } }));
        else setSegWp(pr => { const w = [...(pr[id]||[])]; w[wi] = { x: wx, y: wy }; return { ...pr, [id]: w }; });
      } else if (mode === "elev") {
        const wx = Math.max(0, Math.min(TW, svgX)), wz = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - svgY));
        if (isIcon) { setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: wx } })); setMapZ(pr => ({ ...pr, [id]: wz })); }
        else { setSegWp(pr => { const w = [...(pr[id]||[])]; w[wi] = { ...w[wi], x: wx }; return { ...pr, [id]: w }; }); setWpZ(pr => { const w = [...(pr[id]||[])]; w[wi] = wz; return { ...pr, [id]: w }; }); }
      } else {
        const wy = Math.max(0, Math.min(TH, svgX)), wz = Math.max(MIN_Z, Math.min(MAX_Z, GL_Y - svgY));
        if (isIcon) { setMapPos(pr => ({ ...pr, [id]: { ...pr[id], y: wy } })); setMapZ(pr => ({ ...pr, [id]: wz })); }
        else { setSegWp(pr => { const w = [...(pr[id]||[])]; w[wi] = { ...w[wi], y: wy }; return { ...pr, [id]: w }; }); setWpZ(pr => { const w = [...(pr[id]||[])]; w[wi] = wz; return { ...pr, [id]: w }; }); }
      }
    };

    const mv = ev => {
      ev.preventDefault();
      const p = toP(ref, ev);
      let dx = p.x - startMouseX, dy = p.y - startMouseY;
      if (ev.shiftKey) {
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
      applyEndpoint(aIsIcon, aId, aWi, origA.x + dx, origA.y + dy);
      applyEndpoint(bIsIcon, bId, bWi, origB.x + dx, origB.y + dy);
    };

    const up = () => {
      grabOff();
      const snapFn = mode === "plan"
        ? (isIcon, id, wi) => {
            const z = planZoomRef.current;
            if (isIcon) setMapPos(pr => { const p = pr[id]; return p ? { ...pr, [id]: snapFine(p.x, p.y, z) } : pr; });
            else setSegWp(pr => { const w = [...(pr[id]||[])]; if (w[wi]) w[wi] = snapFine(w[wi].x, w[wi].y, z); return { ...pr, [id]: w }; });
          }
        : mode === "elev"
        ? (isIcon, id, wi) => {
            const z = elevZoomRef.current;
            if (isIcon) { setMapPos(pr => { const p = pr[id]; return p ? { ...pr, [id]: { ...p, x: snapFineV(p.x, z) } } : pr; }); setMapZ(pr => { const v = pr[id]; return v !== undefined ? { ...pr, [id]: snapFineV(v, z) } : pr; }); }
            else { setSegWp(pr => { const w = [...(pr[id]||[])]; if (w[wi]) w[wi] = { ...w[wi], x: snapFineV(w[wi].x, z) }; return { ...pr, [id]: w }; }); setWpZ(pr => { const w = [...(pr[id]||[])]; if (w[wi] !== undefined) w[wi] = snapFineV(w[wi], z); return { ...pr, [id]: w }; }); }
          }
        : (isIcon, id, wi) => {
            const z = sideZoomRef.current;
            if (isIcon) { setMapPos(pr => { const p = pr[id]; return p ? { ...pr, [id]: { ...p, y: snapFineV(p.y, z) } } : pr; }); setMapZ(pr => { const v = pr[id]; return v !== undefined ? { ...pr, [id]: snapFineV(v, z) } : pr; }); }
            else { setSegWp(pr => { const w = [...(pr[id]||[])]; if (w[wi]) w[wi] = { ...w[wi], y: snapFineV(w[wi].y, z) }; return { ...pr, [id]: w }; }); setWpZ(pr => { const w = [...(pr[id]||[])]; if (w[wi] !== undefined) w[wi] = snapFineV(w[wi], z); return { ...pr, [id]: w }; }); }
          };
      snapFn(aIsIcon, aId, aWi);
      snapFn(bIsIcon, bId, bWi);
      setSegLineDrag(null);
    };

    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { grabOff(); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [segLineDrag]);

  // 3次元図での線セグメント中点ドラッグ（垂直+平行 2軸自由移動）
  useEffect(() => {
    if (!segLineDragCab) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    const { startX, startY, zoom, aIsIcon, bIsIcon, aId, aWi, bId, bWi,
            origAx, origAy, origBx, origBy,
            sPerpX, sPerpY, sParX, sParY, wPerpX, wPerpY, wParX, wParY } = segLineDragCab;
    const det = sPerpX * sParY - sPerpY * sParX;
    const sp2 = sPerpX * sPerpX + sPerpY * sPerpY;

    const applyEndpoint = (isIcon, id, wi, newX, newY) => {
      if (isIcon) setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: newX, y: newY } }));
      else setSegWp(pr => { const w = [...(pr[id]||[])]; w[wi] = { ...w[wi], x: newX, y: newY }; return { ...pr, [id]: w }; });
    };

    const sPerpLen2 = sPerpX*sPerpX + sPerpY*sPerpY || 1;
    const sParLen2  = sParX*sParX   + sParY*sParY   || 1;
    const mv = (ev) => {
      const cabEl = cabRef.current; if (!cabEl) return;
      const pr = cabEl.getBoundingClientRect();
      const sc = Math.min((pr.width || CAB_W) / CAB_W, (pr.height || CAB_H) / CAB_H);
      let dmx = (ev.clientX - startX) / sc / zoom;
      let dmy = (ev.clientY - startY) / sc / zoom;
      if (ev.shiftKey) {
        const projPerp = Math.abs(dmx * sPerpX + dmy * sPerpY) / Math.sqrt(sPerpLen2);
        const projPar  = Math.abs(dmx * sParX  + dmy * sParY)  / Math.sqrt(sParLen2);
        if (projPerp >= projPar) {
          const t = (dmx * sPerpX + dmy * sPerpY) / sPerpLen2;
          dmx = t * sPerpX; dmy = t * sPerpY;
        } else {
          const t = (dmx * sParX + dmy * sParY) / sParLen2;
          dmx = t * sParX; dmy = t * sParY;
        }
      }
      let dx_w, dy_w;
      if (Math.abs(det) > 1e-4) {
        // 2x2逆行列: screen delta = t_perp * sPerp + t_par * sPar → world delta
        const t_perp = ( dmx * sParY - dmy * sParX) / det;
        const t_par  = (-dmx * sPerpY + dmy * sPerpX) / det;
        dx_w = t_perp * wPerpX + t_par * wParX;
        dy_w = t_perp * wPerpY + t_par * wParY;
      } else {
        // 縮退時: 垂直方向のみ
        if (sp2 < 1e-6) return;
        const t = (dmx * sPerpX + dmy * sPerpY) / sp2;
        dx_w = t * wPerpX; dy_w = t * wPerpY;
      }
      applyEndpoint(aIsIcon, aId, aWi, origAx + dx_w, origAy + dy_w);
      applyEndpoint(bIsIcon, bId, bWi, origBx + dx_w, origBy + dy_w);
    };

    const up = () => {
      grabOff();
      const snapEnd = (isIcon, id, wi) => {
        if (isIcon) setMapPos(pr => { const p = pr[id]; return p ? { ...pr, [id]: snap(p.x, p.y) } : pr; });
        else setSegWp(pr => { const w = [...(pr[id]||[])]; if (w[wi]) w[wi] = snap(w[wi].x, w[wi].y); return { ...pr, [id]: w }; });
      };
      snapEnd(aIsIcon, aId, aWi);
      snapEnd(bIsIcon, bId, bWi);
      setSegLineDragCab(null);
    };

    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', mv, { passive: false }); window.addEventListener('touchend', up);
    return () => { grabOff(); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); window.removeEventListener('touchmove', mv); window.removeEventListener('touchend', up); };
  }, [segLineDragCab]);

  // 矢視図での線セグメント中点ドラッグ（両端点を同量移動）
  useEffect(() => {
    if (!segLineDragSec) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    const { secId, viewEdge, isXView, hasOBB,
            startSvgX, startSvgY,
            aIsIcon, aId, aWi, origAX, origAY, origAZ,
            bIsIcon, bId, bWi, origBX, origBY, origBZ } = segLineDragSec;
    // d(worldA)/d(along): OBB top/right = -1, OBB bottom/left = +1, AABB top/right = +1, AABB bottom/left = -1
    const dWA = hasOBB
      ? (viewEdge==='top'||viewEdge==='right' ? -1 : 1)
      : (viewEdge==='top'||viewEdge==='right' ?  1 : -1);
    const applyEp = (isIcon, id, wi, newWorldA, newWz) => {
      if (isIcon) {
        if (isXView) setMapPos(prev => { const p=prev[id]; return p?{...prev,[id]:{...p,x:newWorldA}}:prev; });
        else         setMapPos(prev => { const p=prev[id]; return p?{...prev,[id]:{...p,y:newWorldA}}:prev; });
        setMapZ(prev => ({...prev, [id]: newWz}));
      } else {
        if (isXView) setSegWp(prev => { const w=[...(prev[id]||[])]; if(w[wi])w[wi]={...w[wi],x:newWorldA}; return {...prev,[id]:w}; });
        else         setSegWp(prev => { const w=[...(prev[id]||[])]; if(w[wi])w[wi]={...w[wi],y:newWorldA}; return {...prev,[id]:w}; });
        setWpZ(prev => { const w=[...(prev[id]||[])]; w[wi]=newWz; return {...prev,[id]:w}; });
      }
    };
    const mv = ev => {
      ev.preventDefault();
      const secEl = secRefs.current[secId]?.el; if (!secEl) return;
      const _sz = secZoomsRef.current[secId] || 1;
      const evC = ev.touches ? ev.touches[0] : ev;
      const elR = secEl.getBoundingClientRect();
      const svgX = (evC.clientX - elR.left) / _sz;
      const svgY = (evC.clientY - elR.top) / _sz;
      const dalong = svgX - startSvgX;
      const dz = startSvgY - svgY; // svgYは下向き正、wzは上向き正
      const dWorldA = dalong * dWA;
      applyEp(aIsIcon, aId, aWi, (isXView ? origAX : origAY) + dWorldA, origAZ + dz);
      applyEp(bIsIcon, bId, bWi, (isXView ? origBX : origBY) + dWorldA, origBZ + dz);
    };
    const up = () => { grabOff(); setSegLineDragSec(null); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { grabOff(); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [segLineDragSec]);

  // 3次元図での折れ点ドラッグ（水平XY移動）
  useEffect(() => {
    if (!wpDragCab) return;
    const grabOn  = () => { if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); } };
    const grabOff = () => document.getElementById('__gs')?.remove();
    grabOn();
    const { sid, wi, startX, startY, startWp, axA, axB, zoom } = wpDragCab;
    const mv = (ev) => {
      const cabEl = cabRef.current; if (!cabEl) return;
      const pr = cabEl.getBoundingClientRect();
      const sc = Math.min((pr.width || CAB_W) / CAB_W, (pr.height || CAB_H) / CAB_H);
      const dmx = (ev.clientX - startX) / sc / zoom;
      const dmy = (ev.clientY - startY) / sc / zoom;
      const det = axA.sx * axB.sy - axA.sy * axB.sx;
      if (Math.abs(det) < 1e-4) return;
      const ta = (dmx * axB.sy - dmy * axB.sx) / det;
      const tb = (axA.sx * dmy - axA.sy * dmx) / det;
      const newX = startWp.x + ta * axA.wx + tb * axB.wx;
      const newY = startWp.y + ta * axA.wy + tb * axB.wy;
      setSegWp(prev => {
        const w = [...(prev[sid] || [])]; if (w[wi]) w[wi] = { x: newX, y: newY }; return { ...prev, [sid]: w };
      });
      // 2D/3D Cesiumにもwire+折れ点四角をリアルタイム反映（_wpDragCanvasRef経由）
      const _seg = segsRef.current.find(s => s.id === sid); if (!_seg) return;
      const _wps = [...(segWpRef.current[sid] || [])];
      const _wzs = [...(wpZRef.current[sid] || [])];
      if (_wps[wi]) { _wps[wi] = { x: newX, y: newY }; }
      const _fromP = allMapPosRef.current[_seg.from] || {};
      const _toP = allMapPosRef.current[_seg.to] || {};
      const _cabPath = [
        { x: _fromP.x || 0, y: _fromP.y || 0, z: mapZRef.current[_seg.from] || 0 },
        ..._wps.map((w2, i) => ({ x: w2.x, y: w2.y, z: _wzs[i] || 0 })),
        { x: _toP.x || 0, y: _toP.y || 0, z: mapZRef.current[_seg.to] || 0 }
      ];
      cesium3dQueryRef.current?.updateWpDirect?.(sid, _cabPath);
      cesium2dQueryRef.current?.updateWpDirect?.(sid, _cabPath);
    };
    const up = () => {
      grabOff();
      setSegWp(prev => { const w = [...(prev[sid] || [])]; if (w[wi]) w[wi] = snap(w[wi].x, w[wi].y); return { ...prev, [sid]: w }; });
      cesium3dQueryRef.current?.clearWpDirect?.();
      cesium2dQueryRef.current?.clearWpDirect?.();
      setWpDragCab(null); iconDragging.current = false;
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    return () => { grabOff(); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, [wpDragCab]);

  // ギズモ対象の3D位置を取得
  const getGizmoPos = useCallback((tgt) => {
    if (!tgt) return null;
    if (tgt.type === "node") {
      return allMapPos[tgt.id] || null;
    }
    if (tgt.type === "wp") {
      const wps = segWp[tgt.sid] || [];
      const wzs = wpZ[tgt.sid] || [];
      const wp = wps[tgt.wi];
      if (!wp) return null;
      return { x: wp.x, y: wp.y, z: wzs[tgt.wi] || 0 };
    }
    if (tgt.type === "segLine") {
      const getEP = (isIcon, id, wi) => {
        if (isIcon) return allMapPos[id] || null;
        const wps = segWp[id] || [], wzs = wpZ[id] || [];
        return wps[wi] ? { x: wps[wi].x, y: wps[wi].y, z: wzs[wi] || 0 } : null;
      };
      const pA = getEP(tgt.aIsIcon, tgt.aId, tgt.aWi);
      const pB = getEP(tgt.bIsIcon, tgt.bId, tgt.bWi);
      if (!pA || !pB) return null;
      return { x: (pA.x+pB.x)/2, y: (pA.y+pB.y)/2, z: ((pA.z||0)+(pB.z||0))/2 };
    }
    return null;
  }, [allMapPos, segWp, wpZ]);

  // 3Dギズモ軸ドラッグ（ux/uy/worldPerPxはstartAxisで事前計算済み → stale closure不要）
  useEffect(() => {
    if (!axisDrag) return;
    const { ux, uy, worldPerPx, pnRad, startMouse, startPos, startZ, axis, target,
            startPosA, startPosB, startZA, startZB } = axisDrag;
    console.log('[AXIS_DRAG_START] axis='+axis+' worldPerPx='+(worldPerPx||0).toFixed(4)+' pnRad='+((pnRad||0)*180/Math.PI).toFixed(1)+'°');
    let lastDelta = 0, lastDx = 0, lastDy = 0;
    const mv = ev => {
      ev.preventDefault();
      const p = toP(cabRef, ev);
      const _r = cabRef.current?.getBoundingClientRect();
      if (!_r) return;
      const _sc = Math.min(_r.width / CAB_W, _r.height / CAB_H) || 1;
      const mdx = (p.x - startMouse.x) / _sc;
      const mdy = (p.y - startMouse.y) / _sc;
      const proj1 = mdx * (ux||0) + mdy * (uy||0);
      const delta = proj1 * (worldPerPx||0);
      // plantNorthAngleRefから最新PN角度を取得（pnRadのstale closure防止）
      const _pnR = plantNorthAngleRef.current * Math.PI / 180;
      console.log('[AXIS_MV] sc='+_sc.toFixed(3)+' svgPx=('+mdx.toFixed(1)+','+mdy.toFixed(1)+') proj1='+proj1.toFixed(2)+' delta='+delta.toFixed(2)+' _pnR='+(_pnR*180/Math.PI).toFixed(1)+'°');
      // X = PN⊥ (cos, +sin in grid), Y = PN (sin, -cos in grid)
      const _dx = axis === "x" ? Math.cos(_pnR)*delta : axis === "y" ? Math.sin(_pnR)*delta : 0;
      const _dy = axis === "x" ? Math.sin(_pnR)*delta : axis === "y" ? -Math.cos(_pnR)*delta : 0;
      lastDelta = delta; lastDx = _dx; lastDy = _dy;
      axisDragDbgRef.current = { _pnR: _pnR*180/Math.PI, delta: delta.toFixed(2), _dx: _dx.toFixed(2), _dy: _dy.toFixed(2) };
      if (target.type === "node") {
        const id = target.id;
        if (axis === "z") setMapZ(pr => ({ ...pr, [id]: startZ + delta }));
        else setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: startPos.x + _dx, y: startPos.y + _dy } }));
      } else if (target.type === "wp") {
        const { sid, wi } = target;
        if (axis === "z") {
          setWpZ(prev => { const w = [...(prev[sid] || [])]; w[wi] = startZ + delta; return { ...prev, [sid]: w }; });
        } else {
          setSegWp(prev => { const w = [...(prev[sid] || [])]; if (w[wi]) w[wi] = { ...w[wi], x: startPos.x + _dx, y: startPos.y + _dy }; return { ...prev, [sid]: w }; });
        }
      } else if (target.type === "segLine") {
        const { aIsIcon, aId, aWi, bIsIcon, bId, bWi } = target;
        const moveEP = (isIcon, id, wi, origX, origY, origZ) => {
          if (axis === "z") {
            if (isIcon) setMapZ(pr => ({ ...pr, [id]: origZ + delta }));
            else setWpZ(prev => { const w = [...(prev[id]||[])]; w[wi] = origZ + delta; return { ...prev, [id]: w }; });
          } else {
            if (isIcon) setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: origX + _dx, y: origY + _dy } }));
            else setSegWp(prev => { const w = [...(prev[id]||[])]; if (w[wi]) w[wi] = { ...w[wi], x: origX + _dx, y: origY + _dy }; return { ...prev, [id]: w }; });
          }
        };
        moveEP(aIsIcon, aId, aWi, startPosA?.x||0, startPosA?.y||0, startZA||0);
        moveEP(bIsIcon, bId, bWi, startPosB?.x||0, startPosB?.y||0, startZB||0);
      }
    };
    const up = () => {
      // mouseup時にsnapして確定
      if (target.type === "node") {
        const id = target.id;
        if (axis === "z") setMapZ(pr => ({ ...pr, [id]: snapV(startZ + lastDelta) }));
        else setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: snapV(startPos.x + lastDx), y: snapV(startPos.y + lastDy) } }));
      } else if (target.type === "wp") {
        const { sid, wi } = target;
        if (axis === "z") {
          setWpZ(prev => { const w = [...(prev[sid] || [])]; w[wi] = snapV(startZ + lastDelta); return { ...prev, [sid]: w }; });
        } else {
          setSegWp(prev => { const w = [...(prev[sid] || [])]; if (w[wi]) w[wi] = { ...w[wi], x: snapV(startPos.x + lastDx), y: snapV(startPos.y + lastDy) }; return { ...prev, [sid]: w }; });
        }
      } else if (target.type === "segLine") {
        const { aIsIcon, aId, aWi, bIsIcon, bId, bWi } = target;
        const snapEP = (isIcon, id, wi, origX, origY, origZ) => {
          if (axis === "z") {
            if (isIcon) setMapZ(pr => ({ ...pr, [id]: snapV(origZ + lastDelta) }));
            else setWpZ(prev => { const w = [...(prev[id]||[])]; w[wi] = snapV(origZ + lastDelta); return { ...prev, [id]: w }; });
          } else {
            if (isIcon) setMapPos(pr => ({ ...pr, [id]: { ...pr[id], x: snapV(origX + lastDx), y: snapV(origY + lastDy) } }));
            else setSegWp(prev => { const w = [...(prev[id]||[])]; if (w[wi]) w[wi] = { ...w[wi], x: snapV(origX + lastDx), y: snapV(origY + lastDy) }; return { ...prev, [id]: w }; });
          }
        };
        snapEP(aIsIcon, aId, aWi, startPosA?.x||0, startPosA?.y||0, startZA||0);
        snapEP(bIsIcon, bId, bWi, startPosB?.x||0, startPosB?.y||0, startZB||0);
      }
      setAxisDrag(null); iconDragging.current = false;
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [axisDrag]);

  // カメラアイコンドラッグ（平面図: az変更、断面図: el変更）
  useEffect(() => {
    if (!camDrag) return;
    const mv = ev => {
      ev.preventDefault();
      if (camDrag.view === "plan") {
        const p = toP(planRef, ev);
        // ドラッグ位置から注視点へのベクトルでazを計算
        const lx = camDrag.lookAt.x, ly = camDrag.lookAt.y;
        const dx = p.x - lx, dy = p.y - ly;
        // plan上: カメラ方向 = (-sinAz, cosAz)、逆算: az = atan2(-dx, dy)
        const newAz = Math.atan2(-dx, dy);
        // 注視点を3次元図画面中央に保つためpanを補正
        const projLook = project3D(lx, ly, 0, newAz, camEl, camZoom, 0, 0);
        setCamAz(newAz);
        setCamPanX(CAB_W / 2 - projLook.x);
        setCamPanY(CAB_H / 2 - projLook.y);
      } else {
        const p = toP(elevRef, ev);
        // Y位置から仰角を計算: 上=高仰角、下=低仰角
        const glY = GL_Y;
        const relY = glY - p.y; // 地面からの高さ
        const newEl = Math.max(-0.5, Math.min(1.55, relY / (MAX_Z * 0.7) * 1.4));
        setCamEl(newEl);
      }
    };
    const up = () => setCamDrag(null);
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
  }, [camDrag, camEl, camZoom]);

  const HL_COLOR = "#3B82F6";
  const HOVER_COLOR = "#60A5FA";
  const BASE_COLOR = "#1a1a1a";

  // 矢視ヘルパー: 2点→正規化矩形
  const rectOf = (p1, p2) => ({
    x1: Math.min(p1.x, p2.x), y1: Math.min(p1.y, p2.y),
    x2: Math.max(p1.x, p2.x), y2: Math.max(p1.y, p2.y),
  });

  // OBBヘルパー: p1,p2の対角線からpnRad方向に揃ったOBBパラメータを計算
  const obbFromP1P2 = (p1, p2, pnRad) => {
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const c = Math.cos(pnRad), s = Math.sin(pnRad);
    const halfA = Math.abs(dx * c + dy * s) / 2;   // plant X方向の半幅
    const halfB = Math.abs(dx * s - dy * c) / 2;   // plant PN方向の半幅
    return { cx, cy, halfA, halfB };
  };

  // OBBの4頂点を返す（SVGポリゴン用）
  const obbCorners = (cx, cy, halfA, halfB, pnRad) => {
    const c = Math.cos(pnRad), s = Math.sin(pnRad);
    return [
      [cx + halfA*c + halfB*s, cy + halfA*s - halfB*c],  // +X +PN（北東）
      [cx + halfA*c - halfB*s, cy + halfA*s + halfB*c],  // +X -PN（南東）
      [cx - halfA*c - halfB*s, cy - halfA*s + halfB*c],  // -X -PN（南西）
      [cx - halfA*c + halfB*s, cy - halfA*s - halfB*c],  // -X +PN（北西）
    ];
  };

  // OBB最近辺: plant座標でどの辺に最も近いかを返す
  const nearestEdgeOBB = (p1, p2, cur, pnRad) => {
    const { cx, cy, halfA, halfB } = obbFromP1P2(p1, p2, pnRad);
    const c = Math.cos(pnRad), s = Math.sin(pnRad);
    const dx = cur.x - cx, dy = cur.y - cy;
    const pA = dx*c + dy*s, pB = dx*s - dy*c;
    return [
      { id: 'top',    d: Math.abs(pB - halfB) },
      { id: 'bottom', d: Math.abs(pB + halfB) },
      { id: 'left',   d: Math.abs(pA + halfA) },
      { id: 'right',  d: Math.abs(pA - halfA) },
    ].reduce((a, b) => a.d < b.d ? a : b).id;
  };

  // OBB辺の中点と内向き法線（平面図に視線矢印を描く用）
  const edgeInfoSec = (sec, edge) => {
    const { center: { x: cx, y: cy }, halfA, halfB, pnRad: sP } = sec;
    const c = Math.cos(sP), s = Math.sin(sP);
    switch (edge) {
      case 'top':    return { mid: { x: cx + halfB*s,  y: cy - halfB*c  }, nx: -s,  ny:  c  };
      case 'bottom': return { mid: { x: cx - halfB*s,  y: cy + halfB*c  }, nx:  s,  ny: -c  };
      case 'left':   return { mid: { x: cx - halfA*c,  y: cy - halfA*s  }, nx:  c,  ny:  s  };
      case 'right':  return { mid: { x: cx + halfA*c,  y: cy + halfA*s  }, nx: -c,  ny: -s  };
      default:       return { mid: { x: cx, y: cy }, nx: 0, ny: 1 };
    }
  };

  // 矢視ヘルパー: カーソルに最も近い辺を返す（旧式AABB用、後方互換）
  const nearestEdge = (rect, cur) => {
    const ds = [
      { id: 'top',    d: Math.abs(cur.y - rect.y1) },
      { id: 'bottom', d: Math.abs(cur.y - rect.y2) },
      { id: 'left',   d: Math.abs(cur.x - rect.x1) },
      { id: 'right',  d: Math.abs(cur.x - rect.x2) },
    ];
    return ds.reduce((a, b) => a.d < b.d ? a : b).id;
  };

  // 矢視ヘルパー: 辺の中点と内向き法線（旧式AABB用、後方互換）
  const edgeInfo = (r, edge) => ({
    top:    { mid: { x: (r.x1 + r.x2) / 2, y: r.y1 }, nx: 0,  ny: 1  },
    bottom: { mid: { x: (r.x1 + r.x2) / 2, y: r.y2 }, nx: 0,  ny: -1 },
    left:   { mid: { x: r.x1, y: (r.y1 + r.y2) / 2 }, nx: 1,  ny: 0  },
    right:  { mid: { x: r.x2, y: (r.y1 + r.y2) / 2 }, nx: -1, ny: 0  },
  }[edge]);

  // 矢視図オーバーレイ: Cesium 2D/3D向けグリッド座標事前計算
  const sectionOverlays = useMemo(() => {
    const _pnRad = plantNorthAngle * Math.PI / 180;
    return sections.map(_sec => {
      let sec = _sec;
      if (_sec.p1 && _sec.p2) {
        const { cx, cy, halfA: hA, halfB: hB } = obbFromP1P2(_sec.p1, _sec.p2, _pnRad);
        sec = { ..._sec, center: { x: cx, y: cy }, halfA: hA, halfB: hB, pnRad: _pnRad };
      }
      const corners = sec.center !== undefined
        ? obbCorners(sec.center.x, sec.center.y, sec.halfA, sec.halfB, sec.pnRad)
        : [[sec.rect.x1,sec.rect.y1],[sec.rect.x2,sec.rect.y1],[sec.rect.x2,sec.rect.y2],[sec.rect.x1,sec.rect.y2]];
      let baseLine, arms;
      if (sec.center !== undefined) {
        const ei = edgeInfoSec(sec, sec.viewEdge);
        const _cc = Math.cos(sec.pnRad), _ss = Math.sin(sec.pnRad);
        const edgeLen = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom') ? sec.halfA * 2 : sec.halfB * 2;
        const AL = Math.max(10, edgeLen * 0.2);
        const koC = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom')
          ? [[ei.mid.x - sec.halfA*_cc, ei.mid.y - sec.halfA*_ss],
             [ei.mid.x + sec.halfA*_cc, ei.mid.y + sec.halfA*_ss]]
          : [[ei.mid.x + sec.halfB*_ss, ei.mid.y - sec.halfB*_cc],
             [ei.mid.x - sec.halfB*_ss, ei.mid.y + sec.halfB*_cc]];
        baseLine = koC;
        arms = koC.map(([x, y]) => [[x, y], [x + ei.nx*AL, y + ei.ny*AL]]);
      } else {
        const r = sec.rect;
        const ei = edgeInfo(r, sec.viewEdge);
        const edgeLen = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom') ? (r.x2 - r.x1) : (r.y2 - r.y1);
        const AL = Math.max(10, edgeLen * 0.2);
        const koC = sec.viewEdge === 'top'    ? [[r.x1,r.y1],[r.x2,r.y1]]
                 : sec.viewEdge === 'bottom' ? [[r.x1,r.y2],[r.x2,r.y2]]
                 : sec.viewEdge === 'left'   ? [[r.x1,r.y1],[r.x1,r.y2]]
                 :                            [[r.x2,r.y1],[r.x2,r.y2]];
        baseLine = koC;
        arms = koC.map(([x, y]) => [[x, y], [x + ei.nx*AL, y + ei.ny*AL]]);
      }
      return { id: sec.id, corners, baseLine, arms };
    });
  }, [sections, plantNorthAngle]);

  // 矢視: 矩形+視線方向に対するワールド座標の投影
  // along = 視点辺に沿った距離(0=左/上端), depth = 奥行き(0=視点辺, 正=矩形内側)
  const projectToSection = useCallback((sec, wx, wy, wz) => {
    if (sec.center !== undefined) {
      // OBB: plant座標系に揃った矩形
      const dx = wx - sec.center.x, dy = wy - sec.center.y;
      const c = Math.cos(sec.pnRad), s = Math.sin(sec.pnRad);
      const pA = dx*c + dy*s, pB = dx*s - dy*c;
      const { viewEdge, halfA, halfB } = sec;
      let along, depth, totalDepth;
      if (viewEdge === 'top')         { along = halfA - pA; depth = halfB - pB; totalDepth = 2 * halfB; }
      else if (viewEdge === 'bottom') { along = pA + halfA; depth = halfB + pB; totalDepth = 2 * halfB; }
      else if (viewEdge === 'left')   { along = halfB - pB; depth = pA + halfA; totalDepth = 2 * halfA; }
      else                            { along = halfB + pB; depth = halfA - pA; totalDepth = 2 * halfA; }
      return { along, depth, z: wz || 0, totalDepth };
    }
    // 旧式AABB（後方互換）
    const { rect, viewEdge } = sec;
    let along, depth, totalDepth;
    if (viewEdge === 'top') {
      along = wx - rect.x1; depth = wy - rect.y1; totalDepth = rect.y2 - rect.y1;
    } else if (viewEdge === 'bottom') {
      along = rect.x2 - wx; depth = rect.y2 - wy; totalDepth = rect.y2 - rect.y1;
    } else if (viewEdge === 'left') {
      along = wy - rect.y1; depth = wx - rect.x1; totalDepth = rect.x2 - rect.x1;
    } else { // right
      along = rect.y2 - wy; depth = rect.x2 - wx; totalDepth = rect.x2 - rect.x1;
    }
    return { along, depth, z: wz || 0, totalDepth };
  }, []);

  // 矢視描画完了（3クリック方式）
  const finishSection = useCallback((p1, p2, viewEdge) => {
    const rect = rectOf(p1, p2);
    if (rect.x2 - rect.x1 < 20 || rect.y2 - rect.y1 < 20) return;
    const _pnRad = plantNorthAngleRef.current * Math.PI / 180;
    const { cx, cy, halfA, halfB } = obbFromP1P2(p1, p2, _pnRad);
    secCounter.current++;
    const id = `sec${secCounter.current}`;
    const newSec = { id, rect, viewEdge, p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, center: { x: cx, y: cy }, halfA, halfB, pnRad: _pnRad };
    setSections(prev => [...prev, newSec]);
    setWinState(prev => ({
      ...prev,
      [id]: { x: 50 + secCounter.current * 30, y: 50 + secCounter.current * 30, w: 420, h: 280, z: zCounter.current + 1, minimized: false },
    }));
    zCounter.current++;
  }, []);

  const removeSection = useCallback((id) => {
    setSections(prev => prev.filter(s => s.id !== id));
    setWinState(prev => { const n = { ...prev }; delete n[id]; return n; });
  }, []);

  // 水平断面 生成・削除
  const finishHSection = useCallback((zPx, clipSec) => {
    hSecCounter.current++;
    const id = `hSec${hSecCounter.current}`;
    const label = zPx >= 0 ? `${Math.floor(zPx / MAJOR) + 1}F` : `B${Math.ceil(-zPx / MAJOR)}`;
    // clipSecがある場合: その範囲にズームフィットする初期zoom/中心を計算
    const WIN_W = 480, WIN_H = 352, SC_PAD = 40;
    let initZoom = 1, initCX = TW / 2, initCY = TH / 2;
    if (clipSec) {
      if (clipSec.center !== undefined) {
        initCX = clipSec.center.x; initCY = clipSec.center.y;
        const aW = clipSec.halfA * 2, aH = clipSec.halfB * 2;
        if (aW > 0 && aH > 0) initZoom = Math.max(0.1, Math.min(4, Math.min((WIN_W - SC_PAD * 2) / aW, (WIN_H - SC_PAD * 2) / aH)));
      } else if (clipSec.rect) {
        const { x1, y1, x2, y2 } = clipSec.rect;
        initCX = (x1 + x2) / 2; initCY = (y1 + y2) / 2;
        const aW = x2 - x1, aH = y2 - y1;
        if (aW > 0 && aH > 0) initZoom = Math.max(0.1, Math.min(4, Math.min((WIN_W - SC_PAD * 2) / aW, (WIN_H - SC_PAD * 2) / aH)));
      }
    }
    setHSections(prev => [...prev, { id, zPx, label, clipSec: clipSec || null, initCX, initCY }]);
    setHSecZooms(prev => ({ ...prev, [id]: initZoom }));
    setWinState(prev => ({
      ...prev,
      [id]: { x: 60 + hSecCounter.current * 30, y: 60 + hSecCounter.current * 30, w: 480, h: 380, z: ++zCounter.current, minimized: false },
    }));
    setHSecMode(null);
  }, []);

  const removeHSection = useCallback((id) => {
    setHSections(prev => prev.filter(s => s.id !== id));
    setWinState(prev => { const n = { ...prev }; delete n[id]; return n; });
  }, []);

  // 水平断面用ワイヤーフィルタリング: z=zPxを通過するセグメントのXY線分を返す
  const renderHSecSegs = useCallback((zPx) => {
    const TOL = MAJOR / 2;
    const _pos = allMapPosRef.current;
    const _dragId = mapDragRef.current?.id;
    const _dragLive = _dragId ? _lastDragPosRef.current : null;
    const _getPos = id => (_dragId === id && _dragLive) ? { ..._pos[id], ..._dragLive } : _pos[id];
    return segs.flatMap(sg => {
      const aPos = _getPos(sg.from), bPos = _getPos(sg.to);
      if (!aPos || !bPos) return [];
      const wps = segWp[sg.id] || [], wzs = wpZRef.current[sg.id] || [];
      const pts3d = [
        { x: aPos.x, y: aPos.y, z: aPos.z || 0 },
        ...wps.map((wp, i) => ({ x: wp.x, y: wp.y, z: wzs[i] || 0 })),
        { x: bPos.x, y: bPos.y, z: bPos.z || 0 },
      ];
      const lines = [];
      for (let i = 0; i < pts3d.length - 1; i++) {
        const p0 = pts3d[i], p1 = pts3d[i + 1];
        const zMin = Math.min(p0.z, p1.z), zMax = Math.max(p0.z, p1.z);
        if (zMax < zPx - TOL || zMin > zPx + TOL) continue;
        const t0 = zMax === zMin ? 0 : Math.max(0, (zPx - TOL - zMin) / (zMax - zMin));
        const t1 = zMax === zMin ? 1 : Math.min(1, (zPx + TOL - zMin) / (zMax - zMin));
        lines.push({
          x1: p0.x + (p1.x - p0.x) * t0, y1: p0.y + (p1.y - p0.y) * t0,
          x2: p0.x + (p1.x - p0.x) * t1, y2: p0.y + (p1.y - p0.y) * t1,
          isBus: sg.isBus, id: sg.id,
        });
      }
      return lines;
    });
  }, [segs, allMapPos, segWp]);

  // ============================================================
  // ノード描画
  // ============================================================
  const renderNodes = (mode, ref) => nodes.map(n => {
    const pos = allMapPos[n.id]; if (!pos) return null;
    // ルートフィルタ
    const isFiltered = routeSegs && !routeSegs.nodeIds.has(n.id);
    if (isFiltered && mode !== "cab") return null; // 2D図では非表示
    const filterDim = isFiltered ? { opacity: 0.12, filter: "grayscale(1)" } : {};

    const isHover = hoverId === n.id;
    const isHoverBadge = isHover && hovNodeView === mode; // バッジはホバー中のビューのみ
    const isSegHover = hoverSeg && segs.some(s => s.id === hoverSeg && (s.from === n.id || s.to === n.id));
    const isGizmo = mode === "cab" && gizmoTarget && gizmoTarget.type === "node" && gizmoTarget.id === n.id;
    const isWpDragHL = (wpDrag && segs.some(s => s.id === wpDrag.sid && (s.from === n.id || s.to === n.id))) ||
      (wpDragCab && segs.some(s => s.id === wpDragCab.sid && (s.from === n.id || s.to === n.id)));
    const isHL = isHover || isSegHover || isGizmo || isWpDragHL;
    let tp;
    if (mode === "plan") tp = pos;
    else if (mode === "elev") tp = { x: pos.x, y: GL_Y - (pos.z || 0) };
    else if (mode === "side") tp = { x: pos.y, y: GL_Y - (pos.z || 0) };
    else if (mode.startsWith("sec")) {
      const _secRaw = sections.find(s => s.id === mode);
      if (!_secRaw) return null;
      const sec = (_secRaw.p1 && _secRaw.p2) ? (() => {
        const _curPnRad = plantNorthAngle * Math.PI / 180;
        const { cx, cy, halfA: hA, halfB: hB } = obbFromP1P2(_secRaw.p1, _secRaw.p2, _curPnRad);
        return { ..._secRaw, center: { x: cx, y: cy }, halfA: hA, halfB: hB, pnRad: _curPnRad };
      })() : _secRaw;
      const p = projectToSection(sec, pos.x, pos.y, pos.z || 0);
      // ドラッグ中のアイコンは range チェックをスキップ（depth 計算誤差で消えるのを防ぐ）
      const _isSecDragging = secNodeDrag?.id === n.id && secNodeDrag?.secId === mode;
      if (!_isSecDragging && (p.depth < 0 || p.depth > p.totalDepth)) return null;
      const vd = secViewDataRef.current[mode];
      if (!vd) return null;
      // along範囲外のアイコンは非表示（ドラッグ中は clamp して表示継続）
      const isXViewR = vd.viewEdge === 'top' || vd.viewEdge === 'bottom';
      const _secLenR = vd.halfA !== undefined
        ? (isXViewR ? vd.halfA * 2 : vd.halfB * 2)
        : (isXViewR ? vd.rect.x2 - vd.rect.x1 : vd.rect.y2 - vd.rect.y1);
      if (!_isSecDragging && (p.along < 0 || p.along > _secLenR)) return null;
      tp = { x: vd.SPD + p.along, y: vd.dynSecGLY - (pos.z || 0) };
      // YZ面回転: 表示座標を回転中心(GL線中点)まわりに2D回転（SVGと同方向: -secRot）
      const _sRot = secRotates[mode] || 0;
      if (_sRot !== 0) {
        const rcx = (vd.dynSEC_W || 300) / 2, rcy = vd.dynSecGLY;
        const θ = -_sRot * Math.PI / 180;
        const dx = tp.x - rcx, dy = tp.y - rcy;
        tp = { x: rcx + dx * Math.cos(θ) - dy * Math.sin(θ), y: rcy + dx * Math.sin(θ) + dy * Math.cos(θ) };
      }
    } else tp = proj(pos.x, pos.y, pos.z || 0);

    const startD = (e) => {
      if (mode === "plan" && secMode) return; // secMode中はクリックを背景に通す（矢視描画用）
      if (mode === "cab" && e.button && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      iconDragging.current = true;
      if (mode === "elev") { startElevDrag(n.id, e); }
      else if (mode === "side") { startSideDrag(n.id, e); }
      else if (mode.startsWith("sec")) setSecNodeDrag({ id: n.id, secId: mode });
      else if (mode === "cab") {
        // アイコンはstopPropagation済みのため cab背景クリックハンドラの選択解除が届かない。
        // アイコンを操作対象にした時点で配電盤側の選択状態は明示的に解除する
        setSelectedPlacedPanelId(null); setSelectedDoorKey(null); setPanelDetailOpen(false);
        const pos = allMapPos[n.id] || { x: TW/2, y: TH/2 };
        const wz = pos.z || 0;
        const _az = camAzRef.current, _el = camElRef.current;
        // 常にXY水平面のみ移動（Z固定）: カメラ視点に関わらず水平面でドラッグ
        const mpp2 = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
        const p0s = project3D(pos.x, pos.y, wz*mpp2, _az, _el, 1, 0, 0);
        const pX2 = project3D(pos.x+1, pos.y, wz*mpp2, _az, _el, 1, 0, 0);
        const pY2 = project3D(pos.x, pos.y+1, wz*mpp2, _az, _el, 1, 0, 0);
        // XY方向の画面投影軸（wz=0で水平面限定）
        let axA = { sx: pX2.x-p0s.x, sy: pX2.y-p0s.y, wx: 1, wy: 0, wz: 0 };
        let axB = { sx: pY2.x-p0s.x, sy: pY2.y-p0s.y, wx: 0, wy: 1, wz: 0 };
        const det = axA.sx*axB.sy - axA.sy*axB.sx;
        if (Math.abs(det) < 1e-4) {
          const tgt = { type: "node", id: n.id };
          setGizmoTarget(prev => prev && prev.type === "node" && prev.id === n.id ? null : tgt);
          setTimeout(() => { iconDragging.current = false; }, 100);
        } else {
          const _sx = e.clientX, _sy = e.clientY;
          const _dragData = { id: n.id, startX: _sx, startY: _sy,
            startPos: { x: pos.x, y: pos.y }, startZ: wz, axA, axB, zoom: camZoomRef.current };
          setFaceIconDown(n.id);
          let _committed = false;
          const _mv = (me) => {
            if (_committed) return;
            if ((me.clientX-_sx)**2 + (me.clientY-_sy)**2 > 9) {
              _committed = true;
              setFaceDirect(_dragData);
            }
          };
          const _up = () => {
            setFaceIconDown(null);
            window.removeEventListener('mousemove', _mv);
            window.removeEventListener('mouseup', _up);
            if (!_committed) {
              iconDragging.current = false;
              const tgt = { type: "node", id: n.id };
              setGizmoTarget(prev => prev && prev.type === "node" && prev.id === n.id ? null : tgt);
            }
          };
          window.addEventListener('mousemove', _mv);
          window.addEventListener('mouseup', _up);
        }
      }
      else if (n.kind === "on_seg") setTDrag({ brId: n.id, segId: n.segId, view: mode });
      else {
        if (mode === "plan" && tp && planRef.current) {
          const curP = toP(planRef, e);
          mapDragOffsetRef.current = { x: tp.x - curP.x, y: tp.y - curP.y };
        } else {
          mapDragOffsetRef.current = { x: 0, y: 0 };
        }
        if (mode === 'plan') {
          // ── plan drag: setMapDrag不使用（React再描画ゼロ）、命令型でdrag管理 ──
          iconDragging.current = true;
          isDraggingRef.current = true;
          mapDragRef.current = { id: n.id, view: 'plan' };
          // DOM要素・polyline・rectをキャッシュ
          const _connSegs = connectedSegsMapRef.current[n.id] || [];
          const _pi = document.getElementById('pi-' + n.id);
          const _ci = document.getElementById('ci-' + n.id);
          const _cab = cabRef.current;
          const cW = _cab?.clientWidth || CAB_W, cH = _cab?.clientHeight || CAB_H;
          const sc = Math.min(cW / CAB_W, cH / CAB_H);
          const planRect = planRef.current?.getBoundingClientRect() || null;
          const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
          _connSegs.forEach(seg => {
            const pw = document.getElementById('pw-' + seg.id);
            const ew = document.getElementById('ew-' + seg.id);
            const sw = document.getElementById('sw-' + seg.id);
            const cw = document.getElementById('cw-' + seg.id);
            const cwh = document.getElementById('cwh-' + seg.id);
            if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
            if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
            if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
            cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
          });
          _dragGeomCache.current = {
            piEl: _pi, eiEl: document.getElementById('ei-' + n.id),
            siEl: document.getElementById('si-' + n.id), ciEl: _ci,
            piHW: _pi ? _pi.offsetWidth / 2 : 21,  piHH: _pi ? _pi.offsetHeight / 2 : 23,
            eiHW: 21, siHW: 21,
            cabHW: _ci ? _ci.offsetWidth / 2 : 14, cabHH: _ci ? _ci.offsetHeight / 2 : 15,
            cabOx: (cW - CAB_W * sc) / 2, cabOy: (cH - CAB_H * sc) / 2, cabSc: sc,
            planRect, connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
          };
          // Cesium wire SVG overlay（plan drag: billboard entityがアイコンをGPU表示）
          const _planPos0 = allMapPosRef.current[n.id] || {};
          const _planPos0WithId = { ..._planPos0, nodeId: n.id };
          const _pWireOv3d = _buildCesiumWireOverlay(cesium3dQueryRef, _connSegs, _planPos0WithId);
          const _pWireOv2d = _buildCesiumWireOverlay(cesium2dQueryRef, _connSegs, _planPos0WithId);
          // cursor grabbing
          if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id='__gs'; s.textContent='*{cursor:grabbing!important}'; document.head.appendChild(s); }
          // mousemove/mouseup を直接登録（setMapDrag不使用 → React再描画なし）
          let _rafId = null, _pendingEv = null;
          const _mv = (ev) => {
            ev.preventDefault();
            _pendingEv = ev;
            if (_rafId) return;
            _rafId = requestAnimationFrame(() => {
              _rafId = null;
              const ev2 = _pendingEv;
              if (!mapDragRef.current) return;
              const r = _dragGeomCache.current?.planRect;
              const z = planZoomRef.current || 1;
              const pp = r ? { x: (ev2.clientX - r.left) / z, y: (ev2.clientY - r.top) / z } : toP(planRef, ev2);
              let nx = pp.x + mapDragOffsetRef.current.x, ny = pp.y + mapDragOffsetRef.current.y;
              const _pz = z, SNAP_T = 15 / _pz;
              const _pnRad = plantNorthAngleRef.current * Math.PI / 180;
              const cosPn = Math.cos(_pnRad), sinPn = Math.sin(_pnRad);
              // O(1) snap
              const _nearId = nearbyIconRef.current;
              if (_nearId && _nearId !== n.id) {
                const np2 = allMapPosRef.current[_nearId];
                if (np2) {
                  const dx = nx - np2.x, dy = ny - np2.y;
                  const dPN = Math.abs(dx * cosPn + dy * sinPn), dX = Math.abs(dx * sinPn - dy * cosPn);
                  const sPN = dPN < SNAP_T, sX = dX < SNAP_T;
                  if (sPN || sX) {
                    const tPN = dx * sinPn - dy * cosPn, tX = dx * cosPn + dy * sinPn;
                    if (sPN && sX) { nx = np2.x; ny = np2.y; }
                    else if (sPN) { nx = np2.x + tPN * sinPn; ny = np2.y + tPN * (-cosPn); }
                    else { nx = np2.x + tX * cosPn; ny = np2.y + tX * sinPn; }
                  }
                }
              }
              _applyDragDOM(n.id, nx, ny);
              // Cesium wire overlay 更新（plan drag: X,Y変化、world座標で正確投影）
              const _gz = _planPos0.z||0;
              _updateCesiumWireOverlay(_pWireOv3d, nx, ny, _gz);
              _updateCesiumWireOverlay(_pWireOv2d, nx, ny, _gz);
            });
          };
          const _up = () => {
            if (_rafId) cancelAnimationFrame(_rafId);
            window.removeEventListener('mousemove', _mv);
            window.removeEventListener('mouseup', _up);
            window.removeEventListener('touchmove', _mv);
            window.removeEventListener('touchend', _up);
            document.getElementById('__gs')?.remove();
            const fp = _lastDragPosRef.current;
            _lastDragPosRef.current = null;
            if (window._cesiumDebug) console.log(`[planDrag:up] t=${performance.now().toFixed(1)} nodeId=${n.id} fp=${JSON.stringify(fp)} _planPos0=${JSON.stringify(_planPos0)}`);
            if (fp) {
              const snFp = snapFine(fp.x, fp.y, planZoomRef.current);
              const _gz = _planPos0.z || 0;
              // teardownはcesiumAllMapPos更新後のuseEffectに委譲（cbRef._allMapPosが旧値で上書きされる前にisDraggingRef=falseになるのを防ぐ）
              _pendingNonCesiumTeardownRef.current = {
                ov3d: _pWireOv3d, ov2d: _pWireOv2d,
                finalPos: { x: snFp.x, y: snFp.y, z: _gz },
                nodeId: n.id
              };
              // setMapPos → allMapPos変化 → cesiumAllMapPos変化 → useEffect[cesiumAllMapPos]でteardown
              setMapPos(pr => ({ ...pr, [n.id]: snFp }));
              // isDraggingRef = false は useEffect[cesiumAllMapPos] 内で設定（ここでは行わない）
            } else {
              _teardownCesiumWireOverlay(_pWireOv3d);
              _teardownCesiumWireOverlay(_pWireOv2d);
              isDraggingRef.current = false;
            }
            if (window._cesiumDebug) console.log(`[planDrag:up] pending=${!!_pendingNonCesiumTeardownRef.current} t=${performance.now().toFixed(1)}`);
            nearbyIconRef.current = null;
            mapDragRef.current = null;
            cesium3dRenderRef.current?.resume?.();
            cesium2dRenderRef.current?.resume?.();
            // 動かしたアイコンIDをセット（sampleHeightMostDetailedを接続wireのみに絞る）
            movedNodeRef.current = n.id;
            setTimeout(() => { movedNodeRef.current = null; }, 3000); // 3秒後にクリア
            // iconDragging=falseを50ms遅らせる：mouseUp直後のhoverIn/hoverOutイベント連発を抑制
            setTimeout(() => { iconDragging.current = false; }, 50);
          };
          window.addEventListener('mousemove', _mv);
          window.addEventListener('mouseup', _up);
          window.addEventListener('touchmove', _mv, { passive: false });
          window.addEventListener('touchend', _up);
        } else {
          iconDragging.current = true;
          setMapDrag({ id: n.id, view: mode });
        }
      }
    };
    const onCtx = (e) => { e.preventDefault(); e.stopPropagation(); setRouteFilter(prev => prev === n.id ? null : n.id); };

    const hoverIn = () => {
      if (iconDragging.current) {
        if (n.id !== mapDragRef.current?.id) nearbyIconRef.current = n.id;
        return;
      }
      setHovNodeView(mode);
      setHoverIdDebounced(n.id);
    };
    const hoverOut = () => {
      if (iconDragging.current) {
        if (nearbyIconRef.current === n.id) nearbyIconRef.current = null;
        return;
      }
      setHovNodeView(null);
      setHoverIdDebounced(null);
    };
    // cabモード+face-alignedドラッグ中はgrabbing、それ以外はgrab
    const cursor = (mode === "elev" || mode === "side") ? "grab"
      : (n.kind === "on_seg" ? "ew-resize"
      : (mode === "cab" && (faceIconDown === n.id || (faceDirect && faceDirect.id === n.id)) ? "grabbing" : "grab"));
    const hlColor = isHover ? HL_COLOR : HOVER_COLOR;
    const isCab = mode === "cab";
    if (isCab && n.kind === "on_seg") return null; // cab: on_seg接続点白丸は不要
    const nodeZ = isCab ? 20 : (n.kind === "symbol" ? 10 : 12); // cab: 線の上に表示
    // cab: xMidYMid meet のレターボックス補正付きpx座標でDIV配置
    let cabL, cabT;
    if (isCab) {
      const el = ref.current;
      const cW = el ? el.clientWidth : CAB_W, cH = el ? el.clientHeight : CAB_H;
      const sc = Math.min(cW / CAB_W, cH / CAB_H);
      const ox = (cW - CAB_W * sc) / 2, oy = (cH - CAB_H * sc) / 2;
      cabL = (off) => ox + tp.x * sc - off;
      cabT = (off) => oy + tp.y * sc - off;
    } else {
      cabL = (off) => tp.x - off;
      cabT = (off) => tp.y - off;
    }

    // カメラアイコン表示条件: ホバー中のビューのみ（wireホバーで端点が青くなる場合は非表示）
    const showCamIcon = isHoverBadge && n.kind === "symbol" && allMapPos[n.id];

    if (n.kind === "symbol") {
      const _sc = isCab ? Math.min(camZoom, 1.3) : 1;
      const _bW = isCab ? 28 : 42, _bH = isCab ? 30 : 46, _bSym = isCab ? 18 : 28, _bF = isCab ? 8 : 11;
      const _iW = Math.round(_bW * _sc), _iH = Math.round(_bH * _sc), _iSym = Math.round(_bSym * _sc);
      const modeZoom = mode === "plan" ? planZoom : mode === "elev" ? elevZoom : mode === "side" ? sideZoom : 1;
      const iconScale = (!isCab && modeZoom > 1) ? 1 / modeZoom : 1;
      // stateKey: pos・hover・zoom・gizmoが変化した時のみ renderFn() を実行
      // cab: isHL/isGizmo/isHoverBadge をstateKeyに含めない（Cesiumクリック等でホバー変化しても
      //      DOM再作成しないようにする。ホバー効果はcab drag中は_applyDragDOMがDOM直接更新するため不要）
      // cab: カメラ状態もstateKeyに含める（proj()の入力が変わるのでスクリーン位置が変わる）
      // sec: 回転角もstateKeyに含める（回転変化でアイコン位置が変わる）
      const _camSk = isCab ? `|${camAz.toFixed(3)},${camEl.toFixed(3)},${camZoom.toFixed(3)},${camPanX.toFixed(1)},${camPanY.toFixed(1)}` : '';
      const _secRotSk = mode.startsWith("sec") ? `|r${(secRotates[mode] || 0).toFixed(1)}` : '';
      const _sk = isCab
        ? `${pos?.x?.toFixed(1)},${pos?.y?.toFixed(1)},${pos?.z?.toFixed(1)}|${isFiltered}|${_sc.toFixed(2)}${_camSk}`
        : `${pos?.x?.toFixed(1)},${pos?.y?.toFixed(1)},${pos?.z?.toFixed(1)}|${isHL}|${isGizmo}|${isFiltered}|${modeZoom?.toFixed(2)}||${!!showCamIcon}|${isHoverBadge}${_secRotSk}`;
      return (
        <_MemoEl key={`${mode}${n.id}`} stateKey={_sk} renderFn={() => (
          <div data-node="true" data-node-id={n.id}
            id={mode === "plan" ? `pi-${n.id}` : mode === "elev" ? `ei-${n.id}` : mode === "side" ? `si-${n.id}` : mode === "cab" ? `ci-${n.id}` : mode.startsWith("sec") ? `sec-${mode}-${n.id}` : undefined}
            onMouseDown={startD} onTouchStart={startD}
            onMouseEnter={hoverIn} onMouseLeave={hoverOut} onContextMenu={onCtx}
            style={{ position: "absolute", left: cabL(_iW / 2), top: cabT(_iH / 2), width: _iW, height: _iH, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor, zIndex: nodeZ, borderRadius: 3, background: isHL ? "rgba(59,130,246,0.15)" : "transparent", boxShadow: isHL ? `0 0 0 2px ${hlColor}` : "none", touchAction: "none", transition: "box-shadow 0.15s", transform: `scale(${iconScale})`, transformOrigin: "center", ...filterDim }}>
            <Sym shape={n.shape} size={_iSym} color={n.color} hl={isHL} />
            <span style={{ fontSize: Math.round(_bF * _sc), fontWeight: 700, color: "#334155", lineHeight: 1 }}>{n.label}</span>
            {showCamIcon && <div
              onMouseDown={e => { e.stopPropagation(); e.preventDefault(); focusNode(n.id); }}
              style={{ position: "absolute", top: -10, right: -10, width: 16, height: 16, borderRadius: "50%", background: "#3B82F6", color: "#FFF", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.3)", zIndex: 50 }}
              title="3D/2Dマップにフォーカス">📷</div>}
            {isHoverBadge && <div
              onMouseDown={e => { e.stopPropagation(); e.preventDefault();
                setMapPos(pr => { const r = { ...pr }; delete r[n.id]; return r; });
                setMapZ(pr => { const r = { ...pr }; delete r[n.id]; return r; });
              }}
              style={{ position: "absolute", top: -10, left: -10, width: 16, height: 16, borderRadius: "50%", background: "#EF4444", color: "#FFF", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.3)", zIndex: 50 }}
              title="配置図から削除">×</div>}
          </div>
        )} />
      );
    }
    // 接続点: cab modeでは小さく控えめに（ホバー時だけ目立つ）
    if (n.kind === "free") {
      const sz = isCab ? (isHL ? 12 : 6) : 26;
      const mz = mode === "plan" ? planZoom : mode === "elev" ? elevZoom : mode === "side" ? sideZoom : 1;
      const freeScale = (!isCab && mz > 1) ? 1 / mz : 1;
      return <div data-node="true" key={`${mode}${n.id}`} onMouseDown={startD} onTouchStart={startD}
        onMouseEnter={hoverIn} onMouseLeave={hoverOut} onContextMenu={onCtx}
        style={{ position: "absolute", left: cabL(sz / 2), top: cabT(sz / 2), width: sz, height: sz, borderRadius: "50%", cursor, zIndex: nodeZ, background: isHL ? hlColor : BASE_COLOR, opacity: isCab && !isHL ? 0.5 : 1, boxShadow: isHL ? `0 0 6px ${hlColor}` : "none", touchAction: "none", transition: "background 0.15s, opacity 0.15s, box-shadow 0.15s", transform: `scale(${freeScale})`, transformOrigin: "center", ...filterDim }} />;
    }
    const sz2 = isCab ? (isHL ? 12 : 6) : 24;
    const mz2 = mode === "plan" ? planZoom : mode === "elev" ? elevZoom : mode === "side" ? sideZoom : 1;
    const pinScale = (!isCab && mz2 > 1) ? 1 / mz2 : 1;
    // _MemoEl: ドラッグ中はpos変化なし→スキップ→DOM操作保持、mouseUp後pos変化→再描画
    const _osSk = `${pos?.x?.toFixed(1)},${pos?.y?.toFixed(1)}|${isHL}|${isFiltered}|${mz2?.toFixed(2)}${mode.startsWith("sec") ? `|r${(secRotates[mode]||0).toFixed(1)}` : ''}`;
    return (
      <_MemoEl key={`${mode}${n.id}`} stateKey={_osSk} renderFn={() => (
        <div data-node="true"
          id={mode === "plan" ? `onseg-pi-${n.id}` : mode === "elev" ? `onseg-ei-${n.id}` : mode === "side" ? `onseg-si-${n.id}` : undefined}
          onMouseDown={startD} onTouchStart={startD}
          onMouseEnter={hoverIn} onMouseLeave={hoverOut} onContextMenu={onCtx}
          style={{ position: "absolute", left: cabL(sz2 / 2), top: cabT(sz2 / 2), width: sz2, height: sz2, borderRadius: "50%", cursor, zIndex: nodeZ, background: isHL ? hlColor : "#FFF", border: `${isCab ? 1.5 : 2.5}px solid ${isHL ? hlColor : BASE_COLOR}`, opacity: isCab && !isHL ? 0.5 : 1, touchAction: "none", transition: "background 0.15s, opacity 0.15s, box-shadow 0.15s", transform: `scale(${pinScale})`, transformOrigin: "center", ...filterDim }} />
      )} />
    );
  }).filter(Boolean);

  // 3次元図用: セグメント単位で深度ソート（交差で手前/奥がわかる）
  const cabSortedSegs = useMemo(() => {
    if (!proj) return [];
    const items = [];
    segs.forEach(seg => {
      const a = allMapPos[seg.from], b = allMapPos[seg.to];
      if (!a || !b) return;
      const isFiltered = routeSegs && !routeSegs.segIds.has(seg.id);
      const wps = segWp[seg.id] || [];
      const wzs = wpZ[seg.id] || [];
      const path = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
      const tPath = path.map(p => proj(p.x, p.y, p.z || 0));
      const pts = tPath.map(p => `${p.x},${p.y}`).join(" ");
      // 平均深度で全体をソート
      const avgDepth = tPath.reduce((s, p) => s + p.depth, 0) / tPath.length;
      items.push({ segId: seg.id, isBus: seg.isBus, isFiltered, pts, avgDepth, from: seg.from, to: seg.to });
    });
    items.sort((a, b) => b.avgDepth - a.avgDepth); // 奥→手前
    return items;
  }, [segs, allMapPos, segWp, wpZ, proj, routeSegs]);

  // セグメント描画（ホバーで折れ点表示、クリックで追加、plan/elevで操作可能）
  const renderSegs = (mode, ref, transform, opts) => segs.map(seg => {
    const a = allMapPos[seg.from], b = allMapPos[seg.to]; if (!a || !b) return null;
    // ルートフィルタ
    const isFiltered = routeSegs && !routeSegs.segIds.has(seg.id);
    if (isFiltered && mode !== "cab") return null; // 2D図では非表示

    const wps = segWp[seg.id] || [];
    const wzs = wpZ[seg.id] || [];
    const path = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
    const isHover = hoverSeg === seg.id;
    const isNodeHover = hoverId && (seg.from === hoverId || seg.to === hoverId);
    const isHL = isHover || isNodeHover || wpDrag?.sid === seg.id || wpDragCab?.sid === seg.id;

    const baseOpacity = 1;
    const segOpacity = isFiltered ? 0.08 : baseOpacity;
    const segColor = isHL ? HL_COLOR : (isFiltered ? "#999" : BASE_COLOR);
    const isCabMode = mode === "cab";
    const segStroke = isCabMode
      ? (seg.isBus ? (isHL ? 10 : 7) : (isHL ? 7 : 5))  // 3次元図: 平面図等と同等の太さ
      : (seg.isBus ? (isHL ? 6 : 5) : (isHL ? 4 : 3));  // 統一太さ: 画面3px(通常)/5px(母線)
    const canInteract = mode === "plan" || mode === "elev" || mode === "side" || mode === "sec";
    // CSS zoom で太くなる分を頭打ち（視覚: 通常3px/母線5px、ヒット: 6px以上を維持）
    const _mz = mode === "plan" ? planZoom : mode === "elev" ? elevZoom : mode === "side" ? sideZoom
              : mode.startsWith("sec") ? (secZooms[mode] || 1) : 1;
    const MAX_VISUAL_PX = seg.isBus ? 5 : 3;
    const cappedStroke = (_mz > 1) ? Math.min(segStroke, MAX_VISUAL_PX / _mz) : segStroke;
    // ヒットエリア: zoom問わず常に12画面px幅を保証（_mz>1/_mz<=1問わず同一式）
    // _mz<=1時に「16固定」にすると画面px換算がズームで変わりデッドゾーンが生じる
    const cappedHit    = Math.max(cappedStroke + 6 / _mz, 12 / _mz);
    // elev/side: JSヒット判定が担当するためSVGホバーイベントを無効化（CSSズームバグ回避）
    const _noSvgHover = mode === "elev" || mode === "side";
    // stateKey: 生座標で変化を判定（proj()計算なし）、変化なしならrenderFn()をスキップ
    // cab: カメラ状態もstateKeyに含める（proj()の入力が変わるのでスクリーン位置が変わる）
    const _segCamSk = (mode === "cab") ? `|${camAz.toFixed(3)},${camEl.toFixed(3)},${camZoom.toFixed(3)},${camPanX.toFixed(1)},${camPanY.toFixed(1)},${(cabSvgScale||1).toFixed(3)}` : '';
    const _segWpSk = wps.map((w, i) => `${w.x.toFixed(1)},${w.y.toFixed(1)},${(wzs[i]||0).toFixed(1)}`).join(';');
    const _segSk = `${a.x?.toFixed(1)},${a.y?.toFixed(1)},${a.z?.toFixed(1)}-${b.x?.toFixed(1)},${b.y?.toFixed(1)},${b.z?.toFixed(1)}|${_segWpSk}|${isHL}|${isFiltered}|${_mz.toFixed(2)}${_segCamSk}`;

    const _optsK = opts?.wireOnly ? '_w' : opts?.wpOnly ? '_f' : '';
    return (
      <_MemoEl key={`${mode}${seg.id}${_optsK}`} stateKey={_segSk + _optsK} renderFn={() => {
        const tPath = path.map(p => transform(p));
        const pts = tPath.map(p => `${p.x},${p.y}`).join(" ");
        // totalDist: 主wireとサブセグメントで共有するため先頭で計算
        const _wMpp = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
        const _wPts3d = [[a.x,a.y,mapZ[seg.from]||0],...wps.map((wp,i)=>[wp.x,wp.y,wzs[i]||0]),[b.x,b.y,mapZ[seg.to]||0]];
        let _totalDist=0; for(let k=0;k<_wPts3d.length-1;k++){const dx=(_wPts3d[k+1][0]-_wPts3d[k][0])*_wMpp,dy=(_wPts3d[k+1][1]-_wPts3d[k][1])*_wMpp,dz=_wPts3d[k+1][2]-_wPts3d[k][2];_totalDist+=Math.sqrt(dx*dx+dy*dy+dz*dz);}
        return (<g id={mode === "plan" ? `pw-${seg.id}` : mode === "elev" ? `ew-${seg.id}` : mode === "side" ? `sw-${seg.id}` : mode === "cab" ? `cw-${seg.id}` : mode.startsWith("sec") ? `sec-${mode}-w-${seg.id}` : undefined}>
        {/* 太い透明ヒットエリア: 折れ点なしはここが主担当、折れ点ありはサブセグが上に乗るので hoverSeg のみ担当 */}
        {!opts?.wpOnly && canInteract && <polyline points={pts} fill="none" stroke="transparent" strokeWidth={cappedHit}
          style={{ cursor: "pointer" }}
          onMouseEnter={_noSvgHover ? undefined : ev => {
            if (iconDragging.current) return;
            setHoverSegDebounced(seg.id, tPath.length <= 2 ? {x:ev.clientX,y:ev.clientY,dist:_totalDist} : {x:ev.clientX,y:ev.clientY,dist:_totalDist,segDist:null});
          }}
          onMouseMove={_noSvgHover ? undefined : ev => { if (!iconDragging.current) setWireTip(pr => pr ? {...pr, x:ev.clientX, y:ev.clientY} : null); }}
          onMouseLeave={_noSvgHover ? undefined : () => { if (!iconDragging.current) setHoverSegDebounced(null, null); }}
          onClick={ev => {
            if (!ev.ctrlKey) return; // Ctrl+クリックのみ折れ点追加
            const p = toP(ref, ev);
            if (mode === "elev") addWpElev(seg.id, p.x, p.y, _mz);
            else if (mode === "side") addWpSide(seg.id, p.x, p.y, _mz);
            else addWp(seg.id, p.x, p.y, _mz);
          }} />}
        {/* 折れ点区間別距離: 折れ点がある場合はサブセグが主担当（主wireより上に来るためhoverSeg+wireTip両方設定） */}
        {!opts?.wpOnly && canInteract && tPath.length > 2 && tPath.slice(0, -1).map((p0, si) => {
          const p1 = tPath[si + 1];
          const p3a = path[si], p3b = path[si + 1];
          const az = si === 0 ? (mapZ[seg.from]||0) : (wzs[si-1]||0);
          const bz = si === path.length - 2 ? (mapZ[seg.to]||0) : (wzs[si]||0);
          const sdx=(p3b.x-p3a.x)*_wMpp, sdy=(p3b.y-p3a.y)*_wMpp, sdz=bz-az;
          const segD = Math.sqrt(sdx*sdx+sdy*sdy+sdz*sdz);
          return (<polyline key={`sh${si}`} points={`${p0.x},${p0.y} ${p1.x},${p1.y}`}
            fill="none" stroke="transparent" strokeWidth={cappedHit}
            style={{ cursor: 'pointer' }}
            onMouseEnter={_noSvgHover ? undefined : ev => { if (!iconDragging.current) setHoverSegDebounced(seg.id, {x:ev.clientX,y:ev.clientY,dist:_totalDist,segDist:segD}); }}
            onMouseMove={_noSvgHover ? undefined : ev => { if (!iconDragging.current) setWireTip(pr => pr ? {...pr,x:ev.clientX,y:ev.clientY} : null); }}
            onMouseLeave={_noSvgHover ? undefined : () => { if (!iconDragging.current) setHoverSegDebounced(null, null); }}
            onClick={ev => { if (!ev.ctrlKey) return; const p = toP(ref, ev); if (mode === "elev") addWpElev(seg.id, p.x, p.y, _mz); else if (mode === "side") addWpSide(seg.id, p.x, p.y, _mz); else addWp(seg.id, p.x, p.y, _mz); }} />);
        })}
        {mode === "cab" && <polyline points={pts} fill="none" stroke="transparent" strokeWidth={16}
          style={{ cursor: drawMode ? "crosshair" : "pointer" }}
          onMouseEnter={ev => {
            if (iconDragging.current) return;
            const mpp = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
            const pts3d = [[a.x,a.y,mapZ[seg.from]||0],...wps.map((wp,k)=>[wp.x,wp.y,wzs[k]||0]),[b.x,b.y,mapZ[seg.to]||0]];
            let dist=0; for(let k=0;k<pts3d.length-1;k++){const dx=(pts3d[k+1][0]-pts3d[k][0])*mpp,dy=(pts3d[k+1][1]-pts3d[k][1])*mpp,dz=pts3d[k+1][2]-pts3d[k][2];dist+=Math.sqrt(dx*dx+dy*dy+dz*dz);}
            setHoverSegDebounced(seg.id, {x:ev.clientX,y:ev.clientY,dist});
          }}
          onMouseMove={ev => { if (!iconDragging.current) setWireTip(pr => pr ? {...pr, x:ev.clientX, y:ev.clientY} : null); }}
          onMouseLeave={() => { if (!iconDragging.current) setHoverSegDebounced(null, null); }}
          onClick={ev => {
            ev.stopPropagation();
            if (drawMode) {
              if (!drawState) {
                // 最初のクリック: この線を選択するだけ（折れ点は作らない）
                // 最後の折れ点の位置を取得
                const lastWp = wps.length > 0
                  ? { x: wps[wps.length - 1].x, y: wps[wps.length - 1].y, z: wzs[wps.length - 1] || 0 }
                  : { x: b.x, y: b.y, z: b.z || 0 };
                setDrawState({ sid: seg.id, lastPos: lastWp });
              }
              // drawState中のクリックはnativeのonUp側で処理
            } else {
              if (!ev.ctrlKey) return; // Ctrl+クリックのみ折れ点追加
              const p = toP(cabRef, ev);
              addWpCab(seg.id, p.x, p.y);
            }
          }} />}
        {/* 3次元図: 折れ点がある場合のサブセグ区間別距離（メインhitより後＝上に来るため優先） */}
        {mode === "cab" && tPath.length > 2 && tPath.slice(0, -1).map((p0, si) => {
          const p1 = tPath[si + 1];
          const p3a = path[si], p3b = path[si + 1];
          const sdx=(p3b.x-p3a.x)*_wMpp, sdy=(p3b.y-p3a.y)*_wMpp, sdz=(p3b.z||0)-(p3a.z||0);
          const segD = Math.sqrt(sdx*sdx+sdy*sdy+sdz*sdz);
          const _hitWC = 16 / (cabSvgScale || 1);
          return (<polyline key={`csh${si}`} points={`${p0.x.toFixed(1)},${p0.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`}
            fill="none" stroke="transparent" strokeWidth={_hitWC}
            pointerEvents="stroke" style={{ cursor: 'pointer' }}
            onMouseEnter={ev => { setHoverSegDebounced(seg.id, {x:ev.clientX,y:ev.clientY,dist:_totalDist,segDist:segD}); }}
            onMouseMove={ev => { setWireTip(pr => pr ? {...pr,x:ev.clientX,y:ev.clientY} : null); }}
            onMouseLeave={() => { setHoverSegDebounced(null, null); }} />);
        })}
        {/* アウトライン: ホバー時は水色、通常は白（cabは深度ソート層で描画） */}
        {!opts?.wpOnly && mode !== "cab" && !isFiltered && <polyline points={pts} fill="none"
          stroke={isHL ? HL_COLOR : "rgba(232,236,240,0.95)"} strokeWidth={cappedStroke + 6 / Math.max(1, _mz)}
          strokeLinejoin="round" strokeLinecap="round" pointerEvents="none"
          style={{ transition: "stroke 0.15s" }} />}
        {/* 線本体: 常に黒（ホバーでも変えない）（cabは深度ソート層で描画） */}
        {!opts?.wpOnly && mode !== "cab" && <polyline points={pts} fill="none" stroke={isFiltered ? "#999" : BASE_COLOR}
          strokeWidth={cappedStroke}
          strokeLinejoin="round" strokeLinecap="round"
          opacity={segOpacity} pointerEvents="none" />}
        {/* 折れ点マーカー: plan/elev/side=ホバーで表示+ドラッグ, cab=ホバーで表示+クリックでギズモ */}
        {!opts?.wireOnly && (canInteract || mode === "cab") && wps.map((wp, i) => {
          const twp = tPath[i + 1];
          const isWpGizmo = mode === "cab" && gizmoTarget && gizmoTarget.type === "wp" && gizmoTarget.sid === seg.id && gizmoTarget.wi === i;
          const showDot = isHL || isWpGizmo;
          return (
            <g key={`wp${seg.id}-${i}`}
              style={{ pointerEvents: (mode === "plan" && secMode) ? "none" : "auto" }}
              onMouseEnter={_noSvgHover ? undefined : ev => {
                if (iconDragging.current || wpDragActiveRef.current) return;
                if (mode === "cab") { setHoverSegDebounced(seg.id, null); return; }
                let _cumDist = 0;
                for (let _k = 0; _k <= i; _k++) {
                  const _dx=(_wPts3d[_k+1][0]-_wPts3d[_k][0])*_wMpp, _dy=(_wPts3d[_k+1][1]-_wPts3d[_k][1])*_wMpp, _dz=_wPts3d[_k+1][2]-_wPts3d[_k][2];
                  _cumDist += Math.sqrt(_dx*_dx+_dy*_dy+_dz*_dz);
                }
                setHoverSegDebounced(seg.id, {x: ev.clientX, y: ev.clientY, dist: _totalDist, segDist: _cumDist});
              }}
              onMouseMove={_noSvgHover ? undefined : ev => {
                if (iconDragging.current || wpDragActiveRef.current) return;
                setWireTip(pr => pr ? {...pr, x: ev.clientX, y: ev.clientY} : null);
              }}
              onMouseLeave={_noSvgHover ? undefined : () => setHoverSegDebounced(null, null)}>
              {(() => {
                const _onMD = ev => {
                  if (ev.ctrlKey) { ev.stopPropagation(); ev.preventDefault(); rmWp(seg.id, i); return; }
                  if (mode === "cab" && ev.button !== 0) return; // 左クリックのみ
                  ev.stopPropagation(); ev.preventDefault();
                  if (mode === "cab") {
                    iconDragging.current = true;
                    // 軸ベクトル計算（水平XY平面ドラッグ用）
                    const _az = camAzRef.current, _el = camElRef.current, _zoom = camZoomRef.current;
                    const mpp2 = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                    const _wz = (wzs[i] || 0) * mpp2;
                    const p0 = project3D(wp.x,     wp.y,     _wz, _az, _el, 1, 0, 0);
                    const pX = project3D(wp.x + 1, wp.y,     _wz, _az, _el, 1, 0, 0);
                    const pY = project3D(wp.x,     wp.y + 1, _wz, _az, _el, 1, 0, 0);
                    const _axA = { sx: pX.x - p0.x, sy: pX.y - p0.y, wx: 1, wy: 0 };
                    const _axB = { sx: pY.x - p0.x, sy: pY.y - p0.y, wx: 0, wy: 1 };
                    const _drag = { sid: seg.id, wi: i, startX: ev.clientX, startY: ev.clientY,
                      startWp: { x: wp.x, y: wp.y, z: wzs[i] || 0 }, axA: _axA, axB: _axB, zoom: _zoom };
                    let _committed = false;
                    const _mv = (me) => {
                      if (_committed) return;
                      if ((me.clientX - ev.clientX)**2 + (me.clientY - ev.clientY)**2 > 9) {
                        _committed = true; setWpDragCab(_drag);
                      }
                    };
                    const _up = () => {
                      window.removeEventListener('mousemove', _mv); window.removeEventListener('mouseup', _up);
                      if (!_committed) {
                        iconDragging.current = false;
                        const tgt = { type: "wp", sid: seg.id, wi: i };
                        setGizmoTarget(prev => prev && prev.type === "wp" && prev.sid === seg.id && prev.wi === i ? null : tgt);
                      }
                    };
                    window.addEventListener('mousemove', _mv); window.addEventListener('mouseup', _up);
                  } else {
                    const _prevPt = i === 0 ? a : wps[i - 1];
                    const _prevZ  = i === 0 ? (a.z || 0) : (wzs[i - 1] || 0);
                    const _nextPt = i === wps.length - 1 ? b : wps[i + 1];
                    const _nextZ  = i === wps.length - 1 ? (b.z || 0) : (wzs[i + 1] || 0);
                    const _ppPt = i >= 2 ? wps[i-2] : (i === 1 ? a : null);
                    const _ppZ  = i >= 2 ? (wzs[i-2]||0) : (i === 1 ? (a?.z||0) : null);
                    const _nnPt = i <= wps.length-3 ? wps[i+2] : (i === wps.length-2 ? b : null);
                    const _nnZ  = i <= wps.length-3 ? (wzs[i+2]||0) : (i === wps.length-2 ? (b?.z||0) : null);
                    const _wpInfo = { sid: seg.id, wi: i, view: mode,
                      prevX: _prevPt?.x??null, prevY: _prevPt?.y??null, prevZ: _prevZ,
                      nextX: _nextPt?.x??null, nextY: _nextPt?.y??null, nextZ: _nextZ,
                      prevPrevX: _ppPt?.x??null, prevPrevY: _ppPt?.y??null, prevPrevZ: _ppZ,
                      nextNextX: _nnPt?.x??null, nextNextY: _nnPt?.y??null, nextNextZ: _nnZ,
                      hasPrevWp: i > 0, hasNextWp: i < wps.length - 1 };
                    let _wpDone = false;
                    const _wpMv = (me) => {
                      if (_wpDone) return;
                      if ((me.clientX - ev.clientX)**2 + (me.clientY - ev.clientY)**2 > 9) {
                        _wpDone = true;
                        setWpDrag(_wpInfo);
                        window.removeEventListener('mousemove', _wpMv);
                        window.removeEventListener('mouseup', _wpUp);
                      }
                    };
                    const _wpUp = () => {
                      window.removeEventListener('mousemove', _wpMv);
                      window.removeEventListener('mouseup', _wpUp);
                    };
                    window.addEventListener('mousemove', _wpMv);
                    window.addEventListener('mouseup', _wpUp);
                  }
                };
                const _onTS = ev => { ev.stopPropagation(); ev.preventDefault(); setHoverSeg(seg.id);
                  if (mode === "cab") { setGizmoTarget({ type: "wp", sid: seg.id, wi: i }); }
                  else if (mode === "sec") { /* 矢視図は座標系が異なるためwpドラッグ非対応 */ }
                  else {
                    const _prevPt = i === 0 ? a : wps[i - 1];
                    const _prevZ  = i === 0 ? (a.z || 0) : (wzs[i - 1] || 0);
                    const _nextPt = i === wps.length - 1 ? b : wps[i + 1];
                    const _nextZ  = i === wps.length - 1 ? (b.z || 0) : (wzs[i + 1] || 0);
                    const _ppPt = i >= 2 ? wps[i-2] : (i === 1 ? a : null);
                    const _ppZ  = i >= 2 ? (wzs[i-2]||0) : (i === 1 ? (a?.z||0) : null);
                    const _nnPt = i <= wps.length-3 ? wps[i+2] : (i === wps.length-2 ? b : null);
                    const _nnZ  = i <= wps.length-3 ? (wzs[i+2]||0) : (i === wps.length-2 ? (b?.z||0) : null);
                    setWpDrag({ sid: seg.id, wi: i, view: mode,
                      prevX: _prevPt?.x??null, prevY: _prevPt?.y??null, prevZ: _prevZ,
                      nextX: _nextPt?.x??null, nextY: _nextPt?.y??null, nextZ: _nextZ,
                      prevPrevX: _ppPt?.x??null, prevPrevY: _ppPt?.y??null, prevPrevZ: _ppZ,
                      nextNextX: _nnPt?.x??null, nextNextY: _nnPt?.y??null, nextNextZ: _nnZ,
                      hasPrevWp: i > 0, hasNextWp: i < wps.length - 1 });
                  }
                };
                const _onCM = ev => { ev.preventDefault(); rmWp(seg.id, i); };
                // elev/side: JSがカーソル制御するためCSS cursorを持たせない（SVG要素のcursorがコンテナを上書きするのを防ぐ）
                const _hitSt = { cursor: _noSvgHover ? "inherit" : "grab", pointerEvents: "all" };
                if (mode === "cab") {
                  return <circle cx={twp.x} cy={twp.y} r={14 / cabSvgScale} fill="transparent" style={_hitSt} onMouseDown={_onMD} onTouchStart={_onTS} onContextMenu={_onCM} />;
                }
                // 非cab: isHL時のみヒットレクト描画。isHL=false時はwire sub-segが担当し
                // zブロック(wpOnly z=15 > wireOnly z=5)によるwireホバー妨害を回避する
                if (!isHL && !isWpGizmo) return null;
                const _hs = 5 / _mz;
                return <rect x={twp.x - _hs} y={twp.y - _hs} width={_hs * 2} height={_hs * 2} fill="transparent" style={_hitSt} onMouseDown={_onMD} onTouchStart={_onTS} onContextMenu={_onCM} />;
              })()}
              {/* 折れ点マーカー: ホバー時のみ表示、白枠・水色塗り */}
              {showDot && (() => {
                let sz, strokeW;
                if (mode === "cab") {
                  // cab: viewBoxスケール(_csc)で割ってSVG単位を算出→画面上は平面図と同サイズ
                  const _csc = cabSvgScale || 1;
                  sz = (isWpGizmo ? 20 : 10) / _csc;
                  strokeW = 1.5 / _csc;
                } else {
                  const _zoom = mode === "plan" ? planZoom : mode === "elev" ? elevZoom : mode === "side" ? sideZoom : 1;
                  const z = _zoom || 1;
                  sz = (isWpGizmo ? 20 : 10) / z;
                  strokeW = 1.5 / z;
                }
                const half = sz / 2;
                const rx = Math.min(1, sz * 0.1);
                const _zoom2 = mode === "plan" ? planZoom : mode === "elev" ? elevZoom : mode === "side" ? sideZoom : 1;
                // console.log(`[折れ点四角] seg=${seg.id} wp=${i} mode=${mode} SVG座標=(${twp.x.toFixed(1)}, ${twp.y.toFixed(1)}) sz_svgPx=${sz.toFixed(2)} sz_screenPx=${(sz*(_zoom2||1)).toFixed(1)} hitHalf_svgPx=${(5/(_zoom2||1)).toFixed(2)} hitHalf_screenPx=5`);
                return (
                  <rect
                    x={twp.x - half} y={twp.y - half} width={sz} height={sz}
                    fill="#DBEAFE"
                    stroke={HL_COLOR}
                    strokeWidth={strokeW * 2}
                    rx={rx}
                    pointerEvents="none"
                  />
                );
              })()}
            </g>
          );
        })}
        {/* 線セグメント中点ハンドル: 透明ヒットエリアは常時、視覚的黄円はホバー時のみ */}
        {!opts?.wpOnly && (canInteract || mode === "cab" || mode === "sec") && tPath.length >= 2 && tPath.slice(0, -1).map((pa, si) => {
          const pb = tPath[si + 1];
          const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
          const sdx = pb.x - pa.x, sdy = pb.y - pa.y;
          const slen = Math.sqrt(sdx*sdx + sdy*sdy);
          const minLen = mode === "cab" ? 20 : 8 / _mz;
          if (slen < minLen) return null;
          const perpX = -sdy / slen, perpY = sdx / slen;
          const nWps = wps.length;
          const aIsIcon = si === 0;
          const bIsIcon = (si + 1) === nWps + 1;
          if (aIsIcon && nodeById[seg.from]?.kind === "on_seg") return null;
          if (bIsIcon && nodeById[seg.to]?.kind === "on_seg") return null;
          const _css = mode === "cab" ? cabSvgScale : 1; // cab: viewBoxスケール補正（SVG単位→画面px）
          // Math.min廃止: _mz<1時も6/_mzで常に6画面px半径を保証
          const r  = mode === "cab" ? 6 / _css : 6 / _mz;
          const sw = mode === "cab" ? 1.5 : 1.5 / _mz;
          const hitR = mode === "cab" ? 10 / _css : r; // 表示サイズに一致させる（固定px禁止）
          return (
            <g key={`sld_${si}`}
              onMouseEnter={_noSvgHover ? undefined : () => setHoverSegDebounced(seg.id, null)}
              onMouseLeave={_noSvgHover ? undefined : () => setHoverSegDebounced(null, null)}>
              {/* isHL時のみヒットサークル描画。isHL=false時はwire sub-segが担当 */}
              {isHL && <circle cx={mx} cy={my} r={hitR} fill="transparent"
                style={{ cursor: _noSvgHover ? "inherit" : "grab", pointerEvents: "all" }}
                onMouseDown={ev => {
                  ev.preventDefault(); ev.stopPropagation();
                  if (mode === "cab") {
                    const worldA = path[si], worldB = path[si + 1];
                    const wdx = worldB.x - worldA.x, wdy = worldB.y - worldA.y;
                    const wlen2D = Math.sqrt(wdx*wdx + wdy*wdy);
                    if (wlen2D < 0.01) return;
                    const wPerpX = -wdy / wlen2D, wPerpY = wdx / wlen2D;
                    const wParX  =  wdx / wlen2D, wParY  = wdy / wlen2D;
                    const _mpp2 = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                    const midWz = (((worldA.z||0) + (worldB.z||0)) / 2) * _mpp2;
                    const midWx = (worldA.x + worldB.x) / 2, midWy = (worldA.y + worldB.y) / 2;
                    const _az = camAzRef.current, _el = camElRef.current;
                    const sp0 = project3D(midWx,          midWy,          midWz, _az, _el, 1, 0, 0);
                    const sp1 = project3D(midWx + wPerpX, midWy + wPerpY, midWz, _az, _el, 1, 0, 0);
                    const sp2 = project3D(midWx + wParX,  midWy + wParY,  midWz, _az, _el, 1, 0, 0);
                    setSegLineDragCab({
                      startX: ev.clientX, startY: ev.clientY,
                      zoom: camZoomRef.current,
                      aIsIcon, bIsIcon,
                      aId: aIsIcon ? seg.from : seg.id, aWi: aIsIcon ? null : si - 1,
                      bId: bIsIcon ? seg.to : seg.id,   bWi: bIsIcon ? null : si,
                      origAx: worldA.x, origAy: worldA.y,
                      origBx: worldB.x, origBy: worldB.y,
                      sPerpX: sp1.x - sp0.x, sPerpY: sp1.y - sp0.y,
                      sParX:  sp2.x - sp0.x, sParY:  sp2.y - sp0.y,
                      wPerpX, wPerpY, wParX, wParY,
                    });
                  } else if (mode !== "sec") {
                    // 矢視図は独自座標系のためwireドラッグ非対応（hover/circle表示のみ）
                    const mouseP = toP(ref, ev);
                    setSegLineDrag({
                      mode, perpX, perpY, parX: sdx/slen, parY: sdy/slen,
                      startMouseX: mouseP.x, startMouseY: mouseP.y,
                      origA: { x: pa.x, y: pa.y },
                      origB: { x: pb.x, y: pb.y },
                      aIsIcon, bIsIcon,
                      aId: aIsIcon ? seg.from : seg.id, aWi: aIsIcon ? null : si - 1,
                      bId: bIsIcon ? seg.to : seg.id,   bWi: bIsIcon ? null : si,
                    });
                  }
                }} />}
              {isHL && (() => {
                // console.log(`[黄色丸] seg=${seg.id} si=${si} mode=${mode} SVG座標=(${mx.toFixed(1)}, ${my.toFixed(1)}) r_svgPx=${r.toFixed(2)} r_screenPx=${(r*(_zoom3||1)).toFixed(1)} セグ長_svgPx=${slen.toFixed(1)} セグ長_screenPx=${(slen*(_zoom3||1)).toFixed(1)}`);
                return <circle cx={mx} cy={my} r={r} fill="#EAB308" stroke={HL_COLOR} strokeWidth={sw} pointerEvents="none" />;
              })()}
            </g>
          );
        })}
      </g>);
      }} />
    );
  });

  const placedN = nodes.filter(n => n.kind === "symbol" && mapPos[n.id]).length;
  const totalN = nodes.filter(n => n.kind === "symbol").length;

  // CesiumMap共通コールバック（3D/2Dインスタンスで共有）
  const cesiumOnDropNode = useCallback((id, pos) => {
    const baseNode = nodes.find(n => n.id === id);
    if (!baseNode) return;
    const ids = selected.size > 0 && selected.has(id) ? [...selected] : [id];
    const selNodes = ids.map(nid => nodes.find(n => n.id === nid)).filter(n => n && n.kind !== "on_seg");
    if (selNodes.length === 0) return;
    const scale = 3;
    setMapPos(pr => {
      const up = { ...pr };
      selNodes.forEach(nd => {
        const dx = (nd.dPos.x - baseNode.dPos.x) * scale;
        const dy = (nd.dPos.y - baseNode.dPos.y) * scale;
        up[nd.id] = snapFine(
          Math.max(0, Math.min(TW, pos.x + dx)),
          Math.max(0, Math.min(TH, pos.y + dy)),
          planZoom
        );
      });
      return up;
    });
    setMapZ(pr => {
      const up = { ...pr };
      selNodes.forEach(nd => { up[nd.id] = snapFineV(pos.z || 0, planZoom); });
      return up;
    });
    setSelected(new Set());
  }, [nodes, selected, planZoom]);
  const cesiumOnAddWp = useCallback((segId, pos) => {
    const seg = segs.find(s => s.id === segId); if (!seg) return;
    const a = allMapPos[seg.from], b = allMapPos[seg.to]; if (!a || !b) return;
    const wps = segWp[segId] || [];
    const wzs = wpZ[segId] || [];
    const path = [a, ...wps.map((w, i) => ({ ...w, z: wzs[i] || 0 })), b];
    let bs = 0, bd = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const mx = (path[i].x + path[i + 1].x) / 2, my = (path[i].y + path[i + 1].y) / 2;
      const dd = (pos.x - mx) ** 2 + (pos.y - my) ** 2;
      if (dd < bd) { bd = dd; bs = i; }
    }
    setSegWp(prev => { const w = [...(prev[segId] || [])]; w.splice(bs, 0, snap(pos.x, pos.y)); return { ...prev, [segId]: w }; });
    setWpZ(prev => { const w = [...(prev[segId] || [])]; w.splice(bs, 0, pos.z || 0); return { ...prev, [segId]: w }; });
  }, [segs, allMapPos, segWp, wpZ]);
  const cesiumOnMoveWp = useCallback((segId, wi, pos) => {
    setSegWp(prev => { const w = [...(prev[segId] || [])]; if (w[wi]) w[wi] = { x: pos.x, y: pos.y }; return { ...prev, [segId]: w }; });
    setWpZ(prev => { const w = [...(prev[segId] || [])]; w[wi] = pos.z || 0; return { ...prev, [segId]: w }; });
  }, []);
  // Cesium 2D/3D ノードドラッグ：命令型アプローチ（setMapPos は mouseUp 時のみ）
  // wireCanvas overlay refs（3次元図ドラッグと同じcanvas描画方式で smooth 化）
  const _cesiumDragOv3dRef = useRef(null);
  const _cesiumDragOv2dRef = useRef(null);
  // allMapPos更新後のteardown延期用（postRenderが正しい位置を参照するまでentity/wireを出さない）
  const _cesiumDragTeardownRef = useRef(null);
  // 非Cesiumドラッグ（平面図/断面図/側面図/3次元図/矢視図）のteardown延期用
  // mouseUpでは isDraggingRef=trueのまま維持し、cesiumAllMapPos更新後にuseEffectでteardownする
  const _pendingNonCesiumTeardownRef = useRef(null);

  const cesiumOnStartDragNode = useCallback((nodeId, pos0) => {
    // isDraggingRef=trueの前にwireキャッシュを確保（初回ドラッグ時にpostRender未実行でも背景wireを表示）
    cesium3dQueryRef.current?.ensureWireCache?.();
    cesium2dQueryRef.current?.ensureWireCache?.();
    isDraggingRef.current = true;
    movedNodeRef.current = nodeId;
    iconDragging.current = true;
    // drag キャッシュ構築（_applyDragDOM が各ビューを更新できるよう）
    const _connSegs = connectedSegsMapRef.current[nodeId] || [];
    const _pi = document.getElementById('pi-' + nodeId);
    const _ci = document.getElementById('ci-' + nodeId);
    const _cab = cabRef.current;
    const cW = _cab?.clientWidth || CAB_W, cH = _cab?.clientHeight || CAB_H;
    const sc = Math.min(cW / CAB_W, cH / CAB_H);
    const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
    _connSegs.forEach(seg => {
      const pw = document.getElementById('pw-' + seg.id), ew = document.getElementById('ew-' + seg.id);
      const sw = document.getElementById('sw-' + seg.id), cw = document.getElementById('cw-' + seg.id);
      const cwh = document.getElementById('cwh-' + seg.id);
      if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
      if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
      if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
      cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
    });
    _dragGeomCache.current = {
      piEl: _pi, eiEl: document.getElementById('ei-' + nodeId),
      siEl: document.getElementById('si-' + nodeId), ciEl: _ci,
      piHW: _pi ? _pi.offsetWidth / 2 : 21, piHH: _pi ? _pi.offsetHeight / 2 : 23,
      eiHW: 21, siHW: 21,
      cabHW: _ci ? _ci.offsetWidth / 2 : 14, cabHH: _ci ? _ci.offsetHeight / 2 : 15,
      cabOx: (cW - CAB_W * sc) / 2, cabOy: (cH - CAB_H * sc) / 2, cabSc: sc,
      connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
      elevRect: elevRef.current?.getBoundingClientRect() || null,
      sideRect: sideRef.current?.getBoundingClientRect() || null,
    };
    // 3次元図ドラッグと同じ方式: entity/wire非表示 → wireCanvasに直接描画（smooth）
    const _pos0WithId = { ...pos0, nodeId };
    _cesiumDragOv3dRef.current = _buildCesiumWireOverlay(cesium3dQueryRef, _connSegs, _pos0WithId);
    _cesiumDragOv2dRef.current = _buildCesiumWireOverlay(cesium2dQueryRef, _connSegs, _pos0WithId);
    // hide後の空白フレーム防止: 初期位置で即時描画（次のmousemoveを待たずに表示を維持）
    const _initGz = mapZRef.current[nodeId] != null ? mapZRef.current[nodeId] : (pos0?.z || 0);
    _updateCesiumWireOverlay(_cesiumDragOv3dRef.current, pos0.x, pos0.y, _initGz);
    _updateCesiumWireOverlay(_cesiumDragOv2dRef.current, pos0.x, pos0.y, _initGz);
  }, []);

  const cesiumOnMoveNode = useCallback((nodeId, pos) => {
    if (isDraggingRef.current && _dragGeomCache.current?.connSegs) {
      // 命令型：React 再描画なし、全ビューをDOM直接更新
      _applyDragDOM(nodeId, pos.x, pos.y);
      _lastDragPosRef.current = { x: pos.x, y: pos.y, z: pos.z || 0 };
      // wireCanvas overlay 更新（3次元図ドラッグと同じ方式）
      const _gz = pos.z || 0;
      _updateCesiumWireOverlay(_cesiumDragOv3dRef.current, pos.x, pos.y, _gz);
      _updateCesiumWireOverlay(_cesiumDragOv2dRef.current, pos.x, pos.y, _gz);
    } else {
      // フォールバック（axis拘束ドラッグなど）
      setMapPos(prev => ({ ...prev, [nodeId]: { x: pos.x, y: pos.y } }));
      setMapZ(prev => ({ ...prev, [nodeId]: pos.z || 0 }));
    }
  }, []);

  const cesiumOnEndDragNode = useCallback((nodeId, lastPos) => {
    const fp = lastPos || _lastDragPosRef.current;
    _lastDragPosRef.current = null;
    // wireCanvasはクリアしない：teardown後のpostRender(5204)が同フレームでclearRect+再描画するため
    // 先にclearWireCanvasすると「wireCanvas空→entity表示」の空白フレームが生じてフラッシュする
    // entity/wire teardownはallMapPos更新後に延期する
    // （isDraggingRef=trueを維持してpostRenderをブロック → cbRef._allMapPos更新後に解放）
    _cesiumDragTeardownRef.current = {
      ov3d: _cesiumDragOv3dRef.current,
      ov2d: _cesiumDragOv2dRef.current,
      finalPos: fp || null,  // showNodeEntity(pos)で移動先に確実に配置するため保存
      nodeId,
    };
    _cesiumDragOv3dRef.current = null;
    _cesiumDragOv2dRef.current = null;
    iconDragging.current = false;
    movedNodeRef.current = nodeId;
    setTimeout(() => { movedNodeRef.current = null; }, 3000);
    _dragGeomCache.current = null;
    if (fp) {
      // setMapPos → allMapPos変化 → useEffect[allMapPos]でteardown
      setMapPos(prev => ({ ...prev, [nodeId]: { x: fp.x, y: fp.y } }));
      setMapZ(prev => ({ ...prev, [nodeId]: fp.z || 0 }));
    } else {
      // 移動量ゼロ（クリック扱い）は即解放
      _teardownCesiumWireOverlay(_cesiumDragTeardownRef.current?.ov3d);
      _teardownCesiumWireOverlay(_cesiumDragTeardownRef.current?.ov2d);
      _cesiumDragTeardownRef.current = null;
      isDraggingRef.current = false;
    }
  }, []);
  // allMapPos(=cesiumAllMapPos)変化時: CesiumMap再描画+cbRef._allMapPos更新完了後にentity/wireを復元
  // Cesiumドラッグ・非Cesiumドラッグ両方を処理する。isDraggingRef=trueを維持してpostRenderをブロックし、
  // cbRef._allMapPosが新位置で更新された後でisDraggingRef=falseにすることでフラッシュを防ぐ
  useEffect(() => {
    const td  = _cesiumDragTeardownRef.current;
    const ntd = _pendingNonCesiumTeardownRef.current;
    if (!td && !ntd) return;
    if (window._cesiumDebug) console.log(`[App:teardown] START t=${performance.now().toFixed(1)} cesium=${!!td} nonCesium=${!!ntd}`);
    if (td) {
      _cesiumDragTeardownRef.current = null;
      cesium3dQueryRef.current?.clearWireCanvas?.();
      cesium2dQueryRef.current?.clearWireCanvas?.();
      if (td.finalPos && td.nodeId) {
        cesium3dQueryRef.current?.updateMapPosForNode?.(td.nodeId, td.finalPos);
        cesium2dQueryRef.current?.updateMapPosForNode?.(td.nodeId, td.finalPos);
      }
      _teardownCesiumWireOverlay(td.ov3d, td.finalPos);
      _teardownCesiumWireOverlay(td.ov2d, td.finalPos);
    }
    if (ntd) {
      _pendingNonCesiumTeardownRef.current = null;
      cesium3dQueryRef.current?.clearWireCanvas?.();
      cesium2dQueryRef.current?.clearWireCanvas?.();
      if (ntd.finalPos && ntd.nodeId) {
        cesium3dQueryRef.current?.updateMapPosForNode?.(ntd.nodeId, ntd.finalPos);
        cesium2dQueryRef.current?.updateMapPosForNode?.(ntd.nodeId, ntd.finalPos);
      }
      _teardownCesiumWireOverlay(ntd.ov3d, ntd.finalPos);
      _teardownCesiumWireOverlay(ntd.ov2d, ntd.finalPos);
    }
    isDraggingRef.current = false;
    if (window._cesiumDebug) console.log(`[App:teardown] DONE isDragging=false t=${performance.now().toFixed(1)}`);
  }, [cesiumAllMapPos]);

  const cesiumOnDropWp = useCallback((segId, wi, pos) => {
    setSegWp(prev => { const w = [...(prev[segId] || [])]; if (w[wi]) w[wi] = snapFine(pos.x, pos.y, planZoom); return { ...prev, [segId]: w }; });
    setWpZ(prev => { const w = [...(prev[segId] || [])]; w[wi] = pos.z || 0; return { ...prev, [segId]: w }; });
  }, [planZoom]);
  const cesiumOnRemoveWp = useCallback((segId, wi) => {
    setSegWp(prev => { const w = [...(prev[segId] || [])]; w.splice(wi, 1); return { ...prev, [segId]: w }; });
    setWpZ(prev => { const w = [...(prev[segId] || [])]; w.splice(wi, 1); return { ...prev, [segId]: w }; });
  }, []);

  // ============================================================
  return (
    <div style={{ width: "100vw", height: "100vh", background: "#E2E8F0", position: "relative", overflow: "hidden", fontFamily: "'Segoe UI',sans-serif" }}>

      {/* ===== メニューバー ===== */}
      {(() => {
        const FIXED_WINS = [
          { id: 'diag',        label: '単線結線図' },
          { id: 'plan',        label: '平面図' },
          { id: 'elev',        label: '断面図' },
          { id: 'side',        label: '側面図' },
          { id: 'cab',         label: '3次元図' },
          { id: 'cesium3d',    label: 'CesiumJS 3D' },
          { id: 'cesium2d',    label: 'CesiumJS 2D' },
          { id: 'panelEditor', label: '配電盤エディタ' },
          { id: 'admin',       label: '管理ビュー' },
        ];
        const openWin = (id) => {
          zCounter.current++;
          setWinState(pr => ({ ...pr, [id]: { ...pr[id], hidden: false, minimized: false, z: zCounter.current } }));
        };
        const openSecWin = (id) => {
          zCounter.current++;
          setWinState(pr => ({ ...pr, [id]: { ...pr[id], hidden: false, minimized: false, z: zCounter.current } }));
        };
        const menuBtnStyle = (active) => ({
          background: active ? 'rgba(255,255,255,0.2)' : 'transparent',
          border: 'none', color: '#F8FAFC', fontSize: 11, padding: '0 10px', height: '100%',
          cursor: 'pointer', fontFamily: "'Segoe UI',sans-serif", borderRadius: 3,
        });
        const _menuCss = `.wanol-menubtn:hover { background: rgba(255,255,255,0.12) !important; } .wanol-menubtn:active { background: rgba(255,255,255,0.22) !important; }`;
        const dropStyle = { position: 'absolute', top: '100%', left: 0, background: '#1E293B',
          border: '1px solid #475569', borderRadius: 4, minWidth: 180, zIndex: 200000,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', padding: '4px 0' };
        const itemStyle = (visible) => ({
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
          fontSize: 11, color: visible ? '#F8FAFC' : '#94A3B8', cursor: 'pointer',
          background: 'transparent', border: 'none', width: '100%', textAlign: 'left',
          fontFamily: "'Segoe UI',sans-serif",
        });
        return (
          <div ref={menuRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 22,
            background: '#1E293B', display: 'flex', alignItems: 'center', zIndex: 100000,
            borderBottom: '1px solid #334155', userSelect: 'none' }}>
            <style>{_menuCss}</style>
            {/* ファイル */}
            <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center' }}>
              <button className="wanol-menubtn" style={menuBtnStyle(openMenu === 'file')} onClick={() => setOpenMenu(m => m === 'file' ? null : 'file')} onMouseEnter={() => { if (openMenu && openMenu !== 'file') setOpenMenu('file'); }}>ファイル</button>
              {openMenu === 'file' && (
                <div style={dropStyle}>
                  <div style={{ padding: '4px 12px', fontSize: 10, color: '#64748B' }}>（未実装）</div>
                </div>
              )}
            </div>
            {/* ウィンドウ */}
            <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center' }}>
              <button className="wanol-menubtn" style={menuBtnStyle(openMenu === 'win')} onClick={() => setOpenMenu(m => m === 'win' ? null : 'win')} onMouseEnter={() => { if (openMenu && openMenu !== 'win') setOpenMenu('win'); }}>ウィンドウ</button>
              {openMenu === 'win' && (
                <div style={dropStyle}>
                  {FIXED_WINS.map(({ id, label }) => {
                    const ws = winState[id];
                    const visible = ws && !ws.hidden;
                    return (
                      <button key={id} style={itemStyle(visible)} onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.08)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}
                        onClick={() => { if (visible) { setWinState(pr => ({ ...pr, [id]: { ...pr[id], hidden: true } })); } else { openWin(id); } setOpenMenu(null); }}>
                        <span style={{ width: 10, textAlign: 'center', fontSize: 10 }}>{visible ? '✓' : ''}</span>
                        {label}
                      </button>
                    );
                  })}
                  {(sections.length > 0 || hSections.length > 0) && <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />}
                  {sections.map(sec => {
                    const ws = winState[sec.id];
                    const visible = ws && !ws.hidden;
                    return (
                      <button key={sec.id} style={itemStyle(visible)} onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.08)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}
                        onClick={() => { if (visible) { setWinState(pr => ({ ...pr, [sec.id]: { ...pr[sec.id], hidden: true } })); } else { openSecWin(sec.id); } setOpenMenu(null); }}>
                        <span style={{ width: 10, fontSize: 10 }}>{visible ? '✓' : ''}</span>
                        矢視図 {sec.label}
                      </button>
                    );
                  })}
                  {hSections.map(hs => {
                    const ws = winState[hs.id];
                    const visible = ws && !ws.hidden;
                    return (
                      <button key={hs.id} style={itemStyle(visible)} onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.08)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}
                        onClick={() => { if (visible) { setWinState(pr => ({ ...pr, [hs.id]: { ...pr[hs.id], hidden: true } })); } else { openSecWin(hs.id); } setOpenMenu(null); }}>
                        <span style={{ width: 10, fontSize: 10 }}>{visible ? '✓' : ''}</span>
                        平面図 {hs.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {/* 表示 */}
            <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center' }}>
              <button className="wanol-menubtn" style={menuBtnStyle(openMenu === 'view')} onClick={() => setOpenMenu(m => m === 'view' ? null : 'view')} onMouseEnter={() => { if (openMenu && openMenu !== 'view') setOpenMenu('view'); }}>表示</button>
              {openMenu === 'view' && (
                <div style={dropStyle}>
                  <div style={{ padding: '4px 12px', fontSize: 10, color: '#64748B' }}>（未実装）</div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* wire距離ツールチップ（ホバー時） */}
      {wireTip && !wireTipLabels.length && (
        <div style={{ position: "fixed", left: wireTip.x + 14, top: wireTip.y - 10, background: "rgba(15,23,42,0.92)", color: "#F8FAFC", padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, pointerEvents: "none", zIndex: 99999, whiteSpace: "nowrap", boxShadow: "0 2px 6px rgba(0,0,0,0.35)", fontFamily: "'Segoe UI',sans-serif" }}>
          {/* 合計距離 */}
          <div>{wireTip.dist < 1000 ? `${wireTip.dist.toFixed(1)} m` : `${(wireTip.dist/1000).toFixed(3)} km`}</div>
          {/* wire body hover: 当該区間距離 */}
          {wireTip.segDist != null && (
            <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.8, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 2, marginTop: 1 }}>
              区間: {wireTip.segDist < 1000 ? `${wireTip.segDist.toFixed(1)} m` : `${(wireTip.segDist/1000).toFixed(3)} km`}
            </div>
          )}
          {/* fold点 hover: 前後区間距離 */}
          {wireTip.prevSegDist != null && (
            <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.8, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 2, marginTop: 1 }}>
              ←{wireTip.prevSegDist < 1000 ? `${wireTip.prevSegDist.toFixed(1)} m` : `${(wireTip.prevSegDist/1000).toFixed(3)} km`}
              {wireTip.nextSegDist > 0 && <> / {wireTip.nextSegDist < 1000 ? `${wireTip.nextSegDist.toFixed(1)} m` : `${(wireTip.nextSegDist/1000).toFixed(3)} km`}→</>}
            </div>
          )}
        </div>
      )}
      {/* ドラッグ中セグメント距離ラベル（wire近く） */}
      {wireTipLabels.map((l, i) => (
        <div key={i} style={{ position: "fixed", left: l.x, top: l.y, transform: "translate(-50%,-50%)", background: "rgba(15,23,42,0.88)", color: "#F8FAFC", padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 600, pointerEvents: "none", zIndex: 99999, whiteSpace: "nowrap", boxShadow: "0 2px 5px rgba(0,0,0,0.3)", fontFamily: "'Segoe UI',sans-serif" }}>
          {l.text}
        </div>
      ))}


      {/* hSec寸法バッジ: drag中はカーソル追従、mouseup後は最終位置に固定表示 */}
      {(hSecDrag || hSecActiveDim) && (() => {
        const _mppV = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
        const _id = hSecDrag?.id || hSecActiveDim?.id;
        const _liveZ = hSecLiveZRef.current[_id] ?? (hSections.find(h => h.id === _id)?.zPx ?? 0);
        const _allLvl = [
          { id: 'GL', label: 'GL', zPx: 0 },
          ...hSections.map(h => ({ id: h.id, label: h.label, zPx: hSecLiveZRef.current[h.id] ?? h.zPx }))
        ].sort((a, b) => a.zPx - b.zPx);
        const _pos = hSecDrag ? hSecDragClientPos.current : hSecActiveDimPos.current;
        // バッジはカーソル右に配置（矢印は辺上に描画されるため干渉しない）
        const _badgeLeft = _pos.x + 16;
        const _isEditAny = !!hSecEditDim;
        const _activeLabel = _allLvl.find(l => l.id === _id)?.label || '';
        // activeHSec以外の全レベル（GL含む）との距離を全て表示
        const _rows = _allLvl.filter(l => l.id !== _id).map((_ref, _ri) => {
          const _isAbove = _ref.zPx > _liveZ;
          const _lo = _isAbove ? { id: _id, label: _activeLabel, zPx: _liveZ } : _ref;
          const _hi = _isAbove ? _ref : { id: _id, label: _activeLabel, zPx: _liveZ };
          const _mm = Math.round(Math.abs(_ref.zPx - _liveZ) * _mppV * 1000);
          const _isEdit = !hSecDrag && hSecEditDim?.hSecId === _hi.id && hSecEditDim?.refId === _lo.id && _hi.id !== 'GL';
          return (
            <div key={_ri} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {_isEdit ? (
                <input autoFocus defaultValue={_mm}
                  style={{ width: 80, fontSize: 11, border: '1px solid #3B82F6', borderRadius: 3, padding: '1px 4px', outline: 'none', background: '#FFF', color: '#1E293B' }}
                  onMouseDown={ev => ev.stopPropagation()}
                  onClick={ev => ev.stopPropagation()}
                  onKeyDown={ev => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') {
                      const newMm = parseFloat(ev.target.value);
                      if (!isNaN(newMm) && newMm >= 0) {
                        const newZPx = _lo.zPx + newMm / 1000 / _mppV;
                        const newLabel = newZPx >= 0 ? `${Math.floor(newZPx / MAJOR) + 1}F` : `B${Math.ceil(-newZPx / MAJOR)}`;
                        setHSections(prev => prev.map(h => h.id === _hi.id ? { ...h, zPx: newZPx, label: newLabel } : h));
                      }
                      setHSecEditDim(null);
                    }
                    if (ev.key === 'Escape') setHSecEditDim(null);
                  }} />
              ) : (
                <span
                  style={{ cursor: (!hSecDrag && _hi.id !== 'GL') ? 'pointer' : 'default', textDecoration: (!hSecDrag && _hi.id !== 'GL') ? 'underline dotted' : 'none' }}
                  onMouseDown={ev => ev.stopPropagation()}
                  onClick={ev => { ev.stopPropagation(); if (!hSecDrag && _hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }}>
                  {_lo.label} ↔ {_hi.label}: {_mm.toLocaleString()} mm
                </span>
              )}
            </div>
          );
        });
        if (!_rows.length) return null;
        return (
          <div ref={hSecBadgeRef} onMouseDown={ev => ev.stopPropagation()} onClick={ev => ev.stopPropagation()}
            style={{ position: 'fixed', left: _badgeLeft, top: _pos.y - 8, zIndex: 99999, background: 'rgba(15,23,42,0.92)', color: '#F8FAFC', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.4)', fontFamily: "'Segoe UI',sans-serif", display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: hSecDrag ? 'none' : 'auto' }}>
            {_rows}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3, gap: 6 }}>
              {!hSecDrag && <div style={{ fontSize: 9, opacity: 0.6 }}>クリックで値を入力</div>}
              {hSecDrag && <div style={{ flex: 1 }} />}
              <button onMouseDown={ev => ev.stopPropagation()} onClick={ev => { ev.stopPropagation(); setHSecShowBand(prev => ({ ...prev, [_id]: !prev[_id] })); }}
                style={{ padding: '1px 6px', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 9, fontWeight: 600, background: hSecShowBand[_id] ? '#2563EB' : 'rgba(255,255,255,0.2)', color: '#FFF' }}>
                {hSecShowBand[_id] ? '▦ 厚みON' : '▦ 厚みOFF'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ===== 管理ビュー FloatWin ===== */}
      {(() => {
        // 凡例
        const _cell = (v) => {
          const bg = v === '○' ? '#16A34A' : v === '△' ? '#D97706' : v === '×' ? '#DC2626' : '#64748B';
          return <td style={{ textAlign: 'center', padding: '3px 6px', background: bg, color: '#FFF', fontWeight: 700, fontSize: 10, border: '1px solid rgba(255,255,255,0.15)' }}>{v}</td>;
        };
        const _th = (label, sub) => (
          <th style={{ padding: '3px 6px', fontSize: 9, fontWeight: 700, background: '#1E293B', color: '#F8FAFC', border: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap' }}>
            {label}{sub && <><br/><span style={{ fontWeight: 400, color: '#94A3B8' }}>{sub}</span></>}
          </th>
        );
        // 行ラベル（操作元）
        const _hlBg = (rowId) => {
          if (!adminHighlight || adminHighlight.row !== rowId) return undefined;
          return adminHighlight.phase === 'down' ? 'rgba(250,204,21,0.35)'
               : adminHighlight.phase === 'move' ? 'rgba(59,130,246,0.35)'
               : 'rgba(34,197,94,0.35)';
        };
        const _row = (rowId, label, sub, cells) => (
          <tr style={{ background: _hlBg(rowId) }}>
            <th style={{ padding: '3px 8px', fontSize: 9, fontWeight: 700, background: _hlBg(rowId) || '#1E293B', color: _hlBg(rowId) ? '#1E293B' : '#F8FAFC', border: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap', textAlign: 'left', transition: 'background 0.1s' }}>
              {label}{sub && <><br/><span style={{ fontWeight: 400, color: _hlBg(rowId) ? '#475569' : '#94A3B8' }}>{sub}</span></>}
            </th>
            {cells.map((v, i) => <React.Fragment key={i}>{_cell(v)}</React.Fragment>)}
          </tr>
        );
        return (
          <FloatWin id="admin" title="管理ビュー — ビュー間リアルタイムリンク表"
            winState={winState} setWinState={setWinState} bringFront={bringFront}>
            <div style={{ padding: 10, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
              <div style={{ fontSize: 9, color: '#64748B', marginBottom: 6 }}>
                行 = 操作元（アイコンドラッグ中の図）　列 = リアルタイム連動する連動先
                {adminHighlight && <span style={{ marginLeft: 8, padding: '1px 5px', borderRadius: 2, fontSize: 8, fontWeight: 700,
                  background: adminHighlight.phase === 'down' ? '#FBBF24' : adminHighlight.phase === 'move' ? '#3B82F6' : '#22C55E',
                  color: '#FFF' }}>
                  {adminHighlight.phase === 'down' ? '↓ mousedown' : adminHighlight.phase === 'move' ? '→ mousemove' : '↑ mouseup'}: {adminHighlight.row}
                </span>}
              </div>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 10 }}>
                <thead>
                  <tr>
                    {_th('操作元 \\ 連動先', '')}
                    {_th('平面図', 'X-Y')}
                    {_th('断面図', 'X-Z')}
                    {_th('側面図', 'Y-Z')}
                    {_th('矢視図', 'sec×N')}
                    {_th('3次元図', 'cab')}
                    {_th('平面図2F', 'hSec×N')}
                    {_th('単結', 'diag')}
                    {_th('Cesium', '3D')}
                    {_th('Cesium', '2D')}
                  </tr>
                </thead>
                <tbody>
                  {_row('plan', '平面図ドラッグ', 'mapDrag(plan)', ['−','○','○','○','○','○','−','○','○'])}
                  {_row('elev', '断面図ドラッグ', 'elevDrag', ['○','−','○','○','○','○','−','○','○'])}
                  {_row('side', '側面図ドラッグ', 'sideDrag', ['○','○','−','○','○','○','−','○','○'])}
                  {_row('sec', '矢視図ドラッグ', 'secNodeDrag×N', ['○','○','○','−','○','○','−','○','○'])}
                  {_row('cab', '3次元図ドラッグ', 'faceDirect/cab', ['○','○','○','○','−','○','−','×','×'])}
                  {_row('hSecDrag', '平面図2Fドラッグ', 'hSec内drag×N', ['×','×','×','×','×','−','−','×','×'])}
                  {_row('hSecInd', 'hSecインジケーター', 'ドラッグ(z変化)', ['×','○','○','○','○','○','−','×','×'])}
                  {_row('diag', '単結ドラッグ', 'diag内nodeDrag', ['×','×','×','×','×','×','−','×','×'])}
                </tbody>
              </table>
              <div style={{ marginTop: 10, display: 'flex', gap: 12, fontSize: 9 }}>
                <span><span style={{ background:'#16A34A', color:'#FFF', padding:'1px 5px', borderRadius:2 }}>○</span> 実装済み・動作確認</span>
                <span><span style={{ background:'#D97706', color:'#FFF', padding:'1px 5px', borderRadius:2 }}>△</span> 実装済み・動作未確認</span>
                <span><span style={{ background:'#DC2626', color:'#FFF', padding:'1px 5px', borderRadius:2 }}>×</span> 未実装</span>
                <span><span style={{ background:'#64748B', color:'#FFF', padding:'1px 5px', borderRadius:2 }}>−</span> 自身/無関係</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 9, color: '#94A3B8' }}>
                ※ Wire（ポリライン）の更新は各アイコンドラッグと同一パスのため省略。
                Wire単独変化（wpDrag等）は別途確認が必要。
              </div>
            </div>
          </FloatWin>
        );
      })()}

      {/* 配電盤エディタ */}
      <FloatWin id="panelEditor" title="配電盤エディタ"
        winState={winState} setWinState={setWinState} bringFront={bringFront}
        overflow="hidden">
        <iframe ref={panelEditorIframeRef} src="panel-editor.html" style={{ width: '100%', height: '100%', border: 'none', display: 'block', pointerEvents: draggingPanel ? 'none' : 'auto' }} />
      </FloatWin>

      {/* 配電盤D&Dゴースト */}
      {draggingPanel && draggingPanel.sx > 0 && (
        <div style={{ position: 'fixed', left: draggingPanel.sx + 14, top: draggingPanel.sy + 14, background: draggingPanel.panelData?.color || '#4A90D9', border: '2px solid #FFF', borderRadius: 4, padding: '3px 10px', color: '#FFF', fontSize: 11, fontWeight: 700, pointerEvents: 'none', zIndex: 99999, opacity: 0.9, whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
          📦 {draggingPanel.panelData?.name}
        </div>
      )}

      {/* ステータスバー */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "4px 10px", background: "rgba(30,41,59,0.9)", color: "#94A3B8", fontSize: 9, zIndex: 5, display: "flex", gap: 12, touchAction: "none" }}>
        <span>記号: {placedN}/{totalN}</span>
        {routeFilter && <span style={{ color: "#F59E0B" }}>ルート: {routeFilter}</span>}
        {selected.size > 0 && <span style={{ color: "#3B82F6" }}>{selected.size}個選択</span>}
        {currentSSE != null && <span style={{ color: "#A3E635" }}>SSE: {currentSSE.toFixed(1)}</span>}
        <span>単結で範囲選択→一括配置 / 右クリック=ルート選択</span>
      </div>

      {/* 単線結線図ウィンドウ */}
      <FloatWin id="diag" title={`単線結線図 x${diagZoom.toFixed(1)}`} winState={winState} setWinState={setWinState} bringFront={bringFront}>
        <div ref={dRef} style={{ position: "relative", width: diagW, height: diagH, touchAction: "none", zoom: diagZoom }}
          onMouseDown={e => {
            // 背景からの範囲選択開始
            if (e.target === dRef.current || e.target.tagName === "svg" || e.target.tagName === "line" || e.target.tagName === "circle") {
              const p = toP(dRef, e);
              setSelRect({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
            }
          }}>
          <svg width={diagW} height={diagH} style={{ position: "absolute", inset: 0 }}>
            {segs.map(seg => {
              const fn = nodeById[seg.from], tn = nodeById[seg.to]; if (!fn || !tn) return null;
              const isHL = hoverSeg === seg.id || hoverId === seg.from || hoverId === seg.to;
              const filt = routeSegs && !routeSegs.segIds.has(seg.id);
              return <line key={seg.id} x1={fn.dPos.x} y1={fn.dPos.y} x2={tn.dPos.x} y2={tn.dPos.y}
                stroke={isHL ? HL_COLOR : (filt ? "#CCC" : BASE_COLOR)} strokeWidth={seg.isBus ? (isHL ? 5 : 4) : (isHL ? 3 : 2)}
                opacity={filt ? 0.15 : (isHL ? 1 : 0.5)} style={{ transition: "stroke 0.15s, stroke-width 0.15s" }} />;
            })}
            {nodes.map(n => {
              const p = n.dPos;
              const isHover = hoverId === n.id;
              const isSegHover = hoverSeg && segs.some(s => s.id === hoverSeg && (s.from === n.id || s.to === n.id));
              const isWpDragHL = (wpDrag && segs.some(s => s.id === wpDrag.sid && (s.from === n.id || s.to === n.id))) ||
                (wpDragCab && segs.some(s => s.id === wpDragCab.sid && (s.from === n.id || s.to === n.id)));
              const isHL = isHover || isSegHover || isWpDragHL;
              const isSel = selected.has(n.id);
              const filt = routeSegs && !routeSegs.nodeIds.has(n.id);
              const fo = filt ? 0.15 : 1;
              const showCam = isHL && n.kind === "symbol" && allMapPos[n.id];
              if (n.kind === "symbol") return <g key={n.id} transform={`translate(${p.x - 9},${p.y - 9})`} opacity={fo}
                onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)} style={{ cursor: 'default' }}>
                {isSel && <rect x={-3} y={-3} width={22} height={22} fill="none" stroke={HL_COLOR} strokeWidth={2} strokeDasharray="3,2" rx={3} />}
                <Sym shape={n.shape} size={18} color={n.color} hl={isHL} />
                {showCam && <g onMouseDown={e => { e.stopPropagation(); e.preventDefault(); focusNode(n.id); }} style={{ cursor: 'pointer' }}>
                  <circle cx={20} cy={-4} r={7} fill="#3B82F6" opacity={0.92} />
                  <text x={20} y={-4} fontSize={9} textAnchor="middle" dominantBaseline="middle" style={{ pointerEvents: 'none', userSelect: 'none' }}>📷</text>
                </g>}
              </g>;
              if (n.kind === "free") return <g key={n.id}
                onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)}>
                <circle cx={p.x} cy={p.y} r={isHL ? 6 : 4} fill={isHL ? HL_COLOR : BASE_COLOR} opacity={fo} />
                {isSel && <circle cx={p.x} cy={p.y} r={8} fill="none" stroke={HL_COLOR} strokeWidth={1.5} strokeDasharray="3,2" />}
              </g>;
              return <g key={n.id}
                onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)}>
                <circle cx={p.x} cy={p.y} r={isHL ? 5 : 3} fill={isHL ? HL_COLOR : "#FFF"} stroke={isHL ? HL_COLOR : BASE_COLOR} strokeWidth={2} opacity={fo} />
                {isSel && <circle cx={p.x} cy={p.y} r={7} fill="none" stroke={HL_COLOR} strokeWidth={1.5} strokeDasharray="3,2" />}
              </g>;
            })}
            {/* 範囲選択矩形 */}
            {selRect && <rect x={Math.min(selRect.x1, selRect.x2)} y={Math.min(selRect.y1, selRect.y2)}
              width={Math.abs(selRect.x2 - selRect.x1)} height={Math.abs(selRect.y2 - selRect.y1)}
              fill="rgba(59,130,246,0.1)" stroke="#3B82F6" strokeWidth={1} strokeDasharray="4,2" />}
          </svg>
          {/* ノード個別ドラッグ（選択中は全体をドラッグ） */}
          {nodes.filter(n => n.kind !== "on_seg").map(n => (
            <div key={`ov${n.id}`} draggable
              onDragStart={e => {
                e.dataTransfer.setData("text/plain", n.id);
                // 選択されていたら選択ノード全体のドラッグ
                if (selected.size > 0 && !selected.has(n.id)) {
                  // 選択外のノードをドラッグ → 選択解除して単独
                  setSelected(new Set());
                }
              }}
              onTouchStart={e => { e.preventDefault(); setDiagDrag({ id: n.id }); }}
              onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)}
              onContextMenu={e => { e.preventDefault(); setRouteFilter(prev => prev === n.id ? null : n.id); }}
              style={{ position: "absolute", left: n.dPos.x - 10, top: n.dPos.y - 10, width: 20, height: 20, cursor: "grab", opacity: 0, touchAction: "none" }} />
          ))}
          {/* 選択数表示 */}
          {selected.size > 0 && <div style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(59,130,246,0.9)", color: "#FFF", borderRadius: 4, padding: "1px 6px", fontSize: 8, fontWeight: 600 }}>
            {selected.size}個選択中 — ドラッグで一括配置
          </div>}
        </div>
      </FloatWin>

      {/* 平面図ウィンドウ */}
      <FloatWin id="plan" title="平面図 (X-Y)" winState={winState} setWinState={setWinState} bringFront={bringFront} overflow="hidden"
        headerExtra={<>
          <button onClick={() => { setSecMode(m => !m); setSecDrawing(null); if (bldEditMode) { setBldEditMode(false); setSelectedBld(null); setBldDraw(null); setPolyPoints([]); setPolyMousePos(null); } }}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: secMode ? "#DC2626" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
            {secMode ? "✂ ON" : "✂ 矢視追加"}
          </button>
          <button onClick={() => { setBldEditMode(m => !m); setSelectedBld(null); setBldDraw(null); setPolyPoints([]); setPolyMousePos(null); if (secMode) { setSecMode(false); setSecDrawing(null); } }}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: bldEditMode ? "#2563EB" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
            {bldEditMode ? "🏗 ON" : "🏗 建屋"}
          </button>
          {winState.elev?.hidden && <button onClick={() => setWinState(pr => ({ ...pr, elev: { ...pr.elev, hidden: false } }))}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600, background: "rgba(255,255,255,0.15)", color: "#FFF" }}>
            断面図
          </button>}
          {winState.side?.hidden && <button onClick={() => setWinState(pr => ({ ...pr, side: { ...pr.side, hidden: false } }))}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600, background: "rgba(255,255,255,0.15)", color: "#FFF" }}>
            側面図
          </button>}
          <button onClick={() => { setWinState(pr => ({ ...pr, admin: { ...pr.admin, minimized: false, hidden: false } })); bringFront('admin'); }}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600, background: "rgba(255,255,255,0.15)", color: "#FFF" }}>
            📋 管理
          </button>
        </>}>
        <div style={{ display:'flex', flexDirection:'column', width:'100%', height:'100%' }}>
        {/* bldEditMode時のサブオプション */}
        {(bldEditMode || sections.length > 0) && <div style={{ padding: "3px 6px", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", display: "flex", gap: 4, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
          {bldEditMode && <>
            <button onClick={() => { setBldDrawMode('rect'); setPolyPoints([]); setPolyMousePos(null); setBldDrawView('plan'); }}
              style={{ padding: "3px 8px", border: "2px solid", borderColor: bldDrawMode === 'rect' && bldDrawView === 'plan' ? "#2563EB" : "transparent", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 700,
                background: bldDrawMode === 'rect' ? "#DBEAFE" : "#E2E8F0", color: bldDrawMode === 'rect' ? "#1D4ED8" : "#475569" }}>
              ▭ 矩形
            </button>
            <button onClick={() => { setBldDrawMode('poly'); setBldDraw(null); setBldDrawView('plan'); }}
              style={{ padding: "3px 8px", border: "2px solid", borderColor: bldDrawMode === 'poly' && bldDrawView === 'plan' ? "#2563EB" : "transparent", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 700,
                background: bldDrawMode === 'poly' ? "#DBEAFE" : "#E2E8F0", color: bldDrawMode === 'poly' ? "#1D4ED8" : "#475569" }}>
              ⬠ 多角形
            </button>
            <span style={{ fontSize: 8, color: "#94A3B8" }}>{bldDrawMode === 'rect' ? 'ドラッグで矩形作成' : 'クリックで頂点追加、ダブルクリックで確定'}</span>
          </>}
          {sections.length > 0 && <span style={{ fontSize: 8, color: "#94A3B8" }}>矢視: {sections.length}本</span>}
        </div>}
        {/* スクロール可能エリア + インジケーターのラッパー（position:relativeでインジケーターを固定） */}
        <div style={{ position:'relative', flex:1, overflow:'hidden', minHeight:0 }}>
        <div style={{ overflow:'auto', width:'100%', height:'100%' }}>
        <div style={{ padding: VIEW_PAD, display: 'inline-block', lineHeight: 0 }}
          onMouseDown={e => {
            if (e.button !== 0 || bldEditMode || secMode) return;
            const scrollEl = planRef.current?.parentElement?.parentElement;
            if (scrollEl) { e.preventDefault(); setViewPanDrag({ ref: planRef, scrollEl, startX: e.clientX, startY: e.clientY, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop }); }
          }}>
        <div ref={planRef}
          onDragOver={e => e.preventDefault()} onDrop={handleDrop("plan")}
          onAuxClick={e => e.preventDefault()}
          onMouseDown={e => {
            if (e.button === 1) {
              e.preventDefault();
              const _sc = planRef.current?.parentElement?.parentElement;
              const _ox = _sc ? (_sc.scrollLeft + _sc.clientWidth  / 2 - VIEW_PAD) / planZoom : TW / 2;
              const _oy = _sc ? (_sc.scrollTop  + _sc.clientHeight / 2 - VIEW_PAD) / planZoom : TH / 2;
              setPlanRotateOrigin({ x: _ox, y: _oy });
              setViewRotateDrag({ refId: 'plan', startX: e.clientX, startRotate: planRotate });
              return;
            }
            if (bldEditMode && bldDrawMode === 'rect' && bldDrawView === 'plan') {
              // 建屋エディタ: 背景クリックで矩形描画開始
              const target = e.target;
              // 建屋ポリゴン上のクリックは選択として処理されるので、背景のみ描画開始
              if (!target.getAttribute || !target.getAttribute("data-bld-rect")) {
                e.preventDefault();
                const p = toP(planRef, e);
                const sp = snap(p.x, p.y);
                setBldDraw({ startX: sp.x, startY: sp.y, curX: sp.x, curY: sp.y });
                setSelectedBld(null);
              }
            } else if (!bldEditMode && !secMode && e.button === 0) {
              // 通常モード: 背景ドラッグ=パン
              const target = e.target;
              const isBg = !target.getAttribute || (!target.getAttribute("data-bld-rect") && !target.getAttribute("data-node-id"));
              if (isBg) {
                const scrollEl = planRef.current?.parentElement?.parentElement;
                if (scrollEl) {
                  e.preventDefault();
                  setViewPanDrag({ ref: planRef, scrollEl, startX: e.clientX, startY: e.clientY, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop });
                }
              }
            }
          }}
          onClick={e => {
            if (secMode) {
              e.preventDefault();
              const _raw = toP(planRef, e);
              const p = snap(_raw.x, _raw.y);
              if (!secDrawing) {
                setSecDrawing({ phase: 1, p1: p, cur: p });
              } else if (secDrawing.phase === 1) {
                const r = rectOf(secDrawing.p1, secDrawing.cur);
                if (r.x2 - r.x1 >= MINOR && r.y2 - r.y1 >= MINOR)
                  setSecDrawing({ phase: 2, p1: secDrawing.p1, p2: secDrawing.cur, cur: p });
              } else if (secDrawing.phase === 2) {
                const _pnRadNow = plantNorthAngleRef.current * Math.PI / 180;
                const edge = nearestEdgeOBB(secDrawing.p1, secDrawing.p2, secDrawing.cur, _pnRadNow);
                finishSection(secDrawing.p1, secDrawing.p2, edge);
                setSecDrawing(null);
              }
              return;
            }
            if (bldEditMode && bldDrawMode === 'poly' && bldDrawView === 'plan') {
              const target = e.target;
              if (target.getAttribute && target.getAttribute("data-bld-rect")) return;
              const p = toP(planRef, e);
              const sp = snap(p.x, p.y);
              // Check if clicking near first point to close polygon
              if (polyPoints.length >= 3) {
                const dx = sp.x - polyPoints[0].x, dy = sp.y - polyPoints[0].y;
                if (Math.sqrt(dx * dx + dy * dy) < MINOR * 2) {
                  // Close polygon and create building
                  bldCounter.current++;
                  const newId = `bld${bldCounter.current}`;
                  const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
                  setBuildings(prev => [...prev, {
                    id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
                    blocks: [{ points: [...polyPoints], zBottom: 0, zTop: 40 }],
                  }]);
                  setPolyPoints([]);
                  setPolyMousePos(null);
                  setSelectedBld(newId);
                  return;
                }
              }
              setPolyPoints(prev => [...prev, sp]);
            }
          }}
          onDoubleClick={e => {
            if (bldEditMode && bldDrawMode === 'poly' && bldDrawView === 'plan' && polyPoints.length >= 3) {
              e.preventDefault();
              // Close polygon and create building
              bldCounter.current++;
              const newId = `bld${bldCounter.current}`;
              const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
              setBuildings(prev => [...prev, {
                id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
                blocks: [{ points: [...polyPoints], zBottom: 0, zTop: 40 }],
              }]);
              setPolyPoints([]);
              setPolyMousePos(null);
              setSelectedBld(newId);
            }
          }}
          onContextMenu={e => {
            if (bldEditMode && bldDrawMode === 'poly' && bldDrawView === 'plan' && polyPoints.length > 0) {
              e.preventDefault();
              setPolyPoints([]);
              setPolyMousePos(null);
            }
          }}
          onMouseMove={e => {
            if (bldAction && bldAction.type === 'move') {
              const p = toP(planRef, e);
              const dx = snapV(p.x - bldAction.startX);
              const dy = snapV(p.y - bldAction.startY);
              setBuildings(prev => prev.map(b => b.id === bldAction.bid ? {
                ...b, blocks: bldAction.origBlocks.map(blk => ({
                  ...blk, points: blk.points.map(pt => ({x: pt.x + dx, y: pt.y + dy}))
                }))
              } : b));
            } else if (secMode && secDrawing) {
              const _p = toP(planRef, e);
              setSecDrawing(prev => ({ ...prev, cur: snap(_p.x, _p.y) }));
            } else if (bldDraw && !bldDraw.view) {
              const p = toP(planRef, e);
              const sp = snap(p.x, p.y);
              setBldDraw(prev => prev ? { ...prev, curX: sp.x, curY: sp.y } : null);
            } else if (bldEditMode && bldDrawMode === 'poly' && bldDrawView === 'plan' && polyPoints.length > 0) {
              const p = toP(planRef, e);
              const sp = snap(p.x, p.y);
              setPolyMousePos(sp);
            }
          }}
          onMouseUp={e => {
            if (bldAction) { setBldAction(null); return; }
            if (bldDraw && !bldDraw.view) {
              const x1 = Math.min(bldDraw.startX, bldDraw.curX), x2 = Math.max(bldDraw.startX, bldDraw.curX);
              const y1 = Math.min(bldDraw.startY, bldDraw.curY), y2 = Math.max(bldDraw.startY, bldDraw.curY);
              if (Math.abs(x2 - x1) >= MINOR && Math.abs(y2 - y1) >= MINOR) {
                const points = [
                  {x: x1, y: y1}, {x: x2, y: y1}, {x: x2, y: y2}, {x: x1, y: y2}
                ];
                bldCounter.current++;
                const newId = `bld${bldCounter.current}`;
                const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
                setBuildings(prev => [...prev, {
                  id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
                  blocks: [{ points, zBottom: 0, zTop: 40 }],
                }]);
                setSelectedBld(newId);
              }
              setBldDraw(null);
            }
          }}
          style={{ position: "relative", width: TW, height: TH, background: "#FAFAFA", touchAction: "none", cursor: secMode ? "crosshair" : bldEditMode ? "crosshair" : viewRotateDrag?.refId === 'plan' ? "grabbing" : viewPanDrag?.ref === planRef ? "grabbing" : "grab", flex: 1, zoom: planZoom, transform: `rotate(${planRotate}deg)`, transformOrigin: `${planRotateOrigin.x}px ${planRotateOrigin.y}px` }}>
          <svg style={{ position: "absolute", inset: 0, width: TW, height: TH, pointerEvents: "none" }}>
            {(() => { const _pz = planZoom || 1; const ls = []; for (let x = 0; x <= TW; x += MAJOR) ls.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={TH} stroke="rgba(0,0,0,0.07)" strokeWidth={0.8/_pz} />); for (let y = 0; y <= TH; y += MAJOR) ls.push(<line key={`h${y}`} x1={0} y1={y} x2={TW} y2={y} stroke="rgba(0,0,0,0.07)" strokeWidth={0.8/_pz} />); return ls; })()}
            {/* フィールド全体外枠（水色）- 2D/3Dマップと対応 */}
            <rect x={0} y={0} width={TW} height={TH} fill="none" stroke="rgba(6,182,212,0.75)" strokeWidth={2} />
            {/* フィールドポリゴン境界 */}
            {FIELD_POLY_GRID && (
              <polygon
                points={FIELD_POLY_GRID.map(p => `${p.x},${p.y}`).join(' ')}
                fill="rgba(255,220,50,0.08)" stroke="#EAB308" strokeWidth={2}
              />
            )}
            {(() => {
              // 建屋ごとにグループ化して一体表示
              const bldGroups = {};
              flatBlocks.forEach((b, i) => {
                if (!bldGroups[b.buildingId]) bldGroups[b.buildingId] = [];
                bldGroups[b.buildingId].push({ ...b, _idx: i });
              });
              return Object.entries(bldGroups).map(([bid, blocks]) => {
                const isSel = bldEditMode && selectedBld === bid;
                const bld = buildings.find(bb => bb.id === bid);
                // 全ブロックの中心
                const allPts = blocks.flatMap(b => b.points);
                const cx = allPts.reduce((s, p) => s + p.x, 0) / allPts.length;
                const cy = allPts.reduce((s, p) => s + p.y, 0) / allPts.length;
                // 全ブロックの combined path (fill-rule: nonzero で一体表示)
                const pathD = blocks.map(b => {
                  const pts = b.points;
                  return `M${pts[0].x},${pts[0].y}` + pts.slice(1).map(p => `L${p.x},${p.y}`).join("") + "Z";
                }).join(" ");
                const _isBldSel = (bldEditMode ? selectedBld : hovBldId) === bid || (!bldEditMode && selectedBld === bid);
                return <g key={bid}
                  onMouseEnter={() => { if (!bldEditMode) { setHovBldId(bid); setHovBldView('plan'); } }}
                  onMouseLeave={() => { if (!bldEditMode) { setHovBldId(null); setHovBldView(null); } }}
                  onMouseDown={(ev) => {
                    if (ev.target.getAttribute && ev.target.getAttribute("data-edge-handle")) return;
                    if (bldEditMode) {
                      ev.stopPropagation();
                      setSelectedBld(bid);
                      const p = toP(planRef, ev);
                      setBldAction({type:'move', bid, startX:p.x, startY:p.y,
                        origBlocks: JSON.parse(JSON.stringify(bld.blocks))});
                    } else {
                      // 非editモード: クリックで選択、再クリックで解除
                      ev.stopPropagation();
                      const _nsel = selectedBld === bid ? null : bid;
                      setSelectedBld(_nsel);
                      setSelectedBldView(_nsel ? 'plan' : null);
                    }
                  }}
                  style={{ cursor: "pointer", pointerEvents: "auto" }}>
                  {/* 一体化した塗り（stroke無し → 内部壁が消える） */}
                  <path data-bld-rect="1" d={pathD} fill={blocks[0].color} opacity={isSel ? 0.35 : 0.18} fillRule="nonzero" stroke="none" />
                  {/* 各ブロックの外周線（共有辺を除外） */}
                  {blocks.map((b, bi) => {
                    const pts = b.points;
                    const edges = [];
                    for (let j = 0; j < pts.length; j++) {
                      const p1 = pts[j], p2 = pts[(j + 1) % pts.length];
                      // この辺が他のブロックと共有されているか確認
                      const isShared = blocks.some((ob, obi) => {
                        if (obi === bi) return false;
                        const oPts = ob.points;
                        for (let k = 0; k < oPts.length; k++) {
                          const q1 = oPts[k], q2 = oPts[(k + 1) % oPts.length];
                          // 同一線分（逆向き含む）でオーバーラップがあるか
                          if (Math.abs(p1.x - p2.x) < 1 && Math.abs(q1.x - q2.x) < 1 && Math.abs(p1.x - q1.x) < 1) {
                            const a1 = Math.min(p1.y, p2.y), a2 = Math.max(p1.y, p2.y);
                            const b1 = Math.min(q1.y, q2.y), b2 = Math.max(q1.y, q2.y);
                            if (a1 < b2 && b1 < a2) return true;
                          }
                          if (Math.abs(p1.y - p2.y) < 1 && Math.abs(q1.y - q2.y) < 1 && Math.abs(p1.y - q1.y) < 1) {
                            const a1 = Math.min(p1.x, p2.x), a2 = Math.max(p1.x, p2.x);
                            const b1 = Math.min(q1.x, q2.x), b2 = Math.max(q1.x, q2.x);
                            if (a1 < b2 && b1 < a2) return true;
                          }
                        }
                        return false;
                      });
                      if (!isShared) edges.push({ p1, p2 });
                    }
                    return edges.map((e, ei) => <line key={`${bi}-${ei}`} x1={e.p1.x} y1={e.p1.y} x2={e.p2.x} y2={e.p2.y}
                      stroke={isSel ? "#3B82F6" : b.color} strokeWidth={isSel ? 2 : 1} pointerEvents="none" />);
                  })}
                  <text x={cx} y={cy + 4} textAnchor="middle" fontSize={8} fontWeight={700} fill="#475569" opacity={0.5} pointerEvents="none">{blocks[0].label}</text>
                  {bldEditMode && <text x={cx} y={cy + 14} textAnchor="middle" fontSize={7} fill="#94A3B8" pointerEvents="none">{blocks[0].zBottom}~{blocks[0].zTop}</text>}
                  {/* 頂点ラベル (a, b, c, ...) — 箱の外側にオフセット */}
                  {blocks.filter(b2 => !b2._sharedWall).map((b2, bi2) => {
                    const vp = b2.points;
                    if (!vp || vp.length < 3) return null;
                    const vcx = vp.reduce((s,p)=>s+p.x,0)/vp.length;
                    const vcy = vp.reduce((s,p)=>s+p.y,0)/vp.length;
                    const VOFF = 12;
                    return vp.map((pt, vi) => {
                      const dx = pt.x - vcx, dy = pt.y - vcy;
                      const d = Math.sqrt(dx*dx + dy*dy);
                      const ox = d > 0.1 ? pt.x + dx/d*VOFF : pt.x;
                      const oy = d > 0.1 ? pt.y + dy/d*VOFF : pt.y;
                      return <text key={`vl${bi2}_${vi}`} x={ox} y={oy+3} textAnchor="middle" fontSize={7} fontWeight={600} fill="#334155" opacity={0.7} pointerEvents="none">{String.fromCharCode(97+vi)}</text>;
                    });
                  })}
                  {/* 平面図: 辺ハンドル（中央掴み=辺全体移動、端掴み=部分押し出し）+ 頂点ハンドル */}
                  {isSel && blocks.map((b, bi) => {
                    const pts = b.points;
                    const n = pts.length;
                    return <g key={`h${bi}`}>
                      {/* 辺ハンドル */}
                      {pts.map((ep1, ej) => {
                        const ep2 = pts[(ej + 1) % n];
                        const eIsVert = Math.abs(ep2.x - ep1.x) < Math.abs(ep2.y - ep1.y);
                        return <line key={`e${ej}`} data-edge-handle="1"
                          x1={ep1.x} y1={ep1.y} x2={ep2.x} y2={ep2.y}
                          stroke="#3B82F6" strokeWidth={6} opacity={0.3}
                          style={{cursor: eIsVert ? "ew-resize" : "ns-resize", pointerEvents:"auto"}}
                          onMouseDown={ev => {
                            ev.stopPropagation(); ev.preventDefault();
                            const mp = toP(planRef, ev);
                            const edx = ep2.x - ep1.x, edy = ep2.y - ep1.y;
                            const elen = Math.sqrt(edx*edx + edy*edy);
                            const et = elen > 0 ? Math.max(0.05, Math.min(0.95, ((mp.x-ep1.x)*edx + (mp.y-ep1.y)*edy) / (elen*elen))) : 0.5;
                            // 辺の任意位置から部分押し出し
                            setBldAction({type:'extrude', bid, bi:b.blockIdx,
                              edgeIdx: ej, splitT: et,
                              side: et < 0.5 ? 'start' : 'end',
                              startMouse: eIsVert ? ev.clientX : ev.clientY,
                              origPoints: pts.map(p=>({...p})), view:'plan'});
                          }}
                        />;
                      })}
                      {/* 頂点ハンドル */}
                      {pts.map((vp, vj) => (
                        <circle key={`v${vj}`} data-edge-handle="1" cx={vp.x} cy={vp.y} r={4}
                          fill="#3B82F6" stroke="#FFF" strokeWidth={1.5}
                          style={{cursor: "move", pointerEvents: "auto"}}
                          onMouseDown={ev => {
                            ev.stopPropagation(); ev.preventDefault();
                            setBldAction({type:'vertex', bid, bi:b.blockIdx,
                              vertIdx: vj, startMouse: {x: ev.clientX, y: ev.clientY},
                              origPoints: pts.map(p=>({...p})), view:'plan'});
                          }}
                        />
                      ))}
                    </g>;
                  })}
                  {/* 建屋選択バッジはSVG外のHTMLオーバーレイで描画 */}
                </g>;
              });
            })()}
            {/* 矢視: 確定済み矩形+矢印 */}
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#DC2626" />
              </marker>
              <marker id="arrowhead-blue" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#6366F1" />
              </marker>
              <marker id="arrowhead-k" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#1a1a1a" />
              </marker>
            </defs>
            {sections.map(_sec => {
              // p1/p2があれば現在のPN角度でOBBを再計算
              let sec = _sec;
              if (_sec.p1 && _sec.p2) {
                const _curPnRad = plantNorthAngle * Math.PI / 180;
                const { cx, cy, halfA: hA, halfB: hB } = obbFromP1P2(_sec.p1, _sec.p2, _curPnRad);
                sec = { ..._sec, center: { x: cx, y: cy }, halfA: hA, halfB: hB, pnRad: _curPnRad };
              }
              if (sec.center !== undefined) {
                // OBB: PN/X軸に揃った回転矩形
                const corners = obbCorners(sec.center.x, sec.center.y, sec.halfA, sec.halfB, sec.pnRad);
                const pts = corners.map(([x, y]) => `${x},${y}`).join(' ');
                // コの字: viewEdge辺の2コーナーから辺沿いに内向き矢印
                const _ei = edgeInfoSec(sec, sec.viewEdge);
                const _cc = Math.cos(sec.pnRad), _ss = Math.sin(sec.pnRad);
                const _edgeLen = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom') ? sec.halfA * 2 : sec.halfB * 2;
                const AL = Math.max(10, _edgeLen * 0.2);
                const _koC = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom')
                  ? [[_ei.mid.x - sec.halfA*_cc, _ei.mid.y - sec.halfA*_ss],
                     [_ei.mid.x + sec.halfA*_cc, _ei.mid.y + sec.halfA*_ss]]
                  : [[_ei.mid.x + sec.halfB*_ss, _ei.mid.y - sec.halfB*_cc],
                     [_ei.mid.x - sec.halfB*_ss, _ei.mid.y + sec.halfB*_cc]];
                return (
                  <g key={sec.id}>
                    <polygon points={pts} fill="rgba(128,128,128,0.12)" stroke="#1a1a1a" strokeWidth={0.5} />
                    {/* コの字ベース（2コーナーを結ぶ線） */}
                    <line x1={_koC[0][0]} y1={_koC[0][1]} x2={_koC[1][0]} y2={_koC[1][1]}
                      stroke="#1a1a1a" strokeWidth={1.5} />
                    {/* コの字アーム（先端矢印付き） */}
                    {_koC.map(([x, y], i) => (
                      <line key={i} x1={x} y1={y}
                        x2={x + _ei.nx*AL} y2={y + _ei.ny*AL}
                        stroke="#1a1a1a" strokeWidth={1.5} markerEnd="url(#arrowhead-k)" />
                    ))}
                    <text x={corners[3][0] + 3} y={corners[3][1] + 10} fontSize={8} fontWeight={700} fill="#555">
                      {sec.id.replace("sec", "S-")}
                    </text>
                  </g>
                );
              }
              const r = sec.rect;
              // コの字: viewEdge辺の2コーナーから辺沿いに内向き矢印
              const _ei = edgeInfo(r, sec.viewEdge);
              const _edgeLen2 = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom') ? (r.x2 - r.x1) : (r.y2 - r.y1);
              const AL = Math.max(10, _edgeLen2 * 0.2);
              const _koC = sec.viewEdge === 'top'    ? [[r.x1,r.y1],[r.x2,r.y1]]
                         : sec.viewEdge === 'bottom' ? [[r.x1,r.y2],[r.x2,r.y2]]
                         : sec.viewEdge === 'left'   ? [[r.x1,r.y1],[r.x1,r.y2]]
                         :                            [[r.x2,r.y1],[r.x2,r.y2]];
              return (
                <g key={sec.id}>
                  <rect x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1}
                    fill="rgba(128,128,128,0.12)" stroke="#1a1a1a" strokeWidth={0.5} />
                  {/* コの字ベース（2コーナーを結ぶ線） */}
                  <line x1={_koC[0][0]} y1={_koC[0][1]} x2={_koC[1][0]} y2={_koC[1][1]}
                    stroke="#1a1a1a" strokeWidth={1.5} />
                  {/* コの字アーム（先端矢印付き） */}
                  {_koC.map(([x, y], i) => (
                    <line key={i} x1={x} y1={y}
                      x2={x + _ei.nx*AL} y2={y + _ei.ny*AL}
                      stroke="#1a1a1a" strokeWidth={1.5} markerEnd="url(#arrowhead-k)" />
                  ))}
                  <text x={r.x1 + 3} y={r.y1 + 10} fontSize={8} fontWeight={700} fill="#555">
                    {sec.id.replace("sec", "S-")}
                  </text>
                </g>
              );
            })}
            {/* 水平断面インジケーター（平面図: 対象z高さを含む建屋をハイライト） */}
            {hSections.map((hs, _hi) => {
              // clipSecがある場合はそのOBB内の建屋のみ対象
              const blds_z = flatBlocks.filter(b => (b.zBottom||0) <= hs.zPx && hs.zPx <= b.zTop);
              const blds_clip = hs.clipSec ? blds_z.filter(b => {
                const cs = hs.clipSec;
                if (cs.center !== undefined) {
                  const { center: { x: cx, y: cy }, halfA, halfB, pnRad } = cs;
                  const cP = Math.cos(pnRad), sP = Math.sin(pnRad);
                  const bpts = b.points || [];
                  return bpts.some(p => {
                    const dx = p.x - cx, dy = p.y - cy;
                    const pA = dx * cP + dy * sP, pB = dx * sP - dy * cP;
                    return Math.abs(pA) <= halfA && Math.abs(pB) <= halfB;
                  });
                }
                if (cs.rect) {
                  const { x1, y1, x2, y2 } = cs.rect;
                  return (b.pxMinX||0) < x2 && (b.pxMaxX||0) > x1 && (b.pxMinY||0) < y2 && (b.pxMaxY||0) > y1;
                }
                return true;
              }) : blds_z;
              if (blds_clip.length === 0 && hs.clipSec) return null;
              return (
                <g key={`hpi-${hs.id}`} pointerEvents="none">
                  {blds_clip.map((b, i) => (
                    <polygon key={i} points={(b.points||[]).map(p=>`${p.x},${p.y}`).join(' ')}
                      fill="rgba(128,128,128,0.12)" stroke="#1a1a1a" strokeWidth={1/planZoom} />
                  ))}
                  <text x={8/planZoom} y={(10 + _hi * 12)/planZoom}
                    fontSize={8/planZoom} fill="#1a1a1a" fontWeight={700}>⊟ {hs.label}</text>
                </g>
              );
            })}
            {/* 描画中プレビュー（phase1: 回転矩形ゴースト / phase2: 確定矩形+矢印） */}
            {secDrawing?.phase === 1 && (() => {
              const _pnR = plantNorthAngleRef.current * Math.PI / 180;
              const { cx, cy, halfA, halfB } = obbFromP1P2(secDrawing.p1, secDrawing.cur, _pnR);
              const corners = obbCorners(cx, cy, halfA, halfB, _pnR);
              const pts = corners.map(([x, y]) => `${x},${y}`).join(' ');
              return <polygon points={pts}
                fill="rgba(99,102,241,0.08)" stroke="#6366F1" strokeWidth={1.5} strokeDasharray="5,3" />;
            })()}
            {secDrawing?.phase === 2 && (() => {
              const _pnR = plantNorthAngleRef.current * Math.PI / 180;
              const { cx, cy, halfA, halfB } = obbFromP1P2(secDrawing.p1, secDrawing.p2, _pnR);
              const corners = obbCorners(cx, cy, halfA, halfB, _pnR);
              const pts = corners.map(([x, y]) => `${x},${y}`).join(' ');
              const edge = nearestEdgeOBB(secDrawing.p1, secDrawing.p2, secDrawing.cur, _pnR);
              const _tmpSec = { center: { x: cx, y: cy }, halfA, halfB, pnRad: _pnR, viewEdge: edge };
              const ei = edgeInfoSec(_tmpSec, edge);
              const _eLP = (edge === 'top' || edge === 'bottom') ? halfA * 2 : halfB * 2;
              const AL = Math.max(10, _eLP * 0.2);
              const _cc = Math.cos(_pnR), _ss = Math.sin(_pnR);
              const _koC = (edge === 'top' || edge === 'bottom')
                ? [[ei.mid.x - halfA*_cc, ei.mid.y - halfA*_ss],
                   [ei.mid.x + halfA*_cc, ei.mid.y + halfA*_ss]]
                : [[ei.mid.x + halfB*_ss, ei.mid.y - halfB*_cc],
                   [ei.mid.x - halfB*_ss, ei.mid.y + halfB*_cc]];
              return <>
                <polygon points={pts} fill="rgba(128,128,128,0.12)" stroke="#1a1a1a" strokeWidth={0.5} />
                <line x1={_koC[0][0]} y1={_koC[0][1]} x2={_koC[1][0]} y2={_koC[1][1]}
                  stroke="#1a1a1a" strokeWidth={1.5} />
                {_koC.map(([x, y], i) => (
                  <line key={i} x1={x} y1={y}
                    x2={x + ei.nx*AL} y2={y + ei.ny*AL}
                    stroke="#1a1a1a" strokeWidth={1.5} markerEnd="url(#arrowhead-k)" />
                ))}
              </>;
            })()}
          </svg>
          {/* カメラ目線表示（ドラッグ可能・別レイヤー） */}
          <svg style={{ position: "absolute", inset: 0, width: TW, height: TH, zIndex: 4, pointerEvents: "none" }}>
            {(() => {
              const _pz = planZoom || 1;
              // 旧: unproj(=unproject3D) は真横視点(sinE≈0)でNaNを返し、SVG座標が全滅していた
              const lookAt = cabScreenToGroundPoint(CAB_W / 2, CAB_H / 2, camAz, camEl, camZoom, camPanX, camPanY);
              const lx = Math.max(20, Math.min(TW - 20, lookAt.x));
              const ly = Math.max(20, Math.min(TH - 20, lookAt.y));
              const R = 50 / _pz;
              const edx = -Math.sin(camAz), edy = Math.cos(camAz);
              const ex = lx + edx * R, ey = ly + edy * R;
              const fov = 0.5, coneR = 30 / _pz;
              const lookAng = Math.atan2(ly - ey, lx - ex);
              const a1 = lookAng - fov, a2 = lookAng + fov;
              const isDragging = camDrag && camDrag.view === "plan";
              return (
                <g opacity={isDragging ? 0.9 : 0.55}>
                  <circle cx={lx} cy={ly} r={3 / _pz} fill="none" stroke="#6366F1" strokeWidth={1 / _pz} strokeDasharray={`${2/_pz},${2/_pz}`} />
                  <line x1={lx - 6/_pz} y1={ly} x2={lx + 6/_pz} y2={ly} stroke="#6366F1" strokeWidth={0.8 / _pz} />
                  <line x1={lx} y1={ly - 6/_pz} x2={lx} y2={ly + 6/_pz} stroke="#6366F1" strokeWidth={0.8 / _pz} />
                  <line x1={lx} y1={ly} x2={ex} y2={ey} stroke="#6366F1" strokeWidth={1 / _pz} strokeDasharray={`${3/_pz},${3/_pz}`} opacity={0.4} />
                  <path d={`M${ex},${ey} L${ex + Math.cos(a1) * coneR},${ey + Math.sin(a1) * coneR} A${coneR},${coneR} 0 0,1 ${ex + Math.cos(a2) * coneR},${ey + Math.sin(a2) * coneR} Z`}
                    fill="rgba(99,102,241,0.15)" stroke="rgba(99,102,241,0.4)" strokeWidth={1 / _pz} />
                  <circle cx={ex} cy={ey} r={14 / _pz} fill="transparent" style={{ cursor: "grab", pointerEvents: "auto" }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setCamDrag({ view: "plan", lookAt: { x: lx, y: ly } }); }}
                    onTouchStart={e => { e.preventDefault(); e.stopPropagation(); setCamDrag({ view: "plan", lookAt: { x: lx, y: ly } }); }} />
                  <circle cx={ex} cy={ey} r={6 / _pz} fill={isDragging ? "#4F46E5" : "#6366F1"} stroke="#FFF" strokeWidth={1.5 / _pz} pointerEvents="none" />
                  <circle cx={ex} cy={ey} r={2.5 / _pz} fill="#FFF" pointerEvents="none" />
                  <text x={ex + (edx > 0 ? 10/_pz : -10/_pz)} y={ey + (edy > 0 ? -8/_pz : 12/_pz)}
                    textAnchor={edx > 0 ? "start" : "end"} fontSize={7 / _pz} fontWeight={600} fill="#6366F1" pointerEvents="none">CAM</text>
                </g>
              );
            })()}
          </svg>
          <svg style={{ position: "absolute", inset: 0, width: TW, height: TH, zIndex: 5, pointerEvents: secMode ? "none" : "none" }}>
            {/* PN/X軸スナップライン（wpDrag or mapDrag 平面図ドラッグ中） */}
            {(wpDrag?.view === "plan" || mapDrag?.view === "plan") && (() => {
              const snapRef = wpDrag?.view === "plan" ? planWpSnapRef : planIconSnapRef;
              const _pnRad = plantNorthAngle * Math.PI / 180;
              const cosPn = Math.cos(_pnRad), sinPn = Math.sin(_pnRad);
              const T = TW + TH;
              return Object.entries(allMapPos).map(([nid, np]) => {
                const si = snapRef.current;
                const isPN = si?.iconId === nid && si?.type !== "x";
                const isX  = si?.iconId === nid && si?.type !== "pn";
                return [
                  <line key={`pn${nid}`} pointerEvents="none"
                    x1={np.x - T*sinPn} y1={np.y + T*cosPn} x2={np.x + T*sinPn} y2={np.y - T*cosPn}
                    stroke={isPN ? "#3B82F6" : "rgba(59,130,246,0.25)"}
                    strokeWidth={isPN ? 1 : 0.7}
                    strokeDasharray={isPN ? "none" : "4,3"} />,
                  <line key={`xn${nid}`} pointerEvents="none"
                    x1={np.x - T*cosPn} y1={np.y - T*sinPn} x2={np.x + T*cosPn} y2={np.y + T*sinPn}
                    stroke={isX ? "#3B82F6" : "rgba(59,130,246,0.25)"}
                    strokeWidth={isX ? 1 : 0.7}
                    strokeDasharray={isX ? "none" : "4,3"} />,
                ];
              });
            })()}
            {/* wpDrag平面図直角マーク */}
            {wpDrag?.view === "plan" && wpPerpPlanRef.current?.map((m, i) => {
              const { svgX, svgY, dAx, dAy, dBx, dBy } = m;
              const sz = 14 / (planZoom || 1);
              const P1=[svgX-dAx*sz, svgY-dAy*sz], P2=[svgX-dAx*sz+dBx*sz, svgY-dAy*sz+dBy*sz], P3=[svgX+dBx*sz, svgY+dBy*sz];
              return <path key={i} d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                fill="none" stroke="#3B82F6" strokeWidth={1.5/(planZoom||1)} pointerEvents="none" />;
            })}
            {/* mapDrag平面図直角マーク */}
            {mapDrag?.view === "plan" && iconPerpSnapRef.current && (() => {
              const { svgX, svgY, dAx, dAy, dBx, dBy } = iconPerpSnapRef.current;
              const sz = 14 / (planZoom || 1);
              const P1=[svgX-dAx*sz, svgY-dAy*sz], P2=[svgX-dAx*sz+dBx*sz, svgY-dAy*sz+dBy*sz], P3=[svgX+dBx*sz, svgY+dBy*sz];
              return <path d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                fill="none" stroke="#3B82F6" strokeWidth={1.5/(planZoom||1)} pointerEvents="none" />;
            })()}
            {/* wire ライン（アイコンより前=下）: fold point は後のSVGで上に出す */}
            <g style={{ pointerEvents: secMode ? "none" : "auto" }}>{renderSegs("plan", planRef, p => p, { wireOnly: true })}</g>
          </svg>
          {renderNodes("plan", planRef)}
          <svg style={{ position: "absolute", inset: 0, width: TW, height: TH, overflow: "visible", zIndex: 15, pointerEvents: "none" }}>
            {/* fold point のみ（アイコンより前面=高zIndex）: SVGコンテナはnone、circle自身はall */}
            <g>{renderSegs("plan", planRef, p => p, { wpOnly: true })}</g>
          </svg>
          {/* 建屋ドラッグ中のゴースト矩形（rect mode） */}
          {bldDraw && !bldDraw.view && (() => {
            const x1 = Math.min(bldDraw.startX, bldDraw.curX), x2 = Math.max(bldDraw.startX, bldDraw.curX);
            const y1 = Math.min(bldDraw.startY, bldDraw.curY), y2 = Math.max(bldDraw.startY, bldDraw.curY);
            const w = x2 - x1, h = y2 - y1;
            if (w < MINOR || h < MINOR) return null;
            return <div style={{ position: "absolute", left: x1, top: y1, width: w, height: h,
              border: "2px dashed #3B82F6", background: "rgba(59,130,246,0.1)", borderRadius: 2, pointerEvents: "none", zIndex: 20 }} />;
          })()}
          {/* 多角形描画中のゴーストポリゴン（poly mode） */}
          {bldEditMode && bldDrawView === 'plan' && polyPoints.length > 0 && (
            <svg style={{ position: "absolute", inset: 0, width: TW, height: TH, pointerEvents: "none", zIndex: 20 }}>
              <polyline points={[...polyPoints, ...(polyMousePos ? [polyMousePos] : [])].map(p => `${p.x},${p.y}`).join(" ")}
                fill="none" stroke="#3B82F6" strokeWidth={2} strokeDasharray="6,3" />
              {polyPoints.length >= 3 && polyMousePos && (() => {
                const dx = polyMousePos.x - polyPoints[0].x, dy = polyMousePos.y - polyPoints[0].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                return dist < MINOR * 2 ? <circle cx={polyPoints[0].x} cy={polyPoints[0].y} r={8} fill="rgba(59,130,246,0.3)" stroke="#3B82F6" strokeWidth={2} /> : null;
              })()}
              {polyPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4}
                fill="#3B82F6" stroke="#FFF" strokeWidth={1.5} />)}
            </svg>
          )}
          {/* 建屋選択バッジ（平面図）: クリック選択時のみ表示、zoom逆補正でサイズ一定 */}
          {selectedBld && selectedBldView === 'plan' && !bldEditMode && (() => {
            const _bb = flatBlocks.filter(b => b.buildingId === selectedBld);
            if (_bb.length === 0) return null;
            const _allPts = _bb.flatMap(b => b.points);
            const _px = _allPts.reduce((s, p) => s + p.x, 0) / _allPts.length;
            const _py = _allPts.reduce((s, p) => s + p.y, 0) / _allPts.length;
            return renderBldBadgesHTML(selectedBld, _px, _py, 1 / planZoom);
          })()}
          {/* 建屋プロパティパネルは独立FloatWinに移動 */}
        </div>
        </div>{/* VIEW_PAD wrapper */}
        </div>{/* inner scroll container */}
        {/* 方位インジケーター: 平面図（X・N・PN/y） 3次元図同デザイン */}
        {(() => {
          const gc=40, cs=16, arL=30, mpp=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:1;
          const pnRad=plantNorthAngle*Math.PI/180, simAz=-planRotate*Math.PI/180, simEl=Math.PI/2;
          const p0=project3D(TW/2,TH/2,0,simAz,simEl,1,0,0);
          const mkV=(a,b,c)=>{
            const wcx=(a*Math.cos(pnRad)+b*Math.sin(pnRad))*cs, wcy=(-a*Math.sin(pnRad)+b*Math.cos(pnRad))*cs;
            const p=project3D(TW/2+wcx,TH/2-wcy,c*cs*mpp,simAz,simEl,1,0,0);
            return{sx:gc+(p.x-p0.x),sy:gc+(p.y-p0.y),d:p.depth};
          };
          const v=[mkV(-1,-1,-1),mkV(+1,-1,-1),mkV(-1,+1,-1),mkV(+1,+1,-1),mkV(-1,-1,+1),mkV(+1,-1,+1),mkV(-1,+1,+1),mkV(+1,+1,+1)];
          const fd=[
            {vi:[1,3,7,5],b:'#EF4444',dk:'#991B1B',lb:''},{vi:[0,4,6,2],b:'#7F1D1D',dk:'#450A0A',lb:''},
            {vi:[2,3,7,6],b:'#22C55E',dk:'#14532D',lb:''},{vi:[0,1,5,4],b:'#166534',dk:'#052E16',lb:''},
            {vi:[4,5,7,6],b:'#3B82F6',dk:'#1E3A8A',lb:''},{vi:[0,1,3,2],b:'#1E3A8A',dk:'#0F172A',lb:''},
          ];
          const faces=fd.map(f=>({...f,depth:f.vi.reduce((s,i)=>s+v[i].d,0)/4,pts:f.vi.map(i=>`${v[i].sx.toFixed(1)},${v[i].sy.toFixed(1)}`).join(' '),cx:f.vi.reduce((s,i)=>s+v[i].sx,0)/4,cy:f.vi.reduce((s,i)=>s+v[i].sy,0)/4})).sort((a,bb)=>bb.depth-a.depth);
          const midD=(Math.min(...faces.map(f=>f.depth))+Math.max(...faces.map(f=>f.depth)))/2;
          const nrm=(dx,dy)=>{const l=Math.sqrt(dx*dx+dy*dy)||1;return[dx/l,dy/l];};
          const pN=project3D(TW/2,TH/2-1,0,simAz,simEl,1,0,0);
          const pPN=project3D(TW/2+Math.sin(pnRad),TH/2-Math.cos(pnRad),0,simAz,simEl,1,0,0);
          const pXpn=project3D(TW/2+Math.cos(pnRad),TH/2+Math.sin(pnRad),0,simAz,simEl,1,0,0);
          const [nx,ny]=nrm(pN.x-p0.x,pN.y-p0.y),[pnx,pny]=nrm(pPN.x-p0.x,pPN.y-p0.y),[xx,xy]=nrm(pXpn.x-p0.x,pXpn.y-p0.y);
          const ah=(dx,dy,col)=>{const l=Math.sqrt(dx*dx+dy*dy)||1,ux=dx/l,uy=dy/l,hx=gc+dx,hy=gc+dy,w=3.5,hl=7;return<polygon key={`ah${col}`} points={`${hx},${hy} ${hx-ux*hl-uy*w},${hy-uy*hl+ux*w} ${hx-ux*hl+uy*w},${hy-uy*hl-ux*w}`} fill={col}/>;};
          return(
            <div style={{position:'absolute',top:30,right:30,zIndex:25}}>
              <svg width={80} height={80} style={{overflow:'visible',cursor:'default'}}>
                {faces.map((f,i)=>(
                  <g key={`f${i}`}>
                    <polygon points={f.pts} fill={f.depth<midD?f.b:f.dk} stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9}/>
                    {f.lb&&f.depth<midD&&<text x={f.cx} y={f.cy} fill="#FFF" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">{f.lb}</text>}
                  </g>
                ))}
                <circle cx={gc} cy={gc} r={3} fill="#FFF" stroke="#000" strokeWidth={0.8}/>
                <line x1={gc} y1={gc} x2={gc+xx*arL} y2={gc+xy*arL} stroke="#F87171" strokeWidth={1.8} strokeLinecap="round"/>
                {ah(xx*arL,xy*arL,'#F87171')}
                <text x={gc+xx*(arL+11)} y={gc+xy*(arL+11)} fill="#F87171" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">X</text>
                <line x1={gc} y1={gc} x2={gc+nx*arL} y2={gc+ny*arL} stroke="#F97316" strokeWidth={1.8} strokeLinecap="round"/>
                {ah(nx*arL,ny*arL,'#F97316')}
                <text x={gc+nx*(arL+11)} y={gc+ny*(arL+11)} fill="#F97316" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">N</text>
                <line x1={gc} y1={gc} x2={gc+pnx*arL} y2={gc+pny*arL} stroke="#4ADE80" strokeWidth={2} strokeLinecap="round"/>
                {ah(pnx*arL,pny*arL,'#4ADE80')}
                <text x={gc+pnx*(arL+11)} y={gc+pny*(arL+11)-7} fill="#4ADE80" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                  onClick={e=>{e.stopPropagation();setPlanPnOpen(v=>!v);}} style={{cursor:'pointer'}}>PN</text>
                <text x={gc+pnx*(arL+11)} y={gc+pny*(arL+11)+7} fill="#4ADE80" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                  onClick={e=>{e.stopPropagation();setPlanPnOpen(v=>!v);}} style={{cursor:'pointer'}}>y</text>
              </svg>
              {planPnOpen && (
                <div onMouseDown={e=>e.stopPropagation()} style={{marginTop:4,background:'rgba(15,23,42,0.72)',borderRadius:4,padding:'3px 5px'}}>
                  <div style={{display:'flex',alignItems:'center',gap:3}}>
                    <input type="text" inputMode="numeric" autoFocus onFocus={e=>e.target.select()} value={plantNorthInput}
                      onChange={e=>setPlantNorthInput(e.target.value)}
                      onBlur={e=>{const n=((Number(e.target.value)%360)+360)%360;const safe=isNaN(n)?0:n;setPlantNorthAngle(safe);setPlantNorthInput(String(safe));}}
                      onKeyDown={e=>{if(e.key==='Enter'){const n=((Number(e.target.value)%360)+360)%360;const safe=isNaN(n)?0:n;setPlantNorthAngle(safe);setPlantNorthInput(String(safe));}}}
                      style={{width:36,fontSize:9,padding:'1px 3px',background:'rgba(255,255,255,0.18)',border:'1px solid rgba(255,255,255,0.35)',borderRadius:3,color:'#FCD34D',textAlign:'center'}}/>
                    <span style={{fontSize:7,color:'#94A3B8'}}>°</span>
                  </div>
                  <div style={{display:'flex',justifyContent:'center',gap:4,marginTop:2}}>
                    <button onClick={()=>{const n=((plantNorthAngle+1)%360+360)%360;setPlantNorthAngle(n);setPlantNorthInput(String(n));}}
                      style={{fontSize:8,lineHeight:1,padding:'1px 8px',background:'rgba(255,255,255,0.15)',border:'none',borderRadius:2,color:'#FCD34D',cursor:'pointer'}}>▲</button>
                    <button onClick={()=>{const n=((plantNorthAngle-1+360)%360);setPlantNorthAngle(n);setPlantNorthInput(String(n));}}
                      style={{fontSize:8,lineHeight:1,padding:'1px 8px',background:'rgba(255,255,255,0.15)',border:'none',borderRadius:2,color:'#FCD34D',cursor:'pointer'}}>▼</button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        </div>{/* position:relative wrapper */}
        </div>{/* flex-column wrapper */}
      </FloatWin>

      {/* 建屋プロパティパネル（独立FloatWin） */}
      {bldEditMode && selectedBld && (() => {
        const bld = buildings.find(b => b.id === selectedBld);
        if (!bld) return null;
        return (
          <FloatWin id="bldProp" title={`建屋: ${bld.label}`} winState={winState} setWinState={setWinState} bringFront={bringFront}>
            <div style={{ padding: 8, fontSize: 11, overflowY: "auto", maxHeight: 450 }}
              onMouseDown={e => e.stopPropagation()}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5 }}>
                <span style={{ width: 36, color: "#64748B", fontSize: 11 }}>名前:</span>
                <input value={bld.label} onChange={e => setBuildings(prev => prev.map(b => b.id === selectedBld ? { ...b, label: e.target.value } : b))}
                  style={{ flex: 1, padding: "2px 6px", border: "1px solid #CBD5E1", borderRadius: 3, fontSize: 11, height: 22 }} />
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                <span style={{ width: 36, color: "#64748B", fontSize: 11 }}>色:</span>
                <input type="color" value={bld.color} onChange={e => setBuildings(prev => prev.map(b => b.id === selectedBld ? { ...b, color: e.target.value } : b))}
                  style={{ width: 28, height: 22, padding: 0, border: "1px solid #CBD5E1", borderRadius: 2, cursor: "pointer" }} />
                <div style={{ display: "flex", gap: 3 }}>
                  {BLD_COLORS.slice(0, 5).map(c => (
                    <div key={c} onClick={() => setBuildings(prev => prev.map(b => b.id === selectedBld ? { ...b, color: c } : b))}
                      style={{ width: 18, height: 18, background: c, borderRadius: 2, cursor: "pointer", border: c === bld.color ? "2px solid #3B82F6" : "1px solid #CBD5E1" }} />
                  ))}
                </div>
              </div>
              <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 4, marginTop: 3 }}>
                <span style={{ fontWeight: 600, color: "#475569", fontSize: 13 }}>ブロック ({bld.blocks.length})</span>
              </div>
              {bld.blocks.map((blk, bi) => {
                const xMin = Math.min(...blk.points.map(p=>p.x));
                const xMax = Math.max(...blk.points.map(p=>p.x));
                const yMin = Math.min(...blk.points.map(p=>p.y));
                const yMax = Math.max(...blk.points.map(p=>p.y));
                return (
                <div key={bi} style={{ border: "1px solid #E2E8F0", borderRadius: 4, padding: 5, marginTop: 4, background: "#F8FAFC" }}>
                  <div style={{ fontSize: 11, color: "#64748B", marginBottom: 3 }}>
                    頂点: {blk.points.length}個
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>X範囲:</span>
                      <input type="number" value={Math.round(xMin)} onChange={e => {
                        const newVal = parseInt(e.target.value) || 0;
                        const oldVal = Math.min(...blk.points.map(p=>p.x));
                        setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                          ...b, blocks: b.blocks.map((bl, i) => i === bi ? { ...bl, points: bl.points.map(p => Math.abs(p.x - oldVal) < 1 ? {...p, x: newVal} : p) } : bl)
                        } : b));
                      }} style={{ width: 40, padding: "1px 3px", border: "1px solid #CBD5E1", borderRadius: 2, fontSize: 11, textAlign: "center", height: 22 }} />
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>~</span>
                      <input type="number" value={Math.round(xMax)} onChange={e => {
                        const newVal = parseInt(e.target.value) || 0;
                        const oldVal = Math.max(...blk.points.map(p=>p.x));
                        setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                          ...b, blocks: b.blocks.map((bl, i) => i === bi ? { ...bl, points: bl.points.map(p => Math.abs(p.x - oldVal) < 1 ? {...p, x: newVal} : p) } : bl)
                        } : b));
                      }} style={{ width: 40, padding: "1px 3px", border: "1px solid #CBD5E1", borderRadius: 2, fontSize: 11, textAlign: "center", height: 22 }} />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Y範囲:</span>
                      <input type="number" value={Math.round(yMin)} onChange={e => {
                        const newVal = parseInt(e.target.value) || 0;
                        const oldVal = Math.min(...blk.points.map(p=>p.y));
                        setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                          ...b, blocks: b.blocks.map((bl, i) => i === bi ? { ...bl, points: bl.points.map(p => Math.abs(p.y - oldVal) < 1 ? {...p, y: newVal} : p) } : bl)
                        } : b));
                      }} style={{ width: 40, padding: "1px 3px", border: "1px solid #CBD5E1", borderRadius: 2, fontSize: 11, textAlign: "center", height: 22 }} />
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>~</span>
                      <input type="number" value={Math.round(yMax)} onChange={e => {
                        const newVal = parseInt(e.target.value) || 0;
                        const oldVal = Math.max(...blk.points.map(p=>p.y));
                        setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                          ...b, blocks: b.blocks.map((bl, i) => i === bi ? { ...bl, points: bl.points.map(p => Math.abs(p.y - oldVal) < 1 ? {...p, y: newVal} : p) } : bl)
                        } : b));
                      }} style={{ width: 40, padding: "1px 3px", border: "1px solid #CBD5E1", borderRadius: 2, fontSize: 11, textAlign: "center", height: 22 }} />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Z範囲:</span>
                      <input type="number" value={blk.zBottom || 0} onChange={e => {
                        const val = parseInt(e.target.value) || 0;
                        setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                          ...b, blocks: b.blocks.map((bl, i) => i === bi ? { ...bl, zBottom: val } : bl)
                        } : b));
                      }} style={{ width: 40, padding: "1px 3px", border: "1px solid #CBD5E1", borderRadius: 2, fontSize: 11, textAlign: "center", height: 22 }} />
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>~</span>
                      <input type="number" value={blk.zTop} onChange={e => {
                        const val = parseInt(e.target.value) || 0;
                        setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                          ...b, blocks: b.blocks.map((bl, i) => i === bi ? { ...bl, zTop: val } : bl)
                        } : b));
                      }} style={{ width: 40, padding: "1px 3px", border: "1px solid #CBD5E1", borderRadius: 2, fontSize: 11, textAlign: "center", height: 22 }} />
                    </label>
                    {bld.blocks.length > 1 && <button onClick={() => setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                      ...b, blocks: b.blocks.filter((_, i) => i !== bi)
                    } : b))}
                      style={{ marginLeft: "auto", padding: "1px 6px", border: "none", borderRadius: 2, background: "#FEE2E2", color: "#DC2626", fontSize: 10, cursor: "pointer" }}>x</button>}
                  </div>
                </div>
                );
              })}
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                <button onClick={() => {
                  const base = bld.blocks[0];
                  const xs = base.points.map(p => p.x), ys = base.points.map(p => p.y);
                  const minX = Math.min(...xs), maxX = Math.max(...xs);
                  const maxY = Math.max(...ys);
                  const h = MAJOR;
                  const newPts = [{x:minX,y:maxY},{x:maxX,y:maxY},{x:maxX,y:maxY+h},{x:minX,y:maxY+h}];
                  setBuildings(prev => prev.map(b => b.id === selectedBld ? {
                    ...b, blocks: [...b.blocks, { points: newPts, zBottom: 0, zTop: 40 }]
                  } : b));
                }}
                  style={{ flex: 1, padding: "3px 6px", border: "none", borderRadius: 3, background: "#DBEAFE", color: "#2563EB", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                  + ブロック追加
                </button>
                <button onClick={() => { setBuildings(prev => prev.filter(b => b.id !== selectedBld)); setSelectedBld(null); }}
                  style={{ padding: "3px 8px", border: "none", borderRadius: 3, background: "#FEE2E2", color: "#DC2626", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                  建屋削除
                </button>
              </div>
              {/* 面移動セクション */}
              <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 6, marginTop: 6 }}>
                <span style={{ fontWeight: 600, color: "#475569", fontSize: 11 }}>面移動 (2D/3Dで建屋クリック→矢印ドラッグ)</span>
                {bld.blocks.map((blk, bi) => {
                  const pts = blk.points;
                  const n = pts.length;
                  // 辺ごとの面 + zBottom/zTop
                  const faces = [];
                  for (let ei = 0; ei < n; ei++) {
                    faces.push({ key: ei, label: `辺${ei}`, val: '' });
                  }
                  faces.push({ key: 'zBottom', label: '底面', val: blk.zBottom || 0 });
                  faces.push({ key: 'zTop', label: '上面', val: blk.zTop || 40 });
                  const moveFace = (face, delta) => {
                    setBuildings(prev => prev.map(b => {
                      if (b.id !== selectedBld) return b;
                      return { ...b, blocks: b.blocks.map((bl, i) => {
                        if (i !== bi) return bl;
                        if (face === 'zTop') return { ...bl, zTop: (bl.zTop || 40) + delta };
                        if (face === 'zBottom') return { ...bl, zBottom: (bl.zBottom || 0) + delta };
                        const edgeIdx = face;
                        const _pts = bl.points;
                        const _n = _pts.length;
                        const p0 = _pts[edgeIdx], p1 = _pts[(edgeIdx + 1) % _n];
                        const ex = p1.x - p0.x, ey = p1.y - p0.y;
                        const elen = Math.sqrt(ex * ex + ey * ey);
                        if (elen < 0.001) return bl;
                        let nx = ey / elen, ny = -ex / elen;
                        const cx = _pts.reduce((s, p) => s + p.x, 0) / _n;
                        const cy = _pts.reduce((s, p) => s + p.y, 0) / _n;
                        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                        if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
                        const i0 = edgeIdx, i1 = (edgeIdx + 1) % _n;
                        return { ...bl, points: _pts.map((p, pi) => {
                          if (pi === i0 || pi === i1) return { ...p, x: p.x + nx * delta, y: p.y + ny * delta };
                          return p;
                        })};
                      })};
                    }));
                  };
                  return (
                    <div key={bi} style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 2 }}>
                      {faces.map(f => (
                        <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 1 }}>
                          <button onClick={() => moveFace(f.key, -MINOR)}
                            style={{ width: 16, height: 18, border: "1px solid #CBD5E1", borderRadius: "2px 0 0 2px", background: "#F1F5F9", cursor: "pointer", fontSize: 9, padding: 0 }}>-</button>
                          <span style={{ fontSize: 9, color: "#475569", background: "#F8FAFC", border: "1px solid #CBD5E1", borderLeft: "none", borderRight: "none", padding: "1px 3px", minWidth: 38, textAlign: "center", height: 18, lineHeight: "18px" }}>
                            {f.label}{f.val !== '' ? `:${f.val}` : ''}
                          </span>
                          <button onClick={() => moveFace(f.key, MINOR)}
                            style={{ width: 16, height: 18, border: "1px solid #CBD5E1", borderRadius: "0 2px 2px 0", background: "#F1F5F9", cursor: "pointer", fontSize: 9, padding: 0 }}>+</button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </FloatWin>
        );
      })()}

      {/* 断面図ウィンドウ */}
      <FloatWin id="elev" title={`断面図 (X-Z) x${elevZoom.toFixed(1)}`} winState={winState} setWinState={setWinState} bringFront={bringFront} overflow="hidden"
        onClose={() => setWinState(pr => ({ ...pr, elev: { ...pr.elev, hidden: true } }))}
        headerExtra={<>
          <button onClick={() => { setBldEditMode(m => !m); setSelectedBld(null); setBldDraw(null); setPolyPoints([]); setPolyMousePos(null); }}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: bldEditMode ? "#2563EB" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
            {bldEditMode ? "🏗 ON" : "🏗 建屋"}
          </button>
          <button onClick={() => setHSecMode(hSecMode === 'elev' ? null : 'elev')}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: hSecMode === 'elev' ? "#DC2626" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
            {hSecMode === 'elev' ? "⊟ ON" : "⊟ 平面追加"}
          </button>
        </>}>
        <div style={{ display:'flex', flexDirection:'column', width:'100%', height:'100%' }}>
        {bldEditMode && <div style={{ padding: "3px 6px", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          <button onClick={() => { setBldDrawMode('rect'); setPolyPoints([]); setPolyMousePos(null); setBldDrawView('elev'); }}
            style={{ padding: "2px 6px", border: "2px solid", borderColor: bldDrawMode === 'rect' && bldDrawView === 'elev' ? "#2563EB" : "transparent", borderRadius: 4, cursor: "pointer", fontSize: 9, fontWeight: 700,
              background: bldDrawMode === 'rect' ? "#DBEAFE" : "#E2E8F0", color: bldDrawMode === 'rect' ? "#1D4ED8" : "#475569" }}>
            ▭矩形
          </button>
          <span style={{ fontSize: 7, color: "#94A3B8" }}>X-Z範囲→建屋作成</span>
        </div>}
        <div style={{ position:'relative', flex:1, overflow:'hidden', minHeight:0 }}>
        <div style={{ overflow:'auto', width:'100%', height:'100%' }}>
        <div style={{ padding: VIEW_PAD, display: 'inline-block', lineHeight: 0 }}
          onMouseDown={e => {
            if (e.button !== 0 || bldEditMode || hSecMode === 'elev') return;
            const scrollEl = elevRef.current?.parentElement?.parentElement;
            if (scrollEl) { e.preventDefault(); setViewPanDrag({ ref: elevRef, scrollEl, startX: e.clientX, startY: e.clientY, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop }); }
          }}>
        <div ref={elevRef}
          onDragOver={e => e.preventDefault()} onDrop={handleDrop("elev")}
          onAuxClick={e => e.preventDefault()}
          onMouseDown={e => {
            if (e.button === 1) {
              e.preventDefault();
              const _sc = elevRef.current?.parentElement?.parentElement;
              const _sr = _sc ? _sc.getBoundingClientRect() : null;
              const _ox = _sr ? (_sc.scrollLeft + e.clientX - _sr.left - VIEW_PAD) / elevZoom : 0;
              const _oy = _sr ? (_sc.scrollTop  + e.clientY - _sr.top  - VIEW_PAD) / elevZoom : 0;
              setElevRotateOrigin({ x: _ox, y: _oy });
              setViewRotateDrag({ refId: 'elev', startX: e.clientX, startRotate: elevRotate });
              return;
            }
            if (hSecMode === 'elev' && e.button === 0) {
              e.preventDefault();
              const _r = elevRef.current?.getBoundingClientRect();
              const svgY = _r ? (e.clientY - _r.top) / elevZoom : e.clientY;
              setHSecPreview({ view: 'elev', zPx: GL_Y - svgY });
              return;
            }
            if (bldEditMode && bldDrawMode === 'rect' && bldDrawView === 'elev') {
              const target = e.target;
              if (target.getAttribute && target.getAttribute("data-bld-rect")) return;
              e.preventDefault();
              const p = toP(elevRef, e);
              const sx = snapV(p.x), sz = snapV(GL_Y - p.y);
              setBldDraw({ startH: sx, startV: sz, curH: sx, curV: sz, view: 'elev' });
              setSelectedBld(null);
            } else if (!bldEditMode && e.button === 0) {
              const scrollEl = elevRef.current?.parentElement?.parentElement;
              if (scrollEl) {
                e.preventDefault();
                setViewPanDrag({ ref: elevRef, scrollEl, startX: e.clientX, startY: e.clientY, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop });
              }
            }
          }}
          onMouseMove={e => {
            if (hSecPreview?.view === 'elev') {
              const _r = elevRef.current?.getBoundingClientRect();
              const svgY = _r ? (e.clientY - _r.top) / elevZoom : e.clientY;
              setHSecPreview(prev => prev ? { ...prev, zPx: GL_Y - svgY } : null);
              return;
            }
            if (bldDraw && bldDraw.view === 'elev') {
              const p = toP(elevRef, e);
              setBldDraw(prev => prev ? { ...prev, curH: snapV(p.x), curV: snapV(GL_Y - p.y) } : null);
              return;
            }
            if (!iconDragging.current && !wpDragActiveRef.current && !viewPanDrag && !viewRotateDrag) {
              _jsHitDetect(e, elevRef, elevZoom, pt => ({ x: pt.x, y: GL_Y-(pt.z||0) }), setJsCursorElev);
            }
          }}
          onMouseLeave={() => { setHoverSeg(null); setWireTip(null); setJsCursorElev(null); }}
          onMouseUp={e => {
            if (hSecPreview?.view === 'elev') {
              finishHSection(hSecPreview.zPx);
              setHSecPreview(null);
              return;
            }
            if (bldDraw && bldDraw.view === 'elev') {
              const x1 = Math.min(bldDraw.startH, bldDraw.curH), x2 = Math.max(bldDraw.startH, bldDraw.curH);
              const z1 = Math.min(bldDraw.startV, bldDraw.curV), z2 = Math.max(bldDraw.startV, bldDraw.curV);
              if (Math.abs(x2 - x1) >= MINOR && Math.abs(z2 - z1) >= MINOR) {
                const yc = TH / 2, yh = 2 * MAJOR;
                const points = [{x:x1,y:yc-yh},{x:x2,y:yc-yh},{x:x2,y:yc+yh},{x:x1,y:yc+yh}];
                bldCounter.current++;
                const newId = `bld${bldCounter.current}`;
                const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
                setBuildings(prev => [...prev, { id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
                  blocks: [{ points, zBottom: z1, zTop: z2 }] }]);
                setSelectedBld(newId);
              }
              setBldDraw(null);
            }
          }}
          style={{ position: "relative", width: ELEV_W + 30, height: ELEV_H, background: "#FEFEFE", touchAction: "none", cursor: hSecMode === 'elev' ? "crosshair" : bldEditMode && bldDrawView === 'elev' ? "crosshair" : viewRotateDrag?.refId === 'elev' ? "grabbing" : viewPanDrag?.ref === elevRef ? "grabbing" : jsCursorElev || "grab", zoom: elevZoom, transform: `rotate(${elevRotate}deg)`, transformOrigin: `${elevRotateOrigin.x}px ${elevRotateOrigin.y}px` }}>
          <svg style={{ position: "absolute", inset: 0, width: ELEV_W + 30, height: ELEV_H, pointerEvents: "none" }}>
            {(() => {
              const ls = [];
              const _ez = elevZoom || 1;
              for (let x = 0; x <= TW; x += MAJOR) ls.push(<line key={`ev${x}`} x1={x} y1={0} x2={x} y2={ELEV_H} stroke="rgba(0,0,0,0.05)" strokeWidth={0.5/_ez} />);
              for (let z = MIN_Z; z <= MAX_Z; z += MAJOR) { const sy = GL_Y - z; const label = z < 0 ? `B${Math.round(-z / MAJOR)}` : `${Math.round(z / MAJOR)}F`; ls.push(<line key={`eh${z}`} x1={0} y1={sy} x2={TW} y2={sy} stroke={z === 0 ? "rgba(0,0,0,0.08)" : z < 0 ? "rgba(139,92,40,0.08)" : "rgba(0,0,0,0.05)"} strokeWidth={z === 0 ? 1/_ez : 0.5/_ez} />); ls.push(<text key={`el${z}`} x={TW + 3} y={sy + 3} fontSize={6/_ez} fill={z < 0 ? "#A67C52" : "#94A3B8"}>{label}</text>); }
              ls.push(<line key="gl" x1={0} y1={GL_Y} x2={TW} y2={GL_Y} stroke="#8B6914" strokeWidth={2 / _ez} />);
              ls.push(<text key="glt" x={TW + 3} y={GL_Y + 3} fontSize={6 / _ez} fontWeight={700} fill="#8B6914">GL</text>);
              hSections.forEach(hs => {
                const _liveZPx = hSecLiveZRef.current[hs.id] ?? hs.zPx;
                const sy = GL_Y - _liveZPx;
                // clipSecがある場合はそのXAABBに絞る（elevはX-Z平面）
                let lx1 = 0, lx2 = TW;
                if (hs.clipSec) {
                  const cs = hs.clipSec;
                  if (cs.center !== undefined) {
                    const { center: { x: cx }, halfA, halfB, pnRad } = cs;
                    const span = halfA * Math.abs(Math.cos(pnRad)) + halfB * Math.abs(Math.sin(pnRad));
                    lx1 = cx - span; lx2 = cx + span;
                  } else if (cs.rect) { lx1 = cs.rect.x1; lx2 = cs.rect.x2; }
                }
                if (hSecShowBand[hs.id]) ls.push(<rect key={`hsb-e${hs.id}`} x={lx1} y={sy - MAJOR/(2*_ez)} width={lx2-lx1} height={MAJOR/_ez} fill="rgba(0,0,0,0.08)" pointerEvents="none" />);
                ls.push(<line key={`hsi-e${hs.id}`} x1={lx1} y1={sy} x2={lx2} y2={sy} stroke="#1a1a1a" strokeWidth={1.5/_ez} pointerEvents="none" />);
                ls.push(<text key={`hsl-e${hs.id}`} x={lx1 + 4/_ez} y={sy - 3/_ez} fontSize={7/_ez} fill="#1a1a1a" fontWeight={700} pointerEvents="none">{hs.label}</text>);
                ls.push(<rect key={`hsh-e${hs.id}`} x={lx1} y={sy - 6/_ez} width={lx2-lx1} height={12/_ez}
                  fill="transparent" style={{cursor:'ns-resize'}} pointerEvents="all"
                  onMouseDown={e => { e.preventDefault(); e.stopPropagation();
                    if (hSecActiveDim && !hSecDrag) return; // バッジ表示中はドラッグ開始しない（入力モードへの干渉防止）
                    hSecDragClientPos.current = { x: e.clientX, y: e.clientY }; setHSecActiveDim({id:hs.id}); setHSecDrag({id:hs.id, startClientX:e.clientX, startClientY:e.clientY, startZPx:_liveZPx, dZPerPx:1/_ez}); }} />);
              });
              // 断面図: hSec間の寸法バッジ（wireTip同スタイル）
              if (hSections.length >= 1) {
                const _mppV = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                const _allLvl = [{ id: 'GL', label: 'GL', zPx: 0 }, ...hSections.map(hs => ({ id: hs.id, label: hs.label, zPx: hSecLiveZRef.current[hs.id] ?? hs.zPx }))].sort((a, b) => a.zPx - b.zPx);
                const _bw = 56 / _ez, _bh = 13 / _ez, _br = 3 / _ez, _fs = 7 / _ez, _tk = 4 / _ez;
                const _bx = TW - _bw - 4 / _ez;
                for (let _di = 0; _di < _allLvl.length - 1; _di++) {
                  const _lo = _allLvl[_di], _hi = _allLvl[_di + 1];
                  const _sy_lo = GL_Y - _lo.zPx, _sy_hi = GL_Y - _hi.zPx;
                  const _midY = (_sy_lo + _sy_hi) / 2;
                  const _mm = Math.round(Math.abs(_hi.zPx - _lo.zPx) * _mppV * 1000);
                  const _isEdit = !hSecActiveDim && hSecEditDim?.hSecId === _hi.id && hSecEditDim?.refId === _lo.id;
                  ls.push(<line key={`dg-e${_di}`} x1={_bx + _bw/2} y1={_sy_hi} x2={_bx + _bw/2} y2={_sy_lo} stroke="#94A3B8" strokeWidth={0.8/_ez} strokeDasharray={`${3/_ez},${2/_ez}`} pointerEvents="none" />);
                  ls.push(<line key={`dta-e${_di}`} x1={_bx+_bw/2-_tk} y1={_sy_lo} x2={_bx+_bw/2+_tk} y2={_sy_lo} stroke="#64748B" strokeWidth={1/_ez} pointerEvents="none" />);
                  ls.push(<line key={`dtb-e${_di}`} x1={_bx+_bw/2-_tk} y1={_sy_hi} x2={_bx+_bw/2+_tk} y2={_sy_hi} stroke="#64748B" strokeWidth={1/_ez} pointerEvents="none" />);
                  if (_isEdit) {
                    const _fw = _bw, _fh = 16 / _ez;
                    ls.push(<foreignObject key={`dfo-e${_di}`} x={_bx} y={_midY - _fh/2} width={_fw} height={_fh}>
                      <input autoFocus defaultValue={_mm}
                        style={{ width: _fw * _ez + 'px', height: _fh * _ez + 'px', fontSize: 10, border: '1px solid #3B82F6', borderRadius: 2, padding: '0 3px', outline: 'none', background: '#FFF', transform: `scale(${1/_ez})`, transformOrigin: '0 0' }}
                        onKeyDown={ev => {
                          if (ev.key === 'Enter') {
                            const newMm = parseFloat(ev.target.value);
                            if (!isNaN(newMm) && newMm >= 0) {
                              const newZPx = _lo.zPx + newMm / 1000 / _mppV;
                              const newLabel = newZPx >= 0 ? `${Math.floor(newZPx / MAJOR) + 1}F` : `B${Math.ceil(-newZPx / MAJOR)}`;
                              setHSections(prev => prev.map(h => h.id === _hi.id ? { ...h, zPx: newZPx, label: newLabel } : h));
                            }
                            setHSecEditDim(null);
                          }
                          if (ev.key === 'Escape') setHSecEditDim(null);
                        }}
                        onBlur={() => setHSecEditDim(null)} />
                    </foreignObject>);
                  } else {
                    ls.push(<rect key={`dbg-e${_di}`} x={_bx} y={_midY - _bh/2} width={_bw} height={_bh} rx={_br} fill="rgba(30,41,59,0.82)" pointerEvents="all"
                      style={{ cursor: _hi.id !== 'GL' ? 'pointer' : 'default' }}
                      onClick={() => { if (_hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }} />);
                    ls.push(<text key={`dtx-e${_di}`} x={_bx + _bw/2} y={_midY + _fs * 0.38} fontSize={_fs} fill="#F1F5F9" fontWeight={600} textAnchor="middle"
                      style={{ cursor: _hi.id !== 'GL' ? 'pointer' : 'default' }} pointerEvents="all"
                      onClick={() => { if (_hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }}>
                      {_mm.toLocaleString()} mm
                    </text>);
                  }
                }
              }
              // 地下部分の背景
              ls.push(<rect key="underground" x={0} y={GL_Y} width={TW} height={ELEV_H - GL_Y} fill="rgba(139,105,20,0.04)" />);
              // 地下フィールド（z=-10m〜-160m、厚み150m）
              { const _ugY = GL_Y + 10;
                ls.push(<rect key="ug-slab-e" x={0} y={_ugY} width={TW} height={40} fill={_ugC(0.55)} />);
                ls.push(<line key="ug-floor-e" x1={0} y1={_ugY} x2={TW} y2={_ugY} stroke={_ugC(0.85)} strokeWidth={1.5 / _ez} />);
                ls.push(<line key="ug-bot-e" x1={0} y1={_ugY+40} x2={TW} y2={_ugY+40} stroke={_ugC(0.6)} strokeWidth={1 / _ez} />);
                ls.push(<text key="ug-floor-et" x={TW + 3} y={_ugY + 3} fontSize={6} fontWeight={600} fill={_ugFloor}>地下</text>);
              }
              // 建屋ごとにグループ化（一体表示＋共有辺除去）
              const eBldGroups = {};
              flatBlocks.forEach((b, i) => {
                if (!eBldGroups[b.buildingId]) eBldGroups[b.buildingId] = [];
                eBldGroups[b.buildingId].push({ ...b, _idx: i });
              });
              Object.entries(eBldGroups).forEach(([bid, blocks]) => {
                const isSel = bldEditMode && selectedBld === bid;
                // 各ブロックを断面図座標の矩形に変換
                const rects = blocks.map(b => {
                  const zBot = b.zBottom || 0, zT = b.zTop;
                  return { x1: b.pxMinX, y1: GL_Y - zT, x2: b.pxMaxX, y2: GL_Y - zBot, zBot, zT, b };
                });
                // 一体化 path (fill-rule nonzero)
                const pathD = rects.map(r => `M${r.x1},${r.y1}L${r.x2},${r.y1}L${r.x2},${r.y2}L${r.x1},${r.y2}Z`).join(" ");
                ls.push(<path key={`ebf${bid}`} data-bld-rect="1" d={pathD} fill={blocks[0].color}
                  opacity={isSel ? 0.35 : 0.18} fillRule="nonzero" stroke="none"
                  style={{ pointerEvents: "auto", cursor: "pointer" }}
                  onMouseEnter={() => { if (!bldEditMode) { setHovBldId(bid); setHovBldView('elev'); } }}
                  onMouseLeave={() => { if (!bldEditMode) { setHovBldId(null); setHovBldView(null); } }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (bldEditMode) { setSelectedBld(bid); setSelectedBldView('elev'); }
                    else {
                      const _nsel = selectedBld === bid ? null : bid;
                      setSelectedBld(_nsel); setSelectedBldView(_nsel ? 'elev' : null);
                    }
                  }} />);
                // 各ブロックの外周線（共有辺を除外）
                rects.forEach((r, ri) => {
                  const edges = [
                    { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y1, axis: 'h', pos: r.y1, a: r.x1, b_: r.x2 },
                    { x1: r.x1, y1: r.y2, x2: r.x2, y2: r.y2, axis: 'h', pos: r.y2, a: r.x1, b_: r.x2 },
                    { x1: r.x1, y1: r.y1, x2: r.x1, y2: r.y2, axis: 'v', pos: r.x1, a: r.y1, b_: r.y2 },
                    { x1: r.x2, y1: r.y1, x2: r.x2, y2: r.y2, axis: 'v', pos: r.x2, a: r.y1, b_: r.y2 },
                  ];
                  edges.forEach((e, ei) => {
                    const isShared = rects.some((or, ori) => {
                      if (ori === ri) return false;
                      const oEdges = [
                        { axis: 'h', pos: or.y1, a: or.x1, b_: or.x2 }, { axis: 'h', pos: or.y2, a: or.x1, b_: or.x2 },
                        { axis: 'v', pos: or.x1, a: or.y1, b_: or.y2 }, { axis: 'v', pos: or.x2, a: or.y1, b_: or.y2 },
                      ];
                      return oEdges.some(oe => oe.axis === e.axis && Math.abs(oe.pos - e.pos) < 1 &&
                        Math.min(e.a, e.b_) < Math.max(oe.a, oe.b_) && Math.min(oe.a, oe.b_) < Math.max(e.a, e.b_));
                    });
                    if (!isShared) ls.push(<line key={`ebl${bid}${ri}${ei}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                      stroke={isSel ? "#3B82F6" : blocks[0].color} strokeWidth={isSel ? 2/_ez : 1/_ez} pointerEvents="none"
                      strokeDasharray={r.zBot < 0 ? "3,2" : "none"} />);
                  });
                });
                // エッジハンドル（選択時）
                if (isSel) {
                  rects.forEach((r, ri) => {
                    const b = r.b;
                    ls.push(<line key={`eht${bid}${ri}`} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y1}
                      stroke="#3B82F6" strokeWidth={6/_ez} opacity={0.4} style={{cursor:"ns-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'zTop',startMouse:ev.clientY,origVal:r.zT,view:'elev'});}} />);
                    ls.push(<line key={`ehb${bid}${ri}`} x1={r.x1} y1={r.y2} x2={r.x2} y2={r.y2}
                      stroke="#3B82F6" strokeWidth={6/_ez} opacity={0.4} style={{cursor:"ns-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'zBottom',startMouse:ev.clientY,origVal:r.zBot,view:'elev'});}} />);
                    ls.push(<line key={`ehl${bid}${ri}`} x1={r.x1} y1={r.y1} x2={r.x1} y2={r.y2}
                      stroke="#3B82F6" strokeWidth={6/_ez} opacity={0.4} style={{cursor:"ew-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'xMin',startMouse:ev.clientX,origVal:b.pxMinX,origPoints:b.points.map(p=>({...p})),view:'elev'});}} />);
                    ls.push(<line key={`ehr${bid}${ri}`} x1={r.x2} y1={r.y1} x2={r.x2} y2={r.y2}
                      stroke="#3B82F6" strokeWidth={6/_ez} opacity={0.4} style={{cursor:"ew-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'xMax',startMouse:ev.clientX,origVal:b.pxMaxX,origPoints:b.points.map(p=>({...p})),view:'elev'});}} />);
                  });
                }
                // 建屋バッジはSVG外HTMLオーバーレイで描画
              });
              // hSecPreviewプレビュー線（elev）
              if (hSecPreview?.view === 'elev') {
                const _psy = GL_Y - hSecPreview.zPx;
                const _pl = `${Math.floor(hSecPreview.zPx / MAJOR) + 1}F`;
                ls.push(<line key="hsp-e" x1={0} y1={_psy} x2={TW} y2={_psy} stroke="#1a1a1a" strokeWidth={2/_ez} strokeDasharray={`${5/_ez},${3/_ez}`} pointerEvents="none" />);
                ls.push(<text key="hspl-e" x={4/_ez} y={_psy - 4/_ez} fontSize={8/_ez} fill="#1a1a1a" fontWeight={700} pointerEvents="none">{_pl}</text>);
              }
              return ls;
            })()}
          </svg>
          {/* 断面図ゴースト描画 */}
          {bldDraw && bldDraw.view === 'elev' && (() => {
            const h1 = Math.min(bldDraw.startH, bldDraw.curH), h2 = Math.max(bldDraw.startH, bldDraw.curH);
            const v1 = Math.min(bldDraw.startV, bldDraw.curV), v2 = Math.max(bldDraw.startV, bldDraw.curV);
            if (h2 - h1 < MINOR || v2 - v1 < MINOR) return null;
            return <div style={{ position: "absolute", left: h1, top: GL_Y - v2, width: h2 - h1, height: v2 - v1,
              border: "2px dashed #3B82F6", background: "rgba(59,130,246,0.1)", borderRadius: 2, pointerEvents: "none", zIndex: 20 }} />;
          })()}
          {/* カメラ仰角表示（ドラッグ可能） */}
          {(() => {
            const _ez = elevZoom || 1;
            // 旧: unproject3D は真横視点(sinE≈0)でNaNを返し、SVG座標が全滅していた
            const lookAtE = cabScreenToGroundPoint(CAB_W / 2, CAB_H / 2, camAz, camEl, camZoom, camPanX, camPanY);
            const camEX = Math.max(30, Math.min(ELEV_W - 30, lookAtE.x + 50 / _ez));
            const camEY = GL_Y - MAX_Z * 0.7;
            const lookA2 = Math.PI - camEl;
            const cRad2 = 22 / _ez, fov4 = 0.3;
            const ca12 = lookA2 - fov4, ca22 = lookA2 + fov4;
            const isDragging = camDrag && camDrag.view === "elev";
            return (
              <svg style={{ position: "absolute", inset: 0, width: ELEV_W + 30, height: ELEV_H, zIndex: 4, pointerEvents: "none" }}>
                <g opacity={isDragging ? 0.9 : 0.55}>
                  <path d={`M${camEX},${camEY} L${camEX + Math.cos(ca12) * cRad2},${camEY + Math.sin(ca12) * cRad2} A${cRad2},${cRad2} 0 0,1 ${camEX + Math.cos(ca22) * cRad2},${camEY + Math.sin(ca22) * cRad2} Z`}
                    fill="rgba(99,102,241,0.15)" stroke="rgba(99,102,241,0.4)" strokeWidth={1 / _ez} />
                  <circle cx={camEX} cy={camEY} r={14 / _ez} fill="transparent" style={{ cursor: "grab", pointerEvents: "auto" }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setCamDrag({ view: "elev" }); }}
                    onTouchStart={e => { e.preventDefault(); e.stopPropagation(); setCamDrag({ view: "elev" }); }} />
                  <circle cx={camEX} cy={camEY} r={5 / _ez} fill={isDragging ? "#4F46E5" : "#6366F1"} stroke="#FFF" strokeWidth={1.5 / _ez} pointerEvents="none" />
                  <circle cx={camEX} cy={camEY} r={2 / _ez} fill="#FFF" pointerEvents="none" />
                  <text x={camEX} y={camEY - 8 / _ez} textAnchor="middle" fontSize={6 / _ez} fontWeight={600} fill="#6366F1" pointerEvents="none">CAM</text>
                </g>
              </svg>
            );
          })()}
          <svg style={{ position: "absolute", inset: 0, width: ELEV_W + 30, height: ELEV_H, zIndex: 5, pointerEvents: "none" }}>
            {wpDrag?.view === "elev" && Object.entries(allMapPos).map(([nid, np]) => {
              const isSnapped = wpSnapIconRef.current === nid;
              return <line key={nid} x1={np.x} y1={0} x2={np.x} y2={ELEV_H}
                stroke={isSnapped ? "#3B82F6" : "rgba(59,130,246,0.3)"}
                strokeWidth={isSnapped ? 1.5 / (elevZoom || 1) : 0.8 / (elevZoom || 1)}
                strokeDasharray={isSnapped ? "none" : `${4 / (elevZoom||1)},${3 / (elevZoom||1)}`}
                pointerEvents="none" />;
            })}
            {wpDrag?.view === "elev" && wpPerpSnapRef.current?.map((m, i) => {
              const { svgX, svgY, dAx, dAy, dBx, dBy } = m;
              const sz = 14 / (elevZoom || 1);
              const P1=[svgX-dAx*sz,svgY-dAy*sz],P2=[svgX-dAx*sz+dBx*sz,svgY-dAy*sz+dBy*sz],P3=[svgX+dBx*sz,svgY+dBy*sz];
              return <path key={i} d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                fill="none" stroke="#3B82F6" strokeWidth={1.5/(elevZoom||1)} pointerEvents="none" />;
            })}
            {elevDrag && iconPerpSnapRef.current && (() => {
              const { svgX, svgY, dAx, dAy, dBx, dBy } = iconPerpSnapRef.current;
              const sz = 14 / (elevZoom || 1);
              const P1 = [svgX - dAx*sz, svgY - dAy*sz];
              const P2 = [svgX - dAx*sz + dBx*sz, svgY - dAy*sz + dBy*sz];
              const P3 = [svgX + dBx*sz, svgY + dBy*sz];
              return <path d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                fill="none" stroke="#3B82F6" strokeWidth={1.5/(elevZoom||1)} pointerEvents="none" />;
            })()}
            {elevDrag && Object.entries(segWp).flatMap(([sid, wps]) => wps.map((wp, i) => {
              const key = `${sid}_${i}`;
              const isSnapped = iconSnapWpRef.current === key;
              return <line key={key} x1={wp.x} y1={0} x2={wp.x} y2={ELEV_H}
                stroke={isSnapped ? "#3B82F6" : "rgba(59,130,246,0.3)"}
                strokeWidth={isSnapped ? 1.5 / (elevZoom || 1) : 0.8 / (elevZoom || 1)}
                strokeDasharray={isSnapped ? "none" : `${4 / (elevZoom||1)},${3 / (elevZoom||1)}`}
                pointerEvents="none" />;
            }))}
            <g style={{ pointerEvents: "auto" }}>{renderSegs("elev", elevRef, p => ({ x: p.x, y: GL_Y - (p.z || 0) }), { wireOnly: true })}</g>
          </svg>
          {renderNodes("elev", elevRef)}
          <svg style={{ position: "absolute", inset: 0, width: ELEV_W + 30, height: ELEV_H, zIndex: 15, overflow: "visible", pointerEvents: "none" }}>
            <g>{renderSegs("elev", elevRef, p => ({ x: p.x, y: GL_Y - (p.z || 0) }), { wpOnly: true })}</g>
          </svg>
          {/* 建屋選択バッジ（断面図）: クリック選択時のみ表示、zoom逆補正でサイズ一定 */}
          {selectedBld && selectedBldView === 'elev' && !bldEditMode && (() => {
            const _bb = flatBlocks.filter(b => b.buildingId === selectedBld);
            if (_bb.length === 0) return null;
            const _xMn = Math.min(..._bb.map(b => b.pxMinX)), _xMx = Math.max(..._bb.map(b => b.pxMaxX));
            const _zT = Math.max(..._bb.map(b => b.zTop));
            return renderBldBadgesHTML(selectedBld, (_xMn + _xMx) / 2, GL_Y - _zT, 1 / elevZoom);
          })()}
        </div>
        </div>{/* VIEW_PAD wrapper */}
        </div>{/* inner scroll container elev */}
        {/* 方位インジケーター: 断面図（X・Z） 3次元図同デザイン */}
        {(() => {
          const gc=40, cs=16, arL=30, mpp=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:1;
          const pnRad=plantNorthAngle*Math.PI/180;
          // キューブ: cAz固定→面切替なし。CSS rotate(-elevRotate)で2D平面回転
          // 矢印: aAz=ビュー回転込み→PN/Z方向を正確に投影
          const cAz=0, cEl=0;
          const aAz=-elevRotate*Math.PI/180, aEl=0;
          const cp0=project3D(TW/2,TH/2,0,cAz,cEl,1,0,0);
          // plant座標系 (a=X_plant, b=Y_plant=PN, c=Z) — 3次元図と統一
          const mkV=(a,b,c)=>{
            const wcx=(a*Math.cos(pnRad)+b*Math.sin(pnRad))*cs, wcy=(-a*Math.sin(pnRad)+b*Math.cos(pnRad))*cs;
            const p=project3D(TW/2+wcx,TH/2-wcy,c*cs*mpp,cAz,cEl,1,0,0);
            return{sx:gc+(p.x-cp0.x),sy:gc+(p.y-cp0.y),d:p.depth};
          };
          const v=[mkV(-1,-1,-1),mkV(+1,-1,-1),mkV(-1,+1,-1),mkV(+1,+1,-1),mkV(-1,-1,+1),mkV(+1,-1,+1),mkV(-1,+1,+1),mkV(+1,+1,+1)];
          const fd=[
            {vi:[1,3,7,5],b:'#EF4444',dk:'#991B1B',lb:''},{vi:[0,4,6,2],b:'#7F1D1D',dk:'#450A0A',lb:''},
            {vi:[2,3,7,6],b:'#22C55E',dk:'#14532D',lb:''},{vi:[0,1,5,4],b:'#166534',dk:'#052E16',lb:''},
            {vi:[4,5,7,6],b:'#3B82F6',dk:'#1E3A8A',lb:''},{vi:[0,1,3,2],b:'#1E3A8A',dk:'#0F172A',lb:''},
          ];
          const faces=fd.map(f=>({...f,depth:f.vi.reduce((s,i)=>s+v[i].d,0)/4,pts:f.vi.map(i=>`${v[i].sx.toFixed(1)},${v[i].sy.toFixed(1)}`).join(' '),cx:f.vi.reduce((s,i)=>s+v[i].sx,0)/4,cy:f.vi.reduce((s,i)=>s+v[i].sy,0)/4})).sort((a,bb)=>bb.depth-a.depth);
          const midD=(Math.min(...faces.map(f=>f.depth))+Math.max(...faces.map(f=>f.depth)))/2;
          const nrm=(dx,dy)=>{const l=Math.sqrt(dx*dx+dy*dy)||1;return[dx/l,dy/l];};
          const ap0=project3D(TW/2,TH/2,0,aAz,aEl,1,0,0);
          const pZ=project3D(TW/2,TH/2,mpp,aAz,aEl,1,0,0);
          const pXpn=project3D(TW/2+Math.cos(pnRad),TH/2+Math.sin(pnRad),0,aAz,aEl,1,0,0);
          const [zx,zy]=nrm(pZ.x-ap0.x,pZ.y-ap0.y),[xx,xy]=nrm(pXpn.x-ap0.x,pXpn.y-ap0.y);
          const ah=(dx,dy,col)=>{const l=Math.sqrt(dx*dx+dy*dy)||1,ux=dx/l,uy=dy/l,hx=gc+dx,hy=gc+dy,w=3.5,hl=7;return<polygon key={`ah${col}`} points={`${hx},${hy} ${hx-ux*hl-uy*w},${hy-uy*hl+ux*w} ${hx-ux*hl+uy*w},${hy-uy*hl-ux*w}`} fill={col}/>;};
          return(
            <div style={{position:'absolute',top:6,right:50,zIndex:25,pointerEvents:'none'}}>
              <svg width={80} height={80} style={{overflow:'visible'}}>
                {/* キューブ面: その場で2D回転（面切替なし） */}
                <g transform={`rotate(${-elevRotate}, ${gc}, ${gc})`}>
                  {faces.map((f,i)=>(
                    <g key={`f${i}`}>
                      <polygon points={f.pts} fill={f.depth<midD?f.b:f.dk} stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9}/>
                      {f.lb&&f.depth<midD&&<text x={f.cx} y={f.cy} fill="#FFF" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">{f.lb}</text>}
                    </g>
                  ))}
                </g>
                {/* 矢印: ビュー回転を3D投影で正確に反映 */}
                <circle cx={gc} cy={gc} r={3} fill="#FFF" stroke="#000" strokeWidth={0.8}/>
                <line x1={gc} y1={gc} x2={gc+xx*arL} y2={gc+xy*arL} stroke="#F87171" strokeWidth={1.8} strokeLinecap="round"/>
                {ah(xx*arL,xy*arL,'#F87171')}
                <text x={gc+xx*(arL+11)} y={gc+xy*(arL+11)} fill="#F87171" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">X</text>
                <line x1={gc} y1={gc} x2={gc+zx*arL} y2={gc+zy*arL} stroke="#60A5FA" strokeWidth={2} strokeLinecap="round"/>
                {ah(zx*arL,zy*arL,'#60A5FA')}
                <text x={gc+zx*(arL+11)} y={gc+zy*(arL+11)} fill="#60A5FA" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">Z</text>
              </svg>
            </div>
          );
        })()}
        </div>{/* position:relative wrapper elev */}
        </div>{/* flex-column wrapper elev */}
      </FloatWin>

      {/* 側面図ウィンドウ (Y-Z) */}
      <FloatWin id="side" title={`側面図 (Y-Z) x${sideZoom.toFixed(1)}`} winState={winState} setWinState={setWinState} bringFront={bringFront} overflow="hidden"
        onClose={() => setWinState(pr => ({ ...pr, side: { ...pr.side, hidden: true } }))}
        headerExtra={<>
          <button onClick={() => { setBldEditMode(m => !m); setSelectedBld(null); setBldDraw(null); setPolyPoints([]); setPolyMousePos(null); }}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: bldEditMode ? "#2563EB" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
            {bldEditMode ? "🏗 ON" : "🏗 建屋"}
          </button>
          <button onClick={() => setHSecMode(hSecMode === 'side' ? null : 'side')}
            style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: hSecMode === 'side' ? "#DC2626" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
            {hSecMode === 'side' ? "⊟ ON" : "⊟ 平面追加"}
          </button>
        </>}>
        <div style={{ display:'flex', flexDirection:'column', width:'100%', height:'100%' }}>
        {bldEditMode && <div style={{ padding: "3px 6px", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          <button onClick={() => { setBldDrawMode('rect'); setPolyPoints([]); setPolyMousePos(null); setBldDrawView('side'); }}
            style={{ padding: "2px 6px", border: "2px solid", borderColor: bldDrawMode === 'rect' && bldDrawView === 'side' ? "#2563EB" : "transparent", borderRadius: 4, cursor: "pointer", fontSize: 9, fontWeight: 700,
              background: bldDrawMode === 'rect' ? "#DBEAFE" : "#E2E8F0", color: bldDrawMode === 'rect' ? "#1D4ED8" : "#475569" }}>
            ▭矩形
          </button>
          <span style={{ fontSize: 7, color: "#94A3B8" }}>Y-Z範囲→建屋作成</span>
        </div>}
        <div style={{ position:'relative', flex:1, overflow:'hidden', minHeight:0 }}>
        <div style={{ overflow:'auto', width:'100%', height:'100%' }}>
        <div style={{ padding: VIEW_PAD, display: 'inline-block', lineHeight: 0 }}
          onMouseDown={e => {
            if (e.button !== 0 || bldEditMode || hSecMode === 'side') return;
            const scrollEl = sideRef.current?.parentElement?.parentElement;
            if (scrollEl) { e.preventDefault(); setViewPanDrag({ ref: sideRef, scrollEl, startX: e.clientX, startY: e.clientY, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop }); }
          }}>
        <div ref={sideRef}
          onDragOver={e => e.preventDefault()} onDrop={handleDrop("side")}
          onAuxClick={e => e.preventDefault()}
          onMouseDown={e => {
            if (e.button === 1) {
              e.preventDefault();
              const _sc = sideRef.current?.parentElement?.parentElement;
              const _sr = _sc ? _sc.getBoundingClientRect() : null;
              const _ox = _sr ? (_sc.scrollLeft + e.clientX - _sr.left - VIEW_PAD) / sideZoom : 0;
              const _oy = _sr ? (_sc.scrollTop  + e.clientY - _sr.top  - VIEW_PAD) / sideZoom : 0;
              setSideRotateOrigin({ x: _ox, y: _oy });
              setViewRotateDrag({ refId: 'side', startX: e.clientX, startRotate: sideRotate });
              return;
            }
            if (hSecMode === 'side' && e.button === 0) {
              e.preventDefault();
              const _r = sideRef.current?.getBoundingClientRect();
              const svgY = _r ? (e.clientY - _r.top) / sideZoom : e.clientY;
              setHSecPreview({ view: 'side', zPx: GL_Y - svgY });
              return;
            }
            if (bldEditMode && bldDrawMode === 'rect' && bldDrawView === 'side') {
              const target = e.target;
              if (target.getAttribute && target.getAttribute("data-bld-rect")) return;
              e.preventDefault();
              const p = toP(sideRef, e);
              const sy = snapV(p.x), sz = snapV(GL_Y - p.y);
              setBldDraw({ startH: sy, startV: sz, curH: sy, curV: sz, view: 'side' });
              setSelectedBld(null);
            } else if (!bldEditMode && e.button === 0) {
              const scrollEl = sideRef.current?.parentElement?.parentElement;
              if (scrollEl) {
                e.preventDefault();
                setViewPanDrag({ ref: sideRef, scrollEl, startX: e.clientX, startY: e.clientY, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop });
              }
            }
          }}
          onMouseMove={e => {
            if (hSecPreview?.view === 'side') {
              const _r = sideRef.current?.getBoundingClientRect();
              const svgY = _r ? (e.clientY - _r.top) / sideZoom : e.clientY;
              setHSecPreview(prev => prev ? { ...prev, zPx: GL_Y - svgY } : null);
              return;
            }
            if (bldDraw && bldDraw.view === 'side') {
              const p = toP(sideRef, e);
              setBldDraw(prev => prev ? { ...prev, curH: snapV(p.x), curV: snapV(GL_Y - p.y) } : null);
              return;
            }
            if (!iconDragging.current && !wpDragActiveRef.current && !viewPanDrag && !viewRotateDrag) {
              _jsHitDetect(e, sideRef, sideZoom, pt => ({ x: pt.y, y: GL_Y-(pt.z||0) }), setJsCursorSide);
            }
          }}
          onMouseLeave={() => { setHoverSeg(null); setWireTip(null); setJsCursorSide(null); }}
          onMouseUp={e => {
            if (hSecPreview?.view === 'side') {
              finishHSection(hSecPreview.zPx);
              setHSecPreview(null);
              return;
            }
            if (bldDraw && bldDraw.view === 'side') {
              const y1 = Math.min(bldDraw.startH, bldDraw.curH), y2 = Math.max(bldDraw.startH, bldDraw.curH);
              const z1 = Math.min(bldDraw.startV, bldDraw.curV), z2 = Math.max(bldDraw.startV, bldDraw.curV);
              if (Math.abs(y2 - y1) >= MINOR && Math.abs(z2 - z1) >= MINOR) {
                const xc = TW / 2, xh = 2 * MAJOR;
                const points = [{x:xc-xh,y:y1},{x:xc+xh,y:y1},{x:xc+xh,y:y2},{x:xc-xh,y:y2}];
                bldCounter.current++;
                const newId = `bld${bldCounter.current}`;
                const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
                setBuildings(prev => [...prev, { id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
                  blocks: [{ points, zBottom: z1, zTop: z2 }] }]);
                setSelectedBld(newId);
              }
              setBldDraw(null);
            }
          }}
          style={{ position: "relative", width: SIDE_W + 30, height: SIDE_H, background: "#FEFEFE", touchAction: "none", cursor: hSecMode === 'side' ? "crosshair" : bldEditMode && bldDrawView === 'side' ? "crosshair" : viewRotateDrag?.refId === 'side' ? "grabbing" : viewPanDrag?.ref === sideRef ? "grabbing" : jsCursorSide || "grab", zoom: sideZoom, transform: `rotate(${sideRotate}deg)`, transformOrigin: `${sideRotateOrigin.x}px ${sideRotateOrigin.y}px` }}>
          <svg style={{ position: "absolute", inset: 0, width: SIDE_W + 30, height: SIDE_H, pointerEvents: "none" }}>
            {(() => {
              const ls = [];
              const _sz = sideZoom || 1;
              for (let y = 0; y <= TH; y += MAJOR) ls.push(<line key={`sv${y}`} x1={y} y1={0} x2={y} y2={SIDE_H} stroke="rgba(0,0,0,0.05)" strokeWidth={0.5/_sz} />);
              for (let z = MIN_Z; z <= MAX_Z; z += MAJOR) { const sy = GL_Y - z; const label = z < 0 ? `B${Math.round(-z / MAJOR)}` : `${Math.round(z / MAJOR)}F`; ls.push(<line key={`sh${z}`} x1={0} y1={sy} x2={SIDE_W} y2={sy} stroke={z === 0 ? "rgba(0,0,0,0.08)" : z < 0 ? "rgba(139,92,40,0.08)" : "rgba(0,0,0,0.05)"} strokeWidth={z === 0 ? 1/_sz : 0.5/_sz} />); ls.push(<text key={`sl${z}`} x={SIDE_W + 3} y={sy + 3} fontSize={6/_sz} fill={z < 0 ? "#A67C52" : "#94A3B8"}>{label}</text>); }
              ls.push(<line key="sgl" x1={0} y1={GL_Y} x2={SIDE_W} y2={GL_Y} stroke="#8B6914" strokeWidth={2 / _sz} />);
              hSections.forEach(hs => {
                const _liveZPx = hSecLiveZRef.current[hs.id] ?? hs.zPx;
                const sy = GL_Y - _liveZPx;
                // clipSecがある場合はそのYAABBに絞る（sideはY-Z平面）
                let lx1 = 0, lx2 = SIDE_W;
                if (hs.clipSec) {
                  const cs = hs.clipSec;
                  if (cs.center !== undefined) {
                    const { center: { y: cy }, halfA, halfB, pnRad } = cs;
                    const span = halfA * Math.abs(Math.sin(pnRad)) + halfB * Math.abs(Math.cos(pnRad));
                    lx1 = cy - span; lx2 = cy + span;
                  } else if (cs.rect) { lx1 = cs.rect.y1; lx2 = cs.rect.y2; }
                }
                if (hSecShowBand[hs.id]) ls.push(<rect key={`hsb-s${hs.id}`} x={lx1} y={sy - MAJOR/(2*_sz)} width={lx2-lx1} height={MAJOR/_sz} fill="rgba(0,0,0,0.08)" pointerEvents="none" />);
                ls.push(<line key={`hsi-s${hs.id}`} x1={lx1} y1={sy} x2={lx2} y2={sy} stroke="#1a1a1a" strokeWidth={1.5/_sz} pointerEvents="none" />);
                ls.push(<text key={`hsl-s${hs.id}`} x={lx1 + 4/_sz} y={sy - 3/_sz} fontSize={7/_sz} fill="#1a1a1a" fontWeight={700} pointerEvents="none">{hs.label}</text>);
                ls.push(<rect key={`hsh-s${hs.id}`} x={lx1} y={sy - 6/_sz} width={lx2-lx1} height={12/_sz}
                  fill="transparent" style={{cursor:'ns-resize'}} pointerEvents="all"
                  onMouseDown={e => { e.preventDefault(); e.stopPropagation();
                    if (hSecActiveDim && !hSecDrag) return;
                    hSecDragClientPos.current = { x: e.clientX, y: e.clientY }; setHSecActiveDim({id:hs.id}); setHSecDrag({id:hs.id, startClientX:e.clientX, startClientY:e.clientY, startZPx:_liveZPx, dZPerPx:1/_sz}); }} />);
              });
              // 側面図: hSec間の寸法バッジ（wireTip同スタイル）
              if (hSections.length >= 1) {
                const _mppV = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                const _allLvl = [{ id: 'GL', label: 'GL', zPx: 0 }, ...hSections.map(hs => ({ id: hs.id, label: hs.label, zPx: hSecLiveZRef.current[hs.id] ?? hs.zPx }))].sort((a, b) => a.zPx - b.zPx);
                const _bw = 56 / _sz, _bh = 13 / _sz, _br = 3 / _sz, _fs = 7 / _sz, _tk = 4 / _sz;
                const _bx = SIDE_W - _bw - 4 / _sz;
                for (let _di = 0; _di < _allLvl.length - 1; _di++) {
                  const _lo = _allLvl[_di], _hi = _allLvl[_di + 1];
                  const _sy_lo = GL_Y - _lo.zPx, _sy_hi = GL_Y - _hi.zPx;
                  const _midY = (_sy_lo + _sy_hi) / 2;
                  const _mm = Math.round(Math.abs(_hi.zPx - _lo.zPx) * _mppV * 1000);
                  const _isEdit = !hSecActiveDim && hSecEditDim?.hSecId === _hi.id && hSecEditDim?.refId === _lo.id;
                  ls.push(<line key={`dg-s${_di}`} x1={_bx+_bw/2} y1={_sy_hi} x2={_bx+_bw/2} y2={_sy_lo} stroke="#94A3B8" strokeWidth={0.8/_sz} strokeDasharray={`${3/_sz},${2/_sz}`} pointerEvents="none" />);
                  ls.push(<line key={`dta-s${_di}`} x1={_bx+_bw/2-_tk} y1={_sy_lo} x2={_bx+_bw/2+_tk} y2={_sy_lo} stroke="#64748B" strokeWidth={1/_sz} pointerEvents="none" />);
                  ls.push(<line key={`dtb-s${_di}`} x1={_bx+_bw/2-_tk} y1={_sy_hi} x2={_bx+_bw/2+_tk} y2={_sy_hi} stroke="#64748B" strokeWidth={1/_sz} pointerEvents="none" />);
                  if (_isEdit) {
                    const _fw = _bw, _fh = 16 / _sz;
                    ls.push(<foreignObject key={`dfo-s${_di}`} x={_bx} y={_midY - _fh/2} width={_fw} height={_fh}>
                      <input autoFocus defaultValue={_mm}
                        style={{ width: _fw * _sz + 'px', height: _fh * _sz + 'px', fontSize: 10, border: '1px solid #3B82F6', borderRadius: 2, padding: '0 3px', outline: 'none', background: '#FFF', transform: `scale(${1/_sz})`, transformOrigin: '0 0' }}
                        onKeyDown={ev => {
                          if (ev.key === 'Enter') {
                            const newMm = parseFloat(ev.target.value);
                            if (!isNaN(newMm) && newMm >= 0) {
                              const newZPx = _lo.zPx + newMm / 1000 / _mppV;
                              const newLabel = newZPx >= 0 ? `${Math.floor(newZPx / MAJOR) + 1}F` : `B${Math.ceil(-newZPx / MAJOR)}`;
                              setHSections(prev => prev.map(h => h.id === _hi.id ? { ...h, zPx: newZPx, label: newLabel } : h));
                            }
                            setHSecEditDim(null);
                          }
                          if (ev.key === 'Escape') setHSecEditDim(null);
                        }}
                        onBlur={() => setHSecEditDim(null)} />
                    </foreignObject>);
                  } else {
                    ls.push(<rect key={`dbg-s${_di}`} x={_bx} y={_midY - _bh/2} width={_bw} height={_bh} rx={_br} fill="rgba(30,41,59,0.82)" pointerEvents="all"
                      style={{ cursor: _hi.id !== 'GL' ? 'pointer' : 'default' }}
                      onClick={() => { if (_hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }} />);
                    ls.push(<text key={`dtx-s${_di}`} x={_bx + _bw/2} y={_midY + _fs * 0.38} fontSize={_fs} fill="#F1F5F9" fontWeight={600} textAnchor="middle"
                      style={{ cursor: _hi.id !== 'GL' ? 'pointer' : 'default' }} pointerEvents="all"
                      onClick={() => { if (_hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }}>
                      {_mm.toLocaleString()} mm
                    </text>);
                  }
                }
              }
              ls.push(<text key="sglt" x={SIDE_W + 3} y={GL_Y + 3} fontSize={6 / _sz} fontWeight={700} fill="#8B6914">GL</text>);
              // 地下背景
              ls.push(<rect key="sunderground" x={0} y={GL_Y} width={SIDE_W} height={SIDE_H - GL_Y} fill="rgba(139,105,20,0.04)" />);
              // 地下フィールド（z=-10m〜-160m、厚み150m）
              { const _ugY = GL_Y + 10;
                ls.push(<rect key="ug-slab-s" x={0} y={_ugY} width={SIDE_W} height={40} fill={_ugC(0.55)} />);
                ls.push(<line key="ug-floor-s" x1={0} y1={_ugY} x2={SIDE_W} y2={_ugY} stroke={_ugC(0.85)} strokeWidth={1.5 / _sz} />);
                ls.push(<line key="ug-bot-s" x1={0} y1={_ugY+40} x2={SIDE_W} y2={_ugY+40} stroke={_ugC(0.6)} strokeWidth={1 / _sz} />);
                ls.push(<text key="ug-floor-st" x={SIDE_W + 3} y={_ugY + 3} fontSize={6} fontWeight={600} fill={_ugFloor}>地下</text>);
              }
              // 建物（Y-Z断面）— 建屋ごとにグループ化（一体表示＋共有辺除去）
              const sBldGroups = {};
              flatBlocks.forEach((b, i) => {
                if (!sBldGroups[b.buildingId]) sBldGroups[b.buildingId] = [];
                sBldGroups[b.buildingId].push({ ...b, _idx: i });
              });
              Object.entries(sBldGroups).forEach(([bid, blocks]) => {
                const isSel = bldEditMode && selectedBld === bid;
                const rects = blocks.map(b => {
                  const zBot = b.zBottom || 0, zT = b.zTop;
                  return { x1: b.pxMinY, y1: GL_Y - zT, x2: b.pxMaxY, y2: GL_Y - zBot, zBot, zT, b };
                });
                const pathD = rects.map(r => `M${r.x1},${r.y1}L${r.x2},${r.y1}L${r.x2},${r.y2}L${r.x1},${r.y2}Z`).join(" ");
                ls.push(<path key={`sbf${bid}`} data-bld-rect="1" d={pathD} fill={blocks[0].color}
                  opacity={isSel ? 0.35 : 0.18} fillRule="nonzero" stroke="none"
                  style={{ pointerEvents: "auto", cursor: "pointer" }}
                  onMouseEnter={() => { if (!bldEditMode) { setHovBldId(bid); setHovBldView('side'); } }}
                  onMouseLeave={() => { if (!bldEditMode) { setHovBldId(null); setHovBldView(null); } }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (bldEditMode) { setSelectedBld(bid); setSelectedBldView('side'); }
                    else {
                      const _nsel = selectedBld === bid ? null : bid;
                      setSelectedBld(_nsel); setSelectedBldView(_nsel ? 'side' : null);
                    }
                  }} />);
                rects.forEach((r, ri) => {
                  const edges = [
                    { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y1, axis: 'h', pos: r.y1, a: r.x1, b_: r.x2 },
                    { x1: r.x1, y1: r.y2, x2: r.x2, y2: r.y2, axis: 'h', pos: r.y2, a: r.x1, b_: r.x2 },
                    { x1: r.x1, y1: r.y1, x2: r.x1, y2: r.y2, axis: 'v', pos: r.x1, a: r.y1, b_: r.y2 },
                    { x1: r.x2, y1: r.y1, x2: r.x2, y2: r.y2, axis: 'v', pos: r.x2, a: r.y1, b_: r.y2 },
                  ];
                  edges.forEach((e, ei) => {
                    const isShared = rects.some((or, ori) => {
                      if (ori === ri) return false;
                      const oEdges = [
                        { axis: 'h', pos: or.y1, a: or.x1, b_: or.x2 }, { axis: 'h', pos: or.y2, a: or.x1, b_: or.x2 },
                        { axis: 'v', pos: or.x1, a: or.y1, b_: or.y2 }, { axis: 'v', pos: or.x2, a: or.y1, b_: or.y2 },
                      ];
                      return oEdges.some(oe => oe.axis === e.axis && Math.abs(oe.pos - e.pos) < 1 &&
                        Math.min(e.a, e.b_) < Math.max(oe.a, oe.b_) && Math.min(oe.a, oe.b_) < Math.max(e.a, e.b_));
                    });
                    if (!isShared) ls.push(<line key={`sbl${bid}${ri}${ei}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                      stroke={isSel ? "#3B82F6" : blocks[0].color} strokeWidth={isSel ? 2/_sz : 1/_sz} pointerEvents="none"
                      strokeDasharray={r.zBot < 0 ? "3,2" : "none"} />);
                  });
                });
                if (isSel) {
                  rects.forEach((r, ri) => {
                    const b = r.b;
                    ls.push(<line key={`sht${bid}${ri}`} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y1}
                      stroke="#3B82F6" strokeWidth={6/_sz} opacity={0.4} style={{cursor:"ns-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'zTop',startMouse:ev.clientY,origVal:r.zT,view:'side'});}} />);
                    ls.push(<line key={`shb${bid}${ri}`} x1={r.x1} y1={r.y2} x2={r.x2} y2={r.y2}
                      stroke="#3B82F6" strokeWidth={6/_sz} opacity={0.4} style={{cursor:"ns-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'zBottom',startMouse:ev.clientY,origVal:r.zBot,view:'side'});}} />);
                    ls.push(<line key={`shl${bid}${ri}`} x1={r.x1} y1={r.y1} x2={r.x1} y2={r.y2}
                      stroke="#3B82F6" strokeWidth={6/_sz} opacity={0.4} style={{cursor:"ew-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'yMin',startMouse:ev.clientX,origVal:b.pxMinY,origPoints:b.points.map(p=>({...p})),view:'side'});}} />);
                    ls.push(<line key={`shr${bid}${ri}`} x1={r.x2} y1={r.y1} x2={r.x2} y2={r.y2}
                      stroke="#3B82F6" strokeWidth={6/_sz} opacity={0.4} style={{cursor:"ew-resize",pointerEvents:"auto"}}
                      onMouseDown={ev=>{ev.stopPropagation();ev.preventDefault();setBldAction({type:'resize',bid,bi:b.blockIdx,field:'yMax',startMouse:ev.clientX,origVal:b.pxMaxY,origPoints:b.points.map(p=>({...p})),view:'side'});}} />);
                  });
                }
                // 建屋バッジはSVG外HTMLオーバーレイで描画
              });
              // hSecPreviewプレビュー線（side）
              if (hSecPreview?.view === 'side') {
                const _psy = GL_Y - hSecPreview.zPx;
                const _pl = `${Math.floor(hSecPreview.zPx / MAJOR) + 1}F`;
                ls.push(<line key="hsp-s" x1={0} y1={_psy} x2={SIDE_W} y2={_psy} stroke="#1a1a1a" strokeWidth={2/_sz} strokeDasharray={`${5/_sz},${3/_sz}`} pointerEvents="none" />);
                ls.push(<text key="hspl-s" x={4/_sz} y={_psy - 4/_sz} fontSize={8/_sz} fill="#1a1a1a" fontWeight={700} pointerEvents="none">{_pl}</text>);
              }
              return ls;
            })()}
          </svg>
          {/* 側面図ゴースト描画 */}
          {bldDraw && bldDraw.view === 'side' && (() => {
            const h1 = Math.min(bldDraw.startH, bldDraw.curH), h2 = Math.max(bldDraw.startH, bldDraw.curH);
            const v1 = Math.min(bldDraw.startV, bldDraw.curV), v2 = Math.max(bldDraw.startV, bldDraw.curV);
            if (h2 - h1 < MINOR || v2 - v1 < MINOR) return null;
            return <div style={{ position: "absolute", left: h1, top: GL_Y - v2, width: h2 - h1, height: v2 - v1,
              border: "2px dashed #3B82F6", background: "rgba(59,130,246,0.1)", borderRadius: 2, pointerEvents: "none", zIndex: 20 }} />;
          })()}
          <svg style={{ position: "absolute", inset: 0, width: SIDE_W + 30, height: SIDE_H, zIndex: 5, pointerEvents: "none" }}>
            {wpDrag?.view === "side" && Object.entries(allMapPos).map(([nid, np]) => {
              const isSnapped = wpSnapIconRef.current === nid;
              return <line key={nid} x1={np.y} y1={0} x2={np.y} y2={SIDE_H}
                stroke={isSnapped ? "#3B82F6" : "rgba(59,130,246,0.3)"}
                strokeWidth={isSnapped ? 1.5 / (sideZoom || 1) : 0.8 / (sideZoom || 1)}
                strokeDasharray={isSnapped ? "none" : `${4 / (sideZoom||1)},${3 / (sideZoom||1)}`}
                pointerEvents="none" />;
            })}
            {wpDrag?.view === "side" && wpPerpSnapRef.current?.map((m, i) => {
              const { svgX, svgY, dAx, dAy, dBx, dBy } = m;
              const sz = 14 / (sideZoom || 1);
              const P1=[svgX-dAx*sz,svgY-dAy*sz],P2=[svgX-dAx*sz+dBx*sz,svgY-dAy*sz+dBy*sz],P3=[svgX+dBx*sz,svgY+dBy*sz];
              return <path key={i} d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                fill="none" stroke="#3B82F6" strokeWidth={1.5/(sideZoom||1)} pointerEvents="none" />;
            })}
            {sideDrag && iconPerpSnapRef.current && (() => {
              const { svgX, svgY, dAx, dAy, dBx, dBy } = iconPerpSnapRef.current;
              const sz = 14 / (sideZoom || 1);
              const P1 = [svgX - dAx*sz, svgY - dAy*sz];
              const P2 = [svgX - dAx*sz + dBx*sz, svgY - dAy*sz + dBy*sz];
              const P3 = [svgX + dBx*sz, svgY + dBy*sz];
              return <path d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                fill="none" stroke="#3B82F6" strokeWidth={1.5/(sideZoom||1)} pointerEvents="none" />;
            })()}
            {sideDrag && Object.entries(segWp).flatMap(([sid, wps]) => wps.map((wp, i) => {
              const key = `${sid}_${i}`;
              const isSnapped = iconSnapWpRef.current === key;
              return <line key={key} x1={wp.y} y1={0} x2={wp.y} y2={SIDE_H}
                stroke={isSnapped ? "#3B82F6" : "rgba(59,130,246,0.3)"}
                strokeWidth={isSnapped ? 1.5 / (sideZoom || 1) : 0.8 / (sideZoom || 1)}
                strokeDasharray={isSnapped ? "none" : `${4 / (sideZoom||1)},${3 / (sideZoom||1)}`}
                pointerEvents="none" />;
            }))}
            <g style={{ pointerEvents: "auto" }}>{renderSegs("side", sideRef, p => ({ x: p.y, y: GL_Y - (p.z || 0) }), { wireOnly: true })}</g>
          </svg>
          {renderNodes("side", sideRef)}
          <svg style={{ position: "absolute", inset: 0, width: SIDE_W + 30, height: SIDE_H, zIndex: 15, overflow: "visible", pointerEvents: "none" }}>
            <g>{renderSegs("side", sideRef, p => ({ x: p.y, y: GL_Y - (p.z || 0) }), { wpOnly: true })}</g>
          </svg>
          {/* 建屋選択バッジ（側面図）: クリック選択時のみ表示、zoom逆補正でサイズ一定 */}
          {selectedBld && selectedBldView === 'side' && !bldEditMode && (() => {
            const _bb = flatBlocks.filter(b => b.buildingId === selectedBld);
            if (_bb.length === 0) return null;
            const _yMn = Math.min(..._bb.map(b => b.pxMinY)), _yMx = Math.max(..._bb.map(b => b.pxMaxY));
            const _zT = Math.max(..._bb.map(b => b.zTop));
            return renderBldBadgesHTML(selectedBld, (_yMn + _yMx) / 2, GL_Y - _zT, 1 / sideZoom);
          })()}
        </div>
        </div>{/* VIEW_PAD wrapper */}
        </div>{/* inner scroll container side */}
        {/* 方位インジケーター: 側面図（PN/y・Z） 3次元図同デザイン */}
        {(() => {
          const gc=40, cs=16, arL=30, mpp=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:1;
          const pnRad=plantNorthAngle*Math.PI/180;
          const cAz=-Math.PI/2, cEl=0;
          const aAz=-sideRotate*Math.PI/180-Math.PI/2, aEl=0;
          const cp0=project3D(TW/2,TH/2,0,cAz,cEl,1,0,0);
          const mkV=(a,b,c)=>{
            const wcx=(a*Math.cos(pnRad)+b*Math.sin(pnRad))*cs, wcy=(-a*Math.sin(pnRad)+b*Math.cos(pnRad))*cs;
            const p=project3D(TW/2+wcx,TH/2-wcy,c*cs*mpp,cAz,cEl,1,0,0);
            return{sx:gc+(p.x-cp0.x),sy:gc+(p.y-cp0.y),d:p.depth};
          };
          const v=[mkV(-1,-1,-1),mkV(+1,-1,-1),mkV(-1,+1,-1),mkV(+1,+1,-1),mkV(-1,-1,+1),mkV(+1,-1,+1),mkV(-1,+1,+1),mkV(+1,+1,+1)];
          const fd=[
            {vi:[1,3,7,5],b:'#EF4444',dk:'#991B1B',lb:''},{vi:[0,4,6,2],b:'#7F1D1D',dk:'#450A0A',lb:''},
            {vi:[2,3,7,6],b:'#22C55E',dk:'#14532D',lb:''},{vi:[0,1,5,4],b:'#166534',dk:'#052E16',lb:''},
            {vi:[4,5,7,6],b:'#3B82F6',dk:'#1E3A8A',lb:''},{vi:[0,1,3,2],b:'#1E3A8A',dk:'#0F172A',lb:''},
          ];
          const faces=fd.map(f=>({...f,depth:f.vi.reduce((s,i)=>s+v[i].d,0)/4,pts:f.vi.map(i=>`${v[i].sx.toFixed(1)},${v[i].sy.toFixed(1)}`).join(' '),cx:f.vi.reduce((s,i)=>s+v[i].sx,0)/4,cy:f.vi.reduce((s,i)=>s+v[i].sy,0)/4})).sort((a,bb)=>bb.depth-a.depth);
          const midD=(Math.min(...faces.map(f=>f.depth))+Math.max(...faces.map(f=>f.depth)))/2;
          const nrm=(dx,dy)=>{const l=Math.sqrt(dx*dx+dy*dy)||1;return[dx/l,dy/l];};
          const ap0=project3D(TW/2,TH/2,0,aAz,aEl,1,0,0);
          const pZ=project3D(TW/2,TH/2,mpp,aAz,aEl,1,0,0);
          const pPN=project3D(TW/2+Math.sin(pnRad),TH/2-Math.cos(pnRad),0,aAz,aEl,1,0,0);
          const [zx,zy]=nrm(pZ.x-ap0.x,pZ.y-ap0.y),[pnx,pny]=nrm(pPN.x-ap0.x,pPN.y-ap0.y);
          const ah=(dx,dy,col)=>{const l=Math.sqrt(dx*dx+dy*dy)||1,ux=dx/l,uy=dy/l,hx=gc+dx,hy=gc+dy,w=3.5,hl=7;return<polygon key={`ah${col}`} points={`${hx},${hy} ${hx-ux*hl-uy*w},${hy-uy*hl+ux*w} ${hx-ux*hl+uy*w},${hy-uy*hl-ux*w}`} fill={col}/>;};
          return(
            <div style={{position:'absolute',top:6,right:50,zIndex:25}}>
              <svg width={80} height={80} style={{overflow:'visible'}}>
                {/* キューブ面: その場で2D回転（面切替なし） */}
                <g transform={`rotate(${-sideRotate}, ${gc}, ${gc})`}>
                  {faces.map((f,i)=>(
                    <g key={`f${i}`}>
                      <polygon points={f.pts} fill={f.depth<midD?f.b:f.dk} stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9}/>
                      {f.lb&&f.depth<midD&&<text x={f.cx} y={f.cy} fill="#FFF" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">{f.lb}</text>}
                    </g>
                  ))}
                </g>
                {/* 矢印: ビュー回転を3D投影で正確に反映 */}
                <circle cx={gc} cy={gc} r={3} fill="#FFF" stroke="#000" strokeWidth={0.8}/>
                <line x1={gc} y1={gc} x2={gc+pnx*arL} y2={gc+pny*arL} stroke="#4ADE80" strokeWidth={2} strokeLinecap="round"/>
                {ah(pnx*arL,pny*arL,'#4ADE80')}
                <text x={gc+pnx*(arL+11)} y={gc+pny*(arL+11)-7} fill="#4ADE80" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                  onClick={e=>{e.stopPropagation();setSidePnOpen(v=>!v);}} style={{cursor:'pointer'}}>PN</text>
                <text x={gc+pnx*(arL+11)} y={gc+pny*(arL+11)+7} fill="#4ADE80" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                  onClick={e=>{e.stopPropagation();setSidePnOpen(v=>!v);}} style={{cursor:'pointer'}}>y</text>
                <line x1={gc} y1={gc} x2={gc+zx*arL} y2={gc+zy*arL} stroke="#60A5FA" strokeWidth={2} strokeLinecap="round"/>
                {ah(zx*arL,zy*arL,'#60A5FA')}
                <text x={gc+zx*(arL+11)} y={gc+zy*(arL+11)} fill="#60A5FA" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">Z</text>
              </svg>
              {sidePnOpen && (
                <div onMouseDown={e=>e.stopPropagation()} style={{marginTop:4,background:'rgba(15,23,42,0.72)',borderRadius:4,padding:'3px 5px'}}>
                  <div style={{display:'flex',alignItems:'center',gap:3}}>
                    <input type="text" inputMode="numeric" autoFocus onFocus={e=>e.target.select()} value={plantNorthInput}
                      onChange={e=>setPlantNorthInput(e.target.value)}
                      onBlur={e=>{const n=((Number(e.target.value)%360)+360)%360;const safe=isNaN(n)?0:n;setPlantNorthAngle(safe);setPlantNorthInput(String(safe));}}
                      onKeyDown={e=>{if(e.key==='Enter'){const n=((Number(e.target.value)%360)+360)%360;const safe=isNaN(n)?0:n;setPlantNorthAngle(safe);setPlantNorthInput(String(safe));}}}
                      style={{width:36,fontSize:9,padding:'1px 3px',background:'rgba(255,255,255,0.18)',border:'1px solid rgba(255,255,255,0.35)',borderRadius:3,color:'#FCD34D',textAlign:'center'}}/>
                    <span style={{fontSize:7,color:'#94A3B8'}}>°</span>
                  </div>
                  <div style={{display:'flex',justifyContent:'center',gap:4,marginTop:2}}>
                    <button onClick={()=>{const n=((plantNorthAngle+1)%360+360)%360;setPlantNorthAngle(n);setPlantNorthInput(String(n));}}
                      style={{fontSize:8,lineHeight:1,padding:'1px 8px',background:'rgba(255,255,255,0.15)',border:'none',borderRadius:2,color:'#FCD34D',cursor:'pointer'}}>▲</button>
                    <button onClick={()=>{const n=((plantNorthAngle-1+360)%360);setPlantNorthAngle(n);setPlantNorthInput(String(n));}}
                      style={{fontSize:8,lineHeight:1,padding:'1px 8px',background:'rgba(255,255,255,0.15)',border:'none',borderRadius:2,color:'#FCD34D',cursor:'pointer'}}>▼</button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        </div>{/* position:relative wrapper side */}
        </div>{/* flex-column wrapper side */}
      </FloatWin>

      {/* 3次元図ウィンドウ */}
      <FloatWin id="cab" title="3次元図" winState={winState} setWinState={setWinState} bringFront={bringFront} overflow="hidden"
        headerExtra={
          <>
            <button onClick={() => {
              const next = !cabSecMode;
              setCabSecMode(next);
              if (next) { focusCabTopView(); setSecDrawing(null); if (secMode) setSecMode(false); }
              else setSecDrawing(null);
            }} style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
              background: cabSecMode ? "#DC2626" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
              {cabSecMode ? "✂ ON" : "✂ 矢視追加"}
            </button>
          </>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
        <div ref={cabRef}
          onDragOver={e => e.preventDefault()} onDrop={handleDrop("cab")}
          onMouseDown={e => { cabRef._clickDown = { x: e.clientX, y: e.clientY }; }}
          onMouseMove={e => {
            if (!cabSecMode || !secDrawing) return;
            const rect = cabRef.current.getBoundingClientRect();
            const scale = Math.min(rect.width / CAB_W, rect.height / CAB_H);
            const offX = (rect.width - CAB_W * scale) / 2, offY = (rect.height - CAB_H * scale) / 2;
            const svgX = (e.clientX - rect.left - offX) / scale;
            const svgY = (e.clientY - rect.top - offY) / scale;
            const p = unproject3D(svgX, svgY, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
            setSecDrawing(prev => prev ? { ...prev, cur: snap(p.x, p.y) } : null);
          }}
          onClick={e => {
            if (cabSecMode) {
              e.preventDefault();
              const d = cabRef._clickDown;
              if (d && (Math.abs(e.clientX - d.x) > 5 || Math.abs(e.clientY - d.y) > 5)) return;
              const rect = cabRef.current.getBoundingClientRect();
              const scale = Math.min(rect.width / CAB_W, rect.height / CAB_H);
              const offX = (rect.width - CAB_W * scale) / 2, offY = (rect.height - CAB_H * scale) / 2;
              const svgX = (e.clientX - rect.left - offX) / scale;
              const svgY = (e.clientY - rect.top - offY) / scale;
              const raw = unproject3D(svgX, svgY, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
              const sp = snap(raw.x, raw.y);
              if (!secDrawing) {
                setSecDrawing({ phase: 1, p1: sp, cur: sp });
              } else if (secDrawing.phase === 1) {
                const r = rectOf(secDrawing.p1, sp);
                if (r.x2 - r.x1 >= MINOR && r.y2 - r.y1 >= MINOR)
                  setSecDrawing({ phase: 2, p1: secDrawing.p1, p2: sp, cur: sp });
              } else if (secDrawing.phase === 2) {
                const _pnRadNow = plantNorthAngleRef.current * Math.PI / 180;
                const edge = nearestEdgeOBB(secDrawing.p1, secDrawing.p2, sp, _pnRadNow);
                finishSection(secDrawing.p1, secDrawing.p2, edge);
                setSecDrawing(null);
                setCabSecMode(false);
              }
              return;
            }
            const d = cabRef._clickDown;
            if (!d) return;
            if (Math.abs(e.clientX - d.x) > 5 || Math.abs(e.clientY - d.y) > 5) return; // drag
            if (!e.target.closest('[data-bld-face]')) setCab3dArrow(null);
            // 配電盤UI要素(天頂面・扉等)は stopPropagation 済みのためここへは伝播しない。
            // 到達した時点で背景クリックが確定しているので、配電盤の選択も解除する
            // （旧: 配電盤配置レイヤーに全面pointerEvents:'all'のrectを置いて横取りしていたが、
            // 　これがアイコン等のクリックを一切奪ってしまうバグの原因だったため撤去し、ここへ統合した）。
            setSelectedPlacedPanelId(null); setSelectedDoorKey(null); setPanelDetailOpen(false);
          }}
          onContextMenu={e => {
            if (e.target.closest && e.target.closest("[data-node]")) return;
            if (drawMode && drawState) { e.preventDefault(); e.stopPropagation(); setDrawState(null); }
            else if (routeFilter) { e.preventDefault(); setRouteFilter(null); }
            else { e.preventDefault(); }
          }}
          style={{ position: "relative", flex: 1, width: '100%', minHeight: 0,
            background: "linear-gradient(180deg, #D4DDE8 0%, #E8ECF0 40%, #F0F3F6 100%)",
            touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
            cursor: drawMode ? "crosshair" : orbiting ? "grabbing" : panning ? "move" : axisDrag ? "grabbing" : "grab", overflow: 'hidden' }}>
          {/* 配電盤 Canvas（Z-buffer描画・zIndex37でSVGクリック判定層より下） */}
          <canvas ref={panelCanvasRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%', zIndex:37, pointerEvents:'none' }} />
          {/* 地下視点: 薄い土色オーバーレイ */}
          {camEl < 0 && <div style={{ position: "absolute", inset: 0, zIndex: 1, background: "rgba(90,50,20,0.18)", pointerEvents: "none" }} />}
          {/* 地下視点バッジ（右上・小さめ） */}
          {camEl < 0 && <div style={{ position: "absolute", top: 4, right: 4, zIndex: 26, background: "rgba(100,60,20,0.8)", color: "#FCD3A0", borderRadius: 4, padding: "2px 7px", fontSize: 8, fontWeight: 700, whiteSpace: "nowrap", pointerEvents: "none" }}>
            ▲地下視点
          </div>}
          {/* 方向軸ギズモ（右上）: 真北N・真X・Z + PN の4軸 */}
          {(() => {
            const len = 26, gc = 40;
            const pnRad = plantNorthAngle * Math.PI / 180;
            const p0  = project3D(TW/2, TH/2, 0, camAz, camEl, 1, 0, 0);
            const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
            // Z = 上方向
            const pZ   = project3D(TW/2, TH/2, mpp, camAz, camEl, 1, 0, 0);
            // PN (Y) = 真北からCW pnRad回転: grid(+sin,-cos)
            const pPN  = project3D(TW/2 + Math.sin(pnRad), TH/2 - Math.cos(pnRad), 0, camAz, camEl, 1, 0, 0);
            // X = PN⊥ (PN+90°CW): grid(+cos,+sin) — PNと連動して回転
            const pXpn = project3D(TW/2 + Math.cos(pnRad), TH/2 + Math.sin(pnRad), 0, camAz, camEl, 1, 0, 0);
            const nrm = (dx, dy) => { const l = Math.sqrt(dx*dx+dy*dy)||1; return [dx/l, dy/l]; };
            // 真北 N
            const pN  = project3D(TW/2, TH/2 - 1, 0, camAz, camEl, 1, 0, 0);
            const [nx,ny]  = nrm(pN.x  -p0.x, pN.y  -p0.y);
            const [zx,zy]  = nrm(pZ.x  -p0.x, pZ.y  -p0.y);
            const [pnx,pny]= nrm(pPN.x -p0.x, pPN.y -p0.y);
            const [xx,xy]  = nrm(pXpn.x-p0.x, pXpn.y-p0.y); // X = PN⊥
            const applyPN = (v) => {
              const n = ((Number(v) % 360) + 360) % 360;
              if (!isNaN(n)) { setPlantNorthAngle(n); setPlantNorthInput(String(n)); }
            };
            return (
              <div data-pn-gizmo="true" style={{ position: "absolute", top: 30, right: 30, zIndex: 20 }}>
                {/* 立方体ギズモ: PNベース座標系で回転 */}
                {(() => {
                  // cubeScale=16でworld→画面スケールを合わせる
                  const cubeScale = 16;
                  // PNベースの座標軸で頂点変換（PN変更時に立方体も回転）
                  // plant(a=X,b=Y=PN,c=Z) → world: cx=a*cos-b*sin, cy=a*sin+b*cos (CW rotation)
                  const mkV = (a, b, c) => {
                    const wcx = (a * Math.cos(pnRad) + b * Math.sin(pnRad)) * cubeScale;
                    const wcy = (-a * Math.sin(pnRad) + b * Math.cos(pnRad)) * cubeScale;
                    const p = project3D(TW/2 + wcx, TH/2 - wcy, c * cubeScale * mpp, camAz, camEl, 1, 0, 0);
                    return { sx: gc + (p.x - p0.x), sy: gc + (p.y - p0.y), d: p.depth };
                  };
                  const v = [
                    mkV(-1,-1,-1), mkV(+1,-1,-1), mkV(-1,+1,-1), mkV(+1,+1,-1), // 0-3: z=-
                    mkV(-1,-1,+1), mkV(+1,-1,+1), mkV(-1,+1,+1), mkV(+1,+1,+1), // 4-7: z=+
                  ];
                  // 6面: X=赤, Y/PN=オレンジ, Z=青  + id（クリック判定用）
                  const faceDefs = [
                    { id:'px', vi:[1,3,7,5], bright:'#EF4444', dark:'#991B1B', label:'X'  }, // +X
                    { id:'mx', vi:[0,4,6,2], bright:'#7F1D1D', dark:'#450A0A', label:'-X' }, // -X
                    { id:'py', vi:[2,3,7,6], bright:'#22C55E', dark:'#14532D', label:'PN' }, // +Y(PN) 緑
                    { id:'my', vi:[0,1,5,4], bright:'#166534', dark:'#052E16', label:'-PN'}, // -Y 緑暗
                    { id:'pz', vi:[4,5,7,6], bright:'#3B82F6', dark:'#1E3A8A', label:'Z'  }, // +Z
                    { id:'mz', vi:[0,1,3,2], bright:'#1E3A8A', dark:'#0F172A', label:'-Z' }, // -Z
                  ];
                  // 各面の平均depth → 降順ソート（奥から描画）
                  const faces = faceDefs.map(f => ({
                    ...f,
                    depth: f.vi.reduce((s,i) => s + v[i].d, 0) / 4,
                    pts: f.vi.map(i => `${v[i].sx.toFixed(1)},${v[i].sy.toFixed(1)}`).join(' '),
                    cxF: f.vi.reduce((s,i) => s + v[i].sx, 0) / 4,
                    cyF: f.vi.reduce((s,i) => s + v[i].sy, 0) / 4,
                  })).sort((a,b) => b.depth - a.depth);
                  // 最小depth = 最手前の3面のみラベル表示
                  const minD = Math.min(...faces.map(f => f.depth));
                  const maxD = Math.max(...faces.map(f => f.depth));
                  const midD = (minD + maxD) / 2;
                  const arL = len + 4; // 矢印長（立方体の外に出る）
                  const arrHead = (x1,y1,dx,dy,col) => {
                    const l=Math.sqrt(dx*dx+dy*dy)||1, ux=dx/l, uy=dy/l;
                    const hx=x1+dx, hy=y1+dy;
                    const w=3.5, hl=7;
                    return <polygon key={`ah${col}`}
                      points={`${hx},${hy} ${hx-ux*hl-uy*w},${hy-uy*hl+ux*w} ${hx-ux*hl+uy*w},${hy-uy*hl-ux*w}`}
                      fill={col} />;
                  };
                  return (
                    <svg width={80} height={80} style={{ overflow: "visible", pointerEvents: "auto", cursor: gizmoGrabbing ? "grabbing" : "grab" }}
                      onMouseDown={e => {
                        if (e.button !== 0) return;
                        e.preventDefault(); e.stopPropagation();
                        setGizmoGrabbing(true);
                        // gizmoInteractionRef: クリック判定用データ
                        gizmoInteractionRef.current = { startX: e.clientX, startY: e.clientY, faces, midD, gc, svgEl: e.currentTarget, pnRad };
                        // 直近mouseup座標をpivotにしてorbitingを開始
                        // pivot決定は中ボタンorbitと同一ヘルパー（pickOrbitPivot）に一本化。
                        // 旧: unproject3D+クランプは地面z=0固定で真横視点(sinE≈0)に発散していた。
                        const up = lastCabUpRef.current;
                        const piv = pickOrbitPivot(up.x, up.y, camAzRef.current, camElRef.current,
                          camZoomRef.current, camPanXRef.current, camPanYRef.current, placedPanelsRef.current);
                        const pivScr = project3D(piv.x, piv.y, piv.z, camAzRef.current, camElRef.current, camZoomRef.current, camPanXRef.current, camPanYRef.current);
                        setOrbiting({ startX: e.clientX, startY: e.clientY, startAz: camAzRef.current, startEl: camElRef.current, startPanX: camPanXRef.current, startPanY: camPanYRef.current, pivotX: piv.x, pivotY: piv.y, pivotZ: piv.z, screenX: pivScr.x, screenY: pivScr.y });
                      }}>
                      {/* 立方体の面（奥→手前の順） */}
                      {faces.map((f,i) => (
                        <g key={`f${i}`}>
                          <polygon points={f.pts} fill={f.depth < midD ? f.bright : f.dark}
                            stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9} />
                          {f.label && f.depth < midD && (
                            <text x={f.cxF} y={f.cyF} fill="#FFF" fontSize={8}
                              textAnchor="middle" dominantBaseline="middle" fontWeight="700">{f.label}</text>
                          )}
                        </g>
                      ))}
                      {/* 中心点 */}
                      <circle cx={gc} cy={gc} r={3} fill="#FFF" stroke="#000" strokeWidth={0.8} />
                      {/* 矢印（常に手前・4本） */}
                      <line x1={gc} y1={gc} x2={gc+xx*arL} y2={gc+xy*arL} stroke="#F87171" strokeWidth={1.8} strokeLinecap="round" />
                      {arrHead(gc,gc,xx*arL,xy*arL,'#F87171')}
                      <text x={gc+xx*(arL+11)} y={gc+xy*(arL+11)} fill="#F87171" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">X</text>
                      <line x1={gc} y1={gc} x2={gc+nx*arL} y2={gc+ny*arL} stroke="#F97316" strokeWidth={1.8} strokeLinecap="round" />
                      {arrHead(gc,gc,nx*arL,ny*arL,'#F97316')}
                      <text x={gc+nx*(arL+11)} y={gc+ny*(arL+11)} fill="#F97316" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">N</text>
                      <line x1={gc} y1={gc} x2={gc+pnx*arL} y2={gc+pny*arL} stroke="#4ADE80" strokeWidth={2} strokeLinecap="round" />
                      {arrHead(gc,gc,pnx*arL,pny*arL,'#4ADE80')}
                      <text x={gc+pnx*(arL+11)} y={gc+pny*(arL+11)-7} fill="#4ADE80" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                        onClick={e => { e.stopPropagation(); setPnPanelOpen(v => !v); }} style={{ cursor:'pointer' }}>PN</text>
                      <text x={gc+pnx*(arL+11)} y={gc+pny*(arL+11)+7} fill="#4ADE80" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700">y</text>
                      <line x1={gc} y1={gc} x2={gc+zx*arL} y2={gc+zy*arL} stroke="#60A5FA" strokeWidth={2} strokeLinecap="round" />
                      {arrHead(gc,gc,zx*arL,zy*arL,'#60A5FA')}
                      <text x={gc+zx*(arL+11)} y={gc+zy*(arL+11)} fill="#60A5FA" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">Z</text>
                    </svg>
                  );
                })()}
                {/* PN調整パネル（キューブ内PNラベルクリックで開閉） */}
                {pnPanelOpen && (
                  <div style={{ marginTop: 4, background: 'rgba(15,23,42,0.72)', borderRadius: 4, padding: '3px 5px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <input
                        type="text" inputMode="numeric" autoFocus onFocus={e => e.target.select()}
                        value={plantNorthInput}
                        onChange={e => setPlantNorthInput(e.target.value)}
                        onBlur={e => {
                          const n = ((Number(e.target.value) % 360) + 360) % 360;
                          const safe = isNaN(n) ? 0 : n;
                          setPlantNorthAngle(safe); setPlantNorthInput(String(safe));
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const n = ((Number(e.target.value) % 360) + 360) % 360;
                            const safe = isNaN(n) ? 0 : n;
                            setPlantNorthAngle(safe); setPlantNorthInput(String(safe));
                          }
                        }}
                        style={{ width: 36, fontSize: 9, padding: '1px 3px', background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 3, color: '#FCD34D', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: 7, color: '#94A3B8' }}>°</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 2 }}>
                      <button onClick={() => { const n=((plantNorthAngle+1)%360+360)%360; setPlantNorthAngle(n); setPlantNorthInput(String(n)); }}
                        style={{ fontSize: 8, lineHeight:1, padding:'1px 8px', background:'rgba(255,255,255,0.15)', border:'none', borderRadius:2, color:'#FCD34D', cursor:'pointer' }}>▲</button>
                      <button onClick={() => { const n=((plantNorthAngle-1+360)%360); setPlantNorthAngle(n); setPlantNorthInput(String(n)); }}
                        style={{ fontSize: 8, lineHeight:1, padding:'1px 8px', background:'rgba(255,255,255,0.15)', border:'none', borderRadius:2, color:'#FCD34D', cursor:'pointer' }}>▼</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {/* 作図モード表示 */}
          {drawMode && <div style={{ position: "absolute", top: 30, left: "50%", transform: "translateX(-50%)", zIndex: 20, background: drawState ? "rgba(34,197,94,0.9)" : "rgba(34,197,94,0.7)", color: "#FFF", borderRadius: 6, padding: "3px 10px", fontSize: 8, fontWeight: 700 }}>
            {drawState ? `${drawState.sid} 作図中: クリック=直交折れ点追加 / ドラッグ=カメラ移動 / 右クリック=終了` : "対象の線をクリックして作図開始"}
          </div>}
          <div style={{ position: "absolute", bottom: 4, left: 4, zIndex: 20, fontSize: 7, color: "#64748B", background: "rgba(255,255,255,0.7)", borderRadius: 4, padding: "2px 6px" }}>
            右クリック=ルート選択 / ✏作図=直交スナップ連続作図
            {terrain && <span style={{ marginLeft: 8, color: "#16A34A" }}>
              地形: {terrain.minElevation.toFixed(1)}m〜{terrain.maxElevation.toFixed(1)}m
            </span>}
          </div>
          <svg viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {/* ground - 地形メッシュまたはフラット */}
            {(() => {
              const ls = [];
              // フィールドポリゴンまたは矩形の地面を描画
              const fieldPts = FIELD_POLY_GRID
                ? FIELD_POLY_GRID.map(p => proj(p.x, p.y, 0))
                : [[0, 0], [TW, 0], [TW, TH], [0, TH]].map(([x, y]) => proj(x, y, 0));
              if (terrainMesh) {
                terrainMesh.quads.forEach((q, i) => {
                  const p0 = proj(q.x0, q.y0, q.z0);
                  const p1 = proj(q.x1, q.y1, q.z1);
                  const p2 = proj(q.x2, q.y2, q.z2);
                  const p3 = proj(q.x3, q.y3, q.z3);
                  const pts = `${p0.x},${p0.y} ${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
                  ls.push(<polygon key={`tq${i}`} points={pts} fill={terrainColor(q.t)} opacity={0.7} stroke={terrainColor(q.t)} strokeWidth={0.5} />);
                });
                ls.push(<polygon key="gnd-outline" points={fieldPts.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#94A3B8" strokeWidth={1} />);
              } else {
                // 地面グリッド線はポリゴン(opacity0.96)に隠れるため _renderGround() 内に移動
              }
              // 地上・地下フィールドを深度ソートして描画
              // 地下フロア（z=-10）の深度 vs 地上（z=0）の深度で前後を自動判定
              const _ugZ = -10;
              const _ugBotZ = _ugZ - 40; // 厚み40m → 底面z=-50
              const _gndDepth = proj(TW/2, TH/2, 0).depth;
              const _ugDepth  = proj(TW/2, TH/2, _ugZ).depth;
              // 地下が奥（depth大）→ 先に描画し地上が手前で隠す / 地下が手前→ 後に描画
              const _renderUnderground = () => {
                const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                const _ugGX = Math.max(2, Math.round(TW * mpp / 10));
                const _ugGY = Math.max(2, Math.round(TH * mpp / 10));
                const _ugPts = [[0,0],[TW,0],[TW,TH],[0,TH]].map(([x,y]) => proj(x, y, _ugZ));
                const _ugEls = [];
                // 側面4枚（スラブの厚み）
                const _sides = [
                  [[0,0],[TW,0],[TW,0],[0,0]],   // 前面 y=0
                  [[TW,0],[TW,TH],[TW,TH],[TW,0]], // 右面 x=TW
                  [[0,TH],[TW,TH],[TW,TH],[0,TH]], // 後面 y=TH
                  [[0,0],[0,TH],[0,TH],[0,0]],     // 左面 x=0
                ];
                [
                  [[0,0],[TW,0]],   // 前面
                  [[TW,0],[TW,TH]], // 右面
                  [[TW,TH],[0,TH]], // 後面
                  [[0,TH],[0,0]],   // 左面
                ].forEach(([[x0,y0],[x1,y1]], si) => {
                  const a=proj(x0,y0,_ugZ),b=proj(x1,y1,_ugZ),c=proj(x1,y1,_ugBotZ),d=proj(x0,y0,_ugBotZ);
                  _ugEls.push(<polygon key={`ug-side${si}`} points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`} fill={_ugC(0.55)} stroke={_ugC(0.85)} strokeWidth={0.8} />);
                });
                // 底面
                const _botPts = [[0,0],[TW,0],[TW,TH],[0,TH]].map(([x,y]) => proj(x, y, _ugBotZ));
                _ugEls.push(<polygon key="ug-bot" points={_botPts.map(p=>`${p.x},${p.y}`).join(" ")} fill={_ugC(0.55)} stroke={_ugC(0.6)} strokeWidth={0.8} />);
                // 上面（トップ）
                _ugEls.push(<polygon key="ug-floor" points={_ugPts.map(p=>`${p.x},${p.y}`).join(" ")} fill={_ugC(0.55)} stroke={_ugC(0.9)} strokeWidth={1} />);
                if (camZoom >= 1) {
                  for (let gx = 0; gx <= _ugGX; gx++) {
                    const xi = Math.round(TW * gx / _ugGX);
                    const a = proj(xi, 0, _ugZ), b = proj(xi, TH, _ugZ);
                    _ugEls.push(<line key={`ug-gx${gx}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={_ugC(0.7)} strokeWidth={0.6} />);
                  }
                  for (let gy = 0; gy <= _ugGY; gy++) {
                    const yi = Math.round(TH * gy / _ugGY);
                    const a = proj(0, yi, _ugZ), b = proj(TW, yi, _ugZ);
                    _ugEls.push(<line key={`ug-gy${gy}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={_ugC(0.7)} strokeWidth={0.6} />);
                  }
                }
                return _ugEls;
              };
              const _renderGround = () => {
                // 不透明な下地はTW×TH全域（地下フィールドと同範囲）を塗りつぶして完全遮蔽
                const _twPts = [[0,0],[TW,0],[TW,TH],[0,TH]].map(([x,y]) => proj(x,y,0));
                const mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                const _gGX = Math.max(2, Math.round(TW * mpp / 10));
                const _gGY = Math.max(2, Math.round(TH * mpp / 10));
                const els = [
                  <polygon key="gnd-base" points={_twPts.map(p=>`${p.x},${p.y}`).join(" ")} fill="rgba(224,228,234,0.96)" />,
                  <polygon key="gnd" points={fieldPts.map(p=>`${p.x},${p.y}`).join(" ")} fill="rgba(255,220,50,0.08)" stroke="#EAB308" strokeWidth={1.5} />,
                ];
                // 地上グリッド（ズームイン時のみ表示）
                if (camZoom >= 1) {
                  for (let gx = 0; gx <= _gGX; gx++) {
                    const xi = Math.round(TW * gx / _gGX);
                    const a = proj(xi, 0, 0), b = proj(xi, TH, 0);
                    els.push(<line key={`gnd-gx${gx}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(100,110,130,0.35)" strokeWidth={0.6} />);
                  }
                  for (let gy = 0; gy <= _gGY; gy++) {
                    const yi = Math.round(TH * gy / _gGY);
                    const a = proj(0, yi, 0), b = proj(TW, yi, 0);
                    els.push(<line key={`gnd-gy${gy}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(100,110,130,0.35)" strokeWidth={0.6} />);
                  }
                }
                return els;
              };
              // 地下が奥にある（通常視点）→ 地下→地上の順で描画（地上が手前に重なる）
              if (_ugDepth >= _gndDepth) {
                _renderUnderground().forEach(e => ls.push(e));
                _renderGround().forEach(e => ls.push(e));
              } else {
                // 地下が手前（地下視点）→ 地上→地下の順で描画
                _renderGround().forEach(e => ls.push(e));
                _renderUnderground().forEach(e => ls.push(e));
              }
              // フィールド全体外枠（水色）
              const fp3d = [[0,0,0],[TW,0,0],[TW,TH,0],[0,TH,0]].map(([x,y,z]) => proj(x,y,z));
              ls.push(<polygon key="field-rect" points={fp3d.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke="rgba(6,182,212,0.8)" strokeWidth={1.5} />);

              return ls;
            })()}
            {/* buildings - ポリゴン押し出し: solidモデル未保有建物のみ（solidあり建物は下の solid描画で表示） */}
            {(() => {
              // solidモデルが存在する建物IDセット（それらはflatBlocks描画をスキップ）
              const _solidBldIds = new Set(solids.map(s => s.buildingId));
              const cabBldGroups = {};
              flatBlocks.filter(b => !_solidBldIds.has(b.buildingId)).forEach((b, i) => {
                if (!cabBldGroups[b.buildingId]) cabBldGroups[b.buildingId] = [];
                cabBldGroups[b.buildingId].push(b);
              });
              const lerpP = (a, b2, t) => ({ x: a.x + (b2.x - a.x) * t, y: a.y + (b2.y - a.y) * t });
              return Object.entries(cabBldGroups).flatMap(([bid, blocks]) => {
                const els = [];
                blocks.forEach((b, bi) => {
                  // カーブ子ブロックは親と統合描画 → スキップ
                  if (b._sharedWall) return;

                  const pp = b.points;
                  const pn = pp.length;
                  const carveKids = blocks.filter(cb => cb._sharedWall && cb._parentBlockIdx === b.blockIdx);

                  // === Z方向スライシング対応カーブレンダリング ===
                  const pZBot = b.zBottom || 0, pZTop = b.zTop;
                  const EPS_Z = 0.01;

                  // Z境界を収集
                  const zSet = new Set([pZBot, pZTop]);
                  carveKids.forEach(cb => {
                    zSet.add(cb.zBottom || 0);
                    zSet.add(cb.zTop);
                  });
                  const zLevels = [...zSet].filter(z => z >= pZBot - EPS_Z && z <= pZTop + EPS_Z).sort((a, b2) => a - b2);

                  // カーブ前処理
                  const EPS = 0.01;
                  const cdListAll = carveKids.map(cb => {
                    const cp = cb.points;
                    const pe = cb._sharedWall.parentEdge;
                    // 親Z境界へスナップ
                    let czBot = cb.zBottom || 0, czTop = cb.zTop;
                    if (Math.abs(czBot - pZBot) < 0.5) czBot = pZBot;
                    if (Math.abs(czTop - pZTop) < 0.5) czTop = pZTop;
                    return {
                      cp, pe, czBot, czTop,
                      c0Dup: Math.abs(cp[0].x - pp[pe].x) < EPS && Math.abs(cp[0].y - pp[pe].y) < EPS,
                      c3Dup: Math.abs(cp[3].x - pp[(pe + 1) % pn].x) < EPS && Math.abs(cp[3].y - pp[(pe + 1) % pn].y) < EPS,
                    };
                  }).sort((a, b2) => a.pe - b2.pe);

                  // 2直線の交点を計算（面ベースレンダリング用）
                  const lineIntersect3V = (ax, ay, bx, by, cx, cy, dx, dy) => {
                    const d = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx);
                    if (Math.abs(d) < 1e-10) return null;
                    const t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / d;
                    const x = ax + t * (bx - ax), y = ay + t * (by - ay);
                    if (!isFinite(x) || !isFinite(y)) return null;
                    return { x, y };
                  };

                  // ── SVG用カーブ間クリッピングヘルパー ──
                  const pointInQuad3V = (px, py, cp) => {
                    let pos = 0, neg = 0;
                    for (let i = 0; i < 4; i++) {
                      const j = (i + 1) % 4;
                      const cross = (cp[j].x - cp[i].x) * (py - cp[i].y) - (cp[j].y - cp[i].y) * (px - cp[i].x);
                      if (cross > 0) pos++; else if (cross < 0) neg++;
                    }
                    return pos === 0 || neg === 0;
                  };
                  const segQuadTs3V = (ax, ay, bx, by, cp) => {
                    const ts = [];
                    const sdx = bx - ax, sdy = by - ay;
                    const slen2 = sdx * sdx + sdy * sdy;
                    if (slen2 < 1e-12) return ts;
                    for (let i = 0; i < 4; i++) {
                      const j = (i + 1) % 4;
                      const ix = lineIntersect3V(ax, ay, bx, by, cp[i].x, cp[i].y, cp[j].x, cp[j].y);
                      if (!ix) continue;
                      const t = ((ix.x - ax) * sdx + (ix.y - ay) * sdy) / slen2;
                      const qdx = cp[j].x - cp[i].x, qdy = cp[j].y - cp[i].y;
                      const qlen2 = qdx * qdx + qdy * qdy;
                      const u = qlen2 > 1e-12 ? ((ix.x - cp[i].x) * qdx + (ix.y - cp[i].y) * qdy) / qlen2 : -1;
                      if (t > -0.01 && t < 1.01 && u > -0.01 && u < 1.01) ts.push(Math.max(0, Math.min(1, t)));
                    }
                    ts.sort((a2, b2) => a2 - b2);
                    // 重複除去: 四角形の頂点を通る場合
                    const deduped = [];
                    for (const t of ts) {
                      if (deduped.length === 0 || t - deduped[deduped.length - 1] > 0.005) deduped.push(t);
                    }
                    return deduped;
                  };
                  const clipSegOutside3V = (ax, ay, bx, by, sBot, sTop, otherCarves) => {
                    let intervals = [[0, 1]];
                    for (const oc of otherCarves) {
                      if (intervals.length === 0) break;
                      if (oc.czBot >= sTop - 0.01 || oc.czTop <= sBot + 0.01) continue;
                      const aIn = pointInQuad3V(ax, ay, oc.cp);
                      const bIn = pointInQuad3V(bx, by, oc.cp);
                      const crossTs = segQuadTs3V(ax, ay, bx, by, oc.cp);
                      let insides = [];
                      if (aIn && bIn) {
                        insides.push([0, 1]);
                      } else if (aIn && !bIn) {
                        if (crossTs.length >= 1) {
                          insides.push([0, crossTs[0]]);
                        } else {
                          let lo = 0, hi = 1;
                          for (let iter = 0; iter < 16; iter++) {
                            const mid = (lo + hi) / 2;
                            const mx = ax + mid * (bx - ax), my = ay + mid * (by - ay);
                            if (pointInQuad3V(mx, my, oc.cp)) lo = mid; else hi = mid;
                          }
                          if (hi > 0.005) insides.push([0, hi]);
                        }
                      } else if (!aIn && bIn) {
                        if (crossTs.length >= 1) {
                          insides.push([crossTs[crossTs.length - 1], 1]);
                        } else {
                          let lo = 0, hi = 1;
                          for (let iter = 0; iter < 16; iter++) {
                            const mid = (lo + hi) / 2;
                            const mx = ax + mid * (bx - ax), my = ay + mid * (by - ay);
                            if (pointInQuad3V(mx, my, oc.cp)) hi = mid; else lo = mid;
                          }
                          if (1 - lo > 0.005) insides.push([lo, 1]);
                        }
                      } else {
                        if (crossTs.length >= 2) {
                          const tm = (crossTs[0] + crossTs[crossTs.length - 1]) / 2;
                          const mx = ax + tm * (bx - ax), my = ay + tm * (by - ay);
                          if (pointInQuad3V(mx, my, oc.cp)) insides.push([crossTs[0], crossTs[crossTs.length - 1]]);
                        }
                      }
                      for (const [iS, iE] of insides) {
                        const next = [];
                        for (const [a0, a1] of intervals) {
                          if (a1 <= iS + 0.001 || a0 >= iE - 0.001) { next.push([a0, a1]); }
                          else {
                            if (a0 < iS - 0.001) next.push([a0, iS]);
                            if (a1 > iE + 0.001) next.push([iE, a1]);
                          }
                        }
                        intervals = next;
                      }
                    }
                    return intervals;
                  };

                  // 壁レンダリング関数（1スライス分）
                  const renderSliceWalls = (pts, sBot, sTop, sliceSkipEdge, sliceEdgeOpenings) => {
                    const n = pts.length;
                    const fp = pts.map(p => proj(p.x, p.y, sBot));
                    const rp = pts.map(p => proj(p.x, p.y, sTop));
                    const w = [];
                    for (let j = 0; j < n; j++) {
                      if (sliceSkipEdge && sliceSkipEdge.has(j)) continue;
                      const j2 = (j + 1) % n;
                      const p1 = pts[j], p2 = pts[j2];
                      // opening処理
                      const opens = sliceEdgeOpenings && sliceEdgeOpenings[j];
                      if (opens && opens.length > 0) {
                        const sorted2 = [...opens].sort((a, b2) => a.tMin - b2.tMin);
                        let prevT = 0;
                        sorted2.forEach(op => { if (op.tMin > prevT + 0.01) { const wPts = [lerpP(fp[j], fp[j2], prevT), lerpP(fp[j], fp[j2], op.tMin), lerpP(rp[j], rp[j2], op.tMin), lerpP(rp[j], rp[j2], prevT)]; const ax2 = wPts[1].x - wPts[0].x, ay2 = wPts[1].y - wPts[0].y, bx2 = wPts[3].x - wPts[0].x, by2 = wPts[3].y - wPts[0].y; w.push({ pts: wPts, isFront: (ax2 * by2 - ay2 * bx2) > 0 }); } prevT = op.tMax; });
                        if (prevT < 0.99) { const wPts = [lerpP(fp[j], fp[j2], prevT), fp[j2], rp[j2], lerpP(rp[j], rp[j2], prevT)]; const ax2 = wPts[1].x - wPts[0].x, ay2 = wPts[1].y - wPts[0].y, bx2 = wPts[3].x - wPts[0].x, by2 = wPts[3].y - wPts[0].y; w.push({ pts: wPts, isFront: (ax2 * by2 - ay2 * bx2) > 0 }); }
                        continue;
                      }
                      // 共有辺チェック
                      const isShared = blocks.some((ob) => {
                        if (ob.blockIdx === b.blockIdx || ob._sharedWall) return false;
                        const oZBot = ob.zBottom || 0, oZTop = ob.zTop;
                        if (Math.max(sBot, oZBot) >= Math.min(sTop, oZTop)) return false;
                        const oPts = ob.points;
                        for (let k = 0; k < oPts.length; k++) {
                          const q1 = oPts[k], q2 = oPts[(k + 1) % oPts.length];
                          if (Math.abs(p1.x - q2.x) < 1 && Math.abs(p1.y - q2.y) < 1 && Math.abs(p2.x - q1.x) < 1 && Math.abs(p2.y - q1.y) < 1) return true;
                          if (Math.abs(p1.x - q1.x) < 1 && Math.abs(p1.y - q1.y) < 1 && Math.abs(p2.x - q2.x) < 1 && Math.abs(p2.y - q2.y) < 1) return true;
                        }
                        return false;
                      });
                      if (isShared) continue;
                      const wallPts = [fp[j], fp[j2], rp[j2], rp[j]];
                      const ax = wallPts[1].x - wallPts[0].x, ay = wallPts[1].y - wallPts[0].y;
                      const bx_ = wallPts[3].x - wallPts[0].x, by_ = wallPts[3].y - wallPts[0].y;
                      w.push({ pts: wallPts, isFront: (ax * by_ - ay * bx_) > 0 });
                    }
                    return w;
                  };

                  // 各Zスライスを描画
                  const allWalls = [];
                  let topRoofPts = null;
                  for (let zi = 0; zi < zLevels.length - 1; zi++) {
                    const sBot = zLevels[zi], sTop = zLevels[zi + 1];
                    if (sTop - sBot < EPS_Z) continue;
                    const isTopSlice = sTop >= pZTop - EPS_Z;

                    // このZ範囲でアクティブなカーブ（スライス全体をカバー）
                    const active = cdListAll.filter(c => c.czBot <= sBot + EPS_Z && c.czTop >= sTop - EPS_Z);

                    if (active.length === 0) {
                      // カーブなし: 親矩形
                      allWalls.push(...renderSliceWalls(pp, sBot, sTop, null, null));
                    } else {
                      // ══ CSG面分類: 各カーブ辺を親辺と照合し統一的に処理 ══
                      const ptLineDist3V = (px, py, ax, ay, bx, by) => {
                        const edx = bx - ax, edy = by - ay;
                        const el = Math.sqrt(edx * edx + edy * edy);
                        if (el < 0.01) return Infinity;
                        return Math.abs((px - ax) * (-edy / el) + (py - ay) * (edx / el));
                      };

                      // ── 1. 面分類 ──
                      active.forEach(c => {
                        const edges = [
                          [c.cp[0], c.cp[1]],
                          [c.cp[1], c.cp[2]],
                          [c.cp[2], c.cp[3]],
                        ];
                        c._faceOn = [-1, -1, -1, c.pe];
                        for (let fi = 0; fi < 3; fi++) {
                          const [ea, eb] = edges[fi];
                          for (let pi = 0; pi < pn; pi++) {
                            if (pi === c.pe) continue;
                            const pa = pp[pi], pb2 = pp[(pi + 1) % pn];
                            const d0 = ptLineDist3V(ea.x, ea.y, pa.x, pa.y, pb2.x, pb2.y);
                            const d1 = ptLineDist3V(eb.x, eb.y, pa.x, pa.y, pb2.x, pb2.y);
                            if (d0 < 1.0 && d1 < 1.0) {
                              c._faceOn[fi] = pi;
                              break;
                            }
                          }
                        }
                      });

                      // ── 2. 親壁openings: _faceOnから統一算出 ──
                      const openE = {};
                      for (let ei = 0; ei < pn; ei++) {
                        const p0 = pp[ei], p1 = pp[(ei + 1) % pn];
                        const edx = p1.x - p0.x, edy = p1.y - p0.y;
                        const elen2 = edx * edx + edy * edy;
                        if (elen2 < 0.001) continue;
                        active.forEach(c => {
                          const cEdges = [
                            [c.cp[0], c.cp[1]],
                            [c.cp[1], c.cp[2]],
                            [c.cp[2], c.cp[3]],
                            [c.cp[3], c.cp[0]],
                          ];
                          for (let fi = 0; fi < 4; fi++) {
                            if (c._faceOn[fi] !== ei) continue;
                            const [ea, eb] = cEdges[fi];
                            const ta = ((ea.x - p0.x) * edx + (ea.y - p0.y) * edy) / elen2;
                            const tb = ((eb.x - p0.x) * edx + (eb.y - p0.y) * edy) / elen2;
                            if (!openE[ei]) openE[ei] = [];
                            openE[ei].push({ tMin: Math.min(ta, tb), tMax: Math.max(ta, tb) });
                          }
                        });
                      }

                      // ── 3. 親壁レンダリング ──
                      allWalls.push(...renderSliceWalls(pp, sBot, sTop, null, openE));

                      // ── 4. カーブ内壁: 壁の外側に固体がある部分だけ描画 ──
                      const edgeMap3V = {};
                      active.forEach(c => { edgeMap3V[c.pe] = c; });

                      // 壁の外向き法線（カーブ中心から離れる方向）
                      const wallOutNormal3V = (ax, ay, bx, by, ccx, ccy) => {
                        const dx = bx - ax, dy = by - ay;
                        const len = Math.sqrt(dx * dx + dy * dy);
                        if (len < 0.01) return { x: 0, y: 0 };
                        const nx = -dy / len, ny = dx / len;
                        const mx = (ax + bx) / 2, my = (ay + by) / 2;
                        const d1 = (mx + nx - ccx) ** 2 + (my + ny - ccy) ** 2;
                        const d2 = (mx - nx - ccx) ** 2 + (my - ny - ccy) ** 2;
                        return d1 > d2 ? { x: nx, y: ny } : { x: -nx, y: -ny };
                      };

                      const OFF3V = 1.0;
                      const addSolidInnerWall = (ax, ay, bx, by, sBotW, sTopW, otherCarves, outN) => {
                        const oax = ax + outN.x * OFF3V, oay = ay + outN.y * OFF3V;
                        const obx = bx + outN.x * OFF3V, oby = by + outN.y * OFF3V;
                        const segs = clipSegOutside3V(oax, oay, obx, oby, sBotW, sTopW, otherCarves);
                        for (const [t0, t1] of segs) {
                          if (t1 - t0 < 0.001) continue;
                          const x0 = ax + t0 * (bx - ax), y0 = ay + t0 * (by - ay);
                          const x1 = ax + t1 * (bx - ax), y1 = ay + t1 * (by - ay);
                          const fp0 = proj(x0, y0, sBotW), fp1 = proj(x1, y1, sBotW);
                          const rp0 = proj(x0, y0, sTopW), rp1 = proj(x1, y1, sTopW);
                          const wPts = [fp0, fp1, rp1, rp0];
                          const ax2 = wPts[1].x - wPts[0].x, ay2 = wPts[1].y - wPts[0].y;
                          const bx2 = wPts[3].x - wPts[0].x, by2 = wPts[3].y - wPts[0].y;
                          allWalls.push({ pts: wPts, isFront: (ax2 * by2 - ay2 * bx2) > 0 });
                        }
                      };

                      active.forEach(c => {
                        const otherCarves = active.filter(o => o !== c);
                        const ccx = (c.cp[0].x + c.cp[1].x + c.cp[2].x + c.cp[3].x) / 4;
                        const ccy = (c.cp[0].y + c.cp[1].y + c.cp[2].y + c.cp[3].y) / 4;
                        const prevPe = (c.pe - 1 + pn) % pn;
                        const nextPe = (c.pe + 1) % pn;
                        const adjPrev = edgeMap3V[prevPe];
                        const adjNext = edgeMap3V[nextPe];
                        let backFrom = c.cp[1], backTo = c.cp[2];
                        let skipSide0 = false, skipSide2 = false;
                        if (adjPrev) {
                          const ix = lineIntersect3V(c.cp[1].x, c.cp[1].y, c.cp[2].x, c.cp[2].y,
                            adjPrev.cp[1].x, adjPrev.cp[1].y, adjPrev.cp[2].x, adjPrev.cp[2].y);
                          if (ix) {
                            const ddx = c.cp[2].x - c.cp[1].x, ddy = c.cp[2].y - c.cp[1].y;
                            const len2 = ddx * ddx + ddy * ddy;
                            if (len2 > 1e-10) {
                              const tt = ((ix.x - c.cp[1].x) * ddx + (ix.y - c.cp[1].y) * ddy) / len2;
                              if (tt >= -0.01 && tt <= 1.01) { backFrom = ix; skipSide0 = true; }
                            }
                          }
                        }
                        if (adjNext) {
                          const ix = lineIntersect3V(c.cp[1].x, c.cp[1].y, c.cp[2].x, c.cp[2].y,
                            adjNext.cp[1].x, adjNext.cp[1].y, adjNext.cp[2].x, adjNext.cp[2].y);
                          if (ix) {
                            const ddx = c.cp[2].x - c.cp[1].x, ddy = c.cp[2].y - c.cp[1].y;
                            const len2 = ddx * ddx + ddy * ddy;
                            if (len2 > 1e-10) {
                              const tt = ((ix.x - c.cp[1].x) * ddx + (ix.y - c.cp[1].y) * ddy) / len2;
                              if (tt >= -0.01 && tt <= 1.01) { backTo = ix; skipSide2 = true; }
                            }
                          }
                        }
                        if (c._faceOn[0] < 0 && !skipSide0) {
                          const n = wallOutNormal3V(c.cp[0].x, c.cp[0].y, c.cp[1].x, c.cp[1].y, ccx, ccy);
                          addSolidInnerWall(c.cp[0].x, c.cp[0].y, c.cp[1].x, c.cp[1].y, sBot, sTop, otherCarves, n);
                        }
                        if (c._faceOn[1] < 0) {
                          const n = wallOutNormal3V(backFrom.x, backFrom.y, backTo.x, backTo.y, ccx, ccy);
                          addSolidInnerWall(backFrom.x, backFrom.y, backTo.x, backTo.y, sBot, sTop, otherCarves, n);
                        }
                        if (c._faceOn[2] < 0 && !skipSide2) {
                          const n = wallOutNormal3V(c.cp[2].x, c.cp[2].y, c.cp[3].x, c.cp[3].y, ccx, ccy);
                          addSolidInnerWall(c.cp[2].x, c.cp[2].y, c.cp[3].x, c.cp[3].y, sBot, sTop, otherCarves, n);
                        }
                      });
                    }
                    if (isTopSlice) topRoofPts = pp;
                  }

                  // カーブなしの場合（carveKids=0）
                  if (carveKids.length === 0) {
                    allWalls.push(...renderSliceWalls(pp, pZBot, pZTop, null, null));
                    topRoofPts = pp;
                  }

                  const isUnder = pZBot < 0;
                  const roofPts = (topRoofPts || pp).map(p => proj(p.x, p.y, pZTop));
                  els.push(<g key={`cb${bid}${bi}`}>
                    {allWalls.map((w, wi) => (
                      <polygon key={wi} points={w.pts.map(p => `${p.x},${p.y}`).join(" ")}
                        fill={b.color} opacity={isUnder ? 0.15 : w.isFront ? 0.3 : 0.12} stroke={b.color} strokeWidth={w.isFront ? 1 : 0.5}
                        strokeDasharray={isUnder ? "4,2" : "none"} />
                    ))}
                    <polygon points={roofPts.map(p => `${p.x},${p.y}`).join(" ")}
                      fill={b.color} opacity={0.12} stroke={b.color} strokeWidth={1} />
                  </g>);
                });
                // ラベル
                const nonCarve = blocks.filter(b2 => !b2._sharedWall);
                const allRoofPts = nonCarve.flatMap(b2 => b2.points.map(p => proj(p.x, p.y, b2.zTop)));
                const lx = allRoofPts.reduce((s,p) => s+p.x, 0)/allRoofPts.length;
                const ly = allRoofPts.reduce((s,p) => s+p.y, 0)/allRoofPts.length;
                els.push(<text key={`cbl${bid}`} x={lx} y={ly + 4}
                  textAnchor="middle" fontSize={7} fontWeight={700} fill="#334155" opacity={0.6}>{blocks[0].label}</text>);
                // 頂点ラベル (a, b, c, ...) — 三次元図の屋根面各頂点に外側オフセット
                nonCarve.forEach((b2, bi2) => {
                  const vp = b2.points;
                  if (!vp || vp.length < 3) return;
                  const vcx = vp.reduce((s,p) => s+p.x, 0) / vp.length;
                  const vcy = vp.reduce((s,p) => s+p.y, 0) / vp.length;
                  const VOFF3 = 8;
                  vp.forEach((pt, vi) => {
                    const dx = pt.x - vcx, dy = pt.y - vcy;
                    const d = Math.sqrt(dx*dx + dy*dy);
                    const ox = d > 0.1 ? pt.x + dx/d*VOFF3 : pt.x;
                    const oy = d > 0.1 ? pt.y + dy/d*VOFF3 : pt.y;
                    const sp = proj(ox, oy, b2.zTop);
                    els.push(<text key={`cvl${bid}_${bi2}_${vi}`} x={sp.x} y={sp.y+3}
                      textAnchor="middle" fontSize={6} fontWeight={600} fill="#1E40AF" opacity={0.8} pointerEvents="none">{String.fromCharCode(97+vi)}</text>);
                  });
                });
                return els;
              });
            })()}
            {/* solid モデル描画: pushPull後の形状を3次元図に反映（painter's algorithm） */}
            {(() => {
              if (!solids || solids.length === 0) return null;
              const allFaces = [];
              solids.forEach(solid => {
                if (!solid.faces) return;
                solid.faces.filter(f => f.vertices && f.vertices.length >= 3).forEach(f => {
                  const projected = f.vertices.map(v => proj(v.x, v.y, v.z));
                  const depth = projected.reduce((s, p) => s + p.depth, 0) / projected.length;
                  allFaces.push({ face: f, solid, projected, depth });
                });
              });
              // 奥から手前へソート（painter's algorithm）
              allFaces.sort((a, b) => b.depth - a.depth);
              return allFaces.map(({ face, solid, projected }) => {
                const pts = projected.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                const n = face.normal || { nx: 0, ny: 0, nz: 1 };
                const brightness = Math.max(0.25, Math.min(0.95,
                  0.45 + n.nz * 0.05 - Math.abs(n.ny) * 0.05 - Math.abs(n.nx) * 0.05));
                return (
                  <polygon key={`sf_${solid.id}_${face.id}`}
                    points={pts}
                    fill={solid.color || '#6B7A8D'}
                    fillOpacity={brightness * 0.9}
                    stroke="rgba(0,0,0,0.25)"
                    strokeWidth={0.5}
                    data-bld-face="1"
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const verts = face.vertices;
                      const fcx = verts.reduce((s,v)=>s+v.x,0)/verts.length;
                      const fcy = verts.reduce((s,v)=>s+v.y,0)/verts.length;
                      const fcz = verts.reduce((s,v)=>s+v.z,0)/verts.length;
                      const fn = face.normal || {nx:0,ny:0,nz:1};
                      const fnLen = Math.sqrt(fn.nx**2+fn.ny**2+fn.nz**2)||1;
                      setCab3dArrow({ cx:fcx, cy:fcy, cz:fcz,
                        nx:fn.nx/fnLen, ny:fn.ny/fnLen, nz:fn.nz/fnLen,
                        color: solid.color||'#EF4444', buildingId:solid.buildingId, faceId:face.id, solidId:solid.id });
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      const verts2 = face.vertices;
                      const fcx = verts2.reduce((s,v)=>s+v.x,0)/verts2.length;
                      const fcy = verts2.reduce((s,v)=>s+v.y,0)/verts2.length;
                      const fcz = verts2.reduce((s,v)=>s+v.z,0)/verts2.length;
                      const fn = face.normal || {nx:0,ny:0,nz:1};
                      const fnLen = Math.sqrt(fn.nx**2+fn.ny**2+fn.nz**2)||1;
                      const nx=fn.nx/fnLen, ny=fn.ny/fnLen, nz=fn.nz/fnLen;
                      const targetAz = Math.atan2(-nx, ny);
                      const targetEl = Math.asin(Math.max(-1, Math.min(1, nz)));
                      // zoom=1 でターゲット角度に全頂点を投影 → バウンディングボックス（CAB座標系）
                      const projVerts = verts2.map(v => project3D(v.x, v.y, v.z, targetAz, targetEl, 1, 0, 0));
                      const sxs = projVerts.map(p => p.x), sys = projVerts.map(p => p.y);
                      const fw = Math.max(1, Math.max(...sxs) - Math.min(...sxs));
                      const fh = Math.max(1, Math.max(...sys) - Math.min(...sys));
                      // 面がCABビューの60%を占めるようなズーム（CAB座標系で計算）
                      const targetZoom = Math.max(0.1, Math.min(10, Math.min(CAB_W * 0.6 / fw, CAB_H * 0.6 / fh)));
                      // ターゲットズームで面中心を投影 → CAB中央に来るようパンを計算
                      const tp = project3D(fcx, fcy, fcz, targetAz, targetEl, targetZoom, 0, 0);
                      const targetPanX = CAB_W / 2 - tp.x;
                      const targetPanY = CAB_H / 2 - tp.y;
                      let dAz = targetAz - camAzRef.current;
                      while (dAz > Math.PI) dAz -= 2*Math.PI;
                      while (dAz < -Math.PI) dAz += 2*Math.PI;
                      const dEl = targetEl - camElRef.current;
                      // NaN ガード: 計算値が不正ならアニメーションをスキップ
                      if (!isFinite(targetPanX) || !isFinite(targetPanY) || !isFinite(targetZoom)) return;
                      const dPX = targetPanX - camPanXRef.current;
                      const dPY = targetPanY - camPanYRef.current;
                      const dZoom = targetZoom - camZoomRef.current;
                      const az0 = camAzRef.current, el0 = camElRef.current;
                      const px0 = camPanXRef.current, py0 = camPanYRef.current;
                      const z0 = camZoomRef.current;
                      if (!isFinite(az0) || !isFinite(el0) || !isFinite(px0) || !isFinite(py0) || !isFinite(z0)) return;
                      if (cab3dAnimCancelRef.current) cab3dAnimCancelRef.current();
                      let _anim_cancelled = false;
                      cab3dAnimCancelRef.current = () => { _anim_cancelled = true; };
                      const t0 = performance.now(), dur = 600;
                      const step = (now) => {
                        if (_anim_cancelled || panningRef.current) { cab3dAnimCancelRef.current = null; return; }
                        const t = Math.min(1, (now-t0)/dur);
                        const ease = t<0.5 ? 2*t*t : -1+(4-2*t)*t;
                        setCamAz(az0 + dAz*ease);
                        setCamEl(el0 + dEl*ease);
                        setCamZoom(z0 + dZoom*ease);
                        setCamPanX(px0 + dPX*ease);
                        setCamPanY(py0 + dPY*ease);
                        if (t < 1) requestAnimationFrame(step);
                        else cab3dAnimCancelRef.current = null;
                      };
                      requestAnimationFrame(step);
                    }}
                  />
                );
              });
            })()}
          </svg>
          {/* 水平断面インジケーター（3次元図: clipSecのOBBポリゴン or フィールド全体） */}
          <svg viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 13 }}>
            {hSections.map(hs => {
              const _liveZPx3 = hSecLiveZRef.current[hs.id] ?? hs.zPx;
              let _polyPts;
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
              if (!_polyPts) {
                _polyPts = FIELD_POLY_GRID
                  ? FIELD_POLY_GRID
                  : [{ x: 0, y: 0 }, { x: TW, y: 0 }, { x: TW, y: TH }, { x: 0, y: TH }];
              }
              const _fp = _polyPts.map(p => proj(p.x, p.y, _liveZPx3));
              const _pts = _fp.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
              const _fpTop = _polyPts.map(p => proj(p.x, p.y, _liveZPx3 + MAJOR / 2));
              const _ptsTop = _fpTop.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
              const _fpBot = _polyPts.map(p => proj(p.x, p.y, _liveZPx3 - MAJOR / 2));
              const _ptsBot = _fpBot.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
              const _startHSecCabDrag = e => {
                e.preventDefault(); e.stopPropagation();
                const svgRect = e.currentTarget.ownerSVGElement.getBoundingClientRect();
                // xMidYMid meetのスケール: 高さ・幅どちらが制約かを考慮
                const actualScale = Math.min(svgRect.width / CAB_W, svgRect.height / CAB_H);
                // ドラッグ開始点のSVG座標を保存（矢印描画用）
                const _svgOffX = (svgRect.width - CAB_W * actualScale) / 2;
                const _svgOffY = (svgRect.height - CAB_H * actualScale) / 2;
                const _dragSvgX = (e.clientX - svgRect.left - _svgOffX) / actualScale;
                const _dragSvgY = (e.clientY - svgRect.top - _svgOffY) / actualScale;
                // クリック点に最も近いポリゴン辺を見つけ、world座標を補間
                // （逆投影はel≈0で発散するため、辺補間で安定してworld XYを求める）
                let _bestWx = _polyPts[0].x, _bestWy = _polyPts[0].y, _bestDist2 = Infinity;
                const _n = _polyPts.length;
                for (let _ei = 0; _ei < _n; _ei++) {
                  const _pA = _fp[_ei], _pB = _fp[(_ei + 1) % _n];
                  const _wA = _polyPts[_ei], _wB = _polyPts[(_ei + 1) % _n];
                  const _edx = _pB.x - _pA.x, _edy = _pB.y - _pA.y;
                  const _l2 = _edx * _edx + _edy * _edy;
                  const _t = _l2 > 0 ? Math.max(0, Math.min(1,
                    ((_dragSvgX - _pA.x) * _edx + (_dragSvgY - _pA.y) * _edy) / _l2)) : 0;
                  const _nx = _pA.x + _t * _edx, _ny = _pA.y + _t * _edy;
                  const _d2 = (_dragSvgX - _nx) ** 2 + (_dragSvgY - _ny) ** 2;
                  if (_d2 < _bestDist2) {
                    _bestDist2 = _d2;
                    _bestWx = _wA.x + _t * (_wB.x - _wA.x);
                    _bestWy = _wA.y + _t * (_wB.y - _wA.y);
                  }
                }
                hSecDragStartWorld.current = { x: _bestWx, y: _bestWy };
                const svgScale = 1 / (actualScale || 1); // 1スクリーンpx = svgScale SVGユニット
                // _mpp(インジケーター描画用)とproject3D内mppのfallbackが異なるため比率補正
                const _mppI = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                const _mppP = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
                const mppRatio = _mppP / _mppI; // = 1 when METERS_PER_PX defined, = 10 when undefined
                const dZPerPx = svgScale * mppRatio / (Math.max(0.05, Math.cos(camEl)) * camZoom);
                if (hSecActiveDim && !hSecDrag) return;
                hSecDragClientPos.current = { x: e.clientX, y: e.clientY }; setHSecActiveDim({id:hs.id}); setHSecDrag({id:hs.id, startClientX:e.clientX, startClientY:e.clientY, startZPx:_liveZPx3, dZPerPx});
              };
              // active時: ドラッグ開始点から縦に伸びる矢印
              const _isActive = hSecActiveDim?.id === hs.id;
              // world座標→現在カメラで再投影（カメラ回転・ズーム後も正しく追従）
              const _wxy = hSecDragStartWorld.current;
              const _hiPt = proj(_wxy.x, _wxy.y, _liveZPx3);
              const _glPt = proj(_wxy.x, _wxy.y, 0);
              const _ax3 = _hiPt.x;
              const _hiSvgY = _hiPt.y;
              const _glSvgY = _glPt.y;
              return (
                <g key={`hsc-cab-${hs.id}`}>
                  {/* 厚みスラブ: ON時のみ上面・下面・側面グレー塗り */}
                  {hSecShowBand[hs.id] && <>
                    <polygon points={_ptsTop} fill="rgba(0,0,0,0.07)" stroke="rgba(0,0,0,0.2)" strokeWidth={0.8} pointerEvents="none" />
                    {_polyPts.map((_, _vi) => {
                      const _vi2 = (_vi + 1) % _polyPts.length;
                      const _spts = `${_fpTop[_vi].x.toFixed(1)},${_fpTop[_vi].y.toFixed(1)} ${_fpTop[_vi2].x.toFixed(1)},${_fpTop[_vi2].y.toFixed(1)} ${_fpBot[_vi2].x.toFixed(1)},${_fpBot[_vi2].y.toFixed(1)} ${_fpBot[_vi].x.toFixed(1)},${_fpBot[_vi].y.toFixed(1)}`;
                      return <polygon key={_vi} points={_spts} fill="rgba(0,0,0,0.07)" stroke="rgba(0,0,0,0.2)" strokeWidth={0.8} pointerEvents="none" />;
                    })}
                    <polygon points={_ptsBot} fill="rgba(0,0,0,0.07)" stroke="rgba(0,0,0,0.2)" strokeWidth={0.8} pointerEvents="none" />
                  </>}
                  {/* 塗り部分: 視覚のみ、pointerEvents無効 */}
                  <polygon points={_pts} fill="rgba(128,128,128,0.12)" stroke="none" pointerEvents="none" />
                  {/* 縁のみヒット領域: 太い透明strokeでpointerEvents="stroke" */}
                  <polygon points={_pts} fill="none" stroke="transparent" strokeWidth={12}
                    data-hsecindicatorhit="1" style={{cursor:'ns-resize'}} pointerEvents="stroke"
                    onMouseDown={_startHSecCabDrag} />
                  {/* 縁の表示線 */}
                  <polygon points={_pts} fill="none" stroke="#1a1a1a" strokeWidth={1.5} pointerEvents="none" />
                  <text x={_fp[0].x+4} y={_fp[0].y-4} fontSize={9} fill="#1a1a1a" fontWeight={700} pointerEvents="none">{hs.label}</text>
                  {/* active時: GL + 全他hSecへの縦矢印 */}
                  {_isActive && (() => {
                    const _sc3 = cabSvgScale || 1;
                    const _ah = 7 / _sc3, _aw2 = 4 / _sc3, _sw = 1.5 / _sc3;
                    // GL + 他hSec全てを参照レベルとして矢印描画
                    const _refLevels = [
                      { id: 'GL', zPx: 0 },
                      ...hSections.filter(h => h.id !== hs.id).map(h => ({ id: h.id, zPx: hSecLiveZRef.current[h.id] ?? h.zPx }))
                    ];
                    return <g pointerEvents="none">
                      {_refLevels.map((_rl, _rli) => {
                        const _refPt = proj(_wxy.x, _wxy.y, _rl.zPx);
                        const _refSvgY = _refPt.y;
                        // 視覚的に重ならないよう小さなSVG-Xオフセット（3px/scale）
                        const _axOffset = _rli * (3 / _sc3);
                        const _ax = _ax3 + _axOffset;
                        const _yTop = Math.min(_hiSvgY, _refSvgY);
                        const _yBot = Math.max(_hiSvgY, _refSvgY);
                        if (Math.abs(_yBot - _yTop) < _ah * 2 + 1) return null;
                        return <g key={_rl.id}>
                          <line x1={_ax} y1={_yTop + _ah} x2={_ax} y2={_yBot - _ah} stroke="#1E293B" strokeWidth={_sw} />
                          <polygon points={`${_ax},${_yTop} ${_ax-_aw2},${_yTop+_ah} ${_ax+_aw2},${_yTop+_ah}`} fill="#1E293B" />
                          <polygon points={`${_ax},${_yBot} ${_ax-_aw2},${_yBot-_ah} ${_ax+_aw2},${_yBot-_ah}`} fill="#1E293B" />
                        </g>;
                      })}
                    </g>;
                  })()}
                </g>
              );
            })}
          </svg>
          {/* 3次元図のセグメント（深度ソート済み・2パス描画）
              Pass1: 全wireの白ハロー → Pass2: 全wireの黒本体
              これによりT字接続点で黒本体が白ハロー端を上書きし白漏れを消す */}
          <svg viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 14, pointerEvents: "none" }}>
            {/* Pass1: 全wireの白ハロー */}
            {cabSortedSegs.map((item) => {
              if (item.isFiltered) return null;
              const isHL = hoverSeg === item.segId || hoverId === item.from || hoverId === item.to;
              const sw = item.isBus ? (isHL ? 6 : 5) : (isHL ? 4 : 3);
              // ドラッグ中はisHL変化でDOM再作成されないよう固定（Cesiumクリック等による誤消滅防止）
              const _csk = `h|${item.pts}|${iconDragging.current ? 'drag' : isHL}`;
              return (
                <_MemoEl key={`ch${item.segId}`} stateKey={_csk} renderFn={() => (
                  <polyline id={`cwh-${item.segId}`} points={item.pts} fill="none"
                    stroke={isHL ? HL_COLOR : "rgba(232,236,240,0.95)"} strokeWidth={sw + 6}
                    strokeLinejoin="round" strokeLinecap="round"
                    style={{ transition: "stroke 0.15s" }} />
                )} />
              );
            })}
            {/* Pass2: 全wireの黒本体（ハロー後に全描画してT字白漏れを上書き） */}
            {cabSortedSegs.map((item) => {
              const isHL = hoverSeg === item.segId || hoverId === item.from || hoverId === item.to;
              const op = item.isFiltered ? 0.08 : 1;
              const sw = item.isBus ? (isHL ? 6 : 5) : (isHL ? 4 : 3);
              // ドラッグ中はisHL変化でDOM再作成されないよう固定（Cesiumクリック等による誤消滅防止）
              const _csk = `b|${item.pts}|${iconDragging.current ? 'drag' : isHL}|${item.isFiltered}`;
              return (
                <_MemoEl key={`cb${item.segId}`} stateKey={_csk} renderFn={() => (
                  <g id={`cw-${item.segId}`}>
                    <polyline points={item.pts} fill="none"
                      stroke={item.isFiltered ? "#999" : BASE_COLOR}
                      strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round"
                      opacity={op} />
                  </g>
                )} />
              );
            })}
            {/* 矢視図エリア四角＋コの字矢印（3次元図に投影） */}
            {sections.map(_sec => {
              let sec = _sec;
              if (_sec.p1 && _sec.p2) {
                const _curPnRad = plantNorthAngle * Math.PI / 180;
                const { cx, cy, halfA: hA, halfB: hB } = obbFromP1P2(_sec.p1, _sec.p2, _curPnRad);
                sec = { ..._sec, center: { x: cx, y: cy }, halfA: hA, halfB: hB, pnRad: _curPnRad };
              }
              const corners3d = sec.center !== undefined
                ? obbCorners(sec.center.x, sec.center.y, sec.halfA, sec.halfB, sec.pnRad)
                : [[sec.rect.x1,sec.rect.y1],[sec.rect.x2,sec.rect.y1],[sec.rect.x2,sec.rect.y2],[sec.rect.x1,sec.rect.y2]];
              const projPts = corners3d.map(([x, y]) => proj(x, y, 0));
              const ptsStr = projPts.map(p => `${p.x},${p.y}`).join(' ');
              // コの字: 2Dのコーナー・法線をprojで3次元図座標に変換
              let _koC2d, _ei2d, AL;
              if (sec.center !== undefined) {
                _ei2d = edgeInfoSec(sec, sec.viewEdge);
                const _cc = Math.cos(sec.pnRad), _ss = Math.sin(sec.pnRad);
                const _eL = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom') ? sec.halfA * 2 : sec.halfB * 2;
                AL = Math.max(10, _eL * 0.2);
                _koC2d = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom')
                  ? [[_ei2d.mid.x - sec.halfA*_cc, _ei2d.mid.y - sec.halfA*_ss],
                     [_ei2d.mid.x + sec.halfA*_cc, _ei2d.mid.y + sec.halfA*_ss]]
                  : [[_ei2d.mid.x + sec.halfB*_ss, _ei2d.mid.y - sec.halfB*_cc],
                     [_ei2d.mid.x - sec.halfB*_ss, _ei2d.mid.y + sec.halfB*_cc]];
              } else {
                const r = sec.rect;
                _ei2d = edgeInfo(r, sec.viewEdge);
                const _eL2 = (sec.viewEdge === 'top' || sec.viewEdge === 'bottom') ? (r.x2 - r.x1) : (r.y2 - r.y1);
                AL = Math.max(10, _eL2 * 0.2);
                _koC2d = sec.viewEdge === 'top'    ? [[r.x1,r.y1],[r.x2,r.y1]]
                       : sec.viewEdge === 'bottom' ? [[r.x1,r.y2],[r.x2,r.y2]]
                       : sec.viewEdge === 'left'   ? [[r.x1,r.y1],[r.x1,r.y2]]
                       :                            [[r.x2,r.y1],[r.x2,r.y2]];
              }
              const _koPB = _koC2d.map(([x, y]) => proj(x, y, 0));
              const _koPA = _koC2d.map(([x, y]) => proj(x + _ei2d.nx*AL, y + _ei2d.ny*AL, 0));
              return (
                <g key={`sec3d-${sec.id}`} pointerEvents="none">
                  <polygon points={ptsStr} fill="rgba(128,128,128,0.12)" stroke="#1a1a1a" strokeWidth={0.5} />
                  <line x1={_koPB[0].x} y1={_koPB[0].y} x2={_koPB[1].x} y2={_koPB[1].y}
                    stroke="#1a1a1a" strokeWidth={1.5} />
                  {_koPB.map((pb, i) => (
                    <line key={i} x1={pb.x} y1={pb.y} x2={_koPA[i].x} y2={_koPA[i].y}
                      stroke="#1a1a1a" strokeWidth={1.5} markerEnd="url(#arrowhead-k)" />
                  ))}
                </g>
              );
            })}
          </svg>
          {/* 3次元図のセグメント操作層（ホバー・クリック） */}
          <svg data-node="true" viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 15, pointerEvents: "none" }}>
            <g style={{ pointerEvents: "auto" }}>{renderSegs("cab", cabRef, p => proj(p.x, p.y, p.z || 0))}</g>
          </svg>
          {renderNodes("cab", cabRef)}
          {/* 3Dギズモ */}
          {gizmoTarget && (() => {
            const gp = getGizmoPos(gizmoTarget);
            if (!gp) return null;
            const o = proj(gp.x, gp.y, gp.z || 0);
            const _pnRg = plantNorthAngle * Math.PI / 180;
            // 軸の表示長をSVG座標で一定に保つ（ズームに依存しない）
            const AXIS_SVG_LEN = 120; // SVG座標での固定長（ズーム不変）
            const normTip = (wx, wy, wz) => {
              const raw = proj(wx, wy, wz);
              const dx = raw.x - o.x, dy = raw.y - o.y;
              const len = Math.sqrt(dx*dx + dy*dy);
              if (len < 0.001) return o;
              return { x: o.x + (dx/len)*AXIS_SVG_LEN, y: o.y + (dy/len)*AXIS_SVG_LEN };
            };
            const axes = [
              // X = PN⊥ (90°CW from PN): grid (+cos, +sin)
              { axis: "x", color: "#EF4444", label: "X",
                tip: normTip(gp.x + Math.cos(_pnRg)*50, gp.y + Math.sin(_pnRg)*50, gp.z || 0) },
              // Y = PN direction: grid (+sin, -cos)
              { axis: "y", color: "#22C55E", label: "Y",
                tip: normTip(gp.x + Math.sin(_pnRg)*50, gp.y - Math.cos(_pnRg)*50, gp.z || 0) },
              { axis: "z", color: "#3B82F6", label: "Z",
                tip: normTip(gp.x, gp.y, (gp.z || 0) + 50) },
            ];
            const startAxis = (ev, axis) => {
              if (ev.button && ev.button !== 0) return; // 左クリックのみ
              console.log('[START_AXIS] axis='+axis+' client=('+ev.clientX+','+ev.clientY+') isFaceAligned='+isFaceAligned);
              // デッドゾーン: o.x,o.y（SVG座標）からdisplay座標に変換してアイコン中心±14×16px以内
              { const _r0 = cabRef.current ? cabRef.current.getBoundingClientRect() : null;
                if (_r0) {
                  const _sc0 = Math.min(_r0.width/CAB_W, _r0.height/CAB_H)||1;
                  const _ox0 = (_r0.width - CAB_W*_sc0)/2, _oy0 = (_r0.height - CAB_H*_sc0)/2;
                  const _icX = _r0.left + _ox0 + o.x * _sc0; // アイコン中心display x
                  const _icY = _r0.top  + _oy0 + o.y * _sc0; // アイコン中心display y
                  if (Math.abs(ev.clientX - _icX) <= 14 && Math.abs(ev.clientY - _icY) <= 16) {
                    // アイコン四角内 → XYZ軸ドラッグ無効
                    console.log('[DEAD_ZONE] inside icon rect dx='+(ev.clientX-_icX).toFixed(1)+' dy='+(ev.clientY-_icY).toFixed(1)+' isFaceAligned='+isFaceAligned);
                    // face-alignedモード時はここからフェイスドラッグを起動
                    if (isFaceAligned && gizmoTarget) {
                      ev.preventDefault(); ev.stopPropagation();
                      iconDragging.current = true;
                      const _gp = getGizmoPos(gizmoTarget);
                      const _pos = _gp ? { x: _gp.x, y: _gp.y } : { x: TW/2, y: TH/2 };
                      const _wz = _gp ? (_gp.z || 0) : 0;
                      const _pr = plantNorthAngle * Math.PI / 180;
                      const _mpp2 = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                      const _az2 = camAzRef.current, _el2 = camElRef.current;
                      const _p0 = project3D(_pos.x, _pos.y, _wz*_mpp2, _az2, _el2, 1, 0, 0);
                      const _pX = project3D(_pos.x+Math.cos(_pr), _pos.y+Math.sin(_pr), _wz*_mpp2, _az2, _el2, 1, 0, 0);
                      const _pY = project3D(_pos.x+Math.sin(_pr), _pos.y-Math.cos(_pr), _wz*_mpp2, _az2, _el2, 1, 0, 0);
                      const _pZ = project3D(_pos.x, _pos.y, (_wz+1)*_mpp2, _az2, _el2, 1, 0, 0);
                      const _aX = { sx:_pX.x-_p0.x, sy:_pX.y-_p0.y, wx:Math.cos(_pr), wy:Math.sin(_pr), wz:0 };
                      const _aPN= { sx:_pY.x-_p0.x, sy:_pY.y-_p0.y, wx:Math.sin(_pr), wy:-Math.cos(_pr), wz:0 };
                      const _aZ = { sx:_pZ.x-_p0.x, sy:_pZ.y-_p0.y, wx:0, wy:0, wz:1 };
                      const _fid2 = clickedFaceRef.current;
                      let _axA2, _axB2;
                      if (_fid2==='px'||_fid2==='mx') { _axA2=_aPN; _axB2=_aZ; }
                      else if (_fid2==='pz'||_fid2==='mz') { _axA2=_aX; _axB2=_aPN; }
                      else { _axA2=_aX; _axB2=_aZ; }
                      const _det2 = _axA2.sx*_axB2.sy - _axA2.sy*_axB2.sx;
                      if (Math.abs(_det2) >= 1e-4) {
                        setFaceIconDown(gizmoTarget.id);
                        const _dd2 = { id: gizmoTarget.id, startX: ev.clientX, startY: ev.clientY,
                          startPos: _pos, startZ: _wz, axA: _axA2, axB: _axB2, zoom: camZoomRef.current };
                        let _c2 = false;
                        const _m2 = (me) => {
                          if (_c2) return;
                          if ((me.clientX-ev.clientX)**2 + (me.clientY-ev.clientY)**2 > 9) {
                            _c2 = true; setFaceDirect(_dd2);
                          }
                        };
                        const _u2 = () => {
                          setFaceIconDown(null);
                          window.removeEventListener('mousemove', _m2);
                          window.removeEventListener('mouseup', _u2);
                          if (!_c2) { iconDragging.current = false; }
                        };
                        window.addEventListener('mousemove', _m2);
                        window.addEventListener('mouseup', _u2);
                      }
                    }
                    return;
                  }
                }
              }
              ev.preventDefault(); ev.stopPropagation();
              iconDragging.current = true;
              const mp = toP(cabRef, ev);
              const _r3 = cabRef.current.getBoundingClientRect();
              const _sc3 = Math.min(_r3.width/CAB_W, _r3.height/CAB_H)||1;
              // 軸スクリーン方向を事前計算（PN角度・カメラ状態をこの瞬間にスナップショット）
              const _axLen = 30, _pnR0 = plantNorthAngle * Math.PI / 180;
              const _gPr = proj(gp.x, gp.y, gp.z || 0);
              const _tipPr = axis === 'x' ? proj(gp.x + Math.cos(_pnR0)*_axLen, gp.y + Math.sin(_pnR0)*_axLen, gp.z || 0)
                           : axis === 'y' ? proj(gp.x + Math.sin(_pnR0)*_axLen, gp.y - Math.cos(_pnR0)*_axLen, gp.z || 0)
                                          : proj(gp.x, gp.y, (gp.z || 0) + _axLen);
              const _adx0 = _tipPr.x - _gPr.x, _ady0 = _tipPr.y - _gPr.y;
              const _alen0 = Math.sqrt(_adx0*_adx0 + _ady0*_ady0);
              console.log('[AXIS_DRAG_SET] axis='+axis+' pnRad='+(_pnR0*180/Math.PI).toFixed(1)+'° alen='+_alen0.toFixed(2)+' sc='+_sc3.toFixed(3));
              // segLine用: 各端点の開始位置を保存
              let _startPosA = null, _startPosB = null, _startZA = 0, _startZB = 0;
              if (gizmoTarget.type === "segLine") {
                const { aIsIcon, aId, aWi, bIsIcon, bId, bWi } = gizmoTarget;
                const _getEP = (isIcon, id, wi) => {
                  if (isIcon) return allMapPos[id] ? { ...allMapPos[id] } : null;
                  const _wps = segWp[id] || [], _wzs = wpZ[id] || [];
                  return _wps[wi] ? { x: _wps[wi].x, y: _wps[wi].y, z: _wzs[wi] || 0 } : null;
                };
                const _epA = _getEP(aIsIcon, aId, aWi);
                const _epB = _getEP(bIsIcon, bId, bWi);
                _startPosA = _epA ? { x: _epA.x, y: _epA.y } : null;
                _startPosB = _epB ? { x: _epB.x, y: _epB.y } : null;
                _startZA = _epA?.z || 0;
                _startZB = _epB?.z || 0;
              }
              setAxisDrag({
                target: gizmoTarget, axis,
                pnRad: _pnR0,
                startMouse: { x: mp.x, y: mp.y },
                startPos: { x: gp.x, y: gp.y },
                startZ: gp.z || 0,
                ux: _alen0 > 0.1 ? _adx0/_alen0 : 1,
                uy: _alen0 > 0.1 ? _ady0/_alen0 : 0,
                worldPerPx: _alen0 > 0.1 ? _axLen/_alen0 : 0,
                startPosA: _startPosA, startPosB: _startPosB,
                startZA: _startZA, startZB: _startZB,
              });
            };
            return (
              <svg data-gizmo="true" viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 30, pointerEvents: "none" }}>
                <circle cx={o.x} cy={o.y} r={4} fill="#FFF" stroke="#000" strokeWidth={1.5} />
                {axes.map(({ axis, color, label, tip }) => {
                  const dx = tip.x - o.x, dy = tip.y - o.y;
                  const len = Math.sqrt(dx * dx + dy * dy);
                  if (len < 2) return null;
                  const isDragging = axisDrag && axisDrag.axis === axis;
                  const ux = dx / len, uy = dy / len;
                  const arrL = 18, arrW = 9;
                  const lw = isDragging ? 4 : 3;
                  // 矢印先端: 軸線は先端手前で終わり、polygon(矢印)が先端
                  const shaftTip = { x: tip.x - ux * arrL, y: tip.y - uy * arrL };
                  return (
                    <g key={axis} opacity={isDragging ? 1 : 0.9}>
                      {/* 軸線（先端手前まで） */}
                      <line x1={o.x} y1={o.y} x2={shaftTip.x} y2={shaftTip.y}
                        stroke={color} strokeWidth={lw} strokeLinecap="round" />
                      {/* 矢印ヘッド */}
                      <polygon points={`${tip.x},${tip.y} ${shaftTip.x + uy * arrW},${shaftTip.y - ux * arrW} ${shaftTip.x - uy * arrW},${shaftTip.y + ux * arrW}`} fill={color} />
                      {/* ラベル（外縁付き） */}
                      <text x={tip.x + ux * 14} y={tip.y + uy * 14 + 4}
                        textAnchor="middle" fontSize={13} fontWeight={700} fill={color}
                        stroke="#fff" strokeWidth={3} paintOrder="stroke">{label}</text>
                      <line x1={o.x + ux * 24} y1={o.y + uy * 24} x2={tip.x} y2={tip.y}
                        stroke="transparent" strokeWidth={18} strokeLinecap="round"
                        style={{ cursor: isDragging ? "grabbing" : "grab", pointerEvents: "auto" }}
                        onMouseDown={ev => startAxis(ev, axis)}
                        onTouchStart={ev => startAxis(ev, axis)} />
                    </g>
                  );
                })}
              </svg>
            );
          })()}
          {/* 作図モード: 直前の折れ点マーカー */}
          {drawMode && drawState && (() => {
            const lp = proj(drawState.lastPos.x, drawState.lastPos.y, drawState.lastPos.z);
            return (
              <svg viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 25, pointerEvents: "none" }}>
                <circle cx={lp.x} cy={lp.y} r={8} fill="none" stroke="#22C55E" strokeWidth={2} strokeDasharray="4,2" />
                <line x1={lp.x - 12} y1={lp.y} x2={lp.x + 12} y2={lp.y} stroke="#22C55E" strokeWidth={1} />
                <line x1={lp.x} y1={lp.y - 12} x2={lp.x} y2={lp.y + 12} stroke="#22C55E" strokeWidth={1} />
                <text x={lp.x + 14} y={lp.y - 4} fontSize={7} fill="#22C55E" fontWeight={700}>次のクリックで直交方向に追加</text>
              </svg>
            );
          })()}
          {/* ルートフィルタ表示 */}
          {routeFilter && <div style={{ position: "absolute", top: 30, left: 4, zIndex: 20, background: "rgba(245,158,11,0.9)", color: "#FFF", borderRadius: 4, padding: "2px 8px", fontSize: 8, fontWeight: 600 }}>
            ルート: {routeFilter} 表示中（右クリックで解除）
          </div>}
          {/* 3次元図 法線矢印オーバーレイ */}
          {cab3dArrow && (() => {
            // ppDrag中は現在のsolidsからfaceの重心をリアルタイム計算（矢印追従）
            let cx = cab3dArrow.cx, cy = cab3dArrow.cy, cz = cab3dArrow.cz;
            if (ppDrag) {
              const _ls = solids.find(s => s.id === ppDrag.solidId);
              const _lf = _ls && _ls.faces.find(f => f.id === ppDrag.faceId);
              if (_lf && _lf.vertices.length > 0) {
                const _lv = _lf.vertices;
                cx = _lv.reduce((s, v) => s + v.x, 0) / _lv.length;
                cy = _lv.reduce((s, v) => s + v.y, 0) / _lv.length;
                cz = _lv.reduce((s, v) => s + v.z, 0) / _lv.length;
              }
            }
            const { nx, ny, nz, color } = cab3dArrow;
            const base = proj(cx, cy, cz);
            const ARROW_G = 50; // グリッド単位（x,y方向）、z方向はメートル
            const mpp2 = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
            const tipRaw = proj(cx + nx*ARROW_G, cy + ny*ARROW_G, cz + nz*ARROW_G*mpp2);
            const dx = tipRaw.x - base.x, dy = tipRaw.y - base.y;
            const slen = Math.sqrt(dx*dx + dy*dy);
            if (slen < 1) return null;
            const ARROW_PX = 80;
            const scale = ARROW_PX / slen;
            const tipX = base.x + dx*scale, tipY = base.y + dy*scale;
            const ux = dx/slen, uy = dy/slen;
            const arrL = 18, arrW = 9;
            const sx = tipX - ux*arrL, sy = tipY - uy*arrL;
            const _ppCursor = ppDrag ? 'grabbing' : 'grab';
            const _onPPDown = (e) => {
                    e.stopPropagation();
                    const _solid = solidsRef.current.find(s => s.id === cab3dArrow.solidId);
                    if (!_solid) return;
                    // 1グリッド単位分のSVG変位ベクトル
                    const _mpp = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 1;
                    const _b = proj(cx, cy, cz);
                    const _t = proj(cx + nx, cy + ny, cz + nz * _mpp);
                    const _dux = _t.x - _b.x, _duy = _t.y - _b.y;
                    const _len2 = _dux * _dux + _duy * _duy;
                    const _pd = {
                      faceId: cab3dArrow.faceId,
                      solidId: cab3dArrow.solidId,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      startSolid: _solid,
                      dux: _dux, duy: _duy, len2: _len2,
                    };
                    ppDragRef.current = _pd;
                    setPPDrag(_pd);
            };
            return (
              <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:35 }}
                viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet">
                <line x1={base.x} y1={base.y} x2={sx} y2={sy}
                  stroke="#EF4444" strokeWidth={8} strokeLinecap="round" strokeOpacity={0.01}
                  style={{ pointerEvents:'auto', cursor:_ppCursor }} onMouseDown={_onPPDown} />
                <line x1={base.x} y1={base.y} x2={sx} y2={sy}
                  stroke={ppDrag ? "#F97316" : "#EF4444"} strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                <polygon
                  points={`${tipX},${tipY} ${sx+uy*arrW},${sy-ux*arrW} ${sx-uy*arrW},${sy+ux*arrW}`}
                  fill={ppDrag ? "#F97316" : "#EF4444"}
                  style={{ pointerEvents:'auto', cursor:_ppCursor }}
                  onMouseDown={_onPPDown}
                />
                <circle cx={base.x} cy={base.y} r={5} fill="#FFF" stroke="#EF4444" strokeWidth={2} />
                {/* カメラアイコン: クリックでアイコンカメラと同処理 */}
                <g style={{pointerEvents:'auto', cursor:'pointer'}}
                  onClick={e => {
                    e.stopPropagation();
                    const blds = flatBlocks.filter(b => b.buildingId === cab3dArrow.buildingId);
                    const bounds = blds.length > 0 ? {
                      bxMin: Math.min(...blds.map(b => b.pxMinX)),
                      bxMax: Math.max(...blds.map(b => b.pxMaxX)),
                      byMin: Math.min(...blds.map(b => b.pxMinY)),
                      byMax: Math.max(...blds.map(b => b.pxMaxY)),
                      bzMin: Math.min(...blds.map(b => b.zBottom)),
                      bzMax: Math.max(...blds.map(b => b.zTop)),
                    } : null;
                    focusGridPos(cx, cy, cz, bounds);
                  }}>
                  <circle cx={base.x+22} cy={base.y-22} r={13} fill="rgba(15,23,42,0.82)" />
                  <text x={base.x+22} y={base.y-22} fontSize={15} textAnchor="middle" dominantBaseline="middle">📷</text>
                </g>
              </svg>
            );
          })()}
          {/* cabSecMode中の矢視図描画プレビュー */}
          {cabSecMode && secDrawing && (() => {
            const _pnR = plantNorthAngleRef.current * Math.PI / 180;
            const projPt = (wx, wy) => {
              const pr = project3D(wx, wy, 0, camAz, camEl, camZoom, camPanX, camPanY);
              return [pr.x, pr.y];
            };
            if (secDrawing.phase === 1) {
              const { cx: ocx, cy: ocy, halfA, halfB } = obbFromP1P2(secDrawing.p1, secDrawing.cur, _pnR);
              const corners = obbCorners(ocx, ocy, halfA, halfB, _pnR);
              const pts = corners.map(([x, y]) => projPt(x, y).join(',')).join(' ');
              return (
                <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:36 }}
                  viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet">
                  <polygon points={pts} fill="rgba(99,102,241,0.08)" stroke="#6366F1" strokeWidth={1.5} strokeDasharray="5,3" />
                </svg>
              );
            }
            if (secDrawing.phase === 2) {
              const { cx: ocx, cy: ocy, halfA, halfB } = obbFromP1P2(secDrawing.p1, secDrawing.p2, _pnR);
              const corners = obbCorners(ocx, ocy, halfA, halfB, _pnR);
              const pts = corners.map(([x, y]) => projPt(x, y).join(',')).join(' ');
              const edge = nearestEdgeOBB(secDrawing.p1, secDrawing.p2, secDrawing.cur, _pnR);
              const _tmpSec = { center: { x: ocx, y: ocy }, halfA, halfB, pnRad: _pnR, viewEdge: edge };
              const ei = edgeInfoSec(_tmpSec, edge);
              const _cc = Math.cos(_pnR), _ss = Math.sin(_pnR);
              const _koC = (edge === 'top' || edge === 'bottom')
                ? [[ei.mid.x - halfA*_cc, ei.mid.y - halfA*_ss], [ei.mid.x + halfA*_cc, ei.mid.y + halfA*_ss]]
                : [[ei.mid.x + halfB*_ss, ei.mid.y - halfB*_cc], [ei.mid.x - halfB*_ss, ei.mid.y + halfB*_cc]];
              const AL = Math.max(10, ((edge === 'top' || edge === 'bottom') ? halfA*2 : halfB*2) * 0.2);
              const projEdge = _koC.map(([x, y]) => projPt(x, y));
              const projTips = _koC.map(([x, y]) => projPt(x + ei.nx*AL, y + ei.ny*AL));
              return (
                <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:36 }}
                  viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet">
                  <polygon points={pts} fill="rgba(128,128,128,0.12)" stroke="#1a1a1a" strokeWidth={0.5} />
                  <line x1={projEdge[0][0]} y1={projEdge[0][1]} x2={projEdge[1][0]} y2={projEdge[1][1]} stroke="#1a1a1a" strokeWidth={1.5} />
                  {projEdge.map(([ex, ey], i) => (
                    <line key={i} x1={ex} y1={ey} x2={projTips[i][0]} y2={projTips[i][1]} stroke="#1a1a1a" strokeWidth={1.5} />
                  ))}
                </svg>
              );
            }
            return null;
          })()}
          {/* 配電盤 配置レイヤー（レイヤー分離: パス1=不可視ヒット領域 → パス2=可視要素 → パス3=可視ラベル）
              盤ごとの<g>一体構造だと「後から配置した盤」の不可視ヒット拡大領域（天頂面の太stroke・
              ラベル拡大rect）が「先に配置した盤」の可視ラベルを覆い、クリックを横取りするバグがあった。
              SVGはDOM後勝ちのため、盤横断の3パスに再構成し、ラベルが常に最上層に来ることを構造的に保証する。 */}
          {placedPanels.length > 0 && (() => {
            // 全盤の描画データを事前計算（3パスで使い回す）
            const _panelRenderData = placedPanels.map(pp => {
              const pd = pp.panelData;
              if (!pd) return null;
              const W_mm = pd.widthMm || 600;
              const D_mm = pd.depthMm || 400;
              const H_mm = pd.heightMm || 1800;
              const clr = pd.color || '#4A90D9';
              const sel = selectedPlacedPanelId === pp.id;
              // canvasと同じ_pde_makeCabProj（mm単位）で座標計算し、ずれを解消
              const projMM = _pde_makeCabProj(pp, camAz, camEl, camZoom, camPanX, camPanY);
              // 底面4隅・天頂面4隅
              const [p00,p10,p11,p01] = [[0,0,0],[W_mm,0,0],[W_mm,D_mm,0],[0,D_mm,0]].map(([cx,cy,cz])=>projMM(cx,cy,cz));
              const [t00,t10,t11,t01] = [[0,0,H_mm],[W_mm,0,H_mm],[W_mm,D_mm,H_mm],[0,D_mm,H_mm]].map(([cx,cy,cz])=>projMM(cx,cy,cz));
              const botPts = [p00,p10,p11,p01].map(p=>`${p.x},${p.y}`).join(' ');
              const topPts = [t00,t10,t11,t01].map(p=>`${p.x},${p.y}`).join(' ');
              // 回転ハンドル位置（天頂面中心の上）— ドラッグ角度基準も cTop で統一
              const cTop = projMM(W_mm/2, D_mm/2, H_mm);
              const hx = cTop.x, hy = cTop.y - 28;
              return { pp, pd, W_mm, D_mm, H_mm, clr, sel, projMM, t00, t10, t11, t01, botPts, topPts, cTop, hx, hy };
            }).filter(Boolean);

            return (
              <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 38, overflow: 'visible' }}
                viewBox={`0 0 ${CAB_W} ${CAB_H}`} preserveAspectRatio="xMidYMid meet" overflow="visible">
                {/* 背景クリックでの選択解除は cab背景クリックハンドラに統合済み（全面rectでの横取りをやめ、
                    アイコン等のクリックを奪わないようにする） */}

                {/* ===== パス1（最下層）: 全盤の不可視ヒット拡大領域（盤移動用の天頂面のみ） =====
                    天頂面ヒット専用（透明・太stroke=画面上約16px）。
                    旧実装は stroke:none/width:0 で stroke形状が発生せず、遠景ズームでは fill内部しか当たらなかった。
                    ラベルのヒット拡大rectは選択時UIに食われるためパス3へ移設した。 */}
                {_panelRenderData.map(d => {
                  const { pp, sel, topPts } = d;
                  const _hitW = 16 / (cabSvgScale || 1); // viewBox単位化（他のヒット拡大箇所と同じパターン）
                  const _pmCursor = (panelMoveDrag && panelMoveDrag.id === pp.id) ? 'grabbing' : 'pointer';
                  return (
                    <polygon key={`hit-${pp.id}`} points={topPts} fill="transparent"
                      data-panel-move="true"
                      stroke="transparent" strokeWidth={_hitW} strokeLinejoin="round"
                      style={{ pointerEvents:'all', touchAction:'none', cursor:_pmCursor }}
                      onMouseDown={(e) => _startPanelMoveDrag(e, pp)}
                      onTouchStart={(e) => _startPanelMoveDragTouch(e, pp)}
                      onClick={(e) => _togglePlacedPanelSelection(e, pp, sel)} />
                  );
                })}

                {/* ===== パス2（中層）: 全盤の可視要素（選択橙枠・面/仕切り/アイコン/配線/扉・選択時UI） ===== */}
                {_panelRenderData.map(d => {
                  const { pp, pd, sel, topPts, cTop, hx, hy } = d;
                  return (
                    <g key={`body-${pp.id}`}>
                      {/* 可視: 選択時の橙枠のみ担当。イベントはパス1のヒットpolygonに素通し */}
                      {sel && <polygon points={topPts} fill="none"
                        stroke="#F59E0B" strokeWidth={2.5}
                        style={{ pointerEvents:'none' }} />}
                      {/* 3D面・仕切り・アイコン・配線描画（kind分岐）— 天頂面ヒットより後に描くため前面に来る */}
                      {_pde_panelSVGElems(pp, camAz, camEl, camZoom, camPanX, camPanY).map(el => {
                        const dKey = el.isDoor ? `${pp.id}_${el.doorIdx}` : null;
                        const isDoorSel = dKey && selectedDoorKey === dKey;
                        const doorStroke = isDoorSel ? '#F59E0B' : (sel && el.isDoor ? '#93C5FD' : el.stroke);
                        const doorStrokeW = isDoorSel ? 2.5 : el.strokeW;
                        const doorClick = el.isDoor ? (e) => {
                          e.stopPropagation();
                          if (!sel) setSelectedPlacedPanelId(pp.id);
                          if (isDoorSel) { toggleDoor(pp.id, el.doorIdx); setSelectedDoorKey(null); }
                          else { setSelectedDoorKey(dKey); }
                        } : undefined;
                        if (el.kind === 'line') {
                          return <line key={el.key} x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2}
                            stroke={el.stroke} strokeWidth={el.strokeW} strokeLinecap="round"
                            style={{ pointerEvents:'none' }} />;
                        }
                        if (el.kind === 'path') {
                          return <path key={el.key} d={el.d} fill={el.fill} fillOpacity={el.opacity}
                            fillRule={el.fillRule||'nonzero'} stroke={doorStroke||'none'} strokeWidth={doorStrokeW||0}
                            strokeLinejoin="round"
                            style={{ pointerEvents: el.isDoor ? 'all' : 'none', cursor: el.isDoor ? 'pointer' : 'default' }}
                            onClick={doorClick} />;
                        }
                        return (
                          <polygon key={el.key} points={el.pts} fill={el.fill} fillOpacity={el.opacity}
                            stroke={doorStroke} strokeWidth={doorStrokeW} strokeLinejoin="round"
                            style={{ pointerEvents: el.isDoor ? 'all' : 'none', cursor: el.isDoor ? 'pointer' : 'default' }}
                            onClick={doorClick} />
                        );
                      })}
                      {/* 名称ラベルはパス3（最上層）で描画する */}
                      {/* 選択時UI */}
                      {sel && (<g>
                        {/* 回転ドラッグハンドル（円弧矢印） */}
                        {/* 回転ドラッグハンドル — 角度基準はcTop（上面中心） */}
                        <circle cx={hx} cy={hy} r={22} fill="rgba(245,158,11,0.22)"
                          stroke="#F59E0B" strokeWidth={2} strokeDasharray="6,3"
                          data-panel-rot="true"
                          style={{ pointerEvents:'all', cursor:'grab' }}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            panelRotDragActiveRef.current = true;
                            const cab = cabRef.current;
                            if (!cab) return;
                            const r2 = cab.getBoundingClientRect();
                            const sc = Math.min(r2.width/CAB_W, r2.height/CAB_H);
                            const ox = (r2.width-CAB_W*sc)/2, oy = (r2.height-CAB_H*sc)/2;
                            const scx = r2.left + ox + cTop.x*sc, scy = r2.top + oy + cTop.y*sc;
                            setPanelRotDrag({ id:pp.id, screenCx:scx, screenCy:scy, startAngle:Math.atan2(e.clientY-scy, e.clientX-scx), startRot:pp.rot||0 });
                          }} />
                        <text x={hx} y={hy+7} textAnchor="middle" fontSize={20} fill="#F59E0B" style={{ pointerEvents:'none' }}>↻</text>
                        {/* ボタン行（h=36） */}
                        {/* ◀ 1°左 */}
                        <g style={{ pointerEvents:'all', cursor:'pointer' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); rotatePlacedPanel(pp.id, -Math.PI/180); }}>
                          <rect x={hx-72} y={hy+30} width={32} height={36} rx={4} fill="#1E293B" stroke="#64748B" strokeWidth={1} />
                          <text x={hx-56} y={hy+54} textAnchor="middle" fontSize={22} fill="#FFF">◀</text>
                        </g>
                        {/* ▶ 1°右 */}
                        <g style={{ pointerEvents:'all', cursor:'pointer' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); rotatePlacedPanel(pp.id, Math.PI/180); }}>
                          <rect x={hx-36} y={hy+30} width={32} height={36} rx={4} fill="#1E293B" stroke="#64748B" strokeWidth={1} />
                          <text x={hx-20} y={hy+54} textAnchor="middle" fontSize={22} fill="#FFF">▶</text>
                        </g>
                        {/* 90°スナップ */}
                        <g style={{ pointerEvents:'all', cursor:'pointer' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); const cur=pp.rot||0; const snap=Math.round(cur/(Math.PI/2)+1)*(Math.PI/2); rotatePlacedPanel(pp.id, snap-cur); }}>
                          <rect x={hx} y={hy+30} width={52} height={36} rx={4} fill="#1E293B" stroke="#64748B" strokeWidth={1} />
                          <text x={hx+26} y={hy+53} textAnchor="middle" fontSize={17} fill="#FFF">90°↻</text>
                        </g>
                        {/* ⚙ 制限UIトグル */}
                        <g style={{ pointerEvents:'all', cursor:'pointer' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); setPanelDetailOpen(v => !v); }}>
                          <rect x={hx+56} y={hy+30} width={36} height={36} rx={4}
                            fill={panelDetailOpen ? '#6366F1' : '#1E293B'} stroke={panelDetailOpen ? '#818CF8' : '#64748B'} strokeWidth={1} />
                          <text x={hx+74} y={hy+54} textAnchor="middle" fontSize={20} fill="#FFF">⚙</text>
                        </g>
                        {/* ✎ 配電盤エディタで開く */}
                        <g style={{ pointerEvents:'all', cursor:'pointer' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setWinState(prev => ({...prev, panelEditor: {...prev.panelEditor, minimized: false}}));
                            bringFront('panelEditor');
                            panelEditorIframeRef.current?.contentWindow?.postMessage(
                              { type: 'SELECT_PANEL', panelName: pp.panelData.name }, '*');
                          }}>
                          <rect x={hx+96} y={hy+30} width={36} height={36} rx={4} fill="#1E40AF" stroke="#3B82F6" strokeWidth={1} />
                          <text x={hx+114} y={hy+54} textAnchor="middle" fontSize={20} fill="#FFF">✎</text>
                        </g>
                        {/* × 削除 */}
                        <g style={{ pointerEvents:'all', cursor:'pointer' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); setPlacedPanels(pr=>pr.filter(p=>p.id!==pp.id)); setSelectedPlacedPanelId(null); setSelectedDoorKey(null); setPanelDetailOpen(false); }}>
                          <rect x={hx+136} y={hy+30} width={32} height={36} rx={4} fill="rgba(239,68,68,0.9)" stroke="rgba(239,68,68,0.5)" strokeWidth={1} />
                          <text x={hx+152} y={hy+54} textAnchor="middle" fontSize={20} fill="#FFF">×</text>
                        </g>
                      </g>)}
                    </g>
                  );
                })}

                {/* ===== パス3（最上層）: 全盤の可視ラベル（盤名称テキスト＋ヒット拡大rect＋枠） =====
                    ラベルは盤移動ではなく labelOffset 移動（盤本体wx/wyは動かさない）。
                    ヒット拡大rectもここに置く（パス1に置くとパス2の選択時UIに前面を奪われるため）。 */}
                {_panelRenderData.map(d => {
                  const { pp, pd, clr, sel, t00, t10 } = d;
                  const _nFS = Math.min(22, Math.max(7, Math.round(Math.hypot(t10.x - t00.x, t10.y - t00.y) * 22 / 200)));
                  const _nSW = Math.max(1.2, _nFS * 4 / 22);
                  // ユーザー設定オフセット（viewBox単位・盤回転には追従させない = 常に画面平行移動）
                  const _lo = pp.labelOffset || { dx: 0, dy: 0 };
                  const _lx = t00.x + 3 + (_lo.dx || 0);
                  const _ly = t00.y - 3 + (_lo.dy || 0);
                  // 概算テキスト幅（getBBoxはレンダー中に使えないため近似）:
                  // 全角(コードポイント>0xFF)=1.0em / 半角=0.62em（bold 700の平均字幅）
                  const _estW = Array.from(String(pd.name || '')).reduce(
                    (w, ch) => w + (ch.codePointAt(0) > 0xFF ? 1.0 : 0.62), 0) * _nFS;
                  const _csc2 = cabSvgScale || 1;
                  const _padX = 6 / _csc2;                       // 左右パディング=画面上6px
                  const _rH = Math.max(_nFS * 1.3, 28 / _csc2);  // 高さは画面上最低28px確保
                  const _rW = Math.max(_estW + _padX * 2, 28 / _csc2); // 空文字でも最低幅
                  const _rX = _lx - _padX;
                  const _rY = (_ly - _nFS * 0.35) - _rH / 2;     // テキスト垂直中心(≈baseline-0.35em)に合わせる
                  const _lmDragging = !!(labelMoveDrag && labelMoveDrag.id === pp.id);
                  const _lmCursor = _lmDragging ? 'grabbing' : 'move';
                  const _hitSt = { pointerEvents:'all', touchAction:'none', cursor:_lmCursor };
                  return (
                    <g key={`label-${pp.id}`}>
                      {/* 名称のヒット拡大用 透明rect（文字グリフだけでは掴めないため） */}
                      <rect x={_rX} y={_rY} width={_rW} height={_rH} fill="transparent"
                        data-panel-label="true" style={_hitSt}
                        onMouseDown={(e) => _startLabelMoveDrag(e, pp)}
                        onTouchStart={(e) => _startLabelMoveDragTouch(e, pp)}
                        onClick={(e) => _togglePlacedPanelSelection(e, pp, sel)} />
                      <text x={_lx} y={_ly} fontSize={_nFS} fill={clr} fontWeight={700} stroke="#FFF" strokeWidth={_nSW} paintOrder="stroke"
                        data-panel-label="true" style={_hitSt}
                        onMouseDown={(e) => _startLabelMoveDrag(e, pp)}
                        onTouchStart={(e) => _startLabelMoveDragTouch(e, pp)}
                        onClick={(e) => _togglePlacedPanelSelection(e, pp, sel)}>{pd.name}</text>
                    </g>
                  );
                })}
              </svg>
            );
          })()}
          {/* 配電盤 制限UIパネル */}
          {selectedPlacedPanelId && panelDetailOpen && (() => {
            const _pp = placedPanels.find(p => p.id === selectedPlacedPanelId);
            if (!_pp || !_pp.panelData) return null;
            const _mpp2 = (typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:0.1;
            const _wPx = (_pp.panelData.widthMm||600)/1000/_mpp2;
            const _dPx = (_pp.panelData.depthMm||400)/1000/_mpp2;
            const _hM  = (_pp.panelData.heightMm||1800)/1000;
            const _cTop = project3D(_pp.wx+_wPx/2, _pp.wy+_dPx/2, _hM, camAz, camEl, camZoom, camPanX, camPanY);
            const _sc = cabSvgScale;
            const _r2 = cabRef.current?.getBoundingClientRect();
            const _ox = _r2 ? (_r2.width - CAB_W*_sc)/2 : 0;
            const _oy = _r2 ? (_r2.height - CAB_H*_sc)/2 : 0;
            const _px = _ox + _cTop.x * _sc + panelDetailOffset.x;
            const _py = _oy + _cTop.y * _sc - 10 + panelDetailOffset.y;
            const _opa = pdcTransparency(_pp.panelData); // 共通コア: 未設定時はエディタと同じ80
            const _showWires = _pp.panelData.showWires ?? true;
            const _doorsVis = _pp.panelData.doorsVisible ?? true;
            const _iconDispMode = _pp.panelData.iconDisplayMode || 'flat';
            const _iconDispModes = ['box', 'flat', 'hidden'];
            // iconVisMode: PanelEditor.jsxと同じサイクル full→semi→opaque→full
            const _iconVisModes = ['full', 'semi', 'opaque'];
            const _iconVis = _pp.panelData.iconVisMode ?? 'semi';
            const _iconVisModeColors = { full:'#0EA5E9', semi:'#F59E0B', opaque:'#64748B' };
            const _btn = (bg) => ({
              background: bg, color:'#FFF', border:'none', borderRadius:4,
              padding:'4px 6px', fontSize:11, cursor:'pointer', fontWeight:600, lineHeight:1,
            });
            const _opaSliderColor = _opa === 0 ? '#64748B' : _opa === 100 ? '#0EA5E9' : '#F59E0B';
            // ドラッグ開始
            const _onHeaderDown = (e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const startX = e.clientX, startY = e.clientY;
              const startOX = panelDetailOffset.x, startOY = panelDetailOffset.y;
              const onMove = (me) => {
                setPanelDetailOffset({ x: startOX + me.clientX - startX, y: startOY + me.clientY - startY });
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            };
            return (
              <div
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                style={{ position:'absolute', left:_px+12, top:_py, zIndex:50,
                         background:'rgba(15,23,42,0.93)', border:'1px solid #334155',
                         borderRadius:6, padding:'0', minWidth:210,
                         color:'#F1F5F9', fontSize:11, pointerEvents:'all',
                         boxShadow:'0 4px 16px rgba(0,0,0,0.5)', userSelect:'none' }}>
                {/* ヘッダー（ドラッグハンドル） */}
                <div data-panel-detail-drag="true"
                  onMouseDown={_onHeaderDown}
                  style={{display:'flex', justifyContent:'space-between', alignItems:'center',
                          padding:'6px 10px', borderBottom:'1px solid #334155', cursor:'grab',
                          background:'rgba(30,41,59,0.8)', borderRadius:'6px 6px 0 0'}}>
                  <span style={{fontWeight:700, fontSize:12}}>{_pp.panelData.name||'配電盤'}</span>
                  <button onClick={() => setPanelDetailOpen(false)}
                    style={{background:'none', border:'none', color:'#94A3B8', fontSize:14, cursor:'pointer', padding:'0 2px', lineHeight:1}}>×</button>
                </div>
                <div style={{padding:'8px 10px'}}>
                  {/* 盤名称 */}
                  <div style={{marginBottom:2, color:'#94A3B8', fontSize:10}}>盤名称</div>
                  <input value={_pp.panelData.name||''}
                    onChange={e => updatePlacedPanel(_pp.id, 'name', e.target.value)}
                    style={{width:'100%', background:'#1E293B', color:'#FFF', border:'1px solid #475569',
                            borderRadius:3, padding:'2px 5px', fontSize:11, outline:'none', boxSizing:'border-box'}} />
                  {/* ボタン横一列（PanelEditor.jsxと同じ並び: 扉→目マーク→キューブ→配線）*/}
                  <div style={{marginTop:8, display:'flex', gap:4, alignItems:'center'}}>
                    {/* 扉表示トグル: PanelEditor.jsxと同じドアアイコン（表示中=赤、非表示=グレー+斜線） */}
                    <button
                      title={_doorsVis ? '扉表示ON（クリックで非表示）' : '扉表示OFF（クリックで表示）'}
                      onClick={() => { updatePlacedPanel(_pp.id, 'doorsVisible', !_doorsVis); setSelectedDoorKey(null); }}
                      style={_btn(_doorsVis ? '#DC2626' : '#64748B')}>
                      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round">
                        <rect x="3" y="1.5" width="12" height="15" rx="1" strokeWidth="1.4"/>
                        <circle cx="13" cy="9" r="1.1" fill="currentColor" stroke="none"/>
                        {!_doorsVis && <line x1="1.5" y1="16.5" x2="16.5" y2="1.5" strokeWidth="1.6"/>}
                      </svg>
                    </button>
                    {/* 目マーク: full→semi→opaque→full サイクル */}
                    <button
                      title={{ full:'全透過→半透過に', semi:'半透過→不透過に', opaque:'不透過→全透過に' }[_iconVis]}
                      onClick={() => {
                        const next = _iconVisModes[(_iconVisModes.indexOf(_iconVis)+1) % _iconVisModes.length];
                        updatePlacedPanel(_pp.id, 'iconVisMode', next);
                      }}
                      style={_btn(_iconVisModeColors[_iconVis])}>
                      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round">
                        <path d="M1.5 9 C4 4, 14 4, 16.5 9 C14 14, 4 14, 1.5 9Z" strokeWidth="1.3"/>
                        {_iconVis === 'opaque' && <circle cx="9" cy="9" r="3.5" fill="white" strokeWidth="1.3"/>}
                        {_iconVis === 'semi'   && <path d="M9 5.5 A3.5 3.5 0 0 1 9 12.5 Z" fill="currentColor" stroke="none"/>}
                        {_iconVis === 'full'   && <circle cx="9" cy="9" r="3.5" fill="currentColor" stroke="none"/>}
                      </svg>
                    </button>
                    {/* 機器表示形式: 箱/平面/なし（PanelEditor.jsxのiconDisplayModeボタンと同じ3段階） */}
                    <button
                      title={{ box: '機器表示形式: 箱（クリックで平面に）', flat: '機器表示形式: 平面（クリックでなしに）', hidden: '機器表示形式: なし（クリックで箱に）' }[_iconDispMode]}
                      onClick={() => {
                        const _next = _iconDispModes[(_iconDispModes.indexOf(_iconDispMode)+1) % _iconDispModes.length];
                        updatePlacedPanel(_pp.id, 'iconDisplayMode', _next);
                      }}
                      style={_btn(_iconDispMode === 'box' ? '#7C3AED' : _iconDispMode === 'hidden' ? '#374151' : '#64748B')}>
                      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                        {_iconDispMode === 'box' ? (
                          <>
                            <polygon points="9,2 16.5,5.5 9,9 1.5,5.5" strokeWidth="1.3" fill="currentColor" fillOpacity="0.35"/>
                            <polyline points="1.5,5.5 1.5,12.5 9,16 16.5,12.5 16.5,5.5" strokeWidth="1.3"/>
                            <line x1="9" y1="9" x2="9" y2="16" strokeWidth="1.3"/>
                          </>
                        ) : _iconDispMode === 'hidden' ? (
                          <>
                            <rect x="3" y="3" width="12" height="12" rx="1.5" strokeWidth="1.3"/>
                            <line x1="5" y1="5" x2="13" y2="13" strokeWidth="1.5"/>
                            <line x1="13" y1="5" x2="5" y2="13" strokeWidth="1.5"/>
                          </>
                        ) : (
                          <>
                            <rect x="3" y="3" width="12" height="12" rx="1.5" strokeWidth="1.3"/>
                            <rect x="5.5" y="5.5" width="3" height="3" strokeWidth="1.1"/>
                            <rect x="9.5" y="5.5" width="3" height="3" strokeWidth="1.1"/>
                            <rect x="5.5" y="9.5" width="3" height="3" strokeWidth="1.1"/>
                          </>
                        )}
                      </svg>
                    </button>
                    {/* 配線表示 */}
                    <button title={_showWires ? '配線表示ON（クリックでOFF）' : '配線表示OFF（クリックでON）'}
                      onClick={() => updatePlacedPanel(_pp.id, 'showWires', !_showWires)}
                      style={_btn(_showWires ? '#0EA5E9' : '#374151')}>
                      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round">
                        <circle cx="2.5" cy="9" r="1.5" fill="currentColor" stroke="none"/>
                        <circle cx="15.5" cy="9" r="1.5" fill="currentColor" stroke="none"/>
                        <path d="M4 9 C6 5, 8 5, 9 9 C10 13, 12 13, 14 9" strokeWidth="1.5"/>
                        {!_showWires && <line x1="1.5" y1="16.5" x2="16.5" y2="1.5" strokeWidth="1.6"/>}
                      </svg>
                    </button>
                  </div>
                  {/* 外箱透明度スライダー */}
                  <div style={{marginTop:6, marginBottom:2, color:'#94A3B8', fontSize:10}}>外箱透明度 {_opa}%</div>
                  <input type="range" min={0} max={100} value={_opa}
                    onChange={e => updatePlacedPanel(_pp.id, 'outerOpacity', Number(e.target.value))}
                    style={{width:'100%', accentColor: _opaSliderColor}} />
                  {/* 描画品質設定 */}
                  <div style={{marginTop:10, borderTop:'1px solid #334155', paddingTop:8}}>
                    <div style={{color:'#94A3B8', fontSize:10, marginBottom:4, fontWeight:600}}>描画品質</div>
                    <div style={{color:'#CBD5E1', fontSize:10, marginBottom:2}}>ドラッグ中の品質</div>
                    <div style={{display:'flex', gap:4, alignItems:'center', marginBottom:1}}>
                      <span style={{color:'#64748B', fontSize:9}}>低</span>
                      <input type="range" min={0} max={100} value={panelDragQuality}
                        onChange={e => setPanelDragQuality(Number(e.target.value))}
                        style={{flex:1, accentColor:'#6366F1'}} />
                      <span style={{color:'#64748B', fontSize:9}}>高</span>
                    </div>
                    <div style={{color:'#FFF', fontSize:9, textAlign:'center', marginBottom:6}}>{panelDragQuality}%</div>
                    <div style={{color:'#CBD5E1', fontSize:10, marginBottom:2}}>静止後に戻る時間</div>
                    <div style={{display:'flex', gap:4, alignItems:'center', marginBottom:1}}>
                      <span style={{color:'#64748B', fontSize:9}}>即時</span>
                      <input type="range" min={0} max={500} value={panelRestoreDelay}
                        onChange={e => setPanelRestoreDelay(Number(e.target.value))}
                        style={{flex:1, accentColor:'#6366F1'}} />
                      <span style={{color:'#64748B', fontSize:9}}>遅め</span>
                    </div>
                    <div style={{color:'#FFF', fontSize:9, textAlign:'center', marginBottom:4}}>{panelRestoreDelay}ms</div>
                    <button onClick={() => { setPanelDragQuality(50); setPanelRestoreDelay(50); }}
                      style={{width:'100%', padding:'3px 0', border:'none', borderRadius:3, background:'#334155', color:'#94A3B8', fontSize:9, cursor:'pointer'}}>
                      デフォルトに戻す（50% / 50ms）
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
        </div>{/* flex column wrapper */}
      </FloatWin>
      {/* CesiumJS 3Dウィンドウ */}
      <FloatWin id="cesium3d" title="CesiumJS 3D" winState={winState} setWinState={setWinState} bringFront={bringFront} overflow="hidden" keepMounted
        headerExtra={
          <button onClick={e => { e.stopPropagation(); setCesium3dGearOpen(p => !p); }}
            style={{ width: 18, height: 18, border: 'none', borderRadius: 4, background: cesium3dGearOpen ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.15)', color: '#FFF', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⚙</button>
        }>
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {!cesium3dLoaded ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', width:'100%', height:'100%', background:'#1E293B' }}>
            <button onClick={() => setCesium3dLoaded(true)}
              style={{ padding:'10px 28px', fontSize:14, fontWeight:700, background:'#3B82F6', color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>
              表示する
            </button>
          </div>
        ) : (<>
        <CesiumMap
          mode="3d"
          qualitySettings={cesiumQuality}
          winW={winState.cesium3d.w}
          winH={winState.cesium3d.h}
          focusNodeRef={focusNode3dRef}
          focusPosRef={focusPos3dRef}
          onFocusNode={focusNode}
          dragUpdateRef={cesium3dUpdateRef}
          dragStateRef={isDraggingRef}
          cesiumRenderRef={cesium3dRenderRef}
          cesiumQueryRef={cesium3dQueryRef}
          movedNodeRef={movedNodeRef}
          allMapPos={cesiumAllMapPos}
          nodes={nodes}
          segs={segs}
          segWp={segWp}
          wpZ={wpZ}
          mapZ={mapZ}
          setCurrentSSE={setCurrentSSE}
          plantNorthAngle={plantNorthAngle}
          setPlantNorthAngle={setPlantNorthAngle}
          hoverId={hoverId}
          hoverSeg={hoverSeg}
          setHoverId={setHoverId}
          setHoverSeg={setHoverSeg}
          setWireTip={setWireTip}
          routeFilter={routeFilter}
          routeSegs={routeSegs}
          setRouteFilter={setRouteFilter}
          onDropNode={cesiumOnDropNode}
          onAddWp={cesiumOnAddWp}
          onMoveWp={cesiumOnMoveWp}
          onDropWp={cesiumOnDropWp}
          onMoveNode={cesiumOnMoveNode}
          onStartDragNode={cesiumOnStartDragNode}
          onEndDragNode={cesiumOnEndDragNode}
          onRemoveWp={cesiumOnRemoveWp}
          blds={flatBlocks}
          solids={solids}
          setSolids={setSolids} setSolidsDirect={setSolidsDirect}
          hSections={hSections}
          onAddBuilding={(points, zTop) => {
            bldCounter.current++;
            const newId = `bld${bldCounter.current}`;
            const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
            const _zT = zTop || 40;
            setBuildings(prev => [...prev, {
              id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
              blocks: [{ points, zBottom: 0, zTop: _zT }],
            }]);
            // 面ベースSolidも同時生成
            const _newSolid = blockToSolid(newId, 0, `建屋${bldCounter.current}`, BLD_COLORS[colorIdx], points, 0, _zT);
            if (_newSolid) {
              setSolids(prev => [...prev, _newSolid]);
              console.warn('[SOLID] 新規Solid生成', { id: _newSolid.id, faces: _newSolid.faces.length, vertices: _newSolid._normPts.length });
              _dumpSolidFaces(_newSolid, '箱作成');
            }
          }}
          onResizeBuilding={(buildingId, blockIdx, newZTop) => {
            setBuildings(prev => prev.map(b =>
              b.id === buildingId ? {
                ...b, blocks: b.blocks.map((blk, i) =>
                  i === blockIdx ? { ...blk, zTop: newZTop } : blk
                )
              } : b
            ));
          }}
          onMoveBldFace={(buildingId, blockIdx, face, delta, moveAsSet, csgNormal) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const _tgtBlk = b.blocks[blockIdx];
              if (_tgtBlk) {
                const _ei = typeof face === 'number' ? face : parseInt(face, 10);
                const _pts = _tgtBlk.points, _n = _pts.length;
              }
              // 子ブロック（カーブ）の面移動はセット移動しない（親を動かすと相殺される）
              const isChild = b.blocks[blockIdx] && b.blocks[blockIdx]._parentBlockIdx != null;
              const descSet = new Set();
              if (moveAsSet === true && !isChild) {
                let root = blockIdx;
                while (b.blocks[root] && b.blocks[root]._parentBlockIdx != null) root = b.blocks[root]._parentBlockIdx;
                const groupSet = new Set([root]);
                let ch = true;
                while (ch) {
                  ch = false;
                  b.blocks.forEach((bl, idx) => {
                    if (!groupSet.has(idx) && bl._parentBlockIdx != null && groupSet.has(bl._parentBlockIdx)) {
                      groupSet.add(idx);
                      ch = true;
                    }
                  });
                }
                groupSet.forEach(idx => { if (idx !== blockIdx) descSet.add(idx); });
              }
              // === 内側方向クランプ（z面）: 箱を突き抜けない ===
              const _tgt = b.blocks[blockIdx];
              const _origDelta = delta;
              if (_tgt) {
                // ルート親の境界でクランプ（直接の親ではなく最上位の親）
                let _rootPar = _tgt._parentBlockIdx != null ? b.blocks[_tgt._parentBlockIdx] : null;
                if (_rootPar) {
                  while (_rootPar._parentBlockIdx != null) {
                    const _rp2 = b.blocks[_rootPar._parentBlockIdx];
                    if (_rp2) _rootPar = _rp2; else break;
                  }
                }
                // limBot: 親ありなら親のzBottom、親なし(ルート)なら0固定
                // _tgt.zBottomにするとdelta>=0に常時クランプされzBottomが下がれなくなるバグを防ぐ
                const limBot = _rootPar ? (_rootPar.zBottom || 0) : 0;
                const limTop = _rootPar ? (_rootPar.zTop != null ? _rootPar.zTop : 40) : (_tgt.zTop != null ? _tgt.zTop : 40);
                console.warn('[Z_CLAMP] 入力', {
                  face, delta: _origDelta.toFixed(3),
                  blkZB: (_tgt.zBottom||0).toFixed(3), blkZT: (_tgt.zTop||40).toFixed(3),
                  blk厚: ((_tgt.zTop||40)-(_tgt.zBottom||0)).toFixed(3),
                  ルート親: _rootPar ? `zB=${limBot.toFixed(1)} zT=${limTop.toFixed(1)}` : 'なし(自身が親)',
                  parentBlockIdx: _tgt._parentBlockIdx,
                });
                // Z面クランプ: 親境界を超えない + 自己整合性（zBottom<zTop）
                if (face === 'zTop' && delta < 0) {
                  delta = Math.max(delta, (_tgt.zBottom || 0) - (_tgt.zTop || 40) + 0.01);
                  delta = Math.max(delta, limBot - (_tgt.zTop || 40));
                } else if (face === 'zBottom' && delta < 0) {
                  delta = Math.max(delta, limBot - (_tgt.zBottom || 0));
                } else if (face === 'zBottom' && delta > 0) {
                  delta = Math.min(delta, (_tgt.zTop != null ? _tgt.zTop : 40) - (_tgt.zBottom || 0) - 0.01);
                  delta = Math.min(delta, limTop - (_tgt.zBottom || 0));
                } else if (face === 'zTop' && delta > 0 && _rootPar) {
                  delta = Math.min(delta, limTop - (_tgt.zTop || 40));
                }
                if (Math.abs(_origDelta - delta) > 0.001) {
                  console.warn('[Z_CLAMP] ⚠️クランプ発動', { 入力delta: _origDelta.toFixed(3), 出力delta: delta.toFixed(3), 削減量: (_origDelta-delta).toFixed(3) });
                } else {
                }
              }
              // 側面移動時の変位ベクトルを先に計算
              let dx = 0, dy = 0;
              const edgeIdx = typeof face === 'number' ? face : parseInt(face, 10);
              if (!isNaN(edgeIdx) && b.blocks[blockIdx]) {
                const pts = b.blocks[blockIdx].points;
                const n = pts.length;
                const p0 = pts[edgeIdx], p1 = pts[(edgeIdx + 1) % n];
                const ex = p1.x - p0.x, ey = p1.y - p0.y;
                const elen = Math.sqrt(ex * ex + ey * ey);
                if (elen >= 0.001) {
                  // CSG補正済み法線が渡されていればそれを使う（矢印方向と完全一致を保証）
                  let nx, ny;
                  if (csgNormal && csgNormal.nx != null) {
                    nx = csgNormal.nx; ny = csgNormal.ny;
                  } else {
                    nx = ey / elen; ny = -ex / elen;
                    const cx = pts.reduce((s, p) => s + p.x, 0) / n;
                    const cy = pts.reduce((s, p) => s + p.y, 0) / n;
                    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
                  }
                  // === 側面クランプ ===
                  const _sideBlk = b.blocks[blockIdx];
                  const _sidePar = _sideBlk && _sideBlk._parentBlockIdx != null ? b.blocks[_sideBlk._parentBlockIdx] : null;
                  if (_sidePar) {
                    // 子ブロック: 親内部方向のみクランプ、外向き（突き出し）は自由
                    const sw = _sideBlk._sharedWall;
                    const parPts = _sidePar.points;
                    const parN = parPts.length;
                    if (sw && sw.parentEdge != null) {
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
                        // nx,nyはCSG補正済み → isNormalInward=false (外向き)
                        const isNormalInward = false;
                        // 内向き移動のみクランプ（外向き=突き出しは自由）
                        const movingInward = (isNormalInward && delta > 0) || (!isNormalInward && delta < 0);
                        if (movingInward) {
                          let maxDepth = 0;
                          for (let pi = 0; pi < parN; pi++) {
                            const d = -((parPts[pi].x - pe0.x) * pnx + (parPts[pi].y - pe0.y) * pny);
                            if (d > maxDepth) maxDepth = d;
                          }
                          const curDepth = -((p0.x - pe0.x) * pnx + (p0.y - pe0.y) * pny);
                          const depthPerDelta = -(nx * pnx + ny * pny);
                          if (Math.abs(depthPerDelta) > 0.001) {
                            const newDepthIfFull = curDepth + depthPerDelta * delta;
                            if (newDepthIfFull > maxDepth - 0.02) {
                              delta = (maxDepth - curDepth) / depthPerDelta;
                            }
                          }
                        }
                      }
                    }
                  } else if (delta < 0) {
                    // 親ブロック: 自身の対向頂点を超えない（反転防止）
                    const _i0 = edgeIdx, _i1 = (edgeIdx + 1) % n;
                    let maxIn = Infinity;
                    for (let pi = 0; pi < n; pi++) {
                      if (pi === _i0 || pi === _i1) continue;
                      const proj = -((pts[pi].x - p0.x) * nx + (pts[pi].y - p0.y) * ny);
                      if (proj >= -0.01) maxIn = Math.min(maxIn, Math.max(0, proj));
                    }
                    if (maxIn < Infinity) delta = Math.max(delta, -maxIn);
                  }
                  dx = nx * delta; dy = ny * delta;
                }
              }

              // 子ブロックの面移動後に_sharedWall(uMin/uMax)を再計算
              const recalcSharedWall = (movedBlk, movedPts) => {
                if (!movedBlk._sharedWall) return movedBlk._sharedWall;
                const sw = movedBlk._sharedWall;
                const parentBlk = b.blocks[sw.parentBlockIdx];
                if (!parentBlk) return sw;
                const pe = sw.parentEdge;
                const pn = parentBlk.points.length;
                if (pe < 0 || pe >= pn) return sw;
                const pp0 = parentBlk.points[pe], pp1 = parentBlk.points[(pe + 1) % pn];
                const pex = pp1.x - pp0.x, pey = pp1.y - pp0.y;
                const pelen = Math.sqrt(pex * pex + pey * pey);
                if (pelen < 0.001) return sw;
                const eu = pex / pelen, ev = pey / pelen;
                const wi = sw.wallIdx, cn = movedPts.length;
                const cw0 = movedPts[wi], cw1 = movedPts[(wi + 1) % cn];
                const u0 = (cw0.x - pp0.x) * eu + (cw0.y - pp0.y) * ev;
                const u1 = (cw1.x - pp0.x) * eu + (cw1.y - pp0.y) * ev;
                return { ...sw, uMin: Math.min(u0, u1), uMax: Math.max(u0, u1) };
              };
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (i === blockIdx) {
                  if (face === 'zTop') return { ...blk, zTop: (blk.zTop || 40) + delta };
                  if (face === 'zBottom') return { ...blk, zBottom: (blk.zBottom || 0) + delta };
                  if (isNaN(edgeIdx)) return blk;
                  const pts = blk.points;
                  const n = pts.length;
                  const i0 = edgeIdx, i1 = (edgeIdx + 1) % n;
                  const newPts = pts.map((p, pi) => {
                    if (pi === i0 || pi === i1) return { ...p, x: p.x + dx, y: p.y + dy };
                    return p;
                  });
                  const newSw = recalcSharedWall(blk, newPts);
                  return { ...blk, points: newPts, ...(newSw !== blk._sharedWall ? { _sharedWall: newSw } : {}) };
                }
                // セット移動モード: グループ内の他ブロックも追随
                if (descSet.has(i)) {
                  if (!isNaN(edgeIdx) && (dx !== 0 || dy !== 0)) {
                    return { ...blk, points: blk.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
                  }
                  if (face === 'zTop') return { ...blk, zTop: (blk.zTop || 40) + delta };
                  if (face === 'zBottom') return { ...blk, zBottom: (blk.zBottom || 0) + delta };
                }
                return blk;
              })};
            }));
          }}
          onDeleteBuilding={(buildingId) => {
            setBuildings(prev => prev.filter(b => b.id !== buildingId));
          }}
          onRotateBuilding={(buildingId, blockIdx, angle) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const targetBlk = b.blocks[blockIdx];
              if (!targetBlk) return b;
              // グループ全体を収集（親→ルート→全子孫）
              let root = blockIdx;
              while (b.blocks[root] && b.blocks[root]._parentBlockIdx != null) root = b.blocks[root]._parentBlockIdx;
              const rotSet = new Set([root]);
              let ch = true;
              while (ch) {
                ch = false;
                b.blocks.forEach((bl, idx) => {
                  if (!rotSet.has(idx) && bl._parentBlockIdx != null && rotSet.has(bl._parentBlockIdx)) {
                    rotSet.add(idx);
                    ch = true;
                  }
                });
              }
              const tpts = targetBlk.points;
              const cx = tpts.reduce((s, p) => s + p.x, 0) / tpts.length;
              const cy = tpts.reduce((s, p) => s + p.y, 0) / tpts.length;
              const cos = Math.cos(angle), sin = Math.sin(angle);
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (rotSet.has(i)) {
                  const newPts = blk.points.map(p => {
                    const dx = p.x - cx, dy = p.y - cy;
                    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
                  });
                  return { ...blk, points: newPts };
                }
                return blk;
              })};
            }));
          }}
          onMoveBuilding={(buildingId, blockIdx, dx, dy) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              // 親をたどってルートを見つけ、ルートから全子孫を収集（グループ全体）
              let root = blockIdx;
              while (b.blocks[root] && b.blocks[root]._parentBlockIdx != null) root = b.blocks[root]._parentBlockIdx;
              const moveSet = new Set([root]);
              let changed = true;
              while (changed) {
                changed = false;
                b.blocks.forEach((blk, i) => {
                  if (!moveSet.has(i) && blk._parentBlockIdx != null && moveSet.has(blk._parentBlockIdx)) {
                    moveSet.add(i);
                    changed = true;
                  }
                });
              }
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (moveSet.has(i)) {
                  return { ...blk, points: blk.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
                }
                return blk;
              })};
            }));
          }}
          onAddBlock={(buildingId, points, zBottom, zTop, extraProps) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              return { ...b, blocks: [...b.blocks, { points, zBottom, zTop, ...extraProps }] };
            }));
          }}
          onSetBlockPoints={(buildingId, blockIdx, newPoints, preExtrudePoints) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (i !== blockIdx) return blk;
                const updated = { ...blk, points: newPoints, ...(preExtrudePoints ? { _preExtrudePoints: preExtrudePoints } : {}) };
                // 子ブロックの場合: 頂点数変化時にwallIdxを再計算
                if (updated._sharedWall && updated._sharedWall.parentBlockIdx != null) {
                  const sw = updated._sharedWall;
                  const parent = b.blocks[sw.parentBlockIdx];
                  if (parent && sw.parentEdge != null) {
                    const pe = sw.parentEdge;
                    const pPts = parent.points;
                    const pp0 = pPts[pe], pp1 = pPts[(pe + 1) % pPts.length];
                    // 親辺の方向ベクトル
                    const pdx = pp1.x - pp0.x, pdy = pp1.y - pp0.y;
                    const pLen = Math.sqrt(pdx * pdx + pdy * pdy);
                    if (pLen > 0.01) {
                      const pux = pdx / pLen, puy = pdy / pLen;
                      // 新ポリゴンの各辺が親辺上にあるか判定（垂直距離が小さい辺）
                      let bestWall = sw.wallIdx;
                      let bestDist = Infinity;
                      for (let ei = 0; ei < newPoints.length; ei++) {
                        const a = newPoints[ei], bb = newPoints[(ei + 1) % newPoints.length];
                        // 辺の中点の親辺からの垂直距離
                        const mx = (a.x + bb.x) / 2 - pp0.x;
                        const my = (a.y + bb.y) / 2 - pp0.y;
                        const perpDist = Math.abs(mx * (-puy) + my * pux);
                        // 辺の方向が親辺と平行か（内積）
                        const edx = bb.x - a.x, edy = bb.y - a.y;
                        const eLen = Math.sqrt(edx * edx + edy * edy);
                        if (eLen < 0.01) continue;
                        const dot = Math.abs((edx / eLen) * pux + (edy / eLen) * puy);
                        if (perpDist < bestDist && dot > 0.9) {
                          bestDist = perpDist;
                          bestWall = ei;
                        }
                      }
                      if (bestWall !== sw.wallIdx) {
                        console.warn('[WALL_IDX_FIX] wallIdx更新', { old: sw.wallIdx, new: bestWall, perpDist: bestDist.toFixed(2) });
                      }
                      updated._sharedWall = { ...sw, wallIdx: bestWall };
                    }
                  }
                }
                return updated;
              })};
            }));
          }}
          onDeleteBlock={(buildingId, blockIdx) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const newBlocks = b.blocks.filter((_, i) => i !== blockIdx);
              if (newBlocks.length === 0) return null; // ブロックが0なら建屋削除
              return { ...b, blocks: newBlocks };
            }).filter(Boolean));
          }}
          onRevertExtrude={(buildingId, blockIdx) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (i !== blockIdx || !blk._preExtrudePoints) return blk;
                const { _preExtrudePoints, ...rest } = blk;
                return { ...rest, points: _preExtrudePoints };
              })};
            }));
          }}
          onMergeBlockIntoParent={(buildingId, childBlockIdx) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const child = b.blocks[childBlockIdx];
              if (!child || child._parentBlockIdx == null || !child._sharedWall) return b;
              const parentIdx = child._parentBlockIdx;
              const parent = b.blocks[parentIdx];
              if (!parent) return b;
              const sw = child._sharedWall;
              const pp = parent.points, pn = pp.length;
              const cp = child.points, cn = cp.length;
              // 親のポリゴンに子の突起頂点を挿入してL字型を作る
              const merged = [];
              const ei = sw.parentEdge;
              const e0 = pp[ei], e1 = pp[(ei + 1) % pn];
              const el = Math.sqrt((e1.x - e0.x) ** 2 + (e1.y - e0.y) ** 2);
              for (let i = 0; i < pn; i++) {
                merged.push({ ...pp[i] });
                if (i === ei && el >= 0.001) {
                  const tMin = sw.uMin / el, tMax = sw.uMax / el;
                  const wi = sw.wallIdx;
                  // splitMin（共有辺の開始点が辺の端でなければ分割点を追加）
                  if (tMin > 0.001) merged.push({ x: e0.x + (e1.x - e0.x) * tMin, y: e0.y + (e1.y - e0.y) * tMin });
                  // 子の突起頂点（共有壁以外の頂点を順に追加）
                  for (let j = 2; j < cn; j++) merged.push({ ...cp[(wi + j) % cn] });
                  // splitMax（共有辺の終了点が辺の端でなければ分割点を追加）
                  if (tMax < 1 - 0.001) merged.push({ x: e0.x + (e1.x - e0.x) * tMax, y: e0.y + (e1.y - e0.y) * tMax });
                }
              }
              // 親のZ範囲を維持、子のzが広ければ拡張
              const newZBot = Math.min(parent.zBottom || 0, child.zBottom || 0);
              const newZTop = Math.max(parent.zTop != null ? parent.zTop : 40, child.zTop != null ? child.zTop : 40);
              // 親ブロックを更新、子ブロックを削除
              const newBlocks = b.blocks.map((blk, i) => {
                if (i === parentIdx) {
                  return { ...blk, points: merged, zBottom: newZBot, zTop: newZTop, _sharedWall: null, _preExtrudePoints: null };
                }
                return blk;
              }).filter((_, i) => i !== childBlockIdx);
              // 残りのブロックの_parentBlockIdxを調整（削除によるインデックスずれ）
              const newParentIdx = parentIdx > childBlockIdx ? parentIdx - 1 : parentIdx;
              return { ...b, blocks: newBlocks.map(blk => {
                if (blk._parentBlockIdx == null) return blk;
                let pi = blk._parentBlockIdx;
                if (pi === childBlockIdx) pi = parentIdx; // 子の子→親に付け替え
                if (pi > childBlockIdx) pi--; // 削除分ずらす
                return { ...blk, _parentBlockIdx: pi };
              })};
            }));
          }}
          onRenameBuilding={(buildingId, newLabel) => setBuildings(prev => prev.map(b => b.id === buildingId ? { ...b, label: newLabel } : b))}
          onBaseElevChange={(elev) => setSiteBaseElev(elev)}
          onBldUndo={bldUndo}
          onBldRedo={bldRedo}
          onBldPushUndo={bldPushUndo}
          onRemoveNodePos={(nodeId) => {
            setMapPos(pr => { const r = { ...pr }; delete r[nodeId]; return r; });
            setMapZ(pr => { const r = { ...pr }; delete r[nodeId]; return r; });
          }}
          sectionOverlays={sectionOverlays}
          onFocusBld={focusBld}
          onDeleteBld={(bid) => { setBuildings(bs => bs.filter(b => b.id !== bid)); setSelectedBld(null); }}
        />
        {/* 画質設定パネル */}
        {cesium3dGearOpen && (() => {
          const msaaSteps = [1, 2, 4, 8];
          const msaaIdx = msaaSteps.indexOf(cesiumQuality.msaa);
          const row = (label, ctrl) => (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              <span style={{ fontSize: 10, color: '#CBD5E1', width: 96, flexShrink: 0 }}>{label}</span>
              {ctrl}
            </div>
          );
          const toggle = (key) => (
            <button onClick={() => setCesiumQuality(p => ({ ...p, [key]: !p[key] }))}
              style={{ fontSize: 9, padding: '1px 8px', borderRadius: 3, border: 'none', cursor: 'pointer', background: cesiumQuality[key] ? '#6366F1' : '#334155', color: '#FFF', fontWeight: 700 }}>
              {cesiumQuality[key] ? 'ON' : 'OFF'}
            </button>
          );
          return (
            <div onMouseDown={e => e.stopPropagation()}
              style={{ position: 'absolute', top: 8, right: 8, zIndex: 500, background: 'rgba(15,23,42,0.93)', borderRadius: 6, padding: '8px 10px', minWidth: 230, boxShadow: '0 4px 16px rgba(0,0,0,0.5)', border: '1px solid #334155' }}>
              {/* === 画質/速度設定 === */}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', marginBottom: 6, borderBottom: '1px solid #334155', paddingBottom: 4 }}>🎛 画質 / 速度設定</div>
              {row('画面の鮮明さ',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={0.5} max={2.0} step={0.25} value={cesiumQuality.resolutionScale}
                    onChange={e => setCesiumQuality(p => ({ ...p, resolutionScale: parseFloat(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 28, textAlign: 'right' }}>{cesiumQuality.resolutionScale.toFixed(2)}</span>
                </div>
              )}
              {row('遠方建物の細かさ',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={1} max={32} step={1} value={33 - cesiumQuality.sse}
                    onChange={e => setCesiumQuality(p => ({ ...p, sse: 33 - parseInt(e.target.value), sseManual: true }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 28, textAlign: 'right' }}>{cesiumQuality.sse}</span>
                  <button onClick={() => setCesiumQuality(p => ({ ...p, sse: 8, sseManual: false }))}
                    style={{ fontSize: 8, padding: '1px 4px', borderRadius: 2, border: 'none', cursor: 'pointer', background: cesiumQuality.sseManual ? '#6366F1' : '#475569', color: cesiumQuality.sseManual ? '#FFF' : '#64748B', opacity: cesiumQuality.sseManual ? 1 : 0.5 }}>自動</button>
                </div>
              )}
              {row('輪郭の滑らかさ',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={0} max={3} step={1} value={Math.max(0, msaaIdx)}
                    onChange={e => setCesiumQuality(p => ({ ...p, msaa: msaaSteps[parseInt(e.target.value)] }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 28, textAlign: 'right' }}>x{cesiumQuality.msaa}</span>
                </div>
              )}
              {row('スクロール中画質抑制',
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {toggle('scrollLowQ')}
                  {cesiumQuality.scrollLowQ && (<>
                    <input type="range" min={0.25} max={0.95} step={0.05} value={cesiumQuality.scrollLowQScale}
                      onChange={e => setCesiumQuality(p => ({ ...p, scrollLowQScale: parseFloat(e.target.value) }))}
                      style={{ width: 70 }} />
                    <span style={{ fontSize: 10, color: '#F8FAFC', width: 28, textAlign: 'right' }}>{Math.round(cesiumQuality.scrollLowQScale * 100)}%</span>
                  </>)}
                </div>
              )}
              {cesiumQuality.scrollLowQ && row('　└ 適用上限高度',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={100} max={5000} step={100} value={cesiumQuality.scrollLowQMaxAlt}
                    onChange={e => setCesiumQuality(p => ({ ...p, scrollLowQMaxAlt: parseInt(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 42, textAlign: 'right' }}>{cesiumQuality.scrollLowQMaxAlt}m以下</span>
                </div>
              )}
              {row('スクロール2D化',
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {toggle('scroll2D')}
                </div>
              )}
              {row('遠景の省略',
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {toggle('skipLOD')}
                </div>
              )}
              {/* === 地下設定 === */}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', margin: '8px 0 4px', borderTop: '1px solid #334155', paddingTop: 6 }}>🌐 地下設定</div>
              {row('マップの透明度',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={0.0} max={1.0} step={0.05} value={1.0 - cesiumQuality.satelliteAlpha}
                    onChange={e => setCesiumQuality(p => ({ ...p, satelliteAlpha: 1.0 - parseFloat(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 28, textAlign: 'right' }}>{Math.round((1.0 - cesiumQuality.satelliteAlpha) * 100)}%</span>
                </div>
              )}
              {row('マップ非表示距離',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={0} max={50} step={1} value={cesiumQuality.nearClipDist}
                    onChange={e => setCesiumQuality(p => ({ ...p, nearClipDist: parseInt(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 36, textAlign: 'right' }}>{cesiumQuality.nearClipDist}m</span>
                  {cesiumQuality.nearClipDist > 0 && (
                    <button onClick={() => setCesiumQuality(p => ({ ...p, nearClipDist: 0 }))}
                      style={{ fontSize: 8, padding: '1px 4px', borderRadius: 2, border: 'none', cursor: 'pointer', background: 'rgba(255,80,80,0.7)', color: '#fff' }}>戻す</button>
                  )}
                </div>
              )}
              {row('地下グリッド',
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={() => setCesiumQuality(p => ({ ...p, undergroundGrid: !p.undergroundGrid }))}
                    style={{ fontSize: 9, padding: '1px 8px', borderRadius: 3, border: 'none', cursor: 'pointer', background: cesiumQuality.undergroundGrid ? '#6366F1' : '#334155', color: '#FFF', fontWeight: 700 }}>
                    {cesiumQuality.undergroundGrid ? 'ON' : 'OFF'}
                  </button>
                  <span style={{ fontSize: 9, color: '#94A3B8' }}>グリッドの色</span>
                  <input type="color" value={cesiumQuality.undergroundGridColor ?? '#FFFFFF'}
                    onChange={e => setCesiumQuality(p => ({ ...p, undergroundGridColor: e.target.value }))}
                    style={{ width: 32, height: 18, border: 'none', borderRadius: 3, cursor: 'pointer', background: 'none', padding: 0 }} />
                  <span style={{ fontSize: 9, color: '#94A3B8' }}>床の色</span>
                  <input type="color" value={cesiumQuality.undergroundColor ?? '#000000'}
                    onChange={e => setCesiumQuality(p => ({ ...p, undergroundColor: e.target.value }))}
                    style={{ width: 32, height: 18, border: 'none', borderRadius: 3, cursor: 'pointer', background: 'none', padding: 0 }} />
                </div>
              )}
              {row('地面からの深さ',
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input type="range" min={1} max={100} step={1} value={cesiumQuality.undergroundDepth}
                    onChange={e => setCesiumQuality(p => ({ ...p, undergroundDepth: parseInt(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#F8FAFC', width: 36, textAlign: 'right' }}>{cesiumQuality.undergroundDepth}m</span>
                </div>
              )}
              {row('地下wire仕様',
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => setCesiumQuality(p => ({ ...p, ugWireHighlight: !p.ugWireHighlight }))}
                    style={{ fontSize: 9, padding: '1px 8px', borderRadius: 3, border: 'none', cursor: 'pointer', background: cesiumQuality.ugWireHighlight ? '#0891B2' : '#334155', color: '#FFF', fontWeight: 700 }}>
                    {cesiumQuality.ugWireHighlight ? '白縁強調' : 'OFF'}
                  </button>
                </div>
              )}
              <div style={{ marginTop: 6, borderTop: '1px solid #334155', paddingTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => setCesiumQuality({ resolutionScale: window.devicePixelRatio || 1, sse: 8, msaa: 4, skipLOD: false, skyAtmosphere: false, sseManual: false, satelliteAlpha: 1.0, nearClipDist: 0, undergroundGrid: true, undergroundGridColor: '#FFFFFF', undergroundColor: '#000000', undergroundDepth: 10, ugWireHighlight: false, scroll2D: false, scrollLowQ: false, scrollLowQScale: 0.75, scrollLowQMaxAlt: 1000 })}
                  style={{ fontSize: 9, padding: '2px 8px', borderRadius: 3, border: 'none', cursor: 'pointer', background: '#334155', color: '#94A3B8' }}>デフォルトに戻す</button>
              </div>
            </div>
          );
        })()}
        </>)}
        </div>{/* position:relative wrapper */}
      </FloatWin>

      {/* MERGE DEBUG: catch rendering errors */}
      {(() => { try { void (flatBlocks || []); } catch(e) { document.title = 'FLAT-ERR:' + e.message; } return null; })()}

      {/* CesiumJS 2Dウィンドウ */}
      <FloatWin id="cesium2d" title="CesiumJS 2D" winState={winState} setWinState={setWinState} bringFront={bringFront} keepMounted>
        {!cesium2dLoaded ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', width:'100%', height:'100%', background:'#1E293B' }}>
            <button onClick={() => setCesium2dLoaded(true)}
              style={{ padding:'10px 28px', fontSize:14, fontWeight:700, background:'#3B82F6', color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>
              表示する
            </button>
          </div>
        ) : (
        <CesiumMap
          mode="2d"
          sharedBaseElev={siteBaseElev}
          winW={winState.cesium2d.w}
          winH={winState.cesium2d.h}
          focusNodeRef={focusNode2dRef}
          focusPosRef={focusPos2dRef}
          onFocusNode={focusNode}
          dragUpdateRef={cesium2dUpdateRef}
          dragStateRef={isDraggingRef}
          cesiumRenderRef={cesium2dRenderRef}
          cesiumQueryRef={cesium2dQueryRef}
          movedNodeRef={movedNodeRef}
          allMapPos={cesiumAllMapPos}
          nodes={nodes}
          segs={segs}
          segWp={segWp}
          wpZ={wpZ}
          mapZ={mapZ}
          plantNorthAngle={plantNorthAngle}
          setPlantNorthAngle={setPlantNorthAngle}
          hoverId={hoverId}
          hoverSeg={hoverSeg}
          setHoverId={setHoverId}
          setWireTip={setWireTip}
          setHoverSeg={setHoverSeg}
          routeFilter={routeFilter}
          routeSegs={routeSegs}
          setRouteFilter={setRouteFilter}
          onDropNode={cesiumOnDropNode}
          onAddWp={cesiumOnAddWp}
          onMoveWp={cesiumOnMoveWp}
          onDropWp={cesiumOnDropWp}
          onMoveNode={cesiumOnMoveNode}
          onStartDragNode={cesiumOnStartDragNode}
          onEndDragNode={cesiumOnEndDragNode}
          onRemoveWp={cesiumOnRemoveWp}
          blds={flatBlocks}
          solids={solids}
          setSolids={setSolids} setSolidsDirect={setSolidsDirect}
          hSections={hSections}
          onAddBuilding={(points, zTop) => {
            bldCounter.current++;
            const newId = `bld${bldCounter.current}`;
            const colorIdx = (bldCounter.current - 1) % BLD_COLORS.length;
            const _zT = zTop || 40;
            setBuildings(prev => [...prev, {
              id: newId, label: `建屋${bldCounter.current}`, color: BLD_COLORS[colorIdx],
              blocks: [{ points, zBottom: 0, zTop: _zT }],
            }]);
            // 面ベースSolidも同時生成
            const _newSolid = blockToSolid(newId, 0, `建屋${bldCounter.current}`, BLD_COLORS[colorIdx], points, 0, _zT);
            if (_newSolid) {
              setSolids(prev => [...prev, _newSolid]);
              console.warn('[SOLID] 新規Solid生成', { id: _newSolid.id, faces: _newSolid.faces.length, vertices: _newSolid._normPts.length });
              _dumpSolidFaces(_newSolid, '箱作成');
            }
          }}
          onResizeBuilding={(buildingId, blockIdx, newZTop) => {
            setBuildings(prev => prev.map(b =>
              b.id === buildingId ? {
                ...b, blocks: b.blocks.map((blk, i) =>
                  i === blockIdx ? { ...blk, zTop: newZTop } : blk
                )
              } : b
            ));
          }}
          onMoveBldFace={(buildingId, blockIdx, face, delta, moveAsSet, csgNormal) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              // 子ブロック（カーブ）の面移動はセット移動しない（親を動かすと相殺される）
              const isChild = b.blocks[blockIdx] && b.blocks[blockIdx]._parentBlockIdx != null;
              const descSet = new Set();
              if (moveAsSet === true && !isChild) {
                let root = blockIdx;
                while (b.blocks[root] && b.blocks[root]._parentBlockIdx != null) root = b.blocks[root]._parentBlockIdx;
                const groupSet = new Set([root]);
                let ch = true;
                while (ch) {
                  ch = false;
                  b.blocks.forEach((bl, idx) => {
                    if (!groupSet.has(idx) && bl._parentBlockIdx != null && groupSet.has(bl._parentBlockIdx)) {
                      groupSet.add(idx);
                      ch = true;
                    }
                  });
                }
                groupSet.forEach(idx => { if (idx !== blockIdx) descSet.add(idx); });
              }
              // === 内側方向クランプ（z面）: 箱を突き抜けない ===
              const _tgt = b.blocks[blockIdx];
              const _origDelta = delta;
              if (_tgt) {
                // ルート親の境界でクランプ（直接の親ではなく最上位の親）
                let _rootPar = _tgt._parentBlockIdx != null ? b.blocks[_tgt._parentBlockIdx] : null;
                if (_rootPar) {
                  while (_rootPar._parentBlockIdx != null) {
                    const _rp2 = b.blocks[_rootPar._parentBlockIdx];
                    if (_rp2) _rootPar = _rp2; else break;
                  }
                }
                // limBot: 親ありなら親のzBottom、親なし(ルート)なら0固定
                // _tgt.zBottomにするとdelta>=0に常時クランプされzBottomが下がれなくなるバグを防ぐ
                const limBot = _rootPar ? (_rootPar.zBottom || 0) : 0;
                const limTop = _rootPar ? (_rootPar.zTop != null ? _rootPar.zTop : 40) : (_tgt.zTop != null ? _tgt.zTop : 40);
                console.warn('[Z_CLAMP] 入力', {
                  face, delta: _origDelta.toFixed(3),
                  blkZB: (_tgt.zBottom||0).toFixed(3), blkZT: (_tgt.zTop||40).toFixed(3),
                  blk厚: ((_tgt.zTop||40)-(_tgt.zBottom||0)).toFixed(3),
                  ルート親: _rootPar ? `zB=${limBot.toFixed(1)} zT=${limTop.toFixed(1)}` : 'なし(自身が親)',
                  parentBlockIdx: _tgt._parentBlockIdx,
                });
                // Z面クランプ: 親境界を超えない + 自己整合性（zBottom<zTop）
                if (face === 'zTop' && delta < 0) {
                  delta = Math.max(delta, (_tgt.zBottom || 0) - (_tgt.zTop || 40) + 0.01);
                  delta = Math.max(delta, limBot - (_tgt.zTop || 40));
                } else if (face === 'zBottom' && delta < 0) {
                  delta = Math.max(delta, limBot - (_tgt.zBottom || 0));
                } else if (face === 'zBottom' && delta > 0) {
                  delta = Math.min(delta, (_tgt.zTop != null ? _tgt.zTop : 40) - (_tgt.zBottom || 0) - 0.01);
                  delta = Math.min(delta, limTop - (_tgt.zBottom || 0));
                } else if (face === 'zTop' && delta > 0 && _rootPar) {
                  delta = Math.min(delta, limTop - (_tgt.zTop || 40));
                }
                if (Math.abs(_origDelta - delta) > 0.001) {
                  console.warn('[Z_CLAMP] ⚠️クランプ発動', { 入力delta: _origDelta.toFixed(3), 出力delta: delta.toFixed(3), 削減量: (_origDelta-delta).toFixed(3) });
                } else {
                }
              }
              // 側面移動時の変位ベクトルを先に計算
              let dx = 0, dy = 0;
              const edgeIdx = typeof face === 'number' ? face : parseInt(face, 10);
              if (!isNaN(edgeIdx) && b.blocks[blockIdx]) {
                const pts = b.blocks[blockIdx].points;
                const n = pts.length;
                const p0 = pts[edgeIdx], p1 = pts[(edgeIdx + 1) % n];
                const ex = p1.x - p0.x, ey = p1.y - p0.y;
                const elen = Math.sqrt(ex * ex + ey * ey);
                if (elen >= 0.001) {
                  // CSG補正済み法線が渡されていればそれを使う（矢印方向と完全一致を保証）
                  let nx, ny;
                  if (csgNormal && csgNormal.nx != null) {
                    nx = csgNormal.nx; ny = csgNormal.ny;
                  } else {
                    nx = ey / elen; ny = -ex / elen;
                    const cx = pts.reduce((s, p) => s + p.x, 0) / n;
                    const cy = pts.reduce((s, p) => s + p.y, 0) / n;
                    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
                  }
                  // === 側面クランプ ===
                  const _sideBlk = b.blocks[blockIdx];
                  const _sidePar = _sideBlk && _sideBlk._parentBlockIdx != null ? b.blocks[_sideBlk._parentBlockIdx] : null;
                  if (_sidePar) {
                    // 子ブロック: 親内部方向のみクランプ、外向き（突き出し）は自由
                    const sw = _sideBlk._sharedWall;
                    const parPts = _sidePar.points;
                    const parN = parPts.length;
                    if (sw && sw.parentEdge != null) {
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
                        // nx,nyはCSG補正済み → isNormalInward=false (外向き)
                        const isNormalInward = false;
                        // 内向き移動のみクランプ（外向き=突き出しは自由）
                        const movingInward = (isNormalInward && delta > 0) || (!isNormalInward && delta < 0);
                        if (movingInward) {
                          let maxDepth = 0;
                          for (let pi = 0; pi < parN; pi++) {
                            const d = -((parPts[pi].x - pe0.x) * pnx + (parPts[pi].y - pe0.y) * pny);
                            if (d > maxDepth) maxDepth = d;
                          }
                          const curDepth = -((p0.x - pe0.x) * pnx + (p0.y - pe0.y) * pny);
                          const depthPerDelta = -(nx * pnx + ny * pny);
                          if (Math.abs(depthPerDelta) > 0.001) {
                            const newDepthIfFull = curDepth + depthPerDelta * delta;
                            if (newDepthIfFull > maxDepth - 0.02) {
                              delta = (maxDepth - curDepth) / depthPerDelta;
                            }
                          }
                        }
                      }
                    }
                  } else if (delta < 0) {
                    // 親ブロック: 自身の対向頂点を超えない（反転防止）
                    const _i0 = edgeIdx, _i1 = (edgeIdx + 1) % n;
                    let maxIn = Infinity;
                    for (let pi = 0; pi < n; pi++) {
                      if (pi === _i0 || pi === _i1) continue;
                      const proj = -((pts[pi].x - p0.x) * nx + (pts[pi].y - p0.y) * ny);
                      if (proj >= -0.01) maxIn = Math.min(maxIn, Math.max(0, proj));
                    }
                    if (maxIn < Infinity) delta = Math.max(delta, -maxIn);
                  }
                  dx = nx * delta; dy = ny * delta;
                }
              }

              // 子ブロックの面移動後に_sharedWall(uMin/uMax)を再計算
              const recalcSharedWall = (movedBlk, movedPts) => {
                if (!movedBlk._sharedWall) return movedBlk._sharedWall;
                const sw = movedBlk._sharedWall;
                const parentBlk = b.blocks[sw.parentBlockIdx];
                if (!parentBlk) return sw;
                const pe = sw.parentEdge;
                const pn = parentBlk.points.length;
                if (pe < 0 || pe >= pn) return sw;
                const pp0 = parentBlk.points[pe], pp1 = parentBlk.points[(pe + 1) % pn];
                const pex = pp1.x - pp0.x, pey = pp1.y - pp0.y;
                const pelen = Math.sqrt(pex * pex + pey * pey);
                if (pelen < 0.001) return sw;
                const eu = pex / pelen, ev = pey / pelen;
                const wi = sw.wallIdx, cn = movedPts.length;
                const cw0 = movedPts[wi], cw1 = movedPts[(wi + 1) % cn];
                const u0 = (cw0.x - pp0.x) * eu + (cw0.y - pp0.y) * ev;
                const u1 = (cw1.x - pp0.x) * eu + (cw1.y - pp0.y) * ev;
                return { ...sw, uMin: Math.min(u0, u1), uMax: Math.max(u0, u1) };
              };
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (i === blockIdx) {
                  if (face === 'zTop') return { ...blk, zTop: (blk.zTop || 40) + delta };
                  if (face === 'zBottom') return { ...blk, zBottom: (blk.zBottom || 0) + delta };
                  if (isNaN(edgeIdx)) return blk;
                  const pts = blk.points;
                  const n = pts.length;
                  const i0 = edgeIdx, i1 = (edgeIdx + 1) % n;
                  const newPts = pts.map((p, pi) => {
                    if (pi === i0 || pi === i1) return { ...p, x: p.x + dx, y: p.y + dy };
                    return p;
                  });
                  const newSw = recalcSharedWall(blk, newPts);
                  return { ...blk, points: newPts, ...(newSw !== blk._sharedWall ? { _sharedWall: newSw } : {}) };
                }
                // セット移動モード: グループ内の他ブロックも追随
                if (descSet.has(i)) {
                  if (!isNaN(edgeIdx) && (dx !== 0 || dy !== 0)) {
                    return { ...blk, points: blk.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
                  }
                  if (face === 'zTop') return { ...blk, zTop: (blk.zTop || 40) + delta };
                  if (face === 'zBottom') return { ...blk, zBottom: (blk.zBottom || 0) + delta };
                }
                return blk;
              })};
            }));
          }}
          onDeleteBuilding={(buildingId) => {
            setBuildings(prev => prev.filter(b => b.id !== buildingId));
          }}
          onRotateBuilding={(buildingId, blockIdx, angle) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const targetBlk = b.blocks[blockIdx];
              if (!targetBlk) return b;
              // グループ全体を収集（親→ルート→全子孫）
              let root = blockIdx;
              while (b.blocks[root] && b.blocks[root]._parentBlockIdx != null) root = b.blocks[root]._parentBlockIdx;
              const rotSet = new Set([root]);
              let ch = true;
              while (ch) {
                ch = false;
                b.blocks.forEach((bl, idx) => {
                  if (!rotSet.has(idx) && bl._parentBlockIdx != null && rotSet.has(bl._parentBlockIdx)) {
                    rotSet.add(idx);
                    ch = true;
                  }
                });
              }
              const tpts = targetBlk.points;
              const cx = tpts.reduce((s, p) => s + p.x, 0) / tpts.length;
              const cy = tpts.reduce((s, p) => s + p.y, 0) / tpts.length;
              const cos = Math.cos(angle), sin = Math.sin(angle);
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (rotSet.has(i)) {
                  const newPts = blk.points.map(p => {
                    const dx = p.x - cx, dy = p.y - cy;
                    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
                  });
                  return { ...blk, points: newPts };
                }
                return blk;
              })};
            }));
          }}
          onMoveBuilding={(buildingId, blockIdx, dx, dy) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              // 親をたどってルートを見つけ、ルートから全子孫を収集（グループ全体）
              let root = blockIdx;
              while (b.blocks[root] && b.blocks[root]._parentBlockIdx != null) root = b.blocks[root]._parentBlockIdx;
              const moveSet = new Set([root]);
              let changed = true;
              while (changed) {
                changed = false;
                b.blocks.forEach((blk, i) => {
                  if (!moveSet.has(i) && blk._parentBlockIdx != null && moveSet.has(blk._parentBlockIdx)) {
                    moveSet.add(i);
                    changed = true;
                  }
                });
              }
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (moveSet.has(i)) {
                  return { ...blk, points: blk.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
                }
                return blk;
              })};
            }));
          }}
          onAddBlock={(buildingId, points, zBottom, zTop, extraProps) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              return { ...b, blocks: [...b.blocks, { points, zBottom, zTop, ...extraProps }] };
            }));
          }}
          onSetBlockPoints={(buildingId, blockIdx, newPoints, preExtrudePoints) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (i !== blockIdx) return blk;
                const updated = { ...blk, points: newPoints, ...(preExtrudePoints ? { _preExtrudePoints: preExtrudePoints } : {}) };
                // 子ブロックの場合: 頂点数変化時にwallIdxを再計算
                if (updated._sharedWall && updated._sharedWall.parentBlockIdx != null) {
                  const sw = updated._sharedWall;
                  const parent = b.blocks[sw.parentBlockIdx];
                  if (parent && sw.parentEdge != null) {
                    const pe = sw.parentEdge;
                    const pPts = parent.points;
                    const pp0 = pPts[pe], pp1 = pPts[(pe + 1) % pPts.length];
                    // 親辺の方向ベクトル
                    const pdx = pp1.x - pp0.x, pdy = pp1.y - pp0.y;
                    const pLen = Math.sqrt(pdx * pdx + pdy * pdy);
                    if (pLen > 0.01) {
                      const pux = pdx / pLen, puy = pdy / pLen;
                      // 新ポリゴンの各辺が親辺上にあるか判定（垂直距離が小さい辺）
                      let bestWall = sw.wallIdx;
                      let bestDist = Infinity;
                      for (let ei = 0; ei < newPoints.length; ei++) {
                        const a = newPoints[ei], bb = newPoints[(ei + 1) % newPoints.length];
                        // 辺の中点の親辺からの垂直距離
                        const mx = (a.x + bb.x) / 2 - pp0.x;
                        const my = (a.y + bb.y) / 2 - pp0.y;
                        const perpDist = Math.abs(mx * (-puy) + my * pux);
                        // 辺の方向が親辺と平行か（内積）
                        const edx = bb.x - a.x, edy = bb.y - a.y;
                        const eLen = Math.sqrt(edx * edx + edy * edy);
                        if (eLen < 0.01) continue;
                        const dot = Math.abs((edx / eLen) * pux + (edy / eLen) * puy);
                        if (perpDist < bestDist && dot > 0.9) {
                          bestDist = perpDist;
                          bestWall = ei;
                        }
                      }
                      if (bestWall !== sw.wallIdx) {
                        console.warn('[WALL_IDX_FIX] wallIdx更新', { old: sw.wallIdx, new: bestWall, perpDist: bestDist.toFixed(2) });
                      }
                      updated._sharedWall = { ...sw, wallIdx: bestWall };
                    }
                  }
                }
                return updated;
              })};
            }));
          }}
          onDeleteBlock={(buildingId, blockIdx) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const newBlocks = b.blocks.filter((_, i) => i !== blockIdx);
              if (newBlocks.length === 0) return null; // ブロックが0なら建屋削除
              return { ...b, blocks: newBlocks };
            }).filter(Boolean));
          }}
          onRevertExtrude={(buildingId, blockIdx) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              return { ...b, blocks: b.blocks.map((blk, i) => {
                if (i !== blockIdx || !blk._preExtrudePoints) return blk;
                const { _preExtrudePoints, ...rest } = blk;
                return { ...rest, points: _preExtrudePoints };
              })};
            }));
          }}
          onMergeBlockIntoParent={(buildingId, childBlockIdx) => {
            setBuildings(prev => prev.map(b => {
              if (b.id !== buildingId) return b;
              const child = b.blocks[childBlockIdx];
              if (!child || child._parentBlockIdx == null || !child._sharedWall) return b;
              const parentIdx = child._parentBlockIdx;
              const parent = b.blocks[parentIdx];
              if (!parent) return b;
              const sw = child._sharedWall;
              const pp = parent.points, pn = pp.length;
              const cp = child.points, cn = cp.length;
              const merged = [];
              const ei = sw.parentEdge;
              const e0 = pp[ei], e1 = pp[(ei + 1) % pn];
              const el = Math.sqrt((e1.x - e0.x) ** 2 + (e1.y - e0.y) ** 2);
              for (let i = 0; i < pn; i++) {
                merged.push({ ...pp[i] });
                if (i === ei && el >= 0.001) {
                  const tMin = sw.uMin / el, tMax = sw.uMax / el;
                  const wi = sw.wallIdx;
                  if (tMin > 0.001) merged.push({ x: e0.x + (e1.x - e0.x) * tMin, y: e0.y + (e1.y - e0.y) * tMin });
                  for (let j = 2; j < cn; j++) merged.push({ ...cp[(wi + j) % cn] });
                  if (tMax < 1 - 0.001) merged.push({ x: e0.x + (e1.x - e0.x) * tMax, y: e0.y + (e1.y - e0.y) * tMax });
                }
              }
              const newZBot = Math.min(parent.zBottom || 0, child.zBottom || 0);
              const newZTop = Math.max(parent.zTop != null ? parent.zTop : 40, child.zTop != null ? child.zTop : 40);
              const newBlocks = b.blocks.map((blk, i) => {
                if (i === parentIdx) {
                  return { ...blk, points: merged, zBottom: newZBot, zTop: newZTop, _sharedWall: null, _preExtrudePoints: null };
                }
                return blk;
              }).filter((_, i) => i !== childBlockIdx);
              return { ...b, blocks: newBlocks.map(blk => {
                if (blk._parentBlockIdx == null) return blk;
                let pi = blk._parentBlockIdx;
                if (pi === childBlockIdx) pi = parentIdx;
                if (pi > childBlockIdx) pi--;
                return { ...blk, _parentBlockIdx: pi };
              })};
            }));
          }}
          onBldUndo={bldUndo}
          onBldRedo={bldRedo}
          onBldPushUndo={bldPushUndo}
          onRenameBuilding={(buildingId, newLabel) => setBuildings(prev => prev.map(b => b.id === buildingId ? { ...b, label: newLabel } : b))}
          onRemoveNodePos={(nodeId) => {
            setMapPos(pr => { const r = { ...pr }; delete r[nodeId]; return r; });
            setMapZ(pr => { const r = { ...pr }; delete r[nodeId]; return r; });
          }}
          sectionOverlays={sectionOverlays}
          onFocusBld={focusBld}
          onDeleteBld={(bid) => { setBuildings(bs => bs.filter(b => b.id !== bid)); setSelectedBld(null); }}
        />
        )}
      </FloatWin>

      {/* 矢視ウィンドウ（矩形+視線方向方式） */}
      {sections.map(_sec => {
        // p1/p2があれば現在のPN角度でOBBを再計算（PN変更時に追従）
        let sec = _sec;
        if (_sec.p1 && _sec.p2) {
          const _curPnRad = plantNorthAngle * Math.PI / 180;
          const { cx, cy, halfA: hA, halfB: hB } = obbFromP1P2(_sec.p1, _sec.p2, _curPnRad);
          sec = { ..._sec, center: { x: cx, y: cy }, halfA: hA, halfB: hB, pnRad: _curPnRad };
        }
        const { rect, viewEdge } = sec;
        const isXView = viewEdge === 'top' || viewEdge === 'bottom';
        // OBBかAABBかに応じてsecLenを計算
        const secLen = sec.center !== undefined
          ? (isXView ? sec.halfA * 2 : sec.halfB * 2)
          : (isXView ? (rect.x2 - rect.x1) : (rect.y2 - rect.y1));
        if (secLen <= 0) return null;
        const SEC_W = Math.max(300, secLen + 80);
        const SEC_H = MAX_Z - MIN_Z + 80;
        const SPD = 40;
        const secGLY = 30 + MAX_Z;
        const tsX = (a) => SPD + a, tsY = (z) => secGLY - z;

        // 建物: 矩形内のみフィルタして投影（OBBの場合はplant座標系でフィルタ）
        const bldgSecs = flatBlocks.map(b => {
          const zBot = b.zBottom || 0, zT = b.zTop;
          if (sec.center !== undefined) {
            // OBB: 建物の4角をplant座標に投影して範囲チェック
            const corners4 = [
              [b.pxMinX, b.pxMinY], [b.pxMaxX, b.pxMinY],
              [b.pxMaxX, b.pxMaxY], [b.pxMinX, b.pxMaxY],
            ];
            const c = Math.cos(sec.pnRad), s = Math.sin(sec.pnRad);
            const pAs = corners4.map(([bx, by]) => {
              const dx = bx - sec.center.x, dy = by - sec.center.y;
              return dx*c + dy*s;
            });
            const pBs = corners4.map(([bx, by]) => {
              const dx = bx - sec.center.x, dy = by - sec.center.y;
              return dx*s - dy*c;
            });
            const minPB = Math.min(...pBs), maxPB = Math.max(...pBs);
            const minPA = Math.min(...pAs), maxPA = Math.max(...pAs);
            // depth範囲外なら除外
            if (isXView && (maxPB < -sec.halfB || minPB > sec.halfB)) return null;
            if (!isXView && (maxPA < -sec.halfA || minPA > sec.halfA)) return null;
            // projectToSectionと同じalong式で計算
            // top: halfA-pA, bottom: pA+halfA, left: halfB-pB, right: halfB+pB
            let minAlong, maxAlong;
            if (viewEdge === 'top')         { minAlong = sec.halfA - maxPA; maxAlong = sec.halfA - minPA; }
            else if (viewEdge === 'bottom') { minAlong = minPA + sec.halfA; maxAlong = maxPA + sec.halfA; }
            else if (viewEdge === 'left')   { minAlong = sec.halfB - maxPB; maxAlong = sec.halfB - minPB; }
            else                            { minAlong = sec.halfB + minPB; maxAlong = sec.halfB + maxPB; }
            minAlong = Math.max(0, minAlong);
            maxAlong = Math.min(secLen, maxAlong);
            if (minAlong >= maxAlong) return null;
            return { minA: minAlong, maxA: maxAlong, zBottom: zBot, zTop: zT, color: b.color, label: b.label, buildingId: b.buildingId };
          }
          // AABB（旧式）
          if (b.pxMaxX <= rect.x1 || b.pxMinX >= rect.x2) return null;
          if (b.pxMaxY <= rect.y1 || b.pxMinY >= rect.y2) return null;
          const minA = isXView
            ? Math.max(0, b.pxMinX - rect.x1)
            : Math.max(0, b.pxMinY - rect.y1);
          const maxA = isXView
            ? Math.min(secLen, b.pxMaxX - rect.x1)
            : Math.min(secLen, b.pxMaxY - rect.y1);
          if (minA >= maxA) return null;
          return { minA, maxA, zBottom: zBot, zTop: zT, color: b.color, label: b.label, buildingId: b.buildingId };
        }).filter(Boolean);

        // ノード投影
        const nProjs = [];
        nodes.forEach(n => {
          const pos = allMapPos[n.id]; if (!pos) return;
          const p = projectToSection(sec, pos.x, pos.y, pos.z || 0);
          if (p.depth < 0 || p.depth > p.totalDepth) return;
          if (p.along < 0 || p.along > secLen) return;
          nProjs.push({ ...n, along: p.along, z: p.z });
        });

        // セグメント投影（折れ点も含む）
        const sProjs = segs.map(sg => {
          const a = allMapPos[sg.from], b = allMapPos[sg.to]; if (!a || !b) return null;
          const pa = projectToSection(sec, a.x, a.y, a.z || 0);
          const pb = projectToSection(sec, b.x, b.y, b.z || 0);
          const inA = pa.depth >= 0 && pa.depth <= pa.totalDepth;
          const inB = pb.depth >= 0 && pb.depth <= pb.totalDepth;
          if (!inA && !inB) return null;
          const wps_s = segWp[sg.id] || [], wzs_s = wpZ[sg.id] || [];
          const wpPts = wps_s.map((wp, j) => { const pp = projectToSection(sec, wp.x, wp.y, wzs_s[j] || 0); return { along: pp.along, z: pp.z }; });
          return { id: sg.id, isBus: sg.isBus, pts: [{ along: pa.along, z: pa.z }, ...wpPts, { along: pb.along, z: pb.z }] };
        }).filter(Boolean);

        // 建物・hSection高さで表示範囲の基準を決定（初期スクロール位置計算用）
        const allZBld = bldgSecs.flatMap(bs => [bs.zBottom || 0, bs.zTop]);
        const _hSecZs = hSections.map(hs => hSecLiveZRef.current[hs.id] ?? hs.zPx);
        const _allZ = [...allZBld, ..._hSecZs];
        const baseDynMaxZ = (_allZ.length > 0 ? Math.max(..._allZ) : MAJOR * 2) + MAJOR;
        const dynMinZ = allZBld.length > 0 ? Math.min(0, Math.min(...allZBld) - MAJOR * 0.5) : MIN_Z;
        // dynSecGLY は MAX_Z を基準に固定 → ドラッグ中も他アイコンの座標が一切変わらない
        const dynSecGLY = 30 + MAX_Z;
        const dynMaxZ = MAX_Z;
        const dynSecH = Math.max(150, MAX_Z - dynMinZ + 60);
        const dynTsX = (a) => SPD + a;
        const dynTsY = (z) => dynSecGLY - z;
        const dynSEC_W = Math.max(300, secLen + 80);

        // renderNodes / drop ハンドラ用にレンダリングパラメータを保存
        secViewDataRef.current[sec.id] = { dynSecGLY, SPD, viewEdge, rect, dynMaxZ, dynSEC_W, halfA: sec.halfA, halfB: sec.halfB, center: sec.center, secPnRad: sec.pnRad, baseDynMaxZ };

        return (
          <FloatWin key={sec.id} id={sec.id} title={`矢視 ${sec.id.replace("sec", "S-")}`}
            winState={winState} setWinState={setWinState} bringFront={bringFront}
            onClose={() => removeSection(sec.id)}
            headerExtra={<>
              <button onClick={() => setHSecMode(hSecMode === sec.id ? null : sec.id)}
                style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
                  background: hSecMode === sec.id ? "#DC2626" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
                {hSecMode === sec.id ? "⊟ ON" : "⊟ 平面追加"}
              </button>
            </>}>
            <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
            {/* スクロールコンテナ（ズームのみ、パンなし） */}
            {/* display:flex + margin:auto → コンテンツが小さければ中央寄せ、大きければ左端基準で全範囲スクロール可能 */}
            <div style={{ overflow: "auto", width: "100%", height: "100%", display: "flex" }}
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop(sec.id)}
              onMouseDown={e => {
                if (e.button !== 0) return;
                e.preventDefault();
                setViewPanDrag({ secId: sec.id, scrollEl: e.currentTarget, startX: e.clientX, startY: e.clientY, scrollLeft: e.currentTarget.scrollLeft, scrollTop: e.currentTarget.scrollTop });
              }}>
              <div
                ref={(el) => {
                  const prev = secRefs.current[sec.id];
                  if (prev?.el === el) return;
                  if (prev?.fn) prev.el?.removeEventListener("wheel", prev.fn);
                  if (el) {
                    const sid = sec.id;
                    const fn = (e) => {
                      e.preventDefault();
                      const parent = el.parentElement; if (!parent) return;
                      const cr = parent.getBoundingClientRect();
                      const mx = e.clientX - cr.left, my = e.clientY - cr.top;
                      // 保留スクロール値を使用（連続ホイールの累積誤差防止、plan/elevと同方式）
                      const pending = secScrollUpdateRef.current[sid];
                      const slB = pending ? pending.left : parent.scrollLeft;
                      const stB = pending ? pending.top  : parent.scrollTop;
                      setSecZooms(prev => {
                        const pz = prev[sid] || 1;
                        const factor = e.deltaY > 0 ? (1 / 1.07) : 1.07;
                        const nz = Math.max(0.05, Math.min(500, pz * factor));
                        const ratio = nz / pz;
                        secScrollUpdateRef.current[sid] = {
                          el: parent,
                          left: (slB + mx) * ratio - mx,
                          top:  (stB + my) * ratio - my,
                        };
                        return { ...prev, [sid]: nz };
                      });
                    };
                    el.addEventListener("wheel", fn, { passive: false });
                    secRefs.current[sec.id] = { el, fn };
                    // 初期スクロール: 建物+hSectionの天井付近を上端に表示（空の上空を隠す）
                    const _initParent = el.parentElement;
                    if (_initParent && _initParent.scrollTop === 0) {
                      const _initZoom = secZoomsRef.current[sec.id] || 1;
                      _initParent.scrollTop = Math.max(0, (dynSecGLY - baseDynMaxZ - 20) * _initZoom);
                    }
                  } else {
                    delete secRefs.current[sec.id];
                  }
                }}
                onMouseDown={e => {
                  if (e.button === 1) { e.preventDefault(); setViewRotateDrag({ refId: sec.id, startX: e.clientX, startRotate: secRotates[sec.id] || 0 }); return; }
                  if (hSecMode === sec.id && e.button === 0) {
                    e.preventDefault();
                    const _r = e.currentTarget.getBoundingClientRect();
                    const _sz = secZooms[sec.id] || 1;
                    const svgY = (e.clientY - _r.top) / _sz;
                    const _vd = secViewDataRef.current[sec.id];
                    const _gly = _vd ? _vd.dynSecGLY : GL_Y;
                    setHSecPreview({ view: sec.id, zPx: _gly - svgY,
                      clipSec: { rect: sec.rect, center: sec.center, halfA: sec.halfA, halfB: sec.halfB, pnRad: sec.pnRad, viewEdge: sec.viewEdge },
                      _gly });
                    return;
                  }
                  if (e.button === 0) {
                    const scEl = e.currentTarget.parentElement;
                    if (scEl) { e.preventDefault(); setViewPanDrag({ secId: sec.id, scrollEl: scEl, startX: e.clientX, startY: e.clientY, scrollLeft: scEl.scrollLeft, scrollTop: scEl.scrollTop }); }
                  }
                }}
                onAuxClick={e => e.preventDefault()}
                onMouseMove={e => {
                  if (hSecPreview?.view === sec.id) {
                    const _r = e.currentTarget.getBoundingClientRect();
                    const _sz = secZooms[sec.id] || 1;
                    const svgY = (e.clientY - _r.top) / _sz;
                    const _gly = hSecPreview._gly ?? GL_Y;
                    setHSecPreview(prev => prev ? { ...prev, zPx: _gly - svgY } : null);
                  }
                }}
                onMouseUp={e => {
                  if (hSecPreview?.view === sec.id) {
                    finishHSection(hSecPreview.zPx, hSecPreview.clipSec);
                    setHSecPreview(null);
                    return;
                  }
                }}
                style={{ position: "relative", width: dynSEC_W, height: dynSecH, zoom: secZooms[sec.id] || 1, background: "#FEFEFE", userSelect: "none", margin: "auto", cursor: hSecMode === sec.id ? "crosshair" : viewRotateDrag?.refId === sec.id ? "grabbing" : viewPanDrag?.secId === sec.id ? "grabbing" : "grab" }}>
                <svg width={dynSEC_W} height={dynSecH}>
                  {/* 縦グリッド */}
                  {(() => { const _secZ = secZooms[sec.id] || 1; return Array.from({ length: Math.ceil(secLen / MAJOR) + 1 }, (_, i) => <line key={`sv${i}`} x1={SPD + i * MAJOR} y1={0} x2={SPD + i * MAJOR} y2={dynSecH} stroke="rgba(0,0,0,0.04)" strokeWidth={0.5/_secZ} />); })()}
                  {/* 横グリッド（ラベルなし） */}
                  {(() => { const _secZ = secZooms[sec.id] || 1; return Array.from({ length: Math.ceil((dynMaxZ - dynMinZ) / MAJOR) + 1 }, (_, i) => {
                    const z = dynMinZ + i * MAJOR;
                    const sy = dynTsY(z);
                    return <line key={`sh${i}`} x1={0} y1={sy} x2={dynSEC_W} y2={sy} stroke={z < 0 ? "rgba(139,92,40,0.06)" : "rgba(0,0,0,0.04)"} strokeWidth={0.5/_secZ} />;
                  }); })()}
                  {/* YZ面回転グループ: GL線・建物・配線・ノードをまとめて2D回転（符号はキューブと同方向） */}
                  <g transform={`rotate(${-(secRotates[sec.id] || 0)}, ${dynSEC_W / 2}, ${dynSecGLY})`}>
                  {/* 地下背景 */}
                  {dynMinZ < 0 && <rect x={0} y={dynTsY(0)} width={dynSEC_W} height={dynSecH - dynTsY(0)} fill="rgba(139,105,20,0.04)"/>}
                  {dynMinZ < 0 && (() => {
                    const _ugY = dynTsY(0) + 10;
                    const _secZ2 = secZooms[sec.id] || 1;
                    return <>
                      <rect x={0} y={_ugY} width={dynSEC_W} height={40} fill={_ugC(0.55)}/>
                      <line x1={0} y1={_ugY} x2={dynSEC_W} y2={_ugY} stroke={_ugC(0.85)} strokeWidth={1.5 / _secZ2}/>
                      <line x1={0} y1={_ugY+40} x2={dynSEC_W} y2={_ugY+40} stroke={_ugC(0.6)} strokeWidth={1 / _secZ2}/>
                      <text x={dynSEC_W+3} y={_ugY+3} fontSize={6 / _secZ2} fontWeight={600} fill={_ugFloor}>地下</text>
                    </>;
                  })()}
                  {/* GL線（z=0） */}
                  <line x1={0} y1={dynTsY(0)} x2={dynSEC_W} y2={dynTsY(0)} stroke="#8B6914" strokeWidth={2 / (secZooms[sec.id] || 1)} />
                  <text x={dynSEC_W+3} y={dynTsY(0)+3} fontSize={6 / (secZooms[sec.id] || 1)} fontWeight={700} fill="#8B6914">GL</text>
                  {/* 水平断面インジケーター */}
                  {hSections.map(hs => {
                    const _sz2 = secZooms[sec.id] || 1;
                    const _liveZPx2 = hSecLiveZRef.current[hs.id] ?? hs.zPx;
                    const sy = dynSecGLY - _liveZPx2;
                    // この矢視図から作ったhSecなら全幅、別の矢視図から作ったなら非表示
                    if (hs.clipSec && !('rect' in hs.clipSec === false) && hs.clipSec !== null) {
                      const cs = hs.clipSec;
                      const thisSec = sec;
                      const sameOBB = cs.center !== undefined && thisSec.center !== undefined
                        && Math.abs(cs.center.x - thisSec.center.x) < 1
                        && Math.abs(cs.center.y - thisSec.center.y) < 1
                        && Math.abs((cs.halfA||0) - (thisSec.halfA||0)) < 1;
                      const sameRect = cs.rect && thisSec.rect
                        && Math.abs(cs.rect.x1 - thisSec.rect.x1) < 1
                        && Math.abs(cs.rect.y1 - thisSec.rect.y1) < 1;
                      if (!sameOBB && !sameRect) return null;
                    }
                    return (
                      <g key={`hsi-${sec.id}${hs.id}`}>
                        {hSecShowBand[hs.id] && <rect x={0} y={sy - MAJOR/(2*_sz2)} width={dynSEC_W} height={MAJOR/_sz2} fill="rgba(0,0,0,0.08)" pointerEvents="none" />}
                        <line x1={0} y1={sy} x2={dynSEC_W} y2={sy} stroke="#1a1a1a" strokeWidth={1.5/_sz2} pointerEvents="none" />
                        <text x={4/_sz2} y={sy - 3/_sz2} fontSize={7/_sz2} fill="#1a1a1a" fontWeight={700} pointerEvents="none">{hs.label}</text>
                        <rect x={0} y={sy - 6/_sz2} width={dynSEC_W} height={12/_sz2}
                          fill="transparent" style={{cursor:'ns-resize'}} pointerEvents="all"
                          onMouseDown={e => { e.preventDefault(); e.stopPropagation();
                            if (hSecActiveDim && !hSecDrag) return;
                            hSecDragClientPos.current = { x: e.clientX, y: e.clientY }; setHSecActiveDim({id:hs.id}); setHSecDrag({id:hs.id, startClientX:e.clientX, startClientY:e.clientY, startZPx:_liveZPx2, dZPerPx:1/_sz2}); }} />
                      </g>
                    );
                  })}
                  {/* hSecPreviewプレビュー線（sec） */}
                  {hSecPreview?.view === sec.id && (() => {
                    const _sz2 = secZooms[sec.id] || 1;
                    const _psy = (hSecPreview._gly ?? dynSecGLY) - hSecPreview.zPx;
                    const _pl = `${Math.floor(hSecPreview.zPx / MAJOR) + 1}F`;
                    return (<g pointerEvents="none">
                      <line x1={0} y1={_psy} x2={dynSEC_W} y2={_psy} stroke="#1a1a1a" strokeWidth={2/_sz2} strokeDasharray={`${5/_sz2},${3/_sz2}`} />
                      <text x={4/_sz2} y={_psy - 4/_sz2} fontSize={8/_sz2} fill="#1a1a1a" fontWeight={700}>{_pl}</text>
                    </g>);
                  })()}
                  {/* 建物 */}
                  {(() => {
                    const _secBldG = {};
                    bldgSecs.forEach(bs => { if (!_secBldG[bs.buildingId]) _secBldG[bs.buildingId] = []; _secBldG[bs.buildingId].push(bs); });
                    return Object.entries(_secBldG).map(([bid, blocks]) => {
                      const _isSel = selectedBld === bid, _isHov = hovBldId === bid;
                      const _allMinA = Math.min(...blocks.map(b => b.minA));
                      const _allMaxA = Math.max(...blocks.map(b => b.maxA));
                      const _allZTop = Math.max(...blocks.map(b => b.zTop));
                      const _bCx = dynTsX((_allMinA + _allMaxA) / 2);
                      const _bCy = dynTsY(_allZTop);
                      return (
                        <g key={bid}
                          onMouseEnter={() => { setHovBldId(bid); setHovBldView(sec.id); }}
                          onMouseLeave={() => { setHovBldId(null); setHovBldView(null); }}
                          onMouseDown={e => {
                            e.stopPropagation();
                            const _nsel = selectedBld === bid ? null : bid;
                            setSelectedBld(_nsel); setSelectedBldView(_nsel ? sec.id : null);
                          }}
                          style={{ cursor: 'pointer', pointerEvents: 'auto' }}>
                          {blocks.map((bs, i) => {
                            const zBot = bs.zBottom || 0, zT = bs.zTop;
                            return <g key={i}>
                              <rect x={dynTsX(bs.minA)} y={dynTsY(zT)} width={bs.maxA - bs.minA} height={Math.max(1, zT - zBot)}
                                fill={bs.color} stroke={_isSel ? '#3B82F6' : _isHov ? '#64748B' : bs.color}
                                strokeWidth={_isSel ? 2/(secZooms[sec.id]||1) : 1/(secZooms[sec.id]||1)} rx={1}
                                strokeDasharray={zBot < 0 ? "3,2" : "none"} />
                              <text x={dynTsX(bs.minA) + 3} y={dynTsY(zT) + 10} fontSize={6} fontWeight={700} fill="#475569" opacity={0.6}>{bs.label}</text>
                            </g>;
                          })}
                          {/* 建屋バッジはSVG外HTMLオーバーレイで描画 */}
                        </g>
                      );
                    });
                  })()}
                  {/* 配線 */}
                  {sProjs.map(sp => {
                    const secZ = secZooms[sec.id] || 1;
                    const sg = segs.find(s => s.id === sp.id);
                    const spPts = sp.pts.map(p => `${dynTsX(p.along)},${dynTsY(p.z)}`).join(" ");
                    // isHL: wireホバー OR アイコンホバー（断面図・側面図と同仕様）
                    const isHL = hoverSeg === sp.id || !!(hoverId && sg && (sg.from === hoverId || sg.to === hoverId));
                    const capSW = secZ > 1 ? Math.min(sp.isBus ? 3 : 1.5, (sp.isBus ? 5 : 3) / secZ) : (sp.isBus ? 3 : 1.5);
                    const hitSW = secZ > 1 ? Math.max(capSW, 6 / secZ) : 12;
                    return (
                      <g key={sp.id} id={`sec-${sec.id}-w-${sp.id}`}>
                        {/* アウトライン: ホバー時は青、通常は白（断面図・側面図と同仕様）*/}
                        <polyline points={spPts} fill="none"
                          stroke={isHL ? HL_COLOR : "rgba(232,236,240,0.95)"} strokeWidth={capSW + 6 / Math.max(1, secZ)}
                          strokeLinejoin="round" strokeLinecap="round" pointerEvents="none"
                          style={{ transition: "stroke 0.15s" }} />
                        {/* 線本体: 常に黒（断面図・側面図と同仕様） */}
                        <polyline points={spPts} fill="none" stroke={BASE_COLOR} strokeWidth={capSW}
                          strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
                        {(() => {
                          // totalDist: 主wireとサブセグメントで共有するため先頭で計算
                          const _smpp = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
                          const _saP = sg && allMapPos[sg.from], _sbP = sg && allMapPos[sg.to];
                          const _swps = segWp[sp.id] || [], _swzs = wpZ[sp.id] || [];
                          let _sTotalDist = 0;
                          if (_saP && _sbP) {
                            const _spts3d = [[_saP.x,_saP.y,mapZ[sg?.from]||0],..._swps.map((wp,j)=>[wp.x,wp.y,_swzs[j]||0]),[_sbP.x,_sbP.y,mapZ[sg?.to]||0]];
                            for(let k=0;k<_spts3d.length-1;k++){const dx=(_spts3d[k+1][0]-_spts3d[k][0])*_smpp,dy=(_spts3d[k+1][1]-_spts3d[k][1])*_smpp,dz=_spts3d[k+1][2]-_spts3d[k][2];_sTotalDist+=Math.sqrt(dx*dx+dy*dy+dz*dz);}
                          }
                          return (<polyline points={spPts} fill="none" stroke="transparent" strokeWidth={hitSW}
                            style={{ cursor: "pointer" }}
                            onMouseEnter={ev => {
                              setHoverSeg(sp.id);
                              if (_saP && _sbP) setWireTip({x:ev.clientX,y:ev.clientY,dist:_sTotalDist,segDist: sp.pts.length <= 2 ? null : undefined});
                            }}
                            onMouseMove={ev => setWireTip(pr => pr ? {...pr, x:ev.clientX, y:ev.clientY} : null)}
                            onMouseLeave={() => { setHoverSeg(null); setWireTip(null); }}
                            onClick={ev => { if (!ev.ctrlKey) return; addWpSec(sec, sp.id, ev, dynSecGLY, SPD, secZ); }} />);
                        })()}
                        {/* midpoint circle: 断面図・側面図と同仕様の黄色丸 */}
                        {sp.pts.length >= 2 && sp.pts.slice(0, -1).map((pa, si) => {
                          const pb = sp.pts[si + 1];
                          const mx = (dynTsX(pa.along) + dynTsX(pb.along)) / 2;
                          const my = (dynTsY(pa.z) + dynTsY(pb.z)) / 2;
                          const r = Math.min(6, 6 / secZ), hitR = Math.max(r, 10 / secZ);
                          const sw = Math.min(1.5, 1.5 / secZ);
                          const sdx = dynTsX(pb.along) - dynTsX(pa.along), sdy = dynTsY(pb.z) - dynTsY(pa.z);
                          const slen = Math.sqrt(sdx*sdx + sdy*sdy);
                          if (slen < 8 / secZ) return null;
                          return (
                            <g key={`smp${si}`}
                              onMouseEnter={() => setHoverSeg(sp.id)}
                              onMouseLeave={() => setHoverSeg(null)}>
                              <circle cx={mx} cy={my} r={hitR} fill="transparent"
                                style={{ cursor: isHL ? "grab" : "default", pointerEvents: "all" }}
                                onMouseDown={ev2 => {
                                  if (!isHL) return;
                                  ev2.stopPropagation(); ev2.preventDefault();
                                  const sg2 = segs.find(s => s.id === sp.id); if (!sg2) return;
                                  const aP2 = allMapPos[sg2.from], bP2 = allMapPos[sg2.to]; if (!aP2 || !bP2) return;
                                  const wps_d = segWp[sp.id] || [], wzs_d = wpZ[sp.id] || [];
                                  const path2 = [aP2, ...wps_d.map((w, j) => ({...w, z: wzs_d[j] || 0})), bP2];
                                  const secEl2 = secRefs.current[sec.id]?.el; if (!secEl2) return;
                                  const _sz2 = secZoomsRef.current[sec.id] || 1;
                                  const elR2 = secEl2.getBoundingClientRect();
                                  const sSvgX = (ev2.clientX - elR2.left) / _sz2;
                                  const sSvgY = (ev2.clientY - elR2.top) / _sz2;
                                  const _vd2 = secViewDataRef.current[sec.id] || {};
                                  const _aIsIcon = si === 0;
                                  const _bIsIcon = si + 1 === sp.pts.length - 1;
                                  setSegLineDragSec({
                                    secId: sec.id,
                                    viewEdge: _vd2.viewEdge,
                                    isXView: _vd2.viewEdge === 'top' || _vd2.viewEdge === 'bottom',
                                    hasOBB: !!(sec.center),
                                    startSvgX: sSvgX, startSvgY: sSvgY,
                                    aIsIcon: _aIsIcon,
                                    aId: _aIsIcon ? sg2.from : sp.id,
                                    aWi: _aIsIcon ? null : si - 1,
                                    origAX: path2[si].x, origAY: path2[si].y, origAZ: path2[si].z ?? 0,
                                    bIsIcon: _bIsIcon,
                                    bId: _bIsIcon ? sg2.to : sp.id,
                                    bWi: _bIsIcon ? null : si,
                                    origBX: path2[si+1].x, origBY: path2[si+1].y, origBZ: path2[si+1].z ?? 0,
                                  });
                                }} />
                              {isHL && <circle cx={mx} cy={my} r={r}
                                fill="#EAB308" stroke={HL_COLOR} strokeWidth={sw} pointerEvents="none" />}
                            </g>
                          );
                        })}
                        {/* 折れ点区間別距離: 折れ点があるときサブセグが主wire上に来るため hoverSeg+wireTip両方設定 */}
                        {sp.pts.length > 2 && (() => {
                          const _sg2 = segs.find(s => s.id === sp.id);
                          const _aP2 = _sg2 && allMapPos[_sg2.from], _bP2 = _sg2 && allMapPos[_sg2.to];
                          if (!_aP2 || !_bP2) return null;
                          const _wps2 = segWp[sp.id] || [], _wzs2 = wpZ[sp.id] || [];
                          const _pts3d2 = [[_aP2.x,_aP2.y,mapZ[_sg2.from]||0],..._wps2.map((wp,j)=>[wp.x,wp.y,_wzs2[j]||0]),[_bP2.x,_bP2.y,mapZ[_sg2.to]||0]];
                          const _mpp2 = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
                          let _totalDist2=0; for(let k=0;k<_pts3d2.length-1;k++){const dx=(_pts3d2[k+1][0]-_pts3d2[k][0])*_mpp2,dy=(_pts3d2[k+1][1]-_pts3d2[k][1])*_mpp2,dz=_pts3d2[k+1][2]-_pts3d2[k][2];_totalDist2+=Math.sqrt(dx*dx+dy*dy+dz*dz);}
                          return sp.pts.slice(0, -1).map((pa, si) => {
                            const pb = sp.pts[si + 1];
                            const p0 = _pts3d2[si], p1 = _pts3d2[si + 1]; if (!p0 || !p1) return null;
                            const sdx=(p1[0]-p0[0])*_mpp2, sdy=(p1[1]-p0[1])*_mpp2, sdz=p1[2]-p0[2];
                            const segD = Math.sqrt(sdx*sdx+sdy*sdy+sdz*sdz);
                            return (<polyline key={`ssh${si}`}
                              points={`${dynTsX(pa.along)},${dynTsY(pa.z)} ${dynTsX(pb.along)},${dynTsY(pb.z)}`}
                              fill="none" stroke="transparent" strokeWidth={hitSW}
                              style={{ cursor: 'pointer' }}
                              onMouseEnter={ev => { setHoverSeg(sp.id); setWireTip({x:ev.clientX,y:ev.clientY,dist:_totalDist2,segDist:segD}); }}
                              onMouseMove={ev => setWireTip(pr => pr ? {...pr,x:ev.clientX,y:ev.clientY} : null)}
                              onMouseLeave={() => { setHoverSeg(null); setWireTip(null); }} />);
                          });
                        })()}
                        {/* waypoint markers */}
                        {sp.pts.slice(1, -1).map((pt, i) => {
                          const sx2 = dynTsX(pt.along), sy2 = dynTsY(pt.z);
                          const wps_m = segWp[sp.id] || [], wzs_m = wpZ[sp.id] || [];
                          return (
                            <g key={`swp${sp.id}-${i}`}
                              onMouseEnter={ev => {
                                setHoverSeg(sp.id);
                                const _wmpp3 = typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0 ? METERS_PER_PX : 1;
                                const _waP3 = sg && allMapPos[sg.from], _wbP3 = sg && allMapPos[sg.to];
                                if (_waP3 && _wbP3) {
                                  const _wwps3 = segWp[sp.id]||[], _wwzs3 = wpZ[sp.id]||[];
                                  const _wpts3 = [[_waP3.x,_waP3.y,mapZ[sg.from]||0],..._wwps3.map((w,j)=>[w.x,w.y,_wwzs3[j]||0]),[_wbP3.x,_wbP3.y,mapZ[sg.to]||0]];
                                  let _wd3=0; for(let k=0;k<_wpts3.length-1;k++){const dx=(_wpts3[k+1][0]-_wpts3[k][0])*_wmpp3,dy=(_wpts3[k+1][1]-_wpts3[k][1])*_wmpp3,dz=_wpts3[k+1][2]-_wpts3[k][2];_wd3+=Math.sqrt(dx*dx+dy*dy+dz*dz);}
                                  setWireTip({x:ev.clientX,y:ev.clientY,dist:_wd3});
                                }
                              }}
                              onMouseLeave={() => { setHoverSeg(null); setWireTip(null); }}>
                              <circle cx={sx2} cy={sy2} r={12 / secZ} fill="transparent" pointerEvents="auto"
                                style={{ cursor: isHL ? "grab" : "pointer" }}
                                onMouseDown={ev2 => {
                                  if (ev2.ctrlKey) { ev2.stopPropagation(); ev2.preventDefault(); rmWp(sp.id, i); return; }
                                  if (!isHL) return;
                                  ev2.stopPropagation(); ev2.preventDefault();
                                  if (!sg) return;
                                  const aP = allMapPos[sg.from], bP = allMapPos[sg.to]; if (!aP || !bP) return;
                                  const path = [aP, ...wps_m.map((w,j)=>({...w,z:wzs_m[j]||0})), bP];
                                  const _prevPt = path[i]; const _prevZ = path[i].z ?? 0;
                                  const _nextPt = path[i+2]; const _nextZ = path[i+2]?.z ?? 0;
                                  const _ppPt = i > 0 ? path[i-1] : null; const _ppZ = i > 0 ? (path[i-1].z ?? 0) : null;
                                  const _nnPt = i+3 < path.length ? path[i+3] : null; const _nnZ = i+3 < path.length ? (path[i+3].z ?? 0) : null;
                                  setWpDrag({sid:sp.id,wi:i,view:sec.id,
                                    prevX:_prevPt?.x??null,prevY:_prevPt?.y??null,prevZ:_prevZ,
                                    nextX:_nextPt?.x??null,nextY:_nextPt?.y??null,nextZ:_nextZ,
                                    prevPrevX:_ppPt?.x??null,prevPrevY:_ppPt?.y??null,prevPrevZ:_ppZ??null,
                                    nextNextX:_nnPt?.x??null,nextNextY:_nnPt?.y??null,nextNextZ:_nnZ??null});
                                }} />
                              {isHL && <rect x={sx2-5/secZ} y={sy2-5/secZ} width={10/secZ} height={10/secZ}
                                fill="#FFF" stroke={HL_COLOR} strokeWidth={1.5/secZ} pointerEvents="none" />}
                            </g>
                          );
                        })}
                      </g>
                    );
                  })}
                  {/* wpDrag矢視図直角マーク */}
                  {wpDrag?.view === sec.id && wpPerpSecRef.current?.map((m, i) => {
                    const { svgX, svgY, dAx, dAy, dBx, dBy } = m;
                    const sz2 = 14 / (secZooms[sec.id] || 1);
                    const P1=[svgX-dAx*sz2,svgY-dAy*sz2],P2=[svgX-dAx*sz2+dBx*sz2,svgY-dAy*sz2+dBy*sz2],P3=[svgX+dBx*sz2,svgY+dBy*sz2];
                    return <path key={i} d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                      fill="none" stroke="#3B82F6" strokeWidth={1.5/(secZooms[sec.id]||1)} pointerEvents="none" />;
                  })}
                  {/* アイコンドラッグ矢視図直角マーク */}
                  {secNodeDrag?.secId === sec.id && iconPerpSnapRef.current && (() => {
                    const { svgX, svgY, dAx, dAy, dBx, dBy } = iconPerpSnapRef.current;
                    const sz2 = 14 / (secZooms[sec.id] || 1);
                    const P1=[svgX-dAx*sz2,svgY-dAy*sz2],P2=[svgX-dAx*sz2+dBx*sz2,svgY-dAy*sz2+dBy*sz2],P3=[svgX+dBx*sz2,svgY+dBy*sz2];
                    return <path d={`M${P1[0]},${P1[1]}L${P2[0]},${P2[1]}L${P3[0]},${P3[1]}`}
                      fill="none" stroke="#3B82F6" strokeWidth={1.5/(secZooms[sec.id]||1)} pointerEvents="none" />;
                  })()}
                  {/* ノード */}
                  {nProjs.map(np => {
                    const sx = dynTsX(np.along), sy = dynTsY(np.z), isHL = hoverId === np.id;
                    if (np.kind === "symbol") return (
                      <g key={np.id} onMouseEnter={() => setHoverId(np.id)} onMouseLeave={() => setHoverId(null)} style={{ cursor: "pointer" }}>
                        {/* renderNodesがアイコン+ラベルを描画するため、SVGはhover背景のみ */}
                        <rect x={sx - 12} y={sy - 13} width={24} height={26} rx={3} fill={isHL ? "rgba(59,130,246,0.15)" : "transparent"} stroke={isHL ? HL_COLOR : "none"} strokeWidth={isHL ? 2 : 0} />
                      </g>
                    );
                    if (np.kind === "free") return <circle key={np.id} cx={sx} cy={sy} r={6} fill={isHL ? HL_COLOR : BASE_COLOR} onMouseEnter={() => setHoverId(np.id)} onMouseLeave={() => setHoverId(null)} style={{ cursor: "pointer" }} />;
                    return <circle key={np.id} cx={sx} cy={sy} r={5} fill={isHL ? HL_COLOR : "#FFF"} stroke={isHL ? HL_COLOR : BASE_COLOR} strokeWidth={2} onMouseEnter={() => setHoverId(np.id)} onMouseLeave={() => setHoverId(null)} style={{ cursor: "pointer" }} />;
                  })}
                  {/* 矢視図: hSec間の寸法バッジ */}
                  {hSections.length >= 1 && (() => {
                    const _mppV = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
                    const _secZ2 = secZooms[sec.id] || 1;
                    const _allLvl = [{ id: 'GL', label: 'GL', zPx: 0 }, ...hSections.map(hs => ({ id: hs.id, label: hs.label, zPx: hSecLiveZRef.current[hs.id] ?? hs.zPx }))].sort((a, b) => a.zPx - b.zPx);
                    const _dSW = dynSEC_W || 300;
                    const _bw = 56 / _secZ2, _bh = 13 / _secZ2, _br = 3 / _secZ2, _fs = 7 / _secZ2, _tk = 4 / _secZ2;
                    const _bx = _dSW - _bw - 4 / _secZ2;
                    const _dimElems = [];
                    for (let _di = 0; _di < _allLvl.length - 1; _di++) {
                      const _lo = _allLvl[_di], _hi = _allLvl[_di + 1];
                      const _sy_lo = dynSecGLY - _lo.zPx, _sy_hi = dynSecGLY - _hi.zPx;
                      const _midY = (_sy_lo + _sy_hi) / 2;
                      const _mm = Math.round(Math.abs(_hi.zPx - _lo.zPx) * _mppV * 1000);
                      const _isEdit = !hSecActiveDim && hSecEditDim?.hSecId === _hi.id && hSecEditDim?.refId === _lo.id;
                      _dimElems.push(<line key={`dg-sec${sec.id}-${_di}`} x1={_bx+_bw/2} y1={_sy_hi} x2={_bx+_bw/2} y2={_sy_lo} stroke="#94A3B8" strokeWidth={0.8/_secZ2} strokeDasharray={`${3/_secZ2},${2/_secZ2}`} pointerEvents="none" />);
                      _dimElems.push(<line key={`dta-sec${sec.id}-${_di}`} x1={_bx+_bw/2-_tk} y1={_sy_lo} x2={_bx+_bw/2+_tk} y2={_sy_lo} stroke="#64748B" strokeWidth={1/_secZ2} pointerEvents="none" />);
                      _dimElems.push(<line key={`dtb-sec${sec.id}-${_di}`} x1={_bx+_bw/2-_tk} y1={_sy_hi} x2={_bx+_bw/2+_tk} y2={_sy_hi} stroke="#64748B" strokeWidth={1/_secZ2} pointerEvents="none" />);
                      if (_isEdit) {
                        const _fw = _bw, _fh = 16 / _secZ2;
                        _dimElems.push(<foreignObject key={`dfo-sec${sec.id}-${_di}`} x={_bx} y={_midY - _fh/2} width={_fw} height={_fh}>
                          <input autoFocus defaultValue={_mm}
                            style={{ width: _fw * _secZ2 + 'px', height: _fh * _secZ2 + 'px', fontSize: 10, border: '1px solid #3B82F6', borderRadius: 2, padding: '0 3px', outline: 'none', background: '#FFF', transform: `scale(${1/_secZ2})`, transformOrigin: '0 0' }}
                            onKeyDown={ev => {
                              if (ev.key === 'Enter') {
                                const newMm = parseFloat(ev.target.value);
                                if (!isNaN(newMm) && newMm >= 0) {
                                  const newZPx = _lo.zPx + newMm / 1000 / _mppV;
                                  const newLabel = newZPx >= 0 ? `${Math.floor(newZPx / MAJOR) + 1}F` : `B${Math.ceil(-newZPx / MAJOR)}`;
                                  setHSections(prev => prev.map(h => h.id === _hi.id ? { ...h, zPx: newZPx, label: newLabel } : h));
                                }
                                setHSecEditDim(null);
                              }
                              if (ev.key === 'Escape') setHSecEditDim(null);
                            }}
                            onBlur={() => setHSecEditDim(null)} />
                        </foreignObject>);
                      } else {
                        _dimElems.push(<rect key={`dbg-sec${sec.id}-${_di}`} x={_bx} y={_midY - _bh/2} width={_bw} height={_bh} rx={_br} fill="rgba(30,41,59,0.82)" pointerEvents="all"
                          style={{ cursor: _hi.id !== 'GL' ? 'pointer' : 'default' }}
                          onClick={() => { if (_hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }} />);
                        _dimElems.push(<text key={`dtx-sec${sec.id}-${_di}`} x={_bx+_bw/2} y={_midY + _fs*0.38} fontSize={_fs} fill="#F1F5F9" fontWeight={600} textAnchor="middle"
                          style={{ cursor: _hi.id !== 'GL' ? 'pointer' : 'default' }} pointerEvents="all"
                          onClick={() => { if (_hi.id !== 'GL') setHSecEditDim({ hSecId: _hi.id, refId: _lo.id }); }}>
                          {_mm.toLocaleString()} mm
                        </text>);
                      }
                    }
                    return _dimElems;
                  })()}
                  </g>{/* /YZ面回転グループ */}
                </svg>
                {/* ノードアイコン（絶対配置、ドラッグ可） */}
                {renderNodes(sec.id, { current: secRefs.current[sec.id]?.el })}
                {/* 建屋選択バッジ（矢視図）: クリック選択時のみ表示、zoom逆補正でサイズ一定 */}
                {selectedBld && selectedBldView === sec.id && !bldEditMode && (() => {
                  const _bb = bldgSecs.filter(bs => bs.buildingId === selectedBld);
                  if (_bb.length === 0) return null;
                  const _mnA = Math.min(..._bb.map(b => b.minA)), _mxA = Math.max(..._bb.map(b => b.maxA));
                  const _zT = Math.max(..._bb.map(b => b.zTop));
                  return renderBldBadgesHTML(selectedBld, dynTsX((_mnA + _mxA) / 2), dynTsY(_zT), 1 / (secZooms[sec.id] || 1));
                })()}
              </div>
            </div>
            {/* 方位インジケーター: 矢視図（断面図/側面図と同等） */}
            {(() => {
              const gc=40, cs=16, arL=30, mpp=(typeof METERS_PER_PX==='number'&&METERS_PER_PX>0)?METERS_PER_PX:1;
              const pnRad=plantNorthAngle*Math.PI/180;
              const secRot=secRotates[sec.id]||0;
              // cAz: 各辺から見た時にX/PN矢印が正しい方向を向くよう設定
              // bottom(-PNから北向き): X右、top(+PNから南向き): X左、right(+Xから西向き): PN右、left(-Xから東向き): PN左
              const cAz=viewEdge==='top'?(pnRad+Math.PI):viewEdge==='bottom'?pnRad:viewEdge==='left'?(pnRad+Math.PI/2):(pnRad-Math.PI/2);
              const aAz=cAz-secRot*Math.PI/180;  // 矢印: 回転込み
              const cEl=0;
              const cp0=project3D(TW/2,TH/2,0,cAz,cEl,1,0,0);
              const mkV=(a,b,c)=>{
                const wcx=(a*Math.cos(pnRad)+b*Math.sin(pnRad))*cs, wcy=(-a*Math.sin(pnRad)+b*Math.cos(pnRad))*cs;
                const p=project3D(TW/2+wcx,TH/2-wcy,c*cs*mpp,cAz,cEl,1,0,0);
                return{sx:gc+(p.x-cp0.x),sy:gc+(p.y-cp0.y),d:p.depth};
              };
              const v=[mkV(-1,-1,-1),mkV(+1,-1,-1),mkV(-1,+1,-1),mkV(+1,+1,-1),mkV(-1,-1,+1),mkV(+1,-1,+1),mkV(-1,+1,+1),mkV(+1,+1,+1)];
              const fd=[
                {vi:[1,3,7,5],b:'#EF4444',dk:'#991B1B'},{vi:[0,4,6,2],b:'#7F1D1D',dk:'#450A0A'},
                {vi:[2,3,7,6],b:'#22C55E',dk:'#14532D'},{vi:[0,1,5,4],b:'#166534',dk:'#052E16'},
                {vi:[4,5,7,6],b:'#3B82F6',dk:'#1E3A8A'},{vi:[0,1,3,2],b:'#1E3A8A',dk:'#0F172A'},
              ];
              const faces=fd.map(f=>({...f,depth:f.vi.reduce((s,i)=>s+v[i].d,0)/4,pts:f.vi.map(i=>`${v[i].sx.toFixed(1)},${v[i].sy.toFixed(1)}`).join(' '),cx:f.vi.reduce((s,i)=>s+v[i].sx,0)/4,cy:f.vi.reduce((s,i)=>s+v[i].sy,0)/4})).sort((a,bb)=>bb.depth-a.depth);
              const midD=(Math.min(...faces.map(f=>f.depth))+Math.max(...faces.map(f=>f.depth)))/2;
              const nrm=(dx,dy)=>{const l=Math.sqrt(dx*dx+dy*dy)||1;return[dx/l,dy/l];};
              const ap0=project3D(TW/2,TH/2,0,aAz,cEl,1,0,0);
              const pZ=project3D(TW/2,TH/2,mpp,aAz,cEl,1,0,0);
              // X側から見る(left/right): 水平軸=PN → PN矢印を表示
              // PN側から見る(top/bottom): 水平軸=X → X矢印を表示
              const isXSideView = viewEdge==='left'||viewEdge==='right';
              const pX=project3D(TW/2+Math.cos(pnRad),TH/2+Math.sin(pnRad),0,aAz,cEl,1,0,0);
              const pPN=project3D(TW/2+Math.sin(pnRad),TH/2-Math.cos(pnRad),0,aAz,cEl,1,0,0);
              const [zx,zy]=nrm(pZ.x-ap0.x,pZ.y-ap0.y);
              const [hx,hy]=isXSideView?nrm(pPN.x-ap0.x,pPN.y-ap0.y):nrm(pX.x-ap0.x,pX.y-ap0.y);
              const hLabel=isXSideView?'PN':'X';
              const ah=(dx,dy,col)=>{const l=Math.sqrt(dx*dx+dy*dy)||1,ux=dx/l,uy=dy/l,hx=gc+dx,hy=gc+dy,w=3.5,hl=7;return<polygon key={`ah${col}`} points={`${hx},${hy} ${hx-ux*hl-uy*w},${hy-uy*hl+ux*w} ${hx-ux*hl+uy*w},${hy-uy*hl-ux*w}`} fill={col}/>;};
              const isPnOpen=secPnOpenId===sec.id;
              return(
                <div style={{position:'absolute',top:6,right:6,zIndex:25}}>
                  <svg width={80} height={80} style={{overflow:'visible'}}>
                    {/* キューブ: 2D平面回転 */}
                    <g transform={`rotate(${-secRot}, ${gc}, ${gc})`}>
                    {faces.map((f,i)=>(
                      <g key={`f${i}`}>
                        <polygon points={f.pts} fill={f.depth<midD?f.b:f.dk} stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9}/>
                      </g>
                    ))}
                    </g>
                    <circle cx={gc} cy={gc} r={3} fill="#FFF" stroke="#000" strokeWidth={0.8}
                      onClick={e=>{e.stopPropagation();setSecPnOpenId(isPnOpen?null:sec.id);}} style={{cursor:'pointer'}}/>
                    {/* 水平軸矢印: X側ならPN(緑)、PN側ならX(赤) */}
                    <line x1={gc} y1={gc} x2={gc+hx*arL} y2={gc+hy*arL} stroke={isXSideView?'#4ADE80':'#F87171'} strokeWidth={2} strokeLinecap="round"/>
                    {ah(hx*arL,hy*arL,isXSideView?'#4ADE80':'#F87171')}
                    <text x={gc+hx*(arL+11)} y={gc+hy*(arL+11)} fill={isXSideView?'#4ADE80':'#F87171'} fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700">{hLabel}</text>
                    {/* Z矢印（青） */}
                    <line x1={gc} y1={gc} x2={gc+zx*arL} y2={gc+zy*arL} stroke="#60A5FA" strokeWidth={2} strokeLinecap="round"/>
                    {ah(zx*arL,zy*arL,'#60A5FA')}
                    <text x={gc+zx*(arL+11)} y={gc+zy*(arL+11)} fill="#60A5FA" fontSize={9} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
                      onClick={e=>{e.stopPropagation();setSecPnOpenId(isPnOpen?null:sec.id);}} style={{cursor:'pointer'}}>Z</text>
                  </svg>
                  {isPnOpen&&(
                    <div onMouseDown={e=>e.stopPropagation()} style={{marginTop:4,background:'rgba(15,23,42,0.72)',borderRadius:4,padding:'3px 5px'}}>
                      <div style={{display:'flex',alignItems:'center',gap:3}}>
                        <input type="text" inputMode="numeric" autoFocus onFocus={e=>e.target.select()} value={plantNorthInput}
                          onChange={e=>setPlantNorthInput(e.target.value)}
                          onBlur={e=>{const n=((Number(e.target.value)%360)+360)%360;const safe=isNaN(n)?0:n;setPlantNorthAngle(safe);setPlantNorthInput(String(safe));}}
                          onKeyDown={e=>{if(e.key==='Enter'){const n=((Number(e.target.value)%360)+360)%360;const safe=isNaN(n)?0:n;setPlantNorthAngle(safe);setPlantNorthInput(String(safe));}}}
                          style={{width:36,fontSize:9,padding:'1px 3px',background:'rgba(255,255,255,0.18)',border:'1px solid rgba(255,255,255,0.35)',borderRadius:3,color:'#FCD34D',textAlign:'center'}}/>
                        <span style={{fontSize:7,color:'#94A3B8'}}>°</span>
                      </div>
                      <div style={{display:'flex',justifyContent:'center',gap:4,marginTop:2}}>
                        <button onClick={()=>{const n=((plantNorthAngle+1)%360+360)%360;setPlantNorthAngle(n);setPlantNorthInput(String(n));}} style={{fontSize:8,lineHeight:1,padding:'1px 8px',background:'rgba(255,255,255,0.15)',border:'none',borderRadius:2,color:'#FCD34D',cursor:'pointer'}}>▲</button>
                        <button onClick={()=>{const n=((plantNorthAngle-1+360)%360);setPlantNorthAngle(n);setPlantNorthInput(String(n));}} style={{fontSize:8,lineHeight:1,padding:'1px 8px',background:'rgba(255,255,255,0.15)',border:'none',borderRadius:2,color:'#FCD34D',cursor:'pointer'}}>▼</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            </div>{/* position:relative wrapper sec */}
          </FloatWin>
        );
      })}

      {/* 水平断面 FloatWin（高さごとの平面図）hSecTickはドラッグ中再描画トリガー */}
      {hSections.map(hSec => {
        void hSecTick; // ドラッグ中にhSecTick変化→このmapが再実行される
        const _liveZPx = hSecLiveZRef.current[hSec.id] ?? hSec.zPx;
        const _z = hSecZooms[hSec.id] || 1;
        const hitLines = renderHSecSegs(_liveZPx);
        const bldBlocks = flatBlocks.filter(b => (b.zBottom||0) <= _liveZPx && _liveZPx <= b.zTop);
        const _liveLabel = _liveZPx >= 0 ? `${Math.floor(_liveZPx / MAJOR) + 1}F` : `B${Math.ceil(-_liveZPx / MAJOR)}`;
        const _iW = 42, _iH = 46, _iSym = 28, _iF = 11;

        // clipSec: 矢視図由来の場合はそのOBBでクリップ（CSS clip-path）
        const cs = hSec.clipSec;
        const clipPolyPts = cs ? (() => {
          if (cs.center !== undefined) {
            const { center: { x: cx, y: cy }, halfA, halfB, pnRad } = cs;
            const cP = Math.cos(pnRad), sP = Math.sin(pnRad);
            return [
              { x: cx - halfA*cP - halfB*sP, y: cy - halfA*sP + halfB*cP },
              { x: cx + halfA*cP - halfB*sP, y: cy + halfA*sP + halfB*cP },
              { x: cx + halfA*cP + halfB*sP, y: cy + halfA*sP - halfB*cP },
              { x: cx - halfA*cP + halfB*sP, y: cy - halfA*sP - halfB*cP },
            ];
          }
          if (cs.rect) {
            const { x1, y1, x2, y2 } = cs.rect;
            return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
          }
          return null;
        })() : null;
        const _clipPath = clipPolyPts ? `polygon(${clipPolyPts.map(p => `${p.x}px ${p.y}px`).join(', ')})` : undefined;

        const startHSecDragIcon = (e, n) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const containerEl = hSecConRefs.current[hSec.id];
          if (!containerEl) return;
          const _r = containerEl.getBoundingClientRect();
          const _zz = hSecZoomsRef.current[hSec.id] || 1;
          const tp = allMapPosRef.current[n.id] || { x: 0, y: 0 };
          const curP = { x: (e.clientX - _r.left) / _zz, y: (e.clientY - _r.top) / _zz };
          mapDragOffsetRef.current = { x: tp.x - curP.x, y: tp.y - curP.y };
          iconDragging.current = true;
          isDraggingRef.current = true;
          mapDragRef.current = { id: n.id, view: 'plan' };
          setHovNodeView(null); // Cesiumのカメラ/×ボタンを消す
          // 全ビューリアルタイム更新のためドラッグキャッシュを構築
          const _connSegs = connectedSegsMapRef.current[n.id] || [];
          const _pi = document.getElementById('pi-' + n.id), _ci = document.getElementById('ci-' + n.id);
          const _cab = cabRef.current;
          const cW = _cab?.clientWidth || CAB_W, cH = _cab?.clientHeight || CAB_H;
          const _csc = Math.min(cW / CAB_W, cH / CAB_H);
          const planWires = {}, elevWires = {}, sideWires = {}, cabWires = {};
          _connSegs.forEach(seg => {
            const pw = document.getElementById('pw-' + seg.id), ew = document.getElementById('ew-' + seg.id);
            const sw = document.getElementById('sw-' + seg.id), cw = document.getElementById('cw-' + seg.id);
            const cwh = document.getElementById('cwh-' + seg.id);
            if (pw) planWires[seg.id] = Array.from(pw.querySelectorAll('polyline'));
            if (ew) elevWires[seg.id] = Array.from(ew.querySelectorAll('polyline'));
            if (sw) sideWires[seg.id] = Array.from(sw.querySelectorAll('polyline'));
            cabWires[seg.id] = [...Array.from(cw?.querySelectorAll('polyline') || []), ...(cwh ? [cwh] : [])];
          });
          _dragGeomCache.current = {
            piEl: _pi, eiEl: document.getElementById('ei-' + n.id),
            siEl: document.getElementById('si-' + n.id), ciEl: _ci,
            piHW: _pi ? _pi.offsetWidth / 2 : 21, piHH: _pi ? _pi.offsetHeight / 2 : 23,
            eiHW: 21, siHW: 21,
            cabHW: _ci ? _ci.offsetWidth / 2 : 14, cabHH: _ci ? _ci.offsetHeight / 2 : 15,
            cabOx: (cW - CAB_W * _csc) / 2, cabOy: (cH - CAB_H * _csc) / 2, cabSc: _csc,
            connSegs: _connSegs, planWires, elevWires, sideWires, cabWires,
            elevRect: elevRef.current?.getBoundingClientRect() || null,
            sideRect: sideRef.current?.getBoundingClientRect() || null,
          };
          const _gz = allMapPosRef.current[n.id]?.z || 0;
          const _pos0WithId = { ...tp, z: _gz, nodeId: n.id };
          const _ov3d = _buildCesiumWireOverlay(cesium3dQueryRef, _connSegs, _pos0WithId);
          const _ov2d = _buildCesiumWireOverlay(cesium2dQueryRef, _connSegs, _pos0WithId);
          _applyDragDOM(n.id, tp.x, tp.y); // 初期位置でキャッシュを有効化
          _updateCesiumWireOverlay(_ov3d, tp.x, tp.y, _gz);
          _updateCesiumWireOverlay(_ov2d, tp.x, tp.y, _gz);
          if (!document.getElementById('__gs')) { const s = document.createElement('style'); s.id = '__gs'; s.textContent = '*{cursor:grabbing!important}'; document.head.appendChild(s); }
          let _rafId = null, _pendingEv = null;
          const _mv = (ev) => {
            ev.preventDefault();
            _pendingEv = ev;
            if (_rafId) return;
            _rafId = requestAnimationFrame(() => {
              _rafId = null;
              const ev2 = _pendingEv;
              if (!mapDragRef.current) return;
              const _zzz = hSecZoomsRef.current[hSec.id] || 1;
              const pp = { x: (ev2.clientX - _r.left) / _zzz, y: (ev2.clientY - _r.top) / _zzz };
              const nx = pp.x + mapDragOffsetRef.current.x, ny = pp.y + mapDragOffsetRef.current.y;
              _applyDragDOM(n.id, nx, ny, ev2.clientX, ev2.clientY);
              _updateCesiumWireOverlay(_ov3d, nx, ny, _gz);
              _updateCesiumWireOverlay(_ov2d, nx, ny, _gz);
              if (!hSecTickRafRef.current) {
                hSecTickRafRef.current = requestAnimationFrame(() => { hSecTickRafRef.current = null; setHSecTick(c => c + 1); });
              }
            });
          };
          const _up = () => {
            if (_rafId) cancelAnimationFrame(_rafId);
            window.removeEventListener('mousemove', _mv);
            window.removeEventListener('mouseup', _up);
            document.getElementById('__gs')?.remove();
            const fp = _lastDragPosRef.current;
            _lastDragPosRef.current = null;
            _teardownCesiumWireOverlay(_ov3d, fp ? { x: fp.x, y: fp.y, z: _gz } : null);
            _teardownCesiumWireOverlay(_ov2d, fp ? { x: fp.x, y: fp.y, z: _gz } : null);
            if (fp && mapDragRef.current) {
              setMapPos(pr => ({ ...pr, [n.id]: snapFine(fp.x, fp.y, hSecZoomsRef.current[hSec.id] || 1) }));
            }
            mapDragRef.current = null;
            iconDragging.current = false;
            isDraggingRef.current = false;
          };
          window.addEventListener('mousemove', _mv);
          window.addEventListener('mouseup', _up);
        };

        return (
          <FloatWin key={hSec.id} id={hSec.id}
            title={`平面図 ${_liveLabel}`}
            winState={winState} setWinState={setWinState} bringFront={bringFront}
            onClose={() => removeHSection(hSec.id)}
            headerExtra={<>
              <button onClick={() => { setSecMode(m => !m); setSecDrawing(null); }}
                style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
                  background: secMode ? "#DC2626" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
                {secMode ? "✂ ON" : "✂ 矢視追加"}
              </button>
              <button onClick={() => { setBldEditMode(m => !m); setSelectedBld(null); setBldDraw(null); if (secMode) { setSecMode(false); setSecDrawing(null); } }}
                style={{ padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 8, fontWeight: 600,
                  background: bldEditMode ? "#2563EB" : "rgba(255,255,255,0.15)", color: "#FFF" }}>
                {bldEditMode ? "🏗 ON" : "🏗 建屋"}
              </button>
            </>}>
            {/* 平面図（X-Y）と同一構造: スクロール可能コンテナ + CSS zoom + 絶対配置アイコン */}
            <div
              ref={el => {
                if (el && !hSecScrollRefs.current[hSec.id]) {
                  // 初回マウント: clipSec中心またはコンテンツ中心にスクロール
                  const _zz = hSecZoomsRef.current[hSec.id] || 1;
                  const cx = hSec.initCX ?? TW / 2, cy = hSec.initCY ?? TH / 2;
                  el.scrollLeft = Math.max(0, 40 + cx * _zz - el.clientWidth / 2);
                  el.scrollTop  = Math.max(0, 40 + cy * _zz - el.clientHeight / 2);
                  // ホイールズーム: カーソル下を固定（平面図と同じ式）
                  el.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    const SC_PAD = 40;
                    const scRect = el.getBoundingClientRect();
                    const mx = e.clientX - scRect.left;
                    const my = e.clientY - scRect.top;
                    const prevZ = hSecZoomsRef.current[hSec.id] || 1;
                    const factor = e.deltaY > 0 ? (1 / 1.07) : 1.07;
                    const newZ = Math.max(0.1, Math.min(8, prevZ * factor));
                    const ratio = newZ / prevZ;
                    // カーソル下のコンテンツ座標を固定するscroll目標値
                    hSecScrollUpdateRef.current = {
                      id: hSec.id,
                      left: (el.scrollLeft + mx - SC_PAD) * ratio + SC_PAD - mx,
                      top:  (el.scrollTop  + my - SC_PAD) * ratio + SC_PAD - my,
                    };
                    setHSecZooms(prev => ({ ...prev, [hSec.id]: newZ }));
                  }, { passive: false });
                }
                hSecScrollRefs.current[hSec.id] = el;
              }}
              style={{ overflow: 'auto', width: '100%', height: '100%', background: '#FEFEFE' }}>
              <div style={{ padding: 40, display: 'inline-block', lineHeight: 0, minWidth: '100%', minHeight: '100%', boxSizing: 'border-box' }}>
                <div
                  ref={el => { hSecConRefs.current[hSec.id] = el; }}
                  onMouseDown={e => {
                    // 背景クリック（アイコン以外）→ パンドラッグ開始
                    if (e.button !== 0) return;
                    const target = e.target;
                    if (target.getAttribute && (target.getAttribute('data-node') || target.closest('[data-node]'))) return;
                    e.preventDefault();
                    const scEl = hSecScrollRefs.current[hSec.id];
                    if (scEl) setViewPanDrag({ scrollEl: scEl, startX: e.clientX, startY: e.clientY, scrollLeft: scEl.scrollLeft, scrollTop: scEl.scrollTop });
                  }}
                  style={{ position: 'relative', width: TW, height: TH, background: '#FEFEFE', zoom: _z, flexShrink: 0, cursor: viewPanDrag?.scrollEl === hSecScrollRefs.current[hSec.id] ? 'grabbing' : 'grab', clipPath: _clipPath }}>
                  {/* SVG: グリッド + 建屋 + ワイヤー */}
                  <svg style={{ position: 'absolute', inset: 0, width: TW, height: TH }}>
                    <g pointerEvents="none">
                      {(() => {
                        const gls = [];
                        for (let x = 0; x <= TW; x += MAJOR)
                          gls.push(<line key={`gx${x}`} x1={x} y1={0} x2={x} y2={TH} stroke="rgba(0,0,0,0.07)" strokeWidth={0.8} />);
                        for (let y = 0; y <= TH; y += MAJOR)
                          gls.push(<line key={`gy${y}`} x1={0} y1={y} x2={TW} y2={y} stroke="rgba(0,0,0,0.07)" strokeWidth={0.8} />);
                        return gls;
                      })()}
                    </g>
                    {bldBlocks.map((b, i) => (
                      <polygon key={i}
                        points={(b.points||[]).map(p=>`${p.x},${p.y}`).join(' ')}
                        fill={b.color||'#94A3B8'} fillOpacity={0.25}
                        stroke={b.color||'#64748B'} strokeWidth={1.5} pointerEvents="none" />
                    ))}
                    {hitLines.map((ln, i) => (
                      <line key={i} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2}
                        stroke="#1a1a1a" strokeWidth={ln.isBus ? 3 : 1.5} strokeLinecap="round" pointerEvents="none" />
                    ))}
                  </svg>
                  {/* ノードアイコン（平面図と同一デザイン: Sym + ラベル + カメラ/×ボタン） */}
                  {nodes.map(n => {
                    if (n.kind !== 'symbol') return null;
                    const _pBase = allMapPosRef.current[n.id];
                    if (!_pBase) return null;
                    // ドラッグ中は_lastDragPosRef（DOM直接更新値）を優先（allMapPosRefはsetHSecTick再描画で上書きされるため）
                    const _isDragging = mapDragRef.current?.id === n.id;
                    const _dragPos = _isDragging ? _lastDragPosRef.current : null;
                    const _p = { x: _dragPos ? _dragPos.x : _pBase.x, y: _dragPos ? _dragPos.y : _pBase.y, z: _pBase.z ?? 0 };
                    if (Math.abs(_p.z - _liveZPx) > MAJOR / 2) return null;
                    const isHov = hSecHoverId?.nodeId === n.id && hSecHoverId?.hSecId === hSec.id;
                    return (
                      <div key={n.id}
                        onMouseDown={e => startHSecDragIcon(e, n)}
                        onMouseEnter={() => setHSecHoverId({ nodeId: n.id, hSecId: hSec.id })}
                        onMouseLeave={() => setHSecHoverId(null)}
                        style={{ position: 'absolute', left: _p.x - _iW / 2, top: _p.y - _iH / 2,
                                 width: _iW, height: _iH, display: 'flex', flexDirection: 'column',
                                 alignItems: 'center', justifyContent: 'center',
                                 cursor: 'grab', zIndex: 12, borderRadius: 3,
                                 background: isHov ? 'rgba(59,130,246,0.15)' : 'transparent',
                                 boxShadow: isHov ? `0 0 0 2px ${HL_COLOR}` : 'none',
                                 touchAction: 'none' }}>
                        <Sym shape={n.shape} size={_iSym} color={n.color} hl={isHov} />
                        <span style={{ fontSize: _iF, fontWeight: 700, color: '#334155', lineHeight: 1 }}>{n.label}</span>
                        {isHov && <div
                          onMouseDown={e => { e.stopPropagation(); e.preventDefault(); focusNode(n.id); }}
                          style={{ position: 'absolute', top: -10, right: -10, width: 16, height: 16, borderRadius: '50%',
                                   background: '#3B82F6', color: '#FFF', fontSize: 9, display: 'flex',
                                   alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                                   boxShadow: '0 1px 3px rgba(0,0,0,0.3)', zIndex: 50 }}
                          title="3D/2Dマップにフォーカス">📷</div>}
                        {isHov && <div
                          onMouseDown={e => { e.stopPropagation(); e.preventDefault();
                            setMapPos(pr => { const r = { ...pr }; delete r[n.id]; return r; });
                            setMapZ(pr => { const r = { ...pr }; delete r[n.id]; return r; });
                          }}
                          style={{ position: 'absolute', top: -10, left: -10, width: 16, height: 16, borderRadius: '50%',
                                   background: '#EF4444', color: '#FFF', fontSize: 11, fontWeight: 700, display: 'flex',
                                   alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                                   boxShadow: '0 1px 3px rgba(0,0,0,0.3)', zIndex: 50 }}
                          title="配置図から削除">×</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={{ position: 'absolute', top: 6, left: 6,
                          background: 'rgba(26,26,26,0.75)', color: '#FFF',
                          padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700,
                          pointerEvents: 'none' }}>
              {_liveLabel} / z={Math.round(_liveZPx)}px
            </div>
            {/* 寸法バー: 上下隣接面との距離(mm) */}
            {(() => {
              const _mppV = (typeof METERS_PER_PX === 'number' && METERS_PER_PX > 0) ? METERS_PER_PX : 0.1;
              const _toMm = dz => Math.round(Math.abs(dz) * _mppV * 1000);
              const _refs = [
                { id: 'GL', label: 'GL', zPx: 0 },
                ...hSections.filter(h => h.id !== hSec.id).map(h => ({ id: h.id, label: h.label, zPx: hSecLiveZRef.current[h.id] ?? h.zPx }))
              ].sort((a, b) => a.zPx - b.zPx);
              const _below = [..._refs].reverse().find(p => p.zPx < _liveZPx);
              const _above = _refs.find(p => p.zPx > _liveZPx);
              const _dims = [_below, _above].filter(Boolean);
              if (!_dims.length) return null;
              return (
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0,
                              background: 'rgba(241,245,249,0.95)', borderTop: '1px solid #CBD5E1',
                              display: 'flex', gap: 8, padding: '3px 8px', flexWrap: 'wrap', zIndex: 20 }}>
                  {_dims.map(ref => {
                    const _mm = _toMm(_liveZPx - ref.zPx);
                    const _isBelow = ref.zPx < _liveZPx;
                    const _isEdit = !hSecActiveDim && hSecEditDim?.hSecId === hSec.id && hSecEditDim?.refId === ref.id;
                    return (
                      <span key={ref.id} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
                        <span style={{ color: '#64748B' }}>{_isBelow ? '▼' : '▲'}{ref.label}:</span>
                        {_isEdit ? (
                          <input autoFocus defaultValue={_mm}
                            style={{ width: 64, fontSize: 9, border: '1px solid #3B82F6', borderRadius: 2, padding: '0 3px', outline: 'none' }}
                            onKeyDown={ev => {
                              if (ev.key === 'Enter') {
                                const newMm = parseFloat(ev.target.value);
                                if (!isNaN(newMm) && newMm >= 0) {
                                  const newZPx = ref.zPx + (newMm / 1000 / _mppV) * (_isBelow ? 1 : -1);
                                  const newLabel = newZPx >= 0 ? `${Math.floor(newZPx / MAJOR) + 1}F` : `B${Math.ceil(-newZPx / MAJOR)}`;
                                  setHSections(prev => prev.map(h => h.id === hSec.id ? { ...h, zPx: newZPx, label: newLabel } : h));
                                }
                                setHSecEditDim(null);
                              }
                              if (ev.key === 'Escape') setHSecEditDim(null);
                            }}
                            onBlur={() => setHSecEditDim(null)} />
                        ) : (
                          <span onClick={() => setHSecEditDim({ hSecId: hSec.id, refId: ref.id })}
                            style={{ color: '#1D4ED8', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted', minWidth: 40 }}>
                            {_mm.toLocaleString()} mm
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              );
            })()}
          </FloatWin>
        );
      })}
    </div>
  );
}
