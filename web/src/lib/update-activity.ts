// `unsent`: a form of this window holds input nobody has saved, sent or discarded.
type Kind = 'camera' | 'save' | 'upload' | 'unsent';

const counts = { camera: 0, save: 0, upload: 0, unsent: 0 };
let required = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

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
  counts[kind]++;
  changed();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
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
