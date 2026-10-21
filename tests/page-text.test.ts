import { describe, expect, it } from 'bun:test'
import { readPage } from '../src/test/page'

const text = (html: string, selector?: string) => readPage(`<body>${html}</body>`).text(selector)

describe('page.text', () => {
  it.each([
    ['list items', '<ul><li>Sites</li><li>Traffic</li></ul>', 'Sites Traffic'],
    ['paragraphs', '<p>one</p><p>two</p>', 'one two'],
    ['divs', '<div>one</div><div>two</div>', 'one two'],
    ['table cells and rows', '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>', 'a b c'],
    ['a heading and what follows', '<h1>Title</h1>Body', 'Title Body'],
    ['a nav of links in list items', '<header><nav><ul><li><a href="/">nginx-sites</a></li><li><a href="/sites">Sites</a></li></ul></nav></header>', 'nginx-sites Sites'],
    ['a line break', 'one<br>two', 'one two'],
    ['a self-closed line break', 'one<br/>two', 'one two'],
    ['a block inside a word', 'on<div>e</div>', 'on e'],
    ['buttons', '<button>Save</button><button>Cancel</button>', 'Save Cancel'],
  ])('separates %s', (_name, html, expected) => {
    expect(text(html)).toBe(expected)
  })

  it.each([
    ['a bold run inside a word', '<b>x</b>y', 'xy'],
    ['spans', '<span>one</span><span>two</span>', 'onetwo'],
    ['inline links and emphasis', 'a<a href="/">b</a><em>c</em><code>d</code>', 'abcd'],
    ['an inline element between blocks', '<p>one</p><b>x</b><p>two</p>', 'one x two'],
  ])('keeps %s joined', (_name, html, expected) => {
    expect(text(html)).toBe(expected)
  })

  it('leaves one space where whitespace is already between tags', () => {
    expect(text('<p>one</p> \n <p>two</p>')).toBe('one two')
    expect(text('<li>one </li><li> two</li>')).toBe('one two')
  })

  it('reads a selected element the same way, with no space at its edges', () => {
    expect(text('<ul class="x"><li>a</li><li>b</li></ul>', 'ul.x')).toBe('a b')
    expect(text('<li>a</li><li>b</li>', 'li')).toBe('a')
  })

  it('reads the text of every found element the same way', () => {
    expect(readPage('<body><ul><li>a</li><li>b</li></ul></body>').find('ul')[0]!.text).toBe('a b')
  })

  it('keeps leaving out scripts and styles', () => {
    expect(text('<p>one</p><script>var a</script><p>two</p><style>p{}</style>')).toBe('one two')
  })
})
