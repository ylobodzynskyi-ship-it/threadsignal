import test from 'node:test';
import assert from 'node:assert/strict';
import { closest, estimate, gapsFromBenchmarks, normalizePost, viral } from './analysis.js';

test('similar posts are ranked by shared topic words', () => {
  const posts = [
    { text: 'Мій досвід найму дизайнерів у стартапі', likes: 10 },
    { text: 'Як маркетинг змінює продажі у стартапі', likes: 20 }
  ];
  assert.equal(closest('Маркетинг і продажі у стартапі', posts)[0].text, posts[1].text);
});

test('estimate uses observed outcome and Jev scores', () => {
  const scores = Object.fromEntries(['hook', 'specificity', 'conversation', 'clarity'].map(key => [key, { value: .7 }]));
  const high = [{ views: 50000, followers: 1000, similarity: .7 }];
  const low = [{ views: 1000, followers: 1000, similarity: .7 }];
  assert.ok(estimate(high, scores) > estimate(low, scores));
  assert.equal(estimate([], scores), null);
  assert.equal(viral(high[0]), true);
});

test('import rejects invalid statistics', () => {
  assert.throws(() => normalizePost({ text: 'Достатньо довгий текст', views: -1 }), /views/);
});

test('gap analysis highlights dimensions where viral examples score higher', () => {
  const draft = { hook: { value: .4 }, specificity: { value: .8 }, conversation: { value: .5 }, clarity: { value: .9 } };
  const examples = [{ text: 'Сильний початок та досвід з конкретикою', url: null }];
  const ratings = [{ hook: { value: .9 }, specificity: { value: .7 }, conversation: { value: .7 }, clarity: { value: .8 } }];
  const gaps = gapsFromBenchmarks(draft, examples, ratings);
  assert.deepEqual(gaps.map(gap => gap.key), ['hook', 'conversation']);
  assert.equal(gaps[0].example.text, examples[0].text);
});
