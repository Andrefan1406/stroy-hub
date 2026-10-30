// Сравнение названий улиц: казахские буквы, окончания фамилий, опечатки,
// типы улиц и номер дома (streetMatch.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kzToRu, fold, parseQuery, matchResult } = require('../streetMatch');

const item = (road, house, extra = {}) => ({ place_rank: 30, address: { road, house_number: house }, ...extra });

test('казахские буквы приводятся к русским', () => {
  assert.equal(fold('Әл-Фараби'), 'ал фараби');
  assert.equal(fold('ҒАБДУЛЛИН'), 'габдуллин');
  assert.equal(fold('Қайсенов'), 'каисенов');
  assert.equal(fold('Жаңа Өскемен'), 'жана оскемен');
  assert.equal(fold('Ұлы Дүкенов'), 'улы дукенов');
  assert.equal(fold('Қожаһмет Бірлік'), 'кожахмет бирлик');
  assert.equal(fold('Ёлка Мойка'), 'елка моика');
});

test('в запросе отделяются улица и номер дома, тип улицы не мешает', () => {
  assert.deepEqual(parseQuery('ул. Кайсенова, 119'), { words: ['каисен'], house: '119' });
  assert.deepEqual(parseQuery('проспект Назарбаева д. 50А'), { words: ['назарба'], house: '50а' });
  assert.equal(parseQuery('мкр 12, дом 5').house, '5');
});

test('та же улица в другом написании подходит', () => {
  for (const [q, road] of [
    ['Кайсенова 7', 'улица Кайсенов'],
    ['Қайсенов 7', 'улица Кайсенова'],
    ['ул Протозанова 7', 'Протозанова көшесі'],
    ['Протазанова 7', 'улица Протозанова'], // опечатка в одну букву
    ['Аль-Фараби 7', 'улица Әл-Фараби'],
  ]) {
    assert.ok(matchResult(q, item(road, '7'), 28), `${q} ~ ${road}`);
  }
});

test('другая улица не подходит, даже если номер дома тот же', () => {
  assert.equal(matchResult('Кайсенова 119', item('улица Бажова', '119'), 28), null);
  assert.equal(matchResult('Кайсенова 119', item('улица Бажова', undefined, { name: 'Qazaq Oil' }), 28), null);
  assert.equal(matchResult('119', item('улица Бажова', '119'), 28), null, 'одни цифры — не за что зацепиться');
});

test('номер дома не совпал или не указан в ответе — только улица', () => {
  assert.equal(matchResult('Протозанова 10', item('улица Протозанова', '10'), 28).precise, true);
  assert.equal(matchResult('Протозанова 10а', item('улица Протозанова', '10 А'), 28).precise, true);
  assert.equal(matchResult('Протозанова 10', item('улица Протозанова', '10/1'), 28).precise, true);
  assert.equal(matchResult('Протозанова 10', item('улица Протозанова', '12'), 28).precise, false);
  assert.equal(matchResult('Протозанова 10', item('улица Протозанова', undefined), 28).precise, false);
  assert.equal(matchResult('Протозанова', item('улица Протозанова', undefined, { place_rank: 26 }), 28).precise, false);
  assert.equal(matchResult('Кайсенова', item('улица Кайсенова', '34', { name: 'Касым кайсенова 34' }), 28).precise, false, 'улица без дома — не здание');
});

test('организация находится по названию, подпись — как на карте', () => {
  const m = matchResult('Штабы', { place_rank: 30, name: 'Штабы', address: { road: 'улица Ленина' } }, 28);
  assert.deepEqual(m, { precise: true, matched: 'Штабы, улица Ленина' });
});

test('казахские буквы для запроса к карте заменяются русскими с сохранением регистра', () => {
  assert.equal(kzToRu('Әл-Фараби, Қайсенов 119'), 'Ал-Фараби, Кайсенов 119');
  assert.equal(kzToRu('ҚАЙСЕНОВ Ұлы Бірлік'), 'КАЙСЕНОВ Улы Бирлик');
  assert.equal(kzToRu('улица Ленина'), 'улица Ленина');
});
