import type { CheckDiagnostic, CheckOptions } from '.'
import type { NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const CMS = /\bcms\b/
const FROM_CMS = (source: string) => source === '@kayjs/cms' || source === '@kaynooo/kayjs-cms'
const COMMENT = /\/[*/]/
const TRAILING_COMMA = /,$/

type ObjectNode = NodeOfType<'ObjectExpression'>
type Property = Extract<ObjectNode['properties'][number], { type: 'Property' }>

// `role`, `guard: passwordGuard(...)` and an `uploads` list of `cms()`, which `access` and `uploads: { types }` took over in 1.105: `cms({ role: 'editor' })` is `cms({ access: 'editor' })`, `cms({ guard: passwordGuard(password, options) })` is `cms({ access: { password, ...options } })` and `uploads: ['image/*']` is `uploads: { types: ['image/*'] }`; `member` beside a custom guard is one `access` function, reported with no fix.
// Found on a call of `cms` imported from `@kayjs/cms`, in the options object written in the call, in the project's TypeScript files and `.kay` files.
export async function cmsOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-cms-options', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-cms-options', CMS, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_CMS, 'cms')
      const passwordGuards = importsOf(ast, FROM_CMS, 'passwordGuard').locals

      if (locals.size === 0 && namespaces.size === 0)
        continue

      const isCms = (callee: NodeOfType<'CallExpression'>['callee']): boolean => callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'cms'

      walk(ast, (node) => {
        const argument = node.type === 'CallExpression' && isCms(node.callee) ? node.arguments[0] : undefined

        if (argument?.type !== 'ObjectExpression')
          return

        const property = (name: string) => argument.properties.find((one): one is Property => one.type === 'Property' && keyName(one) === name)
        const spread = argument.properties.some(one => one.type === 'SpreadElement')
        const present = (name: string) => property(name) !== undefined
        const found: { property: Property, message: string, help: string, edits: Edit[] | null }[] = []

        const role = property('role')

        if (role)
          found.push({ property: role, message: '`role` of `cms()` is deprecated since 1.105: `access` says who is let in', help: 'write `access` for `role`', edits: role.shorthand || spread || present('access') ? null : [{ start: base + role.key.start, end: base + role.key.end, text: 'access' }] })

        const guard = property('guard')

        if (guard?.value.type === 'CallExpression' && guard.value.callee.type === 'Identifier' && passwordGuards.has(guard.value.callee.name)) {
          const [password, given] = guard.value.arguments
          const inner = given?.type === 'ObjectExpression' && given.properties.length > 0 ? source.slice(base + given.start + 1, base + given.end - 1).trim().replace(TRAILING_COMMA, '') : ''
          const simple = password !== undefined && password.type !== 'SpreadElement' && (given === undefined || (given.type === 'ObjectExpression' && !given.properties.some(one => one.type === 'SpreadElement')))
          const edits = simple && !spread && !present('access') && !guard.shorthand ? [{ start: base + guard.start, end: base + guard.end, text: `access: { password: ${source.slice(base + password.start, base + password.end)}${inner === '' ? '' : `, ${inner}`} }` }] : null

          found.push({ property: guard, message: '`guard: passwordGuard()` of `cms()` is deprecated since 1.105: `access: { password }` takes the passwords and their options', help: 'write `access: { password }` for the `passwordGuard()`; the import it leaves unused can go', edits })
        }

        const uploads = property('uploads')

        if (uploads?.value.type === 'ArrayExpression')
          found.push({ property: uploads, message: '`uploads` of `cms()` as a list is deprecated since 1.105: `uploads: { types }` names the types beside `maxSize`', help: 'write `{ types: [...] }` for the list', edits: uploads.shorthand ? null : [{ start: base + uploads.value.start, end: base + uploads.value.start, text: '{ types: ' }, { start: base + uploads.value.end, end: base + uploads.value.end, text: ' }' }] })

        const member = property('member')

        if (member)
          found.push({ property: member, message: '`member` of `cms()` is deprecated since 1.105: `access` as a function says who is let in and who they are in one', help: 'move `member` and the guard into one `access` function returning the person, or nothing for a visitor', edits: null })

        for (const { property: where, message, help, edits } of found) {
          // A comment in a range the fix replaces would be lost with it.
          const lost = edits?.some(edit => COMMENT.test(source.slice(edit.start, edit.end)))

          report(base + where.start, base + where.end, message, help, lost ? null : edits)
        }
      })
    }
  })
}
