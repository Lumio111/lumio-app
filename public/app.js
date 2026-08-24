// ============ ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ============
let ws;
let currentUsername = '';
let currentUserId = '';
let currentMode = 'general'; // 'general', 'dm', 'rooms'
let currentDmPartner = null;
let currentRoomId = 'general';
let allUsers = [];
let onlineUsers = new Set();
let allRooms = [];
let selectedFile = null;
let audioCtx;
let editingMessageId = null; // ID сообщения, которое сейчас редактируется

// ============ ИНИЦИАЛИЗАЦИЯ ============
window.addEventListener('DOMContentLoaded', () => {
    // Загружаем тему из localStorage
    const savedTheme = localStorage.getItem('lumio_theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }
    
    const token = localStorage.getItem('lumio_token');
    const username = localStorage.getItem('lumio_username');
    
    if (token && username) {
        currentUsername = username;
        document.getElementById('auth-overlay').style.display = 'none';
        document.getElementById('chat-app').style.display = 'flex';
        connectWebSocket(token);
    }
});

// ============ АВТОРИЗАЦИЯ ============
function showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    if (tab === 'login') {
        document.getElementById('login-form').style.display = 'block';
        document.getElementById('register-form').style.display = 'none';
    } else {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
    }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorMsg = document.getElementById('login-error');
    errorMsg.textContent = 'Вход...';

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
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
        } else {
            errorMsg.textContent = data.error || 'Ошибка входа';
        }
    } catch (err) {
        errorMsg.textContent = 'Ошибка сети';
    }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;
    const errorMsg = document.getElementById('reg-error');
    errorMsg.textContent = 'Регистрация...';

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
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
        } else {
            errorMsg.textContent = data.error || 'Ошибка регистрации';
        }
    } catch (err) {
        errorMsg.textContent = 'Ошибка сети';
    }
});

function logout() {
    localStorage.removeItem('lumio_token');
    localStorage.removeItem('lumio_username');
    if (ws) ws.close();
    location.reload();
}

// ============ WEBSOCKET ============
function connectWebSocket(token) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('Connected to server');
        ws.send(JSON.stringify({ type: 'auth', token: token }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
    };

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
        
        case 'user_online':
            onlineUsers.add(msg.userId);
            renderUsersList();
            break;
        
        case 'user_offline':
            onlineUsers.delete(msg.userId);
            renderUsersList();
            break;
        
        case 'history':
            const messagesDiv = document.getElementById('messages');
            messagesDiv.innerHTML = '';
            msg.messages.forEach(m => appendMessage(m));
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            break;
        
        case 'chat_message':
            if (currentMode === 'general' && currentRoomId === 'general') {
                appendMessage(msg.message);
                const messagesDiv = document.getElementById('messages');
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                
                if (msg.message.from !== currentUserId) {
                    playNotificationSound();
                    showBrowserNotification(msg.message.fromName, msg.message.text || '📎 Отправлен файл');
                }
            } else if (currentMode === 'rooms' && currentRoomId === msg.message.roomId) {
                appendMessage(msg.message);
                const messagesDiv = document.getElementById('messages');
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                
                if (msg.message.from !== currentUserId) {
                    playNotificationSound();
                    showBrowserNotification(msg.message.fromName, msg.message.text || '📎 Отправлен файл');
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
                const dmDiv = document.getElementById('messages');
                dmDiv.scrollTop = dmDiv.scrollHeight;
            }
            ws.send(JSON.stringify({ type: 'get_unread_count' }));
            
            if (msg.message.from !== currentUserId) {
                playNotificationSound();
                showBrowserNotification(msg.message.fromName, msg.message.text || '📎 Отправлен файл');
            }
            break;
        
        case 'dm_sent':
            // Сообщение успешно отправлено, показываем его сразу
            break;
        
        // Реакции
        case 'reaction_update':
            updateReactionsInUI(msg.messageId, msg.reactions);
            break;
        
        // Редактирование
        case 'message_edited':
            updateMessageTextInUI(msg.messageId, msg.newText);
            break;
        
        // Удаление
        case 'message_deleted':
            removeMessageFromUI(msg.messageId);
            break;
        
        // Результаты поиска
        case 'search_results':
            showSearchResults(msg.messages);
            break;
    }
}

// ============ ПЕРЕКЛЮЧЕНИЕ РЕЖИМОВ ============
function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    
    document.getElementById('rooms-section').style.display = 'none';
    document.getElementById('users-section').style.display = 'block';
    
    if (mode === 'general') {
        currentDmPartner = null;
        currentRoomId = 'general';
        document.getElementById('chat-title').textContent = 'Общий чат';
        document.getElementById('chat-info').textContent = 'Все пользователи';
        loadGeneralChat();
    } else if (mode === 'dm') {
        document.getElementById('chat-title').textContent = 'Личные сообщения';
        document.getElementById('chat-info').textContent = 'Выберите пользователя';
        document.getElementById('messages').innerHTML = '<div id="empty-state">Выберите пользователя слева для начала переписки</div>';
    } else if (mode === 'rooms') {
        document.getElementById('rooms-section').style.display = 'block';
        document.getElementById('users-section').style.display = 'none';
        document.getElementById('chat-title').textContent = 'Комнаты';
        document.getElementById('chat-info').textContent = 'Выберите комнату';
        document.getElementById('messages').innerHTML = '<div id="empty-state">Выберите комнату слева или создайте новую</div>';
    }
}

function loadGeneralChat() {
    ws.send(JSON.stringify({ type: 'join_room', roomId: 'general' }));
}

// ============ ОТОБРАЖЕНИЕ СПИСКОВ ============
function renderUsersList() {
    const list = document.getElementById('users-list');
    list.innerHTML = '';
    
    allUsers.forEach(user => {
        const isOnline = onlineUsers.has(user._id);
        const isActive = currentDmPartner && currentDmPartner.userId === user._id;
        
        const item = document.createElement('div');
        item.className = `user-item ${isActive ? 'active' : ''}`;
        item.onclick = () => openDm(user._id, user.username);
        
        item.innerHTML = `
            <div>
                <div class="username">${user.username}</div>
                <div class="status ${isOnline ? '' : 'offline'}">${isOnline ? '● онлайн' : '○ оффлайн'}</div>
            </div>
        `;
        list.appendChild(item);
    });
}

function renderRoomsList() {
    const list = document.getElementById('rooms-list');
    list.innerHTML = '';
    
    allRooms.forEach(room => {
        const isActive = currentRoomId === room.id;
        
        const item = document.createElement('div');
        item.className = `room-item ${isActive ? 'active' : ''}`;
        item.onclick = () => openRoom(room.id, room.name);
        
        item.innerHTML = `
            <div class="name">${room.name}</div>
            <div style="font-size: 11px; opacity: 0.7;">${room.description || 'Без описания'}</div>
        `;
        list.appendChild(item);
    });
}

function openDm(userId, username) {
    currentMode = 'dm';
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mode-btn')[1].classList.add('active');
    
    ws.send(JSON.stringify({ type: 'get_dm_history', withUserId: userId }));
    
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
    }
}

function openRoom(roomId, roomName) {
    currentMode = 'rooms';
    currentRoomId = roomId;
    document.getElementById('chat-title').textContent = `🏠 ${roomName}`;
    document.getElementById('chat-info').textContent = 'Групповой чат';
    ws.send(JSON.stringify({ type: 'join_room', roomId: roomId }));
    renderRoomsList();
    
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
    }
}

function createRoom() {
    const name = prompt('Название комнаты:');
    if (!name) return;
    const description = prompt('Описание (необязательно):') || '';
    
    ws.send(JSON.stringify({
        type: 'create_room',
        name: name,
        description: description
    }));
}

// ============ ОТПРАВКА СООБЩЕНИЙ ============
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;

    // Если редактируем сообщение
    if (editingMessageId) {
        ws.send(JSON.stringify({
            type: 'edit_message',
            messageId: editingMessageId,
            newText: text
        }));
        input.value = '';
        editingMessageId = null;
        input.placeholder = 'Введите сообщение...';
        return;
    }

    if (currentMode === 'general') {
        ws.send(JSON.stringify({ type: 'chat_message', text: text }));
    } else if (currentMode === 'dm' && currentDmPartner) {
        ws.send(JSON.stringify({ type: 'send_dm', toUserId: currentDmPartner.userId, text: text }));
        // Сразу показываем свое сообщение
        const tempMsg = {
            id: 'temp_' + Date.now(),
            from: currentUserId,
            fromName: currentUsername,
            text: text,
            timestamp: Date.now(),
            reactions: []
        };
        appendMessage(tempMsg);
        const messagesDiv = document.getElementById('messages');
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    } else if (currentMode === 'rooms' && currentRoomId) {
        // Для комнат используем тот же тип, но с указанием roomId
        ws.send(JSON.stringify({ type: 'chat_message', text: text }));
    }
    
    input.value = '';
}

// ============ ФАЙЛЫ ============
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
        alert('Файл слишком большой. Максимум 10MB.');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        selectedFile = {
            data: e.target.result,
            name: file.name,
            size: file.size,
            type: file.type
        };
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

    const messageData = {
        fileType: fileType,
        fileName: selectedFile.name,
        fileData: selectedFile.data,
        fileSize: selectedFile.size
    };

    if (currentMode === 'general') {
        ws.send(JSON.stringify({ type: 'chat_message', ...messageData }));
    } else if (currentMode === 'dm' && currentDmPartner) {
        ws.send(JSON.stringify({ type: 'send_dm', toUserId: currentDmPartner.userId, ...messageData }));
    } else if (currentMode === 'rooms') {
        ws.send(JSON.stringify({ type: 'chat_message', ...messageData }));
    }
    selectedFile = null;
}

// ============ ОТОБРАЖЕНИЕ СООБЩЕНИЙ ============
function appendMessage(msg) {
    const messagesDiv = document.getElementById('messages');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.remove();
    
    const isOwn = msg.from === currentUserId;
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOwn ? 'own' : ''}`;
    msgDiv.dataset.messageId = msg.id;
    
    const time = new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    
    let content = `<div class="meta">${msg.fromName}</div>`;
    
    if (msg.text) {
        content += `<div class="text">${msg.text}</div>`;
    }
    
    if (msg.edited) {
        content += `<div class="edited">(отредактировано)</div>`;
    }
    
    if (msg.fileData) {
        content += '<div class="file-preview">';
        if (msg.fileType === 'image') {
            content += `<img src="${msg.fileData}" alt="${msg.fileName}" onclick="openImageModal('${msg.fileData}')">`;
        } else if (msg.fileType === 'video') {
            content += `<video controls src="${msg.fileData}"></video>`;
        } else if (msg.fileType === 'audio') {
            content += `<audio controls src="${msg.fileData}"></audio>`;
        } else {
            const sizeKB = (msg.fileSize / 1024).toFixed(1);
            content += `
                <div class="file-info">
                    <div class="icon">📄</div>
                    <div class="details">
                        <div class="name">${msg.fileName}</div>
                        <div class="size">${sizeKB} KB</div>
                    </div>
                    <a href="${msg.fileData}" download="${msg.fileName}">Скачать</a>
                </div>
            `;
        }
        content += '</div>';
    }
    
    // Реакции
    if (msg.reactions && msg.reactions.length > 0) {
        content += '<div class="reactions">';
        const emojiCounts = {};
        msg.reactions.forEach(r => {
            emojiCounts[r.emoji] = (emojiCounts[r.emoji] || 0) + 1;
        });
        Object.keys(emojiCounts).forEach(emoji => {
            content += `<span class="reaction-badge" onclick="addReaction('${msg.id}', '${emoji}')">${emoji} ${emojiCounts[emoji]}</span>`;
        });
        content += '</div>';
    }
    
    content += `<div class="time">${time}</div>`;
    
    // Кнопки действий (только для своих сообщений)
    if (isOwn) {
        content += `
            <div class="actions">
                <button class="action-btn" onclick="showReactionPicker('${msg.id}')">😊</button>
                <button class="action-btn" onclick="startEdit('${msg.id}')">✏️</button>
                <button class="action-btn" onclick="deleteMessage('${msg.id}')">🗑️</button>
            </div>
        `;
    } else {
        content += `
            <div class="actions">
                <button class="action-btn" onclick="showReactionPicker('${msg.id}')">😊</button>
            </div>
        `;
    }
    
    msgDiv.innerHTML = content;
    messagesDiv.appendChild(msgDiv);
}

// ============ РЕАКЦИИ ============
function showReactionPicker(messageId) {
    const emoji = prompt('Введите эмодзи (например: 👍 ❤️ 😂 😮 😢 😡):');
    if (emoji) {
        addReaction(messageId, emoji);
    }
}

function addReaction(messageId, emoji) {
    ws.send(JSON.stringify({
        type: 'add_reaction',
        messageId: messageId,
        emoji: emoji
    }));
}

function updateReactionsInUI(messageId, reactions) {
    const msgDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgDiv) return;
    
    let reactionsDiv = msgDiv.querySelector('.reactions');
    if (!reactionsDiv) {
        reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'reactions';
        const timeDiv = msgDiv.querySelector('.time');
        msgDiv.insertBefore(reactionsDiv, timeDiv);
    }
    
    if (reactions.length === 0) {
        reactionsDiv.remove();
        return;
    }
    
    const emojiCounts = {};
    reactions.forEach(r => {
        emojiCounts[r.emoji] = (emojiCounts[r.emoji] || 0) + 1;
    });
    
    reactionsDiv.innerHTML = '';
    Object.keys(emojiCounts).forEach(emoji => {
        const badge = document.createElement('span');
        badge.className = 'reaction-badge';
        badge.textContent = `${emoji} ${emojiCounts[emoji]}`;
        badge.onclick = () => addReaction(messageId, emoji);
        reactionsDiv.appendChild(badge);
    });
}

// ============ РЕДАКТИРОВАНИЕ И УДАЛЕНИЕ ============
function startEdit(messageId) {
    const msgDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgDiv) return;
    
    const textDiv = msgDiv.querySelector('.text');
    if (!textDiv) return;
    
    const currentText = textDiv.textContent;
    const input = document.getElementById('message-input');
    input.value = currentText;
    input.placeholder = 'Редактирование сообщения... (Enter - сохранить, Esc - отмена)';
    input.focus();
    
    editingMessageId = messageId;
    
    // Добавляем обработчик Esc для отмены
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            input.placeholder = 'Введите сообщение...';
            editingMessageId = null;
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

function deleteMessage(messageId) {
    if (confirm('Удалить это сообщение?')) {
        ws.send(JSON.stringify({
            type: 'delete_message',
            messageId: messageId
        }));
    }
}

function updateMessageTextInUI(messageId, newText) {
    const msgDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgDiv) return;
    
    const textDiv = msgDiv.querySelector('.text');
    if (textDiv) {
        textDiv.textContent = newText;
    }
    
    // Добавляем пометку "(отредактировано)"
    if (!msgDiv.querySelector('.edited')) {
        const edited = document.createElement('div');
        edited.className = 'edited';
        edited.textContent = '(отредактировано)';
        const timeDiv = msgDiv.querySelector('.time');
        msgDiv.insertBefore(edited, timeDiv);
    }
}

function removeMessageFromUI(messageId) {
    const msgDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (msgDiv) {
        msgDiv.remove();
    }
}

// ============ ПОИСК ============
function toggleSearch() {
    const searchBox = document.getElementById('search-box');
    searchBox.style.display = searchBox.style.display === 'none' ? 'block' : 'none';
    if (searchBox.style.display === 'block') {
        document.getElementById('search-input').focus();
    }
}

function searchMessages(event) {
    if (event.key === 'Enter') {
        const query = document.getElementById('search-input').value.trim();
        if (query) {
            ws.send(JSON.stringify({
                type: 'search_messages',
                query: query
            }));
        }
    }
}

function showSearchResults(messages) {
    const messagesDiv = document.getElementById('messages');
    messagesDiv.innerHTML = '';
    
    if (messages.length === 0) {
        messagesDiv.innerHTML = '<div id="empty-state">Ничего не найдено</div>';
        return;
    }
    
    messages.forEach(m => appendMessage(m));
}

// ============ ЭМОДЗИ ============
function toggleEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
}

function addEmoji(emoji) {
    const input = document.getElementById('message-input');
    input.value += emoji;
    input.focus();
    document.getElementById('emoji-picker').style.display = 'none';
}

// ============ ТЕМА ============
function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    localStorage.setItem('lumio_theme', isLight ? 'light' : 'dark');
}

// ============ УВЕДОМЛЕНИЯ ============
function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }
}

function playNotificationSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.type = 'sine';
        oscillator.frequency.value = 800;
        gainNode.gain.value = 0.1;
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.15);
    } catch (e) { console.log("Audio error:", e); }
}

function showBrowserNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        if (document.hidden) {
            const notif = new Notification(title, { body: body });
            notif.onclick = () => {
                window.focus();
                notif.close();
            };
        }
    }
}

// ============ ПРОСМОТР ИЗОБРАЖЕНИЙ ============
function openImageModal(src) {
    document.getElementById('modal-image').src = src;
    document.getElementById('image-modal').style.display = 'flex';
}

function closeImageModal() {
    document.getElementById('image-modal').style.display = 'none';
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}