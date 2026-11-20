"""Extract the supplied XLSX without modifying it; build the game catalogue."""
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'BestLoanList_20261119095853.xlsx'
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read_rows():
    with zipfile.ZipFile(SOURCE) as archive:
        strings = [''.join(si.itertext()) for si in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        for row in sheet.findall('.//s:sheetData/s:row', NS):
            cells = {}
            for cell in row.findall('s:c', NS):
                value = cell.find('s:v', NS)
                value = value.text if value is not None else ''
                if cell.get('t') == 's':
                    value = strings[int(value)]
                cells[re.sub(r'\d', '', cell.get('r'))] = value
            yield int(row.get('r')), cells


def main_author(text):
    text = re.sub(r'^(?:지은이|글쓴이|원작|글·그림|글|저자)\s*:\s*', '', text)
    text = re.split(r'[;,（(]', text)[0].strip()
    text = re.sub(r'\s+(?:지음|글·그림|글|그림|원작|동화|저)$', '', text)
    return text.strip()


def work_title(title):
    if title.startswith('흔한남매 과학 탐험대'):
        return '흔한남매 과학 탐험대'
    return title.strip()


def build():
    books = []
    assumptions = {
        '9791199305304': ('813.7', '원본 KDC 누락. 게임에서 한국 현대소설로 임시 분류.'),
        '9791167764119': ('813.7', '원본 KDC 누락. 게임에서 한국 현대소설로 임시 분류.'),
        **{isbn: ('400', '원본 KDC 누락. 동일 목록의 흔한남매 과학 탐험대 시리즈 분류번호 400을 게임에 적용.')
           for isbn in ['9788934940753', '9788934983439', '9788934930549', '9788934946793']},
    }
    for row_number, raw in read_rows():
        if row_number < 17:
            continue
        assert raw['A'].isdigit(), f'Unexpected row {row_number}'
        kdc = raw.get('I', '').strip()
        assigned = assumptions.get(raw['G'])
        assert kdc or assigned, f'Missing classification at {row_number}'
        book = {
            'bookId': 'isbn-' + raw['G'],
            'title': raw['B'].strip(),
            'authors': raw['C'].strip(),
            'primaryAuthor': main_author(raw['C']),
            'publisher': raw['D'].strip(),
            'publicationYear': raw['E'],
            'volume': raw['F'] or None,
            'isbn': raw['G'],
            'isbnSupplement': raw['H'] or None,
            'loanRank': int(raw['A']),
            'loanCount': int(raw['J'].replace(',', '')),
            'sourceKdc': kdc or None,
            'classification': kdc or assigned[0],
            'classificationSource': 'xlsx' if kdc else 'game_assigned',
            'classificationNote': None if kdc else assigned[1],
            'sourceRow': row_number,
            'sourceValues': raw,
        }
        books.append(book)
    assert len(books) == 200
    assert len({b['isbn'] for b in books}) == 200
    # A transparent game-specific book mark, not a library author-number table.
    # Each first-character bucket is ordered by author then work title.
    buckets = defaultdict(set)
    for book in books:
        first = book['primaryAuthor'][0]
        buckets[first].add((book['primaryAuthor'], work_title(book['title'])))
    marks = {}
    for first, works in buckets.items():
        for number, key in enumerate(sorted(works), 1):
            marks[key] = f'{first}{number:03d}'
    for book in books:
        book['bookMark'] = marks[(book['primaryAuthor'], work_title(book['title']))]
        book['callNumber'] = f"{book['classification']} {book['bookMark']}" + (f" v.{book['volume']}" if book['volume'] is not None else '')
    assert len({b['callNumber'] for b in books}) == 200
    def key(book):
        mark = book['bookMark']
        language_order = 0 if '가' <= mark[0] <= '힣' else 1
        return (Decimal(book['classification']), language_order, mark, int(book['volume']) if book['volume'] is not None else -1)
    books.sort(key=key)
    for index, book in enumerate(books):
        book['sortOrder'] = index + 1
        book['home'] = {'shelf': index // 20 + 1, 'position': index % 20 + 1}
    result = {
        'schemaVersion': 1,
        'source': {
            'file': SOURCE.name, 'sheet': '인기대출도서_전체', 'range': 'A17:J216',
            'provider': '국립중앙도서관', 'providedOn': '2026-11-19',
            'loanPeriod': {'from': '2026-01-01', 'to': '2026-11-18'},
            'license': '저작자표시(BY)',
            'attribution': '국립중앙도서관 인기대출도서 데이터 (2026-11-19 제공). 게임용 청구기호 및 배치 추가.',
        },
        'layout': {'columns': 2, 'rows': 5, 'shelfCount': 10, 'booksPerShelf': 20, 'bookCount': 200, 'numbering': 'column-major'},
        'callNumberPolicy': {
            'type': 'game_generated',
            'description': '원본 KDC + 게임용 도서기호 + 선택적 권차. 실제 소장 도서관의 청구기호가 아님.',
            'bookMark': '대표 저자 첫 글자 + 같은 첫 글자 내 저자/작품명순 3자리 일련번호. 같은 작품의 권차는 도서기호를 공유.',
            'sort': '분류번호 숫자 오름차순 → 한글 우선 → 도서기호 문자순 → 권차 숫자순 (권차 없음은 먼저).',
            'missingKdcCount': sum(b['sourceKdc'] is None for b in books),
            'placement': '정렬 후 20권씩 배치. home.shelf 및 home.position은 1부터 시작.',
        },
        'books': books,
    }
    (ROOT / 'books.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Created books.json: {len(books)} books, 10 shelves, {result["callNumberPolicy"]["missingKdcCount"]} assigned classifications')


if __name__ == '__main__':
    build()
