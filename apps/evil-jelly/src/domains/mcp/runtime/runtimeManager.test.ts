import type { McpNativeToolDescriptor } from "@rejelly/adapter-mcp";
import { describe, expect, it, vi } from "vitest";
import { defaultMcpServerDefinition } from "../configuration/configuration";
import type { McpDesiredConfig, McpDesiredServer } from "../contracts";
import {
  type McpRuntimeConnection,
  type McpRuntimeConnectionCallbacks,
  type McpRuntimeConnector,
  McpRuntimeManager,
  type McpRuntimeScheduler,
} from "./runtimeManager";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function server(
  id: string,
  options: {
    command?: string;
    enabled?: boolean;
    maxConcurrency?: number;
    source?: McpDesiredServer["source"];
    transport?: "stdio" | "streamableHttp";
  } = {},
): McpDesiredServer {
  const transport =
    options.transport === "streamableHttp"
      ? ({ type: "streamableHttp", url: `https://${id}.example/mcp` } as const)
      : ({ type: "stdio", command: options.command ?? id } as const);
  return {
    id,
    source: options.source ?? { kind: "user" },
    definition: defaultMcpServerDefinition({
      transport,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    }),
  };
}

function desired(...servers: McpDesiredServer[]): McpDesiredConfig {
  return { servers };
}

class FakeConnection implements McpRuntimeConnection {
  readonly client = { id: Math.random() };
  readonly close = vi.fn<() => Promise<void>>(async () => undefined);
  readonly listTools = vi.fn<() => Promise<readonly McpNativeToolDescriptor[]>>();
  readonly callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));

  constructor(tools: readonly McpNativeToolDescriptor[] = []) {
    this.listTools.mockResolvedValue(tools);
  }
}

interface ConnectAttempt {
  server: McpDesiredServer;
  signal: AbortSignal;
  callbacks: McpRuntimeConnectionCallbacks;
  result: ReturnType<typeof deferred<McpRuntimeConnection>>;
}

class ControlledConnector implements McpRuntimeConnector {
  readonly attempts: ConnectAttempt[] = [];

  connect(
    requested: McpDesiredServer,
    signal: AbortSignal,
    callbacks: McpRuntimeConnectionCallbacks,
  ): Promise<McpRuntimeConnection> {
    const result = deferred<McpRuntimeConnection>();
    this.attempts.push({ server: requested, signal, callbacks, result });
    return result.promise;
  }
}

class ControlledScheduler implements McpRuntimeScheduler {
  private sequence = 0;
  readonly pending = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = ++this.sequence;
    this.pending.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  fireAll(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}

async function waitForStatus(
  manager: McpRuntimeManager,
  serverId: string,
  status: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(manager.getSnapshot().servers.find((item) => item.serverId === serverId)?.status).toBe(
      status,
    );
  });
}

describe("McpRuntimeManager", () => {
  it("advertises configured chat servers while routing only always and selected servers", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    const baseAlways = server("always");
    const always: McpDesiredServer = {
      ...baseAlways,
      definition: {
        ...baseAlways.definition,
        use: {
          ...baseAlways.definition.use,
          chat: { exposure: "always", required: false },
        },
      },
    };
    await manager.reconcile(desired(always, server("selected")));
    for (const attempt of connector.attempts) {
      attempt.result.resolve(
        new FakeConnection([
          {
            name: "read",
            description: `Read ${attempt.server.id}`,
            inputSchema: { type: "object" },
          },
        ]),
      );
    }
    await waitForStatus(manager, "always", "ready");
    await waitForStatus(manager, "selected", "ready");

    const first = manager.captureDispatchBinding("chat");
    const second = manager.captureDispatchBinding("chat", ["selected"]);

    expect(first.servers.map((item) => item.serverId)).toEqual(["always", "selected"]);
    expect(second.servers.map((item) => item.serverId)).toEqual(["always", "selected"]);
    expect(manager.getVisibleServerIds("chat")).toEqual(["always", "selected"]);
    await expect(manager.waitForServer("always")).resolves.toMatchObject({ status: "ready" });
    expect(first.route({ serverId: "selected", nativeToolName: "read" })).toBeUndefined();
    expect(second.route({ serverId: "always", nativeToolName: "read" })?.description).toBe(
      "Read always",
    );
    expect(second.route({ serverId: "selected", nativeToolName: "read" })?.description).toBe(
      "Read selected",
    );
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(Object.isFrozen(second.servers)).toBe(true);
    await manager.dispose();
  });

  it("waits only for required servers that are effective for this dispatch", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    const base = server("docs");
    const required: McpDesiredServer = {
      ...base,
      definition: {
        ...base.definition,
        use: {
          ...base.definition.use,
          chat: { exposure: "explicit", required: true },
        },
      },
    };
    await manager.reconcile(desired(required));

    await expect(manager.waitForRequiredServers("chat")).resolves.toEqual([]);
    const waiting = manager.waitForRequiredServers("chat", ["docs"]);
    connector.attempts[0]!.result.resolve(new FakeConnection());
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ serverId: "docs", status: "ready" }),
    ]);
    await manager.dispose();
  });

  it("rejects a captured route when the live catalog changes before call", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs")));
    const connection = new FakeConnection([{ name: "read", inputSchema: { type: "object" } }]);
    connector.attempts[0]!.result.resolve(connection);
    await waitForStatus(manager, "docs", "ready");
    const route = manager
      .captureDispatchBinding("chat", ["docs"])
      .route({ serverId: "docs", nativeToolName: "read" })!;

    connector.attempts[0]!.callbacks.onToolsChanged(null, [
      {
        name: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    await vi.waitFor(() =>
      expect(manager.getCatalog("docs")?.revision).not.toBe(route.catalogRevision),
    );

    await expect(manager.callBoundTool("chat", route, {})).resolves.toMatchObject({
      ok: false,
      code: "catalog_changed",
    });
    expect(connection.callTool).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("limits twelve concurrent Audit calls through the shared server semaphore", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    const base = server("docs", { maxConcurrency: 2 });
    const auditServer: McpDesiredServer = {
      ...base,
      definition: {
        ...base.definition,
        use: {
          ...base.definition.use,
          audit: {
            ...base.definition.use.audit,
            exposure: "always",
            allow: ["read"],
          },
        },
      },
    };
    await manager.reconcile(desired(auditServer));
    const connection = new FakeConnection([{ name: "read", inputSchema: { type: "object" } }]);
    const gate = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    connection.callTool.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
      return { content: [{ type: "text", text: "ok" }] };
    });
    connector.attempts[0]!.result.resolve(connection);
    await waitForStatus(manager, "docs", "ready");
    const route = manager
      .captureDispatchBinding("audit")
      .route({ serverId: "docs", nativeToolName: "read" })!;

    const calls = Array.from({ length: 12 }, (_, index) =>
      manager.callBoundTool("audit", route, { index }),
    );
    await vi.waitFor(() => expect(connection.callTool).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    gate.resolve();
    await expect(Promise.all(calls)).resolves.toEqual(
      Array.from({ length: 12 }, () => expect.objectContaining({ ok: true })),
    );
    expect(maximumActive).toBe(2);
    await manager.dispose();
  });

  it("lets an in-flight call finish when its server is removed and rejects later calls", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs")));
    const connection = new FakeConnection([{ name: "read", inputSchema: { type: "object" } }]);
    const result = deferred<{ content: { type: "text"; text: string }[] }>();
    connection.callTool.mockImplementation(() => result.promise);
    connector.attempts[0]!.result.resolve(connection);
    await waitForStatus(manager, "docs", "ready");
    const route = manager
      .captureDispatchBinding("chat", ["docs"])
      .route({ serverId: "docs", nativeToolName: "read" })!;

    const inFlight = manager.callBoundTool("chat", route, {});
    await vi.waitFor(() => expect(connection.callTool).toHaveBeenCalledOnce());
    await manager.reconcile(desired());
    expect(connection.close).toHaveBeenCalledOnce();
    result.resolve({ content: [{ type: "text", text: "finished" }] });

    await expect(inFlight).resolves.toMatchObject({ ok: true });
    await expect(manager.callBoundTool("chat", route, {})).resolves.toMatchObject({
      ok: false,
      code: "tool_unavailable",
    });
    await manager.dispose();
  });

  it("publishes immutable ready state and refreshes one server catalog", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs"), server("search")));
    const docs = new FakeConnection([
      { name: "read", description: "Read docs", inputSchema: { type: "object" } },
    ]);
    const search = new FakeConnection([{ name: "query", inputSchema: { type: "object" } }]);
    connector.attempts[0]!.result.resolve(docs);
    connector.attempts[1]!.result.resolve(search);
    await waitForStatus(manager, "docs", "ready");
    await waitForStatus(manager, "search", "ready");

    const before = manager.getSnapshot();
    const searchRevision = manager.getCatalog("search")?.revision;
    connector.attempts[0]!.callbacks.onToolsChanged(null, [
      { name: "write", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ]);
    await vi.waitFor(() => expect(manager.getCatalog("docs")?.tools[0]?.name).toBe("write"));

    const after = manager.getSnapshot();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(manager.getCatalog("search")?.revision).toBe(searchRevision);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.servers)).toBe(true);
    expect(Object.isFrozen(manager.getCatalog("docs")?.tools)).toBe(true);
    await manager.dispose();
  });

  it("reuses an unchanged ready connection", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    const config = desired(server("docs"));
    await manager.reconcile(config);
    const connection = new FakeConnection();
    connector.attempts[0]!.result.resolve(connection);
    await waitForStatus(manager, "docs", "ready");

    await manager.reconcile(config);

    expect(connector.attempts).toHaveLength(1);
    expect(connection.close).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("reuses transport when only policy changes and publishes the new config fingerprint", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    const original = server("docs");
    await manager.reconcile(desired(original));
    const connection = new FakeConnection();
    connector.attempts[0]!.result.resolve(connection);
    await waitForStatus(manager, "docs", "ready");
    const beforeFingerprint = manager.getSnapshot().servers[0]!.configFingerprint;
    const changed: McpDesiredServer = {
      ...original,
      definition: {
        ...original.definition,
        tools: { deny: ["write"] },
      },
    };

    await manager.reconcile(desired(changed));

    expect(connector.attempts).toHaveLength(1);
    expect(connection.close).not.toHaveBeenCalled();
    expect(manager.getSnapshot().servers[0]!.configFingerprint).not.toBe(beforeFingerprint);
    expect(manager.getReadyClient("docs")).toBe(connection.client);
    await manager.dispose();
  });

  it("cancels a pending replacement and closes its late result without resurrection", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs", { command: "old" })));
    const oldAttempt = connector.attempts[0]!;

    await manager.reconcile(desired(server("docs", { command: "new" })));
    expect(oldAttempt.signal.aborted).toBe(true);
    expect(connector.attempts).toHaveLength(2);
    const lateConnection = new FakeConnection();
    oldAttempt.result.resolve(lateConnection);
    const currentConnection = new FakeConnection();
    connector.attempts[1]!.result.resolve(currentConnection);
    await waitForStatus(manager, "docs", "ready");
    await vi.waitFor(() => expect(lateConnection.close).toHaveBeenCalledOnce());

    expect(manager.getReadyClient("docs")).toBe(currentConnection.client);
    expect(manager.getSnapshot().servers).toHaveLength(1);
    await manager.dispose();
  });

  it("does not revive a server disabled while connecting", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs")));
    const pending = connector.attempts[0]!;

    await manager.reconcile(desired(server("docs", { enabled: false })));
    const lateConnection = new FakeConnection();
    pending.result.resolve(lateConnection);
    await waitForStatus(manager, "docs", "disabled");
    await vi.waitFor(() => expect(lateConnection.close).toHaveBeenCalledOnce());

    expect(manager.getReadyClient("docs")).toBeUndefined();
    await manager.dispose();
  });

  it("retries remote failures but leaves stdio failure stopped", async () => {
    const connector = new ControlledConnector();
    const scheduler = new ControlledScheduler();
    const manager = new McpRuntimeManager(connector, {
      scheduler,
      remoteRetryDelaysMs: [1],
    });
    await manager.reconcile(
      desired(server("remote", { transport: "streamableHttp" }), server("local")),
    );
    connector.attempts
      .find((attempt) => attempt.server.id === "remote")!
      .result.reject(new Error("offline"));
    connector.attempts
      .find((attempt) => attempt.server.id === "local")!
      .result.reject(new Error("exited"));
    await waitForStatus(manager, "remote", "failed");
    await waitForStatus(manager, "local", "failed");
    expect(scheduler.pending.size).toBe(1);

    scheduler.fireAll();
    await vi.waitFor(() => expect(connector.attempts).toHaveLength(3));
    const retry = connector.attempts[2]!;
    expect(retry.server.id).toBe("remote");
    retry.result.resolve(new FakeConnection());
    await waitForStatus(manager, "remote", "ready");
    expect(connector.attempts.filter((attempt) => attempt.server.id === "local")).toHaveLength(1);
    await manager.dispose();
  });

  it("does not restart stdio after an established connection exits", async () => {
    const connector = new ControlledConnector();
    const scheduler = new ControlledScheduler();
    const manager = new McpRuntimeManager(connector, { scheduler });
    await manager.reconcile(desired(server("local")));
    connector.attempts[0]!.result.resolve(new FakeConnection());
    await waitForStatus(manager, "local", "ready");

    connector.attempts[0]!.callbacks.onClose();
    await waitForStatus(manager, "local", "failed");

    expect(connector.attempts).toHaveLength(1);
    expect(scheduler.pending.size).toBe(0);
    await manager.dispose();
  });

  it("cancels a scheduled retry when the server is removed", async () => {
    const connector = new ControlledConnector();
    const scheduler = new ControlledScheduler();
    const manager = new McpRuntimeManager(connector, {
      scheduler,
      remoteRetryDelaysMs: [1],
    });
    await manager.reconcile(desired(server("remote", { transport: "streamableHttp" })));
    connector.attempts[0]!.result.reject(new Error("offline"));
    await waitForStatus(manager, "remote", "failed");
    expect(scheduler.pending.size).toBe(1);

    await manager.reconcile(desired());
    expect(scheduler.pending.size).toBe(0);
    scheduler.fireAll();
    await Promise.resolve();
    expect(connector.attempts).toHaveLength(1);
    expect(manager.getSnapshot().servers).toEqual([]);
    await manager.dispose();
  });

  it("manual reload replaces a ready client even when the fingerprint is unchanged", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs")));
    const first = new FakeConnection();
    connector.attempts[0]!.result.resolve(first);
    await waitForStatus(manager, "docs", "ready");

    await manager.reload("docs");
    expect(first.close).toHaveBeenCalledOnce();
    expect(connector.attempts).toHaveLength(2);
    const second = new FakeConnection();
    connector.attempts[1]!.result.resolve(second);
    await waitForStatus(manager, "docs", "ready");
    expect(manager.getReadyClient("docs")).toBe(second.client);
    await manager.dispose();
  });

  it("keeps workspace definitions untrusted until their exact fingerprint is granted", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    const workspaceServer = server("project", { source: { kind: "workspace" } });
    await manager.reconcile(desired(workspaceServer));
    await waitForStatus(manager, "project", "untrusted");
    expect(connector.attempts).toHaveLength(0);

    const state = manager.getSnapshot().servers[0]!;
    await manager.reconcile(desired(workspaceServer), [
      { serverId: "project", configFingerprint: state.configFingerprint },
    ]);
    expect(connector.attempts).toHaveLength(1);
    await manager.dispose();
  });

  it("aborts pending work and closes late clients during dispose", async () => {
    const connector = new ControlledConnector();
    const manager = new McpRuntimeManager(connector);
    await manager.reconcile(desired(server("docs")));
    const attempt = connector.attempts[0]!;

    await manager.dispose();
    expect(attempt.signal.aborted).toBe(true);
    const late = new FakeConnection();
    attempt.result.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(manager.getSnapshot().servers).toEqual([]);
    await expect(manager.reconcile(desired())).rejects.toThrow(/disposed/);
  });

  it("bounds shutdown when a client close is stuck", async () => {
    const connector = new ControlledConnector();
    const scheduler = new ControlledScheduler();
    const manager = new McpRuntimeManager(connector, { scheduler, closeTimeoutMs: 1 });
    await manager.reconcile(desired(server("docs")));
    const connection = new FakeConnection();
    connection.close.mockImplementation(() => new Promise<void>(() => undefined));
    connector.attempts[0]!.result.resolve(connection);
    await waitForStatus(manager, "docs", "ready");

    const disposing = manager.dispose();
    await vi.waitFor(() => expect(scheduler.pending.size).toBe(1));
    scheduler.fireAll();
    await disposing;

    expect(connection.close).toHaveBeenCalledOnce();
    expect(manager.getSnapshot().servers).toEqual([]);
  });
});
