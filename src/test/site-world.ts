import type { SignInHook, TestSite } from './site-types'
import { afterEach, beforeEach, setSystemTime } from 'bun:test'
import { clearStubs, guardOutgoing, stubFetch } from './outgoing'

// What the views of one site share: the sign-ins the libraries' `test(site)` joined, whether the clock was moved and the guard on `fetch`.
export interface World {
  hooks: SignInHook[]
  clock: { moved: boolean }
  // Forgets the stubs before each test and puts the clock back after it, for a site made at the top of a file or a describe; one made in a test has no hook to take.
  resetEachTest: () => void
  // Puts the clock back and takes the site off the guard on `fetch`.
  release: () => void
}

export function createWorld(allowOutgoing: boolean): World {
  const unguard = guardOutgoing(allowOutgoing)
  const world: World = {
    hooks: [],
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
export function worldOf(world: World): Pick<TestSite, 'signInAs' | 'signOut' | 'joinSignIn' | 'freezeTime' | 'fetchStub'> {
  return {
    joinSignIn: (hook) => {
      const known = world.hooks.findIndex(({ name }) => name === hook.name)

      if (known === -1)
        world.hooks.push(hook)
      else
        world.hooks[known] = hook
    },
    signInAs: async (who) => {
      if (world.hooks.length === 0)
        throw new Error('kay: signInAs signs the site in through the libraries that joined it: call `test(site)` of `@kayjs/auth/test` or `@kayjs/cms/test` first')

      const signedIn: Record<string, unknown> = {}

      for (const hook of world.hooks)
        Object.assign(signedIn, await hook.signIn(who))

      if (Object.keys(signedIn).length === 0)
        throw new Error(`kay: signInAs found no library to sign ${JSON.stringify(who)} in: kayjs-auth needs an \`email\` or \`username\`, kayjs-cms a \`role\` or none at all`)

      return signedIn
    },
    signOut: () => {
      for (const hook of world.hooks)
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
