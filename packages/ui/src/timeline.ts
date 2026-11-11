import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { NewTab } from './outside'
import type { Tone } from './tone'

interface TimelineEntryBase<Key extends string | number> {
  // Tells entries apart and is what `selected` and `onSelectedChange` carry.
  key: Key
  // The time or range as the app words it, such as `08:30` or `08:30 - 09:10`.
  time: string
  icon?: IconSlot | IconProps | undefined
  // `neutral` greys the entry, such as a gap nothing reported; the others colour the icon.
  tone?: Tone | undefined
  // False keeps the entry plain text when the timeline is selectable; true by default.
  pickable?: boolean | undefined
  // Makes the entry a link, to the page it stands for. It is no button then: `onSelectedChange` is not called, and `selected` marks it `aria-current` in place of `aria-pressed`.
  href?: string | undefined
  // Opens the link in a new tab (`true`), the same one (`false`), or a new one when the address leaves the site (`'auto'`, the default).
  newTab?: NewTab | undefined
}

// What the entry says. `text` is the name it had before 1.99, deprecated: `label` wins when both are given.
export type TimelineEntry<Key extends string | number = string> = TimelineEntryBase<Key> & ({ label: string, /** @deprecated Use `label`, which wins when both are given. Removed in 1.103. */ text?: string | undefined } | { label?: undefined, /** @deprecated Use `label`, which wins when both are given. Removed in 1.103. */ text: string })

// The words of an entry, `label` or the older `text`.
export function entryLabel(entry: TimelineEntry<string | number>): string {
  return entry.label ?? entry.text
}
