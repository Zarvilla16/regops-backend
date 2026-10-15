import * as Sentry from "@sentry/node";

const SENSITIVE = /authorization|cookie|password|token|secret|bvn|nin|api[-_]?key|signature/i;

function scrub<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (SENSITIVE.test(key)) delete event.request.headers[key];
      }
    }
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  return event;
}

/** Error reporting is off unless SENTRY_DSN is set. Same scrubbing rules as the API. */
export function initSentry(service: string): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    serverName: service,
    tracesSampleRate: 0,
    beforeSend: (event) => scrub(event),
  });
  return true;
}

/** Report a background job that failed. Only the job name and ids are attached, never the job payload. */
export function captureJobFailure(err: unknown, job?: { name?: string; queueName?: string; id?: string }): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (job?.queueName) scope.setTag("queue", job.queueName);
    if (job?.name) scope.setTag("job", job.name);
    if (job?.id) scope.setTag("job_id", job.id);
    Sentry.captureException(err);
  });
}
