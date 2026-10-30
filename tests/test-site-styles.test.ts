import { resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const root = resolve(await fixtureCopy('bare'))

await Bun.write(`${root}/src/app.css`, '@import "tailwindcss" source("..");\n@theme {\n  --color-used: #123456;\n  --color-lane-0: #654321;\n}\n')
await Bun.write(`${root}/src/routes/_layout.kay`, `---\nimport '../app.css'\n---\nslot\n`)
await Bun.write(`${root}/src/routes/index.kay`, `---\nconst lane = 0\n---\nh1.text-used Hi\np(style={\`color: var(--color-lane-\${lane})\`}) Markup\n`)
await Bun.write(`${root}/package.json`, JSON.stringify({ name: 'app', devDependencies: { 'bun-plugin-tailwind': '*' } }))

it('a visit of a site with styles: true reads the CSS the app builds, no browser needed', async () => {
  const site = await testSite({ root, styles: true })
  const page = await site.visit('/')
  const css = await page.css()

  expect(page.find('link[rel~=stylesheet], style').length).toBeGreaterThan(0)
  expect(css).toContain('--color-used: #123456')
  // A theme variable only a built name reads is dropped by Tailwind, as in production.
  expect(css).not.toContain('--color-lane-0')
  await site.close()
}, 60_000)

it('a theme variable only a built name reads ships from @theme static', async () => {
  await Bun.write(`${root}/src/app.css`, '@import "tailwindcss" source("..");\n@theme static {\n  --color-used: #123456;\n  --color-lane-0: #654321;\n}\n')

  const site = await testSite({ root, styles: true })

  expect(await (await site.visit('/')).css()).toContain('--color-lane-0: #654321')
  await site.close()
}, 60_000)

it('css() skips a stylesheet of another site', async () => {
  await Bun.write(`${root}/src/routes/_layout.kay`, `---\nimport '../app.css'\n---\nhead\n  link(rel="stylesheet" href="https://fonts.example/x.css")\nslot\n`)

  const site = await testSite({ root, styles: true })

  expect(await (await site.visit('/')).css()).toContain('--color-used')
  await site.close()
}, 60_000)

it('css() of a site without styles says how to ask for it', async () => {
  const site = await testSite({ root })
  const page = await site.visit('/')

  expect(page.find('link[rel~=stylesheet]')).toEqual([])
  await expect(page.css()).rejects.toThrow('testSite({ styles: true })')
  await site.close()
}, 60_000)
