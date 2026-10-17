import type { Logo, Settings } from '@kaynooo/kayjs-mail'
import { cssColours, defaults } from '@kaynooo/kayjs-mail'
import site from './styles/site.css' with { type: 'text' }

const colour = cssColours(site, 'styles/site.css')

// The logo the settings give, which tests set for the mails they render.
export const branding: { logo?: Logo | undefined } = {}

export default {
  ...defaults,
  accent: colour('--color-brand'),
  get logo() {
    return branding.logo
  },
} satisfies Settings
