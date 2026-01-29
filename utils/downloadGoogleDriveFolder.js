const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

/**
 * Downloads all files from a Google Drive folder recursively
 *
 * Usage:
 *   node downloadGoogleDriveFolder.js <folderId> <outputDir> [credentialsPath]
 *
 * Setup:
 *   1. Go to Google Cloud Console
 *   2. Create a project and enable Google Drive API
 *   3. Create a Service Account and download the JSON key file
 *   4. Share your Google Drive folder with the service account email
 */

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

async function authenticate(credentialsPath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: SCOPES,
  });
  return auth;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken: pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    files.push(...response.data.files);
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadFile(drive, fileId, destPath) {
  const dest = fs.createWriteStream(destPath);

  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    response.data
      .on('end', () => {
        console.log(`  Downloaded: ${destPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`  Error downloading ${destPath}:`, err.message);
        reject(err);
      })
      .pipe(dest);
  });
}

async function exportGoogleDoc(drive, fileId, destPath, mimeType, exportMimeType, extension) {
  const dest = fs.createWriteStream(destPath + extension);

  const response = await drive.files.export(
    { fileId, mimeType: exportMimeType },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    response.data
      .on('end', () => {
        console.log(`  Exported: ${destPath}${extension}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`  Error exporting ${destPath}:`, err.message);
        reject(err);
      })
      .pipe(dest);
  });
}

// Handle duplicate filenames by adding a number suffix
function getUniqueFilePath(dir, filename) {
  let destPath = path.join(dir, filename);
  if (!fs.existsSync(destPath)) {
    return destPath;
  }

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let counter = 1;

  while (fs.existsSync(destPath)) {
    destPath = path.join(dir, `${base}_${counter}${ext}`);
    counter++;
  }

  return destPath;
}

// Map Google Workspace types to export formats
const EXPORT_MIME_TYPES = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx'
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'image/png',
    extension: '.png'
  },
};

async function downloadFolder(drive, folderId, outputDir, folderName = 'root') {
  console.log(`Processing folder: ${folderName}`);

  const files = await listFilesInFolder(drive, folderId);
  console.log(`Found ${files.length} items in ${folderName}`);

  for (const file of files) {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      // Recursively process subfolder (but still save to same outputDir)
      await downloadFolder(drive, file.id, outputDir, file.name);
    } else if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      // Google Workspace file - needs to be exported
      const exportConfig = EXPORT_MIME_TYPES[file.mimeType];
      if (exportConfig) {
        try {
          const destPath = getUniqueFilePath(outputDir, file.name);
          await exportGoogleDoc(drive, file.id, destPath, file.mimeType, exportConfig.mimeType, exportConfig.extension);
        } catch (err) {
          console.error(`  Skipping ${file.name}: ${err.message}`);
        }
      } else {
        console.log(`  Skipping unsupported Google type: ${file.name} (${file.mimeType})`);
      }
    } else {
      // Regular file - download directly
      try {
        const destPath = getUniqueFilePath(outputDir, file.name);
        await downloadFile(drive, file.id, destPath);
      } catch (err) {
        console.error(`  Failed to download ${file.name}: ${err.message}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node downloadGoogleDriveFolder.js <folderId> <outputDir> [credentialsPath]');
    console.log('');
    console.log('Arguments:');
    console.log('  folderId        - The Google Drive folder ID (from the URL)');
    console.log('  outputDir       - Local directory to save files');
    console.log('  credentialsPath - Path to service account JSON (default: ./credentials.json)');
    console.log('');
    console.log('Example:');
    console.log('  node downloadGoogleDriveFolder.js 1ABC123xyz ./downloads ./service-account.json');
    process.exit(1);
  }

  const [folderId, outputDir, credentialsPath = './credentials.json'] = args;

  if (!fs.existsSync(credentialsPath)) {
    console.error(`Error: Credentials file not found at ${credentialsPath}`);
    console.error('');
    console.error('To set up credentials:');
    console.error('1. Go to https://console.cloud.google.com');
    console.error('2. Create/select a project and enable Google Drive API');
    console.error('3. Go to "IAM & Admin" > "Service Accounts"');
    console.error('4. Create a service account and download the JSON key');
    console.error('5. Share your Google Drive folder with the service account email');
    process.exit(1);
  }

  try {
    console.log('Authenticating...');
    const auth = await authenticate(credentialsPath);
    const drive = google.drive({ version: 'v3', auth });

    console.log(`Starting download from folder: ${folderId}`);
    console.log(`Output directory: ${path.resolve(outputDir)}`);
    console.log('All files will be saved flat (no subfolders)');
    console.log('');

    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    await downloadFolder(drive, folderId, outputDir);

    console.log('');
    console.log('Download complete!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
