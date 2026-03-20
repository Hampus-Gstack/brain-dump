/* ============================================
   Brain Dump PWA — App Logic
   ============================================
   Zero-distraction capture → Google Apps Script → 
   Gemini Flash 2.0 classification → Google Sheets
   ============================================ */

// ---- Configuration ----
// Replace this with your deployed Google Apps Script web app URL
const CONFIG = {
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwtcKxFpOwHbBvlBNL377JKbYkL9c3PoASxCU8Z6jlMmPFQk1reYK1sY6L2gb8pdj-8/exec',
    GOOGLE_SHEET_URL: 'https://docs.google.com/spreadsheets/d/17IPYUIseVK_qPIJxiYrcxosF7BOdRoHfx905wi8WFx4/edit',
    DUMP_SECRET: '30b2ed0e-038c-4a67-ae04-3bfb97628838',
    SUCCESS_DISPLAY_MS: 1200,
    ERROR_DISPLAY_MS: 3000,
    OFFLINE_QUEUE_KEY: 'braindump_queue'
};

// ---- DOM Elements ----
const input = document.getElementById('dumpInput');
const btn = document.getElementById('dumpBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachmentPreview = document.getElementById('attachmentPreview');
const attachmentThumb = document.getElementById('attachmentThumb');
const attachmentName = document.getElementById('attachmentName');
const removeAttachment = document.getElementById('removeAttachment');
const successOverlay = document.getElementById('successOverlay');
const errorOverlay = document.getElementById('errorOverlay');
const errorText = document.getElementById('errorText');
const logLink = document.getElementById('logLink');
const queueBadge = document.getElementById('queueBadge');
const queueCount = document.getElementById('queueCount');

// Current attachment state
let currentAttachment = null;

// ---- Initialize ----
function init() {
    // Set log link
    logLink.href = CONFIG.GOOGLE_SHEET_URL;
    logLink.target = '_blank';
    logLink.rel = 'noopener';

    // Auto-focus textarea
    input.focus();

    // Auto-resize textarea
    input.addEventListener('input', autoResize);

    // Submit handlers
    btn.addEventListener('click', handleSubmit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    });

    // Attachment handlers
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);
    removeAttachment.addEventListener('click', clearAttachment);

    // Process offline queue when back online
    window.addEventListener('online', processQueue);

    // Show queue count if any
    updateQueueBadge();

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
}

// ---- Auto-resize textarea ----
function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.5) + 'px';
}

// ---- Submit Handler ----
async function handleSubmit() {
    const text = input.value.trim();
    if (!text && !currentAttachment) return;

    // Capture attachment before clearing
    const attachment = currentAttachment;

    // Immediately clear + show success (optimistic UI)
    input.value = '';
    autoResize();
    clearAttachment();
    showSuccess();

    // Build payload
    const payload = {
        text: text || (attachment ? '📎 ' + attachment.name : ''),
        timestamp: new Date().toISOString(),
        source: 'pwa',
        secret: CONFIG.DUMP_SECRET
    };

    if (attachment) {
        payload.attachment = {
            name: attachment.name,
            type: attachment.type,
            data: attachment.data  // base64
        };
    }

    if (navigator.onLine) {
        fetch(CONFIG.APPS_SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        }).catch(() => {
            saveToQueue(text);
            showError('Connection lost. Saved locally.');
        });
    } else {
        saveToQueue(text);
    }

    // Re-focus for rapid consecutive dumps
    setTimeout(() => input.focus(), CONFIG.SUCCESS_DISPLAY_MS + 100);
}

// ---- File Attachment ----
function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Check size (max 8MB)
    if (file.size > 8 * 1024 * 1024) {
        showError('File too large. Max 8MB.');
        fileInput.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        const base64 = event.target.result.split(',')[1]; // strip data:...;base64, prefix
        currentAttachment = {
            name: file.name,
            type: file.type,
            data: base64
        };

        // Show preview
        attachmentName.textContent = file.name;
        if (file.type.startsWith('image/')) {
            attachmentThumb.src = event.target.result;
            attachmentThumb.style.display = 'block';
        } else {
            attachmentThumb.style.display = 'none';
        }
        attachmentPreview.style.display = 'flex';
    };
    reader.readAsDataURL(file);
    fileInput.value = ''; // reset so same file can be re-selected
}

function clearAttachment() {
    currentAttachment = null;
    attachmentPreview.style.display = 'none';
    attachmentThumb.src = '';
    attachmentName.textContent = '';
    fileInput.value = '';
}

// ---- Send to Google Apps Script ----
async function sendToBackend(text) {
    const response = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors', // Apps Script requires no-cors from external origins
        headers: {
            'Content-Type': 'text/plain',
        },
        body: JSON.stringify({
            text: text,
            timestamp: new Date().toISOString(),
            source: 'pwa',
            secret: CONFIG.DUMP_SECRET
        })
    });

    // Note: no-cors means we can't read the response,
    // but Apps Script will still process it
    return true;
}

// ---- Offline Queue ----
function saveToQueue(text) {
    const queue = getQueue();
    queue.push({
        text: text,
        timestamp: new Date().toISOString(),
        source: 'pwa'
    });
    localStorage.setItem(CONFIG.OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    updateQueueBadge();
}

function getQueue() {
    try {
        return JSON.parse(localStorage.getItem(CONFIG.OFFLINE_QUEUE_KEY) || '[]');
    } catch {
        return [];
    }
}

async function processQueue() {
    const queue = getQueue();
    if (queue.length === 0) return;

    const remaining = [];

    for (const item of queue) {
        try {
            await sendToBackend(item.text);
        } catch {
            remaining.push(item);
        }
    }

    localStorage.setItem(CONFIG.OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    updateQueueBadge();

    if (remaining.length === 0 && queue.length > 0) {
        showSuccess();
    }
}

function updateQueueBadge() {
    const queue = getQueue();
    if (queue.length > 0) {
        queueBadge.style.display = 'flex';
        queueCount.textContent = queue.length;
    } else {
        queueBadge.style.display = 'none';
    }
}

// ---- UI Feedback ----
function showSuccess() {
    successOverlay.classList.add('show');
    setTimeout(() => {
        successOverlay.classList.remove('show');
    }, CONFIG.SUCCESS_DISPLAY_MS);
}

function showError(message) {
    errorText.textContent = message;
    errorOverlay.classList.add('show');
    setTimeout(() => {
        errorOverlay.classList.remove('show');
    }, CONFIG.ERROR_DISPLAY_MS);
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', init);
