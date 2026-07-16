import { useEffect, useRef, useState } from 'react';
import { consoleApi } from '../api/client.js';

export type StreamState =
  'connecting' | 'live' | 'reconnecting' | 'disconnected';
export type RuntimeEvent = { id?: string; [key: string]: unknown };
export function appendDeduped(
  buffer: RuntimeEvent[],
  incoming: RuntimeEvent[],
  max: number,
) {
  const seen = new Set(buffer.map((e) => String(e.id ?? '')));
  const merged = [...buffer];
  for (const event of incoming) {
    const id = String(event.id ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.unshift(event);
  }
  return merged.slice(0, max);
}
export function useLiveEvents(max = 50) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const cursor = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const run = async () => {
      if (stopped) return;
      if (document.hidden) {
        setState('disconnected');
        timer = window.setTimeout(run, 5000);
        return;
      }
      setState(cursor.current ? 'reconnecting' : 'connecting');
      controller = new AbortController();
      try {
        const url = new URL(consoleApi.streamPath, window.location.origin);
        url.searchParams.set('limit', '25');
        if (cursor.current) url.searchParams.set('cursor', cursor.current);
        const res = await fetch(url.pathname + url.search, {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error('stream failed');
        const text = await res.text();
        const batch: RuntimeEvent[] = [];
        for (const frame of text.split('\n\n')) {
          const id = frame
            .split('\n')
            .find((l) => l.startsWith('id: '))
            ?.slice(4);
          const data = frame
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6);
          if (id) cursor.current = id;
          if (data) {
            const parsed = JSON.parse(data) as RuntimeEvent & {
              nextCursor?: string | null;
            };
            if ('nextCursor' in parsed)
              cursor.current = parsed.nextCursor ?? cursor.current;
            else batch.push({ ...parsed, id: parsed.id ?? id });
          }
        }
        setEvents((old) => appendDeduped(old, batch, max));
        setState('live');
        timer = window.setTimeout(run, 1000);
      } catch (e) {
        if (!stopped && (e as Error).name !== 'AbortError') {
          setState('disconnected');
          timer = window.setTimeout(run, 3000);
        }
      }
    };
    void run();
    const vis = () => {
      if (!document.hidden && !timer) void run();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [max]);
  return { events, state, cursor: cursor.current };
}
