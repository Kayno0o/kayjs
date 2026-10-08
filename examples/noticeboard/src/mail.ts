import { mailer } from '@kaynooo/kayjs-mail'

// Production reads SMTP_HOST and the rest from the environment as it boots; development and tests keep every mail in the outbox.
export const mail = mailer({ from: 'Noticeboard <board@example.com>' })
