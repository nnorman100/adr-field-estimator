# Fixture digests for the mocked tests. Not real images.
api_image  = "us-central1-docker.pkg.dev/dryscope/dryscope-test/web@sha256:0000000000000000000000000000000000000000000000000000000000000000"
live_image = "us-central1-docker.pkg.dev/dryscope/dryscope-test/live@sha256:1111111111111111111111111111111111111111111111111111111111111111"

# Stand-in App Check values (TC-5), not real ones, so every mocked plan (and the committed plan
# web/tests/unit/settings-contract.test.ts reads) shows the services' App Check settings. A real
# apply passes its own or none (App Check off).
firebase_app_id    = "1:000000000000:web:0000000000e2e000"
app_check_site_key = "stand-in-recaptcha-site-key-0000"
