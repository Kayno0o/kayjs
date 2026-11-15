import type { Refreshable } from './action-shared'
import { skew } from './build'
import { liveCache } from './cache-live-id'
import { leave, mayLeave, navigation } from './navigation'
import { refetchTagged } from './resource-tags'
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

// The refresh of a call whose handler invalidated cached keys: left out when the page, or a resource, follows one, as its live connection shows them; the page loads again as for any call when the code that tells is unavailable.
export async function refreshedUnlessFollowed(keys: readonly string[] | undefined): Promise<void> {
  const [navigations, visits] = [navigation.navigations, navigation.visits]

  try {
    // The resources naming a key as a tag ask their route again; the page is left alone when it opted in and follows the rest.
    const rest = keys === undefined ? undefined : refetchTagged(keys)

    if (rest !== undefined && (rest.length === 0 ? document.querySelector('script[data-kay-live-refresh]') !== null : liveCache.loaded && (await import('./live-cache')).follows(rest)))
      return
  }
  catch {}

  if (navigation.navigations === navigations && navigation.visits === visits)
    await refreshed()
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
