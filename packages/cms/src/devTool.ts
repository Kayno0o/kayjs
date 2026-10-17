import type { DevTool } from 'kay/dev-tool'
import { screenPath } from './paths'

// The dev tool's CMS tab, a browser module kay loads on dev pages: whether this visitor is in edit mode, with a toggle for the page they are on.
const STATE_URL = '/_kay/cms'

interface CmsState {
  editing: boolean
  prefix: string
  exit: string
}

function base(): string {
  return document.querySelector<HTMLMetaElement>('meta[name=kay-base]')?.content ?? ''
}

// The page's path without the base, as the screens' `path` takes it.
function sitePath(): string {
  const mount = base()

  return `${location.pathname.startsWith(mount) ? location.pathname.slice(mount.length) || '/' : location.pathname}${location.search}`
}

export default function cmsDevTool(tool: DevTool): void {
  let asked = 0
  const tab = tool.tab({ id: 'cms', label: 'CMS', icon: 'pencil', shown: () => void show() })
  const empty = (text: string) => {
    tab.count(0)
    tab.panel.replaceChildren(tool.make('div', 'empty', text))
  }

  async function show(): Promise<void> {
    const ask = ++asked
    let state: CmsState

    try {
      const response = await fetch(STATE_URL, { cache: 'no-store' })

      if (response.status === 404) {
        if (ask === asked)
          empty('kayjs-cms answers here under `kay dev` alone.')

        return
      }

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      state = await response.json() as CmsState
    }
    catch (error) {
      if (ask === asked)
        empty(`Could not read the edit mode: ${error instanceof Error ? error.message : String(error)}`)

      return
    }

    if (ask !== asked)
      return

    const status = tool.make('div', state.editing ? 'good' : 'note', state.editing ? 'You are in edit mode on this site.' : 'You are not in edit mode.')
    const toggle = tool.make('button', 'tool', state.editing ? 'Leave edit mode' : 'Edit this page')
    const note = tool.make('div', 'note', state.editing ? '' : 'The screens\' guard decides whether you may.')
    const actions = tool.make('div', 'actions')
    const screens = tool.make('a', 'link', 'Open the screens')

    tab.count(state.editing ? 1 : 0)
    toggle.type = 'button'
    screens.href = `${base()}${screenPath(state.prefix)}`
    screens.target = '_blank'
    screens.rel = 'noopener'

    const press = async () => {
      if (!state.editing) {
        location.assign(`${base()}${screenPath(state.prefix, '/page')}?path=${encodeURIComponent(sitePath())}`)

        return
      }

      toggle.disabled = true

      try {
        const response = await fetch(`${base()}${state.exit}`, { method: 'POST' })

        if (!response.ok)
          throw new Error(`the server answered ${response.status}`)

        location.reload()
      }
      catch (error) {
        toggle.disabled = false
        note.textContent = `Could not leave edit mode: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    toggle.addEventListener('click', () => void press())
    actions.append(toggle)
    tab.panel.replaceChildren(status, actions, note, screens)
  }
}
