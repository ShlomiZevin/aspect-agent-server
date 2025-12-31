# QVD Reader Utility

This utility allows you to read QVD (QlikView Data) files from Google Drive.

## Features

- List QVD files in a Google Drive folder
- Download QVD files from Google Drive
- Parse QVD file metadata (table name, fields, record count)
- Extract basic structure information from QVD files

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set up Google Drive API

#### Option A: Service Account (Recommended for server applications)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Drive API"
   - Click "Enable"
4. Create a Service Account:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service Account"
   - Fill in the details and create
   - Click on the created service account
   - Go to "Keys" tab > "Add Key" > "Create new key"
   - Choose JSON format and download
5. Share your Google Drive folder with the service account email
   - Right-click on the folder in Google Drive
   - Click "Share"
   - Add the service account email (found in the JSON file as `client_email`)
   - Give it "Viewer" access

#### Option B: OAuth2 (For user authentication)

1. Follow steps 1-3 from Option A
2. Create OAuth 2.0 credentials instead of a Service Account
3. Download the credentials JSON file

### 3. Configure Environment Variables

Add the following to your `.env` file:

```env
# Google Drive API - Service Account
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_PRIVATE_KEY_ID=your-private-key-id
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
GOOGLE_CLIENT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_CLIENT_ID=your-client-id

# Google Drive folder ID (found in the folder URL)
GOOGLE_DRIVE_FOLDER_ID=your-folder-id
```

**To find your Google Drive folder ID:**
- Open the folder in Google Drive
- Look at the URL: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`
- Copy the ID after `/folders/`

## Usage

### Basic Example

```javascript
const QVDReader = require('./utils/qvdReader');

// Initialize with service account credentials
const credentials = {
  type: 'service_account',
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
};

const qvdReader = new QVDReader(credentials);
await qvdReader.initialize();

// List QVD files in a folder
const files = await qvdReader.listQVDFiles(process.env.GOOGLE_DRIVE_FOLDER_ID);
console.log('QVD files:', files);

// Download and read a QVD file
const qvdData = await qvdReader.fetchAndReadQVD(files[0].id);
console.log('Metadata:', qvdData.metadata);
```

### Run Example Script

```bash
node utils/qvdReaderExample.js
```

## API Reference

### `QVDReader`

#### Constructor
```javascript
new QVDReader(credentials)
```
- `credentials`: Google API credentials object

#### Methods

##### `initialize()`
Initialize the Google Drive API client.

```javascript
await qvdReader.initialize();
```

##### `listQVDFiles(folderId)`
List all QVD files in a Google Drive folder.

```javascript
const files = await qvdReader.listQVDFiles('folder-id');
```

**Returns:** Array of file objects with properties:
- `id`: File ID
- `name`: File name
- `size`: File size in bytes
- `modifiedTime`: Last modified timestamp
- `webViewLink`: Link to view in Google Drive

##### `downloadQVDFile(fileId, destinationPath)`
Download a QVD file from Google Drive.

```javascript
const filePath = await qvdReader.downloadQVDFile('file-id', './temp/myfile.qvd');
```

**Parameters:**
- `fileId`: Google Drive file ID
- `destinationPath` (optional): Local path to save the file

**Returns:** Path to the downloaded file

##### `readQVDFile(filePath)`
Read and parse a QVD file.

```javascript
const data = await qvdReader.readQVDFile('./temp/myfile.qvd');
```

**Returns:** Object with:
- `metadata`: Parsed metadata (table name, fields, record count)
- `filePath`: Path to the file

##### `fetchAndReadQVD(fileId)`
Download and read a QVD file in one step.

```javascript
const qvdData = await qvdReader.fetchAndReadQVD('file-id');
```

**Returns:** Same as `readQVDFile()`

## QVD File Format

QVD files consist of:
1. **XML Header**: Contains metadata about the table structure
2. **Binary Data**: Contains the actual data in a compressed format

This utility currently parses the XML header to extract:
- Table name
- Field names and types
- Number of records

For full data extraction, consider using a complete QVD parser library.

## Troubleshooting

### Error: "Invalid QVD file format"
- Ensure the file is a valid QVD file
- Check that the file was downloaded completely

### Error: "Service account does not have access"
- Make sure you've shared the Google Drive folder with the service account email
- Verify the service account has at least "Viewer" permissions

### Error: "Invalid credentials"
- Check that all environment variables are set correctly
- Ensure the private key is properly formatted with `\n` for newlines

## Security Notes

- Never commit your `.env` file or service account credentials to version control
- The `.gitignore` file should include `.env`
- For production, use Google Cloud Secret Manager instead of environment variables

## Integration with Express Server

```javascript
// In your server.js
const QVDReader = require('./utils/qvdReader');

app.get('/api/qvd-files', async (req, res) => {
  try {
    const qvdReader = new QVDReader(credentials);
    await qvdReader.initialize();

    const files = await qvdReader.listQVDFiles(process.env.GOOGLE_DRIVE_FOLDER_ID);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/qvd-data/:fileId', async (req, res) => {
  try {
    const qvdReader = new QVDReader(credentials);
    await qvdReader.initialize();

    const data = await qvdReader.fetchAndReadQVD(req.params.fileId);
    res.json({ data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```
