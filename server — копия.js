const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

const users = new Map();
const rooms = new Map();
const messages = new Map();

wss.on('connection', (ws) => {
    const userId = uuidv4();
    users.set(ws, { id: userId, name: 'User_' + userId.slice(0, 6) });
    console.log('Connected: ' + userId);
    ws.send(JSON.stringify({ type: 'welcome', userId }));
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleMessage(ws, msg);
        } catch (e) {
            console.error('Error:', e);
        }
    });
    
    ws.on('close', () => {
        const user = users.get(ws);
        console.log('Disconnected: ' + (user ? user.id : 'unknown'));
        rooms.forEach((members, roomId) => {
            if (members.has(ws)) {
                members.delete(ws);
                broadcast(roomId, { type: 'user_left', userId: user.id });
            }
        });
        users.delete(ws);
    });
});

function handleMessage(ws, msg) {
    const user = users.get(ws);
    switch (msg.type) {
        case 'set_name':
            user.name = msg.name;
            break;
        case 'set_public_key':
            user.publicKey = msg.publicKey;
            break;
        case 'join_room':
            const roomId = msg.roomId;
            if (!rooms.has(roomId)) rooms.set(roomId, new Set());
            rooms.get(roomId).add(ws);
            ws.roomId = roomId;
            const members = Array.from(rooms.get(roomId)).map(m => {
                const u = users.get(m);
                return { id: u.id, name: u.name, publicKey: u.publicKey };
            });
            ws.send(JSON.stringify({ type: 'room_members', members }));
            broadcast(roomId, { type: 'user_joined', user: { id: user.id, name: user.name } }, ws);
            const history = (messages.get(roomId) || []).slice(-50);
            ws.send(JSON.stringify({ type: 'history', messages: history }));
            break;
        case 'chat_message':
            const chatMsg = {
                id: uuidv4(),
                from: user.id,
                fromName: user.name,
                text: msg.text,
                encrypted: msg.encrypted,
                timestamp: Date.now(),
                roomId: ws.roomId
            };
            if (!messages.has(ws.roomId)) messages.set(ws.roomId, []);
            messages.get(ws.roomId).push(chatMsg);
            broadcast(ws.roomId, { type: 'chat_message', message: chatMsg });
            break;
        case 'typing':
            broadcast(ws.roomId, { type: 'typing', userId: user.id, userName: user.name }, ws);
            break;
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'webrtc_ice':
            const target = Array.from(users.keys()).find(w => users.get(w).id === msg.targetId);
            if (target) target.send(JSON.stringify({ ...msg, fromId: user.id, fromName: user.name }));
            break;
        case 'call_request':
            const callee = Array.from(users.keys()).find(w => users.get(w).id === msg.targetId);
            if (callee) callee.send(JSON.stringify({ type: 'incoming_call', fromId: user.id, fromName: user.name, callType: msg.callType }));
            break;
        case 'call_accept':
        case 'call_reject':
        case 'call_end':
            const peer = Array.from(users.keys()).find(w => users.get(w).id === msg.targetId);
            if (peer) peer.send(JSON.stringify({ ...msg, fromId: user.id }));
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
    console.log('  LUMIO ULTIMATE SERVER');
    console.log('========================================');
    console.log('  HTTP: http://localhost:' + PORT);
    console.log('  WS:   ws://localhost:' + PORT);
    console.log('========================================');
    console.log('');
});