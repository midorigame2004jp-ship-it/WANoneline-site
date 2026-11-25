// ================================================================
// PanelPropPanel.jsx — 仕切り板プロパティ編集フォーム Phase B
// axis: 軸/位置/範囲/厚さ/色
// poly: 頂点列（{x,y,z}）直接入力
// ================================================================

function PanelPropPanel({ panel, partition, updatePartition, door, updateDoor, disabled }) {
  if (door && updateDoor) {
    const upd = (changes) => updateDoor(panel.id, door.id, changes);
    return <DoorPropForm panel={panel} door={door} update={upd} disabled={disabled} />;
  }
  if (!partition) {
    return <div style={{ fontSize: 11, color: '#94A3B8', padding: '4px 0' }}>仕切りを選択してください</div>;
  }
  if (partition.type === 'axis') {
    return <AxisPartForm panel={panel} part={partition} update={updatePartition} disabled={disabled} />;
  }
  if (partition.type === 'poly') {
    return <PolyPartForm panel={panel} part={partition} update={updatePartition} disabled={disabled} />;
  }
  return null;
}

// ── 扉プロパティフォーム ────────────────────────────────────
function DoorPropForm({ panel, door, update, disabled }) {
  const FACE_UV = {
    front:  { uLabel: 'U位置 幅方向・X', vLabel: 'V位置 高さ方向・Z', uMax: panel.widthMm,  vMax: panel.heightMm },
    back:   { uLabel: 'U位置 幅方向・X', vLabel: 'V位置 高さ方向・Z', uMax: panel.widthMm,  vMax: panel.heightMm },
    left:   { uLabel: 'U位置 奥行き・Y', vLabel: 'V位置 高さ方向・Z', uMax: panel.depthMm,  vMax: panel.heightMm },
    right:  { uLabel: 'U位置 奥行き・Y', vLabel: 'V位置 高さ方向・Z', uMax: panel.depthMm,  vMax: panel.heightMm },
    top:    { uLabel: 'U位置 幅方向・X', vLabel: 'V位置 奥行き・Y',   uMax: panel.widthMm,  vMax: panel.depthMm  },
    bottom: { uLabel: 'U位置 幅方向・X', vLabel: 'V位置 奥行き・Y',   uMax: panel.widthMm,  vMax: panel.depthMm  },
  };
  const fi = FACE_UV[door.face] || FACE_UV.front;
  const FACE_JP = { front:'前面', back:'後面', left:'左面', right:'右面', top:'上面', bottom:'下面' };

  return (
    <div style={{ fontSize: 11 }}>
      <PpField label="名前">
        <input type="text" value={door.name || ''} disabled={disabled}
          onChange={e => update({ name: e.target.value })}
          style={ppInpStyle(disabled)} />
      </PpField>
      <PpField label="設置面">
        <div style={{ ...ppInpStyle(true), padding: '3px 6px', display: 'block' }}>
          {FACE_JP[door.face] || door.face}
        </div>
      </PpField>
      <PpField label={`${fi.uLabel} (0–${fi.uMax}mm)`}>
        <PpNumInput val={door.uMm ?? 0} min={0} max={fi.uMax} disabled={disabled}
          onChange={v => update({ uMm: v })} />
      </PpField>
      <PpField label={`${fi.vLabel} (0–${fi.vMax}mm)`}>
        <PpNumInput val={door.vMm ?? 0} min={0} max={fi.vMax} disabled={disabled}
          onChange={v => update({ vMm: v })} />
      </PpField>
      <PpField label={`幅 (1–${fi.uMax}mm)`}>
        <PpNumInput val={door.widthMm ?? 100} min={1} max={fi.uMax} disabled={disabled}
          onChange={v => update({ widthMm: v })} />
      </PpField>
      <PpField label={`高さ (1–${fi.vMax}mm)`}>
        <PpNumInput val={door.heightMm ?? 200} min={1} max={fi.vMax} disabled={disabled}
          onChange={v => update({ heightMm: v })} />
      </PpField>
      <PpField label="ヒンジ側">
        <select value={door.hingeSide || 'left'} disabled={disabled}
          onChange={e => update({ hingeSide: e.target.value })}
          style={ppInpStyle(disabled)}>
          <option value="left">左</option>
          <option value="right">右</option>
        </select>
      </PpField>
    </div>
  );
}

// ── 軸平行仕切りフォーム ──────────────────────────────────
function AxisPartForm({ panel, part, update, disabled }) {
  const set = (changes) => update(panel.id, part.id, changes);

  // 軸ごとの説明・最大値・範囲ラベル
  const AXIS_INFO = {
    x: {
      desc: 'YZ面と平行（幅方向で左右に分割）',
      posLabel: 'X位置（幅方向）', posMax: panel.widthMm,
      uLabel: 'Y範囲（奥行き）', uMax: panel.depthMm,
      vLabel: 'Z範囲（高さ）',   vMax: panel.heightMm,
    },
    y: {
      desc: 'XZ面と平行（奥行き方向で前後に分割）',
      posLabel: 'Y位置（奥行き方向）', posMax: panel.depthMm,
      uLabel: 'X範囲（幅）',     uMax: panel.widthMm,
      vLabel: 'Z範囲（高さ）',   vMax: panel.heightMm,
    },
    z: {
      desc: 'XY面と平行（水平仕切り）',
      posLabel: 'Z位置（高さ方向）', posMax: panel.heightMm,
      uLabel: 'X範囲（幅）',     uMax: panel.widthMm,
      vLabel: 'Y範囲（奥行き）', vMax: panel.depthMm,
    },
  };
  const info = AXIS_INFO[part.axis] || AXIS_INFO.y;

  // 軸変更時はデフォルト値をリセット
  const handleAxisChange = (newAxis) => {
    const ai = AXIS_INFO[newAxis];
    set({
      axis: newAxis,
      posMm: Math.round(ai.posMax / 2),
      uMinMm: 0, uMaxMm: ai.uMax,
      vMinMm: 0, vMaxMm: ai.vMax,
    });
  };

  return (
    <div style={{ fontSize: 11 }}>
      {/* 名前 */}
      <PpField label="名前">
        <input type="text" value={part.name || ''} disabled={disabled}
          onChange={e => set({ name: e.target.value })}
          style={ppInpStyle(disabled)} />
      </PpField>

      {/* 軸 */}
      <PpField label="軸方向">
        <select value={part.axis || 'y'} disabled={disabled}
          onChange={e => handleAxisChange(e.target.value)}
          style={ppInpStyle(disabled)}>
          <option value="x">X軸垂直（幅で分割）</option>
          <option value="y">Y軸垂直（奥行きで分割）</option>
          <option value="z">Z軸垂直（水平仕切り）</option>
        </select>
      </PpField>
      <div style={{ fontSize: 10, color: '#64748B', marginBottom: 6, padding: '2px 0' }}>{info.desc}</div>

      {/* 位置 */}
      <PpField label={`${info.posLabel} (0–${info.posMax}mm)`}>
        <PpNumInput val={part.posMm ?? info.posMax / 2} min={0} max={info.posMax}
          disabled={disabled} onChange={v => set({ posMm: v })} />
      </PpField>

      {/* u範囲 */}
      <PpField label={`${info.uLabel} 開始–終了`}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <PpNumInput val={part.uMinMm ?? 0} min={0} max={info.uMax}
            disabled={disabled} onChange={v => set({ uMinMm: v })} />
          <span>–</span>
          <PpNumInput val={part.uMaxMm ?? info.uMax} min={0} max={info.uMax}
            disabled={disabled} onChange={v => set({ uMaxMm: v })} />
          <span style={{ color: '#94A3B8', whiteSpace: 'nowrap' }}>mm</span>
        </div>
      </PpField>

      {/* v範囲 */}
      <PpField label={`${info.vLabel} 開始–終了`}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <PpNumInput val={part.vMinMm ?? 0} min={0} max={info.vMax}
            disabled={disabled} onChange={v => set({ vMinMm: v })} />
          <span>–</span>
          <PpNumInput val={part.vMaxMm ?? info.vMax} min={0} max={info.vMax}
            disabled={disabled} onChange={v => set({ vMaxMm: v })} />
          <span style={{ color: '#94A3B8', whiteSpace: 'nowrap' }}>mm</span>
        </div>
      </PpField>

      {/* 厚さ */}
      <PpField label="厚さ (mm)">
        <PpNumInput val={part.thicknessMm ?? 2} min={1} max={200}
          disabled={disabled} onChange={v => set({ thicknessMm: v })} />
      </PpField>

      {/* 色 */}
      <PpField label="色">
        <input type="color" value={part.color || '#94A3B8'} disabled={disabled}
          onChange={e => set({ color: e.target.value })}
          style={{ width: '100%', height: 24, border: '1px solid #CBD5E1', borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer', padding: 1 }} />
      </PpField>
    </div>
  );
}

// ── 任意形状（斜め）仕切りフォーム ────────────────────────
function PolyPartForm({ panel, part, update, disabled }) {
  const set = (changes) => update(panel.id, part.id, changes);
  const verts = part.vertices || [];

  const setVert = (i, axis, val) => {
    const newVerts = verts.map((v, vi) => vi === i ? { ...v, [axis]: val } : v);
    set({ vertices: newVerts });
  };
  const addVert = () => {
    const last = verts[verts.length - 1] || { x: 0, y: panel.depthMm / 2, z: 0 };
    set({ vertices: [...verts, { ...last }] });
  };
  const removeVert = (i) => {
    if (verts.length <= 3) return;
    set({ vertices: verts.filter((_, vi) => vi !== i) });
  };

  return (
    <div style={{ fontSize: 11 }}>
      {/* 名前 */}
      <PpField label="名前">
        <input type="text" value={part.name || ''} disabled={disabled}
          onChange={e => set({ name: e.target.value })}
          style={ppInpStyle(disabled)} />
      </PpField>

      {/* 頂点テーブル */}
      <div style={{ marginBottom: 4, color: '#475569', fontWeight: 700 }}>
        頂点列（{verts.length}点、mm）
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr style={{ background: '#F1F5F9' }}>
              <th style={thStyle}>#</th>
              <th style={thStyle}>X</th>
              <th style={thStyle}>Y</th>
              <th style={thStyle}>Z</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {verts.map((v, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #E2E8F0' }}>
                <td style={{ ...thStyle, color: '#94A3B8' }}>{i + 1}</td>
                {['x', 'y', 'z'].map(ax => (
                  <td key={ax} style={thStyle}>
                    <input type="number" value={v[ax] ?? 0} disabled={disabled}
                      onChange={e => { const val = parseFloat(e.target.value); if (!isNaN(val)) setVert(i, ax, val); }}
                      style={{ width: 52, padding: '2px 3px', fontSize: 10, border: '1px solid #CBD5E1', borderRadius: 2 }} />
                  </td>
                ))}
                <td style={thStyle}>
                  {!disabled && (
                    <button onClick={() => removeVert(i)}
                      style={{ ...ppBtnStyle('#EF4444', true), padding: '1px 4px', fontSize: 9 }}
                      title="この頂点を削除">×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <button onClick={addVert} style={{ ...ppBtnStyle('#6B7280', true), marginTop: 4 }}>
          ＋頂点追加
        </button>
      )}

      {/* 厚さ・色 */}
      <PpField label="厚さ (mm)" style={{ marginTop: 8 }}>
        <PpNumInput val={part.thicknessMm ?? 2} min={1} max={200}
          disabled={disabled} onChange={v => set({ thicknessMm: v })} />
      </PpField>
      <PpField label="色">
        <input type="color" value={part.color || '#94A3B8'} disabled={disabled}
          onChange={e => set({ color: e.target.value })}
          style={{ width: '100%', height: 24, border: '1px solid #CBD5E1', borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer', padding: 1 }} />
      </PpField>
    </div>
  );
}

// ── ヘルパーコンポーネント ────────────────────────────────
function PpField({ label, children }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <label style={{ fontSize: 10, color: '#64748B', display: 'block', marginBottom: 2 }}>{label}</label>
      {children}
    </div>
  );
}

function PpNumInput({ val, min, max, disabled, onChange }) {
  return (
    <input type="number" value={val ?? ''} min={min} max={max} disabled={disabled}
      onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
      style={{ ...ppInpStyle(disabled), width: '100%' }} />
  );
}

function ppInpStyle(disabled) {
  return {
    width: '100%', padding: '3px 6px', fontSize: 11,
    border: '1px solid #CBD5E1', borderRadius: 3,
    background: disabled ? '#F1F5F9' : '#FFF',
    cursor: disabled ? 'not-allowed' : 'text',
    color: disabled ? '#94A3B8' : '#1E293B',
  };
}

const thStyle = { padding: '2px 4px', textAlign: 'center' };
