export function transcriptButtonEnabled(canOpenTranscript: boolean, reason?: string): boolean {
  return canOpenTranscript && !reason;
}
