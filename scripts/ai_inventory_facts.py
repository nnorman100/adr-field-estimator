#!/usr/bin/env python3
"""Renders the prompt texts that docs/ai-inventory.md pins, with the standard library only.

Prints JSON for tests/test_ai_inventory.js, which hashes every prompt text itself and compares the
result with the Pinned prompts table. `--table` prints that table as Markdown rows to paste into
docs/ai-inventory.md after an intended prompt change. Nothing here calls a model, reads a secret or
imports the backend's cloud packages, so it runs in the plain Node CI job.
"""

import ast
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'backend'


def parse(relative):
    return ast.parse((ROOT / relative).read_text(encoding='utf8'), filename=relative)


def module_assignments(tree):
    return {
        node.targets[0].id: node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
    }


def string_constant(tree, name):
    return ast.literal_eval(module_assignments(tree)[name])


def prompt_texts():
    sys.path.insert(0, str(BACKEND))
    import prompts  # noqa: PLC0415  stdlib-only module; its pydantic-free helpers render the texts

    def audit_frame(year):
        text = prompts.audit_prompt({'year_built': year}, [], [], None)
        return text[: text.index('\nInspection evidence (JSON):\n')]

    instructions = prompts.AUDIT_INSTRUCTIONS
    pre, post = audit_frame(1977), audit_frame(1978)
    assert pre.startswith(instructions) and post.startswith(instructions)

    scope = parse('backend/scope.py')
    template = next(
        node.value
        for function in scope.body
        if isinstance(function, ast.FunctionDef) and function.name == 'scope_prompt'
        for node in ast.walk(function)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) > 1000
    )
    return {
        'live.instructions': (
            'backend/prompts.py LIVE_INSTRUCTIONS with shot_list_instructions()',
            prompts.LIVE_INSTRUCTIONS.replace('{shot_list}', prompts.shot_list_instructions()),
        ),
        'live.readiness_instructions': (
            'backend/prompts.py READINESS_INSTRUCTIONS',
            prompts.READINESS_INSTRUCTIONS,
        ),
        'live.readiness_update': ('backend/prompts.py READINESS_UPDATE', prompts.READINESS_UPDATE),
        'live.shot_status_update': (
            'backend/prompts.py SHOT_STATUS_UPDATE',
            prompts.SHOT_STATUS_UPDATE,
        ),
        'live.greeting_trigger': ('backend/prompts.py GREETING_TRIGGER', prompts.GREETING_TRIGGER),
        'shared.company_identity': (
            'backend/prompts.py company_instructions() suffix',
            prompts.company_instructions('', {'name': '<name>', 'signoff': '<signoff>'}),
        ),
        'audit.instructions': ('backend/prompts.py AUDIT_INSTRUCTIONS', instructions),
        'audit.age_rule_pre_1978': (
            'backend/prompts.py audit_prompt() year < 1978 line',
            pre[len(instructions) :],
        ),
        'audit.age_rule_1978_plus': (
            'backend/prompts.py audit_prompt() year >= 1978 line',
            post[len(instructions) :],
        ),
        'ocr.instructions': ('backend/prompts.py OCR_INSTRUCTIONS', prompts.OCR_INSTRUCTIONS),
        'transcribe.instructions': (
            'backend/prompts.py TRANSCRIBE_INSTRUCTIONS',
            prompts.TRANSCRIBE_INSTRUCTIONS,
        ),
        'scope.instructions': ('backend/scope.py scope_prompt() text', template),
        'scope.claim_details': (
            'backend/scope.py CLAIM_PROMPT',
            string_constant(scope, 'CLAIM_PROMPT'),
        ),
        'job_summary.instructions': (
            'backend/prompts.py JOB_SUMMARY_INSTRUCTIONS',
            prompts.JOB_SUMMARY_INSTRUCTIONS,
        ),
        'drying_summary.instructions': (
            'backend/prompts.py DRYING_SUMMARY_INSTRUCTIONS',
            prompts.DRYING_SUMMARY_INSTRUCTIONS,
        ),
    }


def facts():
    prompts = prompt_texts()
    return {
        'prompts': {
            key: {'source': source, 'text': text} for key, (source, text) in prompts.items()
        },
    }


def table(data):
    lines = ['| Prompt id | Source | sha256 of the UTF-8 text |', '| --- | --- | --- |']
    for key, item in data['prompts'].items():
        digest = hashlib.sha256(item['text'].encode('utf8')).hexdigest()
        lines.append(f'| `{key}` | {item["source"]} | `{digest}` |')
    return '\n'.join(lines)


if __name__ == '__main__':
    result = facts()
    print(table(result) if '--table' in sys.argv[1:] else json.dumps(result))
