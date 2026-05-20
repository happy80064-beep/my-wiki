import { Loader2, SendHorizonal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type QueryInputProps = {
  disabled?: boolean;
  isSending?: boolean;
  initialValue?: string;
  onSend: (question: string) => Promise<void> | void;
};

export function QueryInput({ disabled, isSending, initialValue, onSend }: QueryInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!initialValue) return;
    setValue(initialValue);
    textareaRef.current?.focus();
  }, [initialValue]);

  function autoResize() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }

  useEffect(() => {
    autoResize();
  }, [value]);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled || isSending) return;
    await onSend(trimmed);
    setValue('');
  }

  return (
    <div className="rounded-[14px] border border-[#e5e5e4] bg-white p-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="输入你的问题。每轮查询会单独保存到会话里，减少上下文污染。"
        disabled={disabled || isSending}
        className="min-h-14 w-full resize-none rounded-[12px] border border-[#d9d9d6] bg-[#fbfbfa] p-3 text-sm leading-6 text-[#1f2937] outline-none transition focus:border-[#155eef] focus:bg-white disabled:cursor-not-allowed disabled:bg-[#f4f4f3]"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs leading-5 text-[#6b6b68]">Shift + Enter 换行，Enter 发送。</p>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!value.trim() || disabled || isSending}
          className="inline-flex items-center gap-2 rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-[#a8b7d8]"
        >
          {isSending ? <Loader2 size={15} className="animate-spin" /> : <SendHorizonal size={15} />}
          发送
        </button>
      </div>
    </div>
  );
}
