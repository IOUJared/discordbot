import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const dashboardRoot = process.cwd()
const outputRoot = join(dashboardRoot, "build")

function buildWithBase(base: string): void {
  execFileSync("pnpm", ["build"], {
    cwd: dashboardRoot,
    env: { ...process.env, BASE_PATH: base },
    stdio: "pipe",
  })
}

function deploymentPage(base: string, outputPath: string): URL {
  const deploymentBase = base.length === 0 ? "/" : `${base}/`
  return new URL(
    `${deploymentBase}${outputPath.replace(/index\.html$/, "")}`,
    "https://owner.github.io",
  )
}

function generatedAssetUrls(html: string, page: URL): readonly URL[] {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined && !value.startsWith("data:"))
    .map((value) => new URL(value, page))
}

describe("GitHub Pages static artifacts", () => {
  it("Given root and repository base paths When production builds Then page assets and artwork resolve from their deployed URLs", () => {
    for (const base of ["", "/discordbot"]) {
      buildWithBase(base)
      const pages = ["index.html", "showcase/index.html", "design-system/index.html"]

      for (const outputPath of pages) {
        const pageFile = join(outputRoot, outputPath)
        expect(existsSync(pageFile)).toBe(true)

        for (const assetUrl of generatedAssetUrls(
          readFileSync(pageFile, "utf8"),
          deploymentPage(base, outputPath),
        )) {
          expect(assetUrl.pathname.startsWith(`${base}/`)).toBe(true)
          expect(existsSync(join(outputRoot, relative(base || "/", assetUrl.pathname)))).toBe(true)
        }
      }

      for (const artwork of [
        "artwork-mountain.png",
        "artwork-mountain-720.webp",
        "artwork-mountain-720.avif",
      ]) {
        const artworkUrl = new URL(`${base}/${artwork}`, "https://owner.github.io")
        expect(artworkUrl.pathname).toBe(`${base}/${artwork}`)
        expect(existsSync(join(outputRoot, relative(base || "/", artworkUrl.pathname)))).toBe(true)
      }
    }
  }, 60_000)
})
