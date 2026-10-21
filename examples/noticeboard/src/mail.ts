import { mailer } from '@kaynooo/kayjs-mail'

// Production reads MAIL_URL from the environment as it boots, and sends from noreply@ the site's host; development and tests keep every mail in the outbox.
export const mail = mailer({ fromName: 'Noticeboard' })
