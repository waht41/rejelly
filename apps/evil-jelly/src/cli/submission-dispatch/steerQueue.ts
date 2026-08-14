import {
  copyPromptInput,
  isPromptInputSemanticallyEmpty,
  type PromptInput,
} from "../../shared/model/prompt/promptInput";

let queuedSteers: PromptInput[] = [];
let subscribers: Array<(values: PromptInput[]) => void> = [];

function snapshot(): PromptInput[] {
  return queuedSteers.map(copyPromptInput);
}

function notifySubscribers(): void {
  const values = snapshot();
  for (const subscriber of subscribers) {
    subscriber(values);
  }
}

export function enqueueSteer(value: PromptInput): void {
  if (isPromptInputSemanticallyEmpty(value)) return;
  queuedSteers.push(copyPromptInput(value));
  notifySubscribers();
}

export function drainSteers(): PromptInput[] {
  const values = queuedSteers;
  queuedSteers = [];
  notifySubscribers();
  return values;
}

export function clearSteers(): void {
  queuedSteers = [];
  notifySubscribers();
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
