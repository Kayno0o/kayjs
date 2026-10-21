import type { DevTool } from 'kay/dev-tool'

// The dev tool's CMS tab, a browser module kay loads on dev pages: whether this visitor is in edit mode, with a toggle for the page they are on.
const STATE_URL = '/_kay/cms'

interface CmsState {
  editing: boolean
  prefix: string
  exit: string
  words?: Record<string, string>
}

// The English the tab falls back to: the server words the rest in the page's language with its answer, so the texts shown before one arrives or when it fails are the last answer's, else these.
const ENGLISH: Record<string, string> = {
  editing: 'You are in edit mode on this site.',
  notEditing: 'You are not in edit mode.',
  edit: 'Edit this page',
  leave: 'Leave edit mode',
  guard: 'The screens\' guard decides whether you may.',
  screens: 'Open the screens',
  readFailure: 'Could not read the edit mode: {failure}',
  leaveFailure: 'Could not leave edit mode: {failure}',
  unavailable: 'kayjs-cms answers here under `kay dev` alone.',
  answered: 'the server answered {status}',
}

function base(): string {
  return document.querySelector<HTMLMetaElement>('meta[name=kay-base]')?.content ?? ''
}

// The page's path without the base, as the screens' `path` takes it.
function sitePath(): string {
  const mount = base()

  return `${location.pathname.startsWith(mount) ? location.pathname.slice(mount.length) || '/' : location.pathname}${location.search}`
}

// `screenPath` of ./paths, copied: kay serves this module as one file, with no import of its own.
function screenPath(prefix: string, path = ''): string {
  return `${prefix === '/' ? '' : prefix}${path}` || '/'
}

export default function cmsDevTool(tool: DevTool): void {
  let asked = 0
  let words = ENGLISH

  const say = (key: string, values: Record<string, string> = {}) => (words[key] ?? ENGLISH[key]!).replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
  const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
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
          empty(say('unavailable'))

        return
      }

      if (!response.ok)
        throw new Error(say('answered', { status: String(response.status) }))

      state = await response.json() as CmsState
      words = state.words ?? ENGLISH
    }
    catch (error) {
      if (ask === asked)
        empty(say('readFailure', { failure: reason(error) }))

      return
    }

    if (ask !== asked)
      return

    const status = tool.make('div', state.editing ? 'good' : 'note', state.editing ? say('editing') : say('notEditing'))
    const toggle = tool.make('button', 'tool', state.editing ? say('leave') : say('edit'))
    const note = tool.make('div', 'note', state.editing ? '' : say('guard'))
    const actions = tool.make('div', 'actions')
    const screens = tool.make('a', 'link', say('screens'))

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
          throw new Error(say('answered', { status: String(response.status) }))

        location.reload()
      }
      catch (error) {
        toggle.disabled = false
        note.textContent = say('leaveFailure', { failure: reason(error) })
      }
    }

    toggle.addEventListener('click', () => void press())
    actions.append(toggle)
    tab.panel.replaceChildren(status, actions, note, screens)
  }
}
