import type { Static, TSchema } from 'elysia'
import type { ActionContext, ActionProtection, Failure, JSX } from 'kay'
import type { Mailer } from './mailer'
import type { Address, Field } from './types'
import { s } from 'kay'
import { t } from 'kay/i18n'
import { siteOrigin } from 'kay/seo'
import { log } from './log'
import { MailNotConfigured } from './mailer'

// What the view of a contact mail is given: the visitor's answers as `fields` (the name and email first, the message apart), the `subject` and the site's `origin`.
export interface ContactMailProps {
  subject: string
  name: string
  email: string
  message: string
  fields: Field[]
  origin: string
}

// A line break in the name would let it write its own mail headers.
const ONE_LINE = '^[^\\r\\n]*\\S[^\\r\\n]*$'
const LINK = /https?:\/\//gi
const WORDS = /[-_]+/g
const DEFAULT_ERRORS = { name: 'Please write your name, on one line.', email: 'Please write a valid email address.', message: 'Please write your message.' }

export interface ContactOptions<Extra extends Record<string, TSchema> = Record<never, TSchema>> {
  // The fields beyond `name`, `email` and `message`, as schemas: `{ phone: s.Optional(s.String({ maxLength: 30 })), topic: s.UnionEnum(['quote', 'other']) }`. They go in the mail, after the email, in this order.
  fields?: Extra | undefined
  // What each of those is called in the mail, the field's name with its words apart and a capital by default.
  labels?: Partial<Record<keyof Extra & string, string>> | undefined
  // Where the mail goes, the mailer's `to` or `MAIL_TO` when left out.
  to?: Address | Address[] | undefined
  // The mail's subject, the `mail.contact.subject` message by default.
  subject?: ((input: ContactInput<Extra>) => string) | undefined
  // The mail's own `.kay` view, given `ContactMailProps`, in place of kayjs-mail's.
  view?: ((props: ContactMailProps) => JSX.Element) | undefined
  // How else to reach the site, `hello@example.com` or a phone number, which a refusal due to the mail not going out names after its own words.
  reach?: string | undefined
  // The most links a message holds, 3 by default: a message past it is refused as spam.
  maxLinks?: number | undefined
  // The longest message, 5000 characters by default.
  maxLength?: number | undefined
  // The messages the schema refuses a field with, in English by default; the other refusals read the `mail.contact` messages in the page's language.
  errors?: Partial<typeof DEFAULT_ERRORS> | undefined
  // Replaces the defaults of the protection, `rateLimit` 30 posts every 10 minutes and 5 that went through, `minTime` of 3 seconds; the honeypot is the `website` field.
  protection?: Omit<ActionProtection<'website'>, 'honeypot' | 'messages'> | undefined
}

export type ContactInput<Extra extends Record<string, TSchema> = Record<never, TSchema>> = { name: string, email: string, message: string } & Static<ReturnType<typeof s.Object<Extra>>>

// The object schema built below, typed by the input it validates.
type ContactSchema<Extra extends Record<string, TSchema>> = TSchema & { static: ContactInput<Extra> }

// The arguments of `action` for a contact form, for a page to spread: `export const contact = action(...contactForm(mail, { reach: 'hello@example.com' }))`. A post is checked, mailed to the site with the visitor in `replyTo` and answered with a refusal worded in the page's language when the mail cannot go out, with `rateLimit`, `honeypot` and `minTime` set. Pair it with `ContactForm` from kayjs-ui.
export function contactForm<const Extra extends Record<string, TSchema> = Record<never, TSchema>>(mail: Pick<Mailer, 'send'>, options: ContactOptions<Extra> = {}): [
  schema: ContactSchema<Extra>,
  handler: (input: ContactInput<Extra>, ctx: ActionContext) => Promise<Failure<string> | undefined>,
  protection: ActionProtection<'website'>,
] {
  const { fields = {} as Extra, labels = {}, reach, maxLinks = 3, maxLength = 5000 } = options
  const errors = { ...DEFAULT_ERRORS, ...options.errors }
  const words = { reach: reach ?? '' }

  const schema = s.Object({
    name: s.String({ pattern: ONE_LINE, maxLength: 100, error: errors.name }),
    email: s.String({ format: 'email', maxLength: 254, error: errors.email }),
    ...fields,
    message: s.String({ pattern: '\\S', maxLength, error: errors.message }),
  }) as unknown as ContactSchema<Extra>

  const handler = async (input: ContactInput<Extra>, ctx: ActionContext): Promise<Failure<string> | undefined> => {
    const { name, email, message } = input

    if ((message.match(LINK)?.length ?? 0) > maxLinks)
      return ctx.fail(422, t('mail.contact.tooManyLinks', { max: maxLinks }))

    const given: Field[] = [{ label: labelOf('name', labels), value: name }, { label: labelOf('email', labels), value: email, href: `mailto:${email}` }]

    for (const key of Object.keys(fields)) {
      const value = (input as Record<string, unknown>)[key]
      const text = value === undefined || value === null ? '' : String(value).trim()

      given.push({ label: labelOf(key, labels), value: text })
    }

    const subject = options.subject?.(input) ?? t('mail.contact.subject', { name })
    const origin = siteOrigin()

    try {
      // From stays the mailer's own address so SPF and DKIM hold; replying goes to the visitor.
      await mail.send({
        to: options.to,
        replyTo: { name, address: email },
        subject,
        view: options.view ?? await defaultView(),
        props: { subject, name, email, message, fields: given, origin },
      })
    }
    catch (error) {
      // The mailer has logged a failed send itself.
      if (error instanceof MailNotConfigured) {
        log.error(error.message)

        return ctx.fail(503, reach === undefined ? t('mail.contact.notConfigured') : t('mail.contact.notConfiguredReach', words))
      }

      return ctx.fail(502, reach === undefined ? t('mail.contact.sendFailed') : t('mail.contact.sendFailedReach', words))
    }

    return undefined
  }

  const protection: ActionProtection<'website'> = {
    rateLimit: [{ max: 30, window: '10m' }, { max: 5, window: '10m', count: 'succeeded' }],
    minTime: '3s',
    ...options.protection,
    honeypot: { field: 'website', pretend: true },
    messages: {
      rateLimit: () => reach === undefined ? t('mail.contact.rateLimit') : t('mail.contact.rateLimitReach', words),
      minTime: reason => t(reason === 'early' ? 'mail.contact.early' : 'mail.contact.expired'),
    },
  }

  return [schema, handler, protection]
}

function labelOf(key: string, labels: Partial<Record<string, string>>): string {
  const own = labels[key]

  if (own !== undefined)
    return own

  const words = key.replace(WORDS, ' ').trim()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

// Imported here, as this module loads with kay.config.ts before kay compiles any .kay file.
async function defaultView(): Promise<(props: ContactMailProps) => JSX.Element> {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- widened, so the .kay specifier is not resolved
  return (await import('./contact-mail.kay' as string) as { default: (props: ContactMailProps) => JSX.Element }).default
}
