import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, X } from 'lucide-react';
import {
  projectTemplates,
  type CreateWorkspaceProjectInput,
  type ProjectOutputLanguage,
  type ProjectTemplateId,
} from '@/lib/workspace';

type CreateProjectDialogProps = {
  open: boolean;
  defaultParentDirectory: string;
  creating?: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (input: CreateWorkspaceProjectInput) => void | Promise<void>;
};

const outputLanguageOptions: Array<{ value: ProjectOutputLanguage; label: string; help: string }> = [
  { value: 'zh-CN', label: '简体中文', help: '推荐。所有 AI 生成的 Wiki 页面、回答和研究输出默认使用中文。' },
  { value: 'en-US', label: 'English', help: '适合英文材料和英文输出为主的项目。' },
];

export function CreateProjectDialog({
  open,
  defaultParentDirectory,
  creating = false,
  error = '',
  onClose,
  onCreate,
}: CreateProjectDialogProps) {
  const [projectName, setProjectName] = useState('');
  const [parentDirectory, setParentDirectory] = useState(defaultParentDirectory);
  const [templateId, setTemplateId] = useState<ProjectTemplateId>('general');
  const [outputLanguage, setOutputLanguage] = useState<ProjectOutputLanguage>('zh-CN');

  useEffect(() => {
    if (open) setParentDirectory(defaultParentDirectory);
  }, [defaultParentDirectory, open]);

  if (!open) return null;

  function submit() {
    void onCreate({
      projectName,
      parentDirectory,
      templateId,
      outputLanguage,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 py-10">
      <section className="w-full max-w-[520px] rounded-[12px] border border-[#dededb] bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-[#ececea] px-5 py-4">
          <div>
            <p className="text-xs font-medium text-[#155eef]">新建项目</p>
            <h2 className="mt-1 text-lg font-semibold text-[#1f2937]">创建新的 Wiki 知识库</h2>
          </div>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full border border-[#d9d9d6] text-[#626965] hover:bg-[#f7f7f5]"
            onClick={onClose}
            aria-label="关闭创建项目弹窗"
            disabled={creating}
          >
            <X size={16} />
          </button>
        </header>

        <div className="grid max-h-[78vh] gap-5 overflow-auto px-5 py-5">
          <label className="grid gap-2 text-sm font-medium text-[#1f2937]">
            项目名称
            <input
              className="h-10 rounded-[8px] border border-[#d9d9d6] px-3 text-sm font-normal outline-none focus:border-[#155eef]"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="例如：福瑞项目知识库"
              disabled={creating}
            />
          </label>

          <div className="grid gap-2">
            <p className="text-sm font-medium text-[#1f2937]">模板</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {projectTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={[
                    'min-h-[118px] rounded-[8px] border p-3 text-left transition hover:bg-[#f7f7f5]',
                    templateId === template.id
                      ? 'border-[#155eef] bg-[#f4f8ff] ring-1 ring-[#155eef]'
                      : 'border-[#e5e5e4] bg-white',
                  ].join(' ')}
                  onClick={() => setTemplateId(template.id)}
                  disabled={creating}
                >
                  <span className="text-xl leading-none">{template.icon}</span>
                  <span className="mt-2 block text-sm font-semibold text-[#1f2937]">{template.name}</span>
                  <span className="mt-1 block text-xs leading-5 text-[#626965]">{template.description}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="grid gap-2 text-sm font-medium text-[#1f2937]">
            AI 输出语言 <span className="text-[#b42318]">*</span>
            <select
              className="h-10 rounded-[8px] border border-[#d9d9d6] bg-white px-3 text-sm font-normal outline-none focus:border-[#155eef]"
              value={outputLanguage}
              onChange={(event) => setOutputLanguage(event.target.value as ProjectOutputLanguage)}
              disabled={creating}
            >
              {outputLanguageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-xs font-normal leading-5 text-[#626965]">
              {outputLanguageOptions.find((option) => option.value === outputLanguage)?.help}
            </span>
          </label>

          <label className="grid gap-2 text-sm font-medium text-[#1f2937]">
            父目录
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-[8px] border border-[#d9d9d6] px-3 text-sm font-normal outline-none focus:border-[#155eef]"
                value={parentDirectory}
                onChange={(event) => setParentDirectory(event.target.value)}
                placeholder="D:/MyWikiProjects"
                disabled={creating}
              />
              <button
                type="button"
                className="flex size-10 shrink-0 items-center justify-center rounded-[8px] border border-[#d9d9d6] text-[#626965]"
                title="目录选择器将在桌面版后续接入"
                disabled
              >
                <FolderOpen size={17} />
              </button>
            </div>
          </label>

          {error ? (
            <div className="rounded-[8px] border border-[#fecaca] bg-[#fff5f5] px-3 py-2 text-sm leading-6 text-[#b42318]">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[#ececea] px-5 py-4">
          <button
            type="button"
            className="rounded-full border border-[#d9d9d6] px-4 py-2 text-sm font-medium text-[#1f2937] hover:bg-[#f7f7f5]"
            onClick={onClose}
            disabled={creating}
          >
            取消
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full bg-[#111827] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            onClick={submit}
            disabled={creating}
          >
            {creating ? <Loader2 size={15} className="animate-spin" /> : null}
            {creating ? '正在创建...' : '创建'}
          </button>
        </footer>
      </section>
    </div>
  );
}
