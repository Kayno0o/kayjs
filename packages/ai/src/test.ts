import type { Fake } from './fake'
import { afterEach, beforeEach } from 'bun:test'
import { fakeAi } from './fake'

// The fake `ask()` answers from, as one test reads it.
export type AiTest = Pick<Fake, 'reply' | 'fail' | 'asked' | 'last'>

// Scripts and reads the fake model, which forgets its scripts and the asks it saw at the start of every test, so no test clears it by hand.
// Called at the top of a file or a `describe`, as `testSite()` is.
export function aiTest(): AiTest {
  fakeAi.clear()

  // Called inside a test or a hook, where Bun takes no hook, the fake is cleared once here.
  try {
    beforeEach(() => fakeAi.clear())
    // So a file running after this one in the same process meets none of its leftovers either.
    afterEach(() => fakeAi.clear())
  }
  catch {}

  return {
    get asked() {
      return fakeAi.asked
    },
    last: () => fakeAi.last(),
    reply: script => fakeAi.reply(script),
    fail: error => fakeAi.fail(error),
  }
}
