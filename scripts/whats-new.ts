// The page listing what each release adds, which the docs site renders too, keeping what is not released yet under `## Unreleased`.
export const WHATS_NEW = ['llms/whats-new.md']

const UNRELEASED = /^## Unreleased$/m

// Names the `## Unreleased` section after the version being released; a page without one is left as it is.
export function stampUnreleased(text: string, version: string): string {
  return text.replace(UNRELEASED, `## ${version}`)
}
