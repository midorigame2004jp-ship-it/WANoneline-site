// ================================================================
// OrientationCube.jsx — 方位キューブ（共通コンポーネント）
// ================================================================
// 【正】Cesium側の実装（CesiumMap.jsx の「方位キューブ + PN設定UI」）。
// デザイン・機能ともそこからの忠実な移植であり、独自の色や省略を作らない
// （spec 7.10「見た目・操作感・組み立て方を同じにする」）。
//
// Cesium版から引き継いだもの:
//   - 6面の配色と面ラベル（X / -X / PN / -PN / Z / -Z）
//   - 4本の軸矢印: X(赤) / 真北N(橙) / PN(緑・yラベル付き) / Z(青)
//   - 中心の白丸
//   - PNラベルのクリックでPN調整パネルを開閉、数値入力＋Enter/blur、▲▼で±1°
//   - ドラッグでカメラ回転
//
// 【投影の向きについて】Cesium版は heading/pitch、こちらは配電盤と同じ az/el。
// depthの符号規約が両者で逆（Cesium=大きいほど奥 / project3DPanel=大きいほど手前）。
// **ここでは project3DPanel 側の規約に合わせる**（混ぜると「箱が裏返る」不具合になる。
// 3次元図で何度も再発した既知の罠）。
//
// 【幾何は持たない・2026-08-30】投影・面定義・depth順・明暗判定は
// src/panel/orientationCubeCore.js が唯一の実装。このファイルは描画とUIだけを担う。
// App.jsx の4ビュー（平面図・断面図・側面図・矢視図）も同じコアを呼んでいる
// （あちらは world 規約なので ocFromWorldCam を通す）。
// JSXを統合していないのは、こちらに面ラベル・PN調整パネル・ドラッグ回転・可変sizeが要り、
// あちらに矢印の取捨選択と面の2D回転が要るため（要件が違う。コア冒頭に理由）。
//
// props:
//   az, el     : カメラの向き(rad)。配電盤・建物エディタと同じ意味
//   pnDeg      : プラントノース角(度, CW from grid North)
//   setPnDeg   : 指定するとPNラベルがクリック可能になりPN調整パネルが出る
//   size       : 一辺のpx（既定80）
//   onRotate   : (dAz, dEl) => void。指定するとドラッグでカメラを回せる
// ================================================================

const OC_ROT_SENS = 0.005; // Cesium版と同じドラッグ感度

function OrientationCube({ az = -Math.PI / 5, el = -Math.PI / 8, pnDeg = 0, setPnDeg = null, size = 80, onRotate = null }) {
  const gc = size / 2;        // 中心
  const cs = size * 0.2;      // キューブ半辺
  const arL = size * 0.375;   // 矢印長（Cesium版 arL=30 @ size=80 と同比）
  const pnRad = (pnDeg || 0) * Math.PI / 180;
  const [pnPanelOpen, setPnPanelOpen] = useState(false);
  const [pnInput, setPnInput] = useState(String(pnDeg || 0));
  const dragRef = useRef(null);
  useEffect(() => { setPnInput(String(pnDeg || 0)); }, [pnDeg]);

  // 幾何は orientationCubeCore.js が唯一の実装。ここで投影式を書かない。
  // 面定義・depth順・明暗のしきい値・引き分けの扱いは全部そちらにある
  const { faces, midD, isNear } = ocCubeFaces(pnRad, az, el, gc, cs);

  // 軸方向（スクリーン）。真北の式はコア側で直してある
  // （旧実装は b の反転を足したときに真北ベクトルを直し忘れており、
  //   真北が PN 角の2倍で回っていた。PN=0°/180° 以外は誤り。詳細はコアのコメント）
  const dirs = ocAxisDirs(pnRad, az, el);
  const [ax, ay] = dirs.x;
  const [bx, by] = dirs.pn;
  const [zx, zy] = dirs.z;
  const [nx, ny] = dirs.n;

  const arrHead = (dx, dy, col, key) => {
    const hx = gc + dx, hy = gc + dy;
    const l = Math.hypot(dx, dy) || 1, ux = dx/l, uy = dy/l;
    const pts = hx + ',' + hy + ' '
      + (hx-ux*6-uy*3) + ',' + (hy-uy*6+ux*3) + ' '
      + (hx-ux*6+uy*3) + ',' + (hy-uy*6-ux*3);
    return <polygon key={key} points={pts} fill={col} />;
  };

  // ドラッグでカメラ回転（Cesium版と同じ操作感）
  const onDown = (e) => {
    if (!onRotate || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { x: e.clientX, y: e.clientY };
    const mv = (ev) => {
      const d = dragRef.current; if (!d) return;
      onRotate(-(ev.clientX - d.x) * OC_ROT_SENS, -(ev.clientY - d.y) * OC_ROT_SENS);
      dragRef.current = { x: ev.clientX, y: ev.clientY };
    };
    const up = () => { dragRef.current = null; window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  };

  const commitPn = (raw) => {
    const n = Number(raw);
    const safe = isNaN(n) ? 0 : ((n % 360) + 360) % 360;
    setPnDeg(safe); setPnInput(String(safe));
  };
  const stepPn = (d) => { const n = ((((pnDeg || 0) + d) % 360) + 360) % 360; setPnDeg(n); setPnInput(String(n)); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, pointerEvents: 'auto' }}>
      <svg width={size} height={size} style={{ overflow: 'visible', display: 'block', cursor: onRotate ? 'grab' : 'default' }}
        onMouseDown={onDown}>
        {faces.map((f, i) => (
          <g key={i}>
            <polygon points={f.pts} fill={isNear(f) ? f.b : f.dk} stroke="rgba(0,0,0,0.4)" strokeWidth={0.7} opacity={0.9} />
            {isNear(f) && (
              <text x={f.cx} y={f.cy} fill="#FFF" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700">{f.label}</text>
            )}
          </g>
        ))}
        <circle cx={gc} cy={gc} r={3} fill="#FFF" stroke="#000" strokeWidth={0.8} />

        <line x1={gc} y1={gc} x2={gc+ax*arL} y2={gc+ay*arL} stroke="#EF4444" strokeWidth={1.8} strokeLinecap="round" />
        {arrHead(ax*arL, ay*arL, '#EF4444', 'x')}
        <text x={gc+ax*(arL+10)} y={gc+ay*(arL+10)} fill="#EF4444" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">X</text>

        <line x1={gc} y1={gc} x2={gc+nx*arL} y2={gc+ny*arL} stroke="#F97316" strokeWidth={1.8} strokeLinecap="round" />
        {arrHead(nx*arL, ny*arL, '#F97316', 'n')}
        <text x={gc+nx*(arL+11)} y={gc+ny*(arL+11)} fill="#F97316" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">N</text>

        <line x1={gc} y1={gc} x2={gc+bx*arL} y2={gc+by*arL} stroke="#22C55E" strokeWidth={2} strokeLinecap="round" />
        {arrHead(bx*arL, by*arL, '#22C55E', 'pn')}
        <text x={gc+bx*(arL+11)} y={gc+by*(arL+11)-7} fill="#22C55E" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700"
          onMouseDown={setPnDeg ? (e => { e.stopPropagation(); }) : undefined}
          onClick={setPnDeg ? (e => { e.stopPropagation(); setPnPanelOpen(o => !o); }) : undefined}
          style={setPnDeg ? { cursor: 'pointer' } : undefined}>PN</text>
        <text x={gc+bx*(arL+11)} y={gc+by*(arL+11)+7} fill="#22C55E" fontSize={7} textAnchor="middle" dominantBaseline="middle" fontWeight="700">y</text>

        <line x1={gc} y1={gc} x2={gc+zx*arL} y2={gc+zy*arL} stroke="#60A5FA" strokeWidth={2} strokeLinecap="round" />
        {arrHead(zx*arL, zy*arL, '#60A5FA', 'z')}
        <text x={gc+zx*(arL+10)} y={gc+zy*(arL+10)} fill="#60A5FA" fontSize={8} textAnchor="middle" dominantBaseline="middle" fontWeight="700">Z</text>
      </svg>

      {setPnDeg && pnPanelOpen && (
        <div style={{ background: 'rgba(15,23,42,0.72)', borderRadius: 4, padding: '3px 5px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="text" inputMode="numeric" value={pnInput}
              onChange={e => setPnInput(e.target.value)}
              onBlur={e => commitPn(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitPn(e.target.value); }}
              style={{ width: 36, fontSize: 9, padding: '1px 3px', background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 3, color: '#FCD34D', textAlign: 'center' }} />
            <span style={{ fontSize: 7, color: '#94A3B8' }}>°</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 2 }}>
            <button onClick={() => stepPn(+1)} style={{ fontSize: 8, lineHeight: 1, padding: '1px 8px', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 2, color: '#FCD34D', cursor: 'pointer' }}>▲</button>
            <button onClick={() => stepPn(-1)} style={{ fontSize: 8, lineHeight: 1, padding: '1px 8px', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 2, color: '#FCD34D', cursor: 'pointer' }}>▼</button>
          </div>
        </div>
      )}
    </div>
  );
}
