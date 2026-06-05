import { ServiceNowMCP, registeredToolNames } from "./mcp-agent";
import type { Env } from "./sn-client";

export { ServiceNowMCP };

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Streamable HTTP transport (modern clients).
		if (url.pathname === "/mcp") {
			return ServiceNowMCP.serve("/mcp", { env }).fetch(
				request,
				env,
				ctx,
			);
		}

		// SSE transport (legacy clients via mcp-remote, including Claude Desktop).
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return ServiceNowMCP.serveSSE("/sse", { env }).fetch(
				request,
				env,
				ctx,
			);
		}

		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify(
					{
						status: "ok",
						service: "ServiceNow MCP Server",
						instance: env.SERVICENOW_INSTANCE_URL,
						script_execution_enabled:
							env.ENABLE_SCRIPT_EXECUTION === "true",
						tools: registeredToolNames(env),
					},
					null,
					2,
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		return new Response("Not found", { status: 404 });
	},
};
