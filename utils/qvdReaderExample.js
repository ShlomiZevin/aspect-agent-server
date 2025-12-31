/**
 * Example usage of QVDReader utility
 *
 * To use this utility, you need to:
 * 1. Set up Google Drive API credentials (Service Account or OAuth2)
 * 2. Add credentials to .env or use a credentials.json file
 * 3. Get the file ID or folder ID from Google Drive
 */

require('dotenv').config();
const QVDReader = require('./qvdReader');

async function example() {
  try {
    // Option 1: Using Service Account credentials
    const serviceAccountCreds = {
      type: 'service_account',
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    };

    // Initialize reader
    const qvdReader = new QVDReader(serviceAccountCreds);
    await qvdReader.initialize();

    // Example 1: List all QVD files in a specific folder
    const folderId = 'YOUR_GOOGLE_DRIVE_FOLDER_ID'; // Replace with actual folder ID
    console.log('\n📁 Listing QVD files...');
    const files = await qvdReader.listQVDFiles(folderId);

    console.log(`\nFound ${files.length} QVD files:`);
    files.forEach((file, index) => {
      console.log(`${index + 1}. ${file.name} (${file.size} bytes)`);
      console.log(`   ID: ${file.id}`);
      console.log(`   Modified: ${file.modifiedTime}`);
    });

    // Example 2: Download and read a specific QVD file
    if (files.length > 0) {
      const fileId = files[0].id;
      console.log(`\n📥 Downloading and reading: ${files[0].name}`);

      const qvdData = await qvdReader.fetchAndReadQVD(fileId);

      console.log('\n📊 QVD Metadata:');
      console.log('  Table Name:', qvdData.metadata.tableName);
      console.log('  Record Count:', qvdData.metadata.recordCount);
      console.log('  Fields:');
      qvdData.metadata.fields?.forEach((field, idx) => {
        console.log(`    ${idx + 1}. ${field.name} (${field.type})`);
      });
    }

    // Example 3: Download a specific file by ID
    const specificFileId = 'YOUR_FILE_ID'; // Replace with actual file ID
    // const downloadedPath = await qvdReader.downloadQVDFile(specificFileId);
    // const qvdData = await qvdReader.readQVDFile(downloadedPath);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run example if executed directly
if (require.main === module) {
  example();
}

module.exports = example;
