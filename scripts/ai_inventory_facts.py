#!/usr/bin/env python3
"""Reads the AI call-path facts that docs/ai-inventory.md pins, from source, with the standard library only.

Prints JSON for tests/test_ai_inventory.js, which hashes every prompt text itself and compares the
result with the inventory tables. `--table` prints the same two tables as Markdown rows to paste into
docs/ai-inventory.md after an intended prompt, model or limit change. Nothing here calls a model, reads
a secret or imports the backend's cloud packages, so it runs in the plain Node CI job.
"""

import ast
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'backend'

# Actions that guard a paid model call; other quota names guard drafts, links and administration.
AI_QUOTAS = (
    'ocr',
    'scope',
    'transcribe',
    'audit_attempt',
    'audit',
    'job_summary',
    'drying_summary',
    'live',
)

SETTINGS = {
    'backend/main.py': (
        'LOCATION',
        'AUDIT_MODEL',
        'OCR_MODEL',
        'SCOPE_THINKING_LEVEL',
        'AUDIT_THINKING_LEVEL',
        'REST_DEADLINE_SECONDS',
        'AUDIT_ATTEMPT_SECONDS',
        'AUDIT_RETRY_MIN_SECONDS',
        'AUDIT_SAVE_RESERVE_SECONDS',
        'LIVE_MODEL',
        'LIVE_LOCATION',
        'LIVE_VOICE',
        'LIVE_RECHECK_SECONDS',
        'LIVE_REPLY_WAIT_SECONDS',
        'AUDIT_PHOTO_DOWNLOADS',
        'VOICE_NOTE_BYTES',
    ),
    'backend/inspection_store.py': ('DAILY_LIMITS', 'TRANSCRIPT_LIMIT'),
    'backend/job_store.py': ('MODEL_PIXELS',),
    'backend/ai_features.py': (),
    'scripts/deploy_backend.py': ('KNOWN_AI_FEATURES', 'DEFAULT_AI_FEATURES'),
}


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


def is_call_to(node, name):
    function = node.func
    return (isinstance(function, ast.Name) and function.id == name) or (
        isinstance(function, ast.Attribute) and function.attr == name
    )


def generate_calls():
    """One row per `generate(...)` call: the model expression, thinking level and timeout it passes."""
    rows = {}
    for relative in ('backend/main.py', 'backend/workspace_api.py'):
        for node in ast.walk(parse(relative)):
            if not (isinstance(node, ast.Call) and is_call_to(node, 'generate')):
                continue
            if len(node.args) < 4 or not isinstance(node.args[3], ast.Constant):
                continue
            keywords = {k.arg: ast.unparse(k.value) for k in node.keywords}
            rows[f'call.{node.args[3].value}'] = (
                f'{relative}: model={ast.unparse(node.args[2])}'
                f'; thinking={keywords.get("thinking_level", "provider default")}'
                f'; timeout={keywords.get("timeout", "default 100")}'
            )
    return rows


def quota_calls():
    rows = {}
    for relative in ('backend/main.py', 'backend/workspace_api.py'):
        for node in ast.walk(parse(relative)):
            if not (
                isinstance(node, ast.Call)
                and node.args
                and isinstance(node.args[0], ast.Attribute)
                and node.args[0].attr == 'quota'
                and len(node.args) >= 3
                and isinstance(node.args[2], ast.Constant)
                and node.args[2].value in AI_QUOTAS
            ):
                continue
            per_minute = ast.unparse(node.args[3]) if len(node.args) > 3 else 'none'
            rows[f'quota.{node.args[2].value}'] = f'per-minute limit {per_minute}'
    return rows


def live_config():
    function = next(
        node
        for node in parse('backend/live_support.py').body
        if isinstance(node, ast.FunctionDef) and node.name == 'live_config'
    )
    rows = {}
    for node in ast.walk(function):
        if isinstance(node, ast.keyword) and isinstance(node.value, (ast.Constant, ast.List)):
            rows[f'live_config.{node.arg}'] = ast.unparse(node.value)
    fields = next(
        node for node in ast.walk(function) if isinstance(node, ast.Call) and node.keywords
    )
    rows['live_config.fields'] = ', '.join(k.arg for k in fields.keywords)
    return rows


def settings():
    rows = {}
    for relative, names in SETTINGS.items():
        assigned = module_assignments(parse(relative))
        for name in names:
            value = ast.unparse(assigned[name])
            if name == 'DAILY_LIMITS':
                # Only the paid model calls; address, pricing and draft limits are not AI behaviour.
                limits = ast.literal_eval(assigned[name])
                value = repr({key: limits[key] for key in AI_QUOTAS if key in limits})
            rows[f'{Path(relative).name}:{name}'] = value
    rows['ai_features.default'] = (
        "os.getenv('AI_FEATURES', '') split on commas; empty enables nothing"
    )
    rows.update(generate_calls())
    rows.update(quota_calls())
    rows.update(live_config())
    return dict(sorted(rows.items()))


def facts():
    prompts = prompt_texts()
    return {
        'prompts': {
            key: {'source': source, 'text': text} for key, (source, text) in prompts.items()
        },
        'settings': settings(),
    }


def table(data):
    lines = ['| Prompt id | Source | sha256 of the UTF-8 text |', '| --- | --- | --- |']
    for key, item in data['prompts'].items():
        digest = hashlib.sha256(item['text'].encode('utf8')).hexdigest()
        lines.append(f'| `{key}` | {item["source"]} | `{digest}` |')
    lines += ['', '| Setting | Value in code |', '| --- | --- |']
    for key, value in data['settings'].items():
        lines.append(f'| `{key}` | `{value.replace("|", chr(92) + "|")}` |')
    return '\n'.join(lines)


if __name__ == '__main__':
    result = facts()
    print(table(result) if '--table' in sys.argv[1:] else json.dumps(result))
