const CACHE_PREFIX = "postmaster-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

const isSameOrigin = (url) => url.origin === self.location.origin;
const isApiOrAuth = (url) =>
  url.pathname === "/api" ||
  url.pathname.startsWith("/api/") ||
  url.pathname === "/auth" ||
  url.pathname.startsWith("/auth/");
const isHtml = (response) =>
  response.headers.get("content-type")?.toLowerCase().includes("text/html") ===
  true;
const assetKind = (pathname) => {
  if (pathname.startsWith("/assets/")) {
    if (/\.(?:js|mjs)$/i.test(pathname)) return "script";
    if (/\.css$/i.test(pathname)) return "style";
    if (/\.(?:woff2?|ttf|otf|eot)$/i.test(pathname)) return "font";
    if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i.test(pathname))
      return "image";
    return null;
  }
  if (pathname === "/manifest.webmanifest") return "manifest";
  if (
    /^\/(?:icon\.svg|icon-192\.png|icon-512\.png|apple-touch-icon\.png)$/.test(
      pathname,
    )
  )
    return "image";
  return null;
};
const isValidAssetResponse = (response, kind) => {
  if (!response?.ok || response.type !== "basic" || response.redirected)
    return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("text/html")) return false;
  if (kind === "script") return /javascript|ecmascript/.test(contentType);
  if (kind === "style") return contentType.includes("text/css");
  if (kind === "font")
    return contentType.startsWith("font/") || contentType.includes("woff");
  if (kind === "image") return contentType.startsWith("image/");
  if (kind === "manifest")
    return contentType.includes("manifest") || contentType.includes("json");
  return false;
};
const cacheAssetResponse = async (request, response) => {
  if (!isValidAssetResponse(response, assetKind(new URL(request.url).pathname)))
    return response;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
};
const precacheAsset = async (cache, path) => {
  const request = new Request(path, { cache: "no-store" });
  const response = await fetch(request);
  if (
    isValidAssetResponse(
      response,
      assetKind(new URL(path, self.location.origin).pathname),
    )
  ) {
    await cache.put(request, response.clone());
  } else {
    throw new Error("Invalid app asset");
  }
};
const referencedAssets = (html) =>
  [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith("/assets/") && assetKind(path));

const cacheShell = async (response) => {
  if (
    !response.ok ||
    response.type !== "basic" ||
    response.redirected ||
    !isHtml(response)
  )
    return;
  const html = await response.clone().text();
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    referencedAssets(html).map((path) => precacheAsset(cache, path)),
  );
  await cache.put("/", response.clone());
  await Promise.allSettled(
    SHELL_URLS.map((path) => precacheAsset(cache, path)),
  );
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch(new Request("/", { cache: "no-store" }))
      .then(async (response) => {
        if (
          !response.ok ||
          response.type !== "basic" ||
          response.redirected ||
          !isHtml(response)
        ) {
          throw new Error("App shell unavailable");
        }
        await cacheShell(response);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isSameOrigin(url) || isApiOrAuth(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only the canonical app entry may update the offline shell.
          if (
            url.pathname === "/" &&
            !response.redirected &&
            isHtml(response)
          ) {
            event.waitUntil(cacheShell(response.clone()).catch(() => {}));
          }
          return response;
        })
        .catch(async () => (await caches.match("/")) || Response.error()),
    );
    return;
  }

  if (!assetKind(url.pathname)) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) =>
        cacheAssetResponse(request, response),
      );
    }),
  );
});
