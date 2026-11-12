import { serverDatabase } from '@/lib/auth/services';
import { pricesService, type PricesService } from './service';

let service: PricesService | null = null;

// Built on the first prices request from the checked server configuration (the database), then
// reused. A missing or invalid setting throws, and that request fails closed.
export function pricesServices(): PricesService {
  if (!service) service = pricesService(serverDatabase());
  return service;
}
