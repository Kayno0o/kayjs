import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { applyPageHooks, assetFiles } from '../src/server/page-hook'

const scratch = await mkdtemp(join(tmpdir(), 'kay-page-hook-'))
const clientDir = join(scratch, '.kay/client/dist')
const publicDir = join(scratch, 'public')

await Promise.all([
  Bun.write(join(clientDir, 'page-1a2b.css'), 'p{}'),
  Bun.write(join(clientDir, 'images/hero-640w.webp'), 'webp'),
  Bun.write(join(scratch, '.kay/client/favicon/icon-192.png'), 'png'),
  Bun.write(join(publicDir, 'post script.js'), 'console.log(1)'),
  Bun.write(join(scratch, 'secret.txt'), 'outside'),
])

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('page hooks', () => {
  it('finds the file behind each root-relative URL a page links, under the base', async () => {
    const file = assetFiles({ clientDir, publicDir, base: '/repo' })

    expect(await file('/repo/_kay/page-1a2b.css')).toBe(join(clientDir, 'page-1a2b.css'))
    expect(await file('/repo/_kay/images/hero-640w.webp')).toBe(join(clientDir, 'images/hero-640w.webp'))
    expect(await file('/repo/icon-192.png')).toBe(join(scratch, '.kay/client/favicon/icon-192.png'))
    expect(await file('/repo/post%20script.js?v=1')).toBe(join(publicDir, 'post script.js'))
  })

  it('finds no file for another site, a URL outside the base or the directories, or one nothing wrote', async () => {
    const file = assetFiles({ clientDir, publicDir, base: '/repo' })

    for (const url of ['https://cdn.example/a.js', '//cdn.example/a.js', 'a.js', '/_kay/page-1a2b.css', '/repo/_kay/../../../secret.txt', '/repo/%2e%2e/secret.txt', '/repo/_kay/missing.js'])
      expect(await file(url)).toBeUndefined()
  })

  it('hands each hook the HTML the one before it returned', async () => {
    const file = assetFiles({ clientDir, publicDir, base: '' })
    const html = await applyPageHooks([
      ({ html }) => html.replace('</body>', '<footer>one</footer></body>'),
      async ({ path, html }) => html.replace('one', `${path} two`),
    ], '/about', '<body></body>', file)

    expect(html).toBe('<body><footer>/about two</footer></body>')
  })
})
