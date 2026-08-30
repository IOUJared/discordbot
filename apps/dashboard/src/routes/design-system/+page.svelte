<script lang="ts">
  import { onMount } from "svelte"
  import Showcase from "../showcase/+page.svelte"

  onMount(() => {
    document.querySelector(".boot")?.remove()
  })
</script>

<Showcase />
