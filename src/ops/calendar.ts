/**
 * Calendar read helpers: the input schemas (window rules) and the
 * normalizers from Graph shapes to the neutral shapes hadron-server's
 * emailClient reads from the calendar tools (ToolCalendarEvent,
 * ToolScheduleFreeBusy). Pure functions: no I/O, so the rules are testable
 * without Graph.
 */
import { z } from 'zod';
import { ProviderUnavailableError } from '../errors.js';
import type { GraphEvent, GraphScheduleInfo } from '../providers/msgraph/types.js';

/**
 * Limits. `top` (max 100, default 25) and `schedules` (max 20) are
 * hadrontool-google-cal's values. google-cal has NO window cap, so the span
 * cap is new here: a proposed value, one constant, a one-line change if the
 * owner rules otherwise (hadrontool-ms-exchange#7 gate, open ruling 1).
 */
export const MAX_WINDOW_DAYS = 31;
export const DEFAULT_TOP = 25;
export const MAX_TOP = 100;
export const MAX_SCHEDULES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** RFC 3339 with an explicit Z or offset: an ambiguous local time is refused rather than guessed. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const instant = z
  .string()
  .regex(RFC3339, 'must be an RFC 3339 timestamp with a Z or UTC offset')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a real date and time');

/** Window fields: both ends required, each an RFC 3339 instant with an offset. */
export const windowShape = { start: instant, end: instant };

/** Cross-field window rules; every refusal happens in schema parse, before any Graph call. */
export function checkWindow(v: { start: string; end: string }, ctx: z.RefinementCtx): void {
  const s = Date.parse(v.start);
  const e = Date.parse(v.end);
  if (Number.isNaN(s) || Number.isNaN(e)) return; // the field errors already say so
  if (e <= s) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
  } else if (e - s > MAX_WINDOW_DAYS * DAY_MS) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: `the window may span at most ${MAX_WINDOW_DAYS} days` });
  }
}

export const topSchema = z.number().int().min(1).max(MAX_TOP).optional();
/** An address, or the neutral alias `primary` (any case) for the connection's own calendar. */
const scheduleId = z.string().min(1).refine((v) => v.toLowerCase() === 'primary' || v.includes('@'), 'a schedule is an email address or primary');
export const schedulesSchema = z.array(scheduleId).min(1).max(MAX_SCHEDULES).default(['primary']);

/** UTC ISO instant (Z) for an RFC 3339 input. */
export function toUtcIso(v: string): string {
  return new Date(v).toISOString();
}

/** Graph UTC dateTime (7 fractional digits, no Z) → ISO with Z. */
function graphUtc(dt: string): string {
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(dt) ? dt : `${dt}Z`);
  // A malformed provider timestamp is a provider fault, not an opaque RangeError.
  if (Number.isNaN(d.getTime())) throw new ProviderUnavailableError();
  return d.toISOString();
}

/** A whitelist: only these Graph statuses are busy. free, workingElsewhere and unknown are not. */
const BUSY_STATUSES = new Set(['busy', 'tentative', 'oof']);

/**
 * Busy intervals ONLY. Reads status/start/end and nothing else, so no event
 * subject, location or attendee can reach the answer even when Graph sends
 * one: the grant `calendar.freebusy` is structurally limited to yes/no.
 * Answers in request order; a schedule Graph could not resolve keeps its
 * slot with an error marker.
 */
export function normalizeSchedule(requested: string[], infos: GraphScheduleInfo[]): { id: string; busy: { start: string; end: string }[]; error: string | null }[] {
  const byId = new Map(infos.map((i) => [i.scheduleId.toLowerCase(), i]));
  return requested.map((id) => {
    const info = byId.get(id.toLowerCase());
    if (!info) return { id, busy: [], error: 'not_found' };
    if (info.error) return { id, busy: [], error: info.error.responseCode ?? 'error' };
    const busy = (info.scheduleItems ?? [])
      .filter((i) => i.status !== undefined && BUSY_STATUSES.has(i.status))
      .map((i) => ({ start: graphUtc(i.start.dateTime), end: graphUtc(i.end.dateTime) }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { id, busy, error: null };
  });
}

type EventResponse = 'accepted' | 'declined' | 'tentative' | 'none';

function response(r: string | undefined): EventResponse {
  if (r === 'accepted' || r === 'organizer') return 'accepted';
  if (r === 'declined') return 'declined';
  if (r === 'tentativelyAccepted') return 'tentative';
  return 'none';
}

function boundary(t: { dateTime: string }, allDay: boolean, localDate?: string) {
  return allDay
    ? { dateTime: null, date: localDate ?? t.dateTime.slice(0, 10), timeZone: null }
    : { dateTime: graphUtc(t.dateTime), date: null, timeZone: 'UTC' };
}

/** Graph event → neutral ToolCalendarEvent. The calendar is always the primary one in this slice. */
export function normalizeEvent(e: GraphEvent) {
  const allDay = e.isAllDay === true;
  return {
    id: e.id,
    calendarId: 'primary',
    title: e.subject ?? null,
    description: e.bodyPreview ?? null,
    location: e.location?.displayName || null,
    start: boundary(e.start, allDay, e.allDayStartDate),
    end: boundary(e.end, allDay, e.allDayEndDate),
    isAllDay: allDay,
    status: e.isCancelled ? ('cancelled' as const) : e.showAs === 'tentative' ? ('tentative' as const) : ('confirmed' as const),
    organizer: e.organizer?.emailAddress
      ? { name: e.organizer.emailAddress.name ?? null, address: e.organizer.emailAddress.address ?? null }
      : null,
    isOrganizer: e.isOrganizer === true,
    attendees: (e.attendees ?? [])
      .filter((a) => a.emailAddress?.address)
      .map((a) => ({
        name: a.emailAddress?.name ?? null,
        address: a.emailAddress!.address as string,
        optional: a.type === 'optional',
        response: response(a.status?.response),
      })),
    myResponse: e.responseStatus?.response ? response(e.responseStatus.response) : null,
    webLink: e.webLink ?? null,
    seriesId: e.seriesMasterId ?? null,
    createdAt: e.createdDateTime ?? null,
    updatedAt: e.lastModifiedDateTime ?? null,
  };
}
