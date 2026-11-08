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
