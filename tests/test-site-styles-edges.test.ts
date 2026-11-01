import { resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const root = resolve(await fixtureCopy('bare'))
const PLAIN = 'body { color: #0a0b0c }'
const INNER = 'p { color: #0d0e0f }'

await Bun.write(`${root}/src/app.css`, '@import "tailwindcss" source("..");\n@theme {\n  --color-used: #123456;\n}\n')
await Bun.write(`${root}/package.json`, JSON.stringify({ name: 'app', devDependencies: { 'bun-plugin-tailwind': '*' } }))
await Bun.write(`${root}/public/plain.css`, PLAIN)
await Bun.write(`${root}/public/sub/inner.css`, INNER)
// The built stylesheet, then a print one, a disabled one, a `../` one with a query, and another site's by a protocol-relative href.
await Bun.write(`${root}/src/routes/_layout.kay`, `---\nimport '../app.css'\n---\nhead\n  link(rel="stylesheet" href="/plain.css" media="print")\n  link(rel="stylesheet" href="/plain.css" disabled)\n  link(rel="stylesheet" href="../plain.css?v=2")\n  link(rel="stylesheet" href="//example.invalid/other.css")\nslot\n`)
await Bun.write(`${root}/src/routes/index.kay`, 'h1.text-used Hi\n')
// A stylesheet beside the page, by a relative href.
await Bun.write(`${root}/src/routes/sub/_layout.kay`, 'head\n  link(rel="stylesheet" href="inner.css")\nslot\n')
await Bun.write(`${root}/src/routes/sub/page.kay`, 'h1.text-used Sub\n')

it('css() reads the stylesheets of an app under a base path', async () => {
  const site = await testSite({ root, styles: true, base: '/blog' })
  const css = await (await site.visit('/')).css()

  expect(css).toContain('--color-used: #123456')
  expect(css).toContain(PLAIN)
  await site.close()
}, 60_000)

it('css() works on a site with islands: false', async () => {
  const site = await testSite({ root, styles: true, islands: false })

  expect(await (await site.visit('/')).css()).toContain('--color-used: #123456')
  await site.close()
}, 60_000)

it('css() includes a print or disabled stylesheet, which is still the app\'s CSS', async () => {
  const site = await testSite({ root, styles: true })

  // The print one, the disabled one and the `../` one with a query are the same file.
  expect((await (await site.visit('/')).css()).split(PLAIN)).toHaveLength(4)
  await site.close()
}, 60_000)

it('css() resolves a relative, ../ and query-string href against the page, and skips a protocol-relative one', async () => {
  const site = await testSite({ root, styles: true })
  const css = await (await site.visit('/sub/page')).css()

  expect(css).toContain(INNER)
  expect(css.split(PLAIN)).toHaveLength(4)
  await site.close()
}, 60_000)
