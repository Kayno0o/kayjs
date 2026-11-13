import type { CheckDiagnostic, CheckOptions } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { aiOptions } from '../src/check/ai-options'
import { awaitConsent } from '../src/check/await-consent'
import { cmsTestHelpers } from '../src/check/cms-test-helpers'
import { eventNames } from '../src/check/event-names'
import { filterOptions } from '../src/check/filter-options'
import { applySafeFixes } from '../src/check/fixes'
import { infiniteListOptions } from '../src/check/infinite-list-options'
import { localState } from '../src/check/local-state'
import { persistedStorage } from '../src/check/persisted-storage'
import { schemaType } from '../src/check/schema-type'
import { uiItemKeys, uiItems } from '../src/check/ui-items'
import { compileKay } from '../src/compiler'
import { DEPRECATED_LINTS } from '../src/compiler/deprecated-lints'
import { scratchDir } from './scratch'

type Name = keyof typeof DEPRECATED_LINTS

// The project-wide lints, each by the check that finds it; a deprecated lint of the compiler is found by `compileKay`, so it needs no entry.
const SITE: Record<string, (root: string, options: CheckOptions) => Promise<CheckDiagnostic[]>> = {
  'deprecated-local-state': localState,
  'deprecated-event-names': eventNames,
  'deprecated-await-consent': awaitConsent,
  'deprecated-ai-options': aiOptions,
  'deprecated-filter-options': filterOptions,
  'deprecated-ui-items': uiItems,
  'deprecated-ui-item-keys': uiItemKeys,
  'deprecated-infinite-list-options': infiniteListOptions,
  'deprecated-cms-test-helpers': cmsTestHelpers,
  'deprecated-persisted-storage': persistedStorage,
  'deprecated-schema-type': schemaType,
}

// Every deprecated lint has a `safe` fix, which `kay upgrade` applies, that turns its `wrong` example into its `right` one (#2843). A lint whose old form no fix can rewrite without risk goes here with the reason, and `kay upgrade` leaves it to `llms/upgrading.md`: none today.
const NO_SAFE_FIX: Partial<Record<Name, string>> = {}

// Where a lint's `wrong` example lives: the file its first comment names, a `.kay` file when it opens with a fence, a module otherwise.
function placed(source: string): { path: string, text: string } {
  const named = (/^\/\/ (\S+)\n/).exec(source)

  if (named) {
    return { path: named[1]!, text: source.slice(named[0].length) }
  }

  return { path: source.startsWith('---') ? 'src/routes/index.kay' : 'src/mod.ts', text: source }
}

const names = Object.keys(DEPRECATED_LINTS) as Name[]

describe('every deprecated lint has a safe fix', () => {
  it('lists each lint\'s check, so a new one cannot go without', () => {
    const compiled = names.filter(name => !(name in SITE))

    expect(compiled.sort()).toEqual(['deprecated-ai-props', 'deprecated-if-alias', 'deprecated-script-fence', 'deprecated-ui-props'])
    expect(Object.keys(NO_SAFE_FIX).filter(name => !names.includes(name as Name))).toEqual([])
  })

  for (const name of names.filter(one => !(one in NO_SAFE_FIX))) {
    const lint = DEPRECATED_LINTS[name]

    it(`${name} rewrites its example`, async () => {
      if (!(name in SITE)) {
        const diagnostics = compileKay(lint.wrong, 'x.kay', { check: true }).diagnostics.filter(d => d.code === name)
        const edits = diagnostics.flatMap(d => d.fixes?.find(candidate => candidate.safe)?.edits ?? [])

        expect(edits).not.toEqual([])
        expect([...edits].sort((a, b) => b.start - a.start).reduce<string>((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, lint.wrong)).toBe(lint.right)

        return
      }

      const { path, text } = placed(lint.wrong)
      const root = await scratchDir('deprecated-fixes-')

      try {
        await Bun.write(join(root, path), text)

        const found = await SITE[name]!(root, {})

        expect(found.some(one => one.fixes?.some(candidate => candidate.safe))).toBe(true)
        await applySafeFixes(root, found)
        expect(await Bun.file(join(root, path)).text()).toBe(placed(lint.right).text)
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})
