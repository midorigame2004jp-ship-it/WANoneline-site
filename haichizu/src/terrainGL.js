// terrainGL.js — 地面（地形）を WebGL で描く・2026-11-24 ユーザー指示「地面だけを WebGL の canvas にしてくれ」
// ════════════════════════════════════════════════════════════════
// 【なぜ WebGL か】canvas 2D は **1つの面が1色**。滑らかにするには面を細かく割るしかなく、
//   割った分だけ塗りが増えて重くなる（＝ユーザーの言う「重さと見た目のトレードオフ」）。
//   WebGL は**頂点の色を GPU が面の中で補間する**ので、面を増やさずに滑らかにできる。
//   国土地理院の3次元図が「なだらかで速い」のはこれ。
//
// 【この層がやること】地面の面だけ。建屋のSVG・盤のcanvas・道路の塗り（2D canvas）は触らない。
//   地面は一番下なので、重なり順は DOM の順で足りる。
//
// 【葉モジュール】ここから他のファイルを呼ばない。投影の行列は呼ぶ側が
//   geometry.js の makeProjMatrix で作って渡す（**式を2つ作らない**）。
//
// 【頂点は面ごとに4つ（共有しない）】隣の面と頂点を共有すると崖の折り目が作れない。
//   共有しない代わりに、**同じ位置の頂点に同じ色を入れれば滑らか**・
//   **違う色を入れれば段**になる。崖の判定は呼ぶ側が決める。
//
// 【単位】位置は (x, y) グリッド座標・z は**グリッドpx**（makeProjMatrix と同じ約束）。
// ════════════════════════════════════════════════════════════════

const TGL_VS = [
  'attribute vec3 aPos;',
  'attribute vec4 aCol;',
  'uniform mat4 uMVP;',
  'varying vec4 vCol;',
  'void main() {',
  '  gl_Position = uMVP * vec4(aPos, 1.0);',
  '  vCol = aCol;',
  '}',
].join('\n');

const TGL_FS = [
  'precision mediump float;',
  'varying vec4 vCol;',
  'void main() { gl_FragColor = vCol; }',
].join('\n');

function _tglShader(gl, 種, src) {
  const sh = gl.createShader(種);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('シェーダ: ' + log);
  }
  return sh;
}

// WebGL を用意する。使えなければ null（呼ぶ側が canvas 2D に落ちる）
function terrainGLCreate(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let gl = null;
  try {
    // 【MSAA は既定で切る・2026-11-24】96万頂点では GPU 側（program）の負担が大きい。
    //   window.__TERRAIN_GL_AA = true で入れられる（見た目のギザギザが気になるとき）。
    const _aa = (typeof window !== 'undefined' && window.__TERRAIN_GL_AA === true);
    const o = { alpha: true, antialias: _aa, depth: true, premultipliedAlpha: true };
    gl = canvas.getContext('webgl', o) || canvas.getContext('experimental-webgl', o);
  } catch (e) { return null; }
  if (!gl) return null;
  let prog;
  try {
    const vs = _tglShader(gl, gl.VERTEX_SHADER, TGL_VS);
    const fs = _tglShader(gl, gl.FRAGMENT_SHADER, TGL_FS);
    prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('リンク: ' + log);
    }
  } catch (e) {
    return { gl: null, 失敗: String(e && e.message).slice(0, 120) };
  }
  return {
    gl, prog,
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aCol: gl.getAttribLocation(prog, 'aCol'),
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    bufPos: gl.createBuffer(),
    bufCol: gl.createBuffer(),
    数: 0, 版: null,
  };
}

// 頂点を送る。pos は Float32Array（x,y,z の並び）、col は Uint8Array（r,g,b,a の並び）
// 【版】同じ版なら送り直さない（カメラが動いただけなら行列だけ送れば済む）
function terrainGLUpload(G, pos, col, 版) {
  if (!G || !G.gl) return false;
  const gl = G.gl;
  if (版 != null && G.版 === 版) { G.送った = false; return true; }
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufPos);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufCol);
  gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
  G.数 = (pos.length / 3) | 0;
  G.版 = (版 != null) ? 版 : null;
  G.送った = true;   // 観測用（カメラだけ動いた回は false ＝行列だけで済んでいる）
  return true;
}

// 描く。mat は列優先の16要素（makeProjMatrix が返す物）
// 【canvas の大きさ】変わったときだけ代入する（毎回代入すると中身が消えて点滅する）
function terrainGLDraw(G, mat, cw, ch, dpr) {
  if (!G || !G.gl || !G.数) return 0;
  const gl = G.gl, cv = gl.canvas;
  const w = Math.max(1, Math.round(cw * (dpr || 1)));
  const h = Math.max(1, Math.round(ch * (dpr || 1)));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  // 【裏面を落とさない】地下から見ると回り方が反転する。2D 版も裏表を見ていない
  gl.disable(gl.CULL_FACE);
  gl.useProgram(G.prog);
  gl.uniformMatrix4fv(G.uMVP, false, mat);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufPos);
  gl.enableVertexAttribArray(G.aPos);
  gl.vertexAttribPointer(G.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufCol);
  gl.enableVertexAttribArray(G.aCol);
  gl.vertexAttribPointer(G.aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, G.数);
  return G.数;
}

function terrainGLClear(G) {
  if (!G || !G.gl) return;
  const gl = G.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
}

// quad の列から頂点を作る（面ごとに三角形2つ＝6頂点。共有しない）
// 色は 色を決める(q, 隅) → [r,g,b] を呼ぶ。隅は 0..3（q の p0..p3 の順）
// 【段階1】隅によらず同じ色を返せば**いまの canvas 2D と同じ見た目**（面ごとに単色）。
// 【段階2】隅ごとに違う色を返せば GPU が補間して**滑らか**になる。
function terrainGLBuild(quads, 色を決める) {
  const n = quads.length;
  const pos = new Float32Array(n * 6 * 3);
  const col = new Uint8Array(n * 6 * 4);
  let pi = 0, ci = 0;
  const 置 = (x, y, z, c) => {
    pos[pi++] = x; pos[pi++] = y; pos[pi++] = z;
    col[ci++] = c[0]; col[ci++] = c[1]; col[ci++] = c[2]; col[ci++] = 255;
  };
  for (let i = 0; i < n; i++) {
    const q = quads[i];
    const c0 = 色を決める(q, 0), c1 = 色を決める(q, 1);
    const c2 = 色を決める(q, 2), c3 = 色を決める(q, 3);
    // 三角形1: p0 p1 p2
    置(q.x0, q.y0, q.z0, c0); 置(q.x1, q.y1, q.z1, c1); 置(q.x2, q.y2, q.z2, c2);
    // 三角形2: p0 p2 p3
    置(q.x0, q.y0, q.z0, c0); 置(q.x2, q.y2, q.z2, c2); 置(q.x3, q.y3, q.z3, c3);
  }
  return { pos, col, 頂点: n * 6 };
}

// ══ 色ピッキング・2026-11-24 ══
// 【なぜ要るか】WebGL のキャンバスは1枚の絵なので、SVG の pointer-events が使えない。
//   面ごとの id を色として描いて、マウスの下の 1px を読めば「どの面か」が分かる。
//   Fusion360・Onshape・SketchUp も同じやり方。
// 【readPixels は GPU を待つ】同期処理なので mousemove ごとに呼ぶと逆に重い。
//   呼ぶ側が **rAF で1フレーム1回**に間引くこと。
// 【x, y は canvas の画素】左上原点。WebGL は左下原点なので中で直す。
// 戻り: 読んだ色 [r,g,b,a]（id に直すのは呼ぶ側）。読めなければ null
function terrainGLReadPixel(G, x, y) {
  if (!G || !G.gl) return null;
  const gl = G.gl, cv = gl.canvas;
  const px = Math.max(0, Math.min(cv.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(cv.height - 1, Math.round(cv.height - 1 - y)));
  const buf = new Uint8Array(4);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return [buf[0], buf[1], buf[2], buf[3]];
}
// id（1以上の整数）と色の相互変換。0 は「何も無い」
function glIdToColor(id) { return [(id >> 16) & 255, (id >> 8) & 255, id & 255]; }
function glColorToId(c) { return c ? ((c[0] << 16) | (c[1] << 8) | c[2]) : 0; }