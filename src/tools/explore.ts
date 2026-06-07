import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * Exploration tools for discovering the data model of an instance.
 *
 * These exist because LLMs otherwise guess table/field names and probe them
 * one at a time ("is there an `incident_log` table? no… `incident_history`?
 * no…"). That's slow and unreliable. search_tables and search_fields query
 * the metadata tables (sys_db_object, sys_dictionary) directly so the model
 * finds the real name in one call.
 */
export function registerExploreTools(server: McpServer, env: Env) {
	server.tool(
		"search_tables",
		"Find tables by name or label. ALWAYS use this when the user refers to a table by description, " +
			"partial name, or purpose (e.g. 'the table with AI agent logs', 'the incident table', " +
			"'where users are stored'). Do NOT guess a table name and probe it with query_table — " +
			"search here first to get the exact table name, then query that. Searches sys_db_object.",
		{
			keyword: z
				.string()
				.describe(
					"Word or fragment to match against table name and label (e.g. 'incident', 'agent', 'cmdb', 'vulnerability').",
				),
			limit: z.number().int().min(1).max(200).optional().default(50),
		},
		async ({ keyword, limit }) => {
			try {
				const q = `nameLIKE${keyword}^ORlabelLIKE${keyword}`;
				const params = new URLSearchParams({
					sysparm_query: `${q}^ORDERBYname`,
					sysparm_fields: "name,label,super_class.name,sys_scope.scope",
					sysparm_limit: String(limit),
				});
				const data = await snFetch(
					env,
					`/api/now/table/sys_db_object?${params.toString()}`,
				);
				const tables = (data?.result ?? []).map((t: any) => ({
					name: t.name,
					label: t.label,
					extends: t["super_class.name"] || null,
					scope: t["sys_scope.scope"] || "global",
				}));
				return ok({ count: tables.length, tables });
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"search_fields",
		"Find fields (columns) across tables by name, label, or reference target. " +
			"Use when the user asks 'which table has field X', 'what fields reference sys_user', " +
			"or 'find the field that stores Y'. Searches sys_dictionary. " +
			"To list ALL fields of one known table, use get_table_schema instead.",
		{
			element: z
				.string()
				.optional()
				.describe("Field (column) name fragment, e.g. 'assigned_to', 'cost', 'ot_device'."),
			label: z
				.string()
				.optional()
				.describe("Field label fragment, e.g. 'Assigned to', 'Serial number'."),
			reference: z
				.string()
				.optional()
				.describe(
					"Find fields that reference this table, e.g. 'sys_user' to find every field pointing at users.",
				),
			table: z
				.string()
				.optional()
				.describe("Restrict the search to a single table's fields."),
			limit: z.number().int().min(1).max(500).optional().default(100),
		},
		async ({ element, label, reference, table, limit }) => {
			try {
				const conditions: string[] = ["active=true"];
				if (element) conditions.push(`elementLIKE${element}`);
				if (label) conditions.push(`column_labelLIKE${label}`);
				if (reference) conditions.push(`reference=${reference}`);
				if (table) conditions.push(`name=${table}`);
				if (conditions.length === 1) {
					throw new Error(
						"Provide at least one of: element, label, reference, table.",
					);
				}
				const params = new URLSearchParams({
					sysparm_query: `${conditions.join("^")}^ORDERBYname`,
					sysparm_fields:
						"name,element,column_label,internal_type,reference.name,max_length,mandatory",
					sysparm_display_value: "true",
					sysparm_limit: String(limit),
				});
				const data = await snFetch(
					env,
					`/api/now/table/sys_dictionary?${params.toString()}`,
				);
				const fields = (data?.result ?? []).map((f: any) => ({
					table: f.name,
					field: f.element,
					label: f.column_label,
					type: f.internal_type,
					references: f["reference.name"] || null,
					mandatory: f.mandatory === "true",
				}));
				return ok({ count: fields.length, fields });
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"get_choices",
		"Get the valid choice values for a choice field on a table (e.g. the allowed values for " +
			"incident.state, incident.category, change_request.risk). Use this before creating or " +
			"updating records so you set valid values. Reads sys_choice.",
		{
			table: z.string().describe("Table name, e.g. 'incident'."),
			field: z
				.string()
				.describe("Field (element) name, e.g. 'state', 'category', 'priority'."),
			include_inactive: z.boolean().optional().default(false),
		},
		async ({ table, field, include_inactive }) => {
			try {
				const conditions = [`name=${table}`, `element=${field}`];
				if (!include_inactive) conditions.push("inactive=false");
				const params = new URLSearchParams({
					sysparm_query: `${conditions.join("^")}^ORDERBYsequence`,
					sysparm_fields: "value,label,sequence,inactive",
					sysparm_limit: "500",
				});
				const data = await snFetch(
					env,
					`/api/now/table/sys_choice?${params.toString()}`,
				);
				const choices = (data?.result ?? []).map((c: any) => ({
					value: c.value,
					label: c.label,
				}));
				return ok({ table, field, count: choices.length, choices });
			} catch (e) {
				return fail(e);
			}
		},
	);
}
