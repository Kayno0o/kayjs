import { describe, expect, it } from 'bun:test'
import { collectHead } from '../src/runtime/head'
import { attribute, child, element, head, loop, merge, omit, selectOptions } from '../src/runtime/html'
import { sanitizeHtml } from '../src/runtime/sanitize'

describe('child values', () => {
  it('escape text, keep numbers and rendered markup, and drop null, undefined and booleans', () => {
    expect(child(['a < b & c', 1, null, undefined, true, false, { t: '<b>x</b>' }, () => '<i>'])).toBe('a &lt; b &amp; c1<b>x</b>&lt;i>')
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

    expect(rendered).toEqual({ prelude: '', html: '<link rel="stylesheet" href="/a.css"><meta name="description" content="page"><title>Page &amp; co</title>', charset: false, viewport: false })
  })

  it('tells whether the page set its own charset and viewport, and puts the charset first', () => {
    const { head: rendered } = collectHead(() => head([{ tag: 'meta', props: { name: 'viewport', content: 'width=1' } }, { tag: 'meta', props: { charset: 'utf-8' } }]))

    expect(rendered).toEqual({ prelude: '<meta charset="utf-8"><meta name="viewport" content="width=1">', html: '', charset: true, viewport: true })
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
