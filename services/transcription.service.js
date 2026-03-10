/**
 * Transcription Service
 *
 * Transcribes audio files using:
 * - OpenAI Whisper (whisper-1)
 * - Google Gemini (gemini-1.5-pro with audio File API)
 *
 * For OpenAI: automatically compresses audio > 24MB to mp3 32kbps via ffmpeg.
 * For Google: uploads audio via Gemini File API (supports files up to 2GB).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const OPENAI_MAX_BYTES = 24 * 1024 * 1024; // 24MB — safe margin under 25MB limit
const WHISPER_MODEL = 'whisper-1';
const GEMINI_AUDIO_MODEL = 'gemini-1.5-pro';

// ─── OpenAI client ──────────────────────────────────────────────────────────
function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Google GenAI client ─────────────────────────────────────────────────────
let _genaiModule = null;
async function getGenAI() {
  if (!_genaiModule) {
    const mod = await import('@google/genai');
    _genaiModule = new mod.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _genaiModule;
}

// ─── ffmpeg helpers ───────────────────────────────────────────────────────────
/**
 * Compress audio buffer to mp3 at 32kbps / mono / 16kHz.
 * Writes temp files, runs ffmpeg, reads result back, cleans up.
 *
 * @param {Buffer} buffer  - Original audio buffer
 * @param {string} ext     - Original file extension (e.g. '.m4a')
 * @returns {Promise<Buffer>} - Compressed mp3 buffer
 */
async function compressAudioBuffer(buffer, ext = '.m4a') {
  const tmpIn  = path.join(os.tmpdir(), `podcast-in-${Date.now()}${ext}`);
  const tmpOut = path.join(os.tmpdir(), `podcast-out-${Date.now()}.mp3`);

  try {
    fs.writeFileSync(tmpIn, buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .audioCodec('libmp3lame')
        .audioBitrate(32)
        .audioChannels(1)
        .audioFrequency(16000)
        .format('mp3')
        .output(tmpOut)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    return fs.readFileSync(tmpOut);
  } finally {
    if (fs.existsSync(tmpIn))  fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
}

/**
 * Convert audio buffer to mp3 (without aggressive compression) for format compatibility.
 * Used when file is already small enough but needs format conversion.
 */
async function convertToMp3Buffer(buffer, ext = '.m4a') {
  const tmpIn  = path.join(os.tmpdir(), `podcast-conv-in-${Date.now()}${ext}`);
  const tmpOut = path.join(os.tmpdir(), `podcast-conv-out-${Date.now()}.mp3`);

  try {
    fs.writeFileSync(tmpIn, buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .audioCodec('libmp3lame')
        .audioBitrate(64)
        .format('mp3')
        .output(tmpOut)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    return fs.readFileSync(tmpOut);
  } finally {
    if (fs.existsSync(tmpIn))  fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
}

// ─── Transcription providers ──────────────────────────────────────────────────
class TranscriptionService {
  /**
   * Transcribe using OpenAI Whisper.
   * Automatically compresses large files to stay under the 25MB API limit.
   *
   * @param {Buffer} buffer    - Audio file content
   * @param {string} fileName  - Original file name (used for extension detection)
   * @param {string} mimeType  - MIME type of original file
   * @returns {Promise<string>} - Full transcript text
   */
  async transcribeWithOpenAI(buffer, fileName, mimeType) {
    const openai = getOpenAIClient();
    const ext    = path.extname(fileName).toLowerCase() || '.m4a';

    let audioBuffer = buffer;
    let audioName   = fileName;
    let audioMime   = mimeType;

    if (buffer.length > OPENAI_MAX_BYTES) {
      console.log(`🗜️  [Transcription] File is ${(buffer.length / 1024 / 1024).toFixed(1)}MB > 24MB — compressing with ffmpeg...`);
      audioBuffer = await compressAudioBuffer(buffer, ext);
      audioName   = fileName.replace(/\.[^.]+$/, '') + '_compressed.mp3';
      audioMime   = 'audio/mpeg';
      console.log(`✅ [Transcription] Compressed to ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB`);
    } else if (ext === '.m4a') {
      // OpenAI Whisper accepts m4a, but some edge cases fail — convert to mp3 to be safe
      console.log(`🔄 [Transcription] Converting m4a to mp3 for OpenAI compatibility...`);
      audioBuffer = await convertToMp3Buffer(buffer, ext);
      audioName   = fileName.replace(/\.[^.]+$/, '') + '.mp3';
      audioMime   = 'audio/mpeg';
    }

    console.log(`🎙️  [Transcription] Sending to OpenAI Whisper (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)...`);

    const file = new File([audioBuffer], audioName, { type: audioMime });

    const response = await openai.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      response_format: 'text',
    });

    return typeof response === 'string' ? response : response.text || '';
  }

  /**
   * Transcribe using Google Gemini via the File API.
   * Supports large files (up to 2GB). Gemini processes the audio and
   * returns a verbatim transcription.
   *
   * @param {Buffer} buffer    - Audio file content
   * @param {string} fileName  - Original file name
   * @param {string} mimeType  - MIME type of original file
   * @returns {Promise<string>} - Full transcript text
   */
  async transcribeWithGoogle(buffer, fileName, mimeType) {
    const ai = await getGenAI();

    // Normalize MIME type — Gemini requires a supported audio format
    const supportedMimeType = this._normalizeMimeType(mimeType, fileName);

    console.log(`📤 [Transcription] Uploading to Gemini File API (${(buffer.length / 1024 / 1024).toFixed(1)}MB)...`);

    // Upload audio via Gemini File API
    const blob = new Blob([buffer], { type: supportedMimeType });
    const uploadedFile = await ai.files.upload({
      file: blob,
      config: {
        mimeType: supportedMimeType,
        displayName: fileName,
      },
    });

    console.log(`⏳ [Transcription] Waiting for Gemini file processing...`);

    // Poll until the file is ACTIVE (ready for inference)
    let fileInfo = await ai.files.get({ name: uploadedFile.name });
    let attempts = 0;
    while (fileInfo.state === 'PROCESSING' && attempts < 30) {
      await new Promise(r => setTimeout(r, 5000));
      fileInfo = await ai.files.get({ name: uploadedFile.name });
      attempts++;
    }

    if (fileInfo.state !== 'ACTIVE') {
      throw new Error(`Gemini file processing failed with state: ${fileInfo.state}`);
    }

    console.log(`🎙️  [Transcription] Sending to Gemini for transcription...`);

    const response = await ai.models.generateContent({
      model: GEMINI_AUDIO_MODEL,
      contents: [
        {
          parts: [
            {
              fileData: {
                mimeType: fileInfo.mimeType,
                fileUri: fileInfo.uri,
              },
            },
            {
              text: 'Please transcribe this audio recording verbatim and completely. Output ONLY the transcription text — no introductions, no commentary, no formatting headers. Just the spoken words exactly as said.',
            },
          ],
        },
      ],
      config: {
        maxOutputTokens: 32768,
        temperature: 0,
      },
    });

    // Clean up uploaded file from Gemini storage
    try {
      await ai.files.delete({ name: uploadedFile.name });
    } catch (e) {
      console.warn(`⚠️  [Transcription] Could not delete Gemini file: ${e.message}`);
    }

    return response.text || '';
  }

  /**
   * Normalize MIME type for Gemini File API compatibility.
   * Gemini supports: audio/wav, audio/mp3, audio/mpeg, audio/aiff,
   * audio/aac, audio/ogg, audio/flac, audio/webm, video/mp4, video/mpeg, etc.
   *
   * @private
   */
  _normalizeMimeType(mimeType, fileName) {
    const ext = path.extname(fileName).toLowerCase();

    const mimeMap = {
      '.m4a':  'audio/mp4',
      '.mp4':  'audio/mp4',
      '.mp3':  'audio/mpeg',
      '.wav':  'audio/wav',
      '.ogg':  'audio/ogg',
      '.flac': 'audio/flac',
      '.aac':  'audio/aac',
      '.webm': 'audio/webm',
    };

    return mimeMap[ext] || mimeType || 'audio/mp4';
  }
}

module.exports = new TranscriptionService();
