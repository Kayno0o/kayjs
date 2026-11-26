import type { KayChild } from '@kayjs/kay'

export default function Layout({ children }: { children?: KayChild }) {
  return (
    <>
      <header class="site">
        <a class="brand" href="/">Bench shop</a>
        <nav>
          <a href="/">Products</a>
          <a href="/table">Table</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>
        <p>Rendered for the benchmark</p>
      </footer>
    </>
  )
}
