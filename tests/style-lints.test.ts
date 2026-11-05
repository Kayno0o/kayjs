import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

function lints(source: string, only?: string) {
  return compileKay(source, 'src/list.kay', { check: true }).diagnostics.filter(d => only === undefined ? d.code === 'unused-selector' || d.code === 'unreachable-selector' : d.code === only).map(d => ({ code: d.code, severity: d.severity, at: source.slice(d.start, d.end) }))
}

function unused(css: string, template: string, fences = ''): string[] {
  return lints(`${fences}--- style\n${css}\n---\n${template}\n`, 'unused-selector').map(d => d.at)
}

function fixed(source: string): string[] {
  return compileKay(source, 'src/list.kay', { check: true }).diagnostics.flatMap(d => d.fixes ?? []).map(fix => [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source))
}

describe('unused-selector', () => {
  it('warns of a rule whose last compound no element can have, each selector of a list apart', () => {
    expect(lints('--- style\n.card { color: red }\n.nope, .card .inner { color: blue }\n---\n.card hi\n')).toEqual([
      { code: 'unused-selector', severity: 'warning', at: '.nope' },
      { code: 'unused-selector', severity: 'warning', at: '.card .inner' },
    ])
  })

  it('reads the classes, ids and tags the template writes, shorthand or attribute', () => {
    expect(unused('.a { x: y } .b { x: y } #c { x: y } section { x: y } p.a { x: y } .a.z { x: y }', 'section.a#c\n  p(class="b a") hi')).toEqual(['.a.z'])
  })

  it('wants every class of a compound on one element', () => {
    expect(unused('.a.b { x: y }', '.a hi\n.b hi')).toEqual(['.a.b'])
  })

  it('checks a tag against the elements and a class against any element', () => {
    expect(unused('article { x: y } .card { x: y }', 'section.card hi')).toEqual(['article'])
  })

  it('leaves an ancestor the template may not write, only the last compound being this component\'s', () => {
    expect(unused('.outside .card { x: y } .card .inner { x: y } .nope + .card { x: y }', '.card\n  .inner hi')).toEqual([])
  })

  it('reports a missing last compound after an ancestor', () => {
    expect(unused('.card .inner { x: y }', '.card hi')).toEqual(['.card .inner'])
  })

  it('reads inside at-rules and nested rules', () => {
    expect(unused('@media (min-width: 40em) { .nope { x: y } .card { x: y } } .card { .deep { x: y } &:hover { x: y } & .card { x: y } }', '.card hi')).toEqual(['.nope', '.deep'])
  })

  it('skips pseudo-classes and their arguments, attribute selectors and pseudo-elements', () => {
    expect(unused('.card:not(.gone) { x: y } .card:has(.child) { x: y } .card:is(.a, .b)::before { x: y } .card[data-x="y"] { x: y } .card:hover:focus-visible { x: y }', '.card hi')).toEqual([])
  })

  it('leaves :global alone, and the own part of a mixed compound', () => {
    expect(unused(':global(.x) { x: y } :global(.x) .card { x: y } .card :global(.x) { x: y } :global(.x) .gone { x: y } .gone:global(.x) { x: y }', '.card hi')).toEqual([':global(.x) .gone', '.gone:global(.x)'])
  })

  it('counts a class bound as an expression, a toggle, a spread or a part as possibly set', () => {
    const template = 'a(class={active ? \'on\' : \'off\'}) one\nb({...rest}) two\ni(part="head") three'
    const fences = '---\nconst { active, rest } = props<{ active: boolean, rest: object }>()\n---\n'

    expect(unused('a.on { x: y } a.anything { x: y } b.any { x: y } #any { x: y } i.head { x: y }', template, fences)).toEqual([])
    expect(unused('u.on { x: y } a#nothing { x: y }', template, fences)).toEqual(['u.on', 'a#nothing'])
  })

  it('counts a dynamic id as possibly any', () => {
    expect(unused('#row-1 { x: y } li#other { x: y }', 'li(id={`row-${1}`}) hi', '')).toEqual([])
  })

  it('counts a class on a component call, which a child may forward', () => {
    expect(unused('.fill { x: y } .gone { x: y }', 'Child(class="fill")', '---\nimport Child from \'./child.kay\'\n---\n')).toEqual(['.gone'])
  })

  it('counts a class the component code names, which it may set on an element itself', () => {
    const fences = '---\nlet el: HTMLElement\nonMount(() => el.classList.add(\'open\'))\n---\n'

    expect(unused('.open { x: y } .shut { x: y }', 'div(ref={el}) hi', fences)).toEqual(['.shut'])
  })

  it('reads every branch, loop and snippet of the template', () => {
    const template = 'if ok\n  p.yes hi\nelse\n  p.no hi\nfor n of [1]\n  li.row {n}\nsnippet item()\n  b.bold hi\nitem()'
    const fences = '---\nconst ok = true\n---\n'

    expect(unused('.yes { x: y } .no { x: y } .row { x: y } .bold { x: y } .none { x: y }', template, fences)).toEqual(['.none'])
  })

  it('does not count the content a slot renders, which carries its writer\'s attribute', () => {
    expect(unused('.slotted { x: y } .own { x: y }', '.own\n  slot')).toEqual(['.slotted'])
  })

  it('reads a class with an escape as the name it writes', () => {
    expect(unused('.md\\:flex { x: y } .w-1\\/2 { x: y } .no\\:pe { x: y }', 'div(class="md:flex w-1/2") hi')).toEqual(['.no\\:pe'])
  })

  it('leaves a name written with a hex escape, which it does not compare', () => {
    expect(unused('.\\31a { x: y }', 'div hi')).toEqual([])
  })

  it('ignores a selector in a comment, a string or a custom property value', () => {
    expect(unused('/* .gone { x: y } */ .card { content: ".gone { }"; --x: { .gone: 1 } }', '.card hi')).toEqual([])
  })

  it('leaves keyframes selectors and other at-rules alone', () => {
    expect(unused('@keyframes spin { from { x: y } 50% { x: y } to { x: y } } @font-face { font-family: f } .card { x: y }', '.card hi')).toEqual([])
  })

  it('reports nothing for a component with no style fence', () => {
    expect(lints('.card hi\n')).toEqual([])
  })

  it('points at the selector in the file', () => {
    const source = '--- style\n/* c */ .card { x: y }\n  .gone { x: y }\n---\n.card hi\n'
    const [found] = compileKay(source, 'src/list.kay', { check: true }).diagnostics.filter(d => d.code === 'unused-selector')

    expect(source.slice(found!.start, found!.end)).toBe('.gone')
  })

  it('can be allowed in kay.config.ts', () => {
    const source = '--- style\n.gone { x: y }\n---\n.card hi\n'

    expect(compileKay(source, 'src/list.kay', { check: true, lints: { 'unused-selector': 'allow' } }).diagnostics.filter(d => d.code === 'unused-selector')).toEqual([])
  })

  it('reads a markdown block expanded to its elements', () => {
    expect(unused('h1 { x: y } blockquote { x: y }', 'markdown\n  # Title')).toEqual(['blockquote'])
  })
})

describe('unreachable-selector', () => {
  it('is an error for a rule ending on :root, html or body', () => {
    expect(lints('--- style\n:root { --x: 1 }\nhtml, body { margin: 0 }\nbody.dark { x: y }\nhtml:not(.a) { x: y }\n:root::before { x: y }\n---\np hi\n', 'unreachable-selector')).toEqual([
      { code: 'unreachable-selector', severity: 'error', at: ':root' },
      { code: 'unreachable-selector', severity: 'error', at: 'html' },
      { code: 'unreachable-selector', severity: 'error', at: 'body' },
      { code: 'unreachable-selector', severity: 'error', at: 'body.dark' },
      { code: 'unreachable-selector', severity: 'error', at: 'html:not(.a)' },
      { code: 'unreachable-selector', severity: 'error', at: ':root::before' },
    ])
  })

  it('reports it instead of an unused selector', () => {
    expect(lints('--- style\nbody { margin: 0 }\n---\np hi\n').map(d => d.code)).toEqual(['unreachable-selector'])
  })

  it('leaves them as ancestors, which the attribute does not end on', () => {
    expect(lints('--- style\n:root .card { x: y }\nbody > .card { x: y }\nhtml.dark .card { x: y }\n---\n.card hi\n')).toEqual([])
  })

  it('leaves :global(...) and a name inside a pseudo-class', () => {
    expect(lints('--- style\n:global(body) { margin: 0 }\n:global(:root) { --x: 1 }\n.card:not(:root) { x: y }\n.card:is(html, body) { x: y }\n---\n.card hi\n')).toEqual([])
  })

  it('reads nested rules and at-rules', () => {
    expect(lints('--- style\n@media (prefers-color-scheme: dark) { :root { --x: 1 } }\n---\n.card hi\n', 'unreachable-selector').map(d => d.at)).toEqual([':root'])
  })

  it('has a safe fix writing :global(...) around the compound, before a pseudo-element', () => {
    const source = '--- style\nhtml, body.dark, html::before { x: y }\n---\np hi\n'
    const fixes = compileKay(source, 'src/list.kay', { check: true }).diagnostics.flatMap(d => d.fixes ?? [])

    expect(fixes.every(fix => fix.safe === true)).toBe(true)
    expect(fixed(source)).toEqual([
      '--- style\n:global(html), body.dark, html::before { x: y }\n---\np hi\n',
      '--- style\nhtml, :global(body.dark), html::before { x: y }\n---\np hi\n',
      '--- style\nhtml, body.dark, :global(html)::before { x: y }\n---\np hi\n',
    ])
  })

  it('keeps the rule matching nothing once fixed', () => {
    expect(lints(fixed('--- style\nbody { margin: 0 }\n---\np hi\n')[0]!)).toEqual([])
  })
})
