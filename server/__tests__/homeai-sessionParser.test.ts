import { describe, expect, it } from 'vitest';

import { createSessionParser } from '../src/homeai/sessionParser.js';

const T = '2026-09-27T14:00:00.000Z';
const line = (o: unknown) => JSON.stringify(o);
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: 'message', timestamp: T, message: { role: 'assistant', content, ...extra } });
const toolCall = (id: string, name: string, args: Record<string, unknown>, intent?: string) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
  ...(intent ? { intent } : {}),
});
const execStart = (id: string, name: string, args: Record<string, unknown>, intent: string) =>
  line({
    type: 'custom',
    customType: 'tool_execution_start',
    timestamp: T,
    data: { toolCallId: id, toolName: name, args, intent },
  });

describe('sessionParser', () => {
  it('emits header and title from the session header', () => {
    const p = createSessionParser();
    expect(
      p.parseLine(
        line({ type: 'session', id: 's1', cwd: 'G:\\Home-AI', title: 'Plan', timestamp: T }),
      ),
    ).toEqual([
      { kind: 'header', sessionId: 's1', cwd: 'G:\\Home-AI', at: T },
      { kind: 'title', title: 'Plan', at: T },
    ]);
  });

  it('emits toolStart with intent from an assistant toolCall and dedupes tool_execution_start', () => {
    const p = createSessionParser();
    expect(p.parseLine(assistant([toolCall('t1', 'read', { path: 'a.ts' }, 'Reading a')]))).toEqual(
      [
        {
          kind: 'toolStart',
          toolId: 't1',
          toolName: 'read',
          input: { path: 'a.ts' },
          intent: 'Reading a',
          at: T,
        },
      ],
    );
    expect(p.parseLine(execStart('t1', 'read', {}, 'Reading a'))).toEqual([]);
  });

  it('accepts tool_execution_start first and dedupes the later assistant toolCall', () => {
    const p = createSessionParser();
    expect(p.parseLine(execStart('t2', 'bash', { command: 'ls' }, 'Listing'))).toEqual([
      {
        kind: 'toolStart',
        toolId: 't2',
        toolName: 'bash',
        input: { command: 'ls' },
        intent: 'Listing',
        at: T,
      },
    ]);
    expect(p.parseLine(assistant([toolCall('t2', 'bash', { command: 'ls' })]))).toEqual([]);
  });

  it('maps toolResult to toolEnd with isError and the remembered tool name', () => {
    const p = createSessionParser();
    p.parseLine(assistant([toolCall('t3', 'edit', {})]));
    expect(
      p.parseLine(
        line({
          type: 'message',
          timestamp: T,
          message: { role: 'toolResult', toolCallId: 't3', isError: true },
        }),
      ),
    ).toEqual([{ kind: 'toolEnd', toolId: 't3', toolName: 'edit', isError: true, at: T }]);
  });

  it('emits usage (context = input + cacheRead + cacheWrite) and turnEnd only for final stop reasons', () => {
    const p = createSessionParser();
    const usage = {
      input: 4,
      output: 386,
      cacheRead: 100,
      cacheWrite: 20255,
      totalTokens: 20745,
      cost: { total: 0.17 },
    };
    expect(
      p.parseLine(assistant([], { model: 'claude-opus-5-5', usage, stopReason: 'stop' })),
    ).toEqual([
      {
        kind: 'usage',
        model: 'claude-opus-5-5',
        costUsd: 0.17,
        totalTokens: 20745,
        contextTokens: 20359,
        at: T,
      },
      { kind: 'turnEnd', stopReason: 'stop', at: T },
    ]);
    expect(p.parseLine(assistant([], { stopReason: 'toolUse' }))).toEqual([]);
    expect(p.parseLine(assistant([], { stopReason: 'aborted' }))).toEqual([
      { kind: 'turnEnd', stopReason: 'aborted', at: T },
    ]);
  });

  it('parses session_init, session_exit, title_change, and ignores malformed lines', () => {
    const p = createSessionParser();
    expect(
      p.parseLine(
        line({
          type: 'session_init',
          timestamp: T,
          agent: 'scout',
          modelRole: 'smol',
          resolvedModel: 'luna',
        }),
      ),
    ).toEqual([{ kind: 'init', agent: 'scout', modelRole: 'smol', resolvedModel: 'luna', at: T }]);
    expect(
      p.parseLine(line({ type: 'custom', customType: 'session_exit', timestamp: T, data: {} })),
    ).toEqual([{ kind: 'sessionExit', at: T }]);
    expect(p.parseLine(line({ type: 'title_change', title: 'New', timestamp: T }))).toEqual([
      { kind: 'title', title: 'New', at: T },
    ]);
    expect(p.parseLine('{not json')).toEqual([]);
  });
});
