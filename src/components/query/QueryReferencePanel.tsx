import { ExternalLink, FileText, Globe2, Layers, Tags, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { QueryChatReference, QueryChatReferencePreview } from '@/lib/query/chatHelpers';
import { buildInitialBrowserEntityMarkdown } from '@/lib/wiki/browserWikiPageHelpers';
import { buildWikiPageMetadata } from '@/lib/wiki/pageMetadata';
import type { Entity, Entry } from '@/types';
import { QueryAnswerRenderer } from './QueryAnswerRenderer';

type QueryReferencePanelProps = {
  reference: QueryChatReference | null;
  onClose: () => void;
};

export function QueryReferencePanel({ reference, onClose }: QueryReferencePanelProps) {
  const referencePreview = reference?.preview ?? buildPreviewFromLegacyReference(reference);
  const wikiEntityId = referencePreview?.kind === 'wiki' ? referencePreview.entityId : undefined;
  const sourceEntryId = referencePreview?.kind === 'source' ? referencePreview.entryId : undefined;

  const entity = useLiveQuery(
    async () => (wikiEntityId ? await db.entities.get(wikiEntityId) : undefined),
    [wikiEntityId],
  );
  const entry = useLiveQuery(
    async () => (sourceEntryId ? await db.entries.get(sourceEntryId) : undefined),
    [sourceEntryId],
  );

  const preview = buildEffectivePreview(referencePreview, entity, entry);

  return (
    <aside className="h-full min-h-0 rounded-[16px] border border-[#e5e5e4] bg-white">
      <header className="flex items-center justify-between gap-3 border-b border-[#ececeb] px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#155eef]">Reference Preview</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-[#1f2937]">
            {preview?.title ?? '参考资料预览'}
          </h2>
        </div>
        {reference ? (
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] text-[#626965] hover:bg-[#f7f7f5]"
            onClick={onClose}
            aria-label="关闭参考资料预览"
          >
            <X size={15} />
          </button>
        ) : null}
      </header>

      {!reference ? (
        <div className="p-5">
          <div className="rounded-[14px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-5 text-sm leading-7 text-[#626965]">
            点击回答下方的参考来源后，Wiki 页面、源文件或网页来源会在这里打开，不再跳走当前查询对话。
          </div>
        </div>
      ) : preview ? (
        <ReferencePreviewBody preview={preview} />
      ) : (
        <div className="p-5">
          <div className="rounded-[14px] border border-[#f1d2d2] bg-[#fffafa] p-4 text-sm leading-7 text-[#8a1f1f]">
            没有找到这条旧引用的可预览内容。新生成的回答会保存精确页面快照，点击后可直接在右侧查看。
          </div>
          <p className="mt-3 break-all text-xs text-[#626965]">{reference.title}</p>
        </div>
      )}
    </aside>
  );
}

function ReferencePreviewBody({ preview }: { preview: EffectiveReferencePreview }) {
  return (
    <div className="h-[calc(100%-64px)] overflow-auto">
      <section className="border-b border-[#ececeb] px-5 py-4">
        <div className="mb-3 flex flex-wrap gap-2">
          <Chip label={preview.kind === 'wiki' ? preview.pageType || 'wiki' : preview.kind === 'web' ? 'web' : 'source'} />
          {preview.updated ? <Chip label={preview.updated} /> : null}
          {preview.path ? <Chip label={preview.path} /> : null}
        </div>

        {preview.summary ? (
          <p className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3 text-sm leading-6 text-[#1f2937]">
            {preview.summary}
          </p>
        ) : null}

        {preview.kind === 'web' ? (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex max-w-full items-center gap-2 rounded-full border border-[#155eef] px-3 py-1.5 text-sm text-[#155eef] hover:bg-[#f4f8ff]"
          >
            <Globe2 size={14} />
            <span className="truncate">{preview.source || preview.url}</span>
            <ExternalLink size={13} />
          </a>
        ) : null}

        {preview.kind === 'wiki' ? (
          <div className="mt-4 grid gap-3">
            <MetaRow icon={<Tags size={14} />} label="Tags" values={preview.tags} />
            <MetaRow icon={<Layers size={14} />} label="Sources" values={preview.sources} />
            <MetaRow icon={<FileText size={14} />} label="Related" values={preview.related} />
          </div>
        ) : null}

        {preview.truncated ? (
          <p className="mt-3 text-xs text-[#8a8f89]">这里显示的是当前回答使用的引用快照，内容已截断。</p>
        ) : null}
      </section>

      <section className="px-5 py-5">
        {preview.kind === 'web' ? (
          <div className="rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-4 text-sm leading-7 text-[#1f2937]">
            {preview.snippet || '暂无网页摘要。'}
          </div>
        ) : preview.kind === 'source' ? (
          <pre className="whitespace-pre-wrap rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-4 text-sm leading-7 text-[#1f2937]">
            {preview.content || '暂无可预览文本。'}
          </pre>
        ) : preview.content ? (
          <QueryAnswerRenderer content={normalizePreviewMarkdown(preview.content, preview.title)} />
        ) : (
          <p className="text-sm leading-7 text-[#626965]">暂无页面正文。</p>
        )}
      </section>
    </div>
  );
}

type EffectiveReferencePreview = QueryChatReferencePreview & {
  title: string;
  updated?: string;
  summary?: string;
  path?: string;
  content?: string;
  truncated?: boolean;
};

function buildEffectivePreview(
  preview: QueryChatReferencePreview | undefined,
  entity: Entity | undefined,
  entry: Entry | undefined,
): EffectiveReferencePreview | null {
  if (preview?.kind === 'wiki' && preview.content) {
    return preview;
  }

  if (preview?.kind === 'source' && preview.content) {
    return preview;
  }

  if (preview?.kind === 'web') {
    return {
      ...preview,
      summary: preview.source,
      content: preview.snippet,
    };
  }

  if (preview?.kind === 'wiki' && entity) {
    const markdown = entity.wikiMarkdown?.trim() || buildInitialBrowserEntityMarkdown(entity);
    const metadata = buildWikiPageMetadata(markdown, entity);
    return {
      kind: 'wiki',
      entityId: entity.id,
      title: metadata.title || entity.title,
      pageType: metadata.type,
      summary: metadata.description || entity.summary,
      content: metadata.body,
      tags: metadata.tags,
      sources: metadata.sources,
      related: metadata.related,
      updated: metadata.updated,
    };
  }

  if (preview?.kind === 'source' && entry) {
    return {
      kind: 'source',
      entryId: entry.id,
      title: entry.fileMetadata?.filename ?? preview.title,
      path: entry.fileMetadata?.url,
      summary: entry.source,
      content: entry.content,
    };
  }

  if (preview) return preview;
  return null;
}

function buildPreviewFromLegacyReference(reference: QueryChatReference | null): QueryChatReferencePreview | undefined {
  if (!reference) return undefined;
  if (reference.type === 'entity') {
    return {
      kind: 'wiki',
      entityId: reference.key.replace(/^entity:/, ''),
      title: reference.title,
    };
  }
  if (reference.type === 'entry') {
    return {
      kind: 'source',
      entryId: reference.key.replace(/^entry:/, ''),
      title: reference.title,
    };
  }
  if (reference.type === 'web' && reference.href) {
    return {
      kind: 'web',
      title: reference.title,
      url: reference.href,
      source: safeHost(reference.href),
    };
  }
  return undefined;
}

function MetaRow({ icon, label, values }: { icon: ReactNode; label: string; values?: string[] }) {
  const unique = Array.from(new Set(values ?? [])).filter(Boolean).slice(0, 8);
  if (!unique.length) return null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[#626965]">
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-2">
        {unique.map((value) => (
          <Chip key={value} label={value} />
        ))}
      </div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#315078]">
      <span className="truncate">{label}</span>
    </span>
  );
}

function normalizePreviewMarkdown(content: string, title: string) {
  const withoutDuplicateTitle = content
    .trim()
    .replace(new RegExp(`^#\\s+${escapeRegExp(title)}\\s*\\n+`, 'i'), '')
    .trim();
  return withoutDuplicateTitle || content;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
