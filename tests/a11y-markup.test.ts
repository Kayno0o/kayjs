import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const CODES = new Set(['empty-heading', 'anchor-is-valid', 'redundant-role', 'unsupported-aria', 'multiple-h1', 'no-access-key', 'click-without-key', 'interactive-tabindex'])

function found(source: string) {
  return compileKay(source, 'list.kay', { check: true }).diagnostics.filter(d => CODES.has(d.code ?? '')).map(d => `${d.code} ${source.slice(d.start, d.end)}`)
}

describe('markup a11y lints', () => {
  it('reports a heading with nothing to read, leaving text, a name, an expression, a component and a block', () => {
    expect(found('h2\nh3\n  svg(aria-hidden="true")\nh4 Plans\nh5 {title}\nh6(aria-label="Menu")\nh2\n  Icon\nh3\n  if open\n    | x\nh4\n  img(src="/a.png" alt="")\nh1({...rest})\n')).toEqual(['empty-heading h2', 'empty-heading h3', 'empty-heading h4'])
  })

  it('reports an anchor with no destination, leaving a link, a role, a name, a handler, a spread and a component', () => {
    expect(found('a Read\na(href="#") b\na(href="") c\na(href="javascript:void(0)") d\na(href="/x") e\na(href={url}) f\na(role="link" aria-disabled="true") g\na(name="top") h\nsvg\n  a(xlink:href="/x")\n    text x\na(onClick={go}) i\na({...rest}) j\nLink k\n')).toEqual(['anchor-is-valid a', 'anchor-is-valid #', 'anchor-is-valid ', 'anchor-is-valid javascript:void(0)'])
  })

  it('reports a role the element already has, keeping the list roles that restore a list in Safari', () => {
    expect(found('button(role="button") a\nnav(role="navigation" aria-label="Main")\na(href="/x" role="link") b\na(role="link") c\nul(role="list")\n  li(role="listitem") d\nimg(src="/a.png" alt="A" role="img")\nimg(src="/a.png" alt="" role="img")\ninput(type="checkbox" role="checkbox" aria-label="x")\nbutton(role={kind}) e\nbutton(role="tab") f\nh2(role="heading" aria-level="2") g\n')).toEqual(['redundant-role role', 'redundant-role role', 'redundant-role role', 'redundant-role role', 'redundant-role role', 'redundant-role role'])
  })

  it('reports an aria attribute the role does not take, by its own role or the tag\'s, and no global one', () => {
    expect(found('button(aria-checked={on} aria-pressed={on} aria-expanded="true" aria-label="x") a\ndiv(role="switch" aria-checked="true" aria-pressed="true" tabindex="0") b\nh2(aria-expanded="true" aria-level="2") c\ndiv(aria-checked="true") d\ninput(type="checkbox" aria-checked="mixed" aria-label="x")\ninput(type="range" aria-valuenow="2" aria-label="x")\ndiv(role={kind} aria-checked="true") e\ndiv(role="combobox widget" aria-expanded="true" aria-checked="true") f\na(href="/x" aria-expanded="false") g\nnav(aria-current="page" aria-hidden="false") h\n')).toEqual(['unsupported-aria aria-checked', 'unsupported-aria aria-pressed', 'unsupported-aria aria-expanded', 'unsupported-aria aria-checked'])
  })

  it('reports a second h1, not one in another branch, a row, a snippet, a component or hidden markup', () => {
    expect(found('h1 A\nh1 B\nh2 C\n')).toEqual(['multiple-h1 h1'])
    expect(found('if open\n  h1 A\nelse\n  h1 B\nh1 C\n')).toEqual(['multiple-h1 h1'])
    expect(found('if open\n  h1 A\nelse\n  h1 B\n')).toEqual([])
    expect(found('for x of xs key={x}\n  h1 {x}\nsnippet row(x)\n  h1 {x}\nh1 Z\n')).toEqual([])
    expect(found('h1 A\nh1(aria-hidden="true") B\nh1({...rest}) C\nHeading\n')).toEqual([])
  })

  it('counts h1s of match branches apart and skips hidden markup', () => {
    expect(found('match kind\n  when "a"\n    h1 A\n  else\n    h1 B\n')).toEqual([])
    expect(found('div(hidden)\n  p(tabindex="0") x\n  a x\n  button(role="button" aria-checked="true") y\n')).toEqual([])
    expect(found('main(role="main") a\ntextarea(role="textbox" aria-label="x")\ndialog(role="dialog") b\n')).toEqual(['redundant-role role', 'redundant-role role', 'redundant-role role'])
  })

  it('reports an accesskey, whatever its value', () => {
    expect(found('button(accesskey="s") a\ninput(accesskey={key} aria-label="x")\nbutton b\n')).toEqual(['no-access-key accesskey', 'no-access-key accesskey'])
  })

  it('reports a reachable click with no key handler, leaving native controls, key handlers, backdrops and what no keyboard reaches', () => {
    expect(found('div(role="button" tabindex="0" onClick={a}) a\nspan(tabindex="0" onClick={a}) b\ndiv(role="button" tabindex="0" onClick={a} onKeyDown|enter={a}) c\nbutton(onClick={a}) d\na(href="/x" onClick={a}) e\ndiv(role="dialog" tabindex="-1" onClick={a}) f\ndiv(tabindex="0" aria-modal="true" onClick={a}) g\ndiv(onClick={a}) h\ndiv(tabindex="-1" onClick={a}) i\nsummary(onClick={a}) j\na(role="button" tabindex="0" onClick={a}) k\nli(role="option" onClick={a}) m\nTree\n  li(role="treeitem" tabindex="0" onClick={a}) n\nul(role="tree" onKeyDown={a})\n  li(role="treeitem" tabindex="0" onClick={a}) l\n')).toEqual(['click-without-key onClick', 'click-without-key onClick', 'click-without-key onClick'])
  })

  it('reports tabindex 0 on an element read rather than operated, leaving a scroll region, a role, a handler and -1', () => {
    expect(found('p(tabindex="0") a\nh2(tabindex="0") b\nimg(tabindex="0" src="/a.png" alt="A")\ndiv(tabindex="0") c\npre(tabindex="0") d\np(tabindex="-1") e\nli(tabindex="0" onClick={a} onKeyDown={a}) f\nli(tabindex="0" role="option") g\np(tabindex={n}) h\n')).toEqual(['interactive-tabindex tabindex', 'interactive-tabindex tabindex', 'interactive-tabindex tabindex'])
  })

  it('allows a lint with a kay-allow comment', () => {
    expect(found('// kay-allow no-access-key\nbutton(accesskey="s") a\n')).toEqual([])
  })
})
