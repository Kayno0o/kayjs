import type { ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { keyName, unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const OLD_NAME = /\b(?:maxAttachmentBytes|maxSize)\b/
const AI_PACKAGE = '@kaynooo/kayjs-ai'
// An extension's file imports kay or one of its libraries.
const CONFIG_HOLDER = /\bfrom\s+['"](?:kay|kayjs-[\w-]+|@kaynooo\/kayjs-[\w-]+)(?:\/[^'"]*)?['"]/

function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

// A size limit under the name it had before 1.90, when every size limit became `maxSize` (one size) or `maxSizeByPath` (a map by path): `maxAttachmentBytes` of kayjs-ai's `ask` and the path map of an extension written out as `maxSize`.
// The fix renames the key, a number of bytes being a `ByteSize`; a key written beside its new name is reported with no fix, as the new one wins.
export async function sizeLimits(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-size-limits', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-size-limits', OLD_NAME, ({ parsed, report }) => {
    const holder = parsed.some(({ text }) => CONFIG_HOLDER.test(text))

    for (const { ast, base } of parsed) {
      const asks = importsOf(ast, source => source === AI_PACKAGE, 'ask')

      const rename = (object: ObjectExpression, old: string, name: string, what: string) => {
        const plain = object.properties.filter(isPlain)
        const property = plain.find(one => keyName(one) === old)

        if (!property)
          return

        const clash = plain.some(one => keyName(one) === name)
        const { key } = property
        const edit = { start: base + key.start, end: base + (property.shorthand ? property.value.end : key.end), text: property.shorthand ? `${name}: ${old}` : name }

        report(base + key.start, base + key.end, `\`${old}\` of ${what} is \`${name}\` since 1.90, so a size limit is \`maxSize\` and a map of limits by path \`maxSizeByPath\`; the old name works until 1.93`, clash ? `\`${name}\` is set beside it, which wins: drop \`${old}\`` : `write \`${name}\``, clash ? null : [edit])
      }

      walk(ast, (node) => {
        if (node.type === 'CallExpression') {
          const { callee } = node
          const isAsk = callee.type === 'Identifier'
            ? asks.locals.has(callee.name)
            : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === 'ask' && asks.namespaces.has(callee.object.name)
          const given = isAsk && node.arguments[1] ? unwrapped(node.arguments[1]) : undefined

          if (given?.type === 'ObjectExpression')
            rename(given, 'maxAttachmentBytes', 'maxSize', '`ask()`')

          return
        }

        // An extension written out: an object with a `name` and a `maxSize` holding a map, which a size never is.
        if (node.type !== 'ObjectExpression' || !holder)
          return

        const plain = node.properties.filter(isPlain)
        const size = plain.find(one => keyName(one) === 'maxSize')
        const value = size && unwrapped(size.value)

        if (value?.type === 'ObjectExpression' && plain.some(one => keyName(one) === 'name'))
          rename(node, 'maxSize', 'maxSizeByPath', 'an extension')
      })
    }
  })
}
