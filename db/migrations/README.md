# Database Migrations

## Add prompt_id Column to Agents Table

This migration adds a `prompt_id` column to the `agents` table, allowing each agent to have its own OpenAI prompt ID.

### Running the Migration

#### Option 1: Using Node.js Script (Recommended)

```bash
cd aspect-agent-server
node db/migrations/run-add-prompt-id.js
```

This will:
1. Add the `prompt_id` column to the `agents` table
2. Set Freeda 2.0's prompt_id to `pmpt_695cc633a8248193bfd1601116118463064124325ea89640`
3. Set Aspect's prompt_id to `pmpt_6968b04b9d8c819695d296bc9593c145031da9cca78b9b13`
4. Display the results

#### Option 2: Using psql or CloudSQL Console

If you prefer to run the SQL directly:

```bash
psql -h <your-host> -U <your-user> -d <your-database> -f db/migrations/add_prompt_id_to_agents.sql
```

Or copy the contents of `add_prompt_id_to_agents.sql` and run it in your CloudSQL console.

### What Changed

**Database Schema:**
- Added `prompt_id` VARCHAR(255) column to `agents` table
- Agent ID 1 (Freeda 2.0): `prompt_id = 'pmpt_695cc633a8248193bfd1601116118463064124325ea89640'`
- Agent ID 2 (Aspect): `prompt_id = 'pmpt_6968b04b9d8c819695d296bc9593c145031da9cca78b9b13'`

**Code Changes:**
- Schema updated to include `promptId` field
- Server routes now build agent config from both `promptId` column and `config` JSONB
- OpenAI service uses agent-specific prompt IDs
- Backward compatible with existing setup

### Verification

After running the migration, verify with:

```sql
SELECT id, name, prompt_id FROM agents ORDER BY id;
```

Expected output:
```
 id |    name     |                        prompt_id
----+-------------+----------------------------------------------------------
  1 | Freeda 2.0  | pmpt_695cc633a8248193bfd1601116118463064124325ea89640
  2 | Aspect      | pmpt_6968b04b9d8c819695d296bc9593c145031da9cca78b9b13
```

### Rollback

If you need to rollback:

```sql
ALTER TABLE agents DROP COLUMN IF EXISTS prompt_id;
```

Note: This will remove the column but won't affect functionality as the code falls back to environment variables.
