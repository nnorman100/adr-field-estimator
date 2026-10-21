"""Validated inspection inputs; money is calculated exclusively by the rate book."""

from datetime import datetime
from typing import Literal, Annotated
from pydantic import AfterValidator, BaseModel, ConfigDict, Field


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
    # absent until stated; floor area is the room's floor, never the priced demolition area.
    floor_sf: float | None = Field(default=None, gt=0, le=100000)
    ceiling_height_ft: float | None = Field(default=None, gt=0, le=60)
    water_class: Literal[1, 2, 3, 4] | None = None


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


class InspectionData(StrictModel):
    address: str = Field(default='', max_length=500)
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
    # Added with QR tags; drafts saved before it stay without the key (see inspection_payload).
    equipment_scans: list[EquipmentScan] = Field(default_factory=list, max_length=200)


class CreateInspection(StrictModel):
    inspection_id: str = Field(pattern=r'^ADR-INS-[a-f0-9]{32}$')
    data: InspectionData = Field(default_factory=InspectionData)


class UpdateInspection(StrictModel):
    expected_revision: int = Field(ge=1)
    data: InspectionData


class RevisionRequest(StrictModel):
    expected_revision: int = Field(ge=1)


class AuditRequest(RevisionRequest):
    inspection_id: str = Field(pattern=r'^ADR-INS-[a-f0-9]{32}$')


class AuthorizeRequest(AuditRequest):
    auth_id: str = Field(pattern=r'^ADR-AUTH-[A-Za-z0-9-]{6,64}$')
    proposal_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    signature_png: str = Field(min_length=1, max_length=3000000)
    documents_confirmed: Literal[True]


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


class PhotoUpload(RevisionRequest):
    photo_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    room: str = Field(min_length=1, max_length=100)
    captured_at: datetime
    data_url: str = Field(min_length=1, max_length=12000000)


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


class LineItem(StrictModel):
    code: str
    description: str
    quantity: float
    unit: str
    unit_price: float
    waste_percent: float
    total: float


class Proposal(StrictModel):
    property_address: str
    # From job coordination when the audit ran; documents audited before this field omit it.
    customer_name: str = Field(default='', max_length=150)
    date: str
    proposed_cost: float = Field(gt=0)
    proposed_cost_low: float = Field(gt=0)
    lead_notice_required: bool
    findings: list[str]
    recommendations: list[str]
    disclaimers: list[str]


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


class AuditDocuments(StrictModel):
    schema_version: Literal[3] = 3
    company_identity: CompanyIdentity | None = None
    company_setup_missing: list[str] = Field(default_factory=list)
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
