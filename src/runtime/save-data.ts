// Whether the visitor asked for less data: `Save-Data` as the browser reports it, or `prefers-reduced-data`, unless the config turned the behavior off.
export function savesDataInBrowser(): boolean {
  return !document.querySelector('meta[name="kay-save-data"]') && ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true || matchMedia('(prefers-reduced-data: reduce)').matches)
}
