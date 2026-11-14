import type { CheckDiagnostic, CheckOptions } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

import { aiLanguage } from '../src/check/ai-language'
import { cmsOptions } from '../src/check/cms-options'
import { applySafeFixes } from '../src/check/fixes'

import { guardOptions } from '../src/check/guard-options'
import { diskFilesCalls, jobHandlers, jobOptions, scheduleCalls } from '../src/check/job-shapes'
import { formatDurationNumbers } from '../src/check/format-duration'
import { localState } from '../src/check/local-state'
import { mailApi } from '../src/check/mail-api'
import { listenTarget, movedImports, navigateQuery, navigationHooks, persistedCall, persistedQuery } from '../src/check/one-state-api'
import { renamedPackages } from '../src/check/renamed-packages'
import { schemaType } from '../src/check/schema-type'
import { storeNames } from '../src/check/store-names'
import { testHelpers } from '../src/check/test-helpers'

import { compileKay } from '../src/compiler'
import { DEPRECATED_LINTS } from '../src/compiler/deprecated-lints'
import { scratchDir } from './scratch'

type Name = keyof typeof DEPRECATED_LINTS

// The project-wide lints, each by the check that finds it; a deprecated lint of the compiler is found by `compileKay`, so it needs no entry.
const SITE: Record<string, (root: string, options: CheckOptions) => Promise<CheckDiagnostic[]>> = {
  'deprecated-ai-language': aiLanguage,
  'deprecated-job-handler': jobHandlers,
  'deprecated-schedule-call': scheduleCalls,
  'deprecated-job-options': jobOptions,
  'deprecated-disk-files': diskFilesCalls,
  'deprecated-local-state': localState,

  'deprecated-persisted-call': persistedCall,
  'deprecated-persisted-query': persistedQuery,
  'deprecated-navigate-query': navigateQuery,
  'deprecated-navigation-hooks': navigationHooks,
  'deprecated-listen-target': listenTarget,
  'deprecated-import-path': movedImports,
  'deprecated-schema-type': schemaType,
  'deprecated-test-helpers': testHelpers,
  'deprecated-cms-options': cmsOptions,
  'deprecated-store-names': storeNames,
  'deprecated-format-duration': formatDurationNumbers,
  'deprecated-guard-option': guardOptions,
  'deprecated-package-names': async (root, options) => renamedPackages(root, options.lints),
  // Its fix is safe only in a project that lists kayjs-ui, where the new form comes from.
  'deprecated-mail-form': async (root, options) => {
    await Bun.write(join(root, 'package.json'), '{ "dependencies": { "@kayjs/ui": "*" } }')

    return mailApi(root, options)
  },
}

// Every deprecated lint has a `safe` fix, which `kay upgrade` applies, that turns its `wrong` example into its `right` one (#2843). A lint whose old form no fix can rewrite without risk goes here with the reason, and `kay upgrade` leaves it to `llms/upgrading.md`: moving code into a new file is the one today.
const NO_SAFE_FIX: Partial<Record<Name, string>> = {
  'deprecated-page-island': 'moving what needs the browser into a component is a new file and a new import, not an edit in place',
  'deprecated-mail-send': 'a call reaches the request\'s mailer only when its function is handed the context, which an edit in place cannot know',
}

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

    expect(compiled.sort()).toEqual(['deprecated-ai-labels', 'deprecated-if-alias', 'deprecated-image-options', 'deprecated-mail-send', 'deprecated-page-cache', 'deprecated-page-island', 'deprecated-page-seo', 'deprecated-script-fence', 'deprecated-ui-props'])
    expect(compiled.sort()).toEqual(['deprecated-ai-labels', 'deprecated-if-alias', 'deprecated-image-options', 'deprecated-script-fence', 'deprecated-ui-props'])
    expect(compiled.sort()).toEqual(['deprecated-if-alias', 'deprecated-image-options', 'deprecated-page-cache', 'deprecated-page-seo', 'deprecated-script-fence', 'deprecated-ui-props'])
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
