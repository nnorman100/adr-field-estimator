"""Times backend.main.model_image on 60 max-size phone JPEGs, against the same prep without draft decode."""
import io, sys, time
sys.path.insert(0, sys.argv[1])
from PIL import Image, ImageOps
import backend.main as bm

noise = [Image.effect_noise((480, 360), s) for s in (40, 50, 60)]
photo = Image.merge('RGB', noise).resize((8000, 6000), Image.Resampling.BICUBIC)
buf = io.BytesIO(); photo.save(buf, 'JPEG', quality=90); raw = buf.getvalue()
print(f'photo: 8000x6000 JPEG, {len(raw)/1048576:.2f} MB (cap 8 MB)')

def no_draft(raw):
    with Image.open(io.BytesIO(raw)) as image:
        image = ImageOps.exif_transpose(image).convert('RGB'); image.thumbnail((1600, 1600))
        out = io.BytesIO(); image.save(out, 'JPEG', quality=85); return out.getvalue()

for name, fn in [('model_image (draft decode, this change)', bm.model_image), ('full decode (previous prep)', no_draft)]:
    t = time.perf_counter(); [fn(raw) for _ in range(60)]; e = time.perf_counter() - t
    print(f'{name}: 60 photos in {e:.1f}s ({e/60*1000:.0f} ms/photo); audit deadline {bm.REST_DEADLINE_SECONDS}s')
