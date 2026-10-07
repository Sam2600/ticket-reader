import { readFile } from 'node:fs/promises';
import type { McpServer, CallToolResult, ContentBlock } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Config } from '../config.js';
import type { RedmineClient } from '../redmine.js';
import { describeDownload, detectImageMime, downloadAttachment, isTextLike } from '../attachments.js';
import { formatBytes } from '../format.js';
import { errorResult } from './shared.js';

const inputSchema = z.object({
  attachment_id: z
    .number()
    .int()
    .positive()
    .describe('Attachment ID as listed in the Attachments table of get_issue (not the issue number).'),
  issue_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The issue the attachment belongs to (the number you passed to get_issue). Always pass it when known: ' +
        'files are then saved under <attachmentDir>/<issue_id>/ and the ID is verified against the issue. ' +
        'Without it the file is saved under <attachmentDir>/unsorted/.',
    ),
});

export function registerDownloadAttachment(server: McpServer, client: RedmineClient, config: Config): void {
  server.registerTool(
    'download_attachment',
    {
      title: 'Download Redmine attachment',
      description:
        `Download an attachment from Redmine by its attachment ID into ${config.attachmentDir}/<issue_id>/ and return the saved path. ` +
        'Small images are also returned inline so they can be viewed directly; small text files are returned inline as text. ' +
        `Refuses files larger than ${formatBytes(config.maxAttachmentBytes)}. Read-only with respect to Redmine.`,
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ attachment_id, issue_id }): Promise<CallToolResult> => {
      try {
        const result = await downloadAttachment(client, config, attachment_id, issue_id);
        const { attachment, dest, size } = result;
        const lines = describeDownload(result);
        const content: ContentBlock[] = [];

        const imageMime = detectImageMime(attachment);
        if (imageMime && size <= config.inlineImageMaxBytes) {
          content.push({ type: 'image', data: (await readFile(dest)).toString('base64'), mimeType: imageMime });
        } else if (isTextLike(attachment) && size <= config.inlineTextMaxBytes) {
          const text = (await readFile(dest, 'utf8')).replace(/^﻿/, '');
          lines.push('', `Contents of ${attachment.filename}:`, '```', text.trimEnd(), '```');
        } else {
          lines.push('', 'Read the file from the saved path to inspect its contents.');
        }
        content.unshift({ type: 'text', text: lines.join('\n') });
        return { content };
      } catch (err) {
        return errorResult(err, `attachment #${attachment_id}`);
      }
    },
  );
}
