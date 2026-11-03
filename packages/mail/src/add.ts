// What `kay add mail` writes: the mailer, and the extension that hands it to the pages.
export default {
  description: 'a mailer reading SMTP from the environment, with the outbox page in development',
  files: {},
  extension: { import: 'import { mail } from \'@kaynooo/kayjs-mail\'', expression: 'mail()' },
  notes: ['Set MAIL_URL (smtp://user:pass@host:port) in production; mails sent in development are listed on the outbox page. Send with `send` from @kaynooo/kayjs-mail; give mail() `from` and `locale`, or a `module` for a transport of your own.'],
}
