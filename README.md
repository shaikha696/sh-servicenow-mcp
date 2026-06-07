# ServiceNow MCP Server

Connect any AI client — Claude, Cursor, or any MCP-compatible tool — directly to a ServiceNow instance. Build, create data, explore the data model, and debug, all through natural language. Runs on Cloudflare Workers.

```
"Find the table that stores AI agent execution logs."
"Generate 15 demo incidents about network outages."
"What are the valid values for incident.state?"
"Show me the errors logged in the last 30 minutes."
"Create a business rule on the incident table that sets priority to 1 when category is 'security'."
```

---

## Quick start

```bash
git clone https://github.com/ciphervinci/rk-servicenow-mcp
cd rk-servicenow-mcp
npm install

# Set your instance URL in wrangler.jsonc → vars.SERVICENOW_INSTANCE_URL

# Store credentials as encrypted secrets (never commit these)
npx wrangler secret put SERVICENOW_USERNAME
npx wrangler secret put SERVICENOW_PASSWORD

npm run deploy
```

Then connect your client to `https://rk-servicenow-mcp.<your-account>.workers.dev/mcp` and start talking to your instance.

Check it's live: `curl https://rk-servicenow-mcp.<your-account>.workers.dev/health`

---

## What you can do

### 🔍 Explore the data model
Stop guessing table and field names. These query ServiceNow's metadata directly.

| Tool | Use it for |
|---|---|
| `search_tables` | "Which table holds X?" — finds tables by name or label via `sys_db_object`. |
| `search_fields` | "Which table has field X?" / "What references sys_user?" — searches `sys_dictionary`. |
| `get_table_schema` | List every field on a known table, including fields inherited from parent tables. |
| `get_choices` | Valid values for a choice field (e.g. all `incident.state` options) before you write data. |

### 📝 Create and manage data

| Tool | Use it for |
|---|---|
| `create_record` | Create one record in any table. |
| `batch_create_records` | Create many records in one call — bulk demo data, test sets. |
| `update_record` | Update any record by `sys_id`. |
| `delete_record` | Delete a record by `sys_id`. |
| `update_incident` | Update an incident by number (`INC0010001`) or `sys_id`. |
| `add_work_note` | Add a work note or customer comment to any task record. |

### 📊 Query and analyze

| Tool | Use it for |
|---|---|
| `query_table` | Read records from any table with filtering, sorting, pagination. |
| `get_record` | Fetch one record by `sys_id`. |
| `aggregate_table` | Counts, sums, averages, group-by — without pulling every row. |
| `get_user` | Look up a user by username or email. |
| `search_knowledge` | Search published KB articles. |

### 🐛 Debug

| Tool | Use it for |
|---|---|
| `query_logs` | Read recent `syslog` entries (gs.log/info/warn/error output). Filter by level, source, text, and time window. The fastest way to see why a script failed. |

### ⚙️ Develop (advanced — opt-in)

Set `ENABLE_SCRIPT_EXECUTION="true"` to enable these. Requires admin on the instance.

| Tool | Use it for |
|---|---|
| `execute_script` | Run server-side JavaScript synchronously (GlideRecord, GlideAggregate, Script Includes, anything). |
| `check_script_runner_status` | See if the script-runner endpoint is installed and where. |
| `reinstall_script_runner` | Rebuild the script-runner endpoint. |

### 🗂️ Update sets

| Tool | Use it for |
|---|---|
| `set_current_update_set` | Scope your config changes into a chosen update set. |
| `get_current_update_set` | Check which update set is currently active. |

---

## Detailed setup

### 1. Instance URL

Edit `wrangler.jsonc`:

```jsonc
"vars": {
    "SERVICENOW_INSTANCE_URL": "https://devXXXXX.service-now.com",
    "ENABLE_SCRIPT_EXECUTION": "false"
}
```

No trailing slash. Set `ENABLE_SCRIPT_EXECUTION` to `"true"` only if you want background script execution.

### 2. Credentials (as secrets, not vars)

```bash
npx wrangler secret put SERVICENOW_USERNAME
npx wrangler secret put SERVICENOW_PASSWORD
```

> ⚠️ **Never put credentials in `wrangler.jsonc`.** It's committed to git. Secrets are encrypted and live only in Cloudflare.

### 3. ServiceNow service account roles

Create a dedicated user (don't reuse a personal admin login). Grant only what you need:

| What you'll do | Roles |
|---|---|
| Read tables | `snc_read_only` or table ACLs |
| ITSM (incident/change/problem) | `itil` |
| Knowledge search | `knowledge` |
| Explore metadata, read logs | `admin` or read on `sys_dictionary`, `sys_db_object`, `sys_choice`, `syslog` |
| Update sets | write on `sys_user_preference` |
| `execute_script` | `admin` |

### 4. Deploy

```bash
npm run deploy
```

### 5. Deploying via Cloudflare Git integration

If you deploy by connecting the GitHub repo (instead of `npm run deploy`), set this in **Settings → Build**:

| Field | Value |
|---|---|
| Build command | `bun add ai@5.0.78` |
| Deploy command | `npx wrangler deploy` |

The build command works around a bundling issue where esbuild can't resolve a dynamic `import("ai")` inside the `agents` package. Installing `ai` explicitly fixes it.

---

## Connect your client

### Claude.ai
Settings → Connectors → Add custom connector → paste:
```
https://rk-servicenow-mcp.<your-account>.workers.dev/mcp
```

### Claude Desktop
Settings → Developer → Edit Config, add:
```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["mcp-remote", "https://rk-servicenow-mcp.<your-account>.workers.dev/sse"]
    }
  }
}
```
Restart Claude Desktop.

### Cursor / other MCP clients
Use the `/mcp` URL as a remote MCP server.

---

## execute_script (how it works)

On the first call, the MCP installs a small Scripted REST API on your instance (`sys_ws_definition` + `sys_ws_operation`). Every call after that is a single synchronous POST — sub-second, no scheduler delay.

Your script runs inside an IIFE, so use `return` to send a value back:

```javascript
var gr = new GlideRecord('incident');
gr.addQuery('priority', 1);
gr.addQuery('active', true);
gr.setLimit(5);
gr.query();
var out = [];
while (gr.next()) {
    out.push({ number: gr.getValue('number'), short_desc: gr.getValue('short_description') });
}
return JSON.stringify(out);
```

For bulk operations, this beats many individual tool calls:

```javascript
// Close all incidents created today
var gr = new GlideRecord('incident');
gr.addEncodedQuery('sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()');
gr.query();
var n = 0;
while (gr.next()) { gr.state = 7; gr.update(); n++; }
return JSON.stringify({ closed: n });
```

---

## Local development

Create `.dev.vars` (gitignored):
```
SERVICENOW_INSTANCE_URL=https://devXXXXX.service-now.com
SERVICENOW_USERNAME=your_service_account
SERVICENOW_PASSWORD=your_password
ENABLE_SCRIPT_EXECUTION=true
```
Run `npm run dev` → server on `http://localhost:8787`.

---

## Project structure

```
src/
├── index.ts              # Worker routing (/mcp, /sse, /health)
├── mcp-agent.ts          # Agent class, tool registration
├── sn-client.ts          # Shared HTTP client, helpers, types
├── ai-stub.js            # Build shim for the 'ai' package
└── tools/
    ├── table.ts          # query, get, create, update, delete, batch_create
    ├── incidents.ts      # update_incident, add_work_note
    ├── users.ts          # get_user
    ├── schema.ts         # get_table_schema
    ├── explore.ts        # search_tables, search_fields, get_choices
    ├── aggregate.ts      # aggregate_table
    ├── knowledge.ts      # search_knowledge
    ├── update_sets.ts    # set/get_current_update_set
    ├── debug.ts          # query_logs
    └── scripts.ts        # execute_script + diagnostics (opt-in)
```

**Adding a tool:** create `src/tools/your_tool.ts` exporting `registerYourTools(server, env)`, call it in `mcp-agent.ts`, and add the name to `registeredToolNames()`. Use `snFetch`, `ok()`, and `fail()` from `sn-client.ts` for HTTP and error handling.

---

## Endpoints

| Path | Purpose |
|---|---|
| `/mcp` | Streamable HTTP transport (modern clients) |
| `/sse` | SSE transport (for `mcp-remote`) |
| `/health` | Status, instance URL, enabled tools |

---

## Security

- The Worker is public by default — anyone with the URL can call any tool. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) in front of it for anything beyond a personal dev instance.
- The service account's roles define the blast radius. Use a dedicated, least-privilege user.
- `execute_script` is full server-side code execution. Keep it disabled (`ENABLE_SCRIPT_EXECUTION=false`) unless you need it, and never expose it on a production instance without Access in front.

---

Built by [Rishikesh](https://github.com/ciphervinci) · [Medium](https://medium.com/@rkesh0504)
