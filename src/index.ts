import { ServiceNowMCP, registeredToolNames } from "./mcp-agent";
import {
	type Env,
	type SNProps,
	extractCredentialHeaders,
} from "./sn-client";

export { ServiceNowMCP };

/**
 * Validate the bearer token. Returns:
 *   "ok"      — auth passed (or auth disabled because MCP_AUTH_TOKEN is empty)
 *   "missing" — no Authorization header present
 *   "invalid" — header present but token doesn't match
 */
function checkAuth(request: Request, env: Env): "ok" | "missing" | "invalid" {
	if (!env.MCP_AUTH_TOKEN) return "ok";
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return "missing";
	return auth.slice(7) === env.MCP_AUTH_TOKEN ? "ok" : "invalid";
}

function unauthorized(reason: "missing" | "invalid"): Response {
	const message =
		reason === "missing"
			? "No Authorization header. Add 'Authorization: Bearer <token>' to your client config."
			: "Invalid bearer token. The token does not match the server's MCP_AUTH_TOKEN.";
	// NOTE: deliberately NO WWW-Authenticate header. mcp-remote and other
	// MCP clients treat a 401 + "WWW-Authenticate: Bearer" as a signal to
	// start an OAuth discovery/registration flow (RFC 9728). This server uses
	// a STATIC bearer token, not OAuth, so advertising WWW-Authenticate sends
	// clients down a fatal OAuth path (registerClient → ServerError) instead
	// of letting them connect with the token they already hold. Keep it off.
	return new Response(
		JSON.stringify({ error: "Unauthorized", reason, message }),
		{
			status: 401,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * Resolve effective credentials in the WORKER handler, where request headers
 * are reliably available (unlike inside the Durable Object, where the SDK's
 * SSE transport drops them — see cloudflare/agents#660).
 *
 * Header value wins; env var is the fallback. Result is passed to the agent
 * as `props`, which the SDK persists to DO storage and exposes as this.props
 * — surviving hibernation and available before any tool call.
 */
function resolveProps(request: Request, env: Env): SNProps {
	const h = extractCredentialHeaders(request);
	return {
		instanceUrl: (
			h.instanceUrl ||
			env.SERVICENOW_INSTANCE_URL ||
			""
		).replace(/\/$/, ""),
		username: h.username || env.SERVICENOW_USERNAME || "",
		password: h.password || env.SERVICENOW_PASSWORD || "",
		scriptExecution:
			(h.scriptExecution ?? env.ENABLE_SCRIPT_EXECUTION) === "true",
	};
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify(
					{
						status: "ok",
						service: "ServiceNow MCP Server",
						auth_enabled: !!env.MCP_AUTH_TOKEN,
						tools: registeredToolNames(env),
					},
					null,
					2,
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		const auth = checkAuth(request, env);
		if (auth !== "ok") {
			return unauthorized(auth);
		}

		// Resolve per-request credentials and attach to ctx.props. The agents
		// SDK reads ctx.props and persists it as this.props on the Durable
		// Object — available in init() and all tool handlers, hibernation-safe.
		// (This is the documented mechanism; passing props as a serve() option
		// does not work.)
		// @ts-ignore — ctx.props is the SDK's prop-injection channel
		ctx.props = resolveProps(request, env);

		if (url.pathname === "/mcp") {
			return ServiceNowMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return ServiceNowMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
