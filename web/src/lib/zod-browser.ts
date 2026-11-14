import { z } from 'zod';

// Zod 4 tests once whether the page may compile code at run time by calling Function(""), and
// speeds up object parsing if it may. Under the app's content policy (src/lib/security-headers.ts,
// no 'unsafe-eval') that test is refused, which works but is reported as a violation on every
// page. Saying so up front skips the test and keeps the policy free of that noise; parsing is the
// same, only without the compiled fast path. Imported first by the root layout's client mount, so
// it runs before any schema is used in the browser.
z.config({ jitless: true });
