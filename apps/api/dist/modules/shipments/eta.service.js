"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.etaService = void 0;
exports.isHoliday = isHoliday;
exports.nextWeekday = nextWeekday;
const prisma_1 = __importDefault(require("../../utils/prisma"));
const luxon_1 = require("luxon");
// All data reads are from DB only (no hardcoded fallbacks).
// Fail-loud contract: configuration lookups propagate infrastructure failures
// (database outage/query error) as typed errors to the caller so they can NEVER
// be mistaken for an ordinary "route unavailable" empty ETA result. Ordinary
// route unavailability is represented by the documented EMPTY payload, not by
// swallowed exceptions.
async function getAirports() {
    const rows = await prisma_1.default.airport.findMany();
    return rows.map(r => ({ code: r.code, city: r.city, name: r.name, type: r.type, processingHours: r.processingHours, businessStart: r.businessStart, businessEnd: r.businessEnd, tzOffset: r.tzOffset, countryCode: r.countryCode, country: r.country, timezone: r.timezone, operationalBufferHours: r.operationalBufferHours ?? 0, loadFactor: r.loadFactor ?? 0, capacityStatus: r.capacityStatus ?? 'NORMAL' }));
}
async function getSchedules() {
    const rows = await prisma_1.default.flightSchedule.findMany();
    return rows.map(r => ({ originCode: r.originCode || '', destinationCode: r.destinationCode || '', originCity: r.originCity, destinationCity: r.destinationCity, daysOfWeek: r.daysOfWeek, dailyFrequency: r.dailyFrequency, lastDepartureLocal: r.lastDepartureLocal, flightMinutes: r.flightMinutes }));
}
async function getServiceLevelSettings() {
    const rows = await prisma_1.default.serviceLevelSettings.findMany();
    const map = {};
    for (const r of rows) {
        const t = String(r.airportType || '').toLowerCase();
        map[t] = map[t] || {};
        map[t][String(r.serviceLevel).toLowerCase()] = { cutoffHour: r.cutoffHour, adjustment: r.processingAdjustmentHours };
    }
    return map;
}
async function isHoliday(date, city, airportCode, countryCode) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    const rows = await prisma_1.default.operatingCalendar.findMany({ where: { country: countryCode || 'ET', date: { gte: start, lte: end } } });
    if (!rows || !rows.length)
        return false;
    return rows.some(r => r.closedAllDay && ((airportCode && r.airportCode && r.airportCode.toLowerCase() === airportCode.toLowerCase()) || (!airportCode && (!city || !r.city || r.city.toLowerCase() === String(city).toLowerCase()))));
}
function findAirportByCode(list, code) {
    return list.find(a => a.code?.toLowerCase() === code.toLowerCase());
}
function findAirportByCityOrCode(list, value) {
    return list.find(a => a.code?.toLowerCase() === value.toLowerCase() || a.city.toLowerCase() === value.toLowerCase());
}
function findScheduleByCodes(list, originCode, destinationCode) {
    return list.find(s => (s.originCode || '').toLowerCase() === originCode.toLowerCase() && (s.destinationCode || '').toLowerCase() === destinationCode.toLowerCase());
}
function parseTime(hm) {
    const [h, m] = hm.split(':').map(Number);
    return { h, m };
}
function nextBusinessStart(dt, startHour) {
    const d = new Date(dt);
    if (d.getHours() >= startHour)
        return d;
    d.setHours(startHour, 0, 0, 0);
    return d;
}
function addHours(dt, hours) {
    const d = new Date(dt);
    d.setHours(d.getHours() + hours);
    return d;
}
function withinBusiness(dt, start, end) {
    const h = dt.getHours();
    return h >= start && h < end;
}
function dayOfWeek(dt) {
    const d = dt.getDay();
    return d === 0 ? 7 : d;
}
function nextFlightTimeByCodes(schedList, fromCode, toCode, ready) {
    const sch = findScheduleByCodes(schedList, fromCode, toCode);
    if (!sch)
        return null;
    const curDow = dayOfWeek(ready);
    const dep = parseTime(sch.lastDepartureLocal);
    const candidate = new Date(ready);
    candidate.setHours(dep.h, dep.m, 0, 0);
    if (sch.daysOfWeek.includes(curDow) && ready.getHours() <= dep.h)
        return candidate;
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
function cutoffHour(sl, airportType) {
    const t = String(airportType || '').toLowerCase();
    const isExpress = /express|priority/i.test(sl);
    if (isExpress)
        return t === 'hub' ? 16 : t === 'regional' ? 15 : t === 'domestic' ? 14 : 13;
    if (/standard/i.test(sl))
        return t === 'hub' ? 14 : t === 'regional' ? 13 : 12;
    return t === 'hub' ? 13 : t === 'regional' ? 12 : 11;
}
// NOTE (characterization): nextWeekday only skips Sat/Sun; it does NOT consult
// OperatingCalendar. Holiday handling is a separate, single-shot shift applied
// only to the final delivery timestamp (see calculateETA). Exported for tests.
function nextWeekday(dt, businessStart) {
    const d = new Date(dt);
    const day = d.getDay();
    if (day === 0) { // Sunday → Monday
        d.setDate(d.getDate() + 1);
        d.setHours(businessStart, 0, 0, 0);
    }
    else if (day === 6) { // Saturday → Monday
        d.setDate(d.getDate() + 2);
        d.setHours(businessStart, 0, 0, 0);
    }
    return d;
}
exports.etaService = {
    async calculateETA({ originCode, destinationCode, originCity, destinationCity, serviceLevel, dropoffTime, currentStatus }) {
        const airportsData = await getAirports();
        const schedulesData = await getSchedules();
        const slSettings = await getServiceLevelSettings();
        let origin = null;
        let dest = null;
        if (originCode && destinationCode) {
            origin = findAirportByCode(airportsData, originCode);
            dest = findAirportByCode(airportsData, destinationCode);
        }
        else {
            origin = findAirportByCityOrCode(airportsData, String(originCity || ''));
            dest = findAirportByCityOrCode(airportsData, String(destinationCity || ''));
        }
        if (!origin || !dest) {
            return { estimatedDelivery: '', steps: [], totalHours: 0, totalDays: 0, flights: [] };
        }
        const t0 = new Date(dropoffTime);
        if (Number.isNaN(t0.getTime())) {
            throw new RangeError('dropoffTime is not a valid date');
        }
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
            const sRaw = String(currentStatus);
            const s = sRaw.toLowerCase().replace(/_/g, '-');
            const atHub = s.includes('received-at-hub') ||
                s.includes('scanned-inbound') ||
                s.includes('sorting-in-progress') ||
                s.includes('departing-to-next-hub') ||
                s.includes('in-transit-to-destination') ||
                s.includes('arrived-at-destination-hub');
            const customs = s.includes('customs-cleared') ||
                s.includes('customs-clearance-initiated');
            const deliveryPhase = s.includes('dispatched-for-delivery') ||
                s.includes('in-local-delivery-facility') ||
                s.includes('out-for-delivery') ||
                s.includes('delivered') ||
                s.includes('delivered-successfully') ||
                s.includes('signature-obtained');
            if (atHub) {
                originReady = procStart;
            }
            else if (customs) {
                originReady = addHours(procStart, 1);
            }
            else if (deliveryPhase) {
                originReady = addHours(t0, 0);
            }
        }
        const originHub = (await pickHubFor(origin.countryCode)) || 'ADD';
        const destHub = (await pickHubFor(dest.countryCode)) || 'ADD';
        // Hub-relay is used only when NO direct schedule exists for the requested
        // city pair (by code or by city). When both endpoints belong to the same
        // hub country (originHub === destHub) and neither endpoint IS that hub,
        // the relay is origin -> hub -> destination (two legs), not the three-leg
        // international pattern. Previously this condition used `||`, which routed
        // every non-(origin==destHub && dest==originHub) pair — including direct
        // domestic flights INTO the hub (e.g. BJR->ADD) — through the hub branch,
        // where they searched for a nonexistent ADD->ADD second leg and returned
        // the EMPTY payload. This is the documented routing-defect fix.
        const hasDirect = !!(findScheduleByCodes(schedulesData, origin.code, dest.code) ||
            findScheduleByCities(schedulesData, origin.city, dest.city));
        const viaHub = !hasDirect && origin.code.toLowerCase() !== dest.code.toLowerCase();
        const sameCountryRelay = !!originHub && !!destHub && originHub.toLowerCase() === destHub.toLowerCase();
        const flights = [];
        let arrival = null;
        if (viaHub) {
            const originHubCity = airportsData.find(a => a.code === originHub)?.city || '';
            const destHubCity = airportsData.find(a => a.code === destHub)?.city || '';
            let leg1Dep = nextFlightTimeByCodes(schedulesData, origin.code, originHub, originReady) || nextFlightTimeByCities(schedulesData, origin.city, originHubCity, originReady);
            if (!leg1Dep)
                return { estimatedDelivery: '', steps: [], totalHours: 0, totalDays: 0, flights: [] };
            const leg1Mins = (findScheduleByCodes(schedulesData, origin.code, originHub)?.flightMinutes || findScheduleByCities(schedulesData, origin.city, originHubCity)?.flightMinutes || 90);
            const leg1Arr = addFlightMinutesWithTimezone(leg1Dep, leg1Mins, origin.timezone, airportsData.find(a => a.code === originHub)?.timezone || 'UTC');
            const international = String(origin.countryCode || '').toUpperCase() !== String(dest.countryCode || '').toUpperCase();
            const hubLayover = international ? 3 : 1;
            const leg2Ready = addHours(leg1Arr, hubLayover);
            // When both endpoints share the same regional hub, the second relay leg
            // goes hub -> destination directly; searching for a hub -> hub flight
            // would fabricate an ADD->ADD "flight".
            const leg2ToCode = sameCountryRelay ? dest.code : destHub;
            const leg2ToCity = sameCountryRelay ? dest.city : destHubCity;
            let leg2Dep = nextFlightTimeByCodes(schedulesData, originHub, leg2ToCode, leg2Ready) || nextFlightTimeByCities(schedulesData, originHubCity, leg2ToCity, leg2Ready);
            if (!leg2Dep)
                return { estimatedDelivery: '', steps: [], totalHours: 0, totalDays: 0, flights: [] };
            const leg2Mins = (findScheduleByCodes(schedulesData, originHub, leg2ToCode)?.flightMinutes || findScheduleByCities(schedulesData, originHubCity, leg2ToCity)?.flightMinutes || 180);
            const leg2Arr = addFlightMinutesWithTimezone(leg2Dep, leg2Mins, airportsData.find(a => a.code === originHub)?.timezone || 'UTC', airportsData.find(a => a.code === leg2ToCode)?.timezone || dest.timezone || 'UTC');
            arrival = leg2Arr;
            flights.push({ origin: origin.code, destination: originHub, departure: leg1Dep, arrival: leg1Arr });
            flights.push({ origin: originHub, destination: leg2ToCode, departure: leg2Dep, arrival: leg2Arr });
            // The third (hub -> destination feeder) leg only applies when the relay
            // actually terminated at a foreign hub different from the destination.
            if (!sameCountryRelay && destHub.toLowerCase() !== dest.code.toLowerCase()) {
                const finalLayover = international ? 2 : 1;
                const finalReady = addHours(arrival, finalLayover);
                const finalDep = nextFlightTimeByCodes(schedulesData, destHub, dest.code, finalReady) || nextFlightTimeByCities(schedulesData, destHubCity, dest.city, finalReady);
                if (finalDep) {
                    const finalMins = (findScheduleByCodes(schedulesData, destHub, dest.code)?.flightMinutes || findScheduleByCities(schedulesData, destHubCity, dest.city)?.flightMinutes || 90);
                    const finalArr = addFlightMinutesWithTimezone(finalDep, finalMins, airportsData.find(a => a.code === destHub)?.timezone || 'UTC', dest.timezone);
                    flights.push({ origin: destHub, destination: dest.code, departure: finalDep, arrival: finalArr });
                    arrival = finalArr;
                }
            }
        }
        else {
            const legDep = nextFlightTimeByCodes(schedulesData, origin.code, dest.code, originReady) || nextFlightTimeByCities(schedulesData, origin.city, dest.city, originReady);
            if (!legDep)
                return { estimatedDelivery: '', steps: [], totalHours: 0, totalDays: 0, flights: [] };
            const mins = findScheduleByCodes(schedulesData, origin.code, dest.code)?.flightMinutes || findScheduleByCities(schedulesData, origin.city, dest.city)?.flightMinutes || 90;
            arrival = addFlightMinutesWithTimezone(legDep, mins, origin.timezone, dest.timezone);
            flights.push({ origin: origin.code, destination: dest.code, departure: legDep, arrival });
        }
        const arrAdj = nextWeekday(arrival, dest.businessStart);
        const destProcStartBase = withinBusiness(arrAdj, dest.businessStart, dest.businessEnd) ? arrAdj : nextBusinessStart(arrAdj, dest.businessStart);
        const destProcStart = nextWeekday(destProcStartBase, dest.businessStart);
        const t = String(dest.type || '').toLowerCase();
        const deliveryHours = t === 'hub' ? 6 : t === 'regional' ? 8 : (t === 'domestic' || t === 'domestic'.toUpperCase()) ? 8 : 12;
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
    async availability({ originCode, destinationCode, originCity, destinationCity, date }) {
        const airportsData = await getAirports();
        const schedulesData = await getSchedules();
        let origin = null;
        let dest = null;
        if (originCode && destinationCode) {
            origin = findAirportByCode(airportsData, originCode);
            dest = findAirportByCode(airportsData, destinationCode);
        }
        else {
            origin = findAirportByCityOrCode(airportsData, String(originCity || ''));
            dest = findAirportByCityOrCode(airportsData, String(destinationCity || ''));
        }
        if (!origin || !dest)
            return { available: false, flights: [] };
        const base = new Date(date);
        let direct = findScheduleByCodes(schedulesData, origin.code, dest.code) || findScheduleByCities(schedulesData, origin.city, dest.city);
        const lst = [];
        if (direct) {
            for (let i = 0; i < 7; i++) {
                const d = new Date(base);
                d.setDate(d.getDate() + i);
                const dow = dayOfWeek(d);
                if (direct.daysOfWeek.includes(dow)) {
                    const dep = parseTime(direct.lastDepartureLocal);
                    d.setHours(dep.h, dep.m, 0, 0);
                    lst.push({ origin: origin.code, destination: dest.code, departure: d });
                }
            }
            return { available: lst.length > 0, flights: lst };
        }
        const originHub = await pickHubFor(origin.countryCode);
        const destHub = await pickHubFor(dest.countryCode);
        const hubCode = originHub && destHub ? originHub : undefined;
        const leg1 = hubCode ? (findScheduleByCodes(schedulesData, origin.code, hubCode) || findScheduleByCities(schedulesData, origin.city, (airportsData.find(a => a.code === hubCode)?.city || ''))) : null;
        const leg2 = hubCode ? (findScheduleByCodes(schedulesData, hubCode, dest.code) || findScheduleByCities(schedulesData, (airportsData.find(a => a.code === hubCode)?.city || ''), dest.city)) : null;
        if (!leg1 || !leg2)
            return { available: false, flights: [] };
        for (let i = 0; i < 7; i++) {
            const d1 = new Date(base);
            d1.setDate(d1.getDate() + i);
            const dow1 = dayOfWeek(d1);
            if (leg1.daysOfWeek.includes(dow1)) {
                const dep1 = parseTime(leg1.lastDepartureLocal);
                d1.setHours(dep1.h, dep1.m, 0, 0);
                const d2 = new Date(d1);
                d2.setHours(d2.getHours() + 3);
                const dow2 = dayOfWeek(d2);
                if (leg2.daysOfWeek.includes(dow2)) {
                    const dep2 = parseTime(leg2.lastDepartureLocal);
                    d2.setHours(dep2.h, dep2.m, 0, 0);
                    lst.push({ origin: origin.code, destination: hubCode, departure: d1 }, { origin: hubCode, destination: dest.code, departure: d2 });
                }
            }
        }
        return { available: lst.length > 0, flights: lst };
    }
};
exports.default = exports.etaService;
function findScheduleByCities(list, originCity, destinationCity) {
    return list.find(s => (s.originCity || '').toLowerCase() === originCity.toLowerCase() && (s.destinationCity || '').toLowerCase() === destinationCity.toLowerCase());
}
function nextFlightTimeByCities(schedList, originCity, destinationCity, ready) {
    const sch = findScheduleByCities(schedList, originCity, destinationCity);
    if (!sch)
        return null;
    const curDow = dayOfWeek(ready);
    const dep = parseTime(sch.lastDepartureLocal);
    const candidate = new Date(ready);
    candidate.setHours(dep.h, dep.m, 0, 0);
    if (sch.daysOfWeek.includes(curDow) && ready.getHours() <= dep.h)
        return candidate;
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
function addFlightMinutesWithTimezone(departure, minutes, originTz, destTz) {
    const depDT = luxon_1.DateTime.fromJSDate(departure, { zone: originTz || 'UTC' });
    const arrDT = depDT.plus({ minutes }).setZone(destTz || originTz || 'UTC');
    return arrDT.toJSDate();
}
async function pickHubFor(countryCode) {
    if (!countryCode)
        return undefined;
    const rows = await prisma_1.default.regionalHub.findMany({
        where: { country: String(countryCode).toUpperCase() },
        orderBy: { priority: 'asc' }
    });
    return rows[0]?.hubCode;
}
