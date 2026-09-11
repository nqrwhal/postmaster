import { expect, test } from "@playwright/test";
test("capture README demo screenshots", async ({ page }) => {
  test.skip(
    process.env.UPDATE_SCREENSHOTS !== "1",
    "Run explicitly with UPDATE_SCREENSHOTS=1 to refresh README images.",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Desk lamp/ })).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/dashboard.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Desk lamp/ }).click();
  await expect(
    page.getByRole("heading", { name: "Tracking history" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/package-details.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Edit package", exact: true }).click();
  await expect(page.getByRole("form", { name: "Edit package" })).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/package-editor.png",
    animations: "disabled",
  });
});
