# redmine-readonly-mcp

A small, **read-only** [MCP](https://modelcontextprotocol.io) server that lets Claude Code read Redmine tickets
without ever seeing your Redmine credentials.

Claude calls `get_issue(1234)` / `download_attachment(567)`; this server holds the API key and talks to Redmine.
The key is never included in prompts, transcripts or tool output, and the server only ever issues HTTP `GET` —
there are no create/update/delete tools, so a full-permission key cannot be used to change anything.

## Tools

| Tool | What it does |
|---|---|
| `get_issue` | Fetch one issue by number: subject, status, priority, assignee, custom fields, description, relations, subtasks, attachment list (with IDs) and journal history. `format: "json"` returns the raw Redmine JSON. |
| `download_attachment` | Download an attachment by its ID into the configured folder and return the path. Small images are also returned inline (Claude can look at screenshots directly); small text files are returned inline as text. |

Both tools are annotated `readOnlyHint: true`.

## Setup

Requires **Node 20+** and a Redmine instance with the REST API enabled
(*Administration → Settings → API → Enable REST web service*).

### 1. Check the REST API is enabled, and pick a credential

Open `<redmine-url>/issues.json` in your browser:

- **JSON, or a username/password popup** → REST API is enabled. Good.
- **A blank "403 Forbidden" page** → the REST API is disabled. Ask a Redmine admin to tick
  *Administration → Settings → API → Enable REST web service*. Nothing below works until then.

Then choose one of:

- **API key** (preferred): `<redmine-url>/my/account` → **API access key** → *Show*.
- **Username + password**: your normal Redmine login, sent as HTTP Basic auth. Works with LDAP accounts too.
  Accounts with two-factor authentication enabled **must** use the API key instead.

### 2. Create the config file (outside any project)

`%USERPROFILE%\.redmine-mcp\config.json` — with an API key:

```json
{
  "url": "https://redmine.example.com",
  "apiKey": "your-api-key-here",
  "maxAttachmentBytes": 26214400
}
```

or with your login:

```json
{
  "url": "https://redmine.example.com",
  "username": "your-login",
  "password": "your-password",
  "maxAttachmentBytes": 26214400
}
```

Only `url` plus one credential are required (an `apiKey` wins if both are given).
Defaults: attachments go to `~/redmine-attachments/<attachment-id>/`
(override with `attachmentDir` — keep it **outside** `~/.redmine-mcp` so the deny rules below don't stop Claude
reading what it downloaded), downloads over 25 MB are refused, images ≤ 4 MB and text files ≤ 256 KB are also
returned inline (`inlineImageMaxBytes`, `inlineTextMaxBytes`).

Environment variables `REDMINE_URL`, `REDMINE_API_KEY`, `REDMINE_USERNAME`, `REDMINE_PASSWORD`,
`REDMINE_ATTACHMENT_DIR` override the file, and `REDMINE_MCP_CONFIG` points at a different config file.

Lock the file down to your account:

```powershell
icacls "$env:USERPROFILE\.redmine-mcp\config.json" /inheritance:r /grant:r "$env:USERNAME:F"
```

### 3. Build

```powershell
npm install
npm run build
```

### 4. Try it yourself first (no AI involved)

`ticket.cmd` in the project root runs the **same code path** as the MCP tools, so you can verify what Claude
would see before giving it access:

```powershell
.\ticket check            # confirms URL + credentials: prints who you are authenticated as
.\ticket issue 1234       # the Markdown Claude gets from get_issue
.\ticket issue 1234 --json --no-journals
.\ticket issue 1234 --download        # print the issue, then download all of its attachments
.\ticket attachment 567 --issue 1234  # download one file like download_attachment, prints the saved path
```

Downloads are filed per ticket: `~\redmine-attachments\<issue>\<attachmentId>_<filename>` (the ID prefix keeps
three `screenshot.png`s apart). Redmine's attachment endpoint doesn't say which issue a file belongs to, so pass
`--issue` (the MCP tool has the same `issue_id` parameter); without it the file goes to `~\redmine-attachments\unsorted\`.

`ticket.cmd` picks the Node 24 binary from nvm automatically; on another machine with a modern default `node` it just
uses that. Errors (wrong password, REST API disabled, unreachable host) print the same messages the MCP tool
would return, with exit code 1.

### 5. Register with Claude Code

```powershell
claude mcp add --scope user redmine -- node "C:\path\to\Ticket Checker\dist\index.js"
```

If your default `node` is older than 20, point at a specific binary instead, e.g.
`"$env:APPDATA\nvm\v24.21.0\node.exe"`.

Restart Claude Code and run `/mcp` — `redmine` should be connected with two tools. Then just ask:
*"Fetch Redmine issue #1234 and summarise it"*, *"Download the screenshot attached to it"*.

### 6. Defense in depth (recommended)

Claude Code runs shell commands as you, so a process running under your account can technically read the
config file. Add deny rules to `~/.claude/settings.json` to block the obvious paths:

```json
{
  "permissions": {
    "deny": ["Read(~/.redmine-mcp/**)", "Bash(*redmine-mcp*)"]
  }
}
```

This is not airtight — if you need the key to be genuinely unreachable, run this server inside a container or
under a separate Windows account and expose it over HTTP instead of stdio.

## How the read-only guarantee works

- Only two tools are exposed, both reads. Claude can't call a write tool that doesn't exist.
- `src/redmine.ts` is the only place that talks to Redmine and it only implements `GET`. There is no generic
  `request(method, …)` helper to misuse, so even a bug in a tool cannot write.
- Attachment downloads are only allowed from the configured Redmine origin, so the key is never sent elsewhere.
- Redirects are not followed.
- The credential is read in `src/config.ts`, handed to the client, and never logged or returned. Without it,
  nothing Claude does outside this server (`curl`, PowerShell, WebFetch) can authenticate to Redmine.

Paths that bypass this server, and how to close them:

- **Browser automation extensions** (e.g. Claude in Chrome) drive *your* logged-in browser session and could edit a
  ticket through the web UI. Do not grant such extensions access to your Redmine domain.
- **Direct HTTP from the shell** has no credential and so cannot write, but you can block it outright by adding
  `Bash(*your-redmine-host*)`, `PowerShell(*your-redmine-host*)` and `WebFetch(domain:your-redmine-host)` to the
  deny list in `~/.claude/settings.json`.

## Development

```powershell
npm run build
npm run inspect   # opens the MCP Inspector against dist/index.js
```

Diagnostics go to stderr; stdout is the MCP channel.
