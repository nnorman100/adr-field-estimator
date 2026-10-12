# Gemini Live build review

Reviewed October 7, 2026. Scope: the nine supplied Gemini Developer API guides, current Vertex model guidance, and the local implementation. This review recommends build work; it does not change application code, invoke a model, upload inspection evidence, or deploy anything.

## Build direction

Keep the authenticated Cloud Run/Vertex relay and the existing technician review step. Prioritize continuity for long walkthroughs, correct microphone pause handling, and faithful transcript storage before adding tools or changing models. The current media formats and interruption playback behavior already match the core streaming contract.

The repository configures `gemini-3.8-live` in `us-central1`, using server ADC in the dedicated `alert-disaster-field-2026` project (`backend/main.py:36–45`, `304–307`). The supplied examples mostly target the Gemini Developer API. Their endpoint URLs, API-key authentication, and optional configuration are not a drop-in replacement for this Vertex connection. Google documents both relay and direct-client approaches; ephemeral tokens protect direct Developer API clients, while the Vertex session guide demonstrates ADC. [Developer overview](https://ai.google.dev/gemini-api/docs/live-api), [Vertex sessions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session).

## Coverage of all nine supplied pages

All nine URLs returned usable documentation through `agent-browser read`; no requested page was missing. The ephemeral-token read supplied Markdown referencing older `/live` and `/live-session` paths. These references are documentation navigation, not a reason to change the deployed endpoint.

| Guide | Verified takeaway | Application implication |
| --- | --- | --- |
| [Overview](https://ai.google.dev/gemini-api/docs/live-api) | Live accepts streamed audio, image frames and text over a stateful WebSocket. | The walkthrough architecture fits; preserve its authenticated owner boundary. |
| [Raw WebSockets](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) | Developer API connections exchange setup and typed client/server messages; the guide shows Developer API credentials. | Retain the Python GenAI SDK/Vertex transport. The browser's custom relay packets are an internal protocol, not provider messages. |
| [Capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) | Audio, transcription, selectable voices, VAD and interruption events are configurable. One event may contain multiple outputs. | Continue handling transcription and all audio parts independently; add control-event dispatch. |
| [Thinking](https://ai.google.dev/gemini-api/docs/live-api/thinking) | Baseline 3.8 Live omits thinking configuration; Extended Thinking uses a different model and `interaction_status` lifecycle. | Keep baseline for field coaching. Extended Thinking would require separate compatibility and lifecycle work. |
| [Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) | The page describes the separate `gemini-3.5-transcribe-live` recognition model, including interim/final text and SMART formatting. | Do not switch the conversational coach to this TEXT-only pipeline or copy its options without verifying baseline/Vertex support. |
| [Tools](https://ai.google.dev/gemini-api/docs/live-api/tools) | Live function calls require explicit response handling; automatic tool execution is unavailable. | Tool-driven form proposals are possible, but require a server dispatcher and review integration. |
| [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) | Compression, resumption handles and `GoAway` address separate limits on context and connection lifetime. | These are the largest missing lifecycle features. |
| [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) | Short-lived credentials apply to direct Developer API clients; the guide discourages them for backend connections. | They are unnecessary for the present ADC relay. Direct-client migration would be a separate architecture decision. |
| [Best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices) | Organize instructions as persona, conversational flow and guardrails; use small audio chunks and clear playback on interruption. | Restructure the long prompt for readability while retaining ADR safeguards; measure field latency before tuning chunks. |

## Ranked findings from local code

### 1. High: reconnect currently starts a fresh model conversation

`backend/main.py:305–307` has no context compression or session resumption configuration. Its dispatcher skips messages without `server_content` (`331–343`), so `GoAway` and resumption updates are ignored. `public/app.js:477–502` reconnects the relay but does not restore provider session state. The new connection receives saved inspection JSON in the system prompt, which is useful job context but does not restore the previous acoustic or conversational state.

Both Developer and Vertex guides document nominal limits of 15 minutes for audio-only sessions and 2 minutes for audio/video without compression, and approximately 10 minutes per connection. These are documented limits, not measurements of this app. A 3600-second Cloud Run timeout does not override provider limits. [Developer sessions](https://ai.google.dev/gemini-api/docs/live-api/session-management), [Vertex sessions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session).

Proposed work: enable model-verified sliding-window compression; retain the newest resumable handle server-side, bound to the authenticated owner and inspection; process control events before reading `server_content`; use `GoAway` for orderly reconnection. Reauthenticate and check ownership, unsigned state and lease eligibility on every connection. Clear playback and avoid duplicate transcript segments during handover. If resumption fails, explicitly start a fresh session with durable structured job context. The confirmed form remains authoritative when older model context is compressed.

Do not promise a fixed offline resumption window: the Developer guide states two hours, while the current Vertex page says both 24 hours and approximately 10 minutes. This inconsistency needs provider testing for the configured model, endpoint and SDK. A short handle retention policy and an explicit fallback are safer than assuming either duration. [Developer sessions](https://ai.google.dev/gemini-api/docs/live-api/session-management), [Vertex sessions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session).

### 2. High: mute suppresses input without flushing the provider stream

`public/app.js:536` disables the microphone track, and `518` drops audio sends while muted. The relay accepts only audio, video and end packets (`backend/main.py:319–330`). Google instructs clients to send `audioStreamEnd` when audio input pauses for more than a second, so buffered audio can flush; input can subsequently resume. [Capabilities: automatic VAD](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

Proposed work: add an authenticated relay control packet that sends `audio_stream_end=True` for mute or a deliberate sustained pause. Keep this distinct from ending the walkthrough. Test mute during an utterance, unmute, and final transcript arrival. For Finish, consider a bounded flush/drain before closing so a final spoken measurement is not lost; still guarantee camera, microphone, timers, provider tasks and lease cleanup.

### 3. High: transcript concatenation loses event boundaries and provenance detail

`backend/main.py:337–338` forwards text without finality or event identity. `public/app.js:493–494` inserts a space for every received text chunk and discards the earliest characters beyond 80,000. This can alter split words and erase earlier job statements without an explicit completeness indication. The transcript is also editable (`public/app.js:556`). `backend/scope.py:42–51` checks quotes against the stored technician text; that provides traceability to available text, not proof of accurate speech recognition.

Proposed work: introduce ordered, speaker-tagged transcript segments with provider-supported finality and connection identifiers; distinguish live preview from committed text; preserve the provider's text boundaries; show incomplete/truncated capture explicitly. Test split-word chunks, corrections, repeated delivery after reconnect, interruption and simultaneous transcript/audio events. Keep recognition and technician edits distinguishable if used for evidence. Retain the review step before quantities affect pricing.

The dedicated transcription guide's interim/final fields apply to its recognition model; verify actual baseline Vertex event fields before designing the adapter. Its final transcript is still recognized text, not an independently validated measurement. [Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe).

### 4. Medium: recovery and audio gaps need clearer behavior

`public/app.js:489` resets the retry counter on every ready event, so the three-retry limit caps consecutive failures before readiness rather than all reconnects during a walkthrough. `537` stops capture when offline; returning online syncs drafts but does not resume capture. `518` silently drops microphone chunks when the WebSocket backlog exceeds its threshold.

Proposed work: define bounded reconnection/backoff and a visible recovery state; keep the current deliberate restart behavior after offline until device behavior is tested. Record audio-gap counts and expose an interrupted-transcript indication. Measure first-audio and reconnect performance without logging customer speech, images or tokens. `generation_complete` is available as a generation signal but does not mean locally queued audio has finished playing. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).

### 5. Medium: voice, vocabulary and prompt structure are configurable improvements

No named voice is set in `backend/main.py:305–306`; the current voice identity cannot be established from code. Add a configurable, explicitly selected voice after listening tests on an iPhone/Bluetooth earpiece. Vertex documents `voice_name` for all Live models; examples include Charon (informative), Iapetus (clear) and Kore (firm). These are audition candidates, not a selected production voice. [Vertex language and voice](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice).

Vertex's 3.8 model guide explicitly supports `custom_vocabulary` in `AudioTranscriptionConfig`. A small ADR vocabulary could include Extech, HEPA, LGR and common room/material terms. Benchmark corrections and numbers before enabling it; vocabulary bias is not guaranteed accuracy. [Vertex 3.8 developer guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live).

`backend/prompts.py` already asks one question at a time and protects quantities, pricing, uncertain readings, conditional work, required notices and technician review. Reorganize its long instruction string into persona, one-time property intake, repeating room flow and guardrails. Keep all domain constraints; evaluate whether shorter room-specific context improves coaching before removing details. [Best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices).

### 6. Later: typed Live tools can propose form entries

The existing Flash extraction/review workflow remains a valid path. A future `propose_scope_changes` tool could return reviewable suggestions during Live, using the existing field allowlist, explicit technician-source statements and revision checks. It should not directly change confirmed scope, prices, signatures or authorization.

A server dispatcher would need call-ID matching, schema validation, bounded execution, deduplication, cancellation, owner checks and informative responses (`status`, `retryable`, `message`). Add a prompt-level retry cap if tools are introduced. Handle simultaneous audio/transcript/tool/control messages without mutually exclusive branches. [Tools](https://ai.google.dev/gemini-api/docs/live-api/tools), [Vertex mandatory API rules](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live).

## Provider and version cautions

- Preserve `LIVE_MODEL` and `LIVE_LOCATION`. A guide mentioning another model does not establish availability in the dedicated project.
- The Developer capabilities page still shows explicit affective/proactivity flags. Current Vertex 3.8 guidance says these features are enabled by default and the old flags must be omitted. Follow the current model-specific Vertex contract. [Developer capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [Vertex migration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/migrate-from-gemini-2-5-to-gemini-3-8-live).
- Baseline `gemini-3.8-live` does not accept thinking-level configuration. Extended Thinking requires a different model, asynchronous tool handling and `interaction_status` rather than treating every `turn_complete` as idle. It is unnecessary for the first continuity repair. [Thinking](https://ai.google.dev/gemini-api/docs/live-api/thinking).
- If seeding explicit conversational history after a fresh connection, Vertex 3.8 requires `HistoryConfig(initial_history_in_client_content=True)` and waiting for setup completion. Do not replay the entire editable transcript as authoritative model/user history. [Vertex 3.8 developer guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live).
- `backend/requirements.in` pins the tested `google-genai` version. Re-verify Live behavior before raising that pin to rely on new event/configuration fields.

## Implementation stages and acceptance

1. **Continuity and capture correctness:** model-compatible compression/resumption/control events; microphone stream-end signaling; bounded reconnect states; transcript segments and gaps. Preserve existing authentication, ownership, leases and Finish cleanup.
2. **Field conversation quality:** audition an explicit voice; benchmark vocabulary, noisy-room VAD and Bluetooth echo; reorganize prompts. The current worklet sends 100 ms chunks, within Vertex's 20–100 ms range; benchmark 20–40 ms if latency is unsatisfactory rather than assuming smaller chunks fix all delay. [Vertex audio rules](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live), [Developer best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices).
3. **Optional Live tools:** propose typed changes into the existing review UI only after stages 1 and 2 are stable. Keep server pricing and signability decisions unchanged.

For lifecycle implementation, run the repository's Python, frontend and browser acceptance commands and keep both HTML copies identical. Expand `tests/test_live.py` beyond its existing combined audio/transcript/interruption, ownership and revocation checks to cover control-only messages, resumption rejection, concurrent reconnect, mute/flush and late events after Finish. Add browser coverage for fragmented transcript text and audio gaps.

Record synthetic provider checks separately from mocks. Then physically observe a camera-enabled walkthrough longer than the nominal two-minute context limit, connection rollover, microphone/Bluetooth behavior, interruption, reconnect, deliberate offline restart and Finish cleanup on an iPhone. The existing browser latency label is approximate; it is not evidence of sub-second field performance. No acceptance tests or production checks were run for this documentation-only review.

Before deploying the latest local prompt refactor, verify the backend's actual import mode: `backend/main.py:31` omits `OCR_INSTRUCTIONS` from its fallback `from prompts` import although the OCR endpoint uses that name. The package import includes it (`24`). This is a static deployment-readiness finding, not a runtime reproduction; fix and test the launch mode before rollout.
