// /api/v1/geocode/check?address=… — найден ли адрес на карте и насколько
// точно (форма заявки показывает «✓ найден» или требует отметить точку на
// карте, см. addressCheck.js). Ответ: { status, lat?, lng? }, status —
// found | street | not_found | unavailable.
const express = require('express');
const { requireRideRole } = require('./auth');
const { lookupAddress } = require('./routeEstimate');

const router = express.Router();

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
