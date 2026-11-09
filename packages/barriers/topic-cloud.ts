/** Vocabulary of already public barrier cards. This is not coding of anonymous survey responses. */
export interface PublicBarrierText {
  id: string;
  title: string | null;
  description: string | null;
  status: 'active' | 'archived';
}

export interface BarrierTopic {
  key: string;
  label: string;
  count: number;
  barrierIds: string[];
}

const stopWords = new Set([
  'а', 'безусловно', 'будет', 'будут', 'был', 'была', 'были', 'было', 'быть', 'ведь',
  'весь', 'все', 'всего', 'всей', 'всем', 'всех', 'всю', 'вся', 'для', 'его', 'ему',
  'если', 'есть', 'еще', 'здесь', 'или', 'именно', 'их', 'как', 'какая', 'какие', 'какой',
  'когда', 'которого', 'которое', 'которой', 'которому', 'которую', 'которые', 'который',
  'которым', 'которых', 'кто', 'либо', 'между', 'меня', 'мне', 'мной', 'много', 'может',
  'можно', 'мои', 'мой', 'моя', 'мое', 'нам', 'нас', 'наш', 'наша', 'наше', 'наши',
  'нашего', 'нашей', 'наших', 'нее', 'него', 'них', 'нужно', 'нужна', 'нужны', 'одна',
  'одни', 'одного', 'одно', 'одной', 'одну', 'она', 'они', 'оно', 'очень', 'пока', 'после',
  'потому', 'почему', 'при', 'про', 'просто', 'сам', 'сама', 'сами', 'самого', 'самой',
  'себе', 'себя', 'своего', 'своей', 'свои', 'своих', 'свой', 'свою', 'своя', 'свое',
  'так', 'такая', 'такие', 'таким', 'такое', 'такой', 'там', 'того', 'тоже', 'той', 'только',
  'том', 'тому', 'тут', 'уже', 'через', 'чем', 'что', 'чтобы', 'это', 'этого', 'этой', 'этом',
  'этому', 'эту', 'эти', 'этих', 'является', 'the', 'and', 'for', 'with', 'this', 'that',
]);
const negations = new Set(['не', 'нет', 'без', 'ни', 'нельзя']);
const normalize = (word: string) => word.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
const informative = (word: string) => word.length >= 3 && word.length <= 36 && !stopWords.has(word);

function terms(text: string): Set<string> {
  const result = new Set<string>();
  // Sentence boundaries prevent a negation from attaching to the next sentence.
  for (const part of text.split(/[.!?;:\n]+/u)) {
    const words = normalize(part).match(/[\p{L}]+(?:-[\p{L}]+)*/gu) ?? [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (negations.has(word)) {
        let next = i + 1;
        // Skip pronouns, but never jump through another negation or a conjunction.
        while (next < words.length && next <= i + 3 && stopWords.has(words[next]) &&
          !['или', 'что', 'чтобы', 'потому'].includes(words[next])) next++;
        if (next < words.length && next <= i + 3 && informative(words[next]) && !negations.has(words[next])) {
          result.add(`${word} ${words[next]}`);
          i = next;
        }
      } else if (informative(word)) result.add(word);
    }
  }
  return result;
}

/** Exact normalized vocabulary, once per card ID. No stemming, inferred synonyms or author count. */
export function collectBarrierTopics(
  cards: readonly PublicBarrierText[] | null | undefined,
  limit = 32,
): BarrierTopic[] {
  const mentions = new Map<string, Set<string>>();
  for (const card of cards ?? []) {
    if (card.status !== 'active') continue;
    const unique = terms(`${card.title ?? ''}\n${card.description ?? ''}`);
    for (const key of unique) {
      const ids = mentions.get(key) ?? new Set<string>();
      ids.add(card.id);
      mentions.set(key, ids);
    }
  }
  return [...mentions].map(([key, ids]) => ({
    key, label: key, count: ids.size, barrierIds: [...ids].sort(),
  })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ru'))
    .slice(0, Number.isInteger(limit) ? Math.max(0, Math.min(60, limit)) : 32);
}
