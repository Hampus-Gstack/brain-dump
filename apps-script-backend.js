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

    // Route: Chat mode
    if (data.action === 'chat') {
      return handleChat(data.message);
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

    // Auto-bootstrap: ensure daily digest trigger exists
    ensureDailyTrigger();

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

  const lastRow = sheet.getLastRow();

  // Add status checkbox (unchecked)
  sheet.getRange(lastRow, 10).insertCheckboxes();

  // If there's a thumbnail, add IMAGE formula in the row
  if (attachmentThumbUrl) {
    sheet.getRange(lastRow, 9).setFormula('=IMAGE("' + attachmentThumbUrl + '")');
    sheet.setRowHeight(lastRow, 60);
    sheet.getRange(lastRow, 9).setNote('Open: ' + attachmentUrl);
  }

  // Auto-route journal/thought entries to Journal sheet
  var category = classification.category || 'note';
  if (category === 'journal' || category === 'thought') {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var journalSheet = ss.getSheetByName('Journal');
      if (journalSheet) {
        var dateStr = (timestamp || '').substring(0, 10);
        var timeStr = (timestamp || '').substring(11, 16);
        var emoji = category === 'thought' ? '💭' : '📓';
        journalSheet.appendRow([emoji + ' ' + dateStr + ' ' + timeStr]);
        journalSheet.appendRow([rawText]);
        journalSheet.appendRow(['']); // spacer
      }
    } catch(e) {
      Logger.log('Journal routing error: ' + e.message);
    }
  }
}

// ---- Daily AI Email Digest ----
function sendDailyDigest() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1')
    || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  // Collect unchecked items (column J = false or empty)
  const pending = [];
  for (let i = 1; i < data.length; i++) {
    const status = data[i][9]; // column J
    if (status !== true) {
      pending.push({
        text: data[i][1],  // Raw Text
        category: data[i][2],
        priority: data[i][3],
        summary: data[i][6],
        timestamp: data[i][0]
      });
    }
  }

  if (pending.length === 0) {
    Logger.log('No pending items — skipping digest.');
    return;
  }

  // Build digest with Gemini
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const prompt = `Du är en personlig assistent. Sammanfatta dessa obearbetade brain dump-items till en kort, prioriterad morgonbriefing på svenska. Gruppera efter prioritet (brådskande först). Var koncis men handlingsinriktad.

Items:
${pending.map((p, i) => `${i+1}. [${p.priority}] [${p.category}] ${p.summary || p.text}`).join('\n')}

Svara i ren text, inga markdown-headers. Max 300 ord.`;

  let digestText = '';
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
      }),
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText());
    digestText = result.candidates[0].content.parts[0].text;
  } catch (err) {
    digestText = 'Kunde inte generera AI-sammanfattning. Fel: ' + err.toString();
  }

  // Count by priority
  const highCount = pending.filter(p => p.priority === 'high').length;
  const medCount = pending.filter(p => p.priority === 'medium').length;
  const lowCount = pending.filter(p => p.priority === 'low').length;

  // Build email
  const subject = `🧠 Brain Dump: ${pending.length} obearbetade items (${highCount} brådskande)`;
  const sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();

  const body = `God morgon! 🌅\n\n` +
    `Du har ${pending.length} obearbetade items:\n` +
    `🔴 ${highCount} hög prioritet | 🟡 ${medCount} medium | 🟢 ${lowCount} låg/ingen\n\n` +
    `--- AI Briefing ---\n\n${digestText}\n\n` +
    `--- Öppna Sheet ---\n${sheetUrl}\n\n` +
    `Ha en produktiv dag! 💪`;

  // Send email
  const userEmail = Session.getActiveUser().getEmail();
  MailApp.sendEmail({
    to: userEmail,
    subject: subject,
    body: body
  });

  Logger.log('Digest sent to ' + userEmail + ' with ' + pending.length + ' items.');
}

// ---- Auto-ensure daily trigger (called from doPost) ----
function ensureDailyTrigger() {
  try {
    // Check if trigger already exists
    const triggers = ScriptApp.getProjectTriggers();
    const hasDigest = triggers.some(t => t.getHandlerFunction() === 'sendDailyDigest');
    
    if (!hasDigest) {
      ScriptApp.newTrigger('sendDailyDigest')
        .timeBased()
        .atHour(6)
        .everyDays(1)
        .inTimezone('Europe/Stockholm')
        .create();
      Logger.log('✅ Daily digest trigger auto-created for 06:00 CET.');
    }
  } catch(e) {
    Logger.log('Trigger setup skipped: ' + e.message);
  }
}

// ---- Manual setup (run once if auto doesn't work) ----
function setupDailyTrigger() {
  // Remove existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'sendDailyDigest') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('sendDailyDigest')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone('Europe/Stockholm')
    .create();

  Logger.log('Daily digest trigger set for 06:00 CET.');
}

// ---- Test functions ----
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

function testDigest() {
  sendDailyDigest();
}

// ---- AI Chat Handler ----
function handleChat(message) {
  try {
    // Read active tasks from Sheet
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1')
      || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var data = sheet.getDataRange().getValues();
    
    var tasks = [];
    var doneCount = 0;
    for (var i = 1; i < data.length; i++) {
      var text = (data[i][1] || '').toString().trim();
      if (!text) continue;
      var status = data[i][9];
      if (status === true) { doneCount++; continue; }
      tasks.push({
        row: i + 1,
        text: text,
        category: data[i][2] || '',
        priority: data[i][3] || 'none',
        summary: (data[i][6] || text).toString().substring(0, 100)
      });
    }

    // Build context for Gemini
    var taskList = tasks.map(function(t) {
      var emoji = t.priority === 'high' ? '🔴' : (t.priority === 'medium' ? '🟡' : '⚪');
      return emoji + ' [' + t.priority + '] ' + t.summary;
    }).join('\n');

    var now = new Date();
    var dateStr = now.toISOString().substring(0, 10);
    var dayNames = ['söndag','måndag','tisdag','onsdag','torsdag','fredag','lördag'];
    var dayName = dayNames[now.getDay()];

    var prompt = 'Du är en smart personlig assistent för Hampus. '
      + 'Du har tillgång till hans task-lista. Svara kortfattat och direkt på svenska (eller engelska om han skriver på engelska). '
      + 'Var praktisk och konkret. Använd emoji för tydlighet.\n\n'
      + 'IDAG: ' + dateStr + ' (' + dayName + ')\n'
      + 'AKTIVA TASKS (' + tasks.length + ' st, ' + doneCount + ' klara):\n'
      + taskList + '\n\n'
      + 'ANVÄNDARENS MEDDELANDE:\n' + message;

    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
    
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
      }),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());
    var reply = '';
    
    if (result.candidates && result.candidates[0] && result.candidates[0].content) {
      reply = result.candidates[0].content.parts[0].text;
    } else {
      reply = 'Kunde inte generera svar. Försök igen.';
    }

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'ok', reply: reply })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Chat error: ' + err.toString());
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', reply: 'Fel: ' + err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
