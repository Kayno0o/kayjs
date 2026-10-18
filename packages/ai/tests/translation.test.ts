import { existsSync } from 'node:fs'
import { expect, it } from 'bun:test'
import { ai } from '../src'
import { estimateTokens, systemPrompt, translateUnits, unitProblem } from '../src/translation'

const UNREADABLE = 'holds a tag the check cannot read'

const message = (text: string) => ({ id: '1', text, kind: 'message' as const })

it('is a kay command ai() adds as `kay i18n translate`', async () => {
  const { 'i18n translate': module } = ai().commands!

  expect(existsSync(module!)).toBe(true)
  expect((await import(module!) as { default: { usage: string } }).default.usage).toBe('i18n translate <locale> [--dry-run]')
})

it('checks a text against its source', () => {
  expect(unitProblem(message('Hello {name}'), 'Bonjour {name}')).toBeUndefined()
  expect(unitProblem(message('Hello {name}'), 'Bonjour')).toBe('drops {name}')
  expect(unitProblem(message('Hello'), 'Bonjour {who}')).toBe('invents {who}')
  expect(unitProblem(message('<b>Hi</b>'), 'Salut')).toBe('changes the tags of the source')
  expect(unitProblem(message('Hi'), 'Salut\nencore')).toBe('holds a line break the source has not')
  expect(unitProblem(message('Hi'), 'Salut\u2028encore')).toBe('holds a line break the source has not')
  expect(unitProblem(message('Hi\nthere'), 'Salut\nla')).toBeUndefined()
  expect(unitProblem(message('{n} and {n}'), '{n}')).toBe('changes how many times a placeholder appears')
  expect(unitProblem({ id: '1', kind: 'markdown', text: 'x\n\n[r]: /y' }, 'x\n\n[r]: /z')).toBe('changes the link targets or code fences of the source')
  expect(unitProblem(message('Hi'), '  ')).toBe('is empty')
  expect(unitProblem(message('Hi'), 3)).toBe('is not text')
  expect(unitProblem({ id: '1', kind: 'markdown', text: '[a](/x)\n```\ncode\n```' }, '[b](/y)\n```\ncode\n```')).toBe('changes the link targets or code fences of the source')
})

it('estimates more tokens for more text', () => {
  const small = estimateTokens([message('a')], 'en', 'fr')
  const large = estimateTokens([message('a'.repeat(4000))], 'en', 'fr')

  expect(large.input).toBeGreaterThan(small.input)
  expect(large.output).toBeGreaterThan(1000)
})

it('fences around the JSON reply are tolerated, and the usage of both asks is summed', async () => {
  const { fakeAi } = await import('../src')

  fakeAi.reply(['```json', '{ "1": "Salut" }', '```'].join('\n'))

  const result = await translateUnits([message('Hi')], { from: 'en', into: 'fr' })

  expect([...result.done]).toEqual([['1', 'Salut']])
  expect(result.inputTokens).toBeGreaterThan(0)
  fakeAi.clear()
})

it('lets the visible attributes of a tag be translated and holds every other one', () => {
  const html = (text: string) => message(text)

  expect(unitProblem(html('<a href="/x" title="Home">Go</a>'), '<a href="/x" title="Accueil">Aller</a>')).toBeUndefined()
  expect(unitProblem(html('<img src="/a.png" alt="A cat">'), '<img src="/a.png" alt="Un chat">')).toBeUndefined()
  expect(unitProblem(html('<input placeholder=\'Name\' aria-label="Your name">'), '<input placeholder=\'Nom\' aria-label="Votre nom">')).toBeUndefined()
  expect(unitProblem(html('<a title="a > b">x</a>'), '<a title="a > b, oui">x</a>')).toBeUndefined()
  expect(unitProblem(html('<a href="/x">Go</a>'), '<a href="/y">Aller</a>')).toBe('changes the tags of the source')
  expect(unitProblem(html('<img src="/a.png" alt="A">'), '<img src="/b.png" alt="A">')).toBe('changes the tags of the source')
  expect(unitProblem(html('<img src="/a.png" alt="A">'), '<img src="/a.png" alt="A" onerror="x()">')).toBe('changes the tags of the source')
  expect(unitProblem(html('<img src="/a.png" alt="A">'), '<img src="/a.png">')).toBe('changes the tags of the source')
  expect(unitProblem(html('<a title="Home">x</a>'), '<a title="Accueil" style="x:y">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(html('<a class="a b" title="T">x</a>'), '<a class="a" title="T">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(html('<a title="Home">x</a>'), '<a title="Accueil"><img src=x onerror=y>x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(html('<a title="Home">x</a>'), '<a title="a"><img src=x onerror=y> b">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(html('<a title="Home">x</a>'), '<a title="Accueil"')).toBe(UNREADABLE)
})

it('rejects a tag a browser reads that the check cannot count, an odd quote hiding it', () => {
  expect(unitProblem(message('Hello <b>world</b>'), 'Bonjour <b>monde</b><svg onload=alert(1) a\'b>')).toBe(UNREADABLE)
  expect(unitProblem(message('Hello'), 'Bonjour <img src=x"onerror=alert(1)>')).toBe(UNREADABLE)
  expect(unitProblem(message('Hello'), 'Bonjour <a title="x">')).toBe('changes the tags of the source')
  expect(unitProblem(message('a <b and c'), 'a <b et c')).toBe(UNREADABLE)
  expect(unitProblem(message('<a title="a b">x</a>'), '<a title="a" b>x</a>')).toBe('changes the tags of the source')
})

it('rejects a reply swapping, or a source holding, a tag the check cannot read', () => {
  expect(unitProblem(message('It\'s <a b=\'c'), 'C\'est <svg onload=alert(1) q=\'c')).toBe(UNREADABLE)
  expect(unitProblem(message('It\'s <a b=\'c'), 'It\'s <a b=\'c')).toBe(UNREADABLE)
  expect(unitProblem(message('<a b="c'), '<a b="d')).toBe(UNREADABLE)
  expect(unitProblem(message('<a b="c'), 'ok')).toBe(UNREADABLE)
  expect(unitProblem(message('ok'), '<a b="c')).toBe(UNREADABLE)
  expect(unitProblem(message('ok\n'), 'ok <svg\nonload=alert(1) a"b>')).toBe(UNREADABLE)
  expect(unitProblem(message('ok'), 'ok <a b<c>')).toBe(UNREADABLE)
  expect(unitProblem(message('<b>x</b>'), '<b>y</b> <a b=\'c')).toBe(UNREADABLE)
})

it('compares a tag split over lines, and the markup that is not a tag', () => {
  expect(unitProblem(message('<a\n  href="/x"\n  title="T">x</a>'), '<a\n href="/x"\n title="U">y</a>')).toBeUndefined()
  expect(unitProblem(message('<a\nhref="/x">x</a>'), '<a\nhref="/y">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(message('a &lt;b&gt; c'), 'a &lt;b&gt; d')).toBeUndefined()
  expect(unitProblem(message('a'), 'a &lt;script&gt;')).toBeUndefined()
  expect(unitProblem(message('a'), 'a <script>alert(1)</script>')).toBe(UNREADABLE)
  expect(unitProblem(message('a'), 'a <svg onload=alert(1)>')).toBe('changes the tags of the source')
  expect(unitProblem(message('a'), 'a <!-- x')).toBe(UNREADABLE)
  expect(unitProblem(message('a'), 'a <![CDATA[ x')).toBe(UNREADABLE)
  expect(unitProblem(message('a'), 'a <?x')).toBe(UNREADABLE)
  expect(unitProblem(message('<!-- c --> a'), '<!-- c --> b')).toBeUndefined()
  expect(unitProblem(message('<!-- c --> a'), '<!-- c --> <!-- d --> b')).toBe('changes the tags of the source')
  expect(unitProblem(message('<!-- <b> --> a'), '<!-- <i> --> b')).toBeUndefined()
  expect(unitProblem(message('a < b and c > d'), 'a < b et c > d')).toBeUndefined()
})

it('reads attributes with HTML whitespace only, so no-break space cannot hide a quote', () => {
  const source = message('<a title="Home">x</a>')

  for (const space of ['\u00A0', '\u000B', '\uFEFF', '\u3000']) {
    for (const quote of ['"', '\''])
      expect(unitProblem(source, `<a title=${space}${quote}> <img src=x onerror=alert(1)> ${quote}>x</a>`)).toBe(UNREADABLE)
  }

  expect(unitProblem(source, '<a title= "Accueil">x</a>')).toBeUndefined()
})

it('asks for the visible attributes to be translated', () => {
  expect(systemPrompt('en', 'fr')).toContain('title, alt, aria-label')
})

it('rejects a reply that reorders the tags of the source, or moves one into or out of a comment', () => {
  expect(unitProblem(message('<b>x</b> <i>y</i>'), '<i>y</i> <b>x</b>')).toBe('changes the tags of the source')
  expect(unitProblem(message('<b>x</b> a'), '</b>a <b>x')).toBe('changes the tags of the source')
  expect(unitProblem(message('<b>x</b> <i>y</i>'), '<b>x</b> <i>y</i>')).toBeUndefined()
  expect(unitProblem(message('<b>x</b> <i>y</i>'), '<b>X</b> <i>Y</i>')).toBeUndefined()
  expect(unitProblem(message('<b>x</b> <!-- c --> <i>y</i>'), '<!-- c --> <b>x</b> <i>y</i>')).toBe('changes the tags of the source')
  expect(unitProblem(message('<!-- <b> --> x </b>'), '<b> <!-- x --> </b>')).toBe('changes the tags of the source')
  expect(unitProblem(message('<!-- <b> --> x </b>'), '<!-- <b> --> y </b>')).toBeUndefined()
  expect(unitProblem(message('<a title="Home" href="/x">x</a>'), '<a href="/x" title="Accueil">x</a>')).toBeUndefined()
})

it('opens a quoted span only after an equals sign, as a browser does', () => {
  const source = message('<a title="Home">x</a>')

  expect(unitProblem(source, '<a x"> <img src=x onerror=alert(1)> ">x</a>')).toBe(UNREADABLE)
  expect(unitProblem(message('<a x">y</a>'), '<a x">y</a>')).toBe(UNREADABLE)
  expect(unitProblem(source, '<a title=b"c>x</a>')).toBe(UNREADABLE)
  expect(unitProblem(source, '<a title="Accueil" x\'>x</a>')).toBe(UNREADABLE)
  expect(unitProblem(source, '<a title = "Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(source, '<a title=\'Accueil\'>x</a>')).toBeUndefined()
})

it('fails a unit whose source holds an unreadable tag up front, without a request', async () => {
  const { fakeAi } = await import('../src')

  fakeAi.clear()
  fakeAi.reply('{ "1": "Salut" }')

  const result = await translateUnits([message('Hi'), { id: '2', text: 'It\'s <a b=\'c', kind: 'message' }], { from: 'en', into: 'fr' })

  expect([...result.done]).toEqual([['1', 'Salut']])
  expect(result.failed.get('2')).toBe('its source holds a tag the check cannot read')
  expect(fakeAi.asked).toHaveLength(1)
  expect(Object.keys(JSON.parse(fakeAi.asked[0]!.messages.at(-1)!.content) as object)).toEqual(['1'])

  fakeAi.clear()
  fakeAi.reply('{ "2": "Salut" }')

  const only = await translateUnits([{ id: '2', text: '<a b="c', kind: 'message' }], { from: 'en', into: 'fr' })

  expect(only.done.size).toBe(0)
  expect(only.failed.get('2')).toBe('its source holds a tag the check cannot read')
  expect(fakeAi.asked).toHaveLength(0)
  expect(only.inputTokens).toBe(0)
  fakeAi.clear()
})

it('reads a comment as a browser does, so a quote inside it cannot hide a live tag', () => {
  const source = message('<!-- c --> <a title="Home">x</a>')

  expect(unitProblem(source, '<!-- <a title=" --> <img onerror=alert(1)> ">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(source, '<!-- <a title=\' --> <img onerror=alert(1)> \'>x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(source, '<!-- c --> <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(source, '<!-- c --!> <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(source, '<!--> <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(message('<!--> <a title="Home">x</a>'), '<!--> <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(message('<!---> <a title="Home">x</a>'), '<!---> <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(message('<!--> <a title="Home">x</a>'), '<!-- --> <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(source, '<!x> <a title="Accueil">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(source, '<![CDATA[ c ]]> <a title="Accueil">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(source, '<!-- c <a title="Accueil">x</a>')).toBe(UNREADABLE)
  expect(unitProblem(message('<?x?> a'), '<!x> a')).toBe('changes the tags of the source')
})

it('reads `</` and a non-letter as a bogus comment, as a browser does', () => {
  const source = message('<a title="Home">x</a>')

  for (const start of ['</ ', '</3', '</>', '</"', '</!', '</-'])
    expect(unitProblem(source, `${start}<a title=" > <img onerror=alert(1)> ">x</a>`)).toBe('changes the tags of the source')

  expect(unitProblem(source, '</ never closed')).toBe(UNREADABLE)
  expect(unitProblem(source, '</')).toBe(UNREADABLE)
  expect(unitProblem(message('a </ b > <a title="Home">x</a>'), 'a </ c > <a title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(message('a'), 'a </é>')).toBe('changes the tags of the source')
  expect(unitProblem(message('a < b'), 'a < c')).toBeUndefined()
  expect(unitProblem(message('a <3 b'), 'a <3 c')).toBeUndefined()
})

it('does not read what follows a raw text element as markup, it holds the element as unreadable', () => {
  for (const name of ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript', 'SCRIPT']) {
    expect(unitProblem(message(`<${name}>a</${name}>`), `<${name}>b</${name}>`)).toBe(UNREADABLE)
    expect(unitProblem(message('a'), `a <${name}>`)).toBe(UNREADABLE)
  }

  expect(unitProblem(message('<scripts>a</scripts>'), '<scripts>b</scripts>')).toBeUndefined()
})

it('reads the other tag-open states as a browser does', () => {
  const source = message('<a title="Home">x</a>')

  expect(unitProblem(source, '<a/title="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(source, '<a\ttitle="Accueil">x</a>')).toBeUndefined()
  expect(unitProblem(source, '<a title=>x</a>')).toBeUndefined()
  expect(unitProblem(source, '<a href=>x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(source, '<a title=x<y>x</a>')).toBe(UNREADABLE)
  expect(unitProblem(source, '<a"b title="Accueil">x</a>')).toBe(UNREADABLE)
  expect(unitProblem(source, '<a title="Accueil"/>x</a>')).toBeUndefined()
  expect(unitProblem(source, '<?xml title=" ?> <img onerror=alert(1)> ">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(source, '<![CDATA[ " ]]> <a title="Accueil">x</a>')).toBe('changes the tags of the source')
  expect(unitProblem(message('<svg><![CDATA[ a > b ]]></svg>'), '<svg><![CDATA[ a > c ]]></svg>')).toBeUndefined()
})
