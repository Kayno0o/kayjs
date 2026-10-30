import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { readClientSources } from '../src/build/client'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

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
    const root = await app({ 'src/routes/index.kay': PAGE(`import { greet as outside } from 'extern'\nexport const greet = outside`) }, OUTSIDE)
    const built = await pages({ root, prebuilt: false, security: false })
    const developed = await pages({ root, dev: true, security: false })
    const refused = await built.handle(new Request('http://localhost/'))

    expect(refused.status).toBe(500)
    expect((await developed.handle(new Request('http://localhost/'))).status).toBe(200)
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

  it('still builds no reviver for an app with no action', async () => {
    const root = await app({ 'src/routes/index.kay': '--- script\nimport Caller from \'../components/caller.kay\'\n---\np Hi\n' })

    expect((await readClientSources(root)).actionProps).toBe(false)
  })
})
