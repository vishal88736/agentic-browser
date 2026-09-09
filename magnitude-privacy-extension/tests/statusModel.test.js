// tests/statusModel.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStatus, computePipelineSteps, sanitizeActivityLog,
  buildDemoData, runDemoAnalysis, STATUS_LEVELS
} from '../shared/statusModel.js';

test('protected state when model ready and remote allowed', () => {
  const s = computeStatus({ model: { state: 'ready' }, remote: { allowed: true } });
  assert.equal(s.level, STATUS_LEVELS.PROTECTED);
  assert.equal(s.title, 'Protected locally');
});

test('processing state while agent is running', () => {
  const s = computeStatus({ agentRunning: true, model: { state: 'ready' } });
  assert.equal(s.level, STATUS_LEVELS.PROCESSING);
});

test('blocked state when a blockedReason is present', () => {
  const s = computeStatus({ blockedReason: 'Potential leak blocked' });
  assert.equal(s.level, STATUS_LEVELS.BLOCKED);
  assert.equal(s.title, 'Request blocked');
});

test('model unavailable state', () => {
  const s = computeStatus({ model: { state: 'unavailable' } });
  assert.equal(s.level, STATUS_LEVELS.MODEL_UNAVAILABLE);
  assert.equal(s.title, 'Local model unavailable');
});

test('attention state when OCR unavailable', () => {
  const s = computeStatus({ model: { state: 'not_configured' }, ocr: { available: false } });
  assert.equal(s.level, STATUS_LEVELS.ATTENTION);
});

test('pipeline steps block scan+send on leak', () => {
  const steps = computePipelineSteps({ model: { state: 'ready' }, blockedReason: 'leak', leakScanOk: false });
  const scan = steps.find(s => s.id === 'scan');
  const send = steps.find(s => s.id === 'send');
  assert.equal(scan.state, 'blocked');
  assert.equal(send.state, 'blocked');
});

test('pipeline marks detect unavailable with no model and no ocr', () => {
  const steps = computePipelineSteps({ model: { state: 'unavailable' }, ocr: { available: false } });
  assert.equal(steps.find(s => s.id === 'detect').state, 'unavailable');
});

test('sanitizeActivityLog strips raw values and emits friendly labels', () => {
  const entries = [
    { t: 1, event: 'privacy_gate', ocrText: 'PAN ABCDE1234F' },
    { t: 2, event: 'action_executed', content: 'MyPassword123', variant: 'local:fill_credential' },
    { t: 3, event: 'privacy_state', value: 'SecretToken', secret: 'x' }
  ];
  const items = sanitizeActivityLog(entries);
  const wire = JSON.stringify(items);
  assert.ok(!wire.includes('ABCDE1234F'));
  assert.ok(!wire.includes('MyPassword123'));
  assert.ok(!wire.includes('SecretToken'));
  assert.equal(items[0].label, 'Privacy scan completed');
  assert.equal(items[1].label, 'Action executed locally');
  assert.equal(items[1].meta.content, '[redacted]');
});

test('buildDemoData contains only synthetic values', () => {
  const d = buildDemoData();
  assert.ok(d.document.lines.some(l => l.label === 'PAN'));
  assert.ok(Array.isArray(d.fields));
  assert.ok(Array.isArray(d.neutral));
});

test('runDemoAnalysis detects the synthetic document and redacts values', () => {
  const r = runDemoAnalysis();
  assert.equal(r.document.detected, true);
  assert.equal(r.fields.sensitiveCount >= 1, true);
  const wire = JSON.stringify(r);
  assert.ok(!wire.includes('ABCDE1234F'), 'raw synthetic PAN must not leak into analysis output');
  assert.ok(!wire.includes('demo@example.in'), 'raw synthetic email must not leak');
  assert.ok(!wire.includes('DemoPass!23'), 'raw synthetic password must not leak');
});