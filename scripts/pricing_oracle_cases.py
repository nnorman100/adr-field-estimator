"""The pricing oracle's synthetic corpus: named boundary cases plus deterministic seeded jobs.

No customer record is used. Each case is a stored input for scripts/pricing_oracle.py; the
v2 (owner price table) cases live in scripts/pricing_oracle_cases_v2.py. Inputs are kept as raw
JSON, so absent fields stay absent, integers stay integers and -0.0 stays -0.0 when a reader
loads them.
"""

import copy
import hashlib
import random
from decimal import Decimal

from backend import price_books
from backend.adr_price_book import ADR_COMPANY_ID, adr_rates

V1 = price_books.CALCULATION_VERSION
V2 = 'dryscope-v2'
# A 1x1 PNG. Signing digests hash this text; the signature image itself is not checked here.
SIGNATURE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
IDENTITY = dict(
    company_id='oracle-co',
    version=1,
    name='Oracle Restoration',
    address='1 Synthetic Way, Testville',
    phone='555-0100',
    email='office@example.invalid',
    license='000001',
    signoff='Pat Example',
)
AI = dict(summary='Reviewed the inspection.', suggestions=['Check the subfloor.'], unpriced_work=[])
# Every baseline job number zero, so a case prices only what it names.
NO_BASELINE = dict(
    emergency_calls=0, monitoring_hours=0, haul_loads=0, air_scrubbers=0, hepa_filters=0
)
# Synthetic v1 rates for a company other than ADR, each inside its catalog bounds.
ORACLE_RATES = {
    'demo_cat1_unfinished': '1.10',
    'demo_cat1_finished': '2.20',
    'demo_cat2_unfinished': '1.50',
    'demo_cat2_finished': '2.90',
    'demo_cat3_unfinished': '2.50',
    'demo_cat3_finished': '8.40',
    'emergency_call': '150.00',
    'monitoring_hourly': '50.00',
    'haul_pickup_load': '160.00',
    'air_scrubber_daily': '75.00',
    'hepa_filter': '180.00',
    'matterport_scan': '250.00',
    'dump_truck_load': '285.00',
    'equipment_decontamination': '28.00',
    'power_distribution': '65.00',
    'air_mover_daily': '30.00',
    'dehumidifier_daily': '100.00',
    'wood_floor_daily': '180.00',
    'sheet_labor_hourly': '55.00',
    'after_hours_job_charge': '200.00',
    'additional_work_hourly': '55.00',
}


def _hex(text, length=32):
    return hashlib.sha256(text.encode()).hexdigest()[:length]


def photo(key, room, value=None, status=None):
    """A stored photo record. A value makes it a verified meter reading."""
    status = status or ('verified' if value else 'no_meter')
    record = dict(
        id=_hex('photo:' + key),
        room=room,
        captured_at='2026-10-15T12:00:00Z',
        width=1600,
        height=1200,
        ocr_status=status,
        ocr=dict(
            meter_detected=True,
            meter_type='Extech MO290',
            value=value,
            classification='',
            notes='',
        )
        if value
        else None,
        file=dict(
            path=f'users/oracle/inspections/{_hex(key)}/photo.jpg',
            content_type='image/jpeg',
            sha256=_hex('bytes:' + key, 64),
        ),
    )
    if status == 'verified':
        record['location'] = dict(source='not_shared')
    return record


def extra(key, description, hours, rate=None, *, priced_from_book=False, unpriced_item=''):
    """A manual extra; a rate adds the owner's approval snapshot."""
    body = dict(
        id=_hex('extra:' + key),
        description=description,
        hours=hours,
        origin='manual',
        unpriced_item=unpriced_item,
    )
    if rate is not None:
        approval = dict(
            accepted_by_uid='owner-uid',
            accepted_by_name='Olive Owner',
            accepted_at='2026-10-25T12:00:00Z',
            rate=rate,
            total=str((Decimal(hours) * Decimal(rate)).quantize(Decimal('0.01'))),
            company_id='oracle-co',
            company_version=1,
        )
        if priced_from_book:
            approval.update(price_version_id='v-oracle-1', price_content_sha256=_hex('book', 64))
        body['approval'] = approval
    return body


def case(case_id, title, tags, data, *, calculation=V1, **more):
    """One corpus entry. Unnamed inputs take the defaults a synthetic company job would have."""
    v1_book = calculation != V2 and 'rates' not in more
    company = ADR_COMPANY_ID if v1_book else 'oracle-co'
    body = dict(
        calculation=calculation,
        company_id=company,
        version_id=f'v-{_hex("version:" + case_id, 12)}',
        sequence=1,
        inspection_id='ADR-INS-' + _hex('inspection:' + case_id),
        revision=3,
        data=data,
        photos=[],
        ai=AI,
        identity=dict(IDENTITY, company_id=company),
        customer_name='Casey Customer',
        claim=None,
        history=None,
        signing=dict(
            auth_id='ADR-AUTH-oracle-' + _hex('auth:' + case_id, 12),
            signature_png=SIGNATURE_PNG,
            link_key=_hex('link:' + case_id, 64),
            link=dict(
                signer_name='Casey Customer',
                signer_role='owner',
                documents_reviewed=True,
                electronic_consent=True,
                consent_version='homeowner-link-v1',
                signature_png=SIGNATURE_PNG,
            ),
        ),
    )
    if v1_book:
        body['rates'] = adr_rates()
    body.update(more)
    return dict(id=case_id, title=title, tags=sorted(set(tags)), input=body)


def job(rooms, **values):
    """An inspection with the fields every audited job has; other fields are as given."""
    body = dict(
        address='100 Oracle Lane, Testville', year_built=1985, scope_confirmed=True, rooms=rooms
    )
    body.update(values)
    return body


def room(name, category=1, **values):
    return dict(name=name, category=category, **values)


def _v1_year_cases():
    kitchen = [room('Kitchen', 1, finished_sf=40)]
    return [
        case(
            f'v1-year-{year}',
            f'Built in {year}: {note}',
            ['year_boundary', 'lead_notice'],
            job(kitchen, year_built=year),
            ai=dict(AI, testing_advice=['Arrange lead and asbestos testing before demolition.']),
        )
        for year, note in (
            (1800, 'the earliest year a job accepts, pre-1978 wording'),
            (1977, 'the last year that requires the pre-test notice'),
            (1978, 'the first year without the pre-test notice'),
            (2025, 'a recent home'),
        )
    ]


def _v1_cent_cases():
    return [
        case(
            'v1-cent-zero',
            'Nothing priced: the documents refuse a $0.00 scope',
            ['cent_boundary', 'zero_total', 'rejection'],
            job([room('Bath', finished_sf=0)], **NO_BASELINE),
            rates=ORACLE_RATES,
        ),
        case(
            'v1-cent-one',
            'One cent: the smallest rate on one square foot',
            ['cent_boundary'],
            job([room('Closet', finished_sf=1)], **NO_BASELINE),
            rates=dict(ORACLE_RATES, demo_cat1_finished='0.01'),
        ),
        case(
            'v1-cent-half-line',
            'Half a cent on a line rounds half up: 0.5 sq ft at one cent',
            ['cent_boundary', 'half_cent'],
            job([room('Closet', finished_sf=0.5)], **NO_BASELINE),
            rates=dict(ORACLE_RATES, demo_cat1_finished='0.01'),
        ),
        case(
            'v1-cent-half-waste',
            'Half a cent from waste: 1 sq ft at 5 cents plus 10% waste',
            ['cent_boundary', 'half_cent', 'waste'],
            job([room('Closet', finished_sf=1, waste_percent=10)], **NO_BASELINE),
            rates=dict(ORACLE_RATES, demo_cat1_finished='0.05'),
        ),
        case(
            'v1-cent-half-range',
            'Half a cent in the range: 3 cents of labor times 1.5 is 0.045, which rounds up',
            ['cent_boundary', 'half_cent', 'range'],
            job([room('Closet', finished_sf=1)], **NO_BASELINE),
            rates=dict(ORACLE_RATES, demo_cat1_finished='0.03'),
        ),
        case(
            'v1-float-quantities',
            'Fractional hours and areas convert through their float text',
            ['float_format'],
            job(
                [room('Den', 2, finished_sf=33.3, unfinished_sf=0.1, waste_percent=12.5)],
                labor_hours=0.1,
                monitoring_hours=13.25,
            ),
        ),
        case(
            'v1-negative-zero',
            'A -0.0 area is accepted, priced as nothing and stored as -0.0',
            ['negative_zero', 'null_omitted'],
            job([room('Hall', finished_sf=-0.0, unfinished_sf=10)]),
        ),
    ]


# Room names whose override keys sort differently by code point (Python) and by UTF-16 unit:
# U+00E9 < U+FF21 < U+1F600, but the surrogate pair of U+1F600 sorts before U+FF21 in UTF-16.
SERIALIZER_ROOMS = ('Room \u00e9', 'Room \uff21', 'Room \U0001f600')


def serializer_job(**values):
    """Non-ASCII and non-BMP object keys, and floats Python writes with an exponent."""
    rooms = [
        room(SERIALIZER_ROOMS[0], 1, finished_sf=40),
        room(SERIALIZER_ROOMS[1], 2, finished_sf=1e-05, unfinished_sf=12),
        room(SERIALIZER_ROOMS[2], 3, unfinished_sf=1e-07, waste_percent=2.5e-06),
    ]
    overrides = {
        f'{name}:{field}': dict(measured=entered, entered=entered)
        for name, field, entered in (
            (SERIALIZER_ROOMS[2], 'unfinished_sf', '0.00'),
            (SERIALIZER_ROOMS[1], 'finished_sf', '0.00'),
            (SERIALIZER_ROOMS[0], 'finished_sf', '40.00'),
        )
    }
    return job(rooms, labor_hours=1e-05, quantity_overrides=overrides, **values)


def _v1_threshold_cases():
    """The estimating sheet's 1,001 sq ft step: below, at and above, split across two rooms."""
    cases = []
    for label, finished, unfinished in (
        ('999', 600, 399),
        ('1000', 600, 400),
        ('1000.99', 600, 400.99),
        ('1001', 600, 401),
        ('1001.01', 600, 401.01),
    ):
        cases.append(
            case(
                f'v1-range-threshold-{label}',
                f'{label} affected sq ft against the 1,001 sq ft range step',
                ['range_threshold', 'bracket_boundary', 'mixed_rooms'],
                job(
                    [
                        room('Living', 1, finished_sf=finished),
                        room('Garage', 2, unfinished_sf=unfinished),
                    ],
                ),
            )
        )
    return cases


def _v1_category_cases():
    cases = []
    for category in (1, 2, 3):
        for cabinetry in (False, True):
            cases.append(
                case(
                    f'v1-cat{category}-cabinetry-{"yes" if cabinetry else "no"}',
                    f'Category {category} finished and unfinished areas, cabinetry {cabinetry}',
                    ['water_category', 'cabinetry'],
                    job(
                        [
                            room(
                                'Kitchen',
                                category,
                                finished_sf=120,
                                unfinished_sf=80,
                                custom_cabinetry=cabinetry,
                            )
                        ]
                    ),
                )
            )
    cases.append(
        case(
            'v1-cat3-cabinetry-unfinished-only',
            'Category 3 cabinetry with unfinished area only: nothing doubles',
            ['water_category', 'cabinetry'],
            job([room('Pantry', 3, unfinished_sf=50, custom_cabinetry=True)]),
        )
    )
    return cases


def _v1_scope_cases():
    full = job(
        [
            room('Kitchen', 3, finished_sf=40, custom_cabinetry=True, waste_percent=15),
            room('Hall', 1, unfinished_sf=80, waste_percent=10),
            room('Bath', 2, finished_sf=25.5, unfinished_sf=12),
        ],
        is_after_hours=True,
        air_movers=6,
        dehumidifiers=2,
        drying_days=4,
        wood_floor_systems=1,
        wood_floor_days=5,
        labor_hours=3.5,
        matterport_scans=1,
        dump_truck_loads=2,
        equipment_decon=3,
        power_distribution=1,
    )
    return [
        case(
            'v1-mixed-everything',
            'Mixed rooms, waste, after hours, every equipment and optional charge',
            ['mixed_rooms', 'waste', 'after_hours', 'water_category', 'cabinetry'],
            full,
            photos=[
                photo('k1', 'Kitchen', '31.4% WME'),
                photo('h1', 'Hall'),
                photo('b1', 'Bath', '18.0% WME'),
            ],
        ),
        case(
            'v1-max-quantities',
            'Every quantity at its maximum across 30 rooms, with 30 approved extras',
            ['max_quantities', 'extras', 'approval_snapshot', 'water_category', 'cabinetry'],
            job(
                [
                    room(
                        f'Room {n:02d}',
                        n % 3 + 1,
                        finished_sf=100000,
                        unfinished_sf=100000,
                        custom_cabinetry=True,
                        waste_percent=100,
                    )
                    for n in range(30)
                ],
                is_after_hours=True,
                air_movers=100,
                dehumidifiers=100,
                drying_days=60,
                labor_hours=500,
                emergency_calls=100,
                monitoring_hours=500,
                haul_loads=100,
                air_scrubbers=100,
                hepa_filters=100,
                matterport_scans=100,
                dump_truck_loads=100,
                equipment_decon=100,
                power_distribution=100,
                wood_floor_systems=100,
                wood_floor_days=60,
                extras=[
                    extra(f'max{n}', f'Large additional task {n}', '200', '10000.00')
                    for n in range(30)
                ],
            ),
            rates={key: price_books.BY_KEY[key]['maximum'] for key in price_books.KEYS},
            company_id='oracle-co',
        ),
    ]


def _v1_extras_cases():
    rooms = [room('Laundry', 2, finished_sf=60)]
    return [
        case(
            'v1-extras-approved-old-snapshot',
            'An approved extra whose snapshot predates price book fields',
            ['extras', 'approval_snapshot'],
            job(rooms, extras=[extra('old', 'Move and reset toilet', '2.5', '47.46')]),
        ),
        case(
            'v1-extras-approved-book-snapshot',
            'An approved extra priced from a company price book',
            ['extras', 'approval_snapshot'],
            job(
                rooms,
                extras=[extra('book', 'Detach dishwasher', '1.25', '55.00', priced_from_book=True)],
            ),
        ),
        case(
            'v1-extras-pending',
            'An unapproved extra keeps the documents unsignable',
            ['extras', 'unpriced_work'],
            job(
                rooms,
                extras=[
                    extra('ok', 'Move and reset toilet', '1', '47.46'),
                    extra('wait', 'Remove vanity top', '3'),
                ],
            ),
        ),
        case(
            'v1-extras-cover-unpriced',
            'Unpriced work the model named is covered by an approved extra of the same text',
            ['extras', 'unpriced_work', 'approval_snapshot'],
            job(
                rooms,
                extras=[
                    extra(
                        'cover',
                        'Remove water heater platform',
                        '2',
                        '47.46',
                        unpriced_item='Remove water heater platform',
                    )
                ],
            ),
            ai=dict(AI, unpriced_work=['Remove water heater platform']),
        ),
    ]


def _v1_document_cases():
    rooms = [room('Kitchen', 1, finished_sf=40)]
    return [
        case(
            'v1-unpriced-ai-work',
            'Work the model names but no rate prices blocks signing',
            ['unpriced_work'],
            job(rooms),
            ai=dict(AI, unpriced_work=['Replace the subfloor under the dishwasher']),
        ),
        case(
            'v1-ai-text-cleaned',
            'Model sentences that state a price are dropped; field names become words',
            ['ai_text'],
            job(rooms),
            ai=dict(
                summary='The inspection_payload shows wet drywall. Repairs cost $1,200 total.\n'
                'The JSON metadata matches the photos.',
                suggestions=['Budget about 300 dollars for baseboards.', 'Check the year_built.'],
                unpriced_work=[],
            ),
        ),
        case(
            'v1-photos-ocr-states',
            'Verified, unmetered and failed readings; all photos are numbered in log order',
            ['ocr'],
            job(rooms),
            photos=[
                photo('p1', 'Kitchen', '22.0% WME'),
                photo('p2', 'Kitchen'),
                photo('p3', 'Kitchen', status='failed'),
            ],
        ),
        case(
            'v1-photos-ocr-pending',
            'A pending meter reading keeps the documents unsignable',
            ['ocr'],
            job(rooms),
            photos=[photo('p1', 'Kitchen', '22.0% WME'), photo('p2', 'Kitchen', status='pending')],
        ),
        case(
            'v1-identity-missing-fields',
            'A company profile without address, license and sign-off cannot sign',
            ['identity'],
            job(rooms),
            identity=dict(IDENTITY, company_id=ADR_COMPANY_ID, address='', license='', signoff=''),
        ),
        case(
            'v1-identity-absent',
            'No company profile: clauses name "the contractor"',
            ['identity', 'null_omitted'],
            job(rooms),
            identity=None,
            customer_name='',
        ),
        case(
            'v1-claim-details',
            'Recorded claim details print in the letter in document order',
            ['claim'],
            job(rooms),
            claim=dict(
                carrier='Example Mutual',
                claim_number='CLM-0001',
                policy_number='POL-0002',
                date_of_loss='2026-10-10',
                loss_cause='Supply line failure',
                adjuster_name='Avery Adjuster',
                adjuster_email='adjuster@example.invalid',
                adjuster_phone='555-0199',
                deductible='$1,000',
            ),
        ),
        case(
            'v1-transcript-and-notes',
            'Walkthrough chatter is removed from the statement; notes are trimmed',
            ['transcript'],
            job(
                rooms,
                technician_notes='  Water under the sink.  ',
                technician_transcript='Hello there. Okay.\nThe kitchen wall is wet to 24 inches.\n'
                'Thanks. Moisture reads high near the dishwasher.',
            ),
        ),
        case(
            'v1-scope-not-confirmed',
            'An unconfirmed scope prices but cannot be signed',
            ['signable'],
            job(rooms, scope_confirmed=False),
        ),
        case(
            'v1-unicode',
            'Accents, CJK, emoji, a line separator and a tab survive the canonical bytes',
            ['unicode'],
            job(
                [room('Baño principal', 2, finished_sf=30), room('Küche 😀', 1, unfinished_sf=12)],
                address='5 Calle José, Testville',
                technician_notes='Humedad detrás de la pared 😀 second line\tend',
            ),
            customer_name='李 小龍',
            photos=[photo('u1', 'Baño principal', '19.5% WME')],
        ),
        case(
            'v1-serializer-keys-and-exponents',
            'Override keys sort by code point across BMP and non-BMP names; tiny floats keep '
            'their exponent form in the canonical bytes',
            ['unicode', 'unicode_keys', 'exponent_format', 'float_format', 'overrides'],
            serializer_job(),
        ),
        case(
            'v1-sizing-and-history',
            'Sizing inputs print the IICRC check; signed-job history adds a far-from-typical note',
            ['warnings', 'sizing'],
            job(
                [
                    room(
                        'Basement',
                        2,
                        finished_sf=200,
                        floor_sf=400,
                        wet_floor_sf=300,
                        ceiling_height_ft=8,
                        water_class=2,
                    )
                ],
                air_movers=1,
                dehumidifiers=1,
                dehumidifier_ppd=70,
            ),
            history=[
                dict(category=2, sf=str(sf), low='90000.00') for sf in (180, 200, 220, 250, 290)
            ],
        ),
        case(
            'v1-rollback-no-pin',
            'Single-company rollback mode: rates without a pin or price basis',
            ['legacy', 'null_omitted'],
            job(rooms),
            pinned=False,
        ),
    ]


def _v1_rejection_cases():
    rooms = [room('Kitchen', 1, finished_sf=40)]
    return [
        case(
            'v1-reject-package-price',
            'An old package-tier selection must be cleared before an audit',
            ['rejection', 'legacy'],
            dict(job(rooms), package_price='Tier 2', has_crawl_space=True),
        ),
        case(
            'v1-reject-no-year',
            'An audit needs the year built',
            ['rejection', 'null_omitted'],
            dict(job(rooms), year_built=None),
        ),
        case(
            'v1-reject-year-1799',
            'A year before 1800 is not a valid input',
            ['rejection', 'year_boundary'],
            job(rooms, year_built=1799),
        ),
        case(
            'v1-reject-unknown-field',
            'An unknown inspection field is rejected',
            ['rejection'],
            dict(job(rooms), crawl_space_depth=3),
        ),
        case(
            'v1-reject-duplicate-rooms',
            'Two rooms with one name (ignoring case and spaces) are rejected on save',
            ['rejection', 'mixed_rooms'],
            job([room('Kitchen', finished_sf=10), room(' kitchen ', unfinished_sf=5)]),
        ),
        case(
            'v1-reject-stale-override',
            'A quantity override that does not match the entered value is rejected',
            ['rejection', 'overrides'],
            job(
                rooms,
                quantity_overrides={
                    'Kitchen:finished_sf': dict(
                        measured='50', entered='45', reason='Measured twice'
                    )
                },
            ),
        ),
        case(
            'v1-reject-unknown-version',
            'A pin with an unknown calculation version is refused',
            ['rejection', 'unknown_version'],
            job(rooms),
            calculation='adr-residential-v0',
        ),
        *(
            case(
                f'v1-reject-version-{label}',
                f'A pin whose calculation version is {note} is refused',
                ['rejection', 'unknown_version', 'malformed_version'],
                job(rooms),
                calculation=value,
            )
            for label, note, value in (
                ('null', 'null', None),
                ('number', 'a number', 1),
                ('list', 'a list holding a known version', [V1]),
                ('wrong-case', 'a known v2 version in capitals', V2.upper()),
            )
        ),
        _without_calculation(
            case(
                'v1-reject-version-missing',
                'A stored price version without a calculation version cannot be pinned',
                ['rejection', 'unknown_version', 'malformed_version', 'null_omitted'],
                job(rooms),
            )
        ),
    ]


def _without_calculation(entry):
    del entry['input']['calculation']
    return entry


def _seeded_rates(rng):
    """Random v1 rates inside each item's catalog bounds, in cents."""
    rates = {}
    for key in price_books.KEYS:
        item = price_books.BY_KEY[key]
        low = int(Decimal(item['minimum']) * 100)
        high = min(int(Decimal(item['maximum']) * 100), low + 50000)
        rates[key] = str(Decimal(rng.randint(max(low, 1), high)) / 100)
    return {key: str(Decimal(value).quantize(Decimal('0.01'))) for key, value in rates.items()}


def _seeded_area(rng):
    return rng.choice([0, rng.randint(1, 1500), round(rng.uniform(0.01, 900), 2)])


def seeded_v1(count=25, seed=19780101):
    rng = random.Random(seed)
    cases = []
    for n in range(count):
        rooms = [
            room(
                f'Room {k + 1}',
                rng.randint(1, 3),
                finished_sf=_seeded_area(rng),
                unfinished_sf=_seeded_area(rng),
                custom_cabinetry=rng.random() < 0.3,
                waste_percent=rng.choice([0, 0, 5, 10, 12.5, 33.33]),
            )
            for k in range(rng.randint(1, 5))
        ]
        data = job(
            rooms,
            year_built=rng.randint(1940, 2025),
            is_after_hours=rng.random() < 0.3,
            air_movers=rng.randint(0, 12),
            dehumidifiers=rng.randint(0, 4),
            drying_days=rng.randint(1, 7),
            labor_hours=rng.choice([0, 1, 2.5, round(rng.uniform(0, 40), 2)]),
            emergency_calls=rng.randint(0, 2),
            monitoring_hours=rng.choice([0, 13.25, round(rng.uniform(0, 30), 2)]),
            haul_loads=rng.randint(0, 3),
            matterport_scans=rng.randint(0, 1),
            wood_floor_systems=rng.randint(0, 2),
        )
        if rng.random() < 0.3:
            data['extras'] = [extra(f'seed{n}', 'Seeded extra task', '1.5', '60.00')]
        cases.append(
            case(
                f'v1-seeded-{n:02d}',
                f'Seeded v1 job {n} (seed {seed})',
                ['seeded'],
                data,
                rates=_seeded_rates(rng),
                company_id='oracle-co',
            )
        )
    return cases


def corpus():
    """Every case, v1 then v2, in a fixed order."""
    from scripts.pricing_oracle_cases_v2 import v2_cases

    return copy.deepcopy(
        _v1_year_cases()
        + _v1_cent_cases()
        + _v1_threshold_cases()
        + _v1_category_cases()
        + _v1_scope_cases()
        + _v1_extras_cases()
        + _v1_document_cases()
        + _v1_rejection_cases()
        + seeded_v1()
        + v2_cases()
    )
