import { randomBytes } from 'node:crypto';

export const MASK = '••••••';

const SECRET_ENV_NAME = /(?:_KEY|_TOKEN|_SECRET)$|PASSWORD/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{6,}/g,
];
const BEARER = /\b(Bearer\s+)[-A-Za-z0-9._~+/]+=*/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/@"'?#]*@/gi;
const URL_QUERY_SECRET =
  /([?&])([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|auth)[A-Za-z0-9_.-]*)=([^&#\s"']+)(?=[&#\s]|#|$)/gi;
const NAME_VALUE =
  /(["']?)([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|auth)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s};]+))/gi;

export function createRedactor(env: NodeJS.ProcessEnv = process.env): (s: string) => string {
  const values = Object.entries(env)
    .filter(([name, v]) => SECRET_ENV_NAME.test(name) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  const envRe = values.length ? new RegExp(values.map(escapeRe).join('|'), 'g') : null;
  return (input: string): string => {
    let s = envRe ? input.replace(envRe, MASK) : input;
    for (const re of SHAPES) s = s.replace(re, MASK);
    s = s.replace(BEARER, `$1${MASK}`);
    s = s.replace(URL_PASSWORD, `$1${MASK}$3`);
    let nonce: string;
    do {
      nonce = randomBytes(8).toString('hex');
    } while (input.includes(`\u0000PO${nonce}:`));
    const placeholderPrefix = `\u0000PO${nonce}:`;
    const spans: string[] = [];
    s = s.replace(
      URL_QUERY_SECRET,
      (_match, separator: string, name: string) =>
        `${placeholderPrefix}${spans.push(`${separator}${name}=${MASK}`) - 1}\u0000`,
    );
    s = s.replace(
      URL_USERINFO,
      (userinfo) => `${placeholderPrefix}${spans.push(userinfo) - 1}\u0000`,
    );
    s = s.replace(
      NAME_VALUE,
      (
        match,
        q1: string,
        name: string,
        sep: string,
        doubleValue: string | undefined,
        singleValue: string | undefined,
        unquotedValue: string | undefined,
      ) => {
        const value = doubleValue ?? singleValue ?? unquotedValue;
        if (
          name.toLowerCase() === 'authorization' &&
          (value?.toLowerCase() === 'bearer' || value?.toLowerCase().startsWith('bearer '))
        )
          return match;
        const quote = doubleValue !== undefined ? '"' : singleValue !== undefined ? "'" : '';
        return `${q1}${name}${q1}${sep}${quote}${MASK}${quote}`;
      },
    );
    const placeholderRe = new RegExp(`${escapeRe(placeholderPrefix)}(\\d+)\\u0000`, 'g');
    return s.replace(placeholderRe, (placeholder, i: string) => spans[Number(i)] ?? placeholder);
  };
}
