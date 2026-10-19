// What the endless stream saw, read by the test once the client went away.
// `pages` counts the requests the `/kept/slow` and `/kept/await` pages received and the slow ones answered, and `slowGate` holds the slow page's response until the test lets it go.
export const seen = {
  started: 0,
  stopped: 0,
  slowStopped: 0,
  quietStopped: 0,
  pages: { slow: 0, await: 0, slowServed: 0 },
  slowGate: Promise.withResolvers<void>(),
}
