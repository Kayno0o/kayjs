import process from 'node:process'
import { describe, expect, it } from 'bun:test'

// Run in a process of its own: the stamp secret is process-wide, and a test file run before may have set a stronger one.
async function isolated(script: string): Promise<unknown> {
  const run = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  expect({ code: await run.exited, err }).toEqual({ code: 0, err: '' })

  return JSON.parse(out)
}

const HEAD = `
import { createHmac, hkdfSync } from 'node:crypto'
import { openText, sealText, sharedKey, signedText, signText, useStampSecret } from './src/server/stamp'
const keyOf = secret => Buffer.from(hkdfSync('sha256', secret, '', 'kay stamps', 32))
`

describe('the keys signing and sealing', () => {
  it('sign as an HMAC-SHA256 of the use and text under the stamp key, and derive the shared key as one', async () => {
    const script = `${HEAD}
useStampSecret('first-secret-first-secret-first-secret', 'config')
const key = keyOf('first-secret-first-secret-first-secret')
console.log(JSON.stringify([
  signText('use', 'text') === createHmac('sha256', key).update('use\\0text').digest('base64url'),
  signedText('use', 'text', signText('use', 'text')),
  signedText('use', 'other', signText('use', 'text')),
  sharedKey('rates').equals(createHmac('sha256', key).update('kay-key\\0rates').digest()),
]))
`

    expect(await isolated(script)).toEqual([true, true, false, true])
  })

  it('seal under a key per use, and follow a secret that changes', async () => {
    const script = `${HEAD}
useStampSecret('first-secret-first-secret-first-secret', 'config')
const sealed = sealText('flash', 'hello')
const before = [openText('flash', sealed), openText('other', sealed) ?? null]
useStampSecret('second-secret-second-secret-second-sec', 'session')
console.log(JSON.stringify([
  ...before,
  openText('flash', sealed) ?? null,
  sharedKey('rates').equals(createHmac('sha256', keyOf('second-secret-second-secret-second-sec')).update('kay-key\\0rates').digest()),
  openText('flash', sealText('flash', 'again')),
]))
`

    expect(await isolated(script)).toEqual(['hello', null, null, true, 'again'])
  })
})
