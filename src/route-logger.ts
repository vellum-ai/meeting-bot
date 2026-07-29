/**
 * Console-backed logger for code reached from an HTTP route.
 *
 * The daemon hands a real logger to the `init` hook, but a route handler is
 * given no context, so anything a route drives (realtime dispatch, a live
 * provider switch) logs through here instead. A route already runs inside the
 * daemon process, so plain console output lands in the same place the daemon's
 * own logs do; the shape matches {@link Logger} so the same call sites work
 * either way.
 */

import type { Logger } from "./realtime-server.ts";

export const routeLogger: Logger = {
  info: (obj, msg) => console.log(msg ?? "", obj),
  warn: (obj, msg) => console.warn(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
  debug: () => {},
};
