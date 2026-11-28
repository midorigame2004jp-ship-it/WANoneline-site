// solidsGL.js — 3次元図の建物の面を WebGL（GPU）で描く・2026-11-28 ユーザー要望
//   「画像の規模にしたらさすがに重くなったが、これでも軽くないと困るんだが。国土地理院の地球儀モードのように軽くできんのか。」
// ════════════════════════════════════════════════════════════════
// 【地球儀モードが軽い理由＝ここでやること】形（頂点）は1回だけ GPU に置き、カメラが動いたら
//   「見る向き（行列）」だけを送る。canvas 2D や SVG は、カメラが1コマ動くたびに全部の面を
//   JS で投影して線を引き直すので、面の数に比例して重くなる。
//
// 【見た目は SVG と同じ決め方】
//   - 面の色・不透明度・線は App.jsx の _cabFaceLook（SVG・canvas と同じ1か所）を、形を置くときに1回だけ呼ぶ。
//   - 描く・描かない（裏面）と円柱の側面の束ね方は _cabSolidsPlan（同じ1か所）を、並べ直すたびに呼ぶ。
//   - 並べ方も同じ painter's（奥→手前）。**深度テストは使わない**：建物は半透明なので、
//     重なった面の透け方を SVG と同じにするには、奥から順に重ねるしかない。
//   ＝この層が独自に決めるのは「三角形に割る」「線を細い四角にする」だけ。
//
// 【葉モジュール】ここから他のファイルを呼ばない。行列は geometry.js の makeProjMatrix
//   （地面の WebGL と同じ式）を呼ぶ側が作って渡す。
//
// 【毎コマの仕事】
//   - 移動・拡大縮小（向きが同じ）: 行列を送って描くだけ（並べ順は変わらない＝平行投影）
//   - 回転（向きが変わる）: 面ごとの奥行き（重心の1点）と回り方（面積ベクトルとの内積）を
//     計算して並べ直し、並べ順どおりの三角形の番号の列だけを送り直す（頂点は送らない）。
// ════════════════════════════════════════════════════════════════

const SGL_VS = [
  'attribute vec3 aPos;',
  'attribute vec3 aOther;',   // 線のとき: 線分の反対の端（面のときは aPos と同じ）
  'attribute float aSide;',   // 線のとき: ±（線の太さ・CAB 座標）。面のときは 0
  'attribute vec4 aCol;',
  'uniform mat4 uMVP;',
  'uniform vec2 uHalfView;',  // canvas の画素の半分（幅/2, 高さ/2）
  'uniform float uPxPerCab;', // CAB 座標 1 が canvas の何画素か（letterbox の sc × dpr）
  'varying vec4 vCol;',
  'void main() {',
  '  vec4 p = uMVP * vec4(aPos, 1.0);',
  '  float k = 1.0;',
  '  if (aSide != 0.0) {',
  '    vec4 q = uMVP * vec4(aOther, 1.0);',
  '    vec2 d = (q.xy - p.xy) * uHalfView;',
  '    float L = length(d);',
  // 1画素より細い線は 1画素の太さで描き、濃さを細さの分だけ薄くする（canvas 2D・SVG のぼかしと同じ見え方）
  '    float w = abs(aSide) * uPxPerCab;',
  '    float wd = max(w, 1.0);',
  '    k = w / wd;',
  '    if (L > 1e-6) {',
  '      vec2 n = vec2(-d.y, d.x) / L;',
  '      p.xy += n * (0.5 * sign(aSide) * wd) / uHalfView;',
  '    }',
  '  }',
  // 奥行きは使わない（painter's で並べてある）。0 にして奥行きの範囲で切られないようにする
  '  gl_Position = vec4(p.xy, 0.0, 1.0);',
  '  vCol = vec4(aCol.rgb, aCol.a * k);',
  '}',
].join('\n');

// premultipliedAlpha の canvas なので、色に不透明度を掛けて出す（混ぜ方は ONE, ONE_MINUS_SRC_ALPHA）
const SGL_FS = [
  'precision mediump float;',
  'varying vec4 vCol;',
  'void main() { gl_FragColor = vec4(vCol.rgb * vCol.a, vCol.a); }',
].join('\n');

function _sglShader(gl, 種, src) {
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

// WebGL を用意する。使えなければ { gl: null, 失敗 }（呼ぶ側が canvas 2D に落ちる）
function solidsGLCreate(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return { gl: null, 失敗: 'canvas が無い' };
  let gl = null;
  try {
    // 縁のギザギザを canvas 2D・SVG に近づけるため MSAA を入れる（頂点数は地面よりずっと少ない）。
    //   window.__CAB_SOLIDS_GL_AA = false で切る（GPU の仕事を減らす）
    const _aa = !(typeof window !== 'undefined' && window.__CAB_SOLIDS_GL_AA === false);
    const o = { alpha: true, antialias: _aa, depth: false, stencil: false, premultipliedAlpha: true };
    gl = canvas.getContext('webgl', o) || canvas.getContext('experimental-webgl', o);
  } catch (e) { return { gl: null, 失敗: String(e && e.message).slice(0, 120) }; }
  if (!gl) return { gl: null, 失敗: 'webgl が使えない' };
  let prog;
  try {
    const vs = _sglShader(gl, gl.VERTEX_SHADER, SGL_VS);
    const fs = _sglShader(gl, gl.FRAGMENT_SHADER, SGL_FS);
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
  // 【GPU が落ちたとき】ブラウザが GPU をリセットすると、この canvas の中身（頂点・シェーダ）は全部消える。
  //   消えている間は呼ぶ側が canvas 2D に落ち、戻ったら作り直す（solidsGLUsable が false を返す）
  if (!canvas._sglListen) {
    canvas._sglListen = true;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); canvas._sglLost = true; }, false);
    canvas.addEventListener('webglcontextrestored', () => { canvas._sglLost = false; canvas._sglRestored = true; }, false);
  }
  canvas._sglRestored = false;
  // 【GPU が無いときは使わない】パソコンの GPU が使えない（ハードウェア描画が切られている・対応していない）と、
  //   ブラウザは WebGL を CPU でまねて描く（SwiftShader 等）。そのときは速くならず、縁をなめらかにする分だけ遅くなる
  //   （2026-11-28 実測: この検査環境で回転の 50ms を超えるコマ 37 → 62）。呼ぶ側が canvas 2D に落ちる。
  //   window.__CAB_SOLIDS_GL_FORCE = true で GPU が無くても使う（検査用）
  const 描き手 = solidsGLRendererName(gl);
  if (sglIsSoftwareRenderer(描き手) && !(typeof window !== 'undefined' && window.__CAB_SOLIDS_GL_FORCE === true)) {
    return { gl: null, 失敗: 'GPU が使えない（' + 描き手 + '）ので従来の描き方', ソフト: true, 描き手 };
  }
  // 頂点が 65,536 を超えたら 32bit の番号が要る（建物 1万棟なら超える）
  const u32 = !!gl.getExtension('OES_element_index_uint');
  return {
    gl, prog, u32, 描き手,
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aOther: gl.getAttribLocation(prog, 'aOther'),
    aSide: gl.getAttribLocation(prog, 'aSide'),
    aCol: gl.getAttribLocation(prog, 'aCol'),
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uHalfView: gl.getUniformLocation(prog, 'uHalfView'),
    uPxPerCab: gl.getUniformLocation(prog, 'uPxPerCab'),
    bufPos: gl.createBuffer(), bufOther: gl.createBuffer(), bufSide: gl.createBuffer(), bufCol: gl.createBuffer(),
    bufIdx: gl.createBuffer(),
    頂点: 0, 番号: 0, 版: null,
  };
}

// いま使えるか（'使える' ／ '作り直す'（GPU が戻った）／ '使えない'）
function solidsGLUsable(G) {
  if (!G || !G.gl) return '使えない';
  const cv = G.gl.canvas;
  if (cv && cv._sglRestored) return '作り直す';
  if ((cv && cv._sglLost) || (typeof G.gl.isContextLost === 'function' && G.gl.isContextLost())) return '使えない';
  return '使える';
}

// WebGL がどの装置で描いているか（読めなければ空）
function solidsGLRendererName(gl) {
  try {
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    const r = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(r || '');
  } catch (e) { return ''; }
}
// CPU でまねて描いている（GPU を使っていない）か
function sglIsSoftwareRenderer(name) {
  return /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Microsoft Basic Render|Mesa OffScreen/i.test(String(name || ''));
}

// 色の文字列 → [r,g,b]（'#rgb' '#rrggbb' 'rgb()' 'rgba()'）。読めなければ null
function sglParseColor(c) {
  const s = String(c == null ? '' : c).trim();
  let m = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const a = m[1].split(',').map(x => parseFloat(x));
    if (a.length >= 3 && a.slice(0, 3).every(Number.isFinite)) return [a[0], a[1], a[2], Number.isFinite(a[3]) ? a[3] : 1];
  }
  return null;
}

// 平面の多角形を三角形に割る（耳切り）。pts は [{x,y,z}]。戻りは番号の三つ組の平らな配列
//   面の法線の一番大きい軸を落とした2次元で切る（壁は縦、屋根は横）
function sglTriangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  // 面積ベクトル（Newell）
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    ax += (a.y - b.y) * (a.z + b.z); ay += (a.z - b.z) * (a.x + b.x); az += (a.x - b.x) * (a.y + b.y);
  }
  const X = Math.abs(ax), Y = Math.abs(ay), Z = Math.abs(az);
  let u, v, 符;
  if (Z >= X && Z >= Y) { u = (p) => p.x; v = (p) => p.y; 符 = az >= 0 ? 1 : -1; }
  else if (X >= Y) { u = (p) => p.y; v = (p) => p.z; 符 = ax >= 0 ? 1 : -1; }
  else { u = (p) => p.z; v = (p) => p.x; 符 = ay >= 0 ? 1 : -1; }
  const P = pts.map(p => ({ x: u(p) * 符, y: v(p) }));   // 反時計回りにそろえる
  const verts = []; for (let i = 0; i < n; i++) verts.push(i);
  const cross = (a, b, c) => (P[b].x - P[a].x) * (P[c].y - P[a].y) - (P[b].y - P[a].y) * (P[c].x - P[a].x);
  const inTri = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
  };
  const out = [];
  let guard = n * n;
  while (verts.length > 3 && guard-- > 0) {
    let found = false;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[(i - 1 + verts.length) % verts.length], b = verts[i], c = verts[(i + 1) % verts.length];
      if (cross(a, b, c) <= 1e-12) continue;
      let hit = false;
      for (const k of verts) {
        if (k === a || k === b || k === c) continue;
        if ((P[k].x === P[a].x && P[k].y === P[a].y) || (P[k].x === P[b].x && P[k].y === P[b].y) || (P[k].x === P[c].x && P[k].y === P[c].y)) continue;
        if (inTri(k, a, b, c)) { hit = true; break; }
      }
      if (hit) continue;
      out.push(a, b, c);
      verts.splice(i, 1);
      found = true;
      break;
    }
    if (!found) break;
  }
  if (verts.length === 3) out.push(verts[0], verts[1], verts[2]);
  else if (verts.length > 3) {
    // 自己交差などで耳が見つからない残り: 扇で埋める（穴は開けない）
    for (let i = 1; i + 1 < verts.length; i++) out.push(verts[0], verts[i], verts[i + 1]);
  }
  return out;
}

// 面の列から頂点と番号を作る。
//   pieces: [{ pts: [{x,y,z}], fill: [r,g,b,a(0..1)], stroke: [r,g,b,a] | null, lw: 線の太さ（CAB 座標） }]
//   戻り: { pos, other, side, col, idx(Uint32Array), 範囲: Int32Array（piece ごとに [始め, 終わり)）, 頂点 }
//   piece の番号は面ごとに「塗り → 線」の順で並べる（canvas 2D が fill の後に stroke するのと同じ）。
function solidsGLBuild(pieces) {
  let nv = 0, ni = 0;
  const tris = new Array(pieces.length);
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k], n = p.pts.length;
    const t = sglTriangulate(p.pts);
    tris[k] = t;
    nv += n; ni += t.length;
    if (p.stroke) { nv += n * 4; ni += n * 6; }
  }
  const pos = new Float32Array(nv * 3), other = new Float32Array(nv * 3);
  const side = new Float32Array(nv), col = new Uint8Array(nv * 4);
  const idx = new Uint32Array(ni), 範囲 = new Int32Array(pieces.length * 2);
  let vi = 0, ii = 0;
  const put = (a, b, s, c) => {
    pos[vi * 3] = a.x; pos[vi * 3 + 1] = a.y; pos[vi * 3 + 2] = a.z;
    other[vi * 3] = b.x; other[vi * 3 + 1] = b.y; other[vi * 3 + 2] = b.z;
    side[vi] = s;
    col[vi * 4] = c[0]; col[vi * 4 + 1] = c[1]; col[vi * 4 + 2] = c[2];
    col[vi * 4 + 3] = Math.max(0, Math.min(255, Math.round((c[3] == null ? 1 : c[3]) * 255)));
    return vi++;
  };
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k], P = p.pts, n = P.length;
    範囲[k * 2] = ii;
    const base = vi;
    for (let i = 0; i < n; i++) put(P[i], P[i], 0, p.fill);
    for (const t of tris[k]) idx[ii++] = base + t;
    if (p.stroke) {
      const w = p.lw > 0 ? p.lw : 0.5;
      for (let i = 0; i < n; i++) {
        const A = P[i], B = P[(i + 1) % n];
        const a1 = put(A, B, w, p.stroke), a2 = put(A, B, -w, p.stroke);
        const b1 = put(B, A, w, p.stroke), b2 = put(B, A, -w, p.stroke);
        // a1(A の +側) a2(A の −側) b1(B の −側) b2(B の +側) で四角になる（シェーダの向きの決め方より）
        idx[ii++] = a1; idx[ii++] = a2; idx[ii++] = b1;
        idx[ii++] = a1; idx[ii++] = b1; idx[ii++] = b2;
      }
    }
    範囲[k * 2 + 1] = ii;
  }
  return { pos, other, side, col, idx, 範囲, 頂点: vi };
}

// 頂点を送る（形が変わったときだけ）。版が同じなら送らない
function solidsGLUpload(G, B, 版) {
  if (!G || !G.gl) return false;
  const gl = G.gl;
  if (版 != null && G.版 === 版) { G.送った = false; return true; }
  if (B.頂点 > 65535 && !G.u32) return false;   // 32bit の番号が使えない GPU では描けない（呼ぶ側が canvas 2D に落ちる）
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufPos); gl.bufferData(gl.ARRAY_BUFFER, B.pos, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufOther); gl.bufferData(gl.ARRAY_BUFFER, B.other, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufSide); gl.bufferData(gl.ARRAY_BUFFER, B.side, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.bufCol); gl.bufferData(gl.ARRAY_BUFFER, B.col, gl.STATIC_DRAW);
  // 番号の入れ物は最大の長さで1回だけ確保し、並べ直しのたびに中身だけ書き換える（毎コマ確保しない）
  G.idxCpu = G.u32 ? new Uint32Array(B.idx.length) : new Uint16Array(B.idx.length);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.bufIdx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, G.idxCpu.byteLength || 4, gl.DYNAMIC_DRAW);
  G.B = B;
  G.頂点 = B.頂点;
  G.版 = (版 != null) ? 版 : null;
  G.並べ = null;          // 並べ順は作り直す
  G.番号 = 0;
  G.送った = true;
  return true;
}

// 並べ順（piece の番号の列）から三角形の番号を送る
function solidsGLOrder(G, 列, 長さ) {
  if (!G || !G.gl || !G.B) return 0;
  const gl = G.gl, B = G.B;
  const out = G.idxCpu;
  let o = 0;
  for (let k = 0; k < 長さ; k++) {
    const p = 列[k], s = B.範囲[p * 2], e = B.範囲[p * 2 + 1];
    if (e <= s) continue;
    if (G.u32) out.set(B.idx.subarray(s, e), o);
    else for (let i = s; i < e; i++) out[o + i - s] = B.idx[i];
    o += e - s;
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.bufIdx);
  if (o) gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, out.subarray(0, o));
  G.番号 = o;
  return o;
}

// 描く。mat は makeProjMatrix の列優先16要素。cw, ch は CSS 画素の大きさ、sc は letterbox の倍率
// 【canvas の大きさ】変わったときだけ代入する（毎回代入すると中身が消える・確保し直しで重い）
function solidsGLDraw(G, mat, cw, ch, dpr, sc) {
  if (!G || !G.gl) return 0;
  const gl = G.gl, cv = gl.canvas;
  const w = Math.max(1, Math.round(cw * (dpr || 1)));
  const h = Math.max(1, Math.round(ch * (dpr || 1)));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!G.番号) return 0;
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(G.prog);
  gl.uniformMatrix4fv(G.uMVP, false, mat);
  gl.uniform2f(G.uHalfView, w / 2, h / 2);
  gl.uniform1f(G.uPxPerCab, (sc || 1) * (dpr || 1));
  const at = (buf, loc, size, type, norm) => {
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
  };
  at(G.bufPos, G.aPos, 3, gl.FLOAT, false);
  at(G.bufOther, G.aOther, 3, gl.FLOAT, false);
  at(G.bufSide, G.aSide, 1, gl.FLOAT, false);
  at(G.bufCol, G.aCol, 4, gl.UNSIGNED_BYTE, true);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.bufIdx);
  gl.drawElements(gl.TRIANGLES, G.番号, G.u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
  return G.番号;
}

function solidsGLClear(G) {
  if (!G || !G.gl) return;
  const gl = G.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
