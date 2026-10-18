"""The service's only log output: allowlisted structured fields, one JSON line each."""

import json
import logging
import sys

# An allowlist, so prompts, transcripts, images, tokens, emails, links, signatures, user IDs and storage paths cannot reach the log.
LOG_FIELDS = frozenset(
    {
        'model',
        'operation',
        'elapsed_ms',
        'duration_ms',
        'timeout_ms',
        'outcome',
        'provider_status',
        'provider_code',
        'status',
        'total_tokens',
        'inspection_id',
        'method',
        'route',
        # Draft saves: the stored revision and the names of changed data fields, never values.
        'revision',
        'changed_fields',
        # Live session counters: numbers only (backend/live_support.py LiveCounters).
        'mic_seconds',
        'mic_gap_max_ms',
        'video_frames',
        'turns',
        'interruptions',
        'model_audio_seconds',
        'reply_latency_ms_median',
        'reply_latency_ms_max',
        'reply_pace_median',
        'client_gap_count',
        'client_video_pauses',
    }
)


class CloudLoggingJson(logging.Handler):
    """One JSON object per stdout line, which Cloud Logging parses into severity, message and fields."""

    def emit(self, record):
        entry = {
            'severity': record.levelname,
            'message': record.getMessage(),
            **getattr(record, 'fields', {}),
        }
        print(json.dumps(entry, default=str), file=sys.stdout, flush=True)


log = logging.getLogger('adr')
log.setLevel(logging.INFO)
log.propagate = False
if not log.handlers:
    log.addHandler(CloudLoggingJson())


def event(message, severity=logging.INFO, **fields):
    log.log(
        severity,
        message,
        extra={'fields': {k: v for k, v in fields.items() if k in LOG_FIELDS and v is not None}},
    )
