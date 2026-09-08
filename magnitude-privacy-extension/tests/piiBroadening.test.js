// tests/piiBroadening.test.js
//
// Verifies that the protection layer is broad (not PAN-only): identity/financial/
// medical/legal/private documents, PII spans (names, addresses, IFSC, PIN),
// and correct whole-region redaction labels.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSensitiveText, classifyDomField } from '../shared/detectors.js';
import {
  detectSensitiveDocument,
  detectDocumentFromText,
  detectDocumentFileName,
  redactionLabelFor
} from '../shared/documentDetector.js';

// --- PII text broadening --------------------------------------------

test('detects IFSC code as high-signal', () => {
  const f = detectSensitiveText('IFSC: SBIN0001234');
  assert.ok(f.some(x => x.category === 'ifsc' && x.confidence >= 0.8));
});

test('detects labelled name', () => {
  const f = detectSensitiveText('Name: Vishal Agrawal');
  assert.ok(f.some(x => x.category === 'name'));
});

test('detects labelled address', () => {
  const f = detectSensitiveText('Address: 12 MG Road, Bengaluru 560001');
  assert.ok(f.some(x => x.category === 'address'));
});

test('detects PIN code with context', () => {
  const f = detectSensitiveText('PIN Code: 560001');
  assert.ok(f.some(x => x.category === 'pincode' && x.confidence >= 0.9));
});

test('account number with context is high-signal', () => {
  const f = detectSensitiveText('Account Number: 12345678901234');
  assert.ok(f.some(x => x.category === 'bankAccount' && x.confidence >= 0.9));
});

test('classifyDomField flags name/address/IFSC field hints', () => {
  assert.equal(classifyDomField({ name: 'fullname' }).sensitive, true);
  assert.equal(classifyDomField({ name: 'address' }).sensitive, true);
  assert.equal(classifyDomField({ name: 'ifsc' }).sensitive, true);
  assert.equal(classifyDomField({ autocomplete: 'street-address' }).sensitive, true);
});

// --- Document broadening (beyond PAN) --------------------------------

test('detects Aadhaar document', () => {
  assert.equal(detectDocumentFromText('Unique Identification Authority of India, AADHAAR').category, 'aadhaar');
});

test('detects passport document', () => {
  assert.equal(detectDocumentFromText('Passport — machine readable zone').category, 'passport');
});

test('detects voter ID document', () => {
  assert.equal(detectDocumentFromText('Election Commission — EPIC No').category, 'voter_id');
});

test('detects employee ID document', () => {
  assert.equal(detectDocumentFromText('Employee ID / Badge').category, 'employee_id');
});

test('detects college/student ID document', () => {
  assert.equal(detectDocumentFromText('University ID, Roll No').category, 'college_id');
});

test('detects bank statement document', () => {
  assert.equal(detectDocumentFromText('Bank Statement, IFSC, Account Number').category, 'bank');
});

test('detects cheque document', () => {
  assert.equal(detectDocumentFromText('Cheque — Pay to the order of').category, 'cheque');
});

test('detects tax document', () => {
  assert.equal(detectDocumentFromText('Form 16, Income Tax Return').category, 'tax_document');
});

test('detects salary slip', () => {
  assert.equal(detectDocumentFromText('Salary slip — basic salary, gross pay').category, 'salary');
});

test('detects medical report', () => {
  assert.equal(detectDocumentFromText('Medical report — patient, diagnosis').category, 'medical');
});

test('detects legal document', () => {
  assert.equal(detectDocumentFromText('Legal document — affidavit, notary').category, 'legal');
});

test('detects confidential/private content', () => {
  assert.equal(detectDocumentFromText('Confidential — internal use only').category, 'confidential');
});

test('detects sensitive file names for many document types', () => {
  assert.equal(detectDocumentFileName('voter-id.jpg').category, 'voter_id');
  assert.equal(detectDocumentFileName('salary-slip.pdf').category, 'salary');
  assert.equal(detectDocumentFileName('cheque-scan.png').category, 'cheque');
  assert.equal(detectDocumentFileName('confidential-report.docx').category, 'confidential');
});

test('whole-region redaction for any detected document type', () => {
  const res = detectSensitiveDocument({ ocrText: 'Salary slip — net pay', fileName: 'payslip.pdf' });
  assert.equal(res.decision, 'redact');
  assert.equal(res.redact, 'whole_region');
});

test('redaction labels map categories to neutral placeholders', () => {
  assert.equal(redactionLabelFor('pan'), '[IDENTITY DOCUMENT REDACTED]');
  assert.equal(redactionLabelFor('bank'), '[FINANCIAL DOCUMENT REDACTED]');
  assert.equal(redactionLabelFor('medical'), '[MEDICAL DOCUMENT REDACTED]');
  assert.equal(redactionLabelFor('legal'), '[LEGAL DOCUMENT REDACTED]');
  assert.equal(redactionLabelFor('confidential'), '[PRIVATE CONTENT REDACTED]');
});