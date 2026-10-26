import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { compileKay } from '../src/compiler'
import { loadConfigWithin } from '../src/config'
import { dynamic as dynamicHtml, element, leadingNewline, rawData } from '../src/runtime/html'
import { safeUrl } from '../src/runtime/url'
import { elementName, styleText } from '../src/runtime/values'
import { turn } from './helpers/eventually'
import { scratchDir } from './scratch'

let reactive: typeof import('../src/runtime/reactive')
let actionStub: typeof import('../src/runtime/action').actionStub
let dynamicDom: typeof import('../src/runtime/dom-spread').dynamic
let client: typeof import('../src/runtime/client')
let swap: typeof import('../src/runtime/page-swap')
let navigation: typeof import('../src/runtime/navigation')
let submitForm: typeof import('../src/runtime/forms').submit
let dir: string

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })

  reactive = await import('../src/runtime/reactive')
  ;({ actionStub } = await import('../src/runtime/action'))
  ;({ dynamic: dynamicDom } = await import('../src/runtime/dom-spread'))
  client = await import('../src/runtime/client')
  swap = await import('../src/runtime/page-swap')
  navigation = await import('../src/runtime/navigation')
  ;({ submit: submitForm } = await import('../src/runtime/forms'))
  dir = await scratchDir('parity-gaps-')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(dir, { recursive: true, force: true })
})

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++)
    await turn()
}

describe('a tag written in capitals', () => {
  it('is read as its lowercase name, a void one closing at once and a textarea holding its value', () => {
    expect(element('BR', []).t).toBe('<BR>')
    expect(element('TextArea', [{ value: 'a < b' }]).t).toBe('<TextArea>a &lt; b</TextArea>')
    expect(element('SCRIPT', [{ children: 'a</script>' }]).t).toBe('<SCRIPT>a<\\/script></SCRIPT>')
    expect(element('SELECT', [{ value: 'b' }], () => '<option value="b">B</option>').t).toBe('<SELECT value="b"><option value="b" selected>B</option></SELECT>')
  })
})

describe('the first newline of a pre, a listing and a textarea', () => {
  it('is written twice by the server, as the parser drops the first', () => {
    expect(element('pre', [], () => '\nx').t).toBe('<pre>\n\nx</pre>')
    expect(element('LISTING', [{ children: '\r\nx' }]).t).toBe('<LISTING>\n\r\nx</LISTING>')
    expect(element('textarea', [{ value: '\nx' }]).t).toBe('<textarea>\n\nx</textarea>')
    expect(element('textarea', [{ defaultValue: 'x\n' }]).t).toBe('<textarea>x\n</textarea>')
    expect(element('listing', [], () => '\nx').t).toBe('<listing>\n\nx</listing>')
    expect(element('div', [{ children: '\nx' }]).t).toBe('<div>\nx</div>')
    expect(leadingNewline('x')).toBe('x')
  })

  it('is written twice by compiled markup that may start with one, and only by it', () => {
    const compiled = (lines: string) => compileKay(`---\nconst text = props<{ text: string }>().text\n---\n${lines}\n`, 'main.kay', { output: 'html' }).tsx

    expect(compiled('pre {text}')).toContain('Newline(')
    expect(compiled('textarea(value={text})')).toContain('Newline(')
    expect(compiled('textarea(value="&#10;x")')).toContain('Newline(')
    expect(compiled('pre\n  | static')).not.toContain('Newline(')
    expect(compiled('pre\n  code {text}')).not.toContain('Newline(')
    expect(compiled('div {text}')).not.toContain('Newline(')
    expect(compiled('pre\n  | &#10;x')).toContain('Newline(')
  })
})

describe('a dynamic tag', () => {
  it.each(['script', 'STYLE', 'iframe', 'Object', 'embed', 'base', 'meta', 'link'])('refuses %s on both sides', (tag) => {
    expect(() => elementName(tag)).toThrow('cannot be')
    expect(() => dynamicHtml(tag, {})).toThrow('cannot be')
    expect(() => dynamicDom(tag, {})).toThrow('cannot be')
  })

  it('still names any other element', () => {
    expect((dynamicHtml('SECTION', { title: 'a' }) as { t: string }).t).toBe('<SECTION title="a"></SECTION>')
    expect((dynamicDom('section', { title: 'a' }) as Element).outerHTML).toBe('<section title="a"></section>')
  })
})

describe('a style value', () => {
  it('adds no declaration of its own, as an object value or a style:prop', () => {
    expect(styleText({ color: 'red;background:url(//evil/x)', width: '1px' })).toBe('width:1px')
    expect(styleText({ 'width};a': '1px', '--gap': '2px', 'font-size': 'calc(1px + 2px)' })).toBe('--gap:2px;font-size:calc(1px + 2px)')
    expect(styleText({ color: 'red}', background: 'url(a;b)', content: '"a;b"', font: '"open' })).toBe('background:url(a;b);content:"a;b"')
    expect(styleText('top:1px', [['color', 'red;left:0'], ['width', '2px']])).toBe('top:1px;width:2px')
    expect(styleText({ content: '"x\n;position:fixed"', color: 'red /*', width: '1px' })).toBe('width:1px')
    expect(styleText({ width: 'calc(1px /*)', height: '2px' })).toBe('height:2px')
    expect(styleText({ width: 'calc(min(1px, 2px) /* x)', height: '2px', content: '"/*"' })).toBe('height:2px;content:"/*"')
    expect(styleText('top:1px', [['width', 'calc(1px /*)'], ['height', '2px']])).toBe('top:1px;height:2px')
    expect(styleText({ width: '1px/(2)*3', height: '2px' })).toBe('width:1px/(2)*3;height:2px')
    expect(styleText({ '--2xl-gap': '1px', '-webkit-line-clamp': 2 })).toBe('--2xl-gap:1px;-webkit-line-clamp:2')
  })
})

describe('safeUrl', () => {
  it('lets through the web, mail, phone, message and blob schemes, a relative URL and a media data URL', () => {
    for (const url of ['https://a.test/', 'HTTP://a.test', 'mailto:a@b.test', 'tel:+33123', 'sms:+33123', '/path', 'path:with/colon-after-slash'.replace('path:', '/'), '?q=1', '#top', '//cdn.test/x', 'blob:https://a.test/1', 'data:image/png;base64,AAA', 'data:audio/mp3;base64,AAA', 'data:text/csv,a%2Cb', 'data:application/pdf;base64,AAA'])
      expect(safeUrl('href', url)).toBe(url)
  })

  it('prefixes any other scheme, after the control characters a browser skips', () => {
    for (const url of ['javascript:alert(1)', ' \tJava\nScript:alert(1)', 'vbscript:x', 'data:text/html,<p>', 'data:image/svg+xml,<svg/>', 'ftp://a.test', 'file:///etc/passwd', 'foo:bar', 'intent://x#Intent;end'])
      expect(safeUrl('href', url)).toBe(`unsafe:${url}`)

    expect(safeUrl('title', 'javascript:x')).toBe('javascript:x')
  })

  it('lets an SVG data URL through only where it is drawn as an image', () => {
    for (const name of ['src', 'SRC', 'poster'])
      expect(safeUrl(name, 'data:image/svg+xml,<svg/>')).toBe('data:image/svg+xml,<svg/>')

    expect(safeUrl('action', 'data:image/svg+xml;base64,AAA')).toBe('unsafe:data:image/svg+xml;base64,AAA')
  })
})

describe('a script holding JSON', () => {
  const json = '{"a":"</script><!--"}'

  it('writes < as \\u003c, in a spread element and in compiled markup, so the data stays valid', () => {
    expect(rawData(json)).toBe('{"a":"\\u003c/script>\\u003c!--"}')
    expect(JSON.parse(rawData(json))).toEqual({ a: '</script><!--' })
    expect(element('script', [{ type: 'application/ld+json', children: json }]).t).toBe(`<script type="application/ld+json">${rawData(json)}</script>`)
    expect(element('script', [{ children: json }]).t).toBe('<script>{"a":"<\\/script><\\!--"}</script>')

    const compiled = (lines: string) => compileKay(`---\nconst json = props<{ json: string }>().json\n---\n${lines}\n`, 'main.kay', { output: 'html' }).tsx

    expect(compiled('script(type="application/ld+json") {json}')).toContain('RawData(')
    expect(compiled('script(type="importmap")\n  | {json}')).toContain('RawData(')
    expect(compiled('script {json}')).not.toContain('RawData(')
  })
})

describe('concurrent calls of one action', () => {
  it('show the outcome of the one started last, whichever finishes last', async () => {
    let calls = 0
    const answered = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      const own = ++calls

      await Bun.sleep(own === 1 ? 40 : 5)

      return new Response(stringify(own === 1 ? 'first' : 'second'))
    }) as unknown as typeof fetch)

    try {
      const save = actionStub('/_kay/action/test/concurrent') as unknown as { (input: object): Promise<unknown>, pending: () => boolean, succeeded: () => { data: unknown } | undefined }
      const running = [save({}), save({})]

      await Promise.all(running)
      await settle()
      expect([save.pending(), save.succeeded()?.data]).toEqual([false, 'second'])
    }
    finally {
      answered.mockRestore()
    }
  })
})

describe('the island registry', () => {
  it('is read for its own entries only, so an island named toString finds no chunk', async () => {
    const root = document.createElement('div')
    const failed = spyOn(console, 'error').mockImplementation(() => undefined)

    root.innerHTML = '<slot data-component="toString"></slot><slot data-component="constructor"></slot>'
    document.body.append(root)

    try {
      await client.hydrateIslands({}, root)
      await settle()
      expect(failed.mock.calls.map(call => String(call[0]))).toEqual(['[kay] no client chunk for island toString', '[kay] no client chunk for island constructor'])
    }
    finally {
      failed.mockRestore()
      root.remove()
    }
  })
})

describe('effects writing what they read', () => {
  it('stop within a thousand rounds, naming the effect', () => {
    const failed = spyOn(console, 'error').mockImplementation(() => undefined)
    let runs = 0

    try {
      const stop = reactive.root((dispose) => {
        const [count, setCount] = reactive.createSignal(0)

        const climbing = () => {
          runs++
          setCount(count() + 1)
        }

        reactive.effect(climbing)

        return dispose
      })

      reactive.flush()
      stop()
      expect(runs).toBeLessThanOrEqual(1001)
      expect(String(failed.mock.calls[0]?.[0])).toContain('Still queued: climbing')
    }
    finally {
      failed.mockRestore()
    }
  })
})

describe('loading the config', () => {
  it('gives up on one that never settles', async () => {
    const root = join(dir, 'hung')

    await mkdir(root)
    await Bun.write(join(root, 'kay.config.ts'), 'await new Promise(() => undefined)\nexport default {}\n')
    await expect(loadConfigWithin(root, 100)).rejects.toThrow('did not load within 0.1s')
  })

  it('loads one that settles', async () => {
    const root = join(dir, 'quick')

    await mkdir(root)
    await Bun.write(join(root, 'kay.config.ts'), 'await Bun.sleep(5)\nexport default { site: \'https://a.test\' }\n')
    expect((await loadConfigWithin(root, 5000)).site).toBe('https://a.test')
  })
})

describe('a page prefetched while a form post was out', () => {
  it('is forgotten once the post finished', async () => {
    const real = globalThis.XMLHttpRequest
    let sent = false

    class Posting {
      responseType = ''
      status = 200
      response = new Blob([''])
      upload = {}
      onload: (() => void) | null = null
      open = () => undefined
      setRequestHeader = () => undefined
      getAllResponseHeaders(): string {
        return ''
      }

      send(): void {
        sent = true
        swap.prefetch(new URL('http://localhost/next'), document.createElement('a'))
        setTimeout(() => this.onload?.(), 5)
      }
    }

    // The prefetch stays out, as a slow page does.
    const answered = spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise(() => undefined)) as unknown as typeof fetch)
    const form = document.createElement('form')

    document.body.append(form)
    globalThis.XMLHttpRequest = Posting as unknown as typeof XMLHttpRequest

    try {
      try {
        await submitForm(form, null, new URL('http://localhost/post'))
      }
      catch {}

      expect(sent).toBe(true)
      expect([...navigation.prefetched.keys()]).toEqual([])
    }
    finally {
      globalThis.XMLHttpRequest = real
      answered.mockRestore()
      form.remove()
      navigation.prefetched.clear()
    }
  })
})

describe('a page prefetched while a post was out', () => {
  it('is forgotten once the post finished, whether it went through or failed', async () => {
    for (const status of [200, 500]) {
      const answered = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/_kay/action/test/prefetching')) {
          swap.prefetch(new URL('http://localhost/next'), document.createElement('a'))
          await Bun.sleep(5)

          return new Response(status === 200 ? stringify('ok') : 'no', { status })
        }

        return new Response('<p>old</p>', { headers: { 'content-type': 'text/html' } })
      }) as unknown as typeof fetch)

      try {
        const save = actionStub('/_kay/action/test/prefetching') as unknown as (input: object) => Promise<unknown>

        try {
          await save({})
        }
        catch {}

        expect([...navigation.prefetched.keys()]).toEqual([])
      }
      finally {
        answered.mockRestore()
        navigation.prefetched.clear()
      }
    }
  })
})
