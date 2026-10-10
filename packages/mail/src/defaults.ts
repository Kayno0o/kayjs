// What an app may replace through `settings` in its kay.config.ts, spreading these defaults to change a few. Mail clients drop stylesheets, so every value lands in a `style` attribute.
export interface Settings {
  font: string
  // A `Code`'s.
  mono: string
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
  radius: string
  // The card's widest, in pixels.
  width: number
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
