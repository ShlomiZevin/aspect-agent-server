const db = require('./db.pg');
const { demoMockups } = require('../db/schema');
const { eq, desc } = require('drizzle-orm');
const { v4: uuidv4 } = require('uuid');

/**
 * Demo Mockup Service
 *
 * Manages demo chat mockups for customer demonstrations
 */
class DemoService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * List all mockups
   */
  async listMockups() {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(demoMockups)
      .orderBy(desc(demoMockups.updatedAt));

    return result;
  }

  /**
   * Get a mockup by publicId
   */
  async getMockup(publicId) {
    if (!this.drizzle) this.initialize();

    const [mockup] = await this.drizzle
      .select()
      .from(demoMockups)
      .where(eq(demoMockups.publicId, publicId))
      .limit(1);

    return mockup || null;
  }

  /**
   * Create a new mockup
   */
  async createMockup(data = {}) {
    if (!this.drizzle) this.initialize();

    const publicId = uuidv4();

    const defaultConfig = {
      agentName: 'Assistant',
      agentLogoUrl: '',
      senderName: 'User',
      colorScheme: 'blue',
      language: 'en',
    };

    const [mockup] = await this.drizzle
      .insert(demoMockups)
      .values({
        publicId,
        title: data.title || 'Untitled Mockup',
        viewMode: data.viewMode || 'regular',
        config: { ...defaultConfig, ...data.config },
        messages: data.messages || [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return mockup;
  }

  /**
   * Update a mockup
   */
  async updateMockup(publicId, updates) {
    if (!this.drizzle) this.initialize();

    const updateData = {
      updatedAt: new Date(),
    };

    if (updates.title !== undefined) updateData.title = updates.title;
    if (updates.viewMode !== undefined) updateData.viewMode = updates.viewMode;
    if (updates.config !== undefined) {
      // Merge config instead of replacing
      const existing = await this.getMockup(publicId);
      if (existing) {
        updateData.config = { ...existing.config, ...updates.config };
      } else {
        updateData.config = updates.config;
      }
    }
    if (updates.messages !== undefined) updateData.messages = updates.messages;

    const [mockup] = await this.drizzle
      .update(demoMockups)
      .set(updateData)
      .where(eq(demoMockups.publicId, publicId))
      .returning();

    return mockup || null;
  }

  /**
   * Delete a mockup
   */
  async deleteMockup(publicId) {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .delete(demoMockups)
      .where(eq(demoMockups.publicId, publicId))
      .returning({ id: demoMockups.id });

    return result.length > 0;
  }
}

module.exports = new DemoService();
