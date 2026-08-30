import { expect, test } from "@playwright/test"
import { emptyRoom, mockWire, room, track } from "./wire.js"

test("Given the signed-out page When Discord sign-in is clicked Then GET OAuth navigation uses the approved route", async ({
  page,
}) => {
  let method = ""
  await page.route("**/auth/discord", async (route) => {
    method = route.request().method()
    await route.fulfill({ contentType: "text/html", body: "<title>Discord authorization</title>" })
  })
  await page.goto("/")
  await page.getByRole("link", { name: "Sign in with Discord" }).click()
  await expect(page).toHaveURL("http://127.0.0.1:3000/auth/discord")
  expect(method).toBe("GET")
})

test("Given disconnected desktop voice When no channel is selected Then the channel picker remains usable", async ({
  page,
}) => {
  // Given: an authenticated desktop listener who has not joined voice.
  await mockWire(page, { state: emptyRoom })
  await page.goto("/#code=one-time")

  // When: the voice controls render without a selected channel.
  const channelPicker = page.getByRole("combobox", { name: "Voice channel" }).first()
  const channelPickerField = channelPicker.locator("xpath=..")

  // Then: the picker is visible and choosing a channel enables Join voice.
  await expect(channelPicker).toBeVisible()
  const pickerBox = await channelPickerField.boundingBox()
  expect(pickerBox?.width).toBeGreaterThanOrEqual(160)
  await expect(page.getByRole("button", { name: "Join voice" }).first()).toBeDisabled()
  await channelPicker.selectOption("voice-1")
  await expect(page.getByRole("button", { name: "Join voice" }).first()).toBeEnabled()
  const selectedPickerBox = await channelPickerField.boundingBox()
  expect(selectedPickerBox?.y).toBeGreaterThanOrEqual(0)
})

test("Given a desktop queue When an item is pointer-dragged Then its unique ID is reordered optimistically", async ({
  page,
}) => {
  let requestBody: unknown = null
  await mockWire(page)
  await page.unroute("**/api/queue/order")
  await page.route("**/api/queue/order", async (route) => {
    requestBody = route.request().postDataJSON()
    await route.fulfill({
      json: {
        ...room,
        version: 8,
        player: {
          ...room.player,
          queue: [
            room.player.queue[1],
            room.player.queue[2],
            room.player.queue[0],
            ...room.player.queue.slice(3),
          ],
        },
      },
    })
  })
  await page.goto("/#code=one-time")
  const source = page.locator('[data-queue-id="queue-1"]')
  const target = page.locator('[data-queue-id="queue-3"]')
  await source.dragTo(target)
  await expect(page.locator("aside li").nth(2)).toHaveAttribute("data-queue-id", "queue-1")
  expect(requestBody).toEqual({ id: "queue-1", index: 2, expectedVersion: 7 })
})

test("Given a stale pointer reorder When the server conflicts Then the queue rolls back and fully resyncs", async ({
  page,
}) => {
  let releaseConflict = (): void => undefined
  const conflictGate = new Promise<void>((resolve) => {
    releaseConflict = resolve
  })
  await mockWire(page)
  await page.unroute("**/api/queue/order")
  await page.route("**/api/queue/order", async (route) => {
    await conflictGate
    await route.fulfill({
      status: 409,
      json: { error: { code: "stale_version", message: "Player state changed" } },
    })
  })
  await page.goto("/#code=pointer-conflict")
  await page.locator('[data-queue-id="queue-1"]').dragTo(page.locator('[data-queue-id="queue-3"]'))
  await expect(page.locator("aside li").nth(2)).toHaveAttribute("data-queue-id", "queue-1")
  releaseConflict()
  await expect(page.locator("aside li").first()).toHaveAttribute("data-queue-id", "queue-1")
  await expect(page.getByTestId("queue-error")).toContainText("latest order")
})

for (const width of [375, 768, 1280]) {
  test(`Given the primitive gate at ${width}px When it renders Then documented controls remain reachable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/showcase/")
    await expect(page.getByRole("heading", { name: "Primitive showcase" })).toBeVisible()
    await page.screenshot({
      path: `../../.omo/evidence/dashboard/showcase/${width}.png`,
      fullPage: true,
    })
    expect(await page.locator("body").evaluate((body) => body.scrollWidth)).toBe(width)
  })
}

for (const width of [375, 768, 1280]) {
  test(`Given the design-system static route at ${width}px When it opens Then the full gallery renders without load errors`, async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.setViewportSize({ width, height: 900 })

    await page.goto(`${process.env.BASE_PATH ?? ""}/design-system/`)

    await expect(page).toHaveURL(/\/design-system\/$/)
    await expect(page.locator(".boot")).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Primitive showcase" })).toBeVisible()
    await expect(page.locator("[data-matrix-cell]")).toHaveCount(72)
    await page.waitForFunction(() => {
      const artwork = document.querySelector<HTMLImageElement>("[data-primitive='now-playing'] img")
      return artwork?.complete === true && artwork.naturalWidth > 0
    })
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
    await page.screenshot({
      path: `../../.omo/evidence/design-system-route-fix/screens/design-system-${width}.png`,
      fullPage: true,
    })
  })
}

test("Given mobile preferences When queue and zoom states are exercised Then controls remain reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockWire(page)
  await page.goto("/#code=one-time")
  await page.getByRole("button", { name: "Open queue" }).click()
  await expect(page.locator("aside")).toHaveClass(/open/)
  await expect(page.getByRole("button", { name: "Close queue", exact: true })).toBeFocused()
  await page.screenshot({ path: "../../.omo/evidence/dashboard/mobile-queue.png", fullPage: true })
  await page.keyboard.press("Escape")
  await expect(page.locator("aside")).not.toHaveClass(/open/)
  await expect(page.getByRole("button", { name: "Open queue" })).toBeFocused()
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY")
  await page.setViewportSize({ width: 640, height: 450 })
  await page.screenshot({ path: "../../.omo/evidence/dashboard/zoom-200.png", fullPage: true })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})

for (const width of [375, 768]) {
  test(`Given a ${width}px keyboard listener When the queue opens Then its motion and focused close control are visible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await mockWire(page)
    await page.goto("/#code=keyboard-queue")

    const openQueue = page.getByRole("button", {
      name: width < 768 ? "Open queue" : /Queue \(/,
    })
    const closeQueue = page.getByRole("button", { name: "Close queue", exact: true })
    const queueOverlay = page.locator("aside")

    await page.waitForFunction(() => {
      const artwork = document.querySelector<HTMLImageElement>(".now img")
      return artwork?.complete === true && artwork.naturalWidth > 0
    })
    await page.screenshot({
      path: `../../.omo/evidence/final-visual-fix/screens/queue-motion-${width}-rest.png`,
      fullPage: true,
    })

    // Given: the mobile/tablet queue trigger is reached in the native tab sequence.
    let triggerFocused = false
    for (let tabPress = 0; tabPress < 32; tabPress += 1) {
      await page.keyboard.press("Tab")
      triggerFocused = await openQueue.evaluate((button) => document.activeElement === button)
      if (triggerFocused) break
    }
    expect(triggerFocused).toBe(true)

    // When: Enter activates the real queue trigger.
    await page.keyboard.press("Enter")

    // Then: the sheet/drawer is travelling and the keyboard focus ring is rendered on Close queue.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    expect(
      await queueOverlay.evaluate((aside) => {
        const transform = getComputedStyle(aside).transform
        return transform !== "none" && transform !== "matrix(1, 0, 0, 1, 0, 0)"
      }),
    ).toBe(true)
    await page.screenshot({
      path: `../../.omo/evidence/final-visual-fix/screens/queue-motion-${width}-mid-open.png`,
      fullPage: true,
    })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("aside") ?? document.body).transform === "none",
    )
    await expect(closeQueue).toBeFocused()
    await expect(closeQueue).toHaveCSS("outline-width", "2px")
    await page.screenshot({
      path: `../../.omo/evidence/final-visual-fix/screens/queue-motion-${width}-open-settled-focus.png`,
      fullPage: true,
    })
    await page.keyboard.press("Escape")
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    expect(
      await queueOverlay.evaluate((aside) => {
        const transform = getComputedStyle(aside).transform
        return transform !== "none" && transform !== "matrix(1, 0, 0, 1, 0, 0)"
      }),
    ).toBe(true)
    await page.screenshot({
      path: `../../.omo/evidence/final-visual-fix/screens/queue-motion-${width}-mid-close.png`,
      fullPage: true,
    })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("aside") ?? document.body).opacity === "0",
    )
    await expect(openQueue).toBeFocused()
    await page.screenshot({
      path: `../../.omo/evidence/final-visual-fix/screens/queue-motion-${width}-closed.png`,
      fullPage: true,
    })
  })
}

for (const width of [375, 768]) {
  test(`Given a ${width}px reduced-motion keyboard listener When the queue opens Then it has no transform travel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockWire(page)
    await page.goto("/#code=reduced-keyboard-queue")

    const openQueue = page.getByRole("button", {
      name: width < 768 ? "Open queue" : /Queue \(/,
    })
    const closeQueue = page.getByRole("button", { name: "Close queue", exact: true })
    let triggerFocused = false
    for (let tabPress = 0; tabPress < 32; tabPress += 1) {
      await page.keyboard.press("Tab")
      triggerFocused = await openQueue.evaluate((button) => document.activeElement === button)
      if (triggerFocused) break
    }
    expect(triggerFocused).toBe(true)

    await page.keyboard.press("Enter")

    await expect(closeQueue).toBeFocused()
    await expect(closeQueue).toHaveCSS("outline-width", "2px")
    await expect(page.locator("aside")).toHaveCSS("transform", "none")
    await page.screenshot({
      path: `../../.omo/evidence/final-visual-fix/screens/reduced-motion-focus-${width}.png`,
      fullPage: true,
    })
  })
}

for (const width of [375, 768]) {
  test(`Given a ${width}px queue dialog When native Tab or Shift+Tab is pressed Then focus remains in the dialog and returns to every opener`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockWire(page)
    await page.goto("/#code=queue-focus-containment")

    const openQueue = page.getByRole("button", { name: width < 768 ? "Open queue" : /Queue \(/ })
    const openers =
      width < 768
        ? [
            openQueue,
            page.getByRole("button", { name: "Review queue" }),
            page.getByRole("button", { name: /Queue \(/ }),
          ]
        : [openQueue]
    const closeQueue = page.getByRole("button", { name: "Close queue", exact: true })
    const queueOverlay = page.locator("aside")

    let triggerFocused = false
    for (let tabPress = 0; tabPress < 32; tabPress += 1) {
      await page.keyboard.press("Tab")
      triggerFocused = await openQueue.evaluate((button) => document.activeElement === button)
      if (triggerFocused) break
    }
    expect(triggerFocused).toBe(true)

    await page.keyboard.press("Enter")
    await expect(queueOverlay).toHaveAttribute("aria-modal", "true")
    await expect(closeQueue).toBeFocused()
    expect(await page.locator(".skip").evaluate((skip) => skip.inert)).toBe(true)

    for (let tabPress = 0; tabPress < 20; tabPress += 1) {
      await page.keyboard.press("Tab")
      expect(await queueOverlay.evaluate((aside) => aside.contains(document.activeElement))).toBe(
        true,
      )
    }
    for (let tabPress = 0; tabPress < 20; tabPress += 1) {
      await page.keyboard.press("Shift+Tab")
      expect(await queueOverlay.evaluate((aside) => aside.contains(document.activeElement))).toBe(
        true,
      )
    }

    await page.keyboard.press("Escape")
    await expect(openQueue).toBeFocused()

    for (const opener of openers) {
      await opener.focus()
      await page.keyboard.press("Enter")
      await expect(closeQueue).toBeFocused()
      await closeQueue.press("Enter")
      await expect(opener).toBeFocused()
    }
  })
}

test("Given a dropped socket When reconnect starts Then status is exposed", async ({ page }) => {
  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage(() => {
      socket.send(JSON.stringify({ version: 1, type: "state.snapshot", payload: room }))
      void socket.close({ code: 1012, reason: "restart" })
    })
  })
  await page.route("**/api/**", async (route) =>
    route.fulfill({
      json: route.request().url().includes("voice-channels")
        ? { channels: [{ id: "voice-1", name: "Main Room" }] }
        : room,
    }),
  )
  await page.route("**/auth/exchange", async (route) =>
    route.fulfill({ json: { token: "browser-token", expiresAt: "2099-01-01T00:00:00.000Z" } }),
  )
  await page.goto("/#code=one-time")
  await expect(page.locator('[data-status="reconnecting"]:visible').first()).toBeVisible()
  await page.screenshot({ path: "../../.omo/evidence/dashboard/reconnecting.png", fullPage: true })
})

test("Given unseekable playback fails When the event arrives Then seek is disabled and an accessible toast appears", async ({
  page,
}) => {
  // Given
  const unseekableRoom = { ...room, player: { ...room.player, seekable: false } }
  await mockWire(page, {
    state: unseekableRoom,
    failure: {
      version: 1,
      type: "playback.failed",
      payload: {
        guildId: "guild-1",
        queueItemId: "queue-current",
        trackId: "track-current",
        provider: "youtube",
        title: "Mountain Echoes",
        artist: "Harbor Lights",
        message: "Playback failed; skipped to the next track.",
      },
    },
  })

  // When
  await page.goto("/#code=unseekable-failure")

  // Then
  await expect(page.getByTestId("seek-control").getByRole("slider")).toBeDisabled()
  await expect(page.getByTestId("seek-control").getByRole("status")).toContainText(
    "Seeking unavailable",
  )
  const toast = page.getByTestId("playback-failure-toast")
  await expect(toast).toContainText("Mountain Echoes could not be played")
  await expect(toast).toHaveAttribute("role", "status")
  await page.screenshot({
    path: "../../.omo/evidence/final-repair/seekable-failure-notifications/dashboard-failure.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "Dismiss playback failure" }).click()
  await expect(toast).toHaveCount(0)
})

test("Given OAuth callback When the listener controls playback Then the real dashboard updates", async ({
  page,
}) => {
  let searchRequest: unknown = null
  await mockWire(page)
  await page.unroute("**/api/search")
  await page.route("**/api/search", async (route) => {
    searchRequest = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({
      json: {
        results: [{ track: track("search-1", "Northern Lines", "Small Hours"), score: 0.94 }],
      },
    })
  })
  await page.goto("/#code=one-time")
  await expect(page.getByTestId("current-track")).toHaveAttribute("data-track-id", "track-current")
  await expect(page).toHaveURL(/\/$/)
  await page.getByPlaceholder("Track name or link").fill("Northern Lines")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  expect(searchRequest).toEqual({ method: "POST", body: { q: "Northern Lines" } })
  await expect(page.getByTestId("search-result")).toHaveAttribute("data-track-id", "search-1")
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/search-results.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "Add Northern Lines to end" }).click()
  const player = page.getByRole("region", { name: "Mountain Echoes" })
  const footer = page.locator(".desktop-player-footer")
  await footer.getByRole("button", { name: "Pause playback" }).click()
  await player.getByLabel("Volume").fill("88")
  await footer.getByRole("button", { name: /Loop mode/ }).click()
  await page.locator('summary[aria-label="Queue actions for Signal Fires"]').click()
  await page.getByRole("button", { name: "Move Signal Fires up" }).click()
  await expect(page.getByTestId("queue-error")).toBeVisible()
  await page.getByRole("button", { name: "History" }).click()
  await expect(page.getByTestId("history-item")).toHaveAttribute("data-history-id", "history-1")
  await page.screenshot({ path: "../../.omo/evidence/dashboard/history.png", fullPage: true })
  await page.getByRole("button", { name: "Player" }).click()
  await page.getByRole("button", { name: "Log out" }).click()
  await expect(page.getByTestId("auth-anonymous")).toBeVisible()
  await page.screenshot({ path: "../../.omo/evidence/dashboard/login.png", fullPage: true })
})

test("Given provider settings When the simulator is connected Then priority can be changed without credentials", async ({
  page,
}) => {
  let preferenceRequest: unknown = null
  await mockWire(page)
  await page.unroute("**/api/providers/preference")
  await page.route("**/api/providers/preference", async (route) => {
    preferenceRequest = route.request().postDataJSON()
    await route.fulfill({
      json: {
        ...room,
        version: 9,
        providers: { preference: "youtube_only", mockTidalConnected: true },
      },
    })
  })
  await page.goto("/#code=one-time")
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByTestId("provider-settings")).toContainText("Local classroom simulator")
  await expect(page.getByTestId("provider-settings")).toContainText("does not use a TIDAL account")
  await page.getByRole("button", { name: "Connect simulator" }).click()
  await expect(page.getByText("Simulator connected")).toBeVisible()
  await page.getByLabel("YouTube only").check()
  expect(preferenceRequest).toEqual({ preference: "youtube_only" })
  await expect(page.getByLabel("YouTube only")).toBeChecked()
  await page.getByRole("button", { name: "Disconnect simulator" }).click()
  await expect(page.getByText("Simulator off · YouTube active")).toBeVisible()
})

test("Given a mobile listener When settings opens Then the same header action returns to the player", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await mockWire(page)
  await page.goto("/#code=one-time")
  await page.getByRole("button", { name: "Open settings" }).click()
  await expect(page.getByRole("heading", { name: "Source priority" })).toBeVisible()
  await page.getByRole("button", { name: "Return to player" }).click()
  await expect(page.getByTestId("current-track")).toBeVisible()
})

for (const width of [375, 768, 1280]) {
  test(`Given mock TIDAL settings at ${width}px When connection changes Then both visual states remain usable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockWire(page)
    await page.goto("/#code=one-time")
    if (width < 768) await page.getByRole("button", { name: "Open settings" }).click()
    else await page.getByRole("button", { name: "Settings" }).click()
    await expect(page.getByRole("heading", { name: "Source priority" })).toBeVisible()
    await page.screenshot({
      path: `../../.omo/evidence/mock-tidal/settings-${width}-disconnected.png`,
      fullPage: true,
    })
    await page.getByRole("button", { name: "Connect simulator" }).click()
    await expect(page.getByText("Simulator connected")).toBeVisible()
    await page.screenshot({
      path: `../../.omo/evidence/mock-tidal/settings-${width}-connected.png`,
      fullPage: true,
    })
    expect(await page.locator("body").evaluate((body) => body.scrollWidth)).toBe(width)
  })
}

for (const width of [375, 768, 1280]) {
  test(`Given a ${width}px viewport When the room loads Then the shell is usable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockWire(page)
    await page.goto("/#code=one-time")
    await expect(page.getByTestId("current-track")).toHaveAttribute(
      "data-track-id",
      "track-current",
    )
    await page.screenshot({
      path: `../../.omo/evidence/dashboard/product-${width}.png`,
      fullPage: true,
    })
    expect(await page.locator("body").evaluate((body) => body.scrollWidth)).toBe(width)
  })
}

test("Given the desktop reference geometry When the room loads Then comparison evidence is captured", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1568, height: 1003 })
  await mockWire(page)
  await page.goto("/#code=one-time")
  await expect(page.getByTestId("current-track")).toHaveAttribute("data-track-id", "track-current")
  const geometry = await page.locator(".shell").evaluate((shell) => {
    const nav = shell.querySelector("nav")
    const main = shell.querySelector("main")
    const queue = shell.querySelector("aside")
    const footer = document.querySelector(".desktop-player-footer")
    return {
      nav: nav?.getBoundingClientRect().width,
      main: main?.getBoundingClientRect().width,
      queue: queue?.getBoundingClientRect().width,
      footer: footer?.getBoundingClientRect().height,
    }
  })
  expect(geometry).toEqual({ nav: 337, main: 670, queue: 561, footer: 156 })
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/comparison-actual-desktop.png",
    fullPage: true,
  })
})

test("Given the normalized mobile reference geometry When the room loads Then comparison evidence is captured", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 666 })
  await mockWire(page)
  await page.goto("/#code=one-time")
  await expect(page.getByTestId("current-track")).toHaveAttribute("data-track-id", "track-current")
  await page.screenshot({
    path: "../../.omo/evidence/dashboard/comparison-actual-mobile.png",
    fullPage: true,
  })
})
