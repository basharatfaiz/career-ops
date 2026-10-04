// tests/gmail-sync.test.mjs — the Gmail label tracker → reply-watch bridge.
//
// Pins the three rules that keep a Gmail sync from corrupting the tracker:
// the noisy Jobs/Interview label is never trusted as an interview, a proposal
// never moves a row backwards or out of a terminal state, and only rows that
// already exist in the tracker are ever proposed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCandidates, signalFor, proposeChange, review } from '../gmail-sync.mjs';

const app = (num, company, role, status = 'Applied') => ({ num, company, role, status });

test('Jobs/Interview alone never becomes an interview signal', () => {
  assert.equal(signalFor(['Jobs/Interview'], 'Just in at Example Co: employee reviews'), null);
});

test('Jobs/Rejected and unambiguous wording become a rejection signal', () => {
  assert.equal(signalFor(['Jobs/Rejected'], 'Thank you again'), 'rejection');
  assert.equal(signalFor([], 'We regret to inform you that we have decided to proceed with another candidate'), 'rejection');
  assert.equal(signalFor(['Jobs/Offered'], 'Your offer letter'), 'offer');
});

test('raw connector threads are normalised, with label ids read as names', () => {
  const [c] = toCandidates({ threads: [{ messages: [{
    id: 'abc', threadId: 't1', date: '2026-09-26T22:15:23Z', sender: 'acme@myworkday.com',
    subject: 'Thank you again', snippet: 'We&#39;d like to thank you', labelIds: ['UNREAD', 'Label_TEST_REJECTED'],
  }] }] }, { Label_TEST_REJECTED: 'Jobs/Rejected' });
  assert.equal(c.message_id, 'gmail:abc');
  assert.equal(c.body_snippet, "We'd like to thank you");
  assert.deepEqual(c.gmail_labels, ['Jobs/Rejected']);
  assert.equal(c.signal, 'rejection');
});

test('proposals only move forward and never leave a terminal state', () => {
  assert.equal(proposeChange('Applied', 'Rejected'), true);
  assert.equal(proposeChange('Applied', 'Interview'), true);
  assert.equal(proposeChange('Interview', 'Responded'), false);
  assert.equal(proposeChange('Rejected', 'Interview'), false);
  assert.equal(proposeChange('Applied', 'Needs Review'), false);
  assert.equal(proposeChange('Applied', 'Applied'), false);
});

test('a rejection for a tracked row is proposed; confirmations and untracked jobs are not', () => {
  const apps = [app(10, 'Acme', 'Senior Designer'), app(1, 'Globex', 'Senior Product Designer')];
  const candidates = toCandidates([
    { id: 'r', date: '2026-09-26T22:15:23Z', sender: 'acme@myworkday.com', subject: 'Thank you again for your application',
      snippet: 'your application for R000001 - Senior Designer. We regret to inform you', labels: ['Jobs/Rejected'] },
    { id: 'c', date: '2026-09-26T11:32:24Z', sender: 'no-reply@ashbyhq.com', subject: 'Thank you for applying to Globex!',
      snippet: 'Thank you for applying to the Senior Product Designer role at Globex.', labels: ['Jobs/Applied'] },
    { id: 'u', date: '2026-10-01T07:00:00Z', sender: 'no-reply@Initech.com', subject: 'Thank you for applying to Initech',
      snippet: 'Unfortunately we will not be moving forward', labels: ['Jobs/Rejected'] },
  ]);
  const { proposals } = review(candidates, apps);
  assert.equal(proposals.length, 1);
  assert.deepEqual([proposals[0].row, proposals[0].from, proposals[0].to], [10, 'Applied', 'Rejected']);
});
