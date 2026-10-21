import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { check } from '../src/check'
import { limiter } from '../src/server/limit'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const turn = limiter(2)
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

async function problems(files: Record<string, string>): Promise<[string, number, string | undefined][]> {
  const root = await scratchDir('snippet-')

  try {
    await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    // The implicit any of a block whose parameters match nothing follows the error naming the mismatch.
    return (await turn(async () => check(root))).filter(d => d.code !== 'TS7006').map(d => [d.file.slice(root.length + 1), d.line, d.code])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const LIST = '---\nimport type { Snippet } from \'kay\'\n\nconst { items, row, empty } = props<{ items: string[], row: Snippet<[item: string, index: number]>, empty?: Snippet }>()\n---\nfor item, i of items\n  slot row(item, i)\nslot empty\n  p none\n'

describe('Snippet', () => {
  it('types children, a block and a block with parameters, filled by the template syntax or a local snippet', async () => {
    expect(await problems({
      'src/routes/index.kay': '---\nimport List from \'../list.kay\'\n---\nsnippet cell(name: string, position: number)\n  li {position}: {name}\nList(items={[\'a\']})\n  @row(name, position)\n    li {position} {name}\n  @empty\n    p nothing\nList(items={[\'a\']} row={cell})\n',
      'src/list.kay': LIST,
    })).toEqual([])
  })

  it('reports a fill with the wrong parameters or none, and a block given parameters it does not take', async () => {
    expect(await problems({
      'src/routes/index.kay': [
        '---',
        'import List from \'../list.kay\'',
        '---',
        'snippet cell(name: number)',
        '  li {name}',
        'List(items={[\'a\']})',
        '  @row',
        '    li x',
        'List(items={[\'a\']})',
        '  @row(name)',
        '    li {name}',
        'List(items={[\'a\']})',
        '  @row(name, position, more)',
        '    li {name}',
        'List(items={[\'a\']} row={cell})',
        'List(items={[\'a\']})',
        '  @row(name, position)',
        '    li {name}',
        '  @empty(name)',
        '    li {name}',
        '',
      ].join('\n'),
      'src/list.kay': LIST,
    })).toEqual([['src/routes/index.kay', 7, 'TS2322'], ['src/routes/index.kay', 13, 'TS2322'], ['src/routes/index.kay', 15, 'TS2322'], ['src/routes/index.kay', 16, 'TS2322']])
  })

  it('types the arguments of a generic component\'s snippet from its other props, and passes one through two components', async () => {
    expect(await problems({
      'src/routes/index.kay': '---\nimport Outer from \'../outer.kay\'\n---\nOuter(items={[1, 2]})\n  @row(item)\n    li {item.toFixed()}\n',
      'src/outer.kay': '--- <T>\nimport type { Snippet } from \'kay\'\nimport Rows from \'./rows.kay\'\n\nconst { items, row } = props<{ items: T[], row: Snippet<[item: T]> }>()\n---\nRows(items={items} row={row})\n',
      'src/rows.kay': '--- <T>\nimport type { Snippet } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: Snippet<[item: T]> }>()\n---\nul\n  for item of items\n    slot row(item)\n',
    })).toEqual([])
    expect(await problems({
      'src/routes/index.kay': '---\nimport Outer from \'../outer.kay\'\n---\nOuter(items={[1, 2]})\n  @row(item)\n    li {item.toUpperCase()}\n',
      'src/outer.kay': '--- <T>\nimport type { Snippet } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: Snippet<[item: T]> }>()\n---\nul\n  for item of items\n    slot row(item)\n',
    })).toEqual([['src/routes/index.kay', 6, 'TS2339']])
  })

  it('keeps the old JSX.Element types working beside it', async () => {
    expect(await problems({
      'src/routes/index.kay': '---\nimport Old from \'../old.kay\'\n---\nOld\n  @actions\n    b x\n  @row(name)\n    i {name}\n',
      'src/old.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { actions, row } = props<{ actions?: JSX.Element, row: (name: string) => JSX.Element }>()\n---\nslot actions\nslot row(\'a\')\n',
    })).toEqual([['src/old.kay', 4, 'deprecated-markup-prop'], ['src/old.kay', 4, 'deprecated-markup-prop']])
  })

  it('reports a slot calling a prop that is no Snippet, at its name', async () => {
    expect(await problems({
      'src/routes/index.kay': '---\nimport Card from \'../card.kay\'\n---\nCard(title="x" n={1})\n',
      'src/card.kay': '---\nconst { title, n } = props<{ title: string, n: number }>()\n---\nslot title\nslot n(1)\nslot nope\n',
    })).toEqual([['src/card.kay', 5, 'TS2349'], ['src/card.kay', 6, 'TS2339']])
  })

  it('sends an island a Snippet with no parameters as its static slot, and refuses one with parameters from a layout or a server page', async () => {
    const island = '---\nimport type { Snippet } from \'kay\'\nimport { signal } from \'kay\'\n\nconst { icon, row } = props<{ icon?: Snippet, row?: Snippet<[name: string]> }>()\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)})\n  slot icon\n  slot row(\'x\')\n'

    expect(await problems({
      'src/routes/index.kay': '---\nimport Toggle from \'../toggle.kay\'\n---\nToggle\n  @icon\n    b x\n',
      'src/toggle.kay': island,
    })).toEqual([])
    expect(await problems({
      'src/routes/index.kay': '--- server\nimport Toggle from \'../toggle.kay\'\n---\nToggle\n  @row(name)\n    b {name}\n',
      'src/toggle.kay': island,
    })).toEqual([['src/routes/index.kay', 5, 'TS2345']])
  })
})
