// ===== 国土地理院の窓 =====
// 2026-11-22 新設。ユーザー要望:
//   「新たにウインドウを設ける。そのウインドウ内に『地面を作る』ボタンを設け、押すと
//    国土地理院のDEMを取得し3次元図にも反映する。3次元図と国土地理院の座標をリンクさせる
//    必要があり、『3次元範囲を設定』で2点で作った四角をフィールドとする」
//
// 【設計】
// ・地図はライブラリを足さず、地理院タイル（std）を <img> で並べるだけ。Cesium に依存しない
//   （2026-09-23 裁定「Cesium が使えなくても機能を失わない」）。
// ・タイルの座標計算・標高の読み取りは src/gsiTiles.js（葉）1か所。ここには式を書き写さない。
// ・「3次元範囲を設定」は commitFieldPolygon（cesiumUtils.js）を呼ぶだけ。
//   原点と縮尺を決める式は fieldFrameFromPolygon 1か所で、Cesium の多角形と同じ道を通る。
// ・「地面を作る」は terrain.js の parseTerrainJSON が受ける形を作って onTerrain へ渡す。
//   3次元図は既存の terrainMesh の経路でそのまま描く（描き手を増やさない）。

function GsiMapPanel({ onTerrain, terrain, gridN, demSource, onClose, onBuildings, onRemoveBuildings, baseMap }) {
  const boxRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 480, h: 320 });
  const [view, setView] = React.useState(() => {
    const poly = (typeof getSavedFieldPolygon === 'function') ? getSavedFieldPolygon() : null;
    if (poly && poly.length >= 3) {
      const lats = poly.map(p => p.lat), lngs = poly.map(p => p.lng);
      return { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, z: 16 };
    }
    const o = (typeof GEO_ORIGIN !== 'undefined' && GEO_ORIGIN) ? GEO_ORIGIN : { lat: 33.275, lng: 131.667 };
    return { lat: o.lat, lng: o.lng, z: 15 };
  });
  const [pickMode, setPickMode] = React.useState(false);
  const [pts, setPts] = React.useState([]);          // 範囲指定の2点 [{lat,lng}]
  const [hover, setHover] = React.useState(null);     // 範囲指定中のカーソル位置
  const [busy, setBusy] = React.useState(null);       // 取得中の進捗の文字
  const [msg, setMsg] = React.useState('');
  const dragRef = React.useRef(null);

  // 窓の大きさに合わせる
  React.useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(80, Math.round(r.width)), h: Math.max(80, Math.round(r.height)) });
    });
    ro.observe(el);
    const r0 = el.getBoundingClientRect();
    setSize({ w: Math.max(80, Math.round(r0.width)), h: Math.max(80, Math.round(r0.height)) });
    return () => ro.disconnect();
  }, []);

  const z = view.z;
  const 半W = size.w / 2, 半H = size.h / 2;
  const cx = gsiLngToTileX(view.lng, z);
  const cy = gsiLatToTileY(view.lat, z);

  // 画面 ⇄ 緯度経度（この窓の中だけの変換。図面のグリッドとは別物）
  const 画面から = (sx, sy) => ({
    lat: gsiTileYToLat(cy + (sy - 半H) / GSI_TILE_SIZE, z),
    lng: gsiTileXToLng(cx + (sx - 半W) / GSI_TILE_SIZE, z),
  });
  const 画面へ = (lat, lng) => ({
    x: (gsiLngToTileX(lng, z) - cx) * GSI_TILE_SIZE + 半W,
    y: (gsiLatToTileY(lat, z) - cy) * GSI_TILE_SIZE + 半H,
  });

  // 並べるタイル
  const タイルら = [];
  {
    const x0 = Math.floor(cx - 半W / GSI_TILE_SIZE), x1 = Math.floor(cx + 半W / GSI_TILE_SIZE);
    const y0 = Math.floor(cy - 半H / GSI_TILE_SIZE), y1 = Math.floor(cy + 半H / GSI_TILE_SIZE);
    const 枚 = Math.pow(2, z);
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= 枚) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % 枚) + 枚) % 枚;
        タイルら.push({
          key: z + '/' + tx + '/' + ty,
          // 【地図の種類は歯車で選ぶ・2026-11-24】表は gsiTiles.js の GSI_BASEMAPS 1か所
          url: gsiTileUrl((typeof gsiBaseMapId === 'function') ? gsiBaseMapId(baseMap) : 'std', z, wx, ty),
          left: (tx - cx) * GSI_TILE_SIZE + 半W,
          top: (ty - cy) * GSI_TILE_SIZE + 半H,
        });
      }
    }
  }

  // いまのフィールド（図面の範囲）を枠で出す
  const 枠 = (() => {
    const poly = (typeof getSavedFieldPolygon === 'function') ? getSavedFieldPolygon() : null;
    if (!poly || poly.length < 3) return null;
    return poly.map(p => 画面へ(p.lat, p.lng));
  })();

  // 図面全体（TW×TH）が地球上のどこに当たるか＝地面を取る範囲。gridToGeo が正
  const 図面の範囲 = () => {
    if (typeof gridToGeo !== 'function' || typeof TW === 'undefined' || typeof TH === 'undefined') return null;
    const sw = gridToGeo(0, TH);   // y=TH が南
    const ne = gridToGeo(TW, 0);   // y=0 が北
    return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
  };
  const 図面の枠 = (() => {
    const b = 図面の範囲();
    if (!b) return null;
    return [
      画面へ(b.north, b.west), 画面へ(b.north, b.east),
      画面へ(b.south, b.east), 画面へ(b.south, b.west),
    ];
  })();

  // ── 建物を取り込む・2026-11-23 ──
  // 【ラスタの画像解析はしない】標準地図は基本測量成果で、しかも総描（デフォルメ）されている。
  //   ベクトルタイル（基本測量成果ではないと国土地理院が明記）を読むのが正しい。
  // 【変換は geoToGrid 1つ】ベクトルタイル側は緯度経度のまま返す。ここでグリッドへ直す。
  const 建物を取り込む = async () => {
    const b = 図面の範囲();
    if (!b) { setMsg('図面の範囲が決まっていません（先に「3次元範囲を設定」）'); return; }
    if (typeof gsiLoadBuildings !== 'function') { setMsg('ベクトルタイルの読み取りが読み込まれていません'); return; }
    if (typeof geoToGrid !== 'function') { setMsg('座標の変換が読み込まれていません'); return; }
    setBusy(true); setMsg('建物を取り寄せています…');
    try {
      const r = await gsiLoadBuildings(b, {
        onProgress: (i, n, c) => setMsg('タイル ' + i + '/' + n + '…（' + c + '件）'),
      });
      // 【ring 以外は機械的に運ぶ・2026-11-24】
      //   以前は { key, ftCode, 種別, points } と**書き写していた**ので、gsiTiles.js が
      //   高さ・色・意図（中心線・幅員区分）を渡すようにしても**ここで落ちていた**。
      //   足したものを書き忘れない形にする（solidModel の _作図の入力 と同じ作法）。
      const _グ = (a) => a.map(q => { const g = geoToGrid(q.lat, q.lng); return { x: g.x, y: g.y }; });
      const items = r.items.map(it => {
        const 他 = Object.assign({}, it); delete 他.ring; delete 他.中心線;
        // 【塗る面は中心線＋幅で運ぶ・2026-11-24】輪（ring）を持たないので points も作らない。
        //   帯は描く側（地面の canvas・平面図）が地面の起伏に乗せて作る。
        if (it.塗る && Array.isArray(it.中心線)) return Object.assign(他, { 中心線: _グ(it.中心線) });
        return Object.assign(他, { points: _グ(it.ring || []) });
      });
      const res = (typeof onBuildings === 'function') ? onBuildings(items) : null;
      const 内訳 = {};
      for (const it of items) 内訳[it.種別] = (内訳[it.種別] || 0) + 1;
      const 明細 = Object.keys(内訳).map(k => k + ' ' + 内訳[k]).join('・');
      const 行 = [];
      行.push('取り込み ' + ((res ? res.足した : items.length) + (res && res.塗り ? res.塗り : 0)) + ' 件'
        + (明細 ? '（' + 明細 + '）' : ''));
      if (res && res.塗り) 行.push('そのうち ' + res.塗り + ' 件は**地面に塗る面**です（厚みを持たせず、地面の起伏に沿って色を置きます）');
      // 【地面に乗せたかを言う・2026-11-27】地面がある状態で取り込むと「乗せますか？」と聞く（App の importMapBuildings）
      if (res && res.地面に乗せた) 行.push(res.地面に乗せた + ' 件は地面の上に乗せました');
      if (res && res.地面に乗せなかった) 行.push(res.地面に乗せなかった + ' 件は地面に乗せず、高さ 0m の基準面に置きました');
      if (res && res.重複) 行.push('すでにある ' + res.重複 + ' 件は足していません');
      if (res && res.重なり) 行.push('手で作った建屋と重なる ' + res.重なり + ' 件は足していません');
      if (r.穴) 行.push('中庭などの穴 ' + r.穴 + ' 件は落としました');
      if (r.切れ) 行.push('タイルの境目で切れた形 ' + r.切れ + ' 件（端がまっすぐに見えます）');
      if (res && res.交差) 行.push('形が自分と交わっていた ' + res.交差 + ' 件は落としました');
      if (r.上限超過) 行.push('上限に達したので途中で止めました（範囲を狭めてください）');
      // 【高さの知らせは「実データの高さを持たないもの」だけに言う・2026-11-24】
      //   道路は 0.12m の板なので『高さは仮の10m』は嘘になる（Codex監査の指摘）。
      const _仮の高さ = items.filter(it => !(typeof it.height === "number" && it.height > 0)).length;
      if (_仮の高さ) 行.push('そのうち ' + _仮の高さ + ' 件は高さが分からないので仮の '
        + (typeof NEW_BLD_H_M !== 'undefined' ? NEW_BLD_H_M : 10) + 'm です。建物エディタで直してください');
      // 道路は幅員**区分**からの推定（実幅員は配信されていない）。ずれる幅を数で言う
      const _幅推定 = items.filter(it => it.srcAdd && it.srcAdd.幅m).length;
      if (_幅推定) 行.push('道路 ' + _幅推定 + ' 件の幅は幅員区分からの推定です（区分の幅は最大 13m 幅なので±数mずれます）');
      行.push('出典: 国土地理院ベクトルタイル提供実験');
      setMsg(行.join('／'));
    } catch (e) { setMsg('取り込みに失敗: ' + (e && e.message)); }
    finally { setBusy(false); }
  };
  // ── 操作 ──
  const onDown = (e) => {
    if (e.button !== 0) return;
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (pickMode) {
      const p = 画面から(sx, sy);
      setPts(prev => {
        if (prev.length >= 2) return [p];
        const next = [...prev, p];
        if (next.length === 2) 範囲を確定(next[0], next[1]);
        return next;
      });
      return;
    }
    dragRef.current = { sx, sy, lat: view.lat, lng: view.lng };
    e.preventDefault();
  };
  const onMove = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (pickMode && pts.length === 1) setHover(画面から(sx, sy));
    const d = dragRef.current;
    if (!d) return;
    const fx = gsiLngToTileX(d.lng, z) - (sx - d.sx) / GSI_TILE_SIZE;
    const fy = gsiLatToTileY(d.lat, z) - (sy - d.sy) / GSI_TILE_SIZE;
    setView(v => ({ ...v, lng: gsiTileXToLng(fx, z), lat: gsiTileYToLat(fy, z) }));
  };
  const onUp = () => { dragRef.current = null; };
  const onWheel = (e) => {
    e.preventDefault();
    const r = boxRef.current.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const 下 = 画面から(sx, sy);                 // カーソルの下の点を保つ
    const nz = Math.max(5, Math.min(18, z + (e.deltaY < 0 ? 1 : -1)));
    if (nz === z) return;
    const ncx = gsiLngToTileX(下.lng, nz) - (sx - 半W) / GSI_TILE_SIZE;
    const ncy = gsiLatToTileY(下.lat, nz) - (sy - 半H) / GSI_TILE_SIZE;
    setView({ z: nz, lng: gsiTileXToLng(ncx, nz), lat: gsiTileYToLat(ncy, nz) });
  };

  // ── 3次元範囲を設定（2点の四角 → フィールド）──
  const 範囲を確定 = (p1, p2) => {
    const north = Math.max(p1.lat, p2.lat), south = Math.min(p1.lat, p2.lat);
    const west = Math.min(p1.lng, p2.lng), east = Math.max(p1.lng, p2.lng);
    const mPerDegLng = 111320 * Math.cos(((north + south) / 2) * Math.PI / 180);
    const 幅m = (east - west) * mPerDegLng, 高m = (north - south) * 111320;
    if (幅m < 1 || 高m < 1) { setMsg('範囲が小さすぎます。離れた2点を押してください'); setPts([]); return; }
    const poly = [
      { lat: north, lng: west }, { lat: north, lng: east },
      { lat: south, lng: east }, { lat: south, lng: west },
    ];
    const 文 = '3次元の範囲をこの四角にします。\n'
      + '  東西 ' + Math.round(幅m) + ' m ／ 南北 ' + Math.round(高m) + ' m\n\n'
      + '図面（平面図・3次元図）の座標がこの範囲に合わせ直され、\n画面を読み込み直します。よろしいですか？';
    setPickMode(false);
    setTimeout(() => {
      if (window.confirm(文)) {
        // 原点と縮尺を決める式は cesiumUtils.js の fieldFrameFromPolygon 1か所。
        // Cesium の多角形クリックと同じ道（commitFieldPolygon）を通る。
        commitFieldPolygon(poly);
      } else {
        setPts([]);
        setMsg('範囲の設定をやめました');
      }
    }, 0);
  };

  // ── 地面を作る（DEM を取得して3次元図へ）──
  const 地面を作る = async () => {
    const b = 図面の範囲();
    if (!b) { setMsg('図面の範囲が読めません'); return; }
    setMsg('');
    // 【格子の細かさ】面の数＝(格子-1)^2。回すたびに全部の面を投影し直す（1面4点）ので
    // ここが重さに直結する（格子 41 → 1600面／81 → 6400面）。
    // 値はメニューバー右端の歯車（SETTING_DEFS の「地形の細かさ」）から props で来る。
    // 範囲の丸めは App の uiSettingValue 1か所でやっているので、ここでは直さない。
    // 【取り込む格子は常に細かく・2026-11-23 ユーザー指摘】
    //   以前は歯車の「細かさ」をそのまま取り込む格子にしていたので、**取り込んだ格子より細かくは
    //   表示できず**、細かくするには「地面を作る」を押し直すしか無かった（荒くする方向だけ自由）。
    //   取り込みは1回なので常に上限で取り、**表示の細かさは歯車で後からいくらでも変えられる**ようにする。
    //   gridN（歯車の値）はここでは使わない＝表示側（App の terrainToMesh）が使う。
    const 格子 = gsiFetchGridFor(demSource);
    // 精度の高い順に重ねて読む（dem5a が無い画素は dem から）。
    // 「1種類で1枚でも取れたら打ち切る」にすると、取れなかったタイルの範囲が
    // 丸ごと欠けて平らになる（2026-11-23 ユーザー実機報告）。
    // どの標高タイルを使うかは歯車の「標高データ」（0=自動）
    const 種類ら = gsiDemKindsFor(demSource);
    const reader = await gsiLoadElevationStack(b, 種類ら, (k, 済, 全, 取れた) => {
      setBusy(k.note + ' ' + 済 + '/' + 全 + ' 枚' + (取れた ? '（取れた ' + 取れた + '）' : ''));
    });
    if (!reader) {
      setBusy(null);
      setMsg('この範囲の標高データが取れませんでした（海の上か、通信が通っていない可能性）');
      return;
    }
    // 取れなかった画素は 0m（海面）で埋める。dem（10mメッシュ）は全国整備なので、
    // そこまで落として取れない所は海。山あいで欠けるのは dem へ落ちる前の話で、
    // それは gsiLoadElevationStack が埋める（2026-11-23）。
    const data = gsiBuildElevationGrid(b, 格子, 格子, reader, { seaLevel: 0 });
    if (!data) {
      setBusy(null);
      setMsg('この範囲の標高データが取れませんでした');
      return;
    }
    setBusy(null);
    const 差 = (data.maxElevation - data.minElevation);
    const 内訳 = (reader.内訳 || []).map(x => x.note + ' ' + x.got + '/' + x.tiles).join('・');
    setMsg('地面を作りました：' + reader.kind + '／標高 '
      + data.minElevation.toFixed(1) + '〜' + data.maxElevation.toFixed(1) + ' m（高低差 ' + 差.toFixed(1) + ' m）'
      + '／3次元図の 0m ＝ この範囲の陸地の最低標高 ' + data.minElevation.toFixed(1) + ' m（海抜。海は基準に含めない）'
      + '／取り込み ' + 格子 + '×' + 格子 + ' 点（表示の細かさは設定で後から変えられます）'
      + '／タイル ' + 内訳
      + (data._gsi.missing ? '／取れなかった ' + data._gsi.missing + ' 点は 0m（海面）で埋めた' : ''));
    if (typeof onTerrain === 'function') onTerrain(data);
  };

  const ボタン = (色) => ({
    background: 色, color: '#fff', border: 'none', borderRadius: 3,
    padding: '3px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'sans-serif',
  });

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0f172a', color: '#e2e8f0' }}>
      {/* 道具 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 6px', background: '#1e293b', flexWrap: 'wrap' }}>
        <button data-gsi-btn="range" style={ボタン(pickMode ? 'rgba(234,88,12,0.95)' : 'rgba(59,130,246,0.85)')}
          onClick={() => { setPickMode(m => !m); setPts([]); setHover(null); setMsg(pickMode ? '' : '地図の上で2点を押してください（四角の対角）'); }}>
          {pickMode ? '範囲の指定をやめる' : '3次元範囲を設定'}
        </button>
        <button data-gsi-btn="ground" style={ボタン(busy ? 'rgba(100,116,139,0.8)' : 'rgba(22,163,74,0.9)')}
          disabled={!!busy} onClick={地面を作る}>
          {busy ? '取得中…' : '地面を作る'}
        </button>
        {(typeof window === 'undefined' || window.__GSI_BUILDINGS !== false) && (
          <button data-gsi-btn="buildings"
            style={ボタン(busy ? 'rgba(100,116,139,0.8)' : 'rgba(139,92,246,0.9)')}
            disabled={!!busy} onClick={建物を取り込む}>
            {busy ? '取得中…' : '建物を取り込む'}
          </button>
        )}
        {(typeof onRemoveBuildings === 'function') && (
          <button data-gsi-btn="buildings-clear"
            style={ボタン('rgba(239,68,68,0.6)')}
            onClick={() => {
              const n = onRemoveBuildings();
              setMsg(n ? ('取り込んだ建物 ' + n + ' 件を消しました') : '取り込んだ建物はありません');
            }}>
            取り込んだ建物を消す
          </button>
        )}
        {terrain && (
          <button data-gsi-btn="clear" style={ボタン('rgba(239,68,68,0.75)')}
            onClick={() => { if (typeof onTerrain === 'function') onTerrain(null); setMsg('地面を消しました'); }}>
            地面を消す
          </button>
        )}
        <span style={{ fontSize: 11, opacity: 0.8, marginLeft: 'auto' }}>
          ズーム {z}／{view.lat.toFixed(5)}, {view.lng.toFixed(5)}
        </span>
      </div>

      {/* 地図 */}
      <div ref={boxRef} data-gsi-map="1"
        style={{ position: 'relative', flex: 1, overflow: 'hidden', cursor: pickMode ? 'crosshair' : 'grab', background: '#1e293b' }}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
        {タイルら.map(t => (
          <img key={t.key} src={t.url} alt="" draggable={false}
            style={{ position: 'absolute', left: t.left, top: t.top, width: GSI_TILE_SIZE, height: GSI_TILE_SIZE, userSelect: 'none', pointerEvents: 'none' }} />
        ))}

        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {図面の枠 && (
            <polygon data-gsi="sheet" points={図面の枠.map(p => p.x + ',' + p.y).join(' ')}
              fill="rgba(56,189,248,0.10)" stroke="#38bdf8" strokeWidth={2} strokeDasharray="6 4" />
          )}
          {枠 && (
            <polygon data-gsi="field" points={枠.map(p => p.x + ',' + p.y).join(' ')}
              fill="rgba(250,204,21,0.08)" stroke="#facc15" strokeWidth={2} />
          )}
          {pts.length === 1 && hover && (() => {
            const a = 画面へ(pts[0].lat, pts[0].lng), b = 画面へ(hover.lat, hover.lng);
            return <rect data-gsi="pick" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)}
              width={Math.abs(a.x - b.x)} height={Math.abs(a.y - b.y)}
              fill="rgba(249,115,22,0.15)" stroke="#f97316" strokeWidth={2} />;
          })()}
          {pts.map((p, i) => {
            const s = 画面へ(p.lat, p.lng);
            return <circle key={i} cx={s.x} cy={s.y} r={4} fill="#f97316" stroke="#fff" strokeWidth={1.5} />;
          })}
        </svg>

        {/* 出典（地理院タイルの利用条件） */}
        <div style={{ position: 'absolute', right: 4, bottom: 3, fontSize: 10, background: 'rgba(15,23,42,0.75)', padding: '1px 5px', borderRadius: 3 }}>
          出典：<a href={GSI_ATTR_URL} target="_blank" rel="noreferrer" style={{ color: '#93c5fd' }}>{GSI_ATTR_TEXT}</a>
        </div>
      </div>

      {/* 知らせ */}
      <div style={{ fontSize: 11, padding: '3px 6px', background: '#1e293b', minHeight: 18, lineHeight: '14px' }}>
        {busy ? busy : (msg || (pickMode ? '地図の上で2点を押してください（四角の対角）' : '水色の点線＝いまの図面の範囲／黄色＝フィールド'))}
      </div>
    </div>
  );
}
