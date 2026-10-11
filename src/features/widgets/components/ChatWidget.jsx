import React, { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, AlertCircle, RefreshCw, Loader2, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import {
  getWidgetConfigApi,
  sendInitialMessageApi,
  sendFollowupMessageApi,
  getTicketMessagesApi,
  getCustomerTicketsApi
} from '../services/widgetApi';

const ChatWidget = ({ apiKey }) => {
  const [config, setConfig] = useState(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [error, setError] = useState('');

  // Chat State
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  // Ticket State
  const [customerEmail, setCustomerEmail] = useState(() => localStorage.getItem(`sd_widget_email_${apiKey}`) || '');
  const [emailPrompted, setEmailPrompted] = useState(false);
  const [ticketId, setTicketId] = useState(() => localStorage.getItem(`sd_widget_ticket_${apiKey}`) || null);
  const [ticketStatus, setTicketStatus] = useState(null);

  // Widget Visibility State
  const [isOpen, setIsOpen] = useState(false);

  // Tabs State
  const [activeTab, setActiveTab] = useState('current');
  const [previousTickets, setPreviousTickets] = useState([]);

  const bottomRef = useRef(null);
  const pollRef = useRef(null);

  // Initialize
  useEffect(() => {
    const init = async () => {
      try {
        const res = await getWidgetConfigApi(apiKey);
        const cfg = res.data.data;
        setConfig(cfg);

        // Notify parent iframe container of primary color
        window.parent.postMessage(
          JSON.stringify({ type: 'SUPPORT_DESK_CONFIG', color: cfg.primaryColor, position: cfg.position, width: cfg.width, height: cfg.height }),
          '*'
        );

        if (!customerEmail) {
          setEmailPrompted(true);
          setMessages([
            {
              _id: 'welcome',
              sender: 'ai',
              message: `${cfg.welcomeMessage || 'Hello! How can we help you today?'}\n\nPlease enter your email address to get started:`,
              createdAt: new Date().toISOString()
            }
          ]);
        } else {
          setMessages([
            { _id: 'welcome', sender: 'ai', message: cfg.welcomeMessage, createdAt: new Date().toISOString() }
          ]);
        }
      } catch (err) {
        setError('Failed to load widget configuration. Invalid API Key.');
      } finally {
        setLoadingConfig(false);
      }
    };
    init();
  }, [apiKey, customerEmail]);

  // Scroll to bottom
  useEffect(() => {
    if (activeTab === 'current') {
      const timer = setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [messages, emailPrompted, activeTab, sending]);

  // Fetch previous tickets
  useEffect(() => {
    if (customerEmail && apiKey) {
      getCustomerTicketsApi(apiKey, customerEmail).then((res) => {
        const tickets = res.data.data;
        setPreviousTickets(tickets);
      }).catch(err => console.error("Failed to fetch previous tickets", err));
    }
  }, [customerEmail, apiKey]);

  // Listen for widget visibility toggle
  useEffect(() => {
    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'SUPPORT_DESK_TOGGLE') {
          setIsOpen(data.isOpen);
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleResetChat = () => {
    setTicketId(null);
    setTicketStatus(null);
    localStorage.removeItem(`sd_widget_ticket_${apiKey}`);
    if (!customerEmail) {
      setEmailPrompted(true);
      setMessages([
        {
          _id: 'welcome',
          sender: 'ai',
          message: `${config?.welcomeMessage || 'Hello! How can we help you today?'}\n\nPlease enter your email address to get started:`,
          createdAt: new Date().toISOString()
        }
      ]);
    } else {
      setEmailPrompted(false);
      setMessages([
        { _id: 'welcome', sender: 'ai', message: config?.welcomeMessage || 'Hello! How can we help you today?', createdAt: new Date().toISOString() }
      ]);
    }
  };

  const fetchMessages = async () => {
    if (!ticketId || !config) return;
    try {
      const res = await getTicketMessagesApi(apiKey, ticketId);
      const msgs = res.data.data.messages || [];
      const currentStatus = res.data.data?.status || res.data.data?.ticket?.status;
      if (currentStatus) {
        setTicketStatus(currentStatus);
      }

      setMessages((prev) => {
        const prevWithoutWelcome = prev.filter(m => m._id !== 'welcome');

        if (msgs.length !== prevWithoutWelcome.length) {
          return [{ _id: 'welcome', sender: 'ai', message: config.welcomeMessage, createdAt: new Date().toISOString() }, ...msgs];
        }

        const lastMsg = msgs[msgs.length - 1];
        const lastPrevMsg = prevWithoutWelcome[prevWithoutWelcome.length - 1];
        if (lastMsg && lastPrevMsg && (lastMsg.sender !== lastPrevMsg.sender || lastMsg.message !== lastPrevMsg.message || lastMsg._id !== lastPrevMsg._id)) {
          return [{ _id: 'welcome', sender: 'ai', message: config.welcomeMessage, createdAt: new Date().toISOString() }, ...msgs];
        }

        return prev;
      });
    } catch (err) {
      console.error("Polling error", err);
      if (err.response?.status === 404) {
        setTicketId(null);
        setTicketStatus(null);
        localStorage.removeItem(`sd_widget_ticket_${apiKey}`);
      }
    }
  };

  // Polling for ticket messages (runs consistently so replies show automatically)
  useEffect(() => {
    if (!ticketId || !config) return;

    fetchMessages();
    pollRef.current = setInterval(fetchMessages, 3000);
    return () => clearInterval(pollRef.current);
  }, [ticketId, apiKey, config]);

  const isResolved = Boolean(
    ticketStatus === 'resolved' ||
    previousTickets.find(t => t._id === ticketId)?.status === 'resolved' ||
    messages.some(m => {
      const lower = (m.message || '').toLowerCase();
      return (
        lower.includes('this ticket is resolved') ||
        lower.includes('ticket has been marked as resolved') ||
        lower.includes('chat has been resolved') ||
        lower.includes('ticket was marked as resolved') ||
        lower.includes('ticket is resolved')
      );
    })
  );

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!input.trim() || sending) return;

    const text = input.trim();
    setInput('');

    // Optimistic UI for customer's message
    const tempId = Date.now().toString();
    setMessages(prev => [...prev, { _id: tempId, sender: 'customer', message: text, createdAt: new Date().toISOString() }]);

    // Case 1: First-time visitor entering their email upfront
    if (!customerEmail) {
      if (!text.includes('@') || !text.includes('.')) {
        setMessages(prev => [
          ...prev,
          {
            _id: Date.now().toString(),
            sender: 'ai',
            message: "Please enter a valid email address so we can get started.",
            createdAt: new Date().toISOString()
          }
        ]);
        return;
      }
      setCustomerEmail(text);
      localStorage.setItem(`sd_widget_email_${apiKey}`, text);
      setEmailPrompted(false);

      setMessages(prev => [
        ...prev,
        {
          _id: Date.now().toString(),
          sender: 'ai',
          message: "Thank you! How can I assist you today?",
          createdAt: new Date().toISOString()
        }
      ]);
      return;
    }

    // Case 2: User has email, sending initial question (New Chat)
    if (customerEmail && !ticketId) {
      try {
        setSending(true);
        const res = await sendInitialMessageApi(apiKey, { message: text, customerEmail });
        const { isTicketCreated, ticketId: newTicketId, response } = res.data.data;

        setMessages(prev => [...prev, { _id: Date.now().toString(), sender: 'ai', message: response, createdAt: new Date().toISOString() }]);

        if (isTicketCreated && newTicketId) {
          setTicketId(newTicketId);
          localStorage.setItem(`sd_widget_ticket_${apiKey}`, newTicketId);
        }
      } catch (err) {
        setMessages(prev => [...prev, { _id: Date.now().toString(), sender: 'ai', message: 'Sorry, we encountered an error processing your request. Please try again later.', createdAt: new Date().toISOString() }]);
      } finally {
        setSending(false);
      }
      return;
    }

    if (ticketId && isResolved) {
      return;
    }

    // Case 3: Follow-up message to existing ticket
    if (ticketId) {
      try {
        setSending(true);
        const res = await sendFollowupMessageApi(apiKey, ticketId, text);
        const aiReply = res.data?.data?.aiReply;
        if (aiReply) {
          setMessages(prev => {
            const exists = prev.some(m => String(m._id) === String(aiReply._id));
            if (exists) return prev;
            return [...prev, aiReply];
          });
        }
        await fetchMessages();
      } catch (err) {
        if (err.response?.status === 404) {
          setTicketId(null);
          localStorage.removeItem(`sd_widget_ticket_${apiKey}`);
          setMessages(prev => [...prev, { _id: Date.now().toString(), sender: 'ai', message: 'The current ticket session was closed or not found. Please start a new chat.', createdAt: new Date().toISOString() }]);
        } else {
          setMessages(prev => [...prev, { _id: Date.now().toString(), sender: 'ai', message: 'Failed to send message. Please try again.', createdAt: new Date().toISOString() }]);
        }
      } finally {
        setSending(false);
      }
    }
  };

  if (loadingConfig) {
    return (
      <div className="flex h-full items-center justify-center bg-white rounded-xl shadow-2xl border border-gray-100">
        <Loader2 className="animate-spin text-gray-400" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-white p-6 rounded-xl shadow-2xl border border-gray-100 text-center gap-3">
        <AlertCircle size={40} className="text-red-400" />
        <p className="text-sm text-gray-600 font-medium">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden font-sans border border-gray-200" style={{ borderRadius: config.borderRadius ? `${config.borderRadius}px` : '12px' }}>
      {/* Header */}
      <div
        className="px-5 py-4 text-white shrink-0 shadow-sm"
        style={{ backgroundColor: config.primaryColor }}
      >
        <div className="flex justify-between items-center">
          <div>
            <h2 className="font-semibold text-lg">{config.title || 'Chat Support'}</h2>
            <p className="text-xs opacity-90 mt-0.5">{config.subtitle || 'We typically reply in a few minutes'}</p>
          </div>
          <button
            onClick={handleResetChat}
            title="Start New Chat"
            className="p-1.5 rounded-full hover:bg-white/20 text-white/90 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Tabs */}
        {customerEmail && (
          <div className="flex gap-4 mt-3 text-sm font-medium border-b border-white/20">
            <button
              onClick={() => setActiveTab('current')}
              className={`pb-1 border-b-2 transition-colors ${activeTab === 'current' ? 'border-white text-white' : 'border-transparent text-white/70 hover:text-white'}`}
            >
              Current Chat
            </button>
            <button
              onClick={() => setActiveTab('previous')}
              className={`pb-1 border-b-2 transition-colors ${activeTab === 'previous' ? 'border-white text-white' : 'border-transparent text-white/70 hover:text-white'}`}
            >
              Previous Chats
            </button>
          </div>
        )}
      </div>

      {activeTab === 'current' ? (
        <>
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4" style={{ backgroundColor: config.backgroundColor || '#f9fafb' }}>
            {messages.map((msg, idx) => {
              const isCustomer = msg.sender === 'customer';
              return (
                <div key={msg._id || idx} className={`flex ${isCustomer ? 'justify-end' : 'justify-start'} gap-2`}>
                  {!isCustomer && config.showAvatar !== false && (
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1 shadow-sm"
                      style={{ backgroundColor: msg.sender === 'ai' ? '#f3f4f6' : config.primaryColor, color: msg.sender === 'ai' ? config.primaryColor : '#fff' }}
                    >
                      {msg.sender === 'ai' ? <Sparkles size={14} /> : <Bot size={14} />}
                    </div>
                  )}

                  <div>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed shadow-sm ${isCustomer
                        ? 'rounded-tr-sm text-white ml-auto'
                        : 'rounded-tl-sm border border-gray-100 text-gray-900 bg-white'
                        }`}
                      style={isCustomer ? { backgroundColor: config.primaryColor || '#111111', color: '#ffffff' } : { backgroundColor: '#ffffff', color: '#111827', borderColor: config.secondaryColor || '#e5e7eb' }}
                    >
                      {isCustomer ? (
                        msg.message.split('\n').map((line, i) => <p key={i} className="min-h-[14px] text-white" style={{ color: '#ffffff' }}>{line}</p>)
                      ) : (
                        <ReactMarkdown
                          components={{
                            p: ({ node, ...props }) => <p className="mb-2 last:mb-0 text-gray-900" style={{ color: '#111827' }} {...props} />,
                            a: ({ node, ...props }) => <a className="text-blue-600 hover:underline font-medium" target="_blank" rel="noopener noreferrer" {...props} />,
                            ul: ({ node, ...props }) => <ul className="list-disc pl-4 mb-2 space-y-1 text-gray-900" style={{ color: '#111827' }} {...props} />,
                            ol: ({ node, ...props }) => <ol className="list-decimal pl-4 mb-2 space-y-1 text-gray-900" style={{ color: '#111827' }} {...props} />,
                            li: ({ node, ...props }) => <li className="text-gray-900" style={{ color: '#111827' }} {...props} />,
                            strong: ({ node, ...props }) => <strong className="font-semibold text-gray-900" style={{ color: '#111827' }} {...props} />,
                            code: ({ node, inline, ...props }) =>
                              inline ? (
                                <code className="bg-gray-100 px-1.5 py-0.5 rounded-md text-xs font-mono text-gray-800" {...props} />
                              ) : (
                                <pre className="bg-gray-100 p-2.5 rounded-md text-xs overflow-x-auto mb-2 text-gray-800"><code className="font-mono" {...props} /></pre>
                              )
                          }}
                        >
                          {msg.message}
                        </ReactMarkdown>
                      )}
                    </div>
                    {config.showTimestamps !== false && msg.createdAt && (
                      <div className={`text-[10px] mt-1 text-gray-300 ${isCustomer ? 'text-right' : 'text-left'}`}>
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Input Area */}
          <div className="p-3 border-t shrink-0" style={{ backgroundColor: config.backgroundColor || '#ffffff', borderColor: config.secondaryColor || '#f3f4f6' }}>
            {ticketId && isResolved ? (
              <div className="text-center py-2.5 px-3 bg-white/10 rounded-xl border border-white/20 shadow-sm">
                <p className="text-xs text-white font-medium mb-2.5">This ticket has been resolved.</p>
                <button
                  onClick={handleResetChat}
                  className="px-5 py-2 bg-white text-gray-900 font-semibold text-xs rounded-full hover:bg-gray-100 transition-colors shadow-sm"
                >
                  Start New Chat
                </button>
              </div>
            ) : (
              <form onSubmit={handleSend} className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={!customerEmail ? "Enter your email to get started..." : "Type your message..."}
                  style={{ color: '#111827', backgroundColor: '#ffffff' }}
                  className="flex-1 bg-white border border-gray-300 rounded-full px-4 py-2.5 text-[13.5px] text-gray-900 placeholder:text-gray-500 focus:outline-none focus:border-gray-500 transition-colors shadow-sm"
                  disabled={sending}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || sending}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0 shadow-sm"
                  style={{ backgroundColor: config.primaryColor }}
                >
                  {sending ? <Loader2 size={16} className="animate-spin text-white" /> : <Send size={16} className="ml-0.5 text-white" />}
                </button>
              </form>
            )}
            <div className="text-center mt-2">
              <a href="#" className="text-[10px] text-gray-300 hover:text-white transition-colors">Powered by SupportDesk</a>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ backgroundColor: config.backgroundColor || '#f9fafb' }}>
          {previousTickets.length === 0 ? (
            <div className="text-center text-sm text-gray-500 mt-10">No previous chats found.</div>
          ) : (
            previousTickets.map(ticket => (
              <div
                key={ticket._id}
                className={`p-3 rounded-lg border cursor-pointer hover:border-gray-300 transition-colors`}
                style={{ backgroundColor: '#ffffff', borderColor: ticketId === ticket._id ? config.primaryColor : (config.secondaryColor || '#e5e7eb') }}
                onClick={() => {
                  setTicketId(ticket._id);
                  localStorage.setItem(`sd_widget_ticket_${apiKey}`, ticket._id);
                  setActiveTab('current');
                  // Optimistically clear messages so they refetch for the new ticket
                  // Fetch will happen because ticketId changed and polling useEffect runs
                  setMessages([{ _id: 'welcome', sender: 'ai', message: config?.welcomeMessage || 'Loading...', createdAt: new Date().toISOString() }]);
                }}
              >
                <div className="flex justify-between items-start mb-1">
                  <h3 className="text-sm font-medium text-gray-800 line-clamp-1">{ticket.subject || 'Support Ticket'}</h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${ticket.status === 'resolved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                    {ticket.status}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  {new Date(ticket.createdAt).toLocaleDateString()}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default ChatWidget;
