import { describe, expect, it } from 'bun:test';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('GET /health returns { status: "ok" }', () => {
    const controller = new HealthController();
    const result = controller.check();
    expect(result).toEqual({ status: 'ok' });
  });
});
