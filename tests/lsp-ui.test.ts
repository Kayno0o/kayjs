import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { recipeParts, styleInfo, styleInfos, themeBlockTokens, themeTokens, tokensNamedBy } from '../src/build/ui-info'
import { Connection } from '../src/lsp/rpc'
import { templateContext } from '../src/lsp/template-completion'
import { objectCursor, uiFileCursor, uiItems } from '../src/lsp/ui-completion'
import { spawnSuiteServer } from './listening'
import { scratchDir } from './scratch'

const checkout = join(import.meta.dir, '..')
const cli = join(checkout, 'src', 'cli.ts')
const card = join(checkout, 'packages', 'ui', 'src', 'card.kay')

describe('the cursor in an object literal', () => {
  it('finds the keys around it and whether it is at a key or in a string', () => {
    expect(objectCursor(' ')).toEqual({ path: [], at: 'key', word: '' })
    expect(objectCursor(' hea')).toEqual({ path: [], at: 'key', word: 'hea' })
    expect(objectCursor(' head: \'p-6\', ')).toEqual({ path: [], at: 'key', word: '' })
    expect(objectCursor(' Card: { parts: { ')).toEqual({ path: ['Card', 'parts'], at: 'key', word: '' })
    expect(objectCursor(' Card: { parts: { \'ti')).toEqual({ path: ['Card', 'parts'], at: 'key', word: 'ti' })
    expect(objectCursor(' Card: { variants: { tone: { danger: { ')).toEqual({ path: ['Card', 'variants', 'tone', 'danger'], at: 'key', word: '' })
    expect(objectCursor(' Card: { parts: { head: \'p-6 --kui-')).toEqual({ path: ['Card', 'parts'], at: 'string', key: 'head', word: 'p-6 --kui-' })
  })

  it('is none outside the object, in a value that is no string, and after a closed one', () => {
    expect(objectCursor(' head: \'p-6\' }')).toBeUndefined()
    expect(objectCursor(' head: ')).toBeUndefined()
    expect(objectCursor(' head: cx(a, ')).toBeUndefined()
    expect(objectCursor(' head: [\'a\', ')).toBeUndefined()
    expect(objectCursor(' head: cx(\'a, ')).toBeUndefined()
    expect(objectCursor(' a: { b: 1 }, ')).toEqual({ path: [], at: 'key', word: '' })
  })

  it('skips comments, an apostrophe in one included', () => {
    expect(objectCursor('\n // don\'t\n Button: { parts: { ')).toEqual({ path: ['Button', 'parts'], at: 'key', word: '' })
    expect(objectCursor('\n /* it\'s */ Button: { // fine\n parts: { ')).toEqual({ path: ['Button', 'parts'], at: 'key', word: '' })
    expect(objectCursor(' // unfinished')).toBeUndefined()
    expect(objectCursor(' head: \'a//b\', ')).toEqual({ path: [], at: 'key', word: '' })
  })

  it('reads src/ui.ts from the object defineUi takes', () => {
    const source = 'import { defineUi } from \'kay\'\n\nexport default defineUi({\n  Card: {\n    parts: { | },\n  },\n})\n'
    const offset = source.indexOf('|')

    expect(uiFileCursor(source.replace('|', ''), offset)).toEqual({ path: ['Card', 'parts'], at: 'key', word: '' })
    expect(uiFileCursor('const a = {', 11)).toBeUndefined()
  })
})

// The context at the `|` of a source.
function at(marked: string) {
  const offset = marked.indexOf('|')
  const source = marked.slice(0, offset) + marked.slice(offset + 1)
  const context = templateContext(source, offset, 0)

  return context && { ...context.wanted, replaced: source.slice(context.replace.start, context.replace.end) }
}

describe('class objects of a component call', () => {
  it('finds the parts of the component the object is on, in one line and across lines', () => {
    expect(at('Card(class={{ | }})')).toMatchObject({ kind: 'ui', tag: 'Card', cursor: { path: [], at: 'key' } })
    expect(at('Card(class={{ he| }})')).toMatchObject({ kind: 'ui', replaced: 'he' })
    expect(at('Card(\n  title="a"\n  class={{\n    head: \'p-6\',\n    |\n  }}\n)')).toMatchObject({ kind: 'ui', tag: 'Card', cursor: { at: 'key' } })
    expect(at('li: Card(class={{ head: \'p-6 --kui-bo| }})')).toMatchObject({ kind: 'ui', cursor: { at: 'string', key: 'head' }, replaced: '--kui-bo' })
  })

  it('leaves an element, a closed object and a value that is no string alone', () => {
    expect(at('div(class={{ | }})')).toBeUndefined()
    expect(at('Card(class={{ head: \'a\' }} |)')).toMatchObject({ kind: 'attribute', tag: 'Card' })
    expect(at('Card(class={{ head: cx(| }})')).toBeUndefined()
    expect(at('Card(class="a |")')).toBeUndefined()
  })
})

describe('what a component offers src/ui.ts', () => {
  it('reads the parts of a recipe with their classes, and the variants, from the component', () => {
    const info = styleInfo(card)

    expect(info?.name).toBe('Card')
    expect(info?.recipe).toBe(true)
    expect(info?.parts.map(part => part.name).sort()).toEqual(['body', 'head', 'root', 'title'])
    expect(info?.parts.find(part => part.name === 'body')?.classes).toBe('p-kui-card')
  })

  it('reads a string parts as the root, and a template literal without holes', () => {
    expect(recipeParts('--- \nconst look = recipe({ parts: \'a b\' })\n---\ndiv')).toEqual({ root: 'a b' })
    expect(recipeParts('---\nconst look = recipe({ parts: { root: `x y`, head: cx(\'z\') } })\n---\ndiv')).toEqual({ root: 'x y' })
    expect(recipeParts('---\nconst a = 1\n---\ndiv')).toEqual({})
  })

  it('reads the theme tokens from the library and ties a component\'s classes to them', () => {
    const tokens = themeTokens(checkout)
    const names = tokens.map(token => token.name)

    expect(names).toContain('--color-kui-canvas')
    expect(names).toContain('--kui-border-width')
    expect(tokensNamedBy('p-kui-card border-(length:--kui-border-width) bg-kui-surface0 kui-card', tokens).map(token => token.name)).toEqual(expect.arrayContaining(['--kui-border-width', '--color-kui-surface0']))
    expect(tokensNamedBy('kui-card flex', tokens).map(token => token.name)).not.toContain('--radius-kui-card')
  })
})

class Editor {
  private readonly process = spawnSuiteServer([process.execPath, cli, 'lsp', '--stdio'], { stdin: 'pipe', stderr: 'ignore' })
  readonly connection: Connection

  constructor(private readonly root: string) {
    this.connection = new Connection(this.process.stdout, (data) => {
      void this.process.stdin.write(data)
      void this.process.stdin.flush()
    })
  }

  async start() {
    await this.connection.request('initialize', { processId: process.pid, rootUri: pathToFileURL(this.root).href, capabilities: {} })
    this.connection.notify('initialized', {})
  }

  uri(path: string) {
    return pathToFileURL(join(this.root, path)).href
  }

  open(path: string, text: string, languageId: string) {
    this.connection.notify('textDocument/didOpen', { textDocument: { uri: this.uri(path), languageId, version: 1, text } })
  }

  async labels(path: string, text: string): Promise<string[]> {
    const offset = text.indexOf('|')
    const before = text.slice(0, offset).split('\n')
    const list = await this.connection.request<{ items: { label: string }[] } | null>('textDocument/completion', { textDocument: { uri: this.uri(path) }, position: { line: before.length - 1, character: before.at(-1)!.length } })

    return list?.items.map(item => item.label) ?? []
  }

  async stop() {
    await this.connection.request('shutdown')
    this.connection.notify('exit')
    await this.process.exited
  }
}

describe('completion through the language server', () => {
  let root = ''
  let editor: Editor

  const files: Record<string, string> = {
    'package.json': '{ "name": "ui-completion", "type": "module", "dependencies": { "kay": "*", "@kaynooo/kayjs-ui": "*" } }\n',
    'src/components/panel.kay': '---\nimport { recipe } from \'kay\'\nconst look = recipe({ parts: { root: \'p-2\', body: \'text-sm\' }, variants: { size: { sm: \'text-sm\', lg: \'text-lg\' } } })\n---\ndiv(part="root")\n  div(part="body")\n    slot\n',
    'src/components/plain.kay': 'div Plain\n',
  }

  const page = (call: string) => `---\nimport Panel from '../components/panel.kay'\nimport Plain from '../components/plain.kay'\n---\n${call}\n`

  beforeAll(async () => {
    root = await scratchDir('lsp-ui-')

    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }

    editor = new Editor(root)
    await editor.start()
  })

  afterAll(async () => {
    await editor.stop()
  })

  it('offers the parts of a component in its class object, and its tokens in a string', async () => {
    const text = page('Panel(class={{ | }})')

    editor.open('src/routes/index.kay', text.replace('|', ''), 'kay')
    expect(await editor.labels('src/routes/index.kay', text)).toEqual(['root', 'body'])

    const string = page('Panel(class={{ body: \'p-2 --color-kui-|\' }})')

    editor.connection.notify('textDocument/didChange', { textDocument: { uri: editor.uri('src/routes/index.kay'), version: 2 }, contentChanges: [{ text: string.replace('|', '') }] })
    expect(await editor.labels('src/routes/index.kay', string)).toContain('--color-kui-canvas')
  })

  it('offers nothing for a component with no parts, and for one that is not imported', async () => {
    const plain = page('Plain(class={{ | }})')

    editor.connection.notify('textDocument/didChange', { textDocument: { uri: editor.uri('src/routes/index.kay'), version: 3 }, contentChanges: [{ text: plain.replace('|', '') }] })
    expect(await editor.labels('src/routes/index.kay', plain)).toEqual([])

    const unknown = page('Missing(class={{ | }})')

    editor.connection.notify('textDocument/didChange', { textDocument: { uri: editor.uri('src/routes/index.kay'), version: 4 }, contentChanges: [{ text: unknown.replace('|', '') }] })
    expect(await editor.labels('src/routes/index.kay', unknown)).toEqual([])
  })

  it('completes components, parts, variants and their values in src/ui.ts', async () => {
    const ui = (inside: string) => `import { defineUi } from 'kay'\n\nexport default defineUi({\n${inside}\n})\n`
    const send = async (inside: string, version: number) => {
      const text = ui(inside)

      if (version === 1)
        editor.open('src/ui.ts', text.replace('|', ''), 'typescript')
      else
        editor.connection.notify('textDocument/didChange', { textDocument: { uri: editor.uri('src/ui.ts'), version }, contentChanges: [{ text: text.replace('|', '') }] })

      return editor.labels('src/ui.ts', text)
    }

    expect(await send('  |', 1)).toEqual(expect.arrayContaining(['Panel', 'Card']))
    expect(await send('  Panel: { | },', 2)).toEqual(['parts', 'variants'])
    expect(await send('  Panel: { parts: { | } },', 3)).toEqual(['root', 'body'])
    expect(await send('  Panel: { variants: { | } },', 4)).toEqual(['size'])
    expect(await send('  Panel: { variants: { size: { | } } },', 5)).toEqual(['sm', 'lg'])
    expect(await send('  Panel: { variants: { size: { sm: { | } } } },', 6)).toEqual(['root', 'body'])
    expect(await send('  Card: { parts: { head: \'gap-2 --kui-border|\' } },', 7)).toContain('--kui-border-width')
    expect(await send('  Nothing: { parts: { | } },', 8)).toEqual([])
    expect(await send('  Plain: { | },', 9)).toEqual([])
  })
})

describe('the components found for completion', () => {
  it('are read again after a read that failed, not kept as the failure', async () => {
    const root = await scratchDir('ui-infos-')

    await expect(styleInfos(root, [])).rejects.toThrow('ENOENT')
    await mkdir(join(root, 'src'))
    expect(await styleInfos(root, [])).toEqual([])
  })

  const SPLIT_THEME = `
@property --border-width { syntax: '<length>'; inherits: false; initial-value: 1px; }
@theme default {
  /* a { comment } */
  --color-background: light-dark(#fff, #000);
  --color-accent: red;
  --color-chart-2: blue;
  --border-width: 1px;
  --radius-lg: 0.5rem;
}
@theme default inline reference {
  --color-kui-canvas: var(--color-background);
  --color-kui-accent: var(--color-accent);
  --kui-border-width: var(--border-width);
}
.x { --not-a-token: 1; }`

  it('reads token names from the @theme blocks and marks the reference block deprecated', () => {
    const tokens = themeBlockTokens(SPLIT_THEME)

    expect(tokens.map(token => token.name)).toEqual(['--color-background', '--color-accent', '--color-chart-2', '--border-width', '--radius-lg', '--color-kui-canvas', '--color-kui-accent', '--kui-border-width'])
    expect(tokens.filter(token => token.deprecated).map(token => token.name)).toEqual(['--color-kui-canvas', '--color-kui-accent', '--kui-border-width'])
    expect(tokensNamedBy('bg-background text-accent/50 hover:bg-chart-2 rounded-lg p-2 border-(length:--border-width) bg-kui-canvas', tokens).map(token => token.name)).toEqual(['--color-background', '--color-accent', '--color-chart-2', '--border-width', '--radius-lg', '--color-kui-canvas'])
    expect(themeBlockTokens('@theme default { --color-kui-canvas: red; }').map(token => token.name)).toEqual(['--color-kui-canvas'])
  })

  it('hides deprecated tokens from completion', () => {
    const cursor = { path: [], at: 'string' as const, key: 'root', word: '--' }
    const labels = uiItems(cursor, 'Card', { components: [], tokens: themeBlockTokens(SPLIT_THEME) }).map(item => item.label)

    expect(labels).toContain('--color-background')
    expect(labels).not.toContain('--color-kui-canvas')
  })
})
