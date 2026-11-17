import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { check } from '../src/check'
import { applySafeFixes } from '../src/check/fixes'
import { handlerEventLint } from '../src/check/handler-events'
import { secretKeys } from '../src/check/secret-keys'
import { scratchDir } from './scratch'

setDefaultTimeout(120_000)

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'src/cli.ts')
const TSCONFIG = await Bun.file(join(import.meta.dir, 'fixtures/ui-list/tsconfig.json')).text()

const CONFIG = `import { ui } from '@kayjs/ui/extension'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [ui()], guards: { default: 'open' }, proxy: { key: { header: 'x-up', secret: 'k' } } })
`

const PAGE = `---
import { signal } from 'kay'
import Checkbox from '@kayjs/ui/checkbox.kay'
import FileDrop from '@kayjs/ui/file-drop.kay'
import Select from '@kayjs/ui/select.kay'
import Tabs from '@kayjs/ui/tabs.kay'
import Toggle from '@kayjs/ui/toggle.kay'

const query = signal('a')
const on = signal(false)

function toggle(next: boolean) {
  on = next
}

function setQuery(value: string) {
  query = value
}

function pick(files: File[]) {
  return files.length
}
---
Tabs(items={[{ value: 'a', label: 'A' }]} value={query()} label="t" onValueChange={setQuery})
Toggle(label="x" checked={on()} onChange={toggle})
Checkbox(label="x" checked={on()} onChange={toggle})
FileDrop(onFiles={pick})
Select(label="s" options={[{ value: 'a', label: 'A' }]} value={query()} onChange={setQuery})
`

const LOADER = `---
import { call, signal } from 'kay'
import notes from '../api/notes'
import { add } from '../routes/actions.kay'

const text = signal('')

async function load() {
  const list = await call(notes, '/')
  const { total } = await call(notes, '/')
  const created = await add({ title: 'x' })

  text = \`\${list.items.join(',')}\${total}\${created.id}\${(await call(notes, '/')).total}\`
}
---
button(onClick={load}) Load
p {text()}
`

const FILES: Record<string, string> = {
  'kay.config.ts': CONFIG,
  'tsconfig.json': TSCONFIG.replace('"include": ["src", ".kay/types"]', '"include": ["src", "tests", ".kay/types"]'),
  'package.json': '{ "name": "app", "dependencies": { "@kayjs/ui": "~1.104.0" } }\n',
  '.git': '',
  'src/api/notes.ts': 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => ({ items: [\'a\'], total: 1 }))\n',
  'src/routes/actions.kay': '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String() }), async ({ title }) => ({ id: 1, title }))\n---\nh1 x\n',
  'src/routes/index.kay': PAGE,
  'src/components/loader.kay': LOADER,
  'src/lib/total.ts': 'import { call } from \'kay\'\nimport notes from \'../api/notes\'\n\nexport async function total() {\n  const list = await call(notes, \'/\')\n\n  return list.total\n}\n',
  'src/mine.ts': 'import type { KayExtension } from \'kay/server\'\n\nexport const mine: KayExtension = { name: \'mine\', config: { favicon: \'src/favicon.png\', metrics: true } }\n',
  'tests/site.test.ts': 'import { testSite } from \'kay/test\'\n\nexport const site = await testSite({ mcpKey: \'m\', proxyKey: \'p\' })\n',
}

async function project(files: Record<string, string> = FILES): Promise<string> {
  const root = await scratchDir('typed-forms-')

  await mkdir(join(root, 'node_modules/@kayjs'), { recursive: true })
  await symlink(ROOT, join(root, 'node_modules/kay'))
  await symlink(join(ROOT, 'packages/ui'), join(root, 'node_modules/@kayjs/ui'))
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function upgrade(root: string): Promise<void> {
  const run = Bun.spawn(['bun', CLI, 'check', '--fix', '--since', '1.105'], { cwd: root, stdout: 'ignore', stderr: 'ignore' })

  await run.exited
}

const errors = async (root: string) => (await check(root)).filter(found => found.severity === 'error').map(found => `${found.file.split('/').slice(-2).join('/')}:${found.line} ${found.code} ${found.message}`)

describe('1.105 forms the type check finds', () => {
  it('names each old form with its lint before the fix', async () => {
    const root = await project()

    try {
      const found = await check(root)
      const codes = found.map(one => one.code)

      expect(codes.filter(code => code === 'deprecated-callback-handler')).toHaveLength(5)
      expect(codes.filter(code => code === 'deprecated-call-result')).toHaveLength(5)
      expect(codes).toContain('deprecated-secret-keys')
      expect(codes).toContain('deprecated-config-groups')
      expect(found.some(one => one.code?.startsWith('TS') && (/CallResult|not assignable/).test(one.message))).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('upgrades an app holding each old form, and kay check passes after', async () => {
    const root = await project()

    try {
      await upgrade(root)

      expect(await errors(root)).toEqual([])
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toContain('onChange={event => toggle(event.checked)}')
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toContain('onFiles={event => pick(event.files)}')
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toContain('onValueChange={event => setQuery(event.value)}')
      expect(await Bun.file(join(root, 'src/components/loader.kay')).text()).toContain('await add({ title: \'x\' }).orThrow()')
      expect(await Bun.file(join(root, 'src/lib/total.ts')).text()).toContain('call(notes, \'/\').orThrow()')
      expect(await Bun.file(join(root, 'tests/site.test.ts')).text()).toContain('mcp: { token: \'m\' }')
      expect(await Bun.file(join(root, 'tests/site.test.ts')).text()).toContain('proxy: { key: { header: \'x-up\', secret: \'p\' } }')

      const extension = await Bun.file(join(root, 'src/mine.ts')).text()

      expect(extension).toContain('assets: { favicon: \'src/favicon.png\' }')
      expect(extension).toContain('ops: { metrics: true }')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers the fix of a handler taking an object, and reports an arrow function with none', async () => {
    const root = await project({
      ...FILES,
      'src/routes/index.kay': PAGE.replace('function pick', 'function after(state: { count: number }) {\n  on = state.count > 0\n}\n\nfunction pick').replace('Toggle(label="x" checked={on()} onChange={toggle})', 'Toggle(label="x" checked={on()} onChange={after})\nToggle(label="y" checked={on()} onChange={(next: boolean) => toggle(next)})'),
    })

    try {
      const found = (await check(root)).filter(one => one.code === 'deprecated-callback-handler' && one.file.endsWith('index.kay'))
      const unsafe = found.filter(one => one.fixes?.every(fix => !fix.safe))
      const none = found.filter(one => one.fixes === undefined)

      expect(unsafe).toHaveLength(1)
      expect(none).toHaveLength(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a handler already in the new form alone', async () => {
    const root = await project({
      ...FILES,
      'src/routes/index.kay': PAGE.replaceAll('onChange={toggle}', 'onChange={event => toggle(event.checked)}').replace('onValueChange={setQuery}', 'onValueChange={event => setQuery(event.value)}').replace('onFiles={pick}', 'onFiles={event => pick(event.files)}').replace('onChange={setQuery}', 'onChange={event => setQuery(event.value)}'),
    })

    try {
      expect((await check(root)).filter(one => one.code === 'deprecated-callback-handler')).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the type error of a component that is no library\'s', async () => {
    const root = await project({
      ...FILES,
      'src/components/pick.kay': '---\nconst { onPick } = props<{ onPick: (event: { value: string }) => unknown }>()\n---\nbutton(onClick={() => onPick({ value: \'a\' })}) x\n',
      'src/routes/index.kay': '---\nimport Pick from \'../components/pick.kay\'\n\nfunction take(value: string) {\n  return value\n}\n---\nPick(onPick={take})\n',
    })

    try {
      const found = (await check(root)).filter(one => one.file.endsWith('index.kay'))

      expect(found.filter(one => one.code === 'deprecated-callback-handler')).toEqual([])
      expect(found.some(one => one.code?.startsWith('TS'))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wraps a member handler, a signal\'s set, with the field it took', async () => {
    const root = await project({
      ...FILES,
      'src/routes/index.kay': '---\nimport { signal } from \'kay\'\nimport Tabs from \'@kayjs/ui/tabs.kay\'\n\nconst query = signal(\'a\')\n---\nTabs(\n  items={[{ value: \'a\', label: \'A\' }]}\n  value={query()}\n  label="t"\n  onValueChange={query.set}\n)\n',
    })

    try {
      const found = (await check(root)).filter(one => one.code === 'deprecated-callback-handler')

      expect(found).toHaveLength(1)
      expect(found[0]?.fixes?.[0]?.edits[0]?.text).toBe('event => query.set(event.value)')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers, and does not apply, a fix of a result whose ok is read', async () => {
    const root = await project({
      ...FILES,
      'src/lib/total.ts': 'import { call } from \'kay\'\nimport notes from \'../api/notes\'\n\nexport async function total() {\n  const list = await call(notes, \'/\')\n\n  if (!list.ok)\n    return 0\n\n  return list.total\n}\n',
    })

    try {
      const found = (await check(root)).filter(one => one.file.endsWith('total.ts'))

      const reported = found.filter(one => one.code === 'deprecated-call-result')

      expect(reported).toHaveLength(1)
      expect(reported[0]?.fixes?.every(fix => !fix.safe)).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  const IMPORTS = 'import { call } from \'kay\'\nimport notes from \'../api/notes\'\n\n'
  const unsafeReads: Record<string, string> = {
    'a destructure of the result': 'export async function total() {\n  const list = await call(notes, \'/\')\n  const { ok } = list\n\n  return ok ? list.total : 0\n}\n',
    'a data read of the result': 'export async function total() {\n  const list = await call(notes, \'/\')\n  const { data } = list\n\n  return [data, list.total]\n}\n',
    'a computed key': 'export async function total() {\n  const list = await call(notes, \'/\')\n  const key = \'ok\'\n\n  return [list[\'ok\'], list[key], list.total]\n}\n',
    'the result handed on': 'function show(value: unknown) {\n  return value\n}\n\nexport async function total() {\n  const list = await call(notes, \'/\')\n\n  show(list)\n\n  return list.total\n}\n',
    'a name declared twice': 'export async function total() {\n  const list = await call(notes, \'/\')\n\n  return list.total\n}\n\nexport async function other() {\n  const list = { total: 2 }\n\n  return list.total\n}\n',
  }

  for (const [label, body] of Object.entries(unsafeReads)) {
    it(`offers and does not apply a fix beside ${label}`, async () => {
      const root = await project({ ...FILES, 'src/lib/total.ts': IMPORTS + body })

      try {
        const reported = (await check(root)).filter(one => one.file.endsWith('total.ts') && one.code === 'deprecated-call-result')

        expect(reported.length).toBeGreaterThan(0)
        expect(reported.every(one => one.fixes?.every(fix => !fix.safe))).toBe(true)
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('reaches the config of an extension with the other config lints', async () => {
    const root = await scratchDir('typed-forms-')

    try {
      await Bun.write(join(root, 'src/mine.ts'), 'import type { KayExtension } from \'kay/server\'\n\nexport const mine: KayExtension = { name: \'mine\', config: { mcp: { key: true } } }\n')

      const found = await secretKeys(root, {})

      expect(found).toHaveLength(1)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/mine.ts')).text()).toContain('mcp: { token: true }')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  describe('which handlers take an object', () => {
    const SOURCE = 'import Toggle from \'@kayjs/ui/toggle.kay\'\n---\nToggle(onChange={after})'
    const at = SOURCE.indexOf('onChange')
    const lint = (handler: string) => handlerEventLint(`Type '${handler}' is not assignable to type '(event: { checked: boolean; }) => unknown'.\n  Types of parameters 'x' and 'event' are incompatible.\n    Type '{ checked: boolean; }' is not assignable to type 'boolean'.`, SOURCE, { start: at, end: at + 8 })

    it('reads the type of the parameter, not the first colon', () => {
      expect(lint('({ value: v }: Props) => void')?.fixes?.[0]?.safe).toBe(false)
      expect(lint('(next: boolean) => void')?.fixes?.[0]?.safe).toBe(true)
    })

    it('takes object and Record types as objects', () => {
      expect(lint('(state: object) => void')?.fixes?.[0]?.safe).toBe(false)
      expect(lint('(state: Record<string, boolean>) => void')?.fixes?.[0]?.safe).toBe(false)
      expect(lint('(files: File[]) => void')?.fixes?.[0]?.safe).toBe(true)
    })
  })
})
