import type { CheckDiagnostic, CheckOptions } from '.'
import { renamedCallOptions } from './renamed-call-options'

const INFINITE_LIST = /\binfiniteList\b/

// `pageSize` in the options of kayjs-ui's `infiniteList()`, `limit` since 1.100: the rows a full page holds are the `limit` of the window each page asks for, as `PageInput` and `pageFields` name it, `pageSize` being for a list paged by number.
// Found in the options object written as the second argument of a call of `infiniteList` imported from `@kaynooo/kayjs-ui`; a key whose new name is written too is reported with no fix.
export async function infiniteListOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedCallOptions(root, options, {
    lint: 'deprecated-infinite-list-options',
    needle: INFINITE_LIST,
    from: source => source === '@kaynooo/kayjs-ui',
    calls: { infiniteList: 1 },
    renames: [['pageSize', 'limit']],
    since: '1.100',
    of: 'kayjs-ui\'s `infiniteList()`',
  })
}
