export interface PostmasterApiConfig {
  baseUrl: string;
  internalToken: string;
}

type ApiInput = Record<string, unknown>;

export class PostmasterTools {
  constructor(private readonly config: PostmasterApiConfig) {}

  private async call(
    path: string,
    method: string,
    body?: ApiInput,
  ): Promise<unknown> {
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.config.internalToken}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (!response.ok)
      throw new Error(`Postmaster API returned HTTP ${response.status}`);
    return response.json();
  }

  add(input: ApiInput) {
    return this.call("/api/v1/packages", "POST", { items: [input] });
  }
  async find(input: ApiInput) {
    const data = (await this.call("/api/v1/packages", "GET")) as any;
    const query = String(input.query ?? "").toLowerCase();
    return {
      packages: (data.packages ?? []).filter(
        (p: any) =>
          !query ||
          [
            p.id,
            p.name,
            p.trackingNumber,
            p.carrier,
            p.direction,
            p.status,
          ].some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(query),
          ),
      ),
    };
  }
  detail(input: ApiInput) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "GET",
    );
  }
  rename(input: ApiInput) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      { name: input.name },
    );
  }
  edit(input: ApiInput) {
    const patch: ApiInput = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.direction !== undefined) patch.direction = input.direction;
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      patch,
    );
  }
  archive(input: ApiInput) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      { archived: true },
    );
  }
  refresh(input: ApiInput) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}/refresh`,
      "POST",
    );
  }
  notificationPreferences(input: ApiInput) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      { notificationMode: input.mode },
    );
  }
}

export const OPENCLAW_TOOL_NAMES = [
  "postmaster_add",
  "postmaster_edit",
  "postmaster_find",
  "postmaster_detail",
  "postmaster_rename",
  "postmaster_archive",
  "postmaster_refresh",
  "postmaster_notification_preferences",
] as const;
