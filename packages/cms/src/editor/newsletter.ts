import type { EntryRef } from '../kay/contract'
import { attempt, toast } from '@kaynooo/kayjs-ui'
import { call } from 'kay'
import { wording } from 'kay/words'
import newsletterApi from '../api/newsletter'

function params({ collection, slug, locale }: EntryRef) {
  return { params: { collection, slug }, query: locale === undefined ? {} : { locale } }
}

export interface MailPreview {
  subject: string
  html: string | undefined
  text: string
  subscribers: number
}

// The mail a send would make, rendered by the server, and how many subscribers would get it; undefined once a refusal has been toasted.
export async function previewNewsletter(ref: EntryRef): Promise<MailPreview | undefined> {
  return attempt(async () => call(newsletterApi, '/:collection/:slug/preview', { method: 'post', ...params(ref) }), wording('cms.newsletter.previewFailure', 'Could not render the mail'))
}

// Mails the list mail to the editor alone; true once sent.
export async function testNewsletter(ref: EntryRef): Promise<boolean> {
  const outcome = await attempt(async () => call(newsletterApi, '/:collection/:slug/test', { method: 'post', ...params(ref) }), wording('cms.newsletter.testFailure', 'Could not send the test'))

  if (outcome === undefined)
    return false

  toast.success(wording('cms.newsletter.tested', 'Test sent to {to}', { to: outcome.to }))

  return true
}

// Queues the mail for every subscriber; true once queued.
export async function sendNewsletter(ref: EntryRef): Promise<boolean> {
  const outcome = await attempt(async () => call(newsletterApi, '/:collection/:slug/send', { method: 'post', ...params(ref) }), wording('cms.newsletter.sendFailure', 'Could not send to the list'))

  if (outcome === undefined)
    return false

  toast.success(wording('cms.newsletter.queued', 'Queued for {count} subscribers, sent a few at a time', { count: outcome.recipients }))

  return true
}
