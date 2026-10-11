// A page shipping no kay script, once loaded afresh, keeps the entries an earlier page swap pushed, which Back reaches as entries of this document: going to one of kay's for another page loads that page, as nothing swaps it in. An entry the app pushed itself is left to it.
// A page swap leaves it out of the head it merges, the live document handling its entries itself.
export const historyScript = '<script data-kay-history>{const u=location.pathname+location.search;addEventListener("popstate",e=>{e.state?.kay&&location.pathname+location.search!==u&&location.reload()})}</script>'
