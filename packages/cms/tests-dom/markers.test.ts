import type { FieldMarker } from '../src/markers'
import { describe, expect, it } from 'bun:test'
import { BODY, fieldsAt, formatMarker, parseMarker } from '../src/markers'

function render(html: string): HTMLElement {
  document.body.innerHTML = html

  return document.body
}

describe('parseMarker', () => {
  it('reads the collection, the entry, its locale and the field path', () => {
    expect(parseMarker('posts:hello:sections.1.heading')).toEqual({ collection: 'posts', slug: 'hello', path: 'sections.1.heading' })
    expect(parseMarker('posts:hello@fr:title')).toEqual({ collection: 'posts', slug: 'hello', locale: 'fr', path: 'title' })
  })

  it('decodes each segment, so a slug may hold `/`, `:` or `@`', () => {
    const marker = { collection: 'docs', slug: 'guides/a:b@c', locale: 'pt-BR', path: 'title' }

    expect(parseMarker(formatMarker(marker))).toEqual(marker)
    expect(formatMarker(marker)).toBe('docs:guides%2Fa%3Ab%40c@pt-BR:title')
  })

  it('reads a body marker, which names the entry alone', () => {
    const marker: FieldMarker = { collection: 'posts', slug: 'hello', locale: 'fr', path: BODY }

    expect(parseMarker('posts:hello@fr', true)).toEqual(marker)
    expect(formatMarker(marker)).toBe('posts:hello@fr')
    expect(parseMarker('posts:hello:title', true)).toBeUndefined()
  })

  it('refuses a malformed marker', () => {
    expect(parseMarker('posts:hello')).toBeUndefined()
    expect(parseMarker('posts::title')).toBeUndefined()
    expect(parseMarker('posts:a:b:c')).toBeUndefined()
    expect(parseMarker('posts:a@b@c:title')).toBeUndefined()
    expect(parseMarker('posts:%E0:title')).toBeUndefined()
  })
})

describe('fieldsAt', () => {
  it('finds the marked element a click lands in', () => {
    const body = render('<h1 data-kay-field="posts:hello:title">Hello <em>world</em></h1>')
    const [field] = fieldsAt(body.querySelector('em') as Element)

    expect(field?.marker.path).toBe('title')
    expect(field?.element).toBe(body.querySelector('h1') as Element)
  })

  it('gives every attribute an element renders a field in', () => {
    const body = render('<img data-kay-field-src="posts:hello:cover.src" data-kay-field-alt="posts:hello:cover.alt">')
    const fields = fieldsAt(body.querySelector('img') as Element)

    expect(fields.map(field => [field.attribute, field.marker.path])).toEqual([['src', 'cover.src'], ['alt', 'cover.alt']])
  })

  it('finds the comment pair around a field sharing its element with other text', () => {
    const body = render('<p data-kay-field="posts:hello:summary">By <!--kay-field posts:hello:author--><b>Ann</b><!--/kay-field--> on <!--kay-field posts:hello:date-->May 1<!--/kay-field--></p>')
    const paragraph = body.querySelector('p') as Element
    const [author] = fieldsAt(body.querySelector('b') as Element)
    const [date] = fieldsAt(paragraph.childNodes[6] as Node)
    const [plain] = fieldsAt(paragraph.childNodes[4] as Node)

    expect(author?.marker.path).toBe('author')
    expect(author?.start?.data).toBe('kay-field posts:hello:author')
    expect(date?.marker.path).toBe('date')
    expect(plain?.marker.path).toBe('summary')
  })

  it('prefers the innermost marker, and finds none outside them', () => {
    const body = render('<article data-kay-field="posts:hello:body"><h2 data-kay-field="posts:hello:sections.0.heading">One</h2><p>Text</p></article><footer>x</footer>')

    expect(fieldsAt(body.querySelector('h2') as Element)[0]?.marker.path).toBe('sections.0.heading')
    expect(fieldsAt(body.querySelector('p') as Element)[0]?.marker.path).toBe('body')
    expect(fieldsAt(body.querySelector('footer') as Element)).toEqual([])
  })
})

describe('fieldsAt on a Markdown body', () => {
  it('finds the element wrapping the body, and a body sharing its element through a comment pair', () => {
    const body = render('<article data-kay-body="posts:hello"><p>Some <em>text</em></p></article><div><!--kay-body posts:other--><p>Other</p><!--/kay-body--><p data-kay-field="posts:other:title">T</p></div>')

    expect(fieldsAt(body.querySelector('em') as Element)[0]?.marker).toEqual({ collection: 'posts', slug: 'hello', path: BODY })
    expect(fieldsAt(body.querySelector('div > p') as Element)[0]?.marker).toEqual({ collection: 'posts', slug: 'other', path: BODY })
    expect(fieldsAt(body.querySelector('div > p:last-child') as Element)[0]?.marker.path).toBe('title')
  })
})
