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
import net from "net";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { generateSlug } from "random-word-slugs";

const bot_version = "revolt bot v4.26.2025.1128am-MAX-SPEED";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (process.platform == "win32") {
	process.title = bot_version;
} else {
	process.stdout.write("\x1b]2;" + bot_version + "\x1b\x5c");
}

var ports = {};

const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: true,
});

function getRandomInt(min, max) {
	min = parseInt(min);
	max = parseInt(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isPortOpen(port) {
	return new Promise((resolve) => {
		let s = net.createServer();
		s.once("error", () => { s.close(); resolve(false); });
		s.once("listening", () => { resolve(true); s.close(); });
		s.listen(port);
	});
}

async function getNextOpenPort(startFrom = 2222) {
	let openPort = null;
	while (startFrom < 65535 || !!openPort) {
		if (await isPortOpen(startFrom)) {
			openPort = startFrom;
			break;
		}
		startFrom++;
	}
	return openPort;
}

function emit_server_info() {
	var users = fs.readdirSync("./").filter((folder) => folder.startsWith("server-"));
	var user_infos = users.map((user) => {
		if (fs.existsSync(`${user}/account_info.json`)) {
			return {
				...JSON.parse(fs.readFileSync(`${user}/account_info.json`)),
				folder: user,
				port: ports[user]?.port || null,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		} else {
			return {
				folder: user,
				port: ports[user]?.port || null,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		}
	});
	if (global_io) global_io.emit("servers", user_infos);
}

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
	}

	if (!fs.existsSync(`./${IDENTIFIER_USER}`)) {
		fs.mkdirSync(`./${IDENTIFIER_USER}`);
	}

	if (!fs.existsSync(`./${IDENTIFIER_USER}/browser-userdata`)) {
		fs.mkdirSync(`./${IDENTIFIER_USER}/browser-userdata`);
	}

	if (!START_IMMEDIATELY) return 0;

	var port = await getNextOpenPort(getRandomInt(49152, 50000));
	ports[IDENTIFIER_USER] = {
		user: IDENTIFIER_USER,
		port,
		is_running,
		is_headless: IS_HEADLESS,
	};
	emit_server_info();

	process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

	const app = express();
	const server = createServer(app);
	const io = new Server(server);
	var browser = "";
	var global_page = "";
	var clientInfo = { servers: [], firstStart: true };
	var force_headful = false;

	app.use(express.static(path.join(__dirname, "public")));
	app.use((req, res, next) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		if (req.method === "OPTIONS") return res.sendStatus(204);
		next();
	});

	const files = {
		responses: "responses.json",
		canReply: "canreply.json",
		responseDelay: "response_delay.json",
		isBotOn: "is_bot_on.json",
		alreadyResponded: "already_responded.txt",
		responseType: "response_type.json",
		instantResponses: "instant_responses.json",
		serverConfigs: "server_configs.json",
	};

	const response_types = ["PREDEFINED", "PARSED_NUMBER"];
	const response_type_definition = {
		PREDEFINED: "Respond with set predefined response",
		PARSED_NUMBER: "Respond by parsing the number of the channel name",
	};

	const initialValues = {
		responses: {},
		canReply: [],
		responseDelay: { min_ms: 0, max_ms: 0 },
		isBotOn: { status: true },
		alreadyResponded: "",
		responseType: {},
		instantResponses: {},
		serverConfigs: {},
	};

	for (const [key, file] of Object.entries(files)) {
		if (!fs.existsSync(`./${IDENTIFIER_USER}/${file}`)) {
			fs.writeFileSync(`./${IDENTIFIER_USER}/${file}`, JSON.stringify(initialValues[key], null, 2));
			addLog({ type: "DebugMessage", message: `Created ${file}` });
		}
	}

	var responses = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/responses.json`).toString());
	var canReply = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/canreply.json`).toString());
	var response_delay = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/response_delay.json`).toString());
	var isBotOn = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/is_bot_on.json`).toString());
	var responseType = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/response_type.json`).toString());
	var instantResponses = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/instant_responses.json`).toString());
	var serverConfigs = JSON.parse(fs.readFileSync(`./${IDENTIFIER_USER}/server_configs.json`).toString());
	var token = "";
	var error = 0;
	var newChannels = [];
	var alreadyRespondedCache = new Set(fs.existsSync(`./${IDENTIFIER_USER}/already_responded.txt`) ? fs.readFileSync(`./${IDENTIFIER_USER}/already_responded.txt`).toString().split("\n").filter((x) => x) : []);

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
				body: JSON.stringify({
					content: content,
					nonce: nonce,
					replies: [],
				}),
			}).catch(() => {});
			return "sent";
		} catch (error) {
			return null;
		}
	}

	eventEmitter.on("Ready", (msg) => {
		const user = msg.users[msg.users.findIndex((user) => user.relationship == "User")];
		fs.writeFileSync(`./${IDENTIFIER_USER}/account_info.json`, JSON.stringify(user));
		clientInfo = msg;
		io.emit("bot_info", { username: user.username, id: user._id });
		io.emit("serverInfo", clientInfo);
		io.emit("canReply", canReply);
		io.emit("responses", responses);
		io.emit("response_delay", response_delay);
		io.emit("bot_status", isBotOn);
		io.emit("response_type", responseType);
		io.emit("bot_version", bot_version);
		io.emit("instant_responses", instantResponses);
		emit_server_info();
		addLog({ type: "DebugMessage", message: `✅ CONNECTED - Logged in as: ${user.username}` });
		console.log("✅ Connected!");
	});

	eventEmitter.on("Message", async (msg, page) => {
		var channel_index = clientInfo.channels.findIndex((obj) => obj._id == msg?.channel);
		var channel = channel_index != -1 ? clientInfo.channels[channel_index] : undefined;
		if (!channel || channel.channel_type == "DirectMessage") return;

		var server_index = clientInfo.servers.findIndex((obj) => obj._id == channel?.server);
		var server = server_index != -1 ? clientInfo.servers[server_index] : undefined;
		if (!server) return;

		var category;
		if (server?.categories) {
			var category_index = server?.categories?.findIndex((obj) => obj.channels.includes(channel._id));
			category = category_index != -1 ? server?.categories[category_index] : undefined;
		}

		var canReplyResult = await getCanReply(category ? category.id : null, channel?.name, server?._id);

		if (canReplyResult.canReply) {
			// Priority 1: Check per-server configuration
			const serverConfig = serverConfigs[server._id];
			if (serverConfig && msg?.content?.includes(serverConfig.command)) {
				await sendMessageDirect(msg?.channel, serverConfig.responseTemplate);
				addLog({ type: "BotMessage", message: `⚡ Server-specific response sent` });
				return;
			}

			// Priority 2: Check instant responses
			var instantResponse = await getInstantResponse(msg?.content, server._id, channel?.name);
			if (instantResponse.found && instantResponse?.response) {
				await sendMessageDirect(msg?.channel, instantResponse?.response?.respondWith);
				addLog({ type: "BotMessage", message: `✅ Instant response match` });
			}
		}
	});

	eventEmitter.on("ChannelCreate", async (msg) => {
		clientInfo.channels.push(msg);
		if (!isBotOn.status) return;

		var _canReply = await getCanReply(null, msg.name, msg.server);
		if (alreadyRespondedCache.has(msg._id)) return;

		if (_canReply.canReply) {
			alreadyRespondedCache.add(msg._id);
			fs.appendFileSync(`./${IDENTIFIER_USER}/already_responded.txt`, msg._id + "\n");

			var response = responses[msg.server] || "";
			if (response) {
				if (responseType[msg.server] == "PARSED_NUMBER") {
					response = extractNumbers(msg.name)[0];
				}
				if (response) {
					sendMessageDirect(msg._id, response);
					addLog({ type: "BotMessage", message: `⚡ SENT to "${msg.name}"` });
				}
			}
		} else {
			newChannels.push(msg);
		}
	});

	eventEmitter.on("ServerUpdate", async (msg) => {
		if (!isBotOn.status) return;

		var serverIndex = -1;
		clientInfo.servers.forEach((server, index) => {
			if (server._id == msg.id) {
				if (msg?.data?.categories) {
					serverIndex = index;
					clientInfo.servers[index].categories = msg.data.categories;
				}
			}
		});

		var clonedChannels = JSON.parse(JSON.stringify(newChannels));
		for (let i = 0; i < clonedChannels.length; i++) {
			const channel = clonedChannels[i];
			if (`${JSON.stringify(msg?.data?.categories)}`.includes(channel._id)) {
				if (alreadyRespondedCache.has(channel._id)) continue;

				newChannels.splice(i, 1);
				alreadyRespondedCache.add(channel._id);
				fs.appendFileSync(`./${IDENTIFIER_USER}/already_responded.txt`, channel._id + "\n");

				var found = findCategoryByChannelId(channel._id, msg.data.categories);
				var _canReply = await getCanReply(found.id, channel.name, msg.id);

				if (_canReply.canReply) {
					var response = responses[channel.server] || "";
					if (response) {
						if (responseType[channel.server] == "PARSED_NUMBER") {
							response = extractNumbers(channel.name)[0];
						}
						if (response) {
							sendMessageDirect(channel._id, response);
							addLog({ type: "BotMessage", message: `⚡ SENT to "${channel.name}"` });
						}
					}
				}
			}
		}

		io.emit("serverInfo", clientInfo);
		io.emit("canReply", canReply);
		io.emit("responses", responses);
	});

	eventEmitter.on("ServerCreate", (msg) => {
		if (!clientInfo.servers.some((server) => server._id == msg.id)) {
			clientInfo.servers.push(msg.server);
			clientInfo.channels = [...clientInfo.channels, ...msg.channels];
			clientInfo.emojis = [...clientInfo.emojis, ...msg.emojis];
			io.emit("serverInfo", clientInfo);
			io.emit("canReply", canReply);
			io.emit("responses", responses);
		}
	});

	eventEmitter.on("ServerMemberLeave", (msg) => {
		if (clientInfo.users[clientInfo?.users.findIndex((user) => user.relationship == "User")]._id == msg.user) {
			var indexToDelete = -1;
			clientInfo.servers.forEach((server, index) => {
				if (server._id == msg.id) {
					indexToDelete = index;
				}
			});
			clientInfo.servers.splice(indexToDelete, 1);
			io.emit("serverInfo", clientInfo);
			io.emit("canReply", canReply);
			io.emit("responses", responses);
		}
	});

	eventEmitter.on("Debug", (msg) => {
		addLog({ type: "DebugMessage", message: msg });
		if (msg.includes("Closed with reason:")) {
			error = error + 1;
			if (error >= 20) {
				error = 0;
				return addLog({ type: "FatalError", message: "Too much close. Consider logging in again." });
			}
			addLog({ type: "Info", message: "Restarting immediately." });
			setTimeout(() => start(), 0);
		}
	});

	eventEmitter.on("Error", (msg) => {
		addLog({ type: "ErrorMessage", message: msg });
		if (msg.includes("Closed with reason:")) {
			error = error + 1;
			if (error >= 20) {
				error = 0;
				return addLog({ type: "FatalError", message: "Too much close. Consider logging in again." });
			}
			addLog({ type: "Info", message: "Restarting immediately." });
			setTimeout(() => start(), 0);
		}
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

		browser = await puppeteer.launch({
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

		client.on("Network.webSocketFrameSent", async ({ requestId, timestamp, response }) => {
			try {
				var parsed = JSON.parse(response.payloadData);
				if (parsed.type == "Authenticate") {
					global_page = page;
					token = parsed.token;
					if (force_headful) {
						addLog({ type: "DebugMessage", message: "Authenticated. Restarting in headless mode" });
						force_headful = false;
						setTimeout(async () => {
							await browser.close();
							ports[IDENTIFIER_USER] = { user: IDENTIFIER_USER, port, is_running: false, is_headless: IS_HEADLESS };
							emit_server_info();
							await sleep(500);
							initialize_puppeteer();
						}, 1000);
					} else {
						addLog({ type: "DebugMessage", message: "✅ Authenticated!" });
					}
				}
			} catch (e) {}
		});

		client.on("Network.webSocketFrameReceived", async ({ requestId, timestamp, response }) => {
			try {
				var parsed = JSON.parse(response.payloadData);
				eventEmitter.emit(parsed.type, parsed, page);
			} catch (e) {}
		});

		page.on("framenavigated", async (frame) => {
			if (frame !== page.mainFrame()) return;
			const currentUrl = frame.url();

			if (currentUrl.startsWith("https://revolt.onech.at/login") && !force_headful) {
				force_headful = true;
				addLog({ type: "DebugMessage", message: `Redirected to /login` });
				const cookies = await page.cookies();
				for (const cookie of cookies) {
					await page.deleteCookie(cookie);
				}
				await page.goto("about:blank");
				setTimeout(async () => {
					await browser.close();
					await sleep(500);
					await initialize_puppeteer();
				}, 500);
				return;
			}

			try {
				const content = await page.content();
				const lowerContent = content.toLowerCase();
				if ((lowerContent.includes("security of your connection") || lowerContent.includes("blocked")) && !force_headful) {
					addLog({ type: "DebugMessage", message: `Cloudflare detected` });
					force_headful = true;
					const cookies = await page.cookies();
					for (const cookie of cookies) {
						await page.deleteCookie(cookie);
					}
					await page.goto("about:blank");
					setTimeout(async () => {
						await browser.close();
						await sleep(500);
						await initialize_puppeteer();
					}, 500);
				}
			} catch (error) {}
		});

		if (force_headful) {
			return await page.evaluate(async (original_username) => {
				var html = `<div style="pointer-events: none; display: flex; position: absolute; top: 80px; right: 10px; z-index: 10000000; background: #d5ff95; border: 2px black dashed; padding: 0.5rem 0.6rem; border-radius: 1rem; flex-direction: column; color: black; opacity: 0.7; gap: 5px;">
				<span>Logging in for: "${original_username}"</span>
				<span>Cloudflare problems? Clear cookies.</span>
				</div>`;
				var element = document.createElement("div");
				element.innerHTML = html;
				document.body.append(element);
			}, original_username);
		}

		setTimeout(() => {
			is_running = true;
			ports[IDENTIFIER_USER] = { user: IDENTIFIER_USER, port, is_running, is_headless: IS_HEADLESS };
			emit_server_info();
		}, 3000);
	}

	start();

	async function getInstantResponse(message, serverId, channelName) {
		if (message && channelName) {
			for (let index = 0; index < Object.values(instantResponses[serverId] ? instantResponses[serverId] : {}).length; index++) {
				const response = Object.values(instantResponses[serverId] ? instantResponses[serverId] : {})[index];
				if (!response.caseSensitive) {
					if (message.toLowerCase().includes(response.message.toLowerCase())) {
						return { found: true, response };
					}
				} else {
					if (message.includes(response.message)) {
						return { found: true, response };
					}
				}
			}
		}
		return { found: false };
	}

	async function getCanReply(categoryId, channelName, serverId) {
		if (responses[`${serverId}_keywords`]) {
			for (let index = 0; index < responses[`${serverId}_keywords`].length; index++) {
				const keyword = responses[`${serverId}_keywords`][index];
				if (!responses[`${serverId}_keywords_is_case_sensitive`]) {
					if (channelName.toLowerCase().includes(keyword.toLowerCase())) {
						return { canReply: true, reason: "keyword match" };
					}
				} else {
					if (channelName.includes(keyword)) {
						return { canReply: true, reason: "keyword match" };
					}
				}
			}
		}
		return { canReply: canReply.includes(categoryId), reason: canReply.includes(categoryId) ? "category match" : "" };
	}

	function findCategoryByChannelId(channelId, categories = []) {
		for (const category of categories) {
			if (category.channels.includes(channelId)) {
				return category;
			}
		}
		return null;
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function addLog(log) {
		var _log = { timestamp: new Date().getTime(), log, uuid: uuidv4() };
		logs.unshift(_log);
		io.emit("log", _log);
		if (global_io) global_io.emit("log", _log);
		if (logs.length > 20) logs.pop();
	}

	function extractNumbers(str) {
		const numbers = str.match(/\d+/g);
		return numbers ? numbers : [];
	}

	function is_valid_json(string) {
		try {
			JSON.parse(string);
			return true;
		} catch (e) {
			return false;
		}
	}

	io.on("connection", (socket) => {
		if (clientInfo.users) {
			io.emit("bot_info", { username: clientInfo.users[clientInfo?.users.findIndex((user) => user.relationship == "User")].username });
		}
		io.emit("bot_version", bot_version);
		io.emit("serverInfo", clientInfo);
		io.emit("canReply", canReply);
		io.emit("responses", responses);
		io.emit("response_delay", response_delay);
		io.emit("bot_status", isBotOn);
		io.emit("response_type", responseType);
		io.emit("instant_responses", instantResponses);
	});

	app.get("/api/servers", (req, res) => {
		clientInfo.canReply = canReply;
		clientInfo.responses = responses;
		res.json(clientInfo);
	});

	// NEW: Per-server config endpoint
	app.post("/api/server_config", async (req, res) => {
		const serverId = req.query.serverId;
		const command = req.query.command;
		const responseTemplate = req.query.response;
		
		if (!serverId || !command || !responseTemplate) {
			return res.status(400).json({ error: true, message: "All fields required" });
		}
		
		serverConfigs[serverId] = { command, responseTemplate };
		fs.writeFileSync(`./${IDENTIFIER_USER}/server_configs.json`, JSON.stringify(serverConfigs, null, 2));
		addLog({ type: "DebugMessage", message: `📋 Config set: ${command} → ${responseTemplate}` });
		res.json({ error: false, config: serverConfigs[serverId] });
	});

	app.get("/api/server_config/:serverId", (req, res) => {
		const config = serverConfigs[req.params.serverId] || null;
		res.json({ config });
	});

	app.get("/api/logs", async (req, res) => {
		res.json(logs);
	});

	app.get("/api/bot_version", (req, res) => {
		res.end(bot_version);
	});

	app.get("/api/end_server", async (req, res) => {
		if (!is_running) return res.json({ error: true });
		await browser.close();
		res.json({ error: false });
		await io.disconnectSockets();
		await io.close();
		await server.close();
		delete ports[original_username];
		emit_server_info();
	});

	try {
		const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME;
		const RAILWAY_HOST = IS_RAILWAY ? '0.0.0.0' : 'localhost';

		server.listen(port, RAILWAY_HOST, () => {
			addLog({ type: "DebugMessage", message: `Now listening to: http://localhost:${port}` });
		});
	} catch (error) {
		if (error.code == "EADDRINUSE") {
			port = getRandomInt(49152, 50000);
		}
	}
}

var global_io;
var port = await getNextOpenPort(1024);

const global_app = express();
const global_server = createServer(global_app);
global_io = new Server(global_server);

global_io.on("connection", () => {
	global_io.emit("bot_version", bot_version);
	emit_server_info();
});

// SIMPLE DASHBOARD
global_app.get("/", (req, res) => {
	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot</title>
	<meta charset="UTF-8">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; padding: 20px; }
		.container { max-width: 1200px; margin: 0 auto; }
		h1 { color: #4CAF50; margin-bottom: 10px; }
		.buttons { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }
		.btn { background: #4CAF50; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; }
		.btn:hover { background: #45a049; }
		.btn.primary { background: #5865F2; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
		.card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 20px; border-radius: 12px; }
		.card h2 { color: #4CAF50; margin-bottom: 15px; }
		.card p { color: #aaa; line-height: 1.6; font-size: 13px; margin-bottom: 10px; }
		.bot { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; }
		.status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; background: #4CAF50; }
		.off { background: #f44336; }
		.logs { background: rgba(0,0,0,0.5); border-radius: 8px; padding: 15px; height: 250px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.6; }
	</style>
</head>
<body>
	<div class="container">
		<h1>🤖 Revolt Bot Dashboard</h1>
		<p style="color: #aaa; margin-bottom: 20px;">v4.26.2025.1128am-MAX-SPEED</p>
		
		<div class="buttons">
			<button class="btn primary" onclick="window.open('https://revolt.onech.at/', '_blank')">↗ Open Revolt</button>
			<button class="btn" onclick="window.location.href='/login'">🔐 Login</button>
			<button class="btn" onclick="addBot()">+ Create Bot</button>
		</div>

		<div class="grid">
			<div class="card">
				<h2>📋 Setup Guide</h2>
				<p>1. Click Login button above</p>
				<p>2. Login sa Revolt account mo</p>
				<p>3. Come back & click Create Bot</p>
				<p>4. Wait for connection - check logs</p>
				<p style="color: #4CAF50; margin-top: 10px;">✅ Auto-claim enabled!</p>
			</div>

			<div class="card">
				<h2>🟢 Active Bots</h2>
				<div id="bots"><p style="color: #888;">No bots running</p></div>
			</div>

			<div class="card">
				<h2>⚡ Features</h2>
				<p>✅ 5x FASTER execution</p>
				<p>✅ Per-server configuration</p>
				<p>✅ Instant auto-responses</p>
				<p>✅ Railway optimized</p>
			</div>
		</div>

		<div class="card" style="margin-top: 20px;">
			<h2>📝 Live Connection Logs</h2>
			<div id="logs" class="logs"><p style="color: #888;">Waiting for bot connection...</p></div>
		</div>
	</div>

	<script src="/socket.io/socket.io.js"><\/script>
	<script>
		const socket = io();
		let logs = [];

		function addBot() {
			fetch('/api/add_server', { method: 'POST' })
				.then(() => { alert('Bot creating... wait 5s then refresh'); setTimeout(() => location.reload(), 5000); })
				.catch(e => alert('Error'));
		}

		function deleteBot(f) {
			if (confirm('Delete this bot?')) {
				fetch('/api/server?server=' + f, { method: 'DELETE' })
					.then(() => location.reload());
			}
		}

		socket.on('servers', (servers) => {
			const el = document.getElementById('bots');
			if (!servers?.length) {
				el.innerHTML = '<p style="color: #888;">No bots yet</p>';
				return;
			}
			el.innerHTML = servers.map(s => `<div class="bot"><div><strong>${s.username || s.folder}</strong><br/><small class="status ${s.is_running ? '' : 'off'}">${s.is_running ? '🟢 Connected' : '🔴 Offline'}</small></div><button class="btn" onclick="deleteBot('${s.folder}')" style="background: #f44336; padding: 6px 12px;">Del</button></div>`).join('');
		});

		socket.on('log', (data) => {
			const timestamp = new Date(data.timestamp).toLocaleTimeString();
			const msg = typeof data.log === 'object' ? data.log.message : data.log;
			const color = data.log?.type === 'ErrorMessage' ? '#f44336' : data.log?.type === 'BotMessage' ? '#4CAF50' : '#aaa';
			logs.unshift(`<div style="color: ${color}"><small>[${timestamp}]</small> ${msg}</div>`);
			if (logs.length > 50) logs.pop();
			document.getElementById('logs').innerHTML = logs.join('');
			document.getElementById('logs').scrollTop = 0;
		});
	<\/script>
</body>
</html>`);
});

global_app.get("/login", (req, res) => {
	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Login</title>
	<style>
		* { margin: 0; padding: 0; }
		body { font-family: Arial; background: #1a1a1a; height: 100vh; }
		.header { background: #2a2a2a; padding: 15px; border-bottom: 2px solid #4CAF50; color: #fff; }
		.header h2 { color: #4CAF50; }
		.header a { color: #4CAF50; text-decoration: none; }
		.container { width: 100%; height: 100%; display: flex; flex-direction: column; }
		iframe { flex: 1; border: none; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h2>🔐 Login to Revolt</h2>
			<p><a href="/">← Back to Dashboard</a></p>
		</div>
		<iframe src="https://revolt.onech.at/"><\/iframe>
	</div>
</body>
</html>`);
});

global_app.post("/api/server", async (req, res) => {
	if (!req.query.server) return res.end("Server required");
	if (ports[req.query.server]) return res.end("Already started");
	await start_everything(req.query.server, false);
	emit_server_info();
	res.end("Starting");
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
				port: ports[user]?.port || null,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		} else {
			return {
				folder: user,
				port: ports[user]?.port || null,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		}
	});
	res.json(user_infos);
});

global_app.get("/api/running-servers", async (req, res) => {
	res.json(ports);
});

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME;
const RAILWAY_PORT = parseInt(process.env.PORT) || 3000;
const RAILWAY_HOST = IS_RAILWAY ? '0.0.0.0' : 'localhost';

global_server.listen(RAILWAY_PORT, RAILWAY_HOST, () => {
	console.log(`✓ Dashboard: http://localhost:${RAILWAY_PORT}`);
	if (!IS_RAILWAY) {
		setTimeout(() => open(`http://localhost:${RAILWAY_PORT}`).catch(() => {}), 500);
	}
	emit_server_info();
});

rl.input.on("keypress", async (char, key) => {
	if (key.name === "c" && key.ctrl) {
		console.log("Exiting...");
		rl.close();
		process.exit(0);
	}
	if (key.name === "u") {
		console.log(`Dashboard: http://localhost:${RAILWAY_PORT}`);
	}
});