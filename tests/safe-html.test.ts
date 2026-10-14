import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { iconProps as fileIconProps, iconModule, installedIconSets } from '../src/build/icons'
import { decodeCall } from '../src/runtime/action'
import { child, dynamic, element, spreadAttributes } from '../src/runtime/html'
import { island } from '../src/runtime/island.server'
import { isVouched, vouch } from '../src/runtime/safe-html'
import { sanitizeHtml, trustHtml } from '../src/runtime/sanitize'
import { sendValue } from '../src/runtime/send'
import { decodeValue, encodeValue } from '../src/runtime/wire'
import { scratchDir } from './scratch'

const render = (tag: string, source: object) => element(tag, [spreadAttributes(source)]).t
const environment = process.env.NODE_ENV ?? 'test'

afterEach(() => {
  process.env.NODE_ENV = environment
})

describe('vouched markup', () => {
  it('is what trustHtml and sanitizeHtml return, and nothing else', () => {
    const trusted = trustHtml('<b>trusted-1</b>')
    const sanitized = sanitizeHtml('<i>sanitized-1</i><script>x</script>')

    expect([isVouched(trusted), isVouched(sanitized), isVouched('<b>never-vouched-1</b>'), isVouched(5), isVouched(null), isVouched({})]).toEqual([true, true, false, false, false, false])
    expect(isVouched(`${trusted}<script>`)).toBe(false)
    expect(isVouched(trusted.slice(1))).toBe(false)
    expect(isVouched('')).toBe(true)
  })

  it('is bounded: the oldest recent markup goes first, a use keeps it, and an icon stays', () => {
    const big = (mark: string) => mark + 'x'.repeat(6_000_000)
    const kept = vouch(big('a'), false)
    const icon = vouch('<path d="icon-forever"/>', true)

    vouch(big('b'))
    expect(isVouched(kept)).toBe(true)
    vouch(big('c'))
    expect(isVouched(big('b'))).toBe(false)
    expect(isVouched(kept)).toBe(true)
    vouch(big('d'))
    vouch(big('e'))
    expect(isVouched(kept)).toBe(false)
    expect(isVouched(icon)).toBe(true)
  })
})

describe('a spread onto an element', () => {
  it.each(['div', 'svg', 'math', 'span'])('renders markup vouched for on a %s', (tag) => {
    expect(render(tag, { innerHTML: trustHtml('<b>t</b>') })).toBe(`<${tag}><b>t</b></${tag}>`)
    expect(render(tag, { innerHTML: sanitizeHtml('<b>s</b><script>x</script>') })).toBe(`<${tag}><b>s</b></${tag}>`)
  })

  it.each(['div', 'svg', 'math'])('drops a raw, a derived or a mistyped innerHTML on a %s, with a warning in development', (tag) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const marked = trustHtml('<b>derived</b>')

    try {
      process.env.NODE_ENV = 'development'
      expect(render(tag, { innerHTML: '<img src=x onerror=alert(1)>' })).toBe(`<${tag}></${tag}>`)
      expect(render(tag, { innerHTML: `${marked}<img src=x onerror=alert(1)>` })).toBe(`<${tag}></${tag}>`)
      expect(render(tag, { innerHTML: marked.toUpperCase() })).toBe(`<${tag}></${tag}>`)
      expect(render(tag, { innerHTML: 5 })).toBe(`<${tag}></${tag}>`)
      expect(render(tag, { innerHTML: { toString: () => marked } })).toBe(`<${tag}></${tag}>`)
      expect(warn).toHaveBeenCalledTimes(5)
      expect(String(warn.mock.calls[0]![0])).toContain('trustHtml')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('drops it without a warning in production, and leaves null and undefined alone', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      process.env.NODE_ENV = 'production'
      expect(render('div', { innerHTML: '<b>raw</b>' })).toBe('<div></div>')
      process.env.NODE_ENV = 'development'
      expect(render('div', { innerHTML: null })).toBe('<div></div>')
      expect(render('div', { innerHTML: undefined })).toBe('<div></div>')
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('checks a getter on each read, so a prop that turns raw is dropped', () => {
    let value: string = trustHtml('<b>first</b>')
    const spread = spreadAttributes({ get innerHTML() {
      return value
    } })
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect(element('div', [spread]).t).toBe('<div><b>first</b></div>')
      value = '<b>raw-later</b>'
      expect(element('div', [spread]).t).toBe('<div></div>')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('takes a dynamic tag\'s props the same way', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect((dynamic('svg', { innerHTML: trustHtml('<path/>') }) as { t: string }).t).toBe('<svg><path/></svg>')
      expect((dynamic('svg', { innerHTML: '<path d="raw"/>' }) as { t: string }).t).toBe('<svg></svg>')
    }
    finally {
      warn.mockRestore()
    }
  })
})

describe('markup across JSON', () => {
  it('is vouched for again where it arrives from the server: island props, action results and event streams', () => {
    const markup = trustHtml('<b>island-prop-1</b>')
    const text = encodeValue({ html: markup, plain: '<b>plain-prop-1</b>', nested: [markup] })

    expect(text).toContain('"SafeHtml"')
    expect(text.match(/SafeHtml/g)).toHaveLength(1)
    expect(text).not.toContain('["SafeHtml",3]')

    // A browser has no mark of its own: the text names the markup the server vouched for.
    const props = decodeValue('[{"html":1},["SafeHtml",2],"<b>other-realm-1</b>"]') as { html: string }

    expect(props.html).toBe('<b>other-realm-1</b>')
    expect(isVouched(props.html)).toBe(true)
  })

  it('arrives plain when nothing vouched for it on the server, and from the browser', () => {
    const text = encodeValue({ html: '<b>unvouched-1</b>' })

    expect(text).not.toContain('SafeHtml')
    expect(isVouched((decodeValue(text) as { html: string }).html)).toBe(false)
    expect(sendValue({ html: trustHtml('<b>sent-1</b>') })).not.toContain('SafeHtml')
  })

  it('is no type a request\'s input can use to vouch for its own text', () => {
    expect(() => decodeCall('[{"html":1},["SafeHtml",2],"<b>forged-1</b>"]')).toThrow('malformed')
    expect(isVouched('<b>forged-1</b>')).toBe(false)
  })

  it('goes into an island\'s data-props as the SafeHtml type only for markup vouched for', () => {
    const Card = island('card.kay', (_props: { good: string, bad: string }) => null)
    const html = child(Card({ good: trustHtml('<b>good-prop-1</b>'), bad: '<b>bad-prop-1</b>' }))
    const props = (/data-props="([^"]*)"/).exec(html)![1]!.replaceAll('&quot;', '"')

    expect(props.match(/SafeHtml/g)).toHaveLength(1)
    expect(props).toContain('["SafeHtml",')
  })
})

describe('an icon', () => {
  it('is vouched for from its module, from a set picked at run time and from a file', async () => {
    const root = join(import.meta.dir, 'fixtures/icons')
    const file = installedIconSets(root).get('tabler')!
    const props = fileIconProps(file, 'home')!
    const dir = await scratchDir('safe-html-')
    const module = join(dir, 'home.js')

    await Bun.write(module, iconModule(installedIconSets(root), '~icons/tabler/home'))
    const { default: imported } = await import(module) as { default: typeof props }

    expect(isVouched(imported.innerHTML)).toBe(true)
    expect(isVouched(props.innerHTML)).toBe(true)
    expect(render('svg', { ...imported }).startsWith('<svg viewBox="0 0 24 24"')).toBe(true)
    expect(render('svg', { ...imported })).toContain('<path')
    expect(render('svg', { ...JSON.parse(JSON.stringify(imported)) as object, innerHTML: `${imported.innerHTML}<script>x</script>` })).not.toContain('<script>')
  })
})
