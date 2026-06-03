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

// Mode state: 'task' or 'vault'
let currentMode = 'task';
const modeTask = document.getElementById('modeTask');
const modeVault = document.getElementById('modeVault');

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

    // Mode toggle
    if (modeTask) modeTask.addEventListener('click', () => setMode('task'));
    if (modeVault) modeVault.addEventListener('click', () => setMode('vault'));

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
    
    // iOS Safari doesn't support continuous mode well — detect and adapt
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    recognition.continuous = !isIOS; // disable continuous on iOS
    recognition.interimResults = true;
    recognition.lang = 'sv-SE';

    let accumulatedText = ''; // keep text across recognition restarts
    let silenceTimer = null;

    recognition.onresult = (event) => {
        let interim = '';
        let sessionFinal = '';
        for (let i = 0; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                sessionFinal += event.results[i][0].transcript + ' ';
            } else {
                interim += event.results[i][0].transcript;
            }
        }
        
        // Show live transcription (accumulated + current session)
        const currentText = accumulatedText + sessionFinal + interim;
        input.value = currentText.trim();
        autoResize();

        // On final result, save to accumulated
        if (sessionFinal) {
            accumulatedText += sessionFinal;
        }

        // Reset silence timer
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (input.value.trim() && isListening) {
                stopVoice();
            }
        }, 4000); // 4s silence before auto-stop
    };

    recognition.onerror = (event) => {
        if (event.error === 'not-allowed') {
            // Mic permission denied
            if (voiceBtn) voiceBtn.style.display = 'none';
        }
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
            console.log('Voice error:', event.error);
        }
        // Only stop on real errors, not 'no-speech'
        if (event.error !== 'no-speech') {
            stopVoice();
        }
    };

    recognition.onend = () => {
        if (isListening) {
            // Restart if still listening (iOS stops after each result)
            setTimeout(() => {
                if (isListening) {
                    try { recognition.start(); } catch(e) {}
                }
            }, 100);
        }
    };

    // Reset accumulated text when starting fresh
    recognition._resetAccumulated = () => { accumulatedText = ''; };
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
    if (recognition._resetAccumulated) recognition._resetAccumulated();
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
// ---- Mode Toggle ----
function setMode(mode) {
    currentMode = mode;
    if (modeTask) modeTask.classList.toggle('active', mode === 'task');
    if (modeVault) modeVault.classList.toggle('active', mode === 'vault');
    input.placeholder = mode === 'vault' ? 'Idea, thought, journal...' : 'Dump it...';
    input.focus();
}

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
        secret: CONFIG.DUMP_SECRET,
        mode: currentMode
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

// ---- AI Chat ----
const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatToggle = document.getElementById('chatToggle');
const chatClose = document.getElementById('chatClose');

let chatOpen = false;

function initChat() {
    if (chatToggle) chatToggle.addEventListener('click', toggleChat);
    if (chatClose) chatClose.addEventListener('click', toggleChat);
    if (chatSend) chatSend.addEventListener('click', sendChat);
    if (chatInput) chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
    });
}

function toggleChat() {
    chatOpen = !chatOpen;
    chatPanel.classList.toggle('open', chatOpen);
    if (chatOpen) {
        chatInput.focus();
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function addChatBubble(text, type) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + type;
    bubble.textContent = text;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubble;
}

function addTypingIndicator() {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bot typing';
    bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    bubble.id = 'typingIndicator';
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubble;
}

async function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg) return;

    addChatBubble(msg, 'user');
    chatInput.value = '';
    
    const typing = addTypingIndicator();

    try {
        // Use GET request via doGet — Apps Script returns proper CORS headers
        // on GET after the 302 redirect to googleusercontent.com.
        // POST responses are opaque and unreadable cross-origin.
        const params = new URLSearchParams({
            action: 'chat',
            message: msg,
            secret: CONFIG.DUMP_SECRET
        });
        const response = await fetch(CONFIG.APPS_SCRIPT_URL + '?' + params.toString(), {
            method: 'GET',
            redirect: 'follow'
        });

        let reply = '';
        if (response.ok) {
            try {
                const data = await response.json();
                reply = data.reply || 'Inget svar mottaget.';
            } catch {
                const text = await response.text();
                // Try to extract reply from HTML-wrapped JSON
                const match = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                reply = match ? match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : text.substring(0, 500) || 'Kunde inte tolka svaret.';
            }
        } else {
            reply = `Serverfel (${response.status}). Försök igen.`;
        }

        typing.remove();
        addChatBubble(reply, 'bot');

    } catch (err) {
        typing.remove();
        addChatBubble('Kunde inte ansluta. Kolla internet.', 'bot');
    }
}

// ============================================
//  Mobile Triage View — secured task overview
// ============================================
const TRIAGE_PASS_KEY = 'braindump_triage_pass';
const triagePanel = document.getElementById('triagePanel');
const triageAuth = document.getElementById('triageAuth');
const triageAuthLabel = document.getElementById('triageAuthLabel');
const triageAuthErr = document.getElementById('triageAuthErr');
const triageBody = document.getElementById('triageBody');
const triageCounts = document.getElementById('triageCounts');
const triageListEl = document.getElementById('triageList');
const triagePassInput = document.getElementById('triagePass');

let triageOpen = false;
let triageClaiming = false;

function getTriagePass() { return localStorage.getItem(TRIAGE_PASS_KEY) || ''; }
function setTriagePass(p) { localStorage.setItem(TRIAGE_PASS_KEY, p); }
function clearTriagePass() { localStorage.removeItem(TRIAGE_PASS_KEY); }

// Robust GET → JSON (mirrors chat: parse JSON, fall back to extracting from HTML)
async function triageApi(params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(CONFIG.APPS_SCRIPT_URL + '?' + qs, { method: 'GET', redirect: 'follow' });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch {} }
        return { status: 'error', message: 'parse' };
    }
}

function initTriage() {
    const toggle = document.getElementById('triageToggle');
    const close = document.getElementById('triageClose');
    const refresh = document.getElementById('triageRefresh');
    const lock = document.getElementById('triageLock');
    const enter = document.getElementById('triageEnter');
    const claim = document.getElementById('triageClaim');

    if (toggle) toggle.addEventListener('click', openTriage);
    if (close) close.addEventListener('click', closeTriage);
    if (refresh) refresh.addEventListener('click', loadTriage);
    if (lock) lock.addEventListener('click', () => { clearTriagePass(); showTriageAuth(); });
    if (enter) enter.addEventListener('click', submitTriagePass);
    if (claim) claim.addEventListener('click', () => {
        triageClaiming = !triageClaiming;
        triageAuthLabel.textContent = triageClaiming ? 'Välj ett nytt lösenord (min 4)' : 'Ange lösenord';
        claim.textContent = triageClaiming ? '← Tillbaka' : 'Första gången? Sätt lösenord';
        triageAuthErr.textContent = '';
        triagePassInput.focus();
    });
    if (triagePassInput) triagePassInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitTriagePass();
    });
}

function openTriage() {
    triageOpen = true;
    triagePanel.classList.add('open');
    if (getTriagePass()) loadTriage();
    else showTriageAuth();
}
function closeTriage() {
    triageOpen = false;
    triagePanel.classList.remove('open');
}
function showTriageAuth() {
    triageBody.style.display = 'none';
    triageAuth.style.display = 'flex';
    triageAuthErr.textContent = '';
    triagePassInput.value = '';
    triagePassInput.focus();
}

async function submitTriagePass() {
    const pass = triagePassInput.value.trim();
    if (!pass) return;
    triageAuthErr.textContent = '…';
    if (triageClaiming) {
        const r = await triageApi({ action: 'triage_setpass', secret: CONFIG.DUMP_SECRET, newpass: pass });
        if (r.status === 'ok') {
            setTriagePass(pass);
            triageClaiming = false;
            loadTriage();
        } else {
            triageAuthErr.textContent = r.message === 'unauthorized'
                ? 'Lösenord redan satt — ange det istället.'
                : ('Fel: ' + (r.message || 'okänt'));
        }
    } else {
        // verify by attempting a list
        const r = await triageApi({ action: 'triage_list', pass });
        if (r.status === 'ok') { setTriagePass(pass); renderTriage(r); }
        else triageAuthErr.textContent = 'Fel lösenord (eller inte satt än).';
    }
}

async function loadTriage() {
    const pass = getTriagePass();
    if (!pass) return showTriageAuth();
    triageAuth.style.display = 'none';
    triageBody.style.display = 'block';
    triageListEl.innerHTML = '<p class="triage-empty">Laddar…</p>';
    const r = await triageApi({ action: 'triage_list', pass });
    if (r.status !== 'ok') { clearTriagePass(); return showTriageAuth(); }
    renderTriage(r);
}

function renderTriage(r) {
    triageAuth.style.display = 'none';
    triageBody.style.display = 'block';
    const c = r.counts || {};
    triageCounts.innerHTML =
        `<span class="tc tc-act">🎯 ${c.actionable || 0}</span>` +
        `<span class="tc tc-wait">⏳ ${c.waiting || 0}</span>` +
        `<span class="tc tc-block">🚫 ${c.blocked || 0}</span>` +
        `<span class="tc tc-inbox">📥 ${c.inbox || 0}</span>`;

    const tasks = r.tasks || [];
    if (!tasks.length) { triageListEl.innerHTML = '<p class="triage-empty">Inga aktionerbara tasks 🎉</p>'; return; }
    triageListEl.innerHTML = '';
    tasks.forEach((t) => triageListEl.appendChild(taskCard(t)));
}

function taskCard(t) {
    const card = document.createElement('div');
    card.className = 'task-card prio-' + t.priority;
    const ageTxt = (t.age !== '' && t.age > 14) ? `<span class="task-age">⏳${t.age}d</span>` : '';
    const dupTxt = (t.note && t.note.indexOf('POSSIBLE DUP') === 0) ? `<span class="task-dup">🔁 dup</span>` : '';
    card.innerHTML =
        `<div class="task-main">
            <div class="task-summary">${escapeHtml(t.summary)}</div>
            <div class="task-meta">
                <button class="task-prio" data-prio="${t.priority}">${prioLabel(t.priority)}</button>
                ${ageTxt}${dupTxt}
                <span class="task-tags">${escapeHtml(t.tags || '')}</span>
            </div>
        </div>
        <div class="task-actions">
            <button class="task-btn task-done" title="Klar">✓</button>
            <button class="task-btn task-defer" title="Skjut till nästa vecka">⏭</button>
        </div>`;

    card.querySelector('.task-done').addEventListener('click', () => taskAction(t.row, { op: 'done' }, card));
    card.querySelector('.task-defer').addEventListener('click', () => taskAction(t.row, { op: 'defer' }, card));
    card.querySelector('.task-prio').addEventListener('click', () => {
        const next = nextPrio(t.priority);
        taskAction(t.row, { op: 'prio', value: next }, card, false);
    });
    return card;
}

function prioLabel(p) { return ({ high: '🔴 hög', medium: '🟡 medium', low: '🟢 låg', none: '⚪ none' })[p] || p; }
function nextPrio(p) { return ({ high: 'medium', medium: 'low', low: 'high', none: 'high' })[p] || 'medium'; }

async function taskAction(row, opts, card, removeOnDone = true) {
    card.classList.add('task-busy');
    const r = await triageApi(Object.assign({ action: 'triage_update', pass: getTriagePass(), row }, opts));
    card.classList.remove('task-busy');
    if (r.status !== 'ok') { showError('Kunde inte uppdatera.'); return; }
    if (opts.op === 'done' || opts.op === 'defer') {
        if (removeOnDone) {
            card.classList.add('task-removed');
            setTimeout(() => { card.remove(); loadTriage(); }, 350);
        }
    } else {
        // priority change → reload to re-sort/re-filter
        loadTriage();
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', () => {
    init();
    initChat();
    initTriage();
});
