const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

// ============ ПОДКЛЮЧЕНИЕ К MONGODB ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lumio';
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB подключена успешно!'))
    .catch(err => console.error('❌ Ошибка подключения к MongoDB:', err));

// ============ МОДЕЛИ БАЗЫ ДАННЫХ ============
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
    timestamp: Number
});
const Message = mongoose.model('Message', messageSchema);
// ==============================================

// ============ API ДЛЯ РЕГИСТРАЦИИ И ВХОДА ============
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Нужны логин и пароль' });
        
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUser = new User({ username, passwordHash });
        await newUser.save();

        const token = jwt.sign({ userId: newUser._id, username: newUser.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, username });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера при регистрации' });
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
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});
// ==============================================

const users = new Map(); // ws -> { userId, username }
const rooms = new Map(); // roomId -> Set of ws

wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'auth') {
                try {
                    const decoded = jwt.verify(msg.token, JWT_SECRET);
                    ws.userData = { userId: decoded.userId, username: decoded.username };
                    ws.send(JSON.stringify({ type: 'auth_success', username: decoded.username, userId: decoded.userId }));
                    console.log(`✅ User authenticated: ${decoded.username}`);
                    
                    // Обновляем lastSeen
                    await User.findByIdAndUpdate(decoded.userId, { lastSeen: new Date() });
                    
                    // Уведомляем всех о новом пользователе
                    broadcastAll({ type: 'user_online', username: decoded.username, userId: decoded.userId });
                    
                    // Отправляем список всех пользователей
                    const allUsers = await User.find({}, 'username lastSeen').lean();
                    ws.send(JSON.stringify({ type: 'users_list', users: allUsers }));
                } catch (e) {
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
            console.log('❌ Disconnected: ' + ws.userData.username);
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
            
            const members = Array.from(rooms.get(roomId)).map(m => ({ 
                userId: m.userData.userId, 
                username: m.userData.username 
            }));
            ws.send(JSON.stringify({ type: 'room_members', members }));
            broadcast(roomId, { type: 'user_joined', user: { userId: user.userId, username: user.username } }, ws);
            
            const history = await Message.find({ roomId: roomId, isDirect: { $ne: true } }).sort({ timestamp: 1 }).limit(50).lean();
            ws.send(JSON.stringify({ type: 'history', messages: history }));
            break;
            
        case 'chat_message':
            const chatMsg = {
                id: uuidv4(),
                from: user.userId,
                fromName: user.username,
                text: msg.text,
                encrypted: msg.encrypted || false,
                timestamp: Date.now(),
                roomId: ws.roomId,
                isDirect: false
            };
            const newMessage = new Message(chatMsg);
            await newMessage.save();
            broadcast(ws.roomId, { type: 'chat_message', message: chatMsg });
            break;
        
        // ========== ЛИЧНЫЕ СООБЩЕНИЯ ==========
        case 'send_dm':
            const targetUser = await User.findById(msg.toUserId);
            if (!targetUser) return;
            
            const dmMsg = {
                id: uuidv4(),
                from: user.userId,
                fromName: user.username,
                to: msg.toUserId,
                toName: targetUser.username,
                text: msg.text,
                encrypted: msg.encrypted || false,
                timestamp: Date.now(),
                isDirect: true,
                read: false
            };
            const newDm = new Message(dmMsg);
            await newDm.save();
            
            // Отправляем получателю, если он онлайн
            const targetWs = Array.from(users.keys()).find(w => w.userData && w.userData.userId === msg.toUserId);
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: 'new_dm', message: dmMsg }));
            }
            
            // Подтверждаем отправителю
            ws.send(JSON.stringify({ type: 'dm_sent', message: dmMsg }));
            break;
            
        case 'get_dm_history':
            const otherUserId = msg.withUserId;
            const otherUser = await User.findById(otherUserId);
            if (!otherUser) return;
            
            // Загружаем историю переписки между двумя пользователями
            const dmHistory = await Message.find({
                isDirect: true,
                $or: [
                    { from: user.userId, to: otherUserId },
                    { from: otherUserId, to: user.userId }
                ]
            }).sort({ timestamp: 1 }).limit(100).lean();
            
            // Помечаем входящие сообщения как прочитанные
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
            
        case 'get_unread_count':
            const unreadCount = await Message.countDocuments({
                to: user.userId,
                isDirect: true,
                read: false
            });
            ws.send(JSON.stringify({ type: 'unread_count', count: unreadCount }));
            break;
        // ==========================================
            
        case 'typing':
            broadcast(ws.roomId, { type: 'typing', userId: user.userId, username: user.username }, ws);
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
    console.log('  LUMIO ULTIMATE SERVER (WITH DM)');
    console.log('========================================');
    console.log('  HTTP: http://localhost:' + PORT);
    console.log('  WS:   ws://localhost:' + PORT);
    console.log('========================================');
    console.log('');
});