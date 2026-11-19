import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { dynamicImageLints, scanIslandImages } from '../src/build/island-images'
import { remoteVariantName } from '../src/runtime/image'
import { kayBuildSpawned } from './check-helper'
import { fixtureCopy, scratchDir } from './scratch'

const COVER = join(import.meta.dir, 'fixtures/static-island-image/src/cover.png')

// The island of a remote image drawn in the browser alone, its URL a literal.
function remoteIsland(url: string): string {
  return `---\nisland({ render: 'client' })\nimport { image } from 'kay/image'\n---\nimg.remote({...image(${JSON.stringify(url)}, { width: 1000, height: 600, sizes: '50vw' })} alt="Remote")\n`
}

async function exportWith(origin: string, island: string, images = ''): Promise<{ code: number, output: string, outdir: string }> {
  const root = await fixtureCopy('static-island-image')
  const outdir = await scratchDir('static-remote-')

  await Bun.write(join(root, 'src/components/remote.kay'), island)
  await Bun.write(join(root, 'src/routes/index.kay'), `---\nimport Remote from '../components/remote.kay'\n---\nRemote\n`)
  await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ site: 'https://x.example', assets: { images: { remote: { hosts: [${JSON.stringify(origin)}]${images} } } } })\n`)

  const built = await kayBuildSpawned([root, '--no-check', '--static', '--outdir', outdir], { NODE_ENV: 'production' })

  return { code: built.code, output: built.output, outdir }
}

describe('the remote images of islands on a static export', () => {
  let origin: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    origin = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const { pathname } = new URL(request.url)

        if (pathname === '/cover.png')
          return new Response(Bun.file(COVER), { headers: { 'content-type': 'image/png' } })

        if (pathname === '/slow.png') {
          await Bun.sleep(5000)

          return new Response(Bun.file(COVER))
        }

        return new Response('Not found', { status: 404 })
      },
    })
  })

  afterAll(async () => {
    await origin?.stop(true)
  })

  it('writes the files of a literal URL given its size, and the browser knows to link them', async () => {
    const url = `${origin.url.origin}/cover.png`
    const built = await exportWith(origin.url.origin, remoteIsland(url))

    expect(built.code, built.output).toBe(0)

    const files = await readdir(join(built.outdir, '_kay/images'))

    for (const width of [320, 640, 960, 1000])
      expect(files, String(width)).toContain(remoteVariantName(url, { width }))

    const scripts = (await readdir(join(built.outdir, '_kay'))).filter(name => name.endsWith('.js'))
    const code = (await Promise.all(scripts.map(async name => Bun.file(join(built.outdir, '_kay', name)).text()))).join('\n')

    expect(code).toContain(JSON.stringify(url).slice(1, -1))
    expect(existsSync(join(built.outdir, '_kay/images'))).toBe(true)
  }, 120_000)

  it('fails the build naming the URL when the host does not answer in time', async () => {
    const url = `${origin.url.origin}/slow.png`
    const built = await exportWith(origin.url.origin, remoteIsland(url), ', timeout: \'1s\'')

    expect(built.code).not.toBe(0)
    expect(built.output).toContain(url)
  }, 120_000)
})

describe('scanIslandImages', () => {
  it('reads the crop, quality and sizes of an imported image, in a template or in an image() call, and the sources it cannot read', async () => {
    const dir = await scratchDir('island-images-')
    const file = join(dir, 'island.kay')

    await Bun.write(join(dir, 'a.png'), Bun.file(COVER))
    await Bun.write(file, [
      '---',
      'island({ render: \'client\' })',
      'import { image } from \'kay/image\'',
      'import cover from \'./a.png\'',
      'const { post } = defineProps<{ post: { cover: string } }>()',
      'const props = image(cover, { aspect: \'1/1\', quality: 90 })',
      '---',
      'img(src={cover} sizes="95px" alt="")',
      'img(src={cover} alt="")',
      'img({...image(post.cover, { width: 800, height: 600 })} alt="")',
      'img({...image(\'https://cms.example/a.jpg\', { width: 800, height: 600, aspect: \'16/9\' })} alt="")',
      '',
    ].join('\n'))

    const found = scanIslandImages([file])

    expect(found.imported).toEqual([
      { file: join(dir, 'a.png'), options: { sizes: '95px' } },
      { file: join(dir, 'a.png'), options: { aspect: '1/1', quality: 90 } },
    ])
    expect(found.remote).toEqual([{ src: 'https://cms.example/a.jpg', options: { width: 800, height: 600, aspect: '16/9' } }])
    expect(found.dynamic).toHaveLength(1)
    expect(dynamicImageLints(found, 'warn')[0]).toMatchObject({ code: 'static-remote-image', severity: 'warning', file, line: 10 })
  })
})
