# ServiceNow MCP Server (Cloudflare Workers)

A remote MCP server that lets any MCP client (Claude Desktop, Claude.ai connectors, Cloudflare AI Playground, Cursor, etc.) drive a ServiceNow instance via the REST API. Optionally exposes server-side script execution for full instance access.

Deployed on Cloudflare Workers. Auth between client and Worker is delegated to Cloudflare (e.g., Cloudflare Access); auth between Worker and ServiceNow uses Basic auth credentials stored as Worker secrets.

## Tools

Thirteen tools when script execution is disabled, sixteen when enabled.

| Tool | Purpose |
|---|---|
| `query_table` | GET records from any table with `sysparm_query`, fields, pagination, display values |
| `get_record` | Fetch a single record by `sys_id` |
| `create_record` | POST to any table |
| `update_record` | PATCH a record by `sys_id` |
| `delete_record` | DELETE a record by `sys_id` |
| `update_incident` | Resolves `INC#####` to `sys_id` then PATCHes |
| `add_work_note` | Adds work_notes or comments on any task-derived record |
| `get_user` | Look up `sys_user` by `user_name` or `email` |
| `get_table_schema` | Read `sys_dictionary` for a table, walking the inheritance chain |
| `aggregate_table` | Aggregate API: count/sum/avg/min/max/group_by |
| `search_knowledge` | KB search via the `kb_knowledge` table |
| `set_current_update_set` | Scope the MCP service account to an update set so subsequent config changes are captured |
| `get_current_update_set` | Show which update set the service account is currently scoped to |
| `execute_script` | **Opt-in.** Run server-side JavaScript synchronously via an auto-installed Scripted REST API. See below. |
| `check_script_runner_status` | **Opt-in.** Inspect whether `execute_script`'s Scripted REST API is installed on the instance. |
| `reinstall_script_runner` | **Opt-in.** Tear down and reinstall the Scripted REST API used by `execute_script`. |

## Repository layout

```
src/
├── index.ts              # Worker entry: routes /mcp, /sse, /health
├── mcp-agent.ts          # ServiceNowMCP class; init() registers tool groups
├── sn-client.ts          # snFetch, ok/fail helpers, types, GlideDateTime utils
└── tools/
    ├── table.ts          # query/get/create/update/delete on any table
    ├── incidents.ts      # create_incident, update_incident, add_work_note
    ├── users.ts          # get_user
    ├── schema.ts         # get_table_schema (walks inheritance via sys_db_object)
    ├── aggregate.ts      # aggregate_table
    ├── knowledge.ts      # search_knowledge
    ├── update_sets.ts    # set_current_update_set, get_current_update_set
    └── scripts.ts        # execute_script (gated by ENABLE_SCRIPT_EXECUTION)
```

Adding a new tool group = create a file under `src/tools/` exporting a `register*(server, env)` function, then import and call it in `src/mcp-agent.ts`.

## Setup

```bash
git clone <this repo>
cd rk-servicenow-mcp
npm install

# 1. Edit wrangler.jsonc — set vars.SERVICENOW_INSTANCE_URL
#    (e.g. https://devXXXXX.service-now.com, no trailing slash)

# 2. Set the ServiceNow service-account credentials as secrets
npx wrangler secret put SERVICENOW_USERNAME
npx wrangler secret put SERVICENOW_PASSWORD

# 3. (Optional) Enable script execution. See "execute_script" section below
#    before doing this on anything other than a dev instance.
# In wrangler.jsonc, set vars.ENABLE_SCRIPT_EXECUTION = "true"

# 4. Deploy
npm run deploy
```

You'll get a URL like `https://rk-servicenow-mcp.<your-account>.workers.dev`.

Endpoints:
- `/mcp` — Streamable HTTP transport (modern MCP clients)
- `/sse` and `/sse/message` — Server-Sent Events transport (for `mcp-remote`)
- `/health` — Returns instance URL, enabled tools, and script-execution flag

## ServiceNow side: minimum permissions

Create a dedicated service-account user. Roles depend on what you'll use:

| Tool group | Roles needed |
|---|---|
| Read any table | `snc_read_only` or table-specific read ACLs |
| Read/write ITSM tables (incident, change, problem, sc_task) | `itil` |
| Knowledge search | `knowledge` |
| `get_table_schema` | Read on `sys_dictionary` and `sys_db_object` (granted by `personalize_dictionary` or `admin`) |
| `execute_script` | `admin` or `web_service_admin` (required to create the bootstrap `sys_ws_definition` and `sys_ws_operation` records on first call). The handler script itself runs in global scope on the instance. |

Add table-level ACLs for custom `u_*` tables. **Do not give this user `admin` unless you've accepted the risk** — and especially not if you're enabling `execute_script` without Cloudflare Access in front of the Worker.

## execute_script — full instance access

Set `ENABLE_SCRIPT_EXECUTION="true"` in `wrangler.jsonc` to register the tool. With that flag unset (or anything other than `"true"`), the tool isn't even visible to MCP clients.

**How it works:**

On the first `execute_script` call against an instance, the MCP installs a single Scripted REST API:

- `sys_ws_definition` named "MCP Script Runner" (`service_id = mcp_script_runner`)
- `sys_ws_operation` named "exec" — `POST /exec` — whose `operation_script` runs `eval()` on the script you send

Subsequent calls hit that endpoint directly via `POST /api/<namespace>/mcp_script_runner/exec` with a JSON body `{script: "..."}`. The script is wrapped in an IIFE so you can use `return`. Response is synchronous, typically sub-second.

```json
{
  "script": "var gr = new GlideRecord('incident'); gr.addQuery('active', true); gr.addQuery('priority', 1); gr.setLimit(5); gr.query(); var out = []; while (gr.next()) out.push({number: gr.getValue('number'), short_desc: gr.getValue('short_description')}); return JSON.stringify(out);"
}
```

Response shape:
```json
{ "result": { "status": "success", "result": "<your returned value>" } }
```
or on script error:
```json
{ "result": { "status": "error", "message": "...", "stack": "..." } }
```

**Why this replaces the previous `sys_trigger` approach:** `sys_trigger` defers execution to the ServiceNow scheduler, which sweeps in batches. Latency is unbounded under load. Scripted REST runs synchronously in the inbound request thread.

**Diagnostic tools:**
- `check_script_runner_status` — confirms the Scripted REST API is installed and shows the endpoint URL.
- `reinstall_script_runner` — deletes and recreates the API. Use if you've edited the bootstrap handler in `src/tools/scripts.ts` and want it pushed out.

**Caveats:**
- **No log capture.** Calls to `gs.log/info/print` inside your script go to `syslog` as normal but aren't returned by `execute_script`. If you want output, `return JSON.stringify(yourValue)`. If you really need the syslog stream, query the `syslog` table separately via `query_table`.
- **`eval` in global scope.** The handler uses native `eval()` in global scope, so GlideRecord, gs.*, etc. are all available. If you ever set the API definition to a non-global scope, things will get weird — keep it global.
- **The `ENABLE_SCRIPT_EXECUTION` flag is a soft gate.** It protects you from forgetting which deployment is which, not from attackers. The real security boundaries are (a) Cloudflare Access in front of the Worker and (b) the service account's roles.
- **First call is slower than subsequent calls.** Bootstrap creates 2 records on the instance the first time per instance. Roughly 1–2 seconds. After that, every call is one round-trip.

## Example workflows

These are the actual tool sequences for common developer asks. Useful for understanding what the LLM should call.

**Generate 10 incidents.** Ten sequential `create_record` calls with `table='incident'` and your `short_description` / `category` / `priority` fields.

**Bulk update — "set urgency=1 on all incidents created today."** Prefer one `execute_script` call over N+1 sequential calls:
```js
var gr = new GlideRecord('incident');
gr.addEncodedQuery('sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()');
gr.query();
var count = 0;
while (gr.next()) { gr.urgency = 1; gr.update(); count++; }
return JSON.stringify({updated: count});
```

**Counting with a filter — "how many `cmdb_ci` have `u_ot_device_details` populated?"** `aggregate_table` with `table='cmdb_ci', sysparm_query='u_ot_device_detailsISNOTEMPTY', sysparm_count=true`. If you're not sure of the field name, run `get_table_schema` on `cmdb_ci` first.

**Update Set workflow — "create an update set and capture all my changes into it."**
1. `create_record` on table `sys_update_set` with `{name: "MCP demo changes", description: "..."}`. The response includes the new `sys_id`.
2. `set_current_update_set` with that `sys_id`. From here on, any config changes (Business Rules, ACLs, Script Includes, etc.) made via the MCP land in that update set.
3. When done: `update_record` on `sys_update_set/<sys_id>` with `{state: "complete"}` to mark it ready for export.

**Bulk delete — "delete all incidents created today."** `execute_script` with:
```js
var gr = new GlideRecord('incident');
gr.addEncodedQuery('sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()');
gr.query();
var count = gr.getRowCount();
gr.deleteMultiple();
return JSON.stringify({deleted: count});
```

**Discovery — "find the table holding AI Agent execution logs."** `query_table` on `sys_db_object`:
```
sysparm_query: nameLIKEaia^ORnameLIKEagent_log^ORlabelLIKEagent execution
sysparm_fields: name,label,super_class.name
```

**Schema reasoning — "which table is the M2M between user and group?"** `query_table` on `sys_dictionary`:
```
sysparm_query: reference=sys_user^ORreference=sys_user_group^active=true
sysparm_fields: name,element,reference
```
Group results by `name`; the table appearing with both `reference=sys_user` and `reference=sys_user_group` is the M2M. The well-known answer is `sys_user_grmember`.

## Connecting clients

### Claude.ai / Claude Code

Add as a custom remote MCP server: `https://rk-servicenow-mcp.<account>.workers.dev/mcp`.

### Claude Desktop (via `mcp-remote`)

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://rk-servicenow-mcp.<your-account>.workers.dev/sse"
      ]
    }
  }
}
```

Restart Claude Desktop.

### Cloudflare AI Playground

https://playground.ai.cloudflare.com → paste `https://rk-servicenow-mcp.<account>.workers.dev/sse`.

## Local dev

```bash
# Create a .dev.vars file (gitignored) for local secrets
cat > .dev.vars <<'EOF'
SERVICENOW_USERNAME=svc_mcp
SERVICENOW_PASSWORD=hunter2
ENABLE_SCRIPT_EXECUTION=true
EOF

npm run dev   # wrangler dev on http://localhost:8787
```

Then point your client at `http://localhost:8787/mcp` (or `/sse` for the bridge).

## Operational notes

- **Rate limits.** ServiceNow's default inbound REST limit is ~1000 calls/hr per user. A loopy agent will burn through that. Add a [Cloudflare Workers rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/rate-limit/) if this becomes a problem.
- **Multi-instance.** This deployment is single-instance by design. For multi-tenant routing, you'd need to either (a) deploy one Worker per instance, (b) accept instance URL + creds as request headers and drop env-based config, or (c) wrap with an OAuth flow that returns per-user tokens. None of these are built in.
- **Update Sets.** If you want script-execution-driven changes captured in an Update Set, set the current update set in your script via `gs.setCurrentApplication()` + `GlideUpdateManager2` before making config changes. Out of scope for this MCP.

## Extending

Drop a new file in `src/tools/`, export a `register*(server, env)` function with `server.tool(...)` calls, and import/call it from `src/mcp-agent.ts`. Use `snFetch` from `sn-client.ts` so you don't re-implement auth and error handling.

Likely additions:
- Attachment upload/download (`/api/now/attachment`)
- Service Catalog ordering (`/api/sn_sc/servicecatalog/items/{sys_id}/order_now`)
- Update Set switching (`/api/now/ui/update_set/current`)
- Scripted REST API hand-off for synchronous `execute_script`
