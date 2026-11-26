// equipmentRecord.js
// 機器レコード（全モジュール共通のスキーマ）。機器IDをキーに、単線結線図・配置図・配電盤が同じレコードを参照する。
//
// 1台の機器が持つ「状態」はこのレコードだけが持つ（正）。画面の塗り色・刃の角度はレコードから描いた表示。
// 扉のスイッチや3次元図のクリックは「押す側」であり、状態を持たない。
//
// レコードの形:
//   equipmentId : 機器ID（複製すると新しいID。切り取り→貼り付けや undo では同じID）
//   typeKey     : 単線結線図の部品種別（COMPONENT_TYPES のキー。例 'breakers'）
//   domId       : 単線結線図上の要素ID（画面側の都合で変わり得るので参照キーにしない）
//   state       : 状態ID（'on' / 'off' / テンプレート定義の状態ID）。開閉を持たない機器は null
//   placement   : 配置図へのリンク。null（未配置）または下のどちらか
//                 点  : { kind:'point', placedId, iconId, face } … 置いた配電盤(pp.id)と、その盤のアイコンボックス、
//                        ケーブルが入る面（'front'|'back'|'left'|'right'|'top'|'bottom'）。
//                        面は**盤ローカル基準**。盤を回しても変わらない（見え方ではなく物理的な面）
//                 経路: { kind:'path',  placedId, routeId }  … ケーブル・母線の経路（参照先IDを持つ）

export const PLACEMENT_KIND = Object.freeze({ POINT: 'point', PATH: 'path' });

export function newEquipmentId() {
  return `EQ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEquipmentRecord({ equipmentId, typeKey, domId, state = null, placement = null }) {
  return { equipmentId: equipmentId || newEquipmentId(), typeKey, domId, state, placement };
}
