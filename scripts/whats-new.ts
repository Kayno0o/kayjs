// The pages listing what each release adds, the docs site's and the one agents read, each keeping what is not released yet under `## Unreleased`.
export const WHATS_NEW = ['docs/src/content/docs/guides/whats-new.md', 'llms/whats-new.md']

const UNRELEASED = /^## Unreleased$/m

// Names the `## Unreleased` section after the version being released; a page without one is left as it is.
export function stampUnreleased(text: string, version: string): string {
  return text.replace(UNRELEASED, `## ${version}`)
}
