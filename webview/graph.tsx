import dagre from '@dagrejs/dagre';
import { ArrowLeft, ArrowRight, Bug, CircleDot, PanelRight, Play, RotateCcw, Square } from 'lucide-react';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './graph.css';
import {
  RunOverview,
  StepInspector,
  type InspectorRuntimeState,
  type RuntimeLogLine,
} from './inspector';
import type {
  GraphDocument,
  GraphGroup,
  GraphNode,
  GraphNodeData,
} from '../src/directGraphPreview';
import type { DirectDebugBreakpoint, DirectDebugCallFrame, DirectDebugPhase } from '../src/directDebug';
import { activeGraphNodeIDs, edgeRuntimeState, withBranchMerges } from '../src/branchTopology';
import type { GraphEdge } from '../src/directGraphPreview';
import { isTerminalRunStatus } from '../src/runStatus';
import {
  buildRouteProjectionIndex,
  computeRouteProjection,
  projectRouteDocument,
  type RouteProjectionScope,
} from '../src/routeProjection';
import type { RouteTestArtifact } from '../src/routeTestTypes';
import { parseHostActionResponse, type HostActionResponseEnvelope } from '../src/hostActionWebviewProtocol';
import {
  collectorInputType,
  formatCollectorReviewValue as collectorReviewValue,
  normalizeCollectorValues as collectorValues,
} from '../src/collectorFieldValues';
import {
  RouteTestPane,
  routeTestMatchesTarget,
  type RouteTestOutcome,
  type SavedRouteTestView,
} from './routeTestPane';

type NodeStyle = 'smooth-curves' | 'minimalist' | 'header-badges';

type HostMessage =
  | { type: 'loading' }
  | {
      type: 'graph';
      document: GraphDocument;
      style: NodeStyle;
      routeTestContext?: { runbook: string; planHash: string };
      routeTests?: SavedRouteTestView[];
      testMode?: boolean;
    }
  | { type: 'style'; style: NodeStyle }
  | { type: 'graph.reload-state'; active: boolean }
  | { type: 'error'; message: string }
  | { type: 'run.starting'; routeTest?: boolean }
  | { type: 'run.frame'; frame: StdioFrame }
  | { type: 'run.error'; message: string }
  | { type: 'run.stderr'; text: string }
  | { type: 'run.exit'; code: number | null; signal: string | null }
  | { type: 'route-tests'; routeTests: SavedRouteTestView[] }
  | { type: 'route-test.saved'; artifact: RouteTestArtifact; running: boolean }
  | { type: 'route-test.error'; message: string }
  | {
      type: 'test.action';
      action: 'set-input' | 'run' | 'debug' | 'reset' | 'cancel' | 'answer' | 'toggle-breakpoint' | 'select-node' | 'run-route-test' | 'save-route-test' | 'save-route-test-result' | 'click-button' | 'click-route-test-checkbox' | 'toggle-choice' | 'set-collector-field';
      name?: string;
      value?: string;
      answer?: Record<string, unknown>;
      artifact?: RouteTestArtifact;
    }
  | HostActionResponseEnvelope;

interface StdioFrame {
  type: string;
  version: 'gert-stdio/v1';
  runID?: string;
  status?: string;
  event?: RuntimeEvent;
  interaction?: PendingInteraction;
  turnID?: string;
  steps?: Array<{
    step_id?: string;
    node_id?: string;
    status?: string;
    error?: string;
    duration_ms?: number;
    output?: Record<string, unknown>;
  }>;
  routeTest?: RouteTestOutcome;
}

interface RuntimeEvent {
  kind: string;
  run_id: string;
  sequence: number;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

type RuntimeNodeState = InspectorRuntimeState;

interface DebugActualResult {
  status: string;
  output?: Record<string, unknown>;
  error?: string;
}

interface DebugWatchResult {
  expression: string;
  value?: unknown;
  error?: string;
}

interface DebugBreakPayload {
  phase: DirectDebugPhase;
  callPath?: DirectDebugCallFrame[];
  invocation: number;
  attempt: number;
  variables?: Record<string, unknown>;
  protectedVariables?: string[];
  actual?: DebugActualResult;
  outputProtected?: boolean;
  canStepInto?: boolean;
  watches?: DebugWatchResult[];
}

interface DebugBreakpointView extends DirectDebugBreakpoint {
  nodeID: string;
}

interface InputDecl {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: string[];
  enumRedacted?: boolean;
  enumMemberCount?: number;
}

interface InteractionOption {
  label?: string;
  display_label?: string;
  display_value?: string;
  value: string;
  hint?: string;
}

interface InteractionField {
  name: string;
  display_name?: string;
  type: string;
  label?: string;
  required?: boolean;
  default?: unknown;
  hint?: string;
  options?: InteractionOption[];
  multiple?: boolean;
  ephemeral?: boolean;
  validation?: {
    min_length?: number;
    max_length?: number;
    pattern?: string;
    format?: string;
    min?: number;
    max?: number;
    step?: number;
  };
}

interface PendingInteraction {
  type: 'pending';
  runID: string;
  turnID: string;
  stepID: string;
  nodeID?: string;
  kind: 'choice' | 'decision' | 'collector' | 'approval' | 'host_action' | 'debug_break';
  correlationID?: string;
  title?: string;
  prompt?: string;
  options?: InteractionOption[];
  routes?: InteractionOption[];
  fields?: InteractionField[];
  multiple?: boolean;
  min?: number;
  max?: number;
  host_action?: { capability: string; request: Record<string, unknown> };
  debug?: DebugBreakPayload;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const DEFAULT_INSPECTOR_RATIO = 0.31;
const MIN_INSPECTOR_RATIO = 0.2;
const MAX_INSPECTOR_RATIO = 0.65;

function clampInspectorRatio(value: number): number {
  return Math.min(MAX_INSPECTOR_RATIO, Math.max(MIN_INSPECTOR_RATIO, value));
}

function restoredInspectorRatio(): number {
  const state = vscode.getState?.();
  if (!state || typeof state !== 'object' || Array.isArray(state)) return DEFAULT_INSPECTOR_RATIO;
  const value = (state as { inspectorRatio?: unknown }).inspectorRatio;
  return typeof value === 'number' && Number.isFinite(value)
    ? clampInspectorRatio(value)
    : DEFAULT_INSPECTOR_RATIO;
}

function persistInspectorRatio(inspectorRatio: number): void {
  const previous = vscode.getState?.();
  const state = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : {};
  vscode.setState?.({ ...state, inspectorRatio });
}

const kindLabels: Record<string, string> = {
  approve: 'Approval',
  assert: 'Assert',
  branch: 'Branch',
  choice: 'Choice',
  cli: 'CLI',
  collector: 'Collector',
  compensate: 'Compensate',
  decision: 'Decision',
  display: 'Display',
  end: 'End',
  extension: 'Extension',
  include: 'Include',
  iterate: 'Iterate',
  noop: 'No-op',
  parallel: 'Parallel',
  tool: 'Tool',
  wait_for_event: 'Wait event',
};

const RuntimeNodesContext = createContext<Readonly<Record<string, RuntimeNodeState>>>({});
const DebugBreakpointsContext = createContext<ReadonlySet<string>>(new Set());

function breakpointKey(nodeID: string, phase: DirectDebugPhase): string {
  return `${nodeID}:${phase}`;
}

function StepNode({ data, selected }: NodeProps<GraphNodeData>) {
  const runtimeNodes = useContext(RuntimeNodesContext);
  const debugBreakpoints = useContext(DebugBreakpointsContext);
  const kind = typeof data.kind === 'string' ? data.kind : 'step';
  const id = typeof data.id === 'string' ? data.id : '';
  const title = typeof data.title === 'string' ? data.title : '';
  const isTerminal = kind === 'end';
  const runtime = runtimeNodes[id];
  const status = runtime?.status ?? (typeof data.status === 'string' ? data.status : 'pending');
  const error = runtime?.error ?? (typeof data.error === 'string' ? data.error : '');
  const hasBeforeBreakpoint = debugBreakpoints.has(breakpointKey(id, 'before'));
  const hasAfterBreakpoint = debugBreakpoints.has(breakpointKey(id, 'after'));
  const isCurrent = status === 'running' || status === 'delaying';
  const focusedLabel = `Focused step: ${id}`;
  const currentLabel = `Current step: ${id}`;

  return (
    <>
      <NodeToolbar isVisible={selected} position={Position.Left} align="center" offset={12}>
        <div className="node-locator focused" role="status" aria-label={focusedLabel} title={focusedLabel}>
          <span>Focused</span>
          <code>{id}</code>
          <ArrowRight aria-hidden="true" />
        </div>
      </NodeToolbar>
      <NodeToolbar isVisible={isCurrent} position={Position.Right} align="center" offset={12}>
        <div className="node-locator current" role="status" aria-label={currentLabel} title={currentLabel}>
          <ArrowLeft aria-hidden="true" />
          <span>Current</span>
          <code>{id}</code>
        </div>
      </NodeToolbar>
      <div className={`step-node kind-${kind} status-${status}${selected ? ' selected' : ''}`}>
        <Handle type="target" position={Position.Top} />
        <div className="step-heading">
          <span className="kind-mark" aria-hidden="true">{kind.slice(0, 2).toUpperCase()}</span>
          <span>{kindLabels[kind] ?? kind}</span>
        </div>
        <div className="debug-node-markers">
          {hasBeforeBreakpoint ? <span aria-label="Before breakpoint" title="Pause before execution"><CircleDot className="debug-before-marker" aria-hidden="true" /></span> : null}
          {hasAfterBreakpoint ? <span aria-label="After breakpoint" title="Pause after execution"><CircleDot className="debug-after-marker" aria-hidden="true" /></span> : null}
          {runtime?.debugOverride ? <span aria-label="Debug override applied" title="Debug override applied"><Bug className="debug-override-marker" aria-hidden="true" /></span> : null}
        </div>
        <div className="step-id">{id}</div>
        {title && title !== id ? <div className="step-title">{title}</div> : null}
        {status !== 'pending' ? <div className="step-status">{status}{error ? `: ${error}` : ''}</div> : null}
        {!isTerminal ? <Handle type="source" position={Position.Bottom} /> : null}
      </div>
    </>
  );
}

function FrameNode({ data }: NodeProps<GraphNodeData>) {
  return (
    <div className="frame-content">
      <span>{String(data.label ?? data.kind ?? '')}</span>
      {data.empty ? <em>Empty route</em> : null}
    </div>
  );
}

function BranchMergeNode() {
  return (
    <div className="branch-merge-node" title="Branch merge">
      <Handle type="target" position={Position.Top} />
      <span aria-hidden="true" />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { gertStep: StepNode, branchMerge: BranchMergeNode, frameBox: FrameNode };

function InputsForm({
  declarations,
  values,
  disabled,
  onChange,
}: {
  declarations: InputDecl[];
  values: Record<string, string>;
  disabled: boolean;
  onChange(name: string, value: string): void;
}) {
  if (declarations.length === 0) return null;
  return (
    <section className="run-inputs" aria-label="Runbook inputs">
      {declarations.map((declaration) => {
        const value = values[declaration.name] ?? '';
        const label = `${declaration.name}${declaration.required ? ' *' : ''}`;
        return (
          <label key={declaration.name} title={declaration.description}>
            <span>{label}</span>
            {declaration.enum && !declaration.enumRedacted ? (
              <select
                value={value}
                disabled={disabled}
                required={declaration.required}
                onChange={(event) => onChange(declaration.name, event.target.value)}
              >
                <option value="">{declaration.required ? 'Select...' : 'Unset'}</option>
                {declaration.enum.map((member) => <option key={member} value={member}>{member}</option>)}
              </select>
            ) : (
              <input
                type={declaration.type === 'secret' ? 'password' : 'text'}
                autoComplete={declaration.type === 'secret' ? 'off' : undefined}
                value={value}
                disabled={disabled}
                required={declaration.required}
                placeholder={declaration.enumRedacted && declaration.enumMemberCount
                  ? `One of ${declaration.enumMemberCount} permitted values`
                  : declaration.description}
                onChange={(event) => onChange(declaration.name, event.target.value)}
              />
            )}
          </label>
        );
      })}
    </section>
  );
}

function optionText(option: InteractionOption): string {
  return option.label ?? option.display_label ?? option.display_value ?? option.value;
}

const MAX_DEBUG_PATCH_BYTES = 64 * 1024;
const MAX_DEBUG_PATCH_DEPTH = 8;
const MAX_DEBUG_PATCH_NODES = 512;
const MAX_DEBUG_PATCH_STRING_BYTES = 4096;
const MAX_DEBUG_PATCH_KEY_BYTES = 256;
const MAX_DEBUG_PATCH_ARRAY_ITEMS = 64;
const MAX_DEBUG_PATCH_OBJECT_PROPERTIES = 64;

function parseObjectPatch(value: string, label: string): Record<string, unknown> {
  if (new TextEncoder().encode(value).byteLength > MAX_DEBUG_PATCH_BYTES) {
    throw new Error(`${label} exceeds 64 KiB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}');
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  validateDebugPatch(parsed, 0, { nodes: 0 }, label);
  return parsed as Record<string, unknown>;
}

function validateDebugPatch(
  value: unknown,
  depth: number,
  state: { nodes: number },
  label: string,
): void {
  if (depth > MAX_DEBUG_PATCH_DEPTH) throw new Error(`${label} exceeds depth ${MAX_DEBUG_PATCH_DEPTH}.`);
  state.nodes += 1;
  if (state.nodes > MAX_DEBUG_PATCH_NODES) throw new Error(`${label} exceeds ${MAX_DEBUG_PATCH_NODES} values.`);
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > MAX_DEBUG_PATCH_STRING_BYTES) {
      throw new Error(`${label} contains a string larger than ${MAX_DEBUG_PATCH_STRING_BYTES} bytes.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DEBUG_PATCH_ARRAY_ITEMS) {
      throw new Error(`${label} contains an array larger than ${MAX_DEBUG_PATCH_ARRAY_ITEMS} items.`);
    }
    for (const item of value) validateDebugPatch(item, depth + 1, state, label);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_DEBUG_PATCH_OBJECT_PROPERTIES) {
      throw new Error(`${label} contains an object larger than ${MAX_DEBUG_PATCH_OBJECT_PROPERTIES} properties.`);
    }
    for (const [key, item] of entries) {
      if (new TextEncoder().encode(key).byteLength > MAX_DEBUG_PATCH_KEY_BYTES) {
        throw new Error(`${label} contains a key larger than ${MAX_DEBUG_PATCH_KEY_BYTES} bytes.`);
      }
      validateDebugPatch(item, depth + 1, state, label);
    }
  }
}

function DebugInteractionPane({
  interaction,
  onSubmit,
}: {
  interaction: PendingInteraction;
  onSubmit(answer: Record<string, unknown>): void;
}) {
  const debug = interaction.debug;
  const [variablePatch, setVariablePatch] = useState('{}');
  const [outputPatch, setOutputPatch] = useState('{}');
  const [effectiveStatus, setEffectiveStatus] = useState(debug?.actual?.status ?? 'completed');
  const [effectiveError, setEffectiveError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const pauseHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { pauseHeadingRef.current?.focus(); }, [interaction.turnID]);
  if (!debug) return <div className="interaction-error">Debug pause payload is missing.</div>;

  const submit = (action: 'continue' | 'stop' | 'step_into' | 'step_over' | 'step_out', apply: boolean) => {
    try {
      let set: Record<string, unknown> | undefined;
      if (apply) {
        const vars = parseObjectPatch(variablePatch, 'Variable patch');
        const outputs = parseObjectPatch(outputPatch, 'Output patch');
        const protectedVariables = new Set(debug.protectedVariables ?? []);
        const protectedEdit = Object.keys(vars).find((name) => protectedVariables.has(name));
        if (protectedEdit) throw new Error(`${protectedEdit} is protected and cannot be overridden.`);
        if (debug.phase === 'before' && Object.keys(outputs).length > 0) {
          throw new Error('Output patches are available only after execution.');
        }
        set = {
          ...(Object.keys(vars).length > 0 ? { vars } : {}),
          ...(debug.phase === 'after' && Object.keys(outputs).length > 0 ? { output_patch: outputs } : {}),
          ...(debug.phase === 'after' && effectiveStatus !== debug.actual?.status ? { status: effectiveStatus } : {}),
          ...(debug.phase === 'after' && effectiveStatus === 'failed' && effectiveError ? { error: effectiveError } : {}),
        };
        if (Object.keys(set).length === 0) set = undefined;
      }
      setValidationError(undefined);
      setSubmitting(true);
      onSubmit({ kind: 'debug_break', action, ...(set ? { set } : {}) });
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };
  const callPath = [...(debug.callPath ?? []).map((frame) => frame.step_id), interaction.stepID].join(' / ');

  return (
    <section className="interaction-pane debug-break" aria-label="Debug pause">
      <span className="interaction-kind">Debug pause · {debug.phase}</span>
      <h2 ref={pauseHeadingRef} tabIndex={-1}>{interaction.stepID}</h2>
      <div className="debug-breadcrumb">{callPath}</div>
      <dl className="debug-metadata">
        <dt>Invocation</dt><dd>{debug.invocation}</dd>
        <dt>Attempt</dt><dd>{debug.attempt}</dd>
      </dl>
      {debug.watches && debug.watches.length > 0 ? (
        <section className="debug-values" aria-label="Watch expressions">
          <h3>Watches</h3>
          {debug.watches.map((watch) => (
            <div key={watch.expression} className="debug-watch">
              <code>{watch.expression}</code>
              <span>{watch.error ?? JSON.stringify(watch.value)}</span>
            </div>
          ))}
        </section>
      ) : null}
      <details className="debug-values">
        <summary>Runtime variables</summary>
        <pre>{JSON.stringify(debug.variables ?? {}, null, 2)}</pre>
      </details>
      {debug.actual ? (
        <details className="debug-values" open>
          <summary>Actual result · {debug.actual.status}</summary>
          <pre>{JSON.stringify(debug.actual.output ?? {}, null, 2)}</pre>
          {debug.actual.error ? <p>{debug.actual.error}</p> : null}
        </details>
      ) : null}
      <label className="debug-field">
        <span>Variable patch</span>
        <textarea
          value={variablePatch}
          disabled={submitting}
          spellCheck={false}
          onChange={(event) => setVariablePatch(event.target.value)}
        />
      </label>
      {debug.phase === 'after' ? (
        <>
          <label className="debug-field">
            <span>Output patch</span>
            <textarea
              value={outputPatch}
              disabled={submitting || debug.outputProtected}
              spellCheck={false}
              onChange={(event) => setOutputPatch(event.target.value)}
            />
          </label>
          {debug.outputProtected ? <p className="debug-protected">Output is protected and cannot be overridden.</p> : null}
          <label className="debug-field compact">
            <span>Effective status</span>
            <select
              value={effectiveStatus}
              disabled={submitting}
              onChange={(event) => {
                setEffectiveStatus(event.target.value);
                if (event.target.value !== 'failed') setEffectiveError('');
              }}
            >
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
            </select>
          </label>
          {effectiveStatus === 'failed' ? (
            <label className="debug-field compact">
              <span>Effective error</span>
              <input value={effectiveError} disabled={submitting} onChange={(event) => setEffectiveError(event.target.value)} />
            </label>
          ) : null}
        </>
      ) : null}
      {debug.protectedVariables && debug.protectedVariables.length > 0 ? (
        <p className="debug-protected">Protected: {debug.protectedVariables.join(', ')}</p>
      ) : null}
      {validationError ? <div className="interaction-error" role="alert">{validationError}</div> : null}
      <div className="debug-actions">
        <button type="button" disabled={submitting} onClick={() => submit('continue', false)}>Continue unchanged</button>
        <button type="button" className="primary" disabled={submitting} onClick={() => submit('continue', true)}>Apply and continue</button>
        <button type="button" disabled={submitting || !debug.canStepInto} onClick={() => submit('step_into', true)}>Step into</button>
        <button type="button" disabled={submitting} onClick={() => submit('step_over', true)}>Step over</button>
        <button type="button" disabled={submitting} onClick={() => submit('step_out', true)}>Step out</button>
        <button type="button" className="danger" disabled={submitting} onClick={() => submit('stop', false)}>Stop</button>
      </div>
    </section>
  );
}

function ApprovalInteractionPane({
  interaction,
  onSubmit,
}: {
  interaction: PendingInteraction;
  onSubmit(answer: Record<string, unknown>): void;
}) {
  const [approver, setApprover] = useState('');
  const [submitting, setSubmitting] = useState(false);
  return (
    <section className="interaction-pane approval-pane" aria-label="Governance approval">
      <span className="interaction-kind">Approval</span>
      <h2>{interaction.title ?? interaction.stepID}</h2>
      {interaction.prompt ? <p>{interaction.prompt}</p> : null}
      <label className="debug-field compact">
        <span>Approver identity</span>
        <input
          value={approver}
          disabled={submitting}
          required
          autoFocus
          placeholder="name or email"
          onChange={(event) => setApprover(event.target.value)}
        />
      </label>
      <div className="debug-actions">
        <button
          type="button"
          className="primary"
          disabled={submitting || approver.trim() === ''}
          onClick={() => {
            setSubmitting(true);
            onSubmit({ kind: 'approval', approved: true, approver: approver.trim() });
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="danger"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            onSubmit({ kind: 'approval', approved: false });
          }}
        >
          Deny
        </button>
      </div>
    </section>
  );
}

function InteractionPane({
  interaction,
  onSubmit,
  onConfirmHostAction,
  xtsOpened,
}: {
  interaction: PendingInteraction;
  onSubmit(answer: Record<string, unknown>): void;
  onConfirmHostAction(interaction: PendingInteraction): void;
  xtsOpened: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of interaction.fields ?? []) {
      if (field.default !== undefined) initial[field.name] = field.default;
    }
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [collectorReview, setCollectorReview] = useState<Record<string, unknown>>();
  const choiceMax = interaction.kind === 'choice' && interaction.multiple &&
    typeof interaction.max === 'number' && Number.isInteger(interaction.max) && interaction.max >= 0
    ? interaction.max
    : undefined;
  const choiceLimitID = `choice-limit-${interaction.turnID}`;
  const submit = (answer: Record<string, unknown>) => {
    setSubmitting(true);
    onSubmit(answer);
  };

  if (interaction.kind === 'host_action') {
    const isXts = interaction.host_action?.capability === 'xts.open-view';
    if (!isXts) return <div className="interaction-wait" role="status">Opening host view...</div>;
    return (
      <section className="interaction-pane host-action-pane" aria-label={isXts ? 'Open XTS view' : 'Open host view'}>
        <div className="actual-run-stepper" aria-label="Actual run progress"><strong>1 Open XTS</strong><span>2 Answer questions</span><span>3 Review</span></div>
        <span className="interaction-kind">{isXts ? 'Actual run · XTS' : 'Host action'}</span>
        <h2>{interaction.title ?? interaction.stepID}</h2>
        {interaction.prompt ? <p>{interaction.prompt}</p> : null}
        {isXts ? <p>VS Code will switch to XTS. Review the view, then return here to record your findings.</p> : null}
        <button
          type="button"
          className="primary"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            onConfirmHostAction(interaction);
          }}
        >
          {submitting ? 'Opening XTS...' : <span>Open XTS</span>}
        </button>
      </section>
    );
  }
  if (interaction.kind === 'approval') {
    return <ApprovalInteractionPane interaction={interaction} onSubmit={onSubmit} />;
  }
  if (interaction.kind === 'debug_break') {
    return <DebugInteractionPane interaction={interaction} onSubmit={onSubmit} />;
  }

  return (
    <section className="interaction-pane" aria-label="Runbook interaction">
      <span className="interaction-kind">{interaction.kind}</span>
      <h2>{interaction.title ?? interaction.stepID}</h2>
      {interaction.prompt ? <p>{interaction.prompt}</p> : null}

      {interaction.kind === 'choice' ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (choiceMax !== undefined && selected.length > choiceMax) {
            setValidationError(`Select no more than ${choiceMax} options.`);
            return;
          }
          submit({ kind: 'choice', selected });
        }}>
          <fieldset disabled={submitting}>
            {(interaction.options ?? []).map((option) => {
              const checked = selected.includes(option.value);
              const disabledByMax = choiceMax !== undefined && !checked && selected.length >= choiceMax;
              const disabledTitle = disabledByMax
                ? `Maximum of ${choiceMax} options selected. Deselect one to choose another.`
                : undefined;
              return (
                <label className="interaction-option" key={option.value} aria-disabled={disabledByMax} title={disabledTitle}>
                  <input
                    type={interaction.multiple ? 'checkbox' : 'radio'}
                    name="choice"
                    checked={checked}
                    disabled={disabledByMax}
                    aria-describedby={choiceMax === undefined ? undefined : choiceLimitID}
                    onChange={() => {
                      setValidationError(undefined);
                      setSelected((current) => {
                        if (!interaction.multiple) return [option.value];
                        if (current.includes(option.value)) return current.filter((value) => value !== option.value);
                        if (choiceMax !== undefined && current.length >= choiceMax) return current;
                        return [...current, option.value];
                      });
                    }}
                  />
                  <span><strong>{optionText(option)}</strong>{option.hint ? <small>{option.hint}</small> : null}</span>
                </label>
              );
            })}
          </fieldset>
          {choiceMax !== undefined ? (
            <p id={choiceLimitID} className="choice-limit" role="status">
              {selected.length >= choiceMax
                ? `${selected.length} of ${choiceMax} selected. Deselect an option to choose another.`
                : `${selected.length} of ${choiceMax} selected. Select up to ${choiceMax} options.`}
            </p>
          ) : null}
          {validationError ? <p className="interaction-error" role="alert">{validationError}</p> : null}
          <button
            type="submit"
            disabled={submitting || selected.length < (interaction.min ?? 1) || (choiceMax !== undefined && selected.length > choiceMax)}
          >
            Continue
          </button>
        </form>
      ) : null}

      {interaction.kind === 'decision' ? (
        <div className="decision-options">
          {(interaction.routes ?? []).map((route) => (
            <button
              key={route.label}
              type="button"
              disabled={submitting}
              onClick={() => submit({ kind: 'decision', label: route.label })}
            >
              <strong>{optionText(route)}</strong>
              {route.hint ? <small>{route.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}

      {interaction.kind === 'collector' && collectorReview ? (
        <section className="collector-review review-before-submit" aria-label="Review collected answers">
          {xtsOpened ? <div className="actual-run-stepper" aria-label="Actual run progress"><span>1 Open XTS</span><span>2 Answer questions</span><strong>3 Review</strong></div> : null}
          <span className="interaction-kind">Collected in this actual run</span>
          <h3>Review answers</h3>
          <dl>
            {(interaction.fields ?? []).map((field) => (
              <React.Fragment key={field.name}>
                <dt>{field.label ?? field.display_name ?? field.name}</dt>
                <dd>{collectorReviewValue(field, collectorReview[field.name])}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p>Saving submits these answers and resumes the run. The next route may depend on them.</p>
          <div className="debug-actions">
            <button type="button" className="primary" disabled={submitting} onClick={() => submit({ kind: 'collector', values: collectorReview })}>Save answers and continue</button>
            <button type="button" disabled={submitting} onClick={() => setCollectorReview(undefined)}>Edit answers</button>
          </div>
        </section>
      ) : interaction.kind === 'collector' ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          try {
            setValidationError(undefined);
            setCollectorReview(collectorValues(interaction.fields ?? [], values));
          } catch (error) {
            setValidationError(error instanceof Error ? error.message : String(error));
          }
        }}>
          {xtsOpened ? <div className="actual-run-stepper" aria-label="Actual run progress"><span>1 Open XTS</span><strong>2 Answer questions</strong><span>3 Review</span></div> : null}
          {(interaction.fields ?? []).map((field) => (
            <label className="collector-field" data-field-name={field.name} key={field.name}>
              <span>{field.label ?? field.display_name ?? field.name}{field.required ? ' *' : ''}</span>
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  disabled={submitting}
                  checked={Boolean(values[field.name])}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.checked }))}
                />
              ) : field.options && field.options.length > 0 ? (
                <select
                  required={field.required}
                  multiple={field.multiple}
                  disabled={submitting}
                  value={field.multiple
                    ? (Array.isArray(values[field.name]) ? values[field.name] as string[] : [])
                    : String(values[field.name] ?? '')}
                  onChange={(event) => setValues((current) => ({
                    ...current,
                    [field.name]: field.multiple
                      ? Array.from(event.target.selectedOptions).map((option) => option.value)
                      : event.target.value,
                  }))}
                >
                  {!field.multiple ? <option value="">Select...</option> : null}
                  {field.options.map((option) => <option key={option.value} value={option.value}>{optionText(option)}</option>)}
                </select>
              ) : field.type === 'textarea' ? (
                <textarea
                  required={field.required}
                  disabled={submitting}
                  value={String(values[field.name] ?? '')}
                  placeholder={field.hint}
                  rows={3}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                />
              ) : (
                <input
                  type={collectorInputType(field.type)}
                  step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
                  required={field.required}
                  disabled={submitting}
                  value={String(values[field.name] ?? '')}
                  placeholder={field.hint}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                />
              )}
            </label>
          ))}
          {validationError ? <div className="interaction-error" role="alert">{validationError}</div> : null}
          <button type="submit" disabled={submitting}>Review answers</button>
        </form>
      ) : null}
    </section>
  );
}

interface Dimensions {
  width: number;
  height: number;
}

interface PlacedStep {
  source: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GroupBounds {
  group: GraphGroup;
  parentGroupID: string;
  depth: number;
  empty: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodeDimensions(kind: string, style: NodeStyle): Dimensions {
  if (kind === 'merge') return { width: 14, height: 14 };
  if (style === 'minimalist') {
    if (kind === 'end') return { width: 164, height: 48 };
    if (kind === 'branch' || kind === 'decision' || kind === 'choice') return { width: 190, height: 66 };
    return { width: 184, height: 64 };
  }
  if (style === 'header-badges') {
    if (kind === 'end') return { width: 180, height: 58 };
    return { width: 200, height: 78 };
  }
  if (kind === 'end') return { width: 175, height: 52 };
  if (kind === 'branch' || kind === 'decision' || kind === 'choice') return { width: 210, height: 82 };
  return { width: 196, height: 74 };
}

function groupLabel(group: GraphGroup): string {
  if (group.kind === 'branch-arm' && group.fallback) {
    return group.label ? `Otherwise - ${group.label}` : 'Otherwise';
  }
  if (group.label) return group.label;
  const defaults: Record<string, string> = {
    'branch-arm': 'Branch',
    'compensate-body': 'Compensate',
    'include-frame': 'Include',
    'iterate-body': 'Iterate',
    'parallel-branch': 'Parallel',
  };
  return defaults[group.kind] ?? group.kind;
}

function computeGroupBounds(document: GraphDocument, placed: Map<string, PlacedStep>): Map<string, GroupBounds> {
  const nodeByID = new Map(document.nodes.map((node) => [node.id, node]));
  const parentByGroup = new Map<string, string>();
  for (const group of document.groups) {
    const parentNode = group.parent_node_id ? nodeByID.get(group.parent_node_id) : undefined;
    parentByGroup.set(group.id, String(parentNode?.data.group_id ?? ''));
  }

  const membersByGroup = new Map<string, string[]>();
  for (const node of document.nodes) {
    let groupID = String(node.data.group_id ?? '');
    const visited = new Set<string>();
    while (groupID && !visited.has(groupID)) {
      visited.add(groupID);
      const members = membersByGroup.get(groupID) ?? [];
      members.push(node.id);
      membersByGroup.set(groupID, members);
      groupID = parentByGroup.get(groupID) ?? '';
    }
  }

  const depthOf = (groupID: string) => {
    let depth = 0;
    let parentID = parentByGroup.get(groupID) ?? '';
    const visited = new Set<string>();
    while (parentID && !visited.has(parentID)) {
      visited.add(parentID);
      depth += 1;
      parentID = parentByGroup.get(parentID) ?? '';
    }
    return depth;
  };
  const maxDepth = document.groups.reduce((maximum, group) => Math.max(maximum, depthOf(group.id)), 0);
  const maximumStepY = Math.max(0, ...[...placed.values()].map((step) => step.y + step.height));
  const siblingsByParentNode = new Map<string, GraphGroup[]>();
  for (const group of document.groups) {
    const siblings = siblingsByParentNode.get(group.parent_node_id) ?? [];
    siblings.push(group);
    siblingsByParentNode.set(group.parent_node_id, siblings);
  }
  for (const siblings of siblingsByParentNode.values()) {
    siblings.sort((left, right) => (left.index ?? 0) - (right.index ?? 0) || left.id.localeCompare(right.id));
  }
  const result = new Map<string, GroupBounds>();

  for (const group of document.groups) {
    const memberIDs = membersByGroup.get(group.id) ?? [];
    const memberSteps = memberIDs.map((id) => placed.get(id)).filter((step): step is PlacedStep => step !== undefined);
    const depth = depthOf(group.id);
    if (memberSteps.length === 0) {
      const width = 176;
      const height = 62;
      const anchor = group.parent_node_id ? placed.get(group.parent_node_id) : undefined;
      const siblings = siblingsByParentNode.get(group.parent_node_id) ?? [group];
      const siblingIndex = Math.max(0, siblings.findIndex((candidate) => candidate.id === group.id));
      const columnOffset = siblingIndex * 18;
      result.set(group.id, {
        group,
        parentGroupID: parentByGroup.get(group.id) ?? '',
        depth,
        empty: true,
        x: anchor
          ? group.fallback
            ? anchor.x - width - 32 - columnOffset
            : anchor.x + anchor.width + 32 + columnOffset
          : siblingIndex * (width + 24),
        y: anchor ? anchor.y + anchor.height + 34 + siblingIndex * 10 : maximumStepY + 36,
        width,
        height,
      });
      continue;
    }
    const inverseDepth = maxDepth - depth;
    const paddingX = 18 + inverseDepth * 10;
    const paddingTop = 28 + inverseDepth * 10;
    const paddingBottom = 20 + inverseDepth * 10;
    const minX = Math.min(...memberSteps.map((step) => step.x));
    const minY = Math.min(...memberSteps.map((step) => step.y));
    const maxX = Math.max(...memberSteps.map((step) => step.x + step.width));
    const maxY = Math.max(...memberSteps.map((step) => step.y + step.height));
    result.set(group.id, {
      group,
      parentGroupID: parentByGroup.get(group.id) ?? '',
      depth,
      empty: false,
      x: minX - paddingX,
      y: minY - paddingTop,
      width: maxX - minX + paddingX * 2,
      height: maxY - minY + paddingTop + paddingBottom,
    });
  }

  for (const child of [...result.values()].sort((left, right) => right.depth - left.depth)) {
    if (!child.parentGroupID) continue;
    const parent = result.get(child.parentGroupID);
    if (!parent) continue;
    const padding = 14;
    const left = Math.min(parent.x, child.x - padding);
    const top = Math.min(parent.y, child.y - padding);
    const right = Math.max(parent.x + parent.width, child.x + child.width + padding);
    const bottom = Math.max(parent.y + parent.height, child.y + child.height + padding);
    parent.x = left;
    parent.y = top;
    parent.width = right - left;
    parent.height = bottom - top;
  }
  return result;
}

function layoutDocument(
  document: GraphDocument,
  style: NodeStyle,
): { nodes: Node<GraphNodeData>[]; edges: Edge<{ graphEdge: GraphEdge }>[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 42, ranksep: 72 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of document.nodes) {
    const dimensions = nodeDimensions(String(node.data.kind ?? ''), style);
    graph.setNode(node.id, dimensions);
  }
  for (const edge of document.edges) {
    graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);

  const placed = new Map<string, PlacedStep>();
  for (const node of document.nodes) {
    const position = graph.node(node.id) as { x?: number; y?: number; width?: number; height?: number } | undefined;
    const dimensions = nodeDimensions(String(node.data.kind ?? ''), style);
    placed.set(node.id, {
      source: node,
      x: (position?.x ?? 0) - dimensions.width / 2,
      y: (position?.y ?? 0) - dimensions.height / 2,
      width: position?.width ?? dimensions.width,
      height: position?.height ?? dimensions.height,
    });
  }
  const groupBounds = computeGroupBounds(document, placed);
  const frameNodes: Node<GraphNodeData>[] = [...groupBounds.values()]
    .sort((left, right) => left.depth - right.depth)
    .map((bounds) => {
      const parentBounds = bounds.parentGroupID ? groupBounds.get(bounds.parentGroupID) : undefined;
      return {
        id: bounds.group.id,
        type: 'frameBox',
        position: {
          x: bounds.x - (parentBounds?.x ?? 0),
          y: bounds.y - (parentBounds?.y ?? 0),
        },
        parentNode: parentBounds?.group.id,
        extent: parentBounds ? 'parent' : undefined,
        className: `${bounds.group.kind}${bounds.empty ? ' empty-group' : ''}`,
        style: { width: bounds.width, height: bounds.height, zIndex: bounds.depth },
        data: {
          id: bounds.group.id,
          kind: bounds.group.kind,
          label: groupLabel(bounds.group),
          frame_id: bounds.group.frame_id,
          parent_group_id: bounds.parentGroupID,
          empty: bounds.empty,
        },
        selectable: false,
        draggable: false,
        focusable: false,
      };
    });
  const stepNodes: Node<GraphNodeData>[] = document.nodes.map((node) => {
    const position = placed.get(node.id)!;
    const groupID = String(node.data.group_id ?? '');
    const parentBounds = groupID ? groupBounds.get(groupID) : undefined;
    return {
      id: node.id,
      type: node.data.synthetic === true ? 'branchMerge' : 'gertStep',
      position: {
        x: position.x - (parentBounds?.x ?? 0),
        y: position.y - (parentBounds?.y ?? 0),
      },
      parentNode: parentBounds?.group.id,
      extent: parentBounds ? 'parent' : undefined,
      style: { width: position.width, height: position.height, zIndex: 1000 },
      data: {
        ...node.data,
        id: node.data.id ?? node.id,
        graph_parent_node: node.parentNode ?? '',
        graph_extent: node.extent ?? '',
        nodeStyle: style,
      },
      selectable: node.data.synthetic !== true,
      focusable: node.data.synthetic !== true,
    };
  });
  const edgeType = style === 'minimalist' ? 'straight' : style === 'header-badges' ? 'step' : 'smoothstep';
  return {
    nodes: [...frameNodes, ...stepNodes],
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: edgeType,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { graphEdge: edge },
    })),
  };
}

function runtimeEdgeClass(edge: GraphEdge, runtimeNodes: Readonly<Record<string, RuntimeNodeState>>): string | undefined {
  const state = edgeRuntimeState(edge, runtimeNodes);
  if (state?.status === 'running' || state?.status === 'delaying') return 'edge-running';
  if (state?.status === 'completed') return 'edge-completed';
  if (state?.status === 'failed' || state?.status === 'cancelled' || state?.status === 'indeterminate') return 'edge-failed';
  const owner = edge.runtimeNodeID ? runtimeNodes[edge.runtimeNodeID] : undefined;
  if (edge.routeKind && owner && ['completed', 'failed', 'skipped', 'indeterminate'].includes(owner.status)) {
    return 'edge-route-inactive';
  }
  return undefined;
}

function eventNodeID(event: RuntimeEvent): string | undefined {
  const payload = event.payload ?? {};
  const explicitNodeID = payload.node_id;
  if (typeof explicitNodeID === 'string' && explicitNodeID) return explicitNodeID;
  const stepID = payload.step_id;
  if (typeof stepID !== 'string' || !stepID) return undefined;
  const callPath = Array.isArray(payload.call_path)
    ? payload.call_path.filter((frame): frame is DirectDebugCallFrame => (
        typeof frame === 'object' && frame !== null && typeof (frame as { step_id?: unknown }).step_id === 'string'
      ))
    : [];
  const nodeID = debugNodeID(callPath, stepID);
  return typeof nodeID === 'string' && nodeID ? nodeID : undefined;
}

function debugNodeID(callPath: DirectDebugCallFrame[], stepID: string): string {
  if (callPath.length === 0) return stepID;
  const escapePart = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
  return [...callPath.map((frame) => escapePart(frame.step_id)), escapePart(stepID)].join('/');
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function appendRuntimeLog(current: RuntimeLogLine[] | undefined, payload: Record<string, unknown>): RuntimeLogLine[] | undefined {
  if (typeof payload.line !== 'string' || payload.line === '') return current;
  const next = [...(current ?? []), {
    stream: typeof payload.stream === 'string' ? payload.stream : 'stdout',
    line: payload.line,
  }];
  let total = 0;
  const kept: RuntimeLogLine[] = [];
  for (let index = next.length - 1; index >= 0 && kept.length < 50; index -= 1) {
    total += next[index].line.length;
    if (total > 16 * 1024) break;
    kept.unshift(next[index]);
  }
  return kept;
}

function applyRuntimeEvent(
  current: Readonly<Record<string, RuntimeNodeState>>,
  event: RuntimeEvent,
): Record<string, RuntimeNodeState> {
  const nodeID = eventNodeID(event);
  if (!nodeID) return { ...current };
  const previous = current[nodeID] ?? { status: 'pending' };
  if (event.kind === 'debug/override_applied') {
    return {
      ...current,
      [nodeID]: { ...previous, debugOverride: event.payload ?? {} },
    };
  }
  if (event.kind === 'step/output') {
    const payload = event.payload ?? {};
    return {
      ...current,
      [nodeID]: { ...previous, logs: appendRuntimeLog(previous.logs, payload) },
    };
  }
  let status = previous.status;
  if (event.kind === 'step/started' || event.kind === 'step/resumed') status = 'running';
  else if (event.kind === 'step/delaying') status = 'delaying';
  else if (event.kind === 'step/completed') status = 'completed';
  else if (event.kind === 'step/failed') status = 'failed';
  else if (event.kind === 'step/indeterminate') status = 'indeterminate';
  else if (event.kind === 'step/skipped') status = 'skipped';
  else return current as Record<string, RuntimeNodeState>;
  const payload = event.payload ?? {};
  return {
    ...current,
    [nodeID]: {
      ...previous,
      status,
      error: typeof payload.error === 'string' ? payload.error : previous.error,
      durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : previous.durationMs,
      attempt: typeof payload.attempt === 'number'
        ? payload.attempt
        : typeof payload.attempt_number === 'number'
          ? payload.attempt_number
          : previous.attempt,
      delay: typeof payload.delay === 'string' ? payload.delay : previous.delay,
      skipReason: typeof payload.reason === 'string' ? payload.reason : previous.skipReason,
      output: recordValue(payload.output) ?? previous.output,
      captures: recordValue(payload.captures) ?? previous.captures,
      evidence: payload.evidence ?? previous.evidence,
      ...(event.kind === 'step/started' && event.timestamp ? { startedAt: event.timestamp } : {}),
      ...((event.kind === 'step/completed' || event.kind === 'step/failed' || event.kind === 'step/indeterminate' || event.kind === 'step/skipped') && event.timestamp
        ? { finishedAt: event.timestamp }
        : {}),
    },
  };
}

function applyTerminalSteps(
  current: Readonly<Record<string, RuntimeNodeState>>,
  steps: StdioFrame['steps'],
): Record<string, RuntimeNodeState> {
  if (!steps) return { ...current };
  const next = { ...current };
  for (const step of steps) {
    const nodeID = step.node_id || step.step_id;
    if (!nodeID || !step.status) continue;
    next[nodeID] = {
      ...next[nodeID],
      status: step.status,
      error: step.error || next[nodeID]?.error,
      durationMs: step.duration_ms ?? next[nodeID]?.durationMs,
      output: step.output ?? next[nodeID]?.output,
    };
  }
  return next;
}

function graphInputDeclarations(document: GraphDocument): InputDecl[] {
  if (!Array.isArray(document.inputs)) return [];
  return document.inputs.filter((value): value is InputDecl => (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string'
  ));
}

function debugTargetForNode(node: GraphNode): Omit<DebugBreakpointView, 'phase'> {
  const callPath = Array.isArray(node.data.call_path)
    ? node.data.call_path
        .filter((stepID): stepID is string => typeof stepID === 'string' && stepID.length > 0)
        .map((stepID) => ({ step_id: stepID }))
    : [];
  const step = typeof node.data.step_id === 'string' && node.data.step_id
    ? node.data.step_id
    : node.id;
  return { nodeID: node.id, step, ...(callPath.length > 0 ? { callPath } : {}) };
}

function debugTargetSupported(document: GraphDocument, node: GraphNode): boolean {
  const unsupportedKinds = new Set(['parallel', 'compensate', 'wait_for_event']);
  if (unsupportedKinds.has(String(node.data.kind ?? ''))) return false;
  const nodeByID = new Map(document.nodes.map((candidate) => [candidate.id, candidate]));
  const groupByID = new Map(document.groups.map((group) => [group.id, group]));
  let groupID = typeof node.data.group_id === 'string' ? node.data.group_id : '';
  const visited = new Set<string>();
  while (groupID && !visited.has(groupID)) {
    visited.add(groupID);
    const group = groupByID.get(groupID);
    if (!group) break;
    const parent = nodeByID.get(group.parent_node_id);
    if (!parent) break;
    const kind = String(parent.data.kind ?? '');
    if (kind === 'parallel' || kind === 'compensate') return false;
    if (kind === 'iterate' && parent.data.concurrent === true) return false;
    groupID = typeof parent.data.group_id === 'string' ? parent.data.group_id : '';
  }
  return true;
}

function toggleBreakpoint(
  current: DebugBreakpointView[],
  document: GraphDocument,
  nodeID: string,
  phase: DirectDebugPhase,
): DebugBreakpointView[] {
  const node = document.nodes.find((candidate) => candidate.id === nodeID);
  if (!node || !debugTargetSupported(document, node)) return current;
  const target = debugTargetForNode(node);
  const existing = current.findIndex((breakpoint) => breakpoint.nodeID === nodeID && breakpoint.phase === phase);
  if (existing >= 0) return current.filter((_, index) => index !== existing);
  return [...current, { ...target, phase }];
}

function DebugSelectionControls({
  document,
  node,
  breakpoints,
  watches,
  disabled,
  onToggle,
  onWatchesChange,
}: {
  document: GraphDocument;
  node: GraphNode;
  breakpoints: DebugBreakpointView[];
  watches: string;
  disabled: boolean;
  onToggle(nodeID: string, phase: DirectDebugPhase): void;
  onWatchesChange(value: string): void;
}) {
  const supported = debugTargetSupported(document, node);
  const hasBefore = breakpoints.some((breakpoint) => breakpoint.nodeID === node.id && breakpoint.phase === 'before');
  const hasAfter = breakpoints.some((breakpoint) => breakpoint.nodeID === node.id && breakpoint.phase === 'after');
  return (
    <section className="debug-controls" aria-label="Debugger settings">
      <h3><Bug aria-hidden="true" />Debugger</h3>
      {supported ? (
        <div className="breakpoint-options">
          <label>
            <input type="checkbox" checked={hasBefore} disabled={disabled} onChange={() => onToggle(node.id, 'before')} />
            <span>Pause before execution</span>
          </label>
          <label>
            <input type="checkbox" checked={hasAfter} disabled={disabled} onChange={() => onToggle(node.id, 'after')} />
            <span>Pause after execution</span>
          </label>
        </div>
      ) : <p className="debug-protected">Breakpoints are unavailable for this concurrent or structural step.</p>}
      <label className="debug-field">
        <span>Watch expressions</span>
        <textarea
          value={watches}
          disabled={disabled}
          spellCheck={false}
          placeholder="One expression per line"
          onChange={(event) => onWatchesChange(event.target.value)}
        />
      </label>
    </section>
  );
}

function GraphView({
  document,
  testMode,
  style,
  runtimeNodes,
  breakpoints,
  watches,
  pending,
  runID,
  runStatus,
  runStarting,
  reloading,
  runError,
  runDiagnostics,
  inputValues,
  onInputChange,
  onRun,
  onDebugRun,
  onReset,
  onCancel,
  onSubmitInteraction,
  onConfirmHostAction,
  onToggleBreakpoint,
  onWatchesChange,
  onStyleChange,
  routeTestContext,
  routeTests,
  routeTestOutcome,
  routeTestRunning,
  routeTestError,
  onSaveRouteTest,
  onRunRouteTest,
  xtsOpened,
}: {
  document: GraphDocument;
  testMode: boolean;
  style: NodeStyle;
  runtimeNodes: Readonly<Record<string, RuntimeNodeState>>;
  breakpoints: DebugBreakpointView[];
  watches: string;
  pending?: PendingInteraction;
  runID?: string;
  runStatus: string;
  runStarting: boolean;
  reloading: boolean;
  runError?: string;
  runDiagnostics: string;
  inputValues: Record<string, string>;
  onInputChange(name: string, value: string): void;
  onRun(): void;
  onDebugRun(): void;
  onReset(): void;
  onCancel(): void;
  onSubmitInteraction(answer: Record<string, unknown>): void;
  onConfirmHostAction(interaction: PendingInteraction): void;
  onToggleBreakpoint(nodeID: string, phase: DirectDebugPhase): void;
  onWatchesChange(value: string): void;
  onStyleChange(style: NodeStyle): void;
  routeTestContext?: { runbook: string; planHash: string };
  routeTests: SavedRouteTestView[];
  routeTestOutcome?: RouteTestOutcome;
  routeTestRunning: boolean;
  routeTestError?: string;
  onSaveRouteTest(artifact: RouteTestArtifact): void;
  onRunRouteTest(artifact: RouteTestArtifact): void;
  xtsOpened: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [showPanel, setShowPanel] = useState(true);
  const [inspectorRatio, setInspectorRatio] = useState(restoredInspectorRatio);
  const [routeTargetID, setRouteTargetID] = useState<string>();
  const [routeScope, setRouteScope] = useState<RouteProjectionScope>('through');
  const [routeTestEditor, setRouteTestEditor] = useState<{ artifact?: RouteTestArtifact; needsReview?: boolean; key: string; contextKey: string }>();
  const flowRef = useRef<ReactFlowInstance<GraphNodeData>>();
  const canvasRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizePointerIDRef = useRef<number>();
  const restoreViewportRef = useRef<Viewport>();
  const declarations = useMemo(() => graphInputDeclarations(document), [document]);
  const structuralDocument = useMemo(() => withBranchMerges(document), [document]);
  const routeIndex = useMemo(() => buildRouteProjectionIndex(structuralDocument), [structuralDocument]);
  const routeProjection = useMemo(
    () => routeTargetID ? computeRouteProjection(structuralDocument, routeTargetID, routeScope, routeIndex) : undefined,
    [routeIndex, routeScope, routeTargetID, structuralDocument],
  );
  const prerequisiteProjection = useMemo(
    () => routeTargetID ? computeRouteProjection(structuralDocument, routeTargetID, 'to', routeIndex) : undefined,
    [routeIndex, routeTargetID, structuralDocument],
  );
  const displayDocument = useMemo(
    () => routeProjection ? projectRouteDocument(structuralDocument, routeProjection) : structuralDocument,
    [routeProjection, structuralDocument],
  );
  const layout = useMemo(() => layoutDocument(displayDocument, style), [displayDocument, style]);
  const runtimeEdges = useMemo(() => layout.edges.map((edge) => ({
    ...edge,
    className: edge.data?.graphEdge ? runtimeEdgeClass(edge.data.graphEdge, runtimeNodes) : undefined,
  })), [layout.edges, runtimeNodes]);
  const focusedNodeID = routeTargetID ?? selectedId;
  const displayNodes = useMemo(() => layout.nodes.map((node) => ({
    ...node,
    selected: node.id === focusedNodeID,
  })), [focusedNodeID, layout.nodes]);
  const activeNodeIDs = useMemo(() => activeGraphNodeIDs(structuralDocument, runtimeNodes), [structuralDocument, runtimeNodes]);
  const breakpointKeys = useMemo(
    () => new Set(breakpoints.map((breakpoint) => breakpointKey(breakpoint.nodeID, breakpoint.phase))),
    [breakpoints],
  );
  const selected = document.nodes.find((node) => node.id === selectedId);
  const routeTarget = document.nodes.find((node) => node.id === routeTargetID);
  const routeTargetName = String(routeTarget?.data.title || routeTarget?.data.id || routeTarget?.id || 'selected step');
  const routeTestCandidates = useMemo(() => {
    const kinds = new Set(['cli', 'tool', 'host_action', 'collector', 'choice', 'decision', 'approve']);
    return document.nodes.filter((node) => (
      node.id !== routeTargetID && prerequisiteProjection?.nodeIDs.has(node.id) && kinds.has(String(node.data.kind ?? ''))
    ));
  }, [document, prerequisiteProjection, routeTargetID]);
  const routeTestBlockers = useMemo(() => document.nodes.flatMap((node) => {
    if (node.id === routeTargetID || !prerequisiteProjection?.nodeIDs.has(node.id)) return [];
    const kind = String(node.data.kind ?? '');
    const dynamicInclude = kind === 'include' && node.data.dynamic === true;
    if (!dynamicInclude && !['parallel', 'wait_for_event', 'extension', 'prompt'].includes(kind)) return [];
    return [`${String(node.data.title || node.data.id || node.id)} (${dynamicInclude ? 'dynamic include' : kind})`];
  }), [document, prerequisiteProjection, routeTargetID]);
  const savedRouteTests = routeTarget ? routeTests.filter(({ artifact }) => routeTestMatchesTarget(artifact, routeTarget)) : [];
  const runActive = runStarting || (!!runID && !isTerminalRunStatus(runStatus));
  const routeTestContextKey = `${document.hash}:${routeTestContext?.planHash ?? ''}`;
  const currentRouteTestEditor = routeTestEditor?.contextKey === routeTestContextKey ? routeTestEditor : undefined;
  const routeTestReviewOpen = currentRouteTestEditor !== undefined;

  const showRoutesThrough = (nodeID: string) => {
    if (!routeTargetID) restoreViewportRef.current = flowRef.current?.getViewport();
    setRouteScope('through');
    setRouteTargetID(nodeID);
    setSelectedId(nodeID);
  };
  const showFullGraph = () => {
    setSelectedId(routeTargetID);
    setRouteTargetID(undefined);
    setRouteTestEditor(undefined);
  };

  const resizeInspectorFromClientX = (clientX: number) => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    setInspectorRatio(clampInspectorRatio((bounds.right - clientX) / bounds.width));
  };

  const resizeInspectorByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.025;
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = inspectorRatio + step;
    else if (event.key === 'ArrowRight') next = inspectorRatio - step;
    else if (event.key === 'Home') next = MIN_INSPECTOR_RATIO;
    else if (event.key === 'End') next = MAX_INSPECTOR_RATIO;
    if (next === undefined) return;
    event.preventDefault();
    setInspectorRatio(clampInspectorRatio(next));
  };

  useEffect(() => persistInspectorRatio(inspectorRatio), [inspectorRatio]);

  useEffect(() => {
    if (pending?.nodeID || pending?.stepID) setSelectedId(pending.nodeID ?? pending.stepID);
  }, [pending?.turnID, pending?.nodeID, pending?.stepID]);

  useEffect(() => {
    if (!testMode) return;
    const receiveTestAction = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message?.type === 'test.action' && message.action === 'select-node' && message.name) {
        const selectedNode = document.nodes.find((node) => node.id === message.name || node.data.id === message.name);
        setSelectedId(selectedNode?.id);
      }
    };
    window.addEventListener('message', receiveTestAction);
    return () => window.removeEventListener('message', receiveTestAction);
  }, [document.nodes, testMode]);

  useEffect(() => {
    if (!testMode || !selected) return;
    const frame = requestAnimationFrame(() => {
      vscode.postMessage({
        type: 'inspector.state',
        nodeID: selected.id,
        tabs: Array.from(window.document.querySelectorAll('.inspector-tabs [role="tab"]')).map((element) => element.textContent?.trim()),
        sections: Array.from(window.document.querySelectorAll('.inspector .section-heading h3')).map((element) => element.textContent?.trim()),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.id, testMode]);

  useEffect(() => {
    if (!flowRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (routeTargetID) {
        void flowRef.current?.fitView({ padding: 0.2 });
        return;
      }
      const viewport = restoreViewportRef.current;
      if (viewport) {
        restoreViewportRef.current = undefined;
        void flowRef.current?.setViewport(viewport);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [layout.edges.length, layout.nodes.length, routeScope, routeTargetID]);

  useEffect(() => {
    if (!routeTargetID) return;
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void flowRef.current?.fitView({ padding: 0.2 }); });
    };
    const observer = new ResizeObserver(refit);
    if (canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener('resize', refit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', refit);
      cancelAnimationFrame(frame);
    };
  }, [routeTargetID]);

  useEffect(() => {
    if (!testMode) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const firstStep = window.document.querySelector<HTMLElement>('.step-node');
        const firstEdge = window.document.querySelector<SVGElement>('.react-flow__edge');
        vscode.postMessage({
          type: 'rendered',
          nodeCount: window.document.querySelectorAll('.react-flow__node-gertStep').length,
          frameCount: window.document.querySelectorAll('.react-flow__node-frameBox').length,
          edgeCount: window.document.querySelectorAll('.react-flow__edge').length,
          style,
          nodeBorderRadius: firstStep ? getComputedStyle(firstStep).borderRadius : '',
          edgeClassName: firstEdge?.getAttribute('class') ?? '',
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [document, layout.nodes.length, layout.edges.length, style, testMode]);

  return (
    <main className={`app style-${style}${showPanel ? '' : ' panel-hidden'} has-panel-content`}>
      <header className="toolbar">
        <div className="identity">
          <strong>{document.runbook.name ?? document.runbook.id ?? 'Runbook'}</strong>
          <span>{document.nodes.length} steps</span>
        </div>
        <div className="run-actions">
          <span className={`run-status status-${runStatus}`} role="status" aria-live="polite">{runStarting ? 'starting' : runStatus}</span>
          {!runActive ? (
            <button
              className="primary"
              type="button"
              disabled={routeTestReviewOpen || reloading}
              title={reloading ? 'Wait for the runbook graph to finish reloading' : undefined}
              onClick={onRun}
            >
              <Play aria-hidden="true" />Run</button>
          ) : null}
          {!runActive ? (
            <button
              className="debug-run"
              type="button"
              disabled={routeTestReviewOpen || reloading || breakpoints.length === 0}
              title={reloading
                ? 'Wait for the runbook graph to finish reloading'
                : routeTestReviewOpen
                ? 'Close the route-test review before starting a debug run'
                : breakpoints.length === 0
                  ? 'Add a breakpoint to start a debug run'
                  : 'Start with debugger enabled'}
              onClick={onDebugRun}
            >
              <Bug aria-hidden="true" /><span>Debug Run</span>
            </button>
          ) : null}
          {!runActive && isTerminalRunStatus(runStatus) ? (
            <button className="reset-run" type="button" onClick={() => {
              setRouteTestEditor(undefined);
              onReset();
            }}>
              <RotateCcw aria-hidden="true" />Reset
            </button>
          ) : null}
          {runActive && runID ? <button className="danger" type="button" onClick={onCancel}><Square aria-hidden="true" />Cancel</button> : null}
          <select
            aria-label="Graph style"
            value={style}
            onChange={(event) => onStyleChange(event.target.value as NodeStyle)}
          >
            <option value="smooth-curves">Smooth</option>
            <option value="minimalist">Minimal</option>
            <option value="header-badges">Headers</option>
          </select>
          <button type="button" className={showPanel ? 'toggle active' : 'toggle'} onClick={() => setShowPanel((value) => !value)}>
            <PanelRight aria-hidden="true" />Panel
          </button>
        </div>
      </header>
      <InputsForm
        declarations={declarations}
        values={inputValues}
        disabled={runActive}
        onChange={onInputChange}
      />
      {runError ? <div className="run-error" role="alert">{runError}</div> : null}
      {routeTargetID && routeProjection ? (
        <section className="route-view-strip" aria-label={`Routes through ${routeTargetName}`}>
          <div className="route-view-copy">
            <strong>Showing routes through: {routeTargetName}</strong>
            <span>
              {routeProjection.predecessorCount} steps lead to it, {routeProjection.successorCount} follow it, {routeProjection.boundaryEdges.length} hidden dependencies
            </span>
          </div>
          <div className="route-view-actions">
            <div className="route-scope" role="radiogroup" aria-label="Visible routes">
              <button type="button" role="radio" aria-checked={routeScope === 'through'} onClick={() => setRouteScope('through')}>Through this step</button>
              <button type="button" role="radio" aria-checked={routeScope === 'to'} onClick={() => setRouteScope('to')}>To this step</button>
              <button type="button" role="radio" aria-checked={routeScope === 'from'} onClick={() => setRouteScope('from')}>From this step</button>
            </div>
            <button type="button" disabled={runActive} onClick={showFullGraph}>Show full graph</button>
          </div>
        </section>
      ) : null}
      {currentRouteTestEditor ? (
        <div className="route-test-global-safety" role="status">
          {routeTestOutcome?.passed
            ? 'Route test completed - external actions were blocked'
            : routeTestRunning
              ? 'Testing route - XTS and external actions are blocked'
              : 'Reviewing route test - protected execution starts only when you run this route test'}
        </div>
      ) : null}
      <div
        ref={workspaceRef}
        className="workspace"
        style={{ '--inspector-width': `${inspectorRatio * 100}%` } as React.CSSProperties}
      >
        <section ref={canvasRef} className="canvas" aria-label="Runbook structure">
          <RuntimeNodesContext.Provider value={runtimeNodes}>
            <DebugBreakpointsContext.Provider value={breakpointKeys}>
              <ReactFlowProvider>
                <ReactFlow
                  nodes={displayNodes}
                  edges={runtimeEdges}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  minZoom={0.2}
                  maxZoom={1.8}
                  nodesDraggable={false}
                  onInit={(instance) => { flowRef.current = instance; }}
                  onNodeClick={(_, node) => { if (node.data.synthetic !== true) setSelectedId(node.id); }}
                  onPaneClick={() => setSelectedId(undefined)}
                >
                  <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap
                    pannable
                    zoomable
                    ariaLabel="Runbook overview"
                    nodeColor={(node) => node.selected
                      ? 'var(--vscode-charts-yellow)'
                      : ['running', 'delaying'].includes(runtimeNodes[node.id]?.status ?? '')
                        ? 'var(--vscode-charts-green)'
                        : 'var(--vscode-foreground)'}
                    nodeStrokeColor={(node) => node.selected ? 'var(--vscode-editor-background)' : 'transparent'}
                    nodeStrokeWidth={3}
                  />
                </ReactFlow>
              </ReactFlowProvider>
            </DebugBreakpointsContext.Provider>
          </RuntimeNodesContext.Provider>
        </section>
        {showPanel ? (
          <div
            className="inspector-resizer"
            role="separator"
            aria-label="Resize step details"
            aria-orientation="vertical"
            aria-controls="step-details-panel"
            aria-valuemin={MIN_INSPECTOR_RATIO * 100}
            aria-valuemax={MAX_INSPECTOR_RATIO * 100}
            aria-valuenow={Math.round(inspectorRatio * 100)}
            tabIndex={0}
            title="Drag to resize the details panel"
            onDoubleClick={() => setInspectorRatio(DEFAULT_INSPECTOR_RATIO)}
            onKeyDown={resizeInspectorByKey}
            onPointerDown={(event) => {
              event.preventDefault();
              resizePointerIDRef.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              resizeInspectorFromClientX(event.clientX);
            }}
            onPointerMove={(event) => {
              if (resizePointerIDRef.current === event.pointerId) resizeInspectorFromClientX(event.clientX);
            }}
            onPointerUp={(event) => {
              if (resizePointerIDRef.current === event.pointerId) resizePointerIDRef.current = undefined;
            }}
            onPointerCancel={(event) => {
              if (resizePointerIDRef.current === event.pointerId) resizePointerIDRef.current = undefined;
            }}
          />
        ) : null}
        <aside id="step-details-panel" className="inspector" aria-label="Step details">
          {pending ? (
            <InteractionPane
              key={`${pending.turnID}:${runError ?? ''}`}
              interaction={pending}
              onSubmit={onSubmitInteraction}
              onConfirmHostAction={onConfirmHostAction}
              xtsOpened={xtsOpened}
            />
          ) : currentRouteTestEditor && routeTarget && routeTestContext ? (
            <RouteTestPane
              key={currentRouteTestEditor.key}
              document={document}
              target={routeTarget}
              candidates={routeTestCandidates}
              blockers={routeTestBlockers}
              context={routeTestContext}
              initial={currentRouteTestEditor.artifact}
              needsReview={currentRouteTestEditor.needsReview}
              inputValues={inputValues}
              runStatus={runStatus}
              runStarting={runStarting}
              outcome={routeTestOutcome}
              error={routeTestError}
              onSave={onSaveRouteTest}
              onRun={onRunRouteTest}
              onStop={onCancel}
              onClose={() => setRouteTestEditor(undefined)}
            />
          ) : selected ? (
            <div className="selected-step-panel">
              {!routeTargetID || routeTargetID !== selected.id ? (
                <div className="route-context-action">
                  <button type="button" disabled={runActive} onClick={() => showRoutesThrough(selected.id)}>Show routes through this step</button>
                </div>
              ) : null}
              {routeTargetID === selected.id && routeTestContext ? (
                <section className="route-test-launcher" aria-label="Route tests">
                  <button
                    type="button"
                    className="primary"
                    disabled={runActive}
                    onClick={() => setRouteTestEditor({ key: `new:${selected.id}:${Date.now()}`, contextKey: routeTestContextKey })}
                  >Test reaching this step</button>
                  {savedRouteTests.length > 0 ? (
                    <div className="saved-route-tests">
                      <h3>Saved route tests</h3>
                      {savedRouteTests.map((saved) => (
                        <button
                          type="button"
                          key={saved.artifact.id}
                          disabled={runActive}
                          onClick={() => setRouteTestEditor({
                            artifact: saved.artifact,
                            needsReview: saved.needsReview,
                            key: `saved:${saved.artifact.id}:${Date.now()}`,
                            contextKey: routeTestContextKey,
                          })}
                        >
                          <span>{saved.artifact.name}</span>
                          <small>{saved.needsReview ? 'Needs review' : saved.artifact.last_result?.status ?? 'Draft'}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
              <StepInspector
                node={selected}
                runtime={runtimeNodes[selected.id]}
                debugControls={(
                  <DebugSelectionControls
                    document={document}
                    node={selected}
                    breakpoints={breakpoints}
                    watches={watches}
                    disabled={runActive}
                    onToggle={onToggleBreakpoint}
                    onWatchesChange={onWatchesChange}
                  />
                )}
              />
            </div>
          ) : (
            <RunOverview
              document={document}
              runtimeNodes={runtimeNodes}
              runID={runID}
              runStatus={runStarting ? 'starting' : runStatus}
              inputs={declarations.map((declaration) => ({
                name: declaration.name,
                value: inputValues[declaration.name] ?? '',
                secret: declaration.type === 'secret',
              }))}
              breakpointCount={breakpoints.length}
              diagnostics={runDiagnostics}
              activeNodeIDs={activeNodeIDs}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

function App() {
  const [document, setDocument] = useState<GraphDocument>();
  const [testMode, setTestMode] = useState(false);
  const [style, setStyle] = useState<NodeStyle>('smooth-curves');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [runDiagnostics, setRunDiagnostics] = useState('');
  const [runID, setRunID] = useState<string>();
  const [runStatus, setRunStatus] = useState('idle');
  const [runStarting, setRunStarting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [runtimeNodes, setRuntimeNodes] = useState<Record<string, RuntimeNodeState>>({});
  const [breakpoints, setBreakpoints] = useState<DebugBreakpointView[]>([]);
  const [watches, setWatches] = useState('');
  const [pending, setPending] = useState<PendingInteraction>();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [routeTestContext, setRouteTestContext] = useState<{ runbook: string; planHash: string }>();
  const [routeTests, setRouteTests] = useState<SavedRouteTestView[]>([]);
  const [routeTestOutcome, setRouteTestOutcome] = useState<RouteTestOutcome>();
  const [routeTestRunning, setRouteTestRunning] = useState(false);
  const [routeTestError, setRouteTestError] = useState<string>();
  const [xtsOpened, setXtsOpened] = useState(false);
  const pendingRef = useRef<PendingInteraction>();
  const runIDRef = useRef<string>();
  const runFinishedRef = useRef(false);
  const hostSessionRef = useRef(globalThis.crypto.randomUUID());
  const hostRequestRef = useRef<{
    runID: string;
    turnID: string;
    capability: string;
    correlationID: string;
    requestID: string;
  }>();

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { runIDRef.current = runID; }, [runID]);

  const clearActiveRun = () => {
    hostRequestRef.current = undefined;
    pendingRef.current = undefined;
    runIDRef.current = undefined;
    setXtsOpened(false);
    setPending(undefined);
    setRunID(undefined);
  };

  useEffect(() => {
    const receive = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'loading') {
        setError(undefined);
      } else if (message.type === 'graph') {
        setDocument(message.document);
        setRouteTestContext(message.routeTestContext);
        setRouteTests(message.routeTests ?? []);
        setRouteTestOutcome(undefined);
        setRouteTestRunning(false);
        setRouteTestError(undefined);
        setTestMode(message.testMode === true);
        setBreakpoints((current) => current.flatMap((breakpoint) => {
          const node = message.document.nodes.find((candidate) => candidate.id === breakpoint.nodeID);
          if (!node || !debugTargetSupported(message.document, node)) return [];
          return [{ ...debugTargetForNode(node), phase: breakpoint.phase }];
        }));
        setStyle(message.style);
        setLoading(false);
        setError(undefined);
      } else if (message.type === 'graph.reload-state') {
        setReloading(message.active);
      } else if (message.type === 'style') {
        setStyle(message.style);
      } else if (message.type === 'error') {
        setLoading(false);
        setError(message.message);
      } else if (message.type === 'run.starting') {
        clearActiveRun();
        runFinishedRef.current = false;
        setRunStarting(true);
        setRouteTestRunning(message.routeTest === true);
        setRunStatus('starting');
        setRunError(undefined);
        setRunDiagnostics('');
        setRuntimeNodes({});
        if (message.routeTest) {
          setRouteTestOutcome(undefined);
          setRouteTestError(undefined);
        }
      } else if (message.type === 'run.frame') {
        const frame = message.frame;
        if (frame.type === 'run.started') {
          runIDRef.current = frame.runID;
          setRunID(frame.runID);
          setRunStarting(false);
          if (!pendingRef.current) setRunStatus('running');
        } else if (frame.type === 'run.event' && frame.event) {
          setRuntimeNodes((current) => applyRuntimeEvent(current, frame.event!));
          if (frame.event.kind === 'run/started' && !pendingRef.current) setRunStatus('running');
          else if (frame.event.kind === 'run/completed') { clearActiveRun(); setRunStatus('completed'); }
          else if (frame.event.kind === 'run/failed') { clearActiveRun(); setRunStatus('failed'); }
          else if (frame.event.kind === 'run/cancelled') { clearActiveRun(); setRunStatus('cancelled'); }
          else if (frame.event.kind === 'run/indeterminate') { clearActiveRun(); setRunStatus('indeterminate'); }
        } else if (frame.type === 'interaction.pending' && frame.interaction) {
          pendingRef.current = frame.interaction;
          setPending(frame.interaction);
          setRunStatus('waiting');
        } else if (frame.type === 'interaction.resolved') {
          if (hostRequestRef.current?.turnID === frame.turnID) hostRequestRef.current = undefined;
          setPending((current) => {
            if (current?.turnID !== frame.turnID) return current;
            pendingRef.current = undefined;
            return undefined;
          });
          setRunStatus((current) => isTerminalRunStatus(current) ? current : 'running');
        } else if (frame.type === 'run.finished') {
          clearActiveRun();
          runFinishedRef.current = true;
          setRunStarting(false);
          setRouteTestRunning(false);
          setRuntimeNodes((current) => applyTerminalSteps(current, frame.steps));
          setRunStatus(frame.status ?? 'completed');
          if (frame.routeTest) setRouteTestOutcome(frame.routeTest);
        } else if (frame.type === 'protocol.error') {
          clearActiveRun();
          setRunError('The run protocol rejected a command.');
        }
      } else if (message.type === 'run.error') {
        clearActiveRun();
        setRunStarting(false);
        setRouteTestRunning(false);
        setRunStatus('failed');
        setRunError(message.message);
      } else if (message.type === 'run.stderr') {
        setRunDiagnostics((current) => `${current}${message.text}`.slice(-16 * 1024));
      } else if (message.type === 'run.exit') {
        clearActiveRun();
        setRunStarting(false);
        setRouteTestRunning(false);
        if (!runFinishedRef.current) {
          setRunStatus('failed');
          setRunError((current) => current ?? (message.code === 0
            ? 'gert exited before sending run.finished.'
            : `gert exited with code ${message.code ?? 'unknown'}`));
        }
      } else if (message.type === 'route-tests') {
        setRouteTests(message.routeTests);
      } else if (message.type === 'route-test.saved') {
        setRouteTestError(undefined);
      } else if (message.type === 'route-test.error') {
        setRouteTestError(message.message);
      } else if (message.type === 'gert.host-action.ack' || message.type === 'gert.host-action.cancel') {
        const response = parseHostActionResponse(message);
        if (!response) return;
        const interaction = pendingRef.current;
        const hostRequest = hostRequestRef.current;
        if (!interaction || interaction.kind !== 'host_action' || !interaction.host_action || !hostRequest) return;
        if (response.previewSessionId !== hostSessionRef.current ||
          interaction.runID !== hostRequest.runID ||
          interaction.turnID !== hostRequest.turnID ||
          interaction.host_action.capability !== hostRequest.capability ||
          response.correlationId !== hostRequest.correlationID ||
          response.requestId !== hostRequest.requestID) return;
        if (response.type === 'gert.host-action.ack' && (
          response.runId !== hostRequest.runID ||
          response.turnId !== hostRequest.turnID ||
          response.capability !== hostRequest.capability
        )) return;
        if (runIDRef.current !== hostRequest.runID) return;
        if (response.type === 'gert.host-action.ack' && response.status === 'completed' && response.result?.status === 'opened') {
          setXtsOpened(true);
        }
        vscode.postMessage({
          type: 'run.command',
          command: {
            type: 'interaction.answer',
            runID: runIDRef.current,
            turnID: interaction.turnID,
            answer: {
              kind: 'host_action',
              runID: runIDRef.current,
              turnID: interaction.turnID,
              correlationID: hostRequest.correlationID,
              capability: interaction.host_action.capability,
              status: response.status,
              result: response.type === 'gert.host-action.ack' ? response.result ?? undefined : undefined,
            },
          },
        });
        hostRequestRef.current = undefined;
      }
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!document) return;
    const values: Record<string, string> = {};
    for (const declaration of graphInputDeclarations(document)) {
      values[declaration.name] = declaration.default === undefined || declaration.default === null
        ? ''
        : String(declaration.default);
    }
    setInputValues(values);
  }, [document?.hash]);

  const dispatchHostAction = (interaction: PendingInteraction, panelConfirmed: boolean) => {
    if (interaction.kind !== 'host_action' || !interaction.host_action || !runID ||
        runIDRef.current !== runID || pendingRef.current?.turnID !== interaction.turnID) return;
    const correlationID = interaction.correlationID ?? interaction.turnID;
    const requestID = `${hostSessionRef.current}:${correlationID}`;
    if (hostRequestRef.current?.requestID === requestID) return;
    hostRequestRef.current = {
      runID,
      turnID: interaction.turnID,
      capability: interaction.host_action.capability,
      correlationID,
      requestID,
    };
    const envelope = {
      version: 'host-action/v1' as const,
      capability: interaction.host_action.capability,
      runId: runID,
      turnId: interaction.turnID,
      correlationId: correlationID,
      previewSessionId: hostSessionRef.current,
      requestId: requestID,
    };
    if (panelConfirmed) {
      vscode.postMessage({ type: 'gert.host-action.confirmed-request', ...envelope });
    }
    vscode.postMessage({
      type: 'gert.host-action.request',
      ...envelope,
      request: interaction.host_action.request,
    });
  };

  /* Non-XTS capabilities preserve their existing automatic dispatch. XTS waits for explicit panel confirmation. */
  useEffect(() => {
    if (!pending || pending.kind !== 'host_action' || !pending.host_action || !runID || pending.host_action.capability === 'xts.open-view') return;
    dispatchHostAction(pending, false);
  }, [pending?.turnID, runID]);

  const startRun = (debugMode = false) => {
    if (!document) return;
    const declarations = graphInputDeclarations(document);
    const missing = declarations.find((declaration) => declaration.required && !inputValues[declaration.name]);
    if (missing) {
      setRunError(`${missing.name} is required.`);
      return;
    }
    if (debugMode && breakpoints.length === 0) {
      setRunError('Add at least one breakpoint before starting a debug run.');
      return;
    }
    const watchExpressions = watches.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (watchExpressions.length > 32) {
      setRunError('Debug runs support at most 32 watch expressions.');
      return;
    }
    setRunError(undefined);
    hostRequestRef.current = undefined;
    pendingRef.current = undefined;
    runIDRef.current = undefined;
    setRunID(undefined);
    setRuntimeNodes({});
    setPending(undefined);
    vscode.postMessage({
      type: 'run.start',
      inputs: inputValues,
      ...(debugMode ? {
        debug: {
          enabled: true,
          breakpoints: breakpoints.map(({ step, phase, callPath }) => ({ step, phase, ...(callPath ? { callPath } : {}) })),
          ...(watchExpressions.length > 0 ? { watches: watchExpressions } : {}),
        },
      } : {}),
    });
  };

  const cancelRun = () => {
    if (!runID) return;
    const hostRequest = hostRequestRef.current;
    if (hostRequest) {
      vscode.postMessage({
        type: 'gert.host-action.cancel',
        version: 'host-action/v1',
        correlationId: hostRequest.correlationID,
        previewSessionId: hostSessionRef.current,
        requestId: hostRequest.requestID,
        status: 'execution-not-started',
        reason: 'run-replaced',
      });
    }
    hostRequestRef.current = undefined;
    vscode.postMessage({
      type: 'run.command',
      command: { type: 'run.cancel', runID, reason: 'operator cancelled' },
    });
  };

  const resetRun = () => {
    if (runStarting || !isTerminalRunStatus(runStatus)) return;
    vscode.postMessage({ type: 'run.reset' });
    clearActiveRun();
    runFinishedRef.current = true;
    setRunStatus('idle');
    setRunStarting(false);
    setRouteTestRunning(false);
    setRunError(undefined);
    setRunDiagnostics('');
    setRuntimeNodes({});
    setRouteTestOutcome(undefined);
    setRouteTestError(undefined);
  };

  const submitInteraction = (answer: Record<string, unknown>) => {
    if (!pending || !runID) return;
    vscode.postMessage({
      type: 'run.command',
      command: {
        type: 'interaction.answer',
        runID,
        turnID: pending.turnID,
        answer,
      },
    });
  };

  useEffect(() => {
    if (!testMode) return;
    const receiveTestAction = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (!message || message.type !== 'test.action') return;
      if (message.action === 'set-input' && message.name) {
        setInputValues((current) => ({ ...current, [message.name!]: message.value ?? '' }));
      } else if (message.action === 'run') {
        startRun(false);
      } else if (message.action === 'debug') {
        startRun(true);
      } else if (message.action === 'reset') {
        resetRun();
      } else if (message.action === 'cancel') {
        cancelRun();
      } else if (message.action === 'answer' && message.answer) {
        submitInteraction(message.answer);
      } else if (message.action === 'run-route-test' && message.artifact) {
        vscode.postMessage({ type: 'route-test.run', artifact: message.artifact });
      } else if (message.action === 'save-route-test' && message.artifact) {
        vscode.postMessage({ type: 'route-test.save', artifact: message.artifact });
      } else if (message.action === 'save-route-test-result' && message.artifact) {
        vscode.postMessage({ type: 'route-test.save', artifact: { ...message.artifact, last_result: {} } });
      } else if (message.action === 'click-button' && message.name) {
        const button = Array.from(window.document.querySelectorAll<HTMLButtonElement>('button'))
          .find((candidate) => candidate.textContent?.trim() === message.name);
        button?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => vscode.postMessage({
          type: 'test.dom.state',
          clicked: message.name,
          found: button !== undefined,
          collectorReviewVisible: window.document.querySelector('.collector-review') !== null,
          visibleButtons: Array.from(window.document.querySelectorAll<HTMLButtonElement>('button'))
            .map((candidate) => candidate.textContent?.trim()).filter(Boolean),
          disabledButtons: Array.from(window.document.querySelectorAll<HTMLButtonElement>('button:disabled'))
            .map((candidate) => candidate.textContent?.trim()).filter(Boolean),
          routeTestSafetyText: window.document.querySelector('.route-test-global-safety')?.textContent?.trim(),
        })));
      } else if (message.action === 'click-route-test-checkbox' && message.name) {
        const label = Array.from(window.document.querySelectorAll<HTMLLabelElement>('.route-test-pane label'))
          .find((candidate) => candidate.textContent?.includes(message.name!));
        const control = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
        control?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => vscode.postMessage({
          type: 'test.dom.state',
          routeTestCheckbox: message.name,
          found: control !== undefined,
          checked: control?.checked,
        })));
      } else if (message.action === 'toggle-choice' && message.name) {
        const controls = Array.from(window.document.querySelectorAll<HTMLInputElement>('input[name="choice"]'));
        const control = controls.find((candidate) => (
          candidate.closest('label')?.querySelector('strong')?.textContent?.trim() === message.name
        ));
        control?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const currentControls = Array.from(window.document.querySelectorAll<HTMLInputElement>('input[name="choice"]'));
          const labelFor = (candidate: HTMLInputElement) => candidate.closest('label')?.querySelector('strong')?.textContent?.trim();
          vscode.postMessage({
            type: 'test.dom.state',
            choice: message.name,
            found: control !== undefined,
            selectedChoices: currentControls.filter((candidate) => candidate.checked).map(labelFor).filter(Boolean),
            disabledChoices: currentControls.filter((candidate) => candidate.disabled).map(labelFor).filter(Boolean),
            continueDisabled: window.document.querySelector<HTMLButtonElement>('.interaction-pane button[type="submit"]')?.disabled,
            choiceLimitText: window.document.querySelector('.choice-limit')?.textContent?.trim(),
          });
        }));
      } else if (message.action === 'set-collector-field' && message.name) {
        const control = window.document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `.collector-field[data-field-name="${CSS.escape(message.name)}"] input, .collector-field[data-field-name="${CSS.escape(message.name)}"] select`,
        );
        if (control) {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value');
          descriptor?.set?.call(control, message.value ?? '');
          control.dispatchEvent(new Event('change', { bubbles: true }));
          control.dispatchEvent(new Event('input', { bubbles: true }));
        }
        requestAnimationFrame(() => requestAnimationFrame(() => vscode.postMessage({
          type: 'test.dom.state',
          field: message.name,
          found: control !== null,
          value: control?.value,
          collectorReviewVisible: window.document.querySelector('.collector-review') !== null,
        })));
      } else if (message.action === 'toggle-breakpoint' && message.name && (message.value === 'before' || message.value === 'after') && document) {
        setBreakpoints((current) => toggleBreakpoint(current, document, message.name!, message.value as DirectDebugPhase));
      }
    };
    window.addEventListener('message', receiveTestAction);
    return () => window.removeEventListener('message', receiveTestAction);
  }, [document, inputValues, pending, runID, runStatus, runStarting, breakpoints, watches, testMode]);

  useEffect(() => {
    if (!testMode) return;
    const frame = requestAnimationFrame(() => {
      vscode.postMessage({
        type: 'ui.state',
        runID,
        runStatus,
        runStarting,
        reloading,
        runError,
        pendingKind: pending?.kind,
        pendingDebugPhase: pending?.debug?.phase,
        pendingTurnID: pending?.turnID,
        inputCount: document ? graphInputDeclarations(document).length : 0,
        graphNodeIDs: document?.nodes.map((node) => node.id) ?? [],
        inputValues: Object.fromEntries(Object.entries(inputValues).map(([name, value]) => {
          const declaration = document ? graphInputDeclarations(document).find((input) => input.name === name) : undefined;
          return [name, declaration?.type === 'secret' && value ? '<redacted>' : value];
        })),
        runButtonCount: window.document.querySelectorAll('.run-actions button.primary').length,
        debugRunButtonCount: window.document.querySelectorAll('.run-actions button.debug-run').length,
        resetButtonCount: window.document.querySelectorAll('.run-actions button.reset-run').length,
        cancelButtonCount: window.document.querySelectorAll('.run-actions button.danger').length,
        breakpointCount: breakpoints.length,
        debugOverrideCount: Object.values(runtimeNodes).filter((state) => state.debugOverride !== undefined).length,
        routeTestPassed: routeTestOutcome?.passed,
        routeTestTargetReached: routeTestOutcome?.targetReached,
        routeTestExternalDispatches: routeTestOutcome?.externalDispatches,
        routeTestPlanHash: routeTestContext?.planHash,
        routeTestError,
        savedRouteTestIDs: routeTests.map(({ artifact }) => artifact.id),
        savedRouteTestResults: Object.fromEntries(routeTests.map(({ artifact }) => [artifact.id, artifact.last_result?.status])),
        collectorReviewVisible: window.document.querySelector('.collector-review') !== null,
        visibleButtons: Array.from(window.document.querySelectorAll<HTMLButtonElement>('button')).map((button) => button.textContent?.trim()).filter(Boolean),
        nodeStatuses: Object.fromEntries(Object.entries(runtimeNodes).map(([id, state]) => [id, state.status])),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [document, inputValues, runID, runStatus, runStarting, reloading, runError, pending?.turnID, runtimeNodes, breakpoints, routeTestContext?.planHash, routeTestOutcome, routeTestError, routeTests, testMode]);

  if (loading) return <div className="state" role="status">Loading runbook...</div>;
  if (error) return <div className="state error" role="alert">{error}</div>;
  if (!document) return <div className="state" role="status">No graph loaded</div>;
  return (
    <GraphView
      document={document}
      testMode={testMode}
      style={style}
      runtimeNodes={runtimeNodes}
      breakpoints={breakpoints}
      watches={watches}
      pending={pending}
      runID={runID}
      runStatus={runStatus}
      runStarting={runStarting}
      reloading={reloading}
      runError={runError}
      runDiagnostics={runDiagnostics}
      inputValues={inputValues}
      onInputChange={(name, value) => setInputValues((current) => ({ ...current, [name]: value }))}
      onRun={() => startRun(false)}
      onDebugRun={() => startRun(true)}
      onReset={resetRun}
      onCancel={cancelRun}
      onSubmitInteraction={submitInteraction}
      onConfirmHostAction={(interaction) => dispatchHostAction(interaction, true)}
      onToggleBreakpoint={(nodeID, phase) => setBreakpoints((current) => toggleBreakpoint(current, document, nodeID, phase))}
      onWatchesChange={setWatches}
      onStyleChange={(nextStyle) => {
        setStyle(nextStyle);
        vscode.postMessage({ type: 'style.change', style: nextStyle });
      }}
      routeTestContext={routeTestContext}
      routeTests={routeTests}
      routeTestOutcome={routeTestOutcome}
      routeTestRunning={routeTestRunning}
      routeTestError={routeTestError}
      onSaveRouteTest={(artifact) => vscode.postMessage({ type: 'route-test.save', artifact })}
      onRunRouteTest={(artifact) => {
        setRouteTestOutcome(undefined);
        setRouteTestError(undefined);
        vscode.postMessage({ type: 'route-test.run', artifact });
      }}
      xtsOpened={xtsOpened}
    />
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing webview root element');
createRoot(root).render(<App />);