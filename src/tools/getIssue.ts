import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { RedmineClient } from '../redmine.js';
import { fetchIssue } from '../issues.js';
import { formatIssueMarkdown } from '../format.js';
import { errorResult } from './shared.js';

const inputSchema = z.object({
  id: z.number().int().positive().describe('Redmine issue (ticket) number, e.g. 1234'),
  include_journals: z
    .boolean()
    .default(true)
    .describe('Include the comment/change history (journals). Default true.'),
  format: z
    .enum(['markdown', 'json'])
    .default('markdown')
    .describe('markdown = readable summary (default); json = raw Redmine JSON for exact field values.'),
});

export function registerGetIssue(server: McpServer, client: RedmineClient): void {
  server.registerTool(
    'get_issue',
    {
      title: 'Get Redmine issue',
      description:
        'Fetch a single Redmine issue by its number: subject, status, priority, assignee, custom fields, description, ' +
        'the list of attachments (with IDs for download_attachment), relations, subtasks and the journal history. Read-only.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, include_journals, format }): Promise<CallToolResult> => {
      try {
        const issue = await fetchIssue(client, id, { includeJournals: include_journals });
        const text =
          format === 'json'
            ? JSON.stringify(issue, null, 2)
            : formatIssueMarkdown(issue, { includeJournals: include_journals });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return errorResult(err, `issue #${id}`);
      }
    },
  );
}
