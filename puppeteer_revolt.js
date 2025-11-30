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

// ✅ MAX SPEED: Pre-generate nonce pool
function generate_nonce(length) {
	return randomBytes(length).toString("base64").replace(/\+/g, "0").replace(/\//g, "1").substring(0, length).toUpperCase();
}

// ✅ MAX SPEED: Nonce pool - pre-generate 1000 nonces
var noncePool = [];
function fillNoncePool() {
	while (noncePool.length < 1000) {
		noncePool.push(`01${generate_nonce(24)}`);
	}
}
fillNoncePool();

function getNonce() {
	if (noncePool.length < 100) {
		fillNoncePool(); // Async refill when running low
	}
	return noncePool.pop() || `01${generate_nonce(24)}`;
}

// ========================================
// MAIN FUNCTION
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

	// CORS middleware
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
	var token = "";
	var error = 0;

	var newChannels = [];

	// ✅ MAX SPEED: Cache already_responded in memory
	var alreadyRespondedCache = new Set(fs.existsSync(`./${IDENTIFIER_USER}/already_responded.txt`) ? fs.readFileSync(`./${IDENTIFIER_USER}/already_responded.txt`).toString().split("\n").filter((x) => x) : []);

	// ✅ MAX SPEED: Direct message sending function using Node.js fetch
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
		console.log("Connected");
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
			var instantResponse = await getInstantResponse(msg?.content, server._id, channel?.name);

			if (instantResponse.found) {
				addLog({ type: "BotMessage", message: `✅ Instant response match` });
				if (instantResponse?.response) {
					// ✅ MAX SPEED: Use direct send
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

		// ✅ MAX SPEED: Use cached Set
		if (alreadyRespondedCache.has(msg._id)) {
			return; // Skip silently for maximum speed
		}

		if (_canReply.canReply) {
			// ✅ MAX SPEED: Add to cache immediately
			alreadyRespondedCache.add(msg._id);
			fs.appendFileSync(`./${IDENTIFIER_USER}/already_responded.txt`, msg._id + "\n");

			var response = responses[msg.server] || "";

			if (response) {
				// ✅ MAX SPEED: Use setImmediate to ensure we don't block WebSocket processing
				setImmediate(async () => {
					try {
						if (responseType[msg.server] == "PARSED_NUMBER") {
							response = extractNumbers(msg.name)[0];
						}

						if (response) {
							// ✅ MAX SPEED: Direct send - NO page.evaluate overhead!
							const result = await sendMessageDirect(msg._id, response);
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
				// ✅ MAX SPEED: Use cached Set
				if (alreadyRespondedCache.has(channel._id)) {
					continue;
				}

				newChannels.splice(i, 1);

				// ✅ MAX SPEED: Add to cache immediately
				alreadyRespondedCache.add(channel._id);
				fs.appendFileSync(`./${IDENTIFIER_USER}/already_responded.txt`, channel._id + "\n");

				var found = findCategoryByChannelId(channel._id, msg.data.categories);
				var _canReply = await getCanReply(found.id, channel.name, msg.id);

				if (_canReply.canReply) {
					var response = responses[channel.server] || "";

					if (response) {
						// ✅ MAX SPEED: Use setImmediate
						setImmediate(async () => {
							try {
								if (responseType[channel.server] == "PARSED_NUMBER") {
									response = extractNumbers(channel.name)[0];
								}

								if (response) {
									// ✅ MAX SPEED: Direct send
									const result = await sendMessageDirect(channel._id, response);
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
		browser = await puppeteer.launch({
			userDataDir: `./${IDENTIFIER_USER}/browser-userdata`,
			headless: force_headful ? false : IS_HEADLESS,
			args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-web-security", "--disable-features=IsolateOrigins,site-per-process", "--disable-site-isolation-trials"],
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
						addLog({ type: "DebugMessage", message: "Authenticated" });
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

				if (`${serverId}_keywords_is_case_sensitive`) {
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

	// Keep the old sendMessage for API compatibility
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
		res.json(clientInfo);
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

	app.post("/api/set_response_keyword_case_sensitive", async (req, res) => {
		if (!req.query.state) {
			return res.status(400).json({ error: true, message: "State is empty" });
		}
		if (!req.query.state != true && !req.query.state != false) {
			return res.status(400).json({ error: true, message: "State is not a boolean" });
		}
		if (!req.query.serverId) {
			return res.status(400).json({ error: true, message: "Server ID is empty" });
		}

		await setKeywordCaseSensitive(req.query.state, req.query.serverId);
		addLog({ type: "DebugMessage", message: `Keyword responding is now ${req.query.state ? "case sensitive" : "case insensitive"} on "${req.query.serverId}"` });
		res.json({ ...responses, error: false });
	});

	app.post("/api/add_response_keyword", async (req, res) => {
		if (!req.query.string) {
			return res.status(400).json({ error: true, message: "String is empty" });
		}
		if (!req.query.serverId) {
			return res.status(400).json({ error: true, message: "Server ID is empty" });
		}

		try {
			var result = await addReplyWithKeyword(req.query.string, req.query.serverId);
			addLog({ type: "DebugMessage", message: `Bot will now respond to categories on server "${req.query.serverId}" with the keyword ${req.query.string}` });
			io.emit("responses", responses);
			res.json({ ...responses, error: false });
		} catch (error) {
			if (error.message == "DUPLICATE_KEYWORD") {
				return res.status(400).json({
					error: true,
					reason: "DUPLICATE_KEYWORD",
				});
			}
			res.status(500).json(error);
		}
	});

	app.post("/api/delete_keyword", async (req, res) => {
		if (!req.query.string) {
			return res.status(400).json({ error: true, message: "String is empty" });
		}
		if (!req.query.serverId) {
			return res.status(400).json({ error: true, message: "Server ID is empty" });
		}

		try {
			var result = await removeKeyword(req.query.string, req.query.serverId);
			addLog({ type: "DebugMessage", message: `Keyword "${req.query.string}" for matching has been removed on server ${req.query.serverId}` });
			io.emit("responses", responses);
			res.json({ ...responses, error: false });
		} catch (error) {
			if (error.message == "NON_EXISTENT_KEYWORD") {
				return res.status(400).json({
					error: true,
					reason: "NON_EXISTENT_KEYWORD",
				});
			}
			res.status(500).json(error);
		}
	});

	app.post("/api/set_can_reply", async (req, res) => {
		if (!req.query.categoryId) {
			return res.status(400).json({ error: true, message: "Category ID is empty" });
		}

		addLog({ type: "DebugMessage", message: `Bot will now respond on category "${req.query.categoryId}"` });
		await setCanReply(req.query.categoryId);
		res.json({ canReply, error: false });
	});

	app.post("/api/join_server", async (req, res) => {
		if (!req.query.serverUrl) {
			return res.status(400).json({ error: true, message: "Server URL is empty" });
		}
		try {
			const result = await joinServer(req.query.serverUrl, global_page);

			if (!clientInfo.servers.some((server) => server._id == result.server._id)) {
				clientInfo.servers.push(result.server);
				clientInfo.channels = [...clientInfo.channels, ...result.channels];
			}

			if (result.error) {
				res.status(400).json({ error: true, message: `Something went wrong in joining the server link.`, response: result.response });
			} else {
				addLog({ type: "DebugMessage", message: `Bot has joined the server with the invite link "${req.query.serverUrl}"` });
				res.json({ ...result, clientInfo });
			}
		} catch (error) {
			res.status(500).json({ error: true, message: `Something went wrong in joining the server link.`, response: error });
		} finally {
			io.emit("serverInfo", clientInfo);
			io.emit("canReply", canReply);
			io.emit("responses", responses);
		}
	});

	app.post("/api/leave_server", async (req, res) => {
		if (!req.query.serverId) {
			return res.status(400).json({ error: true, message: "Server ID is empty" });
		}
		try {
			const result = await leaveServer(req.query.serverId, req.query.leaveSilently, global_page);

			if (result.error) {
				res.status(400).json({ error: true, message: `Something went wrong in leaving server.` });
			} else {
				addLog({ type: "DebugMessage", message: `Bot has left the server "${req.query.serverId}"` });
				res.json({ ...result, clientInfo });
			}
		} catch (error) {
			res.status(500).json({ error: true, message: `Something went wrong in leaving server.` });
		} finally {
			io.emit("serverInfo", clientInfo);
			io.emit("canReply", canReply);
			io.emit("responses", responses);
		}
	});

	app.get("/api/logs", async (req, res) => {
		res.json(logs);
	});

	app.delete("/api/set_can_reply", async (req, res) => {
		if (!req.query.categoryId) {
			return res.status(400).json({ error: true, message: "Category ID is empty" });
		}

		addLog({ type: "DebugMessage", message: `Bot will now stop responding on category "${req.query.categoryId}"` });
		await unsetCanReply(req.query.categoryId);
		res.json({ canReply, error: false });
	});

	app.post("/api/set_bot_status", async (req, res) => {
		try {
			if (!req.query.status) {
				return res.status(400).json({ error: true, message: "Status is empty" });
			}

			var result = await setBotStatus(JSON.parse(req.query.status));
			addLog({ type: "BotStatus", message: isBotOn.status ? "Bot is now set to: ON" : "Bot is now set to: OFF" });
			res.json({ error: false, message: `Bot is now turned ${isBotOn.status ? "ON" : "OFF"}` }).status(error.status);
		} catch (error) {
			addLog({ type: "BotStatus", message: "Something went wrong when setting bot status." });
			res.json({ error: true, message: "Something went wrong when setting bot status." }).status(500);
		}
	});

	app.post("/api/set_response_delay", async (req, res) => {
		try {
			if (!req.query.min) {
				return res.status(400).json({ error: true, message: "Minimum is empty" });
			}
			if (!req.query.max) {
				return res.status(400).json({ error: true, message: "Maximum is empty" });
			}

			var result = await setResponseDelay(req.query.min, req.query.max);
			addLog({ type: "DebugMessage", message: `Response delay successfully set` });
			res.json({ error: false, message: "Successfully set response delay." });
			io.emit("response_delay", response_delay);
		} catch (error) {
			res.status(500).json({ error: true, message: "Something went wrong when setting response delay." });
		}
	});

	app.post("/api/set_response_type", async (req, res) => {
		try {
			if (!response_types.includes(req.query.response_type)) {
				return res.status(400).json({ error: true, message: `Response type "${req.query.response_type}" is not valid.` });
			}

			if (!req.query.serverId) {
				return res.status(400).json({ error: true, message: "Server ID is empty" });
			}

			var result = await setResponseType(req.query.response_type, req.query.serverId);
			addLog({ type: "DebugMessage", message: `Response type successfully set to ${req.query.response_type}` });
			res.json({ error: false, message: "Successfully set response type." });
			io.emit("response_type", responseType);
		} catch (error) {
			res.status(500).json({ error: true, message: "Something went wrong when setting response type." });
		}
	});

	app.post("/api/instant_response", async (req, res) => {
		try {
			const { serverId, message, respondWith, regex, caseSensitive, uuid } = req.query;

			if (!serverId) return res.status(400).json({ error: true, message: "Server ID is empty" });
			if (!uuid) return res.status(400).json({ error: true, message: "UUID is empty" });
			if (!message) return res.status(400).json({ error: true, message: "Message is empty" });
			if (!respondWith && !regex) return res.status(400).json({ error: true, message: "Response is empty" });
			if (!regex) return res.status(400).json({ error: true, message: "Response type is empty" });
			if (caseSensitive && !["true", "false"].includes(caseSensitive)) return res.status(400).json({ error: true, message: "caseSensitive must be 'true' or 'false'" });

			var result = await addInstantResponse(serverId, message, respondWith, regex, caseSensitive, uuid);
			addLog({ type: "DebugMessage", message: `Instant response added in server ${serverId}` });
			res.json({ error: false, message: "Successfully added instant response." });
			io.emit("instant_responses", clientInfo.instantResponses);
		} catch (error) {
			res.json({ error: true, message: "Something went wrong when adding instant response." });
		}
	});

	app.delete("/api/instant_response", async (req, res) => {
		try {
			const { serverId, uuid } = req.query;

			if (!serverId) return res.status(400).json({ error: true, message: "Server ID is empty" });
			if (!uuid) return res.status(400).json({ error: true, message: "UUID is empty" });

			var result = await removeInstantResponse(serverId, uuid);
			addLog({ type: "DebugMessage", message: `Instant response deleted in server ${serverId}` });
			res.json({ error: false, message: "Successfully deleted instant response." });
			io.emit("instant_responses", clientInfo.instantResponses);
		} catch (error) {
			res.json({ error: true, message: "Something went wrong when deleting instant response." });
		}
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

		server.listen(port, '0.0.0.0', () => {
			addLog({ type: "DebugMessage", message: `Now listening to: http://0.0.0.0:${port}` });
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

const global_app = express();
const global_server = createServer(global_app);
const global_io = new Server(global_server);

global_io.on("connection", () => {
	global_io.emit("bot_version", bot_version);
	emit_server_info();
});

global_app.use(express.static(path.join(__dirname, "public/multi")));

// Revolt Client Route - Direct access to Revolt
global_app.get("/client", (req, res) => {
	res.send(`
		<!DOCTYPE html>
		<html>
		<head>
			<title>Revolt</title>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
				* { margin: 0; padding: 0; box-sizing: border-box; }
				html, body { width: 100%; height: 100%; overflow: hidden; }
				body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #000; }
				iframe { width: 100%; height: 100%; border: none; display: block; }
				.back-btn {
					position: fixed;
					top: 10px;
					left: 10px;
					z-index: 10000;
					background: rgba(76, 175, 80, 0.8);
					color: white;
					border: none;
					padding: 10px 15px;
					border-radius: 4px;
					cursor: pointer;
					font-size: 12px;
					font-weight: bold;
				}
				.back-btn:hover { background: rgba(76, 175, 80, 1); }
			</style>
		</head>
		<body>
			<button class="back-btn" onclick="window.location.href='/'">← Dashboard</button>
			<iframe src="https://revolt.onech.at/" allow="camera; microphone; clipboard-read; clipboard-write; geolocation"></iframe>
		</body>
		</html>
	`);
});

// Root route - Bot Control Panel with Status
global_app.get("/", (req, res) => {
	res.send(`
		<!DOCTYPE html>
		<html>
		<head>
			<title>Revolt Bot Control Panel</title>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
				* { margin: 0; padding: 0; box-sizing: border-box; }
				body { 
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
					background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
					color: #fff;
					padding: 20px;
				}
				.container { max-width: 1200px; margin: 0 auto; }
				.header { text-align: center; margin-bottom: 40px; }
				h1 { font-size: 32px; margin-bottom: 10px; }
				.subtitle { color: #888; font-size: 14px; }
				
				.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
				.card { 
					background: rgba(255,255,255,0.05);
					border: 1px solid rgba(255,255,255,0.1);
					border-radius: 12px;
					padding: 20px;
					backdrop-filter: blur(10px);
				}
				
				.status-box { 
					background: rgba(76, 175, 80, 0.1);
					border: 2px solid #4CAF50;
					border-radius: 8px;
					padding: 15px;
					margin: 15px 0;
				}
				.status-box.connecting { 
					border-color: #FFC107;
					background: rgba(255, 193, 7, 0.1);
				}
				.status-box.error { 
					border-color: #f44336;
					background: rgba(244, 67, 54, 0.1);
				}
				
				.status-indicator { 
					display: inline-block;
					width: 12px;
					height: 12px;
					border-radius: 50%;
					margin-right: 8px;
					animation: pulse 2s infinite;
				}
				.status-indicator.connected { background: #4CAF50; }
				.status-indicator.connecting { background: #FFC107; }
				.status-indicator.disconnected { background: #f44336; animation: none; }
				
				@keyframes pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.5; }
				}
				
				.servers-list { 
					display: grid;
					grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
					gap: 15px;
					margin-top: 20px;
				}
				.server-card {
					background: rgba(255,255,255,0.08);
					border: 1px solid rgba(255,255,255,0.15);
					border-radius: 8px;
					padding: 15px;
					transition: all 0.3s ease;
				}
				.server-card:hover { 
					background: rgba(255,255,255,0.12);
					border-color: rgba(76, 175, 80, 0.5);
				}
				.server-card h3 { margin-bottom: 10px; font-size: 14px; }
				.server-status { 
					font-size: 12px;
					color: #aaa;
					margin: 8px 0;
				}
				
				button {
					background: #4CAF50;
					color: white;
					border: none;
					padding: 10px 16px;
					border-radius: 6px;
					cursor: pointer;
					font-size: 14px;
					margin-top: 10px;
					transition: all 0.3s;
				}
				button:hover { 
					background: #45a049;
					transform: translateY(-2px);
				}
				button.danger { background: #f44336; }
				button.danger:hover { background: #da190b; }
				
				.logs { 
					background: rgba(0,0,0,0.3);
					border: 1px solid rgba(255,255,255,0.1);
					border-radius: 8px;
					padding: 15px;
					height: 300px;
					overflow-y: auto;
					font-family: 'Courier New', monospace;
					font-size: 12px;
					margin-top: 20px;
				}
				.log-entry { 
					padding: 5px 0;
					border-bottom: 1px solid rgba(255,255,255,0.05);
				}
				.log-debug { color: #aaa; }
				.log-success { color: #4CAF50; }
				.log-error { color: #f44336; }
				
				.actions {
					display: flex;
					gap: 10px;
					margin-top: 15px;
				}
				
				.full-width { grid-column: 1 / -1; }
			</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<h1>🤖 Revolt Bot Control Panel</h1>
					<p class="subtitle">Bot Management & Monitoring</p>
				</div>

				<div class="grid">
					<div class="card">
						<h2>Bot Status</h2>
						<div class="status-box" id="botStatus">
							<span class="status-indicator connecting"></span>
							<span>Initializing...</span>
						</div>
						<p style="font-size: 12px; color: #aaa; margin-top: 10px;">
							Bot Version: <strong id="botVersion">Loading...</strong>
						</p>
					</div>

					<div class="card">
						<h2>Server Management</h2>
						<p style="font-size: 12px; color: #aaa; margin-bottom: 15px;">
							Running Instances: <strong id="serverCount">0</strong>
						</p>
						<button onclick="addNewServer()">+ New Bot Instance</button>
					</div>
				</div>

				<div class="grid">
					<div class="card">
						<h2>Revolt Client</h2>
						<p style="font-size: 12px; color: #aaa; margin-bottom: 15px;">
							Access the Revolt chat client
						</p>
						<button onclick="window.location.href='/client'" style="background: #5865F2; margin-top: 20px;">→ Open Revolt</button>
					</div>

					<div class="card">
						<h2>Instructions</h2>
						<p style="font-size: 11px; color: #aaa; line-height: 1.6;">
							<strong>1.</strong> Click "Open Revolt" to login<br>
							<strong>2.</strong> Create bot instances here<br>
							<strong>3.</strong> Bot will auto-respond in chat<br>
							<strong>4.</strong> Monitor logs below
						</p>
					</div>
				</div>

				<div class="card full-width">
					<h2>Active Servers</h2>
					<div class="servers-list" id="serversList">
						<p style="color: #888;">No servers running yet...</p>
					</div>
				</div>

				<div class="card full-width">
					<h2>Activity Log</h2>
					<div class="logs" id="logs"></div>
				</div>
			</div>

			<script src="/socket.io/socket.io.js"></script>
			<script>
				// Auto-open Revolt window on first visit
				if (!sessionStorage.getItem('revoltWindowOpened')) {
					sessionStorage.setItem('revoltWindowOpened', 'true');
					setTimeout(() => {
						window.open('https://revolt.onech.at/', 'revolt_chat', 'width=1400,height=900');
					}, 800);
				}

				const socket = io();
				const logs = [];
				const maxLogs = 50;

				function addLog(type, message) {
					const timestamp = new Date().toLocaleTimeString();
					logs.unshift({ type, message, timestamp });
					if (logs.length > maxLogs) logs.pop();
					updateLogsUI();
				}

				function updateLogsUI() {
					const logsEl = document.getElementById('logs');
					logsEl.innerHTML = logs.map(log => {
						const className = log.type === 'error' ? 'log-error' : 
										   log.type === 'success' ? 'log-success' : 'log-debug';
						return '<div class="log-entry ' + className + '">[' + log.timestamp + '] ' + log.message + '</div>';
					}).join('');
					logsEl.scrollTop = 0;
				}

				socket.on('bot_version', (version) => {
					document.getElementById('botVersion').textContent = version;
					addLog('success', 'Connected to bot server');
				});

				socket.on('servers', (servers) => {
					const serverCount = servers?.length || 0;
					document.getElementById('serverCount').textContent = serverCount;

					if (!servers || servers.length === 0) {
						document.getElementById('serversList').innerHTML = '<p style="color: #888; grid-column: 1/-1;">No servers running yet</p>';
						return;
					}

					document.getElementById('serversList').innerHTML = servers.map(server => {
						const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
						const dashboardBtn = server.port && isLocalhost ? 
							'<button onclick="window.open(\\'http://localhost:' + server.port + '\\', \\'_blank\\')">📊 Dashboard</button>' : 
							'<button onclick="alert(\\'Bot running on port ' + (server.port || 'N/A') + '.\\\\nDashboard accessible on local machine only.\\')">📊 Info</button>';
						return '<div class="server-card">' +
							'<h3>' + (server.username || server.folder) + '</h3>' +
							'<div class="server-status">' +
								'Status: <span class="status-indicator ' + (server.is_running ? 'connected' : 'disconnected') + '"></span>' +
								(server.is_running ? 'Running' : 'Stopped') +
							'</div>' +
							'<div class="server-status">' +
								'Port: ' + (server.port || 'N/A') +
							'</div>' +
							'<div class="server-status">' +
								'Mode: ' + (server.is_headless ? 'Headless' : 'Headful') +
							'</div>' +
							'<div class="actions">' +
								dashboardBtn +
								'<button class="danger" onclick="deleteServer(\\'' + server.folder + '\\')">Delete</button>' +
							'</div>' +
						'</div>';
					}).join('');
				});

				socket.on('bot_info', (info) => {
					addLog('success', 'Bot logged in as: ' + info.username);
					updateBotStatus('connected', 'Connected to Revolt');
				});

				socket.on('log', (log) => {
					const type = log.log?.type || 'debug';
					const message = log.log?.message || JSON.stringify(log.log);
					addLog(type.toLowerCase(), message);
				});

				function updateBotStatus(status, message) {
					const statusEl = document.getElementById('botStatus');
					const indicator = statusEl.querySelector('.status-indicator');
					const text = statusEl.querySelector('span:last-child');
					
					statusEl.className = 'status-box ' + status;
					indicator.className = 'status-indicator ' + status;
					text.textContent = message;
				}

				function addNewServer() {
					fetch('/api/add_server', { method: 'POST' })
						.then(() => addLog('success', 'Creating new bot instance...'))
						.catch(err => addLog('error', 'Failed to create server: ' + err));
				}

				function deleteServer(folder) {
					if (confirm('Delete this bot instance? This cannot be undone.')) {
						fetch('/api/server?server=' + folder, { method: 'DELETE' })
							.then(() => addLog('success', 'Server deleted: ' + folder))
							.catch(err => addLog('error', 'Failed to delete: ' + err));
					}
				}



				// Initial request
				addLog('info', 'Connecting to bot server...');
				socket.emit('request_info');
			</script>
		</body>
		</html>
	`);
});

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

global_app.post("/api/add_server", async (req, res) => {
	const slug = "server-" + generateSlug();
	res.end(slug);
	await start_everything(slug, true, false);

	emit_server_info();
});

global_server.listen(PORT, HOST, () => {
	console.log(`[SERVER START] Listening on ${HOST}:${PORT}`);
	if (!IS_RAILWAY) {
		// Only try to open browser on local development
		open(`http://localhost:${PORT}`).catch(() => {});
	}
	emit_server_info();
});

rl.input.on("keypress", async (char, key) => {
	if (key.name === "c" && key.ctrl) {
		console.log({ type: "DebugMessage", message: `CTRL + C was pressed. Exiting now.` });
		rl.close();
		process.exit(0);
	}

	if (key.name === "u") {
		console.log(`--------------------------`);
		console.log(`http://localhost:${PORT}`);
		console.log(`--------------------------`);
	}
});