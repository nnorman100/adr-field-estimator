type Kind = 'camera' | 'save' | 'upload';

const counts = { camera: 0, save: 0, upload: 0 };
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
  return counts.save ? 'save' : null;
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
