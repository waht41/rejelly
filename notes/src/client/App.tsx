import { useState } from "react";
import { InvestigationsPage } from "./pages/InvestigationsPage";
import { IssuesPage } from "./pages/IssuesPage";
import type { Page } from "./types";

export function App() {
  const [page, setPage] = useState<Page>("issues");

  return (
    <main className="shell">
      {page === "issues" ? (
        <IssuesPage page={page} onPageChange={setPage} />
      ) : (
        <InvestigationsPage page={page} onPageChange={setPage} />
      )}
    </main>
  );
}
