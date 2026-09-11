// Explicitly reprocess one provider message through the normal allowlisted inbox.
// Run inside the postmaster container; existing completed messages are a no-op.
import { cloud } from "@spectrum-ts/core";
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import { Repository } from "../dist/server/repository.js";
import { TrackingService } from "../dist/server/tracking.js";
import { loadConfig } from "../dist/server/config.js";
import {
  PhotonIntegration,
  normalizeInbound,
  isAllowedInbound,
} from "../dist/server/messaging/photon.js";
import { createInboundHandler } from "../dist/server/messaging/handler.js";
const id = process.argv[2];
if (!id || !/^[\w-]{1,150}$/.test(id))
  throw new Error("Supply a single Photon message ID.");
const config = loadConfig();
const tokens = await cloud.issueImessageTokens(
  process.env.SPECTRUM_PROJECT_ID,
  process.env.SPECTRUM_PROJECT_SECRET,
);
if (tokens.type !== "shared")
  throw new Error("This recovery command requires a shared Photon project.");
const client = createGrpcClient({
  address:
    process.env.SPECTRUM_IMESSAGE_ADDRESS ??
    "imessage.spectrum.photon.codes:443",
  token: tokens.token,
  tls: true,
  timeout: 15000,
});
const repo = new Repository(config.dbPath);
const tracking = new TrackingService(repo, config);
try {
  const message = await client.messages.get(id);
  const inbound = normalizeInbound(message);
  if (!inbound || !isAllowedInbound(inbound, config.imessageRecipient))
    throw new Error("This is not an authorized inbound text message.");
  const integration = new PhotonIntegration(
    {
      projectId: process.env.SPECTRUM_PROJECT_ID,
      projectSecret: process.env.SPECTRUM_PROJECT_SECRET,
      recipient: config.imessageRecipient,
    },
    repo,
    createInboundHandler(
      {
        baseUrl: process.env.OPENCLAW_BASE_URL,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
      },
      tracking,
    ),
  );
  await integration.receiveMessage(message);
  console.log(
    "Message processed through the durable inbox; the running service will deliver its queued reply.",
  );
} finally {
  await tracking.stop();
  repo.close();
  await client.close();
}
