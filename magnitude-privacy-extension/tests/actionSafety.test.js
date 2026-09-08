// tests/actionSafety.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyActionForRetry,
  decideRecovery,
  isActionableTarget,
  interpretOutcome
} from '../shared/actionSafety.js';

test('sensitive credential fill is never blindly retried', () => {
  const cls = classifyActionForRetry({ variant: 'local:fill_credential', target: { selectorPath: '#pan' } });
  assert.equal(cls.retryable, false);
  assert.equal(cls.requiresConfirmation, true);
});

test('file upload is never blindly retried', () => {
  const cls = classifyActionForRetry({ variant: 'browser:upload_file', target: { selectorPath: '#file' } });
  assert.equal(cls.retryable, false);
});

test('scroll and tab-switch are safe to retry', () => {
  assert.equal(classifyActionForRetry({ variant: 'mouse:scroll' }).retryable, true);
  assert.equal(classifyActionForRetry({ variant: 'browser:tab:switch' }).retryable, true);
});

test('a click on a submit control is treated as destructive', () => {
  const cls = classifyActionForRetry({ variant: 'mouse:click', target: { label: 'Submit Payment' } });
  assert.equal(cls.retryable, false);
  assert.equal(cls.requiresConfirmation, true);
});

test('a neutral click is retryable', () => {
  const cls = classifyActionForRetry({ variant: 'mouse:click', target: { label: 'Next' } });
  assert.equal(cls.retryable, true);
});

test('recovery stops when action already succeeded', () => {
  const r = decideRecovery({ variant: 'mouse:click', target: { label: 'Next' } }, { alreadySucceeded: true });
  assert.equal(r.action, 'stop');
});

test('recovery requests confirmation for destructive failed action', () => {
  const r = decideRecovery({ variant: 'local:fill_credential' }, { attempt: 1 });
  assert.equal(r.action, 'confirm');
});

test('recovery retries safe action within budget, then stops', () => {
  const safe = { variant: 'mouse:scroll' };
  assert.equal(decideRecovery(safe, { attempt: 1, maxAttempts: 3 }).action, 'retry');
  assert.equal(decideRecovery(safe, { attempt: 3, maxAttempts: 3 }).action, 'stop');
});

test('isActionableTarget enforces exists/visible/enabled/not-obstructed', () => {
  assert.equal(isActionableTarget({ exists: true, visible: true, enabled: true, obstructed: false }), true);
  assert.equal(isActionableTarget({ exists: true, visible: true, enabled: false }), false);
  assert.equal(isActionableTarget({ exists: true, visible: false, enabled: true }), false);
  assert.equal(isActionableTarget({ exists: true, visible: true, enabled: true, obstructed: true }), false);
});

test('interpretOutcome reports changed vs unchanged', () => {
  assert.equal(interpretOutcome({ visuallyChanged: true }).success, true);
  assert.equal(interpretOutcome({ visuallyChanged: false, domChanged: false }).success, false);
  assert.equal(interpretOutcome({ visuallyChanged: true, domChanged: true }).confidence, 1);
});