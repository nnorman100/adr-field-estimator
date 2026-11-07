"""Evaluate GitHub Actions expressions and run workflow step scripts against stub commands."""

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPRESSION = re.compile(r'\$\{\{(.*?)\}\}', re.S)
EXPRESSION_TOKEN = re.compile(r"\s*('(?:[^']|'')*'|\|\||&&|==|!=|[!(),]|[A-Za-z_][\w.-]*)\s*")


def display(value):
    if value is None:
        return ''
    return str(value).lower() if isinstance(value, bool) else str(value)


def number(value):
    if value is None or isinstance(value, bool):
        return int(bool(value))
    try:
        return float(value.strip() or 0)
    except ValueError:
        return float('nan')


def equal(left, right):
    if isinstance(left, str) and isinstance(right, str):
        return left.casefold() == right.casefold()
    return left == right if type(left) is type(right) else number(left) == number(right)


def evaluate(source, context):
    """Evaluate a GitHub Actions expression with the operators and functions this workflow uses."""
    tokens, position, source = [], 0, source.strip()
    while position < len(source):
        match = EXPRESSION_TOKEN.match(source, position)
        assert match, f'unsupported expression syntax: {source[position:]!r}'
        tokens.append(match.group(1))
        position = match.end()

    def take(expected=None):
        token = tokens.pop(0)
        assert expected in (None, token), f'expected {expected!r}, got {token!r}'
        return token

    def either():
        value = both()
        while tokens[:1] == ['||']:
            take()
            right = both()
            value = value if value else right
        return value

    def both():
        value = compare()
        while tokens[:1] == ['&&']:
            take()
            right = compare()
            value = right if value else value
        return value

    def compare():
        value = unary()
        while tokens[:1] in (['=='], ['!=']):
            operator = take()
            value = equal(value, unary()) == (operator == '==')
        return value

    def unary():
        if tokens[:1] == ['!']:
            take()
            return not unary()
        return primary()

    def primary():
        token = take()
        if token == '(':
            value = either()
            take(')')
            return value
        if token.startswith("'"):
            return token[1:-1].replace("''", "'")
        if token in ('true', 'false', 'null'):
            return {'true': True, 'false': False, 'null': None}[token]
        if tokens[:1] == ['(']:
            assert token == 'format', f'unsupported function {token}'
            take('(')
            args = [either()]
            while tokens[:1] == [',']:
                take()
                args.append(either())
            take(')')
            return args[0].format(*(display(arg) for arg in args[1:]))
        value = context
        for part in token.split('.'):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    value = either()
    assert not tokens, f'unparsed expression tokens: {tokens}'
    return value


def interpolate(value, context):
    """A workflow value with each ${{ }} expression replaced by what it evaluates to."""
    if isinstance(value, dict):
        return {key: interpolate(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [interpolate(item, context) for item in value]
    if not isinstance(value, str):
        return value
    return EXPRESSION.sub(lambda match: display(evaluate(match.group(1), context)), value)


def condition(text, context):
    match = EXPRESSION.fullmatch(text.strip())
    return bool(evaluate(match.group(1) if match else text, context))


STUB = """#!{python}
import json, os, sys
with open(os.environ['STEP_LOG'], 'a') as log:
    log.write(json.dumps([os.path.basename(sys.argv[0]), *sys.argv[1:]]) + '\\n')
fails = os.environ.get('STUB_FAILS')
sys.exit(1 if fails and fails in sys.argv else 0)
"""


def run_stubbed(argv, env, commands, passthrough=(), fails=None):
    """Run argv with only stubs and the named real tools on PATH; return the stub calls."""
    with tempfile.TemporaryDirectory() as tmp:
        stubs, log = Path(tmp, 'bin'), Path(tmp, 'commands.jsonl')
        stubs.mkdir()
        for command in commands:
            stub = stubs / command
            stub.write_text(STUB.format(python=sys.executable))
            stub.chmod(0o755)
        for tool in passthrough:
            (stubs / tool).symlink_to(shutil.which(tool))
        result = subprocess.run(
            [shutil.which('bash'), '--noprofile', '--norc', *argv],
            env={**env, 'PATH': str(stubs), 'STEP_LOG': str(log), 'STUB_FAILS': fails or ''},
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def run_step(step, env, commands=('python3', 'gh')):
    """Run a step's script the way the runner's bash does, with only stub commands on PATH."""
    return run_stubbed(['-eo', 'pipefail', '-c', step['run']], env, commands)
