const db = require('./db.pg');
const { messages, messageFeedback, feedbackTags, agents, conversations } = require('../db/schema');
const { eq, and, desc, sql, ilike, lt } = require('drizzle-orm');

/**
 * Feedback Service
 *
 * Manages feedback/comments on assistant messages and tag registry
 */
class FeedbackService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  // ─── Tag Registry ───────────────────────────────────────────────────

  /**
   * Get all tags for an agent (for autocomplete)
   */
  async getTagsForAgent(agentId) {
    if (!this.drizzle) this.initialize();

    const tags = await this.drizzle
      .select({
        name: feedbackTags.name,
        color: feedbackTags.color,
        usageCount: feedbackTags.usageCount,
      })
      .from(feedbackTags)
      .where(eq(feedbackTags.agentId, agentId))
      .orderBy(desc(feedbackTags.usageCount));

    return tags;
  }

  /**
   * Search tags by prefix (for autocomplete after 3 chars)
   */
  async searchTags(agentId, query) {
    if (!this.drizzle) this.initialize();

    const tags = await this.drizzle
      .select({
        name: feedbackTags.name,
        color: feedbackTags.color,
      })
      .from(feedbackTags)
      .where(and(
        eq(feedbackTags.agentId, agentId),
        ilike(feedbackTags.name, `${query}%`)
      ))
      .orderBy(desc(feedbackTags.usageCount))
      .limit(10);

    return tags;
  }

  /**
   * Get or create a tag, incrementing usage count
   */
  async getOrCreateTag(agentId, tagName, tagColor) {
    if (!this.drizzle) this.initialize();

    // Try to find existing tag
    const existing = await this.drizzle
      .select()
      .from(feedbackTags)
      .where(and(
        eq(feedbackTags.agentId, agentId),
        eq(feedbackTags.name, tagName)
      ))
      .limit(1);

    if (existing.length > 0) {
      // Increment usage count
      await this.drizzle
        .update(feedbackTags)
        .set({ usageCount: sql`${feedbackTags.usageCount} + 1` })
        .where(eq(feedbackTags.id, existing[0].id));

      return { name: existing[0].name, color: existing[0].color };
    }

    // Create new tag
    const [newTag] = await this.drizzle
      .insert(feedbackTags)
      .values({
        agentId,
        name: tagName,
        color: tagColor,
        usageCount: 1,
      })
      .returning();

    return { name: newTag.name, color: newTag.color };
  }

  // ─── Feedback CRUD ──────────────────────────────────────────────────

  /**
   * Create feedback on an assistant message
   */
  async createFeedback(assistantMessageId, feedbackText, tags, createdBy = null) {
    if (!this.drizzle) this.initialize();

    // Get the assistant message to find its conversation and preceding user message
    const [assistantMessage] = await this.drizzle
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        metadata: messages.metadata,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.id, assistantMessageId))
      .limit(1);

    if (!assistantMessage) {
      throw new Error(`Message not found: ${assistantMessageId}`);
    }

    // Find the preceding user message in the same conversation
    const [userMessage] = await this.drizzle
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.conversationId, assistantMessage.conversationId),
        eq(messages.role, 'user'),
        lt(messages.createdAt, assistantMessage.createdAt)
      ))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    // Get crewMember from assistant message metadata
    const crewMember = assistantMessage.metadata?.crewMember || null;

    // Get agentId from conversation for tag registry
    const [conversation] = await this.drizzle
      .select({ agentId: conversations.agentId })
      .from(conversations)
      .where(eq(conversations.id, assistantMessage.conversationId))
      .limit(1);

    // Register tags in the tag registry
    if (tags && tags.length > 0 && conversation) {
      for (const tag of tags) {
        await this.getOrCreateTag(conversation.agentId, tag.name, tag.color);
      }
    }

    // Insert feedback
    const [feedback] = await this.drizzle
      .insert(messageFeedback)
      .values({
        assistantMessageId,
        userMessageId: userMessage?.id || null,
        feedbackText,
        tags: tags || [],
        crewMember,
        createdBy,
      })
      .returning();

    return feedback;
  }

  /**
   * Get feedback for a specific message
   */
  async getFeedbackForMessage(assistantMessageId) {
    if (!this.drizzle) this.initialize();

    const [feedback] = await this.drizzle
      .select()
      .from(messageFeedback)
      .where(eq(messageFeedback.assistantMessageId, assistantMessageId))
      .limit(1);

    return feedback || null;
  }

  /**
   * Update existing feedback
   */
  async updateFeedback(feedbackId, updates) {
    if (!this.drizzle) this.initialize();

    // If tags are being updated, register them in the tag registry
    if (updates.tags && updates.tags.length > 0) {
      // Get the feedback to find the message and agent
      const [feedback] = await this.drizzle
        .select({ assistantMessageId: messageFeedback.assistantMessageId })
        .from(messageFeedback)
        .where(eq(messageFeedback.id, feedbackId))
        .limit(1);

      if (feedback) {
        // Get agentId via message -> conversation
        const [message] = await this.drizzle
          .select({ conversationId: messages.conversationId })
          .from(messages)
          .where(eq(messages.id, feedback.assistantMessageId))
          .limit(1);

        if (message) {
          const [conversation] = await this.drizzle
            .select({ agentId: conversations.agentId })
            .from(conversations)
            .where(eq(conversations.id, message.conversationId))
            .limit(1);

          if (conversation) {
            for (const tag of updates.tags) {
              await this.getOrCreateTag(conversation.agentId, tag.name, tag.color);
            }
          }
        }
      }
    }

    const [updated] = await this.drizzle
      .update(messageFeedback)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(messageFeedback.id, feedbackId))
      .returning();

    return updated;
  }

  /**
   * Delete feedback
   */
  async deleteFeedback(feedbackId) {
    if (!this.drizzle) this.initialize();

    await this.drizzle
      .delete(messageFeedback)
      .where(eq(messageFeedback.id, feedbackId));
  }

  // ─── Dashboard Queries ──────────────────────────────────────────────

  /**
   * Get all feedback for an agent (for dashboard)
   */
  async getFeedbackForAgent(agentName, limit = 100) {
    if (!this.drizzle) this.initialize();

    // Get agent ID and urlSlug
    const [agent] = await this.drizzle
      .select({ id: agents.id, urlSlug: agents.urlSlug })
      .from(agents)
      .where(eq(agents.name, agentName))
      .limit(1);

    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    // Get feedback with message content
    const feedbackList = await this.drizzle
      .select({
        id: messageFeedback.id,
        assistantMessageId: messageFeedback.assistantMessageId,
        userMessageId: messageFeedback.userMessageId,
        feedbackText: messageFeedback.feedbackText,
        tags: messageFeedback.tags,
        crewMember: messageFeedback.crewMember,
        createdAt: messageFeedback.createdAt,
        // Join assistant message content
        messageContent: messages.content,
        // Join conversation external ID for linking
        conversationExternalId: conversations.externalId,
      })
      .from(messageFeedback)
      .innerJoin(messages, eq(messages.id, messageFeedback.assistantMessageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.agentId, agent.id))
      .orderBy(desc(messageFeedback.createdAt))
      .limit(limit);

    // For each feedback, get the user message content
    const result = await Promise.all(feedbackList.map(async (fb) => {
      let userMessage = '';
      if (fb.userMessageId) {
        const [userMsg] = await this.drizzle
          .select({ content: messages.content })
          .from(messages)
          .where(eq(messages.id, fb.userMessageId))
          .limit(1);
        userMessage = userMsg?.content || '';
      }

      return {
        id: String(fb.id),
        assistantMessageId: String(fb.assistantMessageId),
        userMessageId: fb.userMessageId ? String(fb.userMessageId) : null,
        feedbackText: fb.feedbackText || '',
        tags: fb.tags || [],
        crewMember: fb.crewMember,
        messageContent: fb.messageContent,
        userMessage,
        conversationId: fb.conversationExternalId,
        agentUrlSlug: agent.urlSlug,
        createdAt: fb.createdAt,
      };
    }));

    return result;
  }

  /**
   * Get feedback stats for an agent (for dashboard)
   */
  async getFeedbackStats(agentName) {
    if (!this.drizzle) this.initialize();

    // Get agent ID
    const [agent] = await this.drizzle
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, agentName))
      .limit(1);

    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    // Get all feedback for this agent
    const feedbackList = await this.drizzle
      .select({
        tags: messageFeedback.tags,
        crewMember: messageFeedback.crewMember,
      })
      .from(messageFeedback)
      .innerJoin(messages, eq(messages.id, messageFeedback.assistantMessageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.agentId, agent.id));

    // Aggregate tags
    const tagCounts = new Map();
    for (const fb of feedbackList) {
      if (fb.tags && Array.isArray(fb.tags)) {
        for (const tag of fb.tags) {
          const key = tag.name;
          if (tagCounts.has(key)) {
            tagCounts.get(key).count++;
          } else {
            tagCounts.set(key, { tag: { name: tag.name, color: tag.color }, count: 1 });
          }
        }
      }
    }

    // Aggregate crew members
    const crewCounts = new Map();
    for (const fb of feedbackList) {
      if (fb.crewMember) {
        crewCounts.set(fb.crewMember, (crewCounts.get(fb.crewMember) || 0) + 1);
      }
    }

    const tagAggregations = [...tagCounts.values()].sort((a, b) => b.count - a.count);
    const crewAggregations = [...crewCounts.entries()]
      .map(([crewMember, count]) => ({ crewMember, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalFeedback: feedbackList.length,
      tagAggregations,
      crewAggregations,
    };
  }
}

module.exports = new FeedbackService();
