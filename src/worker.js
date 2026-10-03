// Cloudflare Worker entry point. All logic lives in app.js (which also
// exports its helpers for the tests in /tests); only the fetch handler is
// exported here, because the Workers runtime treats every named export
// of the entry module as an entrypoint.
import app from "./app.js";
export default app;
