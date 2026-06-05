import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, buildReadParams, fail, ok, snFetch } from "../sn-client";

/**
 * Generic Table API tools. These cover every table in the instance —
 * incident, change_request, sc_request, cmdb_ci, kb_knowledge, sys_user,
 * sys_user_group, custom u_* tables, etc.
 *
 * Ordering note: ServiceNow's Table API does NOT have a sysparm_order_by
 * parameter. Order is expressed inside sysparm_query, e.g.
 *     active=true^priority=1^ORDERBYDESCsys_created_on
 */
export function registerTableTools(server: McpServer, env: Env) {
	server.tool(
		"query_table",
		"Query records from any ServiceNow table via the Table API. " +
			"Use encoded queries (sysparm_query) for filtering and ORDERBY/ORDERBYDESC for sorting.",
		{
			table: z
				.string()
				.describe(
					"Table name (e.g. 'incident', 'change_request', 'cmdb_ci', 'kb_knowledge', 'sys_user', 'u_custom').",
				),
			sysparm_query: z
				.string()
				.optional()
				.describe(
					"Encoded query, e.g. 'active=true^priority=1^ORDERBYDESCsys_created_on'. " +
						"Build in the Filter Navigator UI then 'Copy query' for complex filters.",
				),
			sysparm_fields: z
				.string()
				.optional()
				.describe("Comma-separated field list to return."),
			sysparm_limit: z
				.number()
				.int()
				.min(1)
				.max(10000)
				.optional()
				.default(50),
			sysparm_offset: z.number().int().min(0).optional(),
			sysparm_display_value: z
				.enum(["true", "false", "all"])
				.optional()
				.describe(
					"'true' returns display values, 'false' returns sys_ids (default), 'all' returns both.",
				),
			sysparm_exclude_reference_link: z.boolean().optional(),
		},
		async (args) => {
			try {
				const { table, ...read } = args;
				const params = buildReadParams(read);
				const data = await snFetch(
					env,
					`/api/now/table/${encodeURIComponent(table)}?${params.toString()}`,
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"get_record",
		"Fetch a single record by sys_id from any table.",
		{
			table: z.string(),
			sys_id: z.string().describe("32-character sys_id of the record."),
			sysparm_fields: z.string().optional(),
			sysparm_display_value: z.enum(["true", "false", "all"]).optional(),
			sysparm_exclude_reference_link: z.boolean().optional(),
		},
		async ({ table, sys_id, ...read }) => {
			try {
				const params = buildReadParams(read);
				const qs = params.toString();
				const data = await snFetch(
					env,
					`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}${qs ? `?${qs}` : ""}`,
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"create_record",
		"Create a new record in any table. Pass field values as an object.",
		{
			table: z.string(),
			fields: z
				.record(z.any())
				.describe(
					"Field => value object. Reference fields take sys_ids by default, " +
						"or display values when sysparm_input_display_value is true.",
				),
			sysparm_input_display_value: z
				.boolean()
				.optional()
				.describe(
					"If true, reference fields accept display values (e.g. assignment_group='Database').",
				),
		},
		async ({ table, fields, sysparm_input_display_value }) => {
			try {
				const qs = sysparm_input_display_value
					? "?sysparm_input_display_value=true"
					: "";
				const data = await snFetch(
					env,
					`/api/now/table/${encodeURIComponent(table)}${qs}`,
					{ method: "POST", body: JSON.stringify(fields) },
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"update_record",
		"Update a record by sys_id using PATCH (partial update).",
		{
			table: z.string(),
			sys_id: z.string(),
			fields: z.record(z.any()),
			sysparm_input_display_value: z.boolean().optional(),
		},
		async ({ table, sys_id, fields, sysparm_input_display_value }) => {
			try {
				const qs = sysparm_input_display_value
					? "?sysparm_input_display_value=true"
					: "";
				const data = await snFetch(
					env,
					`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}${qs}`,
					{ method: "PATCH", body: JSON.stringify(fields) },
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"delete_record",
		"Delete a record by sys_id. Permanent if the table doesn't have soft-delete configured.",
		{
			table: z.string(),
			sys_id: z.string(),
		},
		async ({ table, sys_id }) => {
			try {
				await snFetch(
					env,
					`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}`,
					{ method: "DELETE" },
				);
				return ok(`Deleted ${table}/${sys_id}`);
			} catch (e) {
				return fail(e);
			}
		},
	);
}
