import type { Logo, MailSettings } from '@kayjs/mail'
import { cssColors, mailDefaults } from '@kayjs/mail'
import site from './styles/site.css' with { type: 'text' }

const colour = cssColors(site, 'styles/site.css')

// The logo the settings give, which tests set for the mails they render.
export const branding: { logo?: Logo | undefined } = {}

export default {
  ...mailDefaults,
  accent: colour('--color-brand'),
  get logo() {
    return branding.logo
  },
} satisfies MailSettings
