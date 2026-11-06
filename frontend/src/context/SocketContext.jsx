import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Client } from '@stomp/stompjs';
import { api, getToken } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';
import { useToast } from './ToastContext.jsx';

/*
 * One WebSocket (STOMP) connection per logged-in browser tab, shared by every page.
 *
 * Subscriptions made right after connecting:
 *   /topic/presence        someone went online / offline / LIVE      -> presence map
 *   /topic/global          new global chat message                   -> 'global' listeners
 *   /user/queue/private    new private message for me                -> 'private' listeners + unread counters
 *   /user/queue/requests   a chat request involving me changed       -> 'requests' listeners + badge
 *   /user/queue/errors     a message I sent was rejected             -> error toast
 *
 * Pages register for events with useSocketEvent('global', handler) and send with publish(...).
 * If the connection drops, stompjs reconnects every 3 seconds and everything is re-subscribed.
 */
const SocketContext = createContext(null);

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\\/+$/, '');

function wsUrl() {
  if (!API_BASE_URL) {
    throw new Error('Backend URL is missing. Set VITE_API_BASE_URL in Vercel.');
  }

  const backendUrl = new URL(API_BASE_URL);
  backendUrl.protocol = backendUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${backendUrl.origin}/ws`;
}

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const toast = useToast();

  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState({}); // username -> { online, live }
  const [pendingCount, setPendingCount] = useState(0);
  const [unread, setUnread] = useState({}); // username -> number of unread private messages

  const clientRef = useRef(null);
  const listeners = useRef({ global: new Set(), private: new Set(), requests: new Set() });
  const activeChatRef = useRef(null);
  const meRef = useRef(user.username);
  meRef.current = user.username;

  const emit = (type, payload) => listeners.current[type].forEach((fn) => fn(payload));

  const refreshPending = useCallback(() => {
    api('/requests/pending-count')
      .then((r) => setPendingCount(r.count))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const client = new Client({
      brokerURL: wsUrl(),
      connectHeaders: { Authorization: `Bearer ${getToken()}` },
      reconnectDelay: 3000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      onConnect: () => {
        setConnected(true);

        client.subscribe('/topic/presence', (msg) => {
          const p = JSON.parse(msg.body);
          setPresence((prev) => ({ ...prev, [p.username]: { online: p.online, live: p.live } }));
        });

        client.subscribe('/topic/global', (msg) => emit('global', JSON.parse(msg.body)));

        client.subscribe('/user/queue/private', (msg) => {
          const m = JSON.parse(msg.body);
          emit('private', m);
          const fromOther = m.senderUsername !== meRef.current;
          if (fromOther && activeChatRef.current !== m.senderUsername) {
            setUnread((u) => ({ ...u, [m.senderUsername]: (u[m.senderUsername] || 0) + 1 }));
            toast(`💬 New message from ${m.senderName}`, 'info');
          }
        });

        client.subscribe('/user/queue/requests', (msg) => {
          const r = JSON.parse(msg.body);
          emit('requests', r);
          refreshPending();
          const me = meRef.current;
          if (r.status === 'PENDING' && r.recipient.username === me) {
            toast(`📨 ${r.sender.name} sent you a chat request`, 'info');
          } else if (r.status === 'ACCEPTED' && r.sender.username === me) {
            toast(`✅ ${r.recipient.name} accepted your chat request`, 'success');
          } else if (r.status === 'REJECTED' && r.sender.username === me) {
            toast(`${r.recipient.name} declined your chat request`, 'warn');
          }
        });

        client.subscribe('/user/queue/errors', (msg) => {
          const err = JSON.parse(msg.body);
          toast(err.message || 'Something went wrong', 'error');
        });

        // Initial state (taken after subscribing, so no change can slip in between).
        api('/presence')
          .then((list) => setPresence(Object.fromEntries(list.map((p) => [p.username, p]))))
          .catch(() => {});
        refreshPending();
      },
      onWebSocketClose: () => setConnected(false),
      onStompError: (frame) => console.warn('STOMP error:', frame.headers.message),
    });

    client.activate();
    clientRef.current = client;
    return () => {
      client.deactivate();
      clientRef.current = null;
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.username]);

  /** Send a STOMP message. Returns false (and warns) if the connection is down. */
  const publish = useCallback(
    (destination, body = {}, silent = false) => {
      const client = clientRef.current;
      if (!client || !client.connected) {
        if (!silent) toast('Not connected to the chat server. Reconnecting…', 'error');
        return false;
      }
      client.publish({ destination, body: JSON.stringify(body) });
      return true;
    },
    [toast]
  );

  const getStatus = useCallback(
    (username) => presence[username] || { online: false, live: false },
    [presence]
  );

  /** Tell the provider which private chat is open, so its messages are not counted as unread. */
  const setActiveChat = useCallback((username) => {
    activeChatRef.current = username;
    if (username) setUnread((u) => (u[username] ? { ...u, [username]: 0 } : u));
  }, []);

  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  const value = {
    connected,
    publish,
    presence,
    getStatus,
    pendingCount,
    refreshPending,
    unread,
    totalUnread,
    setActiveChat,
    listeners,
  };

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  return useContext(SocketContext);
}

/** Run handler(payload) whenever an event of the given type ('global' | 'private' | 'requests') arrives. */
export function useSocketEvent(type, handler) {
  const { listeners } = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const fn = (payload) => handlerRef.current(payload);
    const set = listeners.current[type];
    set.add(fn);
    return () => set.delete(fn);
  }, [type, listeners]);
}

/**
 * LIVE status heartbeat. Used by the chat screens (global and private).
 * While the screen is open and the tab is visible: send /app/presence.live now and every 15 s.
 * Hiding the tab or leaving the screen sends /app/presence.idle.
 */
export function useLiveStatus() {
  const { connected, publish } = useSocket();

  useEffect(() => {
    if (!connected) return undefined;
    const beat = () => {
      if (document.visibilityState === 'visible') publish('/app/presence.live', {}, true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') beat();
      else publish('/app/presence.idle', {}, true);
    };
    beat();
    const timer = setInterval(beat, 15000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      publish('/app/presence.idle', {}, true);
    };
  }, [connected, publish]);
}
