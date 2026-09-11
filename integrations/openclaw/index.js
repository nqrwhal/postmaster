export class PostmasterTools {
  constructor(config) {
    this.config = config;
  }
  async call(path, method, body) {
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
  add(input) {
    return this.call("/api/v1/packages", "POST", { items: [input] });
  }
  async find(input) {
    const data = await this.call("/api/v1/packages", "GET");
    const query = String(input.query ?? "").toLowerCase();
    return {
      packages: (data.packages ?? []).filter(
        (p) =>
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
  detail(input) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "GET",
    );
  }
  rename(input) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      { name: input.name },
    );
  }
  edit(input) {
    const patch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.direction !== undefined) patch.direction = input.direction;
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      patch,
    );
  }
  archive(input) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      { archived: true },
    );
  }
  refresh(input) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}/refresh`,
      "POST",
    );
  }
  notificationPreferences(input) {
    return this.call(
      `/api/v1/packages/${encodeURIComponent(String(input.id))}`,
      "PATCH",
      { notificationMode: input.mode },
    );
  }
}
