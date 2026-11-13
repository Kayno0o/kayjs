import type { Refreshable } from './action-shared'
import { skew } from './build'
import { leave, mayLeave, navigation } from './navigation'
import { reload } from './stale'

// The code of `navigate()` and `refresh()`, loaded on first use; a chunk a deploy removed asks the server whether the build changed, which reloads the page; undefined means the code is unavailable.
export async function navigateApi(): Promise<typeof import('./navigate-api') | undefined> {
  try {
    return await import('./navigate-api')
  }
  catch {
    await skew()

    return undefined
  }
}

// The page's loads again through the swap, unless the visitor or the app went elsewhere while its code loaded, as a refresh started before them would have given way to them.
// Without the swap's code the page reloads, as a deploy's would, so an action's effect still shows; a reload that would lose what was typed, or came within the minute, leaves the page and the next link loads in full.
export async function refreshed(loads?: readonly string[]): Promise<void> {
  const [navigations, visits] = [navigation.navigations, navigation.visits]
  const api = await navigateApi()

  if (navigation.navigations !== navigations || navigation.visits !== visits)
    return

  if (api)
    await api.refresh(loads)
  else
    reload()
}

// What a call limited its refresh to, `refresh()`ed together; one that throws or fails is that source's to show.
export async function refreshedIn(sources: readonly Refreshable[]): Promise<void> {
  await Promise.allSettled(sources.map(async (source) => {
    await source.refresh()
  }))
}

// Through the swap once it took over the app's links; a site with `navigation: false` loads the page, asking the leave guards first as `navigate()` would.
export async function goTo(target: string): Promise<void> {
  const api = navigation.hooks ? await navigateApi() : undefined

  if (api) {
    await api.navigateTo(target, {}, false)

    return
  }

  const url = new URL(target, location.href)

  if (await mayLeave(url, false))
    leave(url)
}
