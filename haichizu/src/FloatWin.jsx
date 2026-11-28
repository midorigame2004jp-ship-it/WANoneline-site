// ===== UI コンポーネント =====
function Sym({ shape, size = 20, color, hl = false }) {
  const s = size, h = s / 2, st = hl ? "#3B82F6" : color;
  if (shape === "gen") return <svg width={s} height={s}><circle cx={h} cy={h} r={h - 2} fill="#FFF" stroke={st} strokeWidth={2.5} /><text x={h} y={h + 4.5} textAnchor="middle" fontSize={s * 0.42} fontWeight={700} fill={st}>G</text></svg>;
  const isG = shape === "cb_g", fc = hl ? "#DBEAFE" : (isG ? "#16A34A" : "#DC2626");
  return <svg width={s - 2} height={s}><rect x={1} y={1} width={s - 4} height={s - 2} fill={fc} stroke={hl ? "#3B82F6" : fc} strokeWidth={1.5} rx={2} /><text x={(s - 2) / 2} y={s / 2 + 3.5} textAnchor="middle" fontSize={s * 0.36} fontWeight={700} fill="#FFF">52</text></svg>;
}


// ============================================================
// キーボード所有権の裁定（全ウィンドウ共通・spec 12.4）
// ------------------------------------------------------------
// Delete / Ctrl+Z のような「選択中のものに効く」キーは、window に直接
// addEventListener すると**どの窓を触っていても発火する**。
// 実際に「建物エディタで壁を選ばずDeleteを押したら建屋ごと消えた」不具合が出た。
//
// 裁定の基準は winState の z（bringFront が更新している最前面）1本に絞る。
// 新しい窓を足しても自動で正しく振る舞うようにするため、
// ここ（winState の持ち主のそば）に置き、各ウィンドウが個別実装しない。
// ============================================================
// 別ウィンドウの入力欄に残ったフォーカスを外す。
// Cesium のキャンバスは mousedown で preventDefault するため、クリックしても
// ブラウザのフォーカスが移らない。その結果「建物エディタの入力欄にフォーカスが
// 残ったまま地図をクリック」となり、入力欄ガード(bcCanHandleDeleteKey)が
// Delete を弾いて建屋を削除できなかった（2026-08-19 実測で確定）。
// 「別の窓をクリックしたらフォーカスは外れる」という当たり前の挙動を補う。
function fwBlurForeignFocus(winId) {
  const ae = document.activeElement;
  if (!ae || ae === document.body) return;
  const owner = ae.closest && ae.closest('[data-floatwinid]');
  // 同じ窓の中なら編集継続とみなして触らない
  if (owner && owner.dataset.floatwinid === winId) return;
  if (typeof ae.blur === 'function') ae.blur();
}
function fwOwnsKeyboard(winId, winState) {
  if (!winState) return true;                 // ウィンドウ管理外の文脈は従来通り通す
  const ids = Array.isArray(winId) ? winId : [winId];
  // solo モード（?solo=<id>）はその窓しか存在しないので常に所有者
  if (window.SOLO_WIN) return ids.includes(window.SOLO_WIN);
  let topId = null, topZ = -Infinity;
  for (const id in winState) {
    const w = winState[id];
    if (!w || w.hidden || w.minimized) continue;
    const z = w.z || 0;
    if (z > topZ) { topZ = z; topId = id; }
  }
  if (topId == null) return true;             // 全部閉じている＝競合しない
  return ids.includes(topId);
}

// ============================================================
// フローティングウィンドウ
// ============================================================
function FloatWin({ id, title, icon, winState, setWinState, bringFront, children, overflow, headerExtra, onClose, keepMounted }) {
  const w = winState[id];
  const MIN_W = 160, MIN_H = 80;

  // ── solo モード: ?solo=<id> で指定した窓だけフルスクリーン表示 ──
  if (window.SOLO_WIN) {
    if (window.SOLO_WIN !== id) return null;
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 9999,
                    display: "flex", flexDirection: "column",
                    background: "#fff", overflow: "hidden" }}>
        <div style={{ padding: "5px 8px", background: "#1E293B", color: "#F8FAFC",
                      display: "flex", alignItems: "center", gap: 6,
                      flexShrink: 0, userSelect: "none" }}>
          <span style={{ fontSize: 10, fontWeight: 700 }}>{icon ? `${icon} ` : ""}{title}</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: overflow || "auto", position: "relative" }}>
          {children}
        </div>
      </div>
    );
  }

  const getXY = (e) => {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  };

  // ウィンドウを最前面に出す唯一の入口。フォーカス解除と z 更新を必ずセットで行う
  const raise = () => { fwBlurForeignFocus(id); bringFront(id); };

  const lastClickRef = useRef(0);
  const rootRef = useRef(null);
  // 【動かしている間は画面を作り直さない・2026-11-28 ユーザー報告「建物を表示したときからウインドウの移動さえ重い」】
  //   以前は mousemove のたびに setWinState していたので、窓を1px動かすたびに App 全体（平面図の 1万個を超える
  //   SVG・3次元図…）を作り直していた（実測: 1回 65ms・11回/秒）。窓の位置・大きさは見た目だけの話なので、
  //   動かしている間はこの窓の箱（一番外の div）の style だけを書き換え、離したときに1回だけ setWinState する。
  //   React は前回の props と比べて差分だけ DOM に書くので、途中で別の理由の作り直しが来ても書き換えた位置は戻らない。
  //   旗 window.__FLOATWIN_DOM_DRAG=false で従来（動かすたびに作り直す）＝陽性対照
  const domDrag = () => window.__FLOATWIN_DOM_DRAG !== false && !!rootRef.current;
  const startMove = (e) => {
    e.preventDefault(); e.stopPropagation(); raise();
    // ダブルクリック検出（500ms以内の2回mousedown）
    const now = Date.now();
    const gap = now - lastClickRef.current;
    if (window.__DEBUG_TRACE === true) console.warn('[DBLCLICK]', { gap, id });
    if (gap < 500) {
      lastClickRef.current = 0;
      setWinState(pr => {
        const cur = pr[id];
        if (cur._maximized) {
          return { ...pr, [id]: { ...cur, x: cur._restoreX, y: cur._restoreY, w: cur._restoreW, h: cur._restoreH, z: cur._restoreZ || cur.z, _maximized: false } };
        }
        return { ...pr, [id]: { ...cur, _maximized: true, _restoreX: cur.x, _restoreY: cur.y, _restoreW: cur.w, _restoreH: cur.h, _restoreZ: cur.z, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, z: 10000 } };
      });
      return;
    }
    lastClickRef.current = now;
    const start = getXY(e);
    const origX = w.x, origY = w.y;
    // mousemove開始時にiframe上のイベントを奪うオーバーレイを追加（mousedownでは追加しない→clickを守る）
    const _ov = document.createElement('div');
    _ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:default;';
    let _ovAdded = false;
    const _dom = domDrag();
    let 今 = null;   // DOM だけ動かしているときの最後の位置（離したときに1回だけ記録へ書く）
    const mv = (ev) => {
      if (!_ovAdded) { _ovAdded = true; document.body.appendChild(_ov); }
      const p = getXY(ev);
      const nx = origX + p.x - start.x, ny = origY + p.y - start.y;
      if (_dom && rootRef.current) { 今 = { x: nx, y: ny }; rootRef.current.style.left = nx + 'px'; rootRef.current.style.top = ny + 'px'; return; }
      setWinState(pr => ({ ...pr, [id]: { ...pr[id], x: nx, y: ny } }));
    };
    const up = () => {
      window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); if (_ov.parentNode) _ov.parentNode.removeChild(_ov);
      if (今) { const 終 = 今; 今 = null; setWinState(pr => ({ ...pr, [id]: { ...pr[id], x: 終.x, y: 終.y } })); }
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
  };

  // 汎用リサイズ: edges = { l, r, t, b } どの辺を動かすか
  const startResize = (edges) => (e) => {
    e.preventDefault(); e.stopPropagation(); raise();
    const start = getXY(e);
    const orig = { x: w.x, y: w.y, w: w.w, h: w.h };
    const _ov = document.createElement('div');
    _ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:default;';
    let _ovAdded = false;
    const _dom = domDrag();
    let 今 = null;
    const mv = (ev) => {
      if (!_ovAdded) { _ovAdded = true; document.body.appendChild(_ov); }
      ev.preventDefault();
      const p = getXY(ev);
      const dx = p.x - start.x, dy = p.y - start.y;
      let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
      if (edges.r) nw = Math.max(MIN_W, orig.w + dx);
      if (edges.b) nh = Math.max(MIN_H, orig.h + dy);
      if (edges.l) { const dw = Math.min(dx, orig.w - MIN_W); nx = orig.x + dw; nw = orig.w - dw; }
      if (edges.t) { const dh = Math.min(dy, orig.h - MIN_H); ny = orig.y + dh; nh = orig.h - dh; }
      // 大きさも同じく箱の style だけ書き換える。中身は箱の大きさに合わせて並び直し、
      //   大きさを見張っている中身（3次元図の倍率・地図）はそれぞれ自分で追従する
      if (_dom && rootRef.current) {
        今 = { x: nx, y: ny, w: nw, h: nh };
        const st = rootRef.current.style; st.left = nx + 'px'; st.top = ny + 'px'; st.width = nw + 'px'; st.height = nh + 'px';
        return;
      }
      setWinState(pr => ({ ...pr, [id]: { ...pr[id], x: nx, y: ny, w: nw, h: nh } }));
    };
    const up = () => {
      window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); if (_ov.parentNode) _ov.parentNode.removeChild(_ov);
      if (今) { const 終 = 今; 今 = null; setWinState(pr => ({ ...pr, [id]: { ...pr[id], ...終 } })); }
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
  };

  if (w.hidden && !keepMounted) return null;

  const minimized = w.minimized;
  const E = 5; // 辺のハンドル幅(px)
  const edgeStyle = (cursor, pos) => ({
    position: "absolute", ...pos, zIndex: 998, cursor, touchAction: "none",
  });

  return (
    <div ref={rootRef} data-floatwinid={id} onMouseDown={raise} onTouchStart={raise}
      style={{
        position: "absolute", left: w.x, top: w.y,
        width: minimized ? 130 : w.w,
        height: minimized ? 28 : w.h,
        zIndex: w.z,
        borderRadius: (minimized || !w._maximized) ? 6 : 0,
        ...(w.hidden && keepMounted ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
        overflow: minimized ? "hidden" : "visible",
        boxShadow: w._maximized && !minimized ? "none" : "0 4px 20px rgba(0,0,0,0.2)",
        border: w._maximized && !minimized ? "none" : "1px solid #475569",
        display: "flex", flexDirection: "column",
        background: minimized ? "#1E293B" : "#FFF", touchAction: "none",
      }}>
      {/* ヘッダー */}
      <div onMouseDown={startMove} onTouchStart={startMove}
        onClick={minimized ? () => { setWinState(pr => ({ ...pr, [id]: { ...pr[id], minimized: false } })); raise(); } : undefined}
        style={{ padding: "5px 8px", background: "#1E293B", color: "#F8FAFC", display: "flex", alignItems: "center", gap: 6, cursor: "default", flexShrink: 0, userSelect: "none", touchAction: "none", borderRadius: minimized ? "5px" : "5px 5px 0 0" }}>
        <span style={{ fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{icon ? `${icon} ` : ""}{title}</span>
        <div style={{ flex: 1 }} />
        {!minimized && (
          <button onClick={(e) => { e.stopPropagation(); setWinState(pr => ({ ...pr, [id]: { ...pr[id], minimized: true } })); }}
            style={{ width: 18, height: 18, border: "none", borderRadius: 4, background: "rgba(255,255,255,0.15)", color: "#FFF", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
        )}
        {!minimized && headerExtra && <div onMouseDown={e => e.stopPropagation()} style={{ display: "flex", gap: 4, alignItems: "center" }}>{headerExtra}</div>}
        {!minimized && <button onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (onClose) onClose(); else setWinState(pr => ({ ...pr, [id]: { ...pr[id], hidden: true } })); }}
          style={{ width: 18, height: 18, border: "none", borderRadius: 4, background: "rgba(239,68,68,0.7)", color: "#FFF", fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
      </div>
      {/* 中身: 最小化時も children をマウントしたまま非表示にする（状態リセット防止） */}
      <div style={{ flex: 1, minHeight: 0, overflow: minimized ? "hidden" : (overflow || "auto"), position: "relative", borderRadius: "0 0 5px 5px", maxHeight: minimized ? 0 : undefined }}>
        {children}
      </div>
      {/* 8方向リサイズハンドル（最小化時は非表示） */}
      {!minimized && <>
        {/* 辺 */}
        <div onMouseDown={startResize({ t: true })} onTouchStart={startResize({ t: true })}
          style={edgeStyle("ns-resize", { top: -E, left: E * 2, right: E * 2, height: E * 2 })} />
        <div onMouseDown={startResize({ b: true })} onTouchStart={startResize({ b: true })}
          style={edgeStyle("ns-resize", { bottom: -E, left: E * 2, right: E * 2, height: E * 2 })} />
        <div onMouseDown={startResize({ l: true })} onTouchStart={startResize({ l: true })}
          style={edgeStyle("ew-resize", { left: -E, top: E * 2, bottom: E * 2, width: E * 2 })} />
        <div onMouseDown={startResize({ r: true })} onTouchStart={startResize({ r: true })}
          style={edgeStyle("ew-resize", { right: -E, top: E * 2, bottom: E * 2, width: E * 2 })} />
        {/* 角 */}
        <div onMouseDown={startResize({ t: true, l: true })} onTouchStart={startResize({ t: true, l: true })}
          style={edgeStyle("nwse-resize", { top: -E, left: -E, width: E * 3, height: E * 3 })} />
        <div onMouseDown={startResize({ t: true, r: true })} onTouchStart={startResize({ t: true, r: true })}
          style={edgeStyle("nesw-resize", { top: -E, right: -E, width: E * 3, height: E * 3 })} />
        <div onMouseDown={startResize({ b: true, l: true })} onTouchStart={startResize({ b: true, l: true })}
          style={edgeStyle("nesw-resize", { bottom: -E, left: -E, width: E * 3, height: E * 3 })} />
        <div onMouseDown={startResize({ b: true, r: true })} onTouchStart={startResize({ b: true, r: true })}
          style={edgeStyle("nwse-resize", { bottom: -E, right: -E, width: E * 3, height: E * 3 })} />
      </>}
    </div>
  );
}


