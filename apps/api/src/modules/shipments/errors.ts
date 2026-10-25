/**
 * Domain error classes shared by shipment-module services (ETA, AWB, tracking).
 *
 * These extend the project's established AppError contract so the global
 * error middleware (src/middlewares/error.ts) can map them to sanitized HTTP
 * responses instead of letting infrastructure failures masquerade as empty
 * results.
 */
import { AppError } from '../../middlewares/AppError';

/** The origin and/or destination airport is not present in the Airport master data. */
export class EtaRouteNotFoundError extends AppError {
  constructor(message = 'Origin or destination airport is not configured') {
    super(message, 404, 'ETA_ROUTE_NOT_FOUND');
  }
}

/** No flight schedule exists for the requested leg(s); the route is unavailable. */
export class EtaRouteUnavailableError extends AppError {
  constructor(message = 'No flight schedule is available for this route') {
    super(message, 422, 'ETA_ROUTE_UNAVAILABLE');
  }
}

/** The caller supplied an invalid or unparsable date / parameter. */
export class EtaValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

/** A database outage or query failure occurred while computing the ETA. */
export class EtaDataError extends AppError {
  constructor(message = 'Failed to load routing data required for ETA calculation') {
    super(message, 503, 'ETA_DATA_UNAVAILABLE');
  }
}
