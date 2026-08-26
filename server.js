const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '50mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lumio';
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB подключена успешно!'))
    .catch(err => console.error('❌ Ошибка подключения к MongoDB:', err));

// Модели
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    publicKey: { type: String, default: '' },
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    id: String,
    roomId: String,
    from: String,
    fromName: String,
    to: String,
    toName: String,
    text: String,
    encrypted: Boolean,
    isDirect: Boolean,
    read: { type: Boolean, default: false },
    timestamp: Number,
    fileType: String,
    fileName: String,
    fileData: String,
    fileSize: Number,
    reactions: [{ userId: String, emoji: String }],
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    mentions: [String] // Массив упомянутых userId
});
const Message = mongoose.model('Message', messageSchema);

const roomSchema = new mongoose.Schema({
    id: String,
    name: String,
    description: String,
    createdBy: String,
    createdAt: Number,
    isPrivate: { type: Boolean, default: false },
    pinnedMessageId: String // ID закрепленного сообщения
});
const Room = mongoose.model('Room', roomSchema);

// API
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Нужны логин и пароль' });
        
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Пользователь уже существует' });

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUser = new User({ username, passwordHash });
        await newUser.save();

        const token = jwt.sign({ userId: newUser._id, username: newUser.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, username });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        
        if (!user) return res.status(400).json({ error: 'Неверный логин или пароль' });

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) return res.status(400).json({ error: 'Неверный логин или пароль' });

        await User.findByIdAndUpdate(user._id, { lastSeen: new Date() });
        const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, username });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

const users = new Map();
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
         if (msg.type === 'auth') {
    try {
        let userId, username;
        
        // === НОВАЯ ЛОГИКА: Поддержка Firebase UID ===
        try {
            // Пробуем старый способ (JWT)
            const decoded = jwt.verify(msg.token, JWT_SECRET);
            userId = decoded.userId;
            username = decoded.username;
        } catch (jwtError) {
            // Если JWT не сработал, проверяем, это Firebase UID
            if (msg.token && msg.token.length > 20) {
                // Это Firebase UID! Используем его как userId
                userId = msg.token;
                username = msg.token.substring(0, 10); // Берем первые 10 символов как имя
                
                // Ищем или создаем пользователя в базе
                let user = await User.findOne({ username: username });
                if (!user) {
                    user = new User({
                        username: username,
                        password: 'firebase_user', // Специальный маркер
                        lastSeen: new Date()
                    });
                    await user.save();
                }
                userId = user._id.toString(); // Используем MongoDB ID
            } else {
                throw new Error('Invalid token');
            }
        }
        
        ws.userData = { userId: userId, username: username };
        ws.send(JSON.stringify({ type: 'auth_success', username: username, userId: userId }));
        
        await User.findByIdAndUpdate(userId, { lastSeen: new Date() });
        broadcastAll({ type: 'user_online', username: username, userId: userId });
        
        const allUsers = await User.find({}, 'username lastSeen').lean();
        ws.send(JSON.stringify({ type: 'users_list', users: allUsers }));
        
        const allRooms = await Room.find({}).lean();
        ws.send(JSON.stringify({ type: 'rooms_list', rooms: allRooms }));
    } catch (e) {
        console.error('Auth error:', e);
        ws.send(JSON.stringify({ type: 'auth_error' }));
        ws.close();
    }
    return;
}
            if (!ws.userData) {
                ws.close();
                return;
            }

            await handleMessage(ws, msg);
        } catch (e) {
            console.error('Error:', e);
        }
    });
    
    ws.on('close', async () => {
        if (ws.userData) {
            broadcastAll({ type: 'user_offline', userId: ws.userData.userId });
            rooms.forEach((members, roomId) => {
                if (members.has(ws)) {
                    members.delete(ws);
                    broadcast(roomId, { type: 'user_left', userId: ws.userData.userId, username: ws.userData.username });
                }
            });
        }
    });
});

async function handleMessage(ws, msg) {
    const user = ws.userData;
    switch (msg.type) {
        case 'join_room':
            const roomId = msg.roomId;
            if (!rooms.has(roomId)) rooms.set(roomId, new Set());
            rooms.get(roomId).add(ws);
            ws.roomId = roomId;
            
            const history = await Message.find({ roomId: roomId, isDirect: { $ne: true }, deleted: { $ne: true } }).sort({ timestamp: 1 }).limit(50).lean();
            ws.send(JSON.stringify({ type: 'history', messages: history }));
            
            // Отправляем закрепленное сообщение если есть
            const room = await Room.findOne({ id: roomId }).lean();
            if (room && room.pinnedMessageId) {
                const pinnedMsg = await Message.findOne({ id: room.pinnedMessageId }).lean();
                if (pinnedMsg) {
                    ws.send(JSON.stringify({ type: 'pinned_message', message: pinnedMsg }));
                }
            }
            break;
            
        case 'chat_message':
            // Парсим упоминания @username
            const mentionRegex = /@(\w+)/g;
            const mentions = [];
            let match;
            while ((match = mentionRegex.exec(msg.text)) !== null) {
                const mentionedUser = await User.findOne({ username: match[1] });
                if (mentionedUser) {
                    mentions.push(mentionedUser._id.toString());
                }
            }
            
            const chatMsg = {
                id: uuidv4(),
                from: user.userId,
                fromName: user.username,
                text: msg.text || '',
                encrypted: msg.encrypted || false,
                timestamp: Date.now(),
                roomId: ws.roomId,
                isDirect: false,
                fileType: msg.fileType || null,
                fileName: msg.fileName || null,
                fileData: msg.fileData || null,
                fileSize: msg.fileSize || null,
                reactions: [],
                edited: false,
                deleted: false,
                pinned: false,
                mentions: mentions
            };
            const newMessage = new Message(chatMsg);
            await newMessage.save();
            broadcast(ws.roomId, { type: 'chat_message', message: chatMsg });
            
            // Уведомляем упомянутых пользователей
            mentions.forEach(mentionedUserId => {
                const mentionedWs = Array.from(users.keys()).find(w => w.userData && w.userData.userId === mentionedUserId);
                if (mentionedWs && mentionedWs.readyState === 1) {
                    mentionedWs.send(JSON.stringify({ type: 'mention_notification', message: chatMsg }));
                }
            });
            break;
        
        case 'send_dm':
            const targetUser = await User.findById(msg.toUserId);
            if (!targetUser) return;
            
            const dmMsg = {
                id: uuidv4(),
                from: user.userId,
                fromName: user.username,
                to: msg.toUserId,
                toName: targetUser.username,
                text: msg.text || '',
                encrypted: msg.encrypted || false,
                timestamp: Date.now(),
                isDirect: true,
                read: false,
                fileType: msg.fileType || null,
                fileName: msg.fileName || null,
                fileData: msg.fileData || null,
                fileSize: msg.fileSize || null,
                reactions: [],
                edited: false,
                deleted: false,
                pinned: false,
                mentions: []
            };
            const newDm = new Message(dmMsg);
            await newDm.save();
            
            const targetWs = Array.from(users.keys()).find(w => w.userData && w.userData.userId === msg.toUserId);
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: 'new_dm', message: dmMsg }));
            }
            
            ws.send(JSON.stringify({ type: 'dm_sent', message: dmMsg }));
            break;
            
        case 'get_dm_history':
            const otherUserId = msg.withUserId;
            const otherUser = await User.findById(otherUserId);
            if (!otherUser) return;
            
            const dmHistory = await Message.find({
                isDirect: true,
                deleted: { $ne: true },
                $or: [
                    { from: user.userId, to: otherUserId },
                    { from: otherUserId, to: user.userId }
                ]
            }).sort({ timestamp: 1 }).limit(100).lean();
            
            await Message.updateMany(
                { from: otherUserId, to: user.userId, read: false },
                { read: true }
            );
            
            ws.send(JSON.stringify({ 
                type: 'dm_history', 
                messages: dmHistory,
                withUser: { userId: otherUserId, username: otherUser.username }
            }));
            break;
        
        case 'add_reaction':
            const reactionMsg = await Message.findById(msg.messageId);
            if (!reactionMsg) return;
            
            const existingReaction = reactionMsg.reactions.find(r => r.userId === user.userId && r.emoji === msg.emoji);
            if (existingReaction) {
                reactionMsg.reactions = reactionMsg.reactions.filter(r => !(r.userId === user.userId && r.emoji === msg.emoji));
            } else {
                reactionMsg.reactions.push({ userId: user.userId, emoji: msg.emoji });
            }
            await reactionMsg.save();
            
            if (reactionMsg.isDirect) {
                const dmTarget = Array.from(users.keys()).find(w => w.userData && w.userData.userId === reactionMsg.from);
                if (dmTarget) dmTarget.send(JSON.stringify({ type: 'reaction_update', messageId: msg.messageId, reactions: reactionMsg.reactions }));
            } else {
                broadcast(reactionMsg.roomId, { type: 'reaction_update', messageId: msg.messageId, reactions: reactionMsg.reactions });
            }
            break;
        
        case 'edit_message':
            const editMsg = await Message.findById(msg.messageId);
            if (!editMsg || editMsg.from !== user.userId) return;
            
            editMsg.text = msg.newText;
            editMsg.edited = true;
            await editMsg.save();
            
            if (editMsg.isDirect) {
                const editTarget = Array.from(users.keys()).find(w => w.userData && w.userData.userId === editMsg.to);
                if (editTarget) editTarget.send(JSON.stringify({ type: 'message_edited', messageId: msg.messageId, newText: msg.newText }));
            } else {
                broadcast(editMsg.roomId, { type: 'message_edited', messageId: msg.messageId, newText: msg.newText });
            }
            ws.send(JSON.stringify({ type: 'message_edited', messageId: msg.messageId, newText: msg.newText }));
            break;
        
        case 'delete_message':
            const deleteMsg = await Message.findById(msg.messageId);
            if (!deleteMsg || deleteMsg.from !== user.userId) return;
            
            deleteMsg.deleted = true;
            await deleteMsg.save();
            
            if (deleteMsg.isDirect) {
                const deleteTarget = Array.from(users.keys()).find(w => w.userData && w.userData.userId === deleteMsg.to);
                if (deleteTarget) deleteTarget.send(JSON.stringify({ type: 'message_deleted', messageId: msg.messageId }));
            } else {
                broadcast(deleteMsg.roomId, { type: 'message_deleted', messageId: msg.messageId });
            }
            ws.send(JSON.stringify({ type: 'message_deleted', messageId: msg.messageId }));
            break;
        
        case 'pin_message':
            const pinMsg = await Message.findById(msg.messageId);
            if (!pinMsg) return;
            
            const roomToPin = await Room.findOne({ id: pinMsg.roomId });
            if (roomToPin) {
                roomToPin.pinnedMessageId = pinMsg.id;
                await roomToPin.save();
            }
            
            broadcast(pinMsg.roomId, { type: 'message_pinned', message: pinMsg });
            break;
        
        case 'unpin_message':
            const roomToUnpin = await Room.findOne({ id: msg.roomId });
            if (roomToUnpin) {
                roomToUnpin.pinnedMessageId = null;
                await roomToUnpin.save();
            }
            broadcast(msg.roomId, { type: 'message_unpinned' });
            break;
        
        case 'create_room':
            const newRoom = new Room({
                id: uuidv4(),
                name: msg.name,
                description: msg.description || '',
                createdBy: user.userId,
                createdAt: Date.now(),
                isPrivate: msg.isPrivate || false
            });
            await newRoom.save();
            
            const allRooms = await Room.find({}).lean();
            broadcastAll({ type: 'rooms_list', rooms: allRooms });
            break;
        
        case 'search_messages':
            const searchResults = await Message.find({
                roomId: ws.roomId,
                text: { $regex: msg.query, $options: 'i' },
                deleted: { $ne: true }
            }).limit(20).lean();
            ws.send(JSON.stringify({ type: 'search_results', messages: searchResults }));
            break;
        
        case 'export_chat':
            const exportMessages = await Message.find({
                roomId: ws.roomId,
                deleted: { $ne: true }
            }).sort({ timestamp: 1 }).lean();
            ws.send(JSON.stringify({ type: 'chat_export', messages: exportMessages }));
            break;
        
        // Индикатор "печатает..."
        case 'typing_start':
            broadcast(ws.roomId, { type: 'user_typing', userId: user.userId, username: user.username }, ws);
            break;
        
        case 'typing_stop':
            broadcast(ws.roomId, { type: 'user_stop_typing', userId: user.userId }, ws);
            break;
        
        // WebRTC для видеозвонков
        case 'call_request':
            const callee = Array.from(users.keys()).find(w => w.userData && w.userData.userId === msg.targetId);
            if (callee) {
                callee.send(JSON.stringify({ 
                    type: 'incoming_call', 
                    fromId: user.userId, 
                    fromName: user.username,
                    callType: msg.callType || 'video'
                }));
            }
            break;
        
        case 'call_accept':
        case 'call_reject':
        case 'call_end':
            const peer = Array.from(users.keys()).find(w => w.userData && w.userData.userId === msg.targetId);
            if (peer) {
                peer.send(JSON.stringify({ ...msg, fromId: user.userId }));
            }
            break;
        
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'webrtc_ice':
            const target = Array.from(users.keys()).find(w => w.userData && w.userData.userId === msg.targetId);
            if (target) {
                target.send(JSON.stringify({ ...msg, fromId: user.userId }));
            }
            break;
    }
}

function broadcast(roomId, data, except = null) {
    const members = rooms.get(roomId);
    if (!members) return;
    const str = JSON.stringify(data);
    members.forEach(member => {
        if (member !== except && member.readyState === 1) member.send(str);
    });
}

function broadcastAll(data) {
    const str = JSON.stringify(data);
    users.forEach((userData, ws) => {
        if (ws.readyState === 1) ws.send(str);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  LUMIO ULTIMATE SERVER (MEGA UPDATE)');
    console.log('========================================');
    console.log('  HTTP: http://localhost:' + PORT);
    console.log('  WS:   ws://localhost:' + PORT);
    console.log('========================================');
    console.log('');
});