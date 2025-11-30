import axios from "axios";
import { randomBytes } from "crypto";
import fs from "fs";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import open from "open";
import { EventEmitter } from "events";
import { createInterface } from "readline";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { generateSlug } from "random-word-slugs";

const bot_version = "v4.26.2025-RAILWAY-MINIMAL";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.platform == "win32") {
	process.title = bot_version;
} else {
	process.stdout.write("\x1b]2;" + bot_version + "\x1b\x5c");
}

var ports = {};
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

function generate_nonce(length) {
	return randomBytes(length).toString("base64").replace(/\+/g, "0").replace(/\//g, "1").substring(0, length).toUpperCase();
}

var noncePool = [];
function fillNoncePool() {
	while (noncePool.length < 5000) {
		noncePool.push(`01${generate_nonce(24)}`);
	}
}
fillNoncePool();
setInterval(fillNoncePool, 50);

function getNonce() {
	if (noncePool.length < 500) setImmediate(fillNoncePool);
	return noncePool.pop() || `01${generate_nonce(24)}`;
}

function emit_server_info() {
	var users = fs.readdirSync("./").filter((folder) => folder.startsWith("server-"));
	var user_infos = users.map((user) => {
		if (fs.existsSync(`${user}/account_info.json`)) {
			return {
				...JSON.parse(fs.readFileSync(`${user}/account_info.json`)),
				folder: user,
				is_running: ports[user]?.is_running || false,
			};
		} else {
			return { folder: user, is_running: ports[user]?.is_running || false };
		}
	});

	if (global_io) {
		global_io.emit("servers", user_infos);
	}
}

async function start_everything(IDENTIFIER_USER, IS_HEADLESS = true, START_IMMEDIATELY = true) {
	const original_username = IDENTIFIER_USER;
	var is_running = false;

	emit_server_info();

	const eventEmitter = new EventEmitter();
	puppeteer.use(StealthPlugin());

	if (!IDENTIFIER_USER) {
		console.log("User argument is required");
		return 1;
	}

	if (!fs.existsSync(`./${IDENTIFIER_USER}`)) {
		fs.mkdirSync(`./${IDENTIFIER_USER}`);
	}

	if (!fs.existsSync(`./${IDENTIFIER_USER}/browser-userdata`)) {
		fs.mkdirSync(`./${IDENTIFIER_USER}/browser-userdata`);
	}

	if (!START_IMMEDIATELY) {
		return 0;
	}

	ports[IDENTIFIER_USER] = { user: IDENTIFIER_USER, is_running, is_headless: IS_HEADLESS };
	emit_server_info();

	process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

	var clientInfo = { servers: [], firstStart: true };
	var force_headful = false;
	var token = "";

	const files = {
		responses: "responses.json",
		canReply: "canreply.json",
		responseDelay: "response_delay.json",
		isBotOn: "is_bot_on.json",
		responseType: "response_type.json",
		instantResponses: "instant_responses.json",
	};

	const initialValues = {
		responses: {},
		canReply: [],
		responseDelay: { min_ms: 0, max_ms: 0 },
		isBotOn: { status: true },
		responseType: {},
		instantResponses: {},
	};

	for (const [key, file] of Object.entries(files)) {
		if (!fs.existsSync(`./${IDENTIFIER_USER}/${file}`)) {
			fs.writeFileSync(`./${IDENTIFIER_USER}/${file}`, JSON.stringify(initialValues[key], null, 2));
		}
	}

	var responses = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/responses.json`).toString());
	var canReply = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/canreply.json`).toString());
	var isBotOn = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/is_bot_on.json`).toString());
	var responseType = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/response_type.json`).toString());
	var instantResponses = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/instant_responses.json`).toString());

	async function sendMessageDirect(channelId, content) {
		try {
			const nonce = getNonce();
			fetch(`https://revolt-api.onech.at/channels/${channelId}/messages`, {
				method: "POST",
				headers: {
					"X-Session-Token": token,
					"Content-Type": "application/json",
					"idempotency-key": nonce,
				},
				body: JSON.stringify({ content, nonce, replies: [] }),
			}).catch(() => {});
			return "sent";
		} catch (error) {
			console.error("Send error:", error.message);
			return null;
		}
	}

	function addLog(msg) {
		global_io.emit("log_" + IDENTIFIER_USER, { timestamp: new Date().getTime(), log: msg, uuid: uuidv4() });
	}

	eventEmitter.on("Ready", (msg) => {
		const user = msg.users[msg.users.findIndex((user) => user.relationship == "User")];
		fs.writeFileSync(`./${IDENTIFIER_USER}/account_info.json`, JSON.stringify(user));
		clientInfo = msg;
		global_io.emit("bot_info_" + IDENTIFIER_USER, { username: user.username, id: user._id });
		global_io.emit("server_info_" + IDENTIFIER_USER, clientInfo);
		console.log("✅ Connected:", user.username);
	});

	eventEmitter.on("Debug", (msg) => {
		addLog({ type: "DebugMessage", message: msg });
	});

	eventEmitter.on("Error", (msg) => {
		addLog({ type: "ErrorMessage", message: msg });
	});

	async function start() {
		if (isBotOn.status) {
			try {
				addLog({ type: "DebugMessage", message: "Opening Puppeteer browser" });
				await initialize_puppeteer();
			} catch (error) {
				addLog({ type: "ErrorMessage", message: error.message });
			}
		} else {
			addLog({ type: "BotStatus", message: "Bot is OFF" });
		}
	}

	async function initialize_puppeteer() {
		const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME;
		const headlessMode = IS_RAILWAY ? true : (force_headful ? false : IS_HEADLESS);

		let browser = await puppeteer.launch({
			userDataDir: `./${IDENTIFIER_USER}/browser-userdata`,
			headless: headlessMode,
			args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
		});
		const page = await browser.newPage();
		page.setDefaultNavigationTimeout(60000);
		await page.goto("https://revolt.onech.at/");

		addLog({ type: "DebugMessage", message: "Puppeteer launched" });

		const client = await page.target().createCDPSession();
		await client.send("Network.enable");

		client.on("Network.webSocketFrameSent", async ({ response }) => {
			try {
				var parsed = JSON.parse(response.payloadData);
				if (parsed.type == "Authenticate") {
					token = parsed.token;
					addLog({ type: "DebugMessage", message: "✅ Authenticated" });
				}
			} catch (e) {}
		});

		client.on("Network.webSocketFrameReceived", async ({ response }) => {
			try {
				var parsed = JSON.parse(response.payloadData);
				eventEmitter.emit(parsed.type, parsed, page);
			} catch (e) {}
		});

		setTimeout(() => {
			is_running = true;
			ports[IDENTIFIER_USER] = { user: IDENTIFIER_USER, is_running, is_headless: IS_HEADLESS };
			emit_server_info();
		}, 3000);
	}

	start();
}

var global_io;

const global_app = express();
const global_server = createServer(global_app);
global_io = new Server(global_server);

global_io.on("connection", () => {
	global_io.emit("bot_version", bot_version);
	emit_server_info();
});

global_app.use(express.static(path.join(__dirname, "public/multi")));

global_app.post("/api/add_server", async (req, res) => {
	const slug = "server-" + generateSlug();
	console.log(`Creating bot: ${slug}`);
	
	// Start bot in background
	start_everything(slug, true, true);
	
	// Respond immediately
	res.json({ success: true, botId: slug });
	
	// Emit updates
	setTimeout(() => emit_server_info(), 500);
});

global_app.delete("/api/server", async (req, res) => {
	if (!req.query.server) return res.end("Server is required");
	try {
		fs.rmSync(req.query.server, { recursive: true });
		emit_server_info();
		res.status(200).end(req.query.server);
	} catch (error) {
		res.status(500).end(error.code);
	}
});

global_app.get("/api/servers", async (req, res) => {
	var users = fs.readdirSync("./").filter((folder) => folder.startsWith("server-"));
	var user_infos = users.map((user) => {
		if (fs.existsSync(`${user}/account_info.json`)) {
			return { ...JSON.parse(fs.readFileSync(`${user}/account_info.json`)), folder: user, is_running: ports[user]?.is_running || false };
		} else {
			return { folder: user, is_running: ports[user]?.is_running || false };
		}
	});
	res.json(user_infos);
});

global_app.get("/", (req, res) => {
	var users = fs.readdirSync("./").filter((folder) => folder.startsWith("server-"));
	var user_infos = users.map((user) => {
		if (fs.existsSync(`${user}/account_info.json`)) {
			return { ...JSON.parse(fs.readFileSync(`${user}/account_info.json`)), folder: user, is_running: ports[user]?.is_running || false };
		} else {
			return { folder: user, is_running: ports[user]?.is_running || false };
		}
	});

	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot Manager</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: 'Segoe UI'; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; padding: 20px; }
		.container { max-width: 1200px; margin: 0 auto; }
		.header { background: rgba(0,0,0,0.5); padding: 20px; border-radius: 12px; border-left: 4px solid #4CAF50; margin-bottom: 20px; }
		.header h1 { color: #4CAF50; }
		.btn { background: #4CAF50; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-bottom: 20px; }
		.btn:hover { background: #45a049; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
		.card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 15px; border-radius: 12px; cursor: pointer; }
		.card:hover { background: rgba(255,255,255,0.08); }
		.card h3 { color: #4CAF50; margin-bottom: 8px; }
		.card p { color: #aaa; font-size: 12px; margin-bottom: 10px; }
		.status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; background: #4CAF50; }
		.status.off { background: #f44336; }
		.card-btn { background: #5865F2; color: #fff; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-right: 8px; font-weight: bold; }
		.card-btn:hover { background: #4752C4; }
		.card-btn.delete { background: #f44336; }
		.card-btn.delete:hover { background: #da190b; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>🤖 Revolt Bot Manager</h1>
			<p>All bots on Railway</p>
		</div>

		<button class="btn" onclick="createBot()">+ Create New Bot</button>

		<div class="grid">
			${user_infos.length === 0 ? '<div style="grid-column: 1/-1; color: #aaa; text-align: center; padding: 40px;">No bots yet. Click "+ Create New Bot"</div>' : user_infos.map(bot => `
				<div class="card" onclick="window.location.href='/bot/${bot.folder}'">
					<h3>${bot.username || bot.folder}</h3>
					<p>ID: ${bot.folder}</p>
					<p><span class="status ${bot.is_running ? '' : 'off'}">${bot.is_running ? '🟢 Running' : '🔴 Offline'}</span></p>
					<div>
						<button class="card-btn" onclick="event.stopPropagation(); window.location.href='/bot/${bot.folder}'">📊 Dashboard</button>
						<button class="card-btn delete" onclick="event.stopPropagation(); deleteBot('${bot.folder}')">Delete</button>
					</div>
				</div>
			`).join('')}
		</div>
	</div>

	<script>
		function createBot() {
			fetch('/api/add_server', { method: 'POST' })
				.then(() => { alert('Bot creating...'); setTimeout(() => location.reload(), 2000); })
				.catch(e => alert('Error: ' + e));
		}

		function deleteBot(folder) {
			if (!confirm('Delete this bot?')) return;
			fetch('/api/server?server=' + folder, { method: 'DELETE' })
				.then(() => { alert('Bot deleted'); location.reload(); })
				.catch(e => alert('Error: ' + e));
		}
	<\/script>
</body>
</html>`);
});

global_app.get("/bot/:serverId", (req, res) => {
	const serverId = req.params.serverId;
	const bot = ports[serverId];

	if (!bot) {
		return res.send(`<html><body><h1>❌ Bot not found</h1><p><a href="/">← Back</a></p></body></html>`);
	}

	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot - ${serverId}</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: 'Segoe UI'; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; padding: 20px; }
		.container { max-width: 1200px; margin: 0 auto; }
		.header { background: rgba(0,0,0,0.5); padding: 20px; border-radius: 12px; border-left: 4px solid #4CAF50; margin-bottom: 20px; }
		.header h1 { color: #4CAF50; }
		.buttons { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
		.btn { background: #4CAF50; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; }
		.btn:hover { background: #45a049; }
		.btn.primary { background: #5865F2; }
		.btn.primary:hover { background: #4752C4; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
		.card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 20px; border-radius: 12px; }
		.card h2 { color: #4CAF50; margin-bottom: 15px; }
		.card p { color: #aaa; margin-bottom: 10px; font-size: 13px; line-height: 1.6; }
		.logs { background: rgba(0,0,0,0.5); border-radius: 8px; padding: 15px; height: 300px; overflow-y: auto; font-family: monospace; font-size: 11px; line-height: 1.6; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>🤖 ${serverId}</h1>
			<p>Status: <span id="status" style="color: #4CAF50;">🟢 Connecting...</span></p>
		</div>

		<div class="buttons">
			<button class="btn primary" onclick="openLogin()">🔐 Open Login Tab</button>
			<button class="btn" onclick="location.reload()">🔄 Reload</button>
			<button class="btn" onclick="window.location.href='/'">← Back</button>
		</div>

		<div class="grid">
			<div class="card">
				<h2>📋 Setup</h2>
				<p>1. Click "🔐 Open Login Tab"</p>
				<p>2. Login sa Revolt</p>
				<p>3. Close tab</p>
				<p>4. Bot connects! ✅</p>
			</div>

			<div class="card">
				<h2>📊 Bot Info</h2>
				<p>User: <strong id="username">Waiting...</strong></p>
				<p>Servers: <strong id="servers">0</strong></p>
			</div>

			<div class="card">
				<h2>⚡ Features</h2>
				<p>✅ Railway Ready</p>
				<p>✅ Fast</p>
				<p>✅ Working</p>
			</div>
		</div>

		<div class="card" style="margin-top: 20px;">
			<h2>📝 Logs</h2>
			<div id="logs" class="logs"><p style="color: #888;">Waiting...</p></div>
		</div>
	</div>

	<script src="/socket.io/socket.io.js"><\/script>
	<script>
		const socket = io();
		let logs = [];
		const serverId = '${serverId}';

		function openLogin() {
			window.open('/bot/${serverId}/login', '_blank', 'width=900,height=700');
		}

		socket.on('connect', () => {
			document.getElementById('status').textContent = '🟢 Connected';
		});

		socket.on('disconnect', () => {
			document.getElementById('status').textContent = '🔴 Disconnected';
		});

		socket.on('bot_info_' + serverId, (data) => {
			if (data.username) document.getElementById('username').textContent = data.username;
		});

		socket.on('server_info_' + serverId, (data) => {
			if (data) {
				document.getElementById('servers').textContent = data.servers?.length || 0;
			}
		});

		socket.on('log_' + serverId, (data) => {
			const time = new Date(data.timestamp).toLocaleTimeString();
			const msg = typeof data.log === 'object' ? (data.log.message || JSON.stringify(data.log)) : String(data.log);
			const color = data.log?.type === 'ErrorMessage' ? '#f44336' : data.log?.type === 'BotMessage' ? '#4CAF50' : '#aaa';
			
			logs.unshift('<div style="color:' + color + '"><small>[' + time + ']</small> ' + msg + '</div>');
			if (logs.length > 50) logs.pop();
			
			const el = document.getElementById('logs');
			el.innerHTML = logs.join('');
			el.scrollTop = 0;
		});
	<\/script>
</body>
</html>`);
});

global_app.get("/bot/:serverId/login", (req, res) => {
	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Login</title>
	<style>
		* { margin: 0; padding: 0; }
		body { font-family: Arial; background: #1a1a1a; height: 100vh; }
		.container { width: 100%; height: 100%; display: flex; flex-direction: column; }
		.header { background: #2a2a2a; padding: 15px; border-bottom: 2px solid #4CAF50; color: #fff; }
		.header h2 { color: #4CAF50; margin-bottom: 5px; }
		a { color: #4CAF50; cursor: pointer; text-decoration: none; font-weight: bold; }
		a:hover { text-decoration: underline; }
		iframe { flex: 1; border: none; width: 100%; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h2>🔐 Login to Revolt</h2>
			<p style="color: #aaa; font-size: 13px; margin-top: 8px;">Login with your Revolt account. Once done, close this tab.</p>
			<p style="margin-top: 8px;"><a onclick="window.close()">✕ Close Tab</a></p>
		</div>
		<iframe src="https://revolt.onech.at/"><\/iframe>
	</div>
</body>
</html>`);
});

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME;
const RAILWAY_PORT = parseInt(process.env.PORT) || 3000;
const RAILWAY_HOST = IS_RAILWAY ? '0.0.0.0' : 'localhost';

global_server.listen(RAILWAY_PORT, RAILWAY_HOST, () => {
	const url = IS_RAILWAY ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${RAILWAY_PORT}`;
	console.log(`✅ Dashboard: ${url}`);
	if (!IS_RAILWAY) {
		open(url).catch(() => {});
	}
	emit_server_info();
});

rl.input.on("keypress", async (char, key) => {
	if (key.name === "c" && key.ctrl) {
		console.log("\n👋 Shutting down...");
		rl.close();
		process.exit(0);
	}
});