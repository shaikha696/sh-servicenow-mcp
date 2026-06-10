# ServiceNow MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that connects any MCP client — Claude, Cursor, or anything that speaks MCP — to a ServiceNow instance. Develop, create data, explore the data model, and debug, all through natural language. Runs on Cloudflare Workers, supports multiple users each bringing their own instance.

```
"Find the table that stores AI agent execution logs."
"Generate 15 demo incidents about network outages."
"What are the valid values for incident.state?"
"Show me the errors logged in the last 30 minutes."
"Create a business rule on incident that sets priority to 1 when category is 'security'."
```

---

## How it works

```
   MCP Client (Claude Desktop / Claude.ai / Cursor)
        │  Authorization: Bearer <token>
        │  X-ServiceNow-Instance / Username / Password / Script-Execution
        ▼
   Cloudflare Worker  ──►  validates token  ──►  resolves credentials
        │                                              │
        ▼                                              ▼
   Durable Object (per session)  ──── Basic Auth ────► ServiceNow REST API
```

- **One Worker, many users.** Each client passes its own ServiceNow instance + credentials as request headers. The Worker itself holds no instance-specific secrets (beyond an optional default).
- **Two independent auth layers:**
  - `MCP_AUTH_TOKEN` — a shared bearer token that gates access to the Worker.
  - `X-ServiceNow-*` headers — per-client ServiceNow instance and credentials.
- **Credentials never persist.** They're resolved per-request and passed to the session's Durable Object as props; nothing instance-specific is stored long-term.

---

## Tools

**Explore the data model** (stop guessing table/field names)
| Tool | Purpose |
|---|---|
| `search_tables` | Find tables by name/label (queries `sys_db_object`) |
| `search_fields` | Find fields across tables, or what references a table (`sys_dictionary`) |
| `get_table_schema` | All fields on a table, including inherited ones |
| `get_choices` | Valid values for a choice field before you write data |

**Create & manage data**
| Tool | Purpose |
|---|---|
| `create_record` | Create one record in any table |
| `batch_create_records` | Create many records in one call (bulk demo data) |
| `update_record` / `delete_record` | Modify or remove by `sys_id` |
| `update_incident` | Update an incident by number or `sys_id` |
| `add_work_note` | Add a work note or customer comment to any task record |

**Query & analyze**
| Tool | Purpose |
|---|---|
| `query_table` | Read records with filtering, sorting, pagination |
| `get_record` | Fetch one record by `sys_id` |
| `aggregate_table` | Counts, sums, averages, group-by |
| `get_user` | Look up a user by username/email |
| `search_knowledge` | Search published KB articles |

**Debug**
| Tool | Purpose |
|---|---|
| `query_logs` | Read recent `syslog` (gs.log/info/warn/error) by level, source, text, time window |

**Update sets**
| Tool | Purpose |
|---|---|
| `set_current_update_set` / `get_current_update_set` | Scope config changes into an update set |

**Develop (opt-in — requires script execution enabled)**
| Tool | Purpose |
|---|---|
| `execute_script` | Run server-side JavaScript synchronously (GlideRecord, GlideAggregate, Script Includes, etc.) |
| `check_script_runner_status` / `reinstall_script_runner` | Manage the script-runner endpoint |

---

## Setup

### 1. Clone & install
```bash
git clone https://github.com/ciphervinci/rk-servicenow-mcp
cd rk-servicenow-mcp
npm install
```

### 2. Set the auth token as a secret
```bash
# Generate a strong token
openssl rand -hex 32

# Store it as an encrypted secret (NOT a plaintext var)
npx wrangler secret put MCP_AUTH_TOKEN
```

> **Why a secret, not a var:** Git-based deploys overwrite dashboard vars with whatever is in `wrangler.jsonc`. Secrets are never touched by deploys. If you put the token in `vars`, a redeploy will wipe it and leave your Worker open.

### 3. (Optional) Set a default instance
For single-user mode, set default ServiceNow credentials so clients don't need to send headers:
```bash
npx wrangler secret put SERVICENOW_USERNAME
npx wrangler secret put SERVICENOW_PASSWORD
# Set SERVICENOW_INSTANCE_URL in wrangler.jsonc vars (or as a secret)
```
For multi-user mode, leave these empty — each client supplies their own via headers.

### 4. Deploy
```bash
npm run deploy
```

If deploying via the Cloudflare Git integration instead, set under **Settings → Build**:
| Field | Value |
|---|---|
| Build command | `bun add ai@5.0.78` |
| Deploy command | `npx wrangler deploy` |

(The build command works around an esbuild resolution issue with a dynamic import inside the `agents` package.)

### 5. Verify
```bash
curl https://rk-servicenow-mcp.<account>.workers.dev/health
```
Returns status, whether auth is enabled, and the tool list. `/health` requires no auth.

---

## Connecting clients

### Authentication
Every endpoint except `/health` requires:
```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

### Per-client ServiceNow credentials (headers)
| Header | Description |
|---|---|
| `X-ServiceNow-Instance` | `https://devXXXXX.service-now.com` (no trailing slash) |
| `X-ServiceNow-Username` | Service-account username |
| `X-ServiceNow-Password` | Service-account password |
| `X-ServiceNow-Script-Execution` | `true` to enable `execute_script` for this session |

Omit any header to fall back to the Worker's env-var default for that value.

### Claude Desktop (via `mcp-remote`)
Settings → Developer → Edit Config:
```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://rk-servicenow-mcp.<account>.workers.dev/sse",
        "--header", "Authorization:Bearer <your-token>",
        "--header", "X-ServiceNow-Instance:https://devXXXXX.service-now.com",
        "--header", "X-ServiceNow-Username:admin",
        "--header", "X-ServiceNow-Password:yourpassword",
        "--header", "X-ServiceNow-Script-Execution:true"
      ]
    }
  }
}
```
Restart Claude Desktop after editing.

### Claude.ai
Settings → Connectors → Add custom connector. Use the `/mcp` URL and add the `Authorization` and `X-ServiceNow-*` headers if the connector UI supports custom headers.

### Cursor / other clients
Use the `/mcp` URL as a remote MCP server with the same headers.

---

## Local development
Create `.dev.vars` (gitignored):
```
MCP_AUTH_TOKEN=dev-token
SERVICENOW_INSTANCE_URL=https://devXXXXX.service-now.com
SERVICENOW_USERNAME=admin
SERVICENOW_PASSWORD=yourpassword
ENABLE_SCRIPT_EXECUTION=true
```
```bash
npm run dev   # http://localhost:8787
```

---

## ServiceNow service-account roles

Create a dedicated, least-privilege user — do not reuse a personal admin login.

| Feature | Roles |
|---|---|
| Read tables | `snc_read_only` or table ACLs |
| ITSM read/write | `itil` |
| Knowledge search | `knowledge` |
| Metadata exploration & logs | read on `sys_dictionary`, `sys_db_object`, `sys_choice`, `syslog` |
| Update sets | write on `sys_user_preference` |
| `execute_script` | `admin` (installs a Scripted REST API on first call) |

---

## execute_script

On first use, the MCP installs a Scripted REST API on the instance (`sys_ws_definition` + `sys_ws_operation`). Subsequent calls hit it directly — synchronous, sub-second. Your script runs in an IIFE; use `return` to send a value back:

```javascript
var gr = new GlideRecord('incident');
gr.addEncodedQuery('sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()');
gr.query();
var n = 0;
while (gr.next()) { gr.urgency = 1; gr.update(); n++; }
return JSON.stringify({ updated: n });
```

Enabled per-session via the `X-ServiceNow-Script-Execution: true` header (or the env default).

---

## Project structure
```
src/
├── index.ts        # Worker: auth check, credential resolution, routing
├── mcp-agent.ts    # Durable Object agent; receives credentials via props
├── sn-client.ts    # snFetch, SNProps type, header extraction, helpers
├── ai-stub.js      # Build shim for the 'ai' package
└── tools/          # One file per tool group
```

Adding a tool group: create `src/tools/x.ts` exporting `registerXTools(server, props)`, call it in `mcp-agent.ts`, add the name to `registeredToolNames()`. Use `snFetch`, `ok()`, `fail()` from `sn-client.ts`.

---

## Endpoints
| Path | Purpose |
|---|---|
| `/mcp` | Streamable HTTP transport (modern clients) |
| `/sse` | SSE transport (`mcp-remote`, Claude Desktop) |
| `/health` | Status + tool list (no auth) |

---

## Security notes
- **Always set `MCP_AUTH_TOKEN`.** An empty token disables auth and exposes every tool — including `execute_script` — to anyone with the URL.
- Store the token and passwords as **secrets**, never as `vars` (deploys overwrite vars).
- The service account's ServiceNow roles define the blast radius. Use least privilege.
- For higher assurance, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) in front of the Worker.

---

Built by [Rishikesh](https://github.com/ciphervinci) · [Medium](https://medium.com/@rkesh0504)
