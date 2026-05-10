// Next.js calls register() once per server cold-start, BEFORE the first
// request is served. We use that hook to load the right Sentry config
// per runtime — Node for API routes, Edge for middleware. Without this
// file, server-side errors race the SDK init and the first crash of a
// cold function never reaches Sentry.

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forwards request-handler errors (server actions, route handlers) into
// Sentry. Required by the @sentry/nextjs SDK to capture them reliably
// in the App Router.
export const onRequestError = Sentry.captureRequestError;
