import type { KayChild } from 'kay'
import { Head } from 'kay'
import { Toaster } from '@kayjs/ui'
import { GrammarSwitcher } from '../components/GrammarSwitcher'

export default function Layout({ children, locals }: { children: KayChild, locals?: { user?: { email: string } } }) {
  return (
    <>
      <Head>
        <title>Kay v2 — @kayjs/ui Grammar Switcher & @kayjs/auth Showcase</title>
        <link id="kui-grammar" rel="stylesheet" href="/grammars/editorial.css" />
        <style>{`
          body { margin: 0; background: var(--ui-paper, #fff); color: var(--ui-ink, #111); font-family: var(--ui-font-body, system-ui, sans-serif); transition: background 180ms ease, color 180ms ease; }
          .shell { max-width: 68rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
          .topbar { padding-bottom: 1.25rem; margin-bottom: 2rem; border-bottom: 1px solid var(--ui-line, #ddd); }
        `}</style>
      </Head>
      <div class="shell">
        <header class="topbar" data-layout="split">
          <div data-layout="cluster">
            <strong>Kay v2 UI</strong>
            <GrammarSwitcher initial="editorial" />
          </div>
          <nav data-layout="cluster">
            <a data-ui="button" data-variant="ghost" data-size="sm" href="/">Showcase</a>
            <a data-ui="button" data-variant="ghost" data-size="sm" href="/account">
              {locals?.user ? locals.user.email : 'Account (guarded)'}
            </a>
          </nav>
        </header>
        {children}
      </div>
      <Toaster />
    </>
  )
}
