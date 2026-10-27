import type { IconProps } from 'kay/icons'
import type { AddedSlot } from './defaults'
import send from '~icons/tabler/arrow-up'
import expand from '~icons/tabler/arrows-maximize'
import collapse from '~icons/tabler/arrows-minimize'
import bell from '~icons/tabler/bell'
import calendar from '~icons/tabler/calendar'
import apps from '~icons/tabler/grid-dots'
import chat from '~icons/tabler/message-circle'
import edit from '~icons/tabler/pencil'
import pause from '~icons/tabler/player-pause'
import stop from '~icons/tabler/player-stop-filled'
import refresh from '~icons/tabler/refresh'

// The default of each slot added since apps first wrote icon maps of their own, drawn when a map leaves it out.
export const addedIcons: Record<AddedSlot, IconProps> = { apps, bell, calendar, pause, chat, send, stop, expand, collapse, edit, refresh }
