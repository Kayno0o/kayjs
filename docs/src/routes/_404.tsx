import { Head } from 'kay'

export default function NotFoundPage() {
  return (
    <main class="docs-container" style="padding:5rem 1.5rem">
      <Head>
        <title>Not found</title>
      </Head>
      <p style="font-family:var(--ui-font-mono);font-size:0.78rem;color:var(--ui-accent);margin-bottom:0.5rem">404</p>
      <h1 style="font-family:var(--ui-font-display);font-size:2.4rem;margin:0 0 1rem">Page not found</h1>
      <p style="color:var(--ui-subtext);margin-bottom:1.5rem">That docs page moved or does not exist.</p>
      <a data-ui="button" data-tone="accent" href="/docs/getting-started/introduction">Go to Docs →</a>
    </main>
  )
}
