import { serverDatabase } from '@/lib/auth/services';
import { parseLocalSignInFixture } from '@/lib/config';
import { localPricesService } from './local-prices';
import { pricesService, type PricesService } from './service';

let service: PricesService | null = null;

// Built on the first prices request from the checked server configuration (the database), then
// reused. A missing or invalid setting throws, and that request fails closed. On a developer machine
// beside the Auth emulator, LOCAL_SIGN_IN_FIXTURE stands in for the database
// (src/lib/prices/local-prices.ts); the configuration refuses it anywhere else.
export function pricesServices(): PricesService {
  if (!service) {
    const fixture = parseLocalSignInFixture(process.env);
    service = fixture ? localPricesService(fixture) : pricesService(serverDatabase());
  }
  return service;
}
