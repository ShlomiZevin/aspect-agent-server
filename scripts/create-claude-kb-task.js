/**
 * Create Claude KB Files API Task
 *
 * Creates a task in the DB for Claude to implement KB support
 * for the Anthropic provider via the Files API.
 *
 * Usage:
 *   node scripts/create-claude-kb-task.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const TASK_TITLE = 'Add Claude KB Support via Anthropic Files API';

const TASK_DESCRIPTION = `Implement knowledge base (KB) support for the Claude/Anthropic LLM provider using the Anthropic Files API.

FULL SPEC: See tasks/claude-kb-files-api.md in the repo root for the complete breakdown of every file to change and why.

--- WHAT TO DO ---

Currently the KB resolver skips Claude entirely (kb.resolver.js line 8: "anthropic → skip").
The goal is to mimic KB behaviour for Claude by uploading files to the Anthropic Files API (beta)
and injecting them as document blocks at inference time. No semantic retrieval — Claude reads all files.

Changes required (in order):

1. DB MIGRATION
   Add column claude_file_id (varchar 255, nullable) to knowledge_base_files table.
   Use a raw SQL migration — there is no drizzle migrate command wired up, just run it directly in setup-production-db.js style or as a one-off ALTER TABLE.
   Also update db/schema/index.js to add claudeFileId to the knowledgeBaseFiles table definition.

2. NEW SERVICE: services/kb.claude.service.js
   Mirrors kb.google.service.js in structure.
   Wraps three Anthropic Files API calls:
     - uploadFile(buffer, fileName, mimeType) → returns { fileId, fileName }
     - deleteFile(fileId)
     - listFiles()
   Use the Anthropic SDK client (same pattern as llm.claude.js — new Anthropic({ apiKey })).
   The Files API is under client.beta.files.

3. UPDATE: services/kb.service.js
   Add claudeFileId to the providerIds param in addFile() and save it to the DB insert.
   Add claudeFileId to updateFileProviderIds().

4. UPDATE: services/kb.resolver.js
   Add an anthropic branch (alongside the existing openai and google branches).
   Query knowledge_base_files for all files in the matched KB rows.
   Collect claudeFileId values, skip nulls with a warning.
   Return: { enabled: fileIds.length > 0, provider: 'anthropic', fileIds: ['file_xxx', ...], resolvedSources: [...] }

5. UPDATE: services/llm.claude.js — sendMessageStreamWithPrompt
   Accept knowledgeBase in the config object.
   When knowledgeBase.enabled && knowledgeBase.provider === 'anthropic':
     Build document blocks using source: { type: 'file', file_id } format.
     Prepend them to the user message content array (content must become an array, not a plain string).
     Yield a kb_access thinking step event per file (match the pattern used in llm.openai.js or llm.google.js).

6. UPDATE: server.js — KB file upload endpoint
   When the KB provider includes 'anthropic' (provider === 'anthropic' or 'all'),
   call kb.claude.service.uploadFile() and pass the returned fileId as claudeFileId
   into kb.service.addFile() or updateFileProviderIds().

7. UPDATE: knowledgeBases provider values
   Current allowed values: 'openai' | 'google' | 'both'
   Add: 'anthropic' | 'all' (openai + google + anthropic)
   Update any provider-check logic and comments accordingly.

--- HOW TO VERIFY ---

After implementing, verify in this order:

1. DB column exists:
   Run: SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_base_files' AND column_name = 'claude_file_id';
   Expected: one row returned.

2. File upload saves claudeFileId:
   Upload a small text file (.txt) to a KB that has provider = 'anthropic' via the KBManager UI or the POST /api/kb/:id/upload endpoint.
   Then check: SELECT id, file_name, claude_file_id FROM knowledge_base_files ORDER BY id DESC LIMIT 5;
   Expected: claude_file_id is populated (starts with 'file_').

3. KB resolver returns fileIds for Claude model:
   Add a console.log in kb.resolver.js resolve() to print the result when provider is 'anthropic'.
   Configure a crew member with model = 'claude-sonnet-4-...' and knowledgeBase sources pointing to an anthropic KB.
   Send any message to that crew.
   Expected: resolver log shows { enabled: true, provider: 'anthropic', fileIds: [...] }.

4. Claude receives file content:
   With the crew from step 3, ask a question that can only be answered from the uploaded file content.
   Expected: Claude answers correctly using information from the file.
   Also check the thinking indicator — a kb_access step should appear for each file injected.

5. Regression — OpenAI and Google flows unchanged:
   Send a message to a crew using gpt-4o with an OpenAI KB configured.
   Send a message to a crew using gemini-* with a Google KB configured.
   Expected: both work exactly as before, no errors.`;

async function createTask() {
  try {
    console.log('🔧 Creating Claude KB task...\n');

    // Check if task already exists
    const existing = await pool.query(
      `SELECT id, title FROM tasks WHERE title = $1`,
      [TASK_TITLE]
    );

    if (existing.rows.length > 0) {
      console.log('⚠️  Task already exists!');
      console.log(`   ID: ${existing.rows[0].id}`);
      console.log(`   Title: ${existing.rows[0].title}`);
      console.log('\nUpdating description...\n');

      await pool.query(
        `UPDATE tasks SET description = $1, updated_at = NOW() WHERE id = $2`,
        [TASK_DESCRIPTION, existing.rows[0].id]
      );

      console.log('✅ Task description updated.');
      console.log(`   Task ID: ${existing.rows[0].id}`);
    } else {
      const result = await pool.query(
        `INSERT INTO tasks (
          title,
          description,
          status,
          priority,
          type,
          domain,
          assignee,
          opener,
          created_by,
          tags,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
        RETURNING id`,
        [
          TASK_TITLE,
          TASK_DESCRIPTION,
          'todo',
          'medium',
          'feature',
          'aspect',
          'Claude',
          'Kosta',
          'Kosta',
          JSON.stringify(['kb', 'claude', 'anthropic']),
        ]
      );

      console.log('✅ Task created!');
      console.log(`   Task ID: ${result.rows[0].id}`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📋 TASK SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Title:    ${TASK_TITLE}`);
    console.log('Assignee: Claude');
    console.log('Opener:   Kosta');
    console.log('Status:   todo');
    console.log('Priority: medium');
    console.log('Domain:   aspect');
    console.log('Tags:     kb, claude, anthropic');
    console.log('Spec:     tasks/claude-kb-files-api.md');
    console.log('═'.repeat(60));
    console.log('\nRun "node scripts/read-claude-tasks.js all" to confirm.\n');

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

createTask();
