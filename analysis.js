export const RUBRICS = {
  hook: {
    label: 'Перший рядок',
    instructions: 'Наскільки перший рядок post.text зупиняє прокручування стрічки Threads? Оціни лише силу першого рядка.',
    criteria: ['Початок загальний або незрозумілий.', 'Тема зрозуміла, але інтриги мало.', 'Є конкретна думка, несподіванка або напруга, яка спонукає читати далі.'],
    tip: 'Почніть із конкретного висновку, контрасту або неочікуваного факту.'
  },
  specificity: {
    label: 'Конкретність',
    instructions: 'Наскільки post.text містить конкретні деталі, приклад або перевірювану тезу? Не оцінюй стиль чи популярність теми.',
    criteria: ['Загальні слова без прикладу.', 'Є одна конкретна деталь або приклад.', 'Є виразна теза і деталь, яка робить її переконливою.'],
    tip: 'Додайте приклад, число або коротку історію замість загального твердження.'
  },
  conversation: {
    label: 'Привід відповісти',
    instructions: 'Наскільки post.text дає читачеві природний привід відповісти власним досвідом або поглядом? Не винагороджуй штучне прохання поставити лайк.',
    criteria: ['Відповісти майже нічого.', 'Можна висловити думку, але розмова не виникає сама.', 'Є конкретна відкрита напруга або запитання, на яке хочеться відповісти.'],
    tip: 'Залиште читачеві одне конкретне питання або тезу, з якою можна сперечатися.'
  },
  clarity: {
    label: 'Ясність',
    instructions: 'Наскільки легко зрозуміти головну думку post.text після одного прочитання?',
    criteria: ['Головна думка губиться.', 'Сенс зрозумілий після уважного читання.', 'Головна думка відразу зрозуміла.'],
    tip: 'Скоротіть вступ і залиште одну головну думку.'
  }
};

const stopwords = new Set('і й та а але або що це той ця ці для про від після якщо як коли де хто який яка які його її вони вона він ми ви не на у в з із до по за то є було буде вже дуже тут там мені тебе мене цей цю тих також ще просто саме'.split(' '));

export function words(text) {
  return [...new Set((text.toLocaleLowerCase('uk').match(/[\p{L}\p{N}]{3,}/gu) || []).filter(word => !stopwords.has(word)))];
}

export function similarity(a, b) {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return common / Math.sqrt(left.size * right.size);
}

export function engagement(post) {
  return (post.likes || 0) + 2 * (post.replies || 0) + 3 * (post.reposts || 0);
}

export function viral(post) {
  if (post.views != null && post.followers != null && post.followers > 0) {
    return post.views >= 10000 && post.views / post.followers >= 5;
  }
  if (post.views != null) return post.views >= 10000;
  return engagement(post) >= 300;
}

export function personalViewThreshold(posts) {
  const views = posts.filter(post => post.source === 'threads-own' && Number.isFinite(post.views))
    .map(post => post.views).sort((a, b) => a - b);
  if (views.length < 20) return null;
  return views[Math.floor((views.length - 1) * .8)];
}

export function closest(text, posts, count = 8) {
  return posts.map(post => ({ ...post, similarity: similarity(text, post.text) }))
    .filter(post => post.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || engagement(b) - engagement(a))
    .slice(0, count);
}

export function estimate(matches, scores, successful = viral, baseline = .5) {
  if (!matches.length || !scores) return null;
  const weighted = matches.reduce((sum, post) => sum + Math.max(.15, post.similarity) * Number(successful(post)), 0);
  const weight = matches.reduce((sum, post) => sum + Math.max(.15, post.similarity), 0);
  const observedRate = (weighted + 2 * baseline) / (weight + 2);
  const quality = Object.values(scores).reduce((sum, item) => sum + item.value, 0) / Object.keys(scores).length;
  const adjustment = Math.exp((quality - .5) * 1.2);
  const odds = observedRate / (1 - observedRate) * adjustment;
  return Math.round(100 * odds / (1 + odds));
}

export function suggestions(scores) {
  return Object.entries(scores).sort((a, b) => a[1].value - b[1].value).slice(0, 2)
    .filter(([, item]) => item.value < .75)
    .map(([key]) => RUBRICS[key].tip);
}

export function gapsFromBenchmarks(draftScores, benchmarkPosts, benchmarkScores) {
  if (!draftScores || !benchmarkPosts.length) return [];
  return Object.entries(RUBRICS).map(([key, rubric]) => {
    const values = benchmarkScores.map(item => item[key]?.value).filter(Number.isFinite);
    if (!values.length) return null;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const difference = average - draftScores[key].value;
    if (difference < .1) return null;
    const strongestIndex = benchmarkScores.reduce((best, item, index) => item[key]?.value > (benchmarkScores[best]?.[key]?.value ?? -1) ? index : best, 0);
    return {
      key, label: rubric.label, yourScore: draftScores[key].value,
      benchmarkScore: average, difference, tip: rubric.tip,
      example: { text: benchmarkPosts[strongestIndex].text.slice(0, 280), url: benchmarkPosts[strongestIndex].url }
    };
  }).filter(Boolean).sort((a, b) => b.difference - a.difference);
}

export function normalizePost(raw, source = 'import') {
  if (!raw || typeof raw.text !== 'string' || raw.text.trim().length < 8) throw new Error('Кожен пост має містити text від 8 символів.');
  const number = value => value == null || value === '' ? null : Number(value);
  const post = {
    id: String(raw.id || raw.url || crypto.randomUUID()),
    text: raw.text.trim().slice(0, 4000),
    url: typeof raw.url === 'string' && /^https:\/\/(www\.)?threads\.(?:net|com)\//.test(raw.url) ? raw.url : null,
    author: typeof raw.author === 'string' ? raw.author.slice(0, 100) : null,
    createdAt: raw.createdAt && !Number.isNaN(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : null,
    rankType: raw.rankType === 'top' ? 'top' : raw.rankType === 'recent' ? 'recent' : null,
    source
  };
  for (const field of ['views', 'followers', 'likes', 'replies', 'reposts']) {
    post[field] = number(raw[field]);
    if (post[field] != null && (!Number.isFinite(post[field]) || post[field] < 0)) throw new Error(`Некоректне поле ${field}.`);
  }
  return post;
}
