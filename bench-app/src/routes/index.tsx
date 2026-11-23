import { Counter } from '../components/Counter'
import { formatPrice, PRODUCTS } from '../data'

export default async function ProductsPage() {
  const products = PRODUCTS

  return (
    <>
      <h1>Products</h1>
      <p class="summary">{products.length} products</p>
      <Counter start={0} />
      <ul class="products">
        {products.map(product => (
          <li key={product.id} class="product">
            <h2>{product.name}</h2>
            <p class="price">{formatPrice(product.price)}</p>
            <p class={product.stock === 0 ? 'stock out' : 'stock in'}>{product.stock} in stock</p>
            <ul class="tags">
              {product.tags.map(tag => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  )
}
