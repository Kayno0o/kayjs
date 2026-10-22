import type { AuthMailMessage as Mail, AuthMailer as Mailer } from '../../src/mail'

// A mailer keeping what it is sent, whose `take` awaits a mail leaving off the response's path rather than sleeping for it.
export function mailbox() {
  const mails: Mail[] = []
  const taken = new Set<Mail>()
  const waiting = new Set<() => void>()

  const mailer: Mailer = {
    send(mail) {
      mails.push(mail)

      for (const wake of waiting)
        wake()
    },
  }

  // The first `count` mails to `to` or of `kind` not taken yet, waiting for those not sent yet.
  async function take(match: Partial<Pick<Mail, 'kind' | 'to'>>, count = 1): Promise<Mail[]> {
    const matching = () => mails.filter(mail => !taken.has(mail) && (match.kind === undefined || mail.kind === match.kind) && (match.to === undefined || mail.to === match.to)).slice(0, count)
    let found = matching()

    while (found.length < count) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.delete(wake)
          resolve()
        }

        waiting.add(wake)
      })
      found = matching()
    }

    for (const mail of found)
      taken.add(mail)

    return found
  }

  return { mails, mailer, take }
}
