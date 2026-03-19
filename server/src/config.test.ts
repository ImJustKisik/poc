import { describe, expect, it, vi } from 'vitest';

describe('server config', () => {
  it('fails in production without explicit cors origin', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'super-secret';
    delete process.env.CORS_ORIGIN;

    await expect(import('./config.js')).rejects.toThrow('CORS_ORIGIN');
  });
});
