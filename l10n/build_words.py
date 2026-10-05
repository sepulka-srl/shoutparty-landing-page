#!/usr/bin/env python3
"""Build l10n/words.json — the word samples for the localized /<code>/words/ pages.

Usage:  python3 l10n/build_words.py /path/to/ShoutParty

Reads, from the app repo, each language's shipping dictionary
(data/src/main/res/raw[-xx]/dictionary.json) and its in-app difficulty and
category names (ui/src/main/res/values[-xx]/strings.xml). Nothing is translated
here: the words and the labels are the app's own. The sample is a fixed
pseudo-random pick per language, so re-running only changes the output when the
dictionaries change.
"""
import html
import json
import os
import random
import re
import sys

LOCALES = ['ru', 'uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sr',
           'sv', 'da', 'no', 'fi', 'tr', 'he', 'hi', 'id', 'zh', 'ja', 'ko', 'ar']
CATEGORIES = ['EVERYDAY', 'ENTERTAINMENT', 'SPORTS', 'SCIENCE', 'HISTORY', 'NATURE', 'ANIMALS', 'FOOD', 'TRAVEL',
              'FASHION']
DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD']
PER_DIFFICULTY = 30  # three per category
PER_CATEGORY = {'EASY': 6, 'MEDIUM': 6, 'HARD': 4}


def labels(app, code):
    xml = open(os.path.join(app, 'ui/src/main/res', f'values-{code}', 'strings.xml'), encoding='utf-8').read()

    def get(name):
        m = re.search(r'<string name="%s">(.*?)</string>' % name, xml, re.S)
        if not m:
            sys.exit(f'{code}: string {name} missing')
        return html.unescape(m.group(1)).replace("\\'", "'").replace('\\"', '"').strip()

    return (
        {d: get('difficulty_' + d.lower()) for d in DIFFICULTIES},
        {c: get('category_' + c.lower()) for c in CATEGORIES},
    )


def sample(app, code):
    words = json.load(open(os.path.join(app, 'data/src/main/res', f'raw-{code}', 'dictionary.json'), encoding='utf-8'))
    rng = random.Random(f'shoutparty-words-{code}')
    pool = {(c, d): [] for c in CATEGORIES for d in DIFFICULTIES}
    for w in words:
        pool[(w['category'], w['difficulty'])].append(w['text'])
    for bucket in pool.values():
        rng.shuffle(bucket)

    by_difficulty = {}
    for d in DIFFICULTIES:
        picked = []
        for c in CATEGORIES:
            picked += [pool[(c, d)].pop() for _ in range(PER_DIFFICULTY // len(CATEGORIES))]
        rng.shuffle(picked)
        by_difficulty[d] = picked
    by_category = {c: [pool[(c, d)].pop() for d in DIFFICULTIES for _ in range(PER_CATEGORY[d])] for c in CATEGORIES}

    flat = [w for ws in by_difficulty.values() for w in ws] + [w for ws in by_category.values() for w in ws]
    if len(flat) != len(set(flat)):
        sys.exit(f'{code}: a word was picked twice')
    return by_difficulty, by_category


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    app = sys.argv[1]
    out = {}
    for code in LOCALES:
        difficulty_names, category_names = labels(app, code)
        by_difficulty, by_category = sample(app, code)
        out[code] = {
            'difficulties': [{'name': difficulty_names[d], 'words': by_difficulty[d]} for d in DIFFICULTIES],
            'categories': [{'name': category_names[c], 'words': by_category[c]} for c in CATEGORIES],
        }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'words.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'Wrote {path}: {len(out)} languages, '
          f'{sum(len(g["words"]) for g in out["ru"]["difficulties"] + out["ru"]["categories"])} words each')


if __name__ == '__main__':
    main()
