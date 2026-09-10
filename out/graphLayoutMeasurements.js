"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.preserveLayoutMeasurements = preserveLayoutMeasurements;
// React Flow's controlled node updates replace, rather than merge, measured dimensions.
function preserveLayoutMeasurements(layout, measured) {
    const previous = new Map(measured.map(node => [node.id, node]));
    return layout.map(node => {
        const current = previous.get(node.id);
        if (!current || current.type !== node.type ||
            current.style?.width !== node.style?.width || current.style?.height !== node.style?.height)
            return node;
        return { ...node, width: current.width, height: current.height };
    });
}
//# sourceMappingURL=graphLayoutMeasurements.js.map