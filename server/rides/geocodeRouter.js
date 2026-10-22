// /api/v1/geocode/check?address=… — найден ли адрес на карте и насколько
// точно (форма заявки показывает «✓ найден» или требует отметить точку на
// карте, см. addressCheck.js). Ответ: { status, lat?, lng? }, status —
// found | street | not_found | unavailable.
//
// /settlements — выпадающий список населённых пунктов в форме,
// /settlement?name=… — проверка вписанного вручную (settlements.js):
// { status: found, name, lat, lng } | { status: not_found, suggestions } | { status: unavailable }.
const express = require('express');
const { requireRideRole } = require('./auth');
const { lookupAddress } = require('./routeEstimate');
const { resolveSettlement, settlementOptions } = require('./settlements');

const router = express.Router();

router.get('/settlements', requireRideRole('employee', 'dispatcher', 'driver'), (req, res) => {
  res.json({ settlements: settlementOptions() });
});

router.get('/settlement', requireRideRole('employee', 'dispatcher', 'driver'), async (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Укажите населённый пункт' });
  const r = await resolveSettlement(name);
  res.json(r.status === 'found' ? { status: 'found', name: r.name, lat: r.lat, lng: r.lng } : r);
});

router.get('/check', requireRideRole('employee', 'dispatcher', 'driver'), async (req, res) => {
  const address = String(req.query.address || '').trim().slice(0, 300);
  if (!address) return res.status(400).json({ error: 'Укажите адрес' });
  try {
    res.json(await lookupAddress(address));
  } catch (err) {
    res.json({ status: 'unavailable' });
  }
});

module.exports = router;
