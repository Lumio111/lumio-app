// === LUMIO ULTIMATE APP ===
let ws, currentUsername = '', currentUserId = '', currentMode = 'general';
let currentDmPartner = null, currentRoomId = 'general', selectedFile = null;
let allUsers = [], allRooms = [], onlineUsers = new Set();
let audioCtx, editingMessageId = null, typingTimeout = null, isTyping = false;
let peerConnection = null, localStream = null, incomingCallData = null;

window.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('lumio_theme') === 'light') document.body.classList.add('light-theme');
    const token = localStorage.getItem('lumio_token');
    const username = localStorage.getItem('lumio_username');
    if (token && username) {
        currentUsername = username;
        document.getElementById('auth-overlay').style.display = 'none';
        document.getElementById('chat-app').style.display = 'flex';
        connectWebSocket(token);
    }
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) splash.classList.add('hidden');
    }, 1500);
});

function showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('login-form').style.display = tab === 'login' ? 'block' : 'none';
    document.getElementById('register-form').style.display = tab === 'register' ? 'block' : 'none';
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('login-error');
    errorMsg.textContent = 'Вход...';
    try {
        const res = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.getElementById('login-username').value, password: document.getElementById('login-password').value })
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('lumio_token', data.token);
            localStorage.setItem('lumio_username', data.username);
            currentUsername = data.username;
            document.getElementById('auth-overlay').style.display = 'none';
            document.getElementById('chat-app').style.display = 'flex';
            requestNotificationPermission();
            connectWebSocket(data.token);
        } else { errorMsg.textContent = data.error || 'Ошибка входа'; }
    } catch (err) { errorMsg.textContent = 'Ошибка сети'; }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('reg-error');
    errorMsg.textContent = 'Регистрация...';
    try {
        const res = await fetch('/api/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.getElementById('reg-username').value, password: document.getElementById('reg-password').value })
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('lumio_token', data.token);
            localStorage.setItem('lumio_username', data.username);
            currentUsername = data.username;
            document.getElementById('auth-overlay').style.display = 'none';
            document.getElementById('chat-app').style.display = 'flex';
            requestNotificationPermission();
            connectWebSocket(data.token);
        } else { errorMsg.textContent = data.error || 'Ошибка регистрации'; }
    } catch (err) { errorMsg.textContent = 'Ошибка сети'; }
});

function logout() {
    localStorage.removeItem('lumio_token');
    localStorage.removeItem('lumio_username');
    if (ws) ws.close();
    location.reload();
}

function connectWebSocket(token) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: token }));
    ws.onmessage = (event) => handleServerMessage(JSON.parse(event.data));
    ws.onclose = () => console.log('Disconnected');
}

function handleServerMessage(msg) {
    switch (msg.type) {
        case 'auth_success':
            currentUserId = msg.userId;
            document.getElementById('chat-title').textContent = 'Общий чат';
            loadGeneralChat();
            break;
        case 'users_list':
            allUsers = msg.users.filter(u => u.username !== currentUsername);
            renderUsersList();
            break;
        case 'rooms_list':
            allRooms = msg.rooms;
            renderRoomsList();
            break;
        case 'user_online': onlineUsers.add(msg.userId); renderUsersList(); break;
        case 'user_offline': onlineUsers.delete(msg.userId); renderUsersList(); break;
        case 'history':
            const messagesDiv = document.getElementById('messages');
            messagesDiv.innerHTML = '';
            msg.messages.forEach(m => appendMessage(m));
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            break;
        case 'chat_message':
            if ((currentMode === 'general' && currentRoomId === 'general') || (currentMode === 'rooms' && currentRoomId === msg.message.roomId)) {
                appendMessage(msg.message);
                document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
                if (msg.message.from !== currentUserId) {
                    playNotificationSound();
                    showBrowserNotification(msg.message.fromName, msg.message.text || '📎 Файл');
                }
            }
            break;
        case 'dm_history':
            currentDmPartner = msg.withUser;
            const dmDiv = document.getElementById('messages');
            dmDiv.innerHTML = '';
            msg.messages.forEach(m => appendMessage(m));
            dmDiv.scrollTop = dmDiv.scrollHeight;
            document.getElementById('chat-title').textContent = `💬 ${msg.withUser.username}`;
            document.getElementById('chat-info').textContent = 'Личная переписка';
            break;
        case 'new_dm':
            if (currentMode === 'dm' && currentDmPartner && currentDmPartner.userId === msg.message.from) {
                appendMessage(msg.message);
                document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            }
            if (msg.message.from !== currentUserId) {
                playNotificationSound();
                showBrowserNotification(msg.message.fromName, msg.message.text || '📎 Файл');
            }
            break;
        case 'reaction_update': updateReactionsInUI(msg.messageId, msg.reactions); break;
        case 'message_edited': updateMessageTextInUI(msg.messageId, msg.newText); break;
        case 'message_deleted': removeMessageFromUI(msg.messageId); break;
        case 'search_results': showSearchResults(msg.messages); break;
        case 'pinned_message': case 'message_pinned': showPinnedMessage(msg.message); break;
        case 'message_unpinned': hidePinnedMessage(); break;
        case 'user_typing': showTypingIndicator(msg.username); break;
        case 'user_stop_typing': hideTypingIndicator(msg.userId); break;
        case 'mention_notification':
            playNotificationSound();
            showBrowserNotification('Вас упомянули!', msg.message.text);
            break;
        case 'chat_export': downloadChatExport(msg.messages); break;
        case 'incoming_call': handleIncomingCall(msg); break;
        case 'call_accept': handleCallAccept(); break;
        case 'call_reject': case 'call_end': handleCallEnd(); break;
        case 'webrtc_offer': case 'webrtc_answer': case 'webrtc_ice': handleWebRTCMessage(msg); break;
    }
}

function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('rooms-section').style.display = 'none';
    document.getElementById('users-section').style.display = 'block';
    if (mode === 'general') {
        currentDmPartner = null; currentRoomId = 'general';
        document.getElementById('chat-title').textContent = 'Общий чат';
        document.getElementById('chat-info').textContent = 'Все пользователи';
        loadGeneralChat();
    } else if (mode === 'dm') {
        document.getElementById('chat-title').textContent = 'Личные сообщения';
        document.getElementById('chat-info').textContent = 'Выберите пользователя';
        document.getElementById('messages').innerHTML = '<div id="empty-state">Выберите пользователя слева</div>';
    } else if (mode === 'rooms') {
        document.getElementById('rooms-section').style.display = 'block';
        document.getElementById('users-section').style.display = 'none';
        document.getElementById('chat-title').textContent = 'Комнаты';
        document.getElementById('chat-info').textContent = 'Выберите комнату';
        document.getElementById('messages').innerHTML = '<div id="empty-state">Выберите комнату слева</div>';
    }
}

function loadGeneralChat() { ws.send(JSON.stringify({ type: 'join_room', roomId: 'general' })); }

function getAvatarHTML(username, size = 42, isOnline = false) {
    const gradients = [
        'linear-gradient(135deg, #e94560 0%, #ff2e63 100%)',
        'linear-gradient(135deg, #4caf50 0%, #8bc34a 100%)',
        'linear-gradient(135deg, #2196f3 0%, #03a9f4 100%)',
        'linear-gradient(135deg, #ff9800 0%, #ffc107 100%)',
        'linear-gradient(135deg, #9c27b0 0%, #e91e63 100%)',
        'linear-gradient(135deg, #00bcd4 0%, #009688 100%)',
        'linear-gradient(135deg, #f44336 0%, #ff5722 100%)',
        'linear-gradient(135deg, #3f51b5 0%, #2196f3 100%)'
    ];
    const initial = username ? username.charAt(0).toUpperCase() : '?';
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    const gradient = gradients[Math.abs(hash) % gradients.length];
    return `<div class="avatar" style="width:${size}px; height:${size}px; background:${gradient}; font-size:${size/2.3}px;">${initial}${isOnline ? '<div class="avatar-online-indicator"></div>' : ''}</div>`;
}

function renderUsersList() {
    const list = document.getElementById('users-list');
    list.innerHTML = '';
    allUsers.forEach(user => {
        const isOnline = onlineUsers.has(user._id);
        const isActive = currentDmPartner && currentDmPartner.userId === user._id;
        const item = document.createElement('div');
        item.className = `user-item ${isActive ? 'active' : ''}`;
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '12px';
        item.style.padding = '12px';
        item.innerHTML = `
            ${getAvatarHTML(user.username, 42, isOnline)}
            <div style="flex:1; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div class="username" style="font-weight:600;">${user.username}</div>
                    <div class="status ${isOnline ? '' : 'offline'}" style="font-size:11px; margin-top:2px;">
                        ${isOnline ? '● В сети' : '○ Оффлайн'}
                    </div>
                </div>
                ${isOnline ? `<button onclick="startCall('${user._id}', 'video'); event.stopPropagation();" style="background:linear-gradient(135deg, #4caf50, #8bc34a); border:none; color:#fff; padding:8px; border-radius:50%; cursor:pointer; font-size:14px; box-shadow:0 2px 8px rgba(76,175,80,0.4); transition:all 0.3s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'">📹</button>` : ''}
            </div>
        `;
        item.onclick = () => openDm(user._id, user.username);
        list.appendChild(item);
    });
}

function renderRoomsList() {
    const list = document.getElementById('rooms-list');
    list.innerHTML = '';
    allRooms.forEach(room => {
        const item = document.createElement('div');
        item.className = `room-item ${currentRoomId === room.id ? 'active' : ''}`;
        item.onclick = () => openRoom(room.id, room.name);
        item.innerHTML = `<div class="name">${room.name}</div><div style="font-size:11px;opacity:0.7">${room.description || 'Без описания'}</div>`;
        list.appendChild(item);
    });
}

function openDm(userId, username) {
    currentMode = 'dm';
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mode-btn')[1].classList.add('active');
    ws.send(JSON.stringify({ type: 'get_dm_history', withUserId: userId }));
    if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

function openRoom(roomId, roomName) {
    currentMode = 'rooms'; currentRoomId = roomId;
    document.getElementById('chat-title').textContent = `🏠 ${roomName}`;
    document.getElementById('chat-info').textContent = 'Групповой чат';
    ws.send(JSON.stringify({ type: 'join_room', roomId: roomId }));
    renderRoomsList();
    if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

function createRoom() {
    const name = prompt('Название комнаты:');
    if (!name) return;
    ws.send(JSON.stringify({ type: 'create_room', name: name, description: prompt('Описание:') || '' }));
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
document.getElementById('message-input').addEventListener('input', () => {
    if (!isTyping) { isTyping = true; ws.send(JSON.stringify({ type: 'typing_start' })); }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { isTyping = false; ws.send(JSON.stringify({ type: 'typing_stop' })); }, 2000);
});

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    if (editingMessageId) {
        ws.send(JSON.stringify({ type: 'edit_message', messageId: editingMessageId, newText: text }));
        input.value = ''; editingMessageId = null;
        input.placeholder = 'Введите сообщение... (@username для упоминания)';
        return;
    }
    if (currentMode === 'general' || currentMode === 'rooms') {
        ws.send(JSON.stringify({ type: 'chat_message', text: text }));
    } else if (currentMode === 'dm' && currentDmPartner) {
        ws.send(JSON.stringify({ type: 'send_dm', toUserId: currentDmPartner.userId, text: text }));
        appendMessage({ id: 'temp_' + Date.now(), from: currentUserId, fromName: currentUsername, text: text, timestamp: Date.now(), reactions: [] });
        document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
    }
    input.value = '';
    ws.send(JSON.stringify({ type: 'typing_stop' }));
    isTyping = false;
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Максимум 10MB'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        selectedFile = { data: e.target.result, name: file.name, size: file.size, type: file.type };
        sendFile();
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function handleVoiceSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('Максимум 5MB'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        selectedFile = { data: e.target.result, name: 'voice_' + Date.now() + '.webm', size: file.size, type: file.type || 'audio/webm' };
        sendFile();
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function sendFile() {
    if (!selectedFile || !ws || ws.readyState !== 1) return;
    let fileType = 'file';
    if (selectedFile.type.startsWith('image/')) fileType = 'image';
    else if (selectedFile.type.startsWith('video/')) fileType = 'video';
    else if (selectedFile.type.startsWith('audio/')) fileType = 'audio';
    const data = { fileType, fileName: selectedFile.name, fileData: selectedFile.data, fileSize: selectedFile.size };
    if (currentMode === 'general' || currentMode === 'rooms') ws.send(JSON.stringify({ type: 'chat_message', ...data }));
    else if (currentMode === 'dm' && currentDmPartner) ws.send(JSON.stringify({ type: 'send_dm', toUserId: currentDmPartner.userId, ...data }));
    selectedFile = null;
}

function appendMessage(msg) {
    const messagesDiv = document.getElementById('messages');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.remove();
    const isOwn = msg.from === currentUserId;
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOwn ? 'own' : ''}`;
    msgDiv.dataset.messageId = msg.id;
    const time = new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    let displayText = (msg.text || '').replace(/@(\w+)/g, '<span class="mention">@$1</span>');
    let content = `<div class="meta">${msg.fromName}</div>`;
    if (displayText) content += `<div class="text">${displayText}</div>`;
    if (msg.edited) content += `<div class="edited">(изменено)</div>`;
    if (msg.fileData) {
        content += '<div class="file-preview">';
        if (msg.fileType === 'image') content += `<img src="${msg.fileData}" onclick="openImageModal('${msg.fileData}')">`;
        else if (msg.fileType === 'video') content += `<video controls src="${msg.fileData}"></video>`;
        else if (msg.fileType === 'audio') content += `<audio controls src="${msg.fileData}"></audio>`;
        else content += `<div class="file-info"><div class="icon">📄</div><div class="details"><div class="name">${msg.fileName}</div><div class="size">${(msg.fileSize/1024).toFixed(1)} KB</div></div><a href="${msg.fileData}" download="${msg.fileName}">Скачать</a></div>`;
        content += '</div>';
    }
    if (msg.reactions && msg.reactions.length > 0) {
        content += '<div class="reactions">';
        const counts = {};
        msg.reactions.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
        Object.keys(counts).forEach(emoji => { content += `<span class="reaction-badge" onclick="addReaction('${msg.id}', '${emoji}')">${emoji} ${counts[emoji]}</span>`; });
        content += '</div>';
    }
    content += `<div class="time">${time}</div>`;
    content += `<div class="actions"><button class="action-btn" onclick="showReactionPicker('${msg.id}')">😊</button>${isOwn ? `<button class="action-btn" onclick="startEdit('${msg.id}')">✏️</button><button class="action-btn" onclick="pinMessage('${msg.id}')">📌</button><button class="action-btn" onclick="deleteMessage('${msg.id}')">🗑️</button>` : ''}</div>`;
    msgDiv.innerHTML = content;
    messagesDiv.appendChild(msgDiv);
}

function showReactionPicker(id) { const emoji = prompt('Эмодзи (👍 ❤️ 😂):'); if (emoji) addReaction(id, emoji); }
function addReaction(id, emoji) { ws.send(JSON.stringify({ type: 'add_reaction', messageId: id, emoji })); }

function updateReactionsInUI(id, reactions) {
    const msgDiv = document.querySelector(`[data-message-id="${id}"]`);
    if (!msgDiv) return;
    let rDiv = msgDiv.querySelector('.reactions');
    if (!rDiv) { rDiv = document.createElement('div'); rDiv.className = 'reactions'; msgDiv.insertBefore(rDiv, msgDiv.querySelector('.time')); }
    if (reactions.length === 0) { rDiv.remove(); return; }
    const counts = {};
    reactions.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
    rDiv.innerHTML = '';
    Object.keys(counts).forEach(emoji => {
        const badge = document.createElement('span');
        badge.className = 'reaction-badge';
        badge.textContent = `${emoji} ${counts[emoji]}`;
        badge.onclick = () => addReaction(id, emoji);
        rDiv.appendChild(badge);
    });
}

function startEdit(id) {
    const msgDiv = document.querySelector(`[data-message-id="${id}"]`);
    if (!msgDiv) return;
    const input = document.getElementById('message-input');
    input.value = msgDiv.querySelector('.text').textContent;
    input.placeholder = 'Редактирование... (Enter - сохранить, Esc - отмена)';
    input.focus();
    editingMessageId = id;
    const escHandler = (e) => {
        if (e.key === 'Escape') { input.value = ''; input.placeholder = 'Введите сообщение...'; editingMessageId = null; document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
}

function deleteMessage(id) { if (confirm('Удалить?')) ws.send(JSON.stringify({ type: 'delete_message', messageId: id })); }
function updateMessageTextInUI(id, newText) {
    const msgDiv = document.querySelector(`[data-message-id="${id}"]`);
    if (!msgDiv) return;
    msgDiv.querySelector('.text').innerHTML = newText.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
    if (!msgDiv.querySelector('.edited')) {
        const edited = document.createElement('div'); edited.className = 'edited'; edited.textContent = '(изменено)';
        msgDiv.insertBefore(edited, msgDiv.querySelector('.time'));
    }
}
function removeMessageFromUI(id) { const el = document.querySelector(`[data-message-id="${id}"]`); if (el) el.remove(); }
function pinMessage(id) { ws.send(JSON.stringify({ type: 'pin_message', messageId: id })); }
function unpinMessage() { ws.send(JSON.stringify({ type: 'unpin_message', roomId: currentRoomId })); }
function showPinnedMessage(msg) { document.getElementById('pinned-text').textContent = msg.text || '📎 Файл'; document.getElementById('pinned-message').style.display = 'block'; }
function hidePinnedMessage() { document.getElementById('pinned-message').style.display = 'none'; }

let typingUsers = new Map();
function showTypingIndicator(username) { typingUsers.set(username, Date.now()); updateTypingDisplay(); }
function hideTypingIndicator(userId) { const u = allUsers.find(x => x._id === userId); if (u) { typingUsers.delete(u.username); updateTypingDisplay(); } }
function updateTypingDisplay() {
    const ind = document.getElementById('typing-indicator');
    if (typingUsers.size === 0) { ind.style.display = 'none'; return; }
    const names = Array.from(typingUsers.keys());
    ind.textContent = names.length === 1 ? `${names[0]} печатает...` : (names.length === 2 ? `${names[0]} и ${names[1]} печатают...` : `${names.length} человек печатают...`);
    ind.style.display = 'block';
}

function toggleSearch() { const s = document.getElementById('search-box'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; if (s.style.display === 'block') document.getElementById('search-input').focus(); }
function searchMessages(e) { if (e.key === 'Enter') { const q = document.getElementById('search-input').value.trim(); if (q) ws.send(JSON.stringify({ type: 'search_messages', query: q })); } }
function showSearchResults(msgs) { const d = document.getElementById('messages'); d.innerHTML = ''; if (msgs.length === 0) { d.innerHTML = '<div id="empty-state">Ничего не найдено</div>'; return; } msgs.forEach(m => appendMessage(m)); }
function exportChat() { ws.send(JSON.stringify({ type: 'export_chat' })); }
function downloadChatExport(msgs) {
    let text = `Экспорт Lumio\n${new Date().toLocaleString('ru-RU')}\n================\n\n`;
    msgs.forEach(m => { text += `[${new Date(m.timestamp).toLocaleString('ru-RU')}] ${m.fromName}: ${m.text || '[файл]'}\n`; });
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `lumio_${new Date().toISOString().slice(0,10)}.txt`; a.click();
}

function toggleEmojiPicker() { const p = document.getElementById('emoji-picker'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
function addEmoji(emoji) { document.getElementById('message-input').value += emoji; document.getElementById('message-input').focus(); document.getElementById('emoji-picker').style.display = 'none'; }
function toggleTheme() { document.body.classList.toggle('light-theme'); localStorage.setItem('lumio_theme', document.body.classList.contains('light-theme') ? 'light' : 'dark'); }
function requestNotificationPermission() { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); }
function playNotificationSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sine'; osc.frequency.value = 800; gain.gain.value = 0.1;
        osc.start(); osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {}
}
function showBrowserNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        const n = new Notification(title, { body }); n.onclick = () => { window.focus(); n.close(); };
    }
}
function openImageModal(src) { document.getElementById('modal-image').src = src; document.getElementById('image-modal').style.display = 'flex'; }
function closeImageModal() { document.getElementById('image-modal').style.display = 'none'; }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
function startCall(targetId, callType = 'video') {
    navigator.mediaDevices.getUserMedia({ video: callType === 'video', audio: true }).then(stream => {
        localStream = stream; document.getElementById('local-video').srcObject = stream;
        peerConnection = new RTCPeerConnection(rtcConfig);
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
        peerConnection.ontrack = (e) => { document.getElementById('remote-video').srcObject = e.streams[0]; };
        peerConnection.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: 'webrtc_ice', targetId, candidate: e.candidate })); };
        peerConnection.createOffer().then(o => peerConnection.setLocalDescription(o)).then(() => ws.send(JSON.stringify({ type: 'webrtc_offer', targetId, offer: peerConnection.localDescription })));
        ws.send(JSON.stringify({ type: 'call_request', targetId, callType }));
        showCallModal(false);
    }).catch(() => alert('Нет доступа к камере/микрофону'));
}
function handleIncomingCall(msg) { incomingCallData = msg; showCallModal(true); }
function acceptCall() {
    navigator.mediaDevices.getUserMedia({ video: incomingCallData.callType === 'video', audio: true }).then(stream => {
        localStream = stream; document.getElementById('local-video').srcObject = stream;
        peerConnection = new RTCPeerConnection(rtcConfig);
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
        peerConnection.ontrack = (e) => { document.getElementById('remote-video').srcObject = e.streams[0]; };
        peerConnection.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: 'webrtc_ice', targetId: incomingCallData.fromId, candidate: e.candidate })); };
        ws.send(JSON.stringify({ type: 'call_accept', targetId: incomingCallData.fromId }));
        document.getElementById('accept-call').style.display = 'none';
        document.getElementById('reject-call').style.display = 'none';
        document.getElementById('end-call').style.display = 'inline-block';
    }).catch(() => alert('Нет доступа к камере/микрофону'));
}
function rejectCall() { ws.send(JSON.stringify({ type: 'call_reject', targetId: incomingCallData.fromId })); hideCallModal(); }
function endCall() {
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    hideCallModal();
}
function handleCallAccept() { document.getElementById('accept-call').style.display = 'none'; document.getElementById('reject-call').style.display = 'none'; document.getElementById('end-call').style.display = 'inline-block'; }
function handleCallEnd() { endCall(); }
function handleWebRTCMessage(msg) {
    if (!peerConnection) return;
    if (msg.type === 'webrtc_offer') peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
    else if (msg.type === 'webrtc_answer') peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
    else if (msg.type === 'webrtc_ice') peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
}
function showCallModal(isIncoming) {
    document.getElementById('call-modal').style.display = 'flex';
    document.getElementById('accept-call').style.display = isIncoming ? 'inline-block' : 'none';
    document.getElementById('reject-call').style.display = isIncoming ? 'inline-block' : 'none';
    document.getElementById('end-call').style.display = isIncoming ? 'none' : 'inline-block';
}
function hideCallModal() {
    document.getElementById('call-modal').style.display = 'none';
    document.getElementById('local-video').srcObject = null;
    document.getElementById('remote-video').srcObject = null;
    incomingCallData = null;
}// === ЭТАП 1: ВИЗУАЛЬНЫЕ ЭФФЕКТЫ ===

// 2. Ripple-эффект для кнопок
function createRipple(event) {
    const button = event.currentTarget;
    const circle = document.createElement('span');
    const diameter = Math.max(button.clientWidth, button.clientHeight);
    const radius = diameter / 2;
    
    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${event.clientX - button.getBoundingClientRect().left - radius}px`;
    circle.style.top = `${event.clientY - button.getBoundingClientRect().top - radius}px`;
    circle.classList.add('ripple');
    
    const ripple = button.getElementsByClassName('ripple')[0];
    if (ripple) {
        ripple.remove();
    }
    
    button.appendChild(circle);
}

// Применяем ripple ко всем кнопкам
document.addEventListener('DOMContentLoaded', () => {
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
        btn.classList.add('ripple-btn');
        btn.addEventListener('click', createRipple);
    });
});

// 8. Кастомный курсор
const cursor = document.createElement('div');
cursor.className = 'custom-cursor';
document.body.appendChild(cursor);

const trail = document.createElement('div');
trail.className = 'custom-cursor-trail';
document.body.appendChild(trail);

let mouseX = 0, mouseY = 0;
let cursorX = 0, cursorY = 0;
let trailX = 0, trailY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
});

function animateCursor() {
    // Плавное следование курсора
    cursorX += (mouseX - cursorX) * 0.2;
    cursorY += (mouseY - cursorY) * 0.2;
    trailX += (mouseX - trailX) * 0.1;
    trailY += (mouseY - trailY) * 0.1;
    
    cursor.style.left = `${cursorX - 10}px`;
    cursor.style.top = `${cursorY - 10}px`;
    trail.style.left = `${trailX - 4}px`;
    trail.style.top = `${trailY - 4}px`;
    
    requestAnimationFrame(animateCursor);
}
animateCursor();

// Увеличение курсора при наведении на интерактивные элементы
document.addEventListener('mouseover', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.classList.contains('user-item') || e.target.classList.contains('room-item')) {
        cursor.classList.add('hover');
    }
});

document.addEventListener('mouseout', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.classList.contains('user-item') || e.target.classList.contains('room-item')) {
        cursor.classList.remove('hover');
    }
});

// 9. Анимированные иконки
document.addEventListener('DOMContentLoaded', () => {
    const icons = document.querySelectorAll('.action-btn, #emoji-btn, #attach-btn, #voice-btn, #send-btn');
    icons.forEach(icon => {
        icon.classList.add('icon-animated');
    });
});