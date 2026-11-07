import { describe, expect, it } from 'bun:test'
import { authErrorKind } from '../src/check/auth-error'

const NO_OVERLAP = 'This comparison appears to be unintentional because the types \'AuthFailure<"limited"> | AuthFailure<"invalid">\' and \'"limited"\' have no overlap.'
const NOT_COMPARABLE = 'Type \'"banned"\' is not comparable to type \'AuthFailure<"banned"> | AuthFailure<"invalid">\'.'

// Applies the fix of the lint found at `offset`, as `kay check --fix` does.
function fixed(source: string, offset: number, code: number, message = code === 2367 ? NO_OVERLAP : NOT_COMPARABLE, file = 'src/a.ts'): string | undefined {
  const edits = authErrorKind(file, source, offset, code, message)?.fix?.edits

  return edits?.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
}

describe('deprecated-auth-error', () => {
  it('reads error.code in a comparison of an auth result, either way round and with every operator', () => {
    for (const operator of ['===', '!==', '==', '!='])
      expect(fixed(`if (result.error ${operator} 'limited') stop()`, 4, 2367)).toBe(`if (result.error.code ${operator} 'limited') stop()`)

    expect(fixed('if (!result.ok && \'invalid\' !== result.error) stop()', 18, 2367)).toBe('if (!result.ok && \'invalid\' !== result.error.code) stop()')
    expect(fixed('if (a.b.error === "x") stop()', 4, 2367)).toBe('if (a.b.error.code === "x") stop()')
  })

  it('keeps a result that may be missing optional', () => {
    expect(fixed('if (result?.error === \'limited\') stop()', 4, 2367)).toBe('if (result?.error?.code === \'limited\') stop()')
  })

  it('reports a comparison it cannot rewrite with no fix, and leaves a type error that names no auth result alone', () => {
    const found = authErrorKind('src/a.ts', 'if (first(result).error === \'limited\') stop()', 4, 2367, NO_OVERLAP)

    expect(found?.fix).toBeUndefined()
    expect(found?.message).toContain('ErrorShape')
    expect(authErrorKind('src/a.ts', 'if (a.error === \'x\') stop()', 4, 2367, 'This comparison appears to be unintentional because the types \'Foo\' and \'"x"\' have no overlap.')).toBeUndefined()
    expect(authErrorKind('src/a.ts', 'const a = 1', 0, 2322, NO_OVERLAP)).toBeUndefined()
  })

  it('switches over error.code, from a module and from the server fence of a component', () => {
    const module = 'function f() {\n  switch (result.error) {\n    case \'banned\':\n      return 1\n  }\n}\n'

    expect(fixed(module, module.indexOf('\'banned\''), 2678)).toBe(module.replace('result.error)', 'result.error.code)'))

    const kay = '--- server\nswitch (result.error) {\n  case \'banned\':\n    break\n}\n---\np x\n'

    expect(fixed(kay, kay.indexOf('\'banned\''), 2678, undefined, 'src/page.kay')).toBe(kay.replace('result.error)', 'result.error.code)'))
  })

  it('leaves a switch over something else with no fix', () => {
    const source = 'switch (result.status) {\n  case \'banned\':\n    break\n}\n'

    expect(authErrorKind('src/a.ts', source, source.indexOf('\'banned\''), 2678, NOT_COMPARABLE)?.fix).toBeUndefined()
  })
})
