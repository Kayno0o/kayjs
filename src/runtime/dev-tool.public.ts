// `kay/dev-tool`: the types a library's dev tool module is written against, with the tool's own lifecycle (`stop`, `setOpener`) left out of what a library can call.
import type { DevIconName, DevTab, DevTabOptions, DevTool as Tool } from './dev-tool'

export type { DevIconName, DevTab, DevTabOptions }
export type DevTool = Pick<Tool, 'make' | 'tab' | 'button' | 'outline' | 'hideOutline' | 'open'>
