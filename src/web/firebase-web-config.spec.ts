import { runInNewContext } from 'node:vm';
import { buildFirebaseConfigScript } from './firebase-web-config';

const VALID = {
  apiKey: 'AIzaSyA-123_abc',
  authDomain: 'taqwa-add57.firebaseapp.com',
  projectId: 'taqwa-add57',
  storageBucket: 'taqwa-add57.firebasestorage.app',
  messagingSenderId: '151666982072',
  appId: '1:151666982072:web:abc123',
  vapidKey: 'BOp-q_rS1t2u3v4w5x6y7z8',
};

function evaluate(script: string): unknown {
  const sandbox: Record<string, unknown> = {};
  sandbox.self = sandbox;
  runInNewContext(script, sandbox);
  return sandbox.TAQWA_FIREBASE_CONFIG;
}

describe('buildFirebaseConfigScript', () => {
  it('writes a frozen config object for a valid variable', () => {
    const result = buildFirebaseConfigScript(JSON.stringify(VALID));
    expect(result.problem).toBeNull();
    const config = evaluate(result.script) as Record<string, string>;
    expect(config).toEqual(VALID);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('drops unknown keys', () => {
    const result = buildFirebaseConfigScript(
      JSON.stringify({ ...VALID, extra: 'x' }),
    );
    expect(evaluate(result.script)).toEqual(VALID);
  });

  it.each([
    ['unset', undefined],
    ['empty', '   '],
    ['not JSON', '{apiKey:'],
    ['an array', '[]'],
    ['missing vapidKey', JSON.stringify({ ...VALID, vapidKey: undefined })],
  ])('disables push when %s', (_label, raw) => {
    const result = buildFirebaseConfigScript(raw);
    expect(result.problem).not.toBeNull();
    expect(evaluate(result.script)).toBeNull();
  });

  it.each([
    '"};alert(1);//',
    '</script><script>alert(1)</script>',
    'a b',
    'x y',
    "x'y",
    'x'.repeat(300),
  ])('never writes an unsafe value into JavaScript: %s', (bad) => {
    const result = buildFirebaseConfigScript(
      JSON.stringify({ ...VALID, apiKey: bad }),
    );
    expect(result.problem).toMatch(/apiKey/);
    expect(result.script).toBe('self.TAQWA_FIREBASE_CONFIG = null;\n');
  });
});
