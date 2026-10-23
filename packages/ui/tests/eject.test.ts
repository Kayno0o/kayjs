import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { kay } from '../../../src/build/plugin'
import { createProject, PRESETS } from '../../../src/new'
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

    const manifest = JSON.parse(await readFile(join(root, UI_DIR, '.upstream/ejected.json'), 'utf8')) as Record<string, { version: string, files: string[], helpers: Record<string, string> }>
    const { version } = JSON.parse(await readFile(join(LIBRARY, 'package.json'), 'utf8')) as { version: string }

    expect(manifest['card.kay']).toEqual({ version, files: ['card.kay'], helpers: {} })
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
    expect(await readFile(join(root, 'src/page.kay'), 'utf8')).toBe(PAGE)
  })

  test('turns a name key of src/ui.ts into the library\'s path key plus the copy\'s', async () => {
    await writeFile(join(root, 'src/ui.ts'), 'export default {\n  \'Card\': { parts: { head: "b" } },\n}\n')

    await run(eject, ['card'])

    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toBe('export default {\n  \'@kaynooo/kayjs-ui/card.kay\': { parts: { head: "b" } },\n  \'./components/ui/card.kay\': { parts: { head: "b" } },\n}\n')
  })

  test('reads an entry of src/ui.ts with comments and braces in strings', async () => {
    await writeFile(join(root, 'src/ui.ts'), 'export default {\n  \'@kaynooo/kayjs-ui/card.kay\': {\n    // the card\'s look }\n    parts: { root: \'a [&>*]:{b} \' }, /* } */\n  },\n}\n')

    const { out } = await run(eject, ['card'])
    const text = await readFile(join(root, 'src/ui.ts'), 'utf8')

    expect(out).not.toContain('could not be read')
    expect(text).toContain('\n  },\n  \'./components/ui/card.kay\': {\n    // the card\'s look }')
    expect(text.endsWith('/* } */\n  },\n}\n')).toBe(true)
    expect(text.match(/components\/ui\/card\.kay/g)).toHaveLength(1)
  })

  test('finds a key written with double quotes, and ignores a path in a comment or a string', async () => {
    await writeFile(join(root, 'src/ui.ts'), 'export default {\n  // "@kaynooo/kayjs-ui/card.kay": { was: "here" },\n  "@kaynooo/kayjs-ui/card.kay": { parts: { root: \'a\' } },\n  "Other": { parts: "\'./components/ui/card.kay\'" },\n}\n')

    const { out } = await run(eject, ['card'])
    const text = await readFile(join(root, 'src/ui.ts'), 'utf8')

    expect(out).not.toContain('could not be read')
    expect(text).toContain('  "@kaynooo/kayjs-ui/card.kay": { parts: { root: \'a\' } },\n  \'./components/ui/card.kay\': { parts: { root: \'a\' } },\n  "Other"')
  })

  test('leaves src/ui.ts alone when the copy already has its key, or when only a comment names the component', async () => {
    const already = 'export default {\n  "./components/ui/card.kay": { parts: { root: \'b\' } },\n  \'@kaynooo/kayjs-ui/card.kay\': { parts: { root: \'a\' } },\n}\n'

    await writeFile(join(root, 'src/ui.ts'), already)
    await run(eject, ['card'])
    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toBe(already)

    root = await freshApp()

    const commented = 'export default {\n  // Card: { parts: { root: \'a\' } },\n}\n'

    await writeFile(join(root, 'src/ui.ts'), commented)
    await run(eject, ['card'])
    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toBe(commented)
  })

  test('reads a parenthesised entry whole', async () => {
    await writeFile(join(root, 'src/ui.ts'), 'export default {\n  Card: ({ parts: { root: \'a\' } }),\n}\n')
    await run(eject, ['card'])
    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toBe('export default {\n  \'@kaynooo/kayjs-ui/card.kay\': ({ parts: { root: \'a\' } }),\n  \'./components/ui/card.kay\': ({ parts: { root: \'a\' } }),\n}\n')
  })

  test('reads an entry holding a regex with a brace and a template with nested braces', async () => {
    const entry = '{ parts: { root: `a ${`b ${1}`} }`, head: [/}/.source].join(\' \') } }'

    await writeFile(join(root, 'src/ui.ts'), `export default {\n  Card: ${entry},\n}\n`)

    const { out } = await run(eject, ['card'])

    expect(out).not.toContain('could not be read')
    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toBe(`export default {\n  '@kaynooo/kayjs-ui/card.kay': ${entry},\n  './components/ui/card.kay': ${entry},\n}\n`)
  })

  test('says so when an entry of src/ui.ts cannot be read', async () => {
    await writeFile(join(root, 'src/ui.ts'), 'export default {\n  \'@kaynooo/kayjs-ui/card.kay\': { parts: { root: \'a\' } /* \n}\n')

    expect((await run(eject, ['card'])).out).toContain('could not be read')
  })

  test('rewrites the imports of nested files, type imports and dynamic imports', async () => {
    await mkdir(join(root, 'src/pages/deep'), { recursive: true })
    await writeFile(join(root, 'src/pages/deep/x.ts'), 'import type Card from "@kaynooo/kayjs-ui/card.kay"\nconst load = () => import(\'@kaynooo/kayjs-ui/card.kay\')\nexport { Card, load }\n')

    await run(eject, ['card'])

    const text = await readFile(join(root, 'src/pages/deep/x.ts'), 'utf8')

    expect(text).toContain('from "../../components/ui/card.kay"')
    expect(text).toContain('import(\'../../components/ui/card.kay\')')
  })

  test('rewrites the imports of the app\'s tests and root files too', async () => {
    await mkdir(join(root, 'tests'), { recursive: true })
    await writeFile(join(root, 'tests/page.test.ts'), 'import Card from \'@kaynooo/kayjs-ui/card.kay\'\nexport { Card }\n')
    await writeFile(join(root, 'kay.config.ts'), 'import Card from \'@kaynooo/kayjs-ui/card.kay\'\nexport default { Card }\n')

    const { out } = await run(eject, ['card'])

    expect(await readFile(join(root, 'tests/page.test.ts'), 'utf8')).toContain('from \'../src/components/ui/card.kay\'')
    expect(await readFile(join(root, 'kay.config.ts'), 'utf8')).toContain('from \'./src/components/ui/card.kay\'')
    expect(out).toContain('tests/page.test.ts')
  })

  test('points a copy at the copy of a component ejected before it', async () => {
    await run(eject, ['icon'])
    await run(eject, ['button'])

    expect(await readFile(join(root, UI_DIR, 'button.kay'), 'utf8')).toContain('from \'./icon.kay\'')
  })

  test('points the earlier copy at a component ejected after it', async () => {
    await run(eject, ['button'])
    await run(eject, ['icon'])

    expect(await readFile(join(root, UI_DIR, 'button.kay'), 'utf8')).toContain('from \'./icon.kay\'')
  })

  test('finishes a run that stopped before it recorded the copy', async () => {
    await run(eject, ['card'])
    await rm(join(root, UI_DIR, '.upstream/ejected.json'))

    const { code } = await run(eject, ['card'])

    expect(code).toBe(0)
    expect((await readFile(join(root, 'src/ui.ts'), 'utf8')).match(/components\/ui\/card\.kay/g)).toHaveLength(1)
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

describe('a damaged record', () => {
  test('is a message naming the file, not a stack trace', async () => {
    await run(eject, ['card'])

    const manifest = join(root, UI_DIR, '.upstream/ejected.json')

    await writeFile(manifest, '{ nope')
    expect((await run(diff, [])).err).toContain(`${UI_DIR}/.upstream/ejected.json does not parse`)
    expect((await run(eject, ['button'])).code).toBe(1)

    await writeFile(manifest, '{"card.kay": {"version": 1}}')
    expect((await run(diff, [])).err).toContain('is not a record of ejected components')
  })

  test('names the base file that is missing, and --accept records it again', async () => {
    await run(eject, ['card'])
    await rm(join(root, UI_DIR, '.upstream/card.kay.base'))

    const shown = await run(diff, [])

    expect(shown.code).toBe(1)
    expect(shown.err).toContain(`${UI_DIR}/.upstream/card.kay.base is missing`)
    expect((await run(diff, ['card'], { accept: true })).code).toBe(0)
    expect((await run(diff, [], { check: true })).out).toContain('up to date')
  })
})

describe('the library helpers a copy imports', () => {
  async function edit(change: (entry: { helpers?: Record<string, string> }) => void): Promise<void> {
    const manifestPath = join(root, UI_DIR, '.upstream/ejected.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, { helpers?: Record<string, string> }>

    change(manifest['button.kay']!)
    await writeFile(manifestPath, JSON.stringify(manifest))
  }

  test('are recorded with a hash, and a change in one shows in the diff', async () => {
    await run(eject, ['button'])

    const manifest = JSON.parse(await readFile(join(root, UI_DIR, '.upstream/ejected.json'), 'utf8')) as Record<string, { helpers: Record<string, string> }>

    expect(Object.keys(manifest['button.kay']!.helpers)).toEqual(expect.arrayContaining(['defaults.ts', 'icon.kay']))
    expect((await run(diff, [], { check: true })).code).toBe(0)

    await edit((entry) => {
      entry.helpers!['defaults.ts'] = 'stale'
    })

    const shown = await run(diff, [], { check: true })

    expect(shown.code).toBe(1)
    expect(shown.out).toContain('Helpers the copy imports from kayjs-ui')
    expect(shown.out).toContain('defaults.ts changed in kayjs-ui')

    expect((await run(diff, ['button'], { accept: true })).code).toBe(0)
    expect((await run(diff, [], { check: true })).out).toContain('up to date')
  })

  test('are reported when the library dropped one', async () => {
    await run(eject, ['button'])
    await edit((entry) => {
      entry.helpers!['gone.ts'] = 'x'
    })

    expect((await run(diff, [])).out).toContain('gone.ts is gone from kayjs-ui')
  })

  test('are left out once the component itself is ejected', async () => {
    await run(eject, ['button'])
    await run(eject, ['icon'])
    await edit((entry) => {
      entry.helpers!['icon.kay'] = 'stale'
    })

    expect((await run(diff, [], { check: true })).code).toBe(0)
  })
})

describe('the command line', () => {
  test('ejects and diffs on a scaffolded app, and a kayjs-ui bump shows a diff', async () => {
    const app = join(await scratchDir('eject-cli-'), 'app')

    roots.push(join(app, '..'))
    await createProject(app, { kay: '^1.0.0', features: PRESETS.app.features })
    await writeFile(join(app, 'src/demo.ts'), 'export { default as Card } from \'@kaynooo/kayjs-ui/card.kay\'\n')
    await mkdir(join(app, 'tests'), { recursive: true })
    await writeFile(join(app, 'tests/demo.ts'), 'export { default as Card } from \'@kaynooo/kayjs-ui/card.kay\'\n')

    const kay = async (...args: string[]) => {
      const proc = Bun.spawn(['bun', join(LIBRARY, '../../src/cli.ts'), ...args], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

      return { out, err, code }
    }

    const ejected = await kay('ui', 'eject', 'card')

    expect(ejected.err).toBe('')
    expect(ejected.out).toContain('copied card.kay')
    expect(await readFile(join(app, 'src/demo.ts'), 'utf8')).toContain('./components/ui/card.kay')
    expect(await readFile(join(app, 'tests/demo.ts'), 'utf8')).toContain('../src/components/ui/card.kay')
    expect((await kay('ui', 'diff', '--check')).code).toBe(0)

    const base = join(app, UI_DIR, '.upstream/card.kay.base')

    await writeFile(base, (await readFile(base, 'utf8')).replace('level = 3', 'level = 2'))

    const bumped = await kay('ui', 'diff', '--check')

    expect(bumped.code).toBe(1)
    expect(bumped.out).toContain('+const { title, level = 3')

    await writeFile(base, (await readFile(base, 'utf8')).replace('level = 2', 'level = 3'))
    expect((await kay('ui', 'eject', 'button')).code).toBe(0)

    const manifestPath = join(app, UI_DIR, '.upstream/ejected.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, { version: string, helpers: Record<string, string> }>

    manifest['button.kay']!.version = '0.0.1'
    manifest['button.kay']!.helpers['defaults.ts'] = 'stale'
    await writeFile(manifestPath, JSON.stringify(manifest))

    const helper = await kay('ui', 'diff', 'button', '--check')

    expect(helper.code).toBe(1)
    expect(helper.out).toContain('between 0.0.1 and')
    expect(helper.out).toContain('defaults.ts changed in kayjs-ui')
  }, 60_000)
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

  test('compares only what lies between the common lines, so a long file with one change stays cheap', () => {
    const lines = Array.from({ length: 6000 }, (_, index) => `line ${index}`)
    const text = unifiedDiff(lines.join('\n'), lines.with(3000, 'other').join('\n'), 'x')

    expect(text).toContain('@@ -2998,7 +2998,7 @@')
    expect(text).toContain('-line 3000\n+other')
  })

  test('marks a change at the very start, the very end and a pure insertion', () => {
    expect(unifiedDiff('a\nb\nc', 'x\nb\nc', 'f')).toContain('-a\n+x\n b')
    expect(unifiedDiff('a\nb\nc', 'a\nb\nz', 'f')).toContain(' b\n-c\n+z')
    expect(unifiedDiff('a\nc', 'a\nb\nc', 'f')).toContain(' a\n+b\n c')
  })
})
