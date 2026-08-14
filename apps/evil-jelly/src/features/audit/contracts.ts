/** Audit vocabulary shared by the feature and its CLI route. */

export type AuditFindingKind = "clone" | "complexity" | "fragmentation" | "doc-drift" | "doc-sync";

export const CODE_AUDIT_FAMILIES = ["clone", "complexity", "fragmentation"] as const;
export const DOC_AUDIT_FAMILIES = ["doc-drift", "doc-sync"] as const;
export const ALL_AUDIT_FAMILIES = [...CODE_AUDIT_FAMILIES, ...DOC_AUDIT_FAMILIES] as const;

export type CodeAuditFamilyKind = (typeof CODE_AUDIT_FAMILIES)[number];

/** Families selectable via the required `evil audit --family` option. */
export const SELECTABLE_AUDIT_FAMILIES = ALL_AUDIT_FAMILIES;

export type SelectableAuditFamilyKind = (typeof SELECTABLE_AUDIT_FAMILIES)[number];
