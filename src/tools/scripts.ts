import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * execute_script — synchronous server-side JavaScript execution.
 *
 * Mechanism:
 *   On first call (per instance), the MCP bootstraps a Scripted REST API:
 *     - sys_ws_definition  (the API "service" container)
 *     - sys_ws_operation   (POST /exec — evaluates request.body.data.script)
 *   After bootstrap, every execute_script call is a single synchronous POST
 *   to that endpoint. No scheduler involved; response is sub-second.
 *
 * Why this replaces the previous sys_trigger approach:
 *   sys_trigger runs are batched by the ServiceNow scheduler. Latency is
 *   1–5s on a good day and unbounded on a busy one. For an interactive
 *   developer tool that's broken. Scripted REST runs in the request thread.
 *
 * Bootstrap is idempotent: if the records already exist, we reuse them.
 * Detection: we look up the definition by api_id; if absent, we install.
 */

const API_NAME = "MCP Script Runner";
const API_ID = "mcp_script_runner";
const RESOURCE_NAME = "exec";
const RESOURCE_RELATIVE_PATH = "/exec";

const HANDLER_SCRIPT = `(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var body = request.body && request.body.data;
    if (!body || typeof body.script !== 'string') {
        response.setStatus(400);
        return { status: 'error', message: 'Provide a JSON body with {script: "..."}' };
    }
    var script = body.script;
    try {
        var wrapped = '(function() {\\n' + script + '\\n})()';
        var result = eval(wrapped);
        return {
            status: 'success',
            result: (result === undefined) ? null : result
        };
    } catch (e) {
        response.setStatus(500);
        return {
            status: 'error',
            message: (e && e.message) ? String(e.message) : String(e),
            stack: (e && e.stack) ? String(e.stack) : null
        };
    }
})(request, response);`;

interface BootstrapInfo {
	definition_sys_id: string;
	operation_sys_id: string;
	endpoint_path: string;
}

async function findExistingApi(env: Env): Promise<BootstrapInfo | null> {
	const defResp = await snFetch(
		env,
		`/api/now/table/sys_ws_definition?sysparm_query=service_id=${API_ID}^ORapi_id=${API_ID}&sysparm_fields=sys_id,service_id,namespace,api_id&sysparm_limit=1`,
	);
	const def = defResp?.result?.[0];
	if (!def?.sys_id) return null;

	const opResp = await snFetch(
		env,
		`/api/now/table/sys_ws_operation?sysparm_query=web_service_definition=${def.sys_id}^relative_path=${encodeURIComponent(RESOURCE_RELATIVE_PATH)}&sysparm_fields=sys_id&sysparm_limit=1`,
	);
	const op = opResp?.result?.[0];
	if (!op?.sys_id) return null;

	const namespace = def.namespace || def.api_id || "global";
	const serviceId = def.service_id || def.api_id || API_ID;
	return {
		definition_sys_id: def.sys_id,
		operation_sys_id: op.sys_id,
		endpoint_path: `/api/${namespace}/${serviceId}${RESOURCE_RELATIVE_PATH}`,
	};
}

async function bootstrapApi(env: Env): Promise<BootstrapInfo> {
	const defResp = await snFetch(env, "/api/now/table/sys_ws_definition", {
		method: "POST",
		body: JSON.stringify({
			name: API_NAME,
			service_id: API_ID,
			api_id: API_ID,
			active: "true",
		}),
	});
	const def = defResp?.result;
	if (!def?.sys_id) {
		throw new Error(
			"Failed to create sys_ws_definition — no sys_id in response. " +
				"Check that the service account has 'web_service_admin' or 'admin' role.",
		);
	}

	const opResp = await snFetch(env, "/api/now/table/sys_ws_operation", {
		method: "POST",
		body: JSON.stringify({
			web_service_definition: def.sys_id,
			name: RESOURCE_NAME,
			http_method: "POST",
			relative_path: RESOURCE_RELATIVE_PATH,
			operation_script: HANDLER_SCRIPT,
			active: "true",
			produces: "application/json",
			consumes: "application/json",
			requires_authentication: "true",
		}),
	});
	const op = opResp?.result;
	if (!op?.sys_id) {
		throw new Error(
			"Created sys_ws_definition but sys_ws_operation creation failed.",
		);
	}

	const namespace = def.namespace || def.api_id || "global";
	const serviceId = def.service_id || def.api_id || API_ID;
	return {
		definition_sys_id: def.sys_id,
		operation_sys_id: op.sys_id,
		endpoint_path: `/api/${namespace}/${serviceId}${RESOURCE_RELATIVE_PATH}`,
	};
}

async function runScriptThroughApi(env: Env, script: string): Promise<any> {
	let info = await findExistingApi(env);
	if (!info) {
		info = await bootstrapApi(env);
	}

	try {
		return await snFetch(env, info.endpoint_path, {
			method: "POST",
			body: JSON.stringify({ script }),
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/\b404\b/.test(msg)) {
			info = await bootstrapApi(env);
			return await snFetch(env, info.endpoint_path, {
				method: "POST",
				body: JSON.stringify({ script }),
			});
		}
		throw e;
	}
}

export function registerScriptTools(server: McpServer, env: Env) {
	server.tool(
		"execute_script",
		"Execute arbitrary server-side JavaScript on the ServiceNow instance synchronously. " +
			"Uses a Scripted REST API endpoint that the MCP installs on the instance on first call (one-time bootstrap). " +
			"To return a value, use `return JSON.stringify(yourValue)` — the script runs inside an IIFE. " +
			"Errors include message and stack trace.",
		{
			script: z
				.string()
				.describe(
					"JavaScript to execute. Example: `var gr = new GlideRecord('incident'); gr.addQuery('active', true); gr.setLimit(5); gr.query(); var out = []; while (gr.next()) out.push(gr.getValue('number')); return JSON.stringify(out);`",
				),
		},
		async ({ script }) => {
			try {
				const result = await runScriptThroughApi(env, script);
				return ok(result);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"check_script_runner_status",
		"Show whether the execute_script Scripted REST API is installed on the current instance, and at what URL.",
		{},
		async () => {
			try {
				const info = await findExistingApi(env);
				if (!info) {
					return ok({
						installed: false,
						message:
							"Not bootstrapped yet. Will be installed automatically on the next execute_script call.",
					});
				}
				return ok({
					installed: true,
					endpoint_path: info.endpoint_path,
					definition_sys_id: info.definition_sys_id,
					operation_sys_id: info.operation_sys_id,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"reinstall_script_runner",
		"Delete and reinstall the Scripted REST API used by execute_script. Use this if you've modified the bootstrap script or if the existing API is in a bad state.",
		{},
		async () => {
			try {
				const existing = await findExistingApi(env);
				if (existing) {
					await snFetch(
						env,
						`/api/now/table/sys_ws_operation/${existing.operation_sys_id}`,
						{ method: "DELETE" },
					);
					await snFetch(
						env,
						`/api/now/table/sys_ws_definition/${existing.definition_sys_id}`,
						{ method: "DELETE" },
					);
				}
				const fresh = await bootstrapApi(env);
				return ok({
					status: "reinstalled",
					...fresh,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}
