import express from 'express';
import request from 'supertest';
import { securityHeaders, webCspDirectives } from './security-headers';

function app(cspMode: 'enforce' | 'report-only' = 'enforce') {
  const a = express();
  a.use(securityHeaders({ cspMode }));
  a.get('/api/v1/thing', (_req, res) => res.json({ ok: true }));
  a.get('/', (_req, res) => res.send('<!doctype html>'));
  return a;
}

describe('securityHeaders', () => {
  it('gives the API the strictest policy and forbids caching', async () => {
    const res = await request(app()).get('/api/v1/thing').expect(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('gives the web page its CSP and the shared hardening headers', async () => {
    const res = await request(app()).get('/').expect(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['cache-control']).toBeUndefined();
  });

  it('never allows script eval or inline script', () => {
    const scriptSrc = webCspDirectives()['script-src'];
    // Only this origin's own files — the Firebase SDK is vendored.
    expect(scriptSrc).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc.some((s) => s.includes('*'))).toBe(false);
    for (const sources of Object.values(webCspDirectives())) {
      expect(sources).not.toContain('*');
      expect(sources).not.toContain('https:');
    }
  });

  it('switches to Report-Only only when asked', async () => {
    const res = await request(app('report-only')).get('/').expect(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-security-policy-report-only']).toContain(
      "default-src 'none'",
    );
    const api = await request(app('report-only'))
      .get('/api/v1/thing')
      .expect(200);
    expect(api.headers['content-security-policy']).toBeDefined();
  });
});
