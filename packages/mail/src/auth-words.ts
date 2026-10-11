import type { AuthLinkKind, AuthMail } from './auth'
import { t } from 'kay/i18n'
import { AUTH_LINK_KINDS } from './auth'

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
  // Keys built from the kind: the messages type each one, not a template of them.
  const say = t as unknown as (key: string, values?: Record<string, string>) => string
  const of = (line: string): string => say(`mail.auth.${mail.kind}.${line}`, { site: mail.site, email: mail.to, detail: mail.detail ?? '', what: say(mail.url === undefined ? 'mail.auth.code' : 'mail.auth.link') })
  const link = AUTH_LINK_KINDS.includes(mail.kind as AuthLinkKind)
  // How long a link works, left unsaid when its `lasts` is empty.
  const lasts = link && mail.url !== undefined ? of('lasts') : ''
  const ending = [lasts === '' ? undefined : say('mail.auth.linkWorks', { duration: lasts }), mail.code === undefined ? undefined : say('mail.auth.codeWorks'), of('ending')]

  return {
    subject: of('subject'),
    lead: of('lead'),
    button: link ? of('button') : '',
    orPaste: say('mail.auth.orPaste'),
    codeLead: say(mail.url === undefined ? 'mail.auth.yourCode' : 'mail.auth.orTypeCode'),
    review: say('mail.auth.review'),
    ending: ending.filter(line => line !== undefined).join(' '),
  }
}
