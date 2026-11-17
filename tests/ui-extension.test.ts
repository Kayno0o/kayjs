import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { setUiLayers, uiEntryOf, uiFilesOf, uiPathsOf } from '../src/build/ui'
import { uiProblems } from '../src/check/ui'
import { scratchDir } from './scratch'

const CARD = 'section\n  header(part="head") a\n  div(part="body") b\n'

let root: string
let card: string

async function write(path: string, text: string): Promise<void> {
  await Bun.write(join(root, path), text)
}

beforeAll(async () => {
  root = await scratchDir('ui-extension-')
  card = join(root, 'src/panel.kay')
  await write('src/panel.kay', CARD)
  await write('ext/one.ts', `import { defineUi } from 'kay'\nexport default defineUi({ Panel: { parts: { head: 'one-head', body: 'one-body' }, variants: { tone: { brand: { root: 'one-brand' }, quiet: 'one-quiet' } } }, Missing: { parts: 'x' } })\n`)
  await write('ext/two.ts', `export default { './panel.kay': { parts: { head: 'two-head' }, variants: { tone: { brand: { root: 'two-brand' } } } } }\n`)
})

describe('extension ui files', () => {
  it('gives every component the entries of the extension, with no src/ui.ts', () => {
    setUiLayers(root, [{ ui: 'ext/one.ts' }])

    expect(uiEntryOf(root, card)?.parts).toEqual({ head: 'one-head', body: 'one-body' })
  })

  it('lets a later extension replace an earlier one part by part and value by value', () => {
    setUiLayers(root, [{ ui: 'ext/one.ts' }, { ui: join(root, 'ext/two.ts') }])

    expect(uiEntryOf(root, card)).toEqual({
      parts: { head: 'two-head', body: 'one-body' },
      variants: { tone: { brand: { root: 'two-brand' }, quiet: 'one-quiet' } },
    })
  })

  it('lets the app replace what extensions set and keep what it leaves alone', async () => {
    await write('src/ui.ts', `import { defineUi } from 'kay'\nexport default defineUi({ Panel: { parts: 'app-root', variants: { tone: { quiet: 'app-quiet' } } } })\n`)
    setUiLayers(root, [{ ui: 'ext/one.ts' }, { ui: 'ext/two.ts' }])

    expect(uiEntryOf(root, card)).toEqual({
      parts: { head: 'two-head', body: 'one-body', root: 'app-root' },
      variants: { tone: { brand: { root: 'two-brand' }, quiet: 'app-quiet' } },
    })
    expect(uiFilesOf(root)).toEqual([join(root, 'ext/one.ts'), join(root, 'ext/two.ts'), join(root, 'src/ui.ts')])
  })

  it('reads the file again when it changes, and skips one that is gone', async () => {
    setUiLayers(root, [{ ui: 'ext/one.ts' }, { ui: 'ext/gone.ts' }])
    await write('ext/one.ts', `export default { Panel: { parts: { head: 'changed-and-longer' } } }\n`)

    expect(uiEntryOf(root, card)?.parts).toEqual({ head: 'changed-and-longer', root: 'app-root' })
  })

  it('lists the paths of files that are gone, so a rebuild follows their removal, and finds them through a symlinked root', async () => {
    const link = `${root}-link`

    await Bun.spawn(['ln', '-sfn', root, link]).exited
    setUiLayers(link, [{ ui: 'ext/gone.ts' }])

    expect(uiPathsOf(root)).toEqual([join(link, 'ext/gone.ts'), join(root, 'src/ui.ts')])
    expect(uiFilesOf(root)).toEqual([join(root, 'src/ui.ts')])
    await Bun.spawn(['rm', link]).exited
  })

  it('names nothing once no extension lists a file', async () => {
    await Bun.file(join(root, 'src/ui.ts')).delete()
    setUiLayers(root, [{}])

    expect(uiEntryOf(root, card)).toBeUndefined()
    expect(uiFilesOf(root)).toEqual([])
  })

  it('checks an extension file without reporting a component the app lacks', async () => {
    await write('ext/bad.ts', `export default { Panel: { parts: { nope: 'x' } }, Absent: { parts: 'y' }, Broken: { parts: { head: dynamic } } }\n`)
    setUiLayers(root, [{ ui: 'ext/bad.ts' }])

    const messages = uiProblems(root).map(({ message }) => message)

    expect(messages).toContain('`Panel` has no part `nope`')
    expect(messages.some(message => message.includes('Absent'))).toBe(false)
    expect(messages.some(message => message.includes('Classes must be written as a string'))).toBe(true)
  })
})
