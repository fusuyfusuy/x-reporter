import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

describe('AppModule (e2e-lite)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    // Force test env so the logger is silent.
    // PORT must satisfy schema (>0); the actual listen port is decided
    // by app.listen(0) below, which asks the OS for a free port.
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';

    app = await NestFactory.create(AppModule.forRoot(), { logger: false });
    await app.listen(0);
    const url = await app.getUrl();
    // Nest sometimes returns [::1] on IPv6; rewrite for fetch portability
    baseUrl = url.replace('[::1]', '127.0.0.1').replace('://localhost', '://127.0.0.1');
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /health responds 200 with { status: "ok" }', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown-route-does-not-exist`);
    expect(res.status).toBe(404);
  });
});
