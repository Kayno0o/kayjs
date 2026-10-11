import { formatPrice, PRODUCTS } from '../../../shared/data'
import { Counter } from '../components/counter'
import { Site } from '../components/site'

// Rendered on each request, as every other app does, rather than prerendered at build.
export const dynamic = 'force-dynamic'

export default function Products() {
  return (
    <Site page="products">
      <h1>Products</h1>
      <p className="summary">
        {PRODUCTS.length}
        {' '}
        products
      </p>
      <Counter start={0} />
      <ul className="products">
        {PRODUCTS.map(product => (
          <li key={product.id} className="product">
            <h2>{product.name}</h2>
            <p className="price">{formatPrice(product.price)}</p>
            <p className={`stock ${product.stock === 0 ? 'out' : 'in'}`}>
              {product.stock}
              {' '}
              in stock
            </p>
            <ul className="tags">
              {product.tags.map(tag => <li key={tag}>{tag}</li>)}
            </ul>
          </li>
        ))}
      </ul>
    </Site>
  )
}
