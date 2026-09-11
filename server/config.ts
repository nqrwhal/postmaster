export interface Config {
  dbPath: string;
  port: number;
  host: string;
  easypostApiKey: string;
  publicUrl: string;
  ownerLogin: string;
  internalToken: string;
  imessageRecipient: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dbPath: env.POSTMASTER_DB_PATH ?? "data/postmaster.db",
    port: Number(env.PORT ?? 8765),
    host: env.HOST ?? "127.0.0.1",
    easypostApiKey: env.EASYPOST_API_KEY ?? "",
    publicUrl: env.PUBLIC_URL ?? "",
    ownerLogin: env.OWNER_LOGIN ?? "",
    internalToken: env.INTERNAL_TOKEN ?? "",
    imessageRecipient: env.IMESSAGE_RECIPIENT ?? "",
  };
}
