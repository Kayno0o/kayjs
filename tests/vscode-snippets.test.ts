import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

interface Snippet {
  prefix: string
  body: string[]
}

const snippets = Object.entries(await Bun.file(join(import.meta.dir, '../editors/vscode/snippets/kay.json')).json() as Record<string, Snippet>)

// The text an editor inserts once every placeholder holds its default.
const expand = (body: string[]): string => `${body.join('\n').replaceAll(/\$\{\d+:([^}]*)\}/g, '$1').replaceAll(/\$\{?\d+\}?/g, '')}\n`

describe('snippets', () => {
  it('cover a page, a component and an island', () => {
    expect(snippets.map(([, { prefix }]) => prefix)).toEqual(expect.arrayContaining(['page', 'component', 'island']))
  })

  it.each(snippets)('%s compiles without a problem', (_, { body }) => {
    const { diagnostics } = compileKay(expand(body), 'snippet.kay')

    expect(diagnostics.filter(({ severity }) => severity === 'error')).toEqual([])
  })

  it('is contributed by the manifest', async () => {
    const manifest = await Bun.file(join(import.meta.dir, '../editors/vscode/package.json')).json() as { contributes: { snippets: { language: string, path: string }[] } }

    expect(manifest.contributes.snippets).toEqual([{ language: 'kay', path: './snippets/kay.json' }])
  })
})
