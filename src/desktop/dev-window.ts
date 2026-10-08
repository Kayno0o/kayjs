import type { WindowSettings } from './library'
import process from 'node:process'
import { showWindow } from './window'

// Started by `kay dev --desktop` in a process of its own, as the window's loop blocks it, with what to open as JSON; it exits once the window is closed.
const { library, url, settings } = JSON.parse(process.argv[2]!) as { library: string, url: string, settings: WindowSettings }

showWindow(library, url, settings, true)
