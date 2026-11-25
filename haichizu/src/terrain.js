// ===== 地形関数 =====
function parseTerrainJSON(data) {
  const { bounds, step, cols, rows, elevations, minElevation, maxElevation } = data;
  const baseElev = minElevation;
  const elevRange = maxElevation - minElevation || 1;
  return { bounds, step, cols, rows, elevations, baseElev, elevRange, minElevation, maxElevation };
}

function terrainToMesh(terrain, worldW, worldH, exaggeration = 1) {
  const { cols, rows, elevations, baseElev, elevRange } = terrain;
  const cellW = worldW / (cols - 1);
  const cellH = worldH / (rows - 1);
  // 1m の標高差 = 1px のZ差 × exaggeration
  const zScale = exaggeration;
  const quads = [];
  const STEP = Math.max(1, Math.floor(Math.max(cols, rows) / 80));
  for (let r = 0; r < rows - STEP; r += STEP) {
    for (let c = 0; c < cols - STEP; c += STEP) {
      const r2 = Math.min(r + STEP, rows - 1);
      const c2 = Math.min(c + STEP, cols - 1);
      const e00 = elevations[r][c] - baseElev;
      const e10 = elevations[r][c2] - baseElev;
      const e01 = elevations[r2][c] - baseElev;
      const e11 = elevations[r2][c2] - baseElev;
      const avgE = (e00 + e10 + e01 + e11) / 4;
      const t = avgE / (elevRange || 1);
      quads.push({
        x0: c * cellW, y0: r * cellH, z0: e00 * zScale,
        x1: c2 * cellW, y1: r * cellH, z1: e10 * zScale,
        x2: c2 * cellW, y2: r2 * cellH, z2: e11 * zScale,
        x3: c * cellW, y3: r2 * cellH, z3: e01 * zScale,
        t,
      });
    }
  }
  return { quads, zScale };
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

