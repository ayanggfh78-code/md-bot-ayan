require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser, Browsers, delay } = require('@whiskeysockets/baileys');
const P = require('pino');

// =================== SETTINGS ===================
const settings = require('./settings');

// =================== EXPRESS SETUP ===================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// =================== TELEGRAM BOT ===================
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const tgBot = tgToken ? new TelegramBot(tgToken, { polling: true }) : null;

if (tgBot) {
    tgBot.on('polling_error', (error) => {
        console.log('Telegram polling error:', error.message);
    });
}

// =================== DATA STORAGE ===================
const AUTH_DIR = './auth_info';
const DATA_FILE = './data/bot_data.json';
fs.ensureDirSync(AUTH_DIR);
fs.ensureDirSync('./data');

let botData = { 
    antilinkGroups: {}, 
    totalBots: 0, 
    registeredBots: [], 
    statusSettings: {}, 
    antiDelete: {}, 
    userNames: {}, 
    antiCall: {}, 
    broadcastHistory: [] 
};

if (fs.existsSync(DATA_FILE)) {
    try { botData = fs.readJsonSync(DATA_FILE); } catch (e) {}
}

function saveBotData() {
    fs.writeJsonSync(DATA_FILE, botData);
}

const sessions = {}; 
const userSockets = {}; 
const messageLogs = {}; 

// =================== BOT SESSION CLASS ===================
class BotSession {
    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.isConnected = false;
        this.aiEnabled = false;
        this.autoReact = false;
        this.isPublic = true;
        this.authPath = path.join(AUTH_DIR, userId);
        this.processedMessages = new Set();
        this.phoneNumber = null;
        this.ghostMode = false;
        this.tgChatId = null;
    }

    sendLog(message, type = 'info') {
        const logEntry = { timestamp: new Date().toLocaleTimeString(), message, type };
        const socketId = userSockets[this.userId];
        if (socketId) io.to(socketId).emit('console', logEntry);
        console.log(`[${this.userId}] ${message}`);
    }

    sendConnectionStatus() {
        const socketId = userSockets[this.userId];
        if (socketId) {
            io.to(socketId).emit('connection-status', {
                connected: this.isConnected,
                user: this.userId
            });
        }
        io.emit('total-active', Object.values(sessions).filter(s => s.isConnected).length);
    }

    async getAIResponse(userMessage) {
        try {
            const apiUrl = `https://api.siputzx.my.id/api/ai/chatgpt?text=${encodeURIComponent(userMessage)}`;
            const response = await axios.get(apiUrl);
            if (response.data && response.data.data) {
                return response.data.data;
            }
            return "I'm here to help! What would you like to know?";
        } catch (error) {
            return "Sorry, I'm having trouble connecting to AI services right now.";
        }
    }

    async initialize(pairingNumber = null) {
        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);

            this.sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: P({ level: 'fatal' }),
                browser: Browsers.ubuntu('Chrome'),
                syncFullHistory: false,
                markOnlineOnConnect: true,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
            });

            if (pairingNumber && !state.creds.registered) {
                if (!this.sock.authState.creds.registered) {
                    await delay(3000);
                    try {
                        let code = await this.sock.requestPairingCode(pairingNumber);
                        code = code?.match(/.{1,4}/g)?.join("-") || code;
                        this.sendLog(`Pairing Code: ${code}`, 'success');

                        if (this.tgChatId && tgBot) {
                            await tgBot.sendMessage(this.tgChatId, `*MA BOT - PAIRING CODE:*\n\`${code}\`\n\n_Enter this in WhatsApp Linked Devices_`, { parse_mode: 'Markdown' });
                        }

                        const socketId = userSockets[this.userId];
                        if (socketId) io.to(socketId).emit('pairing-code', code);
                    } catch (err) {
                        this.sendLog(`Pairing error: ${err.message}`, 'error');
                    }
                }
            }

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    const socketId = userSockets[this.userId];
                    if (socketId) io.to(socketId).emit('qr', qr);
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    this.isConnected = false;
                    this.sendLog(`Connection closed. Reconnecting: ${shouldReconnect}`, 'warning');
                    this.sendConnectionStatus();
                    
                    const statusCode = (lastDisconnect.error)?.output?.statusCode;
                    
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        this.sendLog('Session expired or logged out.', 'error');
                        delete sessions[this.userId];
                        this.sendConnectionStatus();
                    } else {
                        setTimeout(() => this.initialize(), 5000);
                    }
                } else if (connection === 'open') {
                    this.isConnected = true;
                    this.sendLog('Connected successfully! ✅', 'success');
                    this.sendConnectionStatus();

                    const botNumber = jidNormalizedUser(this.sock.user.id);
                    const botNumberClean = botNumber.split('@')[0];
                    this.phoneNumber = botNumberClean;

                    // Send welcome message with owner image
                    const welcomeText = `╭━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                        `┃  🤖 *MA BOT* 🤖        ┃\n` +
                        `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                        `*CONNECTED SUCCESSFULLY* ✅\n\n` +
                        `*BOT INFORMATION:*\n` +
                        `• *Bot Name:* MA BOT\n` +
                        `• *Developer:* MA Developers\n` +
                        `• *Founder:* Muhammad Ayan\n` +
                        `• *Version:* ${settings.version}\n` +
                        `• *Status:* 24/7 Active\n\n` +
                        `Type *.menu* to explore all features.\n\n` +
                        `> ${settings.footer} | ${settings.copyright}`;

                    await this.sock.sendMessage(botNumber, { 
                        image: { url: settings.startimage },
                        caption: welcomeText 
                    });

                    if (this.tgChatId && tgBot) {
                        await tgBot.sendMessage(this.tgChatId, `✅ *MA BOT CONNECTION SUCCESSFUL!*\n\nYour WhatsApp has been linked.`, { parse_mode: 'Markdown' });
                    }
                }
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                if (m.type !== 'notify') return;

                for (const msg of m.messages) {
                    try {
                        const from = msg.key.remoteJid;
                        const isMe = msg.key.fromMe;
                        const isGroup = from.endsWith('@g.us');
                        const isStatus = from === 'status@broadcast';

                        const messageContent = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message || msg.message;
                        if (!messageContent) continue;

                        const text = (messageContent.conversation || messageContent.extendedTextMessage?.text || messageContent.imageMessage?.caption || messageContent.videoMessage?.caption || '').trim();

                        // Skip status messages
                        if (isStatus) continue;

                        const msgId = msg.key.id;
                        if (this.processedMessages.has(msgId)) continue;
                        this.processedMessages.add(msgId);
                        if (this.processedMessages.size > 1000) this.processedMessages.delete(this.processedMessages.values().next().value);

                        // Command processing
                        if (text.toLowerCase().startsWith('.')) {
                            const cmd = text.toLowerCase();
                            const args = text.split(' ').slice(1);
                            const q = args.join(' ');
                            const commandName = cmd.slice(1).split(' ')[0];

                            const botNumber = jidNormalizedUser(this.sock.user.id);
                            const botNumberClean = botNumber.split('@')[0];
                            const sender = msg.key.participant || from;
                            const senderClean = sender.split('@')[0];

                            const ownerNumbers = String(settings.ownerNumber).split(',').map(n => n.replace(/\D/g, ''));
                            const isOwner = isMe || ownerNumbers.some(on => senderClean === on) || senderClean === botNumberClean;

                            let isAdmin = isOwner;
                            if (!isAdmin && isGroup) {
                                try {
                                    const groupMetadata = await this.sock.groupMetadata(from);
                                    const participant = groupMetadata.participants.find(p => p.id === sender);
                                    isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
                                } catch (e) {}
                            }

                            switch (commandName) {
                                // ===== MENU =====
                                case 'menu': {
                                    const menuText = generateMenuText(msg.pushName || 'User', this);
                                    try {
                                        await this.sock.sendMessage(from, { image: { url: settings.startimage }, caption: menuText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: menuText }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== OWNER COMMANDS =====
                                case 'owner': {
                                    const ownerText = `*MA BOT OWNER*\n\n` +
                                        `👤 *Name:* Muhammad Ayan\n` +
                                        `🏢 *Team:* MA Developers\n` +
                                        `📌 *Role:* Founder & Developer\n\n` +
                                        `> ${settings.footer}`;
                                    await this.sock.sendMessage(from, { image: { url: settings.ownerImage }, caption: ownerText }, { quoted: msg });
                                    break;
                                }

                                // ===== PING =====
                                case 'ping': {
                                    const start = Date.now();
                                    await this.sock.sendMessage(from, { text: 'Pong! 🏓' }, { quoted: msg });
                                    break;
                                }

                                // ===== AI =====
                                case 'ai': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: 'Please provide a message for AI!\nExample: *.ai Hello*' }, { quoted: msg });
                                        break;
                                    }
                                    const aiResponse = await this.getAIResponse(q);
                                    await this.sock.sendMessage(from, { text: aiResponse }, { quoted: msg });
                                    break;
                                }

                                // ===== STICKER =====
                                case 'sticker': case 's': {
                                    if (msg.message?.imageMessage || msg.message?.videoMessage) {
                                        try {
                                            const mediaType = msg.message.imageMessage ? 'image' : 'video';
                                            const stream = await downloadMediaMessage(msg, mediaType, {});
                                            const buffer = Buffer.from(await stream.toBuffer());
                                            // Convert to sticker using sharp or webp
                                            // For now, send as is
                                            await this.sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
                                        } catch (e) {
                                            await this.sock.sendMessage(from, { text: 'Failed to create sticker!' }, { quoted: msg });
                                        }
                                    } else {
                                        await this.sock.sendMessage(from, { text: 'Reply to an image/video with *.sticker*' }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== GROUP MANAGEMENT =====
                                case 'tagall': {
                                    if (!isAdmin) {
                                        await this.sock.sendMessage(from, { text: 'Admin only!' }, { quoted: msg });
                                        break;
                                    }
                                    const groupMetadata = await this.sock.groupMetadata(from);
                                    const mentions = groupMetadata.participants.map(p => p.id);
                                    await this.sock.sendMessage(from, { text: `📢 *MA BOT - TAGGING ALL*\n\n${q || 'Hello everyone!'}`, mentions }, { quoted: msg });
                                    break;
                                }

                                case 'hidetag': {
                                    if (!isAdmin) {
                                        await this.sock.sendMessage(from, { text: 'Admin only!' }, { quoted: msg });
                                        break;
                                    }
                                    const groupMetadata = await this.sock.groupMetadata(from);
                                    const mentions = groupMetadata.participants.map(p => p.id);
                                    await this.sock.sendMessage(from, { text: `${q || 'Hello!'}`, mentions });
                                    break;
                                }

                                // ===== SYSTEM =====
                                case 'uptime': {
                                    const uptime = process.uptime();
                                    const days = Math.floor(uptime / 86400);
                                    const hours = Math.floor((uptime % 86400) / 3600);
                                    const minutes = Math.floor((uptime % 3600) / 60);
                                    const seconds = Math.floor(uptime % 60);
                                    await this.sock.sendMessage(from, { text: `*MA BOT UPTIME*\n\n📅 Days: ${days}\n⏰ Hours: ${hours}\n⏱️ Minutes: ${minutes}\n⏲️ Seconds: ${seconds}` }, { quoted: msg });
                                    break;
                                }

                                // ===== OWNER COMMANDS =====
                                case 'bc': case 'broadcast': {
                                    if (!isOwner) {
                                        await this.sock.sendMessage(from, { text: 'Owner only!' }, { quoted: msg });
                                        break;
                                    }
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: 'Please provide a message!\nExample: *.bc Hello*' }, { quoted: msg });
                                        break;
                                    }
                                    // Broadcast to all chats
                                    const chats = Object.keys(this.sock.chats || {});
                                    let count = 0;
                                    for (const chat of chats) {
                                        try {
                                            await this.sock.sendMessage(chat, { text: `📢 *BROADCAST*\n\n${q}\n\n> ${settings.footer}` });
                                            count++;
                                            await delay(100);
                                        } catch (e) {}
                                    }
                                    await this.sock.sendMessage(from, { text: `✅ Broadcast sent to ${count} chats!` }, { quoted: msg });
                                    break;
                                }

                                // ===== DEFAULT =====
                                default: {
                                    // Unknown command handler
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Message Processing Error:', e);
                    }
                }
            });

        } catch (err) {
            this.sendLog(`Initialization failed: ${err.message}. Retrying in 10s...`, 'error');
            setTimeout(() => this.initialize(), 10000);
        }
    }
}

// =================== MENU GENERATOR ===================
function generateMenuText(userName, session) {
    const mode = session.isPublic ? 'Public' : 'Private';
    
    return `╭━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `┃   🤖 *MA BOT* 🤖        ┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `👤 *Name:* ${userName}\n` +
        `📦 *Version:* ${settings.version}\n` +
        `⚙️ *Mode:* ${mode}\n\n` +
        `*📋 COMMANDS:*\n\n` +
        `*🛠️ SYSTEM:*\n` +
        `• .ping\n` +
        `• .uptime\n` +
        `• .owner\n\n` +
        `*🤖 AI:*\n` +
        `• .ai <message>\n\n` +
        `*🎨 MEDIA:*\n` +
        `• .sticker (reply to image)\n\n` +
        `*👥 GROUP:*\n` +
        `• .tagall\n` +
        `• .hidetag\n\n` +
        `*👑 OWNER:*\n` +
        `• .bc <message>\n\n` +
        `> ${settings.footer}\n` +
        `> ${settings.copyright}`;
}

// =================== LOAD EXISTING SESSIONS ===================
async function loadExistingSessions() {
    try {
        const authDirs = await fs.readdir(AUTH_DIR);
        for (const userId of authDirs) {
            const authPath = path.join(AUTH_DIR, userId);
            const stats = await fs.stat(authPath);
            if (stats.isDirectory()) {
                const credsFile = path.join(authPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    console.log(`[MA BOT] Found existing session: ${userId}. Initializing...`);
                    if (!sessions[userId]) {
                        sessions[userId] = new BotSession(userId);
                        sessions[userId].initialize().catch(err => {
                            console.error(`Failed to auto-initialize session ${userId}:`, err.message);
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.error('[MA BOT] Error loading sessions:', err.message);
    }
}

// =================== SOCKET.IO ===================
io.on('connection', (socket) => {
    socket.on('set-user', (userId) => {
        userSockets[userId] = socket.id;
        if (!sessions[userId]) sessions[userId] = new BotSession(userId);
        sessions[userId].sendConnectionStatus();
    });

    socket.on('pair-request', async ({ userId, number }) => {
        if (sessions[userId]) {
            sessions[userId].tgChatId = null;
            await sessions[userId].initialize(number);
        } else {
            sessions[userId] = new BotSession(userId);
            sessions[userId].tgChatId = null;
            await sessions[userId].initialize(number);
        }
    });

    socket.on('disconnect', () => {
        for (const [userId, socketId] of Object.entries(userSockets)) {
            if (socketId === socket.id) {
                delete userSockets[userId];
                break;
            }
        }
    });
});

// =================== START SERVER ===================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🤖 MA BOT v${settings.version} Server running on port ${PORT}`);
    console.log(`📡 MA Developers | Muhammad Ayan`);
    console.log(`🌐 Web Dashboard: http://localhost:${PORT}`);
    await loadExistingSessions();
});
