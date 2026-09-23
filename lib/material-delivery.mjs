const MATERIAL_PACKET = /^(?:life-thread:|companion-pursuit:|agenda:)/u;

// A delivery mode travels with the selected packet so HTTP, proactive, and
// desktop turns make the same choice without each rebuilding anchor rules.
export function materialDelivery({ enabled = false, packet = null } = {}) {
  const eligible = Boolean(packet?.key && MATERIAL_PACKET.test(packet.key));
  const materialOnly = Boolean(enabled && eligible);
  return Object.freeze({
    materialOnly,
    anchor: materialOnly ? '' : String(packet?.summary || ''),
    receipt: materialOnly ? Object.freeze({ mode: 'material_exposure', expectedVersion: packet.version }) : null,
  });
}

export function materialReceipt(delivery, packet) {
  if (!delivery?.materialOnly || !packet?.key) return null;
  return { ...delivery.receipt, key: packet.key };
}

export function materialContextPacket(packet, delivery) {
  if (!packet || !delivery?.materialOnly) return packet;
  // Agenda opportunities predate this experiment and carry a legacy rendering
  // instruction in detail. It is not factual material for the model.
  if (!String(packet.key || '').startsWith('agenda:')) return packet;
  return { ...packet, detail: String(packet.detail || '').replace(/；?正文直接承接这句，不要复述开头[。.]?/u, '').trim() };
}
