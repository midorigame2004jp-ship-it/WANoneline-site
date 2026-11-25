// ================================================================
// PanelSliceViews.jsx — 配電盤 6面展開図（ドラッグ移動・ホイールズーム対応オーバーレイ）
// position:relative なコンテナ内で position:absolute として表示
// 面セルのみ描画、背景は透明（3Dビューが透けて見える）
// ================================================================

function PanelSliceViews({ panel, selectedPartitionId, onSelect, updatePartition, disabled, highlightedFace = null, highlightedEdge = null, showVirtual = true, showChamberColors = true, selectedIconId = null, selectedIconIds = null, selectedDoorId = null, hoveredPartitionId = null, hoveredDoorId = null, hoveredIconId = null }) {
  if (!panel) return null;

  const { widthMm: W, heightMm: H, depthMm: D } = panel;

  // Chamber自動検出（仕切り構成が変わったときのみ再計算）
  const chambers = React.useMemo(() => {
    const chs = deriveChambers(panel);
    return applyColorMode(chs, panel.chamberColorMode || 'auto10', panel.chamberColorMap, panel.graph4Colors);
  }, [panel]);
  const overlayRef = useRef(null);
  const svgRef = useRef(null);
  const overlayDragRef = useRef(null);
  const partDragRef = useRef(null);
  const partClickRef = useRef(null); // 未選択仕切りのmousedown記録（mouseupで選択判定）

  // 扉候補ホバーセル（PanelCanvas3D から window イベントで受信）
  const [hoveredCell, setHoveredCell] = useState(null);
  useEffect(() => {
    const handler = (e) => setHoveredCell(e.detail);
    window.addEventListener('panelEditorCellHover', handler);
    return () => window.removeEventListener('panelEditorCellHover', handler);
  }, []);

  // アイコンドラッグ移動プレビュー（PanelCanvas3D から window イベントで受信）
  const [dragPreviewCellBox, setDragPreviewCellBox] = useState(null);
  useEffect(() => {
    const handler = (e) => setDragPreviewCellBox(e.detail?.cellBox ?? null);
    window.addEventListener('panelIconDragPreview', handler);
    return () => window.removeEventListener('panelIconDragPreview', handler);
  }, []);

  // 位置状態: initial=左下隅固定 → ドラッグ後=abs(left/top)
  const [posMode, setPosMode] = useState('initial');
  const [absPos, setAbsPos] = useState({ x: 10, y: 10 });
  const [zoom, setZoom] = useState(1);

  const PAD = 10;
  const TOTAL_W = D + W + D + W;
  const TOTAL_H = D + H + D;
  // 辺インデックスペア(ソート済み文字列) → SVG線分([x1,y1,x2,y2]の配列)
  // 頂点: 0=(0,0,0),1=(W,0,0),2=(W,D,0),3=(0,D,0),4=(0,0,H),5=(W,0,H),6=(W,D,H),7=(0,D,H)
  const EDGE_SVG = {
    '0,1': [[PAD+D, PAD+D+H, PAD+D+W, PAD+D+H]],                                              // front↔bottom
    '4,5': [[PAD+D, PAD+D,   PAD+D+W, PAD+D  ]],                                              // front↔top
    '0,4': [[PAD+D, PAD+D,   PAD+D,   PAD+D+H]],                                              // front↔left
    '1,5': [[PAD+D+W, PAD+D, PAD+D+W, PAD+D+H]],                                              // front↔right
    '2,6': [[PAD+D+W+D, PAD+D, PAD+D+W+D, PAD+D+H]],                                         // right↔back
    '4,7': [[PAD, PAD+D, PAD+D, PAD+D], [PAD+D, PAD, PAD+D, PAD+D]],                         // left-top corner
    '5,6': [[PAD+D+W, PAD+D, PAD+D+W+D, PAD+D], [PAD+D+W, PAD, PAD+D+W, PAD+D]],            // right-top corner
    '0,3': [[PAD, PAD+D+H, PAD+D, PAD+D+H], [PAD+D, PAD+D+H, PAD+D, PAD+D+H+D]],            // left-bottom corner
    '1,2': [[PAD+D+W, PAD+D+H, PAD+D+W+D, PAD+D+H], [PAD+D+W, PAD+D+H, PAD+D+W, PAD+D+H+D]], // right-bottom corner
    '3,7': [[PAD, PAD+D, PAD, PAD+D+H], [PAD+D+W+D+W, PAD+D, PAD+D+W+D+W, PAD+D+H]],        // back-left (外縁)
    '2,3': [[PAD+D+W+D, PAD+D+H, PAD+D+W+D+W, PAD+D+H], [PAD+D, PAD+D+H+D, PAD+D+W, PAD+D+H+D]], // back-bottom
    '6,7': [[PAD+D+W+D, PAD+D, PAD+D+W+D+W, PAD+D], [PAD+D, PAD, PAD+D+W, PAD]],            // back-top
  };
  const activeEdgeKey = highlightedEdge ? [...highlightedEdge].sort((a,b)=>a-b).join(',') : null;
  const activeEdgeSegs = activeEdgeKey ? (EDGE_SVG[activeEdgeKey] || []) : [];
  const VB_W = TOTAL_W + PAD * 2;
  const VB_H = TOTAL_H + PAD * 2;

  const BASE_PX = 180;
  const pxPerMm = zoom * BASE_PX / VB_H;
  const svgPxW = Math.round(VB_W * pxPerMm);
  const svgPxH = Math.round(VB_H * pxPerMm);

  // ホイールズーム: React の passive onWheel を使わず直接 addEventListener
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      setZoom(z => Math.max(0.15, Math.min(12, z * factor)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ウィンドウレベルのマウスハンドラ（ドラッグアウト対応）
  useEffect(() => {
    const onMove = (e) => {
      if (overlayDragRef.current) {
        const { x0, y0, px, py } = overlayDragRef.current;
        setAbsPos({ x: px + e.clientX - x0, y: py + e.clientY - y0 });
      }
      if (partDragRef.current) {
        const { initVal, x0, y0, isVert, flipX, flipY, partId, panelId, sc } = partDragRef.current;
        const dx = e.clientX - x0, dy = e.clientY - y0;
        const delta = isVert ? (flipX ? -dx : dx) / sc : (flipY ? -dy : dy) / sc;
        if (updatePartition) updatePartition(panelId, partId, { posMm: Math.round(initVal + delta) });
      }
    };
    const onUp = (e) => {
      // 未選択仕切りをクリックしてほぼ動かしていなければ選択（mouseup時判定）
      if (partClickRef.current) {
        const { part, x0, y0 } = partClickRef.current;
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) {
          if (onSelect) onSelect(part.id);
        }
        partClickRef.current = null;
      }
      overlayDragRef.current = null;
      partDragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [updatePartition, onSelect]);

  const onTitleMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = overlayRef.current;
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentElement.getBoundingClientRect();
    const curX = rect.left - parentRect.left;
    const curY = rect.top - parentRect.top;
    setAbsPos({ x: curX, y: curY });
    setPosMode('abs');
    overlayDragRef.current = { x0: e.clientX, y0: e.clientY, px: curX, py: curY };
  };

  const startPartDrag = (e, part, ln) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    // 選択済み仕切りのドラッグ開始専用（未選択仕切りからは呼ばれない）
    partDragRef.current = {
      partId: part.id, panelId: panel.id,
      initVal: part.posMm ?? 0,
      x0: e.clientX, y0: e.clientY,
      isVert: ln.isVert, flipX: ln.flipX, flipY: ln.flipY,
      sc: pxPerMm,
    };
  };

  const FACES = [
    {
      id: 'front', label: '前面',
      ox: PAD + D, oy: PAD + D, fW: W, fH: H,
      getLines: (p) => {
        if (p.type !== 'axis') return [];
        const pos = p.posMm ?? (p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2);
        if (p.axis === 'x') return [{ u1:pos, v1:H-(p.vMaxMm??H), u2:pos, v2:H-(p.vMinMm??0), isVert:true,  flipX:false, flipY:false }];
        if (p.axis === 'z') return [{ u1:p.uMinMm??0, v1:H-pos, u2:p.uMaxMm??W, v2:H-pos,       isVert:false, flipX:false, flipY:true  }];
        return [];
      },
    },
    {
      id: 'back', label: '後面',
      ox: PAD + D + W + D, oy: PAD + D, fW: W, fH: H,
      getLines: (p) => {
        if (p.type !== 'axis') return [];
        const pos = p.posMm ?? (p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2);
        if (p.axis === 'x') return [{ u1:W-pos, v1:H-(p.vMaxMm??H), u2:W-pos, v2:H-(p.vMinMm??0), isVert:true,  flipX:true,  flipY:false }];
        if (p.axis === 'z') return [{ u1:W-(p.uMaxMm??W), v1:H-pos, u2:W-(p.uMinMm??0), v2:H-pos,  isVert:false, flipX:false, flipY:true  }];
        return [];
      },
    },
    {
      id: 'left', label: '左面',
      ox: PAD, oy: PAD + D, fW: D, fH: H,
      getLines: (p) => {
        if (p.type !== 'axis') return [];
        const pos = p.posMm ?? (p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2);
        if (p.axis === 'y') return [{ u1:D-pos, v1:H-(p.vMaxMm??H), u2:D-pos, v2:H-(p.vMinMm??0), isVert:true,  flipX:true,  flipY:false }];
        if (p.axis === 'z') return [{ u1:D-(p.vMaxMm??D), v1:H-pos, u2:D-(p.vMinMm??0), v2:H-pos,  isVert:false, flipX:false, flipY:true  }];
        return [];
      },
    },
    {
      id: 'right', label: '右面',
      ox: PAD + D + W, oy: PAD + D, fW: D, fH: H,
      getLines: (p) => {
        if (p.type !== 'axis') return [];
        const pos = p.posMm ?? (p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2);
        if (p.axis === 'y') return [{ u1:pos, v1:H-(p.vMaxMm??H), u2:pos, v2:H-(p.vMinMm??0), isVert:true,  flipX:false, flipY:false }];
        if (p.axis === 'z') return [{ u1:p.vMinMm??0, v1:H-pos, u2:p.vMaxMm??D, v2:H-pos,      isVert:false, flipX:false, flipY:true  }];
        return [];
      },
    },
    {
      id: 'top', label: '上面',
      ox: PAD + D, oy: PAD, fW: W, fH: D,
      getLines: (p) => {
        if (p.type !== 'axis') return [];
        const pos = p.posMm ?? (p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2);
        if (p.axis === 'x') return [{ u1:pos, v1:D-(p.uMaxMm??D), u2:pos, v2:D-(p.uMinMm??0), isVert:true,  flipX:false, flipY:false }];
        if (p.axis === 'y') return [{ u1:p.uMinMm??0, v1:D-pos, u2:p.uMaxMm??W, v2:D-pos,      isVert:false, flipX:false, flipY:true  }];
        return [];
      },
    },
    {
      id: 'bottom', label: '下面',
      ox: PAD + D, oy: PAD + D + H, fW: W, fH: D,
      getLines: (p) => {
        if (p.type !== 'axis') return [];
        const pos = p.posMm ?? (p.axis === 'x' ? W/2 : p.axis === 'y' ? D/2 : H/2);
        if (p.axis === 'x') return [{ u1:pos, v1:p.uMinMm??0, u2:pos, v2:p.uMaxMm??D,  isVert:true,  flipX:false, flipY:false }];
        if (p.axis === 'y') return [{ u1:p.uMinMm??0, v1:pos, u2:p.uMaxMm??W, v2:pos,   isVert:false, flipX:false, flipY:false }];
        return [];
      },
    },
  ];

  // 選択アイコンの cellBox（3Dと同じオレンジ区画を展開図でも表示）
  const selCellBox = selectedIconId
    ? ((panel.placedIcons || []).find(ic => ic.id === selectedIconId)?.cellBox ?? null)
    : null;

  const overlayStyle = posMode === 'initial'
    ? { position: 'absolute', left: 10, bottom: 10 }
    : { position: 'absolute', left: absPos.x, top: absPos.y };

  return (
    <div
      ref={overlayRef}
      style={{ ...overlayStyle, zIndex: 20, pointerEvents: 'none' }}
    >
      {/* SVG 展開図: 背景なし・面セルのみ。SVG自体がドラッグハンドル */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width={svgPxW}
        height={svgPxH}
        style={{ display: 'block', userSelect: 'none', pointerEvents: 'none' }}
      >
        {/* 背景なし — クロスの空隙は透明（3Dビューが透けて見える） */}

        {FACES.map(face => {
          const { id, label, ox, oy, fW, fH } = face;
          const fs = Math.min(W, H) * 0.06;

          const allLines = [];
          for (const part of (panel.partitions || [])) {
            if (part.virtual && !showVirtual) continue; // 空想仕切りは非表示時にスキップ
            for (const ln of face.getLines(part)) {
              allLines.push({ ...ln, part });
            }
          }

          return (
            <g key={id}>
              {/* 面背景 */}
              <rect x={ox} y={oy} width={fW} height={fH}
                fill={id === highlightedFace ? 'rgba(251,191,36,0.08)' : 'rgba(8,15,32,0.72)'}
                stroke={id === highlightedFace ? '#FBBF24' : '#334155'}
                strokeWidth={id === highlightedFace ? 2 : 1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'grab', pointerEvents: 'all' }}
                onMouseDown={onTitleMouseDown} />

              {/* Chamber色表示（仕切りで区切られた空間をパステルカラーで塗り分け） */}
              {showChamberColors && chambers.map(ch =>
                chamberFaceRects(ch, id, W, H, D).map((r, i) => (
                  <rect key={`ch-${ch.id}-${i}`}
                    x={ox + r.u} y={oy + r.v} width={r.w} height={r.h}
                    fill={ch.color} fillOpacity={0.22}
                    style={{ pointerEvents: 'none' }} />
                ))
              )}

              {/* 面ラベル */}
              <text x={ox + fs * 0.4} y={oy + fs * 1.2}
                fontSize={fs} fill="#3B5E8A" style={{ pointerEvents: 'none' }}>
                {label}
              </text>

              {/* 配置アイコン — boxモードの同一投影エリアグループをスロット分割 */}
              {(() => {
                const panelDispMode = panel.iconDisplayMode || 'flat';

                // 各アイコンの「この面での投影矩形」を計算するユーティリティ
                const projBox = (cb) => {
                  switch (id) {
                    case 'front':  return { bx:cb.xMin,      by:H-cb.zMax, bw:cb.xMax-cb.xMin, bh:cb.zMax-cb.zMin };
                    case 'back':   return { bx:W-cb.xMax,    by:H-cb.zMax, bw:cb.xMax-cb.xMin, bh:cb.zMax-cb.zMin };
                    case 'left':   return { bx:D-cb.yMax,    by:H-cb.zMax, bw:cb.yMax-cb.yMin, bh:cb.zMax-cb.zMin };
                    case 'right':  return { bx:cb.yMin,      by:H-cb.zMax, bw:cb.yMax-cb.yMin, bh:cb.zMax-cb.zMin };
                    case 'top':    return { bx:cb.xMin,      by:D-cb.yMax, bw:cb.xMax-cb.xMin, bh:cb.yMax-cb.yMin };
                    case 'bottom': return { bx:cb.xMin,      by:cb.yMin,   bw:cb.xMax-cb.xMin, bh:cb.yMax-cb.yMin };
                    default: return null;
                  }
                };

                // 投影後の2D矩形でグループ化（異なるY深度でも前面投影が同じなら同グループ）
                const boxGroups = new Map(); // projKey → {pb, icons:[]}
                for (const icon of (panel.placedIcons || [])) {
                  const dm = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box')
                    ? icon.iconDisplayMode : panelDispMode;
                  if (dm !== 'box' || !icon.cellBox) continue;
                  const pb = projBox(icon.cellBox);
                  if (!pb) continue;
                  // 小数誤差を丸めてキー生成
                  const k = `${Math.round(pb.bx)}|${Math.round(pb.by)}|${Math.round(pb.bw)}|${Math.round(pb.bh)}`;
                  if (!boxGroups.has(k)) boxGroups.set(k, { pb, icons: [] });
                  boxGroups.get(k).icons.push(icon);
                }

                // グループ → スロット分割してslotMapに登録
                const slotMap = new Map(); // iconId → {bx,by,sw,sh}
                for (const { pb, icons: group } of boxGroups.values()) {
                  const N = group.length;
                  const { bx, by, bw, bh } = pb;
                  if (bw <= 0 || bh <= 0) continue;
                  // 幅≥高さなら横優先グリッド
                  const cols = bw >= bh ? Math.ceil(Math.sqrt(N)) : Math.ceil(N / Math.ceil(Math.sqrt(N)));
                  const rows = Math.ceil(N / cols);
                  const sw = bw / cols, sh = bh / rows;
                  group.forEach((icon, i) => {
                    const col = i % cols, row = Math.floor(i / cols);
                    slotMap.set(icon.id, { bx: bx + col * sw, by: by + row * sh, sw, sh });
                  });
                }

              return (panel.placedIcons || []).map(icon => {
                if (dragPreviewCellBox !== null && icon.id === selectedIconId) return null;
                const dispMode = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box')
                  ? icon.iconDisplayMode : panelDispMode;
                const half = Math.min(W, H, D) / 16;
                const { wx, wy, wz, cellBox } = icon;
                const lbl = icon.name || '';
                const fs = Math.min(fW, fH) * 0.06;
                const isSel = icon.id === selectedIconId || icon.id === hoveredIconId;
                const isChecked = selectedIconIds && selectedIconIds.has(icon.id);
                const iconFill   = isSel ? '#1E40AF' : (icon.iconColor || '#1D4ED8');
                const iconStroke = (isChecked || isSel) ? '#FBBF24' : '#93C5FD';
                const iconSW     = isChecked ? 2 : isSel ? 1.5 : 1;

                // boxモード: slotMapのスロット矩形を使用（同一cellBoxは分割済み）
                if (dispMode === 'box' && cellBox) {
                  const slot = slotMap.get(icon.id);
                  if (!slot) return null;
                  const { bx, by, sw: bw, sh: bh } = slot;
                  const PAD2 = 1;
                  const clipId = `bc-${icon.id}-${id}`;
                  // 日本語1文字≒フォントサイズ幅なので係数0.85（余白込み）
                  const boxFs = Math.min(
                    fs * 0.8,
                    (bw - PAD2*2) / Math.max(1, lbl.length) * 0.85,
                    (bh - PAD2*2) * 0.5,
                  );
                  return (
                    <g key={icon.id} style={{ pointerEvents:'none' }}>
                      <clipPath id={clipId}>
                        <rect x={ox+bx+PAD2} y={oy+by+PAD2} width={Math.max(0,bw-PAD2*2)} height={Math.max(0,bh-PAD2*2)} />
                      </clipPath>
                      <rect x={ox+bx+PAD2} y={oy+by+PAD2} width={Math.max(0,bw-PAD2*2)} height={Math.max(0,bh-PAD2*2)}
                        fill={iconFill} fillOpacity={isSel ? 0.55 : 0.32}
                        stroke={iconStroke} strokeWidth={iconSW}
                        vectorEffect="non-scaling-stroke" />
                      {lbl && boxFs > 3 && (
                        <text x={ox+bx+bw/2} y={oy+by+bh/2} textAnchor="middle" dominantBaseline="middle"
                          fontSize={boxFs} fill={iconStroke} clipPath={`url(#${clipId})`}
                          style={{ pointerEvents:'none' }}>{lbl}</text>
                      )}
                    </g>
                  );
                }

                // flatモード: 点アイコン（従来）
                switch (id) {
                  case 'front': return (
                    <g key={icon.id} style={{ pointerEvents:'none' }}>
                      <rect x={ox+wx-half} y={oy+H-wz-half} width={half*2} height={half*2}
                        fill={iconFill} fillOpacity={0.9} stroke={iconStroke} strokeWidth={iconSW}
                        vectorEffect="non-scaling-stroke" />
                      {lbl && <text x={ox+wx} y={oy+H-wz-half-fs*0.3} textAnchor="middle"
                        fontSize={fs*0.8} fill={iconStroke}>{lbl}</text>}
                    </g>
                  );
                  case 'back': return (
                    <g key={icon.id} style={{ pointerEvents:'none' }}>
                      <rect x={ox+(W-wx)-half} y={oy+H-wz-half} width={half*2} height={half*2}
                        fill={iconFill} fillOpacity={0.9} stroke={iconStroke} strokeWidth={iconSW}
                        vectorEffect="non-scaling-stroke" />
                    </g>
                  );
                  case 'left': return (
                    <line key={icon.id}
                      x1={ox+D-wy} y1={oy+H-wz-half} x2={ox+D-wy} y2={oy+H-wz+half}
                      stroke={iconStroke} strokeWidth={isSel ? 2.5 : 2} vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents:'none' }} />
                  );
                  case 'right': return (
                    <line key={icon.id}
                      x1={ox+wy} y1={oy+H-wz-half} x2={ox+wy} y2={oy+H-wz+half}
                      stroke={iconStroke} strokeWidth={isSel ? 2.5 : 2} vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents:'none' }} />
                  );
                  case 'top': return (
                    <line key={icon.id}
                      x1={ox+wx-half} y1={oy+D-wy} x2={ox+wx+half} y2={oy+D-wy}
                      stroke={iconStroke} strokeWidth={isSel ? 2.5 : 2} vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents:'none' }} />
                  );
                  case 'bottom': return (
                    <line key={icon.id}
                      x1={ox+wx-half} y1={oy+wy} x2={ox+wx+half} y2={oy+wy}
                      stroke={iconStroke} strokeWidth={isSel ? 2.5 : 2} vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents:'none' }} />
                  );
                  default: return null;
                }
              });
              })()}

              {/* 扉（選択中はオレンジ、通常は青グレー） */}
              {(panel.doors || []).map(door => {
                if (door.face !== id) return null;
                const isSel = door.id === selectedDoorId || door.id === hoveredDoorId;
                const fill = isSel ? 'rgba(251,146,60,0.35)' : 'rgba(96,165,250,0.20)';
                const stroke = isSel ? '#F97316' : '#60A5FA';
                const sw = isSel ? 2 : 1;
                let dx, dy, dw, dh;
                switch (id) {
                  case 'front':  dx=door.uMm;       dy=H-door.vMm-door.heightMm; dw=door.widthMm; dh=door.heightMm; break;
                  case 'back':   dx=W-door.uMm-door.widthMm; dy=H-door.vMm-door.heightMm; dw=door.widthMm; dh=door.heightMm; break;
                  case 'left':   dx=D-door.uMm-door.widthMm; dy=H-door.vMm-door.heightMm; dw=door.widthMm; dh=door.heightMm; break;
                  case 'right':  dx=door.uMm;       dy=H-door.vMm-door.heightMm; dw=door.widthMm; dh=door.heightMm; break;
                  case 'top':    dx=door.uMm;       dy=D-door.vMm-door.heightMm; dw=door.widthMm; dh=door.heightMm; break;
                  case 'bottom': dx=door.uMm;       dy=door.vMm;                 dw=door.widthMm; dh=door.heightMm; break;
                  default: return null;
                }
                return (
                  <rect key={door.id} x={ox+dx} y={oy+dy} width={dw} height={dh}
                    fill={fill} stroke={stroke} strokeWidth={sw}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: 'none' }} />
                );
              })}

              {/* 扉候補ホバーセル（仕切り線より下に描画） */}
              {hoveredCell && hoveredCell.face === id && (() => {
                const c = hoveredCell;
                let cellX, cellY;
                switch (id) {
                  case 'front':  cellX = ox + c.uMm;             cellY = oy + H - c.vMm - c.heightMm; break;
                  case 'back':   cellX = ox + W - c.uMm - c.widthMm; cellY = oy + H - c.vMm - c.heightMm; break;
                  case 'left':   cellX = ox + D - c.uMm - c.widthMm; cellY = oy + H - c.vMm - c.heightMm; break;
                  case 'right':  cellX = ox + c.uMm;             cellY = oy + H - c.vMm - c.heightMm; break;
                  case 'top':    cellX = ox + c.uMm;             cellY = oy + D - c.vMm - c.heightMm; break;
                  case 'bottom': cellX = ox + c.uMm;             cellY = oy + c.vMm; break;
                  default: return null;
                }
                return (
                  <rect key="hoverCell" x={cellX} y={cellY} width={c.widthMm} height={c.heightMm}
                    fill="rgba(251,191,36,0.55)"
                    stroke="#FBBF24" strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: 'none' }} />
                );
              })()}

              {/* 選択アイコン cellBox（ドラッグ中は移動先プレビューに切り替え、移動元は非表示） */}
              {(() => {
                const isDragging = dragPreviewCellBox !== null;
                const renderCb = isDragging ? dragPreviewCellBox : selCellBox;
                if (!renderCb) return null;
                let u, v, w, h;
                switch (id) {
                  case 'front':  u=renderCb.xMin;   v=H-renderCb.zMax; w=renderCb.xMax-renderCb.xMin; h=renderCb.zMax-renderCb.zMin; break;
                  case 'back':   u=W-renderCb.xMax; v=H-renderCb.zMax; w=renderCb.xMax-renderCb.xMin; h=renderCb.zMax-renderCb.zMin; break;
                  case 'left':   u=D-renderCb.yMax; v=H-renderCb.zMax; w=renderCb.yMax-renderCb.yMin; h=renderCb.zMax-renderCb.zMin; break;
                  case 'right':  u=renderCb.yMin;   v=H-renderCb.zMax; w=renderCb.yMax-renderCb.yMin; h=renderCb.zMax-renderCb.zMin; break;
                  case 'top':    u=renderCb.xMin;   v=D-renderCb.yMax; w=renderCb.xMax-renderCb.xMin; h=renderCb.yMax-renderCb.yMin; break;
                  case 'bottom': u=renderCb.xMin;   v=renderCb.yMin;   w=renderCb.xMax-renderCb.xMin; h=renderCb.yMax-renderCb.yMin; break;
                  default: return null;
                }
                if (w <= 0 || h <= 0) return null;
                return (
                  <rect key="iconCellBox"
                    x={ox + u} y={oy + v} width={w} height={h}
                    fill={isDragging ? 'rgba(251,191,36,0.18)' : 'rgba(251,191,36,0.08)'}
                    stroke="#FBBF24" strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: 'none' }} />
                );
              })()}

              {/* 仕切り線 */}
              {allLines.map((ln, i) => {
                const isSel = ln.part.id === selectedPartitionId || ln.part.id === hoveredPartitionId;
                const col = isSel ? '#FBBF24' : (ln.part.color || '#64748B');
                const lx1 = ox + ln.u1, ly1 = oy + ln.v1;
                const lx2 = ox + ln.u2, ly2 = oy + ln.v2;
                return (
                  <g key={`${ln.part.id}-${i}`}>
                    <line x1={lx1} y1={ly1} x2={lx2} y2={ly2}
                      stroke="transparent" strokeWidth={10}
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: disabled ? 'default' : 'crosshair', pointerEvents: 'stroke' }}
                      onMouseDown={(e) => {
                        if (disabled) return;
                        if (ln.part.id === selectedPartitionId) {
                          // 選択済み → 即ドラッグ開始
                          startPartDrag(e, ln.part, ln);
                        } else {
                          // 未選択 → mouseup時に移動量で選択判定（stopPropagation しない）
                          partClickRef.current = { part: ln.part, x0: e.clientX, y0: e.clientY };
                        }
                      }}
                    />
                    <line x1={lx1} y1={ly1} x2={lx2} y2={ly2}
                      stroke={col} strokeWidth={isSel ? 2 : 1}
                      strokeDasharray={ln.part.virtual ? '6 4' : undefined}
                      opacity={ln.part.virtual ? 0.45 : 1}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                );
              })}

              {/* 選択中ハンドル */}
              {allLines
                .filter(ln => ln.part.id === selectedPartitionId)
                .map((ln, i) => {
                  return (
                    <circle key={`h-${i}`}
                      cx={ox + (ln.u1 + ln.u2) / 2} cy={oy + (ln.v1 + ln.v2) / 2} r={4}
                      fill="#FBBF24" stroke="#1E293B" strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: 'move', pointerEvents: 'all' }}
                      onMouseDown={(e) => startPartDrag(e, ln.part, ln)}
                    />
                  );
                })}
            </g>
          );
        })}

        {/* 折り目線（面の接続辺） */}
        {[
          [PAD+D,     PAD+D,   PAD+D+W,   PAD+D  ],
          [PAD+D,     PAD+D+H, PAD+D+W,   PAD+D+H],
          [PAD+D,     PAD+D,   PAD+D,     PAD+D+H],
          [PAD+D+W,   PAD+D,   PAD+D+W,   PAD+D+H],
          [PAD+D+W+D, PAD+D,   PAD+D+W+D, PAD+D+H],
        ].map(([x1,y1,x2,y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="#1D3557" strokeWidth={1} strokeDasharray="4,4"
            vectorEffect="non-scaling-stroke" />
        ))}

        {/* 選択辺ハイライト（辺そのものをオレンジで描画） */}
        {activeEdgeSegs.map(([x1,y1,x2,y2], i) => (
          <line key={`eh-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="#FBBF24" strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none' }} />
        ))}
      </svg>
    </div>
  );
}
