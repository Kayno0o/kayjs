import type { KayChild } from 'kay'
import { SearchIsland } from '../components/SearchIsland'
import { getFlatNav } from '../content'

export default function Layout({ children, url }: { children: KayChild, url: URL }) {
  const pathname = url.pathname
  const searchItems = getFlatNav().map(item => ({
    id: item.slug,
    label: item.title,
    href: item.href,
    section: item.sectionLabel,
  }))
  const isDocs = pathname.startsWith('/docs')
  const isGrammars = pathname === '/grammars'

  return (
    <>
      <header class="docs-header">
        <div class={isDocs ? 'docs-shell-width docs-nav' : 'docs-container docs-nav'}>
          <a class="docs-brand" href="/">
            <img src="/favicon.svg" width="24" height="24" alt="" />
            kay
            <span class="docs-ver">v2.0-beta</span>
          </a>
          <nav class="docs-nav-links" aria-label="Main navigation">
            <a href="/docs/getting-started/introduction" aria-current={isDocs ? 'page' : undefined}>Docs</a>
            <a href="/grammars" aria-current={isGrammars ? 'page' : undefined}>UI Grammars</a>
            <a class="docs-nav-hide-sm" href="/#ecosystem">Ecosystem</a>
            <a class="docs-nav-hide-sm" href="/#benchmarks">Benchmarks</a>
            <a class="docs-nav-hide-sm" href="/llms.txt" style="font-family:var(--ui-font-mono);font-size:0.8rem">llms.txt</a>
            <SearchIsland items={searchItems} $hydrate="idle" />
          </nav>
        </div>
      </header>
      {children}
      <footer class="docs-footer">
        <div class={isDocs ? 'docs-shell-width docs-footer-row' : 'docs-container docs-footer-row'}>
          <span>
            Built with <a href="https://github.com/Kayno0o/kayjs">kay v2</a>, exported as static files.{' '}
            <span class="docs-weight" data-page-weight=""></span>
          </span>
          <span style="font-family:var(--ui-font-mono);display:flex;gap:1rem">
            <a href="/llms.txt" style="text-decoration:none">llms.txt</a>
            <a href="https://github.com/Kayno0o/kayjs" style="text-decoration:none">GitHub</a>
            <span>MIT</span>
          </span>
        </div>
      </footer>
    </>
  )
}
