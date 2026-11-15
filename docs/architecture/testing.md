# Architecture: Testing layers

Part of [Architecture](../ARCHITECTURE.md).

## Testing layers

Python (`tests/`), JS (`npm test`), Playwright browser suite with fake cloud adapters, Firestore emulator job, and real-service checks recorded separately. Device behavior (iPhone camera, mic, Bluetooth, latency) stays open until observed on a device.

The accepted rebuild's future authority boundaries and submit fence are in [Data ownership](../data-ownership.md); the code-derived current collection and object manifest is in [Legacy data inventory](../legacy-data-inventory.md). These documents describe the planned rebuild, not current runtime authority. They are a partial rebuild-stage S1 slice (ownership map, submit protocol and legacy inventory); the S1 spec, AI prompt and model pinning, and golden parity baseline arrive in separate S1 pull requests.
