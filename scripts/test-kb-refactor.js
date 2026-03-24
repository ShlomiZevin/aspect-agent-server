/**
 * KB Refactor Smoke Test — Step 1
 * Read-only checks: verifies all services load and connect to providers.
 * No creates, no deletes, no writes.
 *
 * Run: node scripts/test-kb-refactor.js
 */

require('dotenv').config();

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  [PASS] ${label}`);
  passed++;
}

function fail(label, err) {
  console.log(`  [FAIL] ${label}`);
  console.log(`         ${err?.message || err}`);
  failed++;
}

async function section(title, fn) {
  console.log(`\n== ${title} ==`);
  try {
    await fn();
  } catch (err) {
    fail('section crashed', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('KB Refactor Smoke Test\n');

  // ── 1. Module loading ────────────────────────────────────────────────────
  await section('Module loading', async () => {
    try { require('../services/kb.openai.service'); ok('kb.openai.service loads'); }
    catch (e) { fail('kb.openai.service loads', e); }

    try { require('../services/kb.google.service'); ok('kb.google.service loads'); }
    catch (e) { fail('kb.google.service loads', e); }

    try { require('../services/kb.anthropic.service'); ok('kb.anthropic.service loads'); }
    catch (e) { fail('kb.anthropic.service loads', e); }

    try { require('../services/kb.service'); ok('kb.service loads'); }
    catch (e) { fail('kb.service loads', e); }

    try { require('../services/dynamic-kb.service'); ok('dynamic-kb.service loads'); }
    catch (e) { fail('dynamic-kb.service loads', e); }

    try { require('../services/llm'); ok('llm.js loads'); }
    catch (e) { fail('llm.js loads', e); }

    try { require('../services/llm.openai'); ok('llm.openai.js loads'); }
    catch (e) { fail('llm.openai.js loads', e); }
  });

  // ── 2. KB service has all expected methods ───────────────────────────────
  await section('kb.service — method presence', async () => {
    const kbService = require('../services/kb.service');
    const methods = [
      'createProviderStores',
      'uploadFile',
      'uploadFileToProviders',
      'deleteFileFromProviders',
      'deleteFileWithProviders',
      'deleteKnowledgeBaseWithProviders',
      'listProviderFiles',
      'syncToProvider',
      'detachProvider',
      'getProviderFileContent',
      'deleteProviderFile',
      'uploadFileToVectorStore',
      // existing DB methods
      'createKnowledgeBase',
      'getKnowledgeBaseById',
      'getFilesByKnowledgeBase',
      'addFile',
      'deleteFile',
      'updateFileProviderIds',
      'updateFileStats',
    ];
    for (const m of methods) {
      if (typeof kbService[m] === 'function') ok(`kbService.${m} exists`);
      else fail(`kbService.${m} exists`, 'method not found');
    }
  });

  // ── 3. kb.openai.service has all expected methods ────────────────────────
  await section('kb.openai.service — method presence', async () => {
    const kbOpenAI = require('../services/kb.openai.service');
    const methods = ['createStore', 'listStores', 'getStore', 'deleteStore', 'listFiles', 'deleteFile', 'uploadFile', 'getFileContent'];
    for (const m of methods) {
      if (typeof kbOpenAI[m] === 'function') ok(`kbOpenAI.${m} exists`);
      else fail(`kbOpenAI.${m} exists`, 'method not found');
    }
  });

  // ── 4. llm.openai.js has NO KB methods (they were removed) ──────────────
  await section('llm.openai.js — KB methods removed', async () => {
    const llmOpenAI = require('../services/llm.openai');
    const removed = ['createVectorStore', 'addFileToVectorStore', 'deleteVectorStoreFile', 'listVectorStoreFiles', 'addFileToKnowledgeBase'];
    for (const m of removed) {
      if (typeof llmOpenAI[m] === 'undefined') ok(`llmOpenAI.${m} removed`);
      else fail(`llmOpenAI.${m} removed`, 'method still exists!');
    }
  });

  // ── 5. llm.js has NO KB pass-throughs ───────────────────────────────────
  await section('llm.js — KB pass-throughs removed', async () => {
    const llm = require('../services/llm');
    const removed = ['createVectorStore', 'addFileToVectorStore', 'deleteVectorStoreFile', 'listVectorStoreFiles', 'addFileToKnowledgeBase'];
    for (const m of removed) {
      if (typeof llm[m] === 'undefined') ok(`llm.${m} removed`);
      else fail(`llm.${m} removed`, 'method still exists!');
    }
  });

  // ── 6. OpenAI API — list vector stores (real API call, read-only) ────────
  await section('OpenAI API — list stores (read-only)', async () => {
    const kbOpenAI = require('../services/kb.openai.service');
    try {
      const stores = await kbOpenAI.listStores();
      ok(`listStores() returned ${stores.length} stores`);
      if (stores.length > 0) {
        const first = stores[0];
        if (first.id && first.name !== undefined) ok('store shape: id + name present');
        else fail('store shape', 'missing id or name');
      }
    } catch (e) { fail('listStores()', e); }
  });

  // ── 7. Anthropic API — list files (read-only) ────────────────────────────
  await section('Anthropic API — list files (read-only)', async () => {
    const kbAnthropic = require('../services/kb.anthropic.service');
    try {
      const files = await kbAnthropic.listFiles();
      ok(`listFiles() returned ${files.length} files`);
    } catch (e) { fail('listFiles()', e); }
  });

  // ── 8. Google API — list stores (read-only) ──────────────────────────────
  await section('Google API — list stores (read-only)', async () => {
    const googleKB = require('../services/kb.google.service');
    try {
      const stores = await googleKB.listStores();
      ok(`listStores() returned ${stores.length} stores`);
    } catch (e) { fail('listStores()', e); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('All checks passed. Ready for Step 2.');
  else console.log('Fix the failures above before deploying.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
