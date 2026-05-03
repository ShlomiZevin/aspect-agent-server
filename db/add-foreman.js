/**
 * One-shot script: insert the Foreman agent row into the agents table.
 *
 * Safe to run multiple times — checks for an existing row first and exits
 * cleanly if it already exists. Touches NO other agents.
 *
 * Usage:
 *   cd aspect-agent-server && node db/add-foreman.js
 */
require('dotenv').config();
const db = require('../services/db.pg');
const { agents } = require('./schema');
const { eq } = require('drizzle-orm');

async function addForeman() {
  console.log('🏗️  Adding Foreman agent...');

  await db.initialize();
  const drizzle = db.getDrizzle();

  const existing = await drizzle.select().from(agents).where(eq(agents.name, 'Foreman'));
  if (existing.length > 0) {
    console.log(`✅ Foreman already exists (ID: ${existing[0].id}). Nothing to do.`);
    process.exit(0);
  }

  const foremanAgent = {
    name: 'Foreman',
    domain: 'construction-erp',
    urlSlug: 'foreman',
    description: 'AI ERP & Master Data assistant for Israeli infrastructure contractors. Parses supplier price quotes, matches supplier SKUs to the master catalog, prices Bills of Quantities (BOQ), and handles general procurement / construction-finance Q&A.',
    promptId: null,
    config: {
      model: process.env.OPENAI_MODEL || 'gpt-5-chat-latest',
      vectorStoreId: null,
      features: ['quote_parsing', 'sku_matching', 'boq_pricing', 'master_data', 'subcontractor_qa'],
      supportedLanguages: ['he', 'en']
    },
    isActive: true
  };

  const [inserted] = await drizzle.insert(agents).values(foremanAgent).returning();
  console.log(`✅ Foreman created successfully (ID: ${inserted.id}).`);
  process.exit(0);
}

addForeman().catch(err => {
  console.error('❌ Failed:', err.message);
  console.error(err);
  process.exit(1);
});
