import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

// The lint's reports for a file, each with the source its safe fix leaves.
function found(source: string, filename = 'thing.kay') {
  const diagnostics = compileKay(source, filename, { check: true }).diagnostics.filter(d => d.code === 'deprecated-script-fence')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed: fix && [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source) }
  })
}

describe('deprecated-script-fence', () => {
  it('writes a leading --- script as ---', () => {
    expect(found('--- script\nconst n = 1\n---\np {n}\n')).toEqual([{ at: '--- script', safe: true, fixed: '---\nconst n = 1\n---\np {n}\n' }])
  })

  it('keeps the type parameters of a generic script', () => {
    expect(found('--- script <T extends string>\nconst { value } = props<{ value: T }>()\n---\np {value}\n')[0]?.fixed).toBe('--- <T extends string>\nconst { value } = props<{ value: T }>()\n---\np {value}\n')
  })

  it('reads past blank lines, and when a named fence follows', () => {
    expect(found('\n\n--- script\nconst n = 1\n--- style\np { color: red }\n---\np {n}\n')).toHaveLength(1)
    expect(found('--- script\nconst n = 1\n--- module\nexport const a = 1\n---\np {n}\n')).toHaveLength(1)
  })

  it('leaves a script that follows a named fence, where the word is needed', () => {
    expect(found('--- server\nconst n = 1\n--- script\nconst m = n\n---\np {m}\n', '_layout.kay')).toEqual([])
    expect(found('--- module\nexport const a = 1\n--- script\nconst m = a\n---\np {m}\n')).toEqual([])
    expect(found('--- style\np { color: red }\n--- script\nconst m = 1\n---\np {m}\n')).toEqual([])
  })

  it('leaves the bare fence, --- client and the pins alone', () => {
    expect(found('---\nconst n = 1\n---\np {n}\n')).toEqual([])
    expect(found('--- client\nconst n = 1\n---\np {n}\n')).toEqual([])
    expect(found('--- island\nconst n = 1\n---\np {n}\n')).toEqual([])
  })

  it('is not fooled by the word inside a template or a later fence line', () => {
    expect(found('---\nconst n = 1\n---\npre\n  | --- script\n')).toEqual([])
    expect(found('---\nconst n = 1\n--- script\n---\np {n}\n')).toEqual([])
  })
})
