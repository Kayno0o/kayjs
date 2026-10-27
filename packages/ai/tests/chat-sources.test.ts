import { afterEach, expect, test } from 'bun:test'
import { ai, ask, fakeAi } from '../src'
import { citedAsWritten, linkAsWritten, linkSources, opensApart, sameSources, usableSources } from '../src/chat-sources'

afterEach(() => {
  ai()
  fakeAi.clear()
})

const sources = [{ n: 1, title: 'Tides', href: 'https://example.com/a?x=1&y="2"' }, { n: 2, title: 'Moon', href: '/moon' }]

test('each [n] outside code and links becomes a link to its source, and the cited sources come in the order cited', () => {
  const { html, cited } = linkSources('<p>See [2] and [1], [1] again, [3] unknown, <code>[1]</code> <a href="/x">[2]</a></p><pre><code>[2]</code></pre><p>[2][1]</p>', sources)

  expect(html).toContain('<p>See <a href="/moon">[2]</a> and <a href="https://example.com/a?x=1&amp;y=&quot;2&quot;">[1]</a>, ')
  expect(html).toContain('[3] unknown, <code>[1]</code> <a href="/x">[2]</a></p><pre><code>[2]</code></pre>')
  expect(html).toEndWith('<p><a href="/moon">[2]</a><a href="https://example.com/a?x=1&amp;y=&quot;2&quot;">[1]</a></p>')
  expect(cited.map(source => source.n)).toEqual([2, 1])
})

test('the sources of a text still to be rendered leave out those cited only in a code span or a fence, as its rendered list does', () => {
  const numbers = (markdown: string) => citedAsWritten(markdown, sources).map(source => source.n)

  expect(numbers('See [2] and `[1]`.')).toEqual([2])
  expect(numbers('Only ``a [1] ` b`` here.')).toEqual([])
  expect(numbers('Fenced:\n\n```ts\n[1]\n```\n\nthen [2]')).toEqual([2])
  expect(numbers('~~~\n[1]\n[2]\n~~~')).toEqual([])
  expect(numbers('```\n[1] in a fence never closed')).toEqual([])
  expect(numbers('a ` lone tick [1]')).toEqual([1])
  expect(numbers('1 < 2 and [1] > 0')).toEqual([1])
  expect(numbers('[01] [12345]')).toEqual([])
  expect(numbers('- ```\n  [1]\n  ```\n[2]')).toEqual([2])
  expect(numbers('> ```\n> [1]\n> ```\n\n[2]')).toEqual([2])
  expect(numbers('\\`[1]\\` [2]')).toEqual([1, 2])
  expect(numbers('`a\n\nb [1]` [2]')).toEqual([1, 2])
  expect(numbers('```a`b\n[1]\n[2]')).toEqual([1, 2])
})

test('a reply as written links each [n] outside its code spans and fences, escaped as the stand-in of the Markdown renderer', () => {
  expect(linkAsWritten('Tides [1][2], see `[1]` and [3x] & <b>[4]</b>', sources)).toEqual({ html: '<p>Tides <a href="https://example.com/a?x=1&amp;y=&quot;2&quot;">[1]</a><a href="/moon">[2]</a>, see `[1]` and [3x] &amp; &lt;b&gt;[4]&lt;/b&gt;</p>\n', cited: sources })
  expect(linkAsWritten('Only `[1]` and\n\n```\n[2]\n```', sources)).toEqual({ html: '<p>Only `[1]` and\n\n```\n[2]\n```</p>\n', cited: [] })
  expect(linkAsWritten('`<code>[1]</code>` [2]', sources).html).toBe('<p>`&lt;code&gt;[1]&lt;/code&gt;` <a href="/moon">[2]</a></p>\n')
  expect(linkAsWritten('- ~~~\n  [1]\n  ~~~\n\n> ```\n> [2]\n> ```\n\n\\`[1]\\`', sources)).toEqual({ html: '<p>- ~~~\n  [1]\n  ~~~\n\n&gt; ```\n&gt; [2]\n&gt; ```\n\n\\`<a href="https://example.com/a?x=1&amp;y=&quot;2&quot;">[1]</a>\\`</p>\n', cited: [sources[0]!] })
  expect(linkAsWritten('[1]', []).html).toBe('<p>[1]</p>\n')
})

test('a reply with no sources is left as it is', () => {
  expect(linkSources('<p>[1]</p>', [])).toEqual({ html: '<p>[1]</p>', cited: [] })
})

test('only well-formed sources with a safe href are used, one per number', () => {
  expect(usableSources([{ n: 1, title: 'a', href: 'javascript:alert(1)' }, { n: 2, title: 'b', href: '//evil.example' }, { n: 5, title: 'g', href: '/\\evil.example' }, { n: 6, title: 'h', href: '/\t/evil.example' }, { n: 7, title: 'i', href: 'https://en.wikipedia.org/wiki/Peter_O\'Toole' }, { n: 8, title: 'j', href: 'https://x.example/a b' }, { n: 3, title: 'c', href: 'https://x.example' }, { n: 3, title: 'dup', href: '/d' }, { n: 1.5, title: 'e', href: '/e' }, { title: 'f', href: '/f' }, null, 'x'])).toEqual([{ n: 3, title: 'c', href: 'https://x.example' }])
  expect(usableSources(undefined)).toEqual([])
})

test('progress carries the sources of the ask beside the text, and none without them', async () => {
  fakeAi.reply('See [1].')

  const withSources: unknown[] = []

  for await (const snapshot of ask('q', { sources }).progress())
    withSources.push(snapshot)

  expect(withSources.length).toBeGreaterThan(0)
  expect(withSources.every(snapshot => JSON.stringify((snapshot as { sources: unknown }).sources) === JSON.stringify(sources))).toBe(true)

  fakeAi.reply('See [1].')

  for await (const snapshot of ask('q').progress())
    expect(snapshot).not.toHaveProperty('sources')
})

test('a citation is one to four digits without a leading zero: [01] and [12345] stay text, even for a source with that number', () => {
  const many = [{ n: 1, title: 'a', href: '/a' }, { n: 12345, title: 'b', href: '/b' }, { n: 9999, title: 'c', href: '/c' }]

  expect(linkSources('<p>[01] [12345] [0] [9999]</p>', many)).toEqual({ html: '<p>[01] [12345] [0] <a href="/c">[9999]</a></p>', cited: [many[2]!] })
})

test('a link opens apart unless it is a path or an anchor of this site and the chat keeps them in place', () => {
  expect([['/moon', true], ['#top', true], ['//evil.example', true], ['/\\evil.example', true], ['https://example.com', true], ['/moon', false]].map(([href, here]) => opensApart(href as string, here as boolean))).toEqual([false, false, true, true, true, true])
})

test('two lists are the same sources when every number, title and address matches in order', () => {
  expect(sameSources(sources, [...sources])).toBe(true)
  expect(sameSources(sources, sources.slice(0, 1))).toBe(false)
  expect(sameSources(sources, [sources[0]!, { ...sources[1]!, href: '/other' }])).toBe(false)
  expect(sameSources([], [])).toBe(true)
})
