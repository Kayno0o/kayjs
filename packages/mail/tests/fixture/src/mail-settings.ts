import type { Logo, MailSettings } from '@kaynooo/kayjs-mail'
import { cssColours, mailDefaults } from '@kaynooo/kayjs-mail'
import site from './styles/site.css' with { type: 'text' }

const colour = cssColours(site, 'styles/site.css')

// The logo the settings give, which tests set for the mails they render.
export const branding: { logo?: Logo | undefined } = {}

export default {
  ...mailDefaults,
  accent: colour('--color-brand'),
  get logo() {
    return branding.logo
  },
} satisfies MailSettings
