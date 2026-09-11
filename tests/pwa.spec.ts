import { expect, test } from "@playwright/test";
test.use({ serviceWorkers: "allow" });

test("PWA caches its shell, excludes private data, and opens offline", async ({
  page,
  context,
  browserName,
  request,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: /Desk lamp/ })).toBeVisible();
  await page.evaluate(async () => {
    await fetch("/api/v1/health");
    await fetch("/assets/missing.js");
  });
  const paths = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        result.push(new URL(request.url).pathname);
    return result;
  });
  expect(paths).toContain("/");
  expect(paths.some((path) => path.startsWith("/api/"))).toBe(false);
  expect(paths).not.toContain("/assets/missing.js");
  if (browserName === "webkit") await request.post("/test/network-offline");
  else await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Postmaster", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await page
      .getByRole("button", { name: "Add package", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Add package", exact: true }),
    ).toBeDisabled();
  } finally {
    if (browserName === "webkit") await request.post("/test/network-online");
    else await context.setOffline(false);
  }
});
