const db = require('./db.pg');
const { tasks, taskAssignees } = require('../db/schema');
const { eq, desc, and, ilike } = require('drizzle-orm');
const notificationsService = require('./notifications.service');
const boardEventsService = require('./boardEvents.service');

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
    if (filters.crewMember) {
      conditions.push(eq(tasks.crewMember, filters.crewMember));
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

    const { title, description, status, priority, type, domain, assignee, dueDate, atRisk, isCompleted, dependsOn, linkedTasks, tags, crewMember, isDraft, createdBy, opener } = data;

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
        dueDate: dueDate || null,
        atRisk: atRisk || false,
        isCompleted: isCompleted || false,
        dependsOn: dependsOn || null,
        linkedTasks: linkedTasks || [],
        tags: tags || [],
        crewMember: crewMember || null,
        isDraft: isDraft || false,
        createdBy: createdBy || null,
        opener: opener || null,
      })
      .returning();

    boardEventsService.emit({ type: 'task_created', task });

    // Notify assignee if assigned on creation (and not assigning themselves)
    if (assignee && assignee !== opener) {
      notificationsService.createNotification({
        recipient: assignee,
        taskId: task.id,
        commentId: null,
        type: opener ? `assigned_by:${opener}` : 'assigned',
      }).catch(err => console.error('[notifications] Failed to create task creation notification:', err));
    }

    return task;
  }

  /**
   * Update a task
   */
  async updateTask(id, updates) {
    if (!this.drizzle) this.initialize();

    // Fetch current task before update to detect changes for notifications
    const [before] = await this.drizzle.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const updatedBy = updates.updatedBy || null;

    const updateData = { updatedAt: new Date() };

    if (updates.title !== undefined) updateData.title = updates.title.trim();
    if (updates.description !== undefined) updateData.description = updates.description?.trim() || null;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.priority !== undefined) updateData.priority = updates.priority;
    if (updates.type !== undefined) updateData.type = updates.type;
    if (updates.domain !== undefined) updateData.domain = updates.domain || 'general';
    if (updates.assignee !== undefined) updateData.assignee = updates.assignee || null;
    if (updates.dueDate !== undefined) updateData.dueDate = updates.dueDate || null;
    if (updates.atRisk !== undefined) updateData.atRisk = updates.atRisk;
    if (updates.isCompleted !== undefined) updateData.isCompleted = updates.isCompleted;
    if (updates.dependsOn !== undefined) updateData.dependsOn = updates.dependsOn || null;
    if (updates.linkedTasks !== undefined) updateData.linkedTasks = updates.linkedTasks;
    if (updates.tags !== undefined) updateData.tags = updates.tags;
    if (updates.crewMember !== undefined) updateData.crewMember = updates.crewMember || null;
    if (updates.isDraft !== undefined) updateData.isDraft = updates.isDraft;
    if (updates.createdBy !== undefined) updateData.createdBy = updates.createdBy || null;
    if (updates.deployedAt !== undefined) updateData.deployedAt = updates.deployedAt || null;
    if (updates.deployedReviewedBy !== undefined) updateData.deployedReviewedBy = updates.deployedReviewedBy;

    const [task] = await this.drizzle
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    // Fire notifications asynchronously
    if (before) {
      this._createUpdateNotifications(before, task, updatedBy).catch(err =>
        console.error('[notifications] Failed to create task update notifications:', err)
      );
    }

    boardEventsService.emit({ type: 'task_updated', task });
    return task;
  }

  /**
   * Notify assignee when task is assigned or status changes
   */
  async _createUpdateNotifications(before, after, updatedBy = null) {
    const newAssignee = after.assignee;
    // Case-insensitive check: is this person the one who made the change?
    const isSelf = (name) => !!(name && updatedBy && name.toLowerCase() === updatedBy.toLowerCase());

    // Assignee changed → notify the new assignee (unless they assigned themselves)
    if (newAssignee && newAssignee !== before.assignee && !isSelf(newAssignee)) {
      const assigner = updatedBy || after.opener || null;
      await notificationsService.createNotification({
        recipient: newAssignee,
        taskId: after.id,
        commentId: null,
        type: assigner ? `assigned_by:${assigner}` : 'assigned',
      });
    }

    // Status changed → notify assignee and opener
    if (after.status !== before.status) {
      const notificationType = `moved_to_${after.status}`;
      const notifiedLower = new Set();

      // Notify assignee (if same as before, not the one who changed it)
      if (newAssignee && newAssignee === before.assignee && !isSelf(newAssignee)) {
        await notificationsService.createNotification({
          recipient: newAssignee,
          taskId: after.id,
          commentId: null,
          type: notificationType,
        });
        notifiedLower.add(newAssignee.toLowerCase());
      }

      // Notify opener (if set, not the one who changed it, and not already notified)
      const opener = after.opener;
      if (opener && !isSelf(opener) && !notifiedLower.has(opener.toLowerCase())) {
        await notificationsService.createNotification({
          recipient: opener,
          taskId: after.id,
          commentId: null,
          type: notificationType,
        });
      }
    }
  }

  /**
   * Mark a task as deployed — sets deployedAt and notifies commenters/assignee/opener
   */
  async markDeployed(id, deployedBy) {
    if (!this.drizzle) this.initialize();

    const [task] = await this.drizzle
      .update(tasks)
      .set({ deployedAt: new Date(), deployedReviewedBy: [], updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();

    if (!task) return null;

    // Notify everyone involved (assignee, opener, commenters) except the deployer
    const { taskComments } = require('../db/schema');
    const comments = await this.drizzle.select({ author: taskComments.author }).from(taskComments).where(eq(taskComments.taskId, id));

    const recipients = new Set();
    if (task.assignee) recipients.add(task.assignee);
    if (task.opener) recipients.add(task.opener);
    for (const c of comments) {
      if (c.author) recipients.add(c.author);
    }
    if (deployedBy) recipients.delete(deployedBy);

    for (const recipient of recipients) {
      notificationsService.createNotification({
        recipient,
        taskId: id,
        commentId: null,
        type: 'deployed',
      }).catch(err => console.error('[notifications] Failed to create deploy notification:', err));
    }

    boardEventsService.emit({ type: 'task_updated', task });
    return task;
  }

  /**
   * Get tasks that were deployed and not yet reviewed by the given identity
   */
  async getWhatsNew(identity) {
    if (!this.drizzle) this.initialize();
    if (!identity) return [];

    const allTasks = await this.drizzle.select().from(tasks).orderBy(desc(tasks.deployedAt));
    return allTasks.filter(t => {
      if (!t.deployedAt) return false;
      const reviewedBy = t.deployedReviewedBy || [];
      return !reviewedBy.includes(identity);
    });
  }

  /**
   * Dismiss a deployed task from a user's "What's New" list
   */
  async dismissDeployed(id, identity) {
    if (!this.drizzle) this.initialize();

    const [task] = await this.drizzle.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) return null;

    const reviewedBy = task.deployedReviewedBy || [];
    if (reviewedBy.includes(identity)) return task;

    const [updated] = await this.drizzle
      .update(tasks)
      .set({ deployedReviewedBy: [...reviewedBy, identity] })
      .where(eq(tasks.id, id))
      .returning();

    return updated;
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
