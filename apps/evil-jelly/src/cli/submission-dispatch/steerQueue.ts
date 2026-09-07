import { releasePromptResources } from "../../shared/host/promptResourceLifecycle";
import {
  copyPromptInput,
  isPromptInputSemanticallyEmpty,
  type PromptInput,
} from "../../shared/model/prompt/promptInput";
import { addPendingSteer, removePendingSubmission } from "./pendingSubmissions";

interface QueuedSteer {
  readonly input: PromptInput;
  readonly pendingId: string;
}

let queuedSteers: QueuedSteer[] = [];
let subscribers: Array<(values: PromptInput[]) => void> = [];

function snapshot(): PromptInput[] {
  return queuedSteers.map((entry) => copyPromptInput(entry.input));
}

function notifySubscribers(): void {
  const values = snapshot();
  for (const subscriber of subscribers) {
    subscriber(values);
  }
}

export function enqueueSteer(value: PromptInput): void {
  if (isPromptInputSemanticallyEmpty(value)) return;
  const input = copyPromptInput(value);
  queuedSteers.push({ input, pendingId: addPendingSteer(input) });
  notifySubscribers();
}

export function drainSteers(): PromptInput[] {
  const entries = queuedSteers;
  queuedSteers = [];
  for (const entry of entries) removePendingSubmission(entry.pendingId);
  notifySubscribers();
  return entries.map((entry) => entry.input);
}

export function clearSteers(): void {
  const discarded = queuedSteers;
  queuedSteers = [];
  for (const entry of discarded) removePendingSubmission(entry.pendingId);
  notifySubscribers();
  void Promise.all(discarded.map((entry) => releasePromptResources(entry.input))).catch(
    () => undefined,
  );
}

export function getQueuedSteers(): PromptInput[] {
  return snapshot();
}

export function subscribeSteers(subscriber: (values: PromptInput[]) => void): () => void {
  subscribers.push(subscriber);
  subscriber(snapshot());
  return () => {
    subscribers = subscribers.filter((entry) => entry !== subscriber);
  };
}
