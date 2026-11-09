import {
  AccessError,
  BASE_CAPABILITIES,
  CAPABILITIES,
  PRICE_CAPABILITIES,
  ROLES,
  type AccessFlags,
  type Capability,
  type Role,
} from './roles';

// Lookups go through Set.has, never object property access, so a value such as "constructor" or
// "__proto__" is an unknown role or key like any other.
const ROLE_SET: ReadonlySet<unknown> = new Set(ROLES);
const CAPABILITY_SET: ReadonlySet<unknown> = new Set(CAPABILITIES);

export function isRole(value: unknown): value is Role {
  return ROLE_SET.has(value);
}

export function isCapability(value: unknown): value is Capability {
  return CAPABILITY_SET.has(value);
}

// For a role read from a record or a token: an unknown value stops the request. The message is
// fixed and never repeats the value.
export function parseRole(value: unknown): Role {
  if (!isRole(value)) throw new AccessError('Unknown role');
  return value;
}

export function parseCapability(value: unknown): Capability {
  if (!isCapability(value)) throw new AccessError('Unknown capability');
  return value;
}

// Only the boolean true switches price books on; anything else, including a missing value, is off.
function priceBooksOn(flags: AccessFlags): boolean {
  return flags?.priceBooks === true;
}

// The keys a role holds under these switches. An unknown role holds none.
export function capabilitiesFor(role: unknown, flags: AccessFlags): readonly Capability[] {
  if (!isRole(role)) return Object.freeze([]);
  const keys: Capability[] = [...BASE_CAPABILITIES[role]];
  if (priceBooksOn(flags)) keys.push(...PRICE_CAPABILITIES[role]);
  return Object.freeze(keys);
}

// Deny by default: false for an unknown role, an unknown key, or a price key while the flag is off.
export function can(role: unknown, key: unknown, flags: AccessFlags): boolean {
  if (!isCapability(key)) return false;
  return capabilitiesFor(role, flags).includes(key);
}
