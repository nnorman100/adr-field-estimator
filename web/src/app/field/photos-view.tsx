'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { photoAddress, sendPhoto, SHOT_NAMES } from '@/lib/field/api';
import { pending as unsent, usePending, type PendingPhoto } from '@/lib/field/pending';
import { preparePhoto } from '@/lib/field/photo';
import { SHOT_TAGS, type PhotoField } from '@/lib/field/schema';
import { savePhotoRef, type FieldDraft } from '@/lib/field/store';
import type { JobContext } from './job-screens';
import { Choice, Outcome, Section } from './ui';

const SHOT_OPTIONS = [{ value: '', label: 'Not tagged' }, ...SHOT_TAGS.map((tag) => ({ value: tag, label: SHOT_NAMES[tag] }))];

function fieldOf(roomId: string, shotTag: string): PhotoField {
  return {
    ...(roomId ? { roomId } : {}),
    ...(shotTag ? { shotTag: shotTag as PhotoField['shotTag'] & string } : {}),
  };
}

// Photos (S5a-6): the camera, a room and a shot tag for each photo, and the job's photos. A photo's
// bytes go to the photo route (S5a-5) first; its reference (room and shot tag) is written to the
// field draft only once the server holds the bytes.
export function PhotosView({ job, draft, open }: { job: JobContext; draft: FieldDraft; open: boolean }) {
  const [roomId, setRoomId] = useState('');
  const [shotTag, setShotTag] = useState('');
  // Photos sent and not yet settled, kept for the life of the page (src/lib/field/pending.ts), so
  // leaving this screen never drops one: its id and bytes stay for "Send again".
  const jobId = job.detail.job.id;
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
  const canTake = job.editable && job.session.capabilities.includes('photos');
  const roomOptions = [{ value: '', label: 'No room' }, ...draft.rooms.map((room) => ({ value: room.id, label: room.field.name ?? 'Room' }))];
  const roomName = (id: string | undefined) => draft.rooms.find((room) => room.id === id)?.field.name ?? null;

  const update = (id: string, change: Partial<PendingPhoto>) => unsent.updatePhoto(jobId, id, change);

  async function finish(item: PendingPhoto) {
    const db = job.session.db;
    if (!db) return;
    update(item.id, { step: 'sending', message: undefined });
    const sent = await sendPhoto(job.session.user, jobId, item.id, item.bytes);
    if (!sent.ok) return update(item.id, { step: 'send-failed', message: sent.message });
    update(item.id, { step: 'saving' });
    try {
      await savePhotoRef(db, job.draftRef, item.id, item.field);
      // The screen that sent it may have closed since: then the open one is told to read the draft.
      if (live.current) await job.reloadDraft();
      else unsent.draftChanged(jobId);
      unsent.removePhoto(jobId, item.id);
    } catch {
      update(item.id, { step: 'save-failed', message: 'The photo is stored but its room and tag were not saved. Save again.' });
    }
  }

  async function take(file: File | undefined) {
    setError(null);
    if (!file) return;
    const bytes = await preparePhoto(file);
    if (!bytes) return setError('This picture could not be read. Take the photo with the camera.');
    const item: PendingPhoto = { id: crypto.randomUUID(), bytes, field: fieldOf(roomId, shotTag), step: 'sending' };
    unsent.addPhoto(jobId, item);
    await finish(item);
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="sr-only">Photos</h3>
      {canTake ? (
        <Section title="Take a photo">
          <Choice id="photo-room" label="Room" value={roomId} options={roomOptions} onChange={setRoomId} />
          <Choice id="photo-shot" label="Shot" value={shotTag} options={SHOT_OPTIONS} onChange={setShotTag} />
          <label
            htmlFor="photo-camera"
            className="inline-flex h-12 cursor-pointer items-center justify-center rounded-md bg-primary px-6 text-base font-medium text-primary-foreground focus-within:ring-2 focus-within:ring-ring"
          >
            Take photo
            <input
              id="photo-camera"
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void take(file);
              }}
            />
          </label>
          <Outcome error={error} notice={null} />
        </Section>
      ) : null}
      {pending.length > 0 ? (
        <Section title="Sending">
          <ul className="flex flex-col gap-2" aria-label="Photos being sent">
            {pending.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
                <p role="status">{item.step === 'sending' ? 'Sending the photo…' : item.step === 'saving' ? 'Saving its room and tag…' : 'Not sent yet.'}</p>
                {item.message ? <p role="alert">{item.message}</p> : null}
                {item.step === 'send-failed' || item.step === 'save-failed' ? (
                  <Button variant="outline" onClick={() => void finish(item)}>
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
  useEffect(() => {
    if (!fetching) return;
    let live = true;
    void photoAddress(job.session.user, job.detail.job.id, photoId).then((found) => {
      if (live) setAddress(found ?? 'missing');
      else if (found) URL.revokeObjectURL(found);
    });
    return () => {
      live = false;
    };
  }, [fetching, job.session.user, job.detail.job.id, photoId]);
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
