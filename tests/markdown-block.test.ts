import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { formatKay } from '../src/compiler/format'
import { expandMarkdown, parseExpanded } from '../src/compiler/markdown-block'
import { parseKay } from '../src/compiler/parser'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

const CALLOUT = '---\nconst { type = \'note\' } = props<{ type?: string }>()\n---\naside.callout(data-type={type})\n  slot\n'
const NAME = 'Ada **<b>&</b>** [x](/y)'
const PAGE = `---
import Callout from '../components/callout.kay'

const name = ${JSON.stringify(NAME)}
const slug = 'about'
---
main
  markdown
    # Hello {slug}

    Some **bold** text, a [link](/about), an [other](/guide/{slug}) and \`code\`.

    - one
    - two {name}

    1. first

    > quoted

    | a | b |
    |---|---|
    | 1 | 2 |

    \`\`\`js
    const a = 1 < 2
    \`\`\`

    <Callout type="warn">
    Careful & ok
    </Callout>

    A \\{literal} brace and {name}.
  p.after Done
`

let dir: string
const sites: { close: () => Promise<void> }[] = []

async function write(files: Record<string, string>) {
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content)))
}

beforeAll(async () => {
  dir = await scratchDir('markdown-block-')
  await write({
    'components/callout.kay': CALLOUT,
    'routes/index.kay': PAGE,
    'routes/about.kay': 'p About\n',
    'routes/plain.kay': 'main\n  a(href="/about") link\n  a(href="/guide/about") other\n',
    'messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n',
    'messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n',
    'routes/guide/about.kay': 'p Guide\n',
  })
})

afterAll(async () => {
  await Promise.all(sites.map(async site => site.close()))
  await rm(dir, { recursive: true, force: true })
})

async function open(options: Record<string, unknown> = {}) {
  const site = await testSite({ routes: join(dir, 'routes'), islands: false, ...options })

  sites.push(site)

  return site
}

describe('a markdown block', () => {
  it('renders its Markdown as the elements a template would write', async () => {
    const page = await (await open()).visit('/')
    const html = await (await (await open()).fetch('/')).text()

    expect(page.find('h1')[0]?.text).toBe('Hello about')
    expect(page.find('strong').map(element => element.text)).toContain('bold')
    expect(page.find('li').map(element => element.text)).toEqual(['one', `two ${NAME}`, 'first'])
    expect(page.find('blockquote').length).toBe(1)
    expect(page.find('td').map(element => element.text)).toEqual(['1', '2'])
    expect(page.find('pre code')[0]?.attributes.class).toBe('language-js')
    expect(html).toContain('const a = 1 &lt; 2\n')
    expect(page.find('p.after')[0]?.text).toBe('Done')
  })

  it('keeps an {expr} holding Markdown or HTML characters as text', async () => {
    const html = await (await (await open()).fetch('/')).text()

    expect(html).toContain('Ada **&lt;b>&amp;&lt;/b>** [x](/y)')
    expect(html).not.toContain('<b>')
    expect(html).toContain('A {literal} brace')
  })

  it('renders the components the Markdown names, around what they wrap', async () => {
    const page = await (await open()).visit('/')
    const callout = page.find('aside.callout')[0]

    expect(callout?.attributes['data-type']).toBe('warn')
    expect(callout?.text).toBe('Careful & ok')
  })

  it('writes its links as a template link is written: under a base and a trailing slash', async () => {
    const site = await open({ base: '/blog', trailingSlash: 'always' })
    const links = async (path: string) => (await site.visit(path)).find('main a').map(element => element.attributes.href)

    expect(await links('/blog/')).toEqual(await links('/blog/plain/'))
    expect(await links('/blog/')).toEqual(['/blog/about', '/blog/guide/about'])
  })

  it('writes its links in the locale of the page', async () => {
    const site = await open({ i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: join(dir, 'messages') } })
    const links = async (path: string) => (await site.visit(path)).find('main a').map(element => element.attributes.href)

    expect(await links('/en')).toEqual(['/en/about', '/en/guide/about'])
    expect(await links('/en/plain')).toEqual(['/en/about', '/en/guide/about'])
    expect(await links('/')).toEqual(['/about', '/guide/about'])
  })
})

describe('a markdown block in the compiled code', () => {
  const component = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nmain\n  button(onClick={() => count.set(count() + 1)}) +\n  markdown\n    Seen **{count()}** times, [home](/).\n'

  it('reaches the browser as DOM code, with no Markdown parser and the same lowering as a template', () => {
    const lowered = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nmain\n  button(onClick={() => count.set(count() + 1)}) +\n  p\n    | Seen #[strong {count()}] times, #[a(href="/") home].\n'
    const { tsx } = compileKay(component, 'src/island.kay', { output: 'dom' })

    expect(tsx).toBe(compileKay(lowered, 'src/island.kay', { output: 'dom' }).tsx)
    expect(tsx).not.toContain('markdown')
    expect(tsx).not.toContain('Bun')
  })

  it('gives the build the classes it wrote, which no source text names', () => {
    const { classes } = compileKay('main\n  markdown\n    - [x] done\n\n    <span class="mark  more">hi</span>\n  p.own Own\n', 'src/p.kay')

    expect(new Set(classes)).toEqual(new Set(['own', 'task-list-item', 'task-list-item-checkbox', 'mark', 'more']))
  })

  it('decodes any named entity in raw HTML and leaves an unknown one as written', () => {
    const { tsx } = compileKay('markdown\n  <p>caf&eacute; &hearts; &copy; &bogus;</p>\n', 'src/p.kay', { output: 'html' })

    expect(tsx).toContain('caf\u00E9 \u2665 \u00A9 &bogus;')
  })

  it('renders on the server as the same strings', () => {
    const page = '---\nconst name = \'x\'\n---\nmarkdown\n  Hi **{name}**\n'
    const lowered = '---\nconst name = \'x\'\n---\np\n  | Hi #[strong {name}]\n'

    expect(compileKay(page, 'src/p.kay', { output: 'html' }).tsx).toBe(compileKay(lowered, 'src/p.kay', { output: 'html' }).tsx)
  })
})

describe('lowering', () => {
  const lines = (markdown: string, head = '---\nconst name = \'n\'\nconst items = [1]\n---\n') => {
    const { file, problems } = parseExpanded(`${head}div\n  markdown\n${markdown.split('\n').map(line => line === '' ? '' : `    ${line}`).join('\n')}\n`)

    return { template: file.source.slice(file.templateStart).split('\n').slice(2, -1).map(line => line.slice(2)), problems: problems.map(problem => problem.message), parse: file.diagnostics.map(diagnostic => diagnostic.message) }
  }

  it('writes a paragraph as a text line with the inline elements in #[...]', () => {
    expect(lines('Hello *you*, a [link](/x "t") and `code`.').template).toEqual(['p', '  | Hello #[em you], a #[a(href="/x" title="t") link] and #[code code].'])
  })

  it('escapes the characters the template reads in text', () => {
    expect(lines('A # sign, #[no] and a\\\\ backslash.').template).toEqual(['p', '  | A # sign, \\#[no] and a{"\\\\"} backslash.'])
    expect(lines('Brace \\{x} and [a \\] b](/z)').template).toEqual(['p', '  | Brace \\{x} and #[a(href="/z") a {"]"} b]'])
  })

  it('keeps a hole as the expression the file wrote, in text and in an attribute', () => {
    expect(lines('Hi {name.toUpperCase()}, [go](/a/{name}?q={ items.length })').template).toEqual(['p', '  | Hi {name.toUpperCase()}, #[a(href={`/a/${name}?q=${ items.length }`}) go]'])
  })

  it('keeps the whitespace of a code block, holes in it too', () => {
    expect(lines('```\na  b\n  {name}\n```').template).toEqual(['pre', '  code', '    | {"a  b\\n  "}{name}{"\\n"}'])
  })

  it('lowers a task list, a table and an image', () => {
    expect(lines('- [x] done\n\n![alt](/i.png)').template).toEqual(['ul', '  li(class="task-list-item")', '    | #[input(type="checkbox" class="task-list-item-checkbox" disabled checked)]done', 'p', '  | #[img(src="/i.png" alt="alt")]'])
  })

  it('reports a Markdown problem on the block and keeps what its holes read read', () => {
    const empty = lines('<div>\n{name}')

    expect(empty.problems.join()).toContain('is never closed')
    expect(empty.template).toEqual(['| {name}'])
  })

  it('reports an unclosed or empty brace on the hole', () => {
    expect(lines('Open {name').problems.join()).toContain('Unclosed')
    expect(lines('Empty {} here').problems.join()).toContain('Empty `{}`')
  })

  it('reports a block with no lines, and one holding the characters kay keeps for its holes', () => {
    expect(parseExpanded('main\n  markdown\n  p x\n').problems.map(problem => problem.message)).toEqual(['A `markdown` block has no lines'])
    expect(parseExpanded('markdown\n  a\uE000b\n').problems.map(problem => problem.message)).toEqual(['A `markdown` block cannot hold the private-use characters U+E000 to U+E003'])
  })

  it('reports a hole of the block at its place in the file', () => {
    const source = 'markdown\n  one {\n  two\n'
    const [problem] = parseExpanded(source).problems

    expect(source.slice(problem!.start, problem!.end)).toBe('{')
  })

  it('keeps blocks nested in an if or a for, at their indentation', () => {
    const { file } = parseExpanded('---\nconst items = [1]\n---\nfor item of items\n  markdown\n    Row {item}\n')

    expect(file.source.slice(file.templateStart)).toBe('\nfor item of items\n  p\n    | Row {item}\n')
  })

  it('leaves a file without a block as it is', () => {
    expect(expandMarkdown(parseKay('p x\n'))).toBeUndefined()
    expect(parseExpanded('p x\n').expansion).toBeUndefined()
  })
})

describe('positions in a file with markdown blocks', () => {
  const source = '---\nconst title = \'T\'\n---\nmain\n  markdown\n    Hi **{title}**, [a](/x)\n\n    More {title.nope}\n  p {bad}\n'

  it('maps a hole to where it is written, and what follows the block to where it is', () => {
    const { diagnostics } = compileKay(source, 'src/p.kay', { check: true })
    const bad = diagnostics.find(diagnostic => diagnostic.message.includes('bad'))

    expect(bad).toBeUndefined()

    const { expansion } = parseExpanded(source)
    const expanded = expansion!.source

    expect(expansion!.real(expanded.indexOf('title.nope'))).toBe(source.indexOf('title.nope'))
    expect(expansion!.real(expanded.indexOf('p {bad}'))).toBe(source.indexOf('p {bad}'))
    expect(source.slice(expansion!.real(expanded.indexOf('{bad}')), expansion!.real(expanded.indexOf('{bad}') + 5))).toBe('{bad}')
  })

  it('maps the generated code to the holes, and what the lowering made up to the keyword', () => {
    const { tsx, map } = compileKay(source, 'src/p.kay', { check: true })
    const at = tsx.indexOf('title.nope')

    expect(map.toSource(at)).toBe(source.indexOf('title.nope'))
    expect(map.toSource(tsx.indexOf('<strong>'))).toBe(source.indexOf('markdown'))
  })

  it('puts a problem the lowering made up on the keyword, and drops a fix it cannot make to the file', () => {
    const { expansion } = parseExpanded(source)
    const span = { start: expansion!.source.indexOf('strong'), end: expansion!.source.indexOf('strong') + 6 }

    expect(expansion!.diagnostic({ ...span, message: 'x', fixes: [{ title: 'f', edits: [{ ...span, text: 'b' }] }] })).toEqual({ start: source.indexOf('markdown'), end: source.indexOf('markdown') + 8, message: 'x', fixes: [] })
  })

  it('moves the line a development inspector shows to the file\'s', () => {
    const { tsx } = compileKay(source, 'src/p.kay', { output: 'html', inspect: true })

    expect(tsx).toContain('src/p.kay:9:3')
  })
})

describe('kay fmt', () => {
  const block = 'main\n    markdown\n        # Title  \n\n          code\n        Two spaces  \n        break\n    p x\n'

  it('moves the lines of a block with it and keeps them as they are, trailing spaces included', () => {
    const { code, diagnostics } = formatKay(block)

    expect(diagnostics).toEqual([])
    expect(code).toBe('main\n  markdown\n      # Title  \n\n        code\n      Two spaces  \n      break\n  p x\n')
  })

  it('is stable', () => {
    const once = formatKay(block).code

    expect(formatKay(once).code).toBe(once)
  })
})
