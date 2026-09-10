"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.bundledPresentationHelper = bundledPresentationHelper;
exports.finiteHelper = finiteHelper;
exports.verifyPresentationHelper = verifyPresentationHelper;
exports.resolvePresentation = resolvePresentation;
exports.resolveCodePresentation = resolveCodePresentation;
exports.requireTypedPlanVersion = requireTypedPlanVersion;
exports.usesTypedResults = usesTypedResults;
exports.requireCompatibleExecution = requireCompatibleExecution;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const authoringProtocol_1 = require("./authoringProtocol");
const presentationProtocol_1 = require("./presentationProtocol");
let active = 0;
const waiters = [];
async function slot(signal) {
    if (signal?.aborted)
        throw new Error('stale-request');
    await new Promise((resolve, reject) => {
        const grant = () => { signal?.removeEventListener('abort', abort); active++; resolve(); };
        const abort = () => {
            const index = waiters.indexOf(grant);
            if (index >= 0)
                waiters.splice(index, 1);
            reject(new Error('stale-request'));
        };
        if (active < 2)
            grant();
        else {
            waiters.push(grant);
            signal?.addEventListener('abort', abort, { once: true });
        }
    });
    return () => { active--; waiters.shift()?.(); };
}
function bundledPresentationHelper(extensionPath) {
    return path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'gert.exe' : 'gert');
}
async function finiteHelper(binary, args, input = '', signal, observe, parse = authoringProtocol_1.parseAuthoringJSON) {
    const started = performance.now();
    let spawned, release, reason = 'ok';
    try {
        if (Buffer.byteLength(input, 'utf8') > presentationProtocol_1.MAX_SOURCE_BYTES)
            throw new Error('limit-exceeded');
        release = await slot(signal);
        return await new Promise((resolve, reject) => {
            let done = false, stdoutSize = 0, stderrSize = 0;
            const chunks = [];
            // The historical CLI rejects this fixed, input-free opt-in before reading
            // stdin. Match only its entire categorical diagnostic, never retain stderr.
            const optIn = args.at(-1);
            const command = args.slice(0, -1).join(' ');
            const rejections = {
                'authoring capabilities': 'authoring: invalid-request\n',
                'presentation capabilities': 'usage: gert presentation resolve --stdio | capabilities\n',
                'presentation expressions capabilities': 'usage: gert presentation expressions resolve --stdio | capabilities\n',
            };
            const legacyRejection = Buffer.from(rejections[command] ?? '');
            let legacyMatch = input === '' && (optIn === '--v2' || optIn === '--v3') && legacyRejection.length > 0;
            spawned = performance.now();
            const child = (0, child_process_1.spawn)(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
            const finish = (error, value) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', aborted);
                if (error) {
                    child.kill();
                    reject(new Error(error));
                }
                else
                    resolve(value);
            };
            const aborted = () => finish('stale-request');
            const timer = setTimeout(() => finish('helper-deadline'), 5000);
            signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted) {
                aborted();
                return;
            }
            child.on('error', () => finish('helper-unavailable'));
            child.stdin.on('error', () => finish('helper-unavailable'));
            child.stdout.on('data', (chunk) => {
                stdoutSize += chunk.length;
                if (stdoutSize > presentationProtocol_1.MAX_SOURCE_BYTES)
                    finish('limit-exceeded');
                else
                    chunks.push(chunk);
            });
            // Diagnostics are counted, never retained/logged: they may contain tool source.
            child.stderr.on('data', (chunk) => {
                if (legacyMatch)
                    legacyMatch = stderrSize + chunk.length <= legacyRejection.length &&
                        chunk.equals(legacyRejection.subarray(stderrSize, stderrSize + chunk.length));
                stderrSize += chunk.length;
                if (stderrSize > presentationProtocol_1.MAX_SOURCE_BYTES)
                    finish('limit-exceeded');
            });
            child.on('close', (code, signal) => {
                if (code !== 0) {
                    finish(code === 2 && !signal && stdoutSize === 0 && legacyMatch && stderrSize === legacyRejection.length
                        ? `unsupported-${command.replaceAll(' ', '-')}-${optIn.slice(2)}`.replace('authoring-capabilities-', 'authoring-') : 'helper-unavailable');
                    return;
                }
                try {
                    finish(undefined, parse(Buffer.concat(chunks)));
                }
                catch {
                    finish('invalid-helper-response');
                }
            });
            child.stdin.end(input, 'utf8');
        });
    }
    catch (error) {
        reason = error instanceof Error && /^(?:limit-exceeded|stale-request|helper-unavailable|helper-deadline|invalid-helper-response|unsupported-authoring-v2)$/.test(error.message)
            ? error.message : 'helper-unavailable';
        throw error;
    }
    finally {
        release?.();
        const ended = performance.now();
        // Observability must not change queue ownership, cancellation or the result.
        try {
            observe?.({ queueMs: Math.round((spawned ?? ended) - started),
                processMs: spawned === undefined ? null : Math.round(ended - spawned), totalMs: Math.round(ended - started), reason });
        }
        catch { /* Diagnostic sink only. */ }
    }
}
async function verifyPresentationHelper(binary, signal, observe) {
    try {
        (0, presentationProtocol_1.decodeCapabilities)(await finiteHelper(binary, ['presentation', 'capabilities', '--v3'], '', signal, observe), 3);
    }
    catch (error) {
        if (!(error instanceof Error) || error.message !== 'unsupported-presentation-capabilities-v3')
            throw error;
        (0, presentationProtocol_1.decodeCapabilities)(await finiteHelper(binary, ['presentation', 'capabilities'], '', signal, observe));
    }
}
async function resolvePresentation(binary, request, signal, observe) {
    if (request.overlays.length > 128)
        throw new Error('limit-exceeded');
    return (0, presentationProtocol_1.decodeReply)(await finiteHelper(binary, ['presentation', 'resolve', '--stdio'], JSON.stringify(request), signal, observe), request);
}
async function resolveCodePresentation(binary, request, signal) {
    const timings = {};
    let phase = 'capabilities';
    try {
        await verifyPresentationHelper(binary, signal, timing => { timings.capabilities = timing; });
        phase = 'resolve';
        return { reply: await resolvePresentation(binary, request, signal, timing => { timings.resolve = timing; }), timings };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason = /^(?:helper-(?:unavailable|deadline)|limit-exceeded|stale-request|invalid-[a-z-]+|unknown-presentation-field|missing-presentation-reason|incomplete-presentation-identity|duplicate-presentation-[a-z-]+|incompatible-[a-z-]+)$/.test(message)
            ? message : 'presentation-unavailable';
        if (timings[phase])
            timings[phase].reason = reason;
        return { reason, timings };
    }
}
function requireTypedPlanVersion(value) {
    try {
        (0, presentationProtocol_1.decodeCapabilities)(value, 3);
    }
    catch {
        throw new Error('Unsupported typed Results capability: this runbook requires an execution-plan/v3 runtime. No execution was started.');
    }
}
function usesTypedResults(document) {
    return document.schema_version === '3' || !!document.frames?.some(frame => frame.invocation !== undefined) ||
        document.nodes.some(node => node.data.kind === 'results' || node.data.kind === 'assign');
}
async function requireCompatibleExecution(binary, document, localMetadata) {
    if (usesTypedResults(document)) {
        let capabilities;
        try {
            capabilities = await finiteHelper(binary, ['presentation', 'capabilities', '--v3'], '');
        }
        catch (error) {
            throw new Error(`Typed Results capability query failed (${error instanceof Error ? error.message : 'helper-unavailable'}). No execution was started.`);
        }
        requireTypedPlanVersion(capabilities);
    }
    const metadata = localMetadata?.bindings.some(binding => binding.actions.some(action => [...action.arguments, ...action.outputs].some(field => field.presentation !== undefined))) || document.nodes.some(node => {
        const presentation = node.data.details?.code_presentation;
        return presentation && [...presentation.arguments, ...presentation.outputs].some(field => field.presentation !== undefined);
    });
    if (!metadata)
        return;
    try {
        await verifyPresentationHelper(binary);
    }
    catch {
        throw new Error('This runbook declares code presentation and requires an execution-plan/v2 runtime. Set gert.binaryPath to the matching upgraded runtime. Authoring uses the bundled helper independently.');
    }
}
//# sourceMappingURL=presentationClient.js.map