import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import { join } from 'node:path'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { walk } from './ast'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const AUTH_PACKAGE = '@kaynooo/kayjs-auth'

// The flat methods of kayjs-auth's account, provider and audit methods before 1.87 and the grouped method each became; `packages/auth/src/flatMethods.ts` keeps them as aliases until 1.90.
export const AUTH_METHODS: Readonly<Record<string, string>> = {
  changeUsername: 'account.changeUsername',
  deleteAccount: 'account.delete',
  deletionImpact: 'account.deletionImpact',
  updateLocale: 'account.updateLocale',
  profile: 'account.profile',
  saveProfile: 'account.saveProfile',
  exportData: 'account.export',
  linkProvider: 'oauth.link',
  unlink: 'oauth.unlink',
  listIdentities: 'oauth.identities',
  providerToken: 'oauth.providerToken',
  listAuditLog: 'audit.list',
  createUser: 'admin.createUser',
}

// `createUser` is a method of the `createAuth` result, which an app imports from its own module: the name is found on an imported `auth` too.
const MODULE_METHODS = new Set(['createUser'])

const FLAT_NAME = new RegExp(`\\.(?:${Object.keys(AUTH_METHODS).join('|')})\\b`)

// A call of a flat kayjs-auth method on the request's auth, `ctx.locals.auth.deleteAccount(proof)`, in a project depending on the library: the fix calls the grouped method, `ctx.locals.auth.account.delete(proof)`.
// The auth is a receiver named `auth`, alone or as the last member of a chain; a name meaning anything else there is the app's own, so a project without the library is left alone.
export async function authMethods(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-auth-account-methods', options.lints) === 'allow' || !await dependsOnAuth(root))
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('auth') || !FLAT_NAME.test(source))
      continue

    const levelAt = lintLevels(source, options.lints)
    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server, parsed.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    const asts = spans.flatMap(({ start: base, end }) => {
      try {
        return [{ base, ast: parseProgram(source.slice(base, end), { lang: file.endsWith('.ts') ? 'ts' : 'tsx', recover: true }).program }]
      }
      catch {
        return []
      }
    })
    // An `auth` the file imports is a module of the app's own, whose `register` or `invite` is no kayjs-auth method.
    const imported = asts.some(({ ast }) => importsAuth(ast))

    for (const { base, ast } of asts) {
      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const callee = node.callee

        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || !Object.hasOwn(AUTH_METHODS, callee.property.name) || !isAuth(callee.object, imported && !MODULE_METHODS.has(callee.property.name)))
          return

        const name = callee.property.name
        const grouped = AUTH_METHODS[name]!
        const start = base + callee.property.start
        const level = levelAt('deprecated-auth-account-methods', start)

        if (level === 'allow')
          return

        found.push({
          file,
          ...positionAt(source, start),
          end: base + callee.property.end,
          message: `\`auth.${name}\` is the flat name kayjs-auth had before 1.87, kept until 1.90: the method is \`auth.${grouped}\``,
          help: `call \`auth.${grouped}\`, with the same arguments`,
          code: 'deprecated-auth-account-methods',
          severity: level === 'warn' ? 'warning' : 'error',
          fixes: [{ title: `Call auth.${grouped}`, edits: [{ start, end: base + callee.property.end, text: grouped }], safe: true }],
        })
      })
    }
  }

  return found
}

// `auth`, unless imported, or a chain ending in `.auth` such as `ctx.locals.auth`, seen through `!` and `as`.
function isAuth(node: Node, imported: boolean): boolean {
  if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression')
    return isAuth(node.expression, imported)

  if (node.type === 'Identifier')
    return node.name === 'auth' && !imported

  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'auth'
}

function importsAuth(ast: Program): boolean {
  return ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && statement.specifiers.some(specifier => specifier.local.name === 'auth'))
}

async function dependsOnAuth(root: string): Promise<boolean> {
  const file = Bun.file(join(root, 'package.json'))

  if (!await file.exists())
    return false

  try {
    const manifest = await file.json() as Partial<Record<'dependencies' | 'devDependencies' | 'peerDependencies', Record<string, string>>>

    return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(listed => listed !== undefined && Object.hasOwn(listed, AUTH_PACKAGE))
  }
  catch {
    return false
  }
}
