const db = require('./db.pg');
const { tasks, taskAssignees } = require('../db/schema');
const { eq, desc, and, ilike } = require('drizzle-orm');

/**
 * Task Board Service
 *
 * Manages tasks and assignees for the internal task board
 */
class TaskService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  // ─── Assignees ───────────────────────────────────────────────────────

  /**
   * Get all assignees
   */
  async getAssignees() {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(taskAssignees)
      .orderBy(taskAssignees.name);

    return result;
  }

  /**
   * Add a new assignee
   */
  async addAssignee(name) {
    if (!this.drizzle) this.initialize();

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Assignee name is required');
    }

    // Check if already exists
    const existing = await this.drizzle
      .select()
      .from(taskAssignees)
      .where(ilike(taskAssignees.name, trimmedName))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    const [assignee] = await this.drizzle
      .insert(taskAssignees)
      .values({ name: trimmedName })
      .returning();

    return assignee;
  }

  /**
   * Seed default assignees if none exist
   */
  async seedDefaultAssignees() {
    if (!this.drizzle) this.initialize();

    const existing = await this.drizzle.select().from(taskAssignees).limit(1);
    if (existing.length > 0) return;

    await this.drizzle.insert(taskAssignees).values([
      { name: 'Shlomi' },
      { name: 'Kosta' },
    ]);
  }

  // ─── Tasks ───────────────────────────────────────────────────────────

  /**
   * Get all tasks with optional filters
   */
  async getTasks(filters = {}) {
    if (!this.drizzle) this.initialize();

    let query = this.drizzle.select().from(tasks);

    const conditions = [];
    if (filters.status) {
      conditions.push(eq(tasks.status, filters.status));
    }
    if (filters.assignee) {
      conditions.push(eq(tasks.assignee, filters.assignee));
    }
    if (filters.type) {
      conditions.push(eq(tasks.type, filters.type));
    }
    if (filters.priority) {
      conditions.push(eq(tasks.priority, filters.priority));
    }
    if (filters.domain) {
      conditions.push(eq(tasks.domain, filters.domain));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const result = await query.orderBy(desc(tasks.createdAt));
    return result;
  }

  /**
   * Get a single task by ID
   */
  async getTask(id) {
    if (!this.drizzle) this.initialize();

    const [task] = await this.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);

    return task || null;
  }

  /**
   * Create a new task
   */
  async createTask(data) {
    if (!this.drizzle) this.initialize();

    const { title, description, status, priority, type, domain, assignee, tags } = data;

    if (!title?.trim()) {
      throw new Error('Task title is required');
    }

    const [task] = await this.drizzle
      .insert(tasks)
      .values({
        title: title.trim(),
        description: description?.trim() || null,
        status: status || 'todo',
        priority: priority || 'medium',
        type: type || 'feature',
        domain: domain || 'general',
        assignee: assignee || null,
        tags: tags || [],
      })
      .returning();

    return task;
  }

  /**
   * Update a task
   */
  async updateTask(id, updates) {
    if (!this.drizzle) this.initialize();

    const updateData = { updatedAt: new Date() };

    if (updates.title !== undefined) updateData.title = updates.title.trim();
    if (updates.description !== undefined) updateData.description = updates.description?.trim() || null;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.priority !== undefined) updateData.priority = updates.priority;
    if (updates.type !== undefined) updateData.type = updates.type;
    if (updates.domain !== undefined) updateData.domain = updates.domain || 'general';
    if (updates.assignee !== undefined) updateData.assignee = updates.assignee || null;
    if (updates.tags !== undefined) updateData.tags = updates.tags;

    const [task] = await this.drizzle
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    return task;
  }

  /**
   * Delete a task
   */
  async deleteTask(id) {
    if (!this.drizzle) this.initialize();

    await this.drizzle.delete(tasks).where(eq(tasks.id, id));
  }
}

module.exports = new TaskService();
