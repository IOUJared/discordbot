import { sveltekit } from "@sveltejs/kit/vite"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"

const iconWeights: Readonly<Record<string, string>> = {
  ArrowDown: "bold", ArrowUp: "bold", ArrowsClockwise: "bold", CheckCircle: "fill",
  ClockCounterClockwise: "regular", DotsSixVertical: "regular", DotsThreeVertical: "bold",
  House: "fill", List: "regular", Lock: "regular", MagnifyingGlass: "regular",
  MusicNotes: "duotone", Pause: "fill", Play: "fill", Plus: "regular", Queue: "regular",
  Shuffle: "bold", SignOut: "regular", SkipBack: "fill", SkipForward: "fill",
  SpeakerHigh: "regular", SpinnerGap: "bold", Stop: "fill", Trash: "bold",
  WarningCircle: "fill", WifiSlash: "bold", X: "regular",
}

function optimizePhosphorWeights(): Plugin {
  return {
    name: "optimize-phosphor-weights",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/phosphor-svelte/lib/") || !id.includes(".svelte")) return
      const name = id.match(/\/([^/?]+)\.svelte(?:\?|$)/)?.[1]
      if (name === undefined) return
      const weight = iconWeights[name]
      if (weight === undefined) return
      const branch = new RegExp(`(?:\\{#if|\\{:else if) weight === "${weight}"\\}([\\s\\S]*?)(?=\\{:else if|\\{/if\\})`)
      const selected = code.match(branch)?.[1]
      if (selected === undefined) return
      return code.replace(/\{#if weight === "[^"]+"\}[\s\S]*?\{\/if\}/, selected)
    },
  }
}

export default defineConfig({
  plugins: [optimizePhosphorWeights(), sveltekit()],
  test: { include: ["tests/**/*.test.ts"] },
})
