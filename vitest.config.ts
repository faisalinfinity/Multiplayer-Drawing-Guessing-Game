import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'], testTimeout: 20000, hookTimeout: 30000 } });
