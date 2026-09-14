'use strict';

const express = require('express');
const cors = require('cors');
const { mountPlatform } = require('./platform');

const app = express();
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origen no permitido por CORS.'));
  },
}));

app.get('/health', (req, res) => res.json({
  service: 'vehicleapp-platform',
  status: 'ok',
  platformEnabled: process.env.PLATFORM_ENABLED === 'true',
}));

mountPlatform(app);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(503).json({ error: 'La plataforma no está disponible.' });
});

const port = process.env.PORT || 5001;
if (require.main === module) {
  app.listen(port, () => console.log(`VehicleApp platform running on port ${port}`));
}

module.exports = app;
