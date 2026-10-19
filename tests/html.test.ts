import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { collectHead } from '../src/runtime/head'
import { attribute, child, dynamic, element, head, html, loop, merge, omit, raw, selectOptions, spreadAttributes } from '../src/runtime/html'
import { sanitizeHtml, trustHtml } from '../src/runtime/sanitize'

describe('child values', () => {
  it('escape text, keep numbers and rendered markup, and drop null, undefined and booleans', () => {
    expect(child(['a < b & c', 1, null, undefined, true, false, html('<b>x</b>'), () => '<i>'])).toBe('a &lt; b &amp; c1<b>x</b>&lt;i>')
  })
})

describe('markup only a render vouches for', () => {
  const forged = JSON.parse('{"t":"<img src=x onerror=alert(1)>"}') as object

  it('escapes a plain object with a `t` string, as a child, in an array, nested and in raw text', () => {
    expect(child(forged)).toBe('')
    expect(child([html('<b>ok</b>'), [forged, [html('<i>deep</i>')]], forged])).toBe('<b>ok</b><i>deep</i>')
    expect(element('div', [], () => child(forged)).t).toBe('<div></div>')
    expect(element('div', [{ children: forged }]).t).toBe('<div></div>')
    expect(raw([forged, html('<b>'), 'a</script>'])).toBe('<b>a<\\/script>')
  })

  it('does not trust a render copied through JSON or a spread of a plain object', () => {
    expect(child(JSON.parse(JSON.stringify(html('<b>x</b>'))))).toBe('')
    expect(child({ t: '<b>x</b>' })).toBe('')
    expect(child({ ...html('<b>x</b>') })).toBe('<b>x</b>')
  })

  it('keeps what a component, an element and a dynamic tag render as markup', () => {
    expect(child(element('p', [{ title: 'a' }], () => 'x'))).toBe('<p title="a">x</p>')
    expect(child(dynamic('b', {}))).toBe('<b></b>')
    expect(child(forged)).not.toContain('<img')
  })
})

describe('element', () => {
  it('takes an attribute set by several sources from the last one, in its place', () => {
    expect(element('p', [{ class: 'from', title: 't', id: 'a' }, { title: 'own' }, { class: ['a', 'from'] }]).t).toBe('<p id="a" title="own" class="a from"></p>')
  })

  it('renders content from the lines under the tag before a children or innerHTML property', () => {
    expect(element('div', [{ innerHTML: '<b>x</b>' }]).t).toBe('<div><b>x</b></div>')
    expect(element('div', [{ children: '<b>' }]).t).toBe('<div>&lt;b></div>')
    expect(element('div', [{ innerHTML: '<b>x</b>' }], () => 'own').t).toBe('<div>own</div>')
    expect(element('br', [{ class: 'x', children: 'never' }]).t).toBe('<br class="x">')
  })

  it('leaves out handlers, refs and empty values', () => {
    expect(element('button', [{ onClick: Number, ref: String, disabled: true, hidden: false, title: null, value: '' }]).t).toBe('<button disabled value></button>')
    expect(element('details', [{ open: true, ontoggle: 'x()' }]).t).toBe('<details open></details>')
  })

  it('leaves out a function that is no class or style, as the browser does, spread or not', () => {
    const secret = 'token'
    const format = () => `${secret}x`

    expect(element('div', [{ format, title: 'a' }]).t).toBe('<div title="a"></div>')
    expect(element('div', [spreadAttributes({ format, 'data-x': format, 'title': 'a' })]).t).toBe('<div title="a"></div>')
    expect(attribute('data-format', format)).toBe('')
    expect(element('input', [{ 'value': format, 'aria-describedby': format }]).t).not.toContain('token')
    expect((dynamic('div', { format }) as { t: string }).t).toBe('<div></div>')
  })

  it('leaves out a handler in any case, and a name HTML would read as several attributes', () => {
    expect(element('div', [{ 'ONCLICK': 'alert(1)', 'OnMouseOver': 'alert(1)', 'x" onfocus="alert(1)': 1, 'a b': 1, 'a=b': 1, 'a>': 1, 'data-ok': 1, 'xlink:href': '/a' }]).t).toBe('<div data-ok="1" xlink:href="/a"></div>')
  })

  it('refuses a dynamic tag HTML would read as more than a name', () => {
    expect((dynamic('my-tag', { title: 'a' }) as { t: string }).t).toBe('<my-tag title="a"></my-tag>')
    expect(() => dynamic('img src=x onerror=alert(1)', {})).toThrow('is not an element name')
    expect(() => dynamic('a>', {})).toThrow('is not an element name')
    expect((dynamic('iframe', { SRCDOC: '<script>alert(1)</script>', onen: 'x', title: 'a' }) as { t: string }).t).toBe('<iframe title="a"></iframe>')
  })

  it('takes from a spread only attributes, handlers as functions, and no srcdoc, getters kept', () => {
    const handler = () => undefined
    let reads = 0
    const kept = spreadAttributes({ 'title': 't', 'onClick': handler, 'ONCLICK': 'alert(1)', 'onmouseover': 'alert(1)', 'innerHTML': trustHtml('<b>icon</b>'), 'SrcDoc': '<script>', 'x" y': 1, 'open': true, get 'live'() {
      return ++reads
    } })

    expect(Object.keys(kept)).toEqual(['title', 'onClick', 'innerHTML', 'open', 'live'])
    expect(kept.onClick).toBe(handler)
    expect([kept.live, kept.live]).toEqual([1, 2])
    expect(spreadAttributes(null)).toBeNull()
  })
})

describe('bound URLs', () => {
  it('neutralise one that would run script, as a browser reads it, and leave every other alone', () => {
    expect(attribute('href', 'javascript:alert(1)')).toBe(' href="unsafe:javascript:alert(1)"')
    expect(attribute('href', ' \tJava\nScript:alert(1)')).toBe(' href="unsafe: \tJava\nScript:alert(1)"')
    expect(attribute('formaction', 'VBScript:x')).toBe(' formaction="unsafe:VBScript:x"')
    expect(attribute('src', 'data: text/html,<p>')).toBe(' src="unsafe:data: text/html,&lt;p>"')
    expect(attribute('HREF', 'javascript:x')).toBe(' HREF="unsafe:javascript:x"')
    expect(attribute('formAction', 'javascript:x')).toBe(' formAction="unsafe:javascript:x"')
    expect(element('a', [{ href: 'javascript:x' }]).t).toBe('<a href="unsafe:javascript:x"></a>')

    for (const [name, value] of [['href', 'https://example.com/javascript:x'], ['href', '/javascript:x'], ['title', 'javascript:x'], ['src', 'data:image/png;base64,AA']])
      expect(attribute(name!, value)).toBe(` ${name}="${value}"`)
  })
})

describe('props', () => {
  it('merge and omit keep getters, so children render only when read', () => {
    let reads = 0
    const props = merge({ a: 1 }, { get children() {
      reads++

      return 'c'
    } })
    const rest = omit(props, 'a')

    expect(reads).toBe(0)
    expect(Object.keys(rest)).toEqual(['children'])
    expect((rest as { children: string }).children).toBe('c')
    expect(reads).toBe(1)
  })
})

describe('loop', () => {
  it('renders each row with its index, and the fallback when there is nothing to list', () => {
    expect(loop(['a', 'b'], (item, index) => `${item as string}${index as number}`)).toBe('a0b1')
    expect(loop(null, () => 'x', () => 'none')).toBe('none')
    expect(loop([], () => 'x')).toBe('')
  })
})

describe('selectOptions', () => {
  it('marks the options whose value or text matches', () => {
    expect(selectOptions(['b', 'C'], '<option value="a">A</option><option value="b">B</option><option> C </option>')).toBe('<option value="a">A</option><option value="b" selected>B</option><option selected> C </option>')
  })
})

describe('head', () => {
  it('lets a later group replace a tag of the same identity, and renders a stylesheet once', () => {
    const { head: rendered } = collectHead(() => {
      head([{ tag: 'title', props: { children: 'Layout' } }, { tag: 'meta', props: { name: 'description', content: 'layout' } }, { tag: 'link', props: { rel: 'stylesheet', href: '/a.css' } }])
      head([{ tag: 'title', props: { children: 'Page & co' } }, { tag: 'meta', props: { name: 'description', content: 'page' } }, { tag: 'link', props: { rel: 'stylesheet', href: '/a.css' } }])
    })

    expect(rendered).toEqual({ prelude: '', styles: '<link rel="stylesheet" href="/a.css">', html: '<meta name="description" content="page"><title>Page &amp; co</title>', root: '', charset: false, viewport: false })
  })

  it('hands the browser the template and the site title an island\'s title goes on setting, and nothing when no island sets it', () => {
    const options = { defaults: [{ tag: 'title', props: { children: 'Site' } }], titleTemplate: '%s | Site' }
    const island = collectHead(() => head([{ tag: 'title', props: { island: true, children: 'Room' } }]), options).head
    const plain = collectHead(() => head([{ tag: 'title', props: { children: 'Room' } }]), options).head
    const bare = collectHead(() => head([{ tag: 'title', props: { island: true, children: 'Room' } }])).head

    expect(island.html).toBe('<meta name="kay-title" content="{&quot;template&quot;:&quot;%s | Site&quot;,&quot;fallback&quot;:&quot;Site&quot;}"><title>Room | Site</title>')
    expect(plain.html).toBe('<title>Room | Site</title>')
    expect(bare.html).toBe('<title>Room</title>')
  })

  it('leaves a function prop out of a tag and of the root attributes', () => {
    const format = () => 'secret'
    const { head: rendered } = collectHead(() => head([{ tag: 'meta', props: { name: 'x', content: 'a', format } }, { tag: 'html', props: { 'lang': 'fr', format, 'data-x': format } }]))

    expect(rendered.html).toBe('<meta name="x" content="a">')
    expect(rendered.root).not.toContain('secret')
    expect(rendered.root).not.toContain('=>')
  })

  it('gathers the stylesheets and inline styles apart, for the component stylesheets to follow them', () => {
    const { head: rendered } = collectHead(() => head([{ tag: 'link', props: { rel: 'preload', href: '/a.woff2', as: 'font' } }, { tag: 'style', props: { children: 'p{color:red}' } }, { tag: 'link', props: { rel: 'stylesheet', href: '/reset.css' } }]))

    expect(rendered.styles).toBe('<link rel="stylesheet" href="/reset.css"><style>p{color:red}</style>')
    expect(rendered.html).toBe('<link rel="preload" href="/a.woff2" as="font">')
  })

  it('tells whether the page set its own charset and viewport, and puts the charset first', () => {
    const { head: rendered } = collectHead(() => head([{ tag: 'meta', props: { name: 'viewport', content: 'width=1' } }, { tag: 'meta', props: { charset: 'utf-8' } }]))

    expect(rendered).toEqual({ prelude: '<meta charset="utf-8"><meta name="viewport" content="width=1">', styles: '', html: '', root: '', charset: true, viewport: true })
  })

  it('neutralises a script URL and a handler in any case, and keeps script text from ending or opening a comment', () => {
    const { head: rendered } = collectHead(() => head([{ tag: 'link', props: { 'rel': 'canonical', 'HREF': ' javascript:alert(1)', 'ONLOAD': 'alert(1)', 'x" y': 1 } }, { tag: 'script', props: { children: 'var a = "<!--<script>"; var b = "</SCRIPT>"' } }]))

    expect(rendered.html).toBe('<link rel="canonical" href="unsafe: javascript:alert(1)"><script>var a = "<\\!--<script>"; var b = "<\\/SCRIPT>"</script>')
  })

  it('writes no handler on the html tag, and keeps a JSON script such as an import map valid', () => {
    const { head: rendered } = collectHead(() => head([{ tag: 'html', props: { class: 'dark', OnLoad: 'alert(1)' } }, { tag: 'script', props: { type: 'importmap', children: '{"imports":{"a":"/<!--</script>"}}' } }]))

    expect(rendered.root).toBe(' class="dark"')
    expect(rendered.html).toContain('<script type="importmap">{"imports":{"a":"/\\u003c!--\\u003c/script>"}}</script>')
  })

  it('sets nothing outside a render', () => {
    head([{ tag: 'title', props: { children: 'Lost' } }])

    expect(collectHead(() => null).head.html).toBe('')
  })
})

describe('sanitizeHtml', () => {
  it('keeps formatting, balanced, and a link to the web, a mailbox or the site', () => {
    expect(String(sanitizeHtml('<p>Hi <B class="x">you</B><br/><a href="https://a.example/?x=1&amp;y=2" onclick="x()">a</a> <a href=\'/p\'>p</a> <a href="mailto:a@b.example">m</a></p>'))).toBe('<p>Hi <b>you</b><br><a href="https://a.example/?x=1&amp;y=2" rel="nofollow ugc">a</a> <a href="/p" rel="nofollow ugc">p</a> <a href="mailto:a@b.example" rel="nofollow ugc">m</a></p>')
    expect(String(sanitizeHtml('<ul><li><em>a</li></ul></strong> & &amp; &eacute; 1 < 2'))).toBe('<ul><li><em>a</em></li></ul> &amp; &amp; &eacute; 1 &lt; 2')
    expect(String(sanitizeHtml('<p><b>open'))).toBe('<p><b>open</b></p>')
  })

  it('drops what loads, runs or styles, and links anywhere else, whatever the spelling', () => {
    expect(String(sanitizeHtml('<script>alert(1)</script><style>*{}</style><!-- c --><img src=x onerror=alert(1)><div style="position:fixed">t</div><svg><script>x</script></svg>'))).toBe('t')
    expect(String(sanitizeHtml('<scr<b>ipt>alert(1)</scr</b>ipt>'))).toBe('&lt;scr<b>ipt>alert(1)&lt;/scr</b>ipt>')
    expect(String(sanitizeHtml('<b>a<!-- c --></b><script>x<style>y</style>z'))).toBe('<b>a</b>xz')

    for (const href of ['javascript:alert(1)', 'java&#115;cript:alert(1)', 'javascript&colon;x', '//evil.example', '/\\evil.example', ' javascript:x', 'data:text/html,x'])
      expect(String(sanitizeHtml(`<a href="${href}">x</a>`))).toBe('<a>x</a>')
  })

  it('reads a megabyte of unclosed tags in one pass', () => {
    const started = performance.now()

    for (const opener of ['<script>', '<!--', '<style>x</style'])
      sanitizeHtml(opener.repeat(1_000_000 / opener.length))

    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('gives markup it already gave back as it is', () => {
    const once = sanitizeHtml('<p>a <a href="/x">b</a> &amp; <i>c</p>')

    expect(String(sanitizeHtml(once))).toBe(once)
  })
})

describe('trustHtml', () => {
  it('bundles none of sanitizeHtml\'s defaults into an island reaching it alone', async () => {
    const entry = `import { trustHtml } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/sanitize'))}\nconsole.log(trustHtml('<b>x</b>'))\n`
    const build = await Bun.build({ entrypoints: ['entry.ts'], files: { 'entry.ts': entry }, target: 'browser', minify: true })
    const code = await build.outputs[0]!.text()

    expect(code).toContain('<b>x</b>')
    expect(code).not.toContain('blockquote')
  })
})
