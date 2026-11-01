"""Pillow-backed image paths: photo decoding, model thumbnails, company logos and signatures.

These pin the behaviour the backend relies on from Pillow so a Pillow upgrade that changes
EXIF handling, thumbnailing, decompression-bomb checks or mode conversion fails here first.
"""

import asyncio, base64, hashlib, io, time
import pytest
from PIL import Image, ImageDraw
import backend.main as bm
import backend.workspaces as workspaces
from backend.inspection_store import Conflict
from backend.job_store import decode_image
from tests.fakes import FakeStore, png
from tests.test_backend import ID, data, sign_payload
from tests.test_inspection_store import audited

ORIENTATION = 0x0112  # EXIF tag: 6 means the stored pixels are rotated 90 degrees clockwise.


def encode(image, format, **options):
    output = io.BytesIO()
    image.save(output, format=format, **options)
    return output.getvalue()


def data_url(raw, subtype):
    return f'data:image/{subtype};base64,' + base64.b64encode(raw).decode()


def rotated_jpeg(size=(3200, 1600)):
    """A landscape JPEG whose EXIF orientation says the camera was held upright."""
    image = Image.new('RGB', size, 'white')
    ImageDraw.Draw(image).rectangle([0, 0, size[0] // 2, size[1]], fill='black')
    exif = Image.Exif()
    exif[ORIENTATION] = 6
    return encode(image, 'JPEG', exif=exif)


def decoded(raw):
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        return image.format, image.mode, image.size, image.getexif().get(ORIENTATION)


def test_photo_uploads_accept_png_jpeg_and_webp_and_report_their_type():
    image = Image.new('RGB', (64, 32), 'blue')
    for subtype, format in (('png', 'PNG'), ('jpeg', 'JPEG'), ('webp', 'WEBP')):
        raw, mime, extension = decode_image(data_url(encode(image, format), subtype))
        assert (mime, extension) == (f'image/{subtype}', subtype)
        assert decoded(raw)[2] == (64, 32)


def test_photo_uploads_reject_mismatched_damaged_and_oversized_images(monkeypatch):
    jpeg = encode(Image.new('RGB', (8, 8)), 'JPEG')
    with pytest.raises(ValueError, match='does not match its file type'):
        decode_image(data_url(jpeg, 'png'))
    truncated = encode(Image.new('RGB', (64, 64)), 'PNG')[:40]
    with pytest.raises(ValueError, match='damaged or cannot be decoded'):
        decode_image(data_url(truncated, 'png'))
    with pytest.raises(ValueError, match='PNG signature'):
        decode_image(data_url(jpeg, 'jpeg'), signature=True)
    wide = encode(Image.new('1', (2100, 2000), 1), 'PNG')
    # The pixel cap is reported as a damaged image; the limit itself is kept as the cause.
    with pytest.raises(ValueError, match='damaged or cannot be decoded') as caught:
        decode_image(data_url(wide, 'png'), signature=True)
    assert 'Signature exceeds 4 megapixels' in str(caught.value.__cause__)
    assert decode_image(data_url(wide, 'png'))[1] == 'image/png'
    # Pillow's own bomb warning is treated as corruption rather than left as a warning.
    monkeypatch.setattr(Image, 'MAX_IMAGE_PIXELS', 1000)
    with pytest.raises(ValueError, match='damaged or cannot be decoded'):
        decode_image(data_url(wide, 'png'))


def test_model_image_applies_exif_orientation_and_fits_a_jpeg_in_1600_pixels():
    part = bm.model_image(rotated_jpeg())
    assert part.inline_data.mime_type == 'image/jpeg'
    format, mode, size, orientation = decoded(part.inline_data.data)
    # Rotated upright (1600x3200), then thumbnailed to the 1600 box, with the EXIF tag dropped.
    assert (format, mode, size, orientation) == ('JPEG', 'RGB', (800, 1600), None)
    with Image.open(io.BytesIO(part.inline_data.data)) as image:
        # The black half of the landscape frame becomes the top of the upright portrait.
        assert image.getpixel((400, 10))[0] < 40 and image.getpixel((400, 1590))[0] > 215


def test_model_image_prepares_a_full_job_of_large_phone_photos_well_inside_the_audit_deadline():
    # A 48-megapixel phone original just under the 8 MB upload cap, sized like a full 60-photo job.
    noise = [Image.effect_noise((480, 360), sigma) for sigma in (40, 50, 60)]
    photo = Image.merge('RGB', noise).resize((8000, 6000), Image.Resampling.BICUBIC)
    raw = encode(photo, 'JPEG', quality=90)
    assert len(raw) <= 8 * 1024 * 1024
    started = time.perf_counter()
    parts = [bm.model_image(raw) for _ in range(60)]
    elapsed = time.perf_counter() - started
    assert elapsed < bm.REST_DEADLINE_SECONDS / 3, f'{elapsed:.1f}s to prepare 60 photos'
    assert decoded(parts[-1].inline_data.data)[:3] == ('JPEG', 'RGB', (1600, 1200))


def test_model_image_fits_a_very_elongated_jpeg_without_a_zero_sized_draft():
    part = bm.model_image(encode(Image.new('RGB', (4000, 2), 'gray'), 'JPEG'))
    assert decoded(part.inline_data.data)[:3] == ('JPEG', 'RGB', (1600, 1))


def test_model_image_flattens_transparent_png_photos_to_rgb_jpeg():
    raw = base64.b64decode(png().partition(',')[2])
    part = bm.model_image(raw)
    assert decoded(part.inline_data.data)[:3] == ('JPEG', 'RGB', (120, 60))


def test_company_logo_is_normalized_to_a_small_upright_jpeg():
    assert workspaces.clean_logo('') == ''
    logo = workspaces.clean_logo(data_url(rotated_jpeg((1024, 512)), 'jpeg'))
    assert logo.startswith('data:image/jpeg;base64,')
    raw = base64.b64decode(logo.partition(',')[2])
    assert decoded(raw) == ('JPEG', 'RGB', (96, 192), None)
    assert len(raw) <= 100000
    transparent = workspaces.clean_logo(png())
    assert decoded(base64.b64decode(transparent.partition(',')[2]))[1:3] == ('RGB', (120, 60))


def test_company_logo_rejects_other_formats_bombs_and_damaged_data():
    with pytest.raises(ValueError, match='PNG or JPEG'):
        workspaces.clean_logo(data_url(encode(Image.new('RGB', (8, 8)), 'WEBP'), 'webp'))
    with pytest.raises(ValueError, match='exceeds 4 megapixels'):
        workspaces.clean_logo(data_url(encode(Image.new('1', (2100, 2000), 1), 'PNG'), 'png'))
    with pytest.raises(ValueError, match='could not be read'):
        workspaces.clean_logo(data_url(b'\x89PNG\r\n\x1a\nnot really', 'png'))
    with pytest.raises(ValueError, match='exceeds 1 MB'):
        workspaces.clean_logo(data_url(b'\x00' * 1000001, 'png'))


def test_invitation_logo_measures_the_saved_image_for_the_email_header():
    logo = workspaces.clean_logo(data_url(rotated_jpeg((1024, 512)), 'jpeg'))
    company = {'company_id': 'other', 'profile': {'name': 'Kern', 'logo_data_url': logo}}
    measured = workspaces.invitation_logo(company)
    assert measured['subtype'] == 'jpeg' and decoded(measured['data'])[2] == (96, 192)
    assert (measured['width'], measured['height']) == (32, 64)


def test_uploaded_photo_records_its_pixel_dimensions():
    store = FakeStore()
    record = store.create_inspection('owner', ID, data())
    raw = encode(Image.new('RGB', (640, 480), 'white'), 'JPEG')
    upload = dict(
        expected_revision=record['revision'],
        photo_id='d' * 32,
        room='Bathroom',
        captured_at='2026-10-06T19:00:00Z',
        data_url=data_url(raw, 'jpeg'),
    )
    (photo,) = store.add_photo('owner', ID, upload)['photos']
    assert (photo['width'], photo['height']) == (640, 480)
    assert photo['file']['content_type'] == 'image/jpeg'
    assert list(store.bucket.objects.values())[0][0] == raw


def test_signature_ink_is_detected_on_opaque_and_transparent_canvases():
    store = FakeStore()
    record = audited(store)
    # A nearly transparent stroke flattens to light gray on white and does not count as ink.
    faint = Image.new('RGBA', (120, 60), (255, 255, 255, 0))
    ImageDraw.Draw(faint).line([(10, 35), (105, 15)], fill=(0, 0, 0, 40), width=3)
    payload = {**sign_payload(record), 'signature_png': data_url(encode(faint, 'PNG'), 'png')}
    with pytest.raises(ValueError, match='Draw a signature'):
        store.authorize('owner', payload)
    assert not store.bucket.objects
    opaque = Image.new('RGB', (120, 60), 'white')
    ImageDraw.Draw(opaque).line([(10, 35), (105, 15)], fill='black', width=3)
    payload['signature_png'] = data_url(encode(opaque, 'PNG'), 'png')
    assert store.authorize('owner', payload)['status'] == 'saved'
    assert len(store.bucket.objects) == 1


def upload_photo(store, raw, subtype='jpeg', photo_id='c' * 32):
    record = store.create_inspection('owner', ID, data())
    store.add_photo(
        'owner',
        ID,
        dict(
            expected_revision=record['revision'],
            photo_id=photo_id,
            room='Bathroom',
            captured_at='2026-10-06T19:00:00Z',
            data_url=data_url(raw, subtype),
        ),
    )
    return store.get_inspection('owner', ID)['photos'][0]


def test_upload_stores_an_upright_1600_pixel_jpeg_beside_the_original():
    store = FakeStore()
    original = rotated_jpeg()
    photo = upload_photo(store, original)
    # The original is untouched and keeps its own reference and hash.
    assert store.bucket.objects[photo['file']['path']][0] == original
    assert (photo['width'], photo['height']) == (3200, 1600)
    copy = photo['model_file']
    # Deterministic name beside the original, a JPEG reference with the copy's own hash.
    assert copy['path'] == photo['file']['path'].rpartition('.')[0] + '-1600.jpg'
    assert copy['content_type'] == 'image/jpeg'
    raw, content_type = store.bucket.objects[copy['path']]
    assert content_type == 'image/jpeg'
    assert hashlib.sha256(raw).hexdigest() == copy['sha256']
    assert decoded(raw) == ('JPEG', 'RGB', (800, 1600), None)
    assert len(store.bucket.objects) == 2


def test_upload_keeps_png_and_webp_photos_and_adds_a_jpeg_copy_for_each():
    for subtype, format in (('png', 'PNG'), ('webp', 'WEBP')):
        store = FakeStore()
        photo = upload_photo(store, encode(Image.new('RGB', (200, 100), 'red'), format), subtype)
        assert photo['file']['content_type'] == f'image/{subtype}'
        assert decoded(store.bucket.objects[photo['model_file']['path']][0])[:3] == (
            'JPEG',
            'RGB',
            (200, 100),
        )


def test_upload_validation_is_unchanged_and_a_rejected_photo_stores_nothing():
    store = FakeStore()
    record = store.create_inspection('owner', ID, data())
    upload = dict(
        expected_revision=record['revision'],
        photo_id='d' * 32,
        room='Bathroom',
        captured_at='2026-10-06T19:00:00Z',
    )
    with pytest.raises(ValueError, match='does not match its file type'):
        store.add_photo('owner', ID, {**upload, 'data_url': data_url(rotated_jpeg(), 'png')})
    with pytest.raises(ValueError, match='photo limit is 8 MB'):
        store.add_photo(
            'owner', ID, {**upload, 'data_url': data_url(b'\xff\xd8\xff' * 3_000_000, 'jpeg')}
        )
    assert not store.bucket.objects


def upload_failing(store, fail):
    """Adds a photo while fail(key, blob) runs after each object upload."""
    record = store.create_inspection('owner', ID, data())
    real = store.bucket.blob

    def blob(key):
        stored = real(key)
        upload = stored.upload_from_string

        def upload_then_fail(*args, **kwargs):
            upload(*args, **kwargs)
            fail(key)

        stored.upload_from_string = upload_then_fail
        return stored

    store.bucket.blob = blob
    store.add_photo(
        'owner',
        ID,
        dict(
            expected_revision=record['revision'],
            photo_id='e' * 32,
            room='Bathroom',
            captured_at='2026-10-06T19:00:00Z',
            data_url=data_url(rotated_jpeg((64, 64)), 'jpeg'),
        ),
    )


def test_a_failed_save_removes_both_the_original_and_its_copy():
    store = FakeStore()

    def concurrent_edit(key):
        if key.endswith('-1600.jpg'):
            store.db.records[f'inspections/{ID}']['revision'] += 1

    with pytest.raises(Conflict):
        upload_failing(store, concurrent_edit)
    assert not store.get_inspection('owner', ID)['photos']
    assert not store.bucket.objects


def test_a_failed_copy_upload_removes_the_original_and_any_partly_written_copy():
    store = FakeStore()

    def lost_response(key):
        if key.endswith('-1600.jpg'):
            raise TimeoutError('response lost after the write')

    with pytest.raises(TimeoutError):
        upload_failing(store, lost_response)
    assert not store.get_inspection('owner', ID)['photos']
    assert not store.bucket.objects


def test_store_photo_serves_the_copy_for_the_model_and_the_original_otherwise():
    store = FakeStore()
    original = rotated_jpeg()
    photo = upload_photo(store, original)
    assert store.photo('owner', ID, photo['id'])[1] == original
    _, raw = store.photo('owner', ID, photo['id'], True)
    assert raw == store.bucket.objects[photo['model_file']['path']][0] != original


def test_older_photos_without_a_copy_fall_back_to_the_original():
    store = FakeStore()
    original = rotated_jpeg()
    photo = upload_photo(store, original)
    key = f'inspections/{ID}'
    del store.db.records[key]['photos'][0]['model_file']
    assert store.photo('owner', ID, photo['id'], True)[1] == original


def test_a_missing_copy_object_falls_back_to_the_original():
    store = FakeStore()
    original = rotated_jpeg()
    photo = upload_photo(store, original)
    del store.bucket.objects[photo['model_file']['path']]
    assert store.photo('owner', ID, photo['id'], True)[1] == original


def test_audit_downloads_the_copy_when_present_and_the_original_for_older_photos():
    store = FakeStore()
    original = rotated_jpeg()
    new = upload_photo(store, original)
    old_id = 'f' * 32
    store.add_photo(
        'owner',
        ID,
        dict(
            expected_revision=store.get_inspection('owner', ID)['revision'],
            photo_id=old_id,
            room='Bathroom',
            captured_at='2026-10-06T19:01:00Z',
            data_url=data_url(original + b'', 'jpeg'),
        ),
    )
    del store.db.records[f'inspections/{ID}']['photos'][1]['model_file']
    photos = store.get_inspection('owner', ID)['photos']
    sent = asyncio.run(bm.model_photos(store, 'owner', ID, photos))
    # Both reach the model as the same upright 1600 px JPEG; only the bytes read differ.
    for part in sent:
        assert decoded(part.inline_data.data) == ('JPEG', 'RGB', (800, 1600), None)
    # The stored copy is sent byte for byte, not re-encoded.
    assert sent[0].inline_data.data == store.bucket.objects[new['model_file']['path']][0]
    assert sent[1].inline_data.data != original
    read = []
    real = store.bucket.blob
    store.bucket.blob = lambda key: (read.append(key), real(key))[1]
    asyncio.run(bm.model_photos(store, 'owner', ID, photos))
    assert sorted(read) == sorted([new['model_file']['path'], photos[1]['file']['path']])
