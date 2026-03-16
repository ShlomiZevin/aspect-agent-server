/**
 * Read playground configs from Google Cloud Storage.
 *
 * Usage:
 *   node scripts/read-playground-config.js                          # list all agents
 *   node scripts/read-playground-config.js "Banking Onboarder V2"   # list configs for agent
 *   node scripts/read-playground-config.js "Banking Onboarder V2" 1710523456789  # read specific config
 *
 * Output: Playground saved configs with crew source code.
 */
require('dotenv').config();

const playgroundService = require('../services/playground.service');
const storageService = require('../services/storage.service');

async function main() {
  const agentName = process.argv[2];
  const configId = process.argv[3];

  if (!agentName) {
    // List all agents that have playground configs
    console.log('Listing all agents with playground configs...\n');
    const [files] = await storageService.getBucket().getFiles({ prefix: 'playground-configs/' });
    const agents = new Set();
    for (const f of files) {
      const parts = f.name.replace('playground-configs/', '').split('/');
      if (parts.length >= 2) agents.add(parts[0]);
    }
    if (agents.size === 0) {
      console.log('No playground configs found.');
    } else {
      for (const a of agents) {
        console.log(`  - ${a}`);
      }
      console.log(`\nUsage: node scripts/read-playground-config.js "<agent name>"`);
    }
    return;
  }

  if (!configId) {
    // List configs for this agent
    console.log(`Listing playground configs for "${agentName}"...\n`);
    const configs = await playgroundService.listSavedConfigs(agentName);
    if (configs.length === 0) {
      console.log('No saved configs found.');
    } else {
      for (const c of configs) {
        console.log(`  ID: ${c.id} | Name: ${c.name} | Saved: ${c.savedAt}`);
      }
      console.log(`\nUsage: node scripts/read-playground-config.js "${agentName}" <id>`);
    }
    return;
  }

  // Read specific config
  console.log(`Reading config ${configId} for "${agentName}"...\n`);
  const data = await playgroundService.loadConfig(agentName, configId);

  console.log(`${'='.repeat(60)}`);
  console.log(`Name: ${data.name}`);
  console.log(`Saved: ${data.savedAt}`);
  console.log(`${'='.repeat(60)}`);

  const config = data.config || {};
  console.log(`\nCrew Name: ${config.crewName || '(not set)'}`);
  console.log(`Display Name: ${config.displayName || '(not set)'}`);
  console.log(`Model: ${config.model || '(default)'}`);
  console.log(`Thinker: ${config.usesThinker ? `yes (${config.thinkingModel || 'default'})` : 'no'}`);

  if (config.guidance) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('GUIDANCE:');
    console.log(`${'─'.repeat(60)}`);
    console.log(config.guidance);
  }

  if (config.thinkingPrompt) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('THINKING PROMPT:');
    console.log(`${'─'.repeat(60)}`);
    console.log(config.thinkingPrompt);
  }

  if (config.persona) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('PERSONA:');
    console.log(`${'─'.repeat(60)}`);
    console.log(config.persona);
  }

  if (config.fieldsToCollect && config.fieldsToCollect.length > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('FIELDS:');
    console.log(`${'─'.repeat(60)}`);
    for (const f of config.fieldsToCollect) {
      console.log(`  - ${f.name}: ${f.description || '(no description)'}`);
    }
  }

  if (config.tools && config.tools.length > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('TOOLS:');
    console.log(`${'─'.repeat(60)}`);
    for (const t of config.tools) {
      console.log(`  - ${t.name}: ${t.description || '(no description)'}`);
    }
  }

  if (config.kbSources && config.kbSources.length > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('KB SOURCES:');
    console.log(`${'─'.repeat(60)}`);
    for (const kb of config.kbSources) {
      console.log(`  - ${kb}`);
    }
  }

  // Also output the exported crew file
  try {
    const exported = playgroundService.exportToCrewFile(config);
    console.log(`\n${'─'.repeat(60)}`);
    console.log('EXPORTED CREW FILE:');
    console.log(`${'─'.repeat(60)}`);
    console.log(exported);
  } catch (err) {
    // Export may fail for incomplete configs
  }

  console.log(`\n${'='.repeat(60)}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
