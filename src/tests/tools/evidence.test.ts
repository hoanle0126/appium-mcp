import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import type {ContentResult} from 'fastmcp';

import type {ActionEvidenceRecord} from '../../tools/evidence.js';

// Mock the session store to avoid pulling in the native drivers it imports.
jest.unstable_mockModule('../../session-store', () => ({
  getSessionInfo: jest.fn(() => null),
}));

const {buildFailureReason, classifyError, isEvidenceEnabled, withEvidence} = await import('../../tools/evidence.js');

const ENV_KEY = 'APPIUM_MCP_EVIDENCE';

function enableEvidence(value = '1'): void {
  process.env[ENV_KEY] = value;
}

const textResult = (text: string): ContentResult => ({
  content: [{type: 'text', text}],
});
const errorResult = (text: string): ContentResult => ({
  content: [{type: 'text', text}],
  isError: true,
});

function readRecord(result: ContentResult): ActionEvidenceRecord {
  const block = result.content.find((c) => c.type === 'resource');
  const text = block?.type === 'resource' && 'text' in block.resource ? block.resource.text : undefined;
  if (typeof text !== 'string') {
    throw new Error('no evidence resource block found');
  }
  return JSON.parse(text) as ActionEvidenceRecord;
}

describe('classifyError', () => {
  test.each([
    ['An element could not be located on the page', 'ELEMENT_NOT_FOUND'],
    ['no such element: unable to find', 'ELEMENT_NOT_FOUND'],
    ['stale element reference', 'STALE_ELEMENT'],
    ['The operation timed out after 10000ms', 'TIMEOUT'],
    ['no such context WEBVIEW_x', 'CONTEXT_NOT_AVAILABLE'],
    ['invalid selector: //[', 'INVALID_SELECTOR'],
    ['something unexpected exploded', 'ACTION_FAILED'],
  ])('maps %j -> %s', (message, code) => {
    expect(classifyError(new Error(message))).toBe(code);
  });

  test('accepts non-Error values', () => {
    expect(classifyError('plain timeout string')).toBe('TIMEOUT');
    expect(classifyError(undefined)).toBe('ACTION_FAILED');
  });
});

describe('isEvidenceEnabled', () => {
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  test.each(['1', 'true', 'TRUE'])('enabled for %j', (value) => {
    process.env[ENV_KEY] = value;
    expect(isEvidenceEnabled()).toBe(true);
  });

  test.each(['0', 'false', '', undefined])('disabled for %j', (value) => {
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }
    expect(isEvidenceEnabled()).toBe(false);
  });
});

describe('withEvidence', () => {
  const original = process.env[ENV_KEY];
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  test('is a no-op when disabled', () => {
    const result = textResult('ok');
    const out = withEvidence(result, {
      name: 'appium_find_element',
      stage: 'locate',
      startedAt: Date.now(),
    });
    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
  });

  test('appends a resource block without mutating the text', () => {
    enableEvidence();
    const out = withEvidence(textResult("elementId 'abc'\nfound"), {
      name: 'appium_find_element',
      stage: 'locate',
      startedAt: Date.now(),
      locator: {strategy: 'accessibility id', selector: 'login'},
      element: {webdriverId: 'abc'},
    });

    expect(out.content[0]).toEqual({
      type: 'text',
      text: "elementId 'abc'\nfound",
    });
    const block = out.content[1];
    expect(block.type).toBe('resource');
    if (block.type === 'resource') {
      expect(block.resource.uri).toMatch(/^evidence:\/\//);
      expect(block.resource.mimeType).toBe('application/vnd.appium.evidence+json');
    }
  });

  test('builds a success record', () => {
    enableEvidence();
    const startedAt = Date.now();
    const record = readRecord(
      withEvidence(textResult('found'), {
        name: 'appium_find_element',
        stage: 'locate',
        startedAt,
        locator: {strategy: 'id', selector: 'btn'},
        element: {webdriverId: 'el-1'},
      }),
    );

    expect(record.schemaVersion).toBe(1);
    expect(record.producer.name).toBe('appium-mcp');
    expect(record.evidenceId).toEqual(expect.any(String));
    expect(record.status).toBe('success');
    expect(record.action.name).toBe('appium_find_element');
    expect(record.action.stage).toBe('locate');
    expect(record.action.locator).toEqual({strategy: 'id', selector: 'btn'});
    expect(record.action.element).toEqual({webdriverId: 'el-1'});
    expect(record.error).toBeUndefined();
    expect(record.reason).toBeUndefined();
    expect(record.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.timing.startedAt).toBe(new Date(startedAt).toISOString());
  });

  test('classifies error from the passed error object', () => {
    enableEvidence();
    const record = readRecord(
      withEvidence(errorResult('Failed to find element. Error: stale'), {
        name: 'appium_find_element',
        stage: 'locate',
        startedAt: Date.now(),
        element: {webdriverId: 'el-stale'},
        error: new Error('stale element reference'),
      }),
    );

    expect(record.status).toBe('error');
    expect(record.error?.code).toBe('STALE_ELEMENT');
    expect(record.error?.message).toBe('stale element reference');
    expect(record.reason).toEqual({
      hypothesis:
        'The previously located element reference is stale because the UI re-rendered or navigated away; re-locate the element before interacting',
      confidence: 0.85,
      signals: ['Element ID: el-stale', 'Stage: locate', 'Error code: STALE_ELEMENT'],
    });
  });

  test('falls back to result text when no error object is supplied', () => {
    enableEvidence();
    const record = readRecord(
      withEvidence(errorResult('The operation timed out'), {
        name: 'appium_gesture',
        stage: 'interact',
        startedAt: Date.now(),
      }),
    );

    expect(record.status).toBe('error');
    expect(record.error?.code).toBe('TIMEOUT');
    expect(record.error?.message).toBe('The operation timed out');
    expect(record.reason).toEqual({
      hypothesis: 'The operation timed out while waiting for the device or application to respond',
      confidence: 0.75,
      signals: ['Stage: interact', 'Error code: TIMEOUT'],
    });
  });
});

describe('buildFailureReason', () => {
  test('flags CSS selector used in NATIVE_APP context', () => {
    const reason = buildFailureReason(
      {code: 'ELEMENT_NOT_FOUND', message: 'no such element'},
      {
        name: 'appium_find_element',
        stage: 'locate',
        locator: {strategy: 'css selector', selector: '.login-btn'},
        context: {platform: 'Android', contextName: 'NATIVE_APP'},
      },
    );

    expect(reason.confidence).toBe(0.85);
    expect(reason.hypothesis).toContain('CSS selector was used while in NATIVE_APP context');
    expect(reason.signals).toContain(
      "Context mismatch: strategy 'css selector' requires a WEBVIEW context, but active context is 'NATIVE_APP'",
    );
  });

  test('flags native locator strategy used in WEBVIEW context', () => {
    const reason = buildFailureReason(
      {code: 'ELEMENT_NOT_FOUND', message: 'no such element'},
      {
        name: 'appium_find_element',
        stage: 'locate',
        locator: {strategy: 'accessibility id', selector: 'login'},
        context: {platform: 'iOS', contextName: 'WEBVIEW_1234'},
      },
    );

    expect(reason.confidence).toBe(0.85);
    expect(reason.hypothesis).toContain("Native locator strategy 'accessibility id' was used while in WEBVIEW context");
    expect(reason.signals).toContain(
      "Context mismatch: native strategy 'accessibility id' used in web context 'WEBVIEW_1234'",
    );
  });

  test('flags platform-specific locator mismatch', () => {
    const reason = buildFailureReason(
      {code: 'INVALID_SELECTOR', message: 'invalid selector'},
      {
        name: 'appium_find_element',
        stage: 'locate',
        locator: {strategy: '-ios predicate string', selector: 'label == "Sign in"'},
        context: {platform: 'Android', contextName: 'NATIVE_APP'},
      },
    );

    expect(reason.confidence).toBe(0.9);
    expect(reason.hypothesis).toBe(
      "The locator strategy '-ios predicate string' is not supported on platform 'Android'",
    );
    expect(reason.signals).toContain("Platform mismatch: strategy '-ios predicate string' used on platform 'Android'");
  });

  test('highlights XPath brittleness on ELEMENT_NOT_FOUND', () => {
    const reason = buildFailureReason(
      {code: 'ELEMENT_NOT_FOUND', message: 'no such element'},
      {
        name: 'appium_find_element',
        stage: 'locate',
        locator: {strategy: 'xpath', selector: '//XCUIElementTypeButton[1]'},
        context: {platform: 'iOS', contextName: 'NATIVE_APP'},
      },
    );

    expect(reason.confidence).toBe(0.65);
    expect(reason.hypothesis).toContain('XPath selector is too brittle');
    expect(reason.signals).toContain('XPath selectors are sensitive to view hierarchy changes');
  });

  test.each([
    ['ELEMENT_NOT_FOUND' as const, 'locate' as const, 0.7, 'The target element was not found in the current hierarchy'],
    ['TIMEOUT' as const, 'locate' as const, 0.75, 'Locating the element timed out'],
    ['CONTEXT_NOT_AVAILABLE' as const, undefined, 0.85, 'The requested context is not available'],
    ['INVALID_SELECTOR' as const, 'locate' as const, 0.9, "The selector syntax is invalid for locator strategy 'id'"],
    [
      'ACTION_FAILED' as const,
      'interact' as const,
      0.55,
      'The interaction failed; the target element may be obscured by an overlay',
    ],
    [
      'ACTION_FAILED' as const,
      undefined,
      0.4,
      'The tool action failed due to an unexpected driver or application error',
    ],
  ])('builds hypothesis for %s (stage=%s)', (code, stage, expectedConfidence, expectedSubstring) => {
    const reason = buildFailureReason(
      {code, message: 'err'},
      {
        name: 'appium_find_element',
        stage,
        locator: {strategy: 'id', selector: 'submit'},
      },
    );

    expect(reason.confidence).toBe(expectedConfidence);
    expect(reason.hypothesis).toContain(expectedSubstring);
    expect(reason.signals).toContain(`Error code: ${code}`);
  });
});
