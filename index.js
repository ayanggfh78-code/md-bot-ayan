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

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
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

// =================== FORMATTING HELPERS ===================
const bold = (text) => `*${text}*`;
const italic = (text) => `_${text}_`;
const mono = (text) => `\`${text}\``;
const strike = (text) => `~${text}~`;

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
        this.logs = [];
        this.lastConnectTime = null;
    }

    sendLog(message, type = 'info') {
        const logEntry = { timestamp: new Date().toLocaleTimeString(), message, type };
        this.logs.push(logEntry);
        if (this.logs.length > 100) this.logs.shift();
        
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
                    this.lastConnectTime = new Date().toISOString();
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
                                        mono('.bc') + ' - Broadcast message\n' +
                                        mono('.setname') + ' - Set bot name\n\n' +
                                        bold('SYSTEM COMMANDS:') + '\n' +
                                        mono('.ping') + ' - Check bot response\n' +
                                        mono('.uptime') + ' - Show uptime\n' +
                                        mono('.runtime') + ' - Show runtime\n' +
                                        mono('.stats') + ' - Show bot stats\n\n' +
                                        bold('AI COMMANDS:') + '\n' +
                                        mono('.ai') + ' - Ask AI anything\n' +
                                        mono('.chatbot') + ' - Toggle chatbot\n\n' +
                                        bold('GROUP COMMANDS:') + '\n' +
                                        mono('.tagall') + ' - Tag all members\n' +
                                        mono('.hidetag') + ' - Hidden tag all\n' +
                                        mono('.groupinfo') + ' - Show group info\n' +
                                        mono('.grouplink') + ' - Get group link\n\n' +
                                        bold('MEDIA COMMANDS:') + '\n' +
                                        mono('.sticker') + ' - Create sticker\n' +
                                        mono('.toimg') + ' - Sticker to image\n\n' +
                                        bold('TOOLS COMMANDS:') + '\n' +
                                        mono('.translate') + ' - Translate text\n' +
                                        mono('.weather') + ' - Weather info\n' +
                                        mono('.shorturl') + ' - Shorten URL\n' +
                                        mono('.calc') + ' - Calculator\n\n' +
                                        bold('FUN COMMANDS:') + '\n' +
                                        mono('.joke') + ' - Random joke\n' +
                                        mono('.meme') + ' - Random meme\n' +
                                        mono('.fact') + ' - Random fact\n' +
                                        mono('.quote') + ' - Random quote\n\n' +
                                        bold('STICKER COMMANDS:') + '\n' +
                                        mono('.sticker') + ' - Image to sticker\n' +
                                        mono('.stickertext') + ' - Text to sticker\n\n' +
                                        bold('DOWNLOAD COMMANDS:') + '\n' +
                                        mono('.song') + ' - Download song\n' +
                                        mono('.video') + ' - Download video\n' +
                                        mono('.ytmp3') + ' - YouTube to MP3\n' +
                                        mono('.ytmp4') + ' - YouTube to MP4\n\n' +
                                        bold('ISLAMIC COMMANDS:') + '\n' +
                                        mono('.quran') + ' - Quran verses\n' +
                                        mono('.hadith') + ' - Hadith\n' +
                                        mono('.prayer') + ' - Prayer times\n\n' +
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

                                // ===== PING =====
                                case 'ping': {
                                    const start = Date.now();
                                    await this.sock.sendMessage(from, { text: bold('Pong!') + '\n\n' + italic('Response time:') + ' ' + (Date.now() - start) + 'ms' }, { quoted: msg });
                                    break;
                                }

                                // ===== UPTIME =====
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

                                // ===== STATS =====
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

                                // ===== AI =====
                                case 'ai': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a message!') + '\n\n' + italic('Example:') + ' ' + mono('.ai Hello') }, { quoted: msg });
                                        break;
                                    }
                                    const aiResponse = await this.getAIResponse(q);
                                    await this.sock.sendMessage(from, { text: aiResponse }, { quoted: msg });
                                    break;
                                }

                                // ===== CHATBOT TOGGLE =====
                                case 'chatbot': {
                                    this.aiEnabled = !this.aiEnabled;
                                    const status = this.aiEnabled ? bold('ENABLED') : bold('DISABLED');
                                    await this.sock.sendMessage(from, { text: italic('Chatbot:') + ' ' + status }, { quoted: msg });
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

                                case 'grouplink': {
                                    if (!isAdmin) {
                                        await this.sock.sendMessage(from, { text: bold('Admin only command!') }, { quoted: msg });
                                        break;
                                    }
                                    const link = await this.sock.groupInviteCode(from);
                                    await this.sock.sendMessage(from, { text: bold('Group Link:') + '\n' + mono('https://chat.whatsapp.com/' + link) }, { quoted: msg });
                                    break;
                                }

                                // ===== MEDIA COMMANDS =====
                                case 'sticker': case 's': {
                                    if (msg.message?.imageMessage || msg.message?.videoMessage) {
                                        try {
                                            const mediaType = msg.message.imageMessage ? 'image' : 'video';
                                            const stream = await downloadMediaMessage(msg, mediaType, {});
                                            const buffer = Buffer.from(await stream.toBuffer());
                                            await this.sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
                                        } catch (e) {
                                            await this.sock.sendMessage(from, { text: bold('Failed to create sticker!') }, { quoted: msg });
                                        }
                                    } else {
                                        await this.sock.sendMessage(from, { text: bold('Reply to an image/video with ') + mono('.sticker') }, { quoted: msg });
                                    }
                                    break;
                                }

                                case 'toimg': {
                                    if (msg.message?.stickerMessage) {
                                        try {
                                            const stream = await downloadMediaMessage(msg, 'sticker', {});
                                            const buffer = Buffer.from(await stream.toBuffer());
                                            await this.sock.sendMessage(from, { image: buffer, caption: bold('Sticker converted to image!') }, { quoted: msg });
                                        } catch (e) {
                                            await this.sock.sendMessage(from, { text: bold('Failed to convert sticker!') }, { quoted: msg });
                                        }
                                    } else {
                                        await this.sock.sendMessage(from, { text: bold('Reply to a sticker!') }, { quoted: msg });
                                    }
                                    break;
                                }

                                // ===== TOOLS COMMANDS =====
                                case 'translate': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide text to translate!') + '\n\n' + italic('Example:') + ' ' + mono('.translate Hello') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Translation not available yet.') }, { quoted: msg });
                                    break;
                                }

                                case 'weather': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a city name!') + '\n\n' + italic('Example:') + ' ' + mono('.weather Lahore') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Weather not available yet.') }, { quoted: msg });
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

                                // ===== SET NAME =====
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

                                // ===== MEME =====
                                case 'meme': {
                                    const memes = [
                                        'https://i.imgur.com/1.jpg',
                                        'https://i.imgur.com/2.jpg',
                                        'https://i.imgur.com/3.jpg'
                                    ];
                                    const randomMeme = memes[Math.floor(Math.random() * memes.length)];
                                    await this.sock.sendMessage(from, { image: { url: randomMeme }, caption: bold('Here\'s a meme!') }, { quoted: msg });
                                    break;
                                }

                                // ===== YTMP3 =====
                                case 'ytmp3': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a YouTube URL!') + '\n\n' + italic('Example:') + ' ' + mono('.ytmp3 https://youtube.com/watch?v=...') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Feature not available yet.') }, { quoted: msg });
                                    break;
                                }

                                // ===== YTMP4 =====
                                case 'ytmp4': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a YouTube URL!') + '\n\n' + italic('Example:') + ' ' + mono('.ytmp4 https://youtube.com/watch?v=...') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Feature not available yet.') }, { quoted: msg });
                                    break;
                                }

                                // ===== SONG =====
                                case 'song': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a song name!') + '\n\n' + italic('Example:') + ' ' + mono('.song Believer') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Feature not available yet.') }, { quoted: msg });
                                    break;
                                }

                                // ===== VIDEO =====
                                case 'video': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a video name!') + '\n\n' + italic('Example:') + ' ' + mono('.video funny cats') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Feature not available yet.') }, { quoted: msg });
                                    break;
                                }

                                // ===== QURAN =====
                                case 'quran': {
                                    await this.sock.sendMessage(from, { text: bold('Quran feature coming soon!') }, { quoted: msg });
                                    break;
                                }

                                // ===== HADITH =====
                                case 'hadith': {
                                    await this.sock.sendMessage(from, { text: bold('Hadith feature coming soon!') }, { quoted: msg });
                                    break;
                                }

                                // ===== PRAYER =====
                                case 'prayer': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a city!') + '\n\n' + italic('Example:') + ' ' + mono('.prayer Lahore') }, { quoted: msg });
                                        break;
                                    }
                                    await this.sock.sendMessage(from, { text: bold('Prayer times feature coming soon!') }, { quoted: msg });
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

// =================== ADMIN PANEL SOCKET EVENTS ===================
const adminPassword = process.env.ADMIN_PASSWORD || 'ma_admin';

io.on('connection', (socket) => {
    // Admin authentication
    socket.on('admin-auth', (password) => {
        if (password === adminPassword) {
            socket.authenticated = true;
            socket.emit('admin-auth-success');
        } else {
            socket.emit('admin-auth-fail');
        }
    });

    // Get stats
    socket.on('get-stats', () => {
        if (!socket.authenticated) return;
        
        const totalSessions = Object.keys(sessions).length;
        const activeSessions = Object.values(sessions).filter(s => s.isConnected).length;
        const totalUsers = Object.keys(botData.userNames || {}).length;

        socket.emit('stats-data', {
            totalSessions,
            activeSessions,
            totalUsers
        });
    });

    // Get users list
    socket.on('get-users', () => {
        if (!socket.authenticated) return;
        
        const users = [];
        for (const [sessionId, session] of Object.entries(sessions)) {
            const userData = {
                sessionId,
                number: session.phoneNumber || 'Not linked',
                status: session.isConnected ? 'online' : session.sock ? 'connecting' : 'offline'
            };
            users.push(userData);
        }
        socket.emit('users-data', users);
    });

    // Send broadcast
    socket.on('send-broadcast', ({ message, adminPassword: pass }) => {
        if (pass !== adminPassword) return;
        
        let totalSent = 0;
        for (const [sessionId, session] of Object.entries(sessions)) {
            if (session.isConnected && session.sock) {
                try {
                    const chats = Object.keys(session.sock.chats || {});
                    for (const chat of chats) {
                        session.sock.sendMessage(chat, { 
                            text: bold('MA BOT BROADCAST') + '\n\n' + message + '\n\n' + bold('© MA Developers | Muhammad Ayan') 
                        });
                        totalSent++;
                    }
                } catch (e) {}
            }
        }
        socket.emit('broadcast-sent', { totalSent });
    });

    // User connection
    socket.on('set-user', (userId) => {
        userSockets[userId] = socket.id;
        if (!sessions[userId]) sessions[userId] = new BotSession(userId);
        sessions[userId].sendConnectionStatus();
    });

    // Pair request
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
    console.log(`Admin Panel: http://localhost:${PORT}/admin.html`);
    await loadExistingSessions();
});
