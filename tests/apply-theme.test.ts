import type { KayExtension } from '../src/config'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { ui } from '../packages/ui/src/extension'
import { buildClient } from '../src/build/client'
import { scratchDir } from './scratch'

const LAYOUT = '---\nimport \'../app.css\'\n---\nslot\n'
const PAGE = 'p.card Card\n'
const REFERENCE = '@reference \'@kaynooo/kayjs-ui/theme.css\';'
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const roots: string[] = []

// An app styling `.card` by `@apply` of a kui utility; `head` is what its stylesheet starts with.
async function app(head: string, rule = '.card { @apply border border-kui-surface2 bg-kui-mantle text-kui-text; }'): Promise<string> {
  const root = await scratchDir('apply-theme-')

  roots.push(root)
  await Promise.all(Object.entries({
    'src/app.css': `@import 'tailwindcss' source("..");\n${head}\n${rule}\n`,
    'src/routes/_layout.kay': LAYOUT,
    'src/routes/index.kay': PAGE,
  }).map(async ([path, text]) => Bun.write(join(root, path), text)))

  return root
}

// Every stylesheet the build wrote, `hot` being the development build that links them whole; `ui()` is registered unless `extensions` says otherwise.
async function stylesheet(root: string, options: { hot: boolean, base?: string, extensions?: KayExtension[] }): Promise<string> {
  const client = await buildClient(root, { plugins: [tailwind], extensions: options.extensions ?? [ui()], hot: options.hot, ...options.base !== undefined && { base: options.base } })
  const files = await Array.fromAsync(new Bun.Glob('**/*.css').scan({ cwd: client.dir, absolute: true }))

  return (await Promise.all(files.map(async file => Bun.file(file).text()))).join('\n')
}

async function failure(root: string, extensions?: KayExtension[]): Promise<string> {
  try {
    await stylesheet(root, { hot: false, ...extensions && { extensions } })

    return ''
  }
  catch (error) {
    return error instanceof AggregateError ? error.errors.map(each => String((each as Error).message ?? each)).join('\n') : String(error)
  }
}

function mantleDeclarations(css: string): number {
  return css.split('--color-kui-mantle:').length - 1
}

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('@apply of a kui utility in the app\'s stylesheet with ui() alone', () => {
  for (const dev of [false, true]) {
    for (const base of ['', '/play']) {
      it(`builds with no @reference, ${dev ? 'dev' : 'production'}, base ${base || 'unset'}`, async () => {
        const css = await stylesheet(await app(''), { hot: dev, ...base === '' ? {} : { base } })

        expect(css).toMatch(/\.card\s*\{[^}]*border-color: var\(--color-kui-surface2[,)]/)
        expect(css).toMatch(/\.card\s*\{[^}]*background-color: var\(--color-kui-mantle[,)]/)
      }, 120_000)
    }
  }

  it('writes no theme rule twice, whether the app also writes the @reference', async () => {
    const alone = mantleDeclarations(await stylesheet(await app(''), { hot: false }))

    expect(alone).toBeGreaterThan(0)
    expect(mantleDeclarations(await stylesheet(await app(REFERENCE), { hot: false }))).toBe(alone)
  }, 120_000)

  it('takes the app\'s own @theme override of a kui colour', async () => {
    const css = await stylesheet(await app('@theme {\n  --color-kui-mantle: #123456;\n}'), { hot: false })

    expect(css).toContain('--color-kui-mantle: #123456')
    expect(css).toMatch(/\.card\s*\{[^}]*background-color: var\(--color-kui-mantle[,)]/)
  }, 120_000)

  it('refuses a utility the theme does not have, naming it', async () => {
    expect(await failure(await app('', '.card { @apply bg-kui-nonesuch; }'))).toContain('bg-kui-nonesuch')
  }, 120_000)

  it('keeps a relative url() of the app\'s stylesheet resolving beside it', async () => {
    const root = await app('', '.card { @apply bg-kui-mantle; background-image: url(./img/dot.png); }')

    await Bun.write(join(root, 'src/img/dot.png'), Buffer.from(PIXEL, 'base64'))

    expect(await stylesheet(root, { hot: false })).toMatch(/background-image: url\((?:"|')?(?:data:image\/png|[^)]*dot[^)]*\.png)/)
  }, 120_000)

  it('builds an @apply of a partial the app\'s stylesheet imports', async () => {
    const root = await app('@import \'./parts.css\';', '')

    await Bun.write(join(root, 'src/parts.css'), '.card { @apply bg-kui-mantle; }\n')

    expect(await stylesheet(root, { hot: false })).toMatch(/\.card\s*\{[^}]*background-color: var\(--color-kui-mantle[,)]/)
  }, 120_000)

  it('leaves an app without ui() to the reference it writes', async () => {
    expect(await failure(await app(''), [])).toContain('border-kui-surface2')
    expect(await failure(await app(REFERENCE), [])).toBe('')
  }, 120_000)
})
