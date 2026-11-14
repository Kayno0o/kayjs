import type { CheckDiagnostic, CheckOptions } from '.'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { importedName } from './ast'
import { scan } from './renamed-exports'

const MAIL_FORM = '@kayjs/mail/subscribe-form.kay'
const UI_FORM = '@kayjs/ui/subscribe-form.kay'
const SEND_NAMES = new Set(['send', 'enqueue', 'registeredMailer'])
const NEEDLE = /@kayjs\/mail/

// Whether the project's manifest lists kayjs-ui, which the moved form comes from.
function hasUi(root: string): boolean {
  const manifest = join(root, 'package.json')

  return existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"@kayjs/ui"')
}

// The old forms of kayjs-mail's API: its own `SubscribeForm`, which kayjs-ui's replaces since 1.105 (the same props, themed), and the `send`, `enqueue` and `registeredMailer` that reach the latest started site's mailer, `ctx.locals.mail` being the request's own.
export async function mailApi(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const formLevel = lintLevel('deprecated-mail-form', options.lints)
  const sendLevel = lintLevel('deprecated-mail-send', options.lints)

  if (formLevel === 'allow' && sendLevel === 'allow')
    return []

  const ui = hasUi(root)
  const found: CheckDiagnostic[] = []

  if (formLevel !== 'allow') {
    found.push(...await scan(root, options, 'deprecated-mail-form', NEEDLE, ({ parsed, report }) => {
      for (const { ast, base } of parsed) {
        for (const statement of ast.body) {
          if (statement.type !== 'ImportDeclaration' || statement.source.value !== MAIL_FORM)
            continue

          const { start, end } = statement.source

          report(base + start, base + end, `kayjs-mail's \`SubscribeForm\` is kayjs-ui's since 1.105, which takes the same props and reads the list's \`privacy\` from its action`, `import it from \`${UI_FORM}\``, [{ start: base + start, end: base + end, text: `'${UI_FORM}'` }], ui)
        }
      }
    }))
  }

  if (sendLevel !== 'allow') {
    found.push(...await scan(root, options, 'deprecated-mail-send', NEEDLE, ({ parsed, report }) => {
      for (const { ast, base } of parsed) {
        for (const statement of ast.body) {
          if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || statement.source.value !== '@kayjs/mail')
            continue

          for (const specifier of statement.specifiers) {
            if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type' || !SEND_NAMES.has(importedName(specifier)))
              continue

            const name = importedName(specifier)

            report(base + specifier.start, base + specifier.end, name === 'registeredMailer' ? '`registeredMailer()` is gone since 1.105: it answered the latest site started, which is none of a request\'s' : `\`${name}()\` of kayjs-mail sends through the latest site started, which is none of a request's, since 1.105: \`ctx.locals.mail\` is the request's own`, 'write `ctx.locals.mail.send(...)` or `.enqueue(...)` in a page, an action or a guard, and the mailer of `src/mail.ts` in a job or a script', null)
          }
        }
      }
    }))
  }

  return found
}
