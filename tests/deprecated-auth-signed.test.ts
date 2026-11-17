import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import SignedIn from \'@kayjs/auth/components/signed-in.kay\'',
  'import SignedOut from \'@kayjs/auth/components/signed-out.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of the first fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'nav.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-auth-signed')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-auth-signed', () => {
  it('writes the role of a SignedIn as require', () => {
    expect(found('SignedIn(role="admin")\n  p Admin')).toEqual([{ at: 'role', safe: true, fixed: 'SignedIn(require="admin")\n  p Admin' }])
    expect(found('SignedIn(role={name})\n  p Admin')[0]?.fixed).toBe('SignedIn(require={name})\n  p Admin')
  })

  it('reports a SignedOut with no fix, since its children join the SignedIn beside it by hand', () => {
    expect(found('SignedOut\n  a(href="/in") Sign in')).toEqual([{ at: 'SignedOut', safe: undefined, fixed: undefined }])
  })

  it('reports a role beside a require with no fix', () => {
    expect(found('SignedIn(role="a" require="b")\n  p x')).toEqual([{ at: 'role', safe: undefined, fixed: undefined }])
  })

  it('leaves require, the else block and other components alone', () => {
    expect(found('SignedIn(require="admin")\n  p Admin\n  @else\n    p Visitor')).toEqual([])
    expect(found('Other(role="admin")')).toEqual([])
  })
})
