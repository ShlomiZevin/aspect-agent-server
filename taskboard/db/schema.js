/**
 * Drizzle schema for `aspect_tasks_db`.
 *
 * Mirrors taskboard/db/migrations/001_init.sql. The migration is the source of
 * truth -- it carries the CHECK constraints, the partial indexes and the
 * updated_at triggers, none of which drizzle expresses -- so change the SQL
 * first and follow here.
 */
const {
  pgTable, bigserial, bigint, varchar, text, boolean, date, timestamp, primaryKey, index,
} = require('drizzle-orm/pg-core');

const tasks = pgTable('tasks', {
  id:           bigserial('id', { mode: 'number' }).primaryKey(),
  title:        varchar('title', { length: 255 }).notNull(),
  description:  text('description'),
  status:       varchar('status', { length: 20 }).default('todo').notNull(),
  priority:     varchar('priority', { length: 20 }).default('medium').notNull(),
  type:         varchar('type', { length: 20 }).default('task').notNull(),
  assignee:     varchar('assignee', { length: 100 }),
  opener:       varchar('opener', { length: 100 }),
  dueDate:      date('due_date'),
  // Native text[], not JSONB — see the migration's header for why.
  tags:         text('tags').array().default([]).notNull(),
  atRisk:       boolean('at_risk').default(false).notNull(),
  acknowledged: boolean('acknowledged').default(false).notNull(),
  isDraft:      boolean('is_draft').default(false).notNull(),
  dependsOn:    bigint('depends_on', { mode: 'number' }),
  deployedAt:   timestamp('deployed_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

const taskLinks = pgTable('task_links', {
  taskId:       bigint('task_id', { mode: 'number' }).notNull(),
  linkedTaskId: bigint('linked_task_id', { mode: 'number' }).notNull(),
}, t => ({
  pk:      primaryKey({ columns: [t.taskId, t.linkedTaskId] }),
  reverse: index('task_links_reverse_idx').on(t.linkedTaskId),
}));

const taskComments = pgTable('task_comments', {
  id:        bigserial('id', { mode: 'number' }).primaryKey(),
  taskId:    bigint('task_id', { mode: 'number' }).notNull(),
  author:    varchar('author', { length: 100 }).notNull(),
  body:      text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  byTask: index('task_comments_task_idx').on(t.taskId, t.createdAt),
}));

const commentLikes = pgTable('comment_likes', {
  commentId: bigint('comment_id', { mode: 'number' }).notNull(),
  person:    varchar('person', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.commentId, t.person] }),
}));

/** kind: 'seen' (dismissed from What's New) | 'emailed' (already in a digest). */
const taskAcks = pgTable('task_acks', {
  taskId:    bigint('task_id', { mode: 'number' }).notNull(),
  person:    varchar('person', { length: 100 }).notNull(),
  kind:      varchar('kind', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  pk:       primaryKey({ columns: [t.taskId, t.person, t.kind] }),
  byPerson: index('task_acks_person_idx').on(t.person, t.kind),
}));

const notifications = pgTable('notifications', {
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  recipient:   varchar('recipient', { length: 100 }).notNull(),
  taskId:      bigint('task_id', { mode: 'number' }).notNull(),
  commentId:   bigint('comment_id', { mode: 'number' }),
  type:        varchar('type', { length: 50 }).notNull(),
  isRead:      boolean('is_read').default(false).notNull(),
  isDelivered: boolean('is_delivered').default(false).notNull(),
  emailedAt:   timestamp('emailed_at', { withTimezone: true }),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

const people = pgTable('people', {
  name:      varchar('name', { length: 100 }).primaryKey(),
  active:    boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

module.exports = {
  tasks, taskLinks, taskComments, commentLikes, taskAcks, notifications, people,
};
