import type { Page } from "../types";

export function SidebarHeader({
  count,
  label,
  page,
  title,
  onPageChange,
}: {
  count: number;
  label: string;
  page: Page;
  title: string;
  onPageChange: (page: Page) => void;
}) {
  return (
    <header className="sidebarHeader">
      <div>
        <h1>{title}</h1>
        <p>
          {count} {label}
        </p>
      </div>
      <div className="headerActions">
        <div className="pageTabs" aria-label="View">
          <button
            className={page === "issues" ? "selected" : ""}
            type="button"
            onClick={() => onPageChange("issues")}
          >
            Issues
          </button>
          <button
            className={page === "investigations" ? "selected" : ""}
            type="button"
            onClick={() => onPageChange("investigations")}
          >
            INV
          </button>
        </div>
        <button className="iconButton" type="button" onClick={() => window.location.reload()}>
          ↻
        </button>
      </div>
    </header>
  );
}
