// ウィンドウ間位置情報共有カスタムフック
// 新しいウィンドウを追加するときは App.jsx で useMapPos() の戻り値を props として渡す
function useMapPos(nodes, segs, initOnSegT) {
  const [mapPos, setMapPos] = useState({});
  const [mapZ, setMapZ] = useState({});
  const [onSegT, setOnSegT] = useState(initOnSegT || {});

  const allMapPos = useMemo(() => {
    const r = {};
    nodes.forEach(n => {
      if (n.kind === 'on_seg') {
        const seg = segs.find(s => s.id === n.segId);
        if (!seg) return;
        const t = onSegT[n.id] ?? n.t ?? 0;
        const aP = r[seg.from], bP = r[seg.to];
        if (aP && bP) r[n.id] = { x: aP.x + (bP.x - aP.x) * t, y: aP.y + (bP.y - aP.y) * t, z: 0 };
      } else if (mapPos[n.id]) {
        r[n.id] = { ...mapPos[n.id], z: mapZ[n.id] || 0 };
      }
    });
    // on_seg ノードの補間（上記で未確定だったものを再処理）
    nodes.filter(n => n.kind === 'on_seg' && !r[n.id]).forEach(n => {
      const seg = segs.find(s => s.id === n.segId);
      if (!seg) return;
      const t = onSegT[n.id] ?? n.t ?? 0;
      const aP = r[seg.from], bP = r[seg.to];
      if (aP && bP) r[n.id] = { x: aP.x + (bP.x - aP.x) * t, y: aP.y + (bP.y - aP.y) * t, z: 0 };
    });
    return r;
  }, [nodes, segs, mapPos, mapZ, onSegT]);

  return { mapPos, setMapPos, mapZ, setMapZ, onSegT, setOnSegT, allMapPos };
}
