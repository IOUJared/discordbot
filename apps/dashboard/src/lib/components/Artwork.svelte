<script lang="ts">
  import { base } from "$app/paths"

  let {
    src,
    alt,
    priority = false,
  }: { src: string; alt: string; priority?: boolean } = $props()

  const bundled = $derived(src.includes("artwork-mountain"))
</script>

<picture>
  {#if bundled}
    <source
      type="image/avif"
      srcset={`${base}/artwork-mountain-360.avif 360w, ${base}/artwork-mountain-480.avif 480w, ${base}/artwork-mountain-720.avif 720w`}
      sizes="(max-width: 767px) 244px, 598px"
    />
    <source
      type="image/webp"
      srcset={`${base}/artwork-mountain-360.webp 360w, ${base}/artwork-mountain-480.webp 480w, ${base}/artwork-mountain-720.webp 720w`}
      sizes="(max-width: 767px) 244px, 598px"
    />
  {/if}
  <img
    src={bundled ? `${base}/artwork-mountain-720.webp` : src}
    {alt}
    width="720"
    height="720"
    loading={priority ? "eager" : "lazy"}
    fetchpriority={priority ? "high" : "auto"}
    decoding="async"
  />
</picture>

<style>
  picture,img{display:block;inline-size:100%;block-size:100%}img{object-fit:cover}
</style>
