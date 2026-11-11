import type { MenuTriggerProps } from './menu'
import type { NewTab } from './outside'

// What a `@trigger` snippet of a BellInbox is handed: a Menu trigger's attributes with a name that follows the unread count, to spread on any element.
export type BellTriggerProps = MenuTriggerProps & { 'aria-label': string }

interface BellItemBase {
  read?: boolean | undefined
  // Opens the link in a new tab (`true`), the same one (`false`), or a new one when the address leaves the site (`'auto'`, the default).
  newTab?: NewTab | undefined
}

// A notification the `Bell` lists: what kay's `notifications.inbox` answers, and what an app's own source gives it. `key` tells it apart and is what `onRead` carries, `label` is what it says and `href` a path of the site or an http(s) URL (anything else draws the row as a button); `id`, `title` and `url` are the names they had before 1.100, deprecated: the new name wins when both are given.
export type BellItem = BellItemBase
  & ({ key: string, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ id?: string | undefined } | { key?: undefined, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ id: string })
  & ({ label: string, /** @deprecated Use `label`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ title?: string | undefined } | { label?: undefined, /** @deprecated Use `label`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ title: string })
  & { href?: string | undefined, /** @deprecated Use `href`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ url?: string | undefined }

// A notification with its new names filled from the old ones, as `@item(note)` and the rows read it: what kay's `notifications.inbox` answers as `{ id, title, url }` gets `key`, `label` and `href` here, and keeps the old three.
export function bellItem<Item extends BellItem>(item: Item): Item & { key: string, label: string, href?: string | undefined } {
  const href = item.href ?? item.url

  return { ...item, key: item.key ?? item.id, label: item.label ?? item.title, ...href !== undefined && { href } }
}

// The notifications of an app's own source: a list, or a function answering one, called once the Bell is in the page and again after a read.
export type BellItems<Item extends BellItem = BellItem> = readonly Item[] | (() => PromiseLike<readonly Item[]> | readonly Item[])
