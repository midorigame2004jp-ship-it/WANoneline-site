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

  // 3次元図からの SELECT_PANEL メッセージで対象盤を選択状態にする
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type !== 'SELECT_PANEL') return;
      const p = state.panels.find(p => p.name === e.data.panelName);
      if (p) state.setActivePanelId(p.id);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [state.panels, state.setActivePanelId]);

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
