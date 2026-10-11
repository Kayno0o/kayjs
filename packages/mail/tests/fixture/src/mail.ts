import { mailer } from '@kaynooo/kayjs-mail'
import Plain from './mails/plain.kay'

export const mail = mailer({ from: 'Fixture <hello@fixture.test>', lang: 'fr' })

// Sends the plain mail, as a site's module sends the mails it imports.
export async function sendPlain(to: string): Promise<void> {
  await mail.send({ to, subject: 'Plain', view: Plain })
}
