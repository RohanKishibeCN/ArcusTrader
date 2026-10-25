import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Signing and reconciliation tests assert on exact serialisation and on
    // fail-closed behaviour; running suites in one process keeps the fake-clock
    // and singleton reset helpers deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    reporters: ['default'],
  },
});
