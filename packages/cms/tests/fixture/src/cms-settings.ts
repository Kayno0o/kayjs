import type { Logo, Settings } from '@kayjs/cms'
import { defaults } from '@kayjs/cms'

// The logo the settings give, which tests set for the admin they render.
export const branding: { logo?: Logo | undefined } = {}

export default {
  ...defaults,
  get logo() {
    return branding.logo
  },
} satisfies Settings
