<script setup lang="ts">
const { start } = defineProps<{ start: number }>()
const count = ref(start)
</script>

<template>
  <button class="counter" @click="count++">Clicked {{ count }}</button>
</template>
