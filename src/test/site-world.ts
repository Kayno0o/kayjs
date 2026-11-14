import type { SignInHook, TestSite } from './site-types'
import { afterEach, beforeEach, setSystemTime } from 'bun:test'
import { clearStubs, guardOutgoing, stubFetch } from './outgoing'

// What the views of one site share: whether the clock was moved and the guard on `fetch`.
export interface World {
  clock: { moved: boolean }
  // Forgets the stubs before each test and puts the clock back after it, for a site made at the top of a file or a describe; one made in a test has no hook to take.
  resetEachTest: () => void
  // Puts the clock back and takes the site off the guard on `fetch`.
  release: () => void
}

export function createWorld(allowOutgoing: boolean): World {
  const unguard = guardOutgoing(allowOutgoing)
  const world: World = {
    clock: { moved: false },
    resetEachTest() {
      try {
        beforeEach(clearStubs)
        afterEach(() => restoreClock(world))
      }
      catch {}
    },
    release() {
      unguard()
      restoreClock(world)
    },
  }

  return world
}

function restoreClock({ clock }: World): void {
  if (clock.moved) {
    setSystemTime()
    clock.moved = false
  }
}

// The helpers that fake what the app meets outside its own routes: who is signed in, the time, and the network.
// The sign-ins the libraries' `test(site)` joined are the view's own, as each closes over the cookies of the view it was given.
export function worldOf(world: World): Pick<TestSite, 'signInAs' | 'signOut' | 'joinSignIn' | 'freezeTime' | 'fetchStub'> {
  const hooks: SignInHook[] = []

  return {
    joinSignIn: (hook) => {
      const known = hooks.findIndex(({ name }) => name === hook.name)

      if (known === -1)
        hooks.push(hook)
      else
        hooks[known] = hook
    },
    signInAs: async (who) => {
      if (hooks.length === 0)
        throw new Error('kay: signInAs signs the site in through the libraries that joined it: call `test(site)` of `@kayjs/auth/test` or `@kayjs/cms/test` first')

      const signedIn: Record<string, unknown> = {}

      for (const hook of hooks)
        Object.assign(signedIn, await hook.signIn(who))

      if (Object.keys(signedIn).length === 0)
        throw new Error(`kay: signInAs found no library to sign ${JSON.stringify(who)} in: kayjs-auth needs an \`email\` or \`username\`, kayjs-cms a \`role\` or none at all`)

      return signedIn
    },
    signOut: () => {
      for (const hook of hooks)
        hook.signOut()
    },
    freezeTime: (at = new Date()) => {
      const date = new Date(at)

      if (Number.isNaN(date.getTime()))
        throw new TypeError(`kay: freezeTime cannot read ${String(at)} as a date`)

      world.clock.moved = true
      setSystemTime(date)

      return date
    },
    fetchStub: routes => stubFetch(routes),
  }
}
