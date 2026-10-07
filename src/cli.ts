#!/usr/bin/env node
/**
 * Command-line front end for manual checks. Uses exactly the same config,
 * client, fetch and formatting code as the MCP server, so what you see here
 * is what Claude Code sees through the tools.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig, type Config } from './config.js';
import { RedmineClient, RedmineError } from './redmine.js';
import { fetchIssue } from './issues.js';
import { describeDownload, downloadAttachment, isTextLike, saveAttachment } from './attachments.js';
import { formatBytes, formatIssueMarkdown } from './format.js';

const USAGE = `Usage: ticket <command> [options]

Commands:
  check                        Verify the Redmine URL and credentials (GET /users/current.json)
  issue <id> [--json] [--no-journals] [--download]
                               Print an issue the way the MCP get_issue tool returns it
  attachment <id> --issue <n>  Download one attachment the way download_attachment does

Options:
  --json                       Raw Redmine JSON instead of Markdown (issue only)
  --no-journals                Omit the comment/change history (issue only)
  --download                   Also download every attachment of the issue (issue only)
  --issue <n>                  Issue the attachment belongs to; files go to <attachmentDir>\\<n>\\
                               (attachment only; without it the file goes to <attachmentDir>\\unsorted\\)
  -h, --help                   Show this help

Config: ${DEFAULT_CONFIG_PATH} (override with REDMINE_MCP_CONFIG)
`;

interface CurrentUser {
  id: number;
  login: string;
  firstname?: string;
  lastname?: string;
  admin?: boolean;
}

function parseId(raw: string | undefined, what: string): number {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new UsageError(`Expected a positive ${what} number, got "${raw ?? ''}"`);
  }
  return id;
}

class UsageError extends Error {}

/** Write to stdout and resolve once flushed, so piping to `more`/files never truncates. */
function print(text: string): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write(text, (err) => (err ? reject(err) : resolve())));
}

async function runCheck(config: Config, client: RedmineClient): Promise<void> {
  const { user } = await client.getJson<{ user: CurrentUser }>('/users/current.json');
  const name = [user.firstname, user.lastname].filter(Boolean).join(' ') || user.login;
  await print(
    `OK: ${config.url} accepted the credentials.\n` +
      `Authenticated as ${name} (login: ${user.login}${user.admin ? ', admin' : ''}).\n` +
      `Attachments will be saved under ${config.attachmentDir}\n`,
  );
}

interface IssueOptions {
  json: boolean;
  includeJournals: boolean;
  download: boolean;
}

async function runIssue(config: Config, client: RedmineClient, id: number, opts: IssueOptions): Promise<void> {
  const issue = await fetchIssue(client, id, { includeJournals: opts.includeJournals });
  await print(
    opts.json
      ? JSON.stringify(issue, null, 2) + '\n'
      : formatIssueMarkdown(issue, { includeJournals: opts.includeJournals }),
  );
  if (!opts.download) return;

  const attachments = issue.attachments ?? [];
  if (attachments.length === 0) {
    await print(`\nNo attachments on issue #${id}.\n`);
    return;
  }
  await print(`\nDownloading ${attachments.length} attachment(s) to ${path.join(config.attachmentDir, String(id))}:\n`);
  let failures = 0;
  for (const a of attachments) {
    try {
      const { dest, size } = await saveAttachment(client, config, a, id);
      await print(`  #${a.id}  ${a.filename}  (${formatBytes(size)})  ->  ${dest}\n`);
    } catch (err) {
      failures++;
      const reason = err instanceof RedmineError ? err.message : String(err);
      await print(`  #${a.id}  ${a.filename}  SKIPPED: ${reason}\n`);
    }
  }
  if (failures) throw new PartialFailure(`${failures} of ${attachments.length} attachment(s) could not be downloaded`);
}

/** Some attachments failed; the issue itself was fetched fine. Exit code 1 without re-printing usage. */
class PartialFailure extends Error {}

async function runAttachment(config: Config, client: RedmineClient, id: number, issueId?: number): Promise<void> {
  const result = await downloadAttachment(client, config, id, issueId);
  const lines = describeDownload(result);
  if (isTextLike(result.attachment) && result.size <= config.inlineTextMaxBytes) {
    const text = (await readFile(result.dest, 'utf8')).replace(/^﻿/, '');
    lines.push('', `--- contents of ${result.attachment.filename} ---`, text.trimEnd(), '--- end ---');
  }
  await print(lines.join('\n') + '\n');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'no-journals': { type: 'boolean', default: false },
      download: { type: 'boolean', default: false },
      issue: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;

  if (values.help || !command) {
    await print(USAGE);
    return command ? 0 : 1;
  }
  if (!['check', 'issue', 'attachment'].includes(command)) {
    throw new UsageError(`Unknown command "${command}"`);
  }

  const config = loadConfig();
  const client = new RedmineClient(config.url, config.credential);

  switch (command) {
    case 'check':
      await runCheck(config, client);
      break;
    case 'issue':
      await runIssue(config, client, parseId(arg, 'issue'), {
        json: values.json,
        includeJournals: !values['no-journals'],
        download: values.download,
      });
      break;
    case 'attachment':
      await runAttachment(
        config,
        client,
        parseId(arg, 'attachment'),
        values.issue === undefined ? undefined : parseId(values.issue, 'issue'),
      );
      break;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
    } else if (err instanceof ConfigError || err instanceof RedmineError || err instanceof PartialFailure) {
      console.error(`Error: ${err.message}`);
    } else if (err instanceof Error && err.message.startsWith('Unknown option')) {
      console.error(`${err.message}\n\n${USAGE}`); // parseArgs rejects unknown flags
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  },
);
