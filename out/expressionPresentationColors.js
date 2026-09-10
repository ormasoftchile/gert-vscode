"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expressionColor = expressionColor;
exports.expressionSpans = expressionSpans;
exports.overlayExpressionSpans = overlayExpressionSpans;
const colors = {
    variable: ['#005CC5', '#79B8FF', '#9CDCFE', '#000080'],
    property: ['#24292E', '#B3D7FF', '#FFFFFF', '#000000'],
    namespace: ['#6F42C1', '#B392F0', '#FFAAFF', '#800080'],
    function: ['#6F42C1', '#D2A8FF', '#FFFF00', '#800080'],
    keyword: ['#D73A49', '#F97583', '#FFFF00', '#000080'],
    string: ['#032F62', '#9ECBFF', '#00FFFF', '#800000'],
    number: ['#005CC5', '#79B8FF', '#B5CEA8', '#006400'],
    boolean: ['#005CC5', '#FFAB70', '#FFFF00', '#000080'],
    null: ['#005CC5', '#FFAB70', '#FFFF00', '#000080'],
    operator: ['#D73A49', '#F97583', '#FFFF00', '#800000'],
    delimiter: ['#24292E', '#E1E4E8', '#FFFFFF', '#000000'],
    interpolation: ['#A04100', '#FFAB70', '#00FFFF', '#800000'],
    comment: ['#57606A', '#8B949E', '#00FF00', '#006400'],
};
function expressionColor(kind, palette) {
    return colors[kind][['light', 'dark', 'hc', 'hc-light'].indexOf(palette)];
}
function expressionSpans(value, palette) {
    return value.tokens.map(token => ({ start: token.start, end: token.end, color: expressionColor(token.class, palette), macro: true, expressionClass: token.class }));
}
// Clip host spans rather than relying on decoration insertion order for precedence.
function overlayExpressionSpans(host, expressions) {
    const overlay = [...expressions].sort((a, b) => a.start - b.start);
    const output = [];
    let first = 0;
    for (const token of host) {
        while (first < overlay.length && overlay[first].end <= token.start)
            first++;
        let cursor = token.start;
        for (let i = first; i < overlay.length && overlay[i].start < token.end; i++) {
            const span = overlay[i];
            if (span.start > cursor)
                output.push({ ...token, start: cursor, end: Math.min(span.start, token.end) });
            cursor = Math.max(cursor, span.end);
            if (cursor >= token.end)
                break;
        }
        if (cursor < token.end)
            output.push({ ...token, start: cursor });
    }
    return [...output, ...overlay].sort((a, b) => a.start - b.start);
}
//# sourceMappingURL=expressionPresentationColors.js.map