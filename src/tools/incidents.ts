import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * Convenience wrappers around the Table API for the most common ITSM flows.
 * Anything these do is achievable via the generic create_record/update_record
 * tools — these exist to give the LLM clearer affordances for common tasks
 * and to handle "find by number" (INC0010001 → sys_id) transparently.
 */
export function registerIncidentTools(server: McpServer, env: Env) {
	server.tool(
		"update_incident",
		"Update an incident by number (INC0010001) or sys_id. Common fields: state, close_code, close_notes, work_notes, comments, assignment_group, assigned_to.",
		{
			identifier: z
				.string()
				.describe("Incident number (e.g. INC0010001) OR sys_id."),
			fields: z.record(z.any()),
			use_display_values: z.boolean().optional().default(false),
		},
		async ({ identifier, fields, use_display_values }) => {
			try {
				let sysId = identifier;
				if (/^INC/i.test(identifier)) {
					const search = await snFetch(
						env,
						`/api/now/table/incident?sysparm_query=number=${encodeURIComponent(identifier)}&sysparm_fields=sys_id&sysparm_limit=1`,
					);
					const found = search?.result?.[0]?.sys_id;
					if (!found)
						throw new Error(`Incident ${identifier} not found.`);
					sysId = found;
				}
				const qs = use_display_values
					? "?sysparm_input_display_value=true"
					: "";
				const data = await snFetch(
					env,
					`/api/now/table/incident/${encodeURIComponent(sysId)}${qs}`,
					{ method: "PATCH", body: JSON.stringify(fields) },
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"add_work_note",
		"Add a work note (internal) or comment (customer-visible) to any task-derived record. Resolves number → sys_id automatically.",
		{
			table: z
				.string()
				.optional()
				.default("incident")
				.describe("Task table: incident, change_request, problem, sc_task, etc."),
			identifier: z
				.string()
				.describe("Record number (e.g. INC0010001) OR sys_id."),
			note: z.string(),
			as: z
				.enum(["work_notes", "comments"])
				.optional()
				.default("work_notes")
				.describe("'work_notes' (internal, default) or 'comments' (customer-visible)."),
		},
		async ({ table, identifier, note, as }) => {
			try {
				let sysId = identifier;
				const looksLikeSysId =
					identifier.length === 32 && /^[a-f0-9]+$/i.test(identifier);
				if (!looksLikeSysId) {
					const search = await snFetch(
						env,
						`/api/now/table/${encodeURIComponent(table)}?sysparm_query=number=${encodeURIComponent(identifier)}&sysparm_fields=sys_id&sysparm_limit=1`,
					);
					const found = search?.result?.[0]?.sys_id;
					if (!found)
						throw new Error(`${table} ${identifier} not found.`);
					sysId = found;
				}
				const data = await snFetch(
					env,
					`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
					{ method: "PATCH", body: JSON.stringify({ [as]: note }) },
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);
}
