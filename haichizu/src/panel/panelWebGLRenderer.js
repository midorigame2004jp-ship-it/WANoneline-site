// ================================================================
// panelWebGLRenderer.js — WebGLによる仕切り・アイコンBox描画
// DOM上のWebGLキャンバス（glCanvas）に直接描画。GPU→CPUコピーなし。
//
// 使い方:
//   const r = createPanelGLRenderer(glCanvas)  // DOM canvas を渡す
//   r.uploadPartGeo(buildPartitionGeo(...))
//   r.uploadIconGeo(buildIconBoxGeo(...))
//   r.render(az, el, zoom, panX, panY, W, H, panel, iconAlpha)
//   // 描画完了 → glCanvas は画面に直接表示される（drawImage不要）
// ================================================================

// ── ユーティリティ（PanelCanvas3D.jsx の同名関数と同一ロジック） ──

function _hexToRGBgl(hex) {
  const h = (hex || '#94A3B8').replace('#', '');
  return [
    parseInt(h.substr(0, 2) || '94', 16),
    parseInt(h.substr(2, 2) || 'A3', 16),
    parseInt(h.substr(4, 2) || 'B8', 16),
  ];
}

function _faceBrightness(normal) {
  const n = normal || {};
  const dot1 = Math.max(0, (n.nx||0)*0.3   + (n.ny||0)*(-0.5) + (n.nz||0)*0.8);
  const dot2 = Math.max(0, (n.nx||0)*(-0.2) + (n.ny||0)*0.3   + (n.nz||0)*(-0.5));
  return 0.45 + 0.45 * dot1 + 0.15 * dot2;
}

function _iconHalfExtentsGL(cellBox) {
  const MINH = 5;
  if (cellBox) {
    const W = cellBox.xMax - cellBox.xMin;
    const D = cellBox.yMax - cellBox.yMin;
    const H = cellBox.zMax - cellBox.zMin;
    const gap = Math.max(MINH, Math.min(W, D, H) * 0.075);
    return {
      hx: Math.max(MINH, W / 2 - gap),
      hy: Math.max(MINH, D / 2 - gap),
      hz: Math.max(MINH, H / 2 - gap),
    };
  }
  return { hx: 20, hy: 20, hz: 20 };
}

// ── GLSL シェーダー ──
// project3DPanel (panelGeometry.js) と同じ計算をGPU上で実行
const _GL_VERT = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aColor;
varying vec3 vColor;
uniform float uAz, uEl, uZoom, uPanX, uPanY;
uniform float uPanelW, uPanelD, uPanelH;
uniform float uCanvW, uCanvH;
void main() {
  float cx =  aPos.x - uPanelW * 0.5;
  float cy = -(aPos.y - uPanelD * 0.5);
  float cz =  aPos.z - uPanelH * 0.5;
  float cosA = cos(uAz), sinA = sin(uAz);
  float rx = cx * cosA - cy * sinA;
  float ry = cx * sinA + cy * cosA;
  float sx = rx * uZoom + uPanX;
  float sy = (-ry * sin(uEl) - cz * cos(uEl)) * uZoom + uPanY;
  float depth = ry * cos(uEl) - cz * sin(uEl);
  float ndcX =  (sx + uCanvW * 0.5) / uCanvW * 2.0 - 1.0;
  float ndcY = -((sy + uCanvH * 0.5) / uCanvH * 2.0 - 1.0);
  // depth大=手前。3000mmスケールで正規化。depthFunc=GREATERで手前が勝つ。
  float ndcZ = clamp(depth / 3000.0, -1.0, 1.0);
  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);
  vColor = aColor;
}`;

const _GL_FRAG = `
precision mediump float;
varying vec3 vColor;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(vColor * (1.0 / 255.0), uAlpha);
}`;

function _compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[WebGL] Shader error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function _createProgram(gl, vSrc, fSrc) {
  const vs = _compileShader(gl, gl.VERTEX_SHADER,   vSrc);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, fSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[WebGL] Link error:', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

// ── ジオメトリビルダー ──

function buildPartitionGeo(solids, selectedPartitionIds) {
  const arr = [];
  solids.forEach(solid => {
    if (solid._isOuter) return;
    const isSel = !!(selectedPartitionIds && selectedPartitionIds.length &&
      selectedPartitionIds.includes(solid._partitionId));
    (solid.faces || []).forEach(f => {
      if (!f.vertices || f.vertices.length < 3) return;
      const br = Math.min(_faceBrightness(f.normal) * (isSel ? 1.3 : 1), 1.5);
      const [ri, gi, bi] = _hexToRGBgl(solid.color || '#94A3B8');
      const r = Math.min(255, ri * br);
      const g = Math.min(255, gi * br);
      const b = Math.min(255, bi * br);
      const vs = f.vertices;
      for (let i = 1; i < vs.length - 1; i++) {
        for (const v of [vs[0], vs[i], vs[i + 1]]) {
          arr.push(v.x, v.y, v.z, r, g, b);
        }
      }
    });
  });
  return new Float32Array(arr);
}

const _FACES6_GL = [
  { idx:[0,1,5,4], n:{nx:0,ny:-1,nz:0} },
  { idx:[2,3,7,6], n:{nx:0,ny:1,nz:0}  },
  { idx:[0,3,7,4], n:{nx:-1,ny:0,nz:0} },
  { idx:[1,2,6,5], n:{nx:1,ny:0,nz:0}  },
  { idx:[4,7,6,5], n:{nx:0,ny:0,nz:1}  },
  { idx:[0,1,2,3], n:{nx:0,ny:0,nz:-1} },
];

function buildIconBoxGeo(panel, dispPos, selectedIconId, hoveredIconId, selectedIconIds, iconReorderPreview) {
  const arr = [];
  const _panelDispMode = panel.iconDisplayMode || 'flat';
  (panel.placedIcons || []).forEach(icon => {
    if (icon.wx == null) return;
    const _iMode = (icon.iconDisplayMode === 'flat' || icon.iconDisplayMode === 'box')
      ? icon.iconDisplayMode : _panelDispMode;
    if (_iMode !== 'box') return;
    const dp  = dispPos.get(icon.id) || icon;
    const { hx, hy, hz } = _iconHalfExtentsGL(dp.subCellBox || icon.cellBox);
    const icx = dp.wx, icy = dp.wy, icz = dp.wz;
    const isSel   = icon.id === selectedIconId || icon.id === hoveredIconId;
    const isReord = iconReorderPreview && icon.id === selectedIconId;
    const baseRGB = icon.iconColor ? _hexToRGBgl(icon.iconColor) : [29, 78, 216];
    const base    = isReord ? [217,119,6] : (isSel ? [59,130,246] : baseRGB);
    const c8 = [
      [icx-hx, icy-hy, icz-hz], [icx+hx, icy-hy, icz-hz],
      [icx+hx, icy+hy, icz-hz], [icx-hx, icy+hy, icz-hz],
      [icx-hx, icy-hy, icz+hz], [icx+hx, icy-hy, icz+hz],
      [icx+hx, icy+hy, icz+hz], [icx-hx, icy+hy, icz+hz],
    ];
    _FACES6_GL.forEach(f => {
      const bright = _faceBrightness(f.n);
      const r = Math.min(255, base[0] * bright);
      const g = Math.min(255, base[1] * bright);
      const b = Math.min(255, base[2] * bright);
      const [i0, i1, i2, i3] = f.idx;
      for (const vi of [i0,i1,i2, i0,i2,i3]) {
        const [vx, vy, vz] = c8[vi];
        arr.push(vx, vy, vz, r, g, b);
      }
    });
  });
  return new Float32Array(arr);
}

// ── WebGL レンダラー本体 ──
// glCanvas: DOM上のcanvas要素（WebGLキャンバス）
function createPanelGLRenderer(glCanvas) {
  const gl = glCanvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: true,
    premultipliedAlpha: false,
  });
  if (!gl) {
    console.warn('[WebGL] context 取得失敗。CPUフォールバックを使用');
    return null;
  }

  const prog = _createProgram(gl, _GL_VERT, _GL_FRAG);
  if (!prog) return null;

  const aPos   = gl.getAttribLocation(prog, 'aPos');
  const aColor = gl.getAttribLocation(prog, 'aColor');
  const uLocs  = {};
  for (const name of ['uAz','uEl','uZoom','uPanX','uPanY',
                       'uPanelW','uPanelD','uPanelH','uCanvW','uCanvH','uAlpha']) {
    uLocs[name] = gl.getUniformLocation(prog, name);
  }

  // 深度テスト: depth値大=手前が勝つ（CPUバッファと同規則）
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.GREATER);
  gl.clearDepth(0.0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const partBuf = gl.createBuffer();
  const iconBuf = gl.createBuffer();
  let partVerts = 0;
  let iconVerts = 0;

  function uploadPartGeo(data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, partBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    partVerts = data.length / 6;
  }

  function uploadIconGeo(data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, iconBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    iconVerts = data.length / 6;
  }

  function _bindAttribs() {
    const STRIDE = 24; // 6 floats × 4 bytes
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos,   3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, STRIDE, 12);
  }

  function render(az, el, zoom, panX, panY, canvW, canvH, panel, iconAlpha) {
    gl.viewport(0, 0, canvW, canvH);
    gl.clearColor(0, 0, 0, 0); // 透明背景
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(prog);
    gl.uniform1f(uLocs.uAz,     az);
    gl.uniform1f(uLocs.uEl,     el);
    gl.uniform1f(uLocs.uZoom,   zoom);
    gl.uniform1f(uLocs.uPanX,   panX);
    gl.uniform1f(uLocs.uPanY,   panY);
    gl.uniform1f(uLocs.uCanvW,  canvW);
    gl.uniform1f(uLocs.uCanvH,  canvH);
    gl.uniform1f(uLocs.uPanelW, panel.widthMm  || 600);
    gl.uniform1f(uLocs.uPanelD, panel.depthMm  || 400);
    gl.uniform1f(uLocs.uPanelH, panel.heightMm || 1800);

    if (partVerts > 0) {
      gl.uniform1f(uLocs.uAlpha, 1.0);
      gl.bindBuffer(gl.ARRAY_BUFFER, partBuf);
      _bindAttribs();
      gl.drawArrays(gl.TRIANGLES, 0, partVerts);
    }
    if (iconVerts > 0) {
      gl.uniform1f(uLocs.uAlpha, iconAlpha != null ? iconAlpha : 1.0);
      gl.bindBuffer(gl.ARRAY_BUFFER, iconBuf);
      _bindAttribs();
      gl.drawArrays(gl.TRIANGLES, 0, iconVerts);
    }
  }

  return { uploadPartGeo, uploadIconGeo, render };
}
