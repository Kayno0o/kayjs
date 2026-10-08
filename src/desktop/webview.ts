import type { Pointer } from 'bun:ffi'
import { CString, dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'

// The few calls of the webview library (github.com/webview/webview) kay makes, on the build webview-bun ships for each platform.
const SYMBOLS = {
  webview_create: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  webview_run: { args: [FFIType.ptr], returns: FFIType.void },
  webview_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  webview_set_title: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  webview_set_size: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.void },
  webview_navigate: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  webview_init: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  webview_bind: { args: [FFIType.ptr, FFIType.ptr, FFIType.function, FFIType.ptr], returns: FFIType.void },
  webview_return: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.void },
} as const

// WEBVIEW_HINT_NONE: the size is where the window starts, the user resizing it freely.
const HINT_NONE = 0
// What the library needs from the machine, which the executable cannot carry.
const MISSING = 'on Linux it needs WebKitGTK 6 (webkitgtk-6.0 on Arch, libwebkitgtk-6.0-4 on Debian and Ubuntu), on Windows 10 the WebView2 runtime'

export interface Webview {
  setTitle: (title: string) => void
  navigate: (url: string) => void
  // Runs before each page's own scripts.
  init: (script: string) => void
  // A global function of each page calling `callback` with its arguments, which resolves to what it returns; the window's loop holds the thread, so `callback` answers at once, never through a promise.
  bind: (name: string, callback: (...args: never[]) => unknown) => void
  // Runs the window's loop, blocking the thread until it is closed.
  run: () => void
}

export function createWebview(library: string, size: { width: number, height: number }, devtools = false): Webview {
  const { symbols } = openLibrary(library)
  const handle = symbols.webview_create(devtools ? 1 : 0, null)

  if (handle === null)
    throw new Error('kay: the webview could not open a window: no display to open it on, or on Windows 10 no WebView2 runtime')

  // The library calls back into them for as long as the window lives.
  const callbacks: JSCallback[] = []

  symbols.webview_set_size(handle, size.width, size.height, HINT_NONE)

  return {
    setTitle: title => symbols.webview_set_title(handle, text(title)),
    navigate: url => symbols.webview_navigate(handle, text(url)),
    init: script => symbols.webview_init(handle, text(script)),
    bind(name, callback) {
      const called = new JSCallback((seq: Pointer, request: Pointer) => {
        const args = JSON.parse(new CString(request).toString()) as never[]
        let status = 0
        let result: unknown

        try {
          result = callback(...args)
        }
        catch (error) {
          status = 1
          result = error instanceof Error ? error.message : String(error)
        }

        symbols.webview_return(handle, seq, status, text(JSON.stringify(result ?? null)))
      }, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void })

      callbacks.push(called)
      symbols.webview_bind(handle, text(name), called, null)
    },
    run() {
      symbols.webview_run(handle)
      symbols.webview_destroy(handle)

      for (const callback of callbacks)
        callback.close()
    },
  }
}

function openLibrary(library: string) {
  try {
    return dlopen(library, SYMBOLS)
  }
  catch (error) {
    throw new Error(`kay: the webview library did not load, ${MISSING}`, { cause: error })
  }
}

// The library copies every string it is given before the call returns.
function text(value: string): Pointer {
  return ptr(Buffer.from(`${value}\0`))
}
