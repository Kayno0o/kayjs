import type { KayChild } from '@kayjs/kay'
import { Head } from '@kayjs/kay'
import '../styles/app.css'

export default function Layout({ children }: { children: KayChild }) {
  return (
    <>
      <Head>
        <title>__APP_NAME__</title>
      </Head>
      <main>{children}</main>
    </>
  )
}
