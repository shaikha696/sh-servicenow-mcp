import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

export function registerUserTools(server: McpServer, env: Env) {
	server.tool(
		"get_user",
		"Look up a sys_user by user_name or email. Returns sys_id, name, email, active, title, department, manager by default.",
		{
			user_name: z.string().optional(),
			email: z.string().optional(),
			sysparm_fields: z
				.string()
				.optional()
				.default(
					"sys_id,user_name,name,email,active,title,department,manager",
				),
		},
		async ({ user_name, email, sysparm_fields }) => {
			try {
				if (!user_name && !email)
					throw new Error("Provide either user_name or email.");
				const parts: string[] = [];
				if (user_name) parts.push(`user_name=${user_name}`);
				if (email) parts.push(`email=${email}`);
				const params = new URLSearchParams({
					sysparm_query: parts.join("^"),
					sysparm_limit: "1",
					sysparm_fields,
				});
				const data = await snFetch(
					env,
					`/api/now/table/sys_user?${params.toString()}`,
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);
}
