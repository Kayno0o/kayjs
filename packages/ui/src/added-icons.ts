import type { IconProps } from 'kay/icons'
import type { AddedSlot } from './defaults'
import collapse from '~icons/tabler/arrows-minimize'
import expand from '~icons/tabler/arrows-maximize'
import send from '~icons/tabler/arrow-up'
import calendar from '~icons/tabler/calendar'
import chat from '~icons/tabler/message-circle'
import pause from '~icons/tabler/player-pause'
import stop from '~icons/tabler/player-stop-filled'

// The default of each slot added since apps first wrote icon maps of their own, drawn when a map leaves it out.
export const addedIcons: Record<AddedSlot, IconProps> = { calendar, pause, chat, send, stop, expand, collapse }
