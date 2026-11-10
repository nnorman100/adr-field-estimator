import { describe, expect, it } from 'vitest';
import { requireEmulatorEnv } from './guard';

const { projectId, firestoreHost } = requireEmulatorEnv(process.env);
const documents = `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents`;
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

describe('Firestore emulator', () => {
  it('stores and returns a document in the demo project', async () => {
    const written = await fetch(`${documents}/harness?documentId=check-${Date.now()}`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ fields: { note: { stringValue: 'emulator harness' } } }),
    });
    expect(written.status).toBe(200);
    const { name } = (await written.json()) as { name: string };
    expect(name).toContain(`projects/${projectId}/`);

    const read = await fetch(`http://${firestoreHost}/v1/${name}`, { headers: ADMIN });
    expect(read.status).toBe(200);
    const document = (await read.json()) as { fields: { note: { stringValue: string } } };
    expect(document.fields.note.stringValue).toBe('emulator harness');
  });
});
