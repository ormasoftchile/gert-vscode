"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeDisplayWithdrawals = decodeDisplayWithdrawals;
exports.loadDisplayWithdrawals = loadDisplayWithdrawals;
exports.storeDisplayWithdrawals = storeDisplayWithdrawals;
const displayObservations_1 = require("./displayObservations");
function isIdentity(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
        Object.values(value).every(field => typeof field === 'string' ||
            (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0));
}
function decodeDisplayWithdrawals(value, runID) {
    let result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return result;
    for (const [nodeID, items] of Object.entries(value)) {
        if (!Array.isArray(items))
            continue;
        for (const item of items) {
            if (!item || typeof item.runID !== 'string' || (runID !== undefined && item.runID !== runID) ||
                typeof item.snapshotDigest !== 'string' || !isIdentity(item.identity))
                continue;
            result = (0, displayObservations_1.retainDisplayObservation)(result, nodeID, item.runID, { ...item.identity,
                output: {}, display_presentation_diagnostic: 'withdrawn',
            }, item.snapshotDigest);
        }
    }
    return result;
}
function loadDisplayWithdrawals(storage, runID) {
    try {
        return decodeDisplayWithdrawals(JSON.parse(storage.getItem(`gert.displayWithdrawals.v1:${runID}`) ?? '{}'), runID);
    }
    catch {
        return {};
    }
}
function storeDisplayWithdrawals(storage, runID, observations) {
    const retained = (0, displayObservations_1.retainDirectDisplayWithdrawals)(loadDisplayWithdrawals(storage, runID), { current: { displayObservations: observations } });
    storage.setItem(`gert.displayWithdrawals.v1:${runID}`, JSON.stringify(retained));
}
//# sourceMappingURL=displayObservationStorage.js.map