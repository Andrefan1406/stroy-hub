import { clearSubmissionId, getSubmissionId } from './submissionId';

beforeEach(() => localStorage.clear());

test('повтор тех же данных — тот же ID, в том числе после «перезагрузки»', () => {
  const payload = [{ date: '2026-11-13', object: 'Дом 63' }];
  const a = getSubmissionId('t', payload);
  expect(a).toBeTruthy();
  expect(getSubmissionId('t', [{ date: '2026-11-13', object: 'Дом 63' }])).toBe(a);
});

test('данные изменились — новый ID', () => {
  const a = getSubmissionId('t', [{ object: 'Дом 63' }]);
  const b = getSubmissionId('t', [{ object: 'Дом 64' }]);
  expect(b).not.toBe(a);
});

test('после успеха ID сбрасывается: такая же заявка уходит как новая', () => {
  const payload = [{ object: 'Дом 63' }];
  const a = getSubmissionId('t', payload);
  clearSubmissionId('t');
  expect(getSubmissionId('t', payload)).not.toBe(a);
});

test('разные формы не мешают друг другу', () => {
  const payload = [{ x: 1 }];
  expect(getSubmissionId('elec', payload)).not.toBe(getSubmissionId('geo', payload));
});
