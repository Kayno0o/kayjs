import type { Fake } from './fake'
import { resetEachTest } from 'kay/test'
import { fakeAi } from './fake'

// The fake `ask()` answers from, as one test reads it.
export type AiTest = Pick<Fake, 'reply' | 'fail' | 'asked' | 'last' | 'clear' | 'heard' | 'transcript' | 'spoken' | 'speech' | 'embedded' | 'embedding'>

// Scripts and reads the fake model, which forgets its scripts and the asks it saw at the start of every test, so no test clears it by hand.
// Called at the top of a file or a `describe`, as `testSite()` is.
export function aiTest(): AiTest {
  resetEachTest(() => fakeAi.clear())

  return {
    get asked() {
      return fakeAi.asked
    },
    last: () => fakeAi.last(),
    reply: (script, when) => fakeAi.reply(script, when),
    fail: (error, when) => fakeAi.fail(error, when),
    clear: () => fakeAi.clear(),
    get heard() {
      return fakeAi.heard
    },
    transcript: (answer, when) => fakeAi.transcript(answer, when),
    get spoken() {
      return fakeAi.spoken
    },
    speech: (answer, when) => fakeAi.speech(answer, when),
    get embedded() {
      return fakeAi.embedded
    },
    embedding: (answer, when) => fakeAi.embedding(answer, when),
  }
}
