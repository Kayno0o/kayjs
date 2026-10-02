import type { Product } from '../../../shared/data'

export type PageProps = { page: 'products', products: Product[] } | { page: 'table' }
