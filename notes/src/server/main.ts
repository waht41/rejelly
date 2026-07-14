import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { InvestigationStore } from "./investigation-store";
import { IssueStore } from "./issue-store";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageRoot, "..");
const port = Number(process.env.PORT ?? 4381);
const host = process.env.HOST ?? "127.0.0.1";

const app = Fastify({
  logger: true,
});

const issueStore = new IssueStore(repoRoot);
const investigationStore = new InvestigationStore(repoRoot);

await app.register(cors, {
  origin: true,
});

app.get("/api/health", async () => ({
  ok: true,
}));

app.get("/api/issues", async () => ({
  issues: await issueStore.listIssues(),
}));

app.get<{ Params: { id: string } }>("/api/issues/:id", async (request, reply) => {
  const issue = await issueStore.getIssue(request.params.id);
  if (!issue) {
    return reply.code(404).send({ error: "Issue not found" });
  }
  return { issue };
});

app.get("/api/investigations", async () => ({
  investigations: await investigationStore.listInvestigations(),
}));

app.get<{ Params: { id: string } }>("/api/investigations/:id", async (request, reply) => {
  const investigation = await investigationStore.getInvestigation(request.params.id);
  if (!investigation) {
    return reply.code(404).send({ error: "Investigation not found" });
  }
  return { investigation };
});

const staticRoot = path.join(packageRoot, "dist", "client");
await app.register(fastifyStatic, {
  root: staticRoot,
  prefix: "/",
  decorateReply: false,
});

await app.listen({ host, port });
