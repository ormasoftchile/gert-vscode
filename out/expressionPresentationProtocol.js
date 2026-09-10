"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPRESSION_CLASSES = exports.EXPRESSION_GRAMMAR = void 0;
exports.expressionPointer = expressionPointer;
exports.decodeExpressionPresentation = decodeExpressionPresentation;
exports.decodeExpressionCapabilities = decodeExpressionCapabilities;
exports.decodeExpressionReply = decodeExpressionReply;
exports.expressionTextMatches = expressionTextMatches;
exports.pointerParts = pointerParts;
exports.safeExpressionText = safeExpressionText;
const presentationProtocol_1 = require("./presentationProtocol");
exports.EXPRESSION_GRAMMAR = 'gert-expression/v2';
exports.EXPRESSION_CLASSES = ['variable', 'property', 'namespace', 'function', 'keyword', 'string', 'number',
    'boolean', 'null', 'operator', 'delimiter', 'interpolation', 'comment'];
function closed(value, keys) {
    const v = (0, presentationProtocol_1.record)(value);
    if (Object.keys(v).some(k => !keys.includes(k)))
        throw new Error('unknown-expression-field');
    return v;
}
function integer(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('invalid-expression-offset');
    return value;
}
function expressionPointer(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || /~(?![01])/u.test(value) || value.split('/').length > 129)
        throw new Error('invalid-expression-pointer');
    return value;
}
function bounded(value) {
    if (new TextEncoder().encode(JSON.stringify(value)).length > presentationProtocol_1.MAX_SOURCE_BYTES)
        throw new Error('limit-exceeded');
}
function array(value, cap) {
    if (!Array.isArray(value) || value.length > cap)
        throw new Error('limit-exceeded');
    return value;
}
const valueKeys = ['mode', 'text_length', 'text_digest', 'tokens'];
function supportedGrammar(value) {
    return value === 'gert-expression/v1' || value === exports.EXPRESSION_GRAMMAR;
}
function decodeValue(v, grammar) {
    const text_length = integer(v.text_length);
    if (text_length > presentationProtocol_1.MAX_CODE_UNITS || (v.mode !== 'gxl' && v.mode !== 'gis' && !(grammar === exports.EXPRESSION_GRAMMAR && v.mode === 'regex')) ||
        typeof v.text_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.text_digest))
        throw new Error('invalid-expression-value');
    let end = 0;
    const tokens = array(v.tokens, 65536).map(item => {
        const token = closed(item, ['start', 'end', 'class']);
        const start = integer(token.start), stop = integer(token.end);
        if (start < end || stop <= start || stop > text_length || !exports.EXPRESSION_CLASSES.includes(token.class))
            throw new Error('invalid-expression-token');
        end = stop;
        return { start, end: stop, class: token.class };
    });
    return { mode: v.mode, text_length, text_digest: v.text_digest, tokens };
}
function tokenBudget(values) {
    if (values.reduce((sum, v) => sum + v.tokens.length, 0) > 65536)
        throw new Error('limit-exceeded');
}
function decodeExpressionPresentation(value) {
    try {
        bounded(value);
        const v = closed(value, ['version', 'grammar_version', 'values']);
        if (v.version !== 1 || !supportedGrammar(v.grammar_version))
            return undefined;
        const grammar = v.grammar_version;
        const values = array(v.values, 4096).map(item => {
            const entry = closed(item, [...valueKeys, 'path']);
            return { ...decodeValue(entry, grammar), path: expressionPointer(entry.path) };
        });
        tokenBudget(values);
        if (new Set(values.map(v => v.path)).size !== values.length)
            return undefined;
        return { version: 1, grammar_version: grammar, values };
    }
    catch {
        return undefined;
    }
}
function decodeExpressionCapabilities(value, version = 1) {
    bounded(value);
    const v = closed(value, ['schema_version', 'resolver_version', 'grammar_version', 'modes', 'max_value_code_units', 'max_regions', 'max_tokens']);
    if (typeof v.schema_version !== 'string' || typeof v.resolver_version !== 'string' || typeof v.grammar_version !== 'string' ||
        !Array.isArray(v.modes) || !v.modes.every(mode => typeof mode === 'string') ||
        ![v.max_value_code_units, v.max_regions, v.max_tokens].every(limit => typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0)) {
        throw new Error('invalid-expression-capabilities');
    }
    const suppliedModes = v.modes;
    const modes = v.grammar_version === exports.EXPRESSION_GRAMMAR ? ['gxl', 'gis', 'regex'] : ['gxl', 'gis'];
    if (v.schema_version !== `expression-capabilities/v${version}` || v.resolver_version !== `core-expression/v${version}`) {
        throw new Error('invalid-expression-capabilities');
    }
    if (!supportedGrammar(v.grammar_version) || suppliedModes.length !== modes.length ||
        !modes.every(mode => suppliedModes.includes(mode)) || v.max_value_code_units !== 32768 ||
        v.max_regions !== 4096 || v.max_tokens !== 65536)
        throw new Error('unsupported-expression-capabilities');
}
function decodeExpressionReply(value, request) {
    bounded(value);
    const v = closed(value, ['schema_version', 'resolver_version', 'grammar_version', 'request_id', 'context', 'document', 'status', 'reason', 'regions']);
    const resolver = request.schema_version === 'expression-resolve/v3' ? 'core-expression/v3' : 'core-expression/v1';
    if (v.schema_version !== request.schema_version || v.resolver_version !== resolver || !supportedGrammar(v.grammar_version))
        throw new Error('unsupported-expression-protocol');
    const grammar = v.grammar_version;
    const context = closed(v.context, ['project_root', 'generation', 'package_map_path', 'entrypoint_path', 'package_root']);
    const document = closed(v.document, ['uri', 'version']);
    if (v.request_id !== request.request_id || document.uri !== request.document.uri || document.version !== request.document.version ||
        Object.keys(context).length !== Object.keys(request.context).length ||
        Object.entries(request.context).some(([k, val]) => context[k] !== val))
        throw new Error('stale-request');
    if (v.status !== 'resolved' && v.status !== 'unavailable' ||
        v.reason !== undefined && !['incomplete-source', 'invalid-request', 'limit-exceeded'].includes(v.reason) ||
        v.status === 'unavailable' && v.reason === undefined)
        throw new Error('invalid-expression-status');
    let end = 0;
    const regions = array(v.regions, 4096).map(item => {
        const region = closed(item, [...valueKeys, 'yaml_path', 'range']);
        const range = closed(region.range, ['start', 'end']);
        const start = integer(range.start), stop = integer(range.end);
        if (start < end || stop <= start || stop > request.document.text.length)
            throw new Error('invalid-expression-range');
        end = stop;
        return { ...decodeValue(region, grammar), yaml_path: expressionPointer(region.yaml_path), range: { start, end: stop } };
    });
    tokenBudget(regions);
    if (v.status === 'unavailable' && regions.length || new Set(regions.map(r => r.yaml_path)).size !== regions.length)
        throw new Error('invalid-expression-regions');
    return { schema_version: request.schema_version, resolver_version: resolver, grammar_version: grammar,
        request_id: request.request_id, context: request.context, document: { uri: request.document.uri, version: request.document.version },
        status: v.status, ...(v.reason ? { reason: v.reason } : {}), regions };
}
function expressionTextMatches(text, value, digest) {
    const boundary = (offset) => !(offset > 0 && offset < text.length &&
        /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
    return text.length === value.text_length && digest === value.text_digest &&
        value.tokens.every(t => boundary(t.start) && boundary(t.end));
}
function pointerParts(pointer) {
    return expressionPointer(pointer).slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function safeExpressionText(root, pointer) {
    try {
        const parts = pointerParts(pointer);
        let value = root;
        for (const [index, key] of parts.entries()) {
            if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
                return undefined;
            if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key))
                return undefined;
            // Only StepDetails' serialized NamedDetailValue arrays own this flag.
            // Their value descendants are arbitrary authored data, not typed records.
            if (index === 2 && ['arguments', 'bindings', 'request', 'filter', 'collect'].includes(parts[0]) &&
                Array.isArray(root[parts[0]]) &&
                value.redacted === true)
                return undefined;
            value = value[key];
        }
        return typeof value === 'string' && !/(?:\[(?:redacted|sensitive|truncated)\]|<(?:redacted|sensitive|truncated)>)/i.test(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=expressionPresentationProtocol.js.map