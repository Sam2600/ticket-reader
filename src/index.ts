#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { RedmineClient } from './redmine.js';
import { registerGetIssue } from './tools/getIssue.js';
import { registerDownloadAttachment } from './tools/downloadAttachment.js';

// stdout is the MCP transport; all diagnostics go to stderr.
const log = (msg: string) => console.error(`[redmine-mcp] ${msg}`);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log(err.message);
      process.exit(1);
    }
    throw err;
  }

  const client = new RedmineClient(config.url, config.credential);
  const server = new McpServer({ name: 'redmine-readonly', version: '0.1.0' });

  registerGetIssue(server, client);
  registerDownloadAttachment(server, client, config);

  await server.connect(new StdioServerTransport());
  log(`connected; Redmine at ${config.url}, attachments in ${config.attachmentDir}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
