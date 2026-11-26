import type { KayChild } from '@kayjs/kay'
import { Head } from '@kayjs/kay'
import '../styles/app.css'

export default function Layout({ children }: { children: KayChild }) {
  return (
    <>
      <Head>
        <title>__APP_NAME__</title>
      </Head>
      <div class="wrap">
        <header data-layout="split" class="site-header">
          <a href="/" class="site-brand">__APP_NAME__</a>
          <a href="/rss.xml" class="site-rss">RSS</a>
        </header>
        <main>{children}</main>
      </div>
    </>
  )
}
