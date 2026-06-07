// Coarsen a client IP to a network prefix before it touches session_devices, so
// a device roaming within one network keeps a single row and we never persist a
// full address. IPv4 collapses to a /24 and IPv6 to a /48; the result is a CIDR
// string Postgres casts straight to inet, or null when no usable IP is present.

export const IPV4_PREFIX = 24;
export const IPV6_PREFIX = 48;

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function ipv4Subnet(ip: string): string {
  const [a, b, c] = ip.split('.');
  return `${a}.${b}.${c}.0/${IPV4_PREFIX}`;
}

function ipv6Subnet(ip: string): string | null {
  // Keep the leading 48 bits (first three hextets) and zero the remainder. The
  // `::` compression only ever elides trailing zero groups for a prefix, so the
  // portion before it carries every bit we retain.
  const head = ip.split('::')[0] ?? '';
  const groups = head
    .split(':')
    .filter((group) => group.length > 0)
    .slice(0, 3);
  if (groups.length === 0) return null;
  while (groups.length < 3) groups.push('0');
  return `${groups.join(':')}::/${IPV6_PREFIX}`;
}

/**
 * Coarsen a client IP to its /24 (v4) or /48 (v6) CIDR, or null when the input
 * is absent or unparseable. Never throws: a missing subnet is stored as NULL.
 */
export function ipSubnet(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.length === 0) return null;
  if (isIpv4(trimmed)) return ipv4Subnet(trimmed);
  if (trimmed.includes(':')) return ipv6Subnet(trimmed);
  return null;
}
