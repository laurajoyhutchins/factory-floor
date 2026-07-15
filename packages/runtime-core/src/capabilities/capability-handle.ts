const CAPABILITY_HANDLE_PREFIX = 'ffcap_';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCapabilityGrantHandle(grantId: string): string {
  if (!UUID_PATTERN.test(grantId))
    throw new Error('capability grant id must be a UUID');
  return `${CAPABILITY_HANDLE_PREFIX}${Buffer.from(grantId, 'utf8').toString('base64url')}`;
}

export function decodeCapabilityGrantHandle(handle: string): string | null {
  if (!handle.startsWith(CAPABILITY_HANDLE_PREFIX)) return null;
  try {
    const grantId = Buffer.from(
      handle.slice(CAPABILITY_HANDLE_PREFIX.length),
      'base64url',
    ).toString('utf8');
    return UUID_PATTERN.test(grantId) ? grantId : null;
  } catch {
    return null;
  }
}
