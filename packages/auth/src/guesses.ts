import type { RequestState } from './state'
import type { UserRecord } from './store'
import { comparePasswords, hashPassword } from '@kaynooo/utils'
import { afterResponse } from './events'
import { randomToken } from './keys'
import { notify } from './notify'

// The counts one password guess is held to: a hard stop for this client on this account, and a looser ceiling for the account from every client together.
export interface Guess {
  keys: string[]
}

// Counts a guess at an account's password before the password is checked, so a burst of parallel guesses cannot all pass a count that only a failure would raise; `forgive` takes it back once the password proves right.
// The hard stop is per client, so someone failing at an email cannot keep its holder out from another address. Without a record the count is kept against what was typed, so a missing account runs out the same way.
export async function startGuess(state: RequestState, record: UserRecord | undefined, typed: string): Promise<Guess | 'limited'> {
  const { core, client } = state
  const { attempts } = core.store
  const account = record ? record.id : core.keys.fingerprint(typed.toLowerCase())
  // A record's id and a digest never share a prefix with the other, whatever the app's ids look like.
  const kind = record ? 'id' : 'typed'
  const hard = `sign-in-account:${kind}:${account}\n${client}`
  const ceiling = `sign-in-ceiling:${kind}:${account}`

  if (await attempts.hit(hard, core.limits.signInAccount.window) > core.limits.signInAccount.max)
    return 'limited'

  const all = await attempts.hit(ceiling, core.limits.signInAccountAll.window)

  if (all > core.limits.signInAccountAll.max) {
    // Once per lockout: only the first attempt past the ceiling mails, and the holder is the one who gets it.
    if (all === core.limits.signInAccountAll.max + 1 && record)
      await afterResponse('reporting a sign-in lockout', async () => notify(state, record, 'sign-in-locked'))

    return 'limited'
  }

  return { keys: [hard, ceiling] }
}

// A right password costs the account nothing: the guesses it follows, from this client and from all of them, are forgotten.
export async function forgive(state: RequestState, guess: Guess): Promise<void> {
  for (const key of guess.keys)
    await state.core.store.attempts.reset(key)
}

let decoy: Promise<string> | undefined

// Spends as long on an account without a password as on a wrong one, so the time taken tells nothing either.
export async function passwordMatches(record: UserRecord | undefined, password: string): Promise<boolean> {
  if (record?.passwordHash != null && record.passwordHash !== '')
    return comparePasswords(password, record.passwordHash)

  decoy ??= hashPassword(randomToken())
  await comparePasswords(password, await decoy)

  return false
}
