import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

vi.mock('../src/transport/index.js', () => ({ transport: { send: vi.fn() } }));

import {
  handleHomeAiMessage,
  openAgentPanel,
  requestTranscript,
} from '../src/homeai/homeAiStore.js';
import { isMuted, playSound, setMuted } from '../src/homeai/sound.js';
import { playDoneSound, setSoundEnabled } from '../src/notificationSound.js';
import { transport } from '../src/transport/index.js';

const opened: { location: { href: string }; closed: boolean; opener: Window | null }[] = [];
const windowStub = {
  open: () => {
    const tab = {
      location: { href: 'about:blank' },
      closed: false,
      opener: null as Window | null,
      close() {
        this.closed = true;
      },
    };
    opened.push(tab);
    return tab as unknown as Window;
  },
};

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  oscillators = 0;
  createOscillator() {
    this.oscillators++;
    return {
      type: '',
      frequency: { value: 0 },
      connect() {
        return this;
      },
      start() {},
      stop() {},
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {
        return this;
      },
    };
  }
  resume() {
    return Promise.resolve();
  }
}

const originalAudioContext = globalThis.AudioContext;
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  globalThis.AudioContext = originalAudioContext;
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  opened.length = 0;
  setMuted(false);
  setSoundEnabled(true);
});

test('home-ai activation keeps upstream done sounds suppressed after sound settings re-enable notifications', async () => {
  const audio = new FakeAudioContext();
  globalThis.AudioContext = class {
    constructor() {
      return audio;
    }
  } as unknown as typeof AudioContext;
  globalThis.window = windowStub as unknown as typeof globalThis.window;

  handleHomeAiMessage({ type: 'ambientSun', phase: 'day', elevation: 10 });
  setSoundEnabled(true);
  await playDoneSound();

  assert.equal(audio.oscillators, 0);
});

test('transcript responses only navigate or close the matching agent tab', () => {
  globalThis.window = windowStub as unknown as typeof globalThis.window;
  requestTranscript(7);
  requestTranscript(8);

  handleHomeAiMessage({ type: 'transcriptLink', agentId: 7, url: 'https://example.test/7' });
  assert.equal(opened[0].location.href, 'https://example.test/7');
  assert.equal(opened[0].closed, false);
  assert.equal(opened[1].location.href, 'about:blank');
  assert.equal(opened[1].closed, false);

  handleHomeAiMessage({ type: 'transcriptLink', agentId: 8, reason: 'not hosted' });
  assert.equal(opened[1].closed, true);
});

test('transcript and agent detail requests reach the transport', () => {
  globalThis.window = windowStub as unknown as typeof globalThis.window;
  const send = vi.mocked(transport.send);
  send.mockClear();
  handleHomeAiMessage({ type: 'ambientSun', phase: 'day', elevation: 10 });

  requestTranscript(7);
  requestTranscript(8);
  assert.deepEqual(
    send.mock.calls.map(([message]) => message),
    [
      { type: 'requestTranscriptLink', agentId: 7 },
      { type: 'requestTranscriptLink', agentId: 8 },
    ],
  );

  send.mockClear();
  openAgentPanel(9);
  assert.deepEqual(
    send.mock.calls.map(([message]) => message),
    [{ type: 'requestAgentDetail', agentId: 9 }],
  );
});

test('mute remains effective when localStorage access throws', () => {
  let oscillators = 0;
  globalThis.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {},
    clear() {},
    key() {
      return null;
    },
    length: 0,
  };
  const audio = new FakeAudioContext();
  audio.createOscillator = () => {
    oscillators++;
    return {
      type: '',
      frequency: { value: 0 },
      connect() {
        return this;
      },
      start() {},
      stop() {},
    };
  };
  globalThis.AudioContext = class {
    constructor() {
      return audio;
    }
  } as unknown as typeof AudioContext;

  setMuted(true);
  assert.equal(isMuted(), true);
  playSound('ding');
  assert.equal(oscillators, 0);
});
