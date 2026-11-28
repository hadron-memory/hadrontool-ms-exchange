import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '../errors.js';
import { graphEvent } from '../test/fakes.js';
import { normalizeEvent, normalizeSchedule } from './calendar.js';

const item = (status: string, s = '2026-12-01T10:00:00.0000000', e = '2026-12-01T11:00:00.0000000') => ({
  status, start: { dateTime: s, timeZone: 'UTC' }, end: { dateTime: e, timeZone: 'UTC' },
});

describe('normalizeSchedule', () => {
  it('marks an address Graph did not answer for as not_found, keeping request order', () => {
    expect(normalizeSchedule(['a@x.edu', 'b@x.edu'], [{ scheduleId: 'b@x.edu', scheduleItems: [] }])).toEqual([
      { id: 'a@x.edu', busy: [], error: 'not_found' },
      { id: 'b@x.edu', busy: [], error: null },
    ]);
  });

  it('reports a per-schedule Graph error as its response code only, with no intervals', () => {
    const out = normalizeSchedule(['a@x.edu'], [
      { scheduleId: 'a@x.edu', scheduleItems: [item('busy')], error: { message: 'You do not have permission for Secret Person', responseCode: 'ErrorMailRecipientNotFound' } },
    ]);
    expect(out).toEqual([{ id: 'a@x.edu', busy: [], error: 'ErrorMailRecipientNotFound' }]);
  });

  it('counts only busy, tentative and oof; free, workingElsewhere, unknown are not busy', () => {
    const [r] = normalizeSchedule(['a@x.edu'], [
      { scheduleId: 'A@x.edu', scheduleItems: ['busy', 'tentative', 'oof', 'free', 'workingElsewhere', 'unknown'].map((s, i) => item(s, `2026-12-0${i + 1}T10:00:00`, `2026-12-0${i + 1}T11:00:00`)) },
    ]);
    expect(r.busy.map((b) => b.start.slice(0, 10))).toEqual(['2026-12-01', '2026-12-02', '2026-12-03']);
  });

  it('refuses a malformed provider timestamp as a typed provider fault, not a RangeError', () => {
    expect(() => normalizeSchedule(['a@x.edu'], [{ scheduleId: 'a@x.edu', scheduleItems: [item('busy', 'garbage')] }])).toThrow(ProviderUnavailableError);
    expect(() => normalizeEvent(graphEvent({ start: { dateTime: 'garbage', timeZone: 'UTC' } }))).toThrow(ProviderUnavailableError);
  });
});
