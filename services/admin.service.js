const db = require('./db.pg');
const { users, conversations, messages } = require('../db/schema');
const { eq, and, or, like, desc, asc, sql, count } = require('drizzle-orm');

/**
 * Admin Service
 *
 * Manages users and provides admin functionality for the dashboard
 */
class AdminService {
  constructor() {
    this.drizzle = null;
  }

  /**
   * Initialize the service
   */
  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Get all users with filters and conversation counts
   * @param {Object} filters - Filter options
   * @param {string} filters.source - Filter by source (web/whatsapp)
   * @param {string} filters.tenant - Filter by tenant
   * @param {string} filters.subscription - Filter by subscription (demo/pro)
   * @param {string} filters.search - Search in phone, email, name, externalId
   * @param {number} filters.limit - Max results (default 100)
   * @param {number} filters.offset - Offset for pagination
   * @returns {Promise<Object>} - { users: Array, total: number }
   */
  async getUsers(filters = {}) {
    if (!this.drizzle) this.initialize();

    const { source, tenant, subscription, search, limit = 100, offset = 0 } = filters;

    // Build WHERE conditions
    const conditions = [];

    if (source) {
      conditions.push(eq(users.source, source));
    }

    if (tenant) {
      conditions.push(eq(users.tenant, tenant));
    }

    if (subscription) {
      conditions.push(eq(users.subscription, subscription));
    }

    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(
        or(
          like(users.phone, searchPattern),
          like(users.email, searchPattern),
          like(users.name, searchPattern),
          like(users.externalId, searchPattern)
        )
      );
    }

    // Get total count
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = await this.drizzle
      .select({ count: count() })
      .from(users)
      .where(whereClause);

    const total = totalResult[0]?.count || 0;

    // Get users with conversation counts
    const userList = await this.drizzle
      .select({
        id: users.id,
        externalId: users.externalId,
        email: users.email,
        name: users.name,
        phone: users.phone,
        role: users.role,
        source: users.source,
        subscription: users.subscription,
        tenant: users.tenant,
        whatsappConversationId: users.whatsappConversationId,
        lastActiveAt: users.lastActiveAt,
        metadata: users.metadata,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(whereClause)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    // Get conversation counts for each user
    const usersWithCounts = await Promise.all(
      userList.map(async (user) => {
        const convCountResult = await this.drizzle
          .select({ count: count() })
          .from(conversations)
          .where(
            and(
              eq(conversations.userId, user.id),
              eq(conversations.status, 'active')
            )
          );

        return {
          ...user,
          conversationCount: convCountResult[0]?.count || 0,
        };
      })
    );

    return { users: usersWithCounts, total };
  }

  /**
   * Get a single user by ID with full details
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>} - User object or null
   */
  async getUserById(userId) {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const user = result[0];

    // Get conversation count
    const convCountResult = await this.drizzle
      .select({ count: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, user.id),
          eq(conversations.status, 'active')
        )
      );

    // Get conversations list
    const userConversations = await this.drizzle
      .select({
        id: conversations.id,
        externalId: conversations.externalId,
        channel: conversations.channel,
        status: conversations.status,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.userId, user.id))
      .orderBy(desc(conversations.updatedAt));

    return {
      ...user,
      conversationCount: convCountResult[0]?.count || 0,
      conversations: userConversations,
    };
  }

  /**
   * Update a user's fields
   * @param {number} userId - User ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated user
   */
  async updateUser(userId, updates) {
    if (!this.drizzle) this.initialize();

    // Only allow updating specific fields
    const allowedFields = ['name', 'email', 'phone', 'role', 'subscription', 'tenant'];
    const sanitizedUpdates = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        sanitizedUpdates[field] = updates[field];
      }
    }

    if (Object.keys(sanitizedUpdates).length === 0) {
      throw new Error('No valid fields to update');
    }

    sanitizedUpdates.updatedAt = new Date();

    const [updated] = await this.drizzle
      .update(users)
      .set(sanitizedUpdates)
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      throw new Error(`User not found: ${userId}`);
    }

    console.log(`✅ Updated user ${userId}:`, Object.keys(sanitizedUpdates).join(', '));
    return updated;
  }

  /**
   * Create a new user manually (for pre-setup before WhatsApp conversation)
   * @param {Object} userData - User data
   * @param {string} userData.phone - Phone number (required)
   * @param {string} userData.tenant - Tenant/organization
   * @param {string} userData.subscription - Subscription level
   * @param {string} userData.role - User role
   * @param {string} userData.name - User name
   * @param {string} userData.email - User email
   * @returns {Promise<Object>} - Created user
   */
  async createUser(userData) {
    if (!this.drizzle) this.initialize();

    const { phone, tenant, subscription, role, name, email } = userData;

    if (!phone) {
      throw new Error('Phone number is required');
    }

    // Check if user with this phone already exists
    const existingByPhone = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.phone, phone))
      .limit(1);

    if (existingByPhone.length > 0) {
      throw new Error(`User with phone ${phone} already exists`);
    }

    // Check if WhatsApp user with this phone exists
    const waExternalId = `wa_${phone}`;
    const existingByExternalId = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, waExternalId))
      .limit(1);

    if (existingByExternalId.length > 0) {
      throw new Error(`WhatsApp user with phone ${phone} already exists`);
    }

    // Create user with generated externalId
    const externalId = `manual_${phone}_${Date.now()}`;

    const [newUser] = await this.drizzle
      .insert(users)
      .values({
        externalId,
        phone,
        name: name || null,
        email: email || null,
        role: role || 'user',
        source: 'web', // Manual creation is considered web source
        subscription: subscription || 'demo',
        tenant: tenant || null,
        metadata: { createdManually: true, createdAt: new Date().toISOString() },
      })
      .returning();

    console.log(`✅ Created manual user: ${newUser.id} (phone: ${phone})`);
    return newUser;
  }

  /**
   * Link a WhatsApp number to a web user
   * If a WhatsApp user already exists for that number, merge into single profile
   * @param {number} userId - Web user ID to link
   * @param {string} phone - WhatsApp phone number
   * @returns {Promise<Object>} - Updated user with WhatsApp linked
   */
  async linkWhatsApp(userId, phone) {
    if (!this.drizzle) this.initialize();

    // Get the user to link
    const user = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const targetUser = user[0];

    // Check if user already has WhatsApp linked
    if (targetUser.whatsappConversationId) {
      throw new Error('User already has WhatsApp linked');
    }

    // Check if a WhatsApp user with this phone exists
    const waExternalId = `wa_${phone}`;
    const existingWaUser = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, waExternalId))
      .limit(1);

    let whatsappConversationId = null;

    if (existingWaUser.length > 0) {
      // Merge: Transfer WhatsApp user's conversations to target user
      const waUser = existingWaUser[0];

      // Get WhatsApp user's conversations
      const waConversations = await this.drizzle
        .select()
        .from(conversations)
        .where(eq(conversations.userId, waUser.id));

      if (waConversations.length > 0) {
        // Transfer conversations to target user
        await this.drizzle
          .update(conversations)
          .set({ userId: targetUser.id, updatedAt: new Date() })
          .where(eq(conversations.userId, waUser.id));

        // Set the first WhatsApp conversation as the linked one
        const waConv = waConversations.find(c => c.channel === 'whatsapp') || waConversations[0];
        whatsappConversationId = waConv.id;
      }

      // Delete the old WhatsApp user (it's now merged)
      await this.drizzle
        .delete(users)
        .where(eq(users.id, waUser.id));

      console.log(`🔗 Merged WhatsApp user ${waUser.id} into user ${targetUser.id}`);
    }

    // Update target user with phone and WhatsApp conversation reference
    const [updated] = await this.drizzle
      .update(users)
      .set({
        phone,
        whatsappConversationId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetUser.id))
      .returning();

    console.log(`📱 Linked WhatsApp ${phone} to user ${targetUser.id}`);
    return updated;
  }

  /**
   * Unlink WhatsApp from a user
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Updated user
   */
  async unlinkWhatsApp(userId) {
    if (!this.drizzle) this.initialize();

    const [updated] = await this.drizzle
      .update(users)
      .set({
        phone: null,
        whatsappConversationId: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      throw new Error(`User not found: ${userId}`);
    }

    console.log(`📱 Unlinked WhatsApp from user ${userId}`);
    return updated;
  }

  /**
   * Get unique tenants for filter dropdown
   * @returns {Promise<string[]>} - List of unique tenants
   */
  async getTenants() {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .selectDistinct({ tenant: users.tenant })
      .from(users)
      .where(sql`${users.tenant} IS NOT NULL AND ${users.tenant} != ''`)
      .orderBy(asc(users.tenant));

    return result.map(r => r.tenant);
  }

  /**
   * Update user's last active timestamp
   * @param {number} userId - User ID
   * @returns {Promise<void>}
   */
  async updateLastActive(userId) {
    if (!this.drizzle) this.initialize();

    await this.drizzle
      .update(users)
      .set({ lastActiveAt: new Date() })
      .where(eq(users.id, userId));
  }

  /**
   * Get admin dashboard stats
   * @returns {Promise<Object>} - Stats object
   */
  async getStats() {
    if (!this.drizzle) this.initialize();

    const [totalUsers] = await this.drizzle.select({ count: count() }).from(users);

    const [webUsers] = await this.drizzle
      .select({ count: count() })
      .from(users)
      .where(eq(users.source, 'web'));

    const [whatsappUsers] = await this.drizzle
      .select({ count: count() })
      .from(users)
      .where(eq(users.source, 'whatsapp'));

    const [proUsers] = await this.drizzle
      .select({ count: count() })
      .from(users)
      .where(eq(users.subscription, 'pro'));

    const [totalConversations] = await this.drizzle
      .select({ count: count() })
      .from(conversations)
      .where(eq(conversations.status, 'active'));

    return {
      totalUsers: totalUsers?.count || 0,
      webUsers: webUsers?.count || 0,
      whatsappUsers: whatsappUsers?.count || 0,
      proUsers: proUsers?.count || 0,
      totalConversations: totalConversations?.count || 0,
    };
  }
}

// Export singleton instance
module.exports = new AdminService();
