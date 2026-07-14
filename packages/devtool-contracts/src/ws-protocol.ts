export type WsSubscriptionTopic = "overview";
export type WsConnectionMode = "trace" | "overview";

export interface OverviewUpdate {
  traceId: string;
  timestamp: number;
  hasEnded: boolean;
  hasError: boolean;
  newSpanCount: number;
}

export interface WsSubscribeMessage {
  type: "subscribe";
  traceId?: string;
  topic?: WsSubscriptionTopic;
}

export interface WsUnsubscribeMessage {
  type: "unsubscribe";
  traceId?: string;
  topic?: WsSubscriptionTopic;
}

export interface WsPingMessage {
  type: "ping";
}

export interface WsPongMessage {
  type: "pong";
}

export interface WsConnectedMessage {
  type: "connected";
  traceId?: string | null;
  mode?: WsConnectionMode;
}

export interface WsEventsMessage<TEvent = unknown> {
  type: "events";
  events: TEvent[];
}

export interface WsOverviewUpdateMessage {
  type: "overview_update";
  data: OverviewUpdate;
}

export type WsClientMessage = WsSubscribeMessage | WsUnsubscribeMessage | WsPingMessage;

export type WsServerMessage<TEvent = unknown> =
  | WsConnectedMessage
  | WsEventsMessage<TEvent>
  | WsOverviewUpdateMessage
  | WsPongMessage;

export type WsProtocolMessage<TEvent = unknown> = WsClientMessage | WsServerMessage<TEvent>;
