import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isApiPath, loadWebAppConfig, parseOriginList } from './web-config';

describe('parseOriginList', () => {
  it('keeps exact https origins and loopback http, de-duplicated', () => {
    const { origins, rejected } = parseOriginList(
      ' https://a.example , http://localhost:5000,https://a.example,http://127.0.0.1:8080 ',
    );
    expect(origins).toEqual([
      'https://a.example',
      'http://localhost:5000',
      'http://127.0.0.1:8080',
    ]);
    expect(rejected).toEqual([]);
  });

  it.each([
    '*',
    'https://*.example.com',
    'https://a.example/',
    'https://a.example/path',
    'https://user:pw@a.example',
    'http://evil.example',
    'javascript:alert(1)',
    'null',
    'a.example',
  ])('rejects %s', (entry) => {
    const { origins, rejected } = parseOriginList(entry);
    expect(origins).toEqual([]);
    expect(rejected).toEqual([entry]);
  });

  it('treats unset as empty', () => {
    expect(parseOriginList(undefined)).toEqual({ origins: [], rejected: [] });
  });
});

describe('loadWebAppConfig', () => {
  const withIndex = () => {
    const dir = mkdtempSync(join(tmpdir(), 'taqwa-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    return dir;
  };

  it('is enabled when the build exists', () => {
    const dir = withIndex();
    const config = loadWebAppConfig({ WEB_DIST_DIR: dir }, '/nowhere');
    expect(config.enabled).toBe(true);
    expect(config.distDir).toBe(dir);
    expect(config.cspMode).toBe('enforce');
  });

  it('is disabled by WEB_APP=off even with a build', () => {
    expect(
      loadWebAppConfig({ WEB_DIST_DIR: withIndex(), WEB_APP: 'OFF' }).enabled,
    ).toBe(false);
  });

  it('is disabled without index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taqwa-web-'));
    expect(loadWebAppConfig({ WEB_DIST_DIR: dir }).enabled).toBe(false);
  });

  it('defaults to ./web-dist and enforces CSP unless report-only is asked for', () => {
    const config = loadWebAppConfig(
      { WEB_CSP_MODE: 'report-only' },
      '/srv/app',
    );
    expect(config.distDir).toBe(join('/srv/app', 'web-dist'));
    expect(config.cspMode).toBe('report-only');
    expect(loadWebAppConfig({ WEB_CSP_MODE: 'anything' }).cspMode).toBe(
      'enforce',
    );
  });
});

describe('isApiPath', () => {
  it.each([
    ['/api', true],
    ['/api/v1/auth/me', true],
    ['/apiary', false],
    ['/', false],
    ['/index.html', false],
  ])('%s → %s', (path, expected) => {
    expect(isApiPath(path)).toBe(expected);
  });
});
