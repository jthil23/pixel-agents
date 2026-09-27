import { describe, expect, it } from 'vitest';

import { createRedactor, MASK } from '../src/homeai/redact.js';

describe('redactor', () => {
  const redact = createRedactor({
    OPENROUTER_API_KEY: 'orkey-1234567890abcdef',
    SHORT_TOKEN: 'abc',
    PATH: '/usr/bin',
  });

  it('masks values of secret-named environment variables of 8+ chars', () => {
    expect(redact('curl -H orkey-1234567890abcdef')).toBe(`curl -H ${MASK}`);
    expect(redact('token abc')).toBe('token abc');
  });

  it('masks credential shapes', () => {
    expect(redact('sk-proj-ABCDEFGH12345678')).toBe(MASK);
    expect(redact('ghp_ABCDEFGHIJKLMNOP1234')).toBe(MASK);
    expect(redact('github_pat_11ABCDEFG_xyz')).toBe(MASK);
    expect(redact('xoxb-123456-abcdef')).toBe(MASK);
    expect(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_abc-123')).toBe(MASK);
    expect(redact('Authorization: Bearer abcdefgh12345')).toBe(`Authorization: Bearer ${MASK}`);
    expect(redact('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----')).toBe(MASK);
  });

  it('masks only the password inside connection URLs', () => {
    expect(redact('mysql://root:hunter22@192.168.1.103:3366/db')).toBe(
      `mysql://root:${MASK}@192.168.1.103:3366/db`,
    );
  });

  it('masks values of secret-looking name/value pairs', () => {
    expect(redact('HA_TOKEN=abcdefgh123')).toBe(`HA_TOKEN=${MASK}`);
    expect(redact('"apiKey": "xyz12345"')).toBe(`"apiKey": "${MASK}"`);
  });

  it('masks complete quoted values and unquoted tokens through commas', () => {
    expect(redact('{"password":"correct horse battery staple"}')).toBe(`{"password":"${MASK}"}`);
    expect(redact('{"apiKey":"abc,def12345"}')).toBe(`{"apiKey":"${MASK}"}`);
    expect(redact('{"password":"a\\"b c"}')).toBe(`{"password":"${MASK}"}`);
    expect(redact('API_TOKEN=abc,def12345')).toBe(`API_TOKEN=${MASK}`);
  });

  it('masks short bearer credentials', () => {
    expect(redact('Authorization: Bearer abc123')).toBe(`Authorization: Bearer ${MASK}`);
  });

  it('preserves URL userinfo structure when masking password', () => {
    expect(redact('mysql://token:hunter22@192.168.1.103:3366/db')).toBe(
      `mysql://token:${MASK}@192.168.1.103:3366/db`,
    );
  });

  it('bounds Bearer credentials at token68 delimiters and redacts embedded tokens', () => {
    expect(redact('{"Authorization":"Bearer abcdefgh12345","note":"visible"}')).toBe(
      `{"Authorization":"Bearer ${MASK}","note":"visible"}`,
    );
    expect(redact('{"password":"correct horse Bearer abc123"}')).toBe(`{"password":"${MASK}"}`);
    expect(redact('Authorization: Bearer abc123')).toBe(`Authorization: Bearer ${MASK}`);
  });

  it('does not reprocess URL userinfo for arbitrary secret-looking usernames', () => {
    expect(redact('mysql://apiKey:hunter22@192.168.1.103:3366/db')).toBe(
      `mysql://apiKey:${MASK}@192.168.1.103:3366/db`,
    );
  });

  it('leaves ordinary text alone', () => {
    const plain = 'Reading magic keywords doc · ssh sol nvidia-smi · Editing keyboard.ts';
    expect(redact(plain)).toBe(plain);
  });
});
