import process from 'node:process'
import { describe, expect, it } from 'bun:test'

// Run in a process of its own: the stamp secret is process-wide.
async function isolated(script: string): Promise<unknown> {
  const run = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  expect({ code: await run.exited, err }).toEqual({ code: 0, err: '' })

  return JSON.parse(out)
}

const HEAD = `
import { signed } from './src/server/index'
import { signText, useStampSecret } from './src/server/stamp'
const A = 'first-secret-first-secret-first-secret'
const B = 'other-secret-other-secret-other-secret'
useStampSecret(A, 'config')
`

describe('signed', () => {
  it('verifies what it signed for the same use and value, and nothing else', async () => {
    const script = `${HEAD}
const token = signed.sign('shot', 'abc')
console.log(JSON.stringify([
  signed.verify('shot', 'abc', token),
  signed.verify('shot', 'abd', token),
  signed.verify('other', 'abc', token),
  signed.verify('shot', 'abc', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')),
  signed.verify('shot', 'abc', undefined),
  signed.verify('shot', 'abc', ''),
  signed.verify('shot', 'abc', '.'),
  signed.verify('shot', 'abc', 'x.' + token.split('.')[1]),
  /^[\\w.-]+$/.test(token),
]))
`

    expect(await isolated(script)).toEqual([true, false, false, false, false, false, false, false, true])
  })

  it('refuses an expired token and one whose expiry was moved', async () => {
    const script = `${HEAD}
const token = signed.sign('shot', 'abc', { maxAge: '1s' })
const [until, sig] = token.split('.')
const later = String(Number(until) + 3600) + '.' + sig
const first = signed.verify('shot', 'abc', token)
await Bun.sleep(2100)
console.log(JSON.stringify([first, signed.verify('shot', 'abc', token), signed.verify('shot', 'abc', later)]))
`

    expect(await isolated(script)).toEqual([true, false, false])
  })

  it('does not pass for a signature kay made itself, and rejects a bare number maxAge', async () => {
    const script = `${HEAD}
const until = String(Math.ceil(Date.now() / 1000) + 600)
let threw = false
try { signed.sign('shot', 'abc', { maxAge: 60 }) } catch { threw = true }
console.log(JSON.stringify([
  signed.verify('shot', 'abc', until + '.' + signText('shot', 'abc\\0' + until)),
  signed.verify('shot', 'abc', until + '.' + signText('kay-file', 'abc\\n' + until)),
  threw,
]))
`

    expect(await isolated(script)).toEqual([false, false, true])
  })

  it('follows the secret: another one refuses, a rotation list keeps older tokens', async () => {
    const script = `${HEAD}
const token = signed.sign('shot', 'abc')
useStampSecret(B, 'session')
const other = signed.verify('shot', 'abc', token)
useStampSecret([B, A], 'session')
const rotated = signed.verify('shot', 'abc', token)
console.log(JSON.stringify([other, rotated, signed.verify('shot', 'abc', signed.sign('shot', 'abc'))]))
`

    expect(await isolated(script)).toEqual([false, true, true])
  })
})
