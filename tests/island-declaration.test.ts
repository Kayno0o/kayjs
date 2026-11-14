import type { Diagnostic } from '../src/compiler/ast'
import { describe, expect, it } from 'bun:test'
import { browserRole, compileKay, rendersAsIsland } from '../src/compiler'
import { parseKay } from '../src/compiler/parser'

const part = 'src/components/part.kay'
const checked = (source: string, filename = part) => compileKay(source, filename, { check: true })
const lints = (source: string, code: string) => checked(source).diagnostics.filter(diagnostic => diagnostic.code === code)
const apply = (source: string, diagnostic: Diagnostic) => diagnostic.fixes![0]!.edits.toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

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

describe('deprecated-island-fence', () => {
  it('rewrites a fence line into the call', () => {
    const island = '--- island\nconst a = 1\n---\np {a}\n'
    const generic = '--- static <T extends string>\nconst { a } = props<{ a: T }>()\n---\np {a}\n'
    const client = '--- client\n---\np hi\n'

    expect(apply(island, lints(island, 'deprecated-island-fence')[0]!)).toBe('---\nisland()\nconst a = 1\n---\np {a}\n')
    expect(apply(generic, lints(generic, 'deprecated-island-fence')[0]!)).toBe('--- <T extends string>\nisland({ render: \'static\' })\nconst { a } = props<{ a: T }>()\n---\np {a}\n')
    expect(apply(client, lints(client, 'deprecated-island-fence')[0]!)).toBe('---\nisland({ render: \'client\' })\n---\np hi\n')
    expect(lints(island, 'deprecated-island-fence')[0]!.fixes![0]!.safe).toBe(true)
  })

  it('moves the exported island into the call, and drops a module fence left empty', () => {
    const only = '--- module\nexport const island = { persist: true, hydrate: \'idle\' } as const\n--- island\n---\nbutton Go\n'
    const shared = '--- module\nexport const island = { hydrate: \'idle\' } as const\nexport const unit = 1\n--- island\n---\nbutton Go\n'

    expect(apply(only, lints(only, 'deprecated-island-fence')[0]!)).toBe('---\nisland({ persist: true, hydrate: \'idle\' })\n---\nbutton Go\n')
    expect(apply(shared, lints(shared, 'deprecated-island-fence')[0]!)).toBe('--- module\nexport const unit = 1\n--- script\nisland({ hydrate: \'idle\' })\n---\nbutton Go\n')
  })

  it('stays quiet for a component that declares island()', () => {
    expect(lints('---\nisland({ hydrate: \'idle\' })\n---\nbutton Go\n', 'deprecated-island-fence')).toEqual([])
  })
})

describe('render="client" and defer at a use', () => {
  const card = (attributes: string) => `---\nimport Card from './card.kay'\n---\nCard(${attributes})\n`

  it('reads server defer and a bare defer as a deferred server island, and server alone as an inline one', () => {
    for (const attributes of ['server defer', 'defer', 'server="defer"']) {
      const html = compileKay(card(attributes), 'src/routes/page.kay', { output: 'html', page: true }).tsx

      expect(html).toContain('"defer"')
      expect(html).toContain('serverIsland')
    }

    expect(compileKay(card('server'), 'src/routes/page.kay', { output: 'html', page: true }).tsx).toContain('"inline"')
    expect(compileKay(card('defer="x"'), 'src/routes/page.kay', { output: 'html', page: true }).tsx).not.toContain('KayServerIsland(')
  })

  it('rewrites the old spellings', () => {
    const old = card('hydrate="client"')
    const defer = card('server="defer" noscript="Show"')

    expect(apply(old, lints(old, 'deprecated-island-attributes')[0]!)).toBe(card('render="client"'))
    expect(apply(defer, lints(defer, 'deprecated-island-attributes')[0]!)).toBe(card('server defer noscript="Show"'))
    expect(lints(card('render="client"'), 'deprecated-island-attributes')).toEqual([])
    expect(lints(card('server defer'), 'deprecated-island-attributes')).toEqual([])
  })
})
