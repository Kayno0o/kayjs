import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { kay } from '../../../src/build/plugin'
import { child } from '../../../src/runtime/html'
import { scratchDir } from '../../../tests/scratch'
import diff from '../src/diff-command'
import { unifiedDiff } from '../src/eject'
import eject from '../src/eject-command'
import { ui } from '../src/extension'

const LIBRARY = join(import.meta.dir, '..')
const MARKERS = /<!--[[\]]-->/g
const UI_DIR = 'src/components/ui'

const PAGE = `---
import Button from '@kaynooo/kayjs-ui/button.kay'
import Card from '@kaynooo/kayjs-ui/card.kay'
---
Card(title="Hello")
  Button {"Go"}
`

let root = ''
const roots: string[] = []

// An app in its own folder, as it would be scaffolded: a page using two components, and a `src/ui.ts` restyling one by its specifier.
async function freshApp(): Promise<string> {
  const dir = await scratchDir('eject-')
  const link = join(dir, 'node_modules', '@kaynooo', 'kayjs-ui')

  await mkdir(dirname(link), { recursive: true })
  await mkdir(join(dir, 'node_modules/@iconify-json'), { recursive: true })
  await symlink(LIBRARY, link)
  await symlink(join(LIBRARY, '../../node_modules/@iconify-json/tabler'), join(dir, 'node_modules/@iconify-json/tabler'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'eject-app', private: true, dependencies: { '@iconify-json/tabler': '*', '@kaynooo/kayjs-ui': '*' } }))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/page.kay'), PAGE)
  await writeFile(join(dir, 'src/entry.ts'), 'export { default as Page } from \'./page.kay\'\n')
  await writeFile(join(dir, 'src/ui.ts'), 'import { defineUi } from \'kay\'\n\nexport default defineUi({\n  \'@kaynooo/kayjs-ui/card.kay\': { parts: { root: \'rounded-xl\' } },\n})\n')
  roots.push(dir)

  return dir
}

async function run(command: typeof eject, args: string[], flags: Record<string, boolean> = {}): Promise<{ code: number, out: string, err: string }> {
  const log = spyOn(console, 'log').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  const refused: string[] = []

  try {
    const code = await command.run({ values: flags, positionals: args }, (reason) => {
      refused.push(reason ?? '')

      return 1
    }, { root, config: {} })

    return { code, out: log.mock.calls.flat().join('\n'), err: [...error.mock.calls.flat(), ...refused].join('\n') }
  }
  finally {
    log.mockRestore()
    error.mockRestore()
  }
}

async function render(): Promise<string> {
  const build = await Bun.build({ entrypoints: [join(root, 'src/entry.ts')], outdir: join(root, 'out'), target: 'bun', plugins: [kay({ root, target: 'ssr' })] })

  if (!build.success)
    throw new AggregateError(build.logs, 'build failed')

  const { Page } = await import(`${build.outputs[0]!.path}?${Math.random()}`) as { Page: (props: Record<string, unknown>) => unknown }

  return child(Page({})).replace(MARKERS, '')
}

beforeEach(async () => {
  root = await freshApp()
})

afterAll(async () => {
  for (const dir of roots)
    await rm(dir, { recursive: true, force: true })
})

describe('kay ui eject', () => {
  test('is added by ui() as two commands', () => {
    const { commands } = ui()

    expect(Object.keys(commands!)).toEqual(['ui eject', 'ui diff'])
    expect(commands!['ui eject']).toBe(join(LIBRARY, 'src/eject-command.ts'))
  })

  test('copies the component, rewrites the app\'s imports and keeps the restyle of src/ui.ts for the copy and the library', async () => {
    const { code, out } = await run(eject, ['card'])

    expect(code).toBe(0)
    expect(out).toContain('copied card.kay')
    expect(existsSync(join(root, UI_DIR, 'card.kay'))).toBe(true)
    expect(await readFile(join(root, 'src/page.kay'), 'utf8')).toContain('import Card from \'./components/ui/card.kay\'')
    expect(await readFile(join(root, 'src/page.kay'), 'utf8')).toContain('@kaynooo/kayjs-ui/button.kay')
    const uiTs = await readFile(join(root, 'src/ui.ts'), 'utf8')

    expect(uiTs).toContain('\'@kaynooo/kayjs-ui/card.kay\': { parts: { root: \'rounded-xl\' } },\n  \'./components/ui/card.kay\': { parts: { root: \'rounded-xl\' } },')

    const html = await render()

    expect(html).toContain('kui-card')
    expect(html).toContain('rounded-xl')
  })

  test('records the version and the upstream text the copy came from', async () => {
    await run(eject, ['Card'])

    const manifest = JSON.parse(await readFile(join(root, UI_DIR, '.upstream/ejected.json'), 'utf8')) as Record<string, { version: string, files: string[] }>
    const { version } = JSON.parse(await readFile(join(LIBRARY, 'package.json'), 'utf8')) as { version: string }

    expect(manifest['card.kay']).toEqual({ version, files: ['card.kay'] })
    expect(await readFile(join(root, UI_DIR, '.upstream/card.kay.base'), 'utf8')).toBe(await readFile(join(LIBRARY, 'src/card.kay'), 'utf8'))
  })

  test('takes the helpers only the component uses and leaves the shared ones in the library', async () => {
    const { out } = await run(eject, ['button'])
    const copy = await readFile(join(root, UI_DIR, 'button.kay'), 'utf8')

    expect(out).toContain('button.kay, button-props.ts, internal/busy-button.kay')
    expect(out).toContain('still on kayjs-ui\'s button.kay: ')
    expect(copy).toContain('from \'./button-props\'')
    expect(copy).toContain('from \'@kaynooo/kayjs-ui/icon.kay\'')
    expect(copy).toContain('from \'@kaynooo/kayjs-ui/lib/defaults\'')
    expect(await readFile(join(root, UI_DIR, 'internal/busy-button.kay'), 'utf8')).toContain('@kaynooo/kayjs-ui/lib/')
    expect(await render()).toContain('kui-btn')
  })

  test('writes nothing for --dry-run', async () => {
    const { out } = await run(eject, ['card'], { 'dry-run': true })

    expect(out).toContain('would copy card.kay')
    expect(existsSync(join(root, UI_DIR))).toBe(false)
    expect(await readFile(join(root, 'src/page.kay'), 'utf8')).toBe(PAGE)
  })

  test('refuses an unknown component, an ejected one and a file in the way', async () => {
    expect((await run(eject, ['nope'])).err).toContain('has no component nope')
    expect((await run(eject, [])).code).toBe(1)

    await run(eject, ['card'])
    expect((await run(eject, ['card'])).err).toContain('ejected already')

    const other = await freshApp()

    root = other
    await mkdir(join(root, UI_DIR), { recursive: true })
    await writeFile(join(root, UI_DIR, 'card.kay'), 'mine')

    const refused = await run(eject, ['card'])

    expect(refused.err).toContain('card.kay exists already')
    expect(await readFile(join(root, UI_DIR, 'card.kay'), 'utf8')).toBe('mine')
    expect(relative(root, join(root, 'src/page.kay'))).toBe('src/page.kay')
    expect(await readFile(join(root, 'src/page.kay'), 'utf8')).toBe(PAGE)
  })

  test('tells a src/ui.ts that keys the component by name, which now names two', async () => {
    await writeFile(join(root, 'src/ui.ts'), 'export default {\n  Card: { parts: { head: "b" } },\n}\n')

    const { out } = await run(eject, ['card'])

    expect(out).toContain('src/ui.ts keys Card by name, which now names two components')
    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toContain('Card: {')
  })
})

describe('kay ui diff', () => {
  test('says an untouched copy is up to date', async () => {
    await run(eject, ['card'])

    const { code, out } = await run(diff, [], { check: true })

    expect(code).toBe(0)
    expect(out).toContain('card.kay: up to date')
  })

  test('says nothing is ejected, and refuses a component that is not', async () => {
    expect((await run(diff, [])).out).toContain('nothing ejected')
    expect((await run(diff, ['card'])).err).toContain('card is not ejected')
  })

  test('shows what the library changed since the recorded version, then follows the installed one on --accept', async () => {
    await run(eject, ['card'])

    const base = join(root, UI_DIR, '.upstream/card.kay.base')
    const manifestPath = join(root, UI_DIR, '.upstream/ejected.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, { version: string }>

    manifest['card.kay']!.version = '0.0.1'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(base, (await readFile(base, 'utf8')).replace('level = 3', 'level = 2'))

    const shown = await run(diff, ['card'], { check: true })

    expect(shown.code).toBe(1)
    expect(shown.out).toContain('between 0.0.1 and')
    expect(shown.out).toContain('-const { title, level = 2')
    expect(shown.out).toContain('+const { title, level = 3')
    expect(shown.out).toContain(`git merge-file ${UI_DIR}/card.kay`)

    expect((await run(diff, [], { accept: true })).err).toContain('--accept takes one component')
    expect((await run(diff, ['card'], { accept: true })).out).toContain('follows kayjs-ui')
    expect((await run(diff, ['card'], { check: true })).out).toContain('up to date')
  })
})

describe('unifiedDiff', () => {
  test('is empty for equal texts and marks changed lines with their context', () => {
    expect(unifiedDiff('a\nb', 'a\nb', 'x')).toBe('')

    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`)
    const changed = lines.with(10, 'other')
    const text = unifiedDiff(lines.join('\n'), changed.join('\n'), 'x')

    expect(text).toContain('@@ -8,7 +8,7 @@')
    expect(text).toContain('-line 10\n+other')
    expect(text).not.toContain('line 2')
  })
})
