import { z } from 'zod';

// Extension pages and isolated content worlds must never generate code at runtime.
// Configure this before constructing any schemas, including Zod's CSP capability probe.
z.config({ jitless: true });

export { z };
