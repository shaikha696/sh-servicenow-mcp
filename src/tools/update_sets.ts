import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Env, fail, ok, snFetch } from "../sn-client";

/**
 * Update Set helpers.
 *
 * Note: creating an update set is just `create_record` on `sys_update_set`, so
 * no dedicated tool is needed for that. What IS needed is `set_current_update_set`,
 * because making an update set "current" so subsequent config changes are
 * captured into it requires updating sys_user_preference for the service
 * account user — that's a multi-step lookup that's awkward to do from the LLM
 * side.
 *
 * How update sets actually work: ServiceNow tracks the current update set on a
 * PER-USER basis via the `sys_update_set` user preference. When that user
 * modifies any table backed by Update Set tracking (Business Rules, Script
 * Includes, ACLs, etc.), those changes get captured into whatever update set
 * is current for THAT user at THAT moment.
 *
 * For this MCP, "that user" is the service account. So set_current_update_set
 * updates the service account's preference, and from that point forward every
 * config change the MCP makes is captured into the chosen update set.
 */
export function registerUpdateSetTools(server: McpServer, env: Env) {
	server.tool(
		"set_current_update_set",
		"Make an update set the 'current' one for the MCP's service account. " +
			"After this, every config change made through the MCP (Business Rules, ACLs, " +
			"Script Includes, dictionary changes, etc.) is captured into this update set " +
			"until the preference is changed again. " +
			"Use create_record on 'sys_update_set' to create a new set first, then pass its sys_id here.",
		{
			update_set_sys_id: z
				.string()
				.describe("sys_id of the sys_update_set record to make current."),
		},
		async ({ update_set_sys_id }) => {
			try {
				// 1. Resolve the service account's user sys_id.
				const userResp = await snFetch(
					env,
					`/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(env.SERVICENOW_USERNAME)}&sysparm_fields=sys_id&sysparm_limit=1`,
				);
				const userSysId: string | undefined =
					userResp?.result?.[0]?.sys_id;
				if (!userSysId) {
					throw new Error(
						`Could not find sys_user record for user_name='${env.SERVICENOW_USERNAME}'.`,
					);
				}

				// 2. Verify the update set exists.
				const usResp = await snFetch(
					env,
					`/api/now/table/sys_update_set/${encodeURIComponent(update_set_sys_id)}?sysparm_fields=sys_id,name,state`,
				);
				if (!usResp?.result?.sys_id) {
					throw new Error(
						`Update set ${update_set_sys_id} not found.`,
					);
				}

				// 3. Look for an existing 'sys_update_set' preference for this user.
				const prefResp = await snFetch(
					env,
					`/api/now/table/sys_user_preference?sysparm_query=user=${userSysId}^name=sys_update_set&sysparm_fields=sys_id&sysparm_limit=1`,
				);
				const existingPrefSysId: string | undefined =
					prefResp?.result?.[0]?.sys_id;

				if (existingPrefSysId) {
					await snFetch(
						env,
						`/api/now/table/sys_user_preference/${encodeURIComponent(existingPrefSysId)}`,
						{
							method: "PATCH",
							body: JSON.stringify({ value: update_set_sys_id }),
						},
					);
				} else {
					await snFetch(env, "/api/now/table/sys_user_preference", {
						method: "POST",
						body: JSON.stringify({
							user: userSysId,
							name: "sys_update_set",
							value: update_set_sys_id,
							type: "string",
						}),
					});
				}

				return ok({
					status: "ok",
					update_set: usResp.result,
					service_account: env.SERVICENOW_USERNAME,
					message: `Service account '${env.SERVICENOW_USERNAME}' is now scoped to update set '${usResp.result.name}'. All subsequent MCP-driven config changes will be captured into it.`,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.tool(
		"get_current_update_set",
		"Get the update set currently 'current' for the MCP's service account.",
		{},
		async () => {
			try {
				const userResp = await snFetch(
					env,
					`/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(env.SERVICENOW_USERNAME)}&sysparm_fields=sys_id&sysparm_limit=1`,
				);
				const userSysId = userResp?.result?.[0]?.sys_id;
				if (!userSysId) {
					throw new Error(
						`Could not find sys_user for '${env.SERVICENOW_USERNAME}'.`,
					);
				}
				const prefResp = await snFetch(
					env,
					`/api/now/table/sys_user_preference?sysparm_query=user=${userSysId}^name=sys_update_set&sysparm_fields=value&sysparm_limit=1`,
				);
				const currentSysId: string | undefined =
					prefResp?.result?.[0]?.value;
				if (!currentSysId) {
					return ok({
						status: "no_preference",
						message: `No 'sys_update_set' preference set for '${env.SERVICENOW_USERNAME}'. Changes will fall into the Default update set.`,
					});
				}
				const usResp = await snFetch(
					env,
					`/api/now/table/sys_update_set/${encodeURIComponent(currentSysId)}?sysparm_fields=sys_id,name,state,description,application`,
				);
				return ok({
					status: "ok",
					current: usResp?.result ?? { sys_id: currentSysId },
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}
