import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { scratchDir } from './scratch'

const LAYOUT = '---\nimport \'../app.css\'\n---\nslot\n'
const PAGE = 'p.card Card\n'
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

// Every stylesheet the build wrote, `hot` being the development build that links them whole.
async function stylesheet(root: string, options: { hot: boolean, base?: string }): Promise<string> {
  const client = await buildClient(root, { plugins: [tailwind], hot: options.hot, ...options.base !== undefined && { base: options.base } })
  const files = await Array.fromAsync(new Bun.Glob('**/*.css').scan({ cwd: client.dir, absolute: true }))

  return (await Promise.all(files.map(async file => Bun.file(file).text()))).join('\n')
}

async function failure(root: string): Promise<string> {
  try {
    await stylesheet(root, { hot: false })

    return ''
  }
  catch (error) {
    return error instanceof AggregateError ? error.errors.map(each => String((each as Error).message ?? each)).join('\n') : String(error)
  }
}

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('@apply of a kui utility in the app\'s stylesheet', () => {
  for (const dev of [false, true]) {
    for (const base of ['', '/play']) {
      it(`builds with the theme referenced, ${dev ? 'dev' : 'production'}, base ${base || 'unset'}`, async () => {
        const css = await stylesheet(await app('@reference \'@kaynooo/kayjs-ui/theme.css\';'), { hot: dev, ...base === '' ? {} : { base } })

        expect(css).toMatch(/\.card\s*\{[^}]*border-color: var\(--color-kui-surface2[,)]/)
        expect(css).toMatch(/\.card\s*\{[^}]*background-color: var\(--color-kui-mantle[,)]/)
      }, 120_000)
    }
  }

  it('takes the app\'s own @theme override of a kui colour', async () => {
    const css = await stylesheet(await app('@reference \'@kaynooo/kayjs-ui/theme.css\';\n@theme {\n  --color-kui-mantle: #123456;\n}'), { hot: false })

    expect(css).toContain('--color-kui-mantle: #123456')
    expect(css).toMatch(/\.card\s*\{[^}]*background-color: var\(--color-kui-mantle[,)]/)
  }, 120_000)

  it('refuses a utility the theme does not have, naming it', async () => {
    expect(await failure(await app('@reference "@kaynooo/kayjs-ui/theme.css";', '.card { @apply bg-kui-nonesuch; }'))).toContain('bg-kui-nonesuch')
  }, 120_000)

  it('refuses a kui utility without the reference, as the theme is the shell\'s stylesheet and not the app\'s', async () => {
    expect(await failure(await app(''))).toContain('border-kui-surface2')
  }, 120_000)
})
