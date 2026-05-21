import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StructuredQueryResult } from '@/lib/graph';
import { buildConversationTitle, type QueryChatReference } from './chatHelpers';

export type QueryConversation = {
  id: string;
  title: string;
  workspaceRoot?: string;
  createdAt: number;
  updatedAt: number;
};

export type QueryChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  conversationId: string;
  workspaceRoot?: string;
  timestamp: number;
  question?: string;
  references?: QueryChatReference[];
  result?: StructuredQueryResult;
};

type QueryChatState = {
  workspaceRoot: string;
  conversations: QueryConversation[];
  activeConversationId: string | null;
  messages: QueryChatMessage[];
  isResponding: boolean;
  setWorkspaceRoot: (root: string) => void;
  createConversation: (title?: string) => string;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  addUserMessage: (question: string) => QueryChatMessage | null;
  addAssistantMessage: (
    question: string,
    answer: string,
    result: StructuredQueryResult,
    references: QueryChatReference[],
  ) => QueryChatMessage | null;
  addAssistantMessageToConversation: (
    conversationId: string,
    question: string,
    answer: string,
    result: StructuredQueryResult,
    references: QueryChatReference[],
  ) => QueryChatMessage | null;
  updateAssistantMessage: (
    messageId: string,
    input: {
      content?: string;
      result?: StructuredQueryResult;
      references?: QueryChatReference[];
    },
  ) => void;
  removeLastAssistantMessage: (conversationId: string) => void;
  updateMessageResult: (messageId: string, result: StructuredQueryResult) => void;
  setIsResponding: (responding: boolean) => void;
  getActiveMessages: () => QueryChatMessage[];
  clearAll: () => void;
};

function nextId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useQueryChatStore = create<QueryChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      workspaceRoot: 'browser-indexeddb',
      activeConversationId: null,
      messages: [],
      isResponding: false,
      setWorkspaceRoot: (root) =>
        set((state) => {
          const workspaceRoot = root || 'browser-indexeddb';
          if (state.workspaceRoot === workspaceRoot) return state;
          const activeConversationId =
            state.conversations
              .filter((conversation) => conversationWorkspaceRoot(conversation) === workspaceRoot)
              .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;
          return { workspaceRoot, activeConversationId };
        }),
      createConversation: (title) => {
        const id = nextId('conv');
        const now = Date.now();
        const workspaceRoot = get().workspaceRoot || 'browser-indexeddb';
        const conversation: QueryConversation = {
          id,
          title: title?.trim() || '新对话',
          workspaceRoot,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }));
        return id;
      },
      deleteConversation: (id) =>
        set((state) => {
          const conversations = state.conversations.filter((conversation) => conversation.id !== id);
          return {
            conversations,
            messages: state.messages.filter((message) => message.conversationId !== id),
            activeConversationId:
              state.activeConversationId === id
                ? conversations
                    .filter((conversation) => conversationWorkspaceRoot(conversation) === state.workspaceRoot)
                    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null
                : state.activeConversationId,
          };
        }),
      setActiveConversation: (id) =>
        set((state) => {
          if (!id) return { activeConversationId: null };
          const conversation = state.conversations.find((item) => item.id === id);
          if (!conversation || conversationWorkspaceRoot(conversation) !== state.workspaceRoot) return state;
          return { activeConversationId: id };
        }),
      addUserMessage: (question) => {
        const trimmed = question.trim();
        if (!trimmed) return null;
        const workspaceRoot = get().workspaceRoot || 'browser-indexeddb';
        let conversationId = get().activeConversationId;
        const activeConversation = conversationId
          ? get().conversations.find((conversation) => conversation.id === conversationId)
          : undefined;
        if (!conversationId || conversationWorkspaceRoot(activeConversation) !== workspaceRoot) {
          conversationId = get().createConversation();
        }
        const message: QueryChatMessage = {
          id: nextId('msg'),
          role: 'user',
          content: trimmed,
          conversationId,
          workspaceRoot,
          timestamp: Date.now(),
          question: trimmed,
        };
        set((state) => {
          const isFirstUserMessage = !state.messages.some(
            (item) => item.conversationId === conversationId && item.role === 'user',
          );
          return {
            messages: [...state.messages, message],
            conversations: state.conversations
              .map((conversation) =>
                conversation.id === conversationId
                  ? {
                      ...conversation,
                      title: isFirstUserMessage ? buildConversationTitle(trimmed) : conversation.title,
                      updatedAt: Date.now(),
                    }
                  : conversation,
              )
              .sort((left, right) => right.updatedAt - left.updatedAt),
          };
        });
        return message;
      },
      addAssistantMessage: (question, answer, result, references) => {
        const conversationId = get().activeConversationId;
        if (!conversationId) return null;
        return get().addAssistantMessageToConversation(conversationId, question, answer, result, references);
      },
      addAssistantMessageToConversation: (conversationId, question, answer, result, references) => {
        const workspaceRoot = get().workspaceRoot || 'browser-indexeddb';
        const message: QueryChatMessage = {
          id: nextId('msg'),
          role: 'assistant',
          content: answer,
          conversationId,
          workspaceRoot,
          timestamp: Date.now(),
          question,
          result,
          references,
        };
        set((state) => ({
          messages: [...state.messages, message],
          conversations: state.conversations
            .map((conversation) =>
              conversation.id === conversationId
                ? {
                    ...conversation,
                    updatedAt: Date.now(),
                  }
                : conversation,
            )
            .sort((left, right) => right.updatedAt - left.updatedAt),
        }));
        return message;
      },
      updateAssistantMessage: (messageId, input) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: input.content ?? message.content,
                  result: input.result ?? message.result,
                  references: input.references ?? message.references,
                }
              : message,
          ),
        })),
      removeLastAssistantMessage: (conversationId) =>
        set((state) => {
          const activeMessages = state.messages.filter((message) => message.conversationId === conversationId);
          const lastAssistant = [...activeMessages].reverse().find((message) => message.role === 'assistant');
          if (!lastAssistant) return state;
          return {
            messages: state.messages.filter((message) => message.id !== lastAssistant.id),
          };
        }),
      updateMessageResult: (messageId, result) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: result.answer,
                  result,
                }
              : message,
          ),
        })),
      setIsResponding: (responding) => set({ isResponding: responding }),
      getActiveMessages: () => {
        const state = get();
        if (!state.activeConversationId) return [];
        return state.messages.filter(
          (message) =>
            message.conversationId === state.activeConversationId &&
            messageWorkspaceRoot(message) === state.workspaceRoot,
        );
      },
      clearAll: () =>
        set({
          conversations: [],
          activeConversationId: null,
          messages: [],
          isResponding: false,
        }),
    }),
    {
      name: 'mywiki.query.v2.chat',
      storage: typeof window === 'undefined' ? undefined : createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        workspaceRoot: state.workspaceRoot,
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        messages: state.messages,
      }),
    },
  ),
);

function conversationWorkspaceRoot(conversation: QueryConversation | undefined) {
  return conversation?.workspaceRoot ?? 'browser-indexeddb';
}

function messageWorkspaceRoot(message: QueryChatMessage) {
  return message.workspaceRoot ?? 'browser-indexeddb';
}
