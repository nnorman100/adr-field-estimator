// A photo from the phone's camera, made ready to send (S5a-6): drawn again at no more than
// MAX_EDGE pixels on its longer side and saved as a JPEG. Drawing it again also leaves out the
// camera's metadata, so the location a phone writes into a photo never leaves it. The full-size
// original travels later, on Wi-Fi (S6-5).
//
// The screen keeps the prepared bytes with the photo's id until the server has a receipt for them,
// so a resend after a lost answer sends the very same bytes (S5a-5 answers the same receipt).

export const MAX_EDGE = 2_560;
const QUALITY = 0.85;

export function scaledSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longer = Math.max(width, height);
  if (longer <= maxEdge) return { width, height };
  const scale = maxEdge / longer;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The JPEG to send, or null when this browser cannot read the picture (the screen then asks for
// another).
export async function preparePhoto(file: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  } finally {
    bitmap.close();
  }
}
