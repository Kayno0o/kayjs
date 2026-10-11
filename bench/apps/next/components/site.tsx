import type { ReactNode } from 'react'

type Page = 'products' | 'table'

// Marks the link to the page shown, as kay does by itself.
export function Site({ page, children }: { page: Page, children: ReactNode }) {
  const current = (name: Page) => page === name ? 'page' : undefined

  return (
    <>
      <header className="site">
        <a className="brand" href="/" aria-current={current('products')}>Bench shop</a>
        <nav>
          <a href="/" aria-current={current('products')}>Products</a>
          <a href="/table" aria-current={current('table')}>Table</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>
        <p>Rendered for the benchmark</p>
      </footer>
    </>
  )
}
