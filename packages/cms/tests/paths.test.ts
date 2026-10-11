import { describe, expect, it } from 'bun:test'
import { joinPath, valueAt, withValueAt } from '../src/paths'

describe('paths', () => {
  const data = { title: 'Hi', tags: ['a', 'b'], sections: [{ heading: 'One' }, { heading: 'Two' }] }

  it('reads keys and list indexes', () => {
    expect(valueAt(data, 'title')).toBe('Hi')
    expect(valueAt(data, 'tags.1')).toBe('b')
    expect(valueAt(data, 'sections.1.heading')).toBe('Two')
    expect(valueAt(data, 'sections.5.heading')).toBeUndefined()
    expect(valueAt(data, 'title.length.x')).toBeUndefined()
  })

  it('writes a copy, sharing what it leaves alone', () => {
    const next = withValueAt(data, 'sections.0.heading', 'First')

    expect(next.sections[0]?.heading).toBe('First')
    expect(data.sections[0]?.heading).toBe('One')
    expect(next.sections[1]).toBe(data.sections[1])
    expect(next.tags).toBe(data.tags)
    expect(Array.isArray(next.sections)).toBe(true)
  })

  it('creates the lists and objects on the way', () => {
    expect(withValueAt({}, 'links.0.url', '/x')).toEqual({ links: [{ url: '/x' }] })
  })

  it('joins a child key onto its parent', () => {
    expect(joinPath('', 'title')).toBe('title')
    expect(joinPath('sections', 2)).toBe('sections.2')
  })
})
