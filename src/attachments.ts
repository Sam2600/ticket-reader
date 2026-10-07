import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { RedmineError, type RedmineClient } from './redmine.js';
import { formatBytes, type Attachment } from './format.js';
import { fetchIssue } from './issues.js';

/**
 * Attachment download shared by the MCP tool and the CLI: metadata lookup,
 * size gate, filename sanitising, download into the configured directory.
 *
 * Layout: `<attachmentDir>/<issueId>/<attachmentId>_<filename>` so files stay
 * grouped by ticket. Redmine's /attachments/{id} endpoint does not reveal the
 * owning issue, so callers pass it; without it files land in `unsorted/`.
 */

export const UNSORTED_DIR = 'unsorted';

export interface DownloadResult {
  attachment: Attachment;
  /** Issue the file was filed under, if known. */
  issueId?: number;
  /** Absolute path of the saved file. */
  dest: string;
  /** Bytes actually written. */
  size: number;
}

/** Thrown before any bytes are transferred when Redmine's metadata already exceeds the limit. */
export class AttachmentTooLargeError extends RedmineError {
  constructor(attachment: Attachment, limit: number) {
    super(
      `${attachment.filename} is ${formatBytes(attachment.filesize)}, above the configured limit of ${formatBytes(limit)}. Not downloaded.`,
    );
    this.name = 'AttachmentTooLargeError';
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Characters Windows forbids in filenames, plus ASCII control characters.
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Reduce an attachment filename to a safe basename for the local filesystem. */
export function sanitizeFilename(filename: string, fallback: string): string {
  let name = path.basename(filename.replace(/\\/g, '/'));
  name = name.replace(UNSAFE_FILENAME_CHARS, '_').replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') return fallback;
  if (WINDOWS_RESERVED.test(path.parse(name).name)) name = `_${name}`;
  return name;
}

const INLINE_IMAGE_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
const INLINE_IMAGE_MIMES = new Set(INLINE_IMAGE_TYPES.values());

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.md', '.markdown', '.patch', '.diff', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml',
  '.ini', '.cfg', '.conf', '.toml', '.sql', '.html', '.htm', '.css', '.js', '.ts', '.py', '.rb', '.php',
  '.java', '.cs', '.go', '.rs', '.sh', '.ps1', '.bat',
]);

/** MIME type to use if this attachment should be shown inline as an image, else undefined. */
export function detectImageMime(attachment: Attachment): string | undefined {
  const ct = attachment.content_type?.split(';')[0].trim().toLowerCase();
  if (ct && INLINE_IMAGE_MIMES.has(ct)) return ct;
  return INLINE_IMAGE_TYPES.get(path.extname(attachment.filename).toLowerCase());
}

/** True when the attachment is plain text we can print inline. */
export function isTextLike(attachment: Attachment): boolean {
  const ct = attachment.content_type?.split(';')[0].trim().toLowerCase() ?? '';
  if (ct.startsWith('text/')) return true;
  if (ct === 'application/json' || ct === 'application/xml') return true;
  return TEXT_EXTENSIONS.has(path.extname(attachment.filename).toLowerCase());
}

/** Where a file for this attachment goes on disk. */
export function attachmentDestination(config: Config, attachment: Attachment, issueId?: number): string {
  const dir = path.join(config.attachmentDir, issueId === undefined ? UNSORTED_DIR : String(issueId));
  const safeName = sanitizeFilename(attachment.filename, `attachment-${attachment.id}`);
  return path.join(dir, `${attachment.id}_${safeName}`);
}

/**
 * Download an attachment whose metadata is already known (e.g. from an issue
 * fetched with include=attachments). No extra metadata request is made.
 */
export async function saveAttachment(
  client: RedmineClient,
  config: Config,
  attachment: Attachment,
  issueId?: number,
): Promise<DownloadResult> {
  if (attachment.filesize > config.maxAttachmentBytes) {
    throw new AttachmentTooLargeError(attachment, config.maxAttachmentBytes);
  }
  const dest = attachmentDestination(config, attachment, issueId);
  await mkdir(path.dirname(dest), { recursive: true });
  await client.downloadToFile(attachment.content_url, dest, config.maxAttachmentBytes);
  const size = (await stat(dest)).size;
  return { attachment, issueId, dest, size };
}

/**
 * Download an attachment by ID. With `issueId` the attachment is looked up on
 * that issue (which also verifies it belongs there) and filed under the issue;
 * without it, Redmine's attachment endpoint is used and the file goes to `unsorted/`.
 */
export async function downloadAttachment(
  client: RedmineClient,
  config: Config,
  attachmentId: number,
  issueId?: number,
): Promise<DownloadResult> {
  if (issueId !== undefined) {
    let issue;
    try {
      issue = await fetchIssue(client, issueId, { includeJournals: false });
    } catch (err) {
      if (err instanceof RedmineError && err.status === 404) {
        throw new RedmineError(`Issue #${issueId} was not found (HTTP 404); check the issue id.`);
      }
      throw err;
    }
    const attachment = (issue.attachments ?? []).find((a) => a.id === attachmentId);
    if (!attachment) {
      throw new RedmineError(
        `Attachment #${attachmentId} is not on issue #${issueId}. ` +
          `Check the ID in the issue's Attachments table (or omit the issue to download it unsorted).`,
      );
    }
    return saveAttachment(client, config, attachment, issueId);
  }
  const { attachment } = await client.getJson<{ attachment: Attachment }>(`/attachments/${attachmentId}.json`);
  return saveAttachment(client, config, attachment);
}

/** Human-readable summary lines for a completed download. */
export function describeDownload({ attachment, issueId, dest, size }: DownloadResult): string[] {
  const lines = [
    `Saved attachment #${attachment.id}${issueId !== undefined ? ` of issue #${issueId}` : ' (issue unknown, filed under unsorted)'} to: ${dest}`,
    `Filename: ${attachment.filename}`,
    `Size: ${formatBytes(size)} (${size} bytes)`,
    `Type: ${attachment.content_type ?? 'unknown'}`,
  ];
  if (attachment.description) lines.push(`Description: ${attachment.description}`);
  if (attachment.author?.name) {
    lines.push(`Uploaded by: ${attachment.author.name}${attachment.created_on ? ` on ${attachment.created_on}` : ''}`);
  }
  return lines;
}
