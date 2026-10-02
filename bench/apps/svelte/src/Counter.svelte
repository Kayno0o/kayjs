<script lang="ts">
  const { start }: { start: number } = $props()
  let count = $state(start)
</script>

<button class="counter" onclick={() => count++}>Clicked {count}</button>
