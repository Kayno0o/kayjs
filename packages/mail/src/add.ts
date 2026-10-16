// What `kay add mail` writes: the mailer, and the extension that hands it to the pages.
export default {
  description: 'a mailer reading SMTP from the environment, with the outbox page in development',
  files: {
    'src/mail.ts': 'import { mailer } from \'@kaynooo/kayjs-mail\'\n\n// SMTP_HOST and SMTP_FROM come from the environment; in development and under `bun test` mails go to the outbox.\nexport const mail = mailer()\n',
  },
  extension: { import: 'import { mailExtension } from \'@kaynooo/kayjs-mail\'', expression: 'mailExtension(\'./src/mail\')' },
  notes: ['Set SMTP_HOST and SMTP_FROM in production; mails sent in development are listed on the outbox page.'],
}
