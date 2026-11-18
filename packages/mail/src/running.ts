import type { Mailer } from './mailer'

// The mailers of the sites running in this process, the latest started last. A site that is closed without stopping (kaynooo/kayjs#3053) leaves its entry until the next start.
const running: Mailer[] = []

// Registers a started site's mailer, and takes it off when the site stops. A mailer a module exports is the same one at each start, so it is listed once, as the latest.
export function register(mailerOf: Mailer): void {
  const known = running.includes(mailerOf)

  if (known)
    running.splice(running.indexOf(mailerOf), 1)

  running.push(mailerOf)

  if (known)
    return

  mailerOf.onStop(() => {
    const at = running.indexOf(mailerOf)

    if (at >= 0)
      running.splice(at, 1)
  })
}

// The mailer of the latest site started, undefined when none runs: what kayjs-auth sends through when the app has no mailer of its own, since it is built before any request.
export function runningMailer(): Mailer | undefined {
  return running.at(-1)
}
