import { useEffect, useMemo, useState } from "react";
import type { IssueDetail, IssueStatus, IssueSummary } from "../../shared/issues";
import { fetchJson, getErrorMessage } from "../api";
import { DetailHeader } from "../components/DetailHeader";
import { MarkdownBody } from "../components/MarkdownBody";
import { Meta } from "../components/Meta";
import { SidebarHeader } from "../components/SidebarHeader";
import type { LoadState, Page } from "../types";

interface IssuesResponse {
  issues: IssueSummary[];
}

interface IssueResponse {
  issue: IssueDetail;
}

type StatusFilter = "active" | "all" | IssueStatus;

const activeIssueStatuses = new Set<IssueStatus>(["open", "in-progress"]);

export function IssuesPage({
  page,
  onPageChange,
}: {
  page: Page;
  onPageChange: (page: Page) => void;
}) {
  const [issuesState, setIssuesState] = useState<LoadState<IssueSummary[]>>({
    status: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detailState, setDetailState] = useState<LoadState<IssueDetail> | undefined>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");

  useEffect(() => {
    fetchJson<IssuesResponse>("/api/issues")
      .then((data) => {
        setIssuesState({ status: "loaded", data: data.issues });
        setSelectedId(data.issues.find((issue) => isIssueVisibleByStatus(issue, "active"))?.id);
      })
      .catch((error: unknown) =>
        setIssuesState({ status: "error", error: getErrorMessage(error) }),
      );
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDetailState({ status: "loading" });
    fetchJson<IssueResponse>(`/api/issues/${selectedId}`)
      .then((data) => setDetailState({ status: "loaded", data: data.issue }))
      .catch((error: unknown) =>
        setDetailState({ status: "error", error: getErrorMessage(error) }),
      );
  }, [selectedId]);

  const issues = issuesState.status === "loaded" ? issuesState.data : [];
  const areas = useMemo(() => {
    const values = new Set<string>();
    for (const issue of issues) {
      for (const area of issue.metadata.areas ?? []) values.add(area);
    }
    return [...values].sort((a, b) => a.localeCompare(b, "en"));
  }, [issues]);

  const visibleIssues = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (!isIssueVisibleByStatus(issue, statusFilter)) return false;
      if (severityFilter !== "all" && issue.metadata.severity !== severityFilter) return false;
      if (areaFilter !== "all" && !(issue.metadata.areas ?? []).includes(areaFilter)) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [
        issue.id,
        issue.slug,
        issue.metadata.title,
        issue.metadata.type,
        issue.metadata.priority,
        issue.description,
        ...(issue.metadata.areas ?? []),
        ...(issue.metadata.legacyIds ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [areaFilter, issues, query, severityFilter, statusFilter]);

  return (
    <>
      <aside className="sidebar">
        <SidebarHeader
          count={issues.length}
          label="notes"
          page={page}
          title="Issues"
          onPageChange={onPageChange}
        />

        <div className="filters">
          <input
            aria-label="Search issues"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="filterRow">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(toStatusFilter(event.target.value))}
            >
              <option value="active">Open + In progress</option>
              <option value="all">All status</option>
              <option value="open">Open</option>
              <option value="in-progress">In progress</option>
              <option value="later">Later</option>
              <option value="done">Done</option>
              <option value="wontfix">Wontfix</option>
            </select>
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
            >
              <option value="all">All severity</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
            <option value="all">All areas</option>
            {areas.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </div>

        <IssueList
          state={issuesState}
          issues={visibleIssues}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </aside>

      <section className="detailPane">
        <IssueDetailView state={detailState} />
      </section>
    </>
  );
}

function isIssueVisibleByStatus(issue: IssueSummary, statusFilter: StatusFilter): boolean {
  if (statusFilter === "all") return true;
  if (statusFilter === "active") return activeIssueStatuses.has(issue.metadata.status);
  return issue.metadata.status === statusFilter;
}

function toStatusFilter(value: string): StatusFilter {
  if (
    value === "active" ||
    value === "all" ||
    value === "open" ||
    value === "in-progress" ||
    value === "later" ||
    value === "done" ||
    value === "wontfix"
  ) {
    return value;
  }
  return "active";
}

function IssueList({
  state,
  issues,
  selectedId,
  onSelect,
}: {
  state: LoadState<IssueSummary[]>;
  issues: IssueSummary[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  if (state.status === "loading") return <div className="emptyState">Loading issues...</div>;
  if (state.status === "error") return <div className="emptyState error">{state.error}</div>;
  if (issues.length === 0) return <div className="emptyState">No matching issues.</div>;

  return (
    <div className="issueList">
      {issues.map((issue) => (
        <button
          key={issue.id}
          className={issue.id === selectedId ? "issueItem selected" : "issueItem"}
          type="button"
          onClick={() => onSelect(issue.id)}
        >
          <span className="issueTopline">
            <span className="issueId">{issue.id}</span>
            <span className={`severity ${issue.metadata.severity}`}>{issue.metadata.severity}</span>
          </span>
          <span className="issueTitle">{issue.metadata.title}</span>
          <span className="issueMeta">
            {issue.metadata.status}
            {issue.metadata.priority ? ` · ${issue.metadata.priority}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

function IssueDetailView({ state }: { state: LoadState<IssueDetail> | undefined }) {
  const [copied, setCopied] = useState<string | undefined>();

  if (!state || state.status === "loading") {
    return <div className="detailEmpty">Select an issue.</div>;
  }
  if (state.status === "error") {
    return <div className="detailEmpty error">{state.error}</div>;
  }

  const issue = state.data;
  const evidence = issue.metadata.evidence ?? [];

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(undefined), 1200);
  }

  return (
    <article className="issueDetail">
      <DetailHeader
        copied={copied === "issue-path"}
        id={issue.id}
        path={issue.relativePath}
        title={issue.metadata.title}
        onCopy={() => copy(issue.relativePath, "issue-path")}
      />

      <div className="metadataGrid">
        <Meta label="Status" value={issue.metadata.status} />
        <Meta label="Severity" value={issue.metadata.severity} />
        <Meta label="Priority" value={issue.metadata.priority} />
        <Meta label="Type" value={issue.metadata.type} />
        <Meta label="Created" value={issue.metadata.createdAt} />
        <Meta label="Updated" value={issue.metadata.updatedAt} />
      </div>

      <div className="chips">
        {(issue.metadata.areas ?? []).map((area) => (
          <span key={area} className="chip">
            {area}
          </span>
        ))}
        {(issue.metadata.legacyIds ?? []).map((legacyId) => (
          <span key={legacyId} className="chip muted">
            {legacyId}
          </span>
        ))}
      </div>

      {evidence.length > 0 ? (
        <section className="panel">
          <h3>Evidence</h3>
          <div className="evidenceList">
            {evidence.map((item, index) => {
              const target = item.file
                ? `${item.file}${item.line ? `:${item.line}` : ""}`
                : "unknown";
              return (
                <div className="evidenceItem" key={`${target}-${index}`}>
                  <button
                    className="pathButton"
                    type="button"
                    onClick={() => copy(target, `evidence-${index}`)}
                  >
                    {target}
                  </button>
                  {item.note ? <p>{item.note}</p> : null}
                  {copied === `evidence-${index}` ? <span className="copied">Copied</span> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <MarkdownBody body={issue.body} />
    </article>
  );
}
