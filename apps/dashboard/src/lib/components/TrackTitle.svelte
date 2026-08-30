<script lang="ts">
  type TitleSegment = {
    readonly text: string
    readonly protectsCjkWord: boolean
  }

  let { title }: { title: string } = $props()

  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
  const cjkRun = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
  const localeFor = (value: string): "ja" | "ko" | "zh" =>
    /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)
      ? "ja"
      : /\p{Script=Hangul}/u.test(value)
        ? "ko"
        : "zh"
  const segment = (value: string): readonly TitleSegment[] => {
    if (typeof Intl.Segmenter !== "function") return [{ text: value, protectsCjkWord: false }]
    return (value.match(cjkRun) ?? []).flatMap((run) => {
      if (!cjk.test(run)) return [{ text: run, protectsCjkWord: false }]
      const words = new Intl.Segmenter(localeFor(run), { granularity: "word" })
      return [...words.segment(run)].map(({ segment: text, isWordLike }) => ({
        text,
        protectsCjkWord: Boolean(isWordLike),
      }))
    })
  }
  const segments = $derived(segment(title))
</script>

{#each segments as segment}{#if segment.protectsCjkWord}<span data-title-segment="cjk">{segment.text}</span>{:else}{segment.text}{/if}{/each}

<style>
  span{display:inline-block;max-inline-size:100%;white-space:normal;overflow-wrap:anywhere}
</style>
