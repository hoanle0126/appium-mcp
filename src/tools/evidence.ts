import {randomUUID} from 'node:crypto';

import type {ContentResult} from 'fastmcp';

import pkg from '../../package.json' with {type: 'json'};

/**
 * Structured, machine-readable trace of a single tool action, so CI and agents
 *  can diagnose failures without parsing prose.
 *
 * This is an *action* record. A future run-level bundle may reference many of
 * these plus heavier artifacts (screenshots, page source).
 */
export interface ActionEvidenceRecord {
  schemaVersion: 1;
  producer: {name: 'appium-mcp'; version: string};
  evidenceId: string;
  status: 'success' | 'error';
  /**
   * Action-specific details. `stage`/`locator`/`element` are optional because
   * they only apply to tools that resolve or interact with elements (find,
   * gesture); tools like screenshot carry just `name`.
   */
  action: {
    name: string;
    stage?: EvidenceStage;
    locator?: {strategy: string; selector: string};
    element?: {webdriverId: string};
  };
  context?: {
    platform?: string;
    contextName?: string;
  };
  timing: {startedAt: string; finishedAt: string; durationMs: number};
  error?: {code: EvidenceErrorCode; message: string};
  /**
   * Non-authoritative failure hypothesis and supporting signals when `status`
   * is `'error'`.
   */
  reason?: EvidenceFailureReason;
}

export interface EvidenceFailureReason {
  hypothesis: string;
  confidence?: number;
  signals?: string[];
}

export type EvidenceStage = 'locate' | 'interact' | 'capture';

export type EvidenceErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'TIMEOUT'
  | 'STALE_ELEMENT'
  | 'CONTEXT_NOT_AVAILABLE'
  | 'INVALID_SELECTOR'
  | 'ACTION_FAILED';

const EVIDENCE_MIME_TYPE = 'application/vnd.appium.evidence+json';

/** Inputs a handler supplies to describe the action it performed. */
export interface EvidenceInput {
  name: string;
  startedAt: number;
  stage?: EvidenceStage;
  locator?: ActionEvidenceRecord['action']['locator'];
  element?: ActionEvidenceRecord['action']['element'];
  context?: ActionEvidenceRecord['context'];
  error?: unknown;
}

/**
 * When disabled, evidence is never built or attached and tool
 * responses are byte-for-byte unchanged.
 */
export function isEvidenceEnabled(): boolean {
  const raw = process.env.APPIUM_MCP_EVIDENCE?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Attach an evidence record to an existing tool result as a `resource` content
 * block, leaving the original text untouched. No-op when evidence is disabled.
 */
export function withEvidence(result: ContentResult, input: EvidenceInput): ContentResult {
  if (!isEvidenceEnabled()) {
    return result;
  }
  const record = buildRecord(result, input);
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: 'resource',
        resource: {
          uri: `evidence://${record.evidenceId}`,
          mimeType: EVIDENCE_MIME_TYPE,
          text: JSON.stringify(record),
        },
      },
    ],
  };
}

/**
 * Snapshot the active session's platform and current context for the evidence
 * record. Returns undefined when there is no session to read, so the field is
 * simply omitted. The session-store import is deferred until evidence is
 * enabled so the disabled path pulls in no driver dependencies.
 */
export async function evidenceContext(sessionId?: string): Promise<ActionEvidenceRecord['context'] | undefined> {
  if (!isEvidenceEnabled()) {
    return undefined;
  }
  const {getSessionInfo} = await import('../session-store.js');
  const info = getSessionInfo(sessionId);
  if (!info) {
    return undefined;
  }
  return {
    ...(info.metadata.platform ? {platform: info.metadata.platform} : {}),
    ...(info.currentContext ? {contextName: info.currentContext} : {}),
  };
}

/**
 * Map a raw Appium/WebDriver error to a stable, normalized code. The codes are
 * also the foundation for failure-reason hypotheses. Inspects the error name
 * first, then the message, falling back to ACTION_FAILED.
 */
export function classifyError(err: unknown): EvidenceErrorCode {
  const name = err instanceof Error ? err.name : '';
  const message = (err instanceof Error ? err.message : String(err)) ?? '';
  const haystack = `${name} ${message}`.toLowerCase();

  if (/no such element|could not be located|element not found/.test(haystack)) {
    return 'ELEMENT_NOT_FOUND';
  }
  if (/stale element/.test(haystack)) {
    return 'STALE_ELEMENT';
  }
  if (/timed? ?out|timeout/.test(haystack)) {
    return 'TIMEOUT';
  }
  if (/no such context|context.*not.*(found|available)/.test(haystack)) {
    return 'CONTEXT_NOT_AVAILABLE';
  }
  if (/invalid selector|invalid.*(locator|xpath)/.test(haystack)) {
    return 'INVALID_SELECTOR';
  }
  return 'ACTION_FAILED';
}

const WEB_ONLY_STRATEGIES = new Set(['css selector']);
const NATIVE_ONLY_STRATEGIES = new Set([
  'accessibility id',
  '-ios predicate string',
  '-ios class chain',
  '-android uiautomator',
]);
const IOS_ONLY_STRATEGIES = new Set(['-ios predicate string', '-ios class chain']);
const ANDROID_ONLY_STRATEGIES = new Set(['-android uiautomator']);

/**
 * Generate a non-authoritative hypothesis and supporting signals explaining why
 * a tool error likely occurred, based on the classified error code and action
 * metadata (locator, element, stage, platform, and active context).
 */
export function buildFailureReason(
  error: NonNullable<ActionEvidenceRecord['error']>,
  input: Pick<EvidenceInput, 'name' | 'stage' | 'locator' | 'element' | 'context'>,
): EvidenceFailureReason {
  const signals: string[] = [];
  const strategy = input.locator?.strategy;
  const platform = input.context?.platform?.toLowerCase();
  const contextName = input.context?.contextName;

  if (input.locator) {
    signals.push(`Locator: ${input.locator.strategy}=${input.locator.selector}`);
  }
  if (input.element) {
    signals.push(`Element ID: ${input.element.webdriverId}`);
  }
  if (contextName) {
    signals.push(`Active context: ${contextName}`);
  }
  if (input.context?.platform) {
    signals.push(`Platform: ${input.context.platform}`);
  }
  if (input.stage) {
    signals.push(`Stage: ${input.stage}`);
  }
  signals.push(`Error code: ${error.code}`);

  if (
    strategy &&
    platform &&
    ((IOS_ONLY_STRATEGIES.has(strategy) && platform === 'android') ||
      (ANDROID_ONLY_STRATEGIES.has(strategy) && platform === 'ios'))
  ) {
    signals.unshift(`Platform mismatch: strategy '${strategy}' used on platform '${input.context?.platform}'`);
    return {
      hypothesis: `The locator strategy '${strategy}' is not supported on platform '${input.context?.platform}'`,
      confidence: 0.9,
      signals,
    };
  }

  if (strategy && contextName) {
    const isWebContext = contextName.toUpperCase().startsWith('WEBVIEW');
    if (WEB_ONLY_STRATEGIES.has(strategy) && contextName === 'NATIVE_APP') {
      signals.unshift(
        `Context mismatch: strategy '${strategy}' requires a WEBVIEW context, but active context is '${contextName}'`,
      );
      return {
        hypothesis:
          'CSS selector was used while in NATIVE_APP context; switch to a WEBVIEW context or use a native locator strategy',
        confidence: 0.85,
        signals,
      };
    }
    if (NATIVE_ONLY_STRATEGIES.has(strategy) && isWebContext) {
      signals.unshift(`Context mismatch: native strategy '${strategy}' used in web context '${contextName}'`);
      return {
        hypothesis: `Native locator strategy '${strategy}' was used while in WEBVIEW context '${contextName}'; switch to NATIVE_APP context or use a CSS/XPath selector`,
        confidence: 0.85,
        signals,
      };
    }
  }

  switch (error.code) {
    case 'ELEMENT_NOT_FOUND': {
      if (strategy === 'xpath') {
        signals.unshift('XPath selectors are sensitive to view hierarchy changes');
        return {
          hypothesis:
            'The target element was not found in the current hierarchy; the UI may still be loading, the element may be off-screen, or the XPath selector is too brittle after a hierarchy change',
          confidence: 0.65,
          signals,
        };
      }
      return {
        hypothesis:
          'The target element was not found in the current hierarchy; the screen may still be loading, blocked by a modal/alert, or the element requires scrolling into view',
        confidence: 0.7,
        signals,
      };
    }
    case 'STALE_ELEMENT':
      return {
        hypothesis:
          'The previously located element reference is stale because the UI re-rendered or navigated away; re-locate the element before interacting',
        confidence: 0.85,
        signals,
      };
    case 'TIMEOUT':
      if (input.stage === 'locate') {
        return {
          hypothesis:
            'Locating the element timed out; the app may still be loading, blocked by a modal, or the selector does not match the current screen',
          confidence: 0.75,
          signals,
        };
      }
      return {
        hypothesis: 'The operation timed out while waiting for the device or application to respond',
        confidence: 0.75,
        signals,
      };
    case 'CONTEXT_NOT_AVAILABLE':
      return {
        hypothesis:
          'The requested context is not available; the WebView may not be initialized yet or WebView debugging may be disabled',
        confidence: 0.85,
        signals,
      };
    case 'INVALID_SELECTOR':
      return {
        hypothesis: strategy
          ? `The selector syntax is invalid for locator strategy '${strategy}'`
          : 'The selector syntax is invalid for the chosen locator strategy',
        confidence: 0.9,
        signals,
      };
    case 'ACTION_FAILED':
      if (input.stage === 'interact') {
        return {
          hypothesis:
            'The interaction failed; the target element may be obscured by an overlay, disabled, or outside the visible viewport',
          confidence: 0.55,
          signals,
        };
      }
      return {
        hypothesis: 'The tool action failed due to an unexpected driver or application error',
        confidence: 0.4,
        signals,
      };
  }
}

function buildRecord(result: ContentResult, input: EvidenceInput): ActionEvidenceRecord {
  const finished = Date.now();
  const status: ActionEvidenceRecord['status'] = result.isError || input.error !== undefined ? 'error' : 'success';
  const resolvedError = status === 'error' ? buildError(input.error, result) : undefined;

  return {
    schemaVersion: 1,
    producer: {name: 'appium-mcp', version: pkg.version},
    evidenceId: randomUUID(),
    status,
    action: {
      name: input.name,
      ...(input.stage ? {stage: input.stage} : {}),
      ...(input.locator ? {locator: input.locator} : {}),
      ...(input.element ? {element: input.element} : {}),
    },
    ...(input.context ? {context: input.context} : {}),
    timing: {
      startedAt: new Date(input.startedAt).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - input.startedAt,
    },
    ...(resolvedError
      ? {
          error: resolvedError,
          reason: buildFailureReason(resolvedError, input),
        }
      : {}),
  };
}

/**
 * Resolve the error message, then classify from the same source so the code
 * and message always agree — handlers that swallow errors only expose the
 * result text, so fall back to that when no error object is passed.
 */
function buildError(err: unknown, result: ContentResult): NonNullable<ActionEvidenceRecord['error']> {
  const message = errorMessage(err, result);
  return {code: classifyError(err ?? message), message};
}

function errorMessage(err: unknown, result: ContentResult): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err !== undefined) {
    return String(err);
  }
  const text = result.content.find((c) => c.type === 'text');
  return text && 'text' in text ? text.text : 'Unknown error';
}
