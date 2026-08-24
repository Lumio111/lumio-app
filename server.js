const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json()); // Нужно для обработки JSON в запросах регистрации/входа
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
// Модель Пользователя
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    publicKey: { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

// Модель Сообщения
const messageSchema = new mongoose.Schema({
    id: String,
    roomId: String,
    from: String,
    fromName: String,
    text: String,
    encrypted: Boolean,
    timestamp: Number
});
const Message = mongoose.model('Message', messageSchema);
// ==============================================

// ============ API ДЛЯ РЕГИСТРАЦИИ И ВХОДА ============
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Нужны логин и пароль' });
        
        // Проверяем, есть ли уже такой пользователь
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });

        // Шифруем пароль
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Создаем пользователя
        const newUser = new User({ username, passwordHash });
        await newUser.save();

        // Создаем JWT токен
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

        // Проверяем пароль
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) return res.status(400).json({ error: 'Неверный логин или пароль' });

        const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, username });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});
// ==============================================

const users = new Map(); // WebSocket подключения: ws -> { userId, username, socketId }
const rooms = new Map();

wss.on('connection', (ws) => {
    // Теперь мы будем ждать, пока клиент отправит токен для идентификации
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            // Если это первое сообщение с токеном
            if (msg.type === 'auth') {
                try {
                    const decoded = jwt.verify(msg.token, JWT_SECRET);
                    ws.userData = { userId: decoded.userId, username: decoded.username };
                    ws.send(JSON.stringify({ type: 'auth_success', username: decoded.username }));
                    console.log(`User authenticated: ${decoded.username}`);
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'auth_error' }));
                    ws.close();
                }
                return;
            }

            if (!ws.userData) {
                ws.close(); // Отключаем, если не прошел аутентификацию
                return;
            }

            await handleMessage(ws, msg);
        } catch (e) {
            console.error('Error:', e);
        }
    });
    
    ws.on('close', () => {
        if (ws.userData) {
            console.log('Disconnected: ' + ws.userData.username);
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
        case 'set_public_key':
            await User.findByIdAndUpdate(user.userId, { publicKey: msg.publicKey });
            break;
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
            
            const history = await Message.find({ roomId: roomId }).sort({ timestamp: 1 }).limit(50).lean();
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
                roomId: ws.roomId
            };
            const newMessage = new Message(chatMsg);
            await newMessage.save();
            broadcast(ws.roomId, { type: 'chat_message', message: chatMsg });
            break;
            
        case 'typing':
            broadcast(ws.roomId, { type: 'typing', userId: user.userId, username: user.username }, ws);
            break;
            
        // WebRTC сообщения (видео/аудио) теперь используют userId вместо старого id
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'webrtc_ice':
        case 'call_request':
        case 'call_accept':
        case 'call_reject':
        case 'call_end':
            const target = Array.from(users.keys()).find(w => w.userData && w.userData.userId === msg.targetId);
            if (target) {
                target.send(JSON.stringify({ ...msg, fromId: user.userId, fromName: user.username }));
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  LUMIO ULTIMATE SERVER (WITH AUTH)');
    console.log('========================================');
    console.log('  HTTP: http://localhost:' + PORT);
    console.log('  WS:   ws://localhost:' + PORT);
    console.log('========================================');
    console.log('');
});