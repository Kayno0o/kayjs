export type Feature = 'server' | 'starter' | 'tailwind' | 'accents' | 'eslint' | 'tests' | 'ci' | 'docker' | 'auth' | 'postgres' | 'ws'

// What kay.config.ts sets beyond the features, for a project migrated from a site that already had them.
export interface ConfigSettings {
  lang?: string | undefined
  site?: string | undefined
  base?: string | undefined
  // The `seo` defaults, left out where the pages already write their own titles and descriptions.
  seo?: boolean | undefined
  // The `fonts` entries of the installed Fontsource packages the site served.
  fonts?: { fontsource: string, weights?: number[] | undefined, styles?: string[] | undefined, subsets?: string[] | undefined }[] | undefined
}

// Where the project's repository is hosted, which decides the CI it is scaffolded with.
export type Host = 'forgejo' | 'github'

// The runner label each host's jobs run on unless `kay new --runner` names another.
export const DEFAULT_RUNNERS: Record<Host, string> = { forgejo: 'debian', github: 'ubuntu-latest' }

// The features a project is scaffolded with, as the files ask for them.
export interface Setup {
  has: (feature: Feature) => boolean
  host: Host
  // The label of the runner the CI jobs run on: the host's own image unless `kay new --runner` names another.
  runner: string
  // A Tailwind class list, left out of the markup of a project without Tailwind.
  tw: (classes: string) => string
  settings: ConfigSettings
}

export const REGISTRY = 'https://git.kaynooo.fr/api/packages/kaynooo/npm/'

// A file of these lines, each `false` left out.
export function lines(...entries: (string | false)[]): string {
  return `${entries.filter(entry => entry !== false).join('\n')}\n`
}

// A single-quoted string literal holding this text.
export function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

// A file of these blocks, each `false` left out, a blank line between the others.
export function blocks(...entries: (string | false)[]): string {
  return `${entries.filter(entry => entry !== false).join('\n\n')}\n`
}

// A `.kay` fence holding these lines, or nothing when none is left.
export function fence(opening: string, ...entries: (string | false)[]): string | false {
  const body = entries.filter(entry => entry !== false)

  return body.length > 0 && [opening, ...body, '---'].join('\n')
}
