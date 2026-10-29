import { describe, expect, it } from 'bun:test'
import { USAGES } from '../src/commands/usages'
import { compileKay, formatDiagnostic } from '../src/compiler'
import { formatKay } from '../src/format'

const readme = await Bun.file(new URL('../README.md', import.meta.url)).text()
// A command's name is one or two words: `kay i18n missing` is the name `i18n missing`, `kay new` the name `new`.
const COMMAND_ROW = /^\| `kay ([a-z0-9-]+(?: [a-z]+)?)` \|/gm
const KAY_BLOCK = /```kay\n([\s\S]*?)```/g

describe('README', () => {
  it('lists exactly the commands of the CLI', () => {
    const listed = [...readme.matchAll(COMMAND_ROW)].map(match => match[1]!)

    expect(listed.toSorted()).toEqual(Object.keys(USAGES).toSorted())
  })

  it('links the release notes and the upgrade notes it ships beside', () => {
    expect(readme).toContain('](llms/whats-new.md)')
    expect(readme).toContain('](llms/upgrading.md)')
  })

  it.each([...readme.matchAll(KAY_BLOCK)].map((match, index) => [index, match[1]!] as const))('example %d compiles cleanly and is formatted', (_index, source) => {
    const { diagnostics } = compileKay(source, 'src/example.kay')

    expect(diagnostics.map(diagnostic => formatDiagnostic(source, 'src/example.kay', diagnostic))).toEqual([])
    expect(formatKay(source).code).toBe(source)
  })
})
