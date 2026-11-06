"""Enforce the 1,000-line limit and recorded no-growth ceilings.

JavaScript's general limit is also checked by ESLint. The baseline file records the
maximum line count for every existing exception, including JavaScript, CSS and Markdown.
Lines are counted like ESLint: blank lines and comments count, a final newline does not.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST = ROOT / 'scripts' / 'file_length_allowlist.json'
CODE_SUFFIXES = ('.py', '.js', '.mjs', '.cjs', '.css', '.md')
BASELINES = ROOT / 'scripts' / 'file_length_baselines.json'
EXCLUDED_PREFIXES = ('public/vendor/', 'node_modules/', 'dist/', 'build/', 'coverage/')
LINE_BREAK = re.compile(r'\r\n|[\r\n  ]')


def count_lines(text):
    if not text:
        return 0
    lines = LINE_BREAK.split(text)
    if lines[-1] == '':
        lines.pop()
    return len(lines)


def load_allowlist(path=ALLOWLIST):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    return int(data['limit']), set(data['files'])


def tracked_code_files(root=ROOT):
    try:
        out = subprocess.run(
            [
                'git',
                '-C',
                str(root),
                'ls-files',
                '-z',
                '--cached',
                '--others',
                '--exclude-standard',
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        names = [n for n in out.split('\0') if n]
    except (OSError, subprocess.CalledProcessError):
        names = [p.relative_to(root).as_posix() for p in Path(root).rglob('*') if p.is_file()]
    return sorted(
        n
        for n in names
        if n.endswith(CODE_SUFFIXES)
        and not n.startswith(EXCLUDED_PREFIXES)
        and (Path(root) / n).is_file()
    )


def check(root=ROOT, limit=None, allowlist=None, baselines=None):
    """Return (errors, warnings, stale) as lists of messages."""
    if limit is None or allowlist is None:
        file_limit, file_allowlist = load_allowlist()
        limit = file_limit if limit is None else limit
        allowlist = file_allowlist if allowlist is None else allowlist
    if baselines is None:
        baselines = json.loads(BASELINES.read_text(encoding='utf-8')) if root == ROOT else {}
    errors, warnings, stale = [], [], []
    counts = {}
    for name in tracked_code_files(root):
        text = (Path(root) / name).read_text(encoding='utf-8', errors='replace')
        counts[name] = count_lines(text)
    for name, lines in counts.items():
        if name in baselines and lines > baselines[name]:
            errors.append(
                f'{name} has {lines} lines, exceeding its {baselines[name]}-line baseline.'
            )
            continue
        if lines <= limit or (name.endswith(('.js', '.mjs', '.cjs')) and name not in baselines):
            continue
        if name in allowlist:
            warnings.append(
                f'{name} has {lines} lines (limit {limit}); split it during planned work.'
            )
        else:
            errors.append(
                f'{name} has {lines} lines, over the {limit}-line limit. Split it; new files '
                'cannot be added to scripts/file_length_allowlist.json.'
            )
    if baselines and set(baselines) != set(allowlist):
        errors.append('File length baselines must match the allowlist.')
    for name in sorted(allowlist):
        if name not in counts:
            stale.append(
                f'{name} no longer exists; remove it from scripts/file_length_allowlist.json.'
            )
        elif counts[name] <= limit:
            stale.append(
                f'{name} is down to {counts[name]} lines (limit {limit}); remove it from '
                'scripts/file_length_allowlist.json so the limit is enforced.'
            )
    return errors, warnings, stale


def main():
    errors, warnings, stale = check()
    for message in warnings:
        print(f'::warning title=File length::{message}')
    for message in stale:
        print(f'::notice title=File length allowlist::{message}')
    for message in errors:
        print(f'::error title=File length::{message}')
    print(
        f'file length: {len(errors)} error(s), {len(warnings)} allowlisted warning(s), '
        f'{len(stale)} allowlist entr{"y" if len(stale) == 1 else "ies"} to remove'
    )
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
