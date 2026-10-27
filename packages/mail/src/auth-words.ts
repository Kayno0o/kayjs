import type { AuthMail } from './auth'
import { configError, durationWords } from 'kay/library'
import { AUTH_MAIL_ENGLISH as en } from 'kay/library/auth-mails'
import { wording } from 'kay/words'
import { isLinkKind, isNoticeKind } from './auth'

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

  const english = en[kind]
  const of = (line: 'subject' | 'lead' | 'ending'): string => wording(`mail.auth.${kind}.${line}`, english[line], { site: mail.name, email: mail.to, detail: mail.detail ?? '', what: mail.url === undefined ? wording('mail.auth.code', en.code) : wording('mail.auth.link', en.link) })
  // How long a link works, left unsaid when its `lasts` is empty; the figure kayjs-auth was set to when it sends one, the default wording otherwise.
  const maxAge = mail.maxAge
  const link = maxAge?.link === undefined ? undefined : durationWords(maxAge.link, mail.locale) + (kind === 'magic-link' ? wording('mail.auth.once', en.once) : '')
  const lasts = isLinkKind(kind) && mail.url !== undefined ? link ?? wording(`mail.auth.${kind}.lasts`, en[kind].lasts) : ''
  const duration = maxAge?.code === undefined ? wording('mail.auth.codeLasts', en.codeLasts) : durationWords(maxAge.code, mail.locale)
  const code = wording('mail.auth.codeWorks', en.codeWorks, { duration })
  const ending = [lasts === '' ? undefined : wording('mail.auth.linkWorks', en.linkWorks, { duration: lasts }), mail.code === undefined ? undefined : code, of('ending')]

  return {
    subject: of('subject'),
    lead: of('lead'),
    button: isLinkKind(kind) ? wording(`mail.auth.${kind}.button`, en[kind].button) : '',
    orPaste: wording('mail.auth.orPaste', en.orPaste),
    codeLead: mail.url === undefined ? wording('mail.auth.yourCode', en.yourCode) : wording('mail.auth.orTypeCode', en.orTypeCode),
    review: wording('mail.auth.review', en.review),
    ending: ending.filter(line => line !== undefined).join(' '),
  }
}
