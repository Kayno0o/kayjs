<script setup lang="ts">
type Page = 'products' | 'table'

const { page } = defineProps<{ page: Page }>()

// Marks the link to the page shown, as kay does by itself.
const current = (name: Page) => page === name ? 'page' : undefined
</script>

<template>
  <header class="site">
    <a class="brand" href="/" :aria-current="current('products')">Bench shop</a>
    <nav>
      <a href="/" :aria-current="current('products')">Products</a>
      <a href="/table" :aria-current="current('table')">Table</a>
    </nav>
  </header>
  <main>
    <slot />
  </main>
  <footer>
    <p>Rendered for the benchmark</p>
  </footer>
</template>
