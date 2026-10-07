import type { CallToolResult } from '@modelcontextprotocol/server';
import { RedmineError } from '../redmine.js';

/** Turn an exception into an MCP error result. Only RedmineError messages are surfaced verbatim. */
export function errorResult(err: unknown, what: string): CallToolResult {
  let message: string;
  if (err instanceof RedmineError) {
    message = err.status === 404 ? `${what} was not found (HTTP 404).` : err.message;
  } else {
    // Unexpected failure: log the stack to stderr (never stdout — that is the MCP channel).
    console.error(`[redmine-mcp] unexpected error while fetching ${what}:`, err);
    message = `Unexpected error while fetching ${what}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}
