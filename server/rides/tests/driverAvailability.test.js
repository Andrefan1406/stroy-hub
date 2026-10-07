// Занятость водителя по пересечению интервалов заявок (driverAvailability.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, seedPeople, insertRequest } = require('./helpers');

const { db } = setupRidesTestApp();
const {
  requestInterval,
  intervalsOverlap,
  findDriverConflict,
  syncDriverStatus,
  DRIVER_BUFFER_MINUTES,
  DEFAULT_TRIP_MINUTES,
} = require('../driverAvailability');

const { employeeId, driver1 } = seedPeople(db);
const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const MIN = 60000;

// Водитель 1 закреплён за заявкой на 07.01.2030 17:00, поездка 60 мин.
const future = insertRequest(db, { employeeId, requestedAt: '2030-01-07T17:00', status: 'assigned', driverId: driver1 });

test('закрепление на будущую дату не делает водителя занятым на более раннюю дату', () => {
  const earlier = insertRequest(db, { employeeId, requestedAt: '2030-01-06T10:00' });
  assert.equal(findDriverConflict(db, driver1, row(earlier)), null);
  const sameDayEarlier = insertRequest(db, { employeeId, requestedAt: '2030-01-07T09:00' });
  assert.equal(findDriverConflict(db, driver1, row(sameDayEarlier)), null);
});

test('реальное пересечение по времени — конфликт', () => {
  const overlapping = insertRequest(db, { employeeId, requestedAt: '2030-01-07T17:30' });
  assert.equal(findDriverConflict(db, driver1, row(overlapping))?.id, future);
  const coveringStart = insertRequest(db, { employeeId, requestedAt: '2030-01-07T16:30', durationMin: 45 });
  assert.equal(findDriverConflict(db, driver1, row(coveringStart))?.id, future);
});

test(`запас ${DRIVER_BUFFER_MINUTES} мин: после заказа 17:00–18:00 следующая подача — со слота 18:15`, () => {
  // Время подачи выбирается слотами по 15 мин. Ровно в момент окончания
  // поездки (18:00) машина ещё не доехала до следующей подачи.
  const atEnd = insertRequest(db, { employeeId, requestedAt: '2030-01-07T18:00' });
  assert.equal(findDriverConflict(db, driver1, row(atEnd))?.id, future);
  const nextSlot = insertRequest(db, { employeeId, requestedAt: '2030-01-07T18:15' });
  assert.equal(findDriverConflict(db, driver1, row(nextSlot)), null);
});

test('поездка закончилась не ровно по слоту — следующий свободный слот через 15 мин после окончания', () => {
  // 10:00 + 65 мин = 11:05 → +15 мин = 11:20 → первый слот 11:30, 11:15 занят.
  const longer = insertRequest(db, { employeeId, requestedAt: '2030-01-10T10:00', durationMin: 65, status: 'assigned', driverId: driver1 });
  const at1115 = insertRequest(db, { employeeId, requestedAt: '2030-01-10T11:15' });
  assert.equal(findDriverConflict(db, driver1, row(at1115))?.id, longer);
  const at1130 = insertRequest(db, { employeeId, requestedAt: '2030-01-10T11:30' });
  assert.equal(findDriverConflict(db, driver1, row(at1130)), null);
});

test(`маршрут не построен — поездка считается длиной ${DEFAULT_TRIP_MINUTES} мин`, () => {
  // 12:00 без оценки маршрута → занят до 12:30, с запасом следующая подача — с 12:45.
  const unknown = insertRequest(db, { employeeId, requestedAt: '2030-01-11T12:00', durationMin: null, status: 'assigned', driverId: driver1 });
  assert.equal(DEFAULT_TRIP_MINUTES, 30);
  assert.equal(findDriverConflict(db, driver1, row(insertRequest(db, { employeeId, requestedAt: '2030-01-11T12:30' })))?.id, unknown);
  assert.equal(findDriverConflict(db, driver1, row(insertRequest(db, { employeeId, requestedAt: '2030-01-11T12:45' }))), null);
});

test('завершённые и отменённые заявки водителя не занимают время', () => {
  const done = insertRequest(db, { employeeId, requestedAt: '2030-01-08T10:00', status: 'completed', driverId: driver1 });
  const cancelled = insertRequest(db, { employeeId, requestedAt: '2030-01-08T12:00', status: 'cancelled', driverId: driver1 });
  for (const at of ['2030-01-08T10:00', '2030-01-08T12:00']) {
    assert.equal(findDriverConflict(db, driver1, row(insertRequest(db, { employeeId, requestedAt: at }))), null);
  }
  assert.ok(done && cancelled);
});

test('интервал начатой поездки — до прогноза окончания, но не раньше «сейчас»', () => {
  const now = Date.parse('2030-01-09T10:20:00+05:00');
  const r = {
    requested_at: '2030-01-09T10:00',
    duration_min: 30,
    status: 'in_progress',
    expected_completion_at: new Date(Date.parse('2030-01-09T11:00:00+05:00')).toISOString(),
  };
  const [start, end] = requestInterval(r, now);
  assert.equal(start, Date.parse('2030-01-09T10:00:00+05:00'));
  assert.equal(end, Date.parse('2030-01-09T11:00:00+05:00'));
  // Прогноз уже прошёл, а поездка не закрыта — водитель занят как минимум до «сейчас».
  const [, endLate] = requestInterval(r, Date.parse('2030-01-09T11:30:00+05:00'));
  assert.equal(endLate, Date.parse('2030-01-09T11:30:00+05:00'));
});

test('intervalsOverlap: соседние интервалы с зазором больше запаса не пересекаются', () => {
  assert.equal(intervalsOverlap([0, 60 * MIN], [80 * MIN, 120 * MIN], 15 * MIN), false);
  assert.equal(intervalsOverlap([0, 60 * MIN], [70 * MIN, 120 * MIN], 15 * MIN), true);
});

test('статус «занят» — только когда подача закреплённого заказа уже наступила', () => {
  db.prepare("UPDATE drivers SET status = 'busy' WHERE id = ?").run(driver1); // как раньше ставил claim
  assert.equal(syncDriverStatus(db, driver1, Date.parse('2030-01-07T12:00:00+05:00')), 'available');
  assert.equal(syncDriverStatus(db, driver1, Date.parse('2030-01-07T16:50:00+05:00')), 'busy');
});
