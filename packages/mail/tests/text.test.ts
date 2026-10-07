import { describe, expect, it } from 'bun:test'
import { htmlToText } from '../src/text'

describe('htmlToText', () => {
  it('puts blocks on lines of their own and folds the spaces inside them', () => {
    expect(htmlToText('<!doctype html><html><head><title>Hi</title><style>p{color:red}</style></head><body><h1>Hello</h1>\n  <p>First   line<br>second line</p><div>Last</div></body></html>')).toBe('Hello\n\nFirst line\nsecond line\n\nLast')
  })

  it('follows a link with its address unless the label already is it', () => {
    expect(htmlToText('<p>Read <a href="https://example.com/terms?a=1&amp;b=2">the terms</a> today.</p>')).toBe('Read the terms (https://example.com/terms?a=1&b=2) today.')
    expect(htmlToText('<p><a href="https://example.com">https://example.com</a></p>')).toBe('https://example.com')
    expect(htmlToText('<p>Write to <a href="mailto:hello@example.com">hello@example.com</a></p>')).toBe('Write to hello@example.com')
    expect(htmlToText('<p><a href="#top">Top</a> <a href="/about">About</a></p>')).toBe('Top About')
  })

  it('dashes list items, numbers ordered ones and indents nested lists', () => {
    expect(htmlToText('<ul><li>One</li><li>Two<ol><li>Inner</li><li>Next</li></ol></li></ul>')).toBe('- One\n- Two\n\n  1. Inner\n  2. Next')
  })

  it('leaves out what the html hides, a preheader say, and shows images by their alt text', () => {
    expect(htmlToText('<div style="display:none"><div>Preview</div> text</div><p aria-hidden="true">Gone</p><p hidden>Also</p><p><img src="x.png" alt="Logo"> Kept <img src="y.png" aria-hidden="true" alt="Spacer"></p>')).toBe('Logo Kept')
    expect(htmlToText('<div style="overflow:hidden">Shown</div>')).toBe('Shown')
    expect(htmlToText('<p><a title="the hidden gem" class="display: none" href="https://x.test/a">Gem</a></p>')).toBe('Gem (https://x.test/a)')
  })

  it('decodes character references and keeps a pre block as written', () => {
    expect(htmlToText('<p>Fish &amp; chips &lt;3 &#233;t&#xE9; a&nbsp;b</p><pre>  two\n  lines</pre>')).toBe('Fish & chips <3 été a b\n\n  two\n  lines')
  })

  it('keeps a lone angle bracket, decodes the entities html written by hand holds, and leaves an impossible one as written', () => {
    expect(htmlToText('<p>5 < 6 &copy; &hellip; &#x110000;</p>')).toBe(`5 < 6 ${String.fromCharCode(169)} ${String.fromCharCode(8230)} &#x110000;`)
  })

  it('separates table cells', () => {
    expect(htmlToText('<table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>3 €</td></tr></table>')).toBe('Item Price\n\nTea 3 €')
  })
})
