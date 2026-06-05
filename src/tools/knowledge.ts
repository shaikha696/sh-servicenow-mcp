import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * KB search via direct table query (kb_knowledge). Portable on every instance
 * regardless of whether the Knowledge API plugin is active.
 */
export function registerKnowledgeTools(server: McpServer, env: Env) {
	server.tool(
		"search_knowledge",
		"Search published KB articles by free-text against title, short_description, and text.",
		{
			query: z.string().describe("Free-text keyword."),
			kb_knowledge_base: z
				.string()
				.optional()
				.describe("Restrict to a specific KB sys_id."),
			limit: z.number().int().min(1).max(100).optional().default(10),
		},
		async ({ query, kb_knowledge_base, limit }) => {
			try {
				const conditions = [
					"workflow_state=published",
					"active=true",
					`short_descriptionLIKE${query}^ORtextLIKE${query}^ORtitleLIKE${query}`,
				];
				if (kb_knowledge_base)
					conditions.push(`kb_knowledge_base=${kb_knowledge_base}`);
				const params = new URLSearchParams({
					sysparm_query: conditions.join("^"),
					sysparm_limit: String(limit),
					sysparm_fields:
						"sys_id,number,short_description,kb_knowledge_base,workflow_state,sys_view_count,sys_updated_on",
				});
				const data = await snFetch(
					env,
					`/api/now/table/kb_knowledge?${params.toString()}`,
				);
				return ok(data);
			} catch (e) {
				return fail(e);
			}
		},
	);
}
