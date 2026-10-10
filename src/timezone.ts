/** Vendored from connectome-heartbeat-mcpl/src/timezone.ts. */
/** Format agent-visible wall-clock times without changing UTC protocol data. */

/** True iff `zone` names an IANA time zone this runtime can format in.
 *  Exported for hosts that want to pre-validate AGENT_TIMEZONE strictly. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Resolve the zone used for agent-visible timestamps. NEVER throws: this is
 *  evaluated at module scope, so a typo'd AGENT_TIMEZONE would kill the stdio
 *  child during import — before the MCPL handshake — and a dead MCPL
 *  subprocess is never respawned by reconnect. Instead, warn loudly on stderr
 *  and fall back to the same default used when the variable is unset
 *  (system zone → UTC). */
export function resolveAgentTimeZone(configured = process.env.AGENT_TIMEZONE): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const zone = configured?.trim();
  if (!zone) return fallback;
  if (!isValidTimeZone(zone)) {
    console.error(`[timezone] Invalid AGENT_TIMEZONE ${JSON.stringify(zone)} — falling back to system time zone ${JSON.stringify(fallback)}`);
    return fallback;
  }
  return zone;
}

export function formatAgentDateTime(value: Date | number, timeZone = resolveAgentTimeZone()): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const rawOffset = get('timeZoneName');
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset} [${timeZone}]`;
}
