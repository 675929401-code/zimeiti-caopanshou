import type { MaterialKind, ProductionMaterial } from "./contracts";

export type DirectorSlotContract = {
  key: string;
  label: string;
  min: number;
  max: number;
  kinds: string[];
};

function supports(slot: DirectorSlotContract, kind: MaterialKind) {
  return slot.kinds.includes(kind);
}

export function validateDirectorMaterialContract(materials: ProductionMaterial[], slots: DirectorSlotContract[]) {
  const issues: string[] = [];
  for (const material of materials) {
    const slot = slots.find((candidate) => candidate.key === material.role);
    if (!slot) {
      issues.push(`素材“${material.name}”尚未分配到当前编导的素材职责`);
      continue;
    }
    if (!supports(slot, material.kind)) issues.push(`素材“${material.name}”不能用于“${slot.label}”`);
  }
  for (const slot of slots) {
    const count = materials.filter((material) => material.role === slot.key).length;
    if (count < slot.min || count > slot.max) issues.push(`${slot.label}需要 ${slot.min}–${slot.max} 个素材，当前 ${count} 个`);
  }
  return [...new Set(issues)];
}

export function assignDirectorMaterialRoles(materials: ProductionMaterial[], slots: DirectorSlotContract[]) {
  const counts = new Map<string, number>();
  return materials.map((material) => {
    const current = slots.find((slot) => slot.key === material.role && supports(slot, material.kind) && (counts.get(slot.key) || 0) < slot.max);
    const selected = current || slots.find((slot) => supports(slot, material.kind) && (counts.get(slot.key) || 0) < slot.max);
    if (!selected) return { ...material, role: "unassigned" };
    counts.set(selected.key, (counts.get(selected.key) || 0) + 1);
    return { ...material, role: selected.key };
  });
}
