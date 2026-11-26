import type { LayoutProps } from '@kayjs/kay'
import { Button, Cluster, Toaster } from '@kayjs/ui'
import { Head } from '@kayjs/kay'
import '../styles/app.css'

export default function Layout({ children, locals }: LayoutProps) {
  const user = locals.user
  return (
    <>
      <Head>
        <title>__APP_NAME__</title>
      </Head>
      <div class="wrap">
        <header data-layout="split" class="site-header">
          <a href="/" class="site-brand">__APP_NAME__</a>
          {user
            ? (
                <Cluster>
                  <Button href="/dashboard" variant="ghost" size="sm">{user.email}</Button>
                  <form action="/auth/signout" method="post">
                    <Button type="submit" variant="outline" size="sm">Sign out</Button>
                  </form>
                </Cluster>
              )
            : <Button href="/login" variant="outline" size="sm">Sign in</Button>}
        </header>
        <main>{children}</main>
      </div>
      <Toaster />
    </>
  )
}
