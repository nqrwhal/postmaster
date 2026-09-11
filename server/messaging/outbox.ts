import type { OutboxMessage } from "../../shared/types.js";
import type { MessageTransport, MessagingRepository } from "./contracts.js";

const retryDelay = (attempts: number) =>
  Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));

export async function drainOutbox(
  repo: MessagingRepository,
  transport: MessageTransport,
  limit = 20,
): Promise<number> {
  const messages = repo.claimDueMessages(limit);
  for (const message of messages) {
    try {
      const result = await transport.send({
        recipient: message.recipient,
        body: message.body,
        clientMessageId: `postmaster:${message.id}`,
      });
      repo.markMessageSent(message.id, result.providerId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (message.attempts >= 8) repo.failMessage(message.id, detail);
      else
        repo.retryMessage(
          message.id,
          detail,
          new Date(Date.now() + retryDelay(message.attempts)).toISOString(),
        );
    }
  }
  return messages.length;
}
