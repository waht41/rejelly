import { createHash } from "node:crypto";
import { evaluateMcpTrust, type McpTrustGrant } from "../configuration/configuration";
import {
  fingerprintMcpConnectionDefinition,
  fingerprintMcpServerDefinition,
  type McpConsumer,
  type McpDesiredConfig,
  type McpDesiredServer,
  type McpRuntimeSnapshot,
  type McpServerRuntimeState,
} from "../contracts";

export interface McpRuntimeToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpRuntimeCatalog {
  readonly serverId: string;
  readonly revision: string;
  readonly tools: readonly McpRuntimeToolDescriptor[];
}

export interface McpRuntimeConnection {
  /** SDK/client facade borrowed by T2's compatibility kit and T3's gateway adapter. */
  readonly client: unknown;
  listTools(): Promise<readonly McpRuntimeToolDescriptor[]>;
  close(): Promise<void>;
}

export interface McpRuntimeConnectionCallbacks {
  readonly onClose: () => void;
  readonly onError: (error: Error) => void;
  readonly onToolsChanged: (
    error: Error | null,
    tools: readonly McpRuntimeToolDescriptor[] | null,
  ) => void;
}

export interface McpRuntimeConnector {
  connect(
    server: McpDesiredServer,
    signal: AbortSignal,
    callbacks: McpRuntimeConnectionCallbacks,
  ): Promise<McpRuntimeConnection>;
}

export interface McpRuntimeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: McpRuntimeScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface McpRuntimeManagerOptions {
  /** Delay after each failed remote connect. Empty disables automatic retry. */
  readonly remoteRetryDelaysMs?: readonly number[];
  readonly scheduler?: McpRuntimeScheduler;
  readonly closeTimeoutMs?: number;
}

type EntryTarget = "active" | "disabled" | "untrusted";

interface RuntimeEntry {
  server: McpDesiredServer;
  configFingerprint: string;
  connectionFingerprint: string;
  sourceIdentity: string;
  readonly token: number;
  target: EntryTarget;
  status: McpServerRuntimeState["status"];
  error?: string;
  catalog?: McpRuntimeCatalog;
  connection?: McpRuntimeConnection;
  abortController?: AbortController;
  retryAttempt: number;
  retryTimer?: unknown;
}

export type McpRuntimeSnapshotListener = (snapshot: McpRuntimeSnapshot) => void;

function sourceIdentity(server: McpDesiredServer): string {
  return server.source.kind === "dynamic"
    ? `${server.source.kind}:${server.source.sourceId}`
    : server.source.kind;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function catalogRevision(tools: readonly McpRuntimeToolDescriptor[]): string {
  const projection = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    }));
  return createHash("sha256").update(canonicalJson(projection)).digest("hex");
}

function freezeCatalog(
  serverId: string,
  tools: readonly McpRuntimeToolDescriptor[],
): McpRuntimeCatalog {
  const frozenTools = tools
    .map((tool) =>
      Object.freeze({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: Object.freeze(structuredClone(tool.inputSchema)),
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    serverId,
    revision: catalogRevision(frozenTools),
    tools: Object.freeze(frozenTools),
  });
}

function desiredFingerprint(entries: Iterable<RuntimeEntry>): string {
  const projection = [...entries]
    .map((entry) => ({
      id: entry.server.id,
      fingerprint: entry.configFingerprint,
      source: entry.sourceIdentity,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function targetFor(server: McpDesiredServer, grants: readonly McpTrustGrant[]): EntryTarget {
  if (!server.definition.enabled) return "disabled";
  return evaluateMcpTrust(server, grants).trusted ? "active" : "untrusted";
}

function initialStatus(target: EntryTarget): McpServerRuntimeState["status"] {
  if (target === "disabled") return "disabled";
  return target === "untrusted" ? "untrusted" : "pending";
}

export class McpRuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly listeners = new Set<McpRuntimeSnapshotListener>();
  private readonly retryDelays: readonly number[];
  private readonly scheduler: McpRuntimeScheduler;
  private readonly closeTimeoutMs: number;
  private serial: Promise<void> = Promise.resolve();
  private tokenSequence = 0;
  private generation = 0;
  private disposed = false;
  private snapshot: McpRuntimeSnapshot = Object.freeze({
    generation: 0,
    desiredFingerprint: createHash("sha256").update("[]").digest("hex"),
    servers: Object.freeze([]),
  });

  constructor(
    private readonly connector: McpRuntimeConnector,
    options: McpRuntimeManagerOptions = {},
  ) {
    this.retryDelays = options.remoteRetryDelaysMs ?? [1_000, 2_500, 5_000];
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
  }

  getSnapshot(): McpRuntimeSnapshot {
    return this.snapshot;
  }

  getCatalog(serverId: string): McpRuntimeCatalog | undefined {
    return this.entries.get(serverId)?.catalog;
  }

  getReadyClient(serverId: string): unknown | undefined {
    const entry = this.entries.get(serverId);
    return entry?.status === "ready" ? entry.connection?.client : undefined;
  }

  getReadyServerIds(): readonly string[] {
    return Object.freeze(
      [...this.entries.values()]
        .filter((entry) => entry.status === "ready" && entry.connection !== undefined)
        .map((entry) => entry.server.id)
        .sort(),
    );
  }

  subscribe(listener: McpRuntimeSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconcile(
    desired: McpDesiredConfig,
    grants: readonly McpTrustGrant[] = [],
  ): Promise<McpRuntimeSnapshot> {
    return this.enqueue(async () => {
      this.assertActive();
      const desiredById = new Map<string, McpDesiredServer>();
      for (const server of desired.servers) {
        if (desiredById.has(server.id)) {
          throw new Error(`Duplicate MCP server id in desired configuration: ${server.id}`);
        }
        desiredById.set(server.id, server);
      }

      for (const [serverId, entry] of [...this.entries]) {
        const next = desiredById.get(serverId);
        if (!next) {
          this.entries.delete(serverId);
          await this.stopEntry(entry);
          continue;
        }
        const nextFingerprint = fingerprintMcpServerDefinition(next.id, next.definition);
        const nextConnectionFingerprint = fingerprintMcpConnectionDefinition(
          next.id,
          next.definition,
        );
        const nextTarget = targetFor(next, grants);
        if (
          entry.connectionFingerprint !== nextConnectionFingerprint ||
          entry.target !== nextTarget
        ) {
          this.entries.delete(serverId);
          await this.stopEntry(entry);
        } else {
          entry.server = next;
          entry.configFingerprint = nextFingerprint;
          entry.sourceIdentity = sourceIdentity(next);
          desiredById.delete(serverId);
        }
      }

      for (const server of desiredById.values()) {
        const target = targetFor(server, grants);
        const entry: RuntimeEntry = {
          server,
          configFingerprint: fingerprintMcpServerDefinition(server.id, server.definition),
          connectionFingerprint: fingerprintMcpConnectionDefinition(server.id, server.definition),
          sourceIdentity: sourceIdentity(server),
          token: ++this.tokenSequence,
          target,
          status: initialStatus(target),
          retryAttempt: 0,
        };
        this.entries.set(server.id, entry);
        if (target === "active") this.beginConnect(entry);
      }
      this.publish();
      return this.snapshot;
    });
  }

  async reload(serverId?: string): Promise<McpRuntimeSnapshot> {
    return this.enqueue(async () => {
      this.assertActive();
      const targets = serverId
        ? [this.entries.get(serverId)].filter((entry): entry is RuntimeEntry => entry !== undefined)
        : [...this.entries.values()];
      if (serverId && targets.length === 0) throw new Error(`Unknown MCP server: ${serverId}`);
      for (const previous of targets) {
        const replacement: RuntimeEntry = {
          server: previous.server,
          configFingerprint: previous.configFingerprint,
          connectionFingerprint: previous.connectionFingerprint,
          sourceIdentity: previous.sourceIdentity,
          token: ++this.tokenSequence,
          target: previous.target,
          status: initialStatus(previous.target),
          retryAttempt: 0,
        };
        this.entries.set(previous.server.id, replacement);
        await this.stopEntry(previous);
        if (replacement.target === "active") this.beginConnect(replacement);
      }
      this.publish();
      return this.snapshot;
    });
  }

  /** Required-policy barrier for a later composition boundary; non-required servers never block. */
  requiredServerIds(consumer: McpConsumer): readonly string[] {
    return Object.freeze(
      [...this.entries.values()]
        .filter(
          (entry) =>
            entry.server.definition.use[consumer].required &&
            entry.server.definition.use[consumer].exposure !== "off",
        )
        .map((entry) => entry.server.id)
        .sort(),
    );
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return;
      this.disposed = true;
      const entries = [...this.entries.values()];
      this.entries.clear();
      await Promise.allSettled(entries.map((entry) => this.stopEntry(entry)));
      this.publish();
      this.listeners.clear();
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("MCP runtime manager is disposed");
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrent(entry: RuntimeEntry): boolean {
    return !this.disposed && this.entries.get(entry.server.id)?.token === entry.token;
  }

  private beginConnect(entry: RuntimeEntry): void {
    if (!this.isCurrent(entry) || entry.target !== "active") return;
    this.clearRetry(entry);
    const abortController = new AbortController();
    entry.abortController = abortController;
    entry.status = "pending";
    entry.error = undefined;
    const callbacks: McpRuntimeConnectionCallbacks = {
      onClose: () => {
        void this.enqueue(() => this.handleConnectionClosed(entry));
      },
      onError: (error) => {
        void this.enqueue(() => this.handleConnectionError(entry, error));
      },
      onToolsChanged: (error, tools) => {
        void this.enqueue(() => this.handleToolsChanged(entry, error, tools));
      },
    };
    void this.connector.connect(entry.server, abortController.signal, callbacks).then(
      (connection) => {
        void this.enqueue(() => this.acceptConnection(entry, connection));
      },
      (error) => {
        void this.enqueue(() => this.handleConnectFailure(entry, error));
      },
    );
  }

  private async acceptConnection(
    entry: RuntimeEntry,
    connection: McpRuntimeConnection,
  ): Promise<void> {
    if (!this.isCurrent(entry) || entry.abortController?.signal.aborted) {
      await this.closeConnection(connection);
      return;
    }
    entry.abortController = undefined;
    entry.connection = connection;
    void connection.listTools().then(
      (tools) => {
        void this.enqueue(() => this.acceptInitialCatalog(entry, connection, tools));
      },
      (error) => {
        void this.enqueue(() => this.handleCatalogFailure(entry, connection, error));
      },
    );
  }

  private async acceptInitialCatalog(
    entry: RuntimeEntry,
    connection: McpRuntimeConnection,
    tools: readonly McpRuntimeToolDescriptor[],
  ): Promise<void> {
    if (!this.isCurrent(entry) || entry.connection !== connection) {
      await this.closeConnection(connection);
      return;
    }
    entry.catalog = freezeCatalog(entry.server.id, tools);
    entry.status = "ready";
    entry.error = undefined;
    entry.retryAttempt = 0;
    this.publish();
  }

  private async handleCatalogFailure(
    entry: RuntimeEntry,
    connection: McpRuntimeConnection,
    error: unknown,
  ): Promise<void> {
    if (!this.isCurrent(entry) || entry.connection !== connection) {
      await this.closeConnection(connection);
      return;
    }
    entry.connection = undefined;
    await this.closeConnection(connection);
    this.failEntry(entry, error);
  }

  private async handleConnectFailure(entry: RuntimeEntry, error: unknown): Promise<void> {
    if (!this.isCurrent(entry)) return;
    entry.abortController = undefined;
    this.failEntry(entry, error);
  }

  private failEntry(entry: RuntimeEntry, error: unknown): void {
    if (!this.isCurrent(entry)) return;
    entry.connection = undefined;
    entry.catalog = undefined;
    entry.status = "failed";
    entry.error = errorMessage(error);
    this.scheduleRetry(entry);
    this.publish();
  }

  private async handleConnectionClosed(entry: RuntimeEntry): Promise<void> {
    if (!this.isCurrent(entry) || !entry.connection) return;
    entry.connection = undefined;
    entry.catalog = undefined;
    this.failEntry(entry, new Error("MCP connection closed"));
  }

  private handleConnectionError(entry: RuntimeEntry, error: Error): void {
    if (!this.isCurrent(entry) || entry.status !== "ready") return;
    entry.error = errorMessage(error);
    this.publish();
  }

  private handleToolsChanged(
    entry: RuntimeEntry,
    error: Error | null,
    tools: readonly McpRuntimeToolDescriptor[] | null,
  ): void {
    if (!this.isCurrent(entry) || entry.status !== "ready" || !entry.connection) return;
    if (error || !tools) {
      entry.error = error ? errorMessage(error) : "MCP tools/list refresh returned no catalog";
      this.publish();
      return;
    }
    entry.catalog = freezeCatalog(entry.server.id, tools);
    entry.error = undefined;
    this.publish();
  }

  private scheduleRetry(entry: RuntimeEntry): void {
    if (
      entry.server.definition.transport.type !== "streamableHttp" ||
      entry.retryAttempt >= this.retryDelays.length ||
      !this.isCurrent(entry)
    ) {
      return;
    }
    const delay = this.retryDelays[entry.retryAttempt] ?? 0;
    entry.retryAttempt += 1;
    entry.retryTimer = this.scheduler.setTimeout(() => {
      void this.enqueue(() => {
        if (!this.isCurrent(entry) || entry.status !== "failed") return;
        entry.retryTimer = undefined;
        this.beginConnect(entry);
        this.publish();
      });
    }, delay);
  }

  private clearRetry(entry: RuntimeEntry): void {
    if (entry.retryTimer === undefined) return;
    this.scheduler.clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }

  private async stopEntry(entry: RuntimeEntry): Promise<void> {
    this.clearRetry(entry);
    entry.abortController?.abort();
    entry.abortController = undefined;
    const connection = entry.connection;
    entry.connection = undefined;
    entry.catalog = undefined;
    if (connection) await this.closeConnection(connection);
  }

  private async closeConnection(connection: McpRuntimeConnection): Promise<void> {
    let timeout: unknown;
    await Promise.race([
      connection.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = this.scheduler.setTimeout(resolve, this.closeTimeoutMs);
      }),
    ]);
    if (timeout !== undefined) this.scheduler.clearTimeout(timeout);
  }

  private publish(): void {
    const servers = [...this.entries.values()]
      .map(
        (entry): McpServerRuntimeState =>
          Object.freeze({
            serverId: entry.server.id,
            configFingerprint: entry.configFingerprint,
            status: entry.status,
            ...(entry.catalog ? { catalogRevision: entry.catalog.revision } : {}),
            ...(entry.error ? { error: entry.error } : {}),
          }),
      )
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    this.snapshot = Object.freeze({
      generation: ++this.generation,
      desiredFingerprint: desiredFingerprint(this.entries.values()),
      servers: Object.freeze(servers),
    });
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        // Observers cannot corrupt runtime serialization.
      }
    }
  }
}
