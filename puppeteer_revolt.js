import axios from "axios";
import { randomBytes } from "crypto";
import fs from "fs";
import express, { response } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { parse, stringify, toJSON, fromJSON } from "flatted";
import open from "open";
import { EventEmitter } from "events";
import { createInterface } from "readline";
import net from "net";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import argsParser from "args-parser";
import { generateSlug } from "random-word-slugs";

const bot_version = "revolt bot v4.26.2025.1128am-MAX-SPEED";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (process.platform == "win32") {
	process.title = bot_version;
} else {
	process.stdout.write("\x1b]2;" + bot_version + "\x1b\x5c");
}

const args = argsParser(process.argv);
var ports = {};

const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: true,
});

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox"
  ]
});

// ========================================
// RAILWAY CONFIGURATION
// ========================================

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME;
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = IS_RAILWAY ? '0.0.0.0' : 'localhost';

console.log(`[RAILWAY CONFIG] IS_RAILWAY: ${IS_RAILWAY}, PORT: ${PORT}, HOST: ${HOST}`);

// ========================================
// HELPER FUNCTIONS
// ========================================

function getRandomInt(min, max) {
	min = parseInt(min);
	max = parseInt(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
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
			return {
				folder: user,
				is_running: ports[user]?.is_running || false,
			};
		}
	});
	global_io.emit("servers", user_infos);
}

function generate_nonce(length) {
	return randomBytes(length).toString("base64").replace(/\+/g, "0").replace(/\//g, "1").substring(0, length).toUpperCase();
}

var noncePool = [];
function fillNoncePool() {
	while (noncePool.length < 1000) {
		noncePool.push(`01${generate_nonce(24)}`);
	}
}
fillNoncePool();

function getNonce() {
	if (noncePool.length < 100) {
		fillNoncePool();
	}
	return noncePool.pop() || `01${generate_nonce(24)}`;
}

// ========================================
// MAIN BOT FUNCTION
// ========================================

async function start_everything(IDENTIFIER_USER, IS_HEADLESS = true, START_IMMEDIATELY = true) {
	const original_username = IDENTIFIER_USER;
	var is_running = false;

	emit_server_info();

	const eventEmitter = new EventEmitter();
	puppeteer.use(StealthPlugin());
	var logs = [];

	if (!IDENTIFIER_USER) {
		console.log({ type: "ErrorMessage", message: "--user argument is required" });
		return 1;
	} else {
		console.log({ type: "DebugMessage", message: `Session for user "${IDENTIFIER_USER}" started` });
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

	ports[IDENTIFIER_USER] = {
		user: IDENTIFIER_USER,
		is_running: false,
	};
	emit_server_info();

	process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

	var browser = "";
	var global_page = "";

	var clientInfo = { servers: [], firstStart: true };
	var force_headful = false;

	const files = {
		responses: "responses.json",
		canReply: "canreply.json",
		responseDelay: "response_delay.json",
		isBotOn: "is_bot_on.json",
		alreadyResponded: "already_responded.txt",
		responseType: "response_type.json",
		instantResponses: "instant_responses.json",
	};

	const response_types = ["PREDEFINED", "PARSED_NUMBER"];
	const initialValues = {
		responses: {},
		canReply: [],
		responseDelay: { min_ms: 0, max_ms: 0 },
		isBotOn: { status: true },
		alreadyResponded: "",
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
	var response_delay = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/response_delay.json`).toString());
	var isBotOn = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/is_bot_on.json`).toString());
	var responseType = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/response_type.json`).toString());
	var instantResponses = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/instant_responses.json`).toString());
	var token = "";
	var error = 0;

	var newChannels = [];
	var alreadyRespondedCache = new Set(fs.existsSync(`./${IDENTIFIER_USER}/already_responded.txt`) ? fs.readFileSync(`./${IDENTIFIER_USER}/already_responded.txt`).toString().split("\n").filter((x) => x) : []);

	async function sendMessageDirect(channelId, content) {
		try {
			const nonce = getNonce();
			const result = await fetch(`https://revolt-api.onech.at/channels/${channelId}/messages`, {
				method: "POST",
				headers: {
					"X-Session-Token": token,
					"Content-Type": "application/json",
					"idempotency-key": nonce,
				},
				body: JSON.stringify({
					content: content,
					nonce: nonce,
					replies: [],
				}),
			});
			return await result.text();
		} catch (error) {
			console.error("Send error:", error.message);
			return null;
		}
	}

	eventEmitter.on("Ready", (msg) => {
		const user = msg.users[msg.users.findIndex((user) => user.relationship == "User")];
		fs.writeFileSync(`./${IDENTIFIER_USER}/account_info.json`, JSON.stringify(user));
		clientInfo = msg;
		global_io.emit("bot_info", { username: user.username, id: user._id });
		global_io.emit("serverInfo", clientInfo);
		global_io.emit("bot_version", bot_version);
		emit_server_info();
		console.log("✓ Bot Connected - " + user.username);
	});

	eventEmitter.on("Message", async (msg, page) => {
		var channel_index = clientInfo.channels.findIndex((obj) => obj._id == msg?.channel);
		var channel = channel_index != -1 ? clientInfo.channels[channel_index] : undefined;
		if (channel?.channel_type == "DirectMessage") return;

		var server_index = clientInfo.servers.findIndex((obj) => obj._id == channel?.server);
		var server = server_index != -1 ? clientInfo.servers[server_index] : undefined;
		var canReplyResult = await getCanReply(null, channel?.name, server?._id);

		if (canReplyResult.canReply) {
			var instantResponse = await getInstantResponse(msg?.content, server._id, channel?.name);
			if (instantResponse.found && instantResponse?.response) {
				await sendMessageDirect(msg?.channel, instantResponse?.response?.respondWith);
			}
		}
	});

	function addLog(log) {
		var _log = { timestamp: new Date().getTime(), log, uuid: uuidv4() };
		logs.unshift(_log);
		global_io.emit("log", _log);
		if (logs.length > 20) logs.pop();
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function getCanReply(categoryId, channelName, serverId) {
		if (responses[`${serverId}_keywords`]) {
			for (let index = 0; index < responses[`${serverId}_keywords`].length; index++) {
				const keyword = responses[`${serverId}_keywords`][index];
				if (channelName.includes(keyword)) {
					return { canReply: true, reason: "keyword match" };
				}
			}
		}
		return { canReply: canReply.includes(categoryId), reason: canReply.includes(categoryId) ? "category match" : "" };
	}

	async function getInstantResponse(message, serverId, channelName) {
		if (message && channelName) {
			for (let index = 0; index < Object.values(instantResponses[serverId] ? instantResponses[serverId] : {}).length; index++) {
				const response = Object.values(instantResponses[serverId] ? instantResponses[serverId] : {})[index];
				if (message.includes(response.message)) {
					return { found: true, response };
				}
			}
		}
		return { found: false };
	}

	async function initialize_puppeteer() {
		// Always headless on Railway - no X server available
		const headlessMode = IS_RAILWAY ? true : IS_HEADLESS;
		
		browser = await puppeteer.launch({
			userDataDir: `./${IDENTIFIER_USER}/browser-userdata`,
			headless: headlessMode,
			args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
		});
		const page = await browser.newPage();
		page.setDefaultNavigationTimeout(60000);
		await page.goto("https://revolt.onech.at/");

		const client = await page.target().createCDPSession();
		await client.send("Network.enable");

		client.on("Network.webSocketFrameSent", async ({ requestId, timestamp, response }) => {
			try {
				var parsed = JSON.parse(response.payloadData);
				if (parsed.type == "Authenticate") {
					global_page = page;
					token = parsed.token;
				}
			} catch (e) {}
		});

		client.on("Network.webSocketFrameReceived", async ({ requestId, timestamp, response }) => {
			try {
				var parsed = JSON.parse(response.payloadData);
				eventEmitter.emit(parsed.type, parsed, page);
			} catch (e) {}
		});

		setTimeout(() => {
			is_running = true;
			ports[IDENTIFIER_USER] = { user: IDENTIFIER_USER, is_running: true };
			emit_server_info();
		}, 3000);
	}

	async function start() {
		if (isBotOn.status) {
			try {
				await initialize_puppeteer();
			} catch (error) {
				console.error("Error:", error.message);
			}
		}
	}

	start();
}

// ========================================
// GLOBAL SERVER SETUP
// ========================================

const global_app = express();
const global_server = createServer(global_app);
const global_io = new Server(global_server);

global_io.on("connection", () => {
	global_io.emit("bot_version", bot_version);
	emit_server_info();
});

global_app.use(express.static(path.join(__dirname, "public/multi")));

// Main Dashboard
global_app.get("/", (req, res) => {
	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot Control Panel</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: Arial; background: #1a1a1a; color: #fff; padding: 20px; }
		.container { max-width: 1200px; margin: 0 auto; }
		h1 { color: #4CAF50; margin-bottom: 20px; }
		.btn { background: #4CAF50; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold; margin: 5px; }
		.btn:hover { background: #45a049; }
		.btn.revolt { background: #5865F2; }
		.btn.revolt:hover { background: #4752C4; }
		.servers { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px; margin-top: 20px; }
		.card { background: #2a2a2a; padding: 15px; border-radius: 8px; border-left: 4px solid #4CAF50; }
		.card h3 { margin-bottom: 10px; }
		.status { display: inline-block; padding: 5px 10px; border-radius: 3px; font-size: 12px; background: #4CAF50; margin: 5px 0; }
		.status.off { background: #f44336; }
	</style>
</head>
<body>
	<div class="container">
		<h1>🤖 Revolt Bot Control Panel</h1>
		
		<div>
			<button class="btn revolt" onclick="window.open('https://revolt.onech.at/', '_blank')">↗ Open Revolt Chat</button>
			<button class="btn" onclick="addBot()">+ Add Bot Instance</button>
		</div>

		<div class="servers" id="servers">
			<p style="color: #888;">No bot instances yet...</p>
		</div>
	</div>

	<script src="/socket.io/socket.io.js"></script>
	<script>
		const socket = io();

		function addBot() {
			fetch('/api/add_server', { method: 'POST' })
				.then(() => alert('Bot instance creating...'))
				.catch(err => alert('Error: ' + err));
		}

		function deleteBot(folder) {
			if (confirm('Delete this bot?')) {
				fetch('/api/server?server=' + folder, { method: 'DELETE' })
					.then(() => location.reload())
					.catch(err => alert('Error: ' + err));
			}
		}

		socket.on('servers', (servers) => {
			const el = document.getElementById('servers');
			if (!servers || !servers.length) {
				el.innerHTML = '<p style="color: #888;">No bot instances yet.</p>';
				return;
			}

			el.innerHTML = servers.map(s => '<div class="card"><h3>' + (s.username || s.folder) + '</h3><div class="status ' + (s.is_running ? '' : 'off') + '">' + (s.is_running ? '🟢 Running' : '🔴 Stopped') + '</div><button class="btn" style="width: 100%; margin-top: 10px;" onclick="deleteBot(\'' + s.folder + '\')">Delete</button></div>').join('');
		});
	</script>
</body>
</html>`);
});

// API Endpoints
global_app.post("/api/server", async (req, res) => {
	if (!req.query.server) return res.end("Server required");
	if (ports[req.query.server]) return res.end("Already started");
	await start_everything(req.query.server, false);
	emit_server_info();
	res.end("Starting.");
});

global_app.delete("/api/server", async (req, res) => {
	if (!req.query.server) return res.end("Server required");
	try {
		fs.rmSync(req.query.server, { recursive: true });
		delete ports[req.query.server];
		emit_server_info();
		res.status(200).end(req.query.server);
	} catch (error) {
		res.status(500).end(error.code);
	}
});

global_app.post("/api/add_server", async (req, res) => {
	const slug = "server-" + generateSlug();
	res.end(slug);
	await start_everything(slug, true, false);
	emit_server_info();
});

global_app.get("/api/servers", async (req, res) => {
	var users = fs.readdirSync("./").filter((folder) => folder.startsWith("server-"));
	var user_infos = users.map((user) => {
		if (fs.existsSync(`${user}/account_info.json`)) {
			return {
				...JSON.parse(fs.readFileSync(`${user}/account_info.json`)),
				folder: user,
				is_running: ports[user]?.is_running || false,
			};
		} else {
			return {
				folder: user,
				is_running: ports[user]?.is_running || false,
			};
		}
	});
	res.json(user_infos);
});

global_server.listen(PORT, HOST, () => {
	console.log(`[SERVER START] Listening on ${HOST}:${PORT}`);
	if (!IS_RAILWAY) {
		open(`http://localhost:${PORT}`).catch(() => {});
		setTimeout(() => {
			open(`https://revolt.onech.at/`).catch(() => {});
		}, 1000);
	}
	emit_server_info();
});

rl.input.on("keypress", async (char, key) => {
	if (key.name === "c" && key.ctrl) {
		console.log("Exiting...");
		rl.close();
		process.exit(0);
	}
});