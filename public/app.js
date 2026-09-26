const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('uk-UA').format(value);
const shorten = text => text.length > 280 ? `${text.slice(0, 280)}…` : text;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не вдалося виконати запит.');
  return result;
}

function message(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle('error', error);
}

function setTab(tab) {
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $('analyze-view').classList.toggle('hidden', tab !== 'analyze');
  $('library-view').classList.toggle('hidden', tab !== 'library');
  $('page-name').textContent = tab === 'analyze' ? 'Аналіз поста' : 'База постів';
  if (tab === 'library') loadPosts();
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
$('draft').addEventListener('input', () => { $('char-count').textContent = `${number($('draft').value.length)} / 4 000 символів`; });
$('draft').placeholder = 'Напишіть тут свій пост для Threads...\n\nНаприклад: Що ви зрозуміли занадто пізно у своїй роботі?';

function postCard(post) {
  const card = document.createElement('article');
  card.className = 'post-card';
  const content = document.createElement('div');
  const text = document.createElement('p');
  text.textContent = shorten(post.text);
  content.append(text);
  if (post.viral) {
    const badge = document.createElement('span');
    badge.className = 'viral-badge';
    badge.textContent = '✳ Вірусний за фактичними показниками';
    content.append(badge);
  } else if (post.rankType === 'top') {
    const badge = document.createElement('span');
    badge.className = 'top-badge';
    badge.textContent = 'TOP пошуку · без підтверджених метрик';
    content.append(badge);
  }
  const meta = document.createElement('small');
  meta.textContent = `${post.author ? `@${post.author} · ` : ''}${post.source === 'threads' ? 'Threads API' : 'Імпорт'}${post.createdAt ? ` · ${new Date(post.createdAt).toLocaleDateString('uk-UA')}` : ''}`;
  content.append(meta);
  if (post.url) {
    const link = document.createElement('a');
    link.href = post.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ' · Відкрити ↗';
    content.append(link);
  }
  const stats = document.createElement('div');
  stats.className = 'post-stats';
  for (const [label, value] of [['Перегляди', post.views], ['Вподобання', post.likes], ['Відповіді', post.replies]]) {
    if (value != null) {
      const item = document.createElement('span');
      const bold = document.createElement('b');
      bold.textContent = number(value);
      item.append(bold, ` ${label}`);
      stats.append(item);
    }
  }
  card.append(content, stats);
  return card;
}

async function loadStatus() {
  const status = await api('/api/status');
  $('jev-dot').classList.toggle('ready', status.jevReady);
  $('threads-dot').classList.toggle('ready', status.threadsReady);
  $('jev-state').textContent = status.jevReady ? 'Jev підключено' : 'Jev не підключено';
  $('threads-state').textContent = status.threadsReady ? 'Threads підключено' : 'Threads не підключено';
  $('nav-count').textContent = status.count;
  $('list-count').textContent = status.count;
  $('search-button').disabled = !status.threadsReady;
  if (!status.threadsReady) message('search-message', 'Додайте THREADS_ACCESS_TOKEN до .env і перезапустіть сервер.');
}

async function loadPosts() {
  const result = await api('/api/posts');
  const list = $('library-list');
  list.replaceChildren(...result.posts.map(postCard));
}

function renderResult(result) {
  $('empty-result').classList.add('hidden');
  $('result').classList.remove('hidden');
  $('probability').textContent = result.probability == null ? '—' : `${result.probability}%`;
  $('probability-tag').textContent = result.probability == null ? 'ЩЕ НЕМАЄ ДАНИХ' : 'ЕКСПЕРИМЕНТАЛЬНА ОЦІНКА';
  const searchSummary = result.searchDetails ? `Пошук «${result.searchDetails.query}»: ${result.searchDetails.found} результатів, ${result.searchDetails.measured} з метриками.` : '';
  $('probability-note').textContent = [result.note, searchSummary, result.searchNote].filter(Boolean).join(' ');
  $('probability-fill').style.width = `${result.probability || 0}%`;
  $('sample-size').textContent = `З показниками: ${result.comparableCount} · Вірусних аналогів: ${result.viralCount} · У базі: ${result.libraryCount}`;

  const rubrics = $('rubric-list');
  rubrics.replaceChildren();
  if (result.scores) {
    Object.values(result.scores).forEach(item => {
      const row = document.createElement('div'); row.className = 'rubric-row';
      const label = document.createElement('span'); label.textContent = item.label;
      const bar = document.createElement('div'); bar.className = 'rubric-bar';
      const fill = document.createElement('span'); fill.style.width = `${Math.round(item.value * 100)}%`; bar.append(fill);
      const value = document.createElement('b'); value.textContent = `${Math.round(item.value * 100)}%`;
      row.append(label, bar, value); rubrics.append(row);
    });
  } else rubrics.textContent = 'Додайте TYPESAFE_API_KEY до .env для оцінки тексту.';

  const gaps = $('gaps-list'); gaps.replaceChildren();
  $('gaps-title').textContent = result.benchmarkType === 'viral' ? 'Чого бракує до вірусних аналогів' : result.benchmarkType === 'top' ? 'Чого бракує до TOP постів Threads' : 'Чого бракує до вірусних аналогів';
  if (result.comparisonNote) {
    const empty = document.createElement('p'); empty.className = 'gap-empty'; empty.textContent = result.comparisonNote; gaps.append(empty);
  } else if (!result.benchmarkCount) {
    const empty = document.createElement('p');
    empty.className = 'gap-empty';
    empty.textContent = 'Щоб порівняти з сильними постами, підключіть пошук Threads або додайте схожі публікації з фактичними переглядами чи реакціями.';
    gaps.append(empty);
  } else if (!result.gaps.length) {
    const empty = document.createElement('p');
    empty.className = 'gap-empty';
    empty.textContent = 'За цими чотирма критеріями чернетка не поступається знайденим аналогам.';
    gaps.append(empty);
  } else result.gaps.forEach(gap => {
    const item = document.createElement('div'); item.className = 'gap-item';
    const title = document.createElement('div'); title.className = 'gap-title';
    const label = document.createElement('b'); label.textContent = gap.label;
    const scores = document.createElement('span'); scores.textContent = `Ваш ${Math.round(gap.yourScore * 100)}% · аналоги ${Math.round(gap.benchmarkScore * 100)}%`;
    title.append(label, scores);
    const tip = document.createElement('p'); tip.textContent = gap.tip;
    const example = document.createElement('div'); example.className = 'gap-example';
    example.textContent = `Приклад: «${shorten(gap.example.text)}»`;
    item.append(title, tip, example); gaps.append(item);
  });

  const tips = $('tips-list'); tips.replaceChildren();
  const tipsData = result.suggestions.length ? result.suggestions : ['Порівняйте кілька варіантів першого рядка та залиште найсильніший.'];
  tipsData.forEach(tip => { const li = document.createElement('li'); li.textContent = tip; tips.append(li); });
  $('similar-section').classList.toggle('hidden', result.similar.length === 0);
  $('similar-list').replaceChildren(...result.similar.map(postCard));
}

$('analyze-button').addEventListener('click', async () => {
  const button = $('analyze-button');
  message('analyze-message', '');
  button.disabled = true;
  try {
    const result = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ text: $('draft').value, query: $('draft-topic').value }) });
    renderResult(result);
  } catch (error) { message('analyze-message', error.message, true); }
  finally { button.disabled = false; }
});

$('search-button').addEventListener('click', async () => {
  const button = $('search-button'); button.disabled = true;
  message('search-message', 'Шукаємо публікації...');
  try {
    const result = await api('/api/threads/search', { method: 'POST', body: JSON.stringify({ query: $('search-query').value }) });
    message('search-message', `Знайдено ${result.found} результатів, у базі ${result.saved}. З показниками: ${result.measured}.`);
    await Promise.all([loadStatus(), loadPosts()]);
  } catch (error) { message('search-message', error.message, true); }
  finally { button.disabled = false; }
});

$('import-button').addEventListener('click', async () => {
  const button = $('import-button'); button.disabled = true;
  try {
    const posts = JSON.parse($('import-json').value);
    const result = await api('/api/posts', { method: 'POST', body: JSON.stringify({ posts }) });
    message('import-message', `Імпортовано ${result.imported} постів. У базі: ${result.count}.`);
    $('import-json').value = '';
    await Promise.all([loadStatus(), loadPosts()]);
  } catch (error) { message('import-message', error.message, true); }
  finally { button.disabled = false; }
});

loadStatus().catch(error => message('analyze-message', error.message, true));
