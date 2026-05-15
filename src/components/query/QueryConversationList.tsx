import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQueryChatStore } from '@/lib/query/chatStore';

type QueryConversationListProps = {
  onCreateConversation: () => void;
};

export function QueryConversationList({ onCreateConversation }: QueryConversationListProps) {
  const conversations = useQueryChatStore((state) => state.conversations);
  const workspaceRoot = useQueryChatStore((state) => state.workspaceRoot);
  const activeConversationId = useQueryChatStore((state) => state.activeConversationId);
  const messages = useQueryChatStore((state) => state.messages);
  const setActiveConversation = useQueryChatStore((state) => state.setActiveConversation);
  const deleteConversation = useQueryChatStore((state) => state.deleteConversation);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const sortedConversations = useMemo(
    () =>
      conversations
        .filter((conversation) => (conversation.workspaceRoot ?? 'browser-indexeddb') === workspaceRoot)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [conversations, workspaceRoot],
  );

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-[16px] border border-[#e5e5e4] bg-white">
      <div className="border-b border-[#ececeb] p-4">
        <button
          type="button"
          onClick={onCreateConversation}
          className="inline-flex w-full items-center justify-center gap-2 rounded-[12px] border border-[#d9d9d6] bg-[#fbfbfa] px-3 py-2 text-sm font-medium text-[#1f2937] transition hover:bg-white"
        >
          <MessageSquarePlus size={15} />
          新建对话
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {sortedConversations.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] px-4 py-5 text-sm leading-6 text-[#6b6b68]">
            还没有查询会话。
            <br />
            我们可以从一个具体问题开始。
          </div>
        ) : (
          <div className="space-y-1">
            {sortedConversations.map((conversation) => {
              const messageCount = messages.filter(
                (message) =>
                  message.conversationId === conversation.id &&
                  (message.workspaceRoot ?? 'browser-indexeddb') === workspaceRoot,
              ).length;
              const isActive = conversation.id === activeConversationId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setActiveConversation(conversation.id)}
                  onMouseEnter={() => setHoveredId(conversation.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={[
                    'group flex w-full items-start justify-between gap-3 rounded-[12px] px-3 py-3 text-left transition',
                    isActive ? 'bg-[#eef4ff] text-[#155eef]' : 'hover:bg-[#f7f7f5] text-[#1f2937]',
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-medium leading-6">{conversation.title}</div>
                    <div className="mt-1 text-xs text-[#6b6b68]">
                      {formatConversationTime(conversation.updatedAt)} · {messageCount} 条消息
                    </div>
                  </div>
                  {hoveredId === conversation.id ? (
                    <span
                      role="button"
                      aria-label={`删除会话：${conversation.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteConversation(conversation.id);
                      }}
                      className="rounded-full p-1 text-[#8a8f89] transition hover:bg-white hover:text-[#b42318]"
                    >
                      <Trash2 size={14} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function formatConversationTime(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
