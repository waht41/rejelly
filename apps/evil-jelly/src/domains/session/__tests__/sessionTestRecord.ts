import { emptySessionMcpState } from "../../../shared/model/mcp/sessionMcpState";
import type { SessionMeta, SessionRecord } from "../model/sessionTypes";

type SessionRecordOverrides = Partial<Omit<SessionRecord, "meta">> & {
  readonly meta?: Partial<SessionMeta>;
};

export function sessionRecordFixture(overrides: SessionRecordOverrides = {}): SessionRecord {
  const { meta, ...record } = overrides;
  return {
    meta: {
      id: "session-test",
      workspaceRoot: "C:/workspace",
      title: "Test session",
      createdAt: 10,
      updatedAt: 20,
      turns: 0,
      traceIds: [],
      ...meta,
    },
    messages: [],
    mcp: emptySessionMcpState(),
    ...record,
  };
}
