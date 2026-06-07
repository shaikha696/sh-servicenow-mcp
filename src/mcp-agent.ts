import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env } from "./sn-client";
import { registerAggregateTools } from "./tools/aggregate";
import { registerDebugTools } from "./tools/debug";
import { registerExploreTools } from "./tools/explore";
import { registerIncidentTools } from "./tools/incidents";
import { registerKnowledgeTools } from "./tools/knowledge";
import { registerSchemaTools } from "./tools/schema";
import { registerScriptTools } from "./tools/scripts";
import { registerTableTools } from "./tools/table";
import { registerUpdateSetTools } from "./tools/update_sets";
import { registerUserTools } from "./tools/users";

/**
 * ServiceNow MCP agent.
 *
 * Tool groups are registered modularly. Each group lives in src/tools/*.ts and
 * exposes a `register*` function that takes (server, env). Adding new tool
 * groups is mechanical: create a new file under src/tools/, export a register
 * function, import and call it here.
 *
 * execute_script is gated on ENABLE_SCRIPT_EXECUTION="true". If the env var
 * isn't set to exactly "true", the tool is not registered at all — MCP clients
 * won't even see it in the tool list.
 */
export class ServiceNowMCP extends McpAgent {
	server = new McpServer({
		name: "ServiceNow MCP Server",
		version: "1.0.0",
	});

	async init() {
		const env = this.env as Env;

		registerTableTools(this.server, env);
		registerIncidentTools(this.server, env);
		registerUserTools(this.server, env);
		registerSchemaTools(this.server, env);
		registerExploreTools(this.server, env);
		registerAggregateTools(this.server, env);
		registerKnowledgeTools(this.server, env);
		registerUpdateSetTools(this.server, env);
		registerDebugTools(this.server, env);

		if (env.ENABLE_SCRIPT_EXECUTION === "true") {
			registerScriptTools(this.server, env);
		}
	}
}

/** Tool names registered for /health visibility. */
export function registeredToolNames(env: Env): string[] {
	const base = [
		"query_table",
		"get_record",
		"create_record",
		"update_record",
		"delete_record",
		"batch_create_records",
		"update_incident",
		"add_work_note",
		"get_user",
		"get_table_schema",
		"search_tables",
		"search_fields",
		"get_choices",
		"aggregate_table",
		"search_knowledge",
		"set_current_update_set",
		"get_current_update_set",
		"query_logs",
	];
	if (env.ENABLE_SCRIPT_EXECUTION === "true") {
		base.push("execute_script", "check_script_runner_status", "reinstall_script_runner");
	}
	return base;
}
