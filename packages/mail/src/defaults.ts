// The colours a mail is drawn in.
export interface Palette {
  text: string
  muted: string
  // Around the card, filling the client's window.
  background: string
  // The card the content sits on.
  surface: string
  border: string
  // A button's background.
  accent: string
  // A button's text.
  onAccent: string
}

// A picture shown above the card of every mail, such as the site's logo.
export interface Logo {
  // The image's URL, absolute: a client opens the mail away from the site.
  src: string
  // What the text part and a client blocking images show in its place.
  alt: string
  // In pixels, which Outlook sizes it by.
  width: number
  height?: number | undefined
  // Where a click on it goes.
  href?: string | undefined
}

// What an app may replace through `settings` in its kay.config.ts, spreading these defaults to change a few. Mail clients drop stylesheets, so every value lands in a `style` attribute.
export interface Settings extends Palette {
  font: string
  // A `Code`'s.
  mono: string
  radius: string
  // The card's widest, in pixels.
  width: number
  // The colours of a client's dark mode, each left out derived from its light one: lightness turned over, and the accent lightened until it reads on the card. Derived from hex colours only.
  dark?: Partial<Palette> | undefined
  // Shown above the card of every mail, the built-in auth and contact ones included, unless a `Layout` gives its own `@header`.
  logo?: Logo | undefined
}

const defaults: Settings = {
  font: 'system-ui, -apple-system, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, \'SF Mono\', Menlo, Consolas, \'Courier New\', monospace',
  text: '#1a1a1a',
  muted: '#555555',
  background: '#f4f4f2',
  surface: '#ffffff',
  border: '#e5e5e0',
  accent: '#1a1a1a',
  onAccent: '#ffffff',
  radius: '6px',
  width: 560,
}

export default defaults
