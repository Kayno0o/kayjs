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
  expect(unitProblem(message('a'), 'a <script>alert(1)</script>')).toBe('changes the tags of the source')
  expect(unitProblem(message('a'), 'a <svg onload=alert(1)>')).toBe('changes the tags of the source')
  expect(unitProblem(message('a'), 'a <!-- x')).toBe('changes the tags of the source')
  expect(unitProblem(message('a'), 'a <![CDATA[ x')).toBe('changes the tags of the source')
  expect(unitProblem(message('a'), 'a <?x')).toBe('changes the tags of the source')
  expect(unitProblem(message('<!-- c --> a'), '<!-- c --> b')).toBeUndefined()
  expect(unitProblem(message('<!-- c --> a'), '<!-- c --> <!-- d --> b')).toBe('changes the tags of the source')
  expect(unitProblem(message('<!-- <b> --> a'), '<!-- <i> --> b')).toBe('changes the tags of the source')
  expect(unitProblem(message('a < b and c > d'), 'a < b et c > d')).toBeUndefined()
})

it('asks for the visible attributes to be translated', () => {
  expect(systemPrompt('en', 'fr')).toContain('title, alt, aria-label')
})
