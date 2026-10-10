<script lang="ts">
  import type { PageProps } from './types'
  import Products from './Products.svelte'
  import Table from './Table.svelte'

  const props: PageProps = $props()
  // Marks the link to the page shown, as kay does by itself.
  const current = (page: PageProps['page']) => props.page === page ? 'page' : undefined
</script>

<header class="site"><a class="brand" href="/" aria-current={current('products')}>Bench shop</a><nav><a href="/" aria-current={current('products')}>Products</a><a href="/table" aria-current={current('table')}>Table</a></nav></header><main>{#if props.page === 'products'}<Products products={props.products} />{:else}<Table />{/if}</main><footer><p>Rendered for the benchmark</p></footer>
