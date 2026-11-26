import type { PageProps } from '@kayjs/kay'
import { Region } from '@kayjs/kay'
import { formatPrice, PRODUCTS } from '../data'

// The one bench page that swaps a region: its weight is the regions client, which no other page loads.
export default function RegionsPage({ url }: PageProps) {
  const tag = url.searchParams.get('tag') ?? ''
  const products = tag === '' ? PRODUCTS : PRODUCTS.filter(product => product.tags.includes(tag))

  return (
    <>
      <h1>Products by tag</h1>
      <form method="get" data-kay-target="products" data-kay-live>
        <input type="search" name="tag" value={tag} aria-label="Tag" />
      </form>
      <Region name="products" aria-label="Products">
        <ul class="products">
          {products.map(product => (
            <li key={product.id} class="product">
              <h2>{product.name}</h2>
              <p class="price">{formatPrice(product.price)}</p>
            </li>
          ))}
        </ul>
      </Region>
    </>
  )
}
