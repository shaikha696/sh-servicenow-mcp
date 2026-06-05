import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * Schema discovery: reads sys_dictionary to enumerate columns on a table.
 * Optionally walks the inheritance chain via sys_db_object.super_class so
 * fields inherited from parents (task → incident) are included.
 */
export function registerSchemaTools(server: McpServer, env: Env) {
	server.tool(
		"get_table_schema",
		"Return column metadata for a table from sys_dictionary. Useful when an agent needs to discover available fields before constructing a query or create body.",
		{
			table: z.string(),
			include_inherited: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"If true (default), also include columns inherited from parent tables (e.g. task → incident).",
				),
		},
		async ({ table, include_inherited }) => {
			try {
				const tablesToQuery: string[] = [table];
				if (include_inherited) {
					let current = table;
					for (let i = 0; i < 10; i++) {
						const parentResp = await snFetch(
							env,
							`/api/now/table/sys_db_object?sysparm_query=name=${encodeURIComponent(current)}&sysparm_fields=super_class.name&sysparm_limit=1`,
						);
						const parent =
							parentResp?.result?.[0]?.["super_class.name"];
						if (!parent || parent === current) break;
						tablesToQuery.push(parent);
						current = parent;
					}
				}
				const query = tablesToQuery.map((t) => `name=${t}`).join("^OR");
				const params = new URLSearchParams({
					sysparm_query: `${query}^active=true`,
					sysparm_fields:
						"element,column_label,internal_type,mandatory,max_length,reference,default_value,name",
					sysparm_limit: "2000",
				});
				const data = await snFetch(
					env,
					`/api/now/table/sys_dictionary?${params.toString()}`,
				);
				return ok({
					table,
					inheritance_chain: tablesToQuery,
					columns: data?.result || [],
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}
