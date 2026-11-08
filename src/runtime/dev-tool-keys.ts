import type { DevState } from './dev-tool-layout'
import type { Shell } from './dev-tool-shell'
import type { TabEntry } from './dev-tool-tabs'

// The keyboard of the drawer: the arrows between the tabs, and the shortcut that opens and closes it. Split from dev-tool.ts.

interface KeyParts {
  win: Window
  host: HTMLElement
  root: ShadowRoot
  tabList: Shell['tabList']
  state: DevState
  tabs: TabEntry[]
  openTab: (id: string | undefined, focus?: boolean) => void
  closeDrawer: (focus?: boolean) => void
}

export function startKeys({ win, host, root, tabList, state, tabs, openTab, closeDrawer }: KeyParts): () => void {
  // Up and Down, Home and End move between the tabs, as a vertical tab list's do.
  tabList.onkeydown = (event) => {
    const index = tabs.findIndex(tab => tab.button === root.activeElement)
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 }[event.key]

    if (index < 0 || next === undefined)
      return

    event.preventDefault()
    openTab(tabs[(next + tabs.length) % tabs.length]!.options.id, true)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyK') {
      event.preventDefault()

      if (event.repeat)
        return

      if (state.open)
        closeDrawer(true)
      else
        openTab(undefined, true)
    }
    // Only from inside the tool, so the page's own dialogs keep their Escape.
    else if (event.key === 'Escape' && state.open && event.composedPath().includes(host)) {
      closeDrawer(true)
    }
  }

  win.addEventListener('keydown', onKeyDown, true)

  return () => win.removeEventListener('keydown', onKeyDown, true)
}
