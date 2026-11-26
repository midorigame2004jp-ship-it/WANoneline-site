// ══════════════════════════════════════════════════════════════════════════
// BodyEditor.jsx — 立体エディタ（プリミティブを組み合わせて形を作る）・2026-09-27
// ══════════════════════════════════════════════════════════════════════════
// 【なぜ要るか・ユーザー指摘 2026-09-26】
//   「円柱って言ったからって円柱ができればいいと思ってるわけ？ 世の中の建物はそれで
//     網羅できると思ってるわけ？ 円柱で先端が半球のようになっているとかも要求したらどうすんの？」
//   形の型を1つずつ足す方式では網羅できない。**基本の形を置いて、足す・くり抜く**で作る。
//
// 【順番が意味を持つ】ops は「作り方の履歴」で、**上から順に、それまでの結果へ**効く。
//   木構造ではない。だから並び順を変えると結果が変わる（↑↓ボタンを出す）。
//   2026-09-27 に実際に踏んだ: [円柱, 球, 箱で切る] と書いたら切り取りが円柱にも効いて
//   円柱が消え、ドームだけが宙に浮いた。**1段目は必ず「土台」**でモードを持たない。
//
// 【記入項目を増やさない・ユーザー指摘 2026-09-23】
//   「記入項目が全体として多すぎるので余計わかりづらい」。
//   よく使う値（寸法と高さ）だけ出し、平面の位置(X/Y)は「細かい数値」に畳む。
//
// 【単位】寸法・位置はすべて**メートル**（csgCore.js の約束）。
//   立体の中はメートルで統一されているので、ここで換算しない。
// ══════════════════════════════════════════════════════════════════════════

const BE_KINDS = [
  { kind: 'box',      name: '箱',     作る: (c) => ({ kind: 'box', w: 4, d: 4, h: 4, at: { x: c.x, y: c.y, z: c.z } }) },
  { kind: 'cylinder', name: '円柱',   作る: (c) => ({ kind: 'cylinder', r: 2, h: 4, at: { x: c.x, y: c.y, z: c.z } }) },
  { kind: 'sphere',   name: '球',     作る: (c) => ({ kind: 'sphere', r: 2, at: { x: c.x, y: c.y, z: c.z } }) },
  { kind: 'cone',     name: '円錐台', 作る: (c) => ({ kind: 'cylinder', r: 3, r2: 1, h: 4, at: { x: c.x, y: c.y, z: c.z } }) },
];
// モードの表示名。1段目は土台なのでモードを持たない
const BE_MODES = [
  { mode: 'union',     name: '足す' },
  { mode: 'subtract',  name: 'くり抜く' },
  { mode: 'intersect', name: '重なりだけ残す' },
];
function beModeName(m) {
  const f = BE_MODES.find(x => x.mode === (m || 'union'));
  return f ? f.name : '足す';
}
// その段の見出し（種類の名前）。円錐台は「上の半径」を持つ円柱として作る
function beKindName(op) {
  if (!op) return '?';
  if (op.kind === 'box') return '箱';
  if (op.kind === 'sphere') return '球';
  if (op.kind === 'cylinder') return (op.r2 != null && op.r2 !== op.r) ? '円錐台' : '円柱';
  if (op.kind === 'extrude') return op.tool === 'wallify' ? '壁にする' : '面の押し引き';
  return op.kind;
}
// その段で出す寸法の欄（種類ごとの違いはこの表だけ。入力欄そのものは1つの部品）
function beFieldsOf(op) {
  if (!op) return [];
  if (op.kind === 'box') return [
    { key: 'w', name: '幅', min: 0.1 }, { key: 'd', name: '奥行', min: 0.1 }, { key: 'h', name: '高さ', min: 0.1 }];
  if (op.kind === 'sphere') return [{ key: 'r', name: '半径', min: 0.1 }];
  if (op.kind === 'cylinder') {
    const f = [{ key: 'r', name: '半径', min: 0.1 }, { key: 'h', name: '高さ', min: 0.1 }];
    if (op.r2 != null) f.push({ key: 'r2', name: '上の半径', min: 0 });
    return f;
  }
  // 面の押し引き。形（輪郭）と向きは3次元図で決めたものなので、あとから直せるのは厚みだけ
  if (op.kind === 'extrude') return [{ key: 'h', name: '厚み', min: 0.01 }];
  return [];
}

const BE_UI = {
  accent: '#F97316', line: '#E2E8F0', text: '#0F172A', sub: '#64748B',
  head: '#F1F5F9', bg: '#FFFFFF',
};

function BodyEditor(props) {
  const { bodies, sel, onUpdateBody, onDeleteBody,
          onUpdateOp, onMoveOp, onAddOp, onDeleteOp, onSelectBody,
          onWallify, onUnwallify, wallifyMsg } = props;
  const [細かく, set細かく] = React.useState(false);
  // 壁にするときの指定。既に壁の段があればその値を初期値にする
  const [壁厚, set壁厚] = React.useState(0.2);
  const [床を残す, set床を残す] = React.useState(true);
  const [天井を残す, set天井を残す] = React.useState(false);
  const 選択id = sel && sel.kind === 'body' ? sel.id : null;
  const body = (bodies || []).find(b => b.id === 選択id) || null;

  const 数値欄 = (値, 変える, opts) => (
    <input type="number" value={Number.isFinite(値) ? 値 : ''} step={(opts && opts.step) || 0.1}
      min={opts && opts.min} onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) 変える(v);
      }}
      style={{ width: 56, fontSize: 11, padding: '2px 4px', border: '1px solid ' + BE_UI.line,
               borderRadius: 3, textAlign: 'right' }} />
  );
  const 小ボタン = (文字, 押す, 使える, 説明) => (
    <button onClick={押す} disabled={!使える} title={説明}
      style={{ fontSize: 11, lineHeight: 1, padding: '3px 6px', borderRadius: 3,
               border: '1px solid ' + BE_UI.line, background: 使える ? '#FFF' : '#F8FAFC',
               color: 使える ? BE_UI.text : '#CBD5E1', cursor: 使える ? 'pointer' : 'default' }}>{文字}</button>
  );

  return (
    <div data-body-editor="1" style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden',
      background: BE_UI.bg, color: BE_UI.text, fontSize: 11, padding: 8, boxSizing: 'border-box' }}>

      {/* 立体の一覧（どれを編集しているか。図の上でクリックしても選べる） */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>立体</div>
        {!(bodies || []).length && (
          <div style={{ color: BE_UI.sub }}>
            {/* 【2026-11-05 実機で確かめて書き直した】旧案内は「〔⌂ タンク〕でドラッグ」と
                言っていたが、それは〔🧪 失敗例〕の中へ移っていて作れない。
                実測：平面図では作れる／3次元図では作れない（同じツール列が出ているのに）。
                名前は語彙表 BC_WORDS から引く（改名したらここも一緒に変わる） */}
            まだありません。<b>平面図</b>で〔{BC_WORDS.モード.建屋}〕を押し、
            〔{BC_WORDS.作る先.立体}〕に切り替えてから
            〔{BC_WORDS.入口.rect}〕などで輪郭を描くと作れます。
            <br />
            （〔{BC_WORDS.作る先.建屋}〕のままだと建屋になります。
            建屋は階・仕切り・扉が置ける形、立体は足す・くり抜くができる形です）
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {(bodies || []).map(b => (
            <button key={b.id} data-body-pick={b.id} onClick={() => onSelectBody && onSelectBody(b.id)}
              style={{ fontSize: 11, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                       border: '1px solid ' + (b.id === 選択id ? BE_UI.accent : BE_UI.line),
                       background: b.id === 選択id ? '#FFF7ED' : '#FFF',
                       fontWeight: b.id === 選択id ? 700 : 400 }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2,
                             background: b.color || '#6B7A8D', marginRight: 5 }} />
              {b.label || b.id}
            </button>
          ))}
        </div>
      </div>

      {!body && (bodies || []).length > 0 && (
        <div style={{ color: BE_UI.sub }}>上から選ぶか、図の上でクリックしてください。</div>
      )}

      {body && (<>
        {/* 名前 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <input value={body.label || ''} data-body-label
            onChange={(e) => onUpdateBody && onUpdateBody(body.id, { label: e.target.value })}
            style={{ flex: 1, fontSize: 12, fontWeight: 700, padding: '3px 6px',
                     border: '1px solid ' + BE_UI.line, borderRadius: 3 }} />
          {小ボタン('立体を消す', () => onDeleteBody && onDeleteBody(body.id), true, 'この立体を消す')}
        </div>

        {/* 作り方の履歴 */}
        <div style={{ fontWeight: 700, marginBottom: 2 }}>作り方（上から順）</div>
        <div style={{ color: BE_UI.sub, marginBottom: 6, lineHeight: 1.5 }}>
          上の段の結果に、下の段を順に足したりくり抜いたりします。
          <b style={{ color: BE_UI.text }}>順番を変えると形が変わります。</b>
        </div>

        {(body.ops || []).map((op, i) => (
          <div key={'op' + i} data-body-op={i}
            style={{ border: '1px solid ' + BE_UI.line, borderRadius: 4, padding: 6, marginBottom: 6,
                     background: i === 0 ? '#F8FAFC' : '#FFF' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <span style={{ background: BE_UI.head, borderRadius: 3, padding: '1px 5px',
                             fontWeight: 700 }}>{i + 1}</span>
              <span style={{ fontWeight: 700 }}>{beKindName(op)}</span>
              {i === 0 ? (
                <span style={{ color: BE_UI.sub }}>土台</span>
              ) : (
                <select value={op.mode || 'union'} data-body-op-mode={i}
                  onChange={(e) => onUpdateOp && onUpdateOp(body.id, i, { mode: e.target.value })}
                  style={{ fontSize: 11, padding: '2px 4px', border: '1px solid ' + BE_UI.line, borderRadius: 3 }}>
                  {BE_MODES.map(m => <option key={m.mode} value={m.mode}>{m.name}</option>)}
                </select>
              )}
              <span style={{ flex: 1 }} />
              {小ボタン('↑', () => onMoveOp && onMoveOp(body.id, i, -1), i > 0, '1つ上へ（形が変わります）')}
              {小ボタン('↓', () => onMoveOp && onMoveOp(body.id, i, 1), i < body.ops.length - 1, '1つ下へ（形が変わります）')}
              {小ボタン('×', () => onDeleteOp && onDeleteOp(body.id, i), body.ops.length > 1, 'この段を消す')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {beFieldsOf(op).map(f => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: BE_UI.sub }}>{f.name}</span>
                  {数値欄(op[f.key], (v) => onUpdateOp && onUpdateOp(body.id, i, { [f.key]: Math.max(f.min, v) }),
                          { min: f.min })}
                  <span style={{ color: BE_UI.sub }}>m</span>
                </label>
              ))}
              {op.kind !== 'extrude' && <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: BE_UI.sub }}>{op.kind === 'cylinder' ? '底の高さ' : '中心の高さ'}</span>
                {数値欄((op.at && op.at.z) || 0,
                        (v) => onUpdateOp && onUpdateOp(body.id, i, { at: { ...(op.at || {}), z: v } }))}
                <span style={{ color: BE_UI.sub }}>m</span>
              </label>}
            </div>
            {細かく && op.kind !== 'extrude' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 5, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: BE_UI.sub }}>東西X</span>
                  {数値欄((op.at && op.at.x) || 0,
                          (v) => onUpdateOp && onUpdateOp(body.id, i, { at: { ...(op.at || {}), x: v } }))}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: BE_UI.sub }}>南北Y</span>
                  {数値欄((op.at && op.at.y) || 0,
                          (v) => onUpdateOp && onUpdateOp(body.id, i, { at: { ...(op.at || {}), y: v } }))}
                </label>
                {op.kind === 'cylinder' && op.r2 == null &&
                  小ボタン('上の半径を付ける（円錐台）',
                           () => onUpdateOp && onUpdateOp(body.id, i, { r2: (op.r || 1) * 0.4 }), true,
                           '上の半径を変えると円錐台になります')}
              </div>
            )}
          </div>
        ))}

        {/* ══ 壁にする ・2026-09-30 ══
            真上から見た形を厚みぶん内側へ縮めてくり抜く。箱なら4枚の壁（＋床）になる。
            **本物のシェルではない**（斜めの屋根がある立体は屋根の下が抜ける）ので、
            名前も「壁にする」にしてある */}
        {(() => {
          const 壁 = (body.ops || []).find(o2 => o2.tool === 'wallify');
          const 失敗 = wallifyMsg && wallifyMsg.bodyId === body.id ? wallifyMsg.理由 : null;
          return (
            <div data-body-wall={壁 ? 'on' : 'off'}
              style={{ borderTop: '1px solid ' + BE_UI.line, paddingTop: 6, marginTop: 6 }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>壁にする</div>
              <div style={{ color: BE_UI.sub, marginBottom: 5, lineHeight: 1.5 }}>
                真上から見た形を厚みぶん内側へくり抜きます（部屋の壁）。
                斜めの屋根がある立体では屋根の下が抜けます。
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {/* 入力は**これから指定する値**だけ。今かかっている値は下に文字で出す
                    （1つの入れ物に2つの意味を持たせない） */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: BE_UI.sub }}>厚み</span>
                  {数値欄(壁厚, (v) => set壁厚(Math.max(0.01, v)), { min: 0.01 })}
                  <span style={{ color: BE_UI.sub }}>m</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                  <input type="checkbox" data-body-wall-floor checked={床を残す}
                    onChange={(e) => set床を残す(e.target.checked)} />
                  <span style={{ color: BE_UI.sub }}>床を残す</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                  <input type="checkbox" data-body-wall-ceil checked={天井を残す}
                    onChange={(e) => set天井を残す(e.target.checked)} />
                  <span style={{ color: BE_UI.sub }}>天井を残す</span>
                </label>
                {小ボタン(壁 ? '厚みを直す' : '壁にする',
                  () => onWallify && onWallify(body.id, {
                    thicknessM: 壁厚, keepFloor: 床を残す, keepCeil: 天井を残す,
                  }), true, '真上から見た形を内側へくり抜く')}
                {壁 && 小ボタン('壁をやめる', () => onUnwallify && onUnwallify(body.id), true,
                  '壁の段だけ外して元の塊に戻す')}
              </div>
              {壁 && (
                <div data-body-wall-now style={{ marginTop: 4, color: BE_UI.sub }}>
                  今かかっている壁: 厚み {(+壁.thicknessM).toFixed(2)}m
                  ／床 {壁.keepFloor ? 'あり' : 'なし'}
                  ／天井 {壁.keepCeil ? 'あり' : 'なし'}
                </div>
              )}
              {失敗 && (
                <div data-body-wall-error style={{ marginTop: 5, color: '#B91C1C', fontWeight: 700 }}>
                  壁にできません: {失敗}
                </div>
              )}
            </div>
          );
        })()}

        {/* 段を足す */}
        <div style={{ borderTop: '1px solid ' + BE_UI.line, paddingTop: 6, marginTop: 4 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>段を足す</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {BE_KINDS.map(k => BE_MODES.slice(0, 2).map(m => (
              <button key={k.kind + m.mode} data-body-add={k.kind + ':' + m.mode}
                onClick={() => onAddOp && onAddOp(body.id, k.kind, m.mode)}
                style={{ fontSize: 11, padding: '3px 7px', borderRadius: 3, cursor: 'pointer',
                         border: '1px solid ' + BE_UI.line, background: '#FFF' }}>
                {k.name}を{m.name}
              </button>
            )))}
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: BE_UI.sub, cursor: 'pointer' }}>
            <input type="checkbox" checked={細かく} onChange={(e) => set細かく(e.target.checked)} />
            細かい数値（平面の位置・円錐台）
          </label>
        </div>
      </>)}
    </div>
  );
}
