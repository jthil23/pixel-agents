// server/__tests__/homeai-clientHooks.test.ts
import { describe, expect, it } from 'vitest';

import { createHomeAiClientHooks } from '../src/homeai/clientHooks.js';
import { transcriptLinkFor } from '../src/homeai/transcriptLinks.js';

const hostsJson = JSON.stringify({
  version: 1,
  hosts: [{ instanceId: 'inst-1', sessionId: 'sid-1', busy: true }],
});

describe('transcriptLinkFor', () => {
  it('matches the host by sessionId and requests a view link', async () => {
    const calls: string[][] = [];
    const result = await transcriptLinkFor('sid-1', async (_file, args) => {
      calls.push(args);
      return args[1] === 'list'
        ? hostsJson
        : JSON.stringify({ version: 1, url: 'https://my.omp.sh/#view' });
    });
    expect(result).toEqual({ url: 'https://my.omp.sh/#view' });
    expect(calls).toEqual([
      ['collab', 'list', '--json'],
      ['collab', 'link', 'inst-1', '--view', '--json'],
    ]);
  });

  it('explains when the session is not hosted or omp fails', async () => {
    expect(await transcriptLinkFor('other', async () => hostsJson)).toEqual({
      reason: 'not hosted: enable collab.autoStart',
    });
    expect(
      await transcriptLinkFor('sid-1', async () => {
        throw new Error('boom');
      }),
    ).toEqual({ reason: 'omp collab list failed' });
  });
});

describe('client hooks', () => {
  const bridge = {
    detail: (id: number) =>
      id === 7
        ? {
            agentId: 7,
            title: 't',
            source: 'omp' as const,
            role: 'session',
            model: 'm',
            costUsd: 1,
            contextTokens: 2,
            recentTools: [],
            canOpenTranscript: true,
          }
        : null,
    rootSessionId: (id: number) => (id === 7 ? 'sid-1' : null),
    snapshotMessages: () => [{ type: 'agentStatus', id: 7, status: 'waiting' }],
  };

  it('sends the bridge snapshot, then the latest ambient messages, on client ready', () => {
    const sent: Record<string, unknown>[] = [];
    const hooks = createHomeAiClientHooks({
      bridge,
      latest: () => [{ type: 'ambientSun', phase: 'day', elevation: 20 }],
      link: async () => ({}),
    });
    hooks.onClientReady((m) => sent.push(m));
    expect(sent.map((m) => m.type)).toEqual(['agentStatus', 'ambientSun']);
  });

  it('answers detail and transcript requests and ignores other messages', async () => {
    const sent: Record<string, unknown>[] = [];
    const hooks = createHomeAiClientHooks({
      bridge,
      latest: () => [],
      link: async (sid) => ({ url: `u:${sid}` }),
    });
    const send = (m: Record<string, unknown>) => sent.push(m);
    expect(hooks.handle({ type: 'requestAgentDetail', agentId: 7 }, send)).toBe(true);
    expect(hooks.handle({ type: 'requestTranscriptLink', agentId: 7 }, send)).toBe(true);
    expect(hooks.handle({ type: 'requestTranscriptLink', agentId: 99 }, send)).toBe(true);
    expect(hooks.handle({ type: 'saveLayout' }, send)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      expect.objectContaining({ type: 'agentDetail', agentId: 7, title: 't' }),
      { type: 'transcriptLink', agentId: 99, reason: 'not an omp session' },
      { type: 'transcriptLink', agentId: 7, url: 'u:sid-1' },
    ]);
  });
});
