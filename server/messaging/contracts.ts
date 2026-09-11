import type { OutboxMessage } from "../../shared/types.js";

export interface MessagingRepository {
  enqueueMessage(input: {
    id?: string;
    recipient: string;
    body: string;
  }): OutboxMessage;
  claimDueMessages(limit: number): OutboxMessage[];
  markMessageSent(id: string, providerId: string): void;
  retryMessage(id: string, error: string, retryAt: string): void;
  failMessage(id: string, error: string): void;
  acceptInbound(id: string, payload: Record<string, unknown>): boolean;
  completeInbound(id: string): void;
  getMetadata(key: string): string | null;
  setMetadata(key: string, value: string): void;
}

export interface MessageTransport {
  send(input: {
    recipient: string;
    body: string;
    clientMessageId: string;
  }): Promise<{ providerId: string }>;
  close?(): Promise<void>;
}

export interface InboundMessage {
  id: string;
  senderId: string;
  body: string;
  direction?: "inbound" | "outbound";
  isGroup?: boolean;
  platform?: string;
  raw?: Record<string, unknown>;
}
