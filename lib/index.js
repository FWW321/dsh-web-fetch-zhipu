/**
 * @fww/dsh-web-fetch-zhipu
 *
 * Zhipu BigModel-backed `WebFetchProvider` for the DeepSeek Harness web
 * capability seam (`ctx.web`) — the fetch twin of
 * @fww/dsh-web-search-zhipu. Talks to Zhipu's hosted web_reader MCP
 * endpoint (open.bigmodel.cn/api/mcp/web_reader/mcp, streamable-http
 * JSON-RPC 2.0) with Bearer auth; the server requires a stateful MCP
 * handshake (initialize → `mcp-session-id` → `notifications/initialized`)
 * before `tools/call`, and the session id is cached and transparently
 * re-established when dropped.
 *
 * SSRF posture: fetch is DELEGATED — the reader runs on Zhipu's network,
 * not this machine. The only local network activity is the outbound HTTPS
 * to the MCP endpoint; classic SSRF targets (loopback, RFC1918, cloud
 * metadata) are unreachable from the reader's vantage point. The seam's
 * "provider owns SSRF protection" rule is vacuously satisfied: this
 * provider never fetches from the local network.
 *
 * Configuration mirrors the search twin: endpoint/tool are FIXED
 * constants (web_reader / webReader) — a Zhipu change is a source release,
 * not a config knob. Configurable: the key (env or literal), retrieval
 * format, cache bypass, timeout, and the markdown/text body cap.
 *
 * This is an implementation package: it registers a provider INTO
 * `ctx.web` (`inject: ['web']`) and owns no model-facing tools (`web_fetch`
 * belongs to `@deepseek-ai/dsh-tool-web`). It installs a Settings section
 * (`web-fetch-zhipu`) for hot edits, and audits each fetch into the
 * initiating agent's session (`web/zhipu-fetch-mcp-request`).
 */

import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { WebError } from "@deepseek-ai/dsh-web";
import z from "@deepseek-ai/schemastery";

/** Default provider id this provider registers under (`ctx.web` registry key). */
const DEFAULT_PROVIDER_ID = "zhipu";
/** Environment variable consulted when no literal `apiKey` is configured. */
const DEFAULT_API_KEY_ENV = "ZHIPU_API_KEY";
/** The Zhipu MCP endpoint (fixed): the web_reader service. */
const MCP_URL = "https://open.bigmodel.cn/api/mcp/web_reader/mcp";
/** The MCP tool called on that endpoint (fixed). */
const TOOL = "webReader";
/** Reader-side timeout per fetch (seconds), passed to the tool. */
const DEFAULT_READER_TIMEOUT_S = 20;
/** Default body cap (chars) applied on top of the tool-level fetchMaxOutputChars. */
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
/** Handshake and fetch timeout per request (ms). */
const REQUEST_TIMEOUT_MS = 60_000;
/** Settings namespace carrying this provider's configuration. */
const SETTINGS_NAMESPACE = settingsNamespace("web-fetch-zhipu");

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Throw the seam's stable cancellation error when the caller is already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) {
		throw new WebError("Zhipu fetch aborted", "WEB_ABORTED", { cause: signal.reason });
	}
}

/**
 * Resolve the API key: literal config first, then the environment variable.
 * `undefined` means the provider reports itself unavailable.
 */
function resolveApiKey(options) {
	if (options.apiKey != null && options.apiKey.length > 0) return options.apiKey;
	const fromEnv = process.env[options.apiKeyEnv];
	if (fromEnv != null && fromEnv.length > 0) return fromEnv;
	return undefined;
}

/** An `AbortSignal.timeout`-alike combined with the caller's signal, if any. */
function timeoutSignal(ms, external) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	const abort = () => controller.abort(external?.reason);
	if (external !== undefined) {
		if (external.aborted) {
			clearTimeout(timer);
			controller.abort(external.reason);
		} else {
			external.addEventListener("abort", abort, { once: true });
		}
	}
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			if (external !== undefined) external.removeEventListener("abort", abort);
		},
	};
}

/**
 * Parse one `text/event-stream` response body into its first `data:`
 * JSON payload, falling back to plain JSON. Returns `null` when neither parses.
 */
function parseSsePayload(text) {
	const dataLines = text.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^\s/, ""));
	if (dataLines.length > 0) {
		try {
			return JSON.parse(dataLines.join("\n"));
		} catch {
			return null;
		}
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Extract a human-readable message from a JSON-RPC error payload, best effort. */
function rpcErrorMessage(payload) {
	const error = payload?.error;
	if (error == null) return null;
	const message = error.message ?? error.data;
	if (message === undefined) return null;
	return typeof message === "string" ? message : JSON.stringify(message);
}

/**
 * Decode the reader document out of a successful `tools/call`. The payload
 * is double-encoded (content[0].text is a JSON string of another JSON
 * string of the `{title, url, content, metadata, external}` object).
 * Unwrap string layers until an object with `content` appears.
 */
function decodeReaderDocument(payload) {
	const content = payload?.result?.content;
	if (!Array.isArray(content)) return null;
	const joined = content
		.map((item) => (typeof item?.text === "string" ? item.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
	if (joined.length === 0) return null;
	let current = joined;
	for (let depth = 0; depth < 3; depth += 1) {
		if (typeof current !== "string") break;
		try {
			current = JSON.parse(current);
		} catch {
			return null;
		}
	}
	if (current === null || typeof current !== "object" || typeof current.content !== "string") {
		return null;
	}
	return current;
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Project one resolved configuration section into the options the provider
 * serves its next fetch with. Called per operation so live Settings edits
 * take effect on the next fetch.
 */
function resolveOptions(section) {
	return {
		providerId: section.providerId ?? DEFAULT_PROVIDER_ID,
		apiKey: section.apiKey ?? "",
		apiKeyEnv: section.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		returnFormat: section.returnFormat ?? "markdown",
		noCache: section.noCache ?? false,
		readerTimeoutS: section.readerTimeoutS ?? DEFAULT_READER_TIMEOUT_S,
		maxOutputChars: section.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
	};
}

class ZhipuFetchProvider {
	resolveOptions;
	id;
	#session; // { apiKey, id } — cached MCP session for reuse
	#idCounter = 0;

	/**
	 * @param resolveOptions - thunk returning the options for the NEXT
	 * operation, snapshotted once at each operation's entry so one fetch
	 * never mixes two settings sections.
	 */
	constructor(resolveOptions, recordRequest) {
		this.resolveOptions = resolveOptions;
		this.id = resolveOptions().providerId ?? DEFAULT_PROVIDER_ID;
		this.recordRequest = recordRequest;
	}

	/** Usable only with a key — the endpoint is a fixed parseable constant. */
	available() {
		return resolveApiKey(this.resolveOptions()) !== undefined;
	}

	async fetch(request, signal) {
		throwIfAborted(signal);
		const options = this.resolveOptions();
		const apiKey = resolveApiKey(options);
		if (apiKey === undefined) {
			throw new WebError(
				`Zhipu fetch provider has no API key (configure one, or set ${options.apiKeyEnv})`,
				"WEB_PROVIDER_CREDENTIAL_MISSING",
			);
		}
		return await this.#mcpFetch(request, apiKey, options, signal);
	}

	#nextId() {
		this.#idCounter += 1;
		return this.#idCounter;
	}

	/** POST one JSON-RPC message; returns `{ payload, newSessionId }` (header, when sent). */
	async #rpc(message, apiKey, sessionId, signal) {
		const { signal: inner, done } = timeoutSignal(REQUEST_TIMEOUT_MS, signal);
		let response;
		try {
			response = await fetch(MCP_URL, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json, text/event-stream",
					...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
				},
				body: JSON.stringify(message),
				signal: inner,
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw new WebError("Zhipu fetch aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
			throw new WebError(`Zhipu MCP request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		} finally {
			done();
		}
		const newSessionId = response.headers.get("mcp-session-id") ?? undefined;
		const text = await response.text();
		if (!response.ok) {
			throw new WebError(`Zhipu MCP error (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
		}
		// Notifications (no message id) legitimately get an empty body back.
		const payload = text.length === 0 && message.id === undefined ? {} : parseSsePayload(text);
		if (payload === null) {
			throw new WebError("Zhipu MCP returned an unprocessable response body", "WEB_PROVIDER_ERROR");
		}
		return { payload, newSessionId };
	}

	/** Full MCP handshake: initialize → (session id) → notifications/initialized. */
	async #handshake(apiKey, signal) {
		const init = await this.#rpc({
			jsonrpc: "2.0",
			id: this.#nextId(),
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "dsh-web-fetch-zhipu", version: "0.1.0" },
			},
		}, apiKey, undefined, signal);
		if (init.payload.error != null) {
			throw new WebError(`Zhipu MCP initialize failed: ${rpcErrorMessage(init.payload) ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
		}
		const id = init.newSessionId;
		if (id === undefined) {
			throw new WebError("Zhipu MCP did not return a session id", "WEB_PROVIDER_ERROR");
		}
		const ready = await this.#rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, apiKey, id, signal);
		if (ready.payload.error != null) {
			throw new WebError(`Zhipu MCP initialized notification failed: ${rpcErrorMessage(ready.payload) ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
		}
		return id;
	}

	async #mcpFetch(request, apiKey, options, signal) {
		throwIfAborted(signal);
		// Tool-level knobs the seam does not model are fixed here: markdown is
		// the reader's strong mode; images are dropped (the seam body is a
		// closed text union).
		const args = {
			url: request.url,
			return_format: options.returnFormat,
			no_cache: options.noCache,
			timeout: options.readerTimeoutS,
		};
		this.recordRequest?.({ arguments: args });

		const attempt = async (sessionId) => {
			this.#idCounter += 1;
			const { payload } = await this.#rpc({
				jsonrpc: "2.0",
				id: this.#idCounter,
				method: "tools/call",
				params: { name: TOOL, arguments: args },
			}, apiKey, sessionId, signal);
			return payload;
		};

		let session = this.#session;
		if (session !== undefined && session.apiKey !== apiKey) {
			session = undefined;
		}
		let payload;
		if (session !== undefined) {
			payload = await attempt(session.id);
			if (payload.error != null && payload.error.code === -401) {
				session = undefined;
				payload = undefined;
			}
		}
		if (session === undefined) {
			const id = await this.#handshake(apiKey, signal);
			this.#session = { apiKey, id };
			payload = await attempt(id);
		}
		if (payload.error != null) {
			const message = rpcErrorMessage(payload);
			throw new WebError(`Zhipu MCP error${message !== null ? `: ${message}` : ""}`, "WEB_PROVIDER_ERROR");
		}
		if (payload.result?.isError === true) {
			// Reader-side failure (bad URL, upstream 5xx, timeout): the tool
			// reports it as isError text rather than an HTTP status. The seam
			// says a non-2xx is a RESULT — but here the document never existed,
			// so a descriptive error code is the honest mapping.
			const detail = (Array.isArray(payload.result.content)
				? payload.result.content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n").trim()
				: "");
			throw new WebError(`Zhipu reader failed${detail.length > 0 ? `: ${detail.slice(0, 300)}` : ""}`, "WEB_PROVIDER_ERROR");
		}
		const document = decodeReaderDocument(payload);
		if (document === null) {
			throw new WebError("Zhipu MCP returned no parseable document", "WEB_PROVIDER_ERROR");
		}
		// The reader converts to model-friendly text and always succeeds with
		// a document; the seam's statusCode carries the reader's success, and
		// truncation flags our char cap.
		const truncated = document.content.length > options.maxOutputChars;
		return {
			url: document.url ?? request.url,
			statusCode: 200,
			body: {
				kind: document.content.trimStart().startsWith("<") ? "html" : "text",
				text: truncated ? document.content.slice(0, options.maxOutputChars) : document.content,
			},
			truncated,
		};
	}
}

// ── Cordis plugin wiring ────────────────────────────────────────────────────

/** Cordis plugin name used by loader diagnostics. */
const name = "web-fetch-zhipu";
/** The web seam this provider registers into. */
const inject = ["web"];

const Config = z.object({
	/**
	 * Provider id registered into `ctx.web` (fetch registry). Defaults to
	 * `zhipu` — same id as the search twin; the registries are separate
	 * maps, so one id may serve both without `WEB_DUPLICATE_PROVIDER`.
	 */
	providerId: z.string().default(DEFAULT_PROVIDER_ID),
	/** Literal Zhipu API key; required unless `apiKeyEnv` is set in the environment. */
	apiKey: z.string().role("secret"),
	/** Environment variable consulted when no literal `apiKey` is configured. */
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	/** Reader conversion mode: `markdown` (strong) or `text`. */
	returnFormat: z.union(["markdown", "text"]).default("markdown"),
	/** Bypass the reader-side cache for this deployment's fetches. */
	noCache: z.boolean().default(false),
	/** Reader-side per-URL timeout (seconds). */
	readerTimeoutS: z.number().step(1).min(1).default(DEFAULT_READER_TIMEOUT_S),
	/** Provider-level body cap (chars); the tool-level `fetchMaxOutputChars` caps again downstream. */
	maxOutputChars: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_CHARS),
});

/**
 * Register the Zhipu fetch provider with `ctx.web` and install its Settings
 * section, so the Web panel edits the same config the provider serves.
 */
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {},
	});
	ctx.web.registerFetchProvider(new ZhipuFetchProvider(
		() => resolveOptions(current()),
		(request) => {
			ctx.get("agents")?.currentInitiator()?.session.append("web/zhipu-fetch-mcp-request", request);
		},
	));
}

export {
	Config,
	DEFAULT_API_KEY_ENV,
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_READER_TIMEOUT_S,
	SETTINGS_NAMESPACE,
	ZhipuFetchProvider,
	apply,
	inject,
	name,
};
