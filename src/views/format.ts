import { PiSession } from '../sessions/types';

export const NO_COST = '–';

/** Formats a USD cost with two decimals, or an en dash when unknown (FR-8 to FR-10). */
export function formatCost(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost)) {
		return NO_COST;
	}
	// Round half away from zero on the decimal representation, so 1.005 gives $1.01.
	const rounded = Math.round(Number((Math.abs(cost) * 100).toPrecision(15))) / 100;
	const text = rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return `${cost < 0 ? '-' : ''}$${text}`;
}

/** Sum of the known costs, or `undefined` when no session has a cost (FR-11). */
export function totalCost(sessions: readonly PiSession[]): number | undefined {
	let total: number | undefined;
	for (const s of sessions) {
		if (s.cost !== undefined) {
			total = (total ?? 0) + s.cost;
		}
	}
	return total;
}
