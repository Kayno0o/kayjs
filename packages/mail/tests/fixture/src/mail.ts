import type { Reply } from '@kaynooo/kayjs-mail'
import { mailer } from '@kaynooo/kayjs-mail'
import Plain from './mails/plain.kay'

// The replies handed to the inbound route, which a test reads.
export const replies: Reply[] = []

export const mail = mailer({ from: 'Fixture <hello@fixture.test>', locale: 'fr', inbound: (reply) => {
  replies.push(reply)
} })

// Sends the plain mail, as a site's module sends the mails it imports.
export async function sendPlain(to: string): Promise<void> {
  await mail.send({ to, subject: 'Plain', view: Plain })
}
