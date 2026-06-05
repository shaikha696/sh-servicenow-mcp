import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * Aggregate API — /api/now/stats/{table}
 * Supports COUNT, SUM, AVG, MIN, MAX, GROUP BY, HAVING.
 */
export function registerAggregateTools(server: McpServer, env: Env) {
	server.tool(
		"aggregate_table",
		"Run aggregations over a ServiceNow table: COUNT, SUM, AVG, MIN, MAX, GROUP BY, HAVING.",
		{
			table: z.string(),
			sysparm_query: z.string().optional(),
			sysparm_count: z
				.boolean()
				.optional()
				.default(true)
				.describe("Return COUNT(*) when true."),
			sysparm_sum_fields: z.string().optional(),
			sysparm_avg_fields: z.string().optional(),
			sysparm_min_fields: z.string().optional(),
			sysparm_max_fields: z.string().optional(),
			sysparm_group_by: z
				.string()
				.optional()
				.describe("Comma-separated fields to group by."),
			sysparm_having: z.string().optional(),
			sysparm_display_value: z.enum(["true", "false", "all"]).optional(),
		},
		async (args) => {
			try {
				const { table, ...rest } = args;
				const params = new URLSearchParams();
				for (const [k, v] of Object.entries(rest)) {
					if (v === undefined || v === null) continue;
					params.append(k, String(v));
				}
				const data = await snFetch(
					env,
					`/api/now/stats/${encodeURIComponent(table)}?${params.toString()}`,
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);
}
