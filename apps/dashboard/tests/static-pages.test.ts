import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const dashboardRoot = process.cwd()
const outputRoot = join(dashboardRoot, "build")

function artifactText(directory: string): string {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) return artifactText(path)
      return /\.(?:html|js|css)$/.test(entry) ? readFileSync(path, "utf8") : ""
    })
    .join("\n")
}

function buildWithBase(base: string): void {
  execFileSync("pnpm", ["build"], {
    cwd: dashboardRoot,
    env: { ...process.env, BASE_PATH: base },
    stdio: "pipe",
  })
}

describe("GitHub Pages static artifacts", () => {
  it("Given root and repository base paths When production builds Then links and artwork resolve without SPA fallback", () => {
    for (const base of ["", "/discordbot"]) {
      buildWithBase(base)
      const text = artifactText(outputRoot)
      const rootHtml = readFileSync(join(outputRoot, "index.html"), "utf8")
      expect(existsSync(join(outputRoot, "showcase", "index.html"))).toBe(true)
      expect(existsSync(join(outputRoot, "design-system", "index.html"))).toBe(true)
      expect(existsSync(join(outputRoot, "artwork-mountain.png"))).toBe(true)
      expect(text.includes("/showcase/")).toBe(true)
      expect(text.includes("/design-system/")).toBe(true)
      expect(text.includes("/artwork-mountain.png")).toBe(true)
      if (base.length > 0) expect(rootHtml.includes(`assets: "${base}"`)).toBe(true)
      expect(text).not.toContain("http://127.0.0.1:4174/artwork-mountain.png")
    }
  }, 60_000)
})
