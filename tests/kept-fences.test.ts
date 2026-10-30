import { describe, expect, it } from 'bun:test'
import { fences } from '../src/build/libraries'
import { scriptImportsOf } from '../src/check/island-modules'

const first = '---\nimport a from "./a"\n--- server\nimport b from "./b"\n---\ndiv\n'
const second = '---\nimport c from "./c"\n---\ndiv\n'

describe('fences', () => {
  it('answers the same text for a source asked again and tells two sources apart', () => {
    expect(fences(first)).toContain('./a')
    expect(fences(first)).toContain('./b')
    expect(fences(first)).toBe(fences(first))
    expect(fences(second)).toContain('./c')
    expect(fences(second)).not.toContain('./a')
  })
})

describe('scriptImportsOf', () => {
  it('answers the imports of each source and a copy the caller may change', () => {
    const imports = scriptImportsOf(first)

    expect(imports).toEqual(['./a'])
    imports.push('./changed')
    expect(scriptImportsOf(first)).toEqual(['./a'])
    expect(scriptImportsOf(second)).toEqual(['./c'])
  })
})
