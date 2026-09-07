import type { PromptInput } from "../../shared/model/prompt/promptInput";
import { promptInputPlainText } from "../../shared/model/prompt/promptInput";

export type PendingSubmission =
  | {
      readonly id: string;
      readonly kind: "steer";
      readonly text: string;
      readonly attachmentCount: number;
    }
  | {
      readonly id: string;
      readonly kind: "command";
      readonly text: string;
    };

let nextPendingId = 1;
let pendingSubmissions: PendingSubmission[] = [];
let subscribers: Array<(items: PendingSubmission[]) => void> = [];

function snapshot(): PendingSubmission[] {
  return pendingSubmissions.map((item) => ({ ...item }));
}

function notifySubscribers(): void {
  const items = snapshot();
  for (const subscriber of subscribers) subscriber(items);
}

export function addPendingSteer(input: PromptInput): string {
  const id = `pending-${nextPendingId++}`;
  pendingSubmissions.push({
    id,
    kind: "steer",
    text: promptInputPlainText(input),
    attachmentCount: input.attachments.length,
  });
  notifySubscribers();
  return id;
}

/** Add one command display entry, coalescing repeated requests for the same command. */
export function ensurePendingCommand(commandText: string): {
  readonly id: string;
  readonly added: boolean;
} {
  const existing = pendingSubmissions.find(
    (item) => item.kind === "command" && item.text === commandText,
  );
  if (existing) return { id: existing.id, added: false };

  const id = `pending-${nextPendingId++}`;
  pendingSubmissions.push({ id, kind: "command", text: commandText });
  notifySubscribers();
  return { id, added: true };
}

export function removePendingSubmission(id: string): void {
  const next = pendingSubmissions.filter((item) => item.id !== id);
  if (next.length === pendingSubmissions.length) return;
  pendingSubmissions = next;
  notifySubscribers();
}

export function getPendingSubmissions(): PendingSubmission[] {
  return snapshot();
}

export function subscribePendingSubmissions(
  subscriber: (items: PendingSubmission[]) => void,
): () => void {
  subscribers.push(subscriber);
  subscriber(snapshot());
  return () => {
    subscribers = subscribers.filter((entry) => entry !== subscriber);
  };
}

export function resetPendingSubmissions(): void {
  pendingSubmissions = [];
  nextPendingId = 1;
  notifySubscribers();
}
