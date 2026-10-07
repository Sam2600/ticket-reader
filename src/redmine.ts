import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { Credential } from './config.js';

/**
 * Minimal Redmine REST client.
 *
 * This is the read-only boundary of the whole server: it only knows how to
 * issue HTTP GET. There is deliberately no generic `request(method, ...)`
 * helper, so no tool can be written that mutates Redmine.
 */

const JSON_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_CHARS = 500;

export class RedmineError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RedmineError';
  }
}

export class DownloadTooLargeError extends RedmineError {
  constructor(limit: number) {
    super(`Attachment exceeds the configured size limit of ${limit} bytes. Partial download discarded.`);
    this.name = 'DownloadTooLargeError';
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export class RedmineClient {
  readonly #baseUrl: string;
  readonly #origin: string;
  /** The single auth header sent with every request. The secret lives only here. */
  readonly #authHeader: Record<string, string>;

  constructor(baseUrl: string, credential: Credential) {
    this.#baseUrl = baseUrl;
    this.#origin = new URL(baseUrl).origin;
    this.#authHeader =
      credential.kind === 'apiKey'
        ? { 'X-Redmine-API-Key': credential.apiKey }
        : { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}` };
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.#authHeader, ...extra };
  }

  #url(path: string, query?: Query): string {
    const url = new URL(this.#baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async #get(url: string, accept: string, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: this.#headers({ Accept: accept }),
        redirect: 'manual', // never follow a redirect off-origin carrying the key
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RedmineError(`Could not reach Redmine at ${this.#origin}: ${describeFetchError(err)}`);
    }
    if (res.ok) return res;

    if (res.status >= 300 && res.status < 400) {
      throw new RedmineError(
        `Redmine responded with a redirect (${res.status}); check that the configured URL is the final Redmine address`,
        res.status,
      );
    }
    throw new RedmineError(await describeHttpError(res), res.status);
  }

  /** GET a JSON resource, e.g. `/issues/123.json`. */
  async getJson<T>(path: string, query?: Query): Promise<T> {
    const res = await this.#get(this.#url(path, query), 'application/json', JSON_TIMEOUT_MS);
    try {
      return (await res.json()) as T;
    } catch {
      throw new RedmineError('Redmine returned a non-JSON response; is the REST API enabled?', res.status);
    }
  }

  /**
   * GET a binary resource and stream it to `destPath`. The URL must be on the
   * same origin as the configured Redmine instance so the key is never sent
   * elsewhere. Aborts (and removes the partial file) if the body exceeds
   * `maxBytes`. Resolves with the number of bytes written.
   */
  async downloadToFile(contentUrl: string, destPath: string, maxBytes: number): Promise<number> {
    let target: URL;
    try {
      target = new URL(contentUrl);
    } catch {
      throw new RedmineError('Attachment URL returned by Redmine is not a valid URL');
    }
    if (target.origin !== this.#origin) {
      throw new RedmineError(`Refusing to download from ${target.origin}: not the configured Redmine origin`);
    }

    const res = await this.#get(target.toString(), '*/*', DOWNLOAD_TIMEOUT_MS);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      throw new DownloadTooLargeError(maxBytes);
    }
    if (!res.body) throw new RedmineError('Redmine returned an empty response body for the attachment');

    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > maxBytes) cb(new DownloadTooLargeError(maxBytes));
        else cb(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), limiter, createWriteStream(destPath));
    } catch (err) {
      await rm(destPath, { force: true }).catch(() => undefined);
      if (err instanceof RedmineError) throw err;
      throw new RedmineError(`Download failed: ${describeFetchError(err)}`);
    }
    return written;
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'request timed out';
    // undici wraps the real reason in `cause`
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

async function describeHttpError(res: Response): Promise<string> {
  switch (res.status) {
    case 401:
      return (
        'Redmine rejected the credentials (HTTP 401). Check the apiKey or username/password in the config file. ' +
        'Note: accounts with two-factor authentication enabled must use an API key, not a password.'
      );
    case 403:
      return (
        'Forbidden (HTTP 403): either your Redmine account lacks permission to view this resource, ' +
        'or the REST API is disabled in Redmine (Administration > Settings > API > "Enable REST web service").'
      );
    case 404:
      return 'Not found (HTTP 404).';
    default: {
      let detail = '';
      try {
        const text = (await res.text()).replace(/\s+/g, ' ').trim();
        if (text) detail = `: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`;
      } catch {
        /* body unreadable; status alone is enough */
      }
      return `Redmine returned HTTP ${res.status}${detail}`;
    }
  }
}
