import { useEffect, useRef, useState } from 'react';
import { consoleApi, inspectionHeaders } from '../api/client.js';

export type StreamState =
  'connecting' | 'live' | 'reconnecting' | 'disconnected';
export type RuntimeEvent = { id?: string; [key: string]: unknown };

export function appendDeduped(
  buffer: RuntimeEvent[],
  incoming: RuntimeEvent[],
  max: number,
) {
  const seen = new Set(buffer.map((event) => String(event.id ?? '')));
  const merged = [...buffer];
  for (const event of incoming) {
    const id = String(event.id ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.unshift(event);
  }
  return merged.slice(0, Math.max(1, max));
}

export function parseSseBatch(text: string) {
  const events: RuntimeEvent[] = [];
  let cursor: string | null = null;
  for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
    if (!frame.trim() || frame.startsWith(':')) continue;
    const lines = frame.split('\n');
    const id = lines
      .find((line) => line.startsWith('id:'))
      ?.slice(3)
      .trim();
    const eventType = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (id) cursor = id;
    if (!data) continue;
    const parsed = JSON.parse(data) as RuntimeEvent & {
      nextCursor?: string | null;
    };
    if (eventType === 'checkpoint' || 'nextCursor' in parsed) {
      cursor = parsed.nextCursor ?? cursor;
      continue;
    }
    events.push({ ...parsed, id: parsed.id ?? id });
  }
  return { events, cursor };
}

export function useLiveEvents(max = 50) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };

    const schedule = (delay: number) => {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = undefined;
        void run();
      }, delay);
    };

    const run = async () => {
      if (stopped) return;
      if (document.hidden) {
        setState('disconnected');
        schedule(5_000);
        return;
      }

      setState(cursor.current ? 'reconnecting' : 'connecting');
      controller?.abort();
      controller = new AbortController();
      try {
        const url = new URL(consoleApi.streamPath, window.location.origin);
        url.searchParams.set('limit', '25');
        if (cursor.current) url.searchParams.set('cursor', cursor.current);
        const response = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
          headers: inspectionHeaders('text/event-stream'),
        });
        if (!response.ok || !response.body)
          throw new Error(`stream_http_${response.status}`);

        const batch = parseSseBatch(await response.text());
        if (batch.cursor) cursor.current = batch.cursor;
        setEvents((current) => appendDeduped(current, batch.events, max));
        setState('live');
        schedule(1_000);
      } catch (error) {
        if (stopped || (error as Error).name === 'AbortError') return;
        setState('disconnected');
        schedule(3_000);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        controller?.abort();
        setState('disconnected');
        schedule(5_000);
      } else {
        clearTimer();
        void run();
      }
    };

    void run();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      controller?.abort();
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [max]);

  return { events, state, cursor: cursor.current };
}
