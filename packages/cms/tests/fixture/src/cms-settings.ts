import type { Logo, Settings } from '@kaynooo/kayjs-cms'
import { defaults } from '@kaynooo/kayjs-cms'

// The logo the settings give, which tests set for the admin they render.
export const branding: { logo?: Logo | undefined } = {}

export default {
  ...defaults,
  get logo() {
    return branding.logo
  },
} satisfies Settings
