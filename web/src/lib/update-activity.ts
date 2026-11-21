// `unsent`: a form of this window holds input nobody has saved, sent or discarded.
type Kind = 'camera' | 'save' | 'upload' | 'unsent';

const counts = { camera: 0, save: 0, upload: 0, unsent: 0 };
let required = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const UPDATE_WORK = 'ds-update-work:';
let windowLock: string | undefined;

// All activity in this window shares its name. Closing the window releases its locks.
export function holdUpdateWindow(): () => void {
  if (typeof window === 'undefined' || !navigator.locks) return () => undefined;
  windowLock ??= UPDATE_WORK + crypto.randomUUID();
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => { release = done; });
  void navigator.locks.request(windowLock, { mode: 'shared' }, () => held).catch(() => undefined);
  return release;
}

export async function hasHeldUpdatePeer(): Promise<boolean> {
  const snapshot = await navigator.locks?.query().catch(() => undefined);
  return [...(snapshot?.held ?? []), ...(snapshot?.pending ?? [])].some(
    ({ name }) => name?.startsWith(UPDATE_WORK) && name !== windowLock,
  );
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

export function beginUpdateActivity(kind: Kind): () => void {
  const releaseWindow = holdUpdateWindow();
  counts[kind]++;
  changed();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    releaseWindow();
    counts[kind]--;
    changed();
  };
}

// Holds an update off for the whole of `work`, from the person's action to its result.
export async function whileUpdateHeld<T>(kind: Kind, work: () => Promise<T>): Promise<T> {
  const end = beginUpdateActivity(kind);
  try {
    return await work();
  } finally {
    end();
  }
}
