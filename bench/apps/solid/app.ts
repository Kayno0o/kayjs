import type { PageProps } from './src/app'
import { join } from 'node:path'
import { plugin } from 'bun'
import { Elysia } from 'elysia'
import { solidPlugin } from './src/compile'

const DIST = join(import.meta.dir, 'dist')

// The same page shell as kay's: hydration script and module entry in the head, the app straight in the body.
export async function createApp() {
  await plugin(solidPlugin('ssr'))

  const [{ App }, { createComponent, generateHydrationScript, renderToString }, { PRODUCTS }, build] = await Promise.all([
    import('./src/app'),
    import('solid-js/web'),
    import('../../shared/data'),
    Bun.build({ entrypoints: [join(import.meta.dir, 'src', 'client.tsx')], outdir: DIST, target: 'browser', splitting: true, minify: true, define: { 'process.env.NODE_ENV': '"production"' }, naming: '[name]-[hash].[ext]', plugins: [solidPlugin('dom')] }),
  ])
  const entry = build.outputs.find(output => output.kind === 'entry-point')!.path.slice(DIST.length + 1)
  const page = (props: PageProps) => {
    const body = renderToString(() => createComponent(App, props))
    const data = JSON.stringify(props).replaceAll('<', '\\u003c')

    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${generateHydrationScript()}<script id="page-data" type="application/json">${data}</script><script type="module" src="/_assets/${entry}"></script></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  return new Elysia()
    .get('/', () => page({ page: 'products', products: PRODUCTS }))
    .get('/table', () => page({ page: 'table' }))
    .get('/_assets/:file', ({ params }) => new Response(Bun.file(join(DIST, params.file)), { headers: { 'content-type': 'text/javascript; charset=utf-8' } }))
}
