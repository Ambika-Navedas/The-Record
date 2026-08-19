import { createContext, useContext, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import type { ChatAnswer } from '../lib/api'

export interface ChatMessage {
  id: string
  role: 'user' | 'bot'
  text: string
  sources?: ChatAnswer['sources']
  pending?: boolean
}

interface ChatDrawerContextValue {
  isOpen: boolean
  messages: ChatMessage[]
  open: () => void
  close: () => void
  ask: (question: string) => void
}

const ChatDrawerContext = createContext<ChatDrawerContextValue | null>(null)

const WELCOME: ChatMessage = {
  id: 'welcome',
  role: 'bot',
  text: 'Ask me anything about your projects, docs, or meetings — I answer with sources, not a folder to dig through.',
}

export function ChatDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME])

  function ask(question: string) {
    const trimmed = question.trim()
    if (!trimmed) return

    const userMsgId = crypto.randomUUID()
    const pendingId = crypto.randomUUID()
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', text: trimmed },
      { id: pendingId, role: 'bot', text: 'Searching…', pending: true },
    ])
    setIsOpen(true)

    api
      .post<ChatAnswer>('/chat/ask', { question: trimmed })
      .then(({ answerText, sources }) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === pendingId ? { ...m, text: answerText, sources, pending: false } : m)),
        )
      })
      .catch(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? { ...m, text: 'Something went wrong reaching the API. Is the backend running on :4000?', pending: false }
              : m,
          ),
        )
      })
  }

  return (
    <ChatDrawerContext.Provider
      value={{ isOpen, messages, open: () => setIsOpen(true), close: () => setIsOpen(false), ask }}
    >
      {children}
    </ChatDrawerContext.Provider>
  )
}

export function useChatDrawer() {
  const ctx = useContext(ChatDrawerContext)
  if (!ctx) throw new Error('useChatDrawer must be used within ChatDrawerProvider')
  return ctx
}
