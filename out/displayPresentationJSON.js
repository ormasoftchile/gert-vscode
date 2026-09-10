"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDisplayJSON = parseDisplayJSON;
// JSON.parse discards duplicate keys. Track only the optional Markdown decoration
// while the wire is still available, without rejecting the underlying tool event.
function parseDisplayJSON(text) {
    const result = JSON.parse(text);
    const frames = [];
    const invalid = [];
    const decorationKey = (key) => key === 'display_presentation' || key === 'displayPresentation';
    const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
    const child = (frame) => {
        if (!frame)
            return result;
        if (frame.array)
            return Array.isArray(frame.value) ? frame.value[frame.index] : undefined;
        return record(frame.value) && frame.key !== undefined
            ? Object.getOwnPropertyDescriptor(frame.value, frame.key)?.value : undefined;
    };
    const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g;
    for (const match of text.matchAll(tokens)) {
        const token = match[0], frame = frames.at(-1);
        if (token === '{' || token === '[') {
            // Business values are opaque, even when their keys resemble decoration.
            const opaque = !!frame?.opaque || ['output', 'captures', 'evidence', 'inputs', 'results'].includes(frame?.key ?? '');
            const decoration = !opaque && frame?.key && decorationKey(frame.key) && record(frame.value)
                ? { owner: frame.value, key: frame.key } : undefined;
            frames.push({ value: child(frame), array: token === '[', index: 0, expectsKey: token === '{', keys: new Set(), decoration, opaque });
        }
        else if (token === '}' || token === ']') {
            frames.pop();
        }
        else if (token === ',') {
            if (frame) {
                frame.index++;
                frame.expectsKey = !frame.array;
            }
        }
        else if (token !== ':' && frame?.expectsKey) {
            const key = JSON.parse(token);
            if (!frame.opaque && frame.keys.has(key)) {
                if (frame.decoration)
                    invalid.push(frame.decoration);
                if (decorationKey(key) && record(frame.value))
                    invalid.push({ owner: frame.value, key });
            }
            frame.keys.add(key);
            frame.key = key;
            frame.expectsKey = false;
        }
    }
    for (const { owner, key } of invalid)
        owner[key] = null;
    return result;
}
//# sourceMappingURL=displayPresentationJSON.js.map