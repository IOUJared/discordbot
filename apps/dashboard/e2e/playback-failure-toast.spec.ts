import { expect, test } from "@playwright/test"
import { mockWire, room, type WireOptions } from "./wire.js"

const failure: NonNullable<WireOptions["failure"]> = {
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
}

async function expectNoActionableOverlap(page: import("@playwright/test").Page): Promise<void> {
  const overlaps = await page.getByTestId("playback-failure-toast").evaluate((toast) => {
    const toastRect = toast.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>("button,input,select,a[href]")]
      .filter((control) => !toast.contains(control))
      .filter((control) => {
        const style = getComputedStyle(control)
        const rect = control.getBoundingClientRect()
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        )
      })
      .filter((control) => {
        const rect = control.getBoundingClientRect()
        return (
          toastRect.left < rect.right &&
          toastRect.right > rect.left &&
          toastRect.top < rect.bottom &&
          toastRect.bottom > rect.top
        )
      })
      .map(
        (control) =>
          control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName,
      )
  })
  expect(overlaps).toEqual([])
}

type MotionState = {
  readonly opacity: number
  readonly transform: string
  readonly filter: string
}

async function pauseToastAtMidpoint(
  toast: import("@playwright/test").Locator,
): Promise<MotionState> {
  return toast.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    )
    const animation = element
      .getAnimations()
      .find((candidate) => candidate.effect?.getComputedTiming().activeDuration > 0)
    if (animation === undefined || animation.effect === null) {
      throw new Error("Expected a toast animation with a positive duration")
    }
    await animation.ready
    const duration = animation.effect.getComputedTiming().activeDuration
    if (typeof duration !== "number" || duration <= 0) {
      throw new Error("Expected a positive toast animation duration")
    }
    animation.pause()
    animation.currentTime = duration / 2
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const style = getComputedStyle(element)
    return { opacity: Number(style.opacity), transform: style.transform, filter: style.filter }
  })
}

async function finishToastMotion(toast: import("@playwright/test").Locator): Promise<void> {
  await toast.evaluate((element) =>
    element.getAnimations().forEach((animation) => {
      animation.finish()
    }),
  )
}

function expectMotionContract(state: MotionState, reducedMotion: boolean): void {
  expect(state.opacity).toBeGreaterThan(0)
  expect(state.opacity).toBeLessThan(1)
  if (reducedMotion) {
    expect(state.transform).toBe("none")
    expect(state.filter).toBe("none")
  } else {
    expect(state.transform).not.toBe("none")
    expect(state.filter).not.toBe("none")
  }
}

for (const width of [375, 768, 1280]) {
  for (const reducedMotion of [false, true]) {
    test(`Given a ${width}px ${reducedMotion ? "reduced" : "normal"} playback failure When it enters and exits Then it does not obstruct actions or steal focus`, async ({
      page,
    }) => {
      let releaseFailure = (): void => undefined
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve
      })
      await page.setViewportSize({ width, height: 900 })
      if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" })
      await mockWire(page, { state: room, failure, failureGate })
      await page.goto("/#code=toast-contract")
      await page.addStyleTag({ content: ":root{--motion-standard:10s}" })
      const toast = page.getByTestId("playback-failure-toast")
      const region = page.getByTestId("playback-failure-region")
      const pause = page.getByRole("button", { name: "Pause playback" })

      await expect(toast).toHaveCount(0)
      await pause.focus()
      releaseFailure()
      await expect(toast).toBeVisible()
      await expect(region).toHaveAttribute("aria-live", "polite")
      await expect(pause).toBeFocused()
      expectMotionContract(await pauseToastAtMidpoint(toast), reducedMotion)
      await expectNoActionableOverlap(page)
      await finishToastMotion(toast)
      await expectNoActionableOverlap(page)

      await page.getByRole("button", { name: "Dismiss playback failure" }).click()
      await expect(toast).toBeVisible()
      expectMotionContract(await pauseToastAtMidpoint(toast), reducedMotion)
      await expectNoActionableOverlap(page)
      await finishToastMotion(toast)
      await expect(toast).toHaveCount(0)
    })
  }
}
