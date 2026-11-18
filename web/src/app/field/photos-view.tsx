'use client';

import { useEffect, useRef, useState } from 'react';
import { notePhoto, photoSent } from '@/lib/field/unsent';
import { settle } from '@/lib/field-db';
import { journaledEdit } from '@/lib/field/journal-sync';
import { Button } from '@/components/ui/button';
import { photoAddress, sendPhoto, SHOT_NAMES } from '@/lib/field/api';
import { pending as unsent, usePending, type PendingPhoto } from '@/lib/field/pending';
import { preparePhoto } from '@/lib/field/photo';
import { MAX_PHOTO_REFS, SHOT_TAGS, type PhotoField } from '@/lib/field/schema';
import { draftDocs, fieldRefusal, photoRefWrites, type FieldDraft } from '@/lib/field/store';
import type { FieldClient } from '@/lib/field-db';
import type { JobContext } from './job-screens';
import { Choice, Outcome, Section } from './ui';

const SHOT_OPTIONS = [{ value: '', label: 'Not tagged' }, ...SHOT_TAGS.map((tag) => ({ value: tag, label: SHOT_NAMES[tag] }))];

function fieldOf(roomId: string, shotTag: string, capturedAt: string): PhotoField {
  return {
    ...(roomId ? { roomId } : {}),
    ...(shotTag ? { shotTag: shotTag as PhotoField['shotTag'] & string } : {}),
    capturedAt,
  };
}

// A photo's reference is saved (its own send, or Try again from the sync chip's sheet): it leaves the
// photos being sent, and no longer holds the unsent mark.
export function photoReferenceSaved(client: FieldClient, jobId: string, photoId: string): void {
  unsent.removePhoto(jobId, photoId);
  photoSent(client.person.tenantId, client.person.uid, photoId);
  void settle(client).catch(() => undefined);
}

// Photos (S5a-6): the camera, a room and a shot tag for each photo, and the job's photos. A photo's
// bytes go to the photo route (S5a-5) first; its reference (room and shot tag) is written to the
// field draft only once the server holds the bytes.
export function PhotosView({ job, draft, open }: { job: JobContext; draft: FieldDraft; open: boolean }) {
  const [roomId, setRoomId] = useState('');
  const [shotTag, setShotTag] = useState('');
  // Photos sent and not yet settled, kept for the life of the page (src/lib/field/pending.ts), so
  // leaving this screen never drops one: its id and bytes stay for "Send again".
  const jobId = job.jobId;
  const pending = usePending(() => unsent.photos(jobId));
  // Whether this screen is still open when a send settles.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const canTake = job.editable && job.session.capabilities.includes('photos') && job.session.online;
  // A capture already opened keeps its input: the camera app hides this page, which takes the
  // connection away until it is shown again, and the picture must still reach this page.
  const [capturing, setCapturing] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  // Once the field work moved away from this person nothing more is taken or sent from here (J5): the
  // photos stay on screen, read only. So too once the job is archived (S5b-2).
  const cameraShown = canTake || (capturing && !job.moved && !job.archived);
  useEffect(() => {
    const input = camera.current;
    if (!input) return;
    const cancel = () => setCapturing(false);
    input.addEventListener('cancel', cancel);
    return () => input.removeEventListener('cancel', cancel);
  }, [cameraShown]);
  // Photos on the draft and those of this page not yet on it: the server refuses past the cap.
  const held = draft.photos.length + pending.filter((item) => !draft.photos.some((photo) => photo.id === item.id)).length;
  const full = held >= MAX_PHOTO_REFS;
  const roomOptions = [{ value: '', label: 'No room' }, ...draft.rooms.map((room) => ({ value: room.id, label: room.field.name ?? 'Room' }))];
  const roomName = (id: string | undefined) => draft.rooms.find((room) => room.id === id)?.field.name ?? null;

  const update = (id: string, change: Partial<PendingPhoto>) => unsent.updatePhoto(jobId, id, change);

  async function finish(item: PendingPhoto) {
    const db = job.session.db;
    if (job.moved) return update(item.id, { step: 'send-failed', message: 'Not sent: another person now owns this job’s field work.' });
    if (job.archived) return update(item.id, { step: 'send-failed', message: 'Not sent: this job is archived.' });
    if (!db || !job.session.online) return update(item.id, { step: 'send-failed', message: 'Needs a connection. Send it again when connected.' });
    update(item.id, { step: 'sending', message: undefined });
    const sent = await sendPhoto(job.session.user, jobId, item.id, item.bytes);
    if (!sent.ok) {
      update(item.id, { step: 'send-failed', message: sent.message });
      return job.checkAccess(sent);
    }
    update(item.id, { step: 'saving' });
    try {
      const writes = photoRefWrites(job.draftRef, item.id, item.field);
      const { acknowledged } = await journaledEdit(job.session.client, job.draftRef, writes, jobId, draftDocs(job.draftRef, draft));
      await acknowledged;
      // The screen that sent it may have closed since: then the open one is told to read the draft.
      if (live.current) await job.reloadDraft();
      else unsent.draftChanged(jobId);
      photoReferenceSaved(job.session.client, jobId, item.id);
    } catch (error) {
      update(item.id, { step: 'save-failed', message: 'The photo is stored but its room and tag were not saved. Save again.' });
      job.checkAccess(fieldRefusal(error));
    }
  }

  async function take(file: File | undefined) {
    setError(null);
    if (!file || job.moved || job.archived) return;
    const capturedAt = new Date().toISOString();
    const bytes = await preparePhoto(file);
    if (!bytes) return setError('This picture could not be read. Take the photo with the camera.');
    const item: PendingPhoto = { id: crypto.randomUUID(), bytes, field: fieldOf(roomId, shotTag, capturedAt), step: 'sending' };
    if (!notePhoto(job.session.client.person.tenantId, job.session.user.uid, item.id)) {
      return setError('This phone could not record the photo as unsent. Try again.');
    }
    unsent.addPhoto(jobId, item);
    await finish(item);
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="sr-only">Photos</h3>
      {!job.session.online ? <p role="status">Needs a connection to send photos. Keep this window open until every photo is sent.</p> : null}
      {cameraShown ? (
        <Section title="Take a photo">
          <Choice id="photo-room" label="Room" value={roomId} options={roomOptions} onChange={setRoomId} />
          <Choice id="photo-shot" label="Shot" value={shotTag} options={SHOT_OPTIONS} onChange={setShotTag} />
          <label
            htmlFor="photo-camera"
            className={`inline-flex h-12 items-center justify-center rounded-md bg-primary px-6 text-base font-medium text-primary-foreground focus-within:ring-2 focus-within:ring-ring ${full ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
          >
            Take photo
            <input
              id="photo-camera"
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              ref={camera}
              onClick={() => setCapturing(true)}
              disabled={full}
              aria-describedby={full ? 'photo-limit' : undefined}
              onChange={(event) => {
                setCapturing(false);
                const file = event.target.files?.[0];
                event.target.value = '';
                void take(file);
              }}
            />
          </label>
          {full ? (
            <p id="photo-limit" className="text-sm">
              This job has the most photos it can hold ({MAX_PHOTO_REFS}).
            </p>
          ) : null}
        </Section>
      ) : null}
      <Outcome error={error} notice={null} />
      {pending.length > 0 ? (
        <Section title="Sending">
          <ul className="flex flex-col gap-2" aria-label="Photos being sent">
            {pending.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
                <p role="status">{item.step === 'sending' ? 'Sending the photo…' : item.step === 'saving' ? 'Saving its room and tag…' : 'Not sent yet.'}</p>
                {item.message ? <p role="alert">{item.message}</p> : null}
                {item.step === 'send-failed' || item.step === 'save-failed' ? (
                  <Button variant="outline" disabled={!job.session.online || job.moved || job.archived} onClick={() => void finish(item)}>
                    Send again
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title={`Job photos (${draft.photos.length})`}>
        {draft.photos.length === 0 ? <p>No photos yet.</p> : null}
        <ul className="grid grid-cols-2 gap-3" aria-label="Job photos">
          {draft.photos.map((photo, index) => (
            <li key={photo.id} className="flex flex-col gap-1">
              <Thumbnail
                job={job}
                load={open}
                photoId={photo.id}
                label={`Photo ${index + 1}${roomName(photo.field.roomId) ? `, ${roomName(photo.field.roomId)}` : ''}${photo.field.shotTag ? `, ${SHOT_NAMES[photo.field.shotTag]}` : ''}`}
              />
              <p className="text-sm">
                {roomName(photo.field.roomId) ?? 'No room'} · {photo.field.shotTag ? SHOT_NAMES[photo.field.shotTag] : 'Not tagged'}
              </p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// The photo's bytes through the photo route, which checks this person may see the job. They are
// fetched only while Photos is the open view (`load`), and kept once fetched; one that could not be
// fetched is fetched again on "Try again".
function Thumbnail({ job, load, photoId, label }: { job: JobContext; load: boolean; photoId: string; label: string }) {
  const [address, setAddress] = useState<string | null | 'missing'>(null);
  const fetching = load && address === null;
  const { checkAccess } = job;
  useEffect(() => {
    if (!fetching) return;
    let live = true;
    void photoAddress(job.session.user, job.jobId, photoId).then((found) => {
      if (typeof found === 'string') {
        if (live) setAddress(found);
        else URL.revokeObjectURL(found);
        return;
      }
      if (live) setAddress('missing');
      checkAccess(found);
    });
    return () => {
      live = false;
    };
  }, [fetching, job.session.user, job.jobId, photoId, checkAccess]);
  useEffect(
    () => () => {
      if (address !== null && address !== 'missing') URL.revokeObjectURL(address);
    },
    [address],
  );
  if (address === null) return <div className="aspect-square rounded-md bg-foreground/10" role="img" aria-label={`${label}, loading`} />;
  if (address === 'missing')
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-md bg-foreground/10 p-2 text-sm">
        <p>{label}, not available.</p>
        <Button variant="outline" onClick={() => setAddress(null)}>
          Try again
        </Button>
      </div>
    );
  // eslint-disable-next-line @next/next/no-img-element -- a local object address; the image optimiser cannot fetch it
  return <img src={address} alt={label} className="aspect-square w-full rounded-md object-cover" />;
}
