// The page swaps kept for the Network tab, as many as it lists navigations.
const SWAP_LOG = 10

export interface SwapLog { path: string, log: { busy: boolean, at: number, path: string }[] }

// A page swap marks the document busy until the new page is in: each change of that mark is logged with the page then shown, from the tool's start.
export function watchSwaps(doc: Document, win: Window, signal: AbortSignal): SwapLog {
  const here = () => `${win.location.pathname}${win.location.search}`
  const swapLog: SwapLog = { path: here(), log: [] }
  const swapWatch = new MutationObserver(() => {
    swapLog.log.push({ busy: doc.documentElement.getAttribute('aria-busy') === 'true', at: win.performance.now(), path: here() })

    if (swapLog.log.length > SWAP_LOG)
      swapLog.log.shift()
  })

  swapWatch.observe(doc.documentElement, { attributes: true, attributeFilter: ['aria-busy'] })
  signal.addEventListener('abort', () => swapWatch.disconnect())

  return swapLog
}
