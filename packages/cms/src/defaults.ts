import type { Logo } from 'kay/library'

export type { Logo }

// What an app may replace through `settings` in its kay.config.ts, spreading these defaults to change a few.
export interface Settings {
  // Shown before the name in the admin's header: `src` a path of the site (`/logo.svg` from `public/`) or an https URL, `alt` what a reader without the image gets, `width` and `height` its size in pixels. `href` is left unused, as the header's link goes to the admin.
  logo?: Logo | undefined
}

const defaults: Settings = {}

export default defaults
