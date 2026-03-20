/**
 * ============================================
 * Brain Dump — Google Apps Script Backend
 * ============================================
 * 
 * HOW TO SET UP:
 * 1. Create a new Google Sheet (this will be your Brain Dump Log)
 * 2. Open Extensions → Apps Script
 * 3. Replace the default code with this entire file
 * 4. Click the gear icon (Project Settings) → Script Properties
 *    Add: GEMINI_API_KEY = your Gemini API key
 *    Add: DUMP_SECRET = 30b2ed0e-038c-4a67-ae04-3bfb97628838
 * 5. Add header row to Sheet1: Timestamp | Raw Text | Category | Priority | Tags | Language | Summary | Source
 * 6. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - Click Deploy → copy the URL
 * 7. Paste the URL into app.js CONFIG.APPS_SCRIPT_URL
 * 
 * CATEGORIES:
 * - todo: actionable task
 * - thought: reflection, insight, observation
 * - journal: personal, emotional, diary-like
 * - idea: creative concept, business idea, opportunity
 * - action: urgent/time-sensitive action
 * - question: something to research or ask  
 * - note: general information to remember
 * ============================================
 */

// ---- Security: validate secret key ----
function validateSecret(data) {
  const expected = PropertiesService.getScriptProperties().getProperty('DUMP_SECRET');
  if (!expected) return true; // No secret set = skip validation
  return data.secret === expected;
}

// ---- Security: rate limiting (100 requests/hour) ----
function checkRateLimit() {
  const cache = CacheService.getScriptCache();
  const key = 'rate_count';
  const count = parseInt(cache.get(key) || '0');
  if (count >= 100) return false;
  cache.put(key, String(count + 1), 3600); // expires in 1 hour
  return true;
}

// ---- Entry point: receive POST requests ----
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Validate secret key
    if (!validateSecret(data)) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Unauthorized' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Rate limit
    if (!checkRateLimit()) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Rate limited' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    const text = data.text;
    const timestamp = data.timestamp || new Date().toISOString();
    const source = data.source || 'unknown';

    if ((!text || text.trim() === '') && !data.attachment) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Empty text' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Handle attachment if present
    let attachmentUrl = '';
    let attachmentThumbUrl = '';
    if (data.attachment && data.attachment.data) {
      const result = uploadToDrive(data.attachment);
      attachmentUrl = result.url;
      attachmentThumbUrl = result.thumbUrl;
    }

    // Classify with Gemini
    const classification = classifyWithGemini(text || 'file attachment');

    // Append to sheet
    appendToSheet(timestamp, text, classification, source, attachmentUrl, attachmentThumbUrl);

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'ok', classification: classification })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ---- Upload file to Google Drive ----
function uploadToDrive(attachment) {
  // Get or create 'Brain Dump Files' folder
  const folderName = 'Brain Dump Files';
  const folders = DriveApp.getFoldersByName(folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

  // Decode base64 and create file
  const blob = Utilities.newBlob(
    Utilities.base64Decode(attachment.data),
    attachment.type,
    attachment.name
  );
  const file = folder.createFile(blob);

  // Make viewable by anyone with link (for IMAGE formula)
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  const url = 'https://drive.google.com/file/d/' + fileId + '/view';
  const thumbUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w200';

  return { url: url, thumbUrl: thumbUrl };
}

// ---- Also handle GET for testing ----
function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', message: 'Brain Dump backend is running.' })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ---- Classify text using Gemini Flash 2.0 ----
function classifyWithGemini(text) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  
  if (!apiKey) {
    Logger.log('GEMINI_API_KEY not set in Script Properties');
    return {
      category: 'note',
      priority: 'none',
      tags: [],
      language: 'unknown',
      summary: text.substring(0, 80)
    };
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;

  const prompt = `You are a classification engine for a personal brain dump / capture system.
Classify the following text entry. The user follows the "5 AM Club" routine and GTD (Getting Things Done) methodology.

Text: "${text}"

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "category": "todo|thought|journal|idea|action|question|note",
  "priority": "high|medium|low|none",
  "tags": ["tag1", "tag2"],
  "language": "en|sv",
  "summary": "one-line summary (max 80 chars, same language as input)"
}

Rules:
- category "action" = urgent, time-sensitive (e.g. "call X today")
- category "todo" = standard task, not urgent
- priority is based on urgency and impact
- tags should be 1-3 keywords capturing the topic
- summary should be a clean, concise version of the input
- detect language: "en" for English, "sv" for Swedish`;

  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048
    }
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());
    
    if (result.candidates && result.candidates[0] && result.candidates[0].content) {
      let responseText = result.candidates[0].content.parts[0].text;
      
      // Strip any markdown code fences if present
      responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      return JSON.parse(responseText);
    }
  } catch (err) {
    Logger.log('Gemini API error: ' + err.toString());
  }

  // Fallback if Gemini fails
  return {
    category: 'note',
    priority: 'none',
    tags: [],
    language: text.match(/[åäöÅÄÖ]/) ? 'sv' : 'en',
    summary: text.substring(0, 80)
  };
}

// ---- Append classified entry to Google Sheet ----
function appendToSheet(timestamp, rawText, classification, source, attachmentUrl, attachmentThumbUrl) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1') 
    || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

  // Check if headers exist, if not add them
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp', 'Raw Text', 'Category', 'Priority', 
      'Tags', 'Language', 'Summary', 'Source', 'Attachment'
    ]);
    
    const headerRange = sheet.getRange(1, 1, 1, 9);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a1a2e');
    headerRange.setFontColor('#e8e8e8');
  }

  // Build attachment cell content
  let attachmentCell = '';
  if (attachmentUrl) {
    attachmentCell = attachmentUrl;
  }

  const row = [
    timestamp,
    rawText,
    classification.category || 'note',
    classification.priority || 'none',
    (classification.tags || []).join(', '),
    classification.language || 'unknown',
    classification.summary || (rawText || '').substring(0, 80),
    source,
    attachmentCell
  ];

  sheet.appendRow(row);

  // If there's a thumbnail, add IMAGE formula in the row
  if (attachmentThumbUrl) {
    const lastRow = sheet.getLastRow();
    // Use IMAGE formula for thumbnail display
    sheet.getRange(lastRow, 9).setFormula('=IMAGE("' + attachmentThumbUrl + '")');
    // Set row height to show thumbnail
    sheet.setRowHeight(lastRow, 60);
    // Add a note with the Drive link for easy access
    sheet.getRange(lastRow, 9).setNote('Open: ' + attachmentUrl);
  }
}

// ---- Test function (run manually in Apps Script editor) ----
function testClassification() {
  const testTexts = [
    'Ring revisor om momsen imorgon',
    'I think our brand positioning needs more focus on lifestyle buyers',
    'Idag vaknade jag 04:55, meditation gick bra. Känner mig fokuserad.',
    'Idea: create a referral program for existing clients'
  ];

  testTexts.forEach(function(text) {
    Logger.log('Input: ' + text);
    const result = classifyWithGemini(text);
    Logger.log('Result: ' + JSON.stringify(result));
    Logger.log('---');
  });
}
