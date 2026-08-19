import { useState } from 'react'
import Markdown from 'react-markdown'
import { useChatDrawer } from '../context/ChatDrawerContext'

export function ChatDrawer() {
  const { isOpen, messages, open, close, ask } = useChatDrawer()
  const [input, setInput] = useState('')

  function handleSend() {
    if (!input.trim()) return
    ask(input)
    setInput('')
  }

  return (
    <>
      <button
        onClick={open}
        aria-label="Ask The Record"
        className="fixed bottom-6 right-6 z-[100] flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-accent-2 to-accent text-2xl text-white shadow-[0_12px_28px_-8px_rgba(52,87,213,0.5)] transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        💬
        <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-green" />
      </button>

      <div
        onClick={close}
        className={`fixed inset-0 z-[200] bg-ink/25 transition-opacity ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <div
        role="dialog"
        aria-label="Ask The Record chat"
        className={`fixed right-0 top-0 z-[201] flex h-full w-[400px] max-w-[92vw] flex-col bg-white shadow-[-16px_0_40px_-20px_rgba(27,28,34,0.35)] transition-transform duration-250 ease-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent-tint to-white text-sm text-accent shadow-[inset_0_0_0_1px_rgba(52,87,213,0.15)]">
              💬
            </div>
            <h3 className="font-display text-[15px] font-bold">Ask The Record</h3>
          </div>
          <button
            onClick={close}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border text-sm text-muted hover:bg-page"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-5">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[88%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                m.role === 'user'
                  ? 'self-end whitespace-pre-wrap rounded-br-[4px] bg-accent text-white'
                  : 'self-start rounded-bl-[4px] border border-border bg-page text-ink'
              }`}
            >
              {m.role === 'user' ? (
                m.text
              ) : (
                <Markdown
                  components={{
                    p: ({ ...props }) => <p className="mb-2 last:mb-0" {...props} />,
                    ul: ({ ...props }) => <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0" {...props} />,
                    ol: ({ ...props }) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0" {...props} />,
                    strong: ({ ...props }) => <strong className="font-semibold" {...props} />,
                    h1: ({ ...props }) => <p className="mb-1 mt-2 font-display text-[13px] font-bold first:mt-0" {...props} />,
                    h2: ({ ...props }) => <p className="mb-1 mt-2 font-display text-[13px] font-bold first:mt-0" {...props} />,
                    h3: ({ ...props }) => <p className="mb-1 mt-2 font-display text-[13px] font-bold first:mt-0" {...props} />,
                    code: ({ ...props }) => <code className="rounded bg-ink/5 px-1 py-0.5 font-mono text-[12px]" {...props} />,
                    a: ({ ...props }) => <a className="text-accent underline" target="_blank" rel="noreferrer" {...props} />,
                  }}
                >
                  {m.text}
                </Markdown>
              )}
              {m.sources && m.sources.length > 0 && (
                <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted">
                  Sources:{' '}
                  {m.sources
                    .map((s) => (s.via === 'graph' ? `${s.title} (related)` : s.title))
                    .join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="border-t border-border p-3.5">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-page py-2 pl-3.5 pr-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Ask anything about your projects, docs, meetings…"
              className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
            />
            <button
              onClick={handleSend}
              aria-label="Send"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-accent text-sm text-white"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
