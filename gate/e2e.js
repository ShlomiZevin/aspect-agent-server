#!/usr/bin/env node
/**
 * Lybi Gate — the end-to-end proof, over HTTP against a running harness
 * (gate/harness.js). Prints what happened and checks the rules; never prints
 * a key or a secret (key prefixes only).
 *
 *   node gate/e2e.js [--base http://127.0.0.1:3917/api/gate]
 *
 * Steps: connect the mock bank → learn fields from sample records → sign the
 * policy → create an inbound key → POST /v1/records with it (and once with a
 * bad key) → read the stored record → call the bank (lookup) → hand off →
 * read the log → revoke the key.
 */

const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:3917/api/gate';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failures++; };

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

(async () => {
  console.log(`Lybi Gate end-to-end — ${BASE}\n`);

  console.log('1. Connect the mock bank');
  const setup = await api('POST', '/setup/mock-bank');
  check(setup.status === 200, `bank key registered (${setup.json && setup.json.bankKey && setup.json.bankKey.fingerprint}) + ${setup.json && setup.json.connections && setup.json.connections.length} connections`);
  const lookup = setup.json.connections.find(c => c.kind === 'lookup');
  const handoff = setup.json.connections.find(c => c.kind === 'handoff');
  const t = await api('POST', `/connections/${lookup.id}/test`);
  check(t.json && t.json.ok, `lookup connection reachable (${t.json && t.json.httpStatus}, ${t.json && t.json.ms} ms)`);

  console.log('\n2. Learn the fields and sign the policy');
  const sample = (await api('GET', '/sample')).json.records;
  const learned = await api('POST', '/policy/learn', { records: sample });
  const fields = learned.json.draft.fields;
  console.log(`   draft v${learned.json.draft.version}: ${fields.map(f => `${f.field}=${f.action}(${f.by})`).join(', ')}`);
  const refused = await api('POST', '/policy/sign');
  check(refused.status === 409 && refused.json.code === 'undecided_fields', `signing waits while ${refused.json && refused.json.fields && refused.json.fields.length} new fields are undecided`);
  const signed = await api('POST', '/policy/sign', { acceptNew: true });
  check(signed.status === 200, `signed v${signed.json && signed.json.signed && signed.json.signed.version} by ${signed.json && signed.json.signed && signed.json.signed.signedBy}`);
  const versions = (await api('GET', '/policy/versions')).json.versions;
  check(versions[0].valid === true, `signature verifies (v${versions[0].version})`);

  console.log('\n3. Inbound API with a real key');
  const created = await api('POST', '/keys', { name: 'e2e proof' });
  const key = created.json.key;
  check(created.status === 201 && /^gk_live_/.test(key.key), `key created: ${key.prefix} (shown once, not printed)`);
  const bad = await api('POST', '/v1/records', { records: [sample[0]] }, { authorization: 'Bearer gk_live_not-a-real-key-000000000000' });
  check(bad.status === 401, `bad key refused (${bad.status} ${bad.json && bad.json.code})`);
  const newField = `e2eNote${Date.now()}`; // new on every run, so the check holds on a used database too
  const incoming = { ...sample[0], leadId: 'EW-E2E-1', [newField]: 'שדה שהמדיניות לא מכירה' };
  const inb = await api('POST', '/v1/records', { records: [incoming] }, { authorization: `Bearer ${key.key}` });
  check(inb.status === 201, `201 — ${inb.json && inb.json.records.length} record, policy v${inb.json && inb.json.policyVersion}`);
  const recId = inb.json.records[0].id;
  console.log(`   actions: ${Object.entries(inb.json.records[0].actions).map(([k, a]) => `${k}=${a}`).join(', ')}`);
  check(inb.json.records[0].actions[newField] === 'hide', `an unknown field (${newField}) is hidden`);
  check((inb.json.newFields || []).includes(newField), 'and added to the draft for the bank to decide');

  console.log('\n4. What was stored');
  const rec = (await api('GET', `/records/${recId}`)).json.record;
  const storedText = JSON.stringify(rec.data);
  for (const f of ['passportNumber', 'patientId', 'iban', 'existingCard', 'email', 'phone']) {
    check(!storedText.includes(String(incoming[f])), `raw ${f} is not stored (${rec.data[f].a})`);
  }
  check(rec.modelView.passportNumber && rec.modelView.passportNumber.startsWith('TKN-PASS-'), `the model gets the passport as ${rec.modelView.passportNumber}`);
  check(!('iban' in rec.modelView) && !('existingCard' in rec.modelView), 'IBAN and card never reach the model');
  console.log(`   model view: ${JSON.stringify(rec.modelView)}`);

  console.log('\n5. Outbound: Lybi asks the bank mid-conversation');
  const call = await api('POST', `/connections/${lookup.id}/call`, { recordId: recId });
  check(call.json && call.json.ok, `bank answered ${call.json && call.json.httpStatus} in ${call.json && call.json.ms} ms`);
  console.log(`   sent: ${JSON.stringify(call.json.sent)} (passport went as token + sealed value)`);
  check(!JSON.stringify(call.json.request).includes(String(incoming.passportNumber)), 'the raw passport never left Lybi');
  if (call.json.answer.newFields.length) {
    check(Object.keys(call.json.answer.modelView).every(f => !call.json.answer.newFields.includes(f)),
      `first answer: its ${call.json.answer.newFields.length} fields are new to the signed policy → hidden until the bank signs`);
  } else {
    console.log('   (the answer\'s fields were signed in an earlier run)');
  }
  const v2 = await api('POST', '/policy/sign', { acceptNew: true });
  check(v2.status === 200, `the bank signs v${v2.json && v2.json.signed && v2.json.signed.version} (with Lybi's suggestions for the new fields)`);
  const call2 = await api('POST', `/connections/${lookup.id}/call`, { recordId: recId });
  check(call2.json && call2.json.ok, `asked again: ${call2.json && call2.json.httpStatus} in ${call2.json && call2.json.ms} ms`);
  console.log(`   bank answer after the gate → model: ${JSON.stringify(call2.json.answer.modelView)}`);
  check(!('riskScore' in call2.json.answer.modelView), 'the bank\'s internal risk score is hidden from the model');
  check(/TKN-ID-/.test(call2.json.answer.modelView.internalNotes || ''), 'an ID inside the bank\'s notes was replaced by its token');

  console.log('\n6. Handoff to the bank');
  const ho = await api('POST', `/connections/${handoff.id}/call`, { recordId: recId });
  check(ho.json && ho.json.ok, `bank confirmed ${ho.json && ho.json.answer && ho.json.answer.reference}: ${ho.json && ho.json.answer && ho.json.answer.opened.filter(o => o.ok).length}/${ho.json && ho.json.answer && ho.json.answer.received} fields opened with the bank's own key`);

  console.log('\n7. The log');
  const lg = (await api('GET', '/log?limit=12')).json.log;
  for (const l of lg.slice().reverse()) console.log(`   ${new Date(l.at).toISOString().slice(11, 19)}  ${l.direction.padEnd(5)} ${l.kind.padEnd(18)} ${l.status.padEnd(8)} ${l.httpStatus || ''}`);
  check(!JSON.stringify(lg).includes(String(incoming.passportNumber)), 'no value in the log');

  console.log('\n8. Clean up');
  const rv = await api('DELETE', `/keys/${key.id}`);
  check(rv.status === 200, `key ${key.prefix} revoked`);
  const after = await api('POST', '/v1/records', { records: [incoming] }, { authorization: `Bearer ${key.key}` });
  check(after.status === 401, 'a revoked key is refused');

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error('❌', err); process.exit(1); });
