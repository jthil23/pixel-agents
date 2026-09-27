import { useSyncExternalStore } from 'react';

import { setSoundEnabled } from '../notificationSound.js';
import { transport } from '../transport/index.js';
import {
  applyHomeAiMessage,
  createHomeAiState,
  type HomeAiState,
  pruneEffects,
} from './homeAiState.js';
import { playSound } from './sound.js';

const state = createHomeAiState();
let version = 0;
const listeners = new Set<() => void>();
let pendingWindow: Window | null = null;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export const homeAiState = (): HomeAiState => state;

/** Returns true when the message was a home-ai message (upstream handling can stop). */
export function handleHomeAiMessage(msg: Record<string, unknown>): boolean {
  const res = applyHomeAiMessage(state, msg, Date.now());
  if (res.firstActivation) setSoundEnabled(false);
  if (res.sound && state.active) playSound(res.sound);
  if (msg.type === 'transcriptLink' && pendingWindow) {
    if (res.openUrl) pendingWindow.location.href = res.openUrl;
    else pendingWindow.close();
    pendingWindow = null;
  }
  if (res.handled || msg.type === 'agentClosed') notify();
  return res.handled;
}

export function tickHomeAi(now: number = Date.now()): void {
  if (pruneEffects(state, now)) notify();
}

export function openAgentPanel(agentId: number): void {
  if (!state.active) return;
  state.panel = { kind: 'agent', agentId };
  transport.send({ type: 'requestAgentDetail', agentId });
  notify();
}

export function openCabinetPanel(groupName: string): void {
  state.panel = { kind: 'cabinet', groupName };
  notify();
}

export function closePanel(): void {
  state.panel = null;
  notify();
}

/** Opens a blank tab synchronously (user gesture) and navigates it when the link arrives. */
export function requestTranscript(agentId: number): void {
  pendingWindow = window.open('about:blank', '_blank');
  if (pendingWindow) pendingWindow.opener = null;
  transport.send({ type: 'requestTranscriptLink', agentId });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHomeAi(): HomeAiState {
  useSyncExternalStore(subscribe, () => version);
  return state;
}
