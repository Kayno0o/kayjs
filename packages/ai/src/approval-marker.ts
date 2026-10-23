// The line a visitor's message ends with when they allowed a held tool call: the ticket the server issued for that call. It reaches the browser, so it imports nothing from the server.
const APPROVED = /^\[kai-approved ([\w.-]+)\]$/gm

export function approvalMessage(text: string, ticket: string): string {
  return `${text}\n[kai-approved ${ticket}]`
}

export function ticketsIn(text: string): string[] {
  return [...text.matchAll(APPROVED)].map(match => match[1]!)
}

export function withoutApproval(text: string): string {
  return text.replaceAll(APPROVED, '').trimEnd()
}
