// The theme tokens of kayjs-ui under their old, prefixed names, and what each became in 1.72, when kayjs-ui started reading the app's own theme names (`--color-background`, `--color-muted`, `--radius-lg`...). Until 1.75 theme.css aliases each old name to its new one, and the `deprecated-ui-token` lint rewrites an app's use of it. The table goes with the lint in 1.75.
export interface UiToken {
  // Which Tailwind namespace the name is in, so the utilities that read it are known; `var` for a name no utility reads.
  kind: 'color' | 'text' | 'weight' | 'tracking' | 'spacing' | 'radius' | 'family' | 'var'
  // The variable that replaces it, when one does: a reference is renamed and keeps its fallback.
  to?: string
  // Whether the new name reads this one as its fallback, so a declaration of it is renamed without changing a pixel. A name folded into one that another old name also folds into is reported only.
  declares?: boolean
  // What a utility reading it becomes, written after the utility's own prefix: `bg-kui-canvas` is `bg-background`.
  utility?: string
  // What a `var()` of it becomes when it is not just the new name.
  value?: string
  // Where to set it instead, for a name that has no replacement of its own.
  help?: string
}

const COLOR = '--color-kui-'
const NAMESPACES = ['color', 'text', 'font-weight', 'tracking', 'spacing', 'radius', 'font'] as const
const KINDS = { 'color': 'color', 'text': 'text', 'font-weight': 'weight', 'tracking': 'tracking', 'spacing': 'spacing', 'radius': 'radius', 'font': 'family' } as const

const recipe = (component: string, part: string, use: string): string => `set \`${use}\` on the \`${part}\` part of \`${component}\` in src/ui.ts: \`'@kaynooo/kayjs-ui/${component}.kay': { parts: { ${part}: '${use}' } }\``
const privateName = (name: string): UiToken => ({ kind: 'var', help: `\`--kui-${name}\` is private to the component, now \`--_${name}\`; it is set and read on the component's own element, so restyle the component from src/ui.ts or \`class\` instead` })
const calc = (factor: string): string => `calc(var(--spacing) * ${factor})`

// A colour that became another name one for one.
function colour(old: string, to: string): [string, UiToken] {
  return [`${COLOR}${old}`, { kind: 'color', to: `--color-${to}`, declares: true, utility: to }]
}

// A colour folded into a name other old ones fold into too.
function folded(old: string, to: string): [string, UiToken] {
  return [`${COLOR}${old}`, { kind: 'color', to: `--color-${to}`, utility: to }]
}

// A border width the one `--border-width` replaced.
function border(old: string): [string, UiToken] {
  return [`--kui-border-${old}`, { kind: 'var', to: '--border-width' }]
}

function renamed(old: string, to: string, kind: UiToken['kind'] = 'var'): [string, UiToken] {
  return [old, { kind, to, declares: true }]
}

export const UI_TOKENS: Readonly<Record<string, UiToken>> = Object.fromEntries([
  colour('canvas', 'background'),
  colour('text', 'foreground'),
  colour('accent', 'accent'),
  colour('success', 'success'),
  colour('warning', 'warning'),
  colour('info', 'info'),
  colour('error', 'danger'),
  colour('field-border', 'input'),
  colour('mantle', 'popover'),
  colour('surface0', 'surface'),
  colour('surface1', 'surface-strong'),
  colour('surface2', 'border'),
  colour('overlay0', 'border-strong'),
  colour('muted', 'muted'),
  colour('accent-hi', 'accent-hover'),
  colour('on-accent', 'accent-foreground'),
  colour('row-hover', 'hover'),
  colour('field-focus', 'ring'),
  ...[1, 2, 3, 4, 5, 6].map(n => colour(`chart-${n}`, `chart-${n}`)),
  folded('overlay1', 'muted'),
  folded('subtext0', 'muted'),
  folded('fill-hover', 'surface-strong'),
  folded('stamp', 'foreground'),
  folded('stamp-fill', 'background'),
  folded('stamp-fill-hover', 'surface-strong'),
  folded('avatar-ring', 'border'),
  [`${COLOR}fill-danger`, { kind: 'color', utility: 'danger/10', value: 'color-mix(in oklab, var(--color-danger) 10%, transparent)' }],
  ...[1, 2, 3, 4, 5, 6].map((n): [string, UiToken] => [`--kui-chart-${n}`, { kind: 'var', to: `--color-chart-${n}` }]),

  renamed('--text-kui-2xs', '--text-2xs', 'text'),
  renamed('--text-kui-2xs--line-height', '--text-2xs--line-height'),
  ['--text-kui-micro', { kind: 'text', to: '--text-2xs', utility: '2xs' }],
  ['--text-kui-micro--line-height', { kind: 'var', to: '--text-2xs--line-height' }],
  ['--text-kui-badge', { kind: 'text', utility: 'xs', value: 'var(--text-xs)', help: recipe('badge', 'root', 'text-xs') }],
  ['--text-kui-badge--line-height', { kind: 'var', value: 'var(--text-xs--line-height)', help: recipe('badge', 'root', 'text-xs') }],
  ['--font-weight-kui-heading', { kind: 'weight', utility: 'semibold', value: 'var(--font-weight-semibold)', help: 'use `font-semibold`' }],
  ['--font-weight-kui-label', { kind: 'weight', utility: 'normal', value: 'var(--font-weight-normal)', help: 'use `font-normal`' }],
  ['--font-weight-kui-notice', { kind: 'weight', utility: 'normal', value: 'var(--font-weight-normal)', help: recipe('notice', 'root', 'font-normal') }],
  ['--font-weight-kui-avatar', { kind: 'weight', utility: 'semibold', value: 'var(--font-weight-semibold)', help: recipe('avatar', 'root', 'font-semibold') }],
  renamed('--tracking-kui-label', '--tracking-label', 'tracking'),
  ['--tracking-kui-section', { kind: 'tracking', to: '--tracking-label', utility: 'label' }],
  ['--tracking-kui-action', { kind: 'tracking', to: '--tracking-label', utility: 'label' }],
  ['--tracking-kui-badge', { kind: 'tracking', utility: 'normal', value: 'var(--tracking-normal)', help: recipe('badge', 'root', 'tracking-normal') }],
  ['--font-kui-mono', { kind: 'family', to: '--font-mono', declares: true, utility: 'mono' }],
  ['--font-kui-body', { kind: 'family', utility: '[family-name:inherit]', value: 'inherit', help: 'use `font-[inherit]`, fields already inherit the font' }],

  ['--spacing-kui-card', { kind: 'spacing', utility: '[calc(var(--spacing)*2.5*var(--density))]', value: 'calc(var(--spacing) * 2.5 * var(--density))' }],
  ['--spacing-kui-inline', { kind: 'spacing', utility: '[calc(var(--spacing)*1.25*var(--density))]', value: 'calc(var(--spacing) * 1.25 * var(--density))' }],
  ['--spacing-kui-section', { kind: 'spacing', utility: '[calc(var(--spacing)*3.5*var(--density))]', value: 'calc(var(--spacing) * 3.5 * var(--density))' }],
  ['--spacing-kui-field-x', { kind: 'spacing', utility: '[calc(var(--spacing)*2.25*var(--density))]', value: 'calc(var(--spacing) * 2.25 * var(--density))' }],
  ['--spacing-kui-field-y', { kind: 'spacing', utility: '[calc(var(--spacing)*var(--density))]', value: 'calc(var(--spacing) * var(--density))' }],
  ['--spacing-kui-field-height', { kind: 'spacing', help: 'a field\'s height is a calc shared through `field-look.ts` now; size one field from `class`, or every field of a component from its recipe in src/ui.ts' }],
  ['--spacing-kui-badge-x', { kind: 'spacing', utility: '1.5', value: calc('1.5'), help: recipe('badge', 'root', 'px-1.5') }],
  ['--spacing-kui-badge-y', { kind: 'spacing', utility: 'px', value: '1px', help: recipe('badge', 'root', 'py-px') }],

  ['--radius-kui-card', { kind: 'radius', utility: 'lg', value: 'var(--radius-lg)', help: 'a box takes `--radius-lg` now, and a button or a field `--radius-md`; set the ones you mean in your `@theme`' }],
  renamed('--radius-kui-sm', '--radius-sm', 'radius'),
  renamed('--radius-kui-md', '--radius-md', 'radius'),
  ['--radius-kui-full', { kind: 'radius', utility: 'full', value: 'calc(infinity * 1px)' }],

  renamed('--kui-density', '--density'),
  renamed('--kui-border-width', '--border-width'),
  border('card'),
  border('input'),
  border('badge'),
  border('stamp'),
  border('notice'),
  border('avatar'),
  renamed('--kui-label-case', '--label-case'),
  renamed('--kui-label-font', '--font-label'),
  renamed('--kui-shadow-raised', '--shadow-raised'),
  renamed('--kui-shadow-press', '--shadow-press'),
  renamed('--kui-press-travel', '--press-travel'),
  renamed('--kui-table-height', '--table-height'),
  renamed('--kui-line-chart-height', '--chart-height'),
  renamed('--kui-bar-chart-height', '--chart-height'),
  renamed('--kui-scatter-chart-height', '--chart-height'),
  renamed('--kui-zoom-scale', '--zoom-scale'),
  ['--kui-badge-case', { kind: 'var', help: recipe('badge', 'root', 'normal-case') }],
  ['--kui-badge-font', { kind: 'var', help: recipe('badge', 'root', 'font-sans') }],
  ['--kui-badge-solid-text', { kind: 'var', to: '--color-accent-foreground' }],
  ['--kui-field-focus-shadow', { kind: 'var', help: 'the focus ring of a field is drawn by its recipe now; restyle the field part in src/ui.ts' }],
  ...['badge-tone', 'toast-tone', 'shell-line', 'shell-fill', 'control-line', 'dot-size', 'masonry-gap', 'masonry-lane', 'masonry-lanes', 'masonry-min', 'masonry-top', 'skeleton-width', 'skeleton-height', 'split-list-width', 'tree-level', 'tooltip-anchor', 'badge-color', 'notice-tone', 'notice-ground'].map((name): [string, UiToken] => [`--kui-${name}`, privateName(name)]),
] as [string, UiToken][])

// The utility prefixes that read each namespace, as a pattern.
const UTILITY_PREFIXES: Record<Exclude<UiToken['kind'], 'var'>, string> = {
  color: 'bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|divide|from|via|to|fill|stroke|decoration|accent|caret|shadow|inset-shadow|placeholder',
  text: 'text',
  weight: 'font',
  family: 'font',
  tracking: 'tracking',
  spacing: 'p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|w|h|size|min-[wh]|max-[wh]|inset(?:-[xy])?|top|right|bottom|left|start|end|basis|translate-[xy]|scroll-[pm][xytrblse]?|indent',
  radius: 'rounded(?:-(?:[tblrse]|tl|tr|br|bl|ss|se|es|ee))?',
}

// The name a utility writes after `kui-`, and the namespace of a token whose utilities can be rewritten; none for `--kui-*` names and for the `--line-height` companions.
function utilityName(name: string): { kind: Exclude<UiToken['kind'], 'var'>, name: string } | undefined {
  for (const namespace of NAMESPACES) {
    const prefix = `--${namespace}-kui-`

    if (name.startsWith(prefix) && !name.slice(prefix.length).includes('--'))
      return { kind: KINDS[namespace], name: name.slice(prefix.length) }
  }

  return undefined
}

// One pattern per namespace matching a utility that reads a token of it, its variants before it left alone: the negative sign, the prefix and the token's name, followed by the end of the class or an opacity.
export const UI_TOKEN_UTILITIES: readonly { kind: Exclude<UiToken['kind'], 'var'>, pattern: RegExp, tokens: Map<string, UiToken> }[] = (Object.keys(UTILITY_PREFIXES) as Exclude<UiToken['kind'], 'var'>[]).flatMap((kind) => {
  const tokens = new Map<string, UiToken>()

  for (const [name, token] of Object.entries(UI_TOKENS)) {
    const found = utilityName(name)

    if (found?.kind === kind)
      tokens.set(found.name, token)
  }

  if (tokens.size === 0)
    return []

  const names = [...tokens.keys()].sort((a, b) => b.length - a.length)

  return [{ kind, tokens, pattern: new RegExp(`(?<![\\w-])(-?)(${UTILITY_PREFIXES[kind]})-kui-(${names.join('|')})(?![\\w-])`, 'g') }]
})
