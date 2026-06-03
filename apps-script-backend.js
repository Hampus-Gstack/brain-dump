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

    // Route: Vault mode (ideas, journal, thoughts)
    const vaultMode = data.mode === 'vault';

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

    // Classify with Gemini (auto-routes ideas/journal/thoughts to Vault/Journal sheets)
    const classification = classifyWithGemini(text || 'file attachment');

    // Append to sheet
    appendToSheet(timestamp, text, classification, source, attachmentUrl, attachmentThumbUrl);

    // Auto-bootstrap: ensure daily triggers exist (digest + archive)
    ensureDailyTrigger();
    ensureArchiveTrigger();

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

// ---- Also handle GET for testing + chat (CORS-friendly) ----
function doGet(e) {
  var params = e.parameter || {};
  
  // Route: Chat via GET (CORS-friendly, responses readable cross-origin)
  if (params.action === 'chat' && params.message) {
    // Validate secret
    if (!validateSecret(params)) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Unauthorized' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    return handleChat(params.message);
  }
  
  // Default: health check
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
  "category": "todo|thought|journal|idea|action|question|note|fragment",
  "priority": "high|medium|low|none",
  "tags": ["tag1", "tag2"],
  "language": "en|sv",
  "summary": "one-line summary (max 80 chars, same language as input)"
}

Rules:
- category "action" = urgent, time-sensitive (e.g. "call X today")
- category "todo" = standard task, not urgent
- category "fragment" = incomplete/unparseable capture with NO clear meaning or action
  (e.g. trails off mid-sentence, a single dangling word, ends in a comma). Be conservative:
  a short but complete thought is NOT a fragment.
- IMPORTANT: if the text contains an imperative verb (ring, kolla, gör, skriv, boka, skicka,
  betala, fixa, call, send, buy, fix) it is a "todo" or "action" — never "note".
- "note" = pure reference/info to remember, with no action.
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

// ---- Near-duplicate detection helpers ----
function bd_normalize(s) {
  return (s || '').toString().toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function bd_tokenSet(s) {
  var set = {};
  bd_normalize(s).split(' ').forEach(function (w) { if (w.length > 2) set[w] = 1; });
  return set;
}
function bd_jaccard(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  if (!ka.length || !kb.length) return 0;
  var inter = 0;
  ka.forEach(function (w) { if (b[w]) inter++; });
  var uni = ka.length + kb.length - inter;
  return uni ? inter / uni : 0;
}
// Returns a 'POSSIBLE DUP: rad N — ...' string if the new capture closely matches
// a recent active row, else ''. Scans the last ~60 rows only. Flag is advisory.
function findPossibleDuplicate(sheet, rawText, summary) {
  try {
    var newSet = bd_tokenSet(summary + ' ' + rawText);
    if (Object.keys(newSet).length < 2) return '';
    var data = sheet.getDataRange().getValues();
    var start = Math.max(1, data.length - 60);
    for (var i = data.length - 1; i >= start; i--) {
      if (data[i][9] === true) continue; // skip done
      var existSet = bd_tokenSet((data[i][6] || '') + ' ' + (data[i][1] || ''));
      if (bd_jaccard(newSet, existSet) >= 0.6) {
        return 'POSSIBLE DUP: rad ' + (i + 1) + ' — ' +
          (data[i][6] || data[i][1] || '').toString().substring(0, 50);
      }
    }
  } catch (e) {
    Logger.log('dup check error: ' + e.message);
  }
  return '';
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

  var category = classification.category || 'note';
  var summary = classification.summary || (rawText || '').substring(0, 80);

  // Near-duplicate detection (non-blocking flag in column K)
  var dupNote = findPossibleDuplicate(sheet, rawText, summary);

  const row = [
    timestamp,
    rawText,
    category,
    classification.priority || 'none',
    (classification.tags || []).join(', '),
    classification.language || 'unknown',
    summary,
    source,
    attachmentCell
  ];

  sheet.appendRow(row);

  const lastRow = sheet.getLastRow();

  // Status checkbox. Reference captures (journal/thought/idea/fragment) are NOT
  // active tasks — auto-complete them so the nightly archive sweeps them out and
  // they never clutter the active list. They are still logged here + routed to
  // Journal/Vault below, so nothing is lost.
  var isReference = (category === 'journal' || category === 'thought' ||
                     category === 'idea' || category === 'fragment');
  sheet.getRange(lastRow, 10).insertCheckboxes();
  if (isReference) sheet.getRange(lastRow, 10).setValue(true);

  // Near-duplicate flag → column K
  if (dupNote) sheet.getRange(lastRow, 11).setValue(dupNote);

  // If there's a thumbnail, add IMAGE formula in the row
  if (attachmentThumbUrl) {
    sheet.getRange(lastRow, 9).setFormula('=IMAGE("' + attachmentThumbUrl + '")');
    sheet.setRowHeight(lastRow, 60);
    sheet.getRange(lastRow, 9).setNote('Open: ' + attachmentUrl);
  }

  // Auto-route journal/thought entries to Journal sheet
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

  // Auto-route ideas to Vault sheet
  if (category === 'idea') {
    try {
      var ss2 = SpreadsheetApp.getActiveSpreadsheet();
      var vaultSheet = ss2.getSheetByName('Vault');
      if (!vaultSheet) {
        vaultSheet = ss2.insertSheet('Vault');
        vaultSheet.appendRow(['Date', 'Idea', 'Tags', 'Status']);
        vaultSheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#e8e8e8');
      }
      var dateStr2 = (timestamp || '').substring(0, 10);
      vaultSheet.appendRow([dateStr2, rawText, (classification.tags || []).join(', '), 'parked']);
    } catch(e2) {
      Logger.log('Vault routing error: ' + e2.message);
    }
  }
}

// ---- Daily AI Email Digest ----
function sendDailyDigest() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1')
    || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  // Collect unchecked items (column J = false or empty), split actionable vs inbox.
  // Actionable = the daily-brief surface: high/medium priority, or category 'action'.
  // Inbox = low/none/notes/reflections — collapsed to a count, not dumped in the email.
  const actionable = [];
  const inbox = [];
  for (let i = 1; i < data.length; i++) {
    const status = data[i][9]; // column J
    if (status === true) continue;
    const item = {
      text: data[i][1],
      category: (data[i][2] || '').toLowerCase(),
      priority: (data[i][3] || 'none').toLowerCase(),
      deps: (data[i][10] || '').toString(),  // column K
      summary: data[i][6],
      timestamp: data[i][0]
    };
    // Exclude blocked items from the actionable surface entirely
    const blocked = item.deps.indexOf('BLOCKED:') === 0;
    const isActionable = !blocked && (item.priority === 'high' || item.priority === 'medium' || item.category === 'action');
    (isActionable ? actionable : inbox).push(item);
  }

  if (actionable.length === 0 && inbox.length === 0) {
    Logger.log('No pending items — skipping digest.');
    return;
  }

  // Build digest with Gemini — from ACTIONABLE only
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const pending = actionable; // keep downstream counts referencing the actionable surface
  const prompt = `Du är en personlig assistent. Sammanfatta dessa AKTIONERBARA brain dump-items till en kort, prioriterad morgonbriefing på svenska. Gruppera efter prioritet (brådskande först). Rekommendera max 3 MITs (viktigaste tasks idag). Var koncis och handlingsinriktad.

Items:
${actionable.map((p, i) => `${i+1}. [${p.priority}] [${p.category}] ${p.summary || p.text}`).join('\n')}

Svara i ren text, inga markdown-headers. Max 250 ord.`;

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

  // Count by priority (within the actionable surface)
  const highCount = actionable.filter(p => p.priority === 'high').length;
  const medCount = actionable.filter(p => p.priority === 'medium').length;

  // Build email — actionable up top, inbox collapsed to a count
  const subject = `🧠 Brain Dump: ${actionable.length} aktionerbara (${highCount} brådskande) · ${inbox.length} i inbox`;
  const sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();

  const body = `God morgon! 🌅\n\n` +
    `🎯 ${actionable.length} aktionerbara: 🔴 ${highCount} hög | 🟡 ${medCount} medium\n` +
    `📥 ${inbox.length} i inbox (låg/ingen prio + notes) — processa i weekly review\n\n` +
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

// ---- Archive: move done rows (J=TRUE) out of Sheet1 into Archive tab ----
// Keeps Sheet1 = active work only. Runs daily at 05:00 (before the 06:00 digest).
function archiveDoneRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Sheet1') || ss.getSheets()[0];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  var header = data[0];

  // Ensure Archive tab exists with header
  var archive = ss.getSheetByName('Archive');
  if (!archive) {
    archive = ss.insertSheet('Archive');
    archive.appendRow(header.concat(['ArchivedFrom']));
    archive.getRange(1, 1, 1, header.length + 1)
      .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#e8e8e8');
  }

  // Collect done rows (column J index 9 === true), bottom-up for safe deletion
  var doneRows = [];   // [{rowNum, values}]
  for (var i = 1; i < data.length; i++) {
    if (data[i][9] === true) {
      doneRows.push({ rowNum: i + 1, values: data[i] });
    }
  }
  if (doneRows.length === 0) {
    Logger.log('archiveDoneRows: nothing to archive.');
    return;
  }

  // Append to Archive (preserve original row ref)
  var payload = doneRows.map(function (d) {
    return d.values.concat(['Sheet1!row' + d.rowNum]);
  });
  archive.getRange(archive.getLastRow() + 1, 1, payload.length, payload[0].length)
    .setValues(payload);

  // Delete from Sheet1, descending so indices stay valid
  doneRows.sort(function (a, b) { return b.rowNum - a.rowNum; });
  doneRows.forEach(function (d) { sheet.deleteRow(d.rowNum); });

  Logger.log('archiveDoneRows: moved ' + doneRows.length + ' rows to Archive.');
}

// ---- Auto-ensure daily archive trigger (called from doPost) ----
function ensureArchiveTrigger() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var has = triggers.some(function (t) { return t.getHandlerFunction() === 'archiveDoneRows'; });
    if (!has) {
      ScriptApp.newTrigger('archiveDoneRows')
        .timeBased().atHour(5).everyDays(1)
        .inTimezone('Europe/Stockholm').create();
      Logger.log('✅ Daily archive trigger auto-created for 05:00 CET.');
    }
  } catch (e) {
    Logger.log('Archive trigger setup skipped: ' + e.message);
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
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
    
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
