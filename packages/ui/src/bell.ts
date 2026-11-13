import type { MenuTriggerProps } from './menu'
import type { NewTab } from './outside'

// What a `@trigger` snippet of a BellInbox is handed: a Menu trigger's attributes with a name that follows the unread count, to spread on any element.
export type BellTriggerProps = MenuTriggerProps & { 'aria-label': string }

interface BellItemBase {
  read?: boolean | undefined
  // Opens the link in a new tab (`true`), the same one (`false`), or a new one when the address leaves the site (`'auto'`, the default).
  newTab?: NewTab | undefined
}

// A notification an app's own source gives the `Bell`. `key` tells it apart and is what `onRead` carries, `label` is what it says and `href` a path of the site or an http(s) URL (anything else draws the row as a button).
export interface BellItem extends BellItemBase {
  key: string
  label: string
  href?: string | undefined
}

// A notification as kay's `notifications.inbox` answers it, which the Bell maps to a `BellItem`.
export interface InboxItem extends BellItemBase {
  id: string
  title: string
  url?: string | undefined
}

// A notification with `key`, `label` and `href` as `@item(note)` and the rows read them: what kay's `notifications.inbox` answers as `{ id, title, url }` gets them filled and keeps the three it came with.
export function bellItem<Item extends BellItem | InboxItem>(item: Item): Item & { key: string, label: string, href?: string | undefined } {
  const note = item as Partial<BellItem & InboxItem>
  const href = note.href ?? note.url

  return { ...item, key: note.key ?? note.id!, label: note.label ?? note.title!, ...href !== undefined && { href } }
}

// The notifications of an app's own source: a list, or a function answering one, called once the Bell is in the page and again after a read.
export type BellItems<Item extends BellItem = BellItem> = readonly Item[] | (() => PromiseLike<readonly Item[]> | readonly Item[])
