<script lang="ts">
  import type { Product } from '../../../shared/data'
  import { formatPrice } from '../../../shared/data'
  import Counter from './Counter.svelte'

  const { products }: { products: Product[] } = $props()
</script>

<h1>Products</h1><p class="summary">{products.length} products</p><Counter start={0} /><ul class="products">{#each products as product (product.id)}<li class="product"><h2>{product.name}</h2><p class="price">{formatPrice(product.price)}</p><p class="stock {product.stock === 0 ? 'out' : 'in'}">{product.stock} in stock</p><ul class="tags">{#each product.tags as tag (tag)}<li>{tag}</li>{/each}</ul></li>{/each}</ul>
