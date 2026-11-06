"""The pinned legacy-Python pricing oracle: expected artifacts for every synthetic corpus case.

Each case file under tests/fixtures/pricing-oracle/cases/ holds one stored input and what the
current Python code makes of it, stage by stage: the normalized inspection, the job pin and price
basis, the price lines, the intermediate buckets, the low/high range, the warnings, all four
document payloads, the canonical proposal bytes with their SHA-256 (the proposal hash), and the
signing-request digests when the documents are signable. A rejected input records where and why
it was rejected. tests/fixtures/pricing-oracle/README.md says when the answers may be regenerated.

    python scripts/pricing_oracle.py --check   # compare the code's answers with the stored ones
    python scripts/pricing_oracle.py --write   # regenerate (owner-approved oracle changes only)
"""

import argparse
import base64
import hashlib
import json
import platform
import subprocess
import sys
from contextlib import contextmanager
from decimal import Decimal, getcontext
from importlib import metadata
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pydantic import ValidationError  # noqa: E402

from backend import claims, estimate_warnings, price_books, price_table, pricing_v2  # noqa: E402
from backend.contracts import (  # noqa: E402
    AIResult,
    AuthorizeRequest,
    HomeownerSignature,
    InspectionData,
    check_quantity_overrides,
    distinct_rooms,
)
from backend.inspection_store import canonical  # noqa: E402
from backend.main import inspection_payload  # noqa: E402
from backend.price_book_store import PriceBookStore, _pin_body  # noqa: E402
from backend.pricing import price_and_range  # noqa: E402
from backend.sizing import equipment_sizing  # noqa: E402

FIXTURES = ROOT / 'tests' / 'fixtures' / 'pricing-oracle'
CASES = FIXTURES / 'cases'
MANIFEST = FIXTURES / 'manifest.json'
FORMAT_VERSION = 1
# The audit's date line is the only clock the documents read; it is frozen for every case.
FROZEN_DATE = '11-06-2026'
PRICED_AT = '2026-11-01T17:00:00Z'
# Containers deeper than this print on one line, so a case file stays reviewable and short.
INLINE_DEPTH = 4
MAX_LINES = 1000
V1 = price_books.CALCULATION_VERSION
V2 = price_table.CALCULATION_VERSION


class _VersionReader:
    """What PriceBookStore.basis_for reads besides the pin: the stored version's calculation."""

    def __init__(self, calculation_version):
        self.calculation_version = calculation_version

    def _version(self, _version_id):
        return {'calculation_version': self.calculation_version}


@contextmanager
def frozen_clock():
    with mock.patch.object(claims, 'proposal_date', lambda: FROZEN_DATE):
        yield


def plain(value):
    """Engine values as JSON: a Decimal keeps its exact str() form, so trailing zeros and exponents
    survive; tuples become lists. Floats, ints, strings, booleans and None are left as they are."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return value


def _rejected(stage, error):
    if isinstance(error, ValidationError):
        detail = [
            {'loc': [str(part) for part in item['loc']], 'type': item['type']}
            for item in error.errors()
        ]
        return {'rejected': {'stage': stage, 'type': 'ValidationError', 'errors': detail}}
    return {'rejected': {'stage': stage, 'type': type(error).__name__, 'message': str(error)}}


def _pin_and_basis(case, normalized_table):
    """The job pin and the price basis the audit reads, from the code that makes them."""
    calculation = case['calculation']
    if normalized_table is not None:
        source = dict(
            normalized_table,
            calculation_version=calculation,
            content_sha256=price_table.content_hash(normalized_table),
        )
    else:
        source = dict(
            rates=case['rates'],
            calculation_version=calculation,
            content_sha256=price_books.content_hash(case['rates'], calculation)
            if price_books.known_calculation_version(calculation)
            else '0' * 64,
        )
    source.update(version_id=case['version_id'], sequence=case['sequence'])
    pin = _pin_body(case['inspection_id'], case['company_id'], source, 'first_price')
    pin['priced_at'] = PRICED_AT
    basis = PriceBookStore.basis_for(_VersionReader(calculation), pin, case['company_id'])
    return pin, basis


def _v1_buckets(data, lines):
    """The amounts claims._v1_proposal_range sums, from the engine's own code sets and rounding."""

    def total(codes):
        return sum(
            (claims.amount(line['total']) for line in lines if line['code'] in codes), Decimal(0)
        )

    return {
        'job': total(claims.JOB_CODES),
        'labor_material': total(claims.LABOR_MATERIAL_CODES),
        'equipment': total(claims.EQUIPMENT_CODES),
        'affected_sf': sum(
            (Decimal(str(r.unfinished_sf)) + Decimal(str(r.finished_sf)) for r in data.rooms),
            Decimal(0),
        ),
    }


def _v2_buckets(lines):
    return {
        f'{prefix}{bucket}': pricing_v2._sum(lines, bucket, taxable=taxed)
        for bucket in ('fixed', 'equipment', 'labor_material')
        for prefix, taxed in (('', False), ('taxed_', True))
    }


def _signing(case, proposal_hash):
    """The digests both signing routes store as payload_sha256 for this proposal."""
    signing = case['signing']
    onsite = AuthorizeRequest.model_validate(
        dict(
            inspection_id=case['inspection_id'],
            expected_revision=case['revision'],
            auth_id=signing['auth_id'],
            proposal_hash=proposal_hash,
            signature_png=signing['signature_png'],
            documents_confirmed=True,
            email_copy=signing.get('email_copy'),
        )
    ).model_dump(mode='json')
    onsite.pop('email_copy', None)
    homeowner = HomeownerSignature.model_validate(signing['link']).model_dump(mode='json')
    # The payload signing_links.sign hashes: revision, hash and reference come from the link.
    link = dict(
        inspection_id=case['inspection_id'],
        expected_revision=case['revision'],
        auth_id='ADR-AUTH-link-' + signing['link_key'][:32],
        proposal_hash=proposal_hash,
        signature_png=homeowner['signature_png'],
        documents_confirmed=True,
        signer_name=homeowner['signer_name'],
        signer_role=homeowner['signer_role'],
        consent_version=homeowner['consent_version'],
    )
    return {
        'onsite_payload': onsite,
        'onsite_sha256': hashlib.sha256(canonical(onsite).encode()).hexdigest(),
        'link_payload': link,
        'link_sha256': hashlib.sha256(canonical(link).encode()).hexdigest(),
    }


def evaluate(case):
    """Everything the current code produces for one stored case input, in pipeline order."""
    with frozen_clock():
        return plain(_evaluate(case))


def _evaluate(case):
    out = {}
    try:
        data = InspectionData.model_validate(case['data'])
    except ValidationError as error:
        return _rejected('inspection', error)
    out['normalized_inspection'] = inspection_payload(data)
    try:
        distinct_rooms(data)
        check_quantity_overrides(data)
    except ValueError as error:
        return dict(out, **_rejected('save_checks', error))

    table = None
    if case['calculation'] == V2:
        try:
            table = price_table.normalize_table(
                case['table'], publish=True, acknowledgements=case.get('acknowledgements', [])
            )
        except ValueError as error:
            return dict(out, **_rejected('table', error))
    pin = basis = None
    rates = case.get('rates')
    if case.get('pinned', True):
        try:
            pin, basis = _pin_and_basis(case, table)
        except Exception as error:  # Conflict from the store is the rejection a pin read gives.
            return dict(out, **_rejected('pin', error))
        out['pin'] = pin
        out['price_basis'] = basis
        rates = pin.get('rates')

    try:
        if pin is not None:
            priced = price_and_range(data, pin)
            lines, low, high = priced.lines, priced.low, priced.high
            itemized, engine_warnings, totals = (
                priced.xactimate_total,
                priced.warnings,
                priced.totals,
            )
        else:
            lines, itemized = claims.price_scope(data, rates)
            low, high = claims.proposal_range(data, lines)
            priced, engine_warnings, totals = None, [], None
    except (ValueError, RuntimeError) as error:
        return dict(out, **_rejected('pricing', error))
    out['pricing'] = {
        'calculation_version': case['calculation'] if pin is not None else V1,
        'lines': lines,
        'itemized_total': itemized,
        'buckets': _v2_buckets(lines) if table is not None else _v1_buckets(data, lines),
        'totals': totals,
        'low': low,
        'high': high,
    }
    out['warnings'] = {
        'engine': engine_warnings,
        'advisory': estimate_warnings.warnings(
            data, equipment_sizing(data), table, priced, case.get('history')
        ),
    }

    try:
        documents = claims.make_documents(
            data,
            case['photos'],
            AIResult.model_validate(case['ai']),
            case.get('identity'),
            case.get('customer_name', ''),
            case.get('claim'),
            rates,
            basis,
            pin,
        )
    except (ValueError, RuntimeError, ValidationError) as error:
        return dict(out, **_rejected('documents', error))
    out['documents'] = documents
    payload = dict(
        data=out['normalized_inspection'],
        photos=case['photos'],
        documents=documents,
        revision=case['revision'],
    )
    raw = canonical(payload).encode()
    proposal_hash = hashlib.sha256(raw).hexdigest()
    out['proposal'] = {
        'canonical_bytes_base64': base64.b64encode(raw).decode('ascii'),
        'byte_length': len(raw),
        'sha256': proposal_hash,
    }
    out['signing'] = _signing(case, proposal_hash) if documents['signable'] else None
    return out


def render(value, depth=0, inline=INLINE_DEPTH):
    """Deterministic text for a case or manifest: sorted keys, ASCII only, two-space indent, and
    containers `inline` levels down on one line. Readers parse it; nothing compares its layout."""
    if depth >= inline or not isinstance(value, (dict, list)) or not value:
        return json.dumps(
            value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(', ', ': ')
        )
    pad = '  ' * (depth + 1)
    if isinstance(value, dict):
        rows = [
            f'{pad}{json.dumps(key, ensure_ascii=True)}: {render(value[key], depth + 1, inline)}'
            for key in sorted(value)
        ]
        return '{\n' + ',\n'.join(rows) + '\n' + '  ' * depth + '}'
    rows = [pad + render(item, depth + 1, inline) for item in value]
    return '[\n' + ',\n'.join(rows) + '\n' + '  ' * depth + ']'


def case_bytes(case):
    """One case file: its stored input and the oracle's expected answer."""
    body = {
        'id': case['id'],
        'title': case['title'],
        'tags': case['tags'],
        'input': case['input'],
        'expected': evaluate(case['input']),
    }
    return (render(body) + '\n').encode('ascii')


def corpus_sha256(files):
    """SHA-256 over every case file's name and SHA-256, in name order."""
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(f'{name}\n{hashlib.sha256(files[name]).hexdigest()}\n'.encode())
    return digest.hexdigest()


def build_files():
    """Every case file the corpus builder and the current code produce, by file name."""
    from scripts.pricing_oracle_cases import corpus

    files = {}
    for case in corpus():
        name = f'{case["id"]}.json'
        if name in files:
            raise ValueError(f'Duplicate case id: {case["id"]}')
        files[name] = case_bytes(case)
    return files


def _git(*args):
    return subprocess.run(
        ['git', '-C', str(ROOT), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def _sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest(files):
    context = getcontext()
    cases, priced = [], set()
    for name in sorted(files):
        body = json.loads(files[name])
        if 'pricing' in body['expected']:
            priced.add(body['expected']['pricing']['calculation_version'])
        cases.append(
            {
                'id': body['id'],
                'file': f'cases/{name}',
                'sha256': hashlib.sha256(files[name]).hexdigest(),
                'calculation_version': body['input']['calculation'],
                'tags': body['tags'],
            }
        )
    return {
        'format_version': FORMAT_VERSION,
        'generator': 'scripts/pricing_oracle.py',
        'corpus_builder': 'scripts/pricing_oracle_cases.py',
        'source': {
            'backend_commit': _git('log', '-1', '--format=%H', '--', 'backend'),
            'backend_tree': _git('rev-parse', 'HEAD:backend'),
        },
        'environment': {
            'python': platform.python_version(),
            'implementation': platform.python_implementation(),
            'requirements_sha256': _sha256_file(ROOT / 'backend' / 'requirements.txt'),
            'packages': {name: metadata.version(name) for name in ('pydantic', 'pydantic-core')},
            'decimal_context': {'prec': context.prec, 'rounding': context.rounding},
        },
        'frozen': {
            'proposal_date': FROZEN_DATE,
            'proposal_date_zone': 'America/Los_Angeles',
            'priced_at': PRICED_AT,
        },
        'calculation_versions': sorted(priced),
        'case_count': len(cases),
        'corpus_sha256': corpus_sha256(files),
        'cases': cases,
    }


def stored_files():
    return {path.name: path.read_bytes() for path in sorted(CASES.glob('*.json'))}


def check():
    """Problems between the stored oracle and what the current code produces; empty when equal."""
    expected, actual = stored_files(), build_files()
    problems = [f'missing case file: {name}' for name in sorted(set(actual) - set(expected))]
    problems += [f'unexpected case file: {name}' for name in sorted(set(expected) - set(actual))]
    for name in sorted(set(expected) & set(actual)):
        if expected[name] != actual[name]:
            offset = next(
                (i for i, (a, b) in enumerate(zip(expected[name], actual[name])) if a != b),
                min(len(expected[name]), len(actual[name])),
            )
            problems.append(f'{name}: first differing byte at offset {offset}')
    stored = json.loads(MANIFEST.read_text(encoding='ascii'))
    if stored['corpus_sha256'] != corpus_sha256(expected):
        problems.append('manifest.json corpus_sha256 does not match the stored case files')
    return problems


def write():
    if _git('status', '--porcelain', '--', 'backend'):
        raise SystemExit('Commit backend/ first: the oracle pins a committed backend tree.')
    files = build_files()
    CASES.mkdir(parents=True, exist_ok=True)
    for path in CASES.glob('*.json'):
        if path.name not in files:
            path.unlink()
    for name, raw in files.items():
        (CASES / name).write_bytes(raw)
    # One line per case entry, so the manifest stays short at any corpus size.
    MANIFEST.write_bytes((render(manifest(files), inline=2) + '\n').encode('ascii'))
    too_long = [name for name, raw in files.items() if raw.count(b'\n') > MAX_LINES]
    if too_long:
        raise SystemExit(f'Case files over {MAX_LINES} lines: {too_long}')
    print(f'Wrote {len(files)} cases, corpus {corpus_sha256(files)}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--write', action='store_true')
    args = parser.parse_args(argv)
    if args.write:
        write()
        return 0
    problems = check()
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
