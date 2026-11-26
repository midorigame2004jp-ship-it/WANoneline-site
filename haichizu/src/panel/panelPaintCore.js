// ================================================================
// 配電盤の「完成した見た目」を描く統括（唯一の実装）
// ================================================================
// panelDrawCore.js は色・形状・collect/paint の部品集で、こちらは
// 「どの順で集めて、どう重ねて、どこでレイヤー合成するか」の統括を持つ。
// 部品集と統括を同じファイルに詰めると責務が混ざるため分けた（2026-08-30 Codex監査の指示）。
//
// 【なぜ分けたか】3次元図だけがこの統括を持っていたため、建物エディタの盤は
// 面をベタ塗りしただけの「骨格」にしか見えなかった。同じ関数を呼べば見た目は必ず一致する。
//
// 【view でカメラ規約の差を吸収する】
//   proj         : 盤ローカルmm(x,y,z) → 画面座標 {x,y,depth}
//   isBackFacing : その法線が裏を向いているか（呼び出し側のカメラ規約で判定する）
//   nearSign     : depth が大きいほど手前なら +1、奥なら -1
//                  （エディタ=+1 / 3次元図=-1。ソートとZバッファの向きがこれで決まる）
//   canvasSc     : ctx に掛かっている scale。線幅をCSS px基準にそろえるのに使う
//
// 【禁止】色・アルファ・線幅をここや呼び出し側に直書きすること。すべて panelDrawCore.js が正。

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

// ctx へ盤1面ぶんを描く。opts: { fastMode, ocResLimit, iconVisMode, cablesVisible, doorsVisible }
function pdcDrawPanel(ctx, panel, view, opts) {
  if (!ctx || !panel || !view || typeof view.proj !== 'function') return;
  const o = opts || {};
  const fastMode = !!o.fastMode;
  const ocResLimit = o.ocResLimit;
  const iconVisMode = o.iconVisMode || 'opaque';
  const cablesVisible = o.cablesVisible !== false;
  const doorsVisible = o.doorsVisible !== false;
  const canvasSc = view.canvasSc || 1;
  const proj = view.proj;
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
    isBackFacing: view.isBackFacing,
    nearSign: (view.nearSign != null ? view.nearSign : -1),
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
        if (icon.doorId) continue;   // 扉アイコンは内部要素ではない（扉描画の直後に外側へ描く）
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
    // ── 扉に貼られたアイコン（四角＋ラベル）──
    // 配置も見た目も共通コアが唯一の正。エディタ（PanelCanvas3D）と同じ関数を呼ぶ。
    // doorRenderList の遠→近順で描くので、扉同士の重なりも扉面と同じ前後関係になる。
    // 閉扉かつ裏向きの扉は収集時点で除外されているため、そのアイコンも自動的に出ない。
    {
      const _dIconPl = pdcDoorIconPlacements(panel, panel.iconLayouts);
      const _dispModeD = panel.iconDisplayMode || 'flat';
      for (const { door: _dr } of doorRenderList) {
        const lst = _dIconPl.get(_dr.id);
        if (!lst) continue;
        for (const { icon, pos } of lst) {
          const iMode = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box' || icon.iconDisplayMode === 'hidden')
            ? icon.iconDisplayMode : _dispModeD;
          if (iMode === 'hidden') continue;   // 非表示指定は区画アイコンと同じ扱い
          pdcPaintDoorIcon(ctx, _dr, panel, _pdcView, icon, pos);
        }
      }
    }
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
      if (icon.doorId) continue;   // 扉アイコンのラベルは扉と一緒に描く（盤中心へフォールバックさせない）
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
