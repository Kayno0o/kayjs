// A workflow run keeps each finished step as a row of its own beside the run's job, in a queue named for the job that no worker takes, so a step's write stays as small as the step: the stores that keep them (`sqliteJobs`, `memoryJobs`, `pgJobs`) delete them with the job.
export const stepsQueue = (jobId: string): string => `kay:steps:${jobId}`
