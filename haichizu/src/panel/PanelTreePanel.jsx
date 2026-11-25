// ================================================================
// PanelTreePanel.jsx — 仕切り板ツリー（追加/削除/選択）Phase B
// ================================================================

function PanelTreePanel({ panel, selectedId, onSelect, onAdd, onDelete, onToggleVirtual, disabled, onHover }) {
  const parts = panel.partitions || [];

  // 仕切りの説明ラベル（軸名は位置情報に含まれるため固定形式に統一）
  const partLabel = (p) => {
    if (p.type === 'axis') {
      const axisName = { x: 'X軸', y: 'Y軸', z: 'Z軸' }[p.axis] || '?';
      const pos = p.posMm != null ? `${p.posMm}mm` : '未設定';
      return `仕切り (${axisName}, ${pos})`;
    }
    if (p.type === 'poly') {
      const vc = (p.vertices || []).length;
      return `${p.name || '仕切り'} (斜め, ${vc}頂点)`;
    }
    return p.name || '仕切り';
  };

  return (
    <div style={{ fontSize: 11 }}>
      {/* ヘッダー */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 4,
      }}>
        <span style={{ fontWeight: 700, color: '#475569' }}>
          仕切り ({parts.length})
        </span>
        {!disabled && (
          <div style={{ display: 'flex', gap: 3 }}>
            <button
              onClick={() => onAdd('axis')}
              title="軸平行仕切りを追加"
              style={ppBtnStyle('#3B82F6', true)}
            >＋軸平行</button>
            <button
              onClick={() => onAdd('poly')}
              title="任意形状（斜め）仕切りを追加"
              style={ppBtnStyle('#7C3AED', true)}
            >＋斜め</button>
          </div>
        )}
      </div>

      {/* リスト */}
      {parts.length === 0 ? (
        <div style={{ color: '#94A3B8', padding: '4px 0' }}>（なし）</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {parts.map(p => (
            <div
              key={p.id}
              onClick={() => onSelect(p.id === selectedId ? null : p.id)}
              onMouseEnter={() => onHover && onHover(p.id)}
              onMouseLeave={() => onHover && onHover(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 6px', borderRadius: 4, cursor: 'pointer',
                background: p.id === selectedId ? '#FFF7ED' : 'transparent',
                border: p.id === selectedId ? '1px solid #FBBF24' : '1px solid transparent',
                color: p.id === selectedId ? '#B45309' : p.virtual ? '#94A3B8' : '#334155',
              }}
            >
              <span style={{ fontSize: 10 }}>{p.type === 'poly' ? '◇' : '▬'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {partLabel(p)}
              </span>
              {!disabled && (
                <>
                  <button
                    onClick={e => { e.stopPropagation(); onToggleVirtual && onToggleVirtual(p.id); }}
                    title={p.virtual ? '通常仕切りに戻す' : '空想仕切りにする'}
                    style={{
                      ...ppBtnStyle('#64748B', true),
                      padding: '1px 5px', fontSize: 12,
                    }}
                  >{p.virtual ? '□' : '■'}</button>
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(p.id); }}
                    title="削除"
                    style={{ ...ppBtnStyle('#EF4444', true), padding: '1px 5px', fontSize: 10 }}
                  >×</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 共通ミニボタンスタイル
function ppBtnStyle(bg, mini) {
  return {
    background: bg, color: '#FFF', border: 'none', borderRadius: 3,
    padding: mini ? '2px 6px' : '3px 8px',
    fontSize: mini ? 10 : 11, cursor: 'pointer', fontWeight: 600, lineHeight: 1.4,
  };
}
