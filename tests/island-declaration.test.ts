import { describe, expect, it } from 'bun:test'
import { browserRole, compileKay, rendersAsIsland } from '../src/compiler'
import { islandFence } from '../src/compiler/island-marker'
import { parseKay } from '../src/compiler/parser'

const part = 'src/components/part.kay'
const checked = (source: string, filename = part) => compileKay(source, filename, { check: true })
const lints = (source: string, code: string) => checked(source).diagnostics.filter(diagnostic => diagnostic.code === code)

describe('island() in the script', () => {
  it('makes a component with nothing interactive an island, everywhere an island is made', () => {
    const source = '---\nisland()\nconst label = \'a\'\n---\np {label}\n'

    for (const output of [undefined, 'html', 'dom'] as const) {
      const compiled = compileKay(source, part, { output })

      expect(compiled.island).toBeDefined()
      expect(compiled.diagnostics).toEqual([])
      expect(compiled.tsx).not.toContain('island(')
    }

    expect(rendersAsIsland(source)).toBe(true)
    expect(browserRole(source, part)).toBe('island')
    expect(compileKay(source, part).cause).toMatchObject({ kind: 'island', name: 'island()', line: 2 })
    expect(compileKay(source, part).why).toBe('an `island()` declaration')
  })

  it('renders client only with render: client, and pins static with render: static', () => {
    const client = '---\nisland({ render: \'client\' })\n---\np hi\n'
    const pinned = '---\nisland({ render: \'static\' })\nconst a = 1\n---\nbutton(onClick={() => 1}) {a}\n'

    expect(parseKay(client).client).toBeDefined()
    expect(compileKay(client, part, { output: 'html' }).tsx).toContain('KayIsland(')
    expect(compileKay(client, part).cause).toMatchObject({ kind: 'client', name: 'island()' })
    expect(lints(pinned, 'static-pin')).toHaveLength(1)
  })

  it('hands the parents what it asks, to the server render only', () => {
    const source = '---\nisland({ hydrate: \'idle\', persist: true, interactive: { open: false } })\n---\nbutton Go\n'
    const html = compileKay(source, part, { output: 'html' }).tsx

    expect(html).toContain(', {"hydrate":"idle","persist":true,"interactive":{"open":false}})')
    expect(compileKay(source, part, { output: 'dom' }).tsx).not.toContain('"persist":true')
    expect(compileKay(source, part).cause).toMatchObject({ interactive: { open: false } })
  })

  it('reports what it cannot read', () => {
    const messages = (source: string) => checked(source).diagnostics.map(diagnostic => diagnostic.message)

    expect(messages('---\nisland({ render: \'x\' })\n---\np\n')[0]).toContain('`render` is')
    expect(messages('---\nisland({ hydrate: \'client\' })\n---\np\n')[0]).toContain('how it renders')
    expect(messages('---\nconst when = \'idle\'\nisland({ hydrate: when })\n---\np\n')[0]).toContain('`hydrate` is')
    expect(messages('---\nisland({ nope: 1 })\n---\np\n')[0]).toContain('`island()` takes')
    expect(messages('---\nisland()\nisland()\n---\np\n')[0]).toContain('declares `island()` once')
  })

  it('is no island on a page, a layout or a special page', () => {
    const source = '---\nisland()\n---\nh1 Home\n'

    expect(compileKay(source, 'src/routes/index.kay', { page: true }).island).toBeUndefined()
    expect(lints(source, 'island-marker')).toHaveLength(0)
    expect(compileKay(source, 'src/routes/_layout.kay', { check: true }).diagnostics.map(diagnostic => diagnostic.code)).toContain('island-marker')
  })
})

describe('what the second review round settled', () => {
  it('keeps the other settings when the pinned call becomes a plain one', () => {
    const source = '---\nisland({ render: \'static\', hydrate: \'idle\' })\nconst a = 1\n---\nbutton(onClick={() => 1}) {a}\n'
    const fix = islandFence(parseKay(source))!

    expect(fix.edits.map(edit => edit.text)).toEqual(['island({ hydrate: \'idle\' })'])
    expect(islandFence(parseKay('---\nisland({ render: \'static\' })\n---\np\n'))!.edits.map(edit => edit.text)).toEqual(['island()'])
  })

  it('writes the file\'s own line endings', () => {
    expect(islandFence(parseKay('---\r\nconst a = 1\r\n---\r\np {a}\r\n'))!.edits[0]!.text).toBe('island()\r\n')
  })

  it('reports an island() call in a module fence', () => {
    const source = '--- module\nisland()\nexport const a = 1\n--- script\nconst b = 2\n---\np {b}\n'

    expect(lints(source, 'fence-invalid').map(diagnostic => diagnostic.message)).toEqual(['`island()` goes in the component\'s script, not its `--- module` fence'])
  })
})

describe('render="client" and defer at a use', () => {
  const card = (attributes: string) => `---\nimport Card from './card.kay'\n---\nCard(${attributes})\n`

  it('reads server defer as a deferred server island, and server alone as an inline one', () => {
    for (const attributes of ['server defer']) {
      const html = compileKay(card(attributes), 'src/routes/page.kay', { output: 'html', page: true }).tsx

      expect(html).toContain('"defer"')
      expect(html).toContain('serverIsland')
    }

    expect(compileKay(card('server'), 'src/routes/page.kay', { output: 'html', page: true }).tsx).toContain('"inline"')
  })

  it('leaves a defer of the component\'s own, alone or with a value, to the component', () => {
    const html = (attributes: string) => compileKay(card(attributes), 'src/routes/page.kay', { output: 'html', page: true }).tsx

    expect(html('defer')).not.toContain('KayServerIsland(')
    expect(html('defer="x"')).not.toContain('KayServerIsland(')
    expect(html('server defer={x}')).toContain('"inline"')
    expect(html('server defer={x}')).toContain('"defer"')
  })

  it('refuses the old spelling of a deferred server island, a value on `server`', () => {
    const found = compileKay(card('server="defer" noscript="Show"'), 'src/routes/page.kay', { check: true, page: true }).diagnostics.filter(diagnostic => diagnostic.code === 'server-island-invalid')

    expect(found.map(diagnostic => diagnostic.message)).toEqual(['`server` takes no value'])
  })
})
