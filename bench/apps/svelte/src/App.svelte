<script lang="ts">
  import type { PageProps } from './types'
  import Products from './Products.svelte'
  import Table from './Table.svelte'

  const props: PageProps = $props()
</script>

<header class="site"><a class="brand" href="/">Bench shop</a><nav><a href="/">Products</a><a href="/table">Table</a></nav></header><main>{#if props.page === 'products'}<Products products={props.products} />{:else}<Table />{/if}</main><footer><p>Rendered for the benchmark</p></footer>
