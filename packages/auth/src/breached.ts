import type { Core } from './core'
import type { PasswordProblem } from './rules'
import { createHash } from 'node:crypto'
import { passwordProblem } from './rules'

const RANGE_URL = 'https://api.pwnedpasswords.com/range/'
const TIMEOUT_MS = 3000

// Whether Have I Been Pwned lists the password, sending only the first five characters of its SHA-1 so the service never learns which one was asked about.
export async function pwnedPassword(password: string): Promise<boolean> {
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase()
  // Padded with decoy suffixes, so even the answer's size tells nothing of the range.
  const response = await fetch(`${RANGE_URL}${hash.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(TIMEOUT_MS) })

  if (!response.ok)
    throw new Error(`${RANGE_URL} answered ${response.status}`)

  const suffix = hash.slice(5)

  for (const line of (await response.text()).split('\n')) {
    const [candidate, count] = line.trim().split(':')

    // A decoy is listed with a count of 0.
    if (candidate === suffix)
      return Number(count) > 0
  }

  return false
}

// The rules' problem with a new password, or `breached` when the app checks for those and the check finds it. A check that fails lets the password through, logged, so an outage never stops anyone registering.
export async function newPasswordProblem(core: Core, password: string): Promise<PasswordProblem | 'breached' | undefined> {
  const problem = passwordProblem(password)

  if (problem || !core.breached)
    return problem

  try {
    return await core.breached(password) ? 'breached' : undefined
  }
  catch (error) {
    console.error('kayjs-auth: the breached-password check failed, so the password passes', error)

    return undefined
  }
}
