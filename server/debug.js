/**
 * @fileoverview Tiny debug gate for the server.
 *
 * Routes verbose/diagnostic logging through a single switch so per-connection /
 * per-message / protocol-trace lines stay out of production logs. Enabled by
 * setting the `DEBUG` env var (any non-empty value).
 *
 * Use this for chatty diagnostics ([IdentityDebug], [PROTO DEBUG], per-connect
 * lines, etc.). Keep genuine error reporting on `console.error` so real
 * failures always surface in production.
 */

const enabled = !!process.env.DEBUG;

export const debug = (...args) => { if (enabled) console.log(...args); };
debug.warn = (...args) => { if (enabled) console.warn(...args); };
debug.trace = (...args) => { if (enabled) console.trace(...args); };
debug.enabled = enabled;

export default debug;
