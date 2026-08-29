require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser, Browsers, delay, downloadContentFromMessage, downloadMediaMessage } = require('@whiskeysockets/baileys');
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
let tgBot = null;

if (tgToken) {
    try {
        tgBot = new TelegramBot(tgToken, { polling: true });
        console.log('Telegram bot initialized');
    } catch (error) {
        console.log('Telegram bot failed:', error.message);
        tgBot = null;
    }
}

if (tgBot) {
    tgBot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        tgBot.sendMessage(chatId, 
            `*MA BOT* 🤖\n\n` +
            `Welcome to MA BOT!\n\n` +
            `*To Connect WhatsApp:*\n` +
            `Send your WhatsApp number with country code.\n\n` +
            `*Example:*\n` +
            `\`923000000000\`\n\n` +
            `*Developed by:* MA Developers\n` +
            `*Founder:* Muhammad Ayan`,
            { parse_mode: 'Markdown' }
        );
    });

    tgBot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (!text || text.startsWith('/')) return;

        if (/^\d+$/.test(text)) {
            const userId = `tg_${chatId}`;
            
            if (!sessions[userId]) {
                sessions[userId] = new BotSession(userId);
            }

            sessions[userId].tgChatId = chatId;

            tgBot.sendMessage(chatId, 
                `*MA BOT* 🤖\n\n` +
                `Requesting pairing code for:\n` +
                `\`${text}\`\n\n` +
                `Please wait...`,
                { parse_mode: 'Markdown' }
            );

            await sessions[userId].initialize(text);
        }
    });

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

// =================== FORMATTING HELPERS ===================
const bold = (text) => `*${text}*`;
const italic = (text) => `_${text}_`;
const mono = (text) => `\`${text}\``;

// =================== WAITING MESSAGE FUNCTION ===================
async function sendWaiting(sock, from, msg, action = 'processing') {
    const messages = {
        processing: '⏳ _Processing your request... Please wait..._',
        searching: '🔍 _Searching for the information... Please wait..._',
        downloading: '📥 _Downloading... This may take some time..._',
        hacking: '💻 _Executing hack... This may take some time..._',
        crashing: '💥 _Crashing target... This may take some time..._',
        tracing: '📍 _Tracing location... This may take some time..._',
        analyzing: '📊 _Analyzing data... This may take some time..._',
        connecting: '🔗 _Connecting to server... Please wait..._'
    };
    
    const waitMsg = messages[action] || messages.processing;
    const sent = await sock.sendMessage(from, { text: waitMsg }, { quoted: msg });
    return sent;
}

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
                            await tgBot.sendMessage(this.tgChatId, `*MA BOT - PAIRING CODE:*\n${mono(code)}\n\n_Enter this in WhatsApp Linked Devices_`, { parse_mode: 'Markdown' });
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
                    this.sendLog('Connected successfully!', 'success');
                    this.sendConnectionStatus();

                    const botNumber = jidNormalizedUser(this.sock.user.id);
                    const botNumberClean = botNumber.split('@')[0];
                    this.phoneNumber = botNumberClean;

                    const welcomeText = 
                        bold('MA BOT') + '\n\n' +
                        bold('CONNECTED SUCCESSFULLY') + '\n\n' +
                        bold('Bot Information:') + '\n' +
                        italic('Bot Name:') + ' MA BOT\n' +
                        italic('Developer:') + ' MA Developers\n' +
                        italic('Founder:') + ' Muhammad Ayan\n' +
                        italic('Version:') + ' ' + settings.version + '\n' +
                        italic('Status:') + ' 24/7 Active\n\n' +
                        'Type ' + mono('.menu') + ' to explore all features.\n\n' +
                        bold('© MA Developers | Muhammad Ayan');

                    await this.sock.sendMessage(botNumber, { 
                        image: { url: settings.startimage },
                        caption: welcomeText 
                    });

                    if (this.tgChatId && tgBot) {
                        await tgBot.sendMessage(this.tgChatId, `*MA BOT CONNECTION SUCCESSFUL!*\n\nYour WhatsApp has been linked.`, { parse_mode: 'Markdown' });
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

                        if (isStatus) continue;

                        const msgId = msg.key.id;
                        if (this.processedMessages.has(msgId)) continue;
                        this.processedMessages.add(msgId);
                        if (this.processedMessages.size > 1000) this.processedMessages.delete(this.processedMessages.values().next().value);

                        // =================== COMMAND PROCESSING ===================
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
                                // ===== BASIC COMMANDS =====
                                case 'menu': {
                                    const menuText = 
                                        bold('MA BOT MENU') + '\n\n' +
                                        bold('OWNER COMMANDS:') + '\n' +
                                        mono('.owner') + ' - Show owner info\n' +
                                        mono('.bc') + ' - Broadcast message\n\n' +
                                        bold('SYSTEM COMMANDS:') + '\n' +
                                        mono('.ping') + ' - Check bot response\n' +
                                        mono('.uptime') + ' - Show uptime\n' +
                                        mono('.stats') + ' - Show bot stats\n\n' +
                                        bold('AI COMMANDS:') + '\n' +
                                        mono('.ai') + ' - Ask AI anything\n' +
                                        mono('.chatbot') + ' - Toggle chatbot\n\n' +
                                        bold('SIM & NUMBER INFO:') + '\n' +
                                        mono('.siminfo') + ' - SIM card info\n' +
                                        mono('.numberinfo') + ' - Number details\n' +
                                        mono('.trace') + ' - Trace number\n' +
                                        mono('.callinfo') + ' - Call details\n' +
                                        mono('.whatsappinfo') + ' - WhatsApp info\n\n' +
                                        bold('CRASH / BUG COMMANDS:') + '\n' +
                                        mono('.crash') + ' - Crash target\n' +
                                        mono('.freeze') + ' - Freeze target\n' +
                                        mono('.lag') + ' - Lag target\n' +
                                        mono('.bug') + ' - Bug target\n' +
                                        mono('.vibrate') + ' - Vibrate target\n' +
                                        mono('.tornado') + ' - Tornado effect\n\n' +
                                        bold('DOWNLOAD COMMANDS:') + '\n' +
                                        mono('.yt') + ' - YouTube download\n' +
                                        mono('.tt') + ' - TikTok download\n' +
                                        mono('.insta') + ' - Instagram download\n\n' +
                                        bold('GROUP COMMANDS:') + '\n' +
                                        mono('.tagall') + ' - Tag all members\n' +
                                        mono('.hidetag') + ' - Hidden tag all\n' +
                                        mono('.groupinfo') + ' - Show group info\n\n' +
                                        bold('TOOLS COMMANDS:') + '\n' +
                                        mono('.calc') + ' - Calculator\n' +
                                        mono('.shorturl') + ' - Shorten URL\n\n' +
                                        bold('FUN COMMANDS:') + '\n' +
                                        mono('.joke') + ' - Random joke\n' +
                                        mono('.fact') + ' - Random fact\n' +
                                        mono('.quote') + ' - Random quote\n\n' +
                                        bold('OWNER:') + '\n' +
                                        italic('Muhammad Ayan | MA Developers') + '\n\n' +
                                        bold('© MA Developers');
                                    
                                    try {
                                        await this.sock.sendMessage(from, { image: { url: settings.startimage }, caption: menuText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: menuText }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'owner': {
                                    const ownerText = 
                                        bold('MA BOT OWNER') + '\n\n' +
                                        bold('Name:') + ' Muhammad Ayan\n' +
                                        bold('Team:') + ' MA Developers\n' +
                                        bold('Role:') + ' Founder & Developer\n' +
                                        bold('Version:') + ' ' + settings.version + '\n\n' +
                                        bold('© MA Developers | Muhammad Ayan');
                                    
                                    await this.sock.sendMessage(from, { image: { url: settings.ownerImage }, caption: ownerText }, { quoted: msg });
                                    break;
                                }

                                case 'ping': {
                                    const start = Date.now();
                                    await this.sock.sendMessage(from, { text: bold('Pong!') + '\n\n' + italic('Response time:') + ' ' + (Date.now() - start) + 'ms' }, { quoted: msg });
                                    break;
                                }

                                case 'uptime': {
                                    const uptime = process.uptime();
                                    const days = Math.floor(uptime / 86400);
                                    const hours = Math.floor((uptime % 86400) / 3600);
                                    const minutes = Math.floor((uptime % 3600) / 60);
                                    const seconds = Math.floor(uptime % 60);
                                    
                                    const text = 
                                        bold('MA BOT UPTIME') + '\n\n' +
                                        italic('Days:') + ' ' + days + '\n' +
                                        italic('Hours:') + ' ' + hours + '\n' +
                                        italic('Minutes:') + ' ' + minutes + '\n' +
                                        italic('Seconds:') + ' ' + seconds + '\n\n' +
                                        bold('© MA Developers');
                                    
                                    await this.sock.sendMessage(from, { text }, { quoted: msg });
                                    break;
                                }

                                case 'stats': {
                                    const activeSessions = Object.values(sessions).filter(s => s.isConnected).length;
                                    const text = 
                                        bold('MA BOT STATS') + '\n\n' +
                                        italic('Total Sessions:') + ' ' + Object.keys(sessions).length + '\n' +
                                        italic('Active Users:') + ' ' + activeSessions + '\n' +
                                        italic('Version:') + ' ' + settings.version + '\n\n' +
                                        bold('© MA Developers');
                                    
                                    await this.sock.sendMessage(from, { text }, { quoted: msg });
                                    break;
                                }

                                // ===== SIM & NUMBER INFO COMMANDS =====
                                case 'siminfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.siminfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'analyzing');
                                    
                                    try {
                                        await delay(2000);
                                        const number = q.replace(/\D/g, '');
                                        const simInfoText = 
                                            bold('SIM CARD INFORMATION') + '\n\n' +
                                            italic('Phone Number:') + ' ' + number + '\n' +
                                            italic('Country:') + ' Pakistan 🇵🇰\n' +
                                            italic('Country Code:') + ' +92\n' +
                                            italic('Operator:') + ' Jazz / Warid / Zong / Telenor\n' +
                                            italic('SIM Type:') + ' Postpaid / Prepaid\n' +
                                            italic('Status:') + ' Active\n' +
                                            italic('IMEI:') + ' ' + Math.floor(Math.random() * 900000000000000 + 100000000000000) + '\n' +
                                            italic('SIM Card Number:') + ' ' + Math.floor(Math.random() * 9000000000 + 1000000000) + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: simInfoText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to fetch SIM info!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'numberinfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.numberinfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'searching');
                                    
                                    try {
                                        await delay(2000);
                                        const number = q.replace(/\D/g, '');
                                        const numberInfoText = 
                                            bold('NUMBER INFORMATION') + '\n\n' +
                                            italic('Phone Number:') + ' ' + number + '\n' +
                                            italic('Country:') + ' Pakistan 🇵🇰\n' +
                                            italic('Carrier:') + ' Jazz / Warid / Zong / Telenor\n' +
                                            italic('Type:') + ' Mobile\n' +
                                            italic('Location:') + ' Karachi, Sindh, Pakistan\n' +
                                            italic('Timezone:') + ' GMT+5\n' +
                                            italic('Network Status:') + ' Active\n' +
                                            italic('Online:') + ' Yes\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: numberInfoText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to fetch number info!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'trace': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.trace 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'tracing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const traceText = 
                                            bold('LOCATION TRACING') + '\n\n' +
                                            italic('Phone Number:') + ' ' + number + '\n' +
                                            italic('Latitude:') + ' 24.8607° N\n' +
                                            italic('Longitude:') + ' 67.0011° E\n' +
                                            italic('Address:') + ' Karachi, Sindh, Pakistan\n' +
                                            italic('City:') + ' Karachi\n' +
                                            italic('State:') + ' Sindh\n' +
                                            italic('Country:') + ' Pakistan\n' +
                                            italic('Accuracy:') + ' ±50m\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: traceText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to trace location!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'callinfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.callinfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'analyzing');
                                    
                                    try {
                                        await delay(2000);
                                        const number = q.replace(/\D/g, '');
                                        const callInfoText = 
                                            bold('CALL INFORMATION') + '\n\n' +
                                            italic('Phone Number:') + ' ' + number + '\n' +
                                            italic('Call Type:') + ' Mobile\n' +
                                            italic('Call Status:') + ' Active\n' +
                                            italic('Last Call:') + ' ' + new Date().toLocaleDateString() + '\n' +
                                            italic('Call Duration:') + ' 5 min 23 sec\n' +
                                            italic('Missed Calls:') + ' 3\n' +
                                            italic('Incoming Calls:') + ' 12\n' +
                                            italic('Outgoing Calls:') + ' 8\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: callInfoText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to fetch call info!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'whatsappinfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.whatsappinfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'searching');
                                    
                                    try {
                                        await delay(2000);
                                        const number = q.replace(/\D/g, '');
                                        const waInfoText = 
                                            bold('WHATSAPP NUMBER INFO') + '\n\n' +
                                            italic('Phone Number:') + ' ' + number + '\n' +
                                            italic('WhatsApp Status:') + ' Active ✅\n' +
                                            italic('Last Seen:') + ' Today at ' + new Date().toLocaleTimeString() + '\n' +
                                            italic('Profile Picture:') + ' Available\n' +
                                            italic('About:') + ' Hello, I am using WhatsApp!\n' +
                                            italic('Online Status:') + ' Online\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: waInfoText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to fetch WhatsApp info!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== CRASH / BUG COMMANDS =====
                                case 'crash': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.crash 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'crashing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const crashText = 
                                            bold('💥 CRASH ATTACK INITIATED') + '\n\n' +
                                            italic('Target:') + ' ' + number + '\n' +
                                            italic('Status:') + ' Target crashed successfully! ✅\n' +
                                            italic('Method:') + ' WhatsApp Protocol Exploit\n' +
                                            italic('Payload:') + ' Malicious Message Injection\n\n' +
                                            italic('Target device will restart in 30 seconds...') + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: crashText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to crash target!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'freeze': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.freeze 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'crashing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const freezeText = 
                                            bold('❄️ FREEZE ATTACK INITIATED') + '\n\n' +
                                            italic('Target:') + ' ' + number + '\n' +
                                            italic('Status:') + ' Target frozen! ✅\n' +
                                            italic('Method:') + ' Device Freeze Exploit\n' +
                                            italic('Duration:') + ' 10 Minutes\n\n' +
                                            italic('Target device is now frozen...') + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: freezeText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to freeze target!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'lag': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.lag 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'crashing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const lagText = 
                                            bold('🐌 LAG ATTACK INITIATED') + '\n\n' +
                                            italic('Target:') + ' ' + number + '\n' +
                                            italic('Status:') + ' Target lagging! ✅\n' +
                                            italic('Method:') + ' Network Congestion Exploit\n' +
                                            italic('Impact:') + ' High Latency + Slow Loading\n\n' +
                                            italic('Target device speed reduced to 10%...') + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: lagText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to lag target!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'bug': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.bug 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'crashing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const bugText = 
                                            bold('🐛 BUG ATTACK INITIATED') + '\n\n' +
                                            italic('Target:') + ' ' + number + '\n' +
                                            italic('Status:') + ' Bug injected! ✅\n' +
                                            italic('Method:') + ' Malicious Code Injection\n' +
                                            italic('Payload:') + ' Zero-Day Exploit\n\n' +
                                            italic('Target device will experience random crashes...') + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: bugText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to inject bug!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'vibrate': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.vibrate 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'crashing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const vibrateText = 
                                            bold('📳 VIBRATION ATTACK INITIATED') + '\n\n' +
                                            italic('Target:') + ' ' + number + '\n' +
                                            italic('Status:') + ' Vibration activated! ✅\n' +
                                            italic('Method:') + ' Device Control Exploit\n' +
                                            italic('Duration:') + ' 30 Seconds\n\n' +
                                            italic('Target device vibrating continuously...') + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: vibrateText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to activate vibration!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'tornado': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.tornado 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'crashing');
                                    
                                    try {
                                        await delay(3000);
                                        const number = q.replace(/\D/g, '');
                                        const tornadoText = 
                                            bold('🌪️ TORNADO ATTACK INITIATED') + '\n\n' +
                                            italic('Target:') + ' ' + number + '\n' +
                                            italic('Status:') + ' Tornado activated! ✅\n' +
                                            italic('Method:') + ' System Overload Exploit\n' +
                                            italic('Impact:') + ' Device will be destroyed\n\n' +
                                            italic('Target device will be wiped clean...') + '\n\n' +
                                            bold('© MA Developers');
                                        await this.sock.sendMessage(from, { text: tornadoText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to activate tornado!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== YOUTUBE DOWNLOADER =====
                                case 'yt': case 'youtube': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a YouTube link!') + '\n\n' + italic('Example:') + ' ' + mono('.yt https://youtube.com/watch?v=...') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'downloading');
                                    
                                    try {
                                        // Extract video ID
                                        const videoId = ytdl.getVideoID(q);
                                        const info = await ytdl.getInfo(videoId);
                                        
                                        const title = info.videoDetails.title;
                                        const duration = info.videoDetails.lengthSeconds;
                                        const thumbnail = info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url;
                                        
                                        const videoInfoText = 
                                            bold('YOUTUBE VIDEO FOUND') + '\n\n' +
                                            italic('Title:') + ' ' + title + '\n' +
                                            italic('Duration:') + ' ' + Math.floor(duration / 60) + ':' + (duration % 60).toString().padStart(2, '0') + '\n' +
                                            italic('Channel:') + ' ' + info.videoDetails.author.name + '\n\n' +
                                            bold('Downloading video... Please wait...');
                                        
                                        await this.sock.sendMessage(from, { text: videoInfoText }, { quoted: msg });
                                        
                                        // Download video
                                        const stream = ytdl(videoId, { quality: 'highestvideo' });
                                        const chunks = [];
                                        for await (const chunk of stream) {
                                            chunks.push(chunk);
                                        }
                                        const buffer = Buffer.concat(chunks);
                                        
                                        await this.sock.sendMessage(from, { 
                                            video: buffer, 
                                            caption: bold('MA BOT DOWNLOAD') + '\n\n' + title + '\n\n' + bold('© MA Developers'),
                                            mimetype: 'video/mp4'
                                        }, { quoted: msg });
                                        
                                        this.sendLog(`YouTube download successful: ${title}`, 'success');
                                    } catch (e) {
                                        this.sendLog(`YouTube download error: ${e.message}`, 'error');
                                        await this.sock.sendMessage(from, { text: bold('Failed to download video!') + '\n\n' + italic('Error:') + ' ' + e.message }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== TIKTOK DOWNLOADER =====
                                case 'tt': case 'tiktok': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a TikTok link!') + '\n\n' + italic('Example:') + ' ' + mono('.tt https://tiktok.com/@user/video/...') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'downloading');
                                    
                                    try {
                                        const tiktokUrl = q;
                                        
                                        // TikTok API (using public API)
                                        const apiUrl = `https://api.siputzx.my.id/api/down/tiktok?url=${encodeURIComponent(tiktokUrl)}`;
                                        const response = await axios.get(apiUrl);
                                        
                                        if (response.data && response.data.status) {
                                            const videoUrl = response.data.data.video || response.data.data.play;
                                            
                                            if (videoUrl) {
                                                const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer' });
                                                const videoBuffer = Buffer.from(videoRes.data);
                                                
                                                await this.sock.sendMessage(from, { 
                                                    video: videoBuffer, 
                                                    caption: bold('MA BOT TIKTOK DOWNLOAD') + '\n\n' + bold('© MA Developers'),
                                                    mimetype: 'video/mp4'
                                                }, { quoted: msg });
                                                
                                                this.sendLog('TikTok download successful', 'success');
                                            } else {
                                                throw new Error('Video URL not found');
                                            }
                                        } else {
                                            throw new Error('Invalid TikTok response');
                                        }
                                    } catch (e) {
                                        this.sendLog(`TikTok download error: ${e.message}`, 'error');
                                        await this.sock.sendMessage(from, { text: bold('Failed to download TikTok video!') + '\n\n' + italic('Error:') + ' ' + e.message }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== INSTAGRAM DOWNLOADER =====
                                case 'insta': case 'instagram': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide an Instagram link!') + '\n\n' + italic('Example:') + ' ' + mono('.insta https://instagram.com/p/...') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'downloading');
                                    
                                    try {
                                        const instaUrl = q;
                                        
                                        // Instagram API (using public API)
                                        const apiUrl = `https://api.siputzx.my.id/api/down/instagram?url=${encodeURIComponent(instaUrl)}`;
                                        const response = await axios.get(apiUrl);
                                        
                                        if (response.data && response.data.status) {
                                            const mediaUrl = response.data.data.url || response.data.data.video || response.data.data.image;
                                            
                                            if (mediaUrl) {
                                                const mediaRes = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                                                const mediaBuffer = Buffer.from(mediaRes.data);
                                                
                                                await this.sock.sendMessage(from, { 
                                                    video: mediaBuffer, 
                                                    caption: bold('MA BOT INSTAGRAM DOWNLOAD') + '\n\n' + bold('© MA Developers'),
                                                    mimetype: 'video/mp4'
                                                }, { quoted: msg });
                                                
                                                this.sendLog('Instagram download successful', 'success');
                                            } else {
                                                throw new Error('Media URL not found');
                                            }
                                        } else {
                                            throw new Error('Invalid Instagram response');
                                        }
                                    } catch (e) {
                                        this.sendLog(`Instagram download error: ${e.message}`, 'error');
                                        await this.sock.sendMessage(from, { text: bold('Failed to download Instagram media!') + '\n\n' + italic('Error:') + ' ' + e.message }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== GROUP COMMANDS =====
                                case 'tagall': {
                                    if (!isAdmin) {
                                        await this.sock.sendMessage(from, { text: bold('Admin only command!') }, { quoted: msg });
                                        break;
                                    }
                                    const groupMetadata = await this.sock.groupMetadata(from);
                                    const mentions = groupMetadata.participants.map(p => p.id);
                                    await this.sock.sendMessage(from, { text: bold('MA BOT - TAGGING ALL') + '\n\n' + (q || 'Hello everyone!'), mentions }, { quoted: msg });
                                    break;
                                }

                                case 'hidetag': {
                                    if (!isAdmin) {
                                        await this.sock.sendMessage(from, { text: bold('Admin only command!') }, { quoted: msg });
                                        break;
                                    }
                                    const groupMetadata = await this.sock.groupMetadata(from);
                                    const mentions = groupMetadata.participants.map(p => p.id);
                                    await this.sock.sendMessage(from, { text: (q || 'Hello!'), mentions });
                                    break;
                                }

                                case 'groupinfo': {
                                    if (!isGroup) {
                                        await this.sock.sendMessage(from, { text: bold('This command is for groups only!') }, { quoted: msg });
                                        break;
                                    }
                                    const groupMetadata = await this.sock.groupMetadata(from);
                                    const text = 
                                        bold('GROUP INFO') + '\n\n' +
                                        italic('Name:') + ' ' + groupMetadata.subject + '\n' +
                                        italic('Members:') + ' ' + groupMetadata.participants.length + '\n' +
                                        italic('Admins:') + ' ' + groupMetadata.participants.filter(p => p.admin).length + '\n' +
                                        italic('Owner:') + ' ' + (groupMetadata.owner ? groupMetadata.owner.split('@')[0] : 'Unknown') + '\n\n' +
                                        bold('© MA Developers');
                                    
                                    await this.sock.sendMessage(from, { text }, { quoted: msg });
                                    break;
                                }

                                // ===== TOOLS COMMANDS =====
                                case 'calc': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a calculation!') + '\n\n' + italic('Example:') + ' ' + mono('.calc 2+2') }, { quoted: msg });
                                        break;
                                    }
                                    try {
                                        const result = eval(q);
                                        await this.sock.sendMessage(from, { text: bold('Result:') + ' ' + result }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Invalid calculation!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'shorturl': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a URL!') + '\n\n' + italic('Example:') + ' ' + mono('.shorturl https://example.com') }, { quoted: msg });
                                        break;
                                    }
                                    try {
                                        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`);
                                        await this.sock.sendMessage(from, { text: bold('Shortened URL:') + '\n' + mono(res.data) }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: bold('Failed to shorten URL!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== FUN COMMANDS =====
                                case 'joke': {
                                    const jokes = [
                                        'Why do programmers prefer dark mode? Because light attracts bugs!',
                                        'Why did the developer go broke? Because he used up all his cache!',
                                        'Why do Java developers wear glasses? Because they don\'t C#!',
                                        'Why did the computer go to the doctor? It caught a virus!',
                                        'Why don\'t programmers like nature? Too many bugs!'
                                    ];
                                    const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
                                    await this.sock.sendMessage(from, { text: bold('Here\'s a joke:') + '\n\n' + randomJoke }, { quoted: msg });
                                    break;
                                }

                                case 'fact': {
                                    const facts = [
                                        'Honey never spoils. Archaeologists have found 3000-year-old honey in Egyptian tombs!',
                                        'The human brain has about 86 billion neurons!',
                                        'Octopuses have three hearts!',
                                        'A group of flamingos is called a flamboyance!',
                                        'The Eiffel Tower can be 15 cm taller during summer!'
                                    ];
                                    const randomFact = facts[Math.floor(Math.random() * facts.length)];
                                    await this.sock.sendMessage(from, { text: bold('Did you know?') + '\n\n' + randomFact }, { quoted: msg });
                                    break;
                                }

                                case 'quote': {
                                    const quotes = [
                                        'The only way to do great work is to love what you do. - Steve Jobs',
                                        'Life is what happens when you\'re busy making other plans. - John Lennon',
                                        'Strive not to be a success, but rather to be of value. - Albert Einstein',
                                        'Believe you can and you\'re halfway there. - Theodore Roosevelt',
                                        'It does not matter how slowly you go as long as you do not stop. - Confucius'
                                    ];
                                    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                                    await this.sock.sendMessage(from, { text: bold('Quote of the day:') + '\n\n' + randomQuote }, { quoted: msg });
                                    break;
                                }

                                // ===== BROADCAST =====
                                case 'bc': case 'broadcast': {
                                    if (!isOwner) {
                                        await this.sock.sendMessage(from, { text: bold('Owner only command!') }, { quoted: msg });
                                        break;
                                    }
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a message!') + '\n\n' + italic('Example:') + ' ' + mono('.bc Hello everyone') }, { quoted: msg });
                                        break;
                                    }
                                    const chats = Object.keys(this.sock.chats || {});
                                    let count = 0;
                                    for (const chat of chats) {
                                        try {
                                            await this.sock.sendMessage(chat, { text: bold('MA BOT BROADCAST') + '\n\n' + q + '\n\n' + bold('© MA Developers') });
                                            count++;
                                            await delay(100);
                                        } catch (e) {}
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Broadcast sent to') + ' ' + count + ' ' + bold('chats!') }, { quoted: msg });
                                    break;
                                }

                                case 'setname': {
                                    if (!isOwner) {
                                        await this.sock.sendMessage(from, { text: bold('Owner only command!') }, { quoted: msg });
                                        break;
                                    }
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a name!') + '\n\n' + italic('Example:') + ' ' + mono('.setname MA BOT') }, { quoted: msg });
                                        break;
                                    }
                                    botData.userNames[this.userId] = q;
                                    saveBotData();
                                    await this.sock.sendMessage(from, { text: bold('Bot name set to:') + ' ' + q }, { quoted: msg });
                                    break;
                                }

                                // ===== AI =====
                                case 'ai': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a message!') + '\n\n' + italic('Example:') + ' ' + mono('.ai Hello') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    const waitMsg = await sendWaiting(this.sock, from, msg, 'processing');
                                    
                                    const aiResponse = await this.getAIResponse(q);
                                    await this.sock.sendMessage(from, { text: aiResponse }, { quoted: msg });
                                    break;
                                }

                                case 'chatbot': {
                                    this.aiEnabled = !this.aiEnabled;
                                    const status = this.aiEnabled ? bold('ENABLED') : bold('DISABLED');
                                    await this.sock.sendMessage(from, { text: italic('Chatbot:') + ' ' + status }, { quoted: msg });
                                    break;
                                }

                                default: {
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
    console.log(`MA BOT v${settings.version} Server running on port ${PORT}`);
    console.log(`MA Developers | Muhammad Ayan`);
    await loadExistingSessions();
});
