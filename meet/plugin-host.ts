/**
 * plugin-host — the host surface this plugin needs from the assistant.
 *
 * ## Why this file exists
 *
 * meet-join used to live inside the assistant monorepo as a "skill" and
 * received its host capabilities from `@vellumai/skill-host-contracts`: an
 * out-of-process IPC contract (`SkillHost` + a `SkillHostClient` that talked
 * to the daemon over a socket). That harness was the "API ugliness" we are
 * unwinding — a parallel host contract that duplicated what the plugin
 * system should expose directly. The IPC bin and its client are gone; what
 * remains is the in-process host surface the plugin's `register(host)` is
 * handed.
 *
 * As a standalone repo installed as an external plugin, meet-join can no
 * longer import from `assistant/src/...` or the monorepo `packages/`. The
 * public plugin contract (`@vellumai/plugin-api`) is the only sanctioned
 * channel — but today that surface is far thinner than what meet needs
 * (workspace paths, STT/TTS provider resolution, the secure key store,
 * assistant identity, memory writes + agent wake, speaker tracking).
 *
 * This file is a deliberate, single-file STUB of everything meet-join
 * consumes from the host. It is the strawman we iterate on to decide how
 * `@vellumai/plugin-api` should grow. Nothing here touches the real
 * plugin-api package. Two runtime helpers (`RiskLevel`, `buildAssistantEvent`)
 * are real because they are trivial and dependency-free; everything else is
 * type-level or a stub that the host will satisfy once the API is expanded.
 *
 * Surface consolidated here (previously across four files in
 * skill-host-contracts): tool types, runtime mode, server-message wire
 * shape, assistant-event envelope, and the host facets.
 */

import { randomUUID } from "node:crypto";

// ===========================================================================
// Tool types
//
// The runtime narrows `ToolContext` / `ToolExecutionResult` to its concrete
// daemon types at the boundary; heavy daemon-internal fields are held as
// `unknown` / broadened `string` here so this stub stays dependency-free.
// ===========================================================================

export type ExecutionTarget = "sandbox" | "host";

/** The kind of extension that owns a tool. Core tools have no owner. */
export type OwnerKind = "skill" | "mcp" | "plugin";

/**
 * Identifies which extension owns a tool. Tracked by the host's tool
 * registry keyed by tool name, not stored on the `Tool` object itself.
 */
export interface OwnerInfo {
  kind: OwnerKind;
  id: string;
}

export enum RiskLevel {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: object;
}

export type ErrorCategory =
  | "permission_denied"
  | "auth"
  | "tool_failure"
  | "unexpected";

export interface DiffInfo {
  filePath: string;
  oldContent: string;
  newContent: string;
  isNewFile: boolean;
}

export type SensitiveOutputKind = "invite_code";

export interface SensitiveOutputBinding {
  kind: SensitiveOutputKind;
  placeholder: string;
  value: string;
}

/** Approval request from the outbound proxy when a policy decision requires user confirmation. */
export interface ProxyApprovalRequest {
  decision: {
    kind: "ask_missing_credential" | "ask_unauthenticated";
    target: {
      hostname: string;
      port: number | null;
      path: string;
      scheme: "http" | "https";
    };
    matchingPatterns?: string[];
  };
  sessionId: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}

/** Callback for proxy policy decisions requiring user confirmation. Returns true if approved. */
export type ProxyApprovalCallback = (
  request: ProxyApprovalRequest,
) => Promise<boolean>;

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  diff?: DiffInfo;
  /** Optional status message for display (e.g. timeout, truncation). */
  status?: string;
  /** Optional rich content blocks (e.g. images) to include alongside text in the tool result. */
  contentBlocks?: unknown[];
  /** Runtime-internal sensitive output bindings (placeholder -> real value). MUST NOT be emitted in client-facing events or logs. */
  sensitiveBindings?: SensitiveOutputBinding[];
  /** When true, the agent loop yields control back to the user after returning this result. */
  yieldToUser?: boolean;
  /** Risk level from the classifier (populated during permission check). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** Whether the host is running in a containerized (Docker) environment. */
  isContainerized?: boolean;
  /** Scope options ladder for the rule editor (narrowest to broadest). */
  riskScopeOptions?: Array<{ pattern: string; label: string }>;
  /** Set when a CES tool returned an `approval_required` response. Narrowed by the host. */
  cesApprovalRequired?: unknown;
}

export type ProxyToolResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

// -- Tool lifecycle events ---------------------------------------------------

interface ToolLifecycleEventBase {
  toolName: string;
  input: Record<string, unknown>;
  workingDir: string;
  conversationId: string;
  requestId?: string;
  executionTarget?: ExecutionTarget;
}

export interface AllowlistOption {
  label: string;
  description: string;
  pattern: string;
}

export interface ScopeOption {
  label: string;
  scope: string;
}

export interface ToolExecutionStartEvent extends ToolLifecycleEventBase {
  type: "start";
  startedAtMs: number;
}

export interface ToolPermissionPromptEvent extends ToolLifecycleEventBase {
  type: "permission_prompt";
  riskLevel: string;
  riskReason?: string;
  reason: string;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  diff?: DiffInfo;
  persistentDecisionsAllowed?: boolean;
}

export interface ToolPermissionDeniedEvent extends ToolLifecycleEventBase {
  type: "permission_denied";
  riskLevel: string;
  riskReason?: string;
  matchedTrustRuleId?: string;
  decision: "deny" | "always_deny";
  reason: string;
  durationMs: number;
}

export interface ToolExecutedEvent extends ToolLifecycleEventBase {
  type: "executed";
  riskLevel: string;
  matchedTrustRuleId?: string;
  decision: string;
  durationMs: number;
  result: ToolExecutionResult;
}

export interface ToolExecutionErrorEvent extends ToolLifecycleEventBase {
  type: "error";
  riskLevel: string;
  matchedTrustRuleId?: string;
  decision: string;
  durationMs: number;
  errorMessage: string;
  isExpected: boolean;
  errorCategory: ErrorCategory;
  errorName?: string;
  errorStack?: string;
}

export type ToolLifecycleEvent =
  | ToolExecutionStartEvent
  | ToolPermissionPromptEvent
  | ToolPermissionDeniedEvent
  | ToolExecutedEvent
  | ToolExecutionErrorEvent;

export type ToolLifecycleEventHandler = (
  event: ToolLifecycleEvent,
) => void | Promise<void>;

// -- Tool context ------------------------------------------------------------

export interface ToolContext {
  workingDir: string;
  conversationId: string;
  /** Logical assistant scope for multi-assistant routing. */
  assistantId?: string;
  /** When set, the tool execution is part of a task run. */
  taskRunId?: string;
  /** Per-message request ID for log correlation. */
  requestId?: string;
  /** Optional callback for streaming incremental output to the client. */
  onOutput?: (chunk: string) => void;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Optional callback for tool lifecycle events. */
  onToolLifecycleEvent?: ToolLifecycleEventHandler;
  /** Optional resolver for proxy tools. */
  proxyToolResolver?: ProxyToolResolver;
  /** When set, only tools in this set may execute. */
  allowedToolNames?: Set<string>;
  /** Prompt the user for a secret value via native SecureField UI. Return shape narrowed by the host. */
  requestSecret?: (params: {
    service: string;
    field: string;
    label: string;
    description?: string;
    placeholder?: string;
    purpose?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
  }) => Promise<unknown>;
  /** Optional callback to send a message to the connected client (e.g. open_url). */
  sendToClient?: (msg: { type: string; [key: string]: unknown }) => void;
  /** True when an interactive client is connected. */
  isInteractive?: boolean;
  /** Memory scope ID from the conversation's memory policy. */
  memoryScopeId?: string;
  /** When true, tools with side effects should always prompt for confirmation. */
  forcePromptSideEffects?: boolean;
  /** When true, the tool requires a fresh interactive approval for every invocation. */
  requireFreshApproval?: boolean;
  /** Approval callback for proxy policy decisions that require user confirmation. */
  proxyApprovalCallback?: ProxyApprovalCallback;
  /** Optional principal identifier propagated to sub-tool confirmation flows. */
  principal?: string;
  /** Trust classification of the actor who initiated this tool invocation. Narrowed by the host to a concrete union. */
  trustClass: string;
  /** Channel through which the tool invocation originates. */
  executionChannel?: string;
  /** Voice/call session ID, if the invocation originates from a call. */
  callSessionId?: string;
  /** True when triggered by a user clicking a surface action button. */
  triggeredBySurfaceAction?: boolean;
  /** True when the user explicitly approved this tool invocation via the interactive permission prompt. */
  approvedViaPrompt?: boolean;
  /** True when inside a scheduled task run whose `required_tools` pre-authorized this tool. */
  batchAuthorizedByTask?: boolean;
  /** External user ID of the requester (non-guardian actor). */
  requesterExternalUserId?: string;
  /** Chat ID of the requester (non-guardian actor). */
  requesterChatId?: string;
  /** Human-readable identifier for the requester. */
  requesterIdentifier?: string;
  /** Preferred display name for the requester. */
  requesterDisplayName?: string;
  /** Slack channel ID for channel-scoped permission enforcement. */
  channelPermissionChannelId?: string;
  /** The tool_use block ID from the LLM response. */
  toolUseId?: string;
  /** Optional proxy for delegating host_bash execution to a connected client. Narrowed by the host. */
  hostBashProxy?: unknown;
  /** Optional proxy for delegating CDP commands to a connected client. Narrowed by the host. */
  hostBrowserProxy?: unknown;
  /** Optional proxy for delegating host_file_* execution to a connected client. Narrowed by the host. */
  hostFileProxy?: unknown;
  /** True when the assistant is running as a platform-managed remote instance. */
  isPlatformHosted?: boolean;
  /** CES RPC client for credential execution operations. Narrowed by the host. */
  cesClient?: unknown;
  /** The interface ID of the connected client driving the current turn. Narrowed by the host. */
  transportInterface?: string;
  /** True when the host browser proxy's sender was overridden by an extension connection. */
  hostBrowserRegistryRouted?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  /** Declared execution target. Used to label lifecycle events for plugin-provided tools. */
  executionTarget?: ExecutionTarget;
  getDefinition(): ToolDefinition;
  execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
}

// ===========================================================================
// Runtime mode
// ===========================================================================

/** `"docker"` = host runs inside a container; `"bare-metal"` = directly on the host. */
export type DaemonRuntimeMode = "bare-metal" | "docker";

// ===========================================================================
// Server message — opaque outbound wire shape
//
// Treated as an opaque discriminated union keyed on `type`; values are
// passed through to the host's event hub without narrowing on variants.
// ===========================================================================

export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

// ===========================================================================
// Assistant event envelope (+ real factory)
// ===========================================================================

export interface AssistantEvent<TMessage = unknown> {
  /** Globally unique event identifier (UUID). */
  id: string;
  /** Resolved conversation id when available. */
  conversationId?: string;
  /** Monotonic per-conversation sequence number, assigned by the host at publish time. */
  seq?: number;
  /** ISO-8601 timestamp of when the event was emitted. */
  emittedAt: string;
  /** Outbound message payload. */
  message: TMessage;
}

/** Construct an `AssistantEvent` envelope around a message payload. */
export function buildAssistantEvent<TMessage>(
  message: TMessage,
  conversationId?: string,
): AssistantEvent<TMessage> {
  return {
    id: randomUUID(),
    conversationId,
    emittedAt: new Date().toISOString(),
    message,
  };
}

// ===========================================================================
// Host facets
//
// These are the capabilities meet-join needs from the host. Today they map
// onto the deprecated SkillHost IPC facets; the open design question (next
// PR) is which of these belong in `@vellumai/plugin-api` and in what shape.
// ===========================================================================

// -- Logger ------------------------------------------------------------------

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface LoggerFacet {
  get(name: string): Logger;
}

// -- Config ------------------------------------------------------------------

export interface ConfigFacet {
  /** Read a typed section from the host's resolved config by dot-path (e.g. `"services.meet"`). */
  getSection<T>(path: string): T | undefined;
}

// -- Identity ----------------------------------------------------------------

export interface IdentityFacet {
  /** Current display name for the assistant, if configured. */
  getAssistantName(): string | undefined;
}

// -- Platform ----------------------------------------------------------------

export interface PlatformFacet {
  /** Absolute path to the current workspace directory. */
  workspaceDir(): string;
  /** Absolute path to the Vellum data root. */
  vellumRoot(): string;
  /** Current runtime mode (bare-metal vs Docker). */
  runtimeMode(): DaemonRuntimeMode;
}

// -- Providers ---------------------------------------------------------------

/** Opaque LLM provider handle (narrowed by the host to the concrete provider union). */
export type Provider = unknown;

/** Opaque "user message" content envelope. */
export type UserMessage = unknown;

/** Opaque `tool_use` content block extracted from an LLM response. */
export type ToolUse = unknown;

export interface LlmProvidersFacet {
  /** Resolve the provider configured for the given LLM call site, or `null` when unavailable. */
  getConfigured(callSite: string): Promise<Provider | null>;
  /** Wrap plain text into the provider's user-message envelope shape. */
  userMessage(text: string): UserMessage;
  /** Pull the first `tool_use` block out of a completion response, if any. */
  extractToolUse(response: unknown): ToolUse | null;
  /** Produce an `AbortSignal` that fires after `ms` ms, plus a `cleanup()` to cancel the timer. */
  createTimeout(ms: number): { signal: AbortSignal; cleanup: () => void };
}

/** Opaque STT spec. */
export type SttSpec = unknown;

/** Opaque streaming transcriber handle. */
export type StreamingTranscriber = unknown;

export interface SttProvidersFacet {
  listProviderIds(): string[];
  supportsBoundary(id: string): boolean;
  /** Resolve a streaming transcriber for `spec`, or `null` when unsupported. */
  resolveStreamingTranscriber(
    spec: SttSpec,
  ): Promise<StreamingTranscriber | null>;
}

/** Opaque TTS provider handle. */
export type TtsProvider = unknown;

/** Opaque TTS runtime config. */
export type TtsConfig = unknown;

export interface TtsProvidersFacet {
  get(id: string): TtsProvider;
  resolveConfig(): TtsConfig;
}

export interface SecureKeysFacet {
  /** Retrieve a provider API key from the secure credential store, or `null` if absent. */
  getProviderKey(id: string): Promise<string | null>;
}

export interface ProvidersFacet {
  llm: LlmProvidersFacet;
  stt: SttProvidersFacet;
  tts: TtsProvidersFacet;
  secureKeys: SecureKeysFacet;
}

// -- Memory ------------------------------------------------------------------

/** Valid message roles for `memory.addMessage` (UI-facing store; no agent-context `system` rows). */
export type MessageRole = "user" | "assistant";

export interface InsertMessageOptions {
  metadata?: Record<string, unknown>;
  skipIndexing?: boolean;
}

export type InsertMessageFn = (
  conversationId: string,
  role: MessageRole,
  content: string,
  options?: InsertMessageOptions,
) => Promise<unknown>;

/** Opaque payload passed to `memory.wakeAgentForOpportunity`. */
export type WakeOpportunity = unknown;

export interface MemoryFacet {
  addMessage: InsertMessageFn;
  wakeAgentForOpportunity(req: WakeOpportunity): Promise<void>;
}

// -- Events ------------------------------------------------------------------

/** Subscription filter mirroring the host hub's event filter. */
export interface Filter {
  /** When set, restrict delivery to this conversation. */
  conversationId?: string;
}

/** Callback invoked for each event that matches a subscriber's filter. */
export type AssistantEventCallback = (
  event: AssistantEvent,
) => void | Promise<void>;

/** Opaque handle returned by `events.subscribe`. Calling `dispose()` unsubscribes. */
export interface Subscription {
  dispose(): void;
  readonly active: boolean;
}

export interface EventsFacet {
  publish(event: AssistantEvent): Promise<void>;
  subscribe(filter: Filter, cb: AssistantEventCallback): Subscription;
  buildEvent(message: ServerMessage, conversationId?: string): AssistantEvent;
}

// -- Speakers ----------------------------------------------------------------

/** Opaque speaker-identity tracker (concrete type owned by the host). */
export type SpeakerIdentityTracker = unknown;

export interface SpeakersFacet {
  createTracker(): SpeakerIdentityTracker;
}

// -- Aggregate ---------------------------------------------------------------

/**
 * Everything meet-join needs from the host, grouped by concern. Passed to
 * the plugin's `register(host)` entry point. This is the surface we will
 * fold into `@vellumai/plugin-api` (in some shape) in the follow-up.
 */
export interface SkillHost {
  logger: LoggerFacet;
  config: ConfigFacet;
  identity: IdentityFacet;
  platform: PlatformFacet;
  providers: ProvidersFacet;
  memory: MemoryFacet;
  events: EventsFacet;
  speakers: SpeakersFacet;
}
