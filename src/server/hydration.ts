import { ISLAND } from '../runtime/markers'

// Clicks, inputs and changes on an island before its chunk has hydrated it are queued on `_$K`, and replayed once it has.
// An island that never hydrates holds at most 50 of them, and an input or change right after one on the same field replaces it, as its handlers read the field's value.
export const HYDRATION_SCRIPT = `(()=>{const q=window._$K=[],c=new WeakMap;for(const t of["click","input","change"])document.addEventListener(t,e=>{const s=e.target.closest?.("${ISLAND}");if(!s||s._$k)return;const l=q[q.length-1];if(t!="click"&&l&&l.type==t&&l.target==e.target)q[q.length-1]=e;else if((c.get(s)|0)<50)c.set(s,-~c.get(s)),q.push(e)},true)})()`

export const hydrationScript = `<script>${HYDRATION_SCRIPT}</script>`
