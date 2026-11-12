import { afterEach, beforeEach } from 'bun:test'

// Runs `clear` now and before and after every test of the file or `describe` it is called in, for a fake or an outbox a library's test helper keeps for the process: no test clears it by hand, and a file running after this one in the same process meets none of its leftovers.
// Called inside a test or a hook, where Bun takes no hook, `clear` runs once here.
export function resetEachTest(clear: () => void): void {
  clear()

  try {
    beforeEach(clear)
    afterEach(clear)
  }
  catch {}
}
