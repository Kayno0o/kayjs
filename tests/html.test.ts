import { describe, expect, it } from 'bun:test'
import { collectHead } from '../src/runtime/head'
import { child, element, head, loop, merge, omit, selectOptions } from '../src/runtime/html'

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
    expect(loop(['a', 'b'], (item, index) => `${item}${index}`)).toBe('a0b1')
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

    expect(rendered).toEqual({ html: '<link rel="stylesheet" href="/a.css"><meta name="description" content="page"><title>Page &amp; co</title>', charset: false, viewport: false })
  })

  it('tells whether the page set its own charset and viewport, and puts the charset first', () => {
    const { head: rendered } = collectHead(() => head([{ tag: 'meta', props: { name: 'viewport', content: 'width=1' } }, { tag: 'meta', props: { charset: 'utf-8' } }]))

    expect(rendered).toEqual({ html: '<meta charset="utf-8"><meta name="viewport" content="width=1">', charset: true, viewport: true })
  })

  it('sets nothing outside a render', () => {
    head([{ tag: 'title', props: { children: 'Lost' } }])

    expect(collectHead(() => null).head.html).toBe('')
  })
})
