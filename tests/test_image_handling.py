"""Pillow-backed image paths: photo decoding, model thumbnails, company logos and signatures.

These pin the behaviour the backend relies on from Pillow so a Pillow upgrade that changes
EXIF handling, thumbnailing, decompression-bomb checks or mode conversion fails here first.
"""

import base64, io
import pytest
from PIL import Image, ImageDraw
import backend.main as bm
import backend.workspaces as workspaces
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
