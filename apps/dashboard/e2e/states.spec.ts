import { expect, test } from "@playwright/test"
import { emptyRoom, item, mockWire, room } from "./wire.js"

test("Given an OAuth exchange in flight When the product starts Then the real loading state is announced", async ({
  page,
}) => {
  let releaseExchange = (): void => undefined
  const exchangeGate = new Promise<void>((resolve) => {
    releaseExchange = resolve
  })
  await page.route("**/auth/exchange", async (route) => {
    await exchangeGate
    await route.fulfill({ json: { token: "browser-token", expiresAt: "2099-01-01T00:00:00.000Z" } })
  })
  await page.goto("/#code=loading")
  await expect(page.getByLabel("Loading music room")).toBeVisible()
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/loading.png",
    fullPage: true,
  })
  releaseExchange()
  await expect(page.getByTestId("auth-anonymous")).not.toBeVisible()
})

test("Given an empty room and history When they load Then every empty product state is actionable", async ({
  page,
}) => {
  await mockWire(page, { state: emptyRoom, history: [] })
  await page.goto("/#code=empty")
  await expect(page.getByRole("heading", { name: "Nothing is playing" })).toBeVisible()
  await expect(page.getByText("No requests")).toBeVisible()
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/empty-player-queue.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "History" }).click()
  await expect(page.getByText("No listening history")).toBeVisible()
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/empty-history.png",
    fullPage: true,
  })
})

test("Given search is unavailable When a request is made Then the failure is visible and recoverable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await mockWire(page, { searchError: true })
  await page.goto("/#code=error")
  await page.getByPlaceholder("Track name or link").fill("broken request")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  const alert = page.getByText("Search is temporarily unavailable")
  await expect(alert).toBeVisible()
  const unobscured = await alert.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const footer = document.querySelector(".desktop-player-footer")?.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return footer !== undefined && rect.bottom <= footer.top && element.contains(hit)
  })
  expect(unobscured).toBe(true)
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/request-error.png",
    fullPage: true,
  })
})

for (const width of [375, 768]) {
  test(`Given the queue overlay at ${width}px When pointer controls are targeted Then the sheet wins hit-testing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await mockWire(page)
    await page.goto("/#code=overlay-hit-test")
    const openQueue = page.getByRole("button", {
      name: width === 375 ? "Open queue" : /Queue \(/,
    })
    await openQueue.click()
    const close = page.getByRole("button", { name: "Close queue", exact: true })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("aside") ?? document.body).transform === "none",
    )
    await expect(close).toBeVisible()
    expect(
      await close.evaluate((button) => {
        const rect = button.getBoundingClientRect()
        return button.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        )
      }),
    ).toBe(true)
    await close.click()
    await openQueue.click()
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("aside") ?? document.body).transform === "none",
    )
    const actions = page.locator('summary[aria-label^="Queue actions for"]').first()
    expect(
      await actions.evaluate((summary) => {
        const rect = summary.getBoundingClientRect()
        return summary.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        )
      }),
    ).toBe(true)
    await actions.click()
    await expect(actions.locator("..")).toHaveAttribute("open", "")
  })
}

test("Given the 375 by 666 mobile viewport When playback loads Then transport is above the fold after art and metadata", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 666 })
  await mockWire(page)
  await page.goto("/#code=mobile-order")
  await expect(page.getByTestId("current-track")).toHaveAttribute("data-track-id", "track-current")
  const positions = await page.evaluate(() => {
    const art = document.querySelector(".now .art")?.getBoundingClientRect()
    const meta = document.querySelector(".now .meta")?.getBoundingClientRect()
    const transport = document.querySelector(".now .transport")?.getBoundingClientRect()
    const voice = document.querySelector(".main .voice")?.getBoundingClientRect()
    const queue = document.querySelector(".mobile-queue-preview")?.getBoundingClientRect()
    const firstQueueItem = document
      .querySelector(".mobile-queue-preview li")
      ?.getBoundingClientRect()
    return {
      artTop: art?.top,
      artBottom: art?.bottom,
      metaTop: meta?.top,
      metaBottom: meta?.bottom,
      transportTop: transport?.top,
      transportBottom: transport?.bottom,
      voiceHeight: voice?.height,
      queueTop: queue?.top,
      firstQueueItemBottom: firstQueueItem?.bottom,
    }
  })
  expect(positions.artTop).toBeLessThan(positions.metaTop ?? 0)
  expect(positions.artBottom).toBeLessThanOrEqual(positions.metaTop ?? 0)
  expect(positions.metaBottom).toBeLessThanOrEqual(positions.transportTop ?? 0)
  expect(positions.transportBottom).toBeLessThanOrEqual(666)
  expect(positions.transportBottom).toBeLessThanOrEqual(positions.queueTop ?? 0)
  expect(positions.firstQueueItemBottom).toBeLessThanOrEqual(666 - 72)
  expect(positions.voiceHeight).toBe(0)
})

test("Given neither snapshot transport is available When login completes Then the disconnected state is actionable", async ({
  page,
}) => {
  const cors = {
    "access-control-allow-origin": "http://127.0.0.1:4174",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  }
  await page.route("**/auth/exchange", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    await route.fulfill({
      headers: cors,
      json: { token: "browser-token", expiresAt: "2099-01-01T00:00:00.000Z" },
    })
  })
  await page.route("**/api/state", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    await route.fulfill({
      status: 503,
      headers: cors,
      json: { error: { code: "unavailable", message: "Music server is offline" } },
    })
  })
  await page.route("**/api/voice-channels", async (route) => {
    await route.fulfill({ headers: cors, json: { channels: [] } })
  })
  await page.goto("/#code=offline")
  await expect(page.getByRole("heading", { name: "Room unavailable" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Music server is offline")
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/fully-disconnected.png",
    fullPage: true,
  })
})

test("Given untrusted long metadata When rendered Then it stays data and cannot overflow", async ({
  page,
}) => {
  const title =
    "<script>not markup</script> A title that continues across the entire control room without clipping controls or forcing horizontal scrolling"
  const longRoom = {
    ...room,
    player: {
      ...room.player,
      currentItem: item("long", title, "An Artist With An Equally Long Display Name"),
    },
  }
  await mockWire(page, { state: longRoom })
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto("/#code=long")
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
  expect(await page.locator("body").evaluate((body) => body.scrollWidth)).toBe(375)
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/long-content-mobile.png",
    fullPage: true,
  })
})

test("Given the mobile queue When keyboard reorder is used Then expectedVersion and unique ID are sent", async ({
  page,
}) => {
  let body: unknown = null
  await page.setViewportSize({ width: 375, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockWire(page)
  await page.unroute("**/api/queue/order")
  await page.route("**/api/queue/order", async (route) => {
    body = route.request().postDataJSON()
    await route.fulfill({
      json: {
        ...room,
        version: 8,
        player: {
          ...room.player,
          queue: [room.player.queue[1], room.player.queue[0], ...room.player.queue.slice(2)],
        },
      },
    })
  })
  await page.goto("/#code=mobile-reorder")
  await page.getByRole("button", { name: "Open queue" }).click()
  await expect(page.getByRole("button", { name: "Close queue", exact: true })).toBeFocused()
  const actions = page.locator(
    'summary[aria-label="Queue actions for Still Water Across a Very Long Listening Session Name That Must Never Force Overflow"]',
  )
  await actions.focus()
  await actions.press("Enter")
  await expect(actions.locator("..")).toHaveAttribute("open", "")
  await page.getByRole("button", { name: /Move Still Water.* down/ }).focus()
  await page.keyboard.press("Enter")
  expect(body).toEqual({ id: "queue-1", index: 1, expectedVersion: 7 })
  await expect(page.locator("aside li").first()).toHaveAttribute("data-queue-id", "queue-2")
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/states/mobile-keyboard-reorder.png",
    fullPage: true,
  })
})
