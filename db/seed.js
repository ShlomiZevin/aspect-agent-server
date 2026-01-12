require('dotenv').config();
const db = require('../services/db.pg');
const { agents } = require('./schema');
const { eq } = require('drizzle-orm');

/**
 * Seed script to create initial agents in the database
 */

async function seed() {
  try {
    console.log('🌱 Starting database seed...');

    await db.initialize();
    const drizzle = db.getDrizzle();

    // Create Freeda 2.0 agent
    console.log('Creating Freeda 2.0 agent...');

    const freedaAgent = {
      name: 'Freeda 2.0',
      domain: 'menopause',
      description: 'AI-powered menopause support agent providing personalized guidance, symptom tracking, and evidence-based information for women navigating menopause.',
      config: {
        promptId: process.env.OPENAI_PROMPT_ID,
        model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
        vectorStoreId: 'vs_695e750fc75481918e3d76851ce30cae',
        features: ['symptom_tracking', 'personalized_advice', 'knowledge_base'],
        supportedLanguages: ['en']
      },
      isActive: true
    };

    // Check if Freeda already exists
    const existing = await drizzle.select().from(agents).where(eq(agents.name, 'Freeda 2.0'));

    if (existing.length > 0) {
      console.log('✅ Freeda 2.0 already exists (ID:', existing[0].id, ')');
    } else {
      const [inserted] = await drizzle.insert(agents).values(freedaAgent).returning();
      console.log('✅ Freeda 2.0 created successfully (ID:', inserted.id, ')');
    }

    console.log('');
    console.log('🎉 Seed completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Seed failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

seed();
