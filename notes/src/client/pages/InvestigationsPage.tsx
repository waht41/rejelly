import { useEffect, useMemo, useState } from "react";
import type {
  InvestigationDetail,
  InvestigationStatus,
  InvestigationSummary,
} from "../../shared/investigations";
import { fetchJson, getErrorMessage } from "../api";
import { DetailHeader } from "../components/DetailHeader";
import { MarkdownBody } from "../components/MarkdownBody";
import { Meta } from "../components/Meta";
import { SidebarHeader } from "../components/SidebarHeader";
import type { LoadState, Page } from "../types";

interface InvestigationsResponse {
  investigations: InvestigationSummary[];
}

interface InvestigationResponse {
  investigation: InvestigationDetail;
}

type InvestigationStatusFilter = "all" | InvestigationStatus;

export function InvestigationsPage({
  page,
  onPageChange,
}: {
  page: Page;
  onPageChange: (page: Page) => void;
}) {
  const [investigationsState, setInvestigationsState] = useState<LoadState<InvestigationSummary[]>>(
    {
      status: "loading",
    },
  );
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detailState, setDetailState] = useState<LoadState<InvestigationDetail> | undefined>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<InvestigationStatusFilter>("active");

  useEffect(() => {
    fetchJson<InvestigationsResponse>("/api/investigations")
      .then((data) => {
        setInvestigationsState({ status: "loaded", data: data.investigations });
        setSelectedId(
          data.investigations.find((investigation) => investigation.metadata.status === "active")
            ?.id ?? data.investigations[0]?.id,
        );
      })
      .catch((error: unknown) =>
        setInvestigationsState({ status: "error", error: getErrorMessage(error) }),
      );
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDetailState({ status: "loading" });
    fetchJson<InvestigationResponse>(`/api/investigations/${selectedId}`)
      .then((data) => setDetailState({ status: "loaded", data: data.investigation }))
      .catch((error: unknown) =>
        setDetailState({ status: "error", error: getErrorMessage(error) }),
      );
  }, [selectedId]);

  const investigations = investigationsState.status === "loaded" ? investigationsState.data : [];

  const visibleInvestigations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return investigations.filter((investigation) => {
      if (statusFilter !== "all" && investigation.metadata.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [
        investigation.id,
        investigation.slug,
        investigation.metadata.title,
        investigation.metadata.status,
        investigation.synopsis,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [investigations, query, statusFilter]);

  const statusCounts = useMemo(() => countInvestigationStatuses(investigations), [investigations]);

  return (
    <>
      <aside className="sidebar">
        <SidebarHeader
          count={investigations.length}
          label="inv"
          page={page}
          title="Investigations"
          onPageChange={onPageChange}
        />

        <div className="filters">
          <input
            aria-label="Search investigations"
            placeholder="Search inv"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(toInvestigationStatusFilter(event.target.value))}
          >
            <option value="active">Active</option>
            <option value="later">Later</option>
            <option value="all">All status</option>
            <option value="resolved">Resolved</option>
            <option value="superseded">Superseded</option>
            <option value="archived">Archived</option>
          </select>
          <div className="summaryStrip">
            <span>Active {statusCounts.active}</span>
            <span>Later {statusCounts.later}</span>
            <span>Resolved {statusCounts.resolved}</span>
          </div>
        </div>

        <InvestigationList
          state={investigationsState}
          investigations={visibleInvestigations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </aside>

      <section className="detailPane">
        <InvestigationDetailView state={detailState} />
      </section>
    </>
  );
}

function toInvestigationStatusFilter(value: string): InvestigationStatusFilter {
  if (
    value === "all" ||
    value === "active" ||
    value === "later" ||
    value === "resolved" ||
    value === "superseded" ||
    value === "archived"
  ) {
    return value;
  }
  return "active";
}

function InvestigationList({
  state,
  investigations,
  selectedId,
  onSelect,
}: {
  state: LoadState<InvestigationSummary[]>;
  investigations: InvestigationSummary[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  if (state.status === "loading") return <div className="emptyState">Loading inv...</div>;
  if (state.status === "error") return <div className="emptyState error">{state.error}</div>;
  if (investigations.length === 0) return <div className="emptyState">No matching inv.</div>;

  return (
    <div className="issueList">
      {investigations.map((investigation) => (
        <button
          key={investigation.id}
          className={investigation.id === selectedId ? "issueItem selected" : "issueItem"}
          type="button"
          onClick={() => onSelect(investigation.id)}
        >
          <span className="issueTopline">
            <span className="issueId">{investigation.id}</span>
            <span className={`statusBadge ${investigation.metadata.status}`}>
              {investigation.metadata.status}
            </span>
          </span>
          <span className="issueTitle">{investigation.metadata.title}</span>
          <span className="issueMeta">{investigation.metadata.updatedAt}</span>
        </button>
      ))}
    </div>
  );
}

function InvestigationDetailView({ state }: { state: LoadState<InvestigationDetail> | undefined }) {
  const [copied, setCopied] = useState(false);

  if (!state || state.status === "loading") {
    return <div className="detailEmpty">Select an inv.</div>;
  }
  if (state.status === "error") {
    return <div className="detailEmpty error">{state.error}</div>;
  }

  const investigation = state.data;

  async function copyPath() {
    await navigator.clipboard.writeText(investigation.relativePath);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <article className="issueDetail">
      <DetailHeader
        copied={copied}
        id={investigation.id}
        path={investigation.relativePath}
        title={investigation.metadata.title}
        onCopy={copyPath}
      />

      <div className="metadataGrid">
        <Meta label="Status" value={investigation.metadata.status} />
        <Meta label="Type" value={investigation.metadata.type} />
        <Meta label="Created" value={investigation.metadata.createdAt} />
        <Meta label="Updated" value={investigation.metadata.updatedAt} />
        <Meta label="Slug" value={investigation.slug} />
      </div>

      <MarkdownBody body={investigation.body} />
    </article>
  );
}

function countInvestigationStatuses(investigations: InvestigationSummary[]) {
  let active = 0;
  let later = 0;
  let resolved = 0;
  for (const investigation of investigations) {
    if (investigation.metadata.status === "active") active += 1;
    else if (investigation.metadata.status === "later") later += 1;
    else if (investigation.metadata.status === "resolved") resolved += 1;
  }
  return { active, later, resolved };
}
