import type { LineInputValue } from "../AgentShared";

let queuedSteers: LineInputValue[] = [];
let subscribers: Array<(values: LineInputValue[]) => void> = [];

function snapshot(): LineInputValue[] {
  return queuedSteers.map((value) => ({
    text: value.text,
    attachments: value.attachments ? [...value.attachments] : undefined,
    ...(value.skills?.length ? { skills: [...value.skills] } : {}),
  }));
}

function notifySubscribers(): void {
  const values = snapshot();
  for (const subscriber of subscribers) {
    subscriber(values);
  }
}

export function enqueueSteer(value: LineInputValue): void {
  const text = value.text.trim();
  if (!text && (!value.attachments || value.attachments.length === 0)) {
    return;
  }
  queuedSteers.push({
    text,
    attachments: value.attachments,
    ...(value.skills?.length ? { skills: value.skills } : {}),
  });
  notifySubscribers();
}

export function drainSteers(): LineInputValue[] {
  const values = queuedSteers;
  queuedSteers = [];
  notifySubscribers();
  return values;
}

export function clearSteers(): void {
  queuedSteers = [];
  notifySubscribers();
}

export function getQueuedSteers(): LineInputValue[] {
  return snapshot();
}

export function subscribeSteers(subscriber: (values: LineInputValue[]) => void): () => void {
  subscribers.push(subscriber);
  subscriber(snapshot());
  return () => {
    subscribers = subscribers.filter((entry) => entry !== subscriber);
  };
}
