/**
 * Reads the chat endpoint's server-sent event stream.
 *
 * `EventSource` cannot do this: the chat endpoint is a POST with a body, and
 * `EventSource` only issues GETs. So this parses the SSE framing off a `fetch`
 * body stream by hand. That is a small amount of code and the alternative was
 * worse — turning the conversation into a GET with the transcript in a query
 * string, or opening a second channel keyed by a session id the server would
 * then have to hold, when the whole point of the endpoint is that it is
 * stateless and the transcript lives in the client.
 *
 * The framing is the SSE minimum the server actually emits: `event:` and
 * `data:` lines, one blank line between frames. No `id:`, no retry directives,
 * no multi-line data — and if the server ever sends those, the frames are
 * ignored rather than misparsed.
 */

export interface ChatStreamEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface ChatStreamOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tenant?: string;
  identity?: string;
  signal?: AbortSignal;
  onEvent: (e: ChatStreamEvent) => void;
}

export async function streamChat(opts: ChatStreamOptions): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      messages: opts.messages,
      ...(opts.tenant ? { tenant: opts.tenant } : {}),
      ...(opts.identity ? { identity: opts.identity } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // A non-streaming error response (the route is missing, or an older panel
  // process is running) arrives as JSON with a status. Surface it as an error
  // event so the caller has one code path rather than two.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {
        error:
          res.status === 404
            ? 'this panel process does not have the /api/chat route — restart it'
            : `chat request failed (${res.status})`,
      };
    }
    opts.onEvent({ type: 'error', data: { status: res.status, ...body } });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    opts.onEvent({ type: 'error', data: { error: 'the browser gave no readable response body' } });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line. Anything after the last separator
    // is a partial frame and stays in the buffer for the next chunk.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let type = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;

      try {
        opts.onEvent({ type, data: JSON.parse(data) as Record<string, unknown> });
      } catch {
        /* a frame we cannot parse is dropped rather than breaking the stream */
      }
    }
  }
}
