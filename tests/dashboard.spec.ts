import { expect, test } from "@playwright/test";
import bwipjs from "bwip-js";

const trackingNumber = "1Z999AA10123456789";
const label = async () =>
  bwipjs.toBuffer({
    bcid: "code128",
    text: trackingNumber,
    scale: 3,
    height: 24,
    padding: 20,
    backgroundcolor: "FFFFFF",
  });

test("direction filtering, creating outbound, editing and persistence", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Desk lamp/ })).toBeVisible();
  await page.getByRole("tab", { name: "Outbound", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Camera return/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Desk lamp/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Add package", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Outbound" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await dialog
    .getByLabel("Tracking number", { exact: true })
    .fill("1Z999AA10123456780");
  await dialog.getByLabel(/Name/).fill("Browser test shipment");
  await dialog
    .getByRole("button", { name: "Add package", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: /Browser test shipment/ }).click();
  await dialog
    .getByRole("button", { name: "Edit package", exact: true })
    .click();
  await dialog.getByRole("tab", { name: "Inbound" }).click();
  await expect(dialog.getByRole("tab", { name: "Inbound" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("form", { name: "Edit package" })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: "Inbound", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Browser test shipment/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Browser test shipment/ }),
  ).toBeVisible();
});

test("photo barcode decodes locally and requires explicit add confirmation", async ({
  page,
}) => {
  let registrations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/packages"))
      registrations++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "label.png",
    mimeType: "image/png",
    buffer: await label(),
  });
  await expect(page.getByLabel("Tracking number", { exact: true })).toHaveValue(
    trackingNumber,
  );
  await expect(
    page.getByText("Barcode captured. Check the number before adding."),
  ).toBeVisible();
  expect(registrations).toBe(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(registrations).toBe(0);
});

test("denied camera offers photo and manual fallback", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Blocked", "NotAllowedError");
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Camera access was blocked",
  );
  await page.getByRole("button", { name: "Enter manually" }).click();
  await expect(
    page.getByLabel("Tracking number", { exact: true }),
  ).toBeVisible();
});

test("closing scanner stops active camera tracks", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      canvas.getContext("2d")!.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(5);
      (window as any).__cameraTrack = stream.getVideoTracks()[0];
      return stream;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restart camera", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__cameraTrack.readyState))
    .toBe("ended");
});

test("camera acquired after scanner closes is immediately stopped", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        (window as any).__allowCamera = () => {
          const canvas = document.createElement("canvas");
          const stream = canvas.captureStream(5);
          (window as any).__cameraTrack = stream.getVideoTracks()[0];
          resolve(stream);
        };
      });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Starting camera…" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.evaluate(() => (window as any).__allowCamera());
  await expect
    .poll(() => page.evaluate(() => (window as any).__cameraTrack.readyState))
    .toBe("ended");
});

for (const colorScheme of ["light", "dark"] as const)
  test(`mobile layout ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Desk lamp/ })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: `/tmp/postmaster-mobile-${colorScheme}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Add package", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({
      path: `/tmp/postmaster-add-${colorScheme}.png`,
      fullPage: true,
    });
  });

test("desktop monochrome layout", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Desk lamp/ })).toBeVisible();
  await page.screenshot({
    path: "/tmp/postmaster-desktop.png",
    fullPage: true,
  });
});

test("camera decodes a shipping barcode and releases the stream", async ({
  page,
}) => {
  const imageData = `data:image/png;base64,${(await label()).toString("base64")}`;
  await page.addInitScript((imageData) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const image = new Image();
      image.src = imageData;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      const stream = canvas.captureStream(5);
      (window as any).__cameraTrack = stream.getVideoTracks()[0];
      return stream;
    };
  }, imageData);
  await page.goto("/");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByLabel("Tracking number", { exact: true })).toHaveValue(
    trackingNumber,
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__cameraTrack.readyState))
    .toBe("ended");
});

for (const rotated of [false, true]) {
  test(`camera reads a dense USPS routing label${rotated ? " rotated" : ""}`, async ({
    page,
  }) => {
    const usps = "9300111043900020273157";
    const png = await bwipjs.toBuffer({
      bcid: "code128",
      text: "42094107" + usps,
      scale: 2,
      height: 15,
      padding: 20,
      backgroundcolor: "FFFFFF",
      rotate: rotated ? "R" : "N",
    });
    await page.addInitScript(
      ({ imageData }) => {
        navigator.mediaDevices.getUserMedia = async () => {
          const image = new Image();
          image.src = imageData;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const stream = canvas.captureStream(30);
          (window as any).__cameraTrack = stream.getVideoTracks()[0];
          // First decode misses, as happens while a real camera focuses.
          setTimeout(() => ctx.drawImage(image, 0, 0), 150);
          return stream;
        };
      },
      { imageData: `data:image/png;base64,${png.toString("base64")}` },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      page.getByLabel("Tracking number", { exact: true }),
    ).toHaveValue(usps);
    await expect
      .poll(() => page.evaluate(() => (window as any).__cameraTrack.readyState))
      .toBe("ended");
  });
}

test("package detail offers a direct carrier link and new carrier choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /Desk lamp/ }).click();
  const dialog = page.getByRole("dialog");
  const link = dialog.getByRole("link", {
    name: /1Z999AA10123456784 — track on UPS/,
  });
  await expect(link).toContainText("↗");
  await expect(
    dialog.getByRole("button", { name: "Track on UPS" }),
  ).toHaveCount(0);
  await expect(link).toHaveAttribute(
    "href",
    "https://www.ups.com/track?tracknum=1Z999AA10123456784",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: "/tmp/postmaster-carrier-link-mobile.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Add package", exact: true }).click();
  for (const carrier of ["ontrac", "dhl", "other"]) {
    await page.getByLabel("Carrier", { exact: true }).selectOption(carrier);
    await expect(page.getByLabel("Carrier", { exact: true })).toHaveValue(
      carrier,
    );
  }
});

test("detail glyphs expose delayed tooltips and support rename, refresh, archive", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/v1/packages", {
    data: {
      items: [
        { trackingNumber: "1Z999AA10123456770", name: "Glyph test parcel" },
      ],
    },
  });
  const id = (await created.json()).results[0].package.id;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.getByRole("button", { name: /Glyph test parcel/ }).click();
  const dialog = page.getByRole("dialog");
  const edit = dialog.getByRole("button", {
    name: "Edit package",
    exact: true,
  });
  await edit.hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("tooltip")).toContainText(
    "direction, and notifications",
  );
  await page.screenshot({
    path: "/tmp/postmaster-detail-glyph-tooltip.png",
    fullPage: true,
  });
  await edit.click();
  await dialog
    .getByLabel("Package name", { exact: true })
    .fill("Renamed glyph parcel");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Renamed glyph parcel", exact: true }),
  ).toBeVisible();
  const refreshResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/packages/${id}/refresh`) &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Refresh tracking", exact: true })
    .click();
  expect((await refreshResponse).status()).toBe(200);
  await expect(dialog.locator(".form-error")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Refresh tracking", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Archive package", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await (await request.get(`/api/v1/packages/${id}`)).json()).package
      .archived,
  ).toBe(true);
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: /Renamed glyph parcel/ }).click();
  await dialog
    .getByRole("button", { name: "Unarchive package", exact: true })
    .click();
  expect(
    (await (await request.get(`/api/v1/packages/${id}`)).json()).package
      .archived,
  ).toBe(false);
});

test("detail glyph header fits long names on touch screens", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: /Desk lamp/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Edit package", exact: true })
    .click();
  await dialog
    .getByLabel("Package name", { exact: true })
    .fill("Studio accessories and replacement charging cables");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: /Studio accessories/ }),
  ).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await expect(
    dialog.getByRole("button", { name: "Archive package", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: "/tmp/postmaster-detail-glyph-mobile.png",
    fullPage: true,
  });
  await request.patch("/api/v1/packages/sample-inbound", {
    data: { name: "Desk lamp" },
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`custom notification menu and black tooltips in ${colorScheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: /Running shoes/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Edit package", exact: true })
      .click();
    const trigger = dialog.getByRole("button", {
      name: "Notifications",
      exact: true,
    });
    await trigger.click();
    await expect(
      page.getByRole("menuitemradio", { name: "Milestones", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({
      path: `/tmp/postmaster-notification-menu-${colorScheme}.png`,
      animations: "disabled",
      fullPage: true,
    });
    await page
      .getByRole("menuitemradio", { name: "Muted", exact: true })
      .click();
    await expect(trigger).toHaveText("Muted");
    await expect(trigger).toBeEnabled();
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveText("Milestones");
    await expect(trigger).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Edit package", exact: true })
      .hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    const tooltip = page.locator(".action-tooltip");
    await expect(tooltip).toHaveCSS("background-color", "rgb(17, 17, 17)");
    await expect(tooltip).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.screenshot({
      path: `/tmp/postmaster-black-tooltip-${colorScheme}.png`,
      fullPage: true,
    });
  });
}

test("package editor saves all settings together and cancel discards drafts", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/v1/packages", {
    data: {
      items: [
        { trackingNumber: "1Z999AA10123456771", name: "Settings parcel" },
      ],
    },
  });
  const id = (await response.json()).results[0].package.id;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /Settings parcel/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Notifications", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("tab", { name: "Inbound", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Edit package", exact: true })
    .click();
  const form = dialog.getByRole("form", { name: "Edit package" });
  await form.getByLabel("Package name", { exact: true }).fill("Saved settings");
  await form.getByRole("tab", { name: "Outbound", exact: true }).click();
  await form
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "Muted", exact: true }).click();
  const before = (await (await request.get(`/api/v1/packages/${id}`)).json())
    .package;
  expect([before.name, before.direction, before.notificationMode]).toEqual([
    "Settings parcel",
    "inbound",
    "milestones",
  ]);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: "/tmp/postmaster-package-editor.png",
    fullPage: true,
  });
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = (await (await request.get(`/api/v1/packages/${id}`)).json())
    .package;
  expect([saved.name, saved.direction, saved.notificationMode]).toEqual([
    "Saved settings",
    "outbound",
    "muted",
  ]);
  await dialog
    .getByRole("button", { name: "Edit package", exact: true })
    .click();
  await form.getByLabel("Package name", { exact: true }).fill("Discard this");
  await form.getByRole("tab", { name: "Inbound", exact: true }).click();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Edit package", exact: true })
    .click();
  await expect(form.getByLabel("Package name", { exact: true })).toHaveValue(
    "Saved settings",
  );
  await expect(
    form.getByRole("tab", { name: "Outbound", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    form.getByRole("button", { name: "Notifications", exact: true }),
  ).toHaveText("Muted");
});

for (const width of [390, 1280]) {
  test(`package editor overlays tracking without moving it at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: /Desk lamp/ }).click();
    const detail = page.locator(".detail-dialog");
    const timeline = detail.locator(".timeline");
    const before = await timeline.boundingBox();
    const edit = detail.getByRole("button", {
      name: "Edit package",
      exact: true,
    });
    await edit.click();
    const editor = page.getByRole("dialog", {
      name: "Edit package",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(await timeline.boundingBox()).toEqual(before);
    await expect(
      editor.getByLabel("Package name", { exact: true }),
    ).toBeFocused();
    expect(
      await editor.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await editor
      .getByLabel("Package name", { exact: true })
      .fill("Unsaved name");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(detail).toBeVisible();
    expect(await timeline.boundingBox()).toEqual(before);
    await edit.click();
    await expect(
      editor.getByLabel("Package name", { exact: true }),
    ).toHaveValue("Desk lamp");
    await page.route("**/api/v1/packages/sample-inbound", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Could not save changes" }),
        });
      } else await route.continue();
    });
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "Could not save changes",
    );
    await expect(editor).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(editor).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(edit).toBeFocused();
  });
}

for (const [timezoneId, expected] of [
  ["America/Los_Angeles", "Sep 8, 2:00 PM PDT"],
  ["America/New_York", "Sep 8, 5:00 PM EDT"],
]) {
  test(`tracking timestamps follow device timezone ${timezoneId}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ timezoneId, locale: "en-US" });
    try {
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:8877/");
      await page.getByRole("button", { name: /Desk lamp/ }).click();
      await expect(page.locator(".timeline time")).toHaveText(
        new RegExp(`^${expected.replace(", ", "(?:, | at )")}$`),
      );
      await expect(
        page.getByRole("dialog").getByText(/^Checked /),
      ).toContainText(
        timezoneId === "America/Los_Angeles" ? /P[DS]T/ : /E[DS]T/,
      );
    } finally {
      await context.close();
    }
  });
}

for (const timezoneId of [
  "America/Los_Angeles",
  "America/New_York",
  "Asia/Tokyo",
]) {
  test(`estimated delivery keeps the carrier date in ${timezoneId}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ timezoneId, locale: "en-US" });
    try {
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:8877/");
      const row = page.getByRole("button", { name: /Desk lamp/ });
      await expect(row).toContainText("Expected Sep 11");
      await row.click();
      await expect(
        page.getByRole("dialog").locator(".detail-summary"),
      ).toContainText("Expected Sep 11");
    } finally {
      await context.close();
    }
  });
}
