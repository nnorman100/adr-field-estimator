"""Versioned Live configuration and durable private resumption state."""
import hashlib
import json
import sys
from array import array
from google.genai import types

RESUME_SECONDS = 600
# 16 kHz PCM16 RMS (about -36 dBFS): browser noise suppression keeps open-mic silence near
# -50 dBFS, while conversational speech after automatic gain sits near -20 dBFS.
SPEECH_RMS = 500

def is_speech(pcm):
    samples = array('h', pcm)
    if sys.byteorder == 'big': samples.byteswap()
    return bool(samples) and sum(s*s for s in samples) > SPEECH_RMS*SPEECH_RMS*len(samples)

def scope_fingerprint(data):
    fields = {k:v for k,v in data.items() if k not in ('technician_transcript','assistant_transcript','capture_metadata','scope_confirmed')}
    return hashlib.sha256(json.dumps(fields,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def live_config(instruction, voice, handle=None):
    return types.LiveConnectConfig(
        response_modalities=['AUDIO'],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=64000,sliding_window=types.SlidingWindow(target_tokens=32000)),
        session_resumption=types.SessionResumptionConfig(handle=handle),
        system_instruction=instruction)
