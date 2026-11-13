import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { LIVE_LOCATION } from './client';
import { reserveMicroUsd, usageFromMetadata, type AiUsage } from './pricing';

// Speech for the S7-5 evaluation datasets: the Live model reads a fixed synthetic script aloud, so
// the voice-note and Live suites hear natural speech (3.8 Live's proactive audio ignored the
// robotic espeak speech in the spike). Owner-run through web/scripts/make-eval-audio.ts, never app
// code and never in CI. It lives inside the AI boundary because it needs the Gen AI SDK, which the
// import guard keeps here. It skips call.ts's caller, quota and budget steps: it sends only the
// committed synthetic scripts, and the script caps its own spend.
//
// Live audio out is 16-bit PCM at 24 kHz, and output transcription returns the words spoken
// (documents/docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api and
// .../live-api/start-manage-session), which the script checks against the text before keeping it.

export const SPEECH_MODEL = 'gemini-3.8-live';
export const SPEECH_INSTRUCTION =
  'You are recording test audio. Read the text the user sends aloud exactly as written, in a calm, ' +
  'natural voice, like a restoration technician dictating a note on a job site. Do not add, drop or ' +
  'change any word, and say nothing else.';
const TURN_MS = 90_000;
// Output tokens one clip may use: about 160 seconds of speech at 25 audio tokens a second, well
// past the longest script. The session is capped at it, and each attempt reserves it before it starts.
export const SPEECH_OUTPUT_TOKEN_CAP = 4_000;

export type Spoken = { pcm24k: Uint8Array; transcript: string };
// One attempt: the clip, or null when the session failed or timed out (the caller reports a code
// only), and the usage Live reported, or null when it reported none.
export type Attempt = { spoken: Spoken | null; usage: AiUsage | null };
export type Speaker = { speak(text: string, voice: string): Promise<Attempt> };

// The most one attempt can cost: its input bytes / 3 and the output cap, at the dearest rates.
export function attemptBoundMicroUsd(text: string, at: Date): number {
  const inputBytes = Buffer.byteLength(SPEECH_INSTRUCTION) + Buffer.byteLength(text);
  return reserveMicroUsd(SPEECH_MODEL, { inputBytes, outputTokenCap: SPEECH_OUTPUT_TOKEN_CAP }, at);
}

// Live reports its output as responseTokenCount and responseTokensDetails, not the REST
// candidates fields.
type LiveUsage = NonNullable<LiveServerMessage['usageMetadata']>;
export function liveUsage(meta: LiveUsage): AiUsage {
  return usageFromMetadata({
    promptTokenCount: meta.promptTokenCount,
    toolUsePromptTokenCount: meta.toolUsePromptTokenCount,
    thoughtsTokenCount: meta.thoughtsTokenCount,
    candidatesTokenCount: meta.responseTokenCount,
    promptTokensDetails: meta.promptTokensDetails,
    candidatesTokensDetails: meta.responseTokensDetails,
  });
}

// One Live session per script: send the text, collect the reply audio and its transcription until
// the turn completes.
export function createSpeaker(project: string): Speaker {
  const ai = new GoogleGenAI({ vertexai: true, project, location: LIVE_LOCATION, apiVersion: 'v1' });
  return {
    async speak(text, voice) {
      const audio: Buffer[] = [];
      let transcript = '';
      let usage: AiUsage | null = null;
      let session: Session | undefined;
      let finish: (done: boolean) => void = () => {};
      const done = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => finish(false), TURN_MS);
      try {
        session = await ai.live.connect({
          model: SPEECH_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            maxOutputTokens: SPEECH_OUTPUT_TOKEN_CAP,
            systemInstruction: SPEECH_INSTRUCTION,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            outputAudioTranscription: {},
          },
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              const content = message.serverContent;
              for (const part of content?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) audio.push(Buffer.from(part.inlineData.data, 'base64'));
              }
              if (content?.outputTranscription?.text) transcript += content.outputTranscription.text;
              if (message.usageMetadata) usage = liveUsage(message.usageMetadata);
              if (content?.turnComplete) finish(true);
            },
            onerror: () => finish(false),
            onclose: () => finish(false),
          },
        });
        session.sendRealtimeInput({ text });
        const ok = await done;
        return { spoken: ok && audio.length > 0 ? { pcm24k: new Uint8Array(Buffer.concat(audio)), transcript } : null, usage };
      } catch {
        return { spoken: null, usage };
      } finally {
        clearTimeout(timer);
        try {
          session?.close();
        } catch {
          // already closed
        }
      }
    },
  };
}
