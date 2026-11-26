/**
 * equipmentMaster.js
 * 全モジュール共通の機器種別マスター（星取表の実体）
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ★新しいアイコンを追加する手順:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 1. EQUIPMENT_TYPE_MASTER にエントリを1つ追加する
 * 2. equipment_design.html の星取表に1列追加する
 * それだけで全モジュール（単線結線図・配置図・インターロック・計算）に反映される
 *
 * ★フィールド定義の読み方:
 *   fieldDefs の各フィールドが「星取表の1マス」に対応する
 *   req: true  → ◉必（未入力だと計算・描画が動かない）
 *   req: false → ○任（defaultで補完可能）
 *   フィールドが存在しない → －（該当なし）
 *
 * ★登録済み種別（19種）:
 *   wire / breaker / generator / transformer / motor / cable /
 *   relay / seriesReactor / shuntReactor / capacitor /
 *   CT / VT / arrester / wattHour / solarPV / BESS / UPS /
 *   fuse / ground / ES / load / busbar
 *
 * ★アイコン表示規格（2026-08-09追加、equipment_design.html「アイコン網羅化計画」参照）:
 *   iconStyle:    ICON_STYLE参照。wire/cable/busbar（線分表現）は対象外
 *   deviceNumber: 継電器(relay)のみ。IEEE C37.2/JEM 1090準拠の番号
 *   svgRef:       resolveSvgRef(typeCode, instance) で解決する。手動指定があれば優先
 */

// ── 充電伝搬条件 ────────────────────────────────────────────
export const CHARGE_PASS = {
  ALWAYS:  'always',   // 常時通過（wire・母線・発電機・PV・UPS・CT・Wh）
  ON_ONLY: 'on_only',  // ON時のみ通過（breaker・fuse・ES）
  SOURCE:  'source',   // 電源として発する（generator / PV / UPS）
  NONE:    'none',     // 通過しない（motor・relay・ground・LA）
};

// ── 接続点位置 ────────────────────────────────────────────────
export const CONN_POS = {
  SHORT_EDGE: 'short_edge',   // 短辺中央（breaker）
  FOUR_DIR:   'four_dir',     // 上下左右4点（generator・transformer・UPS）
  TWO_SIDE:   'two_side',     // 上下2点（CT・VT・fuse・ES等）
  SINGLE_TOP: 'single_top',   // 上1点（ground・load・shuntReactor）
  BUS:        'bus',          // 辺全体・可変（母線）
};

// ── 系統フラグ ────────────────────────────────────────────────
export const SYSTEM_FLAG = {
  EXISTING: 'existing', // 既設
  NEW:      'new',      // 新設
  REMOVE:   'remove',   // 撤去
  CHANGE:   'change',   // 変更
};

// ── 潮流ノード種別 ────────────────────────────────────────────
export const NODE_TYPE = {
  PV:    'PV',    // 電圧制御ノード（発電機・太陽光PV）
  PQ:    'PQ',    // 電力指定ノード（電動機・汎用負荷）
  SLACK: 'slack', // スラックノード（系統1点のみ）
};

// ── 継電器種別 ────────────────────────────────────────────────
export const RELAY_TYPE = {
  OCR:  'OCR',   // 過電流継電器
  OCGR: 'OCGR',  // 地絡過電流継電器
  OVGR: 'OVGR',  // 地絡過電圧継電器
  UFR:  'UFR',   // 不足周波数継電器
  OVR:  'OVR',   // 過電圧継電器
  UVR:  'UVR',   // 不足電圧継電器
  OFR:  'OFR',   // 過周波数継電器
  DFR:  'DFR',   // 地絡方向継電器
};

// ── 汎用負荷種別 ─────────────────────────────────────────────
export const LOAD_TYPE = {
  LIGHTING: 'lighting', // 照明
  OUTLET:   'outlet',   // コンセント
  HEATER:   'heater',   // 電熱器
  GENERAL:  'general',  // 汎用
};

// ── 蓄電池 充放電モード ───────────────────────────────────────
export const CHARGE_DISCHARGE_MODE = {
  CHARGE:    'charge',    // 充電中（電力を消費＝負荷として計算）
  DISCHARGE: 'discharge', // 放電中（電力を供給＝電源として計算）
  STANDBY:   'standby',   // 待機（P≒0）
};

// ── アイコン表示規格（equipment_design.html「アイコン網羅化計画」参照） ──
// wire/busbarは線分表現でありスタイル切替対象がないためfieldDefsに含めない
export const ICON_STYLE = {
  NEW_JIS:      'newJIS',       // JIS C 0617（IEC準拠、デフォルト）
  OLD_JIS:      'oldJIS',       // JIS C 0301（廃止規格、現場に残存）
  IEC:          'IEC',
  IEEE:         'IEEE',
  SIMPLE_LARGE: 'simple-large',
  SIMPLE_SMALL: 'simple-small',
};

// ── 状態・充電の見た目の色（2026-08-09追加）────────────────────
// 直書き禁止。本体色・端子色は必ずこの定数を参照する
export const STATE_VISUAL_COLORS = {
  ON_BODY:     'red',    // 本体塗りつぶし・ON（既存挙動を定数化）
  OFF_BODY:    'green',  // 本体塗りつぶし・OFF（既存挙動を定数化）
  CHARGED:     'red',    // 端子スタブ・充電あり（wireのON色と統一）
  UNCHARGED:   'black',  // 端子スタブ・充電なし（wireのOFF色と統一）
};

// ── 端子の役割（terminals[].role） ──────────────────────────
export const TERMINAL_ROLE = {
  PRIMARY:   'primary',    // 1次側（上流）
  SECONDARY: 'secondary',  // 2次側（下流）
  GENERIC:   'terminal',   // 上流/下流の区別がない一般端子
};

// ── 機器種別マスター（星取表の実体） ────────────────────────
//
// isSetBoundary:       wireセット（物理接続範囲）の境界になるか
//                      true  = アイコンでセットが途切れる（breaker等）
//                      false = セットに含まれる（wire・母線・直列SR等）
// chargePassCondition: 充電伝搬がどの条件でこのアイコンを通過するか
// fieldDefs:           UI生成・バリデーション用のフィールド仕様
//                      req:true=◉必 / req:false=○任 / 未記載=－（該当なし）
//
export const EQUIPMENT_TYPE_MASTER = {

  // ─────────────────────────────────────────────────────────
  wire: {
    label:               'ワイヤー',
    isSetBoundary:       false,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    // 既存フラグ（後方互換）
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     null,
    connectionPos:       null,
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     true,
    hasRatedCapacity:    false,
    hasImpedance:        true,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        false,
    fieldDefs: {
      equipmentId:         { req: false, default: null },        // WR-/CH-/WS-
      name:                { req: true,  default: '' },
      systemFlag:          { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:        { req: true,  default: 6.6 },
      chargeState:         { req: false, default: 'uncharged' },
      groundInfo:          { req: false, default: [] },
      ratedA:              { req: false, default: null },
      R_per_km:            { req: false, default: null },
      X_per_km:            { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  breaker: {
    label:               '遮断器(52)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ON_ONLY,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     2,
    connectionPos:       CONN_POS.SHORT_EDGE,
    // terminals: connectionPointsの返す配列と同じ並び順（[0]=pos:'top', [1]=pos:'bottom'、回転前の座標系）
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.PRIMARY,   label: '1次' },
      { pos: 'bottom', role: TERMINAL_ROLE.SECONDARY, label: '2次' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     true,  // ON=ブレード閉（線と平行）/ OFF=ブレード開（斜め）
    },
    lotoTarget:          true,
    hasRatedCurrent:     true,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       true,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'ON' },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      tripTo:               { req: false, default: [] },
      groundInfo:           { req: false, default: [] },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: true,  default: null },
      Ibreak:               { req: true,  default: null },
      XR_ratio:             { req: false, default: 10 },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  generator: {
    label:               '発電機(G)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.SOURCE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     4,
    connectionPos:       CONN_POS.FOUR_DIR,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
      { pos: 'left',   role: TERMINAL_ROLE.GENERIC, label: '左' },
      { pos: 'right',  role: TERMINAL_ROLE.GENERIC, label: '右' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,  // 円形記号のためブレード表現なし。本体色のみ変化
    },
    lotoTarget:          true,
    hasRatedCurrent:     false,
    hasRatedCapacity:    true,
    hasImpedance:        true,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      state:                { req: true,  default: 'ON' },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedP:               { req: true,  default: null },
      ratedKVA:             { req: true,  default: null },
      pf:                   { req: true,  default: 0.85 },
      Qmax:                 { req: false, default: null },
      Qmin:                 { req: false, default: null },
      nodeType:             { req: false, default: NODE_TYPE.PV },
      XR_ratio:             { req: true,  default: 10 },
      Xd_sub:               { req: true,  default: null },
      Xd_trans:             { req: false, default: null },
      Xd:                   { req: false, default: null },
      X2:                   { req: false, default: null },
      X0:                   { req: false, default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  transformer: {
    label:               '変圧器(TR)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     4,
    connectionPos:       CONN_POS.FOUR_DIR,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.PRIMARY,   label: '1次(上)' },
      { pos: 'bottom', role: TERMINAL_ROLE.SECONDARY, label: '2次(下)' },
      { pos: 'left',   role: TERMINAL_ROLE.GENERIC,   label: '左' },
      { pos: 'right',  role: TERMINAL_ROLE.GENERIC,   label: '右' },
    ],
    onOffControllable:   false,
    lotoTarget:          true,
    hasRatedCurrent:     false,
    hasRatedCapacity:    true,
    hasImpedance:        true,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      V1:                   { req: true,  default: null },
      V2:                   { req: true,  default: null },
      ratedKVA:             { req: true,  default: null },
      Z_percent:            { req: true,  default: null },
      XR_ratio:             { req: true,  default: 10 },
      Z0_percent:           { req: false, default: null },
      connection:           { req: true,  default: 'Δ-Y' },
      tap:                  { req: false, default: 1.0 },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  motor: {
    label:               '電動機(M)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.NONE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
    ],
    onOffControllable:   false,
    lotoTarget:          true,
    hasRatedCurrent:     true,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 0.4 },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: true,  default: null },
      ratedP:               { req: true,  default: null },
      pf:                   { req: true,  default: 0.85 },
      XR_ratio:             { req: false, default: null },
      startRatio:           { req: true,  default: 6 },
      startTime:            { req: false, default: 5 },
      count:                { req: false, default: 1 },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  cable: {
    label:               'ケーブル',
    isSetBoundary:       false,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     null,
    connectionPos:       null,
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     true,
    hasRatedCapacity:    false,
    hasImpedance:        true,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedA:               { req: false, default: null },
      R_per_km:             { req: true,  default: null },
      X_per_km:             { req: true,  default: null },
      length:               { req: true,  default: null },
      section:              { req: false, default: null },
      Z0:                   { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  relay: {
    label:               '継電器(OCR等)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.NONE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
    ],
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       true,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      relayType:            { req: true,  default: RELAY_TYPE.OCR },
      curve:                { req: true,  default: 'SI' },
      tap:                  { req: true,  default: null },
      dial:                 { req: true,  default: null },
      inst:                 { req: false, default: null },
      CT_ratio:             { req: true,  default: null },
      monitorId:            { req: true,  default: null },
      tripTo:               { req: true,  default: [] },
      deviceNumber:         { req: true,  default: null },  // IEEE C37.2/JEM 1090準拠（例:'51','87'）
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  seriesReactor: {
    label:               '直列リアクトル(SR)',
    isSetBoundary:       false,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
    ],
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     true,
    hasRatedCapacity:    false,
    hasImpedance:        true,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: true,  default: null },
      X:                    { req: true,  default: null },
      R:                    { req: false, default: 0 },
      purpose:              { req: false, default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  shuntReactor: {
    label:               '分路リアクトル(SR)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     1,
    connectionPos:       CONN_POS.SINGLE_TOP,
    terminals: [
      { pos: 'top', role: TERMINAL_ROLE.GENERIC, label: '端子' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,
    },
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        true,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      state:                { req: true,  default: 'ON' },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedMVAR:            { req: true,  default: null },
      X:                    { req: true,  default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  capacitor: {
    label:               '進相コンデンサ(SC)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     1,
    connectionPos:       CONN_POS.SINGLE_TOP,
    terminals: [
      { pos: 'top', role: TERMINAL_ROLE.GENERIC, label: '端子' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,
    },
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      state:                { req: true,  default: 'ON' },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedKVAR:            { req: true,  default: null },
      C:                    { req: false, default: null },
      hasSeriesReactor:     { req: false, default: false },
      srPercent:            { req: false, default: 6 },
      inrushRatio:          { req: false, default: 20 },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  CT: {
    label:               '計器用変流器(CT)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     4,
    connectionPos:       CONN_POS.FOUR_DIR,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.PRIMARY,   label: '1次(上)' },
      { pos: 'bottom', role: TERMINAL_ROLE.SECONDARY, label: '2次(下)' },
      { pos: 'left',   role: TERMINAL_ROLE.GENERIC,   label: '左' },
      { pos: 'right',  role: TERMINAL_ROLE.GENERIC,   label: '右' },
    ],
    onOffControllable:   false,
    lotoTarget:          true,
    hasRatedCurrent:     true,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      V1:                   { req: true,  default: null },
      V2:                   { req: true,  default: null },
      ratedA:               { req: true,  default: null },  // 1次定格電流
      ratedKVA:             { req: false, default: null },
      ratio:                { req: true,  default: null },  // 例: 200/5 → 40
      accuracyClass:        { req: true,  default: '5P10' },
      connection:           { req: false, default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  VT: {
    label:               '計器用変圧器(VT/PT)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     4,
    connectionPos:       CONN_POS.FOUR_DIR,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.PRIMARY,   label: '1次(上)' },
      { pos: 'bottom', role: TERMINAL_ROLE.SECONDARY, label: '2次(下)' },
      { pos: 'left',   role: TERMINAL_ROLE.GENERIC,   label: '左' },
      { pos: 'right',  role: TERMINAL_ROLE.GENERIC,   label: '右' },
    ],
    onOffControllable:   false,
    lotoTarget:          true,
    hasRatedCurrent:     false,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      V1:                   { req: true,  default: null },
      V2:                   { req: true,  default: null },
      ratedKVA:             { req: true,  default: null },
      ratio:                { req: true,  default: null },
      accuracyClass:        { req: false, default: '3' },
      connection:           { req: false, default: null },
      tap:                  { req: false, default: 1.0 },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  arrester: {
    label:               '避雷器(LA)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.NONE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     1,
    connectionPos:       CONN_POS.SINGLE_TOP,
    terminals: [
      { pos: 'top', role: TERMINAL_ROLE.GENERIC, label: '端子' },
    ],
    onOffControllable:   false,
    lotoTarget:          true,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      groundInfo:           { req: false, default: [] },
      dischargeVoltage:     { req: true,  default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  wattHour: {
    label:               '電力量計(Wh)',
    isSetBoundary:       false,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
    ],
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: false, default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  solarPV: {
    label:               '太陽光PV',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.SOURCE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,
    },
    lotoTarget:          true,
    hasRatedCurrent:     false,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 0.4 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'ON' },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      groundInfo:           { req: false, default: [] },
      ratedV:               { req: true,  default: null },
      ratedP:               { req: true,  default: null },
      ratedKVA:             { req: true,  default: null },
      pf:                   { req: false, default: 1.0 },
      Qmax:                 { req: false, default: null },
      Qmin:                 { req: false, default: null },
      nodeType:             { req: true,  default: NODE_TYPE.PV },
      XR_ratio:             { req: false, default: null },
      maxIscRatio:          { req: true,  default: 1.1 },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  BESS: {
    label:               '蓄電池(BESS)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.SOURCE,  // 放電時は電源。充放電モードで動的変化
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.GENERIC, label: '上' },
      { pos: 'bottom', role: TERMINAL_ROLE.GENERIC, label: '下' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,
    },
    lotoTarget:          true,
    hasRatedCurrent:     true,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 0.4 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'ON' },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      groundInfo:           { req: false, default: [] },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: true,  default: null },
      ratedP:               { req: true,  default: null },
      ratedKVA:             { req: true,  default: null },
      efficiency:           { req: true,  default: 0.9 },
      Qmax:                 { req: false, default: null },
      Qmin:                 { req: false, default: null },
      nodeType:             { req: false, default: NODE_TYPE.PQ },
      XR_ratio:             { req: false, default: null },
      maxIscRatio:          { req: true,  default: 1.1 },
      capacityKWh:          { req: true,  default: null },
      SOC:                  { req: false, default: 50 },
      chargeDischargeMode:  { req: true,  default: CHARGE_DISCHARGE_MODE.STANDBY },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  UPS: {
    label:               'UPS',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.SOURCE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     4,              // 入力2端子＋出力2端子
    connectionPos:       CONN_POS.FOUR_DIR,
    // 入力=top/left、出力=bottom/right という暫定割当（実配置は未確定・要確認）
    terminals: [
      { pos: 'top',    role: 'input',  label: '入力(上)' },
      { pos: 'bottom', role: 'output', label: '出力(下)' },
      { pos: 'left',   role: 'input',  label: '入力(左)' },
      { pos: 'right',  role: 'output', label: '出力(右)' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,
    },
    lotoTarget:          true,
    hasRatedCurrent:     false,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 0.4 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'ON' },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      groundInfo:           { req: false, default: [] },
      ratedV:               { req: true,  default: null },
      ratedP:               { req: false, default: null },
      ratedKVA:             { req: true,  default: null },
      pf:                   { req: false, default: 0.9 },
      XR_ratio:             { req: false, default: null },
      maxIscRatio:          { req: false, default: null },
      bypassAvailable:      { req: false, default: false },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  fuse: {
    label:               'ヒューズ',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ON_ONLY,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.PRIMARY,   label: '1次' },
      { pos: 'bottom', role: TERMINAL_ROLE.SECONDARY, label: '2次' },
    ],
    onOffControllable:   true,   // 溶断でOFF
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,  // 溶断表現のため回転ブレードではなく本体色のみ（旧JIS開放形/包装形の形状差は別途svgRefで対応）
    },
    lotoTarget:          true,
    hasRatedCurrent:     true,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'ON' },
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: true,  default: null },
      Ibreak:               { req: true,  default: null },
      XR_ratio:             { req: false, default: null },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  ground: {
    label:               '接地端子',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.NONE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     false,
    hasRotation:         false,
    connectionCount:     1,
    connectionPos:       CONN_POS.SINGLE_TOP,
    terminals: [
      { pos: 'top', role: TERMINAL_ROLE.GENERIC, label: '端子' },
    ],
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: false, default: 0 },  // 接地は0V
      placement:            { req: false, default: null },
      groundInfo:           { req: true,  default: [] },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  ES: {
    label:               '接地開閉器(ES)',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.ON_ONLY,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     2,
    connectionPos:       CONN_POS.TWO_SIDE,
    terminals: [
      { pos: 'top',    role: TERMINAL_ROLE.PRIMARY,   label: '1次' },
      { pos: 'bottom', role: TERMINAL_ROLE.SECONDARY, label: '2次' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     true,  // ES自体がスイッチ機構のため遮断器と同様にブレード角度で開閉を表現
    },
    lotoTarget:          true,
    hasRatedCurrent:     true,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        true,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'OFF' },  // デフォルトはOFF（通常開）
      lotoActive:           { req: false, default: false },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedA:               { req: true,  default: null },
      groundInfo:           { req: true,  default: [] },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  load: {
    label:               '汎用負荷',
    isSetBoundary:       true,
    chargePassCondition: CHARGE_PASS.NONE,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         true,
    connectionCount:     1,
    connectionPos:       CONN_POS.SINGLE_TOP,
    terminals: [
      { pos: 'top', role: TERMINAL_ROLE.GENERIC, label: '端子' },
    ],
    onOffControllable:   true,
    stateVisual: {
      onBodyColor:  STATE_VISUAL_COLORS.ON_BODY,
      offBodyColor: STATE_VISUAL_COLORS.OFF_BODY,
      hasBlade:     false,
    },
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    true,
    hasImpedance:        false,
    hasInterlock:        true,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 0.1 },
      rotation:             { req: false, default: 0 },
      state:                { req: true,  default: 'ON' },
      chargeState:          { req: false, default: 'uncharged' },
      interlockConditions:  { req: false, default: [] },
      placement:            { req: false, default: null },
      ratedV:               { req: true,  default: null },
      ratedP:               { req: true,  default: null },
      ratedKVA:             { req: false, default: null },
      pf:                   { req: false, default: 0.85 },
      loadType:             { req: true,  default: LOAD_TYPE.GENERAL },
      iconStyle:            { req: false, default: ICON_STYLE.NEW_JIS },
      svgRef:               { req: false, default: null },
    },
  },

  // ─────────────────────────────────────────────────────────
  busbar: {
    label:               '母線(Bus)',
    isSetBoundary:       false,
    chargePassCondition: CHARGE_PASS.ALWAYS,
    hasEquipmentId:      true,
    hasLabel:            true,
    hasSystemFlag:       true,
    hasVoltageClass:     true,
    hasRotation:         false,
    connectionCount:     null,   // 可変
    connectionPos:       CONN_POS.BUS,
    onOffControllable:   false,
    lotoTarget:          false,
    hasRatedCurrent:     false,
    hasRatedCapacity:    false,
    hasImpedance:        false,
    hasInterlock:        false,
    hasTripOutput:       false,
    hasGrounding:        false,
    hasPlacement:        true,
    fieldDefs: {
      equipmentId:          { req: true,  default: null },
      name:                 { req: true,  default: '' },
      systemFlag:           { req: true,  default: SYSTEM_FLAG.EXISTING },
      voltageClass:         { req: true,  default: 6.6 },
      chargeState:          { req: false, default: 'uncharged' },
      placement:            { req: false, default: null },
      ratedA:               { req: false, default: null },
    },
  },

};

// ── 機器の中で導通する端子の組 ──────────────────────────────
//
// 値は terminals[] の並び順（= getConnectionPoints が返す並び順）の添字の組。
//   未定義（undefined）… 定義がまだ無い種別。従来どおり「全端子が内部でつながっている」として扱う
//   空配列（[]）        … 「内部でつながらない」ことを明示（変圧器の1次-2次、端子1つだけの機器など）
// 実際に通すかどうか（遮断器がONか等）は呼び出し側の判定で決める。ここは「通るとしたらどこ同士か」だけ。
const allPairs = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
};

export const CONDUCTION_PAIRS = {
  breaker:       [[0, 1]],          // 上下を入切する
  generator:     allPairs(4),       // 端子はどれも同じ電位
  transformer:   [],                // 1次-2次は直流的につながらない（磁気結合のみ）
  motor:         [[0, 1]],
  relay:         [[0, 1]],          // コイル（制御回路）
  seriesReactor: [[0, 1]],
  shuntReactor:  [],                // 端子1つ
  capacitor:     [],                // 端子1つ
  CT:            [[0, 1], [2, 3]],  // 主回路は上下を貫通、計器用の2次は左右どうし。1次と2次はつながらない
  VT:            [[0, 1], [2, 3]],  // 同上
  arrester:      [],
  wattHour:      [[0, 1]],
  solarPV:       [[0, 1]],
  BESS:          [[0, 1]],
  UPS:           [[0, 2], [1, 3]],  // 入力どうし（上・左）／出力どうし（下・右）
  fuse:          [[0, 1]],
  ground:        [],
  ES:            [[0, 1]],
  load:          [],
};

// ── 制御回路につながる端子（terminals[] の添字） ──────────────
// ここに無い端子は主回路。保護継電器を動かすとき「どちらの回路か」をこの表で判断する。
export const CONTROL_TERMINALS = {
  CT:    [2, 3],   // 計器用の2次
  VT:    [2, 3],
  relay: [0, 1],   // 継電器のコイル側
};

/** 種別コードの導通ペア。定義が無ければ null（＝呼び出し側で従来どおり全ペア扱い） */
export function getConductionPairs(typeCode) {
  const pairs = CONDUCTION_PAIRS[typeCode];
  return Array.isArray(pairs) ? pairs : null;
}

/** 端子が制御回路側か */
export function isControlTerminal(typeCode, terminalIndex) {
  return (CONTROL_TERMINALS[typeCode] || []).includes(terminalIndex);
}

// ── 画面側の型キー → マスターの種別コード ──────────────────
// 対応表は1か所だけに置く（PropertyPanel 等はここから読む）
export const TARGET_TYPE_TO_MASTER_KEY = {
  // 画面側の複数形・別名
  generators: 'generator', breakers: 'breaker', wires: 'wire',
  groundSymbol: 'ground', groundSymbols: 'ground',
  bladeBreaker: 'breaker', bladeBreakers: 'breaker',   // 刃形の遮断器記号（52）
  // 断路器・負荷開閉器はマスターに対応する種別がまだ無いので載せない（＝定義なし扱い）
  // 同名（マスターの種別コードそのまま）
  generator: 'generator', breaker: 'breaker', wire: 'wire', cable: 'cable',
  transformer: 'transformer', motor: 'motor', relay: 'relay',
  seriesReactor: 'seriesReactor', shuntReactor: 'shuntReactor', capacitor: 'capacitor',
  CT: 'CT', VT: 'VT', arrester: 'arrester', wattHour: 'wattHour',
  solarPV: 'solarPV', BESS: 'BESS', UPS: 'UPS', fuse: 'fuse',
  ground: 'ground', ES: 'ES', load: 'load', busbar: 'busbar',
};

export const masterKeyOfTargetType = (targetType) => TARGET_TYPE_TO_MASTER_KEY[targetType] || targetType || null;

// ── ユーティリティ関数 ────────────────────────────────────────

/**
 * wireセットの境界になる種別コードの一覧を返す
 * BFSでセットを構築するときの「ここで止まる」判定に使う
 */
export function getSetBoundaryTypes() {
  return Object.keys(EQUIPMENT_TYPE_MASTER).filter(
    k => EQUIPMENT_TYPE_MASTER[k].isSetBoundary
  );
}

/**
 * 種別コードから機器種別マスターを取得
 * @param {string} typeCode - 'breaker' / 'solarPV' / 'CT' 等
 * @returns {Object|null}
 */
export function getEquipmentTypeDef(typeCode) {
  return EQUIPMENT_TYPE_MASTER[typeCode] ?? null;
}

/**
 * その機器種別がそのプロパティを持つか判定（後方互換）
 * @param {string} typeCode
 * @param {string} propKey - 'hasRatedCurrent' 等
 * @returns {boolean}
 */
export function hasProperty(typeCode, propKey) {
  const def = getEquipmentTypeDef(typeCode);
  return def ? !!def[propKey] : false;
}

/**
 * 種別のfieldDefsからデフォルト値オブジェクトを生成
 * 新規アイコン配置時の初期値として使う
 * @param {string} typeCode
 * @returns {Object}
 */
export function getDefaultInstance(typeCode) {
  const def = getEquipmentTypeDef(typeCode);
  if (!def) return {};
  const instance = { equipmentType: typeCode };
  for (const [key, spec] of Object.entries(def.fieldDefs ?? {})) {
    instance[key] = spec.default;
  }
  return instance;
}

/**
 * インスタンスのsvgRefを解決する（型・iconStyleから自動導出、手動指定があればそれを優先）
 * 実際のSVGパス定義はまだ実装されていない。命名規則は
 * newcom07.jp「JIS C 0617準拠の電気図記号（単線図用）」PDFの
 * {機器コード}-{バリエーション}_{向きH/V}{形状番号}{位置} を叩き台にする
 * （詳細は .claude/feature_singleline.md 参照）
 * @param {string} typeCode
 * @param {Object} instance - svgRef/iconStyleを含む機器インスタンス
 * @returns {string|null} 解決されたsvgRefキー。iconStyle対象外の種別はnull
 */
export function resolveSvgRef(typeCode, instance) {
  const def = getEquipmentTypeDef(typeCode);
  if (!def || !('iconStyle' in (def.fieldDefs ?? {}))) return null;
  if (instance?.svgRef) return instance.svgRef;
  const iconStyle = instance?.iconStyle ?? def.fieldDefs.iconStyle.default;
  return `${typeCode}.${iconStyle}.default`;
}

/**
 * インスタンスを検証し、◉必フィールドの欠落を返す
 * @param {string} typeCode
 * @param {Object} instance
 * @returns {string[]} 欠落しているフィールド名の配列（空なら検証OK）
 */
export function validateInstance(typeCode, instance) {
  const def = getEquipmentTypeDef(typeCode);
  if (!def) return [`未知の機器種別: ${typeCode}`];
  const missing = [];
  for (const [key, spec] of Object.entries(def.fieldDefs ?? {})) {
    if (spec.req && (instance[key] == null || instance[key] === '')) {
      missing.push(key);
    }
  }
  return missing;
}
