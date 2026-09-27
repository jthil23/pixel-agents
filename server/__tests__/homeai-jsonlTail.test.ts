import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlTail } from '../src/homeai/jsonlTail.js';

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-tail-')), 's.jsonl');

describe('JsonlTail', () => {
  it('returns only complete lines and holds a partial line until its newline arrives', () => {
    const f = tempFile();
    fs.writeFileSync(f, '{"a":1}\n{"b":');
    const t = new JsonlTail(f);
    expect(t.read()).toEqual(['{"a":1}']);
    fs.appendFileSync(f, '2}\r\n');
    expect(t.read()).toEqual(['{"b":2}']);
    expect(t.read()).toEqual([]);
  });

  it('keeps a multi-byte character intact when split across appends', () => {
    const f = tempFile();
    const euro = Buffer.from('€', 'utf8');
    fs.writeFileSync(f, Buffer.concat([Buffer.from('{"c":"'), euro.subarray(0, 1)]));
    const t = new JsonlTail(f);
    expect(t.read()).toEqual([]);
    fs.appendFileSync(f, Buffer.concat([euro.subarray(1), Buffer.from('"}\n')]));
    expect(t.read()).toEqual(['{"c":"€"}']);
  });

  it('restarts after truncation and returns null when the file is deleted', () => {
    const f = tempFile();
    fs.writeFileSync(f, '{"a":1}\n{"a":2}\n');
    const t = new JsonlTail(f);
    t.read();
    fs.writeFileSync(f, '{"z":9}\n');
    expect(t.read()).toEqual(['{"z":9}']);
    fs.rmSync(f);
    expect(t.read()).toBeNull();
  });
});
