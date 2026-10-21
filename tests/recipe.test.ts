import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { compileKay } from '../src/compiler'
import { installClassTable } from '../src/runtime/class-table'
import { child } from '../src/runtime/html'
import { recipe } from '../src/runtime/recipe'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)
await plugin(kay())

const scratch = await scratchDir('recipe-')
const MARKERS = /<!--[[\]]-->/g
const CARD = `---
import { recipe } from 'kay'

const card = recipe({
  parts: { root: 'rounded border', head: 'p-4 font-bold', body: 'p-4' },
  variants: {
    tone: { plain: 'bg-white', danger: { root: 'border-red-500', head: 'bg-red-50' } },
    compact: { true: { head: 'p-2', body: 'p-2' } },
  },
  defaults: { tone: 'plain' },
})
const { title } = props<{ title: string }>()
---
section
  header(part="head") {title}
  div(part="body")
    slot
`
const files: Record<string, string> = {
  'card.kay': CARD,
  'button.kay': '---\nimport { recipe } from \'kay\'\nconst button = recipe({ parts: \'rounded px-4\', variants: { size: { sm: \'text-sm\', lg: \'text-lg\' }, wide: { true: \'w-full\' } }, defaults: { size: \'sm\' } })\nconst { label, ...rest } = props<{ label: string, [key: string]: unknown }>()\n---\nbutton.btn({...rest}) {label}\n',
  'plain.kay': 'section.card\n  header(part="head") a\n',
  'calls.kay': '---\nimport Button from \'./button.kay\'\nimport Card from \'./card.kay\'\n---\nCard(title="default") a\nCard(title="danger" tone="danger") b\nCard(title="compact" compact) c\nCard(title="override" compact class={{ head: \'p-6\' }}) d\nCard(title="string" class="mt-4") e\nButton(label="small")\nButton(label="large" size="lg" wide id="x")\nButton(label="no-wide" wide={false})\n',
  'parent.kay': '---\nimport Card from \'./card.kay\'\nconst tone = signal<\'plain\' | \'danger\'>(\'plain\')\nconst compact = signal(false)\n---\nbutton.swap(onClick={() => tone.set(\'danger\')}) swap\nbutton.pack(onClick={() => compact.set(true)}) pack\nCard(title="t" tone={tone()} compact={compact()}) body\n',
  'part-call.kay': '---\nimport { recipe } from \'kay\'\nimport Card from \'./card.kay\'\nconst panel = recipe({ parts: { root: \'rounded\', card: \'mt-2\' }, variants: { flat: { true: { card: \'mt-0\' } } } })\n---\nsection\n  Card(part="card" title="inner") x\n',
}

beforeAll(async () => {
  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(scratch, name), text)))
  installClassTable({ sets: [[1]], classes: { 'p-2': [0, 0], 'p-4': [0, 0], 'p-6': [0, 0], 'mt-0': [0, 0], 'mt-2': [0, 0], 'mt-4': [0, 0] } })
})

afterAll(async () => {
  installClassTable(undefined)
  await rm(scratch, { recursive: true, force: true })
})

async function render(name: string, props: Record<string, unknown> = {}): Promise<string> {
  const module = await import(join(scratch, name)) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default(props)).replace(MARKERS, '')
}

describe('recipe()', () => {
  const button = recipe({ parts: { root: 'a', head: 'h' }, variants: { tone: { x: 'tx', y: { root: 'ty', head: 'hy' } }, on: { true: 'on', false: 'off' } }, defaults: { tone: 'x' } })

  it('gives the base, then each variant in declaration order, by part', () => {
    expect(button()).toBe('a tx')
    expect(button({ tone: 'y' })).toBe('a ty')
    expect(button({ tone: 'y' }, 'head')).toBe('h hy')
    expect(button({}, 'head')).toBe('h')
    expect(button({}, 'nothing')).toBe('')
  })

  it('reads a boolean variant as true or false, and a variant it does not know as none', () => {
    expect(button({ on: true })).toBe('a tx on')
    expect(button({ on: false })).toBe('a tx off')
    expect(button({ tone: 'nope' as 'x' })).toBe('a')
    expect(button({ tone: undefined })).toBe('a tx')
  })

  it('reads own entries only, and names its variants', () => {
    expect(button({ tone: 'constructor' as 'x' })).toBe('a')
    expect(button({ tone: ['y'] as unknown as 'x' })).toBe('a')
    expect(button.variants).toEqual(['tone', 'on'])
  })

  it('takes a string as the root\'s base', () => {
    expect(recipe({ parts: 'p-2' })()).toBe('p-2')
    expect(recipe({ variants: { size: { sm: 'text-sm' } } })({ size: 'sm' })).toBe('text-sm')
  })
})

describe('a component with a recipe, on the server', () => {
  it('uses the defaults and gives each part its base', async () => {
    expect(await render('calls.kay')).toContain('<section class="rounded border bg-white"><header class="p-4 font-bold" data-part="head">default</header><div class="p-4" data-part="body">a</div></section>')
  })

  it('applies a variant to the root and to a part', async () => {
    expect(await render('calls.kay')).toContain('<section class="rounded border border-red-500"><header class="p-4 font-bold bg-red-50" data-part="head">danger</header>')
  })

  it('reads a boolean variant written bare, and lets its variant classes override the base', async () => {
    expect(await render('calls.kay')).toContain('<header class="font-bold p-2" data-part="head">compact</header><div class="p-2" data-part="body">c</div>')
  })

  it('lets the instance\'s class override a variant, through the merge', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<header class="font-bold p-6" data-part="head">override</header><div class="p-2" data-part="body">d</div>')
    expect(html).toContain('<section class="rounded border bg-white mt-4"><header')
  })

  it('applies a recipe to the single root of a component with no part, and keeps the variant props off the spread', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<button class="btn rounded px-4 text-sm">small</button>')
    expect(html).toContain('<button id="x" class="btn rounded px-4 text-lg w-full">large</button>')
    expect(html).toContain('<button class="btn rounded px-4 text-sm">no-wide</button>')
  })

  it('hands a recipe\'s entry for a part that is a component on to it', async () => {
    expect(await render('part-call.kay')).toContain('<section class="rounded border bg-white mt-2"')
  })
})

describe('a component without a recipe', () => {
  it('pays nothing: no import, no helper, and not an island for the import alone', () => {
    const plain = compileKay(files['plain.kay']!, 'src/plain.kay', {})
    const recipes = compileKay(CARD, 'src/card.kay', {})

    expect(plain.tsx).not.toContain('recipe')
    expect(recipes.island).toBeUndefined()
  })
})

describe('a component with a recipe, as an island', () => {
  let render!: (fn: () => unknown, element: Element) => () => void
  let parent!: (props: object) => unknown
  let card!: (props: object) => unknown

  beforeAll(async () => {
    GlobalRegistrator.register()
    await Bun.write(join(scratch, 'entry.ts'), 'import { render } from \'kay/dom\'\nimport Card from \'./card.kay\'\nimport Parent from \'./parent.kay\'\n\nexport { Card, Parent, render }\n')

    const build = await Bun.build({ entrypoints: [join(scratch, 'entry.ts')], outdir: join(scratch, 'out'), target: 'browser', plugins: [kay()] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    const module = await import(build.outputs[0]!.path) as { Card: typeof card, Parent: typeof parent, render: typeof render }

    card = module.Card
    parent = module.Parent
    render = module.render
  }, 60_000)

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  function mount(component: (props: object) => unknown, props: object): { root: HTMLElement, stop: () => void } {
    const root = document.createElement('div')

    document.body.append(root)

    return { root, stop: render(() => component(props), root) }
  }

  function summary(element: Element): [string, string | null][] {
    return [...element.querySelectorAll('section, header, div[data-part]')].map(found => [found.localName, found.getAttribute('class')])
  }

  it('renders what the server renders for the same props', async () => {
    const props = { title: 'hi', tone: 'danger', compact: true, class: { head: 'p-6' } }
    const server = await import(join(scratch, 'card.kay')) as { default: (props: object) => unknown }
    const holder = document.createElement('div')

    holder.innerHTML = child(server.default(props)).replace(MARKERS, '')

    const { root, stop } = mount(card, props)

    expect(summary(root)).toEqual([['section', 'rounded border border-red-500'], ['header', 'font-bold bg-red-50 p-6'], ['div', 'p-2']])
    expect(summary(holder)).toEqual(summary(root))
    stop()
  })

  it('swaps the classes of a variant changed at runtime', async () => {
    const { root, stop } = mount(parent, {})

    expect(summary(root)).toEqual([['section', 'rounded border bg-white'], ['header', 'p-4 font-bold'], ['div', 'p-4']])
    root.querySelector<HTMLElement>('.swap')?.click()
    await settle()
    expect(summary(root)).toEqual([['section', 'rounded border border-red-500'], ['header', 'p-4 font-bold bg-red-50'], ['div', 'p-4']])
    root.querySelector<HTMLElement>('.pack')?.click()
    await settle()
    expect(summary(root)).toEqual([['section', 'rounded border border-red-500'], ['header', 'font-bold bg-red-50 p-2'], ['div', 'p-2']])
    stop()
  })
})

describe('a recipe the compiler cannot read', () => {
  const messages = (source: string, options = {}) => compileKay(source, 'src/chip.kay', { check: true, ...options }).diagnostics.map(diagnostic => diagnostic.message)
  const head = '---\nimport { recipe } from \'kay\'\n'

  it('reads a recipe cast with as or checked with satisfies', () => {
    expect(compileKay(`${head}const a = recipe({ variants: { tone: { x: 'y' } } }) as Recipe<any>\n---\nspan a\n`, 'src/chip.kay', { check: true }).tsx).toContain('KayRecipeProps<typeof a>')
    expect(compileKay(`${head}const a = recipe({ variants: { tone: { x: 'y' } } }) satisfies object\n---\nspan a\n`, 'src/chip.kay', { check: true }).tsx).toContain('KayRecipeProps<typeof a>')
  })

  it('reports a recipe that shares its const, or is not a const, as one that types no props', () => {
    expect(messages(`${head}const a = recipe({ parts: 'x' }), b = 1\n---\nspan a\n`)).toContain('A recipe is a `const` of its own')
    expect(messages(`${head}let a = recipe({ parts: 'x' })\n---\nspan a\n`)).toContain('A recipe is a `const` of its own')
  })

  it('reports a recipe that reads a name the script declares', () => {
    const found = messages(`${head}const { size } = props<{ size: string }>()\nconst gap = 'gap-2'\nconst a = recipe({ parts: gap, variants: { tone: { x: size } } })\n---\nspan a\n`)

    expect(found.filter(message => message.includes('A recipe is built once'))).toHaveLength(2)
    expect(messages(`${head}import { base } from './base'\nconst other = recipe({ parts: 'x' })\nconst a = recipe({ parts: base, variants: { tone: { x: (name: string) => name } } })\n---\nspan a\n`).filter(message => message.includes('A recipe is built once'))).toEqual([])
  })

  it('reports a recipe that styles a root the template has no part for', () => {
    expect(messages(`${head}const a = recipe({ parts: 'rounded' })\n---\nheader a\nfooter b\n`)).toContain('The recipe styles the root, which the template has no part for')
    expect(messages(`${head}const a = recipe({ parts: { head: 'p-4' }, variants: { tone: { x: { head: 'p-2' } } } })\n---\nheader(part="head") a\nfooter b\n`)).toEqual([])
    expect(messages(`${head}const a = recipe({ parts: 'rounded' })\n---\nheader(part="root") a\nfooter b\n`)).toEqual([])
    expect(messages(`${head}const a = recipe({ variants: { tone: { x: 'p-2' } } })\n---\nheader a\nfooter b\n`)).toContain('The recipe styles the root, which the template has no part for')
  })

  it('reports a recipe in a server fence', () => {
    const found = messages('--- server\nimport { recipe } from \'kay\'\nconst c = recipe({ parts: \'a\' })\n---\nmain a\n', { page: true })

    expect(found).toContain('A recipe belongs to a component\'s script, not to a `--- server` fence')
    expect(messages('--- server\nconst c = recipe({ parts: \'a\' })\n---\nmain a\n', { page: true })).toContain('A recipe belongs to a component\'s script, not to a `--- server` fence')
  })
})

describe('compiling a recipe', () => {
  it('reports a recipe in a page', () => {
    const page = compileKay('---\nimport { recipe } from \'kay\'\nconst c = recipe({ parts: \'a\' })\n---\nmain a\n', 'src/routes/index.kay', { check: true, page: true })

    expect(page.diagnostics.map(diagnostic => diagnostic.message)).toContain('A page or a layout takes no variants')
  })

  it('types the variant props off the recipe, beside the class from the parts', () => {
    const { tsx } = compileKay(CARD, 'src/card.kay', { check: true })

    expect(tsx).toContain('KayRecipeProps<typeof card>')
    expect(tsx).toContain('class?: string | { "root"?: string; "head"?: string; "body"?: string }')
  })

  it('reads a recipe of a component with no props declaration', () => {
    const { tsx } = compileKay('---\nimport { recipe } from \'kay\'\nconst chip = recipe({ variants: { tone: { a: \'x\' } } })\n---\nspan.chip a\n', 'src/chip.kay', { check: true })

    expect(tsx).toContain('KayRecipeProps<typeof chip>')
  })

  it('reports a component with a recipe that also declares class', () => {
    const messages = compileKay('---\nimport { recipe } from \'kay\'\nconst chip = recipe({ variants: { tone: { a: \'x\' } } })\nconst { class: className } = props<{ class?: string }>()\n---\nspan(class={className}) a\n', 'src/chip.kay', { check: true }).diagnostics.map(diagnostic => diagnostic.message)

    expect(messages.some(message => message.includes('takes `class`'))).toBe(true)
  })
})

const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, noUnusedLocals: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const CARD_IMPORT = '---\nimport Card from \'../card.kay\'\n---\n'
const BOTH_IMPORTS = '---\nimport Card from \'../card.kay\'\nimport Chip from \'../chip.kay\'\n---\n'
const CHIP_IMPORT = '---\nimport Chip from \'../chip.kay\'\n---\n'

async function problems(page: string): Promise<string[]> {
  const root = await scratchDir('recipe-check-')

  try {
    const sources = { 'tsconfig.json': tsconfig, 'src/card.kay': CARD, 'src/chip.kay': '---\nimport { recipe } from \'kay\'\nconst chip = recipe({ variants: { tone: { a: \'x\', b: \'y\' }, cols: { 1: \'grid-cols-1\', 2: \'grid-cols-2\' }, level: { low: \'a\', 1: \'b\' } }, defaults: { cols: 1 } })\n---\nspan.chip a\n', 'src/routes/index.kay': page }

    await Promise.all(Object.entries(sources).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return (await check(root)).map(diagnostic => diagnostic.message.slice(0, diagnostic.message.includes('\n') ? diagnostic.message.indexOf('\n') : undefined))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('kay check on a component with a recipe', () => {
  it('passes the variants, a boolean one bare, and a recipe with no props declaration, and reports nothing unused', async () => {
    expect(await problems(`${BOTH_IMPORTS}Card(title="a" tone="danger" compact)\nCard(title="b" compact={false})\nChip(tone="b" cols={2})\nChip(cols="1")\nChip\n`)).toEqual([])
  })

  it('reports an unknown variant value at the call', async () => {
    expect(await problems(`${CARD_IMPORT}Card(title="a" tone="nope")\n`)).toEqual([expect.stringContaining('nope')])
    expect(await problems(`${CHIP_IMPORT}Chip(tone="c")\n`)).toEqual([expect.stringContaining('"c"')])
  })

  it('takes a number from a variant mixing text and numeric keys', async () => {
    expect(await problems(`${CHIP_IMPORT}Chip(level={1})\nChip(level="low")\n`)).toEqual([])
    expect(await problems(`${CHIP_IMPORT}Chip(level={2})\n`)).toEqual([expect.stringContaining('2')])
  })

  it('reports a number no numeric variant has', async () => {
    expect(await problems(`${CHIP_IMPORT}Chip(cols={3})\n`)).toEqual([expect.stringContaining('3')])
  })

  it('reports a boolean variant given a string', async () => {
    expect(await problems(`${CARD_IMPORT}Card(title="a" compact="yes")\n`)).toEqual([expect.stringContaining('boolean')])
  })
})
