import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { Tone } from './tone'

export interface TimelineEntry<Key extends string | number = string> {
  // Tells entries apart and is what `selected` and `onSelect` carry.
  key: Key
  // The time or range as the app words it, such as `08:30` or `08:30 - 09:10`.
  time: string
  text: string
  icon?: IconSlot | IconProps | undefined
  // `neutral` greys the entry, such as a gap nothing reported; the others colour the icon.
  tone?: Tone | undefined
  // False keeps the entry plain text when the timeline is selectable; true by default.
  pickable?: boolean | undefined
  // Makes the entry a link, to the page it stands for. It is no button then: `onSelect` is not called, and `selected` marks it `aria-current` in place of `aria-pressed`.
  href?: string | undefined
}
