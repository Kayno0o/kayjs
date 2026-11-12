import { describe, expect, it } from 'bun:test'
import { cookieJar } from '../src/test/cookies'
import { readPage } from '../src/test/page'

function response(...lines: string[]): Response {
  const headers = new Headers()

  for (const line of lines)
    headers.append('set-cookie', line)

  return new Response('', { headers })
}

describe('the test cookie jar', () => {
  it('keeps a name once per path, as a browser does', () => {
    const jar = cookieJar()

    jar.keep(response('c=1; Path=/admin', 'c=2; Path=/other'))

    expect(jar.header('/admin')).toBe('c=1')
    expect(jar.header('/other')).toBe('c=2')
    expect(jar.header('/')).toBe('')
    expect(jar.cookies.get('c')).toBe('2')
  })

  it('replaces a cookie of the same name and path', () => {
    const jar = cookieJar()

    jar.keep(response('c=1; Path=/a'))
    jar.keep(response('c=3; Path=/a'))

    expect(jar.header('/a')).toBe('c=3')
  })

  it('drops a cookie only through its own path', () => {
    const jar = cookieJar()

    jar.keep(response('p=1; Path=/a'))
    jar.keep(response('p=; Max-Age=0; Path=/b'))

    expect(jar.header('/a')).toBe('p=1')

    jar.keep(response('p=; Max-Age=0; Path=/a'))

    expect(jar.header('/a')).toBe('')
    expect(jar.cookies.has('p')).toBe(false)
  })

  it('shows the remaining cookie of a name when the latest one expires', () => {
    const jar = cookieJar()

    jar.keep(response('c=1; Path=/a', 'c=2; Path=/b'))
    jar.keep(response('c=; Max-Age=0; Path=/b'))

    expect(jar.cookies.get('c')).toBe('1')
    expect(jar.header('/a')).toBe('c=1')
  })

  it('sends a cookie a test wrote itself to every path', () => {
    const jar = cookieJar()

    jar.keep(response('c=1; Path=/a'))
    jar.cookies.set('c', 'mine')

    expect(jar.header('/z')).toBe('c=mine')
  })
})

describe('reading a page', () => {
  it('decodes every named entity of the page, in text and attributes', () => {
    const page = readPage('<footer>&copy; 2026 a&nbsp;b &eacute; &hellip;</footer><a href="/x" title="&eacute;">l</a>')

    expect(page.text('footer')).toBe('© 2026 a b é …')
    expect(page.find('a')[0]!.attributes.title).toBe('é')
  })

  it('leaves an unknown name and reads a reference out of range as U+FFFD', () => {
    expect(readPage('<p>&nope; &constructor; &#1114112; &#xD800; &#0;</p>').text('p')).toBe('&nope; &constructor; � � �')
  })
})
