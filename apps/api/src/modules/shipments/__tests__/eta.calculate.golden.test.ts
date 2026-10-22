// Golden-file tests for etaService.calculateETA.
// These were RE-PINNED in Stage 1 (build recovery) after two deliberate,
// documented behavior changes:
//   1. ROUTING FIX: the viaHub condition used `||` where hub-relay semantics
//      require a direct-schedule check; every domestic flight INTO the hub
//      (e.g. BJR->ADD) was routed through the hub branch and returned the
//      EMPTY payload because it searched for a nonexistent ADD->ADD leg.
//      Direct routes now take the direct branch when a schedule exists.
//   2. FAIL-LOUD: configuration lookups no longer swallow database errors.
//      A DB outage propagates instead of masquerading as an empty schedule.
// Ordinary route unavailability still returns the documented EMPTY payload.
// The delivery pipeline itself (cutoffs, buffers, weekend roll, single-shot
// holiday shift, timezone handling) is unchanged from the pre-fix baseline.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  airport: { findMany: vi.fn() },
  flightSchedule: { findMany: vi.fn() },
  serviceLevelSettings: { findMany: vi.fn() },
  operatingCalendar: { findMany: vi.fn() },
  regionalHub: { findMany: vi.fn() },
}) as any);

vi.mock('../../../utils/prisma', () => ({ default: prismaMock }));

import { etaService } from '../eta.service';
import { AIRPORTS, SCHEDULES, SL_SETTINGS, REGIONAL_HUBS, calendarRow } from './etaFixtures';

// NOTE: the service re-reads every config table on each internal lookup, so a
// single calculateETA() issues dozens of findMany calls. Use persistent
// mockResolvedValue (NOT *Once) for fixtures; tests that need custom behavior
// override with mockImplementation in the test body.
beforeEach(() => {
  prismaMock.airport.findMany.mockResolvedValue(AIRPORTS);
  prismaMock.flightSchedule.findMany.mockResolvedValue(SCHEDULES);
  prismaMock.serviceLevelSettings.findMany.mockResolvedValue(SL_SETTINGS);
  prismaMock.operatingCalendar.findMany.mockResolvedValue([]);
  prismaMock.regionalHub.findMany.mockResolvedValue(REGIONAL_HUBS);
});

const EMPTY_ETA = { estimatedDelivery: '', steps: [], totalHours: 0, totalDays: 0, flights: [] };

describe('calculateETA — golden outputs (server TZ pinned by vitest.config.ts)', () => {
  it('GOLDEN (routing FIXED): BJR -> ADD direct, standard, Wed 2026-09-23 09:00 local', async () => {
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    // Pre-fix this returned EMPTY (viaHub || bug routed it to a fake ADD->ADD
    // leg). Now: Wed 09:00 within business -> ready 11:00 -> same-day BJR->ADD
    // dep 12:00 -> arr 13:05 -> dest proc start 13:05 (within hours) ->
    // +4h processing +6h hub delivery +1h standard buffer -> Thu 00:05.
    expect(new Date(r.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 24, 0, 5).getTime());
    expect(r.totalHours).toBe(15);
    expect(r.totalDays).toBe(1);
    expect(r.flights.length).toBe(1);
    expect(r.flights[0].origin).toBe('BJR');
    expect(r.flights[0].destination).toBe('ADD');
    expect(r.steps.map((s: any) => s.name)).toEqual([
      'Origin dropoff', 'Origin processing start', 'Origin ready',
      'Flight 1 depart BJR', 'Flight 1 arrive ADD',
      'Destination processing start', 'Local delivery complete',
    ]);
  });

  it('GOLDEN: ADD -> BJR express-domestic, Wed 2026-09-23 09:00 local', async () => {
    const r = await etaService.calculateETA({
      originCode: 'ADD', destinationCode: 'BJR',
      serviceLevel: 'express-domestic', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    // Ready 13:00 -> same-day 14:30 dep -> arr 15:35 -> dest proc 2h + delivery
    // 8h -> 01:35 Thu (no weekend/holiday shift). totalHours measured from
    // dropoff 09:00 Wed = 16.5 -> Math.round -> 17.
    expect(new Date(r.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 24, 1, 35).getTime());
    expect(r.totalHours).toBe(17);
    expect(r.totalDays).toBe(1);
    expect(r.flights.length).toBe(1);
  });

  it('GOLDEN: Sunday dropoff rolls processing to Monday', async () => {
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 20, 12, 0).toISOString(), // Sun
    });
    // Sun 12:00 -> nextWeekday Mon 08:00 -> ready 10:00 -> Mon 12:00 dep ->
    // arr 13:05 -> proc 4h -> deliv 6h + buffer 1h -> Tue Sep 22 00:05.
    // totalHours = 36 -> ceil(36/24) = 2 days.
    expect(new Date(r.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 22, 0, 5).getTime());
    expect(r.totalDays).toBe(2);
  });

  it('GOLDEN: unknown airport returns the EMPTY payload with HTTP-level success shape', async () => {
    const r = await etaService.calculateETA({
      originCode: 'ZZZ', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    expect(r).toEqual(EMPTY_ETA);
  });

  it('GOLDEN: no schedule between airports also returns EMPTY (documented unavailable-route contract)', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([]);
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    expect(r).toEqual(EMPTY_ETA);
  });

  it('GOLDEN: international direct ADD -> JNB (Tue/Fri-only flight), Wed dropoff waits for Friday', async () => {
    const r = await etaService.calculateETA({
      originCode: 'ADD', destinationCode: 'JNB',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(), // Wed
    });
    // Tue/Fri-only ADD->JNB dep 23:55. Wed 09:00 dropoff, ready 14:00 (after
    // standard hub cutoff 13? no — cutoff for hub/standard is 14; ready 14:00
    // is not > 14) -> next allowed dep is Fri Sep 25 23:55 server-local.
    // Luxon zone-aware arrival: 23:55 interpreted in Africa/Addis_Ababa +
    // 150 min rendered in Africa/Johannesburg == Sat 02:25 UTC-equivalent
    // instant (TZ pinned to UTC here; correct across hosts).
    expect(r.flights.length).toBe(1);
    const arr = new Date(r.flights[0].arrival);
    expect(arr.getUTCDay()).toBe(6); // Saturday
    expect(arr.getUTCHours()).toBe(2);
    expect(arr.getUTCMinutes()).toBe(25);
    // Downstream: Sat arrival -> nextWeekday Mon 08:00 -> JNB proc 5h + delivery
    // 6h (hub) + standard buffer 1h -> Mon Sep 28 20:00 server-local.
    expect(new Date(r.estimatedDelivery).getTime())
      .toBe(new Date(2026, 8, 28, 20, 0).getTime()); // Mon 20:00 server-local
  });

  it('GOLDEN: currentStatus RECEIVED_AT_HUB skips origin processing entirely', async () => {
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard',
      dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
      currentStatus: 'RECEIVED_AT_HUB',
    });
    // originReady == procStart (Wed 09:00) -> same-day 12:00 dep -> Thu 00:05
    // delivery (same as the plain-direct golden because the status shortcut
    // does not beat the flight schedule here — pins that behavior).
    expect(new Date(r.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 24, 0, 5).getTime());
  });

  it('HOLIDAY PRECEDENCE (current design): calendar is consulted ONCE, only on the final delivery timestamp', async () => {
    // Delivery lands Thu 00:05 (early Friday morning). Mark WEDNESDAY closed
    // for ADD — the closure must NOT shift a Thursday delivery.
    const wed = new Date(2026, 8, 23, 12);
    prismaMock.operatingCalendar.findMany.mockImplementation(async ({ where }: any) => {
      return where?.date && wed >= where.date.gte && wed <= where.date.lte
        ? [calendarRow(wed, { airportCode: 'ADD' })]
        : [];
    });
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    const d = new Date(r.estimatedDelivery);
    expect(d.getDate()).toBe(24);
    expect(d.getHours()).toBe(0);
    expect(prismaMock.operatingCalendar.findMany).toHaveBeenCalledTimes(1);
  });

  it('HOLIDAY SHIFT: delivery day closed -> single-shot shift to next business day at businessStart', async () => {
    // Baseline delivery Thu Sep 24 00:05; Thursday is closed for ADD ->
    // delivered+24h = Fri 00:05 -> nextWeekday Mon? No: Fri(+24h)=Fri... wait:
    // Thu 00:05 + 24h = Fri Sep 25 00:05, a weekday -> setHours(businessStart)
    // -> Fri Sep 25 08:00. Single-shot: the shifted day is never re-checked.
    const thu = new Date(2026, 8, 24, 12);
    prismaMock.operatingCalendar.findMany.mockImplementation(async ({ where }: any) => {
      return where?.date && thu >= where.date.gte && thu <= where.date.lte
        ? [calendarRow(thu, { airportCode: 'ADD' })]
        : [];
    });
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    const d = new Date(r.estimatedDelivery);
    expect(d.getDay()).toBe(5); // Friday
    expect(d.getDate()).toBe(25);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('HOLIDAY PRECEDENCE: the shift is NOT iterative — a second consecutive holiday day is ignored', async () => {
    // Close BOTH Thursday (delivery day) and Friday (shift target). The
    // single-shot shift lands on Friday 08:00 and Friday is never re-checked.
    const thu = new Date(2026, 8, 24, 12);
    const fri = new Date(2026, 8, 25, 12);
    prismaMock.operatingCalendar.findMany.mockImplementation(async ({ where }: any) => {
      if (!where?.date) return [];
      const hit = (d: Date) => d >= where.date.gte && d <= where.date.lte;
      return [thu, fri].filter(hit).map(d => calendarRow(d, { airportCode: 'ADD' }));
    });
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    const d = new Date(r.estimatedDelivery);
    expect(d.getDay()).toBe(5); // Friday — second closure ignored (single-shot)
    expect(d.getDate()).toBe(25);
  });

  it('HOLIDAY PRECEDENCE: flight legs and processing days are NEVER checked against the calendar', async () => {
    // Calendar rows outside the queried final-day window cannot affect the
    // result, and crucially the ONLY calendar call happens once at the end.
    prismaMock.operatingCalendar.findMany.mockImplementation(async () => {
      return [{ date: new Date(2026, 0, 1), country: 'ET', airportCode: null, city: null, closedAllDay: true }];
    });
    const withClosures = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    expect(prismaMock.operatingCalendar.findMany).toHaveBeenCalledTimes(1);
    expect(new Date(withClosures.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 24, 0, 5).getTime());
  });

  it('GOLDEN (routing FIXED): domestic hub relay DIR -> BJR via ADD, two chronological legs', async () => {
    const r = await etaService.calculateETA({
      originCode: 'DIR', destinationCode: 'BJR',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    // No direct DIR->BJR schedule -> relay through the shared ET hub (ADD).
    // Leg1 DIR->ADD Thu Sep 24 08:30 -> arr 10:00; layover 1h; Leg2
    // ADD->BJR Thu 14:30 -> arr 15:35. Legs connect correctly and ascend
    // chronologically (no fabricated ADD->ADD flight).
    expect(r.flights.length).toBe(2);
    expect(r.flights[0].origin).toBe('DIR');
    expect(r.flights[0].destination).toBe('ADD');
    expect(r.flights[1].origin).toBe('ADD');
    expect(r.flights[1].destination).toBe('BJR');
    const dep1 = new Date(r.flights[0].departure).getTime();
    const arr1 = new Date(r.flights[0].arrival).getTime();
    const dep2 = new Date(r.flights[1].departure).getTime();
    const arr2 = new Date(r.flights[1].arrival).getTime();
    expect(arr1).toBeGreaterThan(dep1);
    expect(dep2).toBeGreaterThanOrEqual(arr1);
    expect(arr2).toBeGreaterThan(dep2);
    expect(new Date(r.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 25, 2, 35).getTime());
  });

  it('GOLDEN: international relay JNB -> BJR via ADD hub (two legs, foreign hub != destination)', async () => {
    const r = await etaService.calculateETA({
      originCode: 'JNB', destinationCode: 'BJR',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    expect(r.flights.length).toBe(2);
    expect(r.flights[0].origin).toBe('JNB');
    expect(r.flights[0].destination).toBe('ADD');
    expect(r.flights[1].origin).toBe('ADD');
    expect(r.flights[1].destination).toBe('BJR');
    expect(new Date(r.estimatedDelivery).getTime()).toBe(new Date(2026, 8, 28, 19, 0).getTime());
  });

  it('INVALID INPUT: unparsable dropoffTime throws RangeError (route maps it to HTTP 400)', async () => {
    await expect(etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: 'not-a-date',
    })).rejects.toThrow(RangeError);
  });

  it('FAIL-LOUD (fixed): database outage propagates instead of returning an empty schedule', async () => {
    prismaMock.airport.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    })).rejects.toThrow('db down');
  });

  it('STABLE OUTPUT SHAPE: every successful calculation exposes the same keys', async () => {
    const r = await etaService.calculateETA({
      originCode: 'BJR', destinationCode: 'ADD',
      serviceLevel: 'standard', dropoffTime: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    expect(Object.keys(r).sort()).toEqual(['estimatedDelivery', 'flights', 'steps', 'totalDays', 'totalHours']);
    expect(typeof r.estimatedDelivery).toBe('string');
    expect(Array.isArray(r.steps)).toBe(true);
    expect(Array.isArray(r.flights)).toBe(true);
  });

  it('GOLDEN: availability() falls back to hub routing when no direct schedule exists', async () => {
    const r = await etaService.availability({
      originCode: 'BJR', destinationCode: 'DIR', date: new Date(2026, 8, 23, 9, 0).toISOString(),
    });
    // No BJR->DIR direct; both hub via ADD -> two-leg listing, available if any
    // weekday within 7 days has both legs.
    expect(r.available).toBe(true);
    expect(r.flights.length).toBeGreaterThan(0);
    expect(r.flights[0].origin).toBe('BJR');
    expect(r.flights[0].destination).toBe('ADD');
  });

  it('GOLDEN: availability() unknown route returns { available:false, flights:[] }', async () => {
    const r = await etaService.availability({ originCode: 'XXX', destinationCode: 'ADD', date: new Date(2026, 8, 23).toISOString() });
    expect(r).toEqual({ available: false, flights: [] });
  });

  it('FAIL-LOUD: availability() propagates database outages', async () => {
    prismaMock.flightSchedule.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(etaService.availability({
      originCode: 'BJR', destinationCode: 'ADD', date: new Date(2026, 8, 23, 9, 0).toISOString(),
    })).rejects.toThrow('db down');
  });
});
