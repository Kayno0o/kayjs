import type { TestSite } from '../src/test'
import { beforeAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { readPage } from '../src/test/page'

describe('reading a page', () => {
  const seo = { name: 'Kay & co', titleTemplate: '%s | Kay & co', description: 'A site built with kay', jsonLd: [{ '@type': 'WebSite', 'name': 'Kay </script>  site' }, { '@type': 'Organization', 'name': 'Kay & co' }] }
  // Built once the tests before have built theirs, as the last site sets the origin siteUrl() reads.
  let read: TestSite

  beforeAll(async () => {
    read = await testSite({ root: 'tests/fixtures/seo', site: 'https://example.com/', seo })
  })

  it('gives its title, meta, canonical URL and JSON-LD as a crawler reads them', async () => {
    const page = await read.visit('/about')

    expect(page.title()).toBe('About | Kay & co')
    expect(page.meta('description')).toBe('Who we are')
    expect(page.meta('og:site_name')).toBe('Kay & co')
    expect(page.meta('og:image')).toBeUndefined()
    expect(page.canonical()).toBe('https://example.com/about')
    // A @graph's items one by one, a script's text read as written.
    expect(page.jsonLd()).toEqual([{ '@context': 'https://schema.org', '@type': 'WebSite', 'name': 'Kay </script>  site' }, { '@context': 'https://schema.org', '@type': 'Organization', 'name': 'Kay & co' }])
  })

  it('gives its links and the elements a selector matches, their text squashed', async () => {
    const page = await read.visit('/trail')

    expect(page.links()).toEqual(['/', '/trail/', '/trail?tab=2', '/trail#end', '/trail'])
    expect(page.find('a[aria-current="page"]')).toEqual([{ tag: 'a', attributes: { 'href': '/trail/', 'aria-current': 'page' }, text: 'Trail', html: 'Trail' }])
    expect(page.find('nav')[0]!.text).toBe('HomeTrailTabEndStep')
    expect(page.jsonLd()).toContainEqual(expect.objectContaining({ '@type': 'BreadcrumbList' }))
    expect(page.find('h2')).toEqual([])
  })

  it('gives the markup an element holds as the page wrote it, empty for one that holds none', () => {
    const page = readPage('<body><a href="/" class="logo"><svg viewBox="0 0 1 1"><path d="M0"/></svg> Home &amp; <b>away</b></a><a href="/x"><img src="a.png"></a><br><ul><li><ul><li>deep</li></ul></li></ul></body>')
    const [logo, plain] = page.find('a')

    expect(logo!.html).toBe('<svg viewBox="0 0 1 1"><path d="M0"/></svg> Home &amp; <b>away</b>')
    expect(logo!.text).toBe('Home & away')
    expect(plain!.html).toBe('<img src="a.png">')
    expect(page.find('img')[0]!.html).toBe('')
    expect(page.find('br')[0]!.html).toBe('')
    // A selector matching nested elements gives each its own.
    expect(page.find('ul').map(({ html }) => html)).toEqual(['<li><ul><li>deep</li></ul></li>', '<li>deep</li>'])
    expect(page.find('li').map(({ html }) => html)).toEqual(['<ul><li>deep</li></ul>', 'deep'])
    // An element the page never closes holds the rest of it, as the parser sees no end tag to stop at.
    expect(readPage('<span>one<b>x</b>').find('span')[0]!.html).toBe('one<b>x</b>')
  })

  it('ends an element a browser closes by itself where the browser would', () => {
    expect(readPage('<p>one<p>two').find('p').map(({ html, text }) => [html, text])).toEqual([['one', 'one'], ['two', 'two']])
    expect(readPage('<p>one<div>x</div>').find('p')[0]!.html).toBe('one')
    expect(readPage('<ul><li>a<li>b<ul><li>c</ul><li>d</ul>tail').find('li').map(({ html }) => html)).toEqual(['a', 'b<ul><li>c</ul>', 'c', 'd'])
    expect(readPage('<dl><dt>a<dd>b<dt>c</dl>').find('dd, dt').map(({ html }) => html)).toEqual(['a', 'b', 'c'])
  })

  it('closes an element through the open elements above it, without crossing a scope boundary', () => {
    const htmls = (html: string, selector: string) => readPage(html).find(selector).map(({ html }) => html)

    expect(htmls('<ul><li><span>a<li>b</ul>', 'li')).toEqual(['<span>a', 'b'])
    expect(htmls('<ul><li><div>a<li>b</div></ul>', 'li')).toEqual(['<div>a', 'b'])
    expect(htmls('<ul><li>a<ul><li>b</ul><li>c</ul>', 'li')).toEqual(['a<ul><li>b</ul>', 'b', 'c'])
    expect(htmls('<dl><dt><b>a<dd>b</dl>', 'dt, dd')).toEqual(['<b>a', 'b'])
    expect(htmls('<div><p><b>one<div>two</div>', 'p')).toEqual(['<b>one'])
    expect(htmls('<p><span>one<p>two', 'p')).toEqual(['<span>one', 'two'])
    // A table cell or a button holds its own scope: the outer paragraph stays open.
    expect(htmls('<p>a<button>b<div>c</div></button>d', 'p')).toEqual(['a<button>b<div>c</div></button>d'])
    expect(htmls('<p>a<table><tr><td>b<div>c</div></td></tr></table>d', 'p')).toEqual(['a'])
  })

  it('closes cells, rows, sections and options by the next one', () => {
    const htmls = (html: string, selector: string) => readPage(html).find(selector).map(({ html }) => html)

    expect(htmls('<table><tr><td>a<td>b<th>c</table>', 'td, th')).toEqual(['a', 'b', 'c'])
    expect(htmls('<table><tr><td><b>a<td>b</table>', 'td')).toEqual(['<b>a', 'b'])
    expect(htmls('<table><tr><td>a<tr><td>b</table>', 'tr')).toEqual(['<td>a', '<td>b'])
    expect(htmls('<table><thead><tr><th>a<tbody><tr><td>b</table>', 'thead, tbody')).toEqual(['<tr><th>a', '<tr><td>b'])
    expect(htmls('<table><tbody><tr><td>a<tbody><tr><td>b</table>', 'tbody')).toEqual(['<tr><td>a', '<tr><td>b'])
    // A table nested in a cell has its own rows.
    expect(htmls('<table><tr><td><table><tr><td>x</table><td>y</table>', 'td')).toEqual(['<table><tr><td>x</table>', 'x', 'y'])
    expect(htmls('<select><option>a<option>b<optgroup label=g><option>c</select>', 'option, optgroup')).toEqual(['a', 'b', '<option>c', 'c'])
    expect(htmls('<select><optgroup label=a><option>x<optgroup label=b><option>y</select>', 'optgroup')).toEqual(['<option>x', '<option>y'])
  })

  it('reads the markup of an element beside a comment that looks like its own marker', () => {
    const page = readPage('<!--kay-open-0--><p>one</p><!--kay-close-0-->')

    expect(page.find('p')[0]!.html).toBe('one')
  })

  it('reads past a self-closing script or style, as an inline SVG may hold', () => {
    expect(readPage('<body><svg><style/><script/></svg><p>Shown</p></body>').text()).toBe('Shown')
  })

  it('lists the sitemap\'s URLs, and fails on one that does not answer', async () => {
    expect(await read.sitemap()).toContain('https://example.com/about')
    expect(await read.sitemap()).toContain('https://example.com/blog/a%20%26%20b')
    await expect(read.sitemap('/nope.xml')).rejects.toThrow('/nope.xml answered 404')
  })
})
