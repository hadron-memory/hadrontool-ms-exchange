import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests always run against the dedicated test DB, regardless of .env —
    // same posture as hadron-server's vitest config.
    env: {
      DATABASE_URL: 'postgresql://holger@localhost:5432/hadrontool_ms_exchange_test',
      NODE_ENV: 'test',
      TOKEN_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      WEBHOOK_CLIENT_STATE_SECRET: 'test-client-state-secret',
      MS_EXCHANGE_TOOL_TOKEN: 'test-tool-token',
      WEBHOOK_BASE_URL: 'https://tool.example',
      MICROSOFT_CLIENT_ID: 'test-client-id',
      MICROSOFT_CLIENT_SECRET: 'test-client-secret',
    },
    // DB-backed route tests share tables; run files sequentially.
    fileParallelism: false,
  },
});
