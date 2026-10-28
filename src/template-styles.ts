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

// astro-template's look: Tailwind over the Catppuccin Mocha palette, the accent one of its colours, which the picker in the header changes.
export function tailwindCss({ has }: Setup): string {
  return blocks(
    '@import \'tailwindcss\';',
    VIEW_TRANSITION,
    has('accents') && `/* Static: the picker reads every accent through var(), which Tailwind cannot see. */
@theme static {
  --accent-rosewater: #f5e0dc;
  --accent-flamingo: #f2cdcd;
  --accent-pink: #f5c2e7;
  --accent-mauve: #cba6f7;
  --accent-red: #f38ba8;
  --accent-maroon: #eba0ac;
  --accent-peach: #fab387;
  --accent-yellow: #f9e2af;
  --accent-green: #a6e3a1;
  --accent-teal: #94e2d5;
  --accent-sky: #89dceb;
  --accent-sapphire: #74c7ec;
  --accent-blue: #89b4fa;
  --accent-lavender: #b4befe;
}`,
    `@theme {
  --color-text: #cdd6f4;
  --color-subtext1: #bac2de;
  --color-subtext0: #a6adc8;
  --color-overlay2: #9399b2;
  --color-overlay1: #7f849c;
  --color-overlay0: #6c7086;
  --color-surface2: #585b70;
  --color-surface1: #45475a;
  --color-surface0: #313244;
  --color-base: #1e1e2e;
  --color-mantle: #181825;
  --color-crust: #11111b;
  --color-error: #f38ba8;
${has('accents') ? '\n  /* The accent picker sets --accent on the page. */\n  --color-accent: var(--accent, var(--accent-peach));' : '  --color-accent: #fab387;'}
}`,
    `@layer base {
  body {
    @apply flex min-h-screen flex-col bg-base font-sans text-text;
  }

  a {
    @apply underline decoration-accent underline-offset-4 hover:decoration-2;
  }

  button {
    @apply cursor-pointer rounded border-2 border-overlay0 bg-surface0 px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-base focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50;
  }

  input {
    @apply rounded border-2 border-overlay0 bg-surface0 px-2 py-1 text-text focus:border-accent focus:outline-none;
  }

  label {
    @apply text-sm font-medium text-subtext1;
  }

  ::selection {
    @apply bg-overlay2/25;
  }
}`,
    has('starter') && `@layer components {
  .skip-link {
    @apply absolute top-0 left-0 z-100 -translate-y-full bg-base px-2 py-1 text-accent transition-transform focus:translate-y-0;
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

export const ACCENTS = ['rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'] as const

export type Accent = (typeof ACCENTS)[number]

// Kept in a cookie the server reads, so a page it renders shows the chosen accent from the first paint.
export const accent = persisted<Accent>('accent', 'peach')

// A cookie's value is not checked against the type, so anything but a known accent reads as the default.
export function currentAccent(): Accent {
  const value = accent()

  return ACCENTS.includes(value) ? value : 'peach'
}
`,
  'src/components/accent-picker.kay': `---
import Check from '~icons/tabler/check'
import Palette from '~icons/tabler/palette'
import { accent, ACCENTS, currentAccent } from '../theme'
---
style {\`:root { --accent: var(--accent-\${currentAccent()}); }\`}
details.relative
  summary.flex.cursor-pointer.list-none.items-center.gap-2.text-sm.text-subtext1
    Palette.size-5.text-accent
    | Accent
  div(
    class="absolute right-0 mt-2 grid grid-cols-7 gap-1 rounded border-2 border-overlay0 bg-mantle p-2 shadow-lg"
    role="radiogroup"
    aria-label="Accent colour"
  )
    for name of ACCENTS
      button.grid.size-6.place-items-center.rounded.border-2.border-overlay0.p-0(type="button" role="radio" aria-label={name} aria-checked={currentAccent() === name ? 'true' : 'false'} style={\`background-color: var(--accent-\${name})\`} onClick={() => accent = name})
        if currentAccent() === name
          Check.size-4.text-base
`,
}
