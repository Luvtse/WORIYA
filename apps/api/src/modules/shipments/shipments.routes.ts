import { Router } from 'express';
import { shipmentsService } from './shipments.service';
import { etaService } from './eta.service';
import { requireAuth, requireAnyRole, hasAnyRole } from '../../services/authService';
import prisma from '../../utils/prisma';
import { emailService } from '../../services/emailService';
import { audit } from '../../middlewares/auditLog';

const DELIVERED_STATUSES = new Set(['DELIVERED_SUCCESSFULLY', 'DELIVERY_CONFIRMED', 'SIGNATURE_OBTAINED']);
const VIEWER_ROLES = ['admin', 'finance', 'report', 'warehouse', 'operations'];
const STAFF_ROLES = ['admin', 'warehouse', 'driver', 'operations'];

export const shipmentsRouter = Router();

/**
 * Resolve a shipment by DB id OR AWB reference (route params may carry either)
 * and return the FULL record (user, tracking events, documents). Sends 404
 * itself when nothing matches.
 */
async function resolveShipmentFull(req: any, res: any) {
  const shipment = await shipmentsService.findByIdOrReferenceFull(String(req.params.id));
  if (!shipment) {
    res.status(404).json({ success: false, error: 'Shipment not found' });
    return null;
  }
  return shipment as any;
}

/** Map service errors to proper HTTP status codes instead of blanket 500s. */
function sendError(res: any, error: unknown, fallbackMessage: string) {
  console.error(fallbackMessage, error);
  const err = error as any;
  const message = String(err?.message || '');
  let status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
  if (status === 500) {
    if (/not found/i.test(message)) status = 404;
    else if (/forbidden|permission/i.test(message)) status = 403;
    else if (/required|invalid/i.test(message)) status = 400;
  }
  res.status(status).json({ success: false, error: status === 500 ? fallbackMessage : message });
}

// ============================================================================
// STATIC ROUTES — must be registered BEFORE the parameterized '/:id' routes,
// otherwise Express matches e.g. GET /track/:awb against GET /:id and the
// literal string "track" is looked up as a shipment id (404 shadowing bug).
// ============================================================================

// GET /api/shipments - List all shipments with pagination and filters (role-based visibility)
shipmentsRouter.get('/', requireAuth, async (req: any, res) => {
  try {
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
    const filters = {
      userId: req.query.userId as string,
      status: req.query.status as string,
      search: req.query.search as string,
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string,
      paymentType: req.query.paymentType as string,
    };

    // Get user info from authenticated request
    const userRole = req.user?.role;
    const userId = req.user?.sub; // sub contains the user ID from JWT

    const result = await shipmentsService.findAll(page, limit, filters, userRole, userId);
    res.json({
      success: true,
      data: result.shipments,
      pagination: result.pagination
    });
  } catch (error) {
    sendError(res, error, 'Failed to fetch shipments');
  }
});

// ---------------------------------------------------------------------------
// Drafts: a draft is a Shipment row with isDraft=true and a provisional
// DRAFT-* reference. No real AWB is allocated until finalize. Owners (and
// admins) manage their own drafts; staff can see all drafts.
// ---------------------------------------------------------------------------

// GET /api/shipments/drafts - List drafts
shipmentsRouter.get('/drafts', requireAuth, async (req: any, res) => {
  try {
    const isStaff = await hasAnyRole(req, ['admin', 'warehouse', 'operations']);
    const drafts = await shipmentsService.listDrafts(isStaff ? undefined : req.user?.sub);
    res.json({ success: true, data: drafts });
  } catch (error) {
    sendError(res, error, 'Failed to load drafts');
  }
});

// POST /api/shipments/drafts - Create a draft
shipmentsRouter.post('/drafts', requireAuth, async (req: any, res) => {
  try {
    if (!req.user?.sub) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const draft = await shipmentsService.createDraft(req.user.sub, req.body || {});
    audit({ req, action: 'CREATE', entity: 'ShipmentDraft', entityId: draft.id }).catch(() => {});
    res.status(201).json({ success: true, data: draft });
  } catch (error) {
    sendError(res, error, 'Failed to create draft');
  }
});

// Load-and-authorize helper for draft routes. Sends the error response itself.
async function loadDraftForUser(req: any, res: any) {
  const draft = await shipmentsService.findDraftById(String(req.params.id));
  if (!draft) {
    res.status(404).json({ success: false, error: 'Draft not found' });
    return null;
  }
  const isAdmin = await hasAnyRole(req, ['admin']);
  if (!isAdmin && draft.userId !== req.user?.sub) {
    res.status(403).json({ success: false, error: 'You do not have permission to access this draft' });
    return null;
  }
  return draft as any;
}

// GET /api/shipments/drafts/:id - Get one draft
shipmentsRouter.get('/drafts/:id', requireAuth, async (req: any, res) => {
  try {
    const draft = await loadDraftForUser(req, res);
    if (!draft) return;
    res.json({ success: true, data: draft });
  } catch (error) {
    sendError(res, error, 'Failed to load draft');
  }
});

// PUT /api/shipments/drafts/:id - Update a draft in place
shipmentsRouter.put('/drafts/:id', requireAuth, async (req: any, res) => {
  try {
    const draft = await loadDraftForUser(req, res);
    if (!draft) return;
    const updated = await shipmentsService.updateDraft(draft.id, req.body || {});
    res.json({ success: true, data: updated });
  } catch (error) {
    sendError(res, error, 'Failed to update draft');
  }
});

// DELETE /api/shipments/drafts/:id - Discard a draft
shipmentsRouter.delete('/drafts/:id', requireAuth, async (req: any, res) => {
  try {
    const draft = await loadDraftForUser(req, res);
    if (!draft) return;
    await shipmentsService.deleteDraft(draft.id);
    audit({ req, action: 'DELETE', entity: 'ShipmentDraft', entityId: draft.id }).catch(() => {});
    res.json({ success: true, message: 'Draft deleted successfully' });
  } catch (error) {
    sendError(res, error, 'Failed to delete draft');
  }
});

// POST /api/shipments/drafts/:id/finalize - Allocate a real AWB and activate
shipmentsRouter.post('/drafts/:id/finalize', requireAuth, async (req: any, res) => {
  try {
    const draft = await loadDraftForUser(req, res);
    if (!draft) return;
    const finalized = await shipmentsService.finalizeDraft(draft.id, req.body || {}, req.user?.sub);

    audit({ req, action: 'UPDATE', entity: 'Shipment', entityId: finalized.id, changes: { finalizedFromDraft: true, reference: finalized.reference } }).catch(() => {});
    emailService.sendNotificationEmail(finalized.userId, 'SHIPMENT_CREATED', {
      reference: finalized.reference ?? finalized.id,
      origin: finalized.originAddress,
      destination: finalized.destinationAddress,
      serviceType: finalized.serviceLevel,
    }).catch(err => console.error('[Shipment email] finalize draft:', err));

    res.json({ success: true, data: finalized });
  } catch (error) {
    sendError(res, error, 'Failed to finalize draft');
  }
});

// Airports and flight schedules management routes are defined below with full CRUD implementations.

shipmentsRouter.get('/airports', requireAuth, async (req: any, res) => {
  try {
    const rows = await prisma.airport.findMany({ orderBy: { city: 'asc' } });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load airports' });
  }
});

shipmentsRouter.get('/flight-schedules', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const rows = await prisma.flightSchedule.findMany({ orderBy: [{ originCity: 'asc' }, { destinationCity: 'asc' }] });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load flight schedules' });
  }
});

// GET /api/shipments/track/:awb - Track shipment by AWB number
// Public: Track shipment by AWB number (no auth). Returns a PII-safe view
// (no owner name/email/phone, no documents).
shipmentsRouter.get('/track/:awb', async (req: any, res) => {
  try {
    const shipment = await shipmentsService.findTrackingByAwb(req.params.awb);
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
  } catch (error) {
    sendError(res, error, 'Failed to track shipment');
  }
});

// POST /api/shipments/eta/calculate
shipmentsRouter.post('/eta/calculate', async (req: any, res) => {
  try {
    const result = await etaService.calculateETA({
      originCode: req.body.originCode ? String(req.body.originCode) : undefined,
      destinationCode: req.body.destinationCode ? String(req.body.destinationCode) : undefined,
      originCity: req.body.originCity ? String(req.body.originCity) : undefined,
      destinationCity: req.body.destinationCity ? String(req.body.destinationCity) : undefined,
      serviceLevel: String(req.body.serviceLevel || ''),
      dropoffTime: String(req.body.dropoffTime || new Date().toISOString()),
      currentStatus: req.body.currentStatus ? String(req.body.currentStatus) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) {
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
shipmentsRouter.get('/eta/availability', async (req: any, res) => {
  try {
    const result = await etaService.availability({
      originCode: req.query.originCode ? String(req.query.originCode) : undefined,
      destinationCode: req.query.destinationCode ? String(req.query.destinationCode) : undefined,
      originCity: req.query.originCity ? String(req.query.originCity) : undefined,
      destinationCity: req.query.destinationCity ? String(req.query.destinationCity) : undefined,
      date: String(req.query.date || new Date().toISOString()),
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error, 'Failed to get availability');
  }
});

// Service Level Settings management (admin)
shipmentsRouter.get('/service-level-settings', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const rows = await prisma.serviceLevelSettings.findMany();
    res.json({ success: true, data: rows });
  } catch { res.status(500).json({ success: false, error: 'Failed to load settings' }); }
});

shipmentsRouter.post('/service-level-settings', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const created = await prisma.serviceLevelSettings.create({ data: req.body });
    res.status(201).json({ success: true, data: created });
  } catch { res.status(500).json({ success: false, error: 'Failed to create setting' }); }
});

shipmentsRouter.put('/service-level-settings/:id', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const updated = await prisma.serviceLevelSettings.update({ where: { id: req.params.id }, data: req.body });
    res.json({ success: true, data: updated });
  } catch { res.status(500).json({ success: false, error: 'Failed to update setting' }); }
});

shipmentsRouter.delete('/service-level-settings/:id', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    await prisma.serviceLevelSettings.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, error: 'Failed to delete setting' }); }
});

// Operating calendar management (admin)
shipmentsRouter.get('/operating-calendar', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const rows = await prisma.operatingCalendar.findMany({ orderBy: { date: 'asc' } });
    res.json({ success: true, data: rows });
  } catch { res.status(500).json({ success: false, error: 'Failed to load calendar' }); }
});

shipmentsRouter.post('/operating-calendar', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const created = await prisma.operatingCalendar.create({ data: req.body });
    res.status(201).json({ success: true, data: created });
  } catch { res.status(500).json({ success: false, error: 'Failed to create calendar entry' }); }
});

shipmentsRouter.delete('/operating-calendar/:id', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    await prisma.operatingCalendar.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, error: 'Failed to delete calendar entry' }); }
});

// Bulk schedules upload (admin)
shipmentsRouter.post('/flight-schedules/bulk', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({ success: false, error: 'No schedules provided' });
    await prisma.flightSchedule.createMany({ data: items });
    res.status(201).json({ success: true, count: items.length });
  } catch { res.status(500).json({ success: false, error: 'Failed to upload schedules' }); }
});

shipmentsRouter.post('/flight-schedules', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const created = await prisma.flightSchedule.create({ data: req.body });
    res.status(201).json({ success: true, data: created });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to create flight schedule' }); }
});

shipmentsRouter.put('/flight-schedules/:id', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const updated = await prisma.flightSchedule.update({ where: { id: req.params.id }, data: req.body });
    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to update flight schedule' }); }
});

shipmentsRouter.delete('/flight-schedules/:id', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    await prisma.flightSchedule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to delete flight schedule' }); }
});

// Health check endpoint
shipmentsRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Airports management (reads: any authenticated user — the shipment form uses
// them for city dropdowns; writes: admin/warehouse only)
shipmentsRouter.post('/airports', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const created = await prisma.airport.create({ data: req.body });
    res.status(201).json({ success: true, data: created });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to create airport' }); }
});

shipmentsRouter.put('/airports/:code', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    const updated = await prisma.airport.update({ where: { code: req.params.code }, data: req.body });
    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to update airport' }); }
});

shipmentsRouter.delete('/airports/:code', requireAuth, requireAnyRole(['admin', 'warehouse']), async (req: any, res) => {
  try {
    await prisma.airport.delete({ where: { code: req.params.code } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to delete airport' }); }
});

// ============================================================================
// PARAMETERIZED ('/:id') ROUTES — registered last. The route param may be a
// shipment DB id OR an AWB reference; both are resolved server-side.
// ============================================================================

// POST /api/shipments - Create new shipment
shipmentsRouter.post('/', requireAuth, async (req: any, res) => {
  try {
    const rawPt = req.body?.paymentType;
    const ptUpper = rawPt ? String(rawPt).toUpperCase() : '';
    if (!ptUpper || !['PREPAID','COLLECT','ACCOUNT'].includes(ptUpper)) {
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

    const shipment = await shipmentsService.create(shipmentData);

    // Fire-and-forget: email notification + audit log
    const userId: string = shipmentData.userId ?? '';
    if (userId) {
      emailService.sendNotificationEmail(userId, 'SHIPMENT_CREATED', {
        reference: (shipment as any).reference ?? (shipment as any).id,
        origin: (shipment as any).originAddress ?? req.body.originAddress,
        destination: (shipment as any).destinationAddress ?? req.body.destinationAddress,
        serviceType: (shipment as any).serviceLevel ?? req.body.serviceLevel,
      }).catch(err => console.error('[Shipment email] create:', err));

      audit({ req, action: 'CREATE', entity: 'Shipment', entityId: (shipment as any).id }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      data: shipment
    });
  } catch (error) {
    sendError(res, error, 'Failed to create shipment');
  }
});

// GET /api/shipments/:id - Get shipment by id or AWB reference
shipmentsRouter.get('/:id', requireAuth, async (req: any, res) => {
  try {
    const shipment = await resolveShipmentFull(req, res);
    if (!shipment) return;

    // Staff roles (incl. DB secondary roles) may view any shipment; others must own it.
    const canViewAllShipments = await hasAnyRole(req, VIEWER_ROLES);

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
  } catch (error) {
    sendError(res, error, 'Failed to fetch shipment');
  }
});

// PUT /api/shipments/:id - Update shipment (accepts id or AWB reference)
shipmentsRouter.put('/:id', requireAuth, async (req: any, res) => {
  try {
    const existingShipment = await resolveShipmentFull(req, res);
    if (!existingShipment) return;

    // Staff roles (incl. DB secondary roles) may update any shipment; owners may update their own.
    const canUpdateAllShipments = await hasAnyRole(req, ['admin', 'warehouse', 'operations']);

    if (!canUpdateAllShipments && existingShipment.userId !== req.user?.sub) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to update this shipment'
      });
    }

    const shipment = await shipmentsService.update(existingShipment.id, req.body);
    audit({ req, action: 'UPDATE', entity: 'Shipment', entityId: existingShipment.id }).catch(() => {});
    res.json({
      success: true,
      data: shipment
    });
  } catch (error) {
    sendError(res, error, 'Failed to update shipment');
  }
});

// DELETE /api/shipments/:id - Delete shipment (accepts id or AWB reference)
shipmentsRouter.delete('/:id', requireAuth, async (req: any, res) => {
  try {
    const existingShipment = await resolveShipmentFull(req, res);
    if (!existingShipment) return;

    // Deletion is admin-only (secondary admin role counts); owners cannot delete shipments.
    const canDelete = await hasAnyRole(req, ['admin']);

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to delete this shipment'
      });
    }

    await shipmentsService.delete(existingShipment.id);
    audit({ req, action: 'DELETE', entity: 'Shipment', entityId: existingShipment.id }).catch(() => {});
    res.json({
      success: true,
      message: 'Shipment deleted successfully'
    });
  } catch (error) {
    sendError(res, error, 'Failed to delete shipment');
  }
});

// GET /api/shipments/:id/eta - Authoritative ETA based on server shipment status
shipmentsRouter.get('/:id/eta', requireAuth, async (req: any, res) => {
  try {
    const shipment = await resolveShipmentFull(req, res);
    if (!shipment) return;
    const canViewAll = await hasAnyRole(req, VIEWER_ROLES);
    if (!canViewAll && shipment.userId !== req.user?.sub) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const originCity = String((shipment as any).originCity || '').trim();
    const destinationCity = String((shipment as any).destinationCity || '').trim();
    const dropoffTime = new Date(shipment.createdAt).toISOString();
    const serviceLevel = String((shipment as any).serviceLevel || 'standard');
    const currentStatus = String(shipment.status || '');
    const result = await etaService.calculateETA({
      originCode: (shipment as any).originAirportCode,
      destinationCode: (shipment as any).destinationAirportCode,
      originCity: originCity || undefined,
      destinationCity: destinationCity || undefined,
      serviceLevel,
      dropoffTime,
      currentStatus,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof RangeError) {
      return res.status(400).json({ success: false, error: 'dropoffTime is not a valid date' });
    }
    sendError(res, error, 'Failed to calculate ETA');
  }
});

// POST /api/shipments/:id/tracking-events - Add tracking event
// STAFF-ONLY: tracking events mutate the shipment status, so customers/owners
// must never inject them (schedule-pickup below remains available to owners).
shipmentsRouter.post('/:id/tracking-events', requireAuth, requireAnyRole(STAFF_ROLES), async (req: any, res) => {
  try {
    const existingShipment = await resolveShipmentFull(req, res);
    if (!existingShipment) return;

    if (!req.body?.status) {
      return res.status(400).json({ success: false, error: 'status is required' });
    }

    const event = await shipmentsService.addTrackingEvent(existingShipment.id, req.body);

    audit({ req, action: 'STATUS_CHANGE', entity: 'Shipment', entityId: existingShipment.id, changes: { status: req.body.status } }).catch(() => {});

    // If this tracking event marks the shipment as delivered, send notification
    if (DELIVERED_STATUSES.has(req.body?.status ?? '')) {
      const shipment: any = existingShipment;
      if (shipment?.userId) {
        emailService.sendNotificationEmail(shipment.userId, 'SHIPMENT_DELIVERED', {
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
  } catch (error) {
    sendError(res, error, 'Failed to add tracking event');
  }
});

// POST /api/shipments/:id/schedule-pickup - Schedule pickup
shipmentsRouter.post('/:id/schedule-pickup', requireAuth, async (req: any, res) => {
  try {
    const existingShipment = await resolveShipmentFull(req, res);
    if (!existingShipment) return;

    // Authorization: staff roles (incl. DB secondary roles) may act on any
    // shipment; everyone else must own it.
    const isStaff = await hasAnyRole(req, ['admin', 'warehouse', 'operations']);

    if (!isStaff && existingShipment.userId !== req.user?.sub) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to schedule pickup for this shipment'
      });
    }

    const event = await shipmentsService.schedulePickup(existingShipment.id, req.body);
    res.status(201).json({
      success: true,
      data: event
    });
  } catch (error) {
    sendError(res, error, 'Failed to schedule pickup');
  }
});

// POST /api/shipments/:id/retry-awb - Retry AWB generation for temporary AWBs
shipmentsRouter.post('/:id/retry-awb', requireAuth, async (req: any, res) => {
  try {
    const existingShipment = await resolveShipmentFull(req, res);
    if (!existingShipment) return;

    const isStaff = await hasAnyRole(req, ['admin', 'warehouse', 'operations']);

    if (!isStaff && existingShipment.userId !== req.user?.sub) {
      return res.status(403).json({ success: false, error: 'You do not have permission to retry AWB for this shipment' });
    }

    const updated = await shipmentsService.retryAWBGeneration(existingShipment.id);
    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    sendError(res, error, 'Failed to retry AWB generation');
  }
});
