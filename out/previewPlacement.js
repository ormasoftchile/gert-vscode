"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePreviewPanelTarget = resolvePreviewPanelTarget;
function resolvePreviewPanelTarget(openLocation, runbookViewColumn) {
    if (openLocation === 'beside') {
        return 'beside';
    }
    return runbookViewColumn ?? 'active';
}
//# sourceMappingURL=previewPlacement.js.map