import type { CheckDiagnostic } from '.'
import type { ServedProject } from './shadow-types'
import { positionAt } from '../compiler/mapping'
import { API_OPTIONS } from '../server/api-modules'
import { unreadSettings } from '../server/routes'

const NODE_MODULES = /[\\/]node_modules[\\/]/

// The `guards` and `layouts` settings of an endpoint's `page` and of an `api({...})` call that the server cannot read: it takes them from the source as written, so one held in a variable keeps the guards with no message.
export async function unreadOpenSettings({ endpoints, apiModules }: ServedProject): Promise<CheckDiagnostic[]> {
  const files = [
    ...endpoints.map(({ file }) => ({ file, head: undefined, where: '`page`' })),
    ...apiModules.map(({ file }) => ({ file, head: API_OPTIONS, where: 'the options of `api()`' })),
  ].filter(({ file }) => !NODE_MODULES.test(file))

  const found = await Promise.all(files.map(async ({ file, head, where }) => {
    const source = await Bun.file(file).text()

    return unreadSettings(source, head).map(({ key, index }): CheckDiagnostic => ({
      file,
      ...positionAt(source, index),
      end: index + (key === '...' ? 3 : key.length),
      code: 'page-settings-invalid',
      severity: 'error',
      message: key === '...' ? `kay reads each setting of ${where} as written` : `kay reads \`${key}\` as a literal \`true\` or \`false\``,
      help: key === '...' ? 'write it `key: value`, with no spread or computed key, as `guards` and `layouts` could be among them' : `write \`${key}: false\` itself: the server reads it from the source, so a variable or an expression is ignored`,
    }))
  }))

  return found.flat()
}
