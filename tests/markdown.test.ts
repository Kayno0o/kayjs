import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Window } from 'happy-dom'
import { clientDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { renderMarkdown } from '../src/content'
import { compileMarkdown } from '../src/content/markdown'
import { sanitizedMarkdown } from '../src/runtime/markdown'
import { markdownHtml as islandMarkdown } from '../src/runtime/markdown-render.client'
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

      // A task list's labels are written after the sanitizer, so only the unlabelled form round trips.
      if (!html.includes('<h') && !html.includes('task-list-item'))
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

      markdownHtml('<li class="task-list-item"><label><input type="checkbox" class="task-list-item-checkbox" disabled>'.repeat(5000))
      markdownHtml('- [ ] a\n  b\n'.repeat(5000))

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
    expect(html).toContain('<img src="/x.png" alt="x" title="t" loading="lazy">')
    expect<string>(markdownHtml('![x](/x.png)')).toBe('<p><img src="/x.png" alt="x" loading="lazy"></p>\n')
    expect(html).toContain('<li class="task-list-item"><label><input type="checkbox" class="task-list-item-checkbox" disabled checked>done</label></li>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript')
    expect(html.match(/<input/g)).toHaveLength(1)
    expect(html).toContain('&#57344;')
    expect<string>(markdownHtml('<h2 id="x" class="y">t</h2>')).toBe('<h2>t</h2>\n')
  })

  it('leaves as written the named references Bun.markdown decodes and misses a task whose text is a heading', () => {
    expect<string>(islandMarkdown('&copy;')).toBe('<p>&copy;</p>\n')
    expect<string>(markdownHtml('&copy;')).toBe('<p>©</p>\n')
    expect(islandMarkdown('- [ ] title\n  ---')).not.toContain('task-list-item')
    expect(markdownHtml('- [ ] title\n  ---')).toContain('task-list-item')
  })

  it('weighs on no island until the first Markdown is drawn', async () => {
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
      expect(marked(note!.modules)).toBe(false)
      expect(marked(counter!.modules)).toBe(false)
      expect(marked(report!.entry!.modules)).toBe(false)
      // The renderer is a chunk of its own that the first call fetches: the note island only carries the stand-in drawing the text as written.
      expect(note!.size.gzip - counter!.size.gzip).toBeLessThan(600)
      expect((await readdir(clientDir(root))).some(file => file.startsWith('markdown-render.client-'))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('markdownHtml autolinks', () => {
  const AUTOLINKS = [
    '[[https://x.y/?a=1&b=2]]',
    '[https://x.y] (https://x.y/a) {https://x.y}',
    'See https://x.y/a, https://x.y/b. And https://x.y/c! Or https://x.y/d?',
    'https://x.y/?a=1&b=2 and https://x.y/?a=1&amp;b=2 and https://x.y/?a=1&#38;b=2',
    '*https://x.y/a* and _https://x.y/b_ and **see https://x.y/c now** and *a https://x.y/d b*.',
    'www.x.y/a (www.x.y) www.x.y.',
    'a@b.co, mail a@b.co. (a@b.co) <a@b.co>',
    'mailto:a@b.co and a@b.co: and a@b.co=',
    'xhttps://x.y a.https://x.y/a /https://x.y/a "https://x.y/a" \'https://x.y/a\'',
    'https://x.y/a_ https://x.y/a- https://x.y/a:b https://x.y/a=b http://x ftp://x.y/a',
    'https://x.y/a_b https://x.y/a-b https://x.y/a~b https://x.y/?q=(a) https://x.y/(a)',
    'https://x.y/a#frag. https://x.y/a?b=c;d=e https://x.y/a/b/ https://x.y/~u/',
    '[a](https://x.y) https://x.y `https://x.y` <https://x.y>',
    '> https://x.y/a.\n\n- https://x.y/b,\n- [ ] https://x.y/c\n\n# https://x.y/d\n\n| https://x.y/e |\n|-|',
  ]

  it('links a URL where Bun.markdown does, on the server and in an island', () => {
    for (const markdown of AUTOLINKS)
      expect(islandMarkdown(markdown)).toBe(markdownHtml(markdown))
  })

  // Bun.markdown links the closing `*` of `**url**` with the URL (oven-sh/bun#43980), which the island does not copy: when Bun fixes it this fails, and this test and the line of the docs naming the bug can go.
  it('still differs from Bun.markdown where it links a URL with the marks of its own emphasis', () => {
    expect<string>(markdownHtml('**https://example.com/a**')).toContain('href="https://example.com/a*"')
    expect<string>(islandMarkdown('**https://example.com/a**')).toContain('href="https://example.com/a"')
  })

  it('links what Bun.markdown links, and reads a hostile text in bounded time', () => {
    expect<string>(islandMarkdown('[[https://x.y/?a=1&b=2]]')).toContain('<a href="https://x.y/?a=1&amp;b=2"')
    expect<string>(islandMarkdown('a@b.co')).toContain('<a href="mailto:a@b.co"')
    expect<string>(islandMarkdown('xhttps://x.y')).not.toContain('<a')

    const started = performance.now()

    islandMarkdown('*www.a/x*'.repeat(11_000))
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it('cuts a URL beside any one character as Bun.markdown does', () => {
    const bases = ['https://x.y', 'https://x.y/a', 'https://x.y/?q=1', 'https://x.y#f', 'www.x.y/a', 'see https://x.y/a', '(https://x.y/a', '[https://x.y/a', 'a@b.co', 'foo.a@b.co', 'x-a@b.co', '1a@b.co']

    for (const base of bases) {
      for (const char of '.,!?;:_-~=&%+$#/()[]*\'"@<>{}|^\\` ') {
        for (const tail of ['', 'b', ' b', 'b)', ']]'])
          expect(islandMarkdown(`${base}${char}${tail}`)).toBe(markdownHtml(`${base}${char}${tail}`))
      }
    }
  })

  it('draws the app\'s inline syntax around a URL the same on both sides', () => {
    const inline = [{ pattern: /\[\[([^\]]+)\]\]/, render: ([, name]: string[]) => ({ text: name!, href: `#note:${encodeURIComponent(name!)}` }) }]

    for (const markdown of ['[[https://x.y/?a=1&b=2]] and [[a]] https://x.y/b.', '*[[https://x.y]]* ([[b]])'])
      expect(islandMarkdown(markdown, { inline })).toBe(markdownHtml(markdown, { inline }))
  })
})

describe('task list checkboxes', () => {
  const TASKS = '- [x] done **bold**\n- [ ] wraps over\n  two lines\n- [ ] next [link](/a)\n  - [ ] nested\n- plain\n\n- [ ] loose\n\n  more\n\n1. [ ] ordered `c`\n'

  it('names each box by its item text on the server, in an island and in an entry body', async () => {
    const entry = (await renderMarkdown(TASKS)).html

    for (const html of [markdownHtml(TASKS), islandMarkdown(TASKS), entry]) {
      expect(html.match(/<input/g)).toHaveLength(6)
      expect(html.match(/<label><input/g)).toHaveLength(6)
      expect(html).toContain('disabled>wraps over\ntwo lines</label>')
      expect(html).toContain('<label><input type="checkbox" class="task-list-item-checkbox" disabled checked>done <strong>bold</strong></label>')
      expect(html).toContain('<p><label><input type="checkbox" class="task-list-item-checkbox" disabled>loose</label></p>')
      expect(html).toContain('<li class="task-list-item"><label><input type="checkbox" class="task-list-item-checkbox" disabled>nested</label></li>')
    }

    expect(islandMarkdown(TASKS)).toBe(markdownHtml(TASKS))
  })

  it('leaves axe no label violation on a body with a task list', async () => {
    const window = new Window()
    const scope = globalThis as unknown as Record<string, unknown>

    Object.assign(scope, { window, document: window.document, Node: window.Node, Element: window.Element })

    const axe = (await import('axe-core')).default
    const violations = async (html: string) => {
      window.document.body.innerHTML = `<main>${html}</main>`

      return (await axe.run(window.document.body as unknown as Element, { runOnly: ['label'] })).violations.length
    }

    try {
      expect(await violations(markdownHtml(TASKS))).toBe(0)
      expect(await violations((await renderMarkdown(TASKS)).html)).toBe(0)
      expect(await violations('<ul><li><input type="checkbox" disabled>unnamed</li></ul>')).toBe(1)
    }
    finally {
      window.close()

      for (const key of ['window', 'document', 'Node', 'Element'])
        Reflect.deleteProperty(scope, key)
    }
  })

  it('hides the box of an item with no text from a screen reader, and keeps a hostile line quick', () => {
    const html = markdownHtml('- [ ]\n  - [ ] sub')

    expect(html).not.toContain('<label><input type="checkbox" class="task-list-item-checkbox" disabled></label>')
    expect(html).toContain('<li class="task-list-item"><input aria-hidden="true" type="checkbox" class="task-list-item-checkbox" disabled>')
    expect(html).toContain('<label><input type="checkbox" class="task-list-item-checkbox" disabled>sub</label>')

    const started = performance.now()

    markdownHtml('- [ ] a <b>'.repeat(5000))
    markdownHtml('- [ ] a\n\n'.repeat(3000))
    expect(performance.now() - started).toBeLessThan(3000)
  })
})

describe('heading ids', () => {
  const idsOf = async (markdown: string) => (await compileMarkdown(markdown, 1, { headingLinks: true })).headings.map(heading => heading.id)

  it('keep the letters of an accented or CJK title, and are never empty', async () => {
    expect(await idsOf('## Été & Café\n\n## 日本語 の 見出し\n\n## 🙂\n\n## --')).toEqual(['été-café', '日本語-の-見出し', 'heading', 'heading-1'])
  })

  it('are unique in the page, the first keeping the id it has always had', async () => {
    const compiled = await compileMarkdown('## A\n\n## Été\n\n## A\n\n## A 1\n\n## été', 1, { headingLinks: true })
    const html = compiled.segments.join('')

    expect(compiled.headings.map(heading => heading.id)).toEqual(['a', 'été', 'a-1', 'a-1-1', 'été-1'])
    expect(html).toContain('<h2 id="a-1-1"><a href="#a-1-1">A 1</a></h2>')
  })

  it('stay Bun\'s for a title of ASCII letters, a typographic apostrophe included', async () => {
    expect(await idsOf('## Don’t stop\n\n## It’s – fine')).toEqual(['dont-stop', 'its-fine'])
  })

  it('stay Bun\'s for an ASCII title', async () => {
    expect(await idsOf('# Hello, World! 2\n\n## a_b--c\n\n## `code` x\n\n## Hello, World! 2')).toEqual(['hello-world-2', 'ab-c', 'code-x', 'hello-world-2-1'])
  })
})

describe('the runtime renderer\'s headings', () => {
  it('carry no id, on the server and in an island, so no id scheme can differ from compileMarkdown\'s', () => {
    const source = '## Été & Café\n\n## 日本語\n\n## --\n\n## A\n\n## A'

    expect(markdownHtml(source)).not.toContain('id=')
    expect(islandMarkdown(source)).not.toContain('id=')
  })
})

describe('markdownHtml fence language', () => {
  it('keeps language-* on code, in an island as on the server', () => {
    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('```ts\nconst a = 1\n```')).toBe('<pre><code class="language-ts">const a = 1\n</code></pre>\n')
      expect<string>(render('```c++\nx\n```')).toContain('<code class="language-c++">')
      expect<string>(render('```\nx\n```')).toBe('<pre><code>x\n</code></pre>\n')
    }
  })

  it('drops any other class a user writes on code', () => {
    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('<code class="fixed inset-0">x</code>')).not.toContain('class')
      expect<string>(render('<code class="language-js fixed">x</code>')).not.toContain('class')
      expect<string>(render('<code class="language-x&quot; onmouseover=&quot;y">x</code>')).not.toContain('onmouseover')
      expect<string>(render('<code class="language-js">x</code>')).toContain('class="language-js"')
    }
  })
})

describe('markdownHtml inline extensions', () => {
  const wiki = { pattern: /\[\[([^\]]+)\]\]/, render: ([, name]: string[]) => ({ text: name!, href: `#note:${encodeURIComponent(name!)}` }) }

  it('draws a match as a link, the same on the server and in an island', () => {
    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('See [[My note]] and [[b]].', { inline: [wiki] })).toBe('<p>See <a href="#note:My%20note" rel="nofollow ugc">My note</a> and <a href="#note:b" rel="nofollow ugc">b</a>.</p>\n')
      expect<string>(render('See [[b]]')).toBe('<p>See [[b]]</p>\n')
    }

    for (const markdown of ['a [[x]] *b [[y]]* | c', '- [[x]]\n- [ ] [[y]]\n\n> [[z]]'])
      expect(islandMarkdown(markdown, { inline: [wiki] })).toBe(markdownHtml(markdown, { inline: [wiki] }))
  })

  it('leaves code, fences and links alone', () => {
    for (const render of [markdownHtml, islandMarkdown]) {
      const html = render('`[[a]]`\n\n```\n[[b]]\n```\n\n[[[c]](/x)](/y) <a href="/z">[[d]]</a>', { inline: [wiki] })

      expect(html).toContain('<code>[[a]]</code>')
      expect(html).toContain('[[b]]\n</code>')
      expect(html).not.toContain('#note:a')
      expect(html).not.toContain('#note:b')
      expect(html).not.toContain('#note:d')
    }
  })

  it('escapes what the hook returns as text and gives its groups as plain text', () => {
    const inline = [{ pattern: /\{\{(.+?)\}\}/, render: ([, name]: string[]) => `<img src=x onerror=alert(1)> ${name}` }]

    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('{{a & b}}', { inline })).toBe('<p>&lt;img src=x onerror=alert(1)&gt; a &amp; b</p>\n')
      expect<string>(render('{{&lt;b&gt;}}', { inline })).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &lt;b&gt;</p>\n')
    }
  })

  it('sanitizes a link the hook builds from the text', () => {
    const inline = [{ pattern: /\[\[(.+?)\]\]/, render: ([, target]: string[]) => ({ text: '"><script>x</script>', href: target! }) }]

    for (const render of [markdownHtml, islandMarkdown]) {
      const html = render('[[javascript:alert(1)]] [[/ok" onclick="x]] [[/p?q=1&r=2]]', { inline })

      expect(html).not.toContain('javascript:')
      expect(html).not.toContain('onclick')
      expect(html).not.toContain('<script')
      expect(html).toContain('href="/p?q=1&amp;r=2"')
    }
  })

  it('tries the extensions in order and leaves what its hook declines', () => {
    const inline = [{ pattern: /@(\w+)/, render: ([, name]: string[]) => name === 'no' ? undefined : `<${name}>` }, { pattern: /#(\w+)/, render: ([, tag]: string[]) => ({ text: `#${tag}`, href: `/tags/${tag}` }) }]

    expect<string>(markdownHtml('@no @yes #t', { inline })).toBe('<p>@no &lt;yes&gt; <a href="/tags/t" rel="nofollow ugc">#t</a></p>\n')
    expect<string>(markdownHtml('@no @yes #t', { inline: [{ pattern: /x*/, render: () => 'z' }] })).toBe('<p>@no @yes #t</p>\n')
  })
})

describe('markdownHtml inline extensions on hostile text', () => {
  it('never cuts an entity: a match inside &amp; or &quot; is left', () => {
    const inline = [{ pattern: /amp|quot|gt|#(\d+)/, render: ([word]: string[]) => ({ text: word!, href: '/g' }) }]

    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('Tom & Jerry say "hi" a > b ', { inline })).not.toContain('<a')
      expect<string>(render('Tom & Jerry say "hi"', { inline })).toBe('<p>Tom &amp; Jerry say &quot;hi&quot;</p>\n')
    }
  })

  it('lets a throwing hook throw on the server and in an island, and leaves an answer of no shape as written', () => {
    const boom = [{ pattern: /xx/, render: () => {
      throw new Error('boom')
    } }]

    for (const render of [markdownHtml, islandMarkdown])
      expect(() => render('xx', { inline: boom })).toThrow('boom')

    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('xx', { inline: [{ pattern: /xx/, render: () => null as never }] })).toBe('<p>xx</p>\n')
      expect<string>(render('xx', { inline: [{ pattern: /xx/, render: () => ({ text: 'a' }) as never }] })).toBe('<p>xx</p>\n')
    }
  })

  it('draws no href for a protocol-relative or data address, and works with a lookbehind pattern', () => {
    const link = (pattern: RegExp) => [{ pattern, render: ([, to]: string[]) => ({ text: 't', href: to! }) }]

    for (const render of [markdownHtml, islandMarkdown]) {
      expect<string>(render('[[//evil.com]] [[data:text/html,x]]', { inline: link(/\[\[(.+?)\]\]/) })).toBe('<p><a>t</a> <a>t</a></p>\n')
      expect<string>(render('a [[/x]]', { inline: link(/(?<=a )\[\[(.+?)\]\]/) })).toContain('<a')
    }
  })
})
