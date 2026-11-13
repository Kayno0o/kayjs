import type { MailReply } from '@kayjs/mail'
import { mailer } from '@kayjs/mail'
import Plain from './mails/plain.kay'

// The replies handed to the inbound route, which a test reads.
export const replies: MailReply[] = []

// What the hooks of the mailer and of the `hooked` list were told, in order.
export const heard: { name: string, event: Record<string, unknown> }[] = []

export function hear(name: string) {
  return (event: object): void => {
    heard.push({ name, event: event as Record<string, unknown> })
  }
}

export const mail = mailer({ from: 'Fixture <hello@fixture.test>', locale: 'fr', onSuppress: hear('suppress'), inbound: (reply) => {
  replies.push(reply)
} })

// Sends the plain mail, as a site's module sends the mails it imports.
export async function sendPlain(to: string): Promise<void> {
  await mail.send({ to, subject: 'Plain', view: Plain })
}
