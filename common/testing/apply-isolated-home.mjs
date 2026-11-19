import { inject } from 'vitest';

const env = inject('isolatedTestEnvironment');
if (env === undefined) {
  throw new Error('Isolated test environment was not initialized');
}
for (const [key, value] of Object.entries(env)) {
  if (value === null) delete process.env[key];
  else process.env[key] = value;
}
