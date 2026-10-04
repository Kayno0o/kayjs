// Clicks and inputs on an island before its chunk has hydrated it are queued on `_$K`, and replayed once it has.
export const HYDRATION_SCRIPT = '(()=>{const q=window._$K=[];for(const t of["click","input"])document.addEventListener(t,e=>{const s=e.target.closest?.("slot[data-component]");s&&!s._$k&&q.push(e)},true)})()'

export const hydrationScript = `<script>${HYDRATION_SCRIPT}</script>`
