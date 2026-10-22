"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.shipmentsRouter = void 0;
const express_1 = require("express");
const shipments_service_1 = require("./shipments.service");
const eta_service_1 = require("./eta.service");
const authService_1 = require("../../services/authService");
const prisma_1 = __importDefault(require("../../utils/prisma"));
const emailService_1 = require("../../services/emailService");
const auditLog_1 = require("../../middlewares/auditLog");
const DELIVERED_STATUSES = new Set(['DELIVERED_SUCCESSFULLY', 'DELIVERY_CONFIRMED', 'SIGNATURE_OBTAINED']);
const VIEWER_ROLES = ['admin', 'finance', 'report', 'warehouse', 'operations'];
const STAFF_ROLES = ['admin', 'warehouse', 'driver', 'operations'];
exports.shipmentsRouter = (0, express_1.Router)();
/**
 * Resolve a shipment by DB id OR AWB reference (route params may carry either)
 * and return the FULL record (user, tracking events, documents). Sends 404
 * itself when nothing matches.
 */
async function resolveShipmentFull(req, res) {
    const shipment = await shipments_service_1.shipmentsService.findByIdOrReferenceFull(String(req.params.id));
    if (!shipment) {
        res.status(404).json({ success: false, error: 'Shipment not found' });
        return null;
    }
    return shipment;
}
/** Map service errors to proper HTTP status codes instead of blanket 500s. */
function sendError(res, error, fallbackMessage) {
    console.error(fallbackMessage, error);
    const err = error;
    const message = String(err?.message || '');
    let status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status === 500) {
        if (/not found/i.test(message))
            status = 404;
        else if (/forbidden|permission/i.test(message))
            status = 403;
        else if (/required|invalid/i.test(message))
            status = 400;
    }
    res.status(status).json({ success: false, error: status === 500 ? fallbackMessage : message });
}
// ============================================================================
// STATIC ROUTES — must be registered BEFORE the parameterized '/:id' routes,
// otherwise Express matches e.g. GET /track/:awb against GET /:id and the
// literal string "track" is looked up as a shipment id (404 shadowing bug).
// ============================================================================
// GET /api/shipments - List all shipments with pagination and filters (role-based visibility)
exports.shipmentsRouter.get('/', authService_1.requireAuth, async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
        const filters = {
            userId: req.query.userId,
            status: req.query.status,
            search: req.query.search,
            dateFrom: req.query.dateFrom,
            dateTo: req.query.dateTo,
            paymentType: req.query.paymentType,
        };
        // Get user info from authenticated request
        const userRole = req.user?.role;
        const userId = req.user?.sub; // sub contains the user ID from JWT
        const result = await shipments_service_1.shipmentsService.findAll(page, limit, filters, userRole, userId);
        res.json({
            success: true,
            data: result.shipments,
            pagination: result.pagination
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to fetch shipments');
    }
});
// ---------------------------------------------------------------------------
// Drafts: a draft is a Shipment row with isDraft=true and a provisional
// DRAFT-* reference. No real AWB is allocated until finalize. Owners (and
// admins) manage their own drafts; staff can see all drafts.
// ---------------------------------------------------------------------------
// GET /api/shipments/drafts - List drafts
exports.shipmentsRouter.get('/drafts', authService_1.requireAuth, async (req, res) => {
    try {
        const isStaff = await (0, authService_1.hasAnyRole)(req, ['admin', 'warehouse', 'operations']);
        const drafts = await shipments_service_1.shipmentsService.listDrafts(isStaff ? undefined : req.user?.sub);
        res.json({ success: true, data: drafts });
    }
    catch (error) {
        sendError(res, error, 'Failed to load drafts');
    }
});
// POST /api/shipments/drafts - Create a draft
exports.shipmentsRouter.post('/drafts', authService_1.requireAuth, async (req, res) => {
    try {
        if (!req.user?.sub) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const draft = await shipments_service_1.shipmentsService.createDraft(req.user.sub, req.body || {});
        (0, auditLog_1.audit)({ req, action: 'CREATE', entity: 'ShipmentDraft', entityId: draft.id }).catch(() => { });
        res.status(201).json({ success: true, data: draft });
    }
    catch (error) {
        sendError(res, error, 'Failed to create draft');
    }
});
// Load-and-authorize helper for draft routes. Sends the error response itself.
async function loadDraftForUser(req, res) {
    const draft = await shipments_service_1.shipmentsService.findDraftById(String(req.params.id));
    if (!draft) {
        res.status(404).json({ success: false, error: 'Draft not found' });
        return null;
    }
    const isAdmin = await (0, authService_1.hasAnyRole)(req, ['admin']);
    if (!isAdmin && draft.userId !== req.user?.sub) {
        res.status(403).json({ success: false, error: 'You do not have permission to access this draft' });
        return null;
    }
    return draft;
}
// GET /api/shipments/drafts/:id - Get one draft
exports.shipmentsRouter.get('/drafts/:id', authService_1.requireAuth, async (req, res) => {
    try {
        const draft = await loadDraftForUser(req, res);
        if (!draft)
            return;
        res.json({ success: true, data: draft });
    }
    catch (error) {
        sendError(res, error, 'Failed to load draft');
    }
});
// PUT /api/shipments/drafts/:id - Update a draft in place
exports.shipmentsRouter.put('/drafts/:id', authService_1.requireAuth, async (req, res) => {
    try {
        const draft = await loadDraftForUser(req, res);
        if (!draft)
            return;
        const updated = await shipments_service_1.shipmentsService.updateDraft(draft.id, req.body || {});
        res.json({ success: true, data: updated });
    }
    catch (error) {
        sendError(res, error, 'Failed to update draft');
    }
});
// DELETE /api/shipments/drafts/:id - Discard a draft
exports.shipmentsRouter.delete('/drafts/:id', authService_1.requireAuth, async (req, res) => {
    try {
        const draft = await loadDraftForUser(req, res);
        if (!draft)
            return;
        await shipments_service_1.shipmentsService.deleteDraft(draft.id);
        (0, auditLog_1.audit)({ req, action: 'DELETE', entity: 'ShipmentDraft', entityId: draft.id }).catch(() => { });
        res.json({ success: true, message: 'Draft deleted successfully' });
    }
    catch (error) {
        sendError(res, error, 'Failed to delete draft');
    }
});
// POST /api/shipments/drafts/:id/finalize - Allocate a real AWB and activate
exports.shipmentsRouter.post('/drafts/:id/finalize', authService_1.requireAuth, async (req, res) => {
    try {
        const draft = await loadDraftForUser(req, res);
        if (!draft)
            return;
        const finalized = await shipments_service_1.shipmentsService.finalizeDraft(draft.id, req.body || {}, req.user?.sub);
        (0, auditLog_1.audit)({ req, action: 'UPDATE', entity: 'Shipment', entityId: finalized.id, changes: { finalizedFromDraft: true, reference: finalized.reference } }).catch(() => { });
        emailService_1.emailService.sendNotificationEmail(finalized.userId, 'SHIPMENT_CREATED', {
            reference: finalized.reference ?? finalized.id,
            origin: finalized.originAddress,
            destination: finalized.destinationAddress,
            serviceType: finalized.serviceLevel,
        }).catch(err => console.error('[Shipment email] finalize draft:', err));
        res.json({ success: true, data: finalized });
    }
    catch (error) {
        sendError(res, error, 'Failed to finalize draft');
    }
});
// Airports and flight schedules management routes are defined below with full CRUD implementations.
exports.shipmentsRouter.get('/airports', authService_1.requireAuth, async (req, res) => {
    try {
        const rows = await prisma_1.default.airport.findMany({ orderBy: { city: 'asc' } });
        res.json({ success: true, data: rows });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to load airports' });
    }
});
exports.shipmentsRouter.get('/flight-schedules', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const rows = await prisma_1.default.flightSchedule.findMany({ orderBy: [{ originCity: 'asc' }, { destinationCity: 'asc' }] });
        res.json({ success: true, data: rows });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to load flight schedules' });
    }
});
// GET /api/shipments/track/:awb - Track shipment by AWB number
// Public: Track shipment by AWB number (no auth). Returns a PII-safe view
// (no owner name/email/phone, no documents).
exports.shipmentsRouter.get('/track/:awb', async (req, res) => {
    try {
        const shipment = await shipments_service_1.shipmentsService.findTrackingByAwb(req.params.awb);
        if (!shipment) {
            return res.status(404).json({
                success: false,
                error: 'Shipment not found'
            });
        }
        res.json({
            success: true,
            data: shipment
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to track shipment');
    }
});
// POST /api/shipments/eta/calculate
exports.shipmentsRouter.post('/eta/calculate', async (req, res) => {
    try {
        const result = await eta_service_1.etaService.calculateETA({
            originCode: req.body.originCode ? String(req.body.originCode) : undefined,
            destinationCode: req.body.destinationCode ? String(req.body.destinationCode) : undefined,
            originCity: req.body.originCity ? String(req.body.originCity) : undefined,
            destinationCity: req.body.destinationCity ? String(req.body.destinationCity) : undefined,
            serviceLevel: String(req.body.serviceLevel || ''),
            dropoffTime: String(req.body.dropoffTime || new Date().toISOString()),
            currentStatus: req.body.currentStatus ? String(req.body.currentStatus) : undefined,
        });
        res.json({ success: true, data: result });
    }
    catch (error) {
        // Invalid input (e.g. unparsable dropoffTime) is a 400; anything else
        // (including propagated database failures) maps through sendError so a
        // DB outage can never masquerade as a successful empty ETA.
        if (error instanceof RangeError) {
            return res.status(400).json({ success: false, error: 'dropoffTime is not a valid date' });
        }
        sendError(res, error, 'Failed to calculate ETA');
    }
});
// GET /api/shipments/eta/availability
exports.shipmentsRouter.get('/eta/availability', async (req, res) => {
    try {
        const result = await eta_service_1.etaService.availability({
            originCode: req.query.originCode ? String(req.query.originCode) : undefined,
            destinationCode: req.query.destinationCode ? String(req.query.destinationCode) : undefined,
            originCity: req.query.originCity ? String(req.query.originCity) : undefined,
            destinationCity: req.query.destinationCity ? String(req.query.destinationCity) : undefined,
            date: String(req.query.date || new Date().toISOString()),
        });
        res.json({ success: true, data: result });
    }
    catch (error) {
        sendError(res, error, 'Failed to get availability');
    }
});
// Service Level Settings management (admin)
exports.shipmentsRouter.get('/service-level-settings', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const rows = await prisma_1.default.serviceLevelSettings.findMany();
        res.json({ success: true, data: rows });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
});
exports.shipmentsRouter.post('/service-level-settings', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const created = await prisma_1.default.serviceLevelSettings.create({ data: req.body });
        res.status(201).json({ success: true, data: created });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to create setting' });
    }
});
exports.shipmentsRouter.put('/service-level-settings/:id', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const updated = await prisma_1.default.serviceLevelSettings.update({ where: { id: req.params.id }, data: req.body });
        res.json({ success: true, data: updated });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
});
exports.shipmentsRouter.delete('/service-level-settings/:id', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        await prisma_1.default.serviceLevelSettings.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to delete setting' });
    }
});
// Operating calendar management (admin)
exports.shipmentsRouter.get('/operating-calendar', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const rows = await prisma_1.default.operatingCalendar.findMany({ orderBy: { date: 'asc' } });
        res.json({ success: true, data: rows });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to load calendar' });
    }
});
exports.shipmentsRouter.post('/operating-calendar', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const created = await prisma_1.default.operatingCalendar.create({ data: req.body });
        res.status(201).json({ success: true, data: created });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to create calendar entry' });
    }
});
exports.shipmentsRouter.delete('/operating-calendar/:id', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        await prisma_1.default.operatingCalendar.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to delete calendar entry' });
    }
});
// Bulk schedules upload (admin)
exports.shipmentsRouter.post('/flight-schedules/bulk', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const items = Array.isArray(req.body) ? req.body : [];
        if (!items.length)
            return res.status(400).json({ success: false, error: 'No schedules provided' });
        await prisma_1.default.flightSchedule.createMany({ data: items });
        res.status(201).json({ success: true, count: items.length });
    }
    catch {
        res.status(500).json({ success: false, error: 'Failed to upload schedules' });
    }
});
exports.shipmentsRouter.post('/flight-schedules', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const created = await prisma_1.default.flightSchedule.create({ data: req.body });
        res.status(201).json({ success: true, data: created });
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Failed to create flight schedule' });
    }
});
exports.shipmentsRouter.put('/flight-schedules/:id', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const updated = await prisma_1.default.flightSchedule.update({ where: { id: req.params.id }, data: req.body });
        res.json({ success: true, data: updated });
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Failed to update flight schedule' });
    }
});
exports.shipmentsRouter.delete('/flight-schedules/:id', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        await prisma_1.default.flightSchedule.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Failed to delete flight schedule' });
    }
});
// Health check endpoint
exports.shipmentsRouter.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// Airports management (reads: any authenticated user — the shipment form uses
// them for city dropdowns; writes: admin/warehouse only)
exports.shipmentsRouter.post('/airports', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const created = await prisma_1.default.airport.create({ data: req.body });
        res.status(201).json({ success: true, data: created });
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Failed to create airport' });
    }
});
exports.shipmentsRouter.put('/airports/:code', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        const updated = await prisma_1.default.airport.update({ where: { code: req.params.code }, data: req.body });
        res.json({ success: true, data: updated });
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Failed to update airport' });
    }
});
exports.shipmentsRouter.delete('/airports/:code', authService_1.requireAuth, (0, authService_1.requireAnyRole)(['admin', 'warehouse']), async (req, res) => {
    try {
        await prisma_1.default.airport.delete({ where: { code: req.params.code } });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Failed to delete airport' });
    }
});
// ============================================================================
// PARAMETERIZED ('/:id') ROUTES — registered last. The route param may be a
// shipment DB id OR an AWB reference; both are resolved server-side.
// ============================================================================
// POST /api/shipments - Create new shipment
exports.shipmentsRouter.post('/', authService_1.requireAuth, async (req, res) => {
    try {
        const rawPt = req.body?.paymentType;
        const ptUpper = rawPt ? String(rawPt).toUpperCase() : '';
        if (!ptUpper || !['PREPAID', 'COLLECT', 'ACCOUNT'].includes(ptUpper)) {
            return res.status(400).json({ success: false, error: 'paymentType is required (PREPAID/COLLECT/ACCOUNT)' });
        }
        if (ptUpper === 'ACCOUNT') {
            const acct = req.body?.accountNumber;
            if (!acct || String(acct).trim().length === 0) {
                return res.status(400).json({ success: false, error: 'accountNumber is required when paymentType is ACCOUNT' });
            }
        }
        // Automatically set the userId from the authenticated user
        const shipmentData = {
            ...req.body,
            paymentType: ptUpper,
            userId: req.user?.sub // sub contains the user ID from JWT
        };
        const shipment = await shipments_service_1.shipmentsService.create(shipmentData);
        // Fire-and-forget: email notification + audit log
        const userId = shipmentData.userId ?? '';
        if (userId) {
            emailService_1.emailService.sendNotificationEmail(userId, 'SHIPMENT_CREATED', {
                reference: shipment.reference ?? shipment.id,
                origin: shipment.originAddress ?? req.body.originAddress,
                destination: shipment.destinationAddress ?? req.body.destinationAddress,
                serviceType: shipment.serviceLevel ?? req.body.serviceLevel,
            }).catch(err => console.error('[Shipment email] create:', err));
            (0, auditLog_1.audit)({ req, action: 'CREATE', entity: 'Shipment', entityId: shipment.id }).catch(() => { });
        }
        res.status(201).json({
            success: true,
            data: shipment
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to create shipment');
    }
});
// GET /api/shipments/:id - Get shipment by id or AWB reference
exports.shipmentsRouter.get('/:id', authService_1.requireAuth, async (req, res) => {
    try {
        const shipment = await resolveShipmentFull(req, res);
        if (!shipment)
            return;
        // Staff roles (incl. DB secondary roles) may view any shipment; others must own it.
        const canViewAllShipments = await (0, authService_1.hasAnyRole)(req, VIEWER_ROLES);
        if (!canViewAllShipments && shipment.userId !== req.user?.sub) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to view this shipment'
            });
        }
        // Hide unfinished drafts from non-staff viewers that are not the owner.
        if (shipment.isDraft && !canViewAllShipments && shipment.userId !== req.user?.sub) {
            return res.status(404).json({ success: false, error: 'Shipment not found' });
        }
        res.json({
            success: true,
            data: shipment
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to fetch shipment');
    }
});
// PUT /api/shipments/:id - Update shipment (accepts id or AWB reference)
exports.shipmentsRouter.put('/:id', authService_1.requireAuth, async (req, res) => {
    try {
        const existingShipment = await resolveShipmentFull(req, res);
        if (!existingShipment)
            return;
        // Staff roles (incl. DB secondary roles) may update any shipment; owners may update their own.
        const canUpdateAllShipments = await (0, authService_1.hasAnyRole)(req, ['admin', 'warehouse', 'operations']);
        if (!canUpdateAllShipments && existingShipment.userId !== req.user?.sub) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to update this shipment'
            });
        }
        const shipment = await shipments_service_1.shipmentsService.update(existingShipment.id, req.body);
        (0, auditLog_1.audit)({ req, action: 'UPDATE', entity: 'Shipment', entityId: existingShipment.id }).catch(() => { });
        res.json({
            success: true,
            data: shipment
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to update shipment');
    }
});
// DELETE /api/shipments/:id - Delete shipment (accepts id or AWB reference)
exports.shipmentsRouter.delete('/:id', authService_1.requireAuth, async (req, res) => {
    try {
        const existingShipment = await resolveShipmentFull(req, res);
        if (!existingShipment)
            return;
        // Deletion is admin-only (secondary admin role counts); owners cannot delete shipments.
        const canDelete = await (0, authService_1.hasAnyRole)(req, ['admin']);
        if (!canDelete) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to delete this shipment'
            });
        }
        await shipments_service_1.shipmentsService.delete(existingShipment.id);
        (0, auditLog_1.audit)({ req, action: 'DELETE', entity: 'Shipment', entityId: existingShipment.id }).catch(() => { });
        res.json({
            success: true,
            message: 'Shipment deleted successfully'
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to delete shipment');
    }
});
// GET /api/shipments/:id/eta - Authoritative ETA based on server shipment status
exports.shipmentsRouter.get('/:id/eta', authService_1.requireAuth, async (req, res) => {
    try {
        const shipment = await resolveShipmentFull(req, res);
        if (!shipment)
            return;
        const canViewAll = await (0, authService_1.hasAnyRole)(req, VIEWER_ROLES);
        if (!canViewAll && shipment.userId !== req.user?.sub) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        const originCity = String(shipment.originCity || '').trim();
        const destinationCity = String(shipment.destinationCity || '').trim();
        const dropoffTime = new Date(shipment.createdAt).toISOString();
        const serviceLevel = String(shipment.serviceLevel || 'standard');
        const currentStatus = String(shipment.status || '');
        const result = await eta_service_1.etaService.calculateETA({
            originCode: shipment.originAirportCode,
            destinationCode: shipment.destinationAirportCode,
            originCity: originCity || undefined,
            destinationCity: destinationCity || undefined,
            serviceLevel,
            dropoffTime,
            currentStatus,
        });
        res.json({ success: true, data: result });
    }
    catch (error) {
        if (error instanceof RangeError) {
            return res.status(400).json({ success: false, error: 'dropoffTime is not a valid date' });
        }
        sendError(res, error, 'Failed to calculate ETA');
    }
});
// POST /api/shipments/:id/tracking-events - Add tracking event
// STAFF-ONLY: tracking events mutate the shipment status, so customers/owners
// must never inject them (schedule-pickup below remains available to owners).
exports.shipmentsRouter.post('/:id/tracking-events', authService_1.requireAuth, (0, authService_1.requireAnyRole)(STAFF_ROLES), async (req, res) => {
    try {
        const existingShipment = await resolveShipmentFull(req, res);
        if (!existingShipment)
            return;
        if (!req.body?.status) {
            return res.status(400).json({ success: false, error: 'status is required' });
        }
        const event = await shipments_service_1.shipmentsService.addTrackingEvent(existingShipment.id, req.body);
        (0, auditLog_1.audit)({ req, action: 'STATUS_CHANGE', entity: 'Shipment', entityId: existingShipment.id, changes: { status: req.body.status } }).catch(() => { });
        // If this tracking event marks the shipment as delivered, send notification
        if (DELIVERED_STATUSES.has(req.body?.status ?? '')) {
            const shipment = existingShipment;
            if (shipment?.userId) {
                emailService_1.emailService.sendNotificationEmail(shipment.userId, 'SHIPMENT_DELIVERED', {
                    reference: shipment.reference ?? shipment.id,
                    destination: shipment.destinationAddress,
                    deliveredAt: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
                }).catch(err => console.error('[Shipment email] delivered:', err));
            }
        }
        res.status(201).json({
            success: true,
            data: event
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to add tracking event');
    }
});
// POST /api/shipments/:id/schedule-pickup - Schedule pickup
exports.shipmentsRouter.post('/:id/schedule-pickup', authService_1.requireAuth, async (req, res) => {
    try {
        const existingShipment = await resolveShipmentFull(req, res);
        if (!existingShipment)
            return;
        // Authorization: staff roles (incl. DB secondary roles) may act on any
        // shipment; everyone else must own it.
        const isStaff = await (0, authService_1.hasAnyRole)(req, ['admin', 'warehouse', 'operations']);
        if (!isStaff && existingShipment.userId !== req.user?.sub) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to schedule pickup for this shipment'
            });
        }
        const event = await shipments_service_1.shipmentsService.schedulePickup(existingShipment.id, req.body);
        res.status(201).json({
            success: true,
            data: event
        });
    }
    catch (error) {
        sendError(res, error, 'Failed to schedule pickup');
    }
});
// POST /api/shipments/:id/retry-awb - Retry AWB generation for temporary AWBs
exports.shipmentsRouter.post('/:id/retry-awb', authService_1.requireAuth, async (req, res) => {
    try {
        const existingShipment = await resolveShipmentFull(req, res);
        if (!existingShipment)
            return;
        const isStaff = await (0, authService_1.hasAnyRole)(req, ['admin', 'warehouse', 'operations']);
        if (!isStaff && existingShipment.userId !== req.user?.sub) {
            return res.status(403).json({ success: false, error: 'You do not have permission to retry AWB for this shipment' });
        }
        const updated = await shipments_service_1.shipmentsService.retryAWBGeneration(existingShipment.id);
        res.status(200).json({ success: true, data: updated });
    }
    catch (error) {
        sendError(res, error, 'Failed to retry AWB generation');
    }
});
