import type { Element as DomElement, Node as DomNode } from 'happy-dom'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { Window } from 'happy-dom'
import { kay } from '../src/build/plugin'
import { formatKay } from '../src/compiler/format'
import { migrateAstro } from '../src/migrate/astro'
import { htmlToKay } from '../src/migrate/html'
import { MarkupError } from '../src/migrate/markup'
import { child } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('from-html-')
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const MARKERS = /<!--[[\]]-->/g
const SPACE = /[ \t\n\r\f]+/g
let cases = 0

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

type Edge = 'first' | 'last' | 'both' | 'none'

// Where a child sits among its siblings, the edges of which the text there is trimmed at.
function edgeOf(index: number, count: number): Edge {
  if (count === 1)
    return 'both'

  if (index === 0)
    return 'first'

  return index === count - 1 ? 'last' : 'none'
}

function trimmed(text: string, edge: Edge): string {
  if (edge === 'both')
    return text.trim()

  if (edge === 'first')
    return text.trimStart()

  return edge === 'last' ? text.trimEnd() : text
}

// The DOM both sides parse to, as text: attributes sorted, whitespace collapsed and dropped between blocks, comments and the loading hints kay puts on an image left out.
function canonical(html: string): string {
  const { document } = new Window()

  document.body.innerHTML = html

  const walk = (node: DomNode, edge: Edge): string => {
    if (node.nodeType === 8)
      return ''

    if (node.nodeType === 3) {
      const text = trimmed((node.textContent ?? '').replace(SPACE, ' '), edge)

      return text === ' ' ? '' : text
    }

    const element = node as DomElement
    const attributes = [...element.attributes].filter(attribute => !(element.localName === 'img' && (attribute.name === 'loading' || attribute.name === 'decoding'))).map(attribute => `${attribute.name}=${JSON.stringify(attribute.name === 'class' ? (attribute.value ?? '').split(' ').toSorted().join(' ') : attribute.value)}`).toSorted()
    const children = [...element.childNodes].filter(inner => inner.nodeType !== 8)
    const raw = element.localName === 'script' || element.localName === 'style'
    const inner = children.map((one, index) => walk(one, raw ? 'both' : edgeOf(index, children.length))).join('')

    return `<${element.localName} ${attributes.join(' ')}>${inner}</${element.localName}>`
  }

  const top = [...document.body.childNodes].filter(node => node.nodeType !== 8)

  return top.map((node, index) => walk(node, edgeOf(index, top.length))).join('')
}

async function render(source: string): Promise<string> {
  const file = join(scratch, `case-${cases++}.kay`)

  await Bun.write(file, source)

  const module = await import(file) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default({})).replace(MARKERS, '')
}

const SNIPPETS: Record<string, string> = {
  'a Tailwind UI hero': `<div class="relative isolate overflow-hidden bg-white px-6 py-24 sm:py-32 lg:px-8" id="hero">
  <div class="mx-auto max-w-2xl text-center">
    <h1 class="text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">Data to enrich your online business</h1>
    <p class="mt-6 text-lg leading-8 text-gray-600 w-1/2 py-0.5 md:w-[200px] hover:bg-gray-50 !mt-2">Anim aute id magna aliqua ad ad non deserunt sunt.</p>
    <div class="mt-10 flex items-center justify-center gap-x-6">
      <a href="#" class="rounded-md bg-indigo-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm" aria-label="Get started" data-track="cta">Get started</a>
      <a href="#" class="text-sm font-semibold leading-6 text-gray-900">Learn more <span aria-hidden="true">&rarr;</span></a>
    </div>
  </div>
</div>`,
  'svg icons': `<button type="button" class="inline-flex items-center">
  <svg class="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
    <g stroke="red"><circle cx="1" cy="1" r="2"/><line x1="0" y1="0" x2="1" y2="1" /></g>
  </svg>
  <span class="sr-only">Done</span>
</button>`,
  'inline elements': `<p class="text-sm">Read <a href="/terms" class="font-semibold">the terms</a> and <em>this</em>, <code>x = 1</code>, or <strong>that</strong>.</p>
<p><strong>Bold</strong> first, <i>italic</i> next</p>
<p>Plain <span class="a b"><b>nested</b> inline</span> text <br> after a break</p>`,
  'comments': `<!-- the header -->
<header>
  <!-- a nav
       over two lines -->
  <nav><a href="/">Home</a></nav>
  <!-- close */ and { braces } -->
</header>`,
  'script and style': `<style>
  .a > .b { color: red; content: "\\"" }
  @media (min-width: 40em) { .a { display: none } }
</style>
<script>
  if (1 < 2 && 3 > 2) { console.log(\`\${'x'}\`) }
</script>
<script src="/app.js" defer></script>
<script type="application/ld+json">{"@context":"https://schema.org","name":"A </b> thing"}</script>
<div>after</div>`,
  'boolean attributes': `<form action="/go" method="post">
  <input type="checkbox" name="a" checked disabled>
  <input type=text name=b required placeholder='Say "hi"'>
  <select name="c"><option value="1" selected>One</option><option value="2">Two</option></select>
  <textarea name="d" rows="3" readonly>Some text</textarea>
  <button type="submit" disabled>Send</button>
</form>`,
  'entities and braces': `<div title="Tom &amp; Jerry &quot;live&quot;">
  <p>Fish &amp; chips &lt;b&gt; &copy; 2024 &mdash; &#8364;5 &hellip;</p>
  <p>Spaced&nbsp;&nbsp;out and {curly} braces, 1 &gt; 0, a | b, #[not a tag]</p>
  <img src="/a.png" alt="A &amp; B" width=20 height=20>
</div>`,
  'lists and tables': `<ul role="list" class="divide-y">
  <li class="flex py-4"><img class="h-10 w-10 rounded-full" src="/p.jpg" alt=""><div class="ml-3"><p class="text-sm">Ada</p><p class="text-sm text-gray-500">ada@example.com</p></div></li>
  <li class="flex py-4">Second</li>
</ul>
<table><thead><tr><th scope="col">Name</th></tr></thead><tbody><tr><td>Ada</td></tr></tbody></table>`,
  'text beside elements': `<button class="a">Save <svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button>
<label>Name <input name="n"> and <br> more</label>
<p>Hello <img src="/a.png" alt=""> world</p>
<p>See <a href="/x">x</a> <button type="button">b</button></p>`,
  'markup inside attribute values': `<div data-bs-content="<b>Bold</b><br> and <!-- c -->" title='a < b'>x</div>`,
  'custom data attributes and aria': `<div data-controller="x" data-x-target='a "b"' aria-labelledby="t" hidden tabindex=0 style="color: red; margin: 0">text</div>`,
}

describe('kay fmt --from-html', () => {
  it.each(Object.entries(SNIPPETS))('turns %s into a template kay fmt leaves alone that renders the same HTML', async (_name, html) => {
    const { code, notes } = htmlToKay(html)

    expect(notes).toEqual([])
    expect(formatKay(code)).toEqual({ code, diagnostics: [] })
    expect(canonical(await render(code))).toBe(canonical(html))
  })

  it('writes the tag shorthand, id and classes it holds, and keeps class="..." for the rest', () => {
    const { code } = htmlToKay('<div id="a" class="flex w-1/2 py-0.5 md:w-[200px] hover:bg-x"><a href="/x" class="b">go</a></div>')

    expect(code).toBe('#a.flex.w-1/2.hover:bg-x(class="py-0.5 md:w-[200px]")\n  a.b(href="/x") go\n')
  })

  it('keeps the slot and key attributes of HTML and a script as the page wrote it', () => {
    expect(htmlToKay('<my-card><p slot="title" key="k">x</p></my-card>').code).toBe('my-card\n  p(slot="title" key="k") x\n')
    expect(htmlToKay('<script>const a = 1</script>').notes).toEqual([])
  })

  it('comments out a web component\'s slot, which kay\'s own slot cannot write, and keeps kay\'s in Astro', () => {
    const { code, notes } = htmlToKay('<my-card><slot name="a"></slot></my-card>')

    expect(code).toBe('my-card\n  // kay migrate: a web component\'s `<slot>`: kay\'s `slot` renders a wrapper\'s children, so it cannot write the element\n    <slot name="a"></slot>\n')
    expect(notes).toHaveLength(1)
    expect(formatKay(code).diagnostics).toEqual([])
    expect(migrateAstro('<slot />\n', { role: 'component', rewriteImport: () => undefined }).code).toBe('slot\n')
  })

  it('moves a document\'s head and body children into a head block and the template, noting its lang', () => {
    const { code, notes } = htmlToKay('<!doctype html>\n<html lang="fr">\n<head><meta charset="utf-8"><title>Hi</title></head>\n<body class="x"><main>Body</main></body>\n</html>')

    expect(code).toBe('head\n  meta(charset="utf-8")\n  title Hi\nmain Body\n')
    expect(notes.map(note => note.message.slice(0, note.message.indexOf(':')))).toEqual(['`lang` on html is "fr"', 'the attributes of body (class="x") have no place in kay, which writes body itself'])
  })

  it('lists an attribute a template cannot hold instead of dropping it silently', () => {
    const { code, notes } = htmlToKay('<div>\n<button @click="open = !open" :class="x" class="y">Open</button>\n</div>')

    expect(code).toBe('div\n  button.y Open\n')
    expect(notes.map(note => note.line)).toEqual([2, 2])
    expect(notes[0]!.message).toContain('@click')
  })

  it('lowers shouted tag names, reads a trailing slash of an unquoted value as part of it and notes whitespace it collapses', () => {
    expect(htmlToKay('<DIV><A HREF=/foo/>go</A></DIV>').code).toBe('div\n  a(HREF="/foo/") go\n')
    expect(htmlToKay('<pre>a\n  b</pre>').notes.map(note => note.message)).toEqual([expect.stringContaining('pre keeps its whitespace')])
    expect(htmlToKay('<p>&amp;lt; &amp;</p>').code).toBe('p {\'&\'}lt; &\n')
  })

  it('throws a MarkupError for HTML JSX cannot read, such as a tag left open', () => {
    expect(() => htmlToKay('<ul><li>One<li>Two</ul>')).toThrow(MarkupError)
  })

  it('shares its translation with kay migrate astro', () => {
    const markup = '<div class="a b"><p>Hi <b>there</b> {1 + 1}</p></div>\n'
    const astro = migrateAstro(markup, { role: 'component', rewriteImport: () => undefined })

    expect(astro.code).toBe('.a.b\n  p Hi #[b there] {1 + 1}\n')
    expect(htmlToKay('<div class="a b"><p>Hi <b>there</b></p></div>').code).toBe('.a.b\n  p Hi #[b there]\n')
  })
})

// Whitespace is what a browser renders, so the rendered text is compared with its spaces, which canonical() drops between elements.
function spaced(html: string): string {
  const { document } = new Window()

  document.body.innerHTML = html

  return document.body.textContent.replace(SPACE, ' ').trim()
}

describe('whitespace between inline siblings', () => {
  const CASES = ['<p><b>a</b>\n<i>b</i></p>', '<p>\n<a href="/">a</a>\n<a href="/b">b</a>\n</p>', '<div><button>a</button>\n<button>b</button></div>']

  it.each(CASES)('renders %j as the browser does', async (html) => {
    const { code } = htmlToKay(html)

    expect(formatKay(code)).toEqual({ code, diagnostics: [] })
    expect(spaced(await render(code))).toBe(spaced(html))
    expect(canonical(await render(code))).toBe(canonical(html))
  })

  it('adds none beside a block or a br, which render apart', async () => {
    for (const html of ['<p><b>a</b>\n<br>\n<i>b</i></p>', '<div><div>a</div>\n<span>b</span></div>', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'])
      expect(canonical(await render(htmlToKay(html).code))).toBe(canonical(html))
  })

  it('keeps the space on one line and in Astro, and none beside a block or a br', () => {
    expect(htmlToKay('<p><b>a</b>\n<i>b</i></p>').code).toBe('p #[b a] #[i b]\n')
    expect(migrateAstro('<p><b>a</b>\n<i>b</i></p>\n', { role: 'component', rewriteImport: () => undefined }).code).toBe('p #[b a] #[i b]\n')
    expect(htmlToKay('<div><button>a</button>\n<button>b</button></div>').code).toBe('div\n  button a\n  | {\' \'}\n  button b\n')
    expect(htmlToKay('<div><div>a</div>\n<span>b</span></div>').code).toBe('div\n  div a\n  span b\n')
    expect(htmlToKay('<p><b>a</b>\n<br>\n<i>b</i></p>').code).toBe('p\n  b a\n  br\n  i b\n')
  })
})

describe('kay fmt --from-html on the command line', () => {
  async function run(args: string[], stdin?: string): Promise<{ out: string, err: string, status: number }> {
    const child = Bun.spawn(['bun', CLI, 'fmt', ...args], { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { out, err, status }
  }

  it('prints the template of a file or of stdin, and its notes on stderr', async () => {
    const file = join(scratch, 'page.html')

    await Bun.write(file, '<div class="a"><button @click="x">Go</button></div>\n')

    const fromFile = await run(['--from-html', file])

    expect(fromFile.out).toBe('.a\n  button Go\n')
    expect(fromFile.err).toContain('line 1: the attribute @click')
    expect(fromFile.status).toBe(0)
    expect((await run(['--from-html'], '<p>Hi</p>')).out).toBe('p Hi\n')
    expect((await run(['--from-html', '-'], '<p>Hi</p>')).out).toBe('p Hi\n')
  })

  it('prints one JSON document under --format json', async () => {
    const { out } = await run(['--from-html', '--format', 'json'], '<p @x="1">Hi</p>')

    expect(JSON.parse(out)).toEqual({ code: 'p Hi\n', notes: [{ line: 1, message: expect.stringContaining('@x') }] })
  })

  it('fails on HTML it cannot read, and on --check or several files', async () => {
    expect((await run(['--from-html'], '<ul><li>a<li>b</ul>')).status).toBe(1)
    expect((await run(['--from-html', '--check'], '<p>a</p>')).status).toBe(1)
    expect((await run(['--from-html', 'a.html', 'b.html'])).status).toBe(1)
  })
})
