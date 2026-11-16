import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const HEAD = '---\nimport Card from \'./card.kay\'\nimport Tag from \'./tag.kay\'\nconst on = true\nconst tone = \'a\'\n---\n'

function run(source: string) {
  const found = compileKay(source, 'page.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-parts-class')
  const edits = found.flatMap(d => d.fixes?.[0]?.edits ?? []).sort((a, b) => b.start - a.start)

  return {
    at: found.map(d => source.slice(d.start, d.end)),
    safe: found.map(d => d.fixes?.[0]?.safe),
    fixed: edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source),
  }
}

describe('deprecated-parts-class', () => {
  it('writes parts for the class object of strings, a nested object, a choice and an array of a component call', () => {
    const source = `${HEAD}Card(class={{ head: 'p-6', body: \`p-\${tone}\` }})\nCard(class={{ root: 'mt-4', card: { head: 'p-2' } }})\nCard(class={{ head: on ? 'p-2' : 'p-4', body: ['a', 'b'] }})\nCard.mt-4(title="x" class={{ head: 'p-6' }})\n`
    const result = run(source)

    expect(result.at).toEqual(['class', 'class', 'class', 'class'])
    expect(result.safe).toEqual([true, true, true, true])
    expect(result.fixed).toBe(source.replaceAll('class={{', 'parts={{'))
  })

  it('leaves a class of conditions, a string, an array, a spread and an element alone', () => {
    const source = `${HEAD}Tag(class={{ on }})\nTag(class={{ 'p-4': on, flex: tone === 'a' }})\nTag(class="p-2")\nTag(class={['a', { b: on }]})\nTag(class={{ ...{ head: 'a' } }})\nTag(class={{}})\ndiv(class={{ head: 'p-6' }})\n`

    expect(run(source).at).toEqual([])
  })

  it('offers no fix where the call already has parts', () => {
    const result = run(`${HEAD}Card(class={{ head: 'p-6' }} parts={{ body: 'p-2' }})\n`)

    expect(result.at).toEqual(['class'])
    expect(result.safe).toEqual([undefined])
  })
})
