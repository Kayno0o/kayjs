import { existsSync } from 'node:fs'
import { expect, it } from 'bun:test'
import { ai } from '../src'
import { estimateTokens, translateUnits, unitProblem } from '../src/translation'

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

it('leaves a string field of a kind the app adds as it is, and translates a markdown one', async () => {
  const { collectPaths } = await import('../src/translate')
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      color: { 'type': 'string', 'x-kay': { kind: 'color' } },
      note: { 'type': 'string', 'x-kay': { kind: 'markdown' } },
      cover: { 'type': 'string', 'x-kay': { kind: 'image' } },
      swatches: { type: 'array', items: { 'type': 'string', 'x-kay': { kind: 'color' } } },
    },
  }
  const found: (string | number)[][] = []

  collectPaths(schema, { title: 'Hi', color: '#fff', note: 'Hello', cover: '/a.png', swatches: ['#000'] }, [], found)

  expect(found).toEqual([['title'], ['note']])
})
