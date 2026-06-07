import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * Debugging tools.
 *
 * query_logs reads the syslog table — the destination for gs.log/info/warn/
 * error/print. This is the single most useful thing when debugging scripts,
 * business rules, flows, or integrations: run something, then read what it
 * logged.
 *
 * Note: syslog's timestamp column is `created_on` (NOT `sys_created_on`) —
 * syslog is a standalone high-volume table with its own audit columns.
 */
export function registerDebugTools(server: McpServer, env: Env) {
	server.tool(
		"query_logs",
		"Read recent entries from the system log (syslog) — the output of gs.log/info/warn/error/print. " +
			"Use this to debug scripts, business rules, flows, and integrations after running them. " +
			"Filter by level, source, free-text, and time window.",
		{
			level: z
				.enum(["error", "warn", "info", "debug", "all"])
				.optional()
				.default("all")
				.describe("Minimum severity to return. 'error' returns only errors, etc."),
			source: z
				.string()
				.optional()
				.describe("Filter by log source (the second arg to gs.log), e.g. 'MyScriptInclude'."),
			contains: z
				.string()
				.optional()
				.describe("Free-text fragment to match in the message body."),
			since_minutes: z
				.number()
				.int()
				.min(1)
				.max(10080)
				.optional()
				.default(60)
				.describe("Only return entries from the last N minutes. Default 60."),
			limit: z.number().int().min(1).max(500).optional().default(50),
		},
		async ({ level, source, contains, since_minutes, limit }) => {
			try {
				// syslog.level is an integer: 0=error, 1=warn, 2=info, 3=debug.
				// "Minimum severity" means level <= threshold (lower int = more severe).
				const levelMap: Record<string, number> = {
					error: 0,
					warn: 1,
					info: 2,
					debug: 3,
				};
				const conditions: string[] = [];
				if (level !== "all") {
					conditions.push(`level<=${levelMap[level]}`);
				}
				if (source) conditions.push(`source=${source}`);
				if (contains) conditions.push(`messageLIKE${contains}`);
				// Time window via relative GlideDateTime.
				conditions.push(
					`created_on>=javascript:gs.minutesAgoStart(${since_minutes})`,
				);
				const params = new URLSearchParams({
					sysparm_query: `${conditions.join("^")}^ORDERBYDESCcreated_on`,
					sysparm_fields: "created_on,level,source,message",
					sysparm_limit: String(limit),
				});
				const data = await snFetch(
					env,
					`/api/now/table/syslog?${params.toString()}`,
				);
				const levelNames = ["error", "warn", "info", "debug"];
				const logs = (data?.result ?? []).map((l: any) => ({
					time: l.created_on,
					level: levelNames[Number(l.level)] ?? l.level,
					source: l.source,
					message: l.message,
				}));
				return ok({ count: logs.length, window_minutes: since_minutes, logs });
			} catch (e) {
				return fail(e);
			}
		},
	);
}
