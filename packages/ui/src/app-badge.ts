// Shows `count` on the installed app's icon, or clears the badge at 0. A browser or a tab with no Badging API, and a refusal, change nothing.
export async function setAppBadge(count: number): Promise<void> {
  if (typeof navigator === 'undefined')
    return

  const badging = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>, clearAppBadge?: () => Promise<void> }

  try {
    if (count > 0)
      await badging.setAppBadge?.(count)
    else
      await badging.clearAppBadge?.()
  }
  catch {
    // The badge is a courtesy: a browser refusing it is not the page's failure.
  }
}
