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
      promptId: 'pmpt_695cc633a8248193bfd1601116118463064124325ea89640',
      config: {
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

    // Create Aspect agent
    console.log('Creating Aspect agent...');

    const aspectAgent = {
      name: 'Aspect',
      domain: 'finance',
      description: 'AI-powered business intelligence assistant providing insights on sales, inventory, customer analytics, and financial metrics.',
      promptId: 'pmpt_6968b04b9d8c819695d296bc9593c145031da9cca78b9b13',
      config: {
        model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
        vectorStoreId: null, // No KB by default
        features: ['sales_analytics', 'inventory_management', 'customer_insights', 'business_intelligence'],
        supportedLanguages: ['en', 'he']
      },
      isActive: true
    };

    // Check if Aspect already exists
    const existingAspect = await drizzle.select().from(agents).where(eq(agents.name, 'Aspect'));

    if (existingAspect.length > 0) {
      console.log('✅ Aspect already exists (ID:', existingAspect[0].id, ')');
    } else {
      const [inserted] = await drizzle.insert(agents).values(aspectAgent).returning();
      console.log('✅ Aspect created successfully (ID:', inserted.id, ')');
    }

    // Create Byline Bank RDDA agent
    console.log('Creating Byline agent...');

    const bylineAgent = {
      name: 'Byline',
      domain: 'banking',
      description: 'AI-powered Risk Due Diligence Assessment (RDDA) agent for Byline Bank, guiding Third Party Payment Processors through comprehensive compliance assessment.',
      promptId: null,
      config: {
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        vectorStoreId: null,
        features: ['rdda_assessment', 'compliance', 'document_collection', 'full_journey_view'],
        supportedLanguages: ['en']
      },
      isActive: true
    };

    // Check if Byline already exists
    const existingByline = await drizzle.select().from(agents).where(eq(agents.name, 'Byline'));

    if (existingByline.length > 0) {
      console.log('✅ Byline already exists (ID:', existingByline[0].id, ')');
    } else {
      const [inserted] = await drizzle.insert(agents).values(bylineAgent).returning();
      console.log('✅ Byline created successfully (ID:', inserted.id, ')');
    }

    // Create Banking Onboarder agent
    console.log('Creating Banking Onboarder agent...');

    const bankingOnboarderAgent = {
      name: 'Banking Onboarder',
      domain: 'banking',
      urlSlug: 'banking',
      description: 'AI-powered banking onboarding assistant that guides new customers through the complete account opening process with personalized support and compliance checks.',
      promptId: null,
      config: {
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        vectorStoreId: null,
        features: ['customer_onboarding', 'kyc_verification', 'account_setup', 'compliance'],
        supportedLanguages: ['en']
      },
      isActive: true
    };

    // Check if Banking Onboarder already exists
    const existingOnboarder = await drizzle.select().from(agents).where(eq(agents.name, 'Banking Onboarder'));

    if (existingOnboarder.length > 0) {
      console.log('✅ Banking Onboarder already exists (ID:', existingOnboarder[0].id, ')');
    } else {
      const [inserted] = await drizzle.insert(agents).values(bankingOnboarderAgent).returning();
      console.log('✅ Banking Onboarder created successfully (ID:', inserted.id, ')');
    }

    // Create Banking Onboarder V2 agent (Thinking Model)
    console.log('Creating Banking Onboarder V2 agent...');

    const bankingOnboarderV2Agent = {
      name: 'Banking Onboarder V2',
      domain: 'banking',
      urlSlug: 'banking-v2',
      description: 'Banking onboarder with thinker+talker architecture. 3 crews: welcome, main conversation (Claude thinks, GPT-5 talks), review & finalize.',
      promptId: null,
      config: {
        model: process.env.OPENAI_MODEL || 'gpt-5-chat-latest',
        vectorStoreId: null,
        features: ['customer_onboarding', 'thinking_model', 'account_setup'],
        supportedLanguages: ['he']
      },
      isActive: true
    };

    const existingV2 = await drizzle.select().from(agents).where(eq(agents.name, 'Banking Onboarder V2'));

    if (existingV2.length > 0) {
      console.log('✅ Banking Onboarder V2 already exists (ID:', existingV2[0].id, ')');
    } else {
      const [insertedV2] = await drizzle.insert(agents).values(bankingOnboarderV2Agent).returning();
      console.log('✅ Banking Onboarder V2 created successfully (ID:', insertedV2.id, ')');
    }

    // Create TikTok Comedy agent
    console.log('Creating TikTok Comedy agent...');

    const tiktokAgent = {
      name: 'TikTok Comedy',
      domain: 'content-creation',
      urlSlug: 'tiktok',
      description: 'Comedy brainstorming partner for TikTok content - parody, satire, caricature, and real-life comedy situations. Hebrew-first.',
      promptId: null,
      config: {
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        vectorStoreId: null,
        features: ['comedy_brainstorming', 'script_writing', 'character_development'],
        supportedLanguages: ['he']
      },
      isActive: true
    };

    const existingTiktok = await drizzle.select().from(agents).where(eq(agents.name, 'TikTok Comedy'));

    if (existingTiktok.length > 0) {
      console.log('✅ TikTok Comedy already exists (ID:', existingTiktok[0].id, ')');
    } else {
      const [insertedTiktok] = await drizzle.insert(agents).values(tiktokAgent).returning();
      console.log('✅ TikTok Comedy created successfully (ID:', insertedTiktok.id, ')');
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
