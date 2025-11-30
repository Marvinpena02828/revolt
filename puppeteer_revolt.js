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

// ========================================
// RAILWAY CONFIGURATION
// ========================================
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME;
const RAILWAY_PORT = parseInt(process.env.PORT) || 3000;
const RAILWAY_HOST = IS_RAILWAY ? '0.0.0.0' : 'localhost';

console.log(`[RAILWAY] Enabled: ${IS_RAILWAY}, PORT: ${RAILWAY_PORT}, HOST: ${RAILWAY_HOST}`);

// ========================================
// HELPER FUNCTIONS - MOVED TO TOP
// ========================================

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

function removeStartSubstring(str, substr) {
	if (str.startsWith(substr)) {
		return str.slice(substr.length);
	}
	return str;
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

	global_io.emit("servers", user_infos);
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
// Pre-fill on startup
fillNoncePool();
// Keep filling in background
setInterval(fillNoncePool, 50);

function getNonce() {
	if (noncePool.length < 500) {
		setImmediate(fillNoncePool);
	}
	return noncePool.pop() || `01${generate_nonce(24)}`;
}

// ========================================
// MAIN FUNCTION - COMPLETE ORIGINAL LOGIC
// ========================================

async function start_everything(IDENTIFIER_USER, IS_HEADLESS = true, START_IMMEDIATELY = true) {
	const original_username = IDENTIFIER_USER;

	var is_running = false;

	emit_server_info();

	const eventEmitter = new EventEmitter();
	const Socket = net.Socket;

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

	var port = await getNextOpenPort(getRandomInt(49152, 50000));
	ports[IDENTIFIER_USER] = {
		user: IDENTIFIER_USER,
		port,
		is_running,
		is_headless: IS_HEADLESS,
	};
	emit_server_info();

	function isAlphanumeric(str) {
		return /^[a-zA-Z0-9]+$/.test(str);
	}

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

		if (req.method === "OPTIONS") {
			return res.sendStatus(204);
		}

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
		responses: {
			// Auto-claim keywords for channel matching (global)
			"_keywords": ["reward", "claim", "nitro", "drop", "giveaway", "bonus", "gift", "free", "code", "ticket", "promo", "raffle", "sweepstakes"],
		},
		canReply: [],
		responseDelay: { min_ms: 0, max_ms: 50 },  // Ultra-fast response
		isBotOn: { status: true },
		alreadyResponded: "",
		responseType: {},
		// Per-server configurations for custom responses
		serverConfigs: {
			// Example: "SERVER_ID_1": { command: "/claim 1", response: "Ticket: {number}" }
			// Users can configure per server via API
		},
		// Pre-configured instant responses for common triggers
		instantResponses: {
			"_default": {
				"trigger_click": { uuid: "trigger_click", message: "click here", respondWith: "✅ Claimed", regex: false, caseSensitive: false },
				"trigger_react": { uuid: "trigger_react", message: "react to", respondWith: "✅ Reacted", regex: false, caseSensitive: false },
				"trigger_claim": { uuid: "trigger_claim", message: "claim now", respondWith: "✅ Claimed", regex: false, caseSensitive: false },
				"trigger_win": { uuid: "trigger_win", message: "enter to win", respondWith: "✅ Entered", regex: false, caseSensitive: false },
				"trigger_free": { uuid: "trigger_free", message: "free", respondWith: "✅ Got It", regex: false, caseSensitive: false },
				"trigger_code": { uuid: "trigger_code", message: "code", respondWith: "✅ Code Redeemed", regex: false, caseSensitive: false },
			},
		},
	};

	for (const [key, file] of Object.entries(files)) {
		if (!fs.existsSync(`./${IDENTIFIER_USER}/${file}`)) {
			fs.writeFileSync(`./${IDENTIFIER_USER}/${file}`, JSON.stringify(initialValues[key], null, 2));
			addLog({ type: "DebugMessage", message: `Created ${file} with initial value` });
		} else {
			addLog({ type: "DebugMessage", message: `File ${file} exists` });
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
			// Fire request immediately without waiting for response
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

	eventEmitter.on("raw", async (msg) => {
		addLog(msg);
	});

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
		addLog({ type: "DebugMessage", message: `✅ CONNECTED - Bot logged in as: ${user.username}` });
		logActiveTriggers();  // Show active triggers
		console.log("✅ Connected - Bot is active!");
	});

	eventEmitter.on("Message", async (msg, page) => {
		var channel_index = clientInfo.channels.findIndex((obj) => obj._id == msg?.channel);
		var channel = channel_index != -1 ? clientInfo.channels[channel_index] : undefined;

		if (channel.channel_type == "DirectMessage") {
			return addLog({ type: "DebugMessage", message: "Message is DirectMessage, skipping" });
		}

		var server_index = clientInfo.servers.findIndex((obj) => obj._id == channel?.server);
		var server = server_index != -1 ? clientInfo.servers[server_index] : undefined;

		var category;
		if (server?.categories) {
			var category_index = server?.categories?.findIndex((obj) => obj.channels.includes(channel._id));
			category = category_index != -1 ? server?.categories[category_index] : undefined;
		}

		var canReply = await getCanReply(category ? category.id : null, channel?.name, server?._id);

		if (canReply.canReply) {
			// Priority 1: Check per-server configuration
			const serverConfig = serverConfigs[server._id];
			if (serverConfig && msg?.content?.includes(serverConfig.command)) {
				const response = serverConfig.responseTemplate;
				await sendMessageDirect(msg?.channel, response);
				addLog({ type: "BotMessage", message: `⚡ Server-specific response sent` });
				return;
			}
			
			// Priority 2: Check instant responses
			var instantResponse = await getInstantResponse(msg?.content, server._id, channel?.name);

			if (instantResponse.found) {
				addLog({ type: "BotMessage", message: `✅ Instant response match` });
				if (instantResponse?.response) {
					var result = await sendMessageDirect(msg?.channel, instantResponse?.response?.respondWith);
					addLog({ type: "DebugMessage", message: JSON.stringify(result) });
				} else {
					addLog({ type: "DebugMessage", message: "No number extracted" });
				}
			}
		}
	});

	eventEmitter.on("ChannelCreate", async (msg, page) => {
		clientInfo.channels.push(msg);

		if (!isBotOn.status) {
			return addLog({ type: "DebugMessage", message: "Bot is OFF" });
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
				// Execute immediately without setImmediate for max speed
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
						// Execute immediately without setImmediate for max speed
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
		const headlessMode = IS_RAILWAY ? true : (force_headful ? false : IS_HEADLESS);
		
		browser = await puppeteer.launch({
			userDataDir: `./${IDENTIFIER_USER}/browser-userdata`,
			headless: headlessMode,
			args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-web-security", "--disable-features=IsolateOrigins,site-per-process", "--disable-site-isolation-trials"],
		});
		const page = await browser.newPage();

		page.setDefaultNavigationTimeout(60000);

		await page.goto("https://revolt.onech.at/");

		addLog({ type: "DebugMessage", message: "Puppeteer launched, connecting to Revolt..." });

		const client = await page.target().createCDPSession();

		await client.send("Network.enable");

		client.on("Network.webSocketFrameSent", async ({ requestId, timestamp, response }) => {
			if (is_valid_json(response.payloadData)) {
				var parsed = JSON.parse(response.payloadData);

				if (parsed.type == "Authenticate") {
					global_page = page;
					token = parsed.token;

					if (force_headful) {
						addLog({ type: "DebugMessage", message: "Authenticated. Restarting in headless mode" });
						force_headful = false;

						setTimeout(async () => {
							await browser.close();

							ports[IDENTIFIER_USER] = {
								user: IDENTIFIER_USER,
								port,
								is_running: false,
								is_headless: IS_HEADLESS,
							};
							emit_server_info();

							await sleep(500);
							initialize_puppeteer();
						}, 1000);
					} else {
						addLog({ type: "DebugMessage", message: "✅ Authenticated successfully!" });
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
				addLog({ type: "DebugMessage", message: `Redirected to /login - need manual login` });

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
					addLog({ type: "DebugMessage", message: `Cloudflare detected - opening login` });
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
				port,
				is_running,
				is_headless: IS_HEADLESS,
			};
			emit_server_info();
		}, 3000);
	}

	start();

	async function addInstantResponse(serverId = "", message = "", respondWith = "", regex = false, caseSensitive = false, uuid = "") {
		if (!instantResponses[serverId]) {
			instantResponses[serverId] = {};
		}

		instantResponses[serverId][uuid] = {
			respondWith,
			regex: JSON.parse(regex),
			caseSensitive: JSON.parse(caseSensitive),
			message,
			uuid,
		};

		clientInfo.instantResponses = instantResponses;
		fs.writeFileSync(`./${IDENTIFIER_USER}/instant_responses.json`, JSON.stringify(instantResponses));
	}

	async function removeInstantResponse(serverId = "", uuid = "") {
		if (!instantResponses[serverId]) {
			instantResponses[serverId] = {};
		}
		if (instantResponses[serverId][uuid]) {
			delete instantResponses[serverId][uuid];
		} else {
			throw new Error("NON_EXISTENT_INSTANT_RESPONSE");
		}
		clientInfo.instantResponses = instantResponses;
		fs.writeFileSync(`./${IDENTIFIER_USER}/instant_responses.json`, JSON.stringify(instantResponses));
	}

	async function setReplyWith(string, serverId) {
		responses[serverId] = string;
		clientInfo.responses = responses;
		clientInfo.canReply = canReply;
		fs.writeFileSync(`./${IDENTIFIER_USER}/responses.json`, JSON.stringify(responses));
	}

	async function getReplyWith(serverId) {
		return responses[serverId];
	}

	async function addReplyWithKeyword(string, serverId) {
		if (string) {
			string = string.trim();
		}
		if (!responses[serverId + "_keywords"]) {
			responses[serverId + "_keywords"] = [];
		}

		if (responses[serverId + "_keywords_is_case_sensitive"] != true && responses[serverId + "_keywords_is_case_sensitive"] != false) {
			responses[serverId + "_keywords_is_case_sensitive"] = false;
		}

		if (responses[serverId + "_keywords"].includes(string)) {
			throw new Error("DUPLICATE_KEYWORD");
		}

		responses[serverId + "_keywords"].push(string);
		responses[serverId + "_keywords"] = [...new Set(responses[serverId + "_keywords"])];
		clientInfo.responses = responses;
		clientInfo.canReply = canReply;
		fs.writeFileSync(`./${IDENTIFIER_USER}/responses.json`, JSON.stringify(responses));
		return true;
	}

	async function removeKeyword(string, serverId) {
		if (!responses[serverId + "_keywords"]) {
			responses[serverId + "_keywords"] = [];
		}

		if (responses[serverId + "_keywords_is_case_sensitive"] != true && responses[serverId + "_keywords_is_case_sensitive"] != false) {
			responses[serverId + "_keywords_is_case_sensitive"] = false;
		}

		var index = responses[serverId + "_keywords"].indexOf(string);

		if (index !== -1) {
			responses[serverId + "_keywords"].splice(index, 1);
			fs.writeFileSync(`./${IDENTIFIER_USER}/responses.json`, JSON.stringify(responses));
			return true;
		} else {
			throw new Error("NON_EXISTENT_KEYWORD");
		}
	}

	async function setKeywordCaseSensitive(state, serverId) {
		responses[serverId + "_keywords_is_case_sensitive"] = state;
		clientInfo.responses = responses;
		clientInfo.canReply = canReply;
		fs.writeFileSync(`./${IDENTIFIER_USER}/responses.json`, JSON.stringify(responses));
	}

	async function setCanReply(categoryId) {
		canReply.push(categoryId);
		clientInfo.responses = responses;
		clientInfo.canReply = canReply;
		fs.writeFileSync(`./${IDENTIFIER_USER}/canreply.json`, JSON.stringify([...new Set(canReply)]));
	}

	async function unsetCanReply(categoryId) {
		canReply = canReply.filter((item) => item !== categoryId);
		fs.writeFileSync(`./${IDENTIFIER_USER}/canreply.json`, JSON.stringify(canReply));
	}

	async function getInstantResponse(message, serverId, channelName) {
		if (message && channelName) {
			// Priority 1: Check server-specific responses
			const serverResponses = instantResponses[serverId] ? instantResponses[serverId] : {};
			
			for (let index = 0; index < Object.values(serverResponses).length; index++) {
				const response = Object.values(serverResponses)[index];

				let checkMessage = message;
				let checkChannelName = channelName;
				
				if (!response.caseSensitive) {
					checkMessage = message.toLowerCase();
					checkChannelName = channelName.toLowerCase();
				}

				if (checkMessage.includes(response.message.toLowerCase ? response.message.toLowerCase() : response.message)) {
					if (response.regex) {
						return {
							found: true,
							response: { respondWith: extractNumbers(checkChannelName)[0] },
						};
					}
					return { found: true, response };
				}
			}
			
			// Priority 2: Check default/global responses
			const defaultResponses = instantResponses["_default"] ? instantResponses["_default"] : {};
			
			for (let index = 0; index < Object.values(defaultResponses).length; index++) {
				const response = Object.values(defaultResponses)[index];

				let checkMessage = message;
				
				if (!response.caseSensitive) {
					checkMessage = message.toLowerCase();
				}

				if (checkMessage.includes(response.message.toLowerCase ? response.message.toLowerCase() : response.message)) {
					return { found: true, response };
				}
			}
		}

		return { found: false };
	}

	async function getCanReply(categoryId, channelName, serverId) {
		const checkChannelName = channelName.toLowerCase();
		
		// Priority 1: Check default global keywords first (faster)
		const defaultKeywords = responses["_keywords"] || [];
		for (let keyword of defaultKeywords) {
			if (checkChannelName.includes(keyword.toLowerCase())) {
				return { canReply: true, reason: "global keyword match" };
			}
		}
		
		// Priority 2: Check server-specific keywords
		if (responses[`${serverId}_keywords`]) {
			for (let index = 0; index < responses[`${serverId}_keywords`].length; index++) {
				const keyword = responses[`${serverId}_keywords`][index];

				if (responses[`${serverId}_keywords_is_case_sensitive`]) {
					if (checkChannelName.includes(keyword.toLowerCase())) {
						return { canReply: true, reason: "keyword match" };
					}
				} else {
					if (checkChannelName.includes(keyword.toLowerCase())) {
						return { canReply: true, reason: "keyword match" };
					}
				}
			}
		}

		// Priority 3: Check category whitelist
		return {
			canReply: canReply.includes(categoryId),
			reason: canReply.includes(categoryId) ? "category match" : "",
		};
	}

	async function joinServer(link, page) {
		link = ensureHttps(link);
		if (!isValidInviteLink(link)) {
			return { error: true };
		}

		link = link.replace("/invite/", "/invites/");
		link = link.replace("revolt.onech.at", "revolt-api.onech.at");

		return await page.evaluate(
			async (token, link) => {
				var result = await fetch(link, {
					method: "POST",
					headers: {
						"X-Session-Token": token,
						referer: "https://revolt.onech.at/",
					},
				});

				var data = await result.json();
				return data;
			},
			token,
			link
		);
	}

	function isValidInviteLink(link) {
		const regex = /^https?:\/\/revolt\.onech\.at\/invite\/[A-Za-z0-9]{8}$/;
		return regex.test(link);
	}

	async function setBotStatus(status) {
		if (status == true || status == false) {
			isBotOn.status = status;
			fs.writeFileSync(`./${IDENTIFIER_USER}/is_bot_on.json`, JSON.stringify(isBotOn));

			if (!status) {
				await browser.close();
				addLog({ type: "DebugMessage", message: `Browser closed` });
			} else {
				initialize_puppeteer();
			}

			io.emit("bot_status", isBotOn);
			return true;
		} else {
			throw new Error("INPUT_NOT_BOOLEAN");
		}
	}

	function ensureHttps(url) {
		if (url.startsWith("https://")) {
			return url;
		} else if (url.startsWith("http://")) {
			return url.replace("http://", "https://");
		} else {
			return "https://" + url;
		}
	}

	async function leaveServer(serverId, leaveSilently, page) {
		return await page.evaluate(
			async (token, serverId, leaveSilently) => {
				var result = await fetch(`https://revolt-api.onech.at/servers/${serverId}/${leaveSilently ? "?leave_silently=true" : "?leave_silently=false"}`, {
					method: "DELETE",
					headers: {
						"X-Session-Token": token,
						referer: "https://revolt.onech.at/",
					},
				});

				return { success: true };
			},
			token,
			serverId,
			leaveSilently
		);
	}

	function findCategoryByChannelId(channelId, categories = []) {
		for (const category of categories) {
			if (category.channels.includes(channelId)) {
				return category;
			}
		}
		return null;
	}

	async function setResponseDelay(min, max) {
		if (!isOnlyNumbers(max) || !isOnlyNumbers(min)) {
			throw new Error("INPUT_NOT_NUMERICAL");
		}

		response_delay = {
			min_ms: min,
			max_ms: max,
		};

		fs.writeFileSync(`./${IDENTIFIER_USER}/response_delay.json`, JSON.stringify(response_delay));
		return true;
	}

	async function setResponseType(type, server_id) {
		if (!response_types.includes(type)) {
			throw new Error("INVALID_RESPONSE_TYPE");
		}

		responseType[server_id] = type;
		fs.writeFileSync(`./${IDENTIFIER_USER}/response_type.json`, JSON.stringify(responseType));
		return true;
	}

	function isOnlyNumbers(input) {
		return /^\d+$/.test(input);
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function addLog(log) {
		var _log = { timestamp: new Date().getTime(), log, uuid: uuidv4() };
		logs.unshift(_log);
		io.emit("log", _log);

		if (logs.length > 20) {
			logs.pop();
		}
	}

	function logActiveTriggers() {
		const globalKeywords = responses["_keywords"] || [];
		const defaultTriggers = instantResponses["_default"] ? Object.keys(instantResponses["_default"]).length : 0;
		
		addLog({ type: "DebugMessage", message: `⚡ ACTIVE TRIGGERS: ${globalKeywords.length} keywords + ${defaultTriggers} instant responses` });
		globalKeywords.forEach(kw => {
			addLog({ type: "DebugMessage", message: `   📌 Keyword: "${kw}"` });
		});
		if (defaultTriggers > 0) {
			addLog({ type: "DebugMessage", message: `   💬 Instant responses ready for messages` });
		}
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

	async function sendMessage(id, content, page) {
		return await sendMessageDirect(id, content);
	}

	io.on("connection", (socket) => {
		if (clientInfo.users) {
			io.emit("bot_info", { username: clientInfo.users[clientInfo?.users.findIndex((user) => user.relationship == "User")].username, id: clientInfo.users[clientInfo?.users.findIndex((user) => user.relationship == "User")]._id });
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
		clientInfo.serverConfigs = serverConfigs;
		res.json(clientInfo);
	});

	// Set per-server configuration (command + response template)
	app.post("/api/server_config", async (req, res) => {
		const serverId = req.query.serverId;
		const command = req.query.command;  // e.g., "/claim 1"
		const responseTemplate = req.query.response;  // e.g., "Ticket: {number}"
		
		if (!serverId || !command || !responseTemplate) {
			return res.status(400).json({ error: true, message: "serverId, command, response required" });
		}
		
		serverConfigs[serverId] = { command, responseTemplate };
		fs.writeFileSync(`./${IDENTIFIER_USER}/server_configs.json`, JSON.stringify(serverConfigs, null, 2));
		addLog({ type: "DebugMessage", message: `📋 Server ${serverId}: ${command} → ${responseTemplate}` });
		res.json({ error: false, config: serverConfigs[serverId] });
	});

	// Get per-server configurations
	app.get("/api/server_config/:serverId", (req, res) => {
		const config = serverConfigs[req.params.serverId] || null;
		res.json({ config });
	});

	app.post("/api/set_response", async (req, res) => {
		if (!req.query.response) {
			await setReplyWith(req.query.response, req.query.serverId);
			addLog({ type: "DebugMessage", message: `Bot response set to empty on server "${req.query.serverId}"` });
			return res.json({ ...responses, error: false });
		}
		if (!req.query.serverId) {
			return res.status(400).json({ error: true, message: "Server ID is empty" });
		}

		await setReplyWith(req.query.response, req.query.serverId);
		addLog({ type: "DebugMessage", message: `Bot will now respond "${req.query.response}" on server "${req.query.serverId}"` });
		res.json({ ...responses, error: false });
	});

	app.get("/api/logs", async (req, res) => {
		res.json(logs);
	});

	app.get("/api/bot_version", (req, res) => {
		res.end(bot_version);
	});

	app.get("/api/end_server", async (req, res) => {
		if (!is_running) {
			return res.json({ error: true });
		}
		await browser.close();
		res.json({ error: false });
		await io.disconnectSockets();
		await io.close();
		await server.close();
		delete ports[original_username];
		emit_server_info();
	});

	try {
		addLog({ type: "DebugMessage", message: "Starting bot dashboard server" });

		server.listen(port, RAILWAY_HOST, () => {
			addLog({ type: "DebugMessage", message: `Bot listening on port ${port}` });
		});
	} catch (error) {
		if (error.code == "ERR_SERVER_ALREADY_LISTEN") {
			addLog({ type: "DebugMessage", message: "Bot dashboard server already running" });
		}
		if (error.code == "EADDRINUSE") {
			port = getRandomInt(49152, 50000);
		}
	}
}

// ========================================
// GLOBAL SERVER SETUP
// ========================================

var port = await getNextOpenPort(1024);

const global_app = express();
const global_server = createServer(global_app);
const global_io = new Server(global_server);

global_io.on("connection", () => {
	global_io.emit("bot_version", bot_version);
	emit_server_info();
});

// Main Dashboard - User Friendly
global_app.get("/", (req, res) => {
	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot - Control Panel</title>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { 
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
			color: #fff;
			padding: 20px;
			min-height: 100vh;
		}
		.container { max-width: 1200px; margin: 0 auto; }
		.header { margin-bottom: 30px; }
		h1 { font-size: 32px; margin-bottom: 5px; color: #4CAF50; }
		.subtitle { color: #aaa; font-size: 14px; }
		.status-box {
			background: rgba(76, 175, 80, 0.1);
			border-left: 4px solid #4CAF50;
			padding: 15px;
			border-radius: 8px;
			margin-bottom: 20px;
			display: flex;
			align-items: center;
			gap: 10px;
		}
		.status-indicator {
			width: 12px;
			height: 12px;
			border-radius: 50%;
			background: #4CAF50;
			animation: pulse 2s infinite;
		}
		@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
		.server-item {
			background: rgba(0, 0, 0, 0.3);
			padding: 15px;
			border-radius: 8px;
			margin-bottom: 15px;
			border-left: 4px solid #5865F2;
		}
		.server-name { font-weight: bold; margin-bottom: 10px; color: #4CAF50; }
		.config-form {
			display: grid;
			gap: 10px;
			margin-top: 10px;
		}
		.form-group {
			display: flex;
			flex-direction: column;
			gap: 5px;
		}
		.form-group label {
			font-size: 12px;
			color: #aaa;
			font-weight: bold;
		}
		.form-group input {
			background: rgba(0, 0, 0, 0.5);
			border: 1px solid #444;
			color: #fff;
			padding: 8px 12px;
			border-radius: 4px;
			font-size: 12px;
		}
		.form-group input:focus {
			outline: none;
			border-color: #4CAF50;
			box-shadow: 0 0 5px rgba(76, 175, 80, 0.3);
		}
		.btn-save {
			background: #4CAF50;
			padding: 8px 16px;
			font-size: 12px;
			margin-top: 10px;
		}
		.btn-save:hover { background: #45a049; }
		.btn-clear { background: #666; padding: 8px 16px; font-size: 12px; }
		.btn-clear:hover { background: #888; }
		.config-status {
			font-size: 12px;
			color: #aaa;
			margin-top: 10px;
			padding: 10px;
			background: rgba(76, 175, 80, 0.1);
			border-radius: 4px;
			border-left: 3px solid #4CAF50;
		}
		.config-status.error {
			background: rgba(244, 67, 54, 0.1);
			border-left-color: #f44336;
			color: #f44336;
		}
		.buttons { display: flex; gap: 10px; margin-bottom: 30px; flex-wrap: wrap; }
		.btn {
			background: #4CAF50;
			color: white;
			border: none;
			padding: 12px 24px;
			border-radius: 6px;
			cursor: pointer;
			font-size: 14px;
			font-weight: bold;
			transition: all 0.3s;
		}
		.btn:hover { background: #45a049; transform: translateY(-2px); }
		.btn.primary { background: #5865F2; }
		.btn.primary:hover { background: #4752C4; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
		.card {
			background: rgba(255, 255, 255, 0.05);
			border: 1px solid rgba(255, 255, 255, 0.1);
			padding: 20px;
			border-radius: 12px;
			backdrop-filter: blur(10px);
		}
		.card h2 { color: #4CAF50; margin-bottom: 15px; font-size: 18px; }
		.card p { color: #aaa; line-height: 1.6; margin-bottom: 15px; font-size: 13px; }
		.status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; background: #4CAF50; color: white; }
		.status.off { background: #f44336; }
		.bot-item {
			background: rgba(0, 0, 0, 0.3);
			padding: 12px;
			border-radius: 8px;
			margin-bottom: 10px;
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.bot-info { flex: 1; }
		.bot-name { font-weight: bold; margin-bottom: 4px; }
		.bot-status { font-size: 12px; color: #aaa; }
		.btn-delete { background: #f44336; padding: 6px 12px; font-size: 12px; }
		.btn-delete:hover { background: #da190b; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>🤖 Revolt Bot Control Panel</h1>
			<p class="subtitle">Bot v4.26.2025.1128am-MAX-SPEED</p>
		</div>

		<div class="status-box">
			<div class="status-indicator"></div>
			<span>Dashboard Connected</span>
		</div>

		<div class="buttons">
			<button class="btn primary" onclick="window.open('https://revolt.onech.at/', '_blank')">↗ Open Revolt Chat</button>
			<button class="btn" onclick="window.location.href='/login'">🔐 Login Account</button>
			<button class="btn" onclick="addBot()">+ Create Bot Instance</button>
		</div>

		<div class="grid">
			<div class="card">
				<h2>📋 Quick Start</h2>
				<p><strong>Step 1:</strong> Click "🔐 Login Account" button</p>
				<p><strong>Step 2:</strong> Login with your Revolt account</p>
				<p><strong>Step 3:</strong> Come back and click "+ Create Bot Instance"</p>
				<p><strong>Step 4:</strong> Wait for connection (check logs below)</p>
				<p><strong>Step 5:</strong> Configure servers & responses!</p>
			</div>

			<div class="card">
				<h2>🟢 Active Bots</h2>
				<div id="bots">
					<p style="color: #888;">No bots running...</p>
				</div>
			</div>

			<div class="card">
				<h2>📊 Bot Version</h2>
				<p>revolt bot v4.26.2025.1128am-MAX-SPEED</p>
				<p style="font-size: 12px; color: #4CAF50; margin-top: 10px;">✅ All features enabled</p>
			</div>
		</div>

		<div class="card" style="margin-top: 20px;">
			<h2>⚙️ Server Configuration</h2>
			<div id="serverConfigPanel">
				<p style="color: #888;">Create a bot instance first to see servers</p>
			</div>
		</div>

		<div class="card" style="margin-top: 20px;">
			<h2>📝 Connection Logs</h2>
			<div id="logs" style="background: rgba(0,0,0,0.5); border-radius: 8px; padding: 15px; height: 300px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px; line-height: 1.6;">
				<p style="color: #888;">Waiting for logs...</p>
			</div>
		</div>
	</div>

	<script src="/socket.io/socket.io.js"></script>
	<script>
		const socket = io();
		let logMessages = [];

		function addBot() {
			fetch('/api/add_server', { method: 'POST' })
				.then(() => {
					alert('Bot creating... wait 5 seconds then refresh');
					setTimeout(() => location.reload(), 5000);
				})
				.catch(err => alert('Error: ' + err));
		}

		function deleteBot(folder) {
			if (confirm('Delete this bot instance?')) {
				fetch('/api/server?server=' + folder, { method: 'DELETE' })
					.then(() => location.reload())
					.catch(err => alert('Error'));
			}
		}

		let botServers = [];

		socket.on('servers', (servers) => {
			const el = document.getElementById('bots');
			if (!servers || !servers.length) {
				el.innerHTML = '<p style="color: #888;">No bots yet</p>';
				document.getElementById('serverConfigPanel').innerHTML = '<p style="color: #888;">Create a bot instance first</p>';
				return;
			}
			el.innerHTML = servers.map(s => {
				const deleteBtn = '<button class="btn btn-delete" onclick="deleteBot(' + "'" + s.folder + "'" + ')">Delete</button>';
				return '<div class="bot-item">' +
					'<div class="bot-info">' +
						'<div class="bot-name">' + (s.username || s.folder) + '</div>' +
						'<div class="bot-status"><span class="status ' + (s.is_running ? '' : 'off') + '">' + (s.is_running ? '🟢 Connected' : '🔴 Offline') + '</span></div>' +
					'</div>' +
					deleteBtn +
				'</div>';
			}).join('');

			// Load bot server info to get servers
			if (servers[0] && servers[0].is_running) {
				fetch('/api/servers')
					.then(r => r.json())
					.then(data => {
						botServers = data.servers || [];
						loadServerConfigs();
					})
					.catch(() => {});
			}
		});

		function loadServerConfigs() {
			const panel = document.getElementById('serverConfigPanel');
			if (!botServers || botServers.length === 0) {
				panel.innerHTML = '<p style="color: #888;">No servers available. Bot needs to connect to servers first.</p>';
				return;
			}

			let html = '';
			botServers.forEach(server => {
				html += '<div class="server-item">' +
					'<div class="server-name">🔹 ' + (server.name || server._id) + '</div>' +
					'<div class="config-form">' +
						'<div class="form-group">' +
							'<label>Claim Command (e.g., /claim 1, click here)</label>' +
							'<input type="text" id="cmd_' + server._id + '" placeholder="e.g., /claim 1" style="width: 100%;">' +
						'</div>' +
						'<div class="form-group">' +
							'<label>Response Template (e.g., Ticket: 12345)</label>' +
							'<input type="text" id="resp_' + server._id + '" placeholder="e.g., Ticket: 12345" style="width: 100%;">' +
						'</div>' +
						'<div style="display: flex; gap: 10px; margin-top: 10px;">' +
							'<button class="btn btn-save" onclick="saveServerConfig(\'' + server._id + '\')">💾 Save Config</button>' +
							'<button class="btn btn-clear" onclick="clearServerConfig(\'' + server._id + '\')">🗑️ Clear</button>' +
						'</div>' +
						'<div id="status_' + server._id + '" class="config-status" style="display:none;"></div>' +
					'</div>' +
				'</div>';
			});

			panel.innerHTML = html;

			// Load existing configs
			botServers.forEach(server => {
				fetch('/api/server_config/' + server._id)
					.then(r => r.json())
					.then(data => {
						if (data.config) {
							document.getElementById('cmd_' + server._id).value = data.config.command || '';
							document.getElementById('resp_' + server._id).value = data.config.responseTemplate || '';
						}
					})
					.catch(() => {});
			});
		}

		function saveServerConfig(serverId) {
			const cmd = document.getElementById('cmd_' + serverId).value.trim();
			const resp = document.getElementById('resp_' + serverId).value.trim();
			const statusEl = document.getElementById('status_' + serverId);

			if (!cmd || !resp) {
				statusEl.className = 'config-status error';
				statusEl.textContent = '❌ Command and Response are required';
				statusEl.style.display = 'block';
				return;
			}

			fetch('/api/server_config?serverId=' + serverId + '&command=' + encodeURIComponent(cmd) + '&response=' + encodeURIComponent(resp), { method: 'POST' })
				.then(r => r.json())
				.then(data => {
					if (!data.error) {
						statusEl.className = 'config-status';
						statusEl.textContent = '✅ Config saved successfully! Command: "' + cmd + '" will respond with: "' + resp + '"';
						statusEl.style.display = 'block';
					} else {
						throw new Error('Save failed');
					}
				})
				.catch(err => {
					statusEl.className = 'config-status error';
					statusEl.textContent = '❌ Error: ' + err.message;
					statusEl.style.display = 'block';
				});
		}

		function clearServerConfig(serverId) {
			document.getElementById('cmd_' + serverId).value = '';
			document.getElementById('resp_' + serverId).value = '';
			document.getElementById('status_' + serverId).style.display = 'none';
		}

		socket.on('log', (logData) => {
			const logEl = document.getElementById('logs');
			const log = logData.log;
			const timestamp = new Date(logData.timestamp).toLocaleTimeString();
			
			let message = '';
			if (typeof log === 'object') {
				message = (log.type ? '[' + log.type + '] ' : '') + (log.message || '');
			} else {
				message = String(log);
			}
			
			const color = log?.type === 'ErrorMessage' ? '#f44336' : 
						  log?.type === 'DebugMessage' ? '#888' :
						  log?.type === 'BotMessage' ? '#4CAF50' : '#fff';
			
			logMessages.unshift('<div style="color: ' + color + '"><small>[' + timestamp + ']</small> ' + message + '</div>');
			
			if (logMessages.length > 50) logMessages.pop();
			
			logEl.innerHTML = logMessages.join('');
			logEl.scrollTop = 0;
		});
	</script>
</body>
</html>`);
});

// Login Page
global_app.get("/login", (req, res) => {
	res.send(`<!DOCTYPE html>
<html>
<head>
	<title>Revolt Bot - Login</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: Arial; background: #1a1a1a; height: 100vh; }
		.container { width: 100%; height: 100%; display: flex; flex-direction: column; }
		.header { background: #2a2a2a; padding: 15px; border-bottom: 2px solid #4CAF50; color: #fff; }
		.header h2 { color: #4CAF50; margin-bottom: 5px; }
		.header p { color: #aaa; font-size: 13px; }
		a { color: #4CAF50; text-decoration: none; font-weight: bold; }
		a:hover { text-decoration: underline; }
		iframe { flex: 1; border: none; width: 100%; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h2>🔐 Revolt Bot Account Login</h2>
			<p>Login with your Revolt account. <a href="/">← Back to Dashboard</a></p>
		</div>
		<iframe src="https://revolt.onech.at/"></iframe>
	</div>
</body>
</html>`);
});

// API Routes
global_app.post("/api/server", async (req, res) => {
	if (!req.query.server) return res.end("Server required");
	if (ports[req.query.server]) return res.end("Already started");
	await start_everything(req.query.server, false, true);  // Added true to start immediately
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
	await start_everything(slug, true, true);  // Changed to true so bot starts immediately
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

// Start Global Server
global_server.listen(RAILWAY_PORT, RAILWAY_HOST, () => {
	console.log(`[RAILWAY SERVER] Listening on ${RAILWAY_HOST}:${RAILWAY_PORT}`);
	if (!IS_RAILWAY) {
		setTimeout(() => {
			open(`http://localhost:${RAILWAY_PORT}`).catch(() => {});
		}, 500);
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
		console.log(`--------------------------`);
		console.log(`Dashboard: http://localhost:${RAILWAY_PORT}`);
		console.log(`--------------------------`);
	}
});