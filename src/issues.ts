import type { RedmineClient } from './redmine.js';
import type { Issue } from './format.js';

export interface FetchIssueOptions {
  includeJournals: boolean;
}

/** GET one issue with everything the renderer knows how to show. Shared by the MCP tool and the CLI. */
export async function fetchIssue(client: RedmineClient, id: number, opts: FetchIssueOptions): Promise<Issue> {
  const include = ['attachments', 'relations', 'children', ...(opts.includeJournals ? ['journals'] : [])].join(',');
  const { issue } = await client.getJson<{ issue: Issue }>(`/issues/${id}.json`, { include });
  return issue;
}
