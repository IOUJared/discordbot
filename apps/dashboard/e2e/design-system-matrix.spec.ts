import { expect, test } from "@playwright/test"

const primitives = [
  "app-shell",
  "room-navigation",
  "now-playing",
  "transport",
  "range-control",
  "queue",
  "connection-badge",
  "playback-source-settings",
  "toast-stack",
] as const

const states = [
  "default",
  "hover",
  "active",
  "focus-visible",
  "disabled",
  "loading",
  "empty",
  "error",
] as const

for (const width of [375, 768, 1280]) {
  test(`Given the DESIGN.md primitive contract at ${width}px When the exact route renders Then every state cell is honest`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/design-system/")

    const matrix = page.getByTestId("primitive-state-matrix")
    await expect(matrix).toBeVisible()
    for (const primitive of primitives) {
      for (const state of states) {
        const cell = page.locator(`[data-matrix-cell="${primitive}-${state}"]`)
        await expect(cell).toHaveCount(1)
        await expect(cell).toHaveAttribute("data-kind", /^(component|na)$/)
        if ((await cell.getAttribute("data-kind")) === "na") {
          await expect(cell.getByText(/^N\/A — .+/)).toBeVisible()
        } else {
          await expect(cell.locator("[data-showcase-render]")).toHaveCount(1)
        }
      }
    }

    const duplicateIds = await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id)
      return ids.filter((id, index) => ids.indexOf(id) !== index)
    })
    expect(duplicateIds).toEqual([])
    await expect(
      page.locator('[data-matrix-cell="toast-stack-default"] [aria-live="polite"]'),
    ).toBeEmpty()
    await expect(
      page.locator('[data-matrix-cell="toast-stack-empty"] [aria-live="polite"]'),
    ).toBeEmpty()
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>("[data-primitive='now-playing'] img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    )
    for (const artwork of await page.locator("[data-primitive='now-playing'] img").all()) {
      await artwork.evaluate((image: HTMLImageElement) => image.decode())
    }
    if (width < 1024) {
      const activeShell = page.locator('[data-matrix-cell="app-shell-active"]')
      await activeShell.getByRole("button", { name: "Open queue" }).click()
      await expect(activeShell.getByRole("button", { name: "Close queue" })).toBeFocused()
    }

    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width)
    await page.screenshot({
      path: `../../.omo/evidence/design-system-matrix-fix/screens/matrix-${width}.png`,
      fullPage: true,
    })
  })
}

test("Given representative production controls When pointer and keyboard states are driven Then real CSS state feedback is observable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/design-system/")

  const hoverButton = page.locator('[data-matrix-cell="transport-default"]').getByRole("button", {
    name: "Pause playback",
  })
  await hoverButton.hover()
  await expect(hoverButton).toHaveCSS("background-color", "rgb(65, 79, 141)")
  await hoverButton.screenshot({
    path: "../../.omo/evidence/design-system-matrix-fix/screens/interaction-hover.png",
  })

  const activeButton = page.locator('[data-matrix-cell="transport-default"]').getByRole("button", {
    name: "Pause playback",
  })
  const activeBox = await activeButton.boundingBox()
  expect(activeBox).not.toBeNull()
  if (activeBox === null) throw new Error("Active transport control has no browser box")
  await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2)
  await page.mouse.down()
  await expect(activeButton).toHaveCSS("transform", /matrix\(0\.96/)
  await activeButton.screenshot({
    path: "../../.omo/evidence/design-system-matrix-fix/screens/interaction-active.png",
  })
  await page.mouse.up()

  const focusRange = page.locator('[data-matrix-cell="range-control-default"]').getByRole("slider")
  await focusRange.focus()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  await expect(focusRange).toBeFocused()
  await expect(focusRange).toHaveCSS("outline-width", "2px")
  await page.locator('[data-matrix-cell="range-control-default"]').screenshot({
    path: "../../.omo/evidence/design-system-matrix-fix/screens/interaction-focus.png",
  })
})

for (const width of [375, 768]) {
  test(`Given the responsive queue representation at ${width}px When it closes and reopens Then focus returns to the correct control`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/design-system/")
    const cell = page.locator('[data-matrix-cell="queue-default"]')
    const trigger = cell.getByRole("button", { name: "Open queue showcase" })
    const close = cell.getByRole("button", { name: "Close queue" })
    await close.click()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(cell.getByRole("dialog")).toBeVisible()
    await expect(close).toBeFocused()

    const shell = page.locator('[data-matrix-cell="app-shell-active"]')
    const shellTrigger = shell.getByRole("button", { name: "Open queue" })
    const shellClose = shell.getByRole("button", { name: "Close queue" })
    await shellTrigger.click()
    await expect(shellClose).toBeFocused()
    await shellClose.click()
    await expect(shellTrigger).toBeFocused()
  })
}
