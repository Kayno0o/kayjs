import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { readClientSources } from '../src/build/client'
import { scratchDir } from './scratch'
import { pages, sharedClient } from './shared-pages'

const TSCONFIG = await Bun.file('tests/fixtures/island-action/tsconfig.json').text()
const CALLER = await Bun.file('tests/fixtures/island-action/src/components/caller.kay').text()

// An app whose one page hands an island the action `source` exports, the app's own files being `files`; `extern` is a package under node_modules, which the app's sources do not include.
async function app(files: Record<string, string>, extern?: string): Promise<string> {
  const dir = await scratchDir('action-outside-')

  await mkdir(join(dir, 'src/routes'), { recursive: true })
  await mkdir(join(dir, 'src/components'), { recursive: true })
  await Bun.write(join(dir, 'tsconfig.json'), TSCONFIG)
  await Bun.write(join(dir, 'src/components/caller.kay'), CALLER)

  if (extern !== undefined) {
    await mkdir(join(dir, 'node_modules/extern'), { recursive: true })
    await Bun.write(join(dir, 'node_modules/extern/package.json'), JSON.stringify({ name: 'extern', type: 'module', main: 'index.ts' }))
    await Bun.write(join(dir, 'node_modules/extern/index.ts'), extern)
  }

  for (const [file, text] of Object.entries(files))
    await Bun.write(join(dir, file), text)

  return dir
}

function PAGE(source: string): string {
  return `--- server
${source}
--- script
import Caller from '../components/caller.kay'
---
Caller(run={greet} label="Ann")
`
}

const OUTSIDE = `import { action } from 'kay'
import { t } from 'elysia'

export const greet = action(t.Object({ name: t.String() }), ({ name }) => \`Hello \${name}\`)
`

describe('an action the app does not declare in its own sources', () => {
  it('fails the page that hands it to an island in a production build, naming the cause, and not in development', async () => {
    const root = await app({
      'src/routes/index.kay': PAGE(`import { greet as outside } from 'extern'\nexport const greet = outside`),
      'src/routes/later.kay': `--- server
import { defer } from 'kay'
import { greet as outside } from 'extern'

export const shout = outside

const later = defer(Promise.resolve('Ann'))
--- script
import Caller from '../components/caller.kay'
---
await later then value
  Caller(run={shout} label={value})
`,
    }, OUTSIDE)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const built = await pages({ root, prebuilt: false, security: false })
      const developed = await pages({ root, dev: true, security: false })
      const refused = await built.handle(new Request('http://localhost/'))
      const streamed = await (await built.handle(new Request('http://localhost/later'))).text()

      expect(refused.status).toBe(500)
      expect((await sharedClient(root, {})).actionless).toBe(true)
      expect(streamed).not.toContain('Action')
      expect(logged.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([expect.stringContaining('this build carries no code to revive one')]))
      expect(logged.mock.calls.filter(call => String(call[0]).includes('this build carries no code to revive one'))).toHaveLength(2)
      expect((await developed.handle(new Request('http://localhost/'))).status).toBe(200)
      expect((await (await developed.handle(new Request('http://localhost/later'))).text())).toContain('Action')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('counts an action created under another name as one the app declares', async () => {
    const root = await app({
      'src/routes/index.kay': PAGE(`import { greet as inner } from '../actions'\nexport const greet = inner`),
      'src/actions.ts': `import { action as act } from 'kay'
import { t } from 'elysia'

export const greet = act(t.Object({ name: t.String() }), ({ name }) => \`Hello \${name}\`)
`,
    })

    expect((await readClientSources(root)).actionProps).toBe(true)
  })

  it('leaves the manifest of a build with an action in the app\'s own sources without the flag', async () => {
    const root = await app({ 'src/routes/index.kay': PAGE(`import { t } from 'elysia'\nimport { action } from 'kay'\nexport const greet = action(t.Object({ name: t.String() }), ({ name }) => name)`) })
    const built = await sharedClient(root, {})

    expect(built.actionless).toBeUndefined()
  })

  it('still builds no reviver for an app with no action', async () => {
    const root = await app({ 'src/routes/index.kay': '--- script\nimport Caller from \'../components/caller.kay\'\n---\np Hi\n' })

    expect((await readClientSources(root)).actionProps).toBe(false)
  })

  it('counts action<T>(), a re-export of action and a barrel over kay as ones the app declares', async () => {
    for (const code of [
      `import { action } from 'kay'\nexport const save = action<{ name: string }>(schema, run)`,
      `export { action } from 'kay'`,
      `export { action as act } from 'kay'`,
      `export * from 'kay'`,
      `import * as k from 'kay'\nexport const save = k.action(schema, run)`,
    ]) {
      const root = await app({ 'src/routes/index.kay': PAGE(`import { greet as inner } from '../actions'\nexport const greet = inner`), 'src/actions.ts': code })

      expect([code, (await readClientSources(root)).actionProps]).toEqual([code, true])
    }
  })

  it('counts action read as a value, in a module of the app or in a template expression, as one the app declares', async () => {
    for (const code of [
      `import { action } from 'kay'\nconst a = action\nexport const save = a(schema, run)`,
      `import action from 'kay'\nexport default action`,
      `import * as kay from 'kay'\nexport const { action } = kay`,
      `import * as kay from 'kay'\nconst { action } = kay\nexport const save = action(schema, run)`,
      `import * as k from 'kay'\nconst a = k.action\nexport const save = a(schema, run)`,
      `import { action } from 'kay'\nexport const make = [action]`,
      `import { action } from 'kay'\nexport const make = { action }`,
      `import { action } from 'kay'\nexport const make = { run: action }`,
      `import { action as act } from 'kay'\nconst a = act\nexport const save = a(schema, run)`,
    ]) {
      const root = await app({ 'src/routes/index.kay': PAGE(`import { greet as inner } from '../actions'\nexport const greet = inner`), 'src/actions.ts': code })

      expect([code, (await readClientSources(root)).actionProps]).toEqual([code, true])
    }

    for (const template of [
      'p {action(schema, run)}',
      'p(title={action(schema, run) ? "a" : "b"}) Hi',
      'if action(schema, run)\n  p Yes',
      'for item of [action(schema, run)]\n  p {item}',
      'const a = action\np {a}',
      'p {k.action}',
      'p(title={action}) Hi',
    ]) {
      const root = await app({ 'src/routes/index.kay': `--- script\nimport Caller from '../components/caller.kay'\nimport * as k from 'kay'\n---\n${template}\n` })

      expect([template, (await readClientSources(root)).actionProps]).toEqual([template, true])
    }
  })

  it('does not count a text, a member of another object or a binding named action', async () => {
    for (const code of [
      `export const a = event.action`,
      `export const a = { action: 1 }`,
      `export const a = (reaction) => reaction`,
      `export function action() {}`,
      `export const a = 'action'`,
      `// action\nexport const a = 1`,
    ]) {
      const root = await app({ 'src/routes/index.kay': '--- script\nimport Caller from \'../components/caller.kay\'\n---\np action\n', 'src/actions.ts': code })

      expect([code, (await readClientSources(root)).actionProps]).toEqual([code, false])
    }

    const root = await app({ 'src/routes/index.kay': '--- script\nimport Caller from \'../components/caller.kay\'\nconst form = { action: 1 }\n---\nform(action="/x")\n  p {form.action} action(x) "action"\n' })

    expect((await readClientSources(root)).actionProps).toBe(false)
  })

  it('does not count a comment, a string or another function holding action( as an action', async () => {
    for (const code of [`// action(schema, run)\nexport const a = 1`, `export const a = 'action(x)'`, `export const a = reaction(1)`, `export * from './other'`]) {
      const root = await app({ 'src/routes/index.kay': '--- script\nimport Caller from \'../components/caller.kay\'\n---\np action(x)\n', 'src/actions.ts': code })

      expect([code, (await readClientSources(root)).actionProps]).toEqual([code, false])
    }
  })

  it('logs the action a streamed iterable cannot revive once per stream, however many parts hand it on', async () => {
    const root = await app({
      'src/routes/parts.kay': `--- server
import { greet as outside } from 'extern'

export const shout = outside

async function* names() {
  for (const name of ['Ann', 'Bob', 'Cara']) {
    await Bun.sleep(120)
    yield name
  }
}

const later = names()
--- script
import Caller from '../components/caller.kay'
---
await later then value
  Caller(run={shout} label={value})
`,
    }, OUTSIDE)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const built = await pages({ root, prebuilt: false, security: false })
      const streamed = await (await built.handle(new Request('http://localhost/parts'))).text()

      expect(streamed).not.toContain('Action')
      expect(logged.mock.calls.filter(call => String(call[0]).includes('this build carries no code to revive one'))).toHaveLength(1)
    }
    finally {
      logged.mockRestore()
    }
  })
})
