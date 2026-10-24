import * as kay from '../../../src/runtime'
import * as dom from '../../../src/runtime/dom'
import * as domAwait from '../../../src/runtime/dom-await'
import * as domImage from '../../../src/runtime/dom-image'
import * as domLoop from '../../../src/runtime/dom-loop'
import * as domSpread from '../../../src/runtime/dom-spread'
import * as domTry from '../../../src/runtime/dom-try'
import * as html from '../../../src/runtime/html'
import * as internal from '../../../src/runtime/internal'
import * as islandClient from '../../../src/runtime/island.client'
import * as islandServer from '../../../src/runtime/island.server'
import * as title from '../../../src/runtime/page-title'
import * as pending from '../../../src/runtime/pending'

type Modules = Record<string, unknown>

// What `kay/...` is for the code of the server's output and of the browser's, which differ for an island as the package's `browser` condition picks them. `kay/await` is in neither: its server side reads `process`, so an example with an `await` block does not run.
const SERVER: Modules = { 'kay': kay, 'kay/html': html, 'kay/island': islandServer, 'kay/internal': internal, 'kay/internal/title': title }
const BROWSER: Modules = { 'kay': kay, 'kay/dom': dom, 'kay/dom-loop': domLoop, 'kay/dom-await': domAwait, 'kay/dom-try': domTry, 'kay/dom-spread': domSpread, 'kay/dom-image': domImage, 'kay/pending': pending, 'kay/island': islandClient, 'kay/internal': internal }

type Component = (props: object) => unknown

function load(code: string, modules: Modules): Component {
  const exports: { default?: Component } = {}
  const require = (specifier: string) => {
    if (!Object.hasOwn(modules, specifier))
      throw new Error(`The playground has no \`${specifier}\` to import: it runs a component that imports from 'kay' alone`)

    return modules[specifier]
  }

  // eslint-disable-next-line no-new-func
  new Function('__require', '__exports', code)(require, exports)

  if (!exports.default)
    throw new Error('The component has no default export')

  return exports.default
}

// The markup the server renders for the component. Islands show their server markup; an `await` block is not waited for.
export function renderServer(code: string): string {
  const view = load(code, SERVER)

  return String(islandServer.collectIslands(() => html.child(html.component(view, {}))).result)
}

// Mounts the component in `container` as the browser builds it, returning what removes it again.
export function mount(code: string, container: Element): () => void {
  const view = load(code, BROWSER)

  return dom.render(() => dom.component(view, {}), container)
}
