import type { TestSite } from 'kay/test'
import type { Outbox, SentMail, WaitOptions } from './outbox'
import { afterEach, beforeEach } from 'bun:test'
import { outbox } from './outbox'

// The outbox as one test site reads it.
export interface MailTest extends Pick<Outbox, 'last' | 'to' | 'find' | 'links' | 'link' | 'token'> {
  // Oldest first.
  readonly mails: readonly SentMail[]
  // The newest mail to this address, once there is one: the site's queues run first, so a mail the app enqueued is delivered.
  waitFor: (address: string, options?: Omit<WaitOptions, 'site'>) => Promise<SentMail>
}

// Reads the mails a test site sent, from an outbox that is empty at the start of every test, so no test clears it by hand.
// Called at the top of a file or a `describe`, as `testSite()` is.
export function mailTest(site: Pick<TestSite, 'runJobs'>): MailTest {
  outbox.clear()

  // Called inside a test or a hook, where Bun takes no hook, the outbox is emptied once here.
  try {
    beforeEach(() => outbox.clear())
    // So a file running after this one in the same process meets none of its leftovers either.
    afterEach(() => outbox.clear())
  }
  catch {}

  return {
    get mails() {
      return outbox.mails
    },
    last: () => outbox.last(),
    to: address => outbox.to(address),
    find: id => outbox.find(id),
    links: mail => outbox.links(mail),
    link: (mail, match) => outbox.link(mail, match),
    token: (mail, match) => outbox.token(mail, match),
    waitFor: async (address, options) => outbox.waitFor(address, { ...options, site }),
  }
}
