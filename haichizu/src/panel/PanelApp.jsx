// ================================================================
// PanelApp.jsx — 配電盤エディタ トップレベルコンポーネント
// panel-editor.html からエントリーポイントとして使用
// ================================================================

export default function PanelApp() {
  const [winState, setWinState] = useState(() => ({
    editor: {
      x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, z: 10000,
      _maximized: true,
      _restoreX: 30, _restoreY: 30, _restoreW: 980, _restoreH: 640, _restoreZ: 1,
    },
  }));
  const zRef = useRef(2);

  const bringFront = (id) => {
    zRef.current++;
    setWinState(pr => ({ ...pr, [id]: { ...pr[id], z: zRef.current } }));
  };

  // localStorage から初期パネルを復元（lazy initializer で1回だけ実行）
  const [initialPanels] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wanol_panelData') || '[]'); }
    catch { return []; }
  });
  const state = usePanelEditorState(initialPanels);

  // panels 変更時に自動保存（500ms デバウンス）
  useEffect(() => {
    const t = setTimeout(() =>
      localStorage.setItem('wanol_panelData', JSON.stringify(state.panels)), 500);
    return () => clearTimeout(t);
  }, [state.panels]);

  // ── 3次元図との連携 ──
  // 配置済み盤（実体）もテンプレートと同じ panels 配列に入れて扱う。
  // 実体は placedId を持ち、一覧では「配置済み」区画に分けて表示する。
  // こうすることで編集・アンドゥ・描画の仕組みを一切分岐させずに共用できる。
  useEffect(() => {
    const handler = (e) => {
      const d = e.data;
      if (!d || typeof d.type !== 'string') return;

      // 旧仕様（テンプレートを名前で開く）。互換のため残す。
      if (d.type === 'SELECT_PANEL') {
        const p = state.panels.find(p => p.name === d.panelName);
        if (p) state.setActivePanelId(p.id);
        return;
      }

      // 3次元図にドロップされた → 実体を一覧に追加
      if (d.type === 'PLACED_PANEL_ADDED') {
        state.upsertPlacedPanel(d);
        return;
      }

      // 鉛筆ボタン → その実体を開く（無ければ受け取ったデータで作ってから開く）
      if (d.type === 'SELECT_PLACED_PANEL') {
        const p = state.upsertPlacedPanel(d);
        if (p) state.setActivePanelId(p.id);
        return;
      }

      // 3次元図で削除された → 一覧からも消す
      if (d.type === 'PLACED_PANEL_REMOVED') {
        state.removePlacedPanel(d.placedId);
        return;
      }

      // 3次元図が持っている実体の一覧。ここに無い実体は「置き場所を失った残骸」なので消す。
      // エディタは実体を localStorage に保存するが3次元図の配置は保存されないため、
      // リロードすると一覧にだけ残る。起動時に必ず照合して掃除する。
      if (d.type === 'PLACED_PANEL_LIST' && Array.isArray(d.placedIds)) {
        state.prunePlacedPanels(d.placedIds);
        return;
      }

      // 3次元図側で名前などを変えた → 実体に反映する（往復ループは差分比較で止まる）
      if (d.type === 'PLACED_PANEL_PATCH' && d.placedId && d.patch) {
        const p = state.panels.find(p => p.placedId === d.placedId);
        if (p) state.updatePanel(p.id, d.patch);
        return;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [state.panels, state.setActivePanelId, state.upsertPlacedPanel, state.removePlacedPanel, state.updatePanel]);

  // 起動時に3次元図へ「今ある配置済み盤の一覧をください」と要求する。
  // 3次元図側の準備が先か後かは保証できないため、少し間を置いて数回投げる。
  useEffect(() => {
    if (window.parent === window) return;
    const ask = () => window.parent.postMessage({ type: 'REQUEST_PLACED_PANELS' }, '*');
    ask();
    const t1 = setTimeout(ask, 400);
    const t2 = setTimeout(ask, 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // 実体の内容が変わったら3次元図へ返す（3次元図側の描画データを追従させる）。
  // 変化したものだけを送るため、前回送った内容を覚えておく。
  const _sentRef = useRef(new Map());
  useEffect(() => {
    if (window.parent === window) return;
    const seen = new Set();
    for (const p of state.panels) {
      if (!p.placedId) continue;
      seen.add(p.placedId);
      const json = JSON.stringify(p);
      if (_sentRef.current.get(p.placedId) === json) continue;
      _sentRef.current.set(p.placedId, json);
      window.parent.postMessage(
        { type: 'PLACED_PANEL_UPDATED', placedId: p.placedId, panelData: JSON.parse(json) }, '*');
    }
    for (const k of Array.from(_sentRef.current.keys())) {
      if (!seen.has(k)) _sentRef.current.delete(k);
    }
  }, [state.panels]);

  return (
    <div style={{
      width: '100%', height: '100%',
      background: '#334155',
      position: 'relative', overflow: 'hidden',
    }}>
      <PanelEditor state={state} />
    </div>
  );
}
