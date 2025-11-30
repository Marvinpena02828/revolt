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

const bot_version = "revolt bot v4.26.2025.1128am-RAILWAY";

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

function getRandomInt(min, max) {
	min = parseInt(min);
	max = parseInt(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isPortOpen(port) {
	return new Promise((resolve, reject) => {
		let s = net.createServer();
		s.once("error", (err) => {
			s.close();
			if (err["code"] == "EADDRINUSE") {
				resolve(false);
			} else {
				resolve(false);
			}
		});
		s.once("listening", () => {
			resolve(true);
			s.close();
		});
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
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		} else {
			return {
				folder: user,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		}
	});

	if (global_io) {
		global_io.emit("servers", user_infos);
	}
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
	if (noncePool.length < 500) {
		setImmediate(fillNoncePool);
	}
	return noncePool.pop() || `01${generate_nonce(24)}`;
}

async function start_everything(IDENTIFIER_USER, IS_HEADLESS = true, START_IMMEDIATELY = true) {
	const original_username = IDENTIFIER_USER;
	var is_running = false;

	emit_server_info();

	const eventEmitter = new EventEmitter();
	puppeteer.use(StealthPlugin());

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
		is_running,
		is_headless: IS_HEADLESS,
	};
	emit_server_info();

	process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

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
		serverConfigs: "server_configs.json",
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
		serverConfigs: {},
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
			console.error("Send error:", error.message);
			return null;
		}
	}

	function addLog(log) {
		var _log = { timestamp: new Date().getTime(), log, uuid: uuidv4() };
		global_io.emit("log_" + IDENTIFIER_USER, _log);
	}

	eventEmitter.on("Ready", (msg) => {
		const user = msg.users[msg.users.findIndex((user) => user.relationship == "User")];
		fs.writeFileSync(`./${IDENTIFIER_USER}/account_info.json`, JSON.stringify(user));
		clientInfo = msg;
		global_io.emit("bot_info_" + IDENTIFIER_USER, { username: user.username, id: user._id });
		global_io.emit("server_info_" + IDENTIFIER_USER, clientInfo);
		console.log("✅ Connected:", user.username);
	});

	eventEmitter.on("Message", async (msg, page) => {
		var channel_index = clientInfo.channels.findIndex((obj) => obj._id == msg?.channel);
		var channel = channel_index != -1 ? clientInfo.channels[channel_index] : undefined;

		if (channel?.channel_type == "DirectMessage") {
			return;
		}

		var server_index = clientInfo.servers.findIndex((obj) => obj._id == channel?.server);
		var server = server_index != -1 ? clientInfo.servers[server_index] : undefined;

		var category;
		if (server?.categories) {
			var category_index = server?.categories?.findIndex((obj) => obj.channels.includes(channel._id));
			category = category_index != -1 ? server?.categories[category_index] : undefined;
		}

		var canReplyResult = await getCanReply(category ? category.id : null, channel?.name, server?._id);

		if (canReplyResult.canReply) {
			var instantResponse = await getInstantResponse(msg?.content, server._id, channel?.name);

			if (instantResponse.found) {
				if (instantResponse?.response) {
					await sendMessageDirect(msg?.channel, instantResponse?.response?.respondWith);
					addLog({ type: "BotMessage", message: `⚡ SENT to "${channel.name}"` });
				}
			}
		}
	});

	eventEmitter.on("ChannelCreate", async (msg, page) => {
		clientInfo.channels.push(msg);

		if (!isBotOn.status) {
			return;
		}

		var _canReply = await getCanReply(null, msg.name, msg.server);

		if (alreadyRespondedCache.has(msg._id)) {
			return;
		}

		if (_canReply.canReply) {
			alreadyRespondedCache.add(msg._id);
			fs.appendFileSync(`./${IDENTIFIER_USER}/already_responded.txt`, msg._id + "\n");

			var response = responses[msg.server] || "";

			if (response) {
				setImmediate(async () => {
					try {
						if (responseType[msg.server] == "PARSED_NUMBER") {
							response = extractNumbers(msg.name)[0];
						}

						if (response) {
							await sendMessageDirect(msg._id, response);
							addLog({ type: "BotMessage", message: `⚡ SENT to "${msg.name}"` });
						}
					} catch (error) {
						console.error("Error:", error.message);
					}
				});
			}
		} else {
			newChannels.push(msg);
		}
	});

	eventEmitter.on("ServerUpdate", async (msg, page) => {
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
				if (alreadyRespondedCache.has(channel._id)) {
					continue;
				}

				newChannels.splice(i, 1);

				alreadyRespondedCache.add(channel._id);
				fs.appendFileSync(`./${IDENTIFIER_USER}/already_responded.txt`, channel._id + "\n");

				var found = findCategoryByChannelId(channel._id, msg.data.categories);
				var _canReply = await getCanReply(found.id, channel.name, msg.id);

				if (_canReply.canReply) {
					var response = responses[channel.server] || "";

					if (response) {
						setImmediate(async () => {
							try {
								if (responseType[channel.server] == "PARSED_NUMBER") {
									response = extractNumbers(channel.name)[0];
								}

								if (response) {
									await sendMessageDirect(channel._id, response);
									addLog({ type: "BotMessage", message: `⚡ SENT to "${channel.name}"` });
								}
							} catch (error) {
								console.error("Error:", error.message);
							}
						});
					}
				}
			}
		}

		global_io.emit("server_info_" + IDENTIFIER_USER, clientInfo);
	});

	eventEmitter.on("ServerCreate", (msg) => {
		if (!clientInfo.servers.some((server) => server._id == msg.id)) {
			clientInfo.servers.push(msg.server);
			clientInfo.channels = [...clientInfo.channels, ...msg.channels];
			clientInfo.emojis = [...clientInfo.emojis, ...msg.emojis];
			global_io.emit("server_info_" + IDENTIFIER_USER, clientInfo);
		}
	});

	eventEmitter.on("ServerMemberLeave", (msg) => {
		if (clientInfo.users && clientInfo.users.findIndex((user) => user.relationship == "User") >= 0) {
			if (clientInfo.users[clientInfo.users.findIndex((user) => user.relationship == "User")]._id == msg.user) {
				var indexToDelete = -1;

				clientInfo.servers.forEach((server, index) => {
					if (server._id == msg.id) {
						indexToDelete = index;
					}
				});

				if (indexToDelete >= 0) {
					clientInfo.servers.splice(indexToDelete, 1);
				}
				global_io.emit("server_info_" + IDENTIFIER_USER, clientInfo);
			}
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
			setTimeout(() => {
				start();
			}, 0);
		}
	});

	eventEmitter.on("Error", (msg) => {
		addLog({ type: "ErrorMessage", message: msg });

		if (msg) {
			if (msg.includes("Closed with reason:")) {
				error = error + 1;
				if (error >= 20) {
					error = 0;
					return addLog({ type: "FatalError", message: "Too much close. Consider logging in again." });
				}
				addLog({ type: "Info", message: "Restarting immediately." });
				setTimeout(() => {
					start();
				}, 0);
			}
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

		client.on("Network.webSocketFrameSent", async ({ requestId, timestamp, response }) => {
			if (is_valid_json(response.payloadData)) {
				var parsed = JSON.parse(response.payloadData);

				if (parsed.type == "Authenticate") {
					token = parsed.token;

					if (force_headful) {
						addLog({ type: "DebugMessage", message: "Authenticated. Restarting in headless mode" });
						force_headful = false;

						setTimeout(async () => {
							await browser.close();

							ports[IDENTIFIER_USER] = {
								user: IDENTIFIER_USER,
								is_running: false,
								is_headless: IS_HEADLESS,
							};
							emit_server_info();

							await sleep(500);
							initialize_puppeteer();
						}, 1000);
					} else {
						addLog({ type: "DebugMessage", message: "✅ Authenticated" });
					}
				}
			}
		});

		client.on("Network.webSocketFrameReceived", async ({ requestId, timestamp, response }) => {
			if (is_valid_json(response.payloadData)) {
				var parsed = JSON.parse(response.payloadData);
				eventEmitter.emit(parsed.type, parsed, page);
			}
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
			} catch (error) {
				if (error.message.includes("Execution context was destroyed")) {
					console.log("Page navigated");
				}
			}
		});

		if (force_headful) {
			return await page.evaluate(
				async (original_username) => {
					var html = `<div style="pointer-events: none; display: flex; position: absolute; top: 80px; right: 10px; z-index: 10000000; background: #d5ff95; border: 2px black dashed; padding: 0.5rem 0.6rem; border-radius: 1rem; flex-direction: column; color: black; opacity: 0.7; gap: 5px;">
            <span>Logging in for: "${original_username}"</span>
            <span>Cloudflare problems? Clear cookies.</span>
            </div>`;
					var element = document.createElement("div");
					element.innerHTML = html;
					document.body.append(element);
				},
				original_username
			);
		}

		setTimeout(() => {
			is_running = true;
			ports[IDENTIFIER_USER] = {
				user: IDENTIFIER_USER,
				is_running,
				is_headless: IS_HEADLESS,
			};
			emit_server_info();
		}, 3000);
	}

	start();

	async function getInstantResponse(message, serverId, channelName) {
		if (message && channelName) {
			for (let index = 0; index < Object.values(instantResponses[serverId] ? instantResponses[serverId] : {}).length; index++) {
				const response = Object.values(instantResponses[serverId] ? instantResponses[serverId] : {})[index];

				if (response.caseSensitive) {
					message = message.toLowerCase();
					channelName = channelName.toLowerCase();
				}

				if (message.includes(response.message)) {
					if (response.regex) {
						return {
							found: true,
							response: { respondWith: extractNumbers(channelName)[0] },
						};
					}
					return {
						found: true,
						response,
					};
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
						return {
							canReply: true,
							reason: "keyword match",
						};
					}
				} else {
					if (channelName.includes(keyword)) {
						return {
							canReply: true,
							reason: "keyword match",
						};
					}
				}
			}
		}

		return {
			canReply: canReply.includes(categoryId),
			reason: canReply.includes(categoryId) ? "category match" : "",
		};
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

global_app.post("/api/server", async (req, res) => {
	if (!req.query.server) {
		return res.end("Server is required");
	}

	if (ports[req.query.server]) {
		return res.end("User has already started");
	}

	await start_everything(req.query.server, false);

	emit_server_info();
	res.end("Starting.");
});

global_app.delete("/api/server", async (req, res) => {
	if (!req.query.server) {
		return res.end("Server is required");
	}

	try {
		fs.rmSync(req.query.server, { recursive: true });
		emit_server_info();
		res.status(200).end(req.query.server);
		return 0;
	} catch (error) {
		res.status(500).end(error.code);
	}
});

global_app.get("/api/running-servers", async (req, res) => {
	res.json(ports);
});

global_app.get("/api/servers", async (req, res) => {
	var users = fs.readdirSync("./").filter((folder) => folder.startsWith("server-"));

	var user_infos = users.map((user) => {
		if (fs.existsSync(`${user}/account_info.json`)) {
			return {
				...JSON.parse(fs.readFileSync(`${user}/account_info.json`)),
				folder: user,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		} else {
			return {
				folder: user,
				is_running: ports[user]?.is_running || false,
				is_headless: ports[user]?.is_headless || false,
			};
		}
	});

	res.json(user_infos);
});

global_app.post("/api/add_server", async (req, res) => {
	const slug = "server-" + generateSlug();
	res.end(slug);
	await start_everything(slug, true, false);

	emit_server_info();
});

global_app.get("/", (req, res) => {
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

	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot Manager</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: 'Segoe UI'; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; padding: 20px; }
		.container { max-width: 1200px; margin: 0 auto; }
		.header { background: rgba(0,0,0,0.5); padding: 20px; border-radius: 12px; border-left: 4px solid #4CAF50; margin-bottom: 20px; }
		.header h1 { color: #4CAF50; margin-bottom: 10px; }
		.btn { background: #4CAF50; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-bottom: 20px; }
		.btn:hover { background: #45a049; }
		.btn.primary { background: #5865F2; }
		.btn.primary:hover { background: #4752C4; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
		.card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 15px; border-radius: 12px; cursor: pointer; transition: 0.3s; }
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
			<p>All bots running on this domain</p>
		</div>

		<button class="btn primary" onclick="createBot()">+ Create New Bot</button>

		<div class="grid">
			${user_infos.length === 0 ? '<div style="grid-column: 1/-1; color: #aaa; text-align: center; padding: 40px;">No bots created yet. Click "+ Create New Bot"</div>' : user_infos.map(bot => `
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
		return res.send(`<html><head><title>Not Found</title></head><body><h1>❌ Bot not found</h1><p><a href="/" style="color: #4CAF50;">← Back</a></p></body></html>`);
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
		.header h1 { color: #4CAF50; margin-bottom: 10px; }
		.header p { color: #aaa; }
		.buttons { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
		.btn { background: #4CAF50; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; }
		.btn:hover { background: #45a049; }
		.btn.primary { background: #5865F2; }
		.btn.primary:hover { background: #4752C4; }
		.btn.back { background: #666; }
		.btn.back:hover { background: #555; }
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
			<h1>🤖 Revolt Bot - ${serverId}</h1>
			<p>Status: <span id="status" style="color: #4CAF50;">🟢 Connecting...</span></p>
		</div>

		<div class="buttons">
			<button class="btn primary" onclick="openLogin()">🔐 Open Login Tab</button>
			<button class="btn" onclick="location.reload()">🔄 Reload</button>
			<button class="btn back" onclick="window.location.href='/'">← Back to Bots</button>
		</div>

		<div class="grid">
			<div class="card">
				<h2>📋 Setup</h2>
				<p>1. Click "🔐 Open Login Tab"</p>
				<p>2. Login sa Revolt</p>
				<p>3. Close login tab</p>
				<p>4. Bot connects! ✅</p>
			</div>

			<div class="card">
				<h2>📊 Bot Info</h2>
				<p>User: <strong id="username">Waiting...</strong></p>
				<p>Servers: <strong id="servers">0</strong></p>
				<p>Channels: <strong id="channels">0</strong></p>
			</div>

			<div class="card">
				<h2>⚡ Features</h2>
				<p>✅ 5x FASTER</p>
				<p>✅ Auto-responses</p>
				<p>✅ Railway Ready</p>
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
				document.getElementById('channels').textContent = data.channels?.length || 0;
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