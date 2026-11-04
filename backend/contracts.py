"""Validated inspection inputs; server pricing uses workbook and owner-approved extra rates."""

import re
from decimal import Decimal
from datetime import date, datetime, timedelta
from typing import Literal, Annotated
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    model_validator,
)

try:
    from .price_books import known_calculation_version
    from .shot_list import known_shot
except ImportError:
    from price_books import known_calculation_version
    from shot_list import known_shot


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


LossType = Literal['water', 'mold', 'both']


class Room(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    category: Literal[1, 2, 3] = 1
    # A label beside the category: pricing and audit wording keep reading category. Rooms saved
    # before the field existed stay without it here; the app reads an absent value as the tag the
    # room showed then (category 3 as mold, otherwise water) and saves it on unsigned drafts that
    # the user may edit.
    loss: LossType | None = None
    unfinished_sf: float = Field(default=0, ge=0, le=100000)
    finished_sf: float = Field(default=0, ge=0, le=100000)
    custom_cabinetry: bool = False
    waste_percent: float = Field(default=0, ge=0, le=100)
    # Technician-confirmed inputs for the IICRC equipment-sizing check (backend/sizing.py). They are
    # absent until stated; floor area is the room's floor, never the priced demolition area. The wet
    # floor area, which sets the air movers, defaults to the floor area until a smaller one is stated.
    floor_sf: float | None = Field(default=None, gt=0, le=100000)
    wet_floor_sf: float | None = Field(default=None, ge=0, le=100000)
    ceiling_height_ft: float | None = Field(default=None, gt=0, le=60)
    water_class: Literal[1, 2, 3, 4] | None = None
    # Technician answers that add shots to the room's photo shot list (backend/shot_list.py).
    # Absent until set, so rooms saved before them keep their stored shape.
    source_of_loss: bool | None = None
    contents_present: bool | None = None
    equipment_placed: bool | None = None
    # How many walls or floors are affected and how many materials are wet: the shot list needs one
    # tagged photo of each. Absent until the technician sets them, like the answers above.
    affected_surfaces: int | None = Field(default=None, ge=0, le=50)
    wet_materials: int | None = Field(default=None, ge=0, le=50)


EquipmentKind = Literal['air_mover', 'dehumidifier', 'air_scrubber']
# One asset id per printed tag: letters, digits and the separators a shop's own numbering uses.
ASSET_ID = r'^[A-Z0-9][A-Z0-9._/-]{0,31}$'


class EquipmentScan(StrictModel):
    """One scanned equipment tag, recorded against the room selected at the time. Placement only:
    the priced equipment counts stay the technician's entries and never read these records."""

    id: str = Field(pattern=r'^[a-f0-9]{32}$')
    kind: EquipmentKind
    asset_id: str = Field(pattern=ASSET_ID)
    room: str = Field(min_length=1, max_length=100)
    scanned_at: datetime


class TranscriptSegment(StrictModel):
    speaker: Literal['technician', 'assistant']
    connection_id: str = Field(max_length=64)
    sequence: int = Field(ge=1)
    text: str = Field(max_length=80000)
    finished: bool | None = None


class CaptureMetadata(StrictModel):
    capture_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    status: Literal['recording', 'complete', 'incomplete', 'truncated'] = 'recording'
    gap_count: int = Field(default=0, ge=0, le=1000000)
    recovery_count: int = Field(default=0, ge=0, le=10000)
    technician_edited: bool = False
    segments: list[TranscriptSegment] = Field(default_factory=list, max_length=2000)


def not_future_year(year):
    # Evaluated per request; a bound fixed at import rejects the new year on a warm instance.
    if year > datetime.now().year:
        raise ValueError('Year built cannot be in the future.')
    return year


YearBuilt = Annotated[int, Field(ge=1800), AfterValidator(not_future_year)]


class Coordinates(StrictModel):
    """Where the technician's chosen address suggestion is. They describe the address only while the
    field still reads `address`; any later edit of the text leaves them unused and the app clears them."""

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    address: str = Field(min_length=1, max_length=500)


class ExtraApproval(StrictModel):
    accepted_by_uid: str = Field(min_length=1, max_length=128)
    accepted_by_name: str = Field(min_length=1, max_length=150)
    accepted_at: datetime
    rate: Decimal = Field(gt=0, le=10000, decimal_places=2)
    total: Decimal = Field(ge=0, le=2000000, decimal_places=2)
    company_id: str
    company_version: int = Field(ge=1)
    # Present when the approval was priced from a company price book. Older approvals omit them.
    price_version_id: str = ''
    price_content_sha256: str = ''


class Extra(StrictModel):
    """Manual quantity plus an optional server-owned approval snapshot."""

    id: str = Field(pattern=r'^[a-f0-9]{32}$')
    description: str = Field(min_length=1, max_length=300)
    hours: Decimal = Field(ge=Decimal('0.25'), le=200, decimal_places=2)
    origin: Literal['manual'] = 'manual'
    unpriced_item: str = Field(default='', max_length=1000)
    approval: ExtraApproval | None = None

    @model_validator(mode='after')
    def clean_description(self):
        self.description = ' '.join(self.description.split())
        if not self.description or any(not c.isprintable() for c in self.description):
            raise ValueError('Describe the additional work.')
        return self


class ExtraQuote(StrictModel):
    hours: Decimal = Field(ge=Decimal('0.25'), le=200, decimal_places=2)


class ExtraApprove(StrictModel):
    expected_revision: int = Field(ge=1)
    expected_company_version: int = Field(ge=1)
    owner_name: str = Field(min_length=1, max_length=150)
    # The additional-work rate the owner just reviewed. Empty on clients that predate price books.
    expected_price_hash: str = Field(default='', max_length=64)


ITEM_ID = r'^[a-z][a-z0-9_]{1,39}$'


class ScopeQuantity(StrictModel):
    quantity: Decimal = Field(default=Decimal(0), ge=0, le=100000, decimal_places=2)
    count: int = Field(default=0, ge=0, le=100)
    days: int = Field(default=0, ge=0, le=60)
    measured_quantity: Decimal | None = Field(default=None, ge=0, le=100000, decimal_places=2)
    override_reason: str | None = Field(default=None, min_length=3, max_length=300)

    @model_validator(mode='after')
    def validate_override(self):
        if self.override_reason is not None:
            self.override_reason = ' '.join(self.override_reason.split())
            if len(self.override_reason) < 3 or any(
                not c.isprintable() for c in self.override_reason
            ):
                raise ValueError(
                    'Enter a short reason for the quantity override (at least 3 characters).'
                )
        if self.measured_quantity is not None and self.measured_quantity != self.quantity:
            if not self.override_reason:
                raise ValueError(
                    'Enter a short reason when overriding a walkthrough-measured quantity.'
                )
        elif self.override_reason is not None and self.measured_quantity is None:
            raise ValueError('Override reason requires a measured quantity.')
        return self


class QuantityOverride(StrictModel):
    """A walkthrough-filled quantity: what was measured, what is entered now, and why they differ.

    The reason is absent until the entered value moves away from the measured one.
    """

    measured: Decimal = Field(ge=0, le=100000, decimal_places=2)
    entered: Decimal = Field(ge=0, le=100000, decimal_places=2)
    reason: str | None = Field(
        default=None, min_length=3, max_length=300, exclude_if=lambda value: value is None
    )

    @model_validator(mode='after')
    def validate_reason(self):
        if self.reason is not None:
            self.reason = ' '.join(self.reason.split())
            if len(self.reason) < 3 or any(not c.isprintable() for c in self.reason):
                raise ValueError(
                    'Enter a short reason for the quantity override (at least 3 characters).'
                )
        elif self.entered != self.measured:
            raise ValueError('Enter a short reason when changing a walkthrough-measured quantity.')
        return self


class InspectionData(StrictModel):
    address: str = Field(default='', max_length=500)
    # Added with address suggestions; drafts saved before it stay without the key (see inspection_payload).
    coordinates: Coordinates | None = None
    year_built: YearBuilt | None = None
    # Retired job-condition flags, accepted only so older drafts load; documents ignore them.
    # Technicians describe these conditions in notes or the walkthrough instead.
    has_crawl_space: bool = False
    granite_removal: bool = False
    water_heater_loss: bool = False
    work_performed: bool = False
    rooms: list[Room] = Field(default_factory=list, max_length=30)
    air_movers: int = Field(default=0, ge=0, le=100)
    dehumidifiers: int = Field(default=0, ge=0, le=100)
    # AHAM pints/day rating of one LGR dehumidifier, for the sizing check; absent until stated.
    dehumidifier_ppd: int | None = Field(default=None, ge=1, le=1000)
    drying_days: int = Field(default=3, ge=1, le=60)
    labor_hours: float = Field(default=0, ge=0, le=500)
    is_after_hours: bool = False
    emergency_calls: int = Field(default=1, ge=0, le=100)
    monitoring_hours: float = Field(default=13.25, ge=0, le=500)
    haul_loads: int = Field(default=1, ge=0, le=100)
    air_scrubbers: int = Field(default=1, ge=0, le=100)
    hepa_filters: int = Field(default=1, ge=0, le=100)
    matterport_scans: int = Field(default=0, ge=0, le=100)
    dump_truck_loads: int = Field(default=0, ge=0, le=100)
    equipment_decon: int = Field(default=0, ge=0, le=100)
    power_distribution: int = Field(default=0, ge=0, le=100)
    wood_floor_systems: int = Field(default=0, ge=0, le=100)
    wood_floor_days: int = Field(default=7, ge=1, le=60)
    # Accepted only to load older drafts; new audits reject a selected legacy tier.
    package_price: str | None = Field(default=None, max_length=30)
    technician_notes: str = Field(default='', max_length=40000)
    technician_transcript: str = Field(default='', max_length=80000)
    assistant_transcript: str = Field(default='', max_length=80000)
    scope_confirmed: bool = False
    capture_metadata: CaptureMetadata | None = None
    # Absent on older drafts; clients retain approvals verbatim until they change an extra.
    extras: list[Extra] = Field(default_factory=list, max_length=30)
    # Added with QR tags; drafts saved before it stay without the key (see inspection_payload).
    equipment_scans: list[EquipmentScan] = Field(default_factory=list, max_length=200)
    # Owner-added items only (sources typed / typed_count_days). Absent on drafts saved before v2;
    # An unset value is left out of every dump, so a saved record never gains the key.
    scope_items: dict[Annotated[str, Field(pattern=ITEM_ID)], ScopeQuantity] | None = Field(
        default=None, max_length=150, exclude_if=lambda value: value is None
    )
    # The price table whose default quantities this job started from; absent otherwise, as above.
    seeded_from_version: str | None = Field(
        default=None, max_length=120, exclude_if=lambda value: value is None
    )
    # Estimator overrides of walkthrough-measured quantities; absent until set, as above.
    quantity_overrides: (
        dict[Annotated[str, Field(min_length=1, max_length=120)], QuantityOverride] | None
    ) = Field(default=None, max_length=150, exclude_if=lambda value: value is None)


def distinct_rooms(data: InspectionData):
    """Photos, shot lists and equipment scans are keyed by room name, so two rooms with one name
    would share them. Checked on saves only: stored drafts and signed records load as they are.
    Names compare as the app's roomKey does (public/core.js), ignoring case and extra spaces."""
    seen = set()
    for room in data.rooms:
        key = ' '.join(room.name.split()).lower()
        if key in seen:
            raise ValueError(
                f'Two rooms are named "{room.name.strip()}". Give each room its own name.'
            )
        seen.add(key)
    return data


OVERRIDE_JOB_FIELDS = frozenset(
    {
        'emergency_calls',
        'monitoring_hours',
        'haul_loads',
        'air_scrubbers',
        'hepa_filters',
        'matterport_scans',
        'dump_truck_loads',
        'equipment_decon',
        'power_distribution',
        'labor_hours',
        'air_movers',
        'dehumidifiers',
        'wood_floor_systems',
        'drying_days',
        'wood_floor_days',
    }
)
OVERRIDE_ROOM_FIELDS = frozenset({'unfinished_sf', 'finished_sf', 'floor_sf', 'wet_floor_sf'})


def check_quantity_overrides(data: InspectionData):
    """Each override must describe the job's current value, so a stale `entered` never reaches the
    owner. Keys are a job field, or "room name:field". A blank room area reads as 0, as on the phone.
    Checked on saves and audits only: stored records load as they are."""
    for key, override in (data.quantity_overrides or {}).items():
        room_name, separator, field = key.rpartition(':')
        if separator:
            room = next((r for r in data.rooms if r.name == room_name), None)
            if room is None or field not in OVERRIDE_ROOM_FIELDS:
                raise ValueError(f'The quantity override "{key}" does not match a room value.')
            current = getattr(room, field)
        elif key in OVERRIDE_JOB_FIELDS:
            current = getattr(data, key)
        else:
            raise ValueError(f'The quantity override "{key}" does not match a job value.')
        if abs(Decimal(str(current or 0)) - override.entered) >= Decimal('0.01'):
            raise ValueError(f'The quantity override "{key}" does not match the entered value.')
    return data


class CreateInspection(StrictModel):
    inspection_id: str = Field(pattern=r'^ADR-INS-[a-f0-9]{32}$')
    data: InspectionData = Field(default_factory=InspectionData)

    @model_validator(mode='after')
    def rooms_distinct(self):
        distinct_rooms(self.data)
        check_quantity_overrides(self.data)
        return self


class CopyRequest(StrictModel):
    inspection_id: str = Field(pattern=r'^ADR-INS-[a-f0-9]{32}$')


class UpdateInspection(StrictModel):
    expected_revision: int = Field(ge=1)
    data: InspectionData

    @model_validator(mode='after')
    def rooms_distinct(self):
        distinct_rooms(self.data)
        check_quantity_overrides(self.data)
        return self


class RevisionRequest(StrictModel):
    expected_revision: int = Field(ge=1)


class AuditRequest(RevisionRequest):
    inspection_id: str = Field(pattern=r'^ADR-INS-[a-f0-9]{32}$')


class AuthorizeRequest(AuditRequest):
    auth_id: str = Field(pattern=r'^ADR-AUTH-[A-Za-z0-9-]{6,64}$')
    proposal_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    signature_png: str = Field(min_length=1, max_length=3000000)
    documents_confirmed: Literal[True]
    # The on-site "Email me a copy of my signed documents." box. Absent on a client that predates
    # it: that is not a request, and nothing is backfilled onto an agreement already signed.
    email_copy: bool | None = None


class SigningLinkRequest(RevisionRequest):
    proposal_hash: str = Field(pattern=r'^[a-f0-9]{64}$')


def signer_name(value):
    value = ' '.join(value.split())
    if not value or any(not c.isprintable() for c in value):
        raise ValueError('Type your full name.')
    return value


class HomeownerSignature(StrictModel):
    signer_name: Annotated[str, Field(min_length=1, max_length=150), AfterValidator(signer_name)]
    signer_role: Literal['owner', 'authorized_representative']
    documents_reviewed: Literal[True]
    electronic_consent: Literal[True]
    # The statements the page showed; a page with older wording must reload before signing.
    consent_version: Literal['homeowner-link-v1']
    signature_png: str = Field(min_length=1, max_length=3000000)
    # The /sign page's "Email me a copy of my signed documents." box. Absent means the page
    # did not ask; a saved agreement is not backfilled.
    email_copy: bool | None = None


class PhotoLocation(StrictModel):
    """Where the phone said it was when the photo was taken. Only a 'device' fix carries
    coordinates; a refused or failed fix is recorded as such, never guessed or filled in later."""

    source: Literal['device', 'not_available', 'not_shared']
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    # Horizontal accuracy radius in meters, as the browser reports it.
    accuracy_m: float | None = Field(default=None, ge=0, le=1000000)

    @model_validator(mode='after')
    def fix_matches_source(self):
        fix = (self.latitude, self.longitude, self.accuracy_m)
        if self.source == 'device' and None in fix:
            raise ValueError('A device location needs latitude, longitude and accuracy.')
        if self.source != 'device' and any(value is not None for value in fix):
            raise ValueError('A location that was not recorded carries no coordinates.')
        return self


class PhotoUpload(RevisionRequest):
    photo_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    room: str = Field(min_length=1, max_length=100)
    captured_at: datetime
    data_url: str = Field(min_length=1, max_length=12000000)
    # Absent from older clients and photos saved before location stamps: "No location recorded".
    location: PhotoLocation | None = None


class PhotoRoomUpdate(RevisionRequest):
    """Moves an uploaded photo to another room of the same unsigned draft."""

    room: str = Field(min_length=1, max_length=100)


class ReadingBase(StrictModel):
    """One drying-log entry. Readings sit beside the inspection, never inside its priced
    revision, so a monitoring visit after signing records nothing that pricing or documents read."""

    # A saved room name, or '' for outside air and whole-job entries.
    room: str = Field(default='', max_length=100)
    # When the technician took the reading; the server stamps who saved it and when.
    taken_at: datetime
    note: str = Field(default='', max_length=500)


class AirReading(ReadingBase):
    kind: Literal['air']
    zone: Literal['outside', 'unaffected', 'affected', 'dehu_inlet', 'dehu_outlet'] = 'affected'
    temperature_f: float = Field(ge=-40, le=150)
    relative_humidity: float = Field(ge=1, le=100)


class MaterialReading(ReadingBase):
    kind: Literal['material']
    material: str = Field(min_length=1, max_length=100)
    moisture: float = Field(ge=0, le=1000)
    # Meters report different scales (%MC, %WME, relative pinless); the unit is the technician's.
    unit: str = Field(min_length=1, max_length=20)
    dry_standard: float | None = Field(default=None, ge=0, le=1000)
    affected: bool = True


class ThermalReading(ReadingBase):
    kind: Literal['thermal']
    delta_t_f: float = Field(ge=-200, le=200)
    pattern: Literal['cold_anomaly', 'thermal_bridge', 'evaporative_cooling'] = 'cold_anomaly'
    boundary: str = Field(default='', max_length=300)


DryingReading = Annotated[
    AirReading | MaterialReading | ThermalReading, Field(discriminator='kind')
]


class ReadingUpload(StrictModel):
    reading: DryingReading


class QrTagRequest(StrictModel):
    """Tag codes to render as QR images for a printed sheet; only DryScope tag codes are accepted."""

    codes: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(
        min_length=1, max_length=60
    )


class PhotoShotUpdate(RevisionRequest):
    """Tags an uploaded photo of an unsigned draft with a shot type, or clears the tag (null).
    Photos upload untagged and are tagged here, so an older backend still accepts every upload."""

    shot: Annotated[str, AfterValidator(known_shot)] | None


class VoiceNoteId(StrictModel):
    """A voice note reference reserved before capture or upload to clear an unsigned estimate."""

    note_id: str = Field(pattern=r'^[a-f0-9]{32}$')


class VoiceNoteUpload(StrictModel):
    """One offline voice note recorded on the phone; the audio is transcribed and never stored."""

    note_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    room: str = Field(default='', max_length=100)
    recorded_at: datetime
    # The phone's offset from UTC, so the transcript shows the technician's local recording time.
    utc_offset_minutes: int = Field(default=0, ge=-840, le=840)
    duration_seconds: float = Field(ge=0, le=660)
    mime_type: Literal['audio/mp4', 'audio/webm', 'audio/ogg']
    # Base64 of at most 10 MB of audio.
    audio_base64: str = Field(min_length=1, max_length=14_000_000)


class TranscriptionResult(StrictModel):
    text: str = Field(max_length=20000)


class OcrResult(StrictModel):
    meter_detected: bool
    meter_type: str = Field(max_length=100)
    value: str = Field(max_length=100)
    classification: str = Field(max_length=100)
    notes: str = Field(max_length=1000)


class AIResult(StrictModel):
    summary: str = Field(min_length=1, max_length=6000)
    suggestions: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=30)
    unpriced_work: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=30)
    testing_advice: list[Annotated[str, Field(max_length=1000)]] = Field(
        default_factory=list, max_length=10
    )


class PhotoLog(StrictModel):
    id: str
    room: str
    captured_at: str
    width: int
    height: int
    ocr_status: Literal['pending', 'verified', 'no_meter', 'failed']
    ocr: OcrResult | None
    location: PhotoLocation | None = None


class LineItem(StrictModel):
    code: str
    description: str
    quantity: float
    unit: str
    unit_price: float
    waste_percent: float
    total: float
    # Added with company price tables; documents audited before them omit it.
    xactimate_code: str | None = None


class Proposal(StrictModel):
    property_address: str
    # From job coordination when the audit ran; documents audited before this field omit it.
    customer_name: str = Field(default='', max_length=150)
    date: str
    # The high end, or the single price when estimate_mode is 'single'.
    proposed_cost: float = Field(gt=0)
    # Absent in single-price mode.
    proposed_cost_low: float | None = Field(default=None, gt=0)
    # Absent on documents priced before company price tables (they are always a range).
    estimate_mode: Literal['range', 'single'] | None = None
    lead_notice_required: bool
    findings: list[str]
    recommendations: list[str]
    disclaimers: list[str]


def one_line(value):
    # Claim values print inside document headers and the letter; a line break cannot add a line.
    return ' '.join(value.split())


def loss_date(value):
    value = value.strip()
    if value and date.fromisoformat(value) > date.today() + timedelta(days=1):
        raise ValueError('Date of loss cannot be in the future.')
    return value


def claim_email(value):
    value = value.strip().lower()
    if value and not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', value):
        raise ValueError('Enter a valid adjuster email address.')
    return value


def claim_text(size):
    return Annotated[str, Field(max_length=size), AfterValidator(one_line)]


class ClaimDetails(StrictModel):
    """Insurance claim and loss details from the job sidecar; every field is optional."""

    carrier: claim_text(150) = ''
    claim_number: claim_text(80) = ''
    policy_number: claim_text(80) = ''
    date_of_loss: Annotated[
        str, Field(max_length=10, pattern=r'^(\d{4}-\d{2}-\d{2})?$'), AfterValidator(loss_date)
    ] = ''
    loss_cause: claim_text(500) = ''
    adjuster_name: claim_text(150) = ''
    adjuster_email: Annotated[str, Field(max_length=254), AfterValidator(claim_email)] = ''
    adjuster_phone: claim_text(80) = ''
    deductible: claim_text(40) = ''


class CompanyIdentity(StrictModel):
    company_id: str
    version: int = Field(ge=1)
    name: str
    address: str
    phone: str
    email: str
    license: str
    signoff: str
    logo_data_url: str = ''
    # Retired; older company profiles may still carry it.
    water_heater_notice: str = ''


class RangePolicy(StrictModel):
    first_sf: int = Field(default=1000, ge=1, le=100000)
    first_percent: str = Field(default='50', min_length=1, max_length=10)
    beyond_percent: str = Field(default='20', min_length=1, max_length=10)


class AfterHoursPolicy(StrictModel):
    multiplier: str = Field(default='1.000', min_length=1, max_length=10)
    label: str = Field(default='After-hours adjustment', min_length=1, max_length=80)


class CabinetryPolicy(StrictModel):
    multiplier: str = Field(default='1.000', min_length=1, max_length=10)
    scope: Literal['finished_only', 'all_cat3'] = 'finished_only'


class SalesTaxPolicy(StrictModel):
    enabled: bool = False
    percent: str = Field(default='0', min_length=1, max_length=10)


class AssistPolicy(StrictModel):
    drying_days: int = 3
    range_method: Literal['cushion', 'uncertainty'] = 'cushion'
    extra_drying_days: int = 0
    hidden_damage_percent: dict[Literal['1', '2', '3'], str] = Field(
        default_factory=lambda: {'1': '0', '2': '0', '3': '0'}
    )


class PricingPolicy(StrictModel):
    estimate_mode: Literal['range', 'single'] = 'range'
    area_basis: Literal['demolition', 'wet_floor'] = 'demolition'
    range: RangePolicy = Field(default_factory=RangePolicy)
    after_hours: AfterHoursPolicy = Field(default_factory=AfterHoursPolicy)
    category_multipliers: dict[Literal['1', '2', '3'], str] = Field(
        default_factory=lambda: {'1': '1.000', '2': '1.000', '3': '1.000'}
    )
    cabinetry: CabinetryPolicy = Field(default_factory=CabinetryPolicy)
    minimum_job_charge: str = Field(default='0', min_length=1, max_length=12)
    overhead_profit_percent: str = Field(default='0', min_length=1, max_length=10)
    sales_tax: SalesTaxPolicy = Field(default_factory=SalesTaxPolicy)
    show_line_breakdown: bool = False
    # Absent on every table published before it, and left out of a dump so a saved document's bytes
    # and its proposal hash stay as they were signed.
    assist: AssistPolicy | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode='after')
    def check_policy_values(self):
        try:
            from .price_table import normalize_policy
        except ImportError:
            from price_table import normalize_policy
        normalized = normalize_policy(self.model_dump())
        self.range = RangePolicy(**normalized['range'])
        self.after_hours = AfterHoursPolicy(**normalized['after_hours'])
        self.category_multipliers = normalized['category_multipliers']
        self.cabinetry = CabinetryPolicy(**normalized['cabinetry'])
        self.minimum_job_charge = normalized['minimum_job_charge']
        self.overhead_profit_percent = normalized['overhead_profit_percent']
        self.sales_tax = SalesTaxPolicy(**normalized['sales_tax'])
        self.assist = AssistPolicy(**normalized['assist']) if 'assist' in normalized else None
        return self


def known_calculation(value):
    if value != 'dryscope-v2' and not known_calculation_version(value):
        raise ValueError('Unknown calculation version.')
    return value


class PriceBasis(StrictModel):
    """Rates or policy that produced one audit. Absent on documents priced before company price books."""

    company_id: str = Field(min_length=1, max_length=128)
    version_id: str = Field(min_length=1, max_length=128)
    sequence: int = Field(ge=0)
    content_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    calculation_version: Annotated[str, AfterValidator(known_calculation)]
    priced_at: str = Field(min_length=1, max_length=40)
    rates: dict[str, str] | None = None
    policy: PricingPolicy | None = None
    item_count: int | None = Field(default=None, ge=0, le=150)

    @model_validator(mode='after')
    def check_version_fields(self):
        if self.calculation_version == 'dryscope-v2':
            if self.policy is None or self.item_count is None or self.rates is not None:
                raise ValueError(
                    'dryscope-v2 PriceBasis requires policy and item_count without rates.'
                )
        else:
            if not self.rates or self.policy is not None or self.item_count is not None:
                raise ValueError('v1 PriceBasis requires rates without policy or item_count.')
        return self


class EstimateEnd(StrictModel):
    """One end of the estimate: the summary lines that add up to its total."""

    subtotal: float
    after_hours: float
    minimum_charge: float
    overhead_profit: float
    tax: float
    total: float


class EstimateSummary(StrictModel):
    """How a company price table produced the estimate; absent on documents priced before them."""

    mode: Literal['range', 'single']
    low: EstimateEnd
    high: EstimateEnd | None = None
    after_hours_label: str = Field(max_length=80)
    # Percent strings; '0' when the company has the adjustment off.
    after_hours_percent: str = Field(max_length=12)
    overhead_profit_percent: str = Field(max_length=12)
    sales_tax_percent: str = Field(max_length=12)
    # Under the amounts: the cushion-tier sentence in range mode, absent when there is no cushion
    # to name; the single-price sentence otherwise.
    explanation: str | None = Field(default=None, max_length=2000)
    show_line_breakdown: bool = False


class QuantityNote(StrictModel):
    """An estimator's override of a walkthrough-measured quantity, for the company owner only."""

    label: str = Field(max_length=120)
    room: str | None = Field(default=None, max_length=100)
    measured: float
    entered: float
    reason: str = Field(max_length=300)


class AuditDocuments(StrictModel):
    schema_version: Literal[3] = 3
    company_identity: CompanyIdentity | None = None
    company_setup_missing: list[str] = Field(default_factory=list)
    # The job's claim details when the audit ran; absent before claim details and without workspaces.
    claim: ClaimDetails | None = None
    adr_estimate: Proposal
    xactimate_scope: list[LineItem]
    xactimate_total: float = Field(gt=0)
    iicrc_defense_letter: str
    compliance_notes: list[str]
    photo_audit_log: list[PhotoLog]
    ai_summary: str
    ai_suggestions: list[str]
    unpriced_work: list[str]
    signable: bool
    pending_extras: int = 0
    price_basis: PriceBasis | None = None
    estimate: EstimateSummary | None = None
    # Owner-only (public_record, document and signing links remove it); absent when nothing was overridden.
    quantity_notes: list[QuantityNote] | None = None
