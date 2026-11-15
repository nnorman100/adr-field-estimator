import { serverDatabase } from '@/lib/auth/services';
import { photosServices } from '@/lib/photos/services';
import { documentLinksService, type DocumentLinksService } from './documents';
import { signingLinksService, type SigningLinksService } from './signing';

let signing: SigningLinksService | null = null;
let documents: DocumentLinksService | null = null;

// Built on the first request over the server's database and the photo service (for the signature
// image), then reused.
export function signingLinksServices(): SigningLinksService {
  signing ??= signingLinksService(serverDatabase(), photosServices());
  return signing;
}

export function documentLinksServices(): DocumentLinksService {
  documents ??= documentLinksService(serverDatabase(), photosServices());
  return documents;
}
