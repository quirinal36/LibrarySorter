"""Reconcile every exported record to the workbook, including missing/zero values."""
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_catalog import read_rows

data = json.loads((ROOT / 'books.json').read_text(encoding='utf-8'))
books = data['books']
source = {row: values for row, values in read_rows() if row >= 17}
assert len(source) == len(books) == 200
assert len({b['isbn'] for b in books}) == 200
assert len({b['callNumber'] for b in books}) == 200
assert {b['sourceRow'] for b in books} == set(source)
assert Counter(b['home']['shelf'] for b in books) == {s: 20 for s in range(1, 11)}
for b in books:
    row = source[b['sourceRow']]
    assert b['sourceValues'] == row
    for key, column in [('title', 'B'), ('authors', 'C'), ('publisher', 'D'), ('publicationYear', 'E'), ('isbn', 'G')]:
        assert b[key] == row[column].strip()
    assert b['volume'] == (row['F'] or None)
    assert b['sourceKdc'] == (row['I'] or None)
    assert b['loanRank'] == int(row['A'])
    assert b['loanCount'] == int(row['J'].replace(',', ''))
    if row['I']:
        assert b['classification'] == row['I']
        assert b['classificationSource'] == 'xlsx'
    else:
        assert b['classificationSource'] == 'game_assigned' and b['classificationNote']
assert sum(b['sourceKdc'] is None for b in books) == 6
assert any(b['volume'] == '0' and b['callNumber'].endswith('v.0') for b in books)
print('PASS: all 200 records match XLSX; 194 source KDC / 6 explicit assignments; ten 20-book shelves; volume zero preserved')
