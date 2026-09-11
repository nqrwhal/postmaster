/** Register the app shell service worker when the browser supports installable PWAs. */
export function registerPwa(): void {
  if (import.meta.env.DEV) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker
        .register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        })
        .then((registration) => {
          // Check for a newer shell whenever the app becomes visible again.
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible")
              void registration.update().catch(() => undefined);
          });
        })
        .catch(() => {
          // PWA support is optional; the app remains fully usable without it.
        });
    },
    { once: true },
  );
}
