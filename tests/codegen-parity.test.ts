import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

// The server markup, the markup that hydrates, the browser's DOM and the type-check output of one template.
// A decision about a node (a link that leaves the site, a loop keyed by position, a form's defaults) is made once for every target, so the targets cannot disagree on it.
const PRELUDE = '---\nimport { signal } from \'kay\'\nconst { href, rows } = props<{ href: string, rows: string[] }>()\nconst pick = signal(\'a\')\nconst checked = signal([\'a\'])\n---\n'

const HELPER_IMPORTS = /^import \{.*\n/gm
const POST = /method=\\*"post/
const MULTIPART = /enctype=\\*"multipart/

function targets(template: string) {
  // Without the helper imports, which name every helper the target could call.
  const build = (options: Parameters<typeof compileKay>[2]) => compileKay(PRELUDE + template, 'test.kay', options).tsx.replace(HELPER_IMPORTS, '')

  return {
    server: build({ output: 'html' }),
    hydrating: build({ output: 'html', hydratable: true }),
    browser: build({ output: 'dom' }),
    check: build({ check: true }),
  }
}

describe('a link', () => {
  it('that leaves the site keeps its `rel` in the server and the browser alike', () => {
    const withRel = targets('a(href="https://x.dev" rel="me") x')
    const without = targets('a(href="https://x.dev") x')

    for (const server of [withRel.server, withRel.hydrating])
      expect(server).toContain('KayOutsideLink("https://x.dev", true)')

    expect(withRel.browser).toContain('KayOutside(KayN0_0, "https://x.dev", true)')
    expect(without.server).toContain('KayOutsideLink("https://x.dev")')
    expect(without.browser).toContain('KayOutside(KayN0_0, "https://x.dev");')
  })

  it('that sets its own `target` is left alone by both', () => {
    const own = targets('a(href="https://x.dev" target="_self") x')

    expect(own.server).not.toContain('KayOutsideLink')
    expect(own.browser).not.toContain('KayOutside(')
  })

  it('carrying `hreflang` keeps its `href` as written in the server and the browser alike', () => {
    const written = targets('a(href="/p" hreflang="fr") x')
    const local = targets('a(href="/p") x')

    expect(written.server).not.toContain('KayLocalHref')
    expect(written.browser).toContain('KayAttribute(KayN0_0, "href", "/p", true)')
    expect(local.server).toContain('KayLocalHref("/p")')
    expect(local.browser).toContain('KayAttribute(KayN0_0, "href", "/p");')
    expect(local.browser).toContain('import \'kay/i18n-links\'')
    expect(written.browser).not.toContain('import \'kay/i18n-links\'')
  })

  it('that brings a spread is no link of the template: the spread decides at render', () => {
    const spread = targets('a(href="https://x.dev" {...rows}) x')

    expect(spread.server).not.toContain('KayOutsideLink')
    expect(spread.browser).not.toContain('KayOutside(')
  })

  it('whose `rel` is an expression still keeps it in both', () => {
    const expression = targets('a(href="https://x.dev" rel={href}) x')

    expect(expression.server).toContain('KayOutsideLink("https://x.dev", true)')
    expect(expression.browser).toContain('KayOutside(KayN0_0, "https://x.dev", true)')
  })

  it('is checked as a site link by the types whatever it leaves', () => {
    expect(targets('a(href="/p" hreflang="fr") x').check).toContain('href={KayHref("/p")}')
    expect(targets('a(href={href}) x').check).toContain('href={KayHref((__props.href))}')
  })

  it('read from an expression tells the server and the browser whether it may leave and stay on a locale', () => {
    const read = targets('a(href={href} rel="me") x')
    const own = targets('a(href={href} hreflang="fr" target="_blank") x')

    expect(read.server).toContain('KayLinkHref((__props.href), true, true)')
    expect(read.browser).toContain('KayOutside(KayN0_0, (__props.href), true)')
    expect(own.server).not.toContain('KayLinkHref')
    expect(own.browser).toContain('KayProperty(KayN0_0, "href", (__props.href), true)')
  })
})

describe('a loop', () => {
  it('keyed by its index matches rows by position in the server, the browser and the types', () => {
    const positional = targets('for row, i of rows key={i}\n  p {row}')

    expect(positional.server).toContain('"positional")')
    expect(positional.hydrating).toContain('"positional")')
    expect(positional.browser).toContain('() => (__props.rows), false, (row, i)')
    expect(positional.check).toContain('keyed={false}')
    expect(positional.check).toContain('void (i)')
  })

  it('keyed by an expression or by nothing is not positional in any of them', () => {
    const keyed = targets('for row, i of rows key={row}\n  p {row}')
    const implicit = targets('for row of rows\n  p {row}')

    expect(keyed.server).not.toContain('"positional"')
    expect(keyed.browser).toContain('(row) => (row)')
    expect(implicit.browser).toContain('KayRowKey')
    expect(implicit.check).toContain('keyed={() => 0}')
    expect(keyed.check).toContain('keyed={() => 0}')
  })
})

describe('a form posting to an action', () => {
  const source = (attributes: string) => `---\nimport { action } from 'kay'\nconst save = action(async () => {})\n---\nform(action={save}${attributes})\n  button x`

  it('takes the method and the encoding unless it sets its own, in every target', () => {
    for (const output of [{ output: 'html' }, { output: 'dom' }, { check: true }] as const) {
      const defaults = compileKay(source(''), 'test.kay', output).tsx
      const own = compileKay(source(' method="get" enctype="text/plain"'), 'test.kay', output).tsx

      expect(defaults).toMatch(POST)
      expect(defaults).toMatch(MULTIPART)
      expect(own).not.toMatch(POST)
      expect(own).not.toMatch(MULTIPART)
    }
  })

  it('leaves a `method` written as an expression to the template', () => {
    for (const output of [{ output: 'html' }, { output: 'dom' }, { check: true }] as const) {
      const written = compileKay(source(' method={href}'), 'test.kay', output).tsx

      expect(written).not.toMatch(POST)
      expect(written).toMatch(MULTIPART)
    }
  })
})

describe('a group of boxes', () => {
  it('is checked when the signal holds the box\'s value, the same way in the server, the browser and a spread', () => {
    const plain = targets('input(type="checkbox" value="a" bind:group={checked})')
    const spread = targets('input(type="checkbox" value="a" bind:group={checked} {...rows})')
    const holds = '((kayGroup: unknown, kayValue: string) => Array.isArray(kayGroup) ? kayGroup.includes(kayValue) : kayGroup === kayValue)((checked)(), "a")'

    expect(plain.server).toContain(holds)
    expect(plain.browser).toContain(holds)
    expect(spread.server).toContain(holds)
    expect(spread.browser).toContain(holds)
  })
})

describe('a binding', () => {
  it('is attached by the browser alone: a handler, a ref and a transition leave the server markup and stay props to the types', () => {
    const bound = targets('button(onClick={rows} ref={pick} transition="fade") x')

    for (const server of [bound.server, bound.hydrating]) {
      expect(server).toContain('"<button>x</button>"')
      expect(server).not.toMatch(/onClick|KayRef|KayTransition/)
    }

    expect(bound.browser).toContain('KayListen(KayN0_0, "onClick"')
    expect(bound.browser).toContain('KayRef(KayN0_0, (pick()))')
    expect(bound.browser).toContain('KayTransition(KayN0_0, "name", "fade")')
    expect(bound.check).toContain('onClick={__props.rows}')
    expect(bound.check).toContain('transition="fade"')
  })

  it('written without an expression, or as `on:`, attaches nothing in any of them', () => {
    const inert = targets('button(ref="x" on:foo={rows}) x')

    expect(inert.server).toContain('"<button>x</button>"')
    expect(inert.browser).not.toMatch(/KayRef|KayListen/)
    expect(inert.check).toContain('ref="x" on:foo=')
  })

  it('names a transition part by its suffix in the browser', () => {
    expect(targets('div(transition:enter="slide") x').browser).toContain('KayTransition(KayN0_0, "enter", "slide")')
  })

  it('of `bind:value` is read as the value by the server, the browser and the types, and written back by the last two', () => {
    const bound = targets('input(bind:value={pick})')

    expect(bound.server).toContain('KayAttribute("value", (pick)())')
    expect(bound.hydrating).toContain('KayAttribute("value", (pick)())')
    expect(bound.browser).toContain('KayProperty(KayN0_0, "value", (pick)())')
    expect(bound.browser).toContain('(pick).set(kayEvent.currentTarget.value)')
    expect(bound.check).toContain('value={(pick)()}')
    expect(bound.check).toContain('(pick).set(kayEvent.currentTarget.value)')
  })

  it('of `bind:value` on a textarea is its content on the server and a property in the browser', () => {
    const area = targets('textarea(bind:value={pick})')

    expect(area.server).toContain('(pick)()')
    expect(area.server).not.toContain('KayAttribute("value"')
    expect(area.browser).toContain('KayProperty(KayN0_0, "value", (pick)())')
  })
})

describe('a URL the pages serve', () => {
  it('is checked as a site link when it is a link\'s `href` or a written `src`, `href` or `action`', () => {
    const urls = targets('area(href="/z")\nimg(src="/a.png")\nform(action="/y" method="get")\n  button x')

    expect(urls.check).toContain('<area href={KayHref("/z")}')
    expect(urls.check).toContain('src={KayHref("/a.png")}')
    expect(urls.check).toContain('action={KayHref("/y")}')
  })

  it('is left alone for a feed, a form posting to a route and an expression that is no URL', () => {
    const served = targets('link(rel="alternate" href="/feed")\nform(action="/x" method="post")\n  button x\nimg(src={href})')

    expect(served.check).toContain('<link rel="alternate" href="/feed" />')
    expect(served.check).toContain('<form action="/x" method="post">')
    expect(served.check).toContain('src={__props.href}')
  })
})

describe('a class', () => {
  it('merged with a spread\'s goes after every attribute in the types, and beside an expression it merges where it stands', () => {
    const spread = targets('a.one(class="two" {...rows}) x')
    const expression = targets('div.k(class={pick}) y')

    expect(spread.check).toContain('<a {...__props.rows} class={["one", "two", ((__props.rows) as unknown as { class?: string }).class]}>')
    expect(spread.server).toContain('"class": ["one", "two", ((__props.rows) as unknown as { class?: string }).class]')
    expect(spread.browser).toContain('"class": ["one", "two", ((__props.rows) as unknown as { class?: string }).class]')
    expect(expression.check).toContain('class={["k", ')
    expect(expression.server).toContain('KayClassName(["k", (pick())])')
    expect(expression.browser).toContain('KaySetClass(KayN0_0, ["k", (pick())])')
  })
})

describe('a field of a form posting to an action', () => {
  const form = (fields: string) => targets(`form(action={rows})\n${fields.split('\n').map(line => `  ${line}`).join('\n')}`)

  it('is named and checked against the action\'s input in the types, and constrained and described by the server', () => {
    const fields = form('input(field="title")\ninput(name="body" aria-required)')

    expect(fields.check).toContain('name={KayField((__props.rows), "title")}')
    expect(fields.check).toContain('name={KayField((__props.rows), "body")} aria-required')
    expect(fields.server).toContain('KayFormConstraints((__props.rows), "title", ["field"])')
    expect(fields.server).toContain('KayFieldDescribed(undefined, undefined, true, undefined, KayFormInvalid((__props.rows), "body") || undefined)')
    expect(fields.hydrating).toContain('KayFieldDescribed(undefined, undefined, true, undefined, KayFormInvalid((__props.rows), "body") || undefined)')
  })

  it('of a type with no text or no `aria-required` is left out of the description or the aria requirement', () => {
    const typed = form('input(type="hidden" name="x")\ninput(type="radio" name="r")')

    expect(typed.server).toContain('<input type=\\"hidden\\" name=\\"x\\">')
    expect(typed.server).toMatch(/type=\\"radio\\" name=\\"r\\".*KayFieldDescribed\(undefined, "radio", true, undefined, KayFormInvalid\(\(__props\.rows\), "r"\) \|\| undefined\)/)
  })

  it('written with `field` beside a `name`, or as an expression, is left as written in the types', () => {
    const own = form('input(field="a" name="b")\ninput(field={href})')

    expect(own.check).toContain('{...{}}')
    expect(own.check).toContain('name={KayField((__props.rows), "b")}')
  })

  it('outside a form is written as a plain name by the types', () => {
    expect(targets('input(field="title")').check).toContain('name="title"')
  })
})

describe('a field in the content of a component given an action', () => {
  const source = (fields: string) => `---\nimport Card from './card.kay'\nimport { action } from 'kay'\nconst save = action(async () => {})\n---\nCard(action={save})\n  ${fields}`

  it('keeps `field` typed against the action and leaves `name` unchecked, for every control', () => {
    const check = compileKay(source('textarea(field="a")\n  select(name="b")\n  button(name="c")'), 'test.kay', { check: true }).tsx

    expect(check).toContain('name={KayField((save), "a")}')
    expect(check).toContain('<select name="b"')
    expect(check).toContain('<button name="c"')
  })

  it('writes `field` as a plain name when nothing is checked', () => {
    expect(compileKay(source('input(field="a")'), 'test.kay', { check: false }).tsx).toContain('name="a"')
  })
})
