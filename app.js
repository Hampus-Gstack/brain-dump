/* ============================================
   Brain Dump PWA — App Logic
   ============================================
   Zero-distraction capture → Google Apps Script → 
   Gemini Flash 2.0 classification → Google Sheets
   ============================================ */

// ---- Configuration ----
// Replace this with your deployed Google Apps Script web app URL
const CONFIG = {
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxFv4FaSmWNfycCbgLNlziphLE2YzWaXKHwCSlGY252mix-tDKteeuSXdtLl1-ZhEup/exec',
    GOOGLE_SHEET_URL: 'https://docs.google.com/spreadsheets/d/17IPYUIseVK_qPIJxiYrcxosF7BOdRoHfx905wi8WFx4/edit',
    DUMP_SECRET: '30b2ed0e-038c-4a67-ae04-3bfb97628838',
    SUCCESS_DISPLAY_MS: 1200,
    ERROR_DISPLAY_MS: 3000,
    OFFLINE_QUEUE_KEY: 'braindump_queue'
};

// ---- Auto-update: reload when a new service worker takes over ----
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
    });
}

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

// Voice recognition state
let recognition = null;
let isListening = false;
const voiceBtn = document.getElementById('voiceBtn');
const voicePulse = document.getElementById('voicePulse');

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

    // Voice input
    initVoice();
    if (voiceBtn) voiceBtn.addEventListener('click', toggleVoice);

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

// ---- Voice Input (Web Speech API) ----
function initVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        // Hide mic button if not supported
        if (voiceBtn) voiceBtn.style.display = 'none';
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'sv-SE'; // Default Swedish, auto-detects others

    let finalTranscript = '';
    let silenceTimer = null;

    recognition.onresult = (event) => {
        let interim = '';
        finalTranscript = '';
        for (let i = 0; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
            } else {
                interim += event.results[i][0].transcript;
            }
        }
        // Show live transcription
        input.value = (finalTranscript + interim).trim();
        autoResize();

        // Reset silence timer
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            // Auto-stop after 3s silence if we have text
            if (input.value.trim() && isListening) {
                stopVoice();
            }
        }, 3000);
    };

    recognition.onerror = (event) => {
        if (event.error !== 'aborted') {
            console.log('Voice error:', event.error);
        }
        stopVoice();
    };

    recognition.onend = () => {
        if (isListening) {
            // Restart if still listening (browser may stop)
            try { recognition.start(); } catch(e) {}
        }
    };
}

function toggleVoice() {
    if (isListening) {
        stopVoice();
    } else {
        startVoice();
    }
}

function startVoice() {
    if (!recognition) return;
    isListening = true;
    voiceBtn.classList.add('listening');
    voicePulse.classList.add('active');
    input.placeholder = 'Lyssnar...';
    try {
        recognition.start();
    } catch(e) {
        // Already started
    }
}

function stopVoice() {
    if (!recognition) return;
    isListening = false;
    voiceBtn.classList.remove('listening');
    voicePulse.classList.remove('active');
    input.placeholder = 'Dump it...';
    try {
        recognition.stop();
    } catch(e) {}
}

// ---- Submit Handler ----
async function handleSubmit() {
    // Stop voice if listening
    if (isListening) stopVoice();

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
        const base64 = event.target.result.split(',')[1];
        currentAttachment = {
            name: file.name,
            type: file.type,
            data: base64
        };

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
    fileInput.value = '';
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
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
            text: text,
            timestamp: new Date().toISOString(),
            source: 'pwa',
            secret: CONFIG.DUMP_SECRET
        })
    });
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
