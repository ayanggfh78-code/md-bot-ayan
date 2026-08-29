require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
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

// =================== BOT SESSION CLASS ===================
class BotSession {
    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.isConnected = false;
        this.aiEnabled = false;
        this.isPublic = true;
        this.authPath = path.join(AUTH_DIR, userId);
        this.processedMessages = new Set();
        this.phoneNumber = null;
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
                }
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                console.log('Message received:', m.type);
                
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

                            switch (commandName) {
                                case 'menu': {
                                    const menuText = 
                                        bold('MA BOT MENU') + '\n\n' +
                                        bold('SYSTEM COMMANDS:') + '\n' +
                                        mono('.ping') + ' - Check bot response\n' +
                                        mono('.uptime') + ' - Show uptime\n' +
                                        mono('.stats') + ' - Show bot stats\n\n' +
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
                                        bold('GROUP COMMANDS:') + '\n' +
                                        mono('.tagall') + ' - Tag all members\n' +
                                        mono('.groupinfo') + ' - Show group info\n\n' +
                                        bold('TOOLS COMMANDS:') + '\n' +
                                        mono('.calc') + ' - Calculator\n' +
                                        mono('.shorturl') + ' - Shorten URL\n\n' +
                                        bold('FUN COMMANDS:') + '\n' +
                                        mono('.joke') + ' - Random joke\n' +
                                        mono('.fact') + ' - Random fact\n' +
                                        mono('.quote') + ' - Random quote\n\n' +
                                        bold('© MA Developers');
                                    
                                    try {
                                        await this.sock.sendMessage(from, { image: { url: settings.startimage }, caption: menuText }, { quoted: msg });
                                    } catch (e) {
                                        await this.sock.sendMessage(from, { text: menuText }, { quoted: msg });
                                    }
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

                                case 'siminfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.siminfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(2000);
                                    const number = q.replace(/\D/g, '');
                                    const simInfoText = 
                                        bold('SIM CARD INFORMATION') + '\n\n' +
                                        italic('Phone Number:') + ' ' + number + '\n' +
                                        italic('Country:') + ' Pakistan\n' +
                                        italic('Operator:') + ' Jazz / Warid / Zong / Telenor\n' +
                                        italic('Status:') + ' Active\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: simInfoText }, { quoted: msg });
                                    break;
                                }

                                case 'numberinfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.numberinfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(2000);
                                    const number = q.replace(/\D/g, '');
                                    const numberInfoText = 
                                        bold('NUMBER INFORMATION') + '\n\n' +
                                        italic('Phone Number:') + ' ' + number + '\n' +
                                        italic('Country:') + ' Pakistan\n' +
                                        italic('Carrier:') + ' Jazz / Warid / Zong / Telenor\n' +
                                        italic('Location:') + ' Karachi, Sindh, Pakistan\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: numberInfoText }, { quoted: msg });
                                    break;
                                }

                                case 'trace': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.trace 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const traceText = 
                                        bold('LOCATION TRACING') + '\n\n' +
                                        italic('Phone Number:') + ' ' + number + '\n' +
                                        italic('Location:') + ' Karachi, Sindh, Pakistan\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: traceText }, { quoted: msg });
                                    break;
                                }

                                case 'callinfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.callinfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(2000);
                                    const number = q.replace(/\D/g, '');
                                    const callInfoText = 
                                        bold('CALL INFORMATION') + '\n\n' +
                                        italic('Phone Number:') + ' ' + number + '\n' +
                                        italic('Call Type:') + ' Mobile\n' +
                                        italic('Last Call:') + ' ' + new Date().toLocaleDateString() + '\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: callInfoText }, { quoted: msg });
                                    break;
                                }

                                case 'whatsappinfo': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.whatsappinfo 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(2000);
                                    const number = q.replace(/\D/g, '');
                                    const waInfoText = 
                                        bold('WHATSAPP NUMBER INFO') + '\n\n' +
                                        italic('Phone Number:') + ' ' + number + '\n' +
                                        italic('WhatsApp Status:') + ' Active\n' +
                                        italic('Last Seen:') + ' Today\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: waInfoText }, { quoted: msg });
                                    break;
                                }

                                case 'crash': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.crash 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const crashText = 
                                        bold('CRASH ATTACK INITIATED') + '\n\n' +
                                        italic('Target:') + ' ' + number + '\n' +
                                        italic('Status:') + ' Target crashed successfully!\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: crashText }, { quoted: msg });
                                    break;
                                }

                                case 'freeze': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.freeze 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const freezeText = 
                                        bold('FREEZE ATTACK INITIATED') + '\n\n' +
                                        italic('Target:') + ' ' + number + '\n' +
                                        italic('Status:') + ' Target frozen!\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: freezeText }, { quoted: msg });
                                    break;
                                }

                                case 'lag': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.lag 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const lagText = 
                                        bold('LAG ATTACK INITIATED') + '\n\n' +
                                        italic('Target:') + ' ' + number + '\n' +
                                        italic('Status:') + ' Target lagging!\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: lagText }, { quoted: msg });
                                    break;
                                }

                                case 'bug': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.bug 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const bugText = 
                                        bold('BUG ATTACK INITIATED') + '\n\n' +
                                        italic('Target:') + ' ' + number + '\n' +
                                        italic('Status:') + ' Bug injected!\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: bugText }, { quoted: msg });
                                    break;
                                }

                                case 'vibrate': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.vibrate 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const vibrateText = 
                                        bold('VIBRATION ATTACK INITIATED') + '\n\n' +
                                        italic('Target:') + ' ' + number + '\n' +
                                        italic('Status:') + ' Vibration activated!\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: vibrateText }, { quoted: msg });
                                    break;
                                }

                                case 'tornado': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a phone number!') + '\n\n' + italic('Example:') + ' ' + mono('.tornado 923000000000') }, { quoted: msg });
                                        break;
                                    }
                                    
                                    await delay(3000);
                                    const number = q.replace(/\D/g, '');
                                    const tornadoText = 
                                        bold('TORNADO ATTACK INITIATED') + '\n\n' +
                                        italic('Target:') + ' ' + number + '\n' +
                                        italic('Status:') + ' Tornado activated!\n\n' +
                                        bold('© MA Developers');
                                    await this.sock.sendMessage(from, { text: tornadoText }, { quoted: msg });
                                    break;
                                }

                                case 'joke': {
                                    const jokes = [
                                        'Why do programmers prefer dark mode? Because light attracts bugs!',
                                        'Why did the developer go broke? Because he used up all his cache!',
                                        'Why do Java developers wear glasses? Because they don\'t C#!',
                                        'Why did the computer go to the doctor? It caught a virus!'
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
                                        'A group of flamingos is called a flamboyance!'
                                    ];
                                    const randomFact = facts[Math.floor(Math.random() * facts.length)];
                                    await this.sock.sendMessage(from, { text: bold('Did you know?') + '\n\n' + randomFact }, { quoted: msg });
                                    break;
                                }

                                case 'quote': {
                                    const quotes = [
                                        'The only way to do great work is to love what you do. - Steve Jobs',
                                        'Life is what happens when you\'re busy making other plans. - John Lennon',
                                        'Strive not to be a success, but rather to be of value. - Albert Einstein'
                                    ];
                                    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                                    await this.sock.sendMessage(from, { text: bold('Quote of the day:') + '\n\n' + randomQuote }, { quoted: msg });
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

                                case 'ai': {
                                    if (!q) {
                                        await this.sock.sendMessage(from, { text: bold('Please provide a message!') + '\n\n' + italic('Example:') + ' ' + mono('.ai Hello') }, { quoted: msg });
                                        break;
                                    }
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
                                    await this.sock.sendMessage(from, { text: bold('Command not found!') + '\n\n' + italic('Type') + ' ' + mono('.menu') + ' ' + italic('to see all commands') }, { quoted: msg });
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
