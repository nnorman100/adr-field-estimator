#!/usr/bin/env python3
"""Validate fixture summaries without a provider by default. --live is a separate release gate."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.drying_summary import DryingSummary, validate_summary
from backend.prompts import DRYING_SUMMARY_INSTRUCTIONS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--live',
        action='store_true',
        help='Explicitly call Vertex in the dedicated project (release operator only)',
    )
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.live and args.dry_run:
        parser.error('Choose either --live or --dry-run.')
    packs = json.loads((ROOT / 'tests/fixtures/drying-watch/summaries.json').read_text())
    if args.live:
        # No implicit target, credentials or deployed backend calls in the default evaluation.
        if os.getenv('GOOGLE_CLOUD_PROJECT') != 'alert-disaster-field-2026':
            parser.error('--live requires GOOGLE_CLOUD_PROJECT=alert-disaster-field-2026')
        from backend.main import generate, AUDIT_MODEL

        async def run():
            for pack in packs[:5]:
                result = await generate(
                    DryingSummary,
                    DRYING_SUMMARY_INSTRUCTIONS + '\n' + json.dumps(pack['facts']),
                    AUDIT_MODEL,
                    'drying_watch',
                    'synthetic-eval',
                    thinking_level='LOW',
                    timeout=25,
                )
                validate_summary(result, pack['facts'])

        asyncio.run(run())
        print('live: 5/5 summaries passed unchanged')
    else:
        for pack in packs:
            validate_summary(DryingSummary(text=pack['valid']), pack['facts'])
        print('dry-run: 10/10 fixture summaries passed; no model calls')


if __name__ == '__main__':
    main()
