import type { UiSettings } from '@kaynooo/kayjs-ui'
import { uiDefaults } from '@kaynooo/kayjs-ui'
import plus from '~icons/tabler/circle-plus'
import chat from '~icons/tabler/ghost'
import stop from '~icons/tabler/hand-stop'
import expand from '~icons/tabler/maximize'
import collapse from '~icons/tabler/minimize'
import send from '~icons/tabler/rocket'
import close from '~icons/tabler/square-x'

// Replaces the seven slots the chat draws, for the restyle test to find each one's drawing in the chat.
const settings: UiSettings = { ...uiDefaults, icons: { ...uiDefaults.icons, chat, send, stop, expand, collapse, close, plus } }

export default settings
