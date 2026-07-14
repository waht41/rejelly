export function Meta({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="metaCell">
      <span>{label}</span>
      <strong>{typeof value === "string" && value ? value : "-"}</strong>
    </div>
  );
}
