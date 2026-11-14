import type { Setup } from './template-shared'
import { blocks } from './template-shared'

const VIEW_TRANSITION = `@media (prefers-reduced-motion: no-preference) {
  @view-transition {
    navigation: auto;
  }
}`

// A class of the `.class` shorthand: a balanced `[...]`, a `(...)` after a `-`, a decimal, or any other character that is no space, `.`, `#` or `(`.
const SHORTHAND_CLASS = String.raw`(?:\[[^\]\s]*\]|(?<=-)\([^)\s]*\)|\d\.\d+(?!\w)|[^\s.#(\[\]])+`

// Tailwind IntelliSense's `classRegex`: a `class="..."` value, and the classes after the tag and the `#id` of a line or of a `#[tag]`, each `.class` apart.
// A regex cannot tell a fence from the template, so a script line such as `console.log(` reads as a tag with a class too.
export const TAILWIND_CLASS_REGEX: (string | [string, string])[] = [
  String.raw`class\s*=\s*"([^"]*)"`,
  [String.raw`(?:^|\n|#\[)[ \t]*(?:[A-Za-z][\w-]*)?(?:#[^\s.#(\[\]]+)?((?:\.${SHORTHAND_CLASS})+)`, String.raw`\.(${SHORTHAND_CLASS})`],
]

// `.vscode/settings.json`: kay formats `.kay` files on save, the ESLint extension lints only the languages it lists, which replaces its default ones, and Tailwind IntelliSense reads `.kay` as HTML.
export function editorSettings({ has }: Setup): Record<string, unknown> {
  return {
    '[kay]': { 'editor.defaultFormatter': 'kaynooo.kay', 'editor.formatOnSave': true },
    ...has('eslint') && { 'eslint.validate': ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'kay'] },
    ...has('tailwind') && { 'tailwindCSS.includeLanguages': { kay: 'html' }, 'tailwindCSS.experimental.classRegex': TAILWIND_CLASS_REGEX },
  }
}

// `.vscode/extensions.json`: VS Code offers the kay extension, and those of the features that have one, when the folder opens.
export function editorExtensions({ has }: Setup): { recommendations: string[] } {
  return { recommendations: ['kaynooo.kay', ...has('eslint') ? ['dbaeumer.vscode-eslint'] : [], ...has('tailwind') ? ['bradlc.vscode-tailwindcss'] : []] }
}

// The accents of the picker, orbit's own under names of the starter's.
const ACCENT_COLOURS = {
  starlight: '#bcd4ff',
  mint: '#7ee0b3',
  orchid: '#e09af0',
  periwinkle: '#9aa6ff',
  rose: '#f28fb8',
  sky: '#8fd3f4',
  lime: '#c6e07a',
  amber: '#e8c35a',
  lilac: '#b9a3de',
  sand: '#e6d7a3',
  peach: '#f4a36b',
  coral: '#f27b72',
}

// The look of orbit's apps: kayjs-ui's space skin over a near-black palette, a hairline on every box, kayjs-ui's `starfield` behind the page, and an accent the picker in the header changes.
// The colours carry kayjs-ui's names (`background`, `foreground`, `border`), none of them one of Tailwind's own utilities such as `text-base`.
export function tailwindCss({ has }: Setup): string {
  const ui = has('ui')
  // `ui()` gives the stylesheet the theme; a static site, which cannot mount it, imports it.
  const theme = ui && !has('server') ? '\n@import \'@kayjs/ui/theme.css\';' : ''

  return blocks(
    `@import 'tailwindcss';${theme}${ui ? '\n@import \'@kayjs/ui/skins/space.css\';' : ''}`,
    VIEW_TRANSITION,
    has('accents') && `/* Static: the picker reads every accent through var(), which Tailwind cannot see. */
@theme static {
${Object.entries(ACCENT_COLOURS).map(([name, colour]) => `  --accent-${name}: ${colour};`).join('\n')}
}`,
    `@theme {
${ui ? '  --font-mono: \'JetBrains Mono\', ui-monospace, monospace;\n\n' : ''}  /* One ground for the page and its header, and boxes a step up from it framed by a hairline, since fill alone barely shows this close to black. */
  --color-background: #090a10;
  --color-surface: #11131a;
  --color-surface-strong: #191c25;
  --color-popover: #14161e;
  --color-foreground: #d8dbe6;
  --color-input: #646a7f;
  --color-border: color-mix(in srgb, var(--color-foreground) 11%, transparent);
  --color-border-strong: color-mix(in srgb, var(--color-foreground) 20%, transparent);
  --color-muted: color-mix(in oklab, var(--color-foreground), var(--color-background) 30%);
${ui ? '' : '  --color-danger: #ff6b6b;\n'}  --color-accent-hover: color-mix(in oklab, var(--color-accent), white 30%);
  --color-accent-foreground: #05060a;
${has('accents') ? '\n  /* The accent picker sets --accent on the page. */\n  --color-accent: var(--accent, var(--accent-starlight));' : '  --color-accent: #bcd4ff;'}

  /* What is pressed is never rounder than the box holding it. */
  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
}`,
    `@layer base {
  body {
    @apply ${ui ? 'starfield ' : ''}flex min-h-screen flex-col bg-background font-sans text-foreground;
  }

  a {
    @apply underline decoration-accent underline-offset-4 hover:decoration-2;
  }

  button {
    @apply cursor-pointer rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50;
  }

  input {
    @apply rounded-md border border-input bg-surface px-2 py-1 text-foreground focus:border-accent focus:outline-none;
  }

  label {
    @apply text-sm font-medium text-muted;
  }

  ::selection {
    @apply bg-foreground/25;
  }
}`,
    has('starter') && `@layer components {
  .skip-link {
    @apply absolute top-0 left-0 z-100 -translate-y-full border border-border-strong bg-background px-2 py-1 text-accent transition-transform focus:translate-y-0;
  }
}`,
  )
}

// Without Tailwind, the skip link stays out of sight until it takes the focus.
export const PLAIN_CSS = blocks(VIEW_TRANSITION, `.skip-link {
  position: absolute;
  top: 0;
  left: 0;
  transform: translateY(-100%);
}

.skip-link:focus {
  transform: none;
}`)

export const ACCENT_FILES: Record<string, string> = {
  'src/theme.ts': `import { persisted } from 'kay'

export const ACCENTS = [${Object.keys(ACCENT_COLOURS).map(name => `'${name}'`).join(', ')}] as const

export type Accent = (typeof ACCENTS)[number]

// Kept in a cookie the server reads, so a page it renders shows the chosen accent from the first paint.
export const accent = persisted<Accent>('accent', 'starlight')

// A cookie's value is not checked against the type, so anything but a known accent reads as the default.
export function currentAccent(): Accent {
  const value = accent()

  return ACCENTS.includes(value) ? value : 'starlight'
}
`,
  'src/components/accent-picker.kay': `---
import Check from '~icons/tabler/check'
import Palette from '~icons/tabler/palette'
import { accent, ACCENTS, currentAccent } from '../theme'
---
style {\`:root { --accent: var(--accent-\${currentAccent()}); }\`}
details.relative
  summary.flex.cursor-pointer.list-none.items-center.gap-2.text-sm.text-muted
    Palette.size-5.text-accent
    | Accent
  div(
    class="absolute right-0 mt-2 grid w-max grid-cols-6 gap-1 rounded-lg border border-border-strong bg-popover p-2"
    role="radiogroup"
    aria-label="Accent colour"
  )
    for name of ACCENTS
      button.grid.size-6.place-items-center.rounded-sm.border.border-border-strong.p-0(type="button" role="radio" aria-label={name} aria-checked={currentAccent() === name ? 'true' : 'false'} style={\`background-color: var(--accent-\${name})\`} onClick={() => accent = name})
        if currentAccent() === name
          Check.size-4.text-accent-foreground
`,
}
