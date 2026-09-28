import { normalizePost } from './analysis.js';

const base = 'https://graph.threads.net/v1.0';
const metrics = ['views', 'likes', 'replies', 'reposts'];

async function request(path, token, fetchImpl) {
  const response = await fetchImpl(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Threads: ${result.error?.message || `HTTP ${response.status}`}`);
  return result;
}

export function parseInsights(data) {
  const values = {};
  for (const item of data || []) {
    if (!metrics.includes(item.name)) continue;
    const raw = item.total_value?.value ?? item.values?.[0]?.value;
    const value = raw == null ? null : Number(raw);
    if (Number.isFinite(value) && value >= 0) values[item.name] = value;
  }
  return values;
}

export async function fetchOwnPosts(token, { fetchImpl = fetch, maxPosts = 200 } = {}) {
  if (!token) throw new Error('Threads: токен не налаштовано.');
  const account = await request('/me?fields=id,username', token, fetchImpl);
  if (!account.id || !account.username) throw new Error('Threads: не вдалося визначити акаунт.');
  const found = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ fields: 'id,text,permalink,timestamp,username,media_type', limit: String(Math.min(100, maxPosts - found.length)) });
    if (cursor) params.set('after', cursor);
    const page = await request(`/me/threads?${params}`, token, fetchImpl);
    found.push(...(page.data || []));
    const nextCursor = page.paging?.cursors?.after;
    cursor = page.paging?.next && nextCursor && nextCursor !== cursor ? nextCursor : null;
  } while (cursor && found.length < maxPosts);

  const posts = found.filter(item => item.id && typeof item.text === 'string' && item.text.trim().length >= 8)
    .map(item => normalizePost({ id: item.id, text: item.text, url: item.permalink, author: item.username || account.username, createdAt: item.timestamp }, 'threads-own'));
  let measured = 0;
  let failed = 0;
  for (let index = 0; index < posts.length; index += 4) {
    await Promise.all(posts.slice(index, index + 4).map(async post => {
      try {
        const params = new URLSearchParams({ metric: metrics.join(',') });
        const insights = await request(`/${encodeURIComponent(post.id)}/insights?${params}`, token, fetchImpl);
        Object.assign(post, parseInsights(insights.data));
        if (post.views != null) measured++;
      } catch { failed++; }
    }));
  }
  return { username: account.username, fetched: found.length, skipped: found.length - posts.length, measured, failed, posts };
}
