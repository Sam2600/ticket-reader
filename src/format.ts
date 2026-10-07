/**
 * Redmine issue JSON (the parts we render) and a Markdown renderer tuned for
 * an LLM reader: key facts first, then description, attachments (with the IDs
 * `download_attachment` needs), then the journal history.
 */

export interface Named {
  id: number;
  name: string;
}

export interface CustomField {
  id: number;
  name: string;
  value: string | string[] | null;
  multiple?: boolean;
}

export interface Attachment {
  id: number;
  filename: string;
  filesize: number;
  content_type?: string;
  description?: string;
  content_url: string;
  author?: Named;
  created_on?: string;
}

export interface JournalDetail {
  property: string; // "attr" | "cf" | "attachment" | "relation"
  name: string;
  old_value?: string | null;
  new_value?: string | null;
}

export interface Journal {
  id: number;
  user?: Named;
  notes?: string | null;
  created_on?: string;
  private_notes?: boolean;
  details?: JournalDetail[];
}

export interface Relation {
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type: string;
  delay?: number | null;
}

export interface Issue {
  id: number;
  subject: string;
  description?: string | null;
  project?: Named;
  tracker?: Named;
  status?: Named & { is_closed?: boolean };
  priority?: Named;
  author?: Named;
  assigned_to?: Named;
  category?: Named;
  fixed_version?: Named;
  parent?: { id: number };
  start_date?: string | null;
  due_date?: string | null;
  done_ratio?: number;
  is_private?: boolean;
  estimated_hours?: number | null;
  spent_hours?: number | null;
  created_on?: string;
  updated_on?: string;
  closed_on?: string | null;
  custom_fields?: CustomField[];
  attachments?: Attachment[];
  relations?: Relation[];
  children?: Array<{ id: number; subject?: string; tracker?: Named }>;
  journals?: Journal[];
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Escape a value for use inside a Markdown table cell. */
function cell(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function customFieldValue(cf: CustomField): string {
  if (Array.isArray(cf.value)) return cf.value.length ? cf.value.join(', ') : '—';
  return cf.value === null || cf.value === '' ? '—' : cf.value;
}

const RELATION_LABELS: Record<string, string> = {
  relates: 'relates to',
  duplicates: 'duplicates',
  duplicated: 'is duplicated by',
  blocks: 'blocks',
  blocked: 'is blocked by',
  precedes: 'precedes',
  follows: 'follows',
  copied_to: 'copied to',
  copied_from: 'copied from',
};

function describeDetail(d: JournalDetail, cfNames: Map<number, string>): string {
  const arrow = `${d.old_value ?? '—'} → ${d.new_value ?? '—'}`;
  switch (d.property) {
    case 'attr':
      return `${d.name.replace(/_id$/, '')}: ${arrow}`;
    case 'cf': {
      const name = cfNames.get(Number(d.name)) ?? `custom field #${d.name}`;
      return `${name}: ${arrow}`;
    }
    case 'attachment':
      return d.new_value ? `attachment added: ${d.new_value} (id ${d.name})` : `attachment removed: ${d.old_value ?? d.name}`;
    case 'relation':
      return `relation ${d.name}: ${arrow}`;
    default:
      return `${d.property} ${d.name}: ${arrow}`;
  }
}

export interface FormatOptions {
  includeJournals: boolean;
}

export function formatIssueMarkdown(issue: Issue, opts: FormatOptions): string {
  const out: string[] = [];
  out.push(`# #${issue.id} ${issue.subject}`, '');

  const rows: Array<[string, unknown]> = [
    ['Project', issue.project?.name],
    ['Tracker', issue.tracker?.name],
    ['Status', issue.status ? `${issue.status.name}${issue.status.is_closed ? ' (closed)' : ''}` : undefined],
    ['Priority', issue.priority?.name],
    ['Author', issue.author?.name],
    ['Assignee', issue.assigned_to?.name],
    ['Category', issue.category?.name],
    ['Target version', issue.fixed_version?.name],
    ['Parent', issue.parent ? `#${issue.parent.id}` : undefined],
    ['Start date', issue.start_date],
    ['Due date', issue.due_date],
    ['Done', issue.done_ratio !== undefined ? `${issue.done_ratio}%` : undefined],
    ['Estimated hours', issue.estimated_hours],
    ['Spent hours', issue.spent_hours],
    ['Created', issue.created_on],
    ['Updated', issue.updated_on],
    ['Closed', issue.closed_on],
    ['Private', issue.is_private ? 'yes' : undefined],
  ];
  out.push('| Field | Value |', '|---|---|');
  for (const [label, value] of rows) {
    if (value !== undefined && value !== null && value !== '') out.push(`| ${label} | ${cell(value)} |`);
  }
  out.push('');

  if (issue.custom_fields?.length) {
    out.push('**Custom fields**');
    for (const cf of issue.custom_fields) out.push(`- ${cf.name}: ${customFieldValue(cf)}`);
    out.push('');
  }

  if (issue.relations?.length) {
    out.push('**Relations**');
    for (const r of issue.relations) {
      const other = r.issue_id === issue.id ? r.issue_to_id : r.issue_id;
      const label = RELATION_LABELS[r.relation_type] ?? r.relation_type;
      out.push(`- ${label} #${other}${r.delay ? ` (delay ${r.delay}d)` : ''}`);
    }
    out.push('');
  }

  if (issue.children?.length) {
    out.push('**Subtasks**');
    for (const c of issue.children) out.push(`- #${c.id}${c.subject ? ` ${c.subject}` : ''}`);
    out.push('');
  }

  out.push('## Description', '');
  out.push(issue.description?.trim() ? issue.description.trim() : '_(no description)_', '');

  const attachments = issue.attachments ?? [];
  if (attachments.length) {
    out.push(`## Attachments (${attachments.length})`, '');
    out.push('| ID | Filename | Size | Type | Author | Added | Description |', '|---|---|---|---|---|---|---|');
    for (const a of attachments) {
      out.push(
        `| ${a.id} | ${cell(a.filename)} | ${formatBytes(a.filesize)} | ${cell(a.content_type)} | ${cell(a.author?.name)} | ${cell(a.created_on)} | ${cell(a.description)} |`,
      );
    }
    out.push('', `To fetch a file: \`download_attachment\` with \`issue_id: ${issue.id}\` and the attachment ID above.`, '');
  }

  if (opts.includeJournals) {
    const cfNames = new Map((issue.custom_fields ?? []).map((cf) => [cf.id, cf.name] as const));
    const journals = (issue.journals ?? []).filter((j) => j.notes?.trim() || j.details?.length);
    if (journals.length) {
      out.push(`## Journals (${journals.length})`, '');
      journals.forEach((j, i) => {
        const who = j.user?.name ?? 'unknown';
        const privateTag = j.private_notes ? ' (private note)' : '';
        out.push(`### ${i + 1}. ${who} — ${j.created_on ?? ''}${privateTag}`, '');
        if (j.details?.length) {
          out.push(`_Changes: ${j.details.map((d) => describeDetail(d, cfNames)).join('; ')}_`, '');
        }
        if (j.notes?.trim()) out.push(j.notes.trim(), '');
      });
    }
  }

  return out.join('\n').trimEnd() + '\n';
}
