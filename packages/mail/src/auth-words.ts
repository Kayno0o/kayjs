import type { AuthMail } from './auth'
import { configError, durationWords } from 'kay/library'
import { wording } from 'kay/words'
import { isLinkKind, isNoticeKind } from './auth'
import { ENGLISH } from './auth-english'

export interface AuthWords {
  subject: string
  lead: string
  // A link's button, empty for news of a change to the account.
  button: string
  // Before the link written out, for a reader whose client shows no button.
  orPaste: string
  // Before the code, when the mail carries one.
  codeLead: string
  // Before the link to where the user reviews what happened, for news of a change to the account.
  review: string
  // How long the link or code works, then what to do when it was not asked for or not the user.
  ending: string
}

// The default wording of a kayjs-auth mail in the language it renders in, from the `mail.auth` messages an app overrides key by key; for a view of the app's own keeping some of it.
export function authWords(mail: AuthMail): AuthWords {
  const { kind } = mail

  if (!isLinkKind(kind) && !isNoticeKind(kind))
    throw configError(`${kind} is no kind of mail kayjs-auth sends`)

  const english = ENGLISH[kind]!
  const of = (line: 'subject' | 'lead' | 'ending'): string => wording(`mail.auth.${kind}.${line}`, english[line], { site: mail.name ?? mail.site, email: mail.to, detail: mail.detail ?? '', what: mail.url === undefined ? wording('mail.auth.code', 'code') : wording('mail.auth.link', 'link') })
  // How long a link works, left unsaid when its `lasts` is empty; the figure kayjs-auth was set to when it sends one, the default wording otherwise.
  const maxAge = mail.maxAge ?? mail.expires
  const link = maxAge?.link === undefined ? undefined : durationWords(maxAge.link, mail.locale) + (kind === 'magic-link' ? wording('mail.auth.once', ', once') : '')
  const lasts = isLinkKind(kind) && mail.url !== undefined ? link ?? wording(`mail.auth.${kind}.lasts`, english.lasts ?? '') : ''
  const code = maxAge?.code === undefined ? wording('mail.auth.codeWorks', 'The code works for {duration}, typed where you asked for it.', { duration: wording('mail.auth.codeLasts', '10 minutes') }) : wording('mail.auth.codeWorks', 'The code works for {duration}, typed where you asked for it.', { duration: durationWords(maxAge.code, mail.locale) })
  const ending = [lasts === '' ? undefined : wording('mail.auth.linkWorks', 'The link works for {duration}.', { duration: lasts }), mail.code === undefined ? undefined : code, of('ending')]

  return {
    subject: of('subject'),
    lead: of('lead'),
    button: isLinkKind(kind) ? wording(`mail.auth.${kind}.button`, english.button ?? '') : '',
    orPaste: wording('mail.auth.orPaste', 'Or paste this into your browser:'),
    codeLead: mail.url === undefined ? wording('mail.auth.yourCode', 'Your code:') : wording('mail.auth.orTypeCode', 'Or type this code where you asked for it:'),
    review: wording('mail.auth.review', 'See where your account is signed in, and end what you do not know:'),
    ending: ending.filter(line => line !== undefined).join(' '),
  }
}
