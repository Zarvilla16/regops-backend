import * as Sentry from "@sentry/node";

const SENSITIVE = /authorization|cookie|password|token|secret|bvn|nin|api[-_]?key|signature/i;

/** Removes anything that could carry credentials or customer data before an event leaves the process. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
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

/**
 * Error reporting is off unless SENTRY_DSN is set. Only unexpected failures are sent (see captureUnexpected); request
 * bodies, cookies and headers that look sensitive are dropped, and users are reduced to their id.
 */
export function initSentry(service: string): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    serverName: service,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
}

/** Report a failure the code did not anticipate (a 5xx), with the tenant and user ids as tags only. */
export function captureUnexpected(err: unknown, context?: { userId?: string; tenantId?: string; route?: string }): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context?.userId) scope.setUser({ id: context.userId });
    if (context?.tenantId) scope.setTag("tenant_id", context.tenantId);
    if (context?.route) scope.setTag("route", context.route);
    Sentry.captureException(err);
  });
}
