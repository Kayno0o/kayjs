import type { LayoutProps } from '@kayjs/kay'
import { Button, Cluster, Toaster } from '@kayjs/ui'
import { Head } from '@kayjs/kay'

export default function Layout({ children, locals }: LayoutProps) {
  const user = locals.user
  return (
    <>
      <Head>
        <title>Noticeboard — Kay v2</title>
        <style>{`
          body { margin: 0; background: var(--ui-paper); color: var(--ui-ink); font-family: var(--ui-font-body); }
          .nb-header { border-bottom: 1px solid var(--ui-line); padding: 0.9rem 1.25rem; }
          .nb-inner { max-width: 48rem; margin: 0 auto; }
          .nb-main { max-width: 48rem; margin: 0 auto; padding: 1.75rem 1.25rem 4rem; }
          .nb-brand { font-family: var(--ui-font-display); font-size: 1.35rem; font-weight: 700; text-decoration: none; color: inherit; }
        `}</style>
      </Head>
      <header class="nb-header">
        <nav class="nb-inner" data-layout="split" aria-label="Main navigation">
          <a class="nb-brand" href="/">Noticeboard</a>
          {user
            ? (
                <Cluster>
                  <span id="signed-in-user">{user.name || user.email}</span>
                  <form action="/auth/signout" method="post">
                    <Button type="submit" variant="ghost" size="sm">Sign out</Button>
                  </form>
                </Cluster>
              )
            : (
                <Cluster>
                  <Button href="/login" variant="outline" size="sm">Sign in / Join</Button>
                </Cluster>
              )}
        </nav>
      </header>
      <main id="main-content" class="nb-main">
        {children}
      </main>
      <Toaster />
    </>
  )
}
