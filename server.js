import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closest, estimate, gapsFromBenchmarks, normalizePost, personalViewThreshold, RUBRICS, suggestions, viral, words } from './analysis.js';
import { fetchOwnPosts } from './threads-own.js';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const env = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* Optional local configuration. */ }

const dataPath = path.join(root, 'data', 'posts.json');
let posts = [];
let syncInProgress = false;
try { posts = JSON.parse(await readFile(dataPath, 'utf8')); } catch { /* Empty library on first run. */ }

const save = async () => {
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, JSON.stringify(posts, null, 2));
};
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body(req) {
  let chunks = '';
  for await (const chunk of req) {
    chunks += chunk;
    if (chunks.length > 1_000_000) throw new Error('Запит завеликий.');
  }
  try { return JSON.parse(chunks); } catch { throw new Error('Очікувався коректний JSON.'); }
}

async function jev(text, candidates) {
  if (!process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY === 'your_key_here') return null;
  const questions = Object.fromEntries(Object.entries(RUBRICS).map(([key, rubric]) => [key, {
    type: 'score', instructions: rubric.instructions, criteria: rubric.criteria
  }]));
  candidates.forEach((_, index) => {
    questions[`similar_${index}`] = {
      type: 'noul',
      instructions: `Чи є candidates[${index}].text змістовно релевантним прикладом для post.text — про ту саму проблему, досвід або тему? Не вимагай дослівного збігу.`,
      criteria: { true: 'Корисний змістовий аналог.', false: 'Інша тема або лише випадкові спільні слова.' }
    };
  });
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { post: { text }, candidates: candidates.map(post => ({ text: post.text.slice(0, 700) })) }, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Jev: HTTP ${response.status}. Перевірте ключ і ліміт API.`);
  const result = await response.json();
  const scores = Object.fromEntries(Object.entries(RUBRICS).map(([key, rubric]) => {
    const answer = result.answers?.[key];
    if (answer?.type !== 'score' || !Number.isFinite(answer.score)) throw new Error('Jev повернув неповну оцінку.');
    return [key, { label: rubric.label, value: Math.max(0, Math.min(1, answer.score / 2)), confidence: answer.confidence }];
  }));
  const relevance = candidates.map((_, index) => {
    const answer = result.answers?.[`similar_${index}`];
    return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : 0;
  });
  return { scores, relevance };
}

async function jevBenchmarks(benchmarkPosts) {
  if (!benchmarkPosts.length) return [];
  const questions = {};
  benchmarkPosts.forEach((_, index) => {
    for (const [key, rubric] of Object.entries(RUBRICS)) {
      questions[`post_${index}_${key}`] = {
        type: 'score',
        instructions: `${rubric.instructions.replaceAll('post.text', `posts[${index}].text`)} Оціни лише posts[${index}].text.`,
        criteria: rubric.criteria
      };
    }
  });
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { posts: benchmarkPosts.map(post => ({ text: post.text.slice(0, 700) })) }, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Jev: HTTP ${response.status}. Не вдалося порівняти вірусні пости.`);
  const result = await response.json();
  return benchmarkPosts.map((_, index) => Object.fromEntries(Object.keys(RUBRICS).map(key => {
    const answer = result.answers?.[`post_${index}_${key}`];
    return [key, { value: answer?.type === 'score' && Number.isFinite(answer.score) ? Math.max(0, Math.min(1, answer.score / 2)) : null }];
  })));
}

async function jevSearchQuery(text) {
  const tokens = words(text).slice(0, 14);
  if (!tokens.length) return null;
  const options = [...new Set([...tokens, ...tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`)])].slice(0, 27);
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: { text }, model: 'jev-latest',
      questions: { query: {
        type: 'choice',
        instructions: 'Обери з доступних варіантів найкращий пошуковий запит для пошуку постів Threads про ту саму конкретну тему, що і text. Віддавай перевагу змістовній темі, а не словам про час, кількість чи сам факт публікації. Якщо жоден варіант не передає тему, обери none.',
        criteria: { ...Object.fromEntries(options.map(option => [option, null])), none: 'Немає змістовного пошукового запиту серед варіантів.' }
      } }
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Jev: HTTP ${response.status}. Не вдалося обрати тему пошуку.`);
  const result = await response.json();
  const choice = result.answers?.query?.choice;
  return options.includes(choice) ? choice : null;
}

async function threadsSearch(query, mode) {
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) throw new Error('Додайте THREADS_ACCESS_TOKEN до .env для пошуку в Threads.');
  const url = new URL('https://graph.threads.net/v1.0/keyword_search');
  url.searchParams.set('q', query);
  url.searchParams.set('search_type', mode);
  url.searchParams.set('fields', 'id,text,permalink,username,timestamp');
  url.searchParams.set('limit', '50');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Threads: HTTP ${response.status}`);
  return (result.data || []).filter(item => item.text).map(item => normalizePost({
    id: item.id, text: item.text, url: item.permalink, author: item.username, createdAt: item.timestamp,
    views: item.views, likes: item.like_count, replies: item.reply_count, reposts: item.repost_count,
    rankType: mode === 'TOP' ? 'top' : 'recent'
  }, 'threads'));
}

async function collectThreads(query) {
  const [top, recent] = await Promise.all([threadsSearch(query, 'TOP'), threadsSearch(query, 'RECENT')]);
  const found = [];
  const seen = new Set();
  for (const post of [...top, ...recent]) {
    if (!seen.has(post.id) && found.length < 10) { found.push(post); seen.add(post.id); }
  }
  const byId = new Map(posts.map(post => [post.id, post]));
  found.forEach(post => {
    const previous = byId.get(post.id);
    if (previous) {
      for (const field of ['views', 'followers', 'likes', 'replies', 'reposts']) {
        if (post[field] == null) post[field] = previous[field];
      }
      if (previous.source === 'threads-own') post.source = previous.source;
    }
    byId.set(post.id, post);
  });
  posts = [...byId.values()].slice(-5000);
  await save();
  return { found: top.length + recent.length, saved: posts.length, measured: found.filter(post => post.views != null || post.likes != null || post.replies != null || post.reposts != null).length };
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, {
      jevReady: Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY !== 'your_key_here'),
      threadsReady: Boolean(process.env.THREADS_ACCESS_TOKEN),
      count: posts.length,
      measured: posts.filter(post => post.views != null || post.likes != null || post.replies != null || post.reposts != null).length,
      ownCount: posts.filter(post => post.source === 'threads-own').length,
      ownMeasured: posts.filter(post => post.source === 'threads-own' && post.views != null).length,
      syncInProgress
    });
    if (url.pathname === '/api/posts' && req.method === 'GET') return json(res, 200, {
      posts: [...posts].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 100)
    });
    if (url.pathname === '/api/posts' && req.method === 'POST') {
      const input = await body(req);
      if (!Array.isArray(input.posts) || input.posts.length > 500) throw new Error('Передайте масив posts до 500 елементів.');
      const incoming = input.posts.map(post => normalizePost(post));
      const byId = new Map(posts.map(post => [post.id, post]));
      incoming.forEach(post => byId.set(post.id, post));
      posts = [...byId.values()].slice(-5000);
      await save();
      return json(res, 200, { imported: incoming.length, count: posts.length });
    }
    if (url.pathname === '/api/threads/search' && req.method === 'POST') {
      const input = await body(req);
      const query = String(input.query || '').trim();
      if (query.length < 2 || query.length > 100) throw new Error('Введіть тему пошуку від 2 до 100 символів.');
      return json(res, 200, await collectThreads(query));
    }
    if (url.pathname === '/api/threads/sync-own' && req.method === 'POST') {
      if (syncInProgress) return json(res, 409, { error: 'Синхронізація вже триває.' });
      syncInProgress = true;
      try {
        const result = await fetchOwnPosts(process.env.THREADS_ACCESS_TOKEN);
        const byId = new Map(posts.map(post => [post.id, post]));
        for (const post of result.posts) {
          const previous = byId.get(post.id);
          if (previous) for (const field of ['views', 'likes', 'replies', 'reposts']) {
            if (post[field] == null) post[field] = previous[field];
          }
          byId.set(post.id, post);
        }
        posts = [...byId.values()].slice(-5000);
        await save();
        return json(res, 200, { username: result.username, fetched: result.fetched, imported: result.posts.length, measured: result.measured, failed: result.failed, skipped: result.skipped, count: posts.length });
      } finally { syncInProgress = false; }
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const input = await body(req);
      const text = String(input.text || '').trim();
      if (text.length < 15 || text.length > 4000) throw new Error('Чернетка має містити від 15 до 4000 символів.');
      let searchNote = null;
      let searchDetails = null;
      if (process.env.THREADS_ACCESS_TOKEN) {
        const chosenQuery = String(input.query || '').trim();
        if (chosenQuery.length > 100) throw new Error('Тема пошуку завелика.');
        let query = chosenQuery;
        if (!query && process.env.TYPESAFE_API_KEY) {
          try { query = await jevSearchQuery(text) || ''; }
          catch (error) { searchNote = error.message; }
        }
        if (!query) query = words(text).slice(0, 2).join(' ');
        if (query.length >= 2) {
          try { searchDetails = { query, ...await collectThreads(query) }; }
          catch (error) { searchNote = `Пошук Threads: ${error.message}`; }
        }
      }
      const candidates = closest(text, posts, 15);
      const judgment = await jev(text, candidates);
      const scores = judgment?.scores || null;
      const matches = judgment ? candidates.map((post, index) => ({ ...post, relevance: judgment.relevance[index] }))
        .filter(post => post.relevance >= .3).sort((a, b) => b.relevance - a.relevance).slice(0, 8) : candidates.slice(0, 8);
      const ownThreshold = personalViewThreshold(posts);
      const ownMode = ownThreshold != null;
      const measured = matches.filter(post => ownMode ? post.source === 'threads-own' && post.views != null : post.views != null || post.likes != null || post.replies != null || post.reposts != null);
      const successful = ownMode ? post => post.views >= ownThreshold : viral;
      const ownHistory = ownMode ? posts.filter(post => post.source === 'threads-own' && post.views != null) : [];
      const baseline = ownMode ? ownHistory.filter(successful).length / ownHistory.length : .5;
      const probability = estimate(measured, scores, successful, baseline);
      const strongMatches = matches.filter(post => measured.includes(post) && successful(post)).sort((a, b) => b.relevance - a.relevance);
      const topMatches = matches.filter(post => post.rankType === 'top' && !strongMatches.includes(post)).sort((a, b) => b.relevance - a.relevance);
      const benchmarkType = strongMatches.length ? ownMode ? 'own-strong' : 'viral' : topMatches.length ? 'top' : null;
      const benchmarkPosts = (strongMatches.length ? strongMatches : topMatches).slice(0, 3);
      let benchmarkScores = [];
      let comparisonNote = null;
      if (scores && benchmarkPosts.length) {
        try { benchmarkScores = await jevBenchmarks(benchmarkPosts); }
        catch (error) { comparisonNote = error.message; }
      }
      const gaps = gapsFromBenchmarks(scores, benchmarkPosts, benchmarkScores);
      const orderedMatches = [...strongMatches, ...topMatches, ...matches.filter(post => !strongMatches.includes(post) && !topMatches.includes(post))];
      return json(res, 200, {
        scores, probability, probabilityMode: ownMode ? 'personal' : 'viral',
        probabilityGoal: ownMode ? `Щонайменше ${ownThreshold} переглядів — 80-й перцентиль ваших постів` : 'Досягти порогу вірусності',
        similar: orderedMatches.slice(0, 5).map(post => ({ ...post, viral: measured.includes(post) && viral(post), strong: ownMode && measured.includes(post) && successful(post) })),
        comparableCount: measured.length, viralCount: matches.filter(post => measured.includes(post) && viral(post)).length,
        strongCount: strongMatches.length, libraryCount: posts.length,
        benchmarkType, benchmarkCount: benchmarkPosts.length, gaps, comparisonNote,
        suggestions: scores ? suggestions(scores) : [],
        note: !scores ? 'Додайте ключ Jev для семантичної оцінки.' : !measured.length ? 'Потрібні схожі власні пости з реальними переглядами для відсотка.' : ownMode ? 'Експериментальна оцінка на основі вашої історії та Jev. Вона ще не перевірена на відкладених постах.' : 'Експериментальна оцінка на основі схожих постів і Jev; перевірте її на історичних даних.',
        searchNote, searchDetails
      });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Метод не підтримується.' });
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!['/index.html', '/style.css', '/app.js'].includes(pathname)) return json(res, 404, { error: 'Не знайдено.' });
    const content = await readFile(path.join(root, 'public', pathname));
    res.writeHead(200, { 'Content-Type': mime[path.extname(pathname)], 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch (error) {
    json(res, error.message?.startsWith('Jev:') || error.message?.startsWith('Threads:') ? 502 : 400, { error: error.message || 'Помилка сервера.' });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Threads Analyser: http://localhost:${port}`));
