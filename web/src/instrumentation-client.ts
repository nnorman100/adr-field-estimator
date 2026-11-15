import { z } from 'zod';

// Next runs this before app hydration. Zod's optional JIT probes with Function(), which itself
// generates a CSP report even if a later enforced policy makes the probe throw. Its interpreter
// performs the same validation without eval. Configure before app schemas are constructed.
z.config({ jitless: true });
