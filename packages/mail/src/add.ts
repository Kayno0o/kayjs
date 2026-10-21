// What `kay add mail` writes: the mailer, and the extension that hands it to the pages.
export default {
  description: 'a mailer reading SMTP from the environment, with the outbox page in development',
  files: {
    'src/mail.ts': 'import { mailer } from \'@kaynooo/kayjs-mail\'\n\n// MAIL_URL comes from the environment, and the sender defaults to noreply@ the host of the site; in development and under `bun test` mails go to the outbox.\nexport const mail = mailer()\n',
  },
  extension: { import: 'import { mail } from \'@kaynooo/kayjs-mail\'', expression: 'mail({ module: \'./src/mail\' })' },
  notes: ['Set MAIL_URL (smtp://user:pass@host:port) in production; mails sent in development are listed on the outbox page.'],
}
