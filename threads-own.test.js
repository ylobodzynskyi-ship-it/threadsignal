import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOwnPosts, parseInsights } from './threads-own.js';

test('parseInsights keeps zero and ignores missing metrics', () => {
  assert.deepEqual(parseInsights([
    { name: 'views', values: [{ value: 0 }] },
    { name: 'likes', total_value: { value: 12 } },
    { name: 'replies', values: [] },
    { name: 'quotes', values: [{ value: 2 }] }
  ]), { views: 0, likes: 12 });
});

test('fetchOwnPosts paginates own posts and uses only real Insights', async () => {
  const paths = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    let data;
    if (parsed.pathname.endsWith('/me')) data = { id: 'user-1', username: 'owner' };
    else if (parsed.pathname.endsWith('/me/threads') && !parsed.searchParams.has('after')) data = {
      data: [{ id: 'one', text: 'Достатньо довгий перший пост', timestamp: '2026-09-01T12:00:00Z' }, { id: 'empty', text: 'x' }],
      paging: { next: 'https://graph.threads.net/next', cursors: { after: 'cursor-1' } }
    };
    else if (parsed.pathname.endsWith('/me/threads')) data = { data: [{ id: 'two', text: 'Достатньо довгий другий пост' }] };
    else if (parsed.pathname.endsWith('/one/insights')) data = { data: [{ name: 'views', values: [{ value: 100 }] }, { name: 'likes', values: [{ value: 5 }] }] };
    else data = { data: [{ name: 'likes', values: [{ value: 3 }] }] };
    return { ok: true, json: async () => data };
  };
  const result = await fetchOwnPosts('test-token', { fetchImpl, maxPosts: 10 });
  assert.equal(result.username, 'owner');
  assert.equal(result.fetched, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.measured, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.posts[0].views, 100);
  assert.equal(result.posts[1].views, null);
  assert.equal(result.posts[1].likes, 3);
  assert.ok(paths.some(path => path.includes('after=cursor-1')));
});
