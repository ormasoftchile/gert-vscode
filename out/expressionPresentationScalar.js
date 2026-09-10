"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveExpressionScalars = resolveExpressionScalars;
const crypto_1 = require("crypto");
const yaml_1 = require("yaml");
const presentationScalar_1 = require("./presentationScalar");
const expressionPresentationProtocol_1 = require("./expressionPresentationProtocol");
function resolveExpressionScalars(source, reply) {
    if (reply?.status !== 'resolved')
        return [];
    const doc = (0, yaml_1.parseDocument)(source, { keepSourceTokens: true, prettyErrors: false, strict: true, uniqueKeys: true });
    const mapped = [];
    for (const expression of reply.regions) {
        try {
            const node = doc.getIn((0, expressionPresentationProtocol_1.pointerParts)(expression.yaml_path), true);
            if (!(0, yaml_1.isScalar)(node) || typeof node.value !== 'string' || !node.range ||
                node.range[0] !== expression.range.start || node.range[1] !== expression.range.end ||
                doc.errors.some(e => e.code === 'DUPLICATE_KEY' || e.pos[0] <= node.range[2]))
                continue;
            const digest = 'sha256:' + (0, crypto_1.createHash)('sha256').update(node.value, 'utf8').digest('hex');
            if (!(0, expressionPresentationProtocol_1.expressionTextMatches)(node.value, expression, digest))
                continue;
            mapped.push({ ...(0, presentationScalar_1.mapScalar)(node), expression });
        }
        catch { /* Ambiguous/incomplete source is not paintable. */ }
    }
    return mapped;
}
//# sourceMappingURL=expressionPresentationScalar.js.map