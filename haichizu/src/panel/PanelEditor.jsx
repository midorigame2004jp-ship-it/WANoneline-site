// ================================================================
// PanelEditor.jsx — 配電盤エディタ本体 Phase B
// 左ペイン: パネルリスト→パネルプロパティ→仕切りツリー→仕切りプロパティ
// 右ペイン: 3D キャンバス
// ================================================================

// ── カラーピッカー 色変換ユーティリティ ──
function _cp_hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0,2),16)||0, g: parseInt(h.slice(2,4),16)||0, b: parseInt(h.slice(4,6),16)||0 };
}
function _cp_rgbToHex(r,g,b) {
  return '#'+[r,g,b].map(x=>Math.max(0,Math.min(255,Math.round(x))).toString(16).padStart(2,'0')).join('');
}
function _cp_hsvToRgb(h,s,v) {
  const c=v*s, x=c*(1-Math.abs((h/60)%2-1)), m=v-c;
  let r,g,b;
  if(h<60){r=c;g=x;b=0;}else if(h<120){r=x;g=c;b=0;}else if(h<180){r=0;g=c;b=x;}
  else if(h<240){r=0;g=x;b=c;}else if(h<300){r=x;g=0;b=c;}else{r=c;g=0;b=x;}
  return {r:Math.round((r+m)*255),g:Math.round((g+m)*255),b:Math.round((b+m)*255)};
}
function _cp_rgbToHsv(r,g,b) {
  r/=255;g/=255;b/=255;
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
  let h=0;
  if(d>0){
    if(mx===r)h=60*(((g-b)/d%6+6)%6);
    else if(mx===g)h=60*((b-r)/d+2);
    else h=60*((r-g)/d+4);
  }
  return {h, s:mx>0?d/mx:0, v:mx};
}

// カラーピッカーポップアップ（SV勾配＋色相バー＋RGB＋16進数）
function ColorPickerPopup({ value, onChange, fixedPos }) {
  const svRef = React.useRef(null);
  const hueRef = React.useRef(null);
  const init = React.useMemo(() => {
    const rgb = _cp_hexToRgb(value || '#000000');
    return _cp_rgbToHsv(rgb.r, rgb.g, rgb.b);
  }, []);
  const [hsv, setHsv] = React.useState(init);
  const [hexDraft, setHexDraft] = React.useState('');
  const [hexFocused, setHexFocused] = React.useState(false);

  // parent value変化時にhsvを同期（ポップアップを開き直した時）
  React.useEffect(() => {
    const rgb = _cp_hexToRgb(value || '#000000');
    setHsv(_cp_rgbToHsv(rgb.r, rgb.g, rgb.b));
  }, [value]);

  const rgb = _cp_hsvToRgb(hsv.h, hsv.s, hsv.v);
  const hexVal = _cp_rgbToHex(rgb.r, rgb.g, rgb.b);

  const emit = (newHsv) => {
    const r2 = _cp_hsvToRgb(newHsv.h, newHsv.s, newHsv.v);
    onChange(_cp_rgbToHex(r2.r, r2.g, r2.b));
  };

  // SV勾配キャンバス描画
  React.useEffect(() => {
    const cv = svRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const W=cv.width, H=cv.height;
    const base = _cp_hsvToRgb(hsv.h,1,1);
    ctx.fillStyle=`rgb(${base.r},${base.g},${base.b})`;
    ctx.fillRect(0,0,W,H);
    const wg=ctx.createLinearGradient(0,0,W,0);
    wg.addColorStop(0,'rgba(255,255,255,1)'); wg.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=wg; ctx.fillRect(0,0,W,H);
    const bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'rgba(0,0,0,0)'); bg.addColorStop(1,'rgba(0,0,0,1)');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // セレクタ●
    const cx=hsv.s*W, cy=(1-hsv.v)*H;
    ctx.beginPath(); ctx.arc(cx,cy,6,0,Math.PI*2);
    ctx.strokeStyle='#FFF'; ctx.lineWidth=2; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx,cy,6,0,Math.PI*2);
    ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=1; ctx.stroke();
  }, [hsv.h, hsv.s, hsv.v]);

  // 色相バー描画
  React.useEffect(() => {
    const cv = hueRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const W=cv.width, H=cv.height;
    const hg=ctx.createLinearGradient(0,0,W,0);
    for(let i=0;i<=6;i++) hg.addColorStop(i/6,`hsl(${i*60},100%,50%)`);
    ctx.fillStyle=hg; ctx.fillRect(0,0,W,H);
    const x=(hsv.h/360)*W;
    ctx.fillStyle='#FFF'; ctx.fillRect(x-2,0,4,H);
    ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.lineWidth=1; ctx.strokeRect(x-2,0,4,H);
  }, [hsv.h]);

  const makeDragger = (handler) => (e) => {
    e.preventDefault();
    handler(e);
    const move = (me) => handler(me);
    const up = () => { window.removeEventListener('mousemove',move); window.removeEventListener('mouseup',up); };
    window.addEventListener('mousemove',move); window.addEventListener('mouseup',up);
  };

  const onSvDrag = (e) => {
    const cv=svRef.current; if(!cv) return;
    const r=cv.getBoundingClientRect();
    const s=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    const v=1-Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));
    const nHsv={...hsv,s,v}; setHsv(nHsv); emit(nHsv);
  };
  const onHueDrag = (e) => {
    const cv=hueRef.current; if(!cv) return;
    const r=cv.getBoundingClientRect();
    const h=Math.max(0,Math.min(360,((e.clientX-r.left)/r.width)*360));
    const nHsv={...hsv,h}; setHsv(nHsv); emit(nHsv);
  };

  const handleRgb = (ch,val) => {
    const v=Math.max(0,Math.min(255,parseInt(val)||0));
    const nr={...rgb,[ch]:v};
    const nHsv=_cp_rgbToHsv(nr.r,nr.g,nr.b); setHsv(nHsv); emit(nHsv);
  };

  return (
    <div onMouseDown={e=>e.stopPropagation()} style={{
      position:'fixed', zIndex:99999, background:'#FFF',
      border:'1px solid #CBD5E1', borderRadius:6, padding:8,
      boxShadow:'0 4px 16px rgba(0,0,0,0.25)', width:220,
      top: fixedPos ? fixedPos.top : 0,
      left: fixedPos ? fixedPos.left : 0,
    }}>
      <canvas ref={svRef} width={204} height={150}
        style={{display:'block',borderRadius:3,cursor:'crosshair',marginBottom:6,width:'100%'}}
        onMouseDown={makeDragger(onSvDrag)} />
      <canvas ref={hueRef} width={204} height={14}
        style={{display:'block',borderRadius:3,cursor:'pointer',marginBottom:8,width:'100%'}}
        onMouseDown={makeDragger(onHueDrag)} />
      <div style={{display:'flex',gap:4,marginBottom:6}}>
        {[['r','R'],['g','G'],['b','B']].map(([ch,label])=>(
          <div key={ch} style={{display:'flex',flexDirection:'column',alignItems:'center',flex:1}}>
            <input type="number" min={0} max={255} value={rgb[ch]}
              onChange={e=>handleRgb(ch,e.target.value)}
              style={{width:'100%',fontSize:12,textAlign:'center',padding:'2px 0',border:'1px solid #CBD5E1',borderRadius:3,boxSizing:'border-box'}} />
            <span style={{fontSize:10,color:'#64748B',marginTop:2}}>{label}</span>
          </div>
        ))}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:4}}>
        <span style={{fontSize:11,color:'#64748B',fontFamily:'monospace',flexShrink:0}}>#</span>
        <input type="text"
          value={hexFocused ? hexDraft : hexVal.replace('#','')}
          maxLength={6}
          placeholder="RRGGBB"
          onFocus={()=>{ setHexFocused(true); setHexDraft(hexVal.replace('#','')); }}
          onBlur={()=>setHexFocused(false)}
          onChange={e=>{
            const v=e.target.value; setHexDraft(v);
            if(/^[0-9a-fA-F]{6}$/.test(v)){
              const nr=_cp_hexToRgb('#'+v);
              const nHsv=_cp_rgbToHsv(nr.r,nr.g,nr.b); setHsv(nHsv); emit(nHsv);
            }
          }}
          style={{flex:1,fontSize:12,padding:'2px 4px',border:'1px solid #CBD5E1',borderRadius:3,fontFamily:'monospace'}} />
      </div>
    </div>
  );
}

// カラー入力（スウォッチクリックでカスタムポップアップ表示）
function ColorInput({ value, defaultValue, onChange, style, disabled, onClick, title }) {
  const isControlled = value !== undefined;
  const initVal = (isControlled ? value : defaultValue) || '#000000';
  const [localVal, setLocalVal] = React.useState(initVal);
  const [open, setOpen] = React.useState(false);
  const [fixedPos, setFixedPos] = React.useState(null);
  const containerRef = React.useRef(null);
  const btnRef = React.useRef(null);
  const displayVal = isControlled ? (value || '#000000') : localVal;
  const emit = (v) => {
    if (!isControlled) setLocalVal(v);
    onChange && onChange({ target: { value: v } });
  };
  // ポップアップ外クリックで閉じる
  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  // スタイルからレイアウト系プロパティをコンテナに移す
  const { marginLeft, marginRight, margin, marginTop, marginBottom, flexShrink, alignSelf, ...btnStyle } = style || {};
  const handleOpen = (e) => {
    if (disabled) return;
    onClick && onClick(e);
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const popW = 228; // popup width + padding
      const left = r.right + 6 + popW > window.innerWidth ? r.left - popW - 6 : r.right + 6;
      const top = Math.min(r.top, window.innerHeight - 360);
      setFixedPos({ top, left });
    }
    setOpen(o => !o);
  };
  return (
    <span ref={containerRef} style={{
      display:'inline-block', position:'relative', verticalAlign:'middle',
      marginLeft, marginRight, margin, marginTop, marginBottom, flexShrink, alignSelf,
    }}>
      <button
        ref={btnRef}
        style={{ ...btnStyle, background: displayVal, padding: 0 }}
        onClick={handleOpen}
        title={title}
        disabled={disabled}
      />
      {open && !disabled && (
        <ColorPickerPopup value={displayVal} onChange={v => emit(v)} fixedPos={fixedPos} />
      )}
    </span>
  );
}

function PanelEditor({ state }) {
  const {
    panels, activePanelId, setActivePanelId, activePanel,
    camera, setCamera,
    addPanel, updatePanel, deletePanel, toggleLock,
    addPartition, updatePartition, deletePartition,
    addDoor, addDoors, updateDoor, deleteDoor,
    addCable, updateCable, deleteCable,
    undo, redo, canUndo, canRedo, beginMerge, endMerge,
  } = state;

  // 選択中の仕切り ID 配列（複数選択対応。パネルが変わったらリセット）
  const [selectedPartIds, setSelectedPartIds] = useState([]);
  useEffect(() => { setSelectedPartIds([]); }, [activePanelId]);

  // 扉表示/非表示トグル（非表示中は仕切りを選択しやすくする）
  const [doorsVisible, setDoorsVisible] = useState(
    () => localStorage.getItem('wanol_doorsVisible') !== 'false'
  );



  // 区画色分け表示トグル
  const [showChamberColors, setShowChamberColors] = useState(
    () => localStorage.getItem('wanol_showChamberColors') !== 'false'
  );

// 機器透過モード: 'full'=全透過, 'semi'=半透過（仕切りに隠れる）, 'opaque'=不透過（扉/仕切りに隠れる）
  // 【状態源】盤ごとに記憶する（panel.iconVisMode）。3次元図（App.jsx）も
  // pp.panelData.iconVisMode を参照しており、両者で同じ盤データが唯一の正になる。
  // 旧実装は localStorage('wanol_iconVisMode') のエディタ全体グローバルだったため
  // 盤を切り替えても値が変わらず3次元図と食い違っていた（2026-08-02 修正）。
  // 未設定の既存盤は既定値 'semi'（App.jsx L1734 の `?? 'semi'` と一致）。
  const iconVisMode = activePanel?.iconVisMode || 'semi';
  const _iconVisModes = ['full', 'semi', 'opaque'];
  const _iconVisModeLabels = { full: '機器全透過', semi: '機器半透過', opaque: '機器不透過' };
  const _iconVisModeColors = { full: '#0EA5E9', semi: '#F59E0B', opaque: '#64748B' };

  // ドロップ先区画ホバー
  const [hoverChamberId, setHoverChamberId] = React.useState(null);

  // サイドバーリストのホバーID（仕切り・扉・アイコン）
  const [hoveredPartId, setHoveredPartId] = useState(null);
  const [hoveredDoorId, setHoveredDoorId] = useState(null);
  const [hoveredIconId, setHoveredIconId] = useState(null);
  const [hoveredCableId, setHoveredCableId] = useState(null);
  const [selectedCableId, setSelectedCableId] = useState(null);
  const [cablesVisible, setCablesVisible] = useState(true);
  // ドラッグ中解像度スケール（0.25〜1.0、デフォルト0.5）
  const [dragResolution, setDragResolution] = useState(
    () => parseFloat(localStorage.getItem('wanol_dragResolution') || '0.5')
  );
  // 静止後フル解像度に戻るまでの遅延ms（0〜500ms、デフォルト50ms）
  const [dragRestoreDelay, setDragRestoreDelay] = useState(
    () => parseInt(localStorage.getItem('wanol_dragRestoreDelay') || '50')
  );
  const [showDragResPopup, setShowDragResPopup] = useState(false);
  const _dragResPopupRef = useRef(null);
  useEffect(() => {
    if (!showDragResPopup) return;
    const handler = (e) => {
      if (_dragResPopupRef.current && !_dragResPopupRef.current.contains(e.target)) {
        setShowDragResPopup(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDragResPopup]);

  // 選択中アイコン（単一 + 複数選択セット）
  const [selectedIconId, setSelectedIconId] = React.useState(null);
  const [selectedIconIds, setSelectedIconIds] = React.useState(new Set());
  const [editingIconNameId, setEditingIconNameId] = React.useState(null); // インライン名前編集中のアイコンID
  const _editingInputRef = React.useRef(null); // 編集中inputへのref（クリック確定用）
  // キャンバスなど外部クリックでblurを強制して名前編集を確定させる
  useEffect(() => {
    if (!editingIconNameId) return;
    const handler = (e) => {
      if (_editingInputRef.current && !_editingInputRef.current.contains(e.target)) {
        _editingInputRef.current.blur();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [editingIconNameId]);

  // 選択中の扉 ID（null = 未選択）
  const [selectedDoorId, setSelectedDoorId] = useState(null);
  useEffect(() => { setSelectedDoorId(null); }, [activePanelId]);

  // 外箱辺選択（PanelCanvas3D内部から通知される [idxA,idxB] or null）
  const [selectedBoxEdge, setSelectedBoxEdge] = useState(null);

  // 扉配置モード: null | 'hover' | face文字列。パネルが変わったらリセット
  const [doorPlaceMode, setDoorPlaceMode] = useState(null);
  useEffect(() => { setDoorPlaceMode(null); }, [activePanelId]);

  // ケーブルルートモード（キャンバス直接操作）
  // null | { step:'from'|'waypoints', fromIconId?, waypoints:[], color, thickness, label }
  const [cableAddMode, setCableAddMode] = useState(null);
  useEffect(() => { setCableAddMode(null); }, [activePanelId]);
  // Esc=キャンセル、Enter=現在の経由点で確定（始点確定済みのとき）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setCableAddMode(null); setCableEditMode(null); return; }
      if (e.key === 'Enter') {
        setCableAddMode(prev => {
          if (!prev || prev.step !== 'waypoints') return prev;
          // 始点のみ確定済みでEnter → 終点未指定のまま done へ（単独アイコンへのスタブ）
          return { ...prev, step: 'done', toIconId: null };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // ケーブルフォーム: null=非表示, object=後から編集中
  const [cableForm, setCableForm] = useState(null);
  // ケーブル配置編集モード: null | { cableId, selectedWpIdx: null|number }
  // selectedWpIdx: null=未選択, -1=始点, -2=終点, 0以上=waypoints[i]
  const [cableEditMode, setCableEditMode] = useState(null);
  useEffect(() => { setCableEditMode(null); }, [activePanelId]);


  // Chamber 自動検出（パネル構成が変わったときのみ再計算）
  const chambers = useMemo(
    () => {
      if (!activePanel) return [];
      const chs = deriveChambers(activePanel);
      return applyColorMode(chs, activePanel.chamberColorMode || 'auto10', activePanel.chamberColorMap, activePanel.graph4Colors);
    },
    // placedIcons変更時に再計算しない（chamberはpartitions/サイズ/色設定のみで決まる）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activePanel?.id,
      activePanel?.partitions,
      activePanel?.widthMm, activePanel?.heightMm, activePanel?.depthMm,
      activePanel?.chamberColorMode, activePanel?.chamberColorMap, activePanel?.graph4Colors,
    ]
  );

  // 仕切り変更後にアイコンBoxのcellBoxを再計算
  // トリガー: activePanel.partitions 変化（長さ変更も含む）
  // 計算: chambers（partitionsから算出済み）のcellsを使用 — dragと同じ基準
  //   非構造仕切り（短い仕切り）は chambers に反映されないため、cellBox も制約しない。
  //   これはdrag配置と一貫した挙動（dragもchambersベース）。
  const _prevPartitionsRef = useRef(null);
  const _prevPanelIdRef = useRef(null);
  useEffect(() => {
    if (!activePanel || !chambers || chambers.length === 0) return;
    const panelId = activePanel.id;
    const currentPartitions = (activePanel.partitions || []).filter(p => p.type === 'axis');

    if (_prevPanelIdRef.current !== panelId) {
      _prevPartitionsRef.current = currentPartitions;
      _prevPanelIdRef.current = panelId;
      return;
    }
    const prevPartitions = _prevPartitionsRef.current || [];
    _prevPartitionsRef.current = currentPartitions;

    const hasChange = currentPartitions.length !== prevPartitions.length ||
      currentPartitions.some(p => { const pp = prevPartitions.find(x => x.id === p.id); return !pp || pp.posMm !== p.posMm || pp.uMinMm !== p.uMinMm || pp.uMaxMm !== p.uMaxMm || pp.vMinMm !== p.vMinMm || pp.vMaxMm !== p.vMaxMm; }) ||
      prevPartitions.some(pp => !currentPartitions.find(p => p.id === pp.id));
    if (!hasChange) return;

    const icons = activePanel.placedIcons || [];
    if (!icons.length) return;

    // アイコンの wx/wy/wz が含まれるチャンバーをスコアリングで探す
    // 境界一致時は「最も内側にある」チャンバーを選ぶ
    const findChamber = (wx, wy, wz) => {
      let best = null, bestScore = -Infinity;
      for (const ch of chambers) {
        for (const cell of (ch.cells || [])) {
          const sx = Math.min(wx - cell.xMin, cell.xMax - wx);
          const sy = Math.min(wy - cell.yMin, cell.yMax - wy);
          const sz = Math.min(wz - cell.zMin, cell.zMax - wz);
          const score = Math.min(sx, sy, sz);
          if (score > bestScore) { bestScore = score; best = ch; }
        }
      }
      return bestScore >= -5 ? best : null;
    };

    let changed = false;
    const updated = icons.map(icon => {
      if (!icon.cellBox || icon.wx == null) return icon;
      const ch = findChamber(icon.wx, icon.wy, icon.wz);
      if (!ch || !ch.cells || ch.cells.length === 0) return icon;
      const cells = ch.cells;
      const nb = {
        xMin: Math.min(...cells.map(c => c.xMin)), xMax: Math.max(...cells.map(c => c.xMax)),
        yMin: Math.min(...cells.map(c => c.yMin)), yMax: Math.max(...cells.map(c => c.yMax)),
        zMin: Math.min(...cells.map(c => c.zMin)), zMax: Math.max(...cells.map(c => c.zMax)),
      };
      const old = icon.cellBox;
      const newWx = (nb.xMin + nb.xMax) / 2;
      const newWy = (nb.yMin + nb.yMax) / 2;
      const newWz = (nb.zMin + nb.zMax) / 2;
      if (nb.xMin === old.xMin && nb.xMax === old.xMax &&
          nb.yMin === old.yMin && nb.yMax === old.yMax &&
          nb.zMin === old.zMin && nb.zMax === old.zMax) return icon;
      changed = true;
      return { ...icon, cellBox: nb, wx: newWx, wy: newWy, wz: newWz };
    });
    if (changed) updatePanel(activePanel.id, { placedIcons: updated });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel?.partitions]);

  // ESC で扉配置モードをキャンセル
  useEffect(() => {
    if (!doorPlaceMode) return;
    const onKey = (e) => { if (e.key === 'Escape') setDoorPlaceMode(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doorPlaceMode]);

  // Ctrl+Z / Ctrl+Y でアンドゥ / リドゥ
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Delete/Backspace で選択中の仕切り・扉を削除
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!activePanel || activePanel.locked) return;
      if (selectedPartIds.length > 0) {
        selectedPartIds.forEach(id => deletePartition(activePanel.id, id));
        setSelectedPartIds([]);
      }
      if (selectedDoorId) {
        deleteDoor(activePanel.id, selectedDoorId);
        setSelectedDoorId(null);
      }
      if (selectedIconId) {
        updatePanel(activePanel.id, {
          placedIcons: (activePanel.placedIcons || []).filter(ic => ic.id !== selectedIconId),
        });
        setSelectedIconId(null);
      }
      if (selectedCableId) {
        deleteCable(activePanel.id, selectedCableId);
        setSelectedCableId(null);
        if (hoveredCableId === selectedCableId) setHoveredCableId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activePanel, selectedPartIds, selectedDoorId, selectedIconId, selectedCableId, hoveredCableId, deletePartition, deleteDoor, updatePanel, setSelectedIconId, deleteCable]);

  // プライマリ選択（最後に選択した仕切り）
  const selectedPartId = selectedPartIds[selectedPartIds.length - 1] ?? null;
  const selectedPart = activePanel
    ? (activePanel.partitions || []).find(p => p.id === selectedPartId) || null
    : null;

  // 均等配置: 選択した仕切りの最端2枚を固定し、その間の全仕切り(未選択含む)を等間隔に並べる
  const handleUniformLayout = () => {
    if (selectedPartIds.length < 2 || !activePanel) return;
    const { widthMm: W, heightMm: H, depthMm: D, partitions = [] } = activePanel;

    // 軸ごとにグループ化して処理
    const byAxis = {};
    selectedPartIds.forEach(id => {
      const p = partitions.find(pt => pt.id === id);
      if (!p || p.type !== 'axis') return;
      if (!byAxis[p.axis]) byAxis[p.axis] = [];
      byAxis[p.axis].push(p);
    });

    Object.entries(byAxis).forEach(([axis, parts]) => {
      if (parts.length < 2) return;
      const maxVal = axis === 'x' ? W : axis === 'y' ? D : H;
      const posOf = p => p.posMm != null ? p.posMm : maxVal / 2;
      const sorted = [...parts].sort((a, b) => posOf(a) - posOf(b));
      const firstPos = posOf(sorted[0]);
      const lastPos  = posOf(sorted[sorted.length - 1]);

      // firstPos〜lastPos 間の全同軸仕切りを均等配置（選択外も含む）
      const inRange = partitions
        .filter(p => p.type === 'axis' && p.axis === axis)
        .map(p => ({ ...p, pos: posOf(p) }))
        .filter(p => p.pos >= firstPos - 0.5 && p.pos <= lastPos + 0.5)
        .sort((a, b) => a.pos - b.pos);
      if (inRange.length < 2) return;

      const step = (lastPos - firstPos) / (inRange.length - 1);
      let _firstUniform = true;
      inRange.forEach((p, i) => {
        if (i === 0 || i === inRange.length - 1) return; // 両端は固定
        updatePartition(activePanel.id, p.id, { posMm: Math.round(firstPos + step * i) }, { forceNew: _firstUniform });
        _firstUniform = false;
      });
    });
  };

  // 盤内均等配置: 選択した仕切りを親箱壁-壁間で等間隔に再配置（全員動く）
  const handleUniformLayoutPanel = () => {
    if (selectedPartIds.length < 1 || !activePanel) return;
    const { widthMm: W, heightMm: H, depthMm: D, partitions = [] } = activePanel;
    const byAxis = {};
    selectedPartIds.forEach(id => {
      const p = partitions.find(pt => pt.id === id);
      if (!p || p.type !== 'axis') return;
      if (!byAxis[p.axis]) byAxis[p.axis] = [];
      byAxis[p.axis].push(p);
    });
    Object.entries(byAxis).forEach(([axis, parts]) => {
      const maxVal = axis === 'x' ? W : axis === 'y' ? D : H;
      const posOf = p => p.posMm != null ? p.posMm : maxVal / 2;
      const sorted = [...parts].sort((a, b) => posOf(a) - posOf(b));
      const n = sorted.length;
      let _firstPanel = true;
      sorted.forEach((p, i) => {
        updatePartition(activePanel.id, p.id, { posMm: Math.round(maxVal * (i + 1) / (n + 1)) }, { forceNew: _firstPanel });
        _firstPanel = false;
      });
    });
  };

  // ケーブルルートモード: アイコン/区画クリック時のコールバック
  // extra: { wx, wy, wz } クリックしたセル中心の3D座標（chamber型のみ）
  const handleCablePoint = (type, id, extra) => {
    setCableAddMode(prev => {
      if (!prev) return null;
      if (prev.step === 'from') {
        if (type === 'icon') {
          return { ...prev, step: 'waypoints', fromIconId: id,
                   fromWx: extra?.wx ?? null, fromWy: extra?.wy ?? null, fromWz: extra?.wz ?? null };
        }
        if (type === 'chamber') {
          const wp = { chamberId: id, wx: extra?.wx, wy: extra?.wy, wz: extra?.wz };
          return { ...prev, step: 'waypoints', waypoints: [wp] };
        }
        return prev;
      }
      if (prev.step === 'waypoints') {
        if (type === 'complete') {
          return { ...prev, step: 'done', toIconId: null };
        }
        if (type === 'chamber') {
          const wp = { chamberId: id, wx: extra?.wx, wy: extra?.wy, wz: extra?.wz };
          return { ...prev, waypoints: [...prev.waypoints, wp] };
        }
        if (type === 'icon' && id !== prev.fromIconId) {
          return { ...prev, step: 'done', toIconId: id };
        }
      }
      // step='from' でも区画クリック(complete除く)は無視
      return prev;
    });
  };

  // cableEditMode中: waypoint点をクリックして選択、別の点をクリックして移動
  const handleCableWpClick = useCallback((wpIdx) => {
    setCableEditMode(prev => prev ? { ...prev, selectedWpIdx: wpIdx } : prev);
  }, []);
  // ケーブル端点移動後にwiresetIdを再計算して差し替え
  const recalcWiresetIds = useCallback((baseCables) => {
    if (!activePanel || !baseCables || baseCables.length === 0) return;
    const EPS = 5; // mm
    // 各ケーブルの全通過点チェーンを構築（from + waypoints + to）
    const icons = activePanel.placedIcons || [];
    const chains = baseCables.map(c => {
      const fi = icons.find(ic=>ic.id===c.fromIconId);
      const ti = icons.find(ic=>ic.id===c.toIconId);
      const chain = [];
      const fwx = c.fromWx??fi?.wx??null;
      if (fwx!=null) chain.push({wx:fwx, wy:c.fromWy??fi?.wy??0, wz:c.fromWz??fi?.wz??0});
      for (const wp of (c.waypoints||[])) { if (wp?.wx!=null) chain.push({wx:wp.wx,wy:wp.wy,wz:wp.wz}); }
      const twx = c.toWx??ti?.wx??null;
      if (twx!=null) chain.push({wx:twx, wy:c.toWy??ti?.wy??0, wz:c.toWz??ti?.wz??0});
      return chain;
    });
    // Union-Find
    const parent = baseCables.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (let i = 0; i < baseCables.length; i++) {
      for (let j = i+1; j < baseCables.length; j++) {
        let connected = false;
        outer: for (const pi of chains[i]) {
          for (const pj of chains[j]) {
            if (Math.hypot(pi.wx-pj.wx, pi.wy-pj.wy, pi.wz-pj.wz) <= EPS) { connected = true; break outer; }
          }
        }
        if (connected) union(i, j);
      }
    }
    // グループごとにwiresetIdを決定
    const groupWsId = new Map(); // root → wsId
    baseCables.forEach((_, i) => {
      const root = find(i);
      if (!groupWsId.has(root)) {
        // グループ内の既存wiresetIdを優先
        const existing = baseCables.filter((__, j) => find(j) === root).find(c => c.wiresetId);
        groupWsId.set(root, existing?.wiresetId || null);
      }
    });
    // グループサイズを確認しwiresetId付与
    const groupSize = new Map();
    baseCables.forEach((_, i) => { const r = find(i); groupSize.set(r, (groupSize.get(r)||0)+1); });
    const newCables = baseCables.map((c, i) => {
      const root = find(i);
      const size = groupSize.get(root);
      let wsId = size >= 2 ? (groupWsId.get(root) || ('ws_'+Date.now()+'_'+root)) : null;
      // 同グループ内で同じIDを使うため再取得
      if (size >= 2 && !groupWsId.get(root)) groupWsId.set(root, wsId);
      wsId = size >= 2 ? groupWsId.get(root) : null;
      return c.wiresetId === wsId ? c : { ...c, wiresetId: wsId };
    });
    updatePanel(activePanel.id, { cables: newCables });
  }, [activePanel, updatePanel]);

  const handleCableWpMove = useCallback((type, extra) => {
    if (type === 'cancel') {
      setCableEditMode(prev => prev ? { ...prev, selectedWpIdx: null } : null);
      return;
    }
    if (type === 'endpoint' && extra?.wx != null) {
      const { cableId, endType, wx, wy, wz } = extra;
      if (!cableId || !endType || !activePanel) return;
      const patch = endType === 'from' ? { fromWx: wx, fromWy: wy, fromWz: wz } : { toWx: wx, toWy: wy, toWz: wz };
      const updatedCables = (activePanel.cables||[]).map(c => c.id === cableId ? { ...c, ...patch } : c);
      recalcWiresetIds(updatedCables);
      setCableEditMode(prev => prev ? { ...prev, selectedWpIdx: null } : null);
    }
    if (type === 'chamber' && extra?.wx != null) {
      const cableId = extra.cableId;
      const targetIdx = extra.wpIdx;
      if (!cableId || targetIdx == null || !activePanel) return;
      const cable = activePanel.cables?.find(c => c.id === cableId);
      if (!cable) return;
      const newWps = (cable.waypoints || []).map((wp, i) =>
        i === targetIdx ? { ...wp, wx: extra.wx, wy: extra.wy, wz: extra.wz, chamberId: extra.chamberId ?? wp.chamberId } : wp
      );
      const updatedCables = (activePanel.cables||[]).map(c => c.id === cableId ? { ...c, waypoints: newWps } : c);
      recalcWiresetIds(updatedCables);
      setCableEditMode(prev => prev ? { ...prev, selectedWpIdx: null } : null);
    }
  }, [activePanel, updateCable, recalcWiresetIds]);

  // Ctrl+ドラッグによるタップ作成
  const handleNewTap = useCallback(({ fromWx, fromWy, fromWz, fromChamberId, toWx, toWy, toWz, toChamberId, cableId }) => {
    if (!activePanel) return;
    const existingCable = activePanel.cables?.find(c => c.id === cableId);
    if (!existingCable) return;
    // 母線にwiresetIdがなければ新規発行して付与
    const wsId = existingCable.wiresetId || ('ws_' + Date.now());
    if (!existingCable.wiresetId) {
      updateCable(activePanel.id, cableId, { wiresetId: wsId });
    }
    // タップ（分岐線）を追加
    addCable(activePanel.id, {
      wiresetId: wsId,
      fromWx, fromWy, fromWz,
      fromIconId: '',
      toWx, toWy, toWz,
      toIconId: '',
      waypoints: [],
      color: existingCable.color || '#60A5FA',
      thickness: existingCable.thickness || 3,
      label: '',
    });
  }, [activePanel, updateCable, addCable]);

  // cableAddMode が 'done' になったらケーブルを保存してリセット
  useEffect(() => {
    if (!cableAddMode || cableAddMode.step !== 'done') return;
    addCable(activePanel?.id, {
      fromIconId: cableAddMode.fromIconId,
      fromWx: cableAddMode.fromWx,
      fromWy: cableAddMode.fromWy,
      fromWz: cableAddMode.fromWz,
      toIconId: cableAddMode.toIconId,
      waypoints: cableAddMode.waypoints,
      color: cableAddMode.color,
      thickness: cableAddMode.thickness,
      label: cableAddMode.label,
    });
    setCableAddMode(null);
  }, [cableAddMode]); // eslint-disable-line

  // キャンバスコンテナのサイズ監視
  const canvContainerRef = useRef(null);
  const [canvSize, setCanvSize] = useState({ w: 600, h: 500 });
  useEffect(() => {
    if (!canvContainerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setCanvSize({ w: Math.max(200, Math.floor(width)), h: Math.max(200, Math.floor(height)) });
      }
    });
    ro.observe(canvContainerRef.current);
    return () => ro.disconnect();
  }, []);

  // パネルが切り替わったらカメラをフィット（初期表示は1段階引いた状態）
  // useLayoutEffect: ブラウザ描画前に同期実行 → zoom=1 の一瞬表示を防ぐ
  useLayoutEffect(() => {
    if (!activePanel) return;
    const fit = panelAutoFit(activePanel, camera.az, camera.el, canvSize.w, canvSize.h);
    setCamera(c => ({ ...c, ...fit, zoom: fit.zoom * 0.78 }));
  }, [activePanelId]); // eslint-disable-line

  const handleFit = () => {
    if (!activePanel) return;
    const fit = panelAutoFit(activePanel, camera.az, camera.el, canvSize.w, canvSize.h);
    setCamera(c => ({ ...c, ...fit }));
  };

  // 仕切り追加（デフォルト値をパネルサイズから計算）
  const handleAddPartition = (type) => {
    if (!activePanel) return;
    let defaults;
    if (type === 'axis') {
      defaults = {
        axis: 'y',
        posMm: Math.round(activePanel.depthMm / 2),
        uMinMm: 0, uMaxMm: activePanel.widthMm,
        vMinMm: 0, vMaxMm: activePanel.heightMm,
        thicknessMm: 2,
      };
    } else {
      // poly: デフォルトは前後中央面の4頂点
      const { widthMm: W, heightMm: H, depthMm: D } = activePanel;
      defaults = {
        vertices: [
          { x: 0, y: D / 2, z: 0 },
          { x: W, y: D / 2, z: 0 },
          { x: W, y: D / 2, z: H },
          { x: 0, y: D / 2, z: H },
        ],
        thicknessMm: 2,
      };
    }
    const id = addPartition(activePanel.id, { type, ...defaults });
    if (id) setSelectedPartIds([id]);
  };

  const locked = activePanel ? activePanel.locked : false;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── 左サイドバー（スクロール可） ── */}
      <div style={{
        width: 260, minWidth: 260, flexShrink: 0,
        borderRight: '1px solid #CBD5E1',
        background: '#F8FAFC',
        overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* ロックバナー */}
        {locked && (
          <div style={{
            background: '#FEF2F2', borderBottom: '1px solid #FECACA',
            padding: '5px 10px', fontSize: 11, color: '#DC2626', fontWeight: 700,
          }}>
            🔒 ロック中 — 編集不可
          </div>
        )}

        {/* === パネル一覧 === */}
        <div style={{ padding: '8px 8px 0', borderBottom: '1px solid #E2E8F0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>配電盤一覧</span>
            <button onClick={addPanel} style={panelBtnStyle('#3B82F6')}>＋新規</button>
          </div>
          <div style={{ maxHeight: 120, overflowY: 'auto', marginBottom: 8 }}>
            {panels.length === 0 && (
              <div style={{ fontSize: 11, color: '#94A3B8', padding: '4px 0' }}>（なし）</div>
            )}
            {panels.map(p => (
              <div key={p.id}
                onClick={() => setActivePanelId(p.id)}
                style={{
                  padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
                  fontSize: 12, marginBottom: 2,
                  background: p.id === activePanelId ? '#DBEAFE' : 'transparent',
                  color: p.id === activePanelId ? '#1D4ED8' : '#334155',
                  border: p.id === activePanelId ? '1px solid #BFDBFE' : '1px solid transparent',
                  display: 'flex', gap: 4, alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 10 }}>{p.locked ? '🔒' : '📦'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.name}</span>
                {p.id === activePanelId && (<>
                  <button
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (window.parent !== window) {
                        window.parent.postMessage({ type: 'PANEL_DRAG_START', panel: JSON.parse(JSON.stringify(p)) }, '*');
                      }
                    }}
                    style={{ fontSize: 9, padding: '1px 5px', background: '#059669', color: '#fff', border: 'none', borderRadius: 3, cursor: 'grab', flexShrink: 0 }}
                    title="配置図の3次元図へドラッグして配置"
                  >配置</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (window.confirm(`「${p.name}」を削除しますか？`)) deletePanel(p.id); }}
                    style={{ fontSize: 9, padding: '1px 5px', background: '#EF4444', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', flexShrink: 0 }}
                  >盤削除</button>
                </>)}
              </div>
            ))}
          </div>
        </div>

        {activePanel && (<>

          {/* === メイン機能 === */}
          <div style={{ padding: '8px 8px 6px', borderBottom: '2px solid #334155', background: '#1E293B' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <span style={{ fontSize: 10, color: '#64748B', fontWeight: 700, letterSpacing: '0.05em' }}>メイン機能</span>
              {/* アンドゥ/リドゥ + 歯車（右端） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  onClick={undo}
                  disabled={!canUndo}
                  title="アンドゥ (Ctrl+Z)"
                  style={{
                    background: 'none', border: 'none', cursor: canUndo ? 'pointer' : 'default',
                    padding: '1px 2px', lineHeight: 1,
                    color: canUndo ? '#94A3B8' : '#334155',
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                    <path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 2.1-5.8"/>
                  </svg>
                </button>
                <button
                  onClick={redo}
                  disabled={!canRedo}
                  title="リドゥ (Ctrl+Y)"
                  style={{
                    background: 'none', border: 'none', cursor: canRedo ? 'pointer' : 'default',
                    padding: '1px 2px', lineHeight: 1,
                    color: canRedo ? '#94A3B8' : '#334155',
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                    <path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-2.1-5.8"/>
                  </svg>
                </button>
              {/* ドラッグ解像度設定: 歯車ボタン（右端） */}
              <div ref={_dragResPopupRef} style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowDragResPopup(v => !v)}
                  title="ドラッグ中の描画品質設定"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', lineHeight: 1,
                    color: showDragResPopup ? '#F59E0B' : '#64748B',
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
                {showDragResPopup && (
                  <div style={{
                    position: 'absolute', top: '110%', right: 0,
                    background: '#1E293B', border: '1px solid #475569', borderRadius: 6,
                    padding: '10px 12px', zIndex: 999, width: 200, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                  }}>
                    <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 6, fontWeight: 700 }}>
                      ドラッグ中の描画品質
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#64748B', marginBottom: 3 }}>
                      <span>低画質（軽い）</span><span>高画質（重い）</span>
                    </div>
                    <input type="range" min={25} max={100} step={5}
                      value={Math.round(dragResolution * 100)}
                      onChange={e => {
                        const v = parseInt(e.target.value) / 100;
                        setDragResolution(v);
                        localStorage.setItem('wanol_dragResolution', v);
                      }}
                      style={{ width: '100%', cursor: 'pointer' }}
                    />
                    <div style={{ textAlign: 'center', fontSize: 10, color: '#E2E8F0', marginTop: 4 }}>
                      {Math.round(dragResolution * 100)}%（デフォルト: 50%）
                    </div>
                    <div style={{ borderTop: '1px solid #334155', marginTop: 8, paddingTop: 8 }}>
                      <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 4, fontWeight: 700 }}>
                        静止後に戻るまでの時間
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#64748B', marginBottom: 3 }}>
                        <span>即時（0ms）</span><span>遅め（500ms）</span>
                      </div>
                      <input type="range" min={0} max={500} step={50}
                        value={dragRestoreDelay}
                        onChange={e => {
                          const v = parseInt(e.target.value);
                          setDragRestoreDelay(v);
                          localStorage.setItem('wanol_dragRestoreDelay', v);
                        }}
                        style={{ width: '100%', cursor: 'pointer' }}
                      />
                      <div style={{ textAlign: 'center', fontSize: 10, color: '#E2E8F0', marginTop: 4 }}>
                        {dragRestoreDelay}ms（デフォルト: 50ms）
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setDragResolution(0.5); localStorage.setItem('wanol_dragResolution', 0.5);
                        setDragRestoreDelay(50); localStorage.setItem('wanol_dragRestoreDelay', 50);
                      }}
                      style={{ marginTop: 6, width: '100%', fontSize: 9, padding: '2px 0', borderRadius: 3,
                               background: '#334155', color: '#94A3B8', border: '1px solid #475569', cursor: 'pointer' }}
                    >デフォルトに戻す</button>
                  </div>
                )}
              </div>
              </div>{/* end アンドゥ/リドゥ+歯車 wrapper */}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginBottom: 7 }}>
              {/* 扉表示トグル: ドアアイコン。表示中=赤、非表示=グレー+斜線 */}
              <button
                onClick={() => setDoorsVisible(v => { const next = !v; localStorage.setItem('wanol_doorsVisible', next); return next; })}
                style={{ ...panelBtnStyle(doorsVisible ? '#DC2626' : '#64748B'), padding: '4px 6px', lineHeight: 1 }}
                title={doorsVisible ? 'Door: visible (click to hide)' : 'Door: hidden (click to show)'}
              >
                <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round">
                  <rect x="3" y="1.5" width="12" height="15" rx="1" strokeWidth="1.4"/>
                  <circle cx="13" cy="9" r="1.1" fill="currentColor" stroke="none"/>
                  {!doorsVisible && <line x1="1.5" y1="16.5" x2="16.5" y2="1.5" strokeWidth="1.6"/>}
                </svg>
              </button>
              {/* 区画色ON/OFF: 4分割カラーグリッドアイコン */}
              <button
                onClick={() => setShowChamberColors(v => { const next = !v; localStorage.setItem('wanol_showChamberColors', next); return next; })}
                style={{ ...panelBtnStyle(showChamberColors ? '#0EA5E9' : '#64748B'), padding: '4px 6px', lineHeight: 1 }}
                title={showChamberColors ? 'Chamber colors: ON (click to turn off)' : 'Chamber colors: OFF (click to turn on)'}
              >
                <svg viewBox="0 0 18 18" width="18" height="18">
                  <rect x="1.5" y="1.5" width="6.5" height="6.5" rx="1" fill={showChamberColors ? '#38BDF8' : 'none'} stroke="currentColor" strokeWidth="1.3"/>
                  <rect x="10"  y="1.5" width="6.5" height="6.5" rx="1" fill={showChamberColors ? '#A78BFA' : 'none'} stroke="currentColor" strokeWidth="1.3"/>
                  <rect x="1.5" y="10"  width="6.5" height="6.5" rx="1" fill={showChamberColors ? '#34D399' : 'none'} stroke="currentColor" strokeWidth="1.3"/>
                  <rect x="10"  y="10"  width="6.5" height="6.5" rx="1" fill={showChamberColors ? '#FCA5A5' : 'none'} stroke="currentColor" strokeWidth="1.3"/>
                </svg>
              </button>
              {/* 機器透過モード: 目アイコン。全透過=輪郭のみ、半透過=半分、不透過=塗りつぶし */}
              <button
                onClick={() => {
                  // 盤ごとに記憶（3次元図 App.jsx の updatePlacedPanel(..., 'iconVisMode', next) と同じ状態源）
                  const cur = activePanel.iconVisMode || 'semi';
                  const next = _iconVisModes[(_iconVisModes.indexOf(cur) + 1) % _iconVisModes.length];
                  updatePanel(activePanel.id, { iconVisMode: next });
                }}
                style={{ ...panelBtnStyle(_iconVisModeColors[iconVisMode]), padding: '4px 6px', lineHeight: 1 }}
                title={{ full: 'Device: fully transparent', semi: 'Device: semi-transparent', opaque: 'Device: opaque' }[iconVisMode]}
              >
                <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round">
                  {/* 目の外形 */}
                  <path d="M1.5 9 C4 4, 14 4, 16.5 9 C14 14, 4 14, 1.5 9Z" strokeWidth="1.3"/>
                  {/* 瞳: 透過モードで充填度が変わる */}
                  {iconVisMode === 'opaque' && <circle cx="9" cy="9" r="3.5" fill="white" strokeWidth="1.3"/>}
                  {iconVisMode === 'semi'   && <path d="M9 5.5 A3.5 3.5 0 0 1 9 12.5 Z" fill="currentColor" stroke="none"/>}
                  {iconVisMode === 'full'   && <circle cx="9" cy="9" r="3.5" fill="currentColor" stroke="none"/>}
                </svg>
              </button>
              {/* 機器3D表示: キューブアイコン(ON)、平面四角(OFF)、バツ付き(非表示) */}
              <button
                onClick={() => {
                  const _cur = activePanel.iconDisplayMode || 'flat';
                  const _modes3d = ['box', 'flat', 'hidden'];
                  const _next = _modes3d[(_modes3d.indexOf(_cur) + 1) % _modes3d.length];
                  updatePanel(activePanel.id, { iconDisplayMode: _next });
                }}
                style={{ ...panelBtnStyle(activePanel.iconDisplayMode === 'box' ? '#7C3AED' : activePanel.iconDisplayMode === 'hidden' ? '#374151' : '#64748B'), padding: '4px 6px', lineHeight: 1 }}
                title={{ box: 'Device display: 3D box', flat: 'Device display: flat icon', hidden: 'Device display: hidden' }[activePanel.iconDisplayMode || 'flat']}
              >
                <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  {activePanel.iconDisplayMode === 'box' ? (
                    /* 3D等角キューブ */
                    <>
                      <polygon points="9,2 16.5,5.5 9,9 1.5,5.5" strokeWidth="1.3" fill="currentColor" fillOpacity="0.35"/>
                      <polyline points="1.5,5.5 1.5,12.5 9,16 16.5,12.5 16.5,5.5" strokeWidth="1.3"/>
                      <line x1="9" y1="9" x2="9" y2="16" strokeWidth="1.3"/>
                    </>
                  ) : activePanel.iconDisplayMode === 'hidden' ? (
                    /* 非表示: 四角+バツ */
                    <>
                      <rect x="3" y="3" width="12" height="12" rx="1.5" strokeWidth="1.3"/>
                      <line x1="5" y1="5" x2="13" y2="13" strokeWidth="1.5"/>
                      <line x1="13" y1="5" x2="5" y2="13" strokeWidth="1.5"/>
                    </>
                  ) : (
                    /* 平面: 四角に平面レイアウトを示す内線 */
                    <>
                      <rect x="3" y="3" width="12" height="12" rx="1.5" strokeWidth="1.3"/>
                      <rect x="5.5" y="5.5" width="3" height="3" strokeWidth="1.1"/>
                      <rect x="9.5" y="5.5" width="3" height="3" strokeWidth="1.1"/>
                      <rect x="5.5" y="9.5" width="3" height="3" strokeWidth="1.1"/>
                    </>
                  )}
                </svg>
              </button>
              {/* 配線ON/OFF: ケーブルアイコン。ON=シアン、OFF=ダークグレー+斜線 */}
              <button
                onClick={() => { setCablesVisible(v => !v); setSelectedCableId(null); }}
                style={{ ...panelBtnStyle(cablesVisible ? '#0EA5E9' : '#374151'), padding: '4px 6px', lineHeight: 1 }}
                title={cablesVisible ? 'Cables: visible (click to hide)' : 'Cables: hidden (click to show)'}
              >
                <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="round">
                  <circle cx="2.5" cy="9" r="1.5" fill="currentColor" stroke="none"/>
                  <circle cx="15.5" cy="9" r="1.5" fill="currentColor" stroke="none"/>
                  <path d="M4 9 C6 5, 8 5, 9 9 C10 13, 12 13, 14 9" strokeWidth="1.5"/>
                  {!cablesVisible && <line x1="1.5" y1="16.5" x2="16.5" y2="1.5" strokeWidth="1.6"/>}
                </svg>
              </button>
              {/* 区画色モード（ON時のみ） */}
              {showChamberColors && (
                <select
                  value={activePanel.chamberColorMode || 'auto10'}
                  onChange={e => updatePanel(activePanel.id, { chamberColorMode: e.target.value })}
                  style={{ fontSize: 10, padding: '2px 4px', borderRadius: 3, border: '1px solid #475569',
                           background: '#334155', color: '#E2E8F0', cursor: 'pointer' }}
                >
                  <option value="auto10">10色順</option>
                  <option value="graph4">4色塗分</option>
                  <option value="posHash">位置ハッシュ</option>
                  <option value="manual">手動</option>
                </select>
              )}
            </div>
            {/* 4色塗分カスタムパレット */}
            {showChamberColors && (activePanel.chamberColorMode || 'auto10') === 'graph4' && (() => {
              const DEFAULT4 = ['#93C5FD', '#FCD34D', '#86EFAC', '#FCA5A5'];
              const current = activePanel.graph4Colors || DEFAULT4;
              const isDefault = current.every((c, i) => c === DEFAULT4[i]);
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 4, flexWrap: 'wrap' }}>
                  {current.map((col, i) => (
                    <ColorInput
                      key={i}
                      value={col}
                      title={`色${i + 1}`}
                      onChange={e => {
                        const next = [...current];
                        next[i] = e.target.value;
                        updatePanel(activePanel.id, { graph4Colors: next });
                      }}
                      style={{ width: 28, height: 22, padding: 1, border: '1px solid #475569',
                               borderRadius: 3, cursor: 'pointer', background: 'none' }}
                    />
                  ))}
                  {!isDefault && (
                    <button
                      onClick={() => updatePanel(activePanel.id, { graph4Colors: DEFAULT4 })}
                      style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3, border: '1px solid #475569',
                               background: '#334155', color: '#94A3B8', cursor: 'pointer' }}
                      title="デフォルト色に戻す"
                    >戻す</button>
                  )}
                </div>
              );
            })()}
            {/* 透明度スライダー */}
            {activePanel && (<>
              <label style={{ fontSize: 10, color: '#94A3B8', display: 'block', marginBottom: 2 }}>
                外箱の透明度: {pdcTransparency(activePanel)}%（0=不透明・仕切り隠蔽）
              </label>
              <input type="range" min={0} max={100} step={1}
                value={pdcTransparency(activePanel)} disabled={locked}
                onChange={e => updatePanel(activePanel.id, { outerOpacity: parseInt(e.target.value) })}
                style={{ width: '100%', cursor: locked ? 'not-allowed' : 'pointer' }} />
            </>)}
          </div>

          {/* === パネルプロパティ === */}
          <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
            <Collapsible title="パネルプロパティ" storageKey="wanol_sec_panelProps">
              {/* 手動モード: 区画ごとのカラーピッカー */}
              {showChamberColors && (activePanel.chamberColorMode || 'auto10') === 'manual' && chambers.length > 0 && (
                <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {chambers.map((ch, i) => (
                    <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{
                        width: 14, height: 14, borderRadius: 2, flexShrink: 0,
                        background: ch.color, border: '1px solid #CBD5E1',
                      }} />
                      <span style={{ fontSize: 10, color: '#475569', flex: 1 }}>区画 {i + 1}</span>
                      <ColorInput value={ch.color}
                        onChange={e => {
                          const key = chamberStableKey(ch);
                          updatePanel(activePanel.id, {
                            chamberColorMap: { ...(activePanel.chamberColorMap || {}), [key]: e.target.value },
                          });
                        }}
                        style={{ width: 36, height: 20, padding: 1, border: '1px solid #CBD5E1', borderRadius: 2, cursor: 'pointer' }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <PanelPropForm panel={activePanel} updatePanel={updatePanel} disabled={locked} />
            </Collapsible>
          </div>

          {/* === 盤内機器 === */}
          <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
            <Collapsible title={`盤内機器${(activePanel.placedIcons || []).length > 0 ? ` (${(activePanel.placedIcons || []).length})` : ''}`} storageKey="wanol_sec_icons">
              <div
                draggable
                onDragStart={e => e.dataTransfer.setData('application/panel-icon',
                  JSON.stringify({ entityType: 'breaker' }))}
                style={{
                  padding: '3px 8px', background: '#DBEAFE', border: '1px dashed #3B82F6',
                  borderRadius: 4, cursor: 'grab', userSelect: 'none',
                  fontSize: 10, marginBottom: 4, textAlign: 'center',
                }}
              >⊕ 機器をドラッグして3D面へ配置</div>
              {chambers.length > 0 && (activePanel.placedIcons || []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {/* 全機器 / チェック選択 一括色変更ヘッダー */}
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2, flexWrap:'wrap' }}>
                    <input type="checkbox"
                      style={{ width:12, height:12, cursor:'pointer', accentColor:'#7C3AED' }}
                      title="全機器を選択/解除"
                      checked={selectedIconIds.size === (activePanel.placedIcons || []).length && (activePanel.placedIcons || []).length > 0}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedIconIds(new Set((activePanel.placedIcons || []).map(x => x.id)));
                        else setSelectedIconIds(new Set());
                      }}
                    />
                    <span style={{ fontSize:9, color:'#94A3B8' }}>全機器:</span>
                    <ColorInput defaultValue="#1D4ED8"
                      style={{ width:24, height:14, padding:0, border:'none', cursor:'pointer', borderRadius:2 }}
                      onChange={(e) => {
                        const col = e.target.value;
                        updatePanel(activePanel.id, {
                          placedIcons: (activePanel.placedIcons || []).map(x => ({ ...x, iconColor: col })),
                        });
                      }}
                      title="全機器の色を一括変更"
                    />
                    {selectedIconIds.size > 0 && (
                      <>
                        <span style={{ fontSize:9, color:'#7C3AED', fontWeight:700 }}>✓{selectedIconIds.size}件:</span>
                        <ColorInput defaultValue="#1D4ED8"
                          style={{ width:24, height:14, padding:0, border:'none', cursor:'pointer', borderRadius:2, outline:'2px solid #7C3AED' }}
                          onChange={(e) => {
                            const col = e.target.value;
                            updatePanel(activePanel.id, {
                              placedIcons: (activePanel.placedIcons || []).map(x => selectedIconIds.has(x.id) ? { ...x, iconColor: col } : x),
                            });
                          }}
                          title="チェックした機器の色を一括変更"
                        />
                      </>
                    )}
                  </div>
                  {chambers.map((ch, i) => {
                    const key = chamberStableKey(ch);
                    const icons = (activePanel.placedIcons || []).filter(ic => ic.chamberKey === key);
                    if (!icons.length) return null;
                    const N = icons.length;
                    const layoutOpts = N === 2
                      ? [['h','横2'],['v','縦2']]
                      : N === 3
                      ? [['h','横3'],['v','縦3'],['t1b2','上1下2'],['t2b1','上2下1']]
                      : N === 4
                      ? [['auto','2×2'],['h','横4'],['v','縦4']]
                      : [['auto',`格子`],['h',`横${N}`],['v',`縦${N}`]];
                    const currentLayout = (activePanel.iconLayouts || {})[key] || 'auto';
                    const isSelectedChamber = icons.some(ic => ic.id === selectedIconId);
                    const allChChecked = icons.length > 0 && icons.every(ic => selectedIconIds.has(ic.id));
                    const someChChecked = icons.some(ic => selectedIconIds.has(ic.id));
                    return (
                      <div key={ch.id}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2,
                          borderRadius: 3, padding: '1px 4px',
                          background: isSelectedChamber ? '#FEF3C7' : 'transparent',
                        }}>
                          <input type="checkbox"
                            style={{ width:11, height:11, cursor:'pointer', accentColor:'#7C3AED', flexShrink:0 }}
                            checked={allChChecked}
                            ref={el => { if (el) el.indeterminate = someChChecked && !allChChecked; }}
                            onChange={(e) => {
                              setSelectedIconIds(prev => {
                                const next = new Set(prev);
                                if (selectedIconId && !next.has(selectedIconId)) next.add(selectedIconId);
                                icons.forEach(ic => e.target.checked ? next.add(ic.id) : next.delete(ic.id));
                                return next;
                              });
                              setSelectedIconId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            title="この区画の機器を全選択/解除"
                          />
                          <span style={{ width: 10, height: 10, borderRadius: 2, flexShrink: 0, background: ch.color, border: '1px solid #CBD5E1' }} />
                          <span style={{ fontSize: 10, color: isSelectedChamber ? '#B45309' : '#475569', fontWeight: 600 }}>区画 {i + 1}</span>
                          <ColorInput
                            defaultValue={icons[0]?.iconColor || '#1D4ED8'}
                            style={{ width:18, height:12, padding:0, border:'none', cursor:'pointer', borderRadius:2, marginLeft:'auto' }}
                            onChange={(e) => {
                              const col = e.target.value;
                              updatePanel(activePanel.id, {
                                placedIcons: (activePanel.placedIcons || []).map(x => icons.some(ic => ic.id === x.id) ? { ...x, iconColor: col } : x),
                              });
                            }}
                            onClick={(e) => e.stopPropagation()}
                            title={`区画${i+1}の全機器を一括色変更`}
                          />
                        </div>
                        {icons.map(ic => {
                          const isSelIcon = ic.id === selectedIconId;
                          const isMultiSel = selectedIconIds.has(ic.id);
                          return (
                          <div key={ic.id}
                            onClick={(e) => {
                              setSelectedIconId(ic.id); setSelectedPartIds([]); setSelectedDoorId(null);
                            }}
                            onMouseEnter={() => { setHoveredIconId(ic.id); setHoverChamberId(ch.id); }}
                            onMouseLeave={() => { setHoveredIconId(null); setHoverChamberId(null); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4, borderRadius: 3,
                              padding: '1px 4px 1px 4px', cursor: 'pointer',
                              background: isMultiSel ? '#EDE9FE' : isSelIcon ? '#FEF3C7' : 'transparent',
                              border: `1px solid ${isMultiSel ? '#7C3AED' : isSelIcon ? '#D97706' : 'transparent'}`,
                            }}>
                            <input type="checkbox"
                              checked={isMultiSel}
                              style={{ width:11, height:11, cursor:'pointer', accentColor:'#7C3AED', flexShrink:0 }}
                              onChange={(e) => {
                                e.stopPropagation();
                                setSelectedIconIds(prev => {
                                  const next = new Set(prev);
                                  if (selectedIconId && !next.has(selectedIconId)) next.add(selectedIconId);
                                  if (e.target.checked) next.add(ic.id); else next.delete(ic.id);
                                  return next;
                                });
                                setSelectedIconId(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            {editingIconNameId === ic.id ? (
                              <input
                                autoFocus
                                ref={_editingInputRef}
                                defaultValue={ic.name}
                                style={{ fontSize: 10, flex: 1, border: '1px solid #7C3AED', borderRadius: 2, padding: '0 2px', outline: 'none', minWidth: 0 }}
                                onBlur={(e) => {
                                  const newName = e.target.value.trim();
                                  if (newName && newName !== ic.name) {
                                    updatePanel(activePanel.id, {
                                      placedIcons: (activePanel.placedIcons || []).map(x => x.id === ic.id ? { ...x, name: newName } : x),
                                    }, { forceNew: true });
                                  }
                                  setEditingIconNameId(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.target.blur();
                                  if (e.key === 'Escape') { setEditingIconNameId(null); }
                                  e.stopPropagation();
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span
                                style={{ fontSize: 10, color: isMultiSel ? '#6D28D9' : isSelIcon ? '#B45309' : '#334155', fontWeight: (isSelIcon || isMultiSel) ? 700 : 400, flex: 1, cursor: 'text' }}
                                onDoubleClick={(e) => { e.stopPropagation(); setEditingIconNameId(ic.id); }}
                                title="ダブルクリックで名前を編集"
                              >{ic.name}</span>
                            )}
                            <ColorInput
                              value={ic.iconColor || '#1D4ED8'}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                e.stopPropagation();
                                const col = e.target.value;
                                updatePanel(activePanel.id, {
                                  placedIcons: (activePanel.placedIcons || []).map(x => x.id === ic.id ? { ...x, iconColor: col } : x),
                                });
                              }}
                              style={{ width:20, height:14, padding:0, border:'none', cursor:'pointer', borderRadius:2, flexShrink:0 }}
                              title="このアイコンの色を変更"
                            />
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const modes = ['inherit', 'flat', 'box'];
                                const cur = ic.iconDisplayMode || 'inherit';
                                const next = modes[(modes.indexOf(cur) + 1) % modes.length];
                                updatePanel(activePanel.id, {
                                  placedIcons: (activePanel.placedIcons || []).map(x => x.id === ic.id ? { ...x, iconDisplayMode: next } : x),
                                });
                              }}
                              style={{
                                fontSize: 9, padding: '0 3px', border: 'none', borderRadius: 2, cursor: 'pointer',
                                background: ic.iconDisplayMode === 'box' ? '#7C3AED' : ic.iconDisplayMode === 'flat' ? '#3B82F6' : '#E2E8F0',
                                color: (ic.iconDisplayMode === 'box' || ic.iconDisplayMode === 'flat') ? '#FFF' : '#475569',
                              }}
                              title="個別表示形式切替: 継承→平面→立体"
                            >{ic.iconDisplayMode === 'box' ? '立' : ic.iconDisplayMode === 'flat' ? '平' : '継'}</button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                updatePanel(activePanel.id, {
                                  placedIcons: (activePanel.placedIcons || []).filter(x => x.id !== ic.id),
                                });
                                if (selectedIconId === ic.id) setSelectedIconId(null);
                                setSelectedIconIds(prev => { const next = new Set(prev); next.delete(ic.id); return next; });
                              }}
                              style={{ fontSize: 9, padding: '0 3px', background: '#FEE2E2', border: 'none', borderRadius: 2, cursor: 'pointer', color: '#DC2626' }}
                            >×</button>
                          </div>
                        );})}
                        {layoutOpts.length > 0 && !locked && (
                          <div style={{ paddingLeft: 14, marginTop: 3, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                            {layoutOpts.map(([lk, lbl]) => {
                              const isActive = currentLayout === lk || (lk === 'h' && currentLayout === 'auto' && N === 2);
                              return (
                                <button key={lk}
                                  onClick={() => updatePanel(activePanel.id, {
                                    iconLayouts: { ...(activePanel.iconLayouts || {}), [key]: lk },
                                  })}
                                  style={{
                                    fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer', border: 'none',
                                    background: isActive ? '#3B82F6' : '#E2E8F0',
                                    color: isActive ? '#FFF' : '#475569',
                                    fontWeight: isActive ? 700 : 400,
                                  }}
                                >{lbl}</button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Collapsible>
          </div>

          {/* === 仕切りツリー === */}
          <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
            <Collapsible title={`仕切り (${(activePanel.partitions || []).length})`} storageKey="wanol_sec_partTree">
              <PanelTreePanel
                panel={activePanel}
                selectedId={selectedPartId}
                onSelect={(id) => {
                  setSelectedPartIds(id ? [id] : []);
                  if (id) { setSelectedIconId(null); setSelectedDoorId(null); setSelectedBoxEdge(null); }
                }}
                onAdd={handleAddPartition}
                onDelete={(id) => { deletePartition(activePanel.id, id); setSelectedPartIds(ids => ids.filter(x => x !== id)); }}
                onToggleVirtual={(id) => {
                  const p = (activePanel.partitions || []).find(pt => pt.id === id);
                  if (p) updatePartition(activePanel.id, id, { virtual: !p.virtual });
                }}
                disabled={locked}
                onHover={setHoveredPartId}
              />
              {selectedPartIds.length >= 2 && !locked && (
                <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: '#64748B', whiteSpace: 'nowrap', fontWeight: 600 }}>均等配置</span>
                  <button onClick={handleUniformLayout} style={panelBtnStyle('#8B5CF6')}
                    title="選択した仕切りの両端を固定し、内側を等間隔に並べる">
                    {selectedPartIds.length}枚選択中
                  </button>
                  <button onClick={handleUniformLayoutPanel} style={panelBtnStyle('#0EA5E9')}
                    title="選択した仕切りを親箱の壁-壁間で等間隔に配置（全員移動）">
                    盤内中
                  </button>
                </div>
              )}
            </Collapsible>
          </div>

          {/* === 仕切りプロパティ（選択時のみ） === */}
          {selectedPart && (
            <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
              <Collapsible title="仕切りプロパティ" storageKey="wanol_sec_partProps">
                <PanelPropPanel
                  panel={activePanel}
                  partition={selectedPart}
                  updatePartition={updatePartition}
                  disabled={locked}
                />
              </Collapsible>
            </div>
          )}

          {selectedDoorId && !selectedPart && (() => {
            const selDoor = (activePanel.doors || []).find(d => d.id === selectedDoorId);
            return selDoor ? (
              <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
                <Collapsible title="扉プロパティ" storageKey="wanol_sec_doorProps">
                  <PanelPropPanel
                    panel={activePanel}
                    door={selDoor}
                    updateDoor={updateDoor}
                    disabled={locked}
                  />
                </Collapsible>
              </div>
            ) : null;
          })()}

          {/* === 扉セクション === */}
          <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
            <Collapsible
              title={`扉${(activePanel.doors || []).length > 0 ? ` (${activePanel.doors.length})` : ''}`}
              storageKey="wanol_sec_doors"
            >
            <div style={{ marginBottom: 6, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              {!locked && (
                <button
                  onClick={() => setDoorPlaceMode(doorPlaceMode ? null : 'hover')}
                  style={{
                    ...panelBtnStyle(doorPlaceMode ? '#1D4ED8' : '#3B82F6'),
                    outline: doorPlaceMode ? '2px solid #93C5FD' : 'none',
                    outlineOffset: '1px',
                  }}
                >{doorPlaceMode ? '設置中…（Escでキャンセル）' : '＋ 新規扉'}</button>
              )}
              {!locked && doorPlaceMode && doorPlaceMode !== 'hover' && (() => {
                const faceLabel = { front:'前面', back:'後面', left:'左面', right:'右面', top:'上面', bottom:'下面' }[doorPlaceMode] || doorPlaceMode;
                const { strict } = deriveFaceDoorCandidates(activePanel, doorPlaceMode);
                if (strict.length === 0) return null;
                return (
                  <button
                    onClick={() => {
                      addDoors(activePanel.id, strict.map(r => ({ face: doorPlaceMode, uMm: r.uMm, vMm: r.vMm, widthMm: r.widthMm, heightMm: r.heightMm })));
                      setDoorPlaceMode(null);
                    }}
                    style={{ ...panelBtnStyle('#065F46') }}
                  >{faceLabel}の全区画に扉を作成（{strict.length}個）</button>
                );
              })()}
            </div>
            {(activePanel.doors || []).length === 0 ? (
              <div style={{ fontSize: 10, color: '#94A3B8' }}>（なし）</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {(activePanel.doors || []).map(door => {
                  const faceLabel = { front:'前面', back:'後面', left:'左面', right:'右面', top:'上面', bottom:'下面' }[door.face] || door.face;
                  const isDoorSelected = selectedDoorId === door.id;
                  const doorCh = doorToChamberId(door, chambers, activePanel);
                  return (
                    <div key={door.id}
                      onClick={() => {
                        const newId = isDoorSelected ? null : door.id;
                        setSelectedDoorId(newId);
                        if (newId != null) { setSelectedPartIds([]); setSelectedIconId(null); setSelectedBoxEdge(null); }
                      }}
                      onMouseEnter={() => setHoveredDoorId(door.id)}
                      onMouseLeave={() => setHoveredDoorId(null)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '3px 6px', borderRadius: 4, fontSize: 10,
                        background: isDoorSelected ? '#FEF3C7' : '#F8FAFC',
                        border: `1px solid ${isDoorSelected ? '#D97706' : '#E2E8F0'}`,
                        cursor: 'pointer',
                      }}>
                      <span style={{ fontSize: 10 }}>🚪</span>
                      {doorCh ? (
                        <span style={{
                          display: 'inline-block', width: 8, height: 8, borderRadius: 2,
                          background: doorCh.color, flexShrink: 0,
                        }} title={`区画: ${doorCh.id}`} />
                      ) : (
                        <span style={{ display: 'inline-block', width: 8, height: 8, flexShrink: 0 }} />
                      )}
                      <span style={{ flex: 1, color: isDoorSelected ? '#B45309' : '#334155', fontWeight: isDoorSelected ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {faceLabel} {Math.round(door.widthMm)}×{Math.round(door.heightMm)}
                      </span>
                      {!locked && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); updateDoor(activePanel.id, door.id, { hingeSide: door.hingeSide === 'right' ? 'left' : 'right' }); }}
                            title={`ヒンジ切替（現在: ${door.hingeSide === 'right' ? '右' : '左'}）`}
                            style={{ ...panelBtnStyle('#64748B'), padding: '4px 8px', lineHeight: 0, display:'inline-flex', alignItems:'center' }}
                          ><HingeSvg side={door.hingeSide || 'left'}/></button>
                          <button
                            onClick={(e) => { e.stopPropagation(); updateDoor(activePanel.id, door.id, { isOpen: !door.isOpen }, { forceNew: true }); }}
                            style={panelBtnStyle(door.isOpen ? '#10B981' : '#6B7280')}
                          >{door.isOpen ? '開' : '閉'}</button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteDoor(activePanel.id, door.id); }}
                            style={{ ...panelBtnStyle('#EF4444'), padding: '1px 5px' }}
                          >×</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </Collapsible>
          </div>

          {/* === ケーブルセクション === */}
          <div style={{ padding: 8, borderBottom: '1px solid #E2E8F0' }}>
            <Collapsible
              title={`配線${(activePanel.cables || []).length > 0 ? ` (${(activePanel.cables || []).length})` : ''}`}
              storageKey="wanol_sec_cables"
            >
            {/* 配置編集モード中のステータスバー */}
            {cableEditMode && !cableAddMode && (
              <div style={{ background: '#1E3A5F', borderRadius: 4, padding: '6px 8px', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#60A5FA', fontWeight: 'bold' }}>
                  {cableEditMode.selectedWpIdx == null
                    ? '配置編集: 移動したい経由点の○をクリック'
                    : `経由点${cableEditMode.selectedWpIdx + 1}を選択中 → 移動先の区画をクリック`}
                </span>
                <button onClick={() => { setCableEditMode(null); setCableForm(null); }}
                  style={{ fontSize: 10, padding: '2px 6px', background: '#374151', border: '1px solid #4B5563', borderRadius: 3, cursor: 'pointer', color: '#E5E7EB', flexShrink: 0 }}>
                  完了
                </button>
              </div>
            )}
            {/* ルーティングモード中の設定バー */}
            {cableAddMode ? (
              <div style={{ background: '#1E3A5F', borderRadius: 4, padding: '6px 8px', marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: '#F59E0B', fontWeight: 'bold' }}>
                  {cableAddMode.step === 'from' ? '① 始点：アイコンまたは区画をクリック' : `② 区画クリック=経由点追加 / 別アイコンクリック=終点確定 / Enter=確定 (経由${(cableAddMode.waypoints||[]).length}点)`}
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <ColorInput value={cableAddMode.color}
                    onChange={e => setCableAddMode(m => ({ ...m, color: e.target.value }))}
                    style={{ width: 26, height: 18, padding: 0, border: 'none', cursor: 'pointer', borderRadius: 2, flexShrink: 0 }} />
                  <input type="number" value={cableAddMode.thickness} min={1} max={10}
                    onChange={e => setCableAddMode(m => ({ ...m, thickness: Number(e.target.value) }))}
                    style={{ width: 32, padding: '1px 3px', fontSize: 10, border: '1px solid #334155', borderRadius: 3, background: '#0F172A', color: '#E2E8F0', flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: '#94A3B8', flexShrink: 0 }}>px</span>
                  <input type="text" value={cableAddMode.label}
                    onChange={e => setCableAddMode(m => ({ ...m, label: e.target.value }))}
                    placeholder="ラベル" maxLength={20}
                    style={{ flex: 1, minWidth: 0, padding: '1px 4px', fontSize: 10, border: '1px solid #334155', borderRadius: 3, background: '#0F172A', color: '#E2E8F0' }} />
                  <button onClick={() => setCableAddMode(null)}
                    style={{ fontSize: 10, padding: '2px 5px', background: '#374151', border: '1px solid #4B5563', borderRadius: 3, cursor: 'pointer', color: '#E5E7EB', flexShrink: 0 }}>
                    Esc
                  </button>
                </div>
              </div>
            ) : !locked && (
              <button onClick={() => setCableAddMode({ step: 'from', waypoints: [], color: '#60A5FA', thickness: 3, label: '' })}
                style={{ ...panelBtnStyle('#3B82F6'), marginBottom: 6 }}>
                ＋ 配線追加
              </button>
            )}
            {/* 編集フォーム（既存ケーブルの色・ラベル変更用） */}
            {cableForm && (
              <div style={{ background: '#F1F5F9', borderRadius: 4, padding: 8, marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 10, color: '#64748B', marginBottom: 2 }}>配線編集</div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: '#64748B', width: 36, flexShrink: 0 }}>ラベル</span>
                  <input type="text" value={cableForm.label || ''}
                    onChange={e => setCableForm(f => ({ ...f, label: e.target.value }))}
                    placeholder="CV5.5×3C" maxLength={20}
                    style={{ flex: 1, padding: '2px 4px', fontSize: 11, border: '1px solid #CBD5E1', borderRadius: 3 }} />
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: '#64748B', width: 36, flexShrink: 0 }}>枠線色</span>
                  <ColorInput value={cableForm.color || '#60A5FA'}
                    onChange={e => setCableForm(f => ({ ...f, color: e.target.value }))}
                    style={{ width: 32, height: 22, padding: 0, border: 'none', cursor: 'pointer' }} />
                  <span style={{ fontSize: 10, color: '#64748B', marginLeft: 4 }}>線色</span>
                  <ColorInput value={cableForm.lineColor || '#000000'}
                    onChange={e => setCableForm(f => ({ ...f, lineColor: e.target.value }))}
                    style={{ width: 32, height: 22, padding: 0, border: 'none', cursor: 'pointer' }} />
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: '#64748B', width: 36, flexShrink: 0 }}>線幅</span>
                  <input type="number" value={cableForm.thickness || 3} min={1} max={20}
                    onChange={e => setCableForm(f => ({ ...f, thickness: Number(e.target.value) }))}
                    style={{ width: 36, padding: '2px 4px', fontSize: 11, border: '1px solid #CBD5E1', borderRadius: 3 }} />
                  <span style={{ fontSize: 10, color: '#64748B', marginLeft: 4 }}>枠線幅</span>
                  <input type="number" value={cableForm.outlineThickness ?? 4} min={0} max={20}
                    onChange={e => setCableForm(f => ({ ...f, outlineThickness: Number(e.target.value) }))}
                    style={{ width: 36, padding: '2px 4px', fontSize: 11, border: '1px solid #CBD5E1', borderRadius: 3 }} />
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => {
                    const _patch = { label: cableForm.label, color: cableForm.color, lineColor: cableForm.lineColor, thickness: cableForm.thickness, outlineThickness: cableForm.outlineThickness ?? 4 };
                    updateCable(activePanel.id, cableForm._editId, _patch);
                    setCableForm(null);
                  }} style={{ ...panelBtnStyle('#10B981'), flex: 1 }}>保存</button>
                  {cableForm._wiresetId && (
                    <button onClick={() => {
                      const _patch = { color: cableForm.color, lineColor: cableForm.lineColor, thickness: cableForm.thickness, outlineThickness: cableForm.outlineThickness ?? 4 };
                      (activePanel.cables || []).filter(c => c.wiresetId === cableForm._wiresetId).forEach(c => updateCable(activePanel.id, c.id, _patch));
                      setCableForm(null);
                    }} style={{ ...panelBtnStyle('#7C3AED'), flex: 1 }}>Wireセット一括</button>
                  )}
                  <button onClick={() => setCableForm(null)} style={{ ...panelBtnStyle('#64748B'), flex: 1 }}>キャンセル</button>
                </div>
              </div>
            )}
            {/* ケーブル一覧（WireSetグループ対応） */}
            {(activePanel.cables || []).length > 0 && (() => {
              const _cables = activePanel.cables || [];
              const _wsMap = new Map();
              const _singles = [];
              _cables.forEach(c => {
                if (c.wiresetId) {
                  if (!_wsMap.has(c.wiresetId)) _wsMap.set(c.wiresetId, []);
                  _wsMap.get(c.wiresetId).push(c);
                } else { _singles.push(c); }
              });
              const _renderRow = (cable, label, indented, showRouteEdit) => {
                const fromIc = (activePanel.placedIcons || []).find(ic => ic.id === cable.fromIconId);
                const toIc = (activePanel.placedIcons || []).find(ic => ic.id === cable.toIconId);
                return (
                  <div key={cable.id}
                    onMouseEnter={() => setHoveredCableId(cable.id)}
                    onMouseLeave={() => setHoveredCableId(null)}
                    onClick={() => setSelectedCableId(prev => prev === cable.id ? null : cable.id)}
                    style={{ padding: '3px 5px', borderRadius: 4, cursor: 'pointer',
                      border: `1px solid ${selectedCableId === cable.id ? '#F97316' : hoveredCableId === cable.id ? '#FBBF24' : '#E2E8F0'}`,
                      background: selectedCableId === cable.id ? '#FFF7ED' : hoveredCableId === cable.id ? '#FFFBEB' : '#F8FAFC',
                      display: 'flex', alignItems: 'center', gap: 4, marginLeft: indented ? 10 : 0 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: cable.color || '#60A5FA', border: `2px solid ${cable.lineColor || '#000000'}`, flexShrink: 0, boxSizing: 'border-box' }} />
                    <span style={{ fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {label}{(fromIc || toIc) ? ` (${fromIc?.name || '?'}→${toIc?.name || '?'})` : ''}
                    </span>
                    {!locked && (<>
                      {showRouteEdit ? (
                        <button onClick={() => { setCableEditMode({ cableId: cable.id, selectedWpIdx: null }); setCableForm({ ...cable, _editId: cable.id, _wiresetId: cable.wiresetId || null }); }}
                          style={{ fontSize: 13, padding: '0px 4px', background: cableEditMode?.cableId === cable.id ? '#DBEAFE' : '#F1F5F9', border: `1px solid ${cableEditMode?.cableId === cable.id ? '#3B82F6' : '#CBD5E1'}`, borderRadius: 3, cursor: 'pointer', lineHeight: 1 }}>✏</button>
                      ) : (
                        <button onClick={() => { setCableForm({ ...cable, _editId: cable.id, _wiresetId: cable.wiresetId || null }); }}
                          style={{ fontSize: 13, padding: '0px 4px', background: cableForm?._editId === cable.id ? '#DBEAFE' : '#F1F5F9', border: `1px solid ${cableForm?._editId === cable.id ? '#3B82F6' : '#CBD5E1'}`, borderRadius: 3, cursor: 'pointer', lineHeight: 1 }}>✏</button>
                      )}
                      <button onClick={() => {
                        deleteCable(activePanel.id, cable.id);
                        if (selectedCableId === cable.id) setSelectedCableId(null);
                        if (hoveredCableId === cable.id) setHoveredCableId(null);
                      }}
                        style={{ fontSize: 10, padding: '1px 5px', background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 3, cursor: 'pointer', color: '#EF4444' }}>×</button>
                    </>)}
                  </div>
                );
              };
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {_singles.map((c, ci) => _renderRow(c, c.label || `配線${ci + 1}`, false, true))}
                  {[..._wsMap.entries()].map(([wsId, wsCables], wi) => {
                    const bus = wsCables[0];
                    const taps = wsCables.slice(1);
                    return (
                      <div key={wsId} style={{ border: '1px solid #BFDBFE', borderRadius: 4, background: '#EFF6FF', padding: '3px 4px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ fontSize: 10, color: '#1D4ED8', fontWeight: 'bold', marginBottom: 2 }}>
                          Wireセット {wi + 1}（母線＋{taps.length}タップ）
                        </div>
                        {_renderRow(bus, `母線: ${bus.label || '無題'}`, false, true)}
                        {taps.map((tap, ti) => _renderRow(tap, `タップ${ti + 1}${tap.label ? ': ' + tap.label : ''}`, true, true))}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            </Collapsible>
          </div>

        </>)}

        {!activePanel && (
          <div style={{ padding: 12, fontSize: 11, color: '#94A3B8' }}>
            「＋新規」でパネルを作成するか、リストから選択してください
          </div>
        )}
      </div>

      {/* ── 右エリア: 3Dキャンバス（展開図オーバーレイ含む） ── */}
      <div ref={canvContainerRef}
        style={{ flex: 1, background: '#1E293B', overflow: 'hidden', position: 'relative' }}>
        {activePanel ? (
          <PanelCanvas3D
            panel={activePanel}
            camera={camera}
            setCamera={setCamera}
            width={canvSize.w}
            height={canvSize.h}
            selectedPartitionIds={selectedPartIds}
            onSelectPartitions={(ids, isCtrl) => {
              setSelectedPartIds(ids);
              if (ids.length > 0 && !isCtrl) { setSelectedIconId(null); setSelectedDoorId(null); setSelectedBoxEdge(null); }
            }}
            updatePartition={updatePartition}
            addPartition={addPartition}
            updatePanel={updatePanel}
            doors={activePanel.doors || []}
            doorsVisible={doorsVisible}
            addDoor={addDoor}
            updateDoor={updateDoor}
            doorPlaceMode={doorPlaceMode}
            onSetDoorPlaceMode={setDoorPlaceMode}
            selectedDoorId={selectedDoorId}
            onSelectDoor={(id) => {
              setSelectedDoorId(id);
              if (id != null) { setSelectedPartIds([]); setSelectedIconId(null); setSelectedBoxEdge(null); }
            }}
            onSelectEdge={(edge) => {
              setSelectedBoxEdge(edge);
              if (edge != null) { setSelectedPartIds([]); setSelectedIconId(null); setSelectedDoorId(null); }
            }}
            showChamberColors={showChamberColors}
            hoverChamberId={hoverChamberId}
            hoveredPartitionId={hoveredPartId}
            hoveredDoorId={hoveredDoorId}
            hoveredIconId={hoveredIconId}
            hoveredCableId={hoveredCableId}
            selectedCableId={selectedCableId}
            cablesVisible={cablesVisible}
            dragResolution={dragResolution}
            dragRestoreDelay={dragRestoreDelay}
            onDeletePartitions={(ids) => {
              ids.forEach(id => deletePartition(activePanel.id, id));
              setSelectedPartIds([]);
            }}
            beginMerge={beginMerge}
            endMerge={endMerge}
            onCableClick={(id) => {
              setSelectedCableId(id);
              if (id != null) {
                setSelectedIconId(null); setSelectedIconIds(new Set()); setSelectedPartIds([]); setSelectedDoorId(null);
                const _c = (activePanel?.cables || []).find(c => c.id === id);
                if (_c) {
                  setCableEditMode({ cableId: id, selectedWpIdx: null });
                  setCableForm({ ..._c, _editId: id, _wiresetId: _c.wiresetId || null });
                }
              } else {
                setCableEditMode(null);
                setCableForm(null);
              }
            }}
            onHoverChamber={setHoverChamberId}
            selectedIconId={selectedIconId}
            selectedIconIds={selectedIconIds}
            onSelectIcon={(id) => {
              setSelectedIconId(id);
              if (id != null) { setSelectedPartIds([]); setSelectedDoorId(null); setSelectedBoxEdge(null); setSelectedCableId(null); }
            }}
            onToggleIconCheck={(id) => {
              setSelectedIconIds(prev => {
                const next = new Set(prev);
                // 単体選択中のアイコンがあればチェックセットに移す
                if (selectedIconId && !next.has(selectedIconId)) next.add(selectedIconId);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              });
              // 単体選択（区画ハイライト）を解除
              setSelectedIconId(null);
            }}
iconVisMode={iconVisMode}
            iconLayouts={activePanel.iconLayouts || {}}
            onDropIcon={(chamberId, chamberKey, wx, wy, wz, iconData) => {
              const _unitN = (activePanel.placedIcons || []).length + 1;
              const newIcon = { id: 'icon_' + Date.now(), name: '機器' + _unitN, chamberKey, wx, wy, wz, ...iconData };
              let updated = [...(activePanel.placedIcons || []), newIcon];
              // 同区画に2個以上あれば全員に A,B,C... ラベルを付与（イミュータブルな新オブジェクトで）
              const chamberIconIds = new Set(
                updated.filter(ic => ic.chamberKey === chamberKey).map(ic => ic.id)
              );
              if (chamberIconIds.size >= 2) {
                let counter = 0;
                updated = updated.map(ic =>
                  chamberIconIds.has(ic.id)
                    ? { ...ic, name: String.fromCharCode(65 + counter++) }
                    : ic
                );
              }
              updatePanel(activePanel.id, { placedIcons: updated }, { forceNew: true });
            }}
            onMoveIcon={(iconId, chamberId, chamberKey, wx, wy, wz, cellBox, face) => {
              updatePanel(activePanel.id, {
                placedIcons: (activePanel.placedIcons || []).map(ic =>
                  ic.id === iconId ? { ...ic, chamberKey, wx, wy, wz, cellBox, face } : ic
                ),
              }); // canvas drag内 → beginMerge/endMergeでカバー済み
            }}
            onReorderIcon={(reorderedIds) => {
              // reorderedIds: 並び替え後の icon.id の順序配列
              if (!reorderedIds?.length) return;
              const idSet = new Set(reorderedIds);
              const byId = Object.fromEntries((activePanel.placedIcons || []).map(ic => [ic.id, ic]));
              const reorderedIcons = reorderedIds.map(id => byId[id]).filter(Boolean);
              if (reorderedIcons.length !== reorderedIds.length) return; // ID不整合なら中断
              let ri = 0;
              const newIcons = (activePanel.placedIcons || []).map(ic =>
                idSet.has(ic.id) ? reorderedIcons[ri++] : ic
              );
              updatePanel(activePanel.id, { placedIcons: newIcons }, { forceNew: true });
            }}
            cables={activePanel.cables || []}
            cableAddMode={cableAddMode}
            onCablePoint={handleCablePoint}
            cableEditMode={cableEditMode}
            onCableWpClick={handleCableWpClick}
            onCableWpMove={handleCableWpMove}
            onNewTap={handleNewTap}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: '#475569', fontSize: 13,
          }}>
            「＋新規」でパネルを作成するか、リストから選択してください
          </div>
        )}

        {/* 展開図オーバーレイ（ドラッグ移動・ホイールズーム可能） */}
        {activePanel && (
          <PanelSliceViews
            panel={activePanel}
            selectedPartitionId={selectedPartId}
            onSelect={(id) => setSelectedPartIds(id ? [id] : [])}
            updatePartition={updatePartition}
            disabled={locked}
            highlightedFace={typeof doorPlaceMode === 'string' && doorPlaceMode !== 'hover' ? doorPlaceMode : null}
            highlightedEdge={selectedBoxEdge}
            showChamberColors={showChamberColors}
            selectedIconId={selectedIconId}
            selectedIconIds={selectedIconIds}
            selectedDoorId={selectedDoorId}
            hoveredPartitionId={hoveredPartId}
            hoveredDoorId={hoveredDoorId}
            hoveredIconId={hoveredIconId}
            hoveredCableId={hoveredCableId}
            selectedCableId={selectedCableId}
          />
        )}
      </div>
    </div>
  );
}

// ── マンセル → Hex 変換（CIE Lab 経由・近似計算）──────────────
// HVC: 色相("5Y"/"10YR"/"N" 等), 明度 0–10, 彩度 0–20
function munsellToHex(hueStr, value, chroma) {
  const v = Math.max(0, Math.min(10, +value || 0));
  const c = Math.max(0, +chroma || 0);
  // 無彩色
  if (!hueStr || hueStr.trim().toUpperCase() === 'N' || c === 0) {
    const L = Math.round(v / 10 * 255);
    const h2 = L.toString(16).padStart(2, '0');
    return `#${h2}${h2}${h2}`;
  }
  const m = hueStr.trim().match(/^([0-9.]+)\s*([A-Z]+)$/i);
  if (!m) return '#888888';
  const hn = parseFloat(m[1]);
  const hl = m[2].toUpperCase();
  const HUE_START = { R:0, YR:36, Y:72, GY:108, G:144, BG:180, B:216, PB:252, P:288, RP:324 };
  if (!(hl in HUE_START)) return '#888888';
  const rad = (HUE_START[hl] + (hn / 10) * 36) * Math.PI / 180;
  // V → L*
  const Y = Math.pow(v / 10, 2.2) * 100;
  const Ls = v === 0 ? 0 : 116 * Math.cbrt(Y / 100) - 16;
  // C → a*, b* (スケール係数 6 ≒ 彩度10が中程度の鮮やかさ)
  const S = 6;
  const as = c * S * Math.cos(rad), bs = c * S * Math.sin(rad);
  // Lab → XYZ (D65)
  const fy = (Ls + 16) / 116;
  const f2 = (t) => t > 6/29 ? t*t*t : 3*(6/29)*(6/29)*(t - 4/29);
  const X = 0.95047 * f2(as/500 + fy);
  const Yy = 1.00000 * f2(fy);
  const Z = 1.08883 * f2(fy - bs/200);
  // XYZ → sRGB with gamma
  const gam = (t) => {
    if (t <= 0) return 0; if (t >= 1) return 255;
    return Math.round((t <= 0.0031308 ? 12.92*t : 1.055*Math.pow(t,1/2.4)-0.055) * 255);
  };
  const r = gam( 3.2406*X - 1.5372*Yy - 0.4986*Z);
  const g = gam(-0.9689*X + 1.8758*Yy + 0.0415*Z);
  const b = gam( 0.0557*X - 0.2040*Yy + 1.0570*Z);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// マンセルカラーテーブル（色相ファミリー→ステップの2段選択 + 明度×彩度グリッド）
function MunsellTable({ onChange, disabled }) {
  const FAMILIES = ['N', 'R', 'YR', 'Y', 'GY', 'G', 'BG', 'B', 'PB', 'P', 'RP'];
  const STEPS = [2.5, 5, 7.5, 10];
  const VALUES = [8, 7, 6, 5, 4, 3, 2];
  const CHROMAS = [0, 2, 4, 6, 8, 10, 12];
  const [selFamily, setSelFamily] = useState('Y');
  const [selStep, setSelStep] = useState(5);
  const selHue = selFamily === 'N' ? 'N' : `${selStep}${selFamily}`;
  const btnBase = { padding: '1px 5px', fontSize: 9, borderRadius: 2, lineHeight: 1.5, border: 'none', cursor: 'pointer' };
  return (
    <div style={{ fontSize: 9, userSelect: 'none' }}>
      {/* 色相ファミリー＋ステップを1行に統合 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 3, alignItems: 'center' }}>
        {FAMILIES.map(fam => (
          <button key={fam} onClick={() => setSelFamily(fam)}
            style={{ ...btnBase, fontWeight: selFamily === fam ? 700 : 400,
              background: selFamily === fam ? '#3B82F6' : '#E2E8F0',
              color: selFamily === fam ? '#FFF' : '#334155' }}>
            {fam}
          </button>
        ))}
        {selFamily !== 'N' && (<>
          <span style={{ color: '#CBD5E1', fontSize: 8, margin: '0 1px' }}>|</span>
          {STEPS.map(s => (
            <button key={s} onClick={() => setSelStep(s)}
              style={{ ...btnBase, fontWeight: selStep === s ? 700 : 400,
                background: selStep === s ? '#0EA5E9' : '#E2E8F0',
                color: selStep === s ? '#FFF' : '#334155' }}>
              {s}
            </button>
          ))}
          <span style={{ fontSize: 8, color: '#94A3B8', marginLeft: 1 }}>{selHue}</span>
        </>)}
      </div>
      {/* 彩度ヘッダ */}
      <div style={{ display: 'flex', gap: 1, marginBottom: 1, paddingLeft: 16 }}>
        {CHROMAS.map(c => (
          <div key={c} style={{ width: 20, textAlign: 'center', color: '#94A3B8', fontSize: 8 }}>
            {c === 0 ? 'N' : c}
          </div>
        ))}
      </div>
      {/* 明度×彩度グリッド */}
      {VALUES.map(v => (
        <div key={v} style={{ display: 'flex', gap: 1, marginBottom: 1, alignItems: 'center' }}>
          <div style={{ width: 14, textAlign: 'right', paddingRight: 2, color: '#94A3B8', fontSize: 8, flexShrink: 0 }}>{v}</div>
          {CHROMAS.map(c => {
            const hex = munsellToHex(selHue, v, c);
            return (
              <div key={c} onClick={() => !disabled && onChange(hex)}
                style={{
                  width: 20, height: 16, background: hex, flexShrink: 0,
                  border: '1px solid rgba(0,0,0,0.12)', borderRadius: 1,
                  cursor: disabled ? 'default' : 'pointer',
                }}
                title={`${selHue} ${v}/${c}　${hex}`}
              />
            );
          })}
        </div>
      ))}
      <div style={{ fontSize: 8, color: '#94A3B8', marginTop: 2 }}>明度(行: 8→2)　彩度(列: N→12)</div>
    </div>
  );
}

// パネルプロパティフォーム
function PanelPropForm({ panel, updatePanel, disabled }) {
  const numInput = (label, field, unit) => (
    <div style={{ marginBottom: 5 }}>
      <label style={{ fontSize: 10, color: '#64748B', display: 'block', marginBottom: 2 }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="number" value={panel[field] ?? ''} disabled={disabled}
          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) updatePanel(panel.id, { [field]: v }); }}
          style={{ flex: 1, padding: '3px 6px', fontSize: 12, border: '1px solid #CBD5E1', borderRadius: 4, background: disabled ? '#F1F5F9' : '#FFF' }} />
        {unit && <span style={{ fontSize: 10, color: '#94A3B8' }}>{unit}</span>}
      </div>
    </div>
  );
  return (
    <div>
      <div style={{ marginBottom: 5 }}>
        <label style={{ fontSize: 10, color: '#64748B', display: 'block', marginBottom: 2 }}>名前</label>
        <input type="text" value={panel.name || ''} disabled={disabled}
          onChange={e => updatePanel(panel.id, { name: e.target.value })}
          style={{ width: '100%', padding: '3px 6px', fontSize: 12, border: '1px solid #CBD5E1', borderRadius: 4, background: disabled ? '#F1F5F9' : '#FFF' }} />
      </div>
      {numInput('幅', 'widthMm', 'mm')}
      {numInput('高さ', 'heightMm', 'mm')}
      {numInput('奥行き', 'depthMm', 'mm')}
      <div style={{ marginBottom: 5 }}>
        <Collapsible title="色（16進数）" storageKey="wanol_sec_hexColor" defaultOpen={false}>
          <ColorInput value={panel.color || '#4A90D9'} disabled={disabled}
            onChange={e => updatePanel(panel.id, { color: e.target.value })}
            style={{ width: '100%', height: 28, border: '1px solid #CBD5E1', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', padding: 2, marginTop: 4 }} />
        </Collapsible>
      </div>
      <div style={{ marginBottom: 5 }}>
        <Collapsible title="色（マンセル）" storageKey="wanol_sec_munsellColor" defaultOpen={false}>
          <MunsellTable onChange={c => updatePanel(panel.id, { color: c })} disabled={disabled} />
        </Collapsible>
      </div>
      <div style={{ padding: '4px 6px', background: '#EFF6FF', borderRadius: 4, fontSize: 10, color: '#1E40AF' }}>
        {panel.widthMm}mm × {panel.heightMm}mm × {panel.depthMm}mm
      </div>
    </div>
  );
}

// 共通ボタンスタイル
function panelBtnStyle(bg) {
  return {
    background: bg, color: '#FFF', border: 'none', borderRadius: 4,
    padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600, lineHeight: 1.4,
  };
}

// 折りたたみセクション
function Collapsible({ title, children, defaultOpen = true, storageKey }) {
  const [open, setOpen] = React.useState(() => {
    if (storageKey) {
      const s = localStorage.getItem(storageKey);
      if (s !== null) return s !== 'false';
    }
    return defaultOpen;
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (storageKey) localStorage.setItem(storageKey, next);
  };
  return (
    <div>
      <div onClick={toggle} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: 'pointer', userSelect: 'none',
        fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: open ? 6 : 0,
      }}>
        <span>{title}</span>
        <span style={{
          color: '#DC2626', fontSize: 9, display: 'inline-block',
          transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 0.15s',
        }}>▼</span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

// ヒンジアイコン（等角投影ボックス + 開扉パネル）
// 左ヒンジ: 右斜め上から見た箱・左辺から扉が手前左に開く
// 右ヒンジ: 左右反転して右辺から扉が手前右に開く
function HingeSvg({ side }) {
  const L = side !== 'right';
  // 箱は常に同じ等角投影。扉ポリゴンのみ左右で切り替わる。
  // 左ヒンジ: 左辺(12,6-21)を軸に左前方へ開く → (4,9)-(4,24)
  // 右ヒンジ: 右辺(28,6-21)を軸に右前方へ開く → (36,9)-(36,24)
  const doorPts = L ? "12,6 12,21 4,24 4,9" : "28,6 28,21 36,24 36,9";
  return (
    <svg width="22" height="15" viewBox="0 0 40 28" style={{ display:'block' }}>
      {/* 箱（常に固定）*/}
      <polygon points="12,6 28,6 33,2 17,2"
        fill="rgba(255,255,255,0.22)" stroke="currentColor" strokeWidth="1.3"/>
      <polygon points="28,6 33,2 33,17 28,21"
        fill="rgba(255,255,255,0.12)" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="12" y="6" width="16" height="15"
        fill="rgba(255,255,255,0.05)" stroke="currentColor" strokeWidth="1.3"/>
      {/* 扉（左右で位置が変わる）*/}
      <polygon points={doorPts}
        fill="rgba(96,165,250,0.72)" stroke="#60A5FA" strokeWidth="1.3"/>
    </svg>
  );
}
