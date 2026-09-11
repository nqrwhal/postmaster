import type { IntegrationHealth } from "../../shared/types.js";
import type {
  InboundMessage,
  MessageTransport,
  MessagingRepository,
} from "./contracts.js";
import { drainOutbox } from "./outbox.js";
import { cloud } from "@spectrum-ts/core";
import {
  createGrpcClient,
  type AdvancedIMessage,
  type MessageEvent,
  type CatchUpEvent,
  type Message,
} from "@photon-ai/advanced-imessage/grpc";

export interface PhotonConfig {
  projectId: string;
  projectSecret: string;
  recipient: string;
  pollMs?: number;
}
export interface InboundHandler {
  (
    message: InboundMessage,
    reply: (text: string) => Promise<void>,
  ): Promise<void>;
}

export function normalizeInbound(message: any): InboundMessage | null {
  // Advanced iMessage represents content as { text?, attachments, ... };
  // it has no `type: "text"` discriminator (the higher-level SDK does).
  if (
    !message?.guid ||
    message.isFromMe ||
    message.isSystemMessage ||
    message.isServiceMessage
  )
    return null;
  const senderId = message.sender?.address;
  if (
    typeof senderId !== "string" ||
    typeof message.content?.text !== "string" ||
    !message.content.text.trim()
  )
    return null;
  if (message.sender.service && message.sender.service !== "iMessage")
    return null;
  return {
    id: String(message.guid),
    senderId,
    body: message.content.text,
    direction: "inbound",
    isGroup:
      message.chatGuids?.some((guid: string) => guid.includes(";+;")) === true,
    platform: "imessage",
    raw: {
      messageId: message.guid,
      senderId,
      chatGuid: message.chatGuids?.[0],
      occurredAt: message.dateCreated?.toISOString?.(),
    },
  };
}
export function isAllowedInbound(
  message: InboundMessage,
  recipient: string,
): boolean {
  return (
    message.senderId === recipient &&
    !message.isGroup &&
    message.platform === "imessage"
  );
}
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PhotonIntegration {
  private clients: AdvancedIMessage[] = [];
  private running = false;
  private cachedTokens?: Awaited<ReturnType<typeof cloud.issueImessageTokens>>;
  private tokenExpiry = 0;
  private tokenRefresh?: Promise<
    Awaited<ReturnType<typeof cloud.issueImessageTokens>>
  >;
  private streamPromises: Promise<void>[] = [];
  private inboundTasks = new Map<string, Promise<void>>();
  private healthState: IntegrationHealth;
  constructor(
    private readonly config: PhotonConfig,
    private readonly repo: MessagingRepository,
    private readonly onInbound: InboundHandler,
  ) {
    const configured = Boolean(
      config.projectId && config.projectSecret && config.recipient,
    );
    this.healthState = {
      configured,
      status: configured ? "connecting" : "disabled",
      message: configured
        ? "Photon is not connected yet"
        : "Photon credentials or recipient are missing",
    };
  }
  health(): IntegrationHealth {
    return this.healthState;
  }

  async start(): Promise<void> {
    if (!this.healthState.configured) return;
    const tokenData = await this.refreshToken();
    const entries =
      tokenData.type === "shared"
        ? [
            {
              address:
                process.env.SPECTRUM_IMESSAGE_ADDRESS ??
                "imessage.spectrum.photon.codes:443",
              token: async () => {
                const renewed = await this.refreshToken();
                return renewed.type === "shared"
                  ? renewed.token
                  : tokenData.token;
              },
            },
          ]
        : Object.entries(tokenData.auth).map(([instanceId, token]) => ({
            address: `${instanceId}.imsg.photon.codes:443`,
            token: async () => {
              const renewed = await this.refreshToken();
              return renewed.type === "dedicated"
                ? (renewed.auth[instanceId] ?? token)
                : token;
            },
          }));
    this.clients = entries.map((entry) =>
      createGrpcClient({
        address: entry.address,
        token: entry.token,
        tls: true,
        autoIdempotency: true,
        retry: true,
        timeout: 15_000,
      }),
    );
    this.running = true;
    this.healthState = {
      configured: true,
      status: "ok",
      message: `Photon connected (${this.clients.length} client${this.clients.length === 1 ? "" : "s"})`,
    };
    this.streamPromises = this.clients.map((client, index) =>
      this.consume(client, `photon.sequence:${entries[index].address}`),
    );
  }
  private async refreshToken() {
    if (this.cachedTokens && Date.now() < this.tokenExpiry)
      return this.cachedTokens;
    if (!this.tokenRefresh)
      this.tokenRefresh = cloud
        .issueImessageTokens(this.config.projectId, this.config.projectSecret)
        .then((data) => {
          this.cachedTokens = data;
          this.tokenExpiry = Date.now() + data.expiresIn * 800;
          return data;
        })
        .finally(() => {
          this.tokenRefresh = undefined;
        });
    return this.tokenRefresh;
  }

  private async consume(
    client: AdvancedIMessage,
    cursorKey: string,
  ): Promise<void> {
    while (this.running) {
      try {
        const storedCursor = this.repo.getMetadata(cursorKey);
        const cursor = Number(storedCursor ?? "0");
        // Establish live delivery first. The pending first read keeps the
        // subscription open while catch-up runs, closing the handoff gap.
        const live = client.messages.subscribeEvents();
        const liveIterator = live[Symbol.asyncIterator]();
        let firstLiveError: unknown;
        const firstLive = liveIterator.next().catch((error: unknown) => {
          firstLiveError = error;
          return { done: true as const, value: undefined };
        });
        try {
          // Always establish a baseline. On first boot, historical messages
          // advance the cursor but do not execute old commands.
          for await (const event of client.events.catchUp(
            cursor || undefined,
          )) {
            if (!this.running) break;
            await this.handleEvent(
              client,
              event,
              cursorKey,
              storedCursor !== null,
            );
            if (event.type === "catchup.complete") break;
          }
          if (firstLiveError) throw firstLiveError;
          this.healthState = {
            configured: true,
            status: "ok",
            message: "Photon connected",
          };
          const first = await firstLive;
          if (firstLiveError) throw firstLiveError;
          if (!first.done)
            await this.handleEvent(client, first.value, cursorKey, true);
          while (this.running) {
            const next = await liveIterator.next();
            if (next.done) break;
            await this.handleEvent(client, next.value, cursorKey, true);
          }
        } finally {
          await live.close();
        }
      } catch (error) {
        if (!this.running) break;
        this.healthState = {
          configured: true,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        await wait(this.config.pollMs ?? 2_000);
      }
    }
  }

  private async handleEvent(
    client: AdvancedIMessage,
    event: CatchUpEvent | MessageEvent,
    cursorKey: string,
    processInbound = true,
  ): Promise<void> {
    if (event.type !== "message.received") {
      if (event.type === "catchup.complete")
        this.persistSequence(cursorKey, event.headSequence);
      else if ("sequence" in event)
        this.persistSequence(cursorKey, event.sequence);
      return;
    }
    if (processInbound) await this.receiveMessage(event.message);
    this.persistSequence(cursorKey, event.sequence);
    void client;
  }

  /** Process live messages and explicit recovery through the same durable inbox. */
  async receiveMessage(message: Message): Promise<void> {
    const inbound = normalizeInbound(message);
    if (!inbound || !isAllowedInbound(inbound, this.config.recipient)) return;
    const existing = this.inboundTasks.get(inbound.id);
    if (existing) return existing;
    const task = (async () => {
      if (this.repo.acceptInbound(inbound.id, inbound.raw ?? {})) {
        let replyIndex = 0;
        await this.onInbound(inbound, async (text) => {
          this.repo.enqueueMessage({
            id: `reply:${inbound.id}:${replyIndex++}`,
            recipient: this.config.recipient,
            body: text.slice(0, 1200),
          });
        });
        this.repo.completeInbound(inbound.id);
      }
    })();
    this.inboundTasks.set(inbound.id, task);
    try {
      await task;
    } finally {
      this.inboundTasks.delete(inbound.id);
    }
  }

  private persistSequence(cursorKey: string, sequence: number): void {
    const stored = this.repo.getMetadata(cursorKey);
    const current = Number(stored ?? "0");
    if (stored === null || sequence > current)
      this.repo.setMetadata(cursorKey, String(sequence));
  }

  async drain(limit = 20): Promise<number> {
    if (!this.clients.length) return 0;
    const transport: MessageTransport = {
      send: async ({ recipient, body, clientMessageId }) => {
        if (recipient !== this.config.recipient)
          throw new Error("Outbound recipient is not allowlisted");
        const sent = await this.clients[0].messages.sendText(
          `any;-;${recipient}`,
          body,
          { clientMessageId },
        );
        return { providerId: sent.guid };
      },
    };
    return drainOutbox(this.repo, transport, limit);
  }
  connectionFailed(): void {
    this.healthState = {
      configured: this.healthState.configured,
      status: "error",
      message: "Photon connection failed; retrying",
    };
  }
  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.clients.map((client) => client.close()));
    await Promise.allSettled(this.streamPromises);
    await Promise.allSettled(this.inboundTasks.values());
  }
}
