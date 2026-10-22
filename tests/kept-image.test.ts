import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { IMAGE_EXPORTS, keptScan } from '../src/server/pure-page'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('kept-imports-')

  roots.push(root)
  await Promise.all(Object.entries({ 'kay.config.ts': CONFIG, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// Why the page at `src/routes/index.kay` is not kept, or undefined when it is.
async function stopOf(files: Record<string, string>, page = 'src/routes/index.kay'): Promise<string | undefined> {
  const root = await project(files)
  const { stop } = await keptScan({ file: join(root, page), layouts: [] }, undefined, root)

  return stop === undefined ? undefined : stop.why
}

const LOGO = 'export default \'/logo.webp\'\n'

async function built(root: string): Promise<string[]> {
  const { code, report, output } = await kayBuild([root, '--no-check'])

  if (code !== 0)
    throw new Error(`${report}${output}`)

  const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { pages: Record<string, unknown> }

  return Object.keys(manifest.pages).sort()
}

describe('a page importing kay/image', () => {
  it('classes every export of kay/image once', async () => {
    const exported = Object.keys(await import('../src/runtime/image.public')).sort()

    expect(Object.keys(IMAGE_EXPORTS).sort()).toEqual(exported)
  })

  it('is kept when it uses image, shareImage or shareCard, in the page, a component or a module, renamed or not', async () => {
    const files = {
      'src/logo.ts': LOGO,
      'src/routes/index.kay': '---\nimport { image } from \'kay/image\'\nimport logo from \'../logo\'\n---\nimg(src={logo} alt="" {...image(logo, { sizes: \'20rem\' })})\n',
      'src/routes/renamed.kay': '---\nimport { image as picture, type ImageProps } from \'kay/image\'\nimport logo from \'../logo\'\n---\nimg(alt="" {...picture(logo)})\n',
      'src/routes/component.kay': '---\nimport Logo from \'../logo-img.kay\'\n---\nLogo\n',
      'src/logo-img.kay': '---\nimport { image } from \'kay/image\'\nimport logo from \'./logo\'\n---\nimg(alt="" {...image(logo, { sizes: \'20rem\' })})\n',
      'src/routes/module.kay': '---\nimport { props } from \'../props\'\n---\nimg(alt="" {...props})\n',
      'src/props.ts': 'import { image } from \'kay/image\'\nimport logo from \'./logo\'\n\nexport const props = image(logo)\n',
      'src/routes/share.kay': '--- server\nimport { shareCard, shareImage } from \'kay/image\'\nimport logo from \'../logo\'\n---\nmeta(property="og:image" content={shareImage(logo)})\nmeta(property="og:image" content={shareCard({ title: \'A\', image: logo })})\n',
    }

    for (const page of ['index', 'renamed', 'component', 'module', 'share'])
      expect(await stopOf(files, `src/routes/${page}.kay`)).toBeUndefined()
  })

  it('stops at an export kay does not class as free, the whole module, and an image taken from the request', async () => {
    const files = {
      'src/logo.ts': LOGO,
      'src/routes/unknown.kay': '---\nimport { somethingNew } from \'kay/image\'\n---\np Hi\n',
      'src/routes/whole.kay': '---\nimport * as images from \'kay/image\'\nimport logo from \'../logo\'\n---\nimg(alt="" {...images.image(logo)})\n',
      'src/routes/internal.kay': '---\nimport { setMaxDensity } from \'kay/image\'\n---\np Hi\n',
      'src/routes/beside.kay': '---\nimport { image } from \'kay/image\'\nimport { dayjs } from \'dayjs\'\n---\np Hi\n',
      'src/routes/request.kay': '---\nimport { image } from \'kay/image\'\n---\nimg(alt="" {...image(ctx.url.searchParams.get(\'src\') ?? \'\')})\n',
      'src/routes/clock.kay': '---\nimport { shareCard } from \'kay/image\'\n---\nmeta(content={shareCard({ title: new Date().toISOString() })})\n',
    }

    expect(await stopOf(files, 'src/routes/unknown.kay')).toContain('imports `somethingNew` from `kay/image`')
    expect(await stopOf(files, 'src/routes/whole.kay')).toContain('imports the whole module from `kay/image`')
    expect(await stopOf(files, 'src/routes/internal.kay')).toContain('imports `setMaxDensity` from `kay/image`')
    expect(await stopOf(files, 'src/routes/beside.kay')).toBe('imports the package `dayjs`')
    expect(await stopOf(files, 'src/routes/request.kay')).toBe('reads `ctx`')
    expect(await stopOf(files, 'src/routes/clock.kay')).toBe('reads `Date`')
  })

  it('prerenders a page spreading image() and renders its variants', async () => {
    const root = await project({
      'src/routes/index.kay': '---\nimport { image } from \'kay/image\'\nimport logo from \'../logo.png\'\n---\nimg(alt="Logo" {...image(logo, { sizes: \'20rem\' })})\n',
    })

    await Bun.write(join(root, 'src/logo.png'), Bun.file(join(import.meta.dir, 'fixtures/static/src/hero.png')))
    expect(await built(root)).toEqual(['/'])

    const html = await Bun.file(join(outputDir(root), 'pages', 'index.html')).text()

    expect(html).toContain('srcset=')
  }, 60_000)
})
