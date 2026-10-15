// Apart from `./lifecycle` so `kay start` names the process it runs the server for without loading the server.
// Names the `kay start` or `kay render` running the server, which a SIGKILL of that process alone, or of `kay start`'s group, leaves running: the server stops once that process is gone.
export const START_PARENT = 'KAY_START_PID'
// Which of the two it is, for the line the server logs as it stops.
export const START_COMMAND = 'KAY_START_COMMAND'
