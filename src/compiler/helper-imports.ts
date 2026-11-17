import type { AwaitAlert } from './names'
import { helperName } from './markup'

// The `kay/html` helpers static server output calls, each imported under a `Kay` name.
const HTML_HELPERS = ['attempt', 'attribute', 'checkedMarkup', 'child', 'className', 'component', 'componentClass', 'currentPage', 'dynamic', 'element', 'errorParagraph', 'fieldDescribed', 'formConstraints', 'formKey', 'formOptions', 'formType', 'head', 'html', 'imageAttributes', 'innerMarkup', 'leadingNewline', 'linkHref', 'localHref', 'loop', 'memo', 'merge', 'nonEmptyAttribute', 'omit', 'outsideLink', 'partClass', 'partHanded', 'partsClass', 'raw', 'rawData', 'rawTyped', 'refillOptions', 'schemaFill', 'selectOptions', 'serverIsland', 'show', 'spreadAttributes', 'spreadWith', 'style', 'untrack']

// The `kay/dom` helpers browser output calls, each imported under a `Kay` name.
const DOM_HELPERS = ['append', 'attribute', 'branches', 'checkedMarkup', 'choose', 'close', 'component', 'componentClass', 'effect', 'errorParagraph', 'fragment', 'holdSubmits', 'insert', 'listen', 'listenSubmit', 'listenSubmitWith', 'listenWith', 'markers', 'memo', 'merge', 'omit', 'outside', 'part', 'partClass', 'partHanded', 'partsClass', 'property', 'ref', 'setClass', 'setStyle', 'spreadAttributes', 'spreadWith', 'template', 'text', 'transition', 'untrack']
// The helpers in modules of their own, as their runtimes weigh on a page whose islands use none of them: the module of each is only loaded by a page with an island that compiles to it.
const APART = [['kay/dom-loop', ['loop', 'rowKey']], ['kay/dom-await', ['awaited']], ['kay/dom-try', ['attempt']], ['kay/dom-spread', ['dynamic', 'spread']], ['kay/dom-image', ['image']], ['kay/pending', ['pendingCall']]] as const

// The imports of server output, then the app's `await-failed.kay` when the template has an `await`.
export function htmlHelperImport(alert: AwaitAlert | undefined, awaits: boolean): string {
  return `import { ${HTML_HELPERS.map(helper => `${helper} as ${helperName(helper)}`).join(', ')} } from 'kay/html'\n${awaitAlertImport(alert, awaits)}`
}

export function domHelperImport(alert: AwaitAlert | undefined, awaits: boolean): string {
  const named = (helpers: readonly string[]) => helpers.map(helper => `${helper} as ${helperName(helper)}`).join(', ')

  return `import { ${named(DOM_HELPERS)} } from 'kay/dom'\n${APART.map(([module, helpers]) => `import { ${named(helpers)} } from '${module}'\n`).join('')}${awaitAlertImport(alert, awaits)}`
}

// The app's `await-failed.kay`, imported by a template with an `await` and handed to the block that has no `catch` and no `try` around it, in the browser with a way to run the block again.
function awaitAlertImport(alert: AwaitAlert | undefined, awaits: boolean): string {
  return alert !== undefined && awaits ? `import KayAwaitFailed from ${JSON.stringify(alert.file)}\n` : ''
}

export function awaitAlertTail(alert: AwaitAlert | undefined, target: 'html' | 'dom'): string {
  if (alert === undefined)
    return ''

  return target === 'html' ? ', alert: (error) => KayComponent(KayAwaitFailed, { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) })' : ', undefined, (error, retry) => KayComponent(KayAwaitFailed, { error, retry })'
}
