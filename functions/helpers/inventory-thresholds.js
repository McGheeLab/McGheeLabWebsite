/* inventory-thresholds.js — V3.646
 *
 * The SERVER's copy of the low-stock derivation.
 *
 * MUST stay in step with LOW_PCT + severity() in rm/js/inventory-qty.js.
 * This is a deliberate duplication, not an oversight: functions/ is CommonJS on
 * Node, rm/js/ is browser globals with no build step, and there is no import
 * path between them in this repo. Two copies with a comment naming each other
 * beats a build step nobody else in the tree needs.
 *
 * The client WRITES stock_status (so the four legacy display consumers work with
 * no read-time compute and no dependency on this function running), but the
 * alerting trigger RECOMPUTES from the raw numbers and treats the client's value
 * as advisory. A client that lies about stock_status therefore cannot suppress
 * or forge an alert.
 */

const LOW_PCT = 0.20;

/** 'na' | 'full' | 'low' | 'out' — computed from the numbers, never from stock_status. */
function severity(item) {
  if (!item || item.qty_tracked !== true) return 'na';
  const rem = Number(item.qty_remaining);
  if (!isFinite(rem)) return 'na';
  if (rem <= 0) return 'out';
  const min = item.qty_min;
  if (min != null && isFinite(Number(min))) return rem <= Number(min) ? 'low' : 'full';
  const made = Number(item.qty_made);
  if (isFinite(made) && made > 0 && rem / made <= LOW_PCT) return 'low';
  return 'full';
}

/** The stock_status enum value, or null when the item isn't tracked. */
function deriveStatus(item) {
  if (!item || item.qty_tracked !== true) return null;
  const s = severity(item);
  return s === 'out' ? 'out_of_stock' : (s === 'low' ? 'low' : 'full');
}

/** True for the two severities worth telling a manager about. */
function isLowSeverity(s) { return s === 'low' || s === 'out'; }

module.exports = { LOW_PCT, severity, deriveStatus, isLowSeverity };
