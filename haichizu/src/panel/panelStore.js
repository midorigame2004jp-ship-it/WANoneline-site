// ================================================================
// panelStore.js — 配電盤エディタ状態管理（useState + useRef パターン）
// Zustand 非依存（配置図側と同じ方式）
// ================================================================

// アンドゥ/リドゥ付き useState ラッパー
// 300ms以内の連続呼び出しは最後のエントリを上書き（ドラッグ操作を1アンドゥ単位に）
function usePanelHistoryState(initial) {
  const histRef = useRef([initial]);
  const idxRef = useRef(0);
  const lastTimeRef = useRef(0);
  const _dragMergingRef = useRef(false);
  const _dragFirstCallRef = useRef(false); // beginMerge後の最初のsetPanelsだけ新エントリにする
  const [, tick] = useState(0);

  const setPanels = useCallback((updater, { forceNew = false } = {}) => {
    const now = Date.now();
    let merge;
    if (forceNew) {
      merge = false;
      // ドラッグ中のforceNew（addPartition等）: 以降の更新はマージへ移行
      if (_dragFirstCallRef.current) {
        _dragFirstCallRef.current = false;
        _dragMergingRef.current = true;
      }
    } else if (_dragFirstCallRef.current) {
      // ドラッグ開始後の最初のupdatePartition: 新エントリを作ってからマージ開始
      merge = false;
      _dragFirstCallRef.current = false;
      _dragMergingRef.current = true;
    } else {
      merge = _dragMergingRef.current || (now - lastTimeRef.current) < 300;
    }
    lastTimeRef.current = now;
    const cur = histRef.current[idxRef.current];
    const next = typeof updater === 'function' ? updater(cur) : updater;
    if (merge) {
      histRef.current[idxRef.current] = next;
    } else {
      histRef.current = histRef.current.slice(0, idxRef.current + 1);
      histRef.current.push(next);
      if (histRef.current.length > 50) histRef.current.shift();
      else idxRef.current++;
    }
    tick(n => n + 1);
  }, []);

  const undo = useCallback(() => {
    if (idxRef.current > 0) { idxRef.current--; tick(n => n + 1); }
  }, []);
  const redo = useCallback(() => {
    if (idxRef.current < histRef.current.length - 1) { idxRef.current++; tick(n => n + 1); }
  }, []);
  // ドラッグ開始: 次のsetPanels呼び出しで新エントリを作り、以降はマージ
  const beginMerge = useCallback(() => {
    _dragFirstCallRef.current = true;
    _dragMergingRef.current = false;
  }, []);
  const endMerge = useCallback(() => {
    _dragMergingRef.current = false;
    _dragFirstCallRef.current = false;
    lastTimeRef.current = 0;
  }, []);

  const panels = histRef.current[idxRef.current];
  const canUndo = idxRef.current > 0;
  const canRedo = idxRef.current < histRef.current.length - 1;
  return [panels, setPanels, undo, redo, canUndo, canRedo, beginMerge, endMerge];
}

function usePanelEditorState(initialPanels = []) {
  const [panels, setPanels, undo, redo, canUndo, canRedo, beginMerge, endMerge] = usePanelHistoryState(initialPanels);
  const [activePanelId, setActivePanelId] = useState(null);
  // カメラ: az(水平回転), el(仰角), zoom, panX, panY
  const [camera, setCamera] = useState({
    az: -Math.PI / 5,  // 約-36° — 前面と左面が見える（右面でなく左面を表示）
    el: -Math.PI / 8,  // 約-22.5° — 上面がほどよく見える等角投影
    zoom: 1,
    panX: 0,
    panY: 0,
  });

  const activePanel = panels.find(p => p.id === activePanelId) || null;

  const _isLocked = (panelId) => {
    const p = panels.find(p => p.id === panelId);
    return p ? p.locked : false;
  };

  // パネル追加（デフォルト寸法: 幅600×高さ1800×奥行400mm）
  const addPanel = () => {
    const id = 'panel_' + Date.now();
    const W = 600, H = 1800, D = 400;
    const newPanel = {
      id,
      name: '新規配電盤',
      widthMm: W,
      heightMm: H,
      depthMm: D,
      color: '#4A90D9',
      locked: false,
      partitions: [
        { id: 'part_' + Date.now() + '_x', name: '仕切り（X軸）', type: 'axis', axis: 'x',
          posMm: Math.round(W / 2), uMinMm: 0, uMaxMm: D, vMinMm: 0, vMaxMm: H,
          thicknessMm: 2, color: '#94A3B8' },
        { id: 'part_' + (Date.now()+1) + '_y', name: '仕切り（Y軸）', type: 'axis', axis: 'y',
          posMm: Math.round(D / 2), uMinMm: 0, uMaxMm: W, vMinMm: 0, vMaxMm: H,
          thicknessMm: 2, color: '#94A3B8' },
        { id: 'part_' + (Date.now()+2) + '_z', name: '仕切り（Z軸）', type: 'axis', axis: 'z',
          posMm: Math.round(H / 2), uMinMm: 0, uMaxMm: W, vMinMm: 0, vMaxMm: D,
          thicknessMm: 2, color: '#94A3B8' },
      ],
      doors: [],
      wirePorts: [],
      placedIcons: [],
      placements: {},
      iconDisplayMode: 'flat',
      cables: [],
    };
    setPanels(pr => [...pr, newPanel]);
    setActivePanelId(id);
    return id;
  };

  // パネルプロパティ更新（ロック中は不可）
  // widthMm/depthMm/heightMm が変化した場合、接触面の仕切りを同一トランザクションで追従更新
  const updatePanel = (panelId, changes, { forceNew = false } = {}) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p => {
      if (p.id !== panelId) return p;
      const updated = { ...p, ...changes };
      // 寸法変化がなければ仕切り更新不要
      const dimAxes = { widthMm: 'x', depthMm: 'y', heightMm: 'z' };
      // 初期値は changes 優先。更新前の p から取ると、最終行の { ...updated, partitions, doors } で
      // changes.doors / changes.partitions を握り潰してしまう（3次元図からの扉開閉が反映されない原因）。
      let partitions = Array.isArray(changes.partitions) ? changes.partitions : p.partitions;
      let doors = Array.isArray(changes.doors) ? changes.doors : (p.doors || []);
      for (const [dim, movingAxis] of Object.entries(dimAxes)) {
        if (changes[dim] == null || changes[dim] === p[dim]) continue;
        const oldMax = p[dim], newMax = changes[dim];
        // _partitionsFollowingFace / _doorsFollowingFace は PanelCanvas3D.jsx に定義（同一eval内でホイスト済み）
        const toUpdateParts = _partitionsFollowingFace(partitions, dim, oldMax, newMax);
        if (toUpdateParts.length > 0) {
          const patchMap = new Map(toUpdateParts.map(({ id, changes: ch }) => [id, ch]));
          partitions = partitions.map(pt => { const ch = patchMap.get(pt.id); return ch ? { ...pt, ...ch } : pt; });
        }
        const toUpdateDoors = _doorsFollowingFace(doors, dim, oldMax, newMax);
        if (toUpdateDoors.length > 0) {
          const patchMap = new Map(toUpdateDoors.map(({ id, changes: ch }) => [id, ch]));
          doors = doors.map(d => { const ch = patchMap.get(d.id); return ch ? { ...d, ...ch } : d; });
        }
      }
      return { ...updated, partitions, doors };
    }), { forceNew });
  };

  // パネル削除（ロック中は不可）
  const deletePanel = (panelId) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.filter(p => p.id !== panelId));
    setActivePanelId(pr => (pr === panelId ? null : pr));
  };

  // ロック切り替え（ロック中でも実行可能）
  const toggleLock = (panelId) => {
    setPanels(pr => pr.map(p => p.id === panelId ? { ...p, locked: !p.locked } : p));
  };

  // 仕切り追加（ロック中は不可）
  const addPartition = (panelId, partData) => {
    if (_isLocked(panelId)) return;
    const part = {
      id: 'part_' + Date.now(),
      name: '仕切り',
      type: 'axis',
      axis: 'y',
      posMm: null,
      uMinMm: null, uMaxMm: null, vMinMm: null, vMaxMm: null,
      vertices: null,
      color: '#94A3B8',
      thicknessMm: 2,
      virtual: false,
      ...partData,
    };
    setPanels(pr => pr.map(p =>
      p.id === panelId ? { ...p, partitions: [...p.partitions, part] } : p
    ), { forceNew: true });
    return part.id;
  };

  // 仕切り更新（ロック中は不可）
  const updatePartition = (panelId, partId, changes, { forceNew = false } = {}) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p =>
      p.id === panelId
        ? { ...p, partitions: p.partitions.map(pt => pt.id === partId ? { ...pt, ...changes } : pt) }
        : p
    ), { forceNew });
  };

  // 仕切り削除（ロック中は不可）
  const deletePartition = (panelId, partId) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p =>
      p.id === panelId ? { ...p, partitions: p.partitions.filter(pt => pt.id !== partId) } : p
    ));
  };

  // 扉追加（ロック中は不可）
  const addDoor = (panelId, doorData) => {
    if (_isLocked(panelId)) return null;
    const door = {
      id: 'door_' + Date.now(),
      name: '扉',
      face: 'front',
      uMm: 0, vMm: 0, widthMm: 100, heightMm: 200,
      hingeSide: 'left',
      isOpen: false,
      ...doorData,
    };
    setPanels(pr => pr.map(p =>
      p.id === panelId ? { ...p, doors: [...(p.doors || []), door] } : p
    ), { forceNew: true });
    return door.id;
  };

  // 扉一括追加（ロック中は不可）— 1回のsetPanelsで追加するのでIDが重複しない
  const addDoors = (panelId, doorsData) => {
    if (_isLocked(panelId)) return [];
    const base = Date.now();
    const newDoors = doorsData.map((d, i) => ({
      id: 'door_' + (base + i),
      name: '扉',
      face: 'front',
      uMm: 0, vMm: 0, widthMm: 100, heightMm: 200,
      hingeSide: 'left',
      isOpen: false,
      ...d,
    }));
    setPanels(pr => pr.map(p =>
      p.id === panelId ? { ...p, doors: [...(p.doors || []), ...newDoors] } : p
    ), { forceNew: true });
    return newDoors.map(d => d.id);
  };

  // 扉更新（ロック中は不可）
  const updateDoor = (panelId, doorId, changes, { forceNew = false } = {}) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p =>
      p.id === panelId
        ? { ...p, doors: (p.doors || []).map(d => d.id === doorId ? { ...d, ...changes } : d) }
        : p
    ), { forceNew });
  };

  // 扉削除（ロック中は不可）
  const deleteDoor = (panelId, doorId) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p => {
      if (p.id !== panelId) return p;
      // 扉に貼られたアイコンも道連れで消す（扉が無いと座標を導出できず不可視ゾンビになるため）
      const goneIds = new Set((p.placedIcons || []).filter(ic => ic.doorId === doorId).map(ic => ic.id));
      return {
        ...p,
        doors: (p.doors || []).filter(d => d.id !== doorId),
        placedIcons: (p.placedIcons || []).filter(ic => ic.doorId !== doorId),
        // 消えたアイコンに繋がっていた配線も外す（端点だけ残った配線を作らない）
        cables: (p.cables || []).filter(c => !goneIds.has(c.fromIconId) && !goneIds.has(c.toIconId)),
      };
    }));
  };

  // ケーブル追加（ロック中は不可）
  const addCable = (panelId, cableData) => {
    if (_isLocked(panelId)) return null;
    const cable = {
      id: 'cable_' + Date.now(),
      fromIconId: '',
      toIconId: '',
      wiresetId: null,
      waypoints: [],
      color: '#60A5FA',
      lineColor: '#000000',
      thickness: 3,
      outlineThickness: 4,
      label: '',
      ...cableData,
    };
    setPanels(pr => pr.map(p =>
      p.id === panelId ? { ...p, cables: [...(p.cables || []), cable] } : p
    ), { forceNew: true });
    return cable.id;
  };

  // ケーブル更新（ロック中は不可）
  const updateCable = (panelId, cableId, patch) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p =>
      p.id === panelId
        ? { ...p, cables: (p.cables || []).map(c => c.id === cableId ? { ...c, ...patch } : c) }
        : p
    ));
  };

  // ケーブル削除（ロック中は不可）
  const deleteCable = (panelId, cableId) => {
    if (_isLocked(panelId)) return;
    setPanels(pr => pr.map(p =>
      p.id === panelId ? { ...p, cables: (p.cables || []).filter(c => c.id !== cableId) } : p
    ));
  };

  // ── 配置済み盤（3次元図の実体）の受け入れ ──
  // 実体はテンプレートと同じ panels 配列に置き、placedId の有無だけで区別する。
  // 別配列にすると編集・アンドゥ・描画をすべて二重に持つことになるため一本化する。
  // 既に同じ placedId があれば「開き直し」なので作り直さず既存を返す（編集内容を失わない）。
  const upsertPlacedPanel = (msg) => {
    if (!msg || !msg.placedId) return null;
    const existing = panels.find(p => p.placedId === msg.placedId);
    if (existing) return existing;
    if (!msg.panelData) return null;
    const inst = {
      ...msg.panelData,
      placedId: msg.placedId,
      serialNo: msg.serialNo,
      templateId: msg.templateId,
      templateName: msg.templateName,
    };
    setPanels(pr => pr.some(p => p.placedId === msg.placedId) ? pr : [...pr, inst]);
    return inst;
  };

  // 3次元図に実在する placedId 群を受け取り、そこに無い実体を一覧から取り除く。
  // テンプレート（placedId 無し）は対象外。
  const prunePlacedPanels = (livingIds) => {
    const alive = new Set(livingIds || []);
    setPanels(pr => {
      const kept = pr.filter(p => !p.placedId || alive.has(p.placedId));
      return kept.length === pr.length ? pr : kept;
    });
  };

  const removePlacedPanel = (placedId) => {
    if (!placedId) return;
    setPanels(pr => pr.filter(p => p.placedId !== placedId));
    if (activePanelId && panels.find(p => p.id === activePanelId)?.placedId === placedId) {
      setActivePanelId(null);
    }
  };

  return {
    panels,
    activePanelId,
    setActivePanelId,
    activePanel,
    camera,
    setCamera,
    addPanel,
    upsertPlacedPanel,
    prunePlacedPanels,
    removePlacedPanel,
    updatePanel,
    deletePanel,
    toggleLock,
    addPartition,
    updatePartition,
    deletePartition,
    addDoor,
    addDoors,
    updateDoor,
    deleteDoor,
    addCable,
    updateCable,
    deleteCable,
    undo,
    redo,
    canUndo,
    canRedo,
    beginMerge,
    endMerge,
  };
}
