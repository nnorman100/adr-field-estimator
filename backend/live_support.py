"""Versioned Live configuration and durable private resumption state."""

import hashlib
import json
import sys
from array import array
from statistics import median
from google.genai import types

RESUME_SECONDS = 600
# 16 kHz PCM16 RMS (about -36 dBFS): browser noise suppression keeps open-mic silence near
# -50 dBFS, while conversational speech after automatic gain sits near -20 dBFS.
SPEECH_RMS = 500
# Every Nth numbered microphone packet is acknowledged (once a second at 100 ms packets), so the
# client sees how far its audio is behind and can pause video on a weak uplink.
AUDIO_ACK_EVERY = 10
MIC_BYTES_PER_SECOND = 32000
MODEL_BYTES_PER_SECOND = 48000


class LiveCounters:
    """Content-free measurements of one Live session for its session-ended log event."""

    def __init__(self):
        self.mic_bytes = 0
        self.frames = 0
        self.mic_gap = 0.0
        self.last_mic = None
        self.last_speech = None
        self.turns = 0
        self.interruptions = 0
        self.model_bytes = 0
        self.latencies = []
        self.paces = []
        self.reply_start = None
        self.reply_last = None
        self.reply_bytes = 0
        self.answered = False
        self.client = {}

    def audio(self, size, speech, now):
        self.mic_bytes += size
        if self.last_mic is not None:
            self.mic_gap = max(self.mic_gap, now - self.last_mic)
        self.last_mic = now
        if speech:
            self.last_speech = now
            self.answered = False

    def pause(self):
        # A muted microphone is a deliberate silence, not a gap in delivery.
        self.last_mic = None

    def model_audio(self, size, now):
        if self.reply_start is None:
            self.reply_start = now
            self.answered = True
            # Only a reply that follows new speech measures response time.
            if self.last_speech is not None:
                self.latencies.append(now - self.last_speech)
                self.last_speech = None
        self.reply_last = now
        self.reply_bytes += size
        self.model_bytes += size

    def end_reply(self, interrupted=False):
        """Closes the model's reply and returns whether it began after all speech so far."""
        # Live also closes an interrupted reply with turn_complete, which is not another turn.
        if self.reply_start is None:
            return False
        answered = self.answered and not interrupted
        if interrupted:
            self.interruptions += 1
        else:
            self.turns += 1
        seconds = self.reply_bytes / MODEL_BYTES_PER_SECOND
        if self.reply_start is not None and seconds >= 1:
            # Reply audio seconds per second of delivery; above 1 the model streams ahead of playback.
            self.paces.append(seconds / max(self.reply_last - self.reply_start, 0.05))
        self.reply_start = self.reply_last = None
        self.reply_bytes = 0
        self.answered = False
        return answered

    def client_end(self, packet):
        for key in ('gap_count', 'video_pauses'):
            value = packet.get(key)
            if type(value) is int and 0 <= value <= 1_000_000:
                self.client[key] = value

    def fields(self):
        return dict(
            mic_seconds=round(self.mic_bytes / MIC_BYTES_PER_SECOND, 1),
            mic_gap_max_ms=round(self.mic_gap * 1000),
            video_frames=self.frames,
            turns=self.turns,
            interruptions=self.interruptions,
            model_audio_seconds=round(self.model_bytes / MODEL_BYTES_PER_SECOND, 1),
            reply_latency_ms_median=round(median(self.latencies) * 1000)
            if self.latencies
            else None,
            reply_latency_ms_max=round(max(self.latencies) * 1000) if self.latencies else None,
            reply_pace_median=round(median(self.paces), 2) if self.paces else None,
            client_gap_count=self.client.get('gap_count'),
            client_video_pauses=self.client.get('video_pauses'),
        )


def is_speech(pcm):
    samples = array('h', pcm)
    if sys.byteorder == 'big':
        samples.byteswap()
    return bool(samples) and sum(s * s for s in samples) > SPEECH_RMS * SPEECH_RMS * len(samples)


# Room answers that only change the photo shot list (backend/shot_list.py ROOM_FIELDS); Live
# receives them in shot status updates, so setting one during a walkthrough does not restart it.
SHOT_FIELDS = (
    'source_of_loss',
    'contents_present',
    'equipment_placed',
    'affected_surfaces',
    'wet_materials',
)


def scope_fingerprint(data):
    fields = {
        k: v
        for k, v in data.items()
        if k
        not in (
            'technician_transcript',
            'assistant_transcript',
            'capture_metadata',
            'scope_confirmed',
        )
    }
    if 'rooms' in fields:
        fields['rooms'] = [
            {k: v for k, v in room.items() if k not in SHOT_FIELDS} for room in fields['rooms']
        ]
    return hashlib.sha256(
        json.dumps(fields, sort_keys=True, separators=(',', ':')).encode()
    ).hexdigest()


def live_config(instruction, voice, handle=None):
    return types.LiveConnectConfig(
        response_modalities=['AUDIO'],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=64000, sliding_window=types.SlidingWindow(target_tokens=32000)
        ),
        session_resumption=types.SessionResumptionConfig(handle=handle),
        system_instruction=instruction,
    )
