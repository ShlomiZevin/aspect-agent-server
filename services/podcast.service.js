/**
 * Podcast Service
 *
 * DB CRUD for podcast_episodes table.
 * Handles episode creation, status updates for transcription & summarization.
 */

const db = require('./db.pg');

class PodcastService {
  /**
   * Create a new episode record after audio upload.
   */
  async createEpisode({ title, audioFileName, audioFileUrl, audioFileSize, audioMimeType }) {
    const result = await db.query(
      `INSERT INTO podcast_episodes
         (title, audio_file_name, audio_file_url, audio_file_size, audio_mime_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, audioFileName, audioFileUrl, audioFileSize, audioMimeType]
    );
    return result.rows[0];
  }

  /**
   * List all episodes ordered by newest first.
   */
  async listEpisodes() {
    const result = await db.query(
      `SELECT * FROM podcast_episodes ORDER BY created_at DESC`
    );
    return result.rows;
  }

  /**
   * Get a single episode by ID.
   */
  async getEpisode(id) {
    const result = await db.query(
      `SELECT * FROM podcast_episodes WHERE id = $1`,
      [parseInt(id)]
    );
    return result.rows[0] || null;
  }

  /**
   * Update transcript status and result fields.
   */
  async updateTranscriptStatus(id, { status, url, text, provider, error }) {
    const result = await db.query(
      `UPDATE podcast_episodes
       SET transcript_status   = $1::text,
           transcript_url      = COALESCE($2, transcript_url),
           transcript_text     = COALESCE($3, transcript_text),
           transcript_provider = COALESCE($4, transcript_provider),
           transcript_error    = $5,
           transcribed_at      = CASE WHEN $1::text = 'completed' THEN NOW() ELSE transcribed_at END
       WHERE id = $6
       RETURNING *`,
      [status, url || null, text || null, provider || null, error || null, parseInt(id)]
    );
    return result.rows[0];
  }

  /**
   * Update summary status and result fields.
   */
  async updateSummaryStatus(id, { status, url, text, provider, model, prompt, error }) {
    const result = await db.query(
      `UPDATE podcast_episodes
       SET summary_status   = $1::text,
           summary_url      = COALESCE($2, summary_url),
           summary_text     = COALESCE($3, summary_text),
           summary_provider = COALESCE($4, summary_provider),
           summary_model    = COALESCE($5, summary_model),
           summary_prompt   = COALESCE($6, summary_prompt),
           summary_error    = $7,
           summarized_at    = CASE WHEN $1::text = 'completed' THEN NOW() ELSE summarized_at END
       WHERE id = $8
       RETURNING *`,
      [status, url || null, text || null, provider || null, model || null, prompt || null, error || null, parseInt(id)]
    );
    return result.rows[0];
  }

  /**
   * Delete an episode record.
   */
  async deleteEpisode(id) {
    const result = await db.query(
      `DELETE FROM podcast_episodes WHERE id = $1 RETURNING *`,
      [parseInt(id)]
    );
    return result.rows[0] || null;
  }
}

module.exports = new PodcastService();
