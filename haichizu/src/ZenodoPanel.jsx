// ══════════════════════════════════════════════════════════════
// Zenodo の建物データ（高さ付き）を取り込む窓・2026-11-23
// ══════════════════════════════════════════════════════════════
// 【何のデータか】配置図データZenodo/Japan.shp（https://zenodo.org/records/12674244）。
//   日本全国の建物 2,685万件のポリゴンに **Height（高さ・メートル）** が付いている。
//   座標系は WGS84 なので geoToGrid がそのまま使える（.prj で確認）。
// 【なぜ要るか】国土地理院のベクトルタイルには**高さが入っていない**（実測で確認）。
//   こちらは高さがあるので、建屋を「形も高さも実データ」で起こせる。
// 【範囲】国土地理院の窓と同じ「図面の範囲」を使う（gridToGeo が正・同じ式を2つ書かない）。
// 【読むのはサーバー】3.9GB をブラウザへ送れないので /zenodo/buildings が範囲で切り出す。
function ZenodoPanel({ onBuildings, onRemoveBuildings }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [上限, set上限] = React.useState(3000);

  const 図面の範囲 = () => {
    if (typeof gridToGeo !== 'function' || typeof TW === 'undefined' || typeof TH === 'undefined') return null;
    const sw = gridToGeo(0, TH), ne = gridToGeo(TW, 0);
    return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
  };

  const 取り込む = async () => {
    const b = 図面の範囲();
    if (!b) { setMsg('図面の範囲が決まっていません（国土地理院の窓で「3次元範囲を設定」）'); return; }
    if (typeof geoToGrid !== 'function') { setMsg('座標の変換が読み込まれていません'); return; }
    setBusy(true); setMsg('建物を探しています（全国2,685万件を走査します）…');
    try {
      const u = '/zenodo/buildings?w=' + b.west + '&s=' + b.south + '&e=' + b.east + '&n=' + b.north + '&max=' + 上限;
      const res = await fetch(u);
      const j = await res.json();
      if (j.error) { setMsg('取り込めません: ' + j.error); return; }
      const items = (j.items || []).map((it, k) => {
        const points = it.ring.map(q => { const g = geoToGrid(q[1], q[0]); return { x: g.x, y: g.y }; });
        let la = 0, lo = 0; for (const q of it.ring) { lo += q[0]; la += q[1]; }
        la /= it.ring.length; lo /= it.ring.length;
        return {
          key: 'zenodo:' + la.toFixed(6) + ',' + lo.toFixed(6),
          種別: '建物', ftCode: null, points,
          height: (typeof it.h === 'number' && it.h > 0) ? it.h : null,
        };
      });
      const r = (typeof onBuildings === 'function') ? onBuildings(items) : null;
      const 高さあり = items.filter(x => x.height != null).length;
      const 行 = [];
      行.push('取り込み ' + (r ? r.足した : items.length) + ' 件');
      行.push('高さが入っていた ' + 高さあり + ' 件（残りは仮の値）');
      if (r && r.重複) 行.push('すでにある ' + r.重複 + ' 件は足していません');
      if (r && r.重なり) 行.push('手で作った建屋と重なる ' + r.重なり + ' 件は足していません');
      if (j.打切) 行.push('上限 ' + 上限 + ' 件で打ち切りました');
      行.push('走査 ' + (j.走査 || 0).toLocaleString() + ' 件 / ' + (j.ms || 0) + 'ms');
      行.push('出典: Zenodo 12674244（Japan building footprints with height）');
      setMsg(行.join('／'));
    } catch (e) { setMsg('取り込みに失敗: ' + (e && e.message)); }
    finally { setBusy(false); }
  };

  const ボタン = (bg) => ({
    background: bg, color: '#fff', border: 'none', borderRadius: 4,
    padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
  });
  const b = 図面の範囲();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0F172A', color: '#E2E8F0' }}>
      <div style={{ display: 'flex', gap: 6, padding: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button data-zenodo-btn="import" style={ボタン(busy ? 'rgba(100,116,139,0.8)' : 'rgba(16,185,129,0.9)')}
          disabled={busy} onClick={取り込む}>
          {busy ? '探しています…' : '建物を取り込む（高さ付き）'}
        </button>
        {(typeof onRemoveBuildings === 'function') && (
          <button data-zenodo-btn="clear" style={ボタン('rgba(239,68,68,0.6)')}
            onClick={() => { const n = onRemoveBuildings(); setMsg(n ? ('取り込んだ建物 ' + n + ' 件を消しました') : '取り込んだ建物はありません'); }}>
            取り込んだ建物を消す
          </button>
        )}
        <label style={{ fontSize: 11, opacity: 0.85 }}>
          上限
          <input type="number" min="1" max="20000" step="100" value={上限}
            onChange={e => set上限(Math.max(1, Math.min(20000, +e.target.value || 1)))}
            style={{ width: 70, marginLeft: 4, background: '#1E293B', color: '#E2E8F0', border: '1px solid #334155', borderRadius: 3, padding: '2px 4px' }} />
        </label>
      </div>
      <div style={{ padding: '0 10px 8px', fontSize: 11, lineHeight: 1.6, opacity: 0.9 }}>
        <div>日本全国の建物 2,685万件（<b>高さ付き</b>）から、いまの図面の範囲ぶんを切り出します。</div>
        {b && <div style={{ opacity: 0.75 }}>範囲 経度 {b.west.toFixed(5)}〜{b.east.toFixed(5)} ／ 緯度 {b.south.toFixed(5)}〜{b.north.toFixed(5)}</div>}
        <div style={{ opacity: 0.75 }}>範囲は国土地理院の窓と同じ（「3次元範囲を設定」で決めた四角）です。</div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 10px 10px', fontSize: 11, whiteSpace: 'pre-wrap' }}>{msg}</div>
      <div style={{ padding: '6px 10px', fontSize: 10, opacity: 0.6, borderTop: '1px solid #1E293B' }}>
        出典: <a href="https://zenodo.org/records/12674244" target="_blank" rel="noreferrer" style={{ color: '#7DD3FC' }}>Zenodo 12674244</a>
      </div>
    </div>
  );
}
