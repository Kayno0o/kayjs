import type { AuthMail } from './auth'
import { t } from 'kay/i18n'
import { configError, durationWords } from 'kay/library'
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

  const of = (line: 'subject' | 'lead' | 'ending'): string => t(`mail.auth.${kind}.${line}`, { site: mail.site, email: mail.to, detail: mail.detail ?? '', what: t(mail.url === undefined ? 'mail.auth.code' : 'mail.auth.link') })
  // How long a link works, left unsaid when its `lasts` is empty; the figure kayjs-auth was set to when it sends one, the default wording otherwise.
  const link = mail.expires?.link === undefined ? undefined : durationWords(mail.expires.link, mail.locale) + (kind === 'magic-link' ? t('mail.auth.once') : '')
  const lasts = isLinkKind(kind) && mail.url !== undefined ? link ?? t(`mail.auth.${kind}.lasts`) : ''
  const code = mail.expires?.code === undefined ? t('mail.auth.codeWorks', { duration: t('mail.auth.codeLasts') }) : t('mail.auth.codeWorks', { duration: durationWords(mail.expires.code, mail.locale) })
  const ending = [lasts === '' ? undefined : t('mail.auth.linkWorks', { duration: lasts }), mail.code === undefined ? undefined : code, of('ending')]

  return {
    subject: of('subject'),
    lead: of('lead'),
    button: isLinkKind(kind) ? t(`mail.auth.${kind}.button`) : '',
    orPaste: t('mail.auth.orPaste'),
    codeLead: t(mail.url === undefined ? 'mail.auth.yourCode' : 'mail.auth.orTypeCode'),
    review: t('mail.auth.review'),
    ending: ending.filter(line => line !== undefined).join(' '),
  }
}
