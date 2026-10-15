import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { renderMarkdown } from '../src/content'
import { sanitizedMarkdown } from '../src/runtime/markdown'
import { markdownHtml as islandMarkdown } from '../src/runtime/markdown.client'
import { markdownHtml } from '../src/runtime/markdown.server'

// GFM as a user writes it, with the edges where marked and Bun.markdown part by default.
const CORPUS = [
  '# Hello World\n\n## Getting *started* now!\n\n## Hello World\n\n### Café & co',
  '# a ![img *x*](/i) `code` <span>html</span> b_c Ça',
  '#',
  '## Hello World-1\n\n## Hello World\n\n## Hello World',
  '# __init__\n\n# A--B\n\n# -edge-\n\n# emoji 🙂 heading',
  'Setext\n===\n\nTwo\n---',
  'Some *em* and **strong** and `code` and ~~del~~ and ~one~ and a [link](https://x.y "t").',
  '**a**_b_ __c__ *d* ***e***',
  '- a\n- b\n  - c\n\n1. one\n2. two',
  '3. a\n4. b\n\n0. zero',
  '-\n- x',
  '- ```\n  c\n  ```\n- a\n  ```\n  c\n  ```',
  '- a\n\n- b',
  '* a\n* b\n\n  c',
  '1. a\n\n   b\n2. c',
  '- a\n  > q',
  '- a  \n- b',
  '- [ ] todo\n- [x] done\n- [X] upper',
  '- [ ] a\n\n- [x] b',
  '- [ ] a\n  - [x] nested\n- [ ]',
  '| a | b |\n|:--|--:|\n| 1 | 2 |',
  '| a |\n| - |',
  '| a | b |\n|:-:|---|\n| 1 |\n| x | y | z |',
  '| a | b |\n| - | - |\n| `c|d` | **e** |\n|   x   |y|',
  'a | b\n--|--\n1 | 2',
  '```ts\nconst a = 1 < 2\n```\n\n    indented',
  '```\n```',
  '~~~ js extra\nx & "y"\n~~~',
  '```\nunclosed',
  '> quoted\n> more\n>\n> # h\n> - l',
  'Visit https://example.com and www.example.org or a@b.co.',
  '<https://a.b> <a@b.co> http://a.b/c?d=e&f=g.',
  'raw <b>bold</b> and <div>block</div>',
  '<div>\nx\n</div>\n\n<div>x</div>\nnext',
  '<!-- c -->\n\npara',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<input type="checkbox" checked> <li></li>',
  '[x](javascript:alert(1)) ![y](javascript:alert(1))',
  'line one\nline two  \nline three\\\nfour',
  'a\n  b\n\tc  \nd',
  'a\n\n---\n\nb\n***\n___',
  '![alt](/x.png "title") ![a *b*](/x.png)',
  '[a](/a%20b) [b](<c d>) [c](/é) [d](/a"b) [e](/a "t\\"q")',
  '[r]\n\n[r]: /u "T"',
  'a & b < c > d "q" \'s\'',
  '&#39; &#x41; &amp; &nbsp; &lt;b&gt; &foo',
  '\\* \\& \\< \\_ `a<b` `` a`b ``',
  '[^1]\n\n[^1]: note',
  'text\n\n\n\nmore',
  '  lead\n\ntrailing   ',
  'Paragraph\n# Heading after',
]

// A reply as it streams in, every prefix of which an island renders.
const STREAMED = '# Release notes\n\nThis **release** brings *three* things:\n\n1. Faster `build`\n2. Tables:\n\n| name | size |\n|:-----|-----:|\n| entry | 9.7 KB |\n\n- [x] shipped\n- [ ] next\n  - nested ~~item~~\n\n> A quote\n> over lines\n\n```ts\nconst a = 1 < 2 && "b"\n```\n\n![logo](/logo.png)\n\nVisit https://example.com/a?b=c&d or www.kay.dev.  \nNew line.\n\n---\n\n## Release notes\n'

// Where the two part while a line is still coming: a URL marked links before it has a dot, or with a trailing `=`, and a task whose next line, a lone dash so far, makes its text a heading.
const UNFINISHED = /(?:https?:\/\/|www\.)\S*$|\[[ x]\] .*\n\s*-\s?$/

describe('markdownHtml', () => {
  it('renders in an island what it renders on the server, GFM and raw tags included', () => {
    for (const markdown of CORPUS)
      expect(islandMarkdown(markdown)).toBe(markdownHtml(markdown))
  })

  it('renders every prefix of a streamed reply as the server does', () => {
    const prefixes = Array.from({ length: STREAMED.length + 1 }, (_, length) => STREAMED.slice(0, length))

    for (const prefix of prefixes.filter(prefix => !UNFINISHED.test(prefix)))
      expect(islandMarkdown(prefix)).toBe(markdownHtml(prefix))
  })

  it('is renderMarkdown\'s HTML, sanitized, its headings plain', async () => {
    for (const markdown of CORPUS) {
      const { html } = await renderMarkdown(markdown)

      if (!html.includes('<h'))
        expect(markdownHtml(markdown)).toBe(sanitizedMarkdown(html))
    }

    for (const render of [markdownHtml, islandMarkdown])
      expect<string>(render('# Hi *x*\n\nSet\n===')).toBe('<h1>Hi <em>x</em></h1>\n<h1>Set</h1>\n')
  })

  it('leaves no link, source or tag that runs code, and no checkbox the private characters could forge', () => {
    const hostile = [
      '![x](javascript:alert(1)) ![y](data:text/html,x)',
      '[a](data:text/html,<script>alert(1)</script>) [b](&#106;avascript:alert(1)) [c](java&#x09;script:alert(1)) [d](vbscript:msgbox(1)) [e](//evil.example)',
      '<img src=x onerror=alert(1)> <svg onload=alert(1)><circle/></svg> <iframe src="https://evil.example"></iframe>',
      '<table><tr><td align="javascript:x" onclick="x()">c</td></tr></table>',
      '\uE001 a\n- \uE000 b\n- &#xE001; c\n- &#57344; d',
    ]

    for (const render of [markdownHtml, islandMarkdown]) {
      for (const markdown of hostile) {
        const html = render(markdown)

        expect(html).not.toMatch(/\s(?:href|src)=/)
        expect(html).not.toMatch(/<(?:script|svg|iframe)|\son\w+=|align="j/)
        expect(html).not.toContain('<input')
      }
    }
  })

  it('formats in an island in linear time, and shows Markdown it cannot format as it is written', () => {
    // The best of three runs, so a pause under load does not count; eight times the input takes about eight times as long, where marked unbounded took sixty-four.
    const best = (markdown: string) => Math.min(...Array.from({ length: 3 }, () => {
      const started = performance.now()

      islandMarkdown(markdown)

      return performance.now() - started
    }))
    const small = best('*a '.repeat(1000)) + best('_a ~b '.repeat(500))
    const large = best('*a '.repeat(8000)) + best('_a ~b '.repeat(4000))

    expect(large / small).toBeLessThan(24)
    expect<string>(islandMarkdown(`${'> '.repeat(10_000)}x`)).toStartWith('<p>&gt; &gt; ')
    expect<string>(islandMarkdown('**a**'.repeat(20_001))).toStartWith('<p>**a**')
  })

  it('keeps tables, images and task boxes, and drops what runs code or takes input', () => {
    const html = islandMarkdown('| a |\n|:-:|\n| ![x](/x.png "t") |\n\n- [x] done\n\n<script>alert(1)</script><input> [l](javascript:alert(1)) \uE000')

    expect(html).toContain('<th align="center">a</th>')
    expect(html).toContain('<img src="/x.png" alt="x" title="t">')
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked>done</li>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript')
    expect(html.match(/<input/g)).toHaveLength(1)
    expect(html).toContain('&#57344;')
    expect<string>(markdownHtml('<h2 id="x" class="y">t</h2>')).toBe('<h2>t</h2>\n')
  })

  it('leaves as written the named references Bun.markdown decodes, links a URL with parentheses it leaves as text, and misses a task whose text is a heading', () => {
    expect<string>(islandMarkdown('&copy;')).toBe('<p>&copy;</p>\n')
    expect<string>(markdownHtml('&copy;')).toBe('<p>©</p>\n')
    expect<string>(islandMarkdown('https://a.b/(c)')).toContain('<a href="https://a.b/(c)"')
    expect<string>(markdownHtml('https://a.b/(c)')).toBe('<p>https://a.b/(c)</p>\n')
    expect(islandMarkdown('- [ ] title\n  ---')).not.toContain('task-list-item')
    expect(markdownHtml('- [ ] title\n  ---')).toContain('task-list-item')
  })

  it('weighs only on the islands importing it', async () => {
    const base = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(base, { recursive: true })

    const root = await mkdtemp(join(base, 'markdown-'))

    try {
      await Promise.all(Object.entries({
        'src/note.kay': '---\nimport { signal } from \'kay\'\nimport { markdownHtml } from \'kay/markdown\'\n\nconst text = signal(\'# hi\')\n---\ntextarea(value={text()} onInput={event => text.set(event.currentTarget.value)})\ndiv(innerHTML={markdownHtml(text())})\n',
        'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
        'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\nimport Note from \'../note.kay\'\n---\nCounter\nNote\n',
      }).map(async ([path, content]) => Bun.write(join(root, path), content)))

      const { report } = await buildClient(root, { minify: true, report: 'modules' })
      const [note, counter] = report!.islands
      const marked = (modules: { name: string }[] | undefined) => (modules ?? []).some(module => module.name.includes('marked/lib'))

      expect(note!.file).toBe('src/note.kay')
      expect(marked(note!.modules)).toBe(true)
      expect(marked(counter!.modules)).toBe(false)
      expect(marked(report!.entry!.modules)).toBe(false)
      // marked and the renderer matching Bun.markdown's HTML, minified and gzipped.
      expect(note!.size.gzip - counter!.size.gzip).toBeLessThan(16_000)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
