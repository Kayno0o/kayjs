import type { IconProps } from 'kay/icons'
import alert from '~icons/tabler/alert-triangle'
import back from '~icons/tabler/arrow-left'
import chevron from '~icons/tabler/chevron-down'
import success from '~icons/tabler/circle-check'
import info from '~icons/tabler/info-circle'
import spinner from '~icons/tabler/loader-2'
import menu from '~icons/tabler/menu-2'
import pause from '~icons/tabler/player-pause'
import play from '~icons/tabler/player-play'
import plus from '~icons/tabler/plus'
import search from '~icons/tabler/search'
import star from '~icons/tabler/star-filled'
import remove from '~icons/tabler/trash'
import globe from '~icons/tabler/world'
import close from '~icons/tabler/x'
import zoomIn from '~icons/tabler/zoom-in'
import zoomOut from '~icons/tabler/zoom-out'
import zoomFit from '~icons/tabler/zoom-reset'

// The icons the library's own components ask for, by what they mean rather than by a name in some set.
// A link of a site's navigation: `icon` is drawn before its label.
export interface NavLink {
  href: string
  label: string
  icon?: IconSlot | IconProps | undefined
}

export type IconSlot = 'alert' | 'back' | 'chevron' | 'close' | 'delete' | 'globe' | 'info' | 'menu' | 'pause' | 'play' | 'plus' | 'search' | 'spinner' | 'star' | 'success' | 'zoomFit' | 'zoomIn' | 'zoomOut'

// The slots added since apps first wrote icon maps of their own: optional, so such a map still type-checks, each drawing its default when left out.
export type AddedSlot = 'pause'

// What an app may replace through `settings` in its kay.config.ts, spreading these defaults to change a few.
export interface Settings {
  // An icon of any set kay imports, `~icons/<prefix>/<name>`, standing in for each slot.
  icons: Record<Exclude<IconSlot, AddedSlot>, IconProps> & Partial<Record<AddedSlot, IconProps>>
}

const defaults: Settings = {
  icons: { alert, back, chevron, close, delete: remove, globe, info, menu, pause, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut },
}

export default defaults
