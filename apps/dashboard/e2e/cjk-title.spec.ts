import { expect, test } from "@playwright/test"
import { item, mockWire, room } from "./wire.js"

const semanticUnits = ["留下", "之后", "汇合", "安静"]
const adversarialWords = ["한".repeat(400), "漢".repeat(400)]

for (const width of [375, 768, 1280]) {
  for (const word of adversarialWords) {
    test(`Given a ${word[0] === "한" ? "Hangul" : "Han"} title at ${width}px When it contains one unspaced long word Then it stays visible without splitting short semantic units`, async ({
      page,
    }) => {
      const title = `${semanticUnits.join("")} ${word} supercalifragilisticexpialidociouswithoutspaces`
      const state = {
        ...room,
        player: { ...room.player, currentItem: item("cjk-long-word", title, "조용한 밤") },
      }
      await mockWire(page, { state })
      await page.setViewportSize({ width, height: 900 })
      await page.goto("/#code=cjk-long-word")

      const heading = page.getByTestId("current-track").getByRole("heading")
      await expect(heading).toBeVisible()
      await expect(heading).toHaveAccessibleName(title)
      const layout = await heading.evaluate((element, expectedUnits) => {
        const unitRects = expectedUnits.map((text) => {
          const unit = [
            ...element.querySelectorAll<HTMLElement>('[data-title-segment="cjk"]'),
          ].find((candidate) => candidate.textContent === text)
          return { text, rects: unit === undefined ? 0 : unit.getClientRects().length }
        })
        const range = document.createRange()
        range.selectNodeContents(element)
        return {
          bodyWidth: document.body.scrollWidth,
          headingClientWidth: element.clientWidth,
          headingScrollWidth: element.scrollWidth,
          lineCount: range.getClientRects().length,
          title: element.textContent?.replace(/\s+/gu, " ").trim() ?? "",
          unitRects,
        }
      }, semanticUnits)
      expect(layout.bodyWidth).toBe(width)
      expect(layout.headingScrollWidth).toBeLessThanOrEqual(layout.headingClientWidth)
      expect(layout.lineCount).toBeGreaterThan(1)
      expect(layout.title).toBe(title)
      expect(layout.unitRects).toEqual(semanticUnits.map((text) => ({ text, rects: 1 })))
    })
  }
}
