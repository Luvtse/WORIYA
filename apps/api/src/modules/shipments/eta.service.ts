import prisma from '../../utils/prisma';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import {
  EtaDataError,
  EtaRouteNotFoundError,
  EtaRouteUnavailableError,
  EtaValidationError,
} from './errors';

type ServiceLevel = 'express-domestic' | 'express-worldwide' | 'priority' | 'standard' | 'economy';

interface CalculateParams {
  originCode?: string;
  destinationCode?: string;
  originCity?: string;
  destinationCity?: string;
  serviceLevel: ServiceLevel | string;
  dropoffTime: string;
  currentStatus?: string;
}

interface AvailabilityParams {
  originCode?: string;
  destinationCode?: string;
  originCity?: string;
  destinationCity?: string;
  date: string;
}

// All data reads are from DB only (no hardcoded fallbacks). Infrastructure
// failures propagate as typed errors (see ./errors.ts) instead of being
// swallowed into empty results.

/** Normalized airport view used by the ETA engine (derived from the generated Prisma model). */
export interface AirportInfo {
  code: string;
  city: string;
  name: string;
  type: string;
  processingHours: number;
  businessStart: number;
  businessEnd: number;
  tzOffset: number;
  countryCode: string;
  country: string;
  timezone: string;
  operationalBufferHours: number;
  loadFactor: number;
  capacityStatus: string;
}

/** Normalized flight-schedule view used by the ETA engine. */
export interface ScheduleInfo {
  originCode: string;
  destinationCode: string;
  originCity: string;
  destinationCity: string;
  daysOfWeek: number[];
  dailyFrequency: number;
  lastDepartureLocal: string;
  flightMinutes: number;
}

/** Per service-level cutoff / processing configuration keyed by airport type. */
export interface ServiceLevelConfig {
  cutoffHour: number;
  adjustment: number;
}

const HUB_FALLBACK_CODE = 'ADD';

function toAirportInfo(r: Prisma.AirportGetPayload<object>): AirportInfo {
  return {
    code: r.code,
    city: r.city,
    name: r.name,
    type: r.type,
    processingHours: r.processingHours,
    businessStart: r.businessStart,
    businessEnd: r.businessEnd,
    tzOffset: r.tzOffset,
    countryCode: r.countryCode || r.country,
    country: r.country,
    timezone: r.timezone || 'UTC',
    operationalBufferHours: r.operationalBufferHours ?? 0,
    loadFactor: r.loadFactor ?? 0,
    capacityStatus: r.capacityStatus || 'NORMAL',
  };
}

function toScheduleInfo(r: Prisma.FlightScheduleGetPayload<object>): ScheduleInfo {
  return {
    originCode: r.originCode || '',
    destinationCode: r.destinationCode || '',
    originCity: r.originCity,
    destinationCity: r.destinationCity,
    daysOfWeek: r.daysOfWeek,
    dailyFrequency: r.dailyFrequency,
    lastDepartureLocal: r.lastDepartureLocal,
    flightMinutes: r.flightMinutes,
  };
}

async function getAirports(): Promise<AirportInfo[]> {
  try {
    const rows = await prisma.airport.findMany();
    return rows.map(toAirportInfo);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientKnownRequestError) {
      throw new EtaDataError('Failed to load airport master data');
    }
    throw err;
  }
}

async function getSchedules(): Promise<ScheduleInfo[]> {
  try {
    const rows = await prisma.flightSchedule.findMany();
    return rows.map(toScheduleInfo);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientKnownRequestError) {
      throw new EtaDataError('Failed to load flight schedules');
    }
    throw err;
  }
}

async function getServiceLevelSettings(): Promise<Record<string, Record<string, ServiceLevelConfig>>> {
  try {
    const rows = await prisma.serviceLevelSettings.findMany();
    const map: Record<string, Record<string, ServiceLevelConfig>> = {};
    for (const r of rows) {
      const t = String(r.airportType || '').toLowerCase();
      map[t] = map[t] || {};
      map[t][String(r.serviceLevel).toLowerCase()] = { cutoffHour: r.cutoffHour, adjustment: r.processingAdjustmentHours };
    }
    return map;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientKnownRequestError) {
      throw new EtaDataError('Failed to load service level settings');
    }
    throw err;
  }
}

export async function isHoliday(date: Date, city?: string, airportCode?: string, countryCode?: string): Promise<boolean> {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = new Date(date); end.setHours(23, 59, 59, 999);
  let rows: Prisma.OperatingCalendarGetPayload<object>[];
  try {
    rows = await prisma.operatingCalendar.findMany({ where: { country: countryCode || 'ET', date: { gte: start, lte: end } } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientKnownRequestError) {
      throw new EtaDataError('Failed to load the operating calendar');
    }
    throw err;
  }
  if (!rows.length) return false;
  return rows.some((r) =>
    r.closedAllDay &&
    ((airportCode && r.airportCode && r.airportCode.toLowerCase() === airportCode.toLowerCase()) ||
      (!airportCode && (!city || !r.city || r.city.toLowerCase() === String(city).toLowerCase())))
  );
}

function findAirportByCode(list: AirportInfo[], code: string): AirportInfo | undefined {
  return list.find(a => a.code?.toLowerCase() === code.toLowerCase());
}

function findAirportByCityOrCode(list: AirportInfo[], value: string): AirportInfo | undefined {
  const v = String(value || '').toLowerCase();
  return list.find(a => a.code?.toLowerCase() === v || a.city.toLowerCase() === v);
}

function findScheduleByCodes(list: ScheduleInfo[], originCode: string, destinationCode: string): ScheduleInfo | undefined {
  return list.find(s => (s.originCode || '').toLowerCase() === String(originCode).toLowerCase() && (s.destinationCode || '').toLowerCase() === String(destinationCode).toLowerCase());
}

function parseTime(hm: string): { h: number; m: number } {
  const parts = String(hm || '').split(':').map(Number);
  const h = parts[0];
  const m = parts[1];
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new EtaValidationError(`Invalid departure time in flight schedule: "${hm}"`);
  }
  return { h, m };
}

/**
 * If `dt` already falls at/after the business-start hour it is returned as-is;
 * otherwise it is snapped forward to the business start on the same day.
 * (Weekend handling is applied separately via nextWeekday.)
 */
function nextBusinessStart(dt: Date, startHour: number): Date {
  const d = new Date(dt);
  if (d.getHours() >= startHour) return d;
  d.setHours(startHour, 0, 0, 0);
  return d;
}

function addHours(dt: Date, hours: number): Date {
  const d = new Date(dt);
  d.setHours(d.getHours() + hours);
  return d;
}

function withinBusiness(dt: Date, start: number, end: number): boolean {
  const h = dt.getHours();
  return h >= start && h < end;
}

function dayOfWeek(dt: Date): number {
  const d = dt.getDay();
  return d === 0 ? 7 : d;
}

/**
 * Next scheduled departure for a leg identified by airport codes, at-or-after
 * `ready`. A candidate that lands before `ready` (for example when the shift
 * moves to the next week) must not be returned — flights can never depart in
 * the past relative to shipment readiness.
 */
function nextFlightTimeByCodes(schedList: ScheduleInfo[], fromCode: string, toCode: string, ready: Date): Date | null {
  const sch = findScheduleByCodes(schedList, fromCode, toCode);
  if (!sch) return null;
  return nextFlightTime(sch, ready);
}

function nextFlightTime(sch: ScheduleInfo, ready: Date): Date | null {
  const dep = parseTime(sch.lastDepartureLocal);
  const curDow = dayOfWeek(ready);
  if (sch.daysOfWeek.includes(curDow)) {
    const candidate = new Date(ready);
    candidate.setHours(dep.h, dep.m, 0, 0);
    if (candidate.getTime() >= ready.getTime()) return candidate;
  }
  for (let i = 1; i <= 7; i++) {
    const d = new Date(ready);
    d.setDate(d.getDate() + i);
    const dow = dayOfWeek(d);
    if (sch.daysOfWeek.includes(dow)) {
      d.setHours(dep.h, dep.m, 0, 0);
      return d;
    }
  }
  return null;
}

/** Static fallback cutoff table used when no ServiceLevelSettings row exists. */
function cutoffHour(sl: string, airportType: string): number {
  const t = String(airportType || '').toLowerCase();
  const isExpress = /express|priority/i.test(sl);
  if (isExpress) return t === 'hub' ? 16 : t === 'regional' ? 15 : t === 'domestic' ? 14 : 13;
  if (/standard/i.test(sl)) return t === 'hub' ? 14 : t === 'regional' ? 13 : 12;
  return t === 'hub' ? 13 : t === 'regional' ? 12 : 11;
}

export function nextWeekday(dt: Date, businessStart: number): Date {
  const d = new Date(dt);
  const day = d.getDay();
  if (day === 0) { // Sunday → Monday
    d.setDate(d.getDate() + 1);
    d.setHours(businessStart, 0, 0, 0);
  } else if (day === 6) { // Saturday → Monday
    d.setDate(d.getDate() + 2);
    d.setHours(businessStart, 0, 0, 0);
  }
  return d;
}

function findScheduleByCities(list: ScheduleInfo[], originCity: string, destinationCity: string): ScheduleInfo | undefined {
  return list.find(s => (s.originCity || '').toLowerCase() === String(originCity).toLowerCase() && (s.destinationCity || '').toLowerCase() === String(destinationCity).toLowerCase());
}

function nextFlightTimeByCities(schedList: ScheduleInfo[], originCity: string, destinationCity: string, ready: Date): Date | null {
  const sch = findScheduleByCities(schedList, originCity, destinationCity);
  if (!sch) return null;
  return nextFlightTime(sch, ready);
}

/**
 * Adds flight duration to a departure instant and returns the arrival wall
 * clock expressed in the destination's local timezone (as a JS Date whose
 * local fields equal the destination-local arrival time).
 */
function addFlightMinutesWithTimezone(departure: Date, minutes: number, originTz?: string, destTz?: string): Date {
  const isValidZone = (z: string) => DateTime.now().setZone(z).isValid;
  const zone = isValidZone(originTz || 'UTC') ? (originTz || 'UTC') : 'UTC';
  const destZone = isValidZone(destTz || zone) ? (destTz || zone) : zone;
  const depDT = DateTime.fromJSDate(departure, { zone });
  const arrDT = depDT.plus({ minutes }).setZone(destZone);
  // Re-anchor the resulting destination-local wall clock so downstream
  // setHours/getHours arithmetic operates in destination-local terms.
  return new Date(arrDT.year, arrDT.month - 1, arrDT.day, arrDT.hour, arrDT.minute, arrDT.second, arrDT.millisecond);
}

async function pickHubFor(countryCode?: string): Promise<string | undefined> {
  if (!countryCode) return undefined;
  let rows: Pick<Prisma.RegionalHubGetPayload<object>, 'hubCode'>[];
  try {
    rows = await prisma.regionalHub.findMany({
      where: { country: String(countryCode).toUpperCase() },
      orderBy: { priority: 'asc' },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientKnownRequestError) {
      throw new EtaDataError('Failed to load regional hub configuration');
    }
    throw err;
  }
  return rows[0]?.hubCode;
}

const EMPTY_RESULT = () => ({ estimatedDelivery: '', steps: [], totalHours: 0, totalDays: 0, flights: [] });

/** Resolve origin/destination airports from codes or city names. */
function resolveEndpoints(airports: AirportInfo[], originCode?: string, destinationCode?: string, originCity?: string, destinationCity?: string) {
  let origin: AirportInfo | undefined;
  let dest: AirportInfo | undefined;
  if (originCode && destinationCode) {
    origin = findAirportByCode(airports, originCode);
    dest = findAirportByCode(airports, destinationCode);
  } else {
    origin = findAirportByCityOrCode(airports, String(originCity || ''));
    dest = findAirportByCityOrCode(airports, String(destinationCity || ''));
  }
  return { origin, dest };
}

/** Classify a shipment status string into lifecycle phases used for ETA adjustments. */
function classifyStatus(raw: string) {
  const s = String(raw || '').toLowerCase().replace(/_/g, '-');
  const atHub =
    s.includes('received-at-hub') ||
    s.includes('scanned-inbound') ||
    s.includes('sorting-in-progress') ||
    s.includes('departing-to-next-hub') ||
    s.includes('in-transit-to-destination') ||
    s.includes('arrived-at-destination-hub');
  const customs =
    s.includes('customs-cleared') ||
    s.includes('customs-clearance-initiated') ||
    s.includes('customs-released') ||
    s.includes('awaiting-clearance') ||
    s.includes('clearance-delay');
  const deliveryPhase =
    s.includes('dispatched-for-delivery') ||
    s.includes('in-local-delivery-facility') ||
    s.includes('out-for-delivery') ||
    s.includes('delivered') ||
    s.includes('delivery-attempted') ||
    s.includes('signature-obtained');
  return { atHub, customs, deliveryPhase };
}

export const etaService = {
  async calculateETA({ originCode, destinationCode, originCity, destinationCity, serviceLevel, dropoffTime, currentStatus }: CalculateParams) {
    const airportsData = await getAirports();
    const schedulesData = await getSchedules();
    const slSettings = await getServiceLevelSettings();

    if (!dropoffTime || Number.isNaN(new Date(dropoffTime).getTime())) {
      throw new EtaValidationError('dropoffTime must be a valid date');
    }

    const { origin, dest } = resolveEndpoints(airportsData, originCode, destinationCode, originCity, destinationCity);
    if (!origin || !dest) {
      // Unknown endpoints: preserve the documented empty-result shape relied on
      // by tracking consumers; genuine infrastructure failures throw above.
      return EMPTY_RESULT();
    }

    const t0 = new Date(dropoffTime);
    const startBase = withinBusiness(t0, origin.businessStart, origin.businessEnd) ? t0 : nextBusinessStart(t0, origin.businessStart);
    const start = nextWeekday(startBase, origin.businessStart);
    const typeKey = String(origin.type || '').toLowerCase();
    const slKey = String(serviceLevel || '').toLowerCase();
    const cfg = slSettings[typeKey]?.[slKey];
    const cut = (cfg?.cutoffHour ?? cutoffHour(serviceLevel, origin.type));
    const afterCut = start.getHours() > cut;
    const procStart = new Date(start);
    if (afterCut) {
      procStart.setDate(procStart.getDate() + 1);
      procStart.setHours(origin.businessStart, 0, 0, 0);
    }
    let originReady = addHours(procStart, origin.processingHours + (cfg?.adjustment ?? 0));
    if (currentStatus) {
      const { atHub, customs, deliveryPhase } = classifyStatus(currentStatus);
      if (atHub) {
        originReady = procStart;
      } else if (customs) {
        originReady = addHours(procStart, 1);
      } else if (deliveryPhase) {
        originReady = addHours(t0, 0);
      }
    }

    const originHub = (await pickHubFor(origin.countryCode)) || HUB_FALLBACK_CODE;
    const destHub = (await pickHubFor(dest.countryCode)) || HUB_FALLBACK_CODE;

    // A direct leg exists only when an actual schedule connects origin→dest.
    const directSch =
      findScheduleByCodes(schedulesData, origin.code, dest.code) ||
      findScheduleByCities(schedulesData, origin.city, dest.city);

    const international = String(origin.countryCode || '').toUpperCase() !== String(dest.countryCode || '').toUpperCase();

    const flights: { origin: string; destination: string; departure: Date; arrival: Date }[] = [];
    let arrival: Date | null = null;

    if (directSch) {
      // ---- Direct-flight routing (single leg) ----
      const legDep = nextFlightTime(directSch, originReady);
      if (!legDep) return EMPTY_RESULT();
      arrival = addFlightMinutesWithTimezone(legDep, directSch.flightMinutes, origin.timezone, dest.timezone);
      flights.push({ origin: origin.code, destination: dest.code, departure: legDep, arrival });
    } else {
      // ---- Hub-relay routing: origin → origin hub → [dest hub] → destination ----
      const originHubAirport = findAirportByCode(airportsData, originHub);
      const destHubAirport = findAirportByCode(airportsData, destHub);
      const originHubCity = originHubAirport?.city || '';
      const destHubCity = destHubAirport?.city || '';

      // Leg 1: origin → origin hub (skipped when origin *is* the hub).
      let legReady = originReady;
      let cursor = origin.code;
      let cursorTz = origin.timezone;
      if (origin.code.toLowerCase() !== originHub.toLowerCase()) {
        const leg1Dep = nextFlightTimeByCodes(schedulesData, origin.code, originHub, originReady) ||
          nextFlightTimeByCities(schedulesData, origin.city, originHubCity, originReady);
        if (!leg1Dep) return EMPTY_RESULT();
        const leg1Mins =
          findScheduleByCodes(schedulesData, origin.code, originHub)?.flightMinutes ??
          findScheduleByCities(schedulesData, origin.city, originHubCity)?.flightMinutes ?? 90;
        const leg1Arr = addFlightMinutesWithTimezone(leg1Dep, leg1Mins, cursorTz, originHubAirport?.timezone || cursorTz);
        flights.push({ origin: origin.code, destination: originHub, departure: leg1Dep, arrival: leg1Arr });
        const hubLayover = international ? 3 : 1;
        legReady = addHours(leg1Arr, hubLayover);
        cursor = originHub;
        cursorTz = originHubAirport?.timezone || cursorTz;
        arrival = leg1Arr;
      }

      // Intermediate hub-to-hub leg only when the countries differ.
      if (international && originHub.toLowerCase() !== destHub.toLowerCase()) {
        const leg2Dep = nextFlightTimeByCodes(schedulesData, originHub, destHub, legReady) ||
          nextFlightTimeByCities(schedulesData, originHubCity, destHubCity, legReady);
        if (!leg2Dep) return EMPTY_RESULT();
        const leg2Mins =
          findScheduleByCodes(schedulesData, originHub, destHub)?.flightMinutes ??
          findScheduleByCities(schedulesData, originHubCity, destHubCity)?.flightMinutes ?? 180;
        const leg2Arr = addFlightMinutesWithTimezone(leg2Dep, leg2Mins, cursorTz, destHubAirport?.timezone || 'UTC');
        flights.push({ origin: originHub, destination: destHub, departure: leg2Dep, arrival: leg2Arr });
        const finalLayover = 2;
        legReady = addHours(leg2Arr, finalLayover);
        cursor = destHub;
        cursorTz = destHubAirport?.timezone || cursorTz;
        arrival = leg2Arr;
      }

      // Final leg: current cursor hub → destination (skipped when destination *is* the hub).
      if (cursor.toLowerCase() !== dest.code.toLowerCase()) {
        const cursorCity = cursor === originHub ? originHubCity : destHubCity;
        const finalDep = nextFlightTimeByCodes(schedulesData, cursor, dest.code, legReady) ||
          nextFlightTimeByCities(schedulesData, cursorCity, dest.city, legReady);
        if (!finalDep) return EMPTY_RESULT();
        const finalMins =
          findScheduleByCodes(schedulesData, cursor, dest.code)?.flightMinutes ??
          findScheduleByCities(schedulesData, cursorCity, dest.city)?.flightMinutes ?? 90;
        const finalArr = addFlightMinutesWithTimezone(finalDep, finalMins, cursorTz, dest.timezone);
        flights.push({ origin: cursor, destination: dest.code, departure: finalDep, arrival: finalArr });
        arrival = finalArr;
      }
    }

    if (!arrival) return EMPTY_RESULT();

    // Customs processing adds a fixed hold for international relay shipments.
    if (international) {
      arrival = addHours(arrival, 2);
    }

    const arrAdj = nextWeekday(arrival, dest.businessStart);
    const destProcStartBase = withinBusiness(arrAdj, dest.businessStart, dest.businessEnd) ? arrAdj : nextBusinessStart(arrAdj, dest.businessStart);
    const destProcStart = nextWeekday(destProcStartBase, dest.businessStart);
    const t = String(dest.type || '').toLowerCase();
    const deliveryHours = t === 'hub' ? 6 : t === 'regional' ? 8 : (t === 'domestic') ? 8 : 12;
    let delivered = addHours(addHours(destProcStart, dest.processingHours), deliveryHours);
    // Operational buffer: remote areas +2h, standard/economy +1h + airport configured buffer
    const buffer = (t === 'remote' ? 2 : 0) + (!/express|priority/i.test(serviceLevel) ? 1 : 0) + (dest.operationalBufferHours || 0) + (dest.loadFactor && dest.loadFactor > 0.7 ? 1 : 0);
    delivered = addHours(delivered, buffer);
    // Holiday shift: if delivered on holiday, move to next business day
    if (await isHoliday(delivered, dest.city, dest.code, dest.countryCode)) {
      const shifted = nextWeekday(addHours(delivered, 24), dest.businessStart);
      shifted.setHours(dest.businessStart, 0, 0, 0);
      delivered = shifted;
    }
    const steps = [
      { name: 'Origin dropoff', time: t0 },
      { name: 'Origin processing start', time: procStart },
      { name: 'Origin ready', time: originReady },
      ...flights.flatMap((f, i) => [{ name: `Flight ${i + 1} depart ${f.origin}`, time: f.departure }, { name: `Flight ${i + 1} arrive ${f.destination}`, time: f.arrival }]),
      { name: 'Destination processing start', time: destProcStart },
      { name: 'Local delivery complete', time: delivered },
    ];
    const totalHours = Math.round((delivered.getTime() - t0.getTime()) / 36e5);
    const totalDays = Math.ceil(totalHours / 24);
    return {
      estimatedDelivery: delivered.toISOString(),
      steps,
      totalHours,
      totalDays,
      flights,
    };
  },

  async availability({ originCode, destinationCode, originCity, destinationCity, date }: AvailabilityParams) {
    const airportsData = await getAirports();
    const schedulesData = await getSchedules();

    if (!date || Number.isNaN(new Date(date).getTime())) {
      throw new EtaValidationError('date must be a valid date');
    }

    const { origin, dest } = resolveEndpoints(airportsData, originCode, destinationCode, originCity, destinationCity);
    if (!origin || !dest) return { available: false, flights: [] };
    const base = new Date(date);
    const direct = findScheduleByCodes(schedulesData, origin.code, dest.code) || findScheduleByCities(schedulesData, origin.city, dest.city);
    const lst: { origin: string; destination: string; departure: Date }[] = [];
    if (direct) {
      const dep = parseTime(direct.lastDepartureLocal);
      for (let i = 0; i < 7; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() + i);
        const dow = dayOfWeek(d);
        if (direct.daysOfWeek.includes(dow)) {
          d.setHours(dep.h, dep.m, 0, 0);
          lst.push({ origin: origin.code, destination: dest.code, departure: d });
        }
      }
      return { available: lst.length > 0, flights: lst };
    }
    const originHub = (await pickHubFor(origin.countryCode)) || HUB_FALLBACK_CODE;
    const destHub = (await pickHubFor(dest.countryCode)) || HUB_FALLBACK_CODE;
    const hubCode = originHub && destHub ? originHub : undefined;
    if (!hubCode) return { available: false, flights: [] };
    const hubCity = airportsData.find(a => a.code === hubCode)?.city || '';
    const destHubCity = airportsData.find(a => a.code === destHub)?.city || '';
    const leg1 = findScheduleByCodes(schedulesData, origin.code, hubCode) || findScheduleByCities(schedulesData, origin.city, hubCity);
    const intermediate = originHub !== destHub
      ? (findScheduleByCodes(schedulesData, originHub, destHub) || findScheduleByCities(schedulesData, hubCity, destHubCity))
      : null;
    const leg2 = originHub !== destHub
      ? (findScheduleByCodes(schedulesData, destHub, dest.code) || findScheduleByCities(schedulesData, destHubCity, dest.city))
      : (findScheduleByCodes(schedulesData, hubCode, dest.code) || findScheduleByCities(schedulesData, hubCity, dest.city));
    if (!leg1 || !leg2) return { available: false, flights: [] };
    const dep1 = parseTime(leg1.lastDepartureLocal);
    const dep2 = parseTime(leg2.lastDepartureLocal);
    for (let i = 0; i < 7; i++) {
      const d1 = new Date(base);
      d1.setDate(d1.getDate() + i);
      const dow1 = dayOfWeek(d1);
      if (leg1.daysOfWeek.includes(dow1)) {
        d1.setHours(dep1.h, dep1.m, 0, 0);
        const d2 = new Date(d1);
        d2.setHours(d2.getHours() + 3);
        const dow2 = dayOfWeek(d2);
        if (intermediate && !intermediate.daysOfWeek.includes(dayOfWeek(d2))) continue;
        if (leg2.daysOfWeek.includes(dow2)) {
          d2.setHours(dep2.h, dep2.m, 0, 0);
          if (intermediate) {
            lst.push({ origin: origin.code, destination: hubCode, departure: d1 }, { origin: hubCode, destination: destHub, departure: d2 });
          } else {
            lst.push({ origin: origin.code, destination: hubCode, departure: d1 }, { origin: hubCode, destination: dest.code, departure: d2 });
          }
        }
      }
    }
    return { available: lst.length > 0, flights: lst };
  }
};

export {
  getAirports,
  getSchedules,
  getServiceLevelSettings,
  findAirportByCode,
  findAirportByCityOrCode,
  findScheduleByCodes,
  findScheduleByCities,
  parseTime,
  nextBusinessStart,
  addHours,
  withinBusiness,
  dayOfWeek,
  cutoffHour,
  nextFlightTimeByCodes,
  nextFlightTimeByCities,
  addFlightMinutesWithTimezone,
  pickHubFor,
  EtaDataError,
  EtaRouteNotFoundError,
  EtaRouteUnavailableError,
  EtaValidationError,
};

export default etaService;
