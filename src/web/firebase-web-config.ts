/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /firebase-config.js — the Firebase *web* app settings, generated from the
 * FIREBASE_WEB_CONFIG environment variable.
 *
 * Both the page (web/index.html) and the push service worker
 * (web/firebase-messaging-sw.js) load this one file, so the settings live in
 * one place and changing them needs no new web build.
 *
 * These values are public by design (every Firebase web page ships them);
 * they are not secrets. What protects the project is restricting the
 * browser API key to this site's address in Google Cloud Console.
 *
 * FIREBASE_WEB_CONFIG is the JSON object from Firebase Console → Project
 * settings → Your apps → Web app, plus "vapidKey" (Cloud Messaging → Web
 * Push certificates → Key pair). Example:
 *   {"apiKey":"AIza…","authDomain":"taqwa-add57.firebaseapp.com",
 *    "projectId":"taqwa-add57","storageBucket":"taqwa-add57.firebasestorage.app",
 *    "messagingSenderId":"151666982072","appId":"1:151666982072:web:…",
 *    "vapidKey":"B…"}
 *
 * Every value must match a strict character set before it is written into
 * JavaScript, so the variable can never inject code into the page.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const REQUIRED_KEYS = [
  'apiKey',
  'projectId',
  'messagingSenderId',
  'appId',
  'vapidKey',
] as const;
const OPTIONAL_KEYS = ['authDomain', 'storageBucket'] as const;
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,256}$/;

export type FirebaseWebConfig = Record<
  (typeof REQUIRED_KEYS)[number] | (typeof OPTIONAL_KEYS)[number],
  string | undefined
>;

export interface FirebaseWebConfigResult {
  /** The script body to serve; always valid JavaScript. */
  readonly script: string;
  /** Null when push is configured, otherwise why it is not. */
  readonly problem: string | null;
}

const DISABLED_SCRIPT = 'self.TAQWA_FIREBASE_CONFIG = null;\n';

export function buildFirebaseConfigScript(
  raw: string | undefined,
): FirebaseWebConfigResult {
  if (!raw || !raw.trim()) {
    return {
      script: DISABLED_SCRIPT,
      problem: 'FIREBASE_WEB_CONFIG is not set',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      script: DISABLED_SCRIPT,
      problem: 'FIREBASE_WEB_CONFIG is not valid JSON',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      script: DISABLED_SCRIPT,
      problem: 'FIREBASE_WEB_CONFIG must be a JSON object',
    };
  }

  const source = parsed as Record<string, unknown>;
  const config: Record<string, string> = {};

  for (const key of REQUIRED_KEYS) {
    const value = source[key];
    if (typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      return {
        script: DISABLED_SCRIPT,
        problem: `FIREBASE_WEB_CONFIG.${key} is missing or has unexpected characters`,
      };
    }
    config[key] = value;
  }
  for (const key of OPTIONAL_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      return {
        script: DISABLED_SCRIPT,
        problem: `FIREBASE_WEB_CONFIG.${key} has unexpected characters`,
      };
    }
    config[key] = value;
  }

  // Values are restricted to [A-Za-z0-9._:-], so JSON.stringify output can
  // contain no quote-breaking, "</script>" or line-terminator sequences.
  return {
    script: `self.TAQWA_FIREBASE_CONFIG = Object.freeze(${JSON.stringify(config)});\n`,
    problem: null,
  };
}
