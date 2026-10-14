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
import { decodeServerValue, decodeValue, encodeValue } from '../src/runtime/wire'
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

  it('is bounded: markup nothing used for a whole generation is forgotten, a use keeps it, and an icon stays', () => {
    const big = (mark: string) => mark + 'x'.repeat(5_000_000)
    const icon = vouch('<path d="icon-forever"/>', true)

    for (const mark of 'abcd')
      vouch(big(mark))

    expect(isVouched(big('a'))).toBe(false)
    expect(isVouched(big('b'))).toBe(false)
    // Used, so it moves to the newer generation and outlasts the next one.
    expect(isVouched(big('c'))).toBe(true)

    for (const mark of 'ef')
      vouch(big(mark))

    expect(isVouched(big('c'))).toBe(true)
    expect(isVouched(big('d'))).toBe(false)

    for (const mark of 'ghij')
      vouch(big(mark))

    expect(isVouched(big('c'))).toBe(false)
    expect(isVouched(icon)).toBe(true)
  })

  it('counts a repeat of markup the newer generation holds for nothing, so a hot path cannot push other markup out', () => {
    const big = (mark: string) => mark + 'x'.repeat(5_000_000)

    vouch(big('k'))

    for (let i = 0; i < 10; i++)
      vouch(big('k'))

    vouch(big('l'))

    // Ten repeats of `k` counted once, so `k` and `l` have not yet filled the generation and `k` is not forgotten.
    expect(isVouched(big('k'), false)).toBe(true)
  })

  it('leaves what is no string alone, so the registry is not spoilt', () => {
    const kept = trustHtml('<b>before-null-1</b>')

    expect(trustHtml(null as unknown as string)).toBeNull()
    expect(trustHtml(5 as unknown as string) as unknown).toBe(5)
    expect(isVouched(kept)).toBe(true)
    expect(isVouched(5)).toBe(false)
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

  it('warns of a dropped innerHTML once per process in production, and leaves null and undefined alone', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      process.env.NODE_ENV = 'development'
      expect(render('div', { innerHTML: null })).toBe('<div></div>')
      expect(render('div', { innerHTML: undefined })).toBe('<div></div>')
      expect(warn).not.toHaveBeenCalled()
      process.env.NODE_ENV = 'production'
      expect(render('div', { innerHTML: '<b>raw-prod-1</b>' })).toBe('<div></div>')
      expect(render('div', { innerHTML: '<b>raw-prod-2</b>' })).toBe('<div></div>')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('most recently vouched for')
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
  const encoded = (value: unknown) => decodeServerValue(encodeValue(value))

  it('survives an encode and a decode as the same markup, an icon prop, a sanitized prop and a nested one included', () => {
    const file = installedIconSets(join(import.meta.dir, 'fixtures/icons')).get('tabler')!
    const icon = fileIconProps(file, 'home')!
    const sanitized = sanitizeHtml('<b>sanitized-prop-1</b><script>x</script>')
    const text = encodeValue({ icon, sanitized, nested: [{ deep: [sanitized] }], map: new Map([['k', icon.innerHTML]]), plain: 'text' })
    const back = decodeServerValue(text) as { icon: typeof icon, sanitized: string, nested: [{ deep: string[] }], map: Map<string, string>, plain: string }

    expect(back).toEqual({ icon, sanitized, nested: [{ deep: [sanitized] }], map: new Map([['k', icon.innerHTML]]), plain: 'text' })
    expect(text).toContain('"SafeHtml"')
    expect(isVouched(back.icon.innerHTML) && isVouched(back.sanitized) && isVouched(back.nested[0].deep[0]!)).toBe(true)
  })

  it('writes the markup behind a mark, so the entry never points at itself', () => {
    const text = encodeValue({ html: trustHtml('<b>entry-1</b>') })

    expect(text).toBe(String.raw`[{"html":1},["SafeHtml",2],"!\u003Cb>entry-1\u003C/b>"]`)
    expect(decodeServerValue(text)).toEqual({ html: '<b>entry-1</b>' })
  })

  it('reads a plain string equal to a vouched one as that string, and vouches again what only the server vouched for', () => {
    const markup = trustHtml('<b>twin-1</b>')

    expect(encoded({ vouched: markup, plain: '<b>twin-1</b>' })).toEqual({ vouched: markup, plain: markup })

    // A browser that never vouched for it: the text alone names it.
    const fresh = decodeServerValue('[{"html":1},["SafeHtml",2],"!<b>only-the-server-1</b>"]') as { html: string }

    expect(isVouched(fresh.html)).toBe(true)
  })

  it('arrives plain when nothing vouched for it, and from the browser', () => {
    const text = encodeValue({ html: '<b>unvouched-1</b>' })

    expect(text).not.toContain('SafeHtml')
    expect(isVouched((decodeServerValue(text) as { html: string }).html)).toBe(false)
    expect(sendValue({ html: trustHtml('<b>sent-1</b>') })).not.toContain('SafeHtml')
  })

  it('is no type text the browser or a request holds can use to vouch for its own markup', () => {
    const forged = '[{"html":1},["SafeHtml",2],"!<img src=x onerror=alert(1)>"]'

    expect(() => decodeValue(forged)).toThrow('malformed')
    expect(() => decodeCall(forged)).toThrow('malformed')
    expect(isVouched('<img src=x onerror=alert(1)>')).toBe(false)
    expect(() => decodeServerValue('[{"html":1},["SafeHtml",2],5]')).toThrow()
    // Anything with a `slice`, an array here, once reached `vouch` and spoilt its count.
    expect(() => decodeServerValue('[{"html":1},["SafeHtml",2],["!x"]]')).toThrow('malformed')
    expect(() => decodeServerValue('[{"html":1},["SafeHtml",2],"no mark"]')).toThrow('malformed')
    expect(isVouched('no mark')).toBe(false)
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
