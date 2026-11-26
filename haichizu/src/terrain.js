// ===== 地形関数 =====
// 陰影の光の向き（正規化済み。北西の斜め上から。図面の y は南向きなので ly は負＝北側）
// 【陰影の基準勾配・2026-11-23】この勾配（高さ÷水平距離）で明暗が振り切れる。
// 0.25 ＝ 1マスで 25% 上がる斜面が真っ黒／真っ白。大分の 1.5m 盛土（2.9m 格子で勾配0.52）は
// 片側 0.86・反対側 0（飽和）になり、平地のざらつき（2cm＝勾配0.007）は 0.5 のまま＝見分けられる。
// globalThis.__TERRAIN_SHADE_SLOPE で変えられる（調べるとき用。歯車には出さない）。
const SHADE_REF_SLOPE = 0.25;
const LIGHT = (() => { const v = [-0.45, -0.6, 0.66]; const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; })();
function parseTerrainJSON(data) {
  const { bounds, step, cols, rows, elevations, minElevation, maxElevation } = data;
  const baseElev = minElevation;
  const elevRange = maxElevation - minElevation || 1;
  return { bounds, step, cols, rows, elevations, baseElev, elevRange, minElevation, maxElevation };
}

// 【高さの単位・2026-11-22 advisor監査】terrain の elevations は**メートル**。
// 3次元図の proj が受けるのは**グリッドpx**なので、呼び手が mToPx（1m が何px か＝建屋と同じ
// _bldZPx(1)）を渡す。従来は zScale=exaggeration のままで、1px=0.1m の図面では実寸の 1/10 に
// なっていた（建屋で 2026-09-22 に直したのと同じ型）。葉モジュールなので window は読まない。
// maxDiv = 表示の分割数の上限。既定 80 は従来互換。
// 【2026-11-23 ユーザー報告「1mメッシュでも粗い」】ここが 80 固定だったので、
//   歯車の「細かさ」を 161 にしても表示は 80×80（約7m間隔）に間引かれていた＝設定が効いていなかった。
function terrainToMesh(terrain, worldW, worldH, exaggeration = 1, mToPx = 1, maxDiv = 80) {
  const { cols, rows, elevations, baseElev, elevRange } = terrain;
  const cellW = worldW / (cols - 1);
  const cellH = worldH / (rows - 1);
  // 標高差(m) × 強調倍率 × (1m あたりのグリッドpx)
  const zScale = exaggeration * (Number.isFinite(mToPx) && mToPx > 0 ? mToPx : 1);
  // グリッド1px の実寸（m）。陰影の傾きをメートルどうしの比で出すのに使う
  const mPerPx = (Number.isFinite(mToPx) && mToPx > 0) ? (1 / mToPx) : 1;
  const quads = [];
  // 【格子点（頂点）の明るさ・2026-11-24】面ごとでなく**点ごと**に傾きを出す。
   //   隣の面と同じ点を見るので明るさが連続＝GPU が補間して**モザイクが消える**。
   //   差分は**表示の格子（±STEP）**で取る（±1 だと描かれた形と陰影が食い違う）。外周は片側差分。
   //   旗 globalThis.__TERRAIN_VTX_SHADE = false で面ごとだけ（＝従来）。
  const _頂点陰 = !(typeof globalThis !== 'undefined' && globalThis.__TERRAIN_VTX_SHADE === false);
  const _点の明るさ = (r, c, STEP) => {
    const rm = Math.max(0, r - STEP), rp = Math.min(rows - 1, r + STEP);
    const cm = Math.max(0, c - STEP), cp = Math.min(cols - 1, c + STEP);
    const 幅m = cellW * (cp - cm) * mPerPx, 高m = cellH * (rp - rm) * mPerPx;
    const dzdx = 幅m > 0 ? (elevations[r][cp] - elevations[r][cm]) * exaggeration / 幅m : 0;
    const dzdy = 高m > 0 ? (elevations[rp][c] - elevations[rm][c]) * exaggeration / 高m : 0;
    const nx = -dzdx, ny = -dzdy;
    const nl = Math.sqrt(nx * nx + ny * ny + 1) || 1;
    return Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / nl);
  };
  const _div = Math.max(4, Math.min(1024, Math.round(maxDiv) || 80));
  const STEP = Math.max(1, Math.round((Math.max(cols, rows) - 1) / Math.max(1, _div - 1))); // 区間数で割る（floor(401/81)=4 だと100分割になってずれる）
  for (let r = 0; r < rows - STEP; r += STEP) {
    for (let c = 0; c < cols - STEP; c += STEP) {
      const r2 = Math.min(r + STEP, rows - 1);
      const c2 = Math.min(c + STEP, cols - 1);
      const e00 = elevations[r][c] - baseElev;
      const e10 = elevations[r][c2] - baseElev;
      const e01 = elevations[r2][c] - baseElev;
      const e11 = elevations[r2][c2] - baseElev;
      const avgE = (e00 + e10 + e01 + e11) / 4;
      // 基準（陸地の最低標高）より低い所（海）は負になるので 0〜1 に収める
      const t = Math.max(0, Math.min(1, avgE / (elevRange || 1)));
      // 【陰影・2026-11-23 ユーザー報告「3Dで見ると丘なのに3次元図は平坦に見える」】
      // 実寸（1km四方に高低差100m＝約10%）だと、色だけでは起伏が読めない。
      // 面の傾きから明るさを出して色に掛ける＝国土地理院の3次元地図と同じ見え方にする。
      // 傾きはメートルどうしの比で出す（cellW はグリッドpx なので実寸へ直す）。
      const 面幅m = cellW * (c2 - c) * mPerPx, 面高m = cellH * (r2 - r) * mPerPx;
      // 【強調は陰影にも効かせる・2026-11-23 ユーザー報告「強調を10にしてもだめ」】
      // 以前は z（高さ）にだけ強調を掛け、陰影の傾きは実寸のままだった。
      // 実寸の 2m の盛土は 7m 間隔の格子で明暗差が 6% しかなく、段に丸めると消えていた。
      const dzdx = 面幅m > 0 ? (((e10 + e11) - (e00 + e01)) / 2) * exaggeration / 面幅m : 0;
      const dzdy = 面高m > 0 ? (((e01 + e11) - (e00 + e10)) / 2) * exaggeration / 面高m : 0;
      const nx = -dzdx, ny = -dzdy, nz = 1;
      const nl = Math.sqrt(nx * nx + ny * ny + 1) || 1;
      // 光は北西の斜め上から（図面の y は南向きなので ly は負＝北から）
      const 明るさ = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl);
      quads.push({
        x0: c * cellW, y0: r * cellH, z0: e00 * zScale,
        x1: c2 * cellW, y1: r * cellH, z1: e10 * zScale,
        x2: c2 * cellW, y2: r2 * cellH, z2: e11 * zScale,
        x3: c * cellW, y3: r2 * cellH, z3: e01 * zScale,
        t, 明るさ,
        // 4隅の明るさ（p0=(r,c) p1=(r,c2) p2=(r2,c2) p3=(r2,c)）。正規化は下で面と同じ式を通す
        明0: _頂点陰 ? _点の明るさ(r, c, STEP) : 明るさ,
        明1: _頂点陰 ? _点の明るさ(r, c2, STEP) : 明るさ,
        明2: _頂点陰 ? _点の明るさ(r2, c2, STEP) : 明るさ,
        明3: _頂点陰 ? _点の明るさ(r2, c, STEP) : 明るさ,
      });
    }
  }
  // 【明るさの正規化・2026-11-23】平らな土地だと明るさが 0.66〜0.76 のように狭い範囲に固まり、
  //   段に丸めると全部同じ色になって「のっぺり」する。その地形の中の最小〜最大を 0〜1 に引き伸ばす。
  //   起伏が全く無ければ 0.5（真ん中の明るさ）。
  // 【5%〜95% で引き伸ばす・2026-11-23】最小〜最大だと、1か所の急な崖が外れ値になって
  //   他の面が全部まん中に潰れる（白い配色で「ほとんど真っ白」になっていた原因）。
  //   両端を切って引き伸ばし、はみ出した分は 0/1 で止める。
  const 明ら = quads.map(q => q.明るさ).sort((a, b) => a - b);
  const 明小 = 明ら.length ? 明ら[Math.floor(明ら.length * 0.05)] : 0;
  const 明大 = 明ら.length ? 明ら[Math.floor(明ら.length * 0.95)] : 1;
  const 明幅 = 明大 - 明小;
  // 【明るさは絶対基準にする・2026-11-23 ユーザー報告「1.5mの盛土がほぼ平ら」／監査で発生源と判定】
  //   上の相対正規化（その地形の 5%〜95% を 0〜1 に引き伸ばす）が発生源だった。
  //   敷地の大半が平らだと、幅を決めるのは**平地の数cmのざらつき**なので、それが画面いっぱいに
  //   引き伸ばされ、**2cm の凹凸と 1.5m の盛土が同じ濃さ**で出ていた。
  //   実測（大分・576m×403m）: 生の明るさの幅は 0.064（6%）しかなく、それを 100% に増幅していた。
  //   ＝以前のご裁定「山の高さを基準にしているから 50cm・120cm の差が見えない」と同じ型の違反。
  //   【直し方】平らな面を必ず 0.5（＝地色そのまま）にし、基準勾配で 0/1 に達する。範囲外は止める。
  //   地形によらず「同じ傾き＝同じ濃さ」になるので、盛土はどの図でも同じ濃さで出る
  //   （国土地理院の3次元地図可視化サイトの「陰影」と同じ考え方）。
  //   あわせて、上の 傾き×強調 がここで初めて意味を持つ（相対正規化では引き伸ばし直されて消えていた）。
  const 絶対 = !(typeof globalThis !== 'undefined' && globalThis.__TERRAIN_SHADE_ABS === false);
  if (絶対) {
    const 平 = LIGHT[2];   // 平らな面（傾き0）の明るさ＝光の真上成分
    const 基準勾配 = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__TERRAIN_SHADE_SLOPE))
      ? Math.max(0.01, globalThis.__TERRAIN_SHADE_SLOPE) : SHADE_REF_SLOPE;
    // 傾き s の面は、光と正対する向きで明るさが平地から最大 s×√(Lx²+Ly²) ずれる（緩い傾きの一次近似）
    const 幅 = Math.max(1e-6, 基準勾配 * Math.hypot(LIGHT[0], LIGHT[1]));
    // 【面と4隅を同じ式で】別の式にすると、旗の ON/OFF で濃さが変わる（Codex監査の条件）
    const _正 = (v) => Math.max(0, Math.min(1, 0.5 + (v - 平) / (2 * 幅)));
    for (const q of quads) {
      q.明るさ = _正(q.明るさ);
      q.明0 = _正(q.明0); q.明1 = _正(q.明1); q.明2 = _正(q.明2); q.明3 = _正(q.明3);
    }
  } else {
    const _正2 = (v) => (明幅 > 1e-6) ? Math.max(0, Math.min(1, (v - 明小) / 明幅)) : 0.5;
    for (const q of quads) {
      q.明0 = _正2(q.明0); q.明1 = _正2(q.明1); q.明2 = _正2(q.明2); q.明3 = _正2(q.明3);
      q.明るさ = (明幅 > 1e-6) ? Math.max(0, Math.min(1, (q.明るさ - 明小) / 明幅)) : 0.5;
    }
  }
  return { quads, zScale, 明の範囲: [明小, 明大] };
}

// ── 地形の配色（2026-11-23 ユーザー要望「緑赤以外の表示方法も設定で選べるように」）──
// 【表1つ】増やすときはここに1行。歯車の選択肢もここから作る。
//   単色: true のものは標高で色を変えない＝**陰影だけで形を見る**（国土地理院の3次元地図に近い）。
const TERRAIN_PALETTES = [
  { id: 0, label: '段彩（緑→茶）', fn: (t) => terrainColor(t) },
  { id: 1, label: '白（陰影だけ・3次元感が出る）', 単色: true, fn: () => 'rgb(232,232,228)' },
  { id: 2, label: '土色（陰影だけ）', 単色: true, fn: () => 'rgb(198,178,150)' },
  { id: 3, label: '段彩（青→緑→茶→白）', fn: (t) => terrainColorAlt(t) },
  // 濃淡の幅は控えめに（真っ黒〜真っ白だと陰影が潰れて凹凸が読みにくい・2026-11-23）
  { id: 4, label: 'グレー（濃淡だけ）', fn: (t) => { const v = Math.round(222 - 72 * Math.max(0, Math.min(1, t))); return 'rgb(' + v + ',' + v + ',' + v + ')'; } },
  { id: 5, label: '地面色（単色・陰影なしでも平ら）', 単色: true, fn: () => 'rgb(214,208,196)' },
];
// ══ 任意の点の地面の高さ・2026-11-24 ══
// 【なぜ要るか】道路を「地面に塗る面」にするのに、折れ線の各点の高さが要る。
// 【表示と同じ格子で引く】面は maxDiv で間引かれている（terrainToMesh の STEP）。
//   元の細かい標高で引くと、**描かれた地面から道路がずれる**（Codex監査の必須条件）。
//   だから同じ STEP の升目の四隅から双線形で補間する＝面の四隅と必ず一致する。
// 戻り: グリッドpx（z の単位。terrainToMesh の zScale と同じ扱い）。terrain が無ければ 0
function terrainStep(terrain, maxDiv) {
  const _div = Math.max(4, Math.min(1024, Math.round(maxDiv) || 80));
  return Math.max(1, Math.round((Math.max(terrain.cols, terrain.rows) - 1) / Math.max(1, _div - 1)));
}
function terrainZAt(terrain, worldW, worldH, x, y, exaggeration = 1, mToPx = 1, maxDiv = 80) {
  if (!terrain || !terrain.elevations || !terrain.cols || !terrain.rows) return 0;
  const { cols, rows, elevations, baseElev } = terrain;
  const STEP = terrainStep(terrain, maxDiv);
  const cellW = worldW / (cols - 1), cellH = worldH / (rows - 1);
  const c = Math.max(0, Math.min(cols - 1, x / (cellW || 1)));
  const r = Math.max(0, Math.min(rows - 1, y / (cellH || 1)));
  const c0 = Math.min(cols - 1, Math.floor(c / STEP) * STEP);
  const r0 = Math.min(rows - 1, Math.floor(r / STEP) * STEP);
  const c1 = Math.min(cols - 1, c0 + STEP), r1 = Math.min(rows - 1, r0 + STEP);
  const fx = (c1 > c0) ? (c - c0) / (c1 - c0) : 0;
  const fy = (r1 > r0) ? (r - r0) / (r1 - r0) : 0;
  const e = (rr, cc) => (elevations[rr] && Number.isFinite(elevations[rr][cc]))
    ? (elevations[rr][cc] - baseElev) : 0;
  const z = e(r0, c0) * (1 - fx) * (1 - fy) + e(r0, c1) * fx * (1 - fy)
          + e(r1, c0) * (1 - fx) * fy + e(r1, c1) * fx * fy;
  return z * exaggeration * ((Number.isFinite(mToPx) && mToPx > 0) ? mToPx : 1);
}
// 折れ線を「地面の格子の間隔」で刻む（頂点だけ地面に乗せると長い直線の途中が浮く／埋もれる）
// 戻り: 刻んだ点列（入力と同じ形）。terrain が無ければそのまま返す
function terrainResample(pts, terrain, worldW, worldH, maxDiv = 80) {
  if (!pts || pts.length < 2) return pts || [];
  if (!terrain || !terrain.cols || !terrain.rows) return pts;
  const STEP = terrainStep(terrain, maxDiv);
  const 刻 = Math.max(1e-6, Math.min(worldW / (terrain.cols - 1) * STEP,
                                     worldH / (terrain.rows - 1) * STEP));
  const 出 = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.min(400, Math.max(1, Math.ceil(L / 刻)));
    for (let k = 1; k <= n; k++) 出.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  return 出;
}
function terrainPalette(id) {
  const n = Number(id);
  return TERRAIN_PALETTES.find(p => p.id === n) || TERRAIN_PALETTES[0];
}
// 地図でよく使う標高の段彩（低い＝青緑／中＝緑→黄／高い＝茶→白）
function terrainColorAlt(t) {
  const x = Math.max(0, Math.min(1, t));
  const 点 = [
    [0.00, [120, 170, 190]], [0.15, [110, 165, 120]], [0.40, [190, 200, 120]],
    [0.65, [190, 150, 95]], [0.85, [160, 120, 95]], [1.00, [240, 240, 240]],
  ];
  for (let i = 1; i < 点.length; i++) {
    if (x <= 点[i][0]) {
      const a = 点[i - 1], b = 点[i];
      const u = (x - a[0]) / ((b[0] - a[0]) || 1);
      const v = (j) => Math.round(a[1][j] + (b[1][j] - a[1][j]) * u);
      return 'rgb(' + v(0) + ',' + v(1) + ',' + v(2) + ')';
    }
  }
  return 'rgb(240,240,240)';
}

// ── 等高線（2026-11-23 ユーザー要望）──
// 【なぜ要るか】「50cm・120cm の段差をこだわりたい」。色や陰影は相対的なので絶対値が読めないが、
//   等高線なら「この線とこの線の間が 50cm」と**数で**分かる。
// 各セルの4辺で等高線の高さをまたぐ所を補間して線分にする（マーチングスクエアの簡易版）。
// 返すのは図面座標の線分 [{x,y,z},{x,y,z}]。z は terrainToMesh と同じ尺度。
function terrainContourSegs(terrain, worldW, worldH, interval, exaggeration = 1, mToPx = 1, maxDiv = 80) {
  const { cols, rows, elevations, baseElev, minElevation, maxElevation } = terrain;
  if (!(interval > 0) || !elevations || cols < 2 || rows < 2) return [];
  const zScale = exaggeration * (Number.isFinite(mToPx) && mToPx > 0 ? mToPx : 1);
  const _div = Math.max(4, Math.min(1024, Math.round(maxDiv) || 80));
  const STEP = Math.max(1, Math.round((Math.max(cols, rows) - 1) / Math.max(1, _div - 1))); // 区間数で割る（floor(401/81)=4 だと100分割になってずれる）
  const cellW = worldW / (cols - 1), cellH = worldH / (rows - 1);
  const segs = [];
  const 上限 = 400; // 本数が増えすぎないように（間隔が細かすぎるとき）
  let 本 = 0;
  for (let v = Math.ceil(minElevation / interval) * interval; v <= maxElevation; v += interval) {
    if (++本 > 上限) break;
    const z = (v - baseElev) * zScale;
    for (let r = 0; r + STEP < rows; r += STEP) {
      for (let c = 0; c + STEP < cols; c += STEP) {
        const r2 = Math.min(r + STEP, rows - 1), c2 = Math.min(c + STEP, cols - 1);
        const P = [
          { x: c * cellW, y: r * cellH }, { x: c2 * cellW, y: r * cellH },
          { x: c2 * cellW, y: r2 * cellH }, { x: c * cellW, y: r2 * cellH },
        ];
        const H = [elevations[r][c], elevations[r][c2], elevations[r2][c2], elevations[r2][c]];
        const 交 = [];
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          const h1 = H[i], h2 = H[j];
          if ((h1 - v) * (h2 - v) < 0) {
            const u = (v - h1) / ((h2 - h1) || 1);
            交.push({ x: P[i].x + (P[j].x - P[i].x) * u, y: P[i].y + (P[j].y - P[i].y) * u, z });
          }
        }
        if (交.length >= 2) segs.push([交[0], 交[1]]);
        if (交.length === 4) segs.push([交[2], 交[3]]);
      }
    }
  }
  return segs;
}

// ── 崖（地形の外周を下まで落とす側面）──
// 地形が紙のように薄く見えるのを防ぎ、厚みを出す。底は最低標高。
function terrainSkirtQuads(terrain, worldW, worldH, exaggeration = 1, mToPx = 1, maxDiv = 80) {
  const { cols, rows, elevations, baseElev } = terrain;
  if (!elevations || cols < 2 || rows < 2) return [];
  const zScale = exaggeration * (Number.isFinite(mToPx) && mToPx > 0 ? mToPx : 1);
  const _div = Math.max(4, Math.min(1024, Math.round(maxDiv) || 80));
  const STEP = Math.max(1, Math.round((Math.max(cols, rows) - 1) / Math.max(1, _div - 1))); // 区間数で割る（floor(401/81)=4 だと100分割になってずれる）
  const cellW = worldW / (cols - 1), cellH = worldH / (rows - 1);
  const 底 = 0; // baseElev を引いた座標での 0＝一番低い所
  const out = [];
  const 面 = (ax, ay, ae, bx, by, be) => out.push({
    x0: ax, y0: ay, z0: (ae - baseElev) * zScale,
    x1: bx, y1: by, z1: (be - baseElev) * zScale,
    x2: bx, y2: by, z2: 底, x3: ax, y3: ay, z3: 底,
  });
  for (let c = 0; c + STEP < cols; c += STEP) {
    const c2 = Math.min(c + STEP, cols - 1);
    面(c * cellW, 0, elevations[0][c], c2 * cellW, 0, elevations[0][c2]);
    面(c * cellW, (rows - 1) * cellH, elevations[rows - 1][c], c2 * cellW, (rows - 1) * cellH, elevations[rows - 1][c2]);
  }
  for (let r = 0; r + STEP < rows; r += STEP) {
    const r2 = Math.min(r + STEP, rows - 1);
    面(0, r * cellH, elevations[r][0], 0, r2 * cellH, elevations[r2][0]);
    面((cols - 1) * cellW, r * cellH, elevations[r][cols - 1], (cols - 1) * cellW, r2 * cellH, elevations[r2][cols - 1]);
  }
  return out;
}

function terrainColor(t) {
  if (t < 0.33) {
    const s = t / 0.33;
    return `rgb(${Math.round(80 + s * 100)},${Math.round(160 - s * 30)},${Math.round(60 - s * 20)})`;
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return `rgb(${Math.round(180 + s * 40)},${Math.round(130 - s * 30)},${Math.round(40 - s * 10)})`;
  }
  const s = (t - 0.66) / 0.34;
  return `rgb(${Math.round(220 - s * 20)},${Math.round(100 - s * 30)},${Math.round(30 + s * 20)})`;
}

