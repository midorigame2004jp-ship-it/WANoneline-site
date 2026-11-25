// ================================================================
// PanelSlotDropZone.jsx — スロットへのD&D受け入れゾーン（Phase F）
// MIME: application/panel-icon, dropEffect: 'link'
// ================================================================
function PanelSlotDropZone({ slot, onDrop }) {
  // Phase F で実装
  return (
    <div style={{ minHeight: 24, border: '1px dashed #CBD5E1', borderRadius: 4, padding: 4 }}>
      {(slot.icons || []).map(ic => (
        <span key={ic.id} style={{ fontSize: 10, background: '#DBEAFE', borderRadius: 3, padding: '1px 4px', marginRight: 3 }}>
          {ic.name}
        </span>
      ))}
    </div>
  );
}
