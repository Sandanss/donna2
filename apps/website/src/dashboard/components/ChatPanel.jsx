import { useState, useRef, useEffect } from 'react';
import { useDashboard } from '../DashboardContext';
import ProposalCard from './ProposalCard';

export default function ChatPanel({ onClose }) {
  const { senior, api } = useDashboard();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  async function handleSend(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    const userMessage = { role: 'user', content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    setThinking(null);

    // Add empty assistant message that we'll stream into
    const assistantIdx = newMessages.length;
    setMessages(prev => [...prev, { role: 'assistant', content: '', proposals: [] }]);

    try {
      const response = await api.streamChat(
        senior.id,
        newMessages.map(m => ({ role: m.role, content: m.content })),
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            const data = JSON.parse(line.slice(6));
            handleSSEEvent(eventType, data, assistantIdx);
            eventType = null;
          } else if (line === '') {
            eventType = null;
          }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        if (updated[assistantIdx]) {
          updated[assistantIdx] = {
            ...updated[assistantIdx],
            content: updated[assistantIdx].content || 'Sorry, something went wrong. Please try again.',
          };
        }
        return updated;
      });
    } finally {
      setStreaming(false);
      setThinking(null);
    }
  }

  function handleSSEEvent(eventType, data, assistantIdx) {
    switch (eventType) {
      case 'text':
        setMessages(prev => {
          const updated = [...prev];
          if (updated[assistantIdx]) {
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: updated[assistantIdx].content + data.text,
            };
          }
          return updated;
        });
        setThinking(null);
        break;
      case 'proposal':
        setMessages(prev => {
          const updated = [...prev];
          if (updated[assistantIdx]) {
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              proposals: [...(updated[assistantIdx].proposals || []), data],
            };
          }
          return updated;
        });
        setThinking(null);
        break;
      case 'thinking':
        setThinking(data.message);
        break;
      case 'error':
        setMessages(prev => {
          const updated = [...prev];
          if (updated[assistantIdx]) {
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: updated[assistantIdx].content || 'An error occurred. Please try again.',
            };
          }
          return updated;
        });
        break;
      case 'done':
        break;
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <>
      <div className="db-chat-overlay" onClick={onClose} />
      <div className="db-chat-panel">
        {/* Header */}
        <div className="db-chat-header">
          <div className="db-chat-header__title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            <span>Ask Donna</span>
          </div>
          <button className="db-chat-header__close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="db-chat-messages">
          {messages.length === 0 && (
            <div className="db-chat-empty">
              <div className="db-chat-beta-banner">
                <strong>Ask Donna is still in beta</strong>
                <p>For best results, we recommend being very detailed in your ask. If the chatbot gets stuck, try re-asking your question or starting over.</p>
              </div>
              <p className="db-chat-empty__title" style={{ marginTop: 0 }}>Schedule calls and reminders with natural language</p>
              <div className="db-chat-empty__examples">
                <button className="db-chat-empty__example" onClick={() => setInput('Schedule a call for tomorrow at 3pm')}>
                  "Schedule a call for tomorrow at 3pm"
                </button>
                <button className="db-chat-empty__example" onClick={() => setInput('Call mom at 5pm to remind her I\'m picking her up at 5:30')}>
                  "Call at 5pm to remind about pickup at 5:30"
                </button>
                <button className="db-chat-empty__example" onClick={() => setInput('Schedule calls before every Astros home game this month')}>
                  "Calls before every Astros game this month"
                </button>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`db-chat-bubble db-chat-bubble--${msg.role}`}>
              {msg.content && <div className="db-chat-bubble__text">{msg.content}</div>}
              {msg.proposals?.map((proposal, pi) => (
                <ProposalCard key={pi} proposal={proposal} />
              ))}
            </div>
          ))}

          {thinking && (
            <div className="db-chat-thinking">
              <div className="db-chat-thinking__dot" />
              <span>{thinking}</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form className="db-chat-input" onSubmit={handleSend}>
          <input
            ref={inputRef}
            type="text"
            className="db-chat-input__field"
            placeholder="Type a message..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
          />
          <button
            type="submit"
            className="db-chat-input__send"
            disabled={!input.trim() || streaming}
            aria-label="Send"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </div>
    </>
  );
}
