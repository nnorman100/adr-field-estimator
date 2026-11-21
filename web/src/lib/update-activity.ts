// `unsent`: a form of this window holds input nobody has saved, sent or discarded.
type Kind = 'camera' | 'save' | 'upload' | 'unsent';

const counts = { camera: 0, save: 0, upload: 0, unsent: 0 };
let required = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const UPDATE_WORK = 'ds-update-work:';
// Held shared while a window takes its hold and exclusive while an update activates the waiting
// worker, so protected work either shows in the activation's check or waits for it to finish.
const UPDATE_ADMISSION = 'ds-update-admission';
let windowLock: string | undefined;

type Hold = { release: () => void; admitted: Promise<void> };

// All activity in this window shares its name. Closing the window releases its locks.
function takeWindowHold(): Hold {
  if (typeof window === 'undefined' || !navigator.locks) return { release: () => undefined, admitted: Promise.resolve() };
  const { locks } = navigator;
  const name = (windowLock ??= UPDATE_WORK + crypto.randomUUID());
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => { release = done; });
  const admitted = locks
    .request(UPDATE_ADMISSION, { mode: 'shared' }, () => new Promise<void>((granted) => {
      locks.request(name, { mode: 'shared' }, () => { granted(); return held; }).catch(granted);
    }))
    .then(() => undefined, () => undefined);
  return { release, admitted };
}

export const holdUpdateWindow = (): (() => void) => takeWindowHold().release;

export async function hasHeldUpdatePeer(): Promise<boolean> {
  const snapshot = await navigator.locks?.query().catch(() => undefined);
  return [...(snapshot?.held ?? []), ...(snapshot?.pending ?? [])].some(
    ({ name }) => name?.startsWith(UPDATE_WORK) && name !== windowLock,
  );
}

// Runs `activate` while no other window can start protected work: the peer check and the worker's
// switch happen under one exclusive lock. 'peer-held' when another window holds work already.
export async function whileActivatingUpdate<T>(activate: () => Promise<T>): Promise<T | 'peer-held'> {
  const run = async () => ((await hasHeldUpdatePeer()) ? 'peer-held' as const : activate());
  return navigator.locks ? navigator.locks.request(UPDATE_ADMISSION, { mode: 'exclusive' }, run) : run();
}

export function subscribeToUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const updateRequired = (): boolean => required;

export function requireAppUpdate(): void {
  if (typeof window === 'undefined' || required) return;
  required = true;
  changed();
}

export function updateBusy(): Kind | null {
  if (counts.camera) return 'camera';
  if (counts.upload) return 'upload';
  if (counts.save) return 'save';
  return counts.unsent ? 'unsent' : null;
}

// `admitted` settles once this activity shows to other windows, which is after any update that is
// activating the worker has finished: work that sends to the server waits for it.
export function beginUpdateActivity(kind: Kind): (() => void) & { admitted: Promise<void> } {
  const { release, admitted } = takeWindowHold();
  counts[kind]++;
  changed();
  let ended = false;
  return Object.assign(() => {
    if (ended) return;
    ended = true;
    release();
    counts[kind]--;
    changed();
  }, { admitted });
}

// Holds an update off for the whole of `work`, from the person's action to its result.
export async function whileUpdateHeld<T>(kind: Kind, work: () => Promise<T>): Promise<T> {
  const end = beginUpdateActivity(kind);
  try {
    await end.admitted;
    return await work();
  } finally {
    end();
  }
}
