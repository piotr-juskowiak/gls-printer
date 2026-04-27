/**
 * ══════════════════════════════════════════════════════════════
 *  GLS Printer — Backend Server
 *  Node.js + Express
 *  DOSTOSOWANY DO STRUKTURY BAZY WAPRO
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const sql = require('mssql');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  KONFIGURACJA MS SQL (WAPRO)
// ─────────────────────────────────────────────
let rawHost = process.env.WFMAG_HOST || '192.168.1.10';
let parsedServer = rawHost;

if (parsedServer.includes(',')) {
  const parts = parsedServer.split(',');
  parsedServer = parts[0];
  process.env.WFMAG_PORT = parts[1];
}

let parsedInstance = undefined;
if (parsedServer.includes('\\')) {
  const parts = parsedServer.split('\\');
  parsedServer = parts[0];
  parsedInstance = parts[1];
}

const sqlConfig = {
  server: parsedServer,
  database: process.env.WFMAG_DATABASE || 'WAPRO',
  user: process.env.WFMAG_USER || 'sa',
  password: process.env.WFMAG_PASSWORD || '',
  options: {
    encrypt: process.env.WFMAG_ENCRYPT === 'true',
    trustServerCertificate: process.env.WFMAG_TRUST_CERT !== 'false',
    enableArithAbort: true,
    connectTimeout: 10000,
    requestTimeout: 15000,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

if (!process.env.WFMAG_PORT && parsedInstance) {
  sqlConfig.options.instanceName = parsedInstance;
} else if (process.env.WFMAG_PORT) {
  sqlConfig.port = parseInt(process.env.WFMAG_PORT);
}

let pool = null;

async function getPool() {
  if (!pool) {
    try {
      pool = await sql.connect(sqlConfig);
      console.log('✅ Połączono z WAPRO SQL Server');
    } catch (err) {
      console.error('❌ Błąd połączenia z SQL:', err.message);
      throw err;
    }
  }
  return pool;
}

// ─────────────────────────────────────────────
//  ZAPYTANIA SQL — WAPRO
//
//  W bazie WAPRO:
//    TYP_DOKUMENTU = 's'  — dokumenty sprzedaży
//    NUMER — pełny symbol np. "F/000489/26", "WZ/000123/26"
//
//  Opcjonalnie w .env dodaj NUMER_PREFIXES=F/,FK/
//  żeby filtrować tylko wybrane typy dokumentów.
// ─────────────────────────────────────────────

const NUMER_PREFIXES = process.env.NUMER_PREFIXES
  ? process.env.NUMER_PREFIXES.split(',').map(s => s.trim())
  : [];

async function fetchDocumentList() {
  const db = await getPool();

  let prefixFilter = '';
  if (NUMER_PREFIXES.length > 0) {
    const likes = NUMER_PREFIXES
      .map(p => `dh.NUMER LIKE '${p.replace(/'/g, "''")}%'`)
      .join(' OR ');
    prefixFilter = `AND (${likes})`;
  }

  const query = `
    SELECT TOP 200
      dh.NUMER                                              AS numer,
      CASE
        WHEN CHARINDEX('/', dh.NUMER) > 0
        THEN LEFT(dh.NUMER, CHARINDEX('/', dh.NUMER) - 1)
        ELSE dh.NUMER
      END                                                   AS typ,
      dh.NUMER                                              AS nr,
      COALESCE(dh.KONTRAHENT_NAZWA, k.NAZWA, '')            AS nazwa_kontrahenta,
      COALESCE(k.ULICA_LOKAL, '')                           AS ulica,
      COALESCE(k.KOD_POCZTOWY, '')                          AS kod_pocztowy,
      COALESCE(k.MIEJSCOWOSC, '')                           AS miasto,
      COALESCE(k.TELEFON_FIRMOWY, '')                       AS telefon,
      COALESCE(dh.UWAGI, '')                                AS uwagi,
      ''                                                    AS opis_zawartosci,
      '' AS godzina,
      CASE
        WHEN dh.STATUS_DOKUMENTU = 'A' THEN 'cancelled'
        WHEN dh.FLAGA_STANU      = 2   THEN 'ready'
        ELSE                                'new'
      END                                                   AS status
    FROM dbo.DOKUMENT_HANDLOWY dh
    LEFT JOIN dbo.KONTRAHENT k ON k.ID_KONTRAHENTA = dh.ID_KONTRAHENTA
    WHERE
      dh.TYP_DOKUMENTU = 's'
      AND DATEADD(day, dh.DATA_WYSTAWIENIA - 1, '18000101') >= DATEADD(day, -400, GETDATE())
      AND (dh.STATUS_DOKUMENTU IS NULL OR dh.STATUS_DOKUMENTU <> 'A')
      ${prefixFilter}
    ORDER BY dh.DATA_WYSTAWIENIA DESC, dh.ID_DOKUMENTU_HANDLOWEGO DESC
  `;

  const result = await db.request().query(query);
  return result.recordset;
}

async function fetchDocumentByNumber(numStr) {
  const db = await getPool();

  const query = `
    SELECT TOP 1
      dh.NUMER                                              AS numer,
      CASE
        WHEN CHARINDEX('/', dh.NUMER) > 0
        THEN LEFT(dh.NUMER, CHARINDEX('/', dh.NUMER) - 1)
        ELSE dh.NUMER
      END                                                   AS typ,
      dh.NUMER                                              AS nr,
      COALESCE(dh.KONTRAHENT_NAZWA, k.NAZWA, '')            AS nazwa_kontrahenta,
      COALESCE(k.ULICA_LOKAL, '')                           AS ulica,
      COALESCE(k.KOD_POCZTOWY, '')                          AS kod_pocztowy,
      COALESCE(k.MIEJSCOWOSC, '')                           AS miasto,
      COALESCE(k.TELEFON_FIRMOWY, '')                       AS telefon,
      COALESCE(dh.UWAGI, '')                                AS uwagi,
      ''                                                    AS opis_zawartosci
    FROM dbo.DOKUMENT_HANDLOWY dh
    LEFT JOIN dbo.KONTRAHENT k ON k.ID_KONTRAHENTA = dh.ID_KONTRAHENTA
    WHERE
      dh.NUMER = @numer
      AND dh.TYP_DOKUMENTU = 's'
      AND (dh.STATUS_DOKUMENTU IS NULL OR dh.STATUS_DOKUMENTU <> 'A')
  `;

  const result = await db.request()
    .input('numer', sql.VarChar(50), numStr.trim().toUpperCase())
    .query(query);

  return result.recordset[0] || null;
}

// ─────────────────────────────────────────────
//  GLS ADE — SOAP Web Service
// ─────────────────────────────────────────────

const GLS_API_URL = process.env.GLS_API_URL || 'https://ade.gls-poland.com/service.php';
const GLS_USER = process.env.GLS_USERNAME || '';
const GLS_PASS = process.env.GLS_PASSWORD || '';

function buildGlsSoapEnvelope(method, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:GlsAde">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:${method}>
      ${bodyXml}
    </urn:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function createGlsParcel(parcel) {
  const {
    recipientName, recipientStreet, recipientCity,
    recipientZip, recipientPhone, weight,
    reference, notes, packageCount,
  } = parcel;

  const senderName = process.env.SENDER_NAME || 'Henry Sp. z o.o.';
  const senderStreet = process.env.SENDER_STREET || 'ul. Przykladowa 1';
  const senderCity = process.env.SENDER_CITY || 'Warszawa';
  const senderZip = process.env.SENDER_ZIP || '00-001';
  const senderPhone = process.env.SENDER_PHONE || '';
  const senderContact = process.env.SENDER_CONTACT || 'Magazyn';

  const trackingNumbers = [];
  const labelDataList = [];

  for (let i = 0; i < packageCount; i++) {
    const bodyXml = `
      <login>${escapeXml(GLS_USER)}</login>
      <password>${escapeXml(GLS_PASS)}</password>
      <pParcels>
        <item>
          <RecipientName>${escapeXml(recipientName)}</RecipientName>
          <RecipientStreet>${escapeXml(recipientStreet)}</RecipientStreet>
          <RecipientZipCode>${escapeXml(recipientZip)}</RecipientZipCode>
          <RecipientCity>${escapeXml(recipientCity)}</RecipientCity>
          <RecipientPhone>${escapeXml(recipientPhone || '')}</RecipientPhone>
          <SendersName>${escapeXml(senderName)}</SendersName>
          <SendersStreet>${escapeXml(senderStreet)}</SendersStreet>
          <SendersZipCode>${escapeXml(senderZip)}</SendersZipCode>
          <SendersCity>${escapeXml(senderCity)}</SendersCity>
          <SendersPhone>${escapeXml(senderPhone)}</SendersPhone>
          <SendersContact>${escapeXml(senderContact)}</SendersContact>
          <References1>${escapeXml(reference || '')}</References1>
          <Notes1>${escapeXml(notes || '')}</Notes1>
          <Weight>${weight}</Weight>
          <ServiceType>AH</ServiceType>
        </item>
      </pParcels>
    `;

    const envelope = buildGlsSoapEnvelope('InsertParcel', bodyXml);
    const response = await axios.post(GLS_API_URL, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': 'urn:GlsAde#InsertParcel',
      },
      timeout: 15000,
    });

    const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });
    const body = parsed['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'];
    const result = body?.['ns1:InsertParcelResponse']?.return
      || body?.['InsertParcelResponse']?.return;

    if (!result) {
      throw new Error('Nieoczekiwana odpowiedź GLS API: ' + response.data.substring(0, 300));
    }
    if (result.Status && result.Status !== 'OK' && result.Status !== '0') {
      throw new Error('GLS API błąd: ' + (result.ErrorDesc || result.Status));
    }

    trackingNumbers.push(result.TrackingNumber || result.ParcelNumber || result.Number);
    if (result.LabelData || result.Label) {
      labelDataList.push(result.LabelData || result.Label);
    }
  }

  return { trackingNumbers, labelDataList, success: true };
}

async function sendZplToPrinter(zplData) {
  return new Promise((resolve, reject) => {
    const printerIp = process.env.PRINTER_IP || '192.168.1.50';
    const printerPort = parseInt(process.env.PRINTER_PORT || '9100');
    const client = new net.Socket();
    client.setTimeout(5000);
    client.connect(printerPort, printerIp, () => {
      client.write(zplData, 'utf8', () => { client.end(); resolve({ success: true }); });
    });
    client.on('error', (err) => reject(new Error('Błąd połączenia z drukarką: ' + err.message)));
    client.on('timeout', () => { client.destroy(); reject(new Error('Timeout połączenia z drukarką')); });
  });
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ─────────────────────────────────────────────
//  HELPER — formatuj wiersz SQL → obiekt frontendu
// ─────────────────────────────────────────────
function formatDocRow(row) {
  const addr = [
    row.ulica,
    (row.kod_pocztowy + ' ' + row.miasto).trim()
  ].filter(Boolean).join(', ');

  const isEmpik = /empik/i.test(row.nazwa_kontrahenta);
  const glnMatch = (row.uwagi || '').match(/GLN[:\s]+(\d{13})/i);
  const orderMatch = (row.uwagi || '').match(/zam[.\s]+(\d+)/i);

  return {
    numer: row.numer,
    typ: row.typ,
    status: row.status || 'new',
    godzina: row.godzina || '',
    name: row.nazwa_kontrahenta,
    addr: addr,
    phone: row.telefon,
    desc: row.opis_zawartosci,
    uwagi: row.uwagi,
    empik: isEmpik,
    empikGLN: glnMatch ? glnMatch[1] : '',
    empikOrder: orderMatch ? orderMatch[1] : '',
  };
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────

app.get('/api/documents', async (req, res) => {
  try {
    const rows = await fetchDocumentList();
    res.json({ ok: true, data: rows.map(formatDocRow) });
  } catch (err) {
    console.error('GET /api/documents error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/document/:number(*)', async (req, res) => {
  try {
    const numStr = decodeURIComponent(req.params.number);
    const row = await fetchDocumentByNumber(numStr);
    if (!row) return res.status(404).json({ ok: false, error: 'Dokument nie znaleziony: ' + numStr });
    res.json({ ok: true, data: formatDocRow(row) });
  } catch (err) {
    console.error('GET /api/document error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/print', async (req, res) => {
  try {
    const { docNum, name, addr, phone, weight, packageCount, uwagi } = req.body;
    if (!docNum || !name || !weight) {
      return res.status(400).json({ ok: false, error: 'Brak wymaganych danych (docNum, name, weight)' });
    }

    const addrParts = (addr || '').split(',');
    const street = (addrParts[0] || '').trim();
    const cityPart = (addrParts[1] || '').trim();
    const zipMatch = cityPart.match(/(\d{2}-\d{3})\s*(.*)/);

    const result = await createGlsParcel({
      recipientName: name,
      recipientStreet: street,
      recipientCity: zipMatch ? zipMatch[2].trim() : cityPart,
      recipientZip: zipMatch ? zipMatch[1] : '',
      recipientPhone: phone || '',
      weight: parseFloat(weight),
      reference: docNum,
      notes: uwagi || '',
      packageCount: parseInt(packageCount) || 1,
    });

    if (result.labelDataList && result.labelDataList.length > 0) {
      for (const zpl of result.labelDataList) {
        try { await sendZplToPrinter(zpl); }
        catch (printerErr) { console.warn('⚠️ Drukarka niedostępna:', printerErr.message); }
      }
    }

    res.json({ ok: true, trackingNumbers: result.trackingNumbers, labelAvailable: result.labelDataList.length > 0 });
  } catch (err) {
    console.error('POST /api/print error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pomocniczy endpoint — jakie numery dokumentów są w bazie
app.get('/api/doctypes', async (req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT
        LEFT(NUMER, CHARINDEX('/', NUMER + '/') - 1) AS prefiks,
        COUNT(*) AS ile
      FROM dbo.DOKUMENT_HANDLOWY
      WHERE TYP_DOKUMENTU = 's'
      GROUP BY LEFT(NUMER, CHARINDEX('/', NUMER + '/') - 1)
      ORDER BY ile DESC
    `);
    res.json({ ok: true, data: result.recordset, current_prefix_filter: NUMER_PREFIXES });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  const status = { server: 'ok', sql: 'unknown', gls: 'unknown', timestamp: new Date().toISOString() };
  try {
    const db = await getPool();
    await db.request().query('SELECT 1 AS test');
    status.sql = 'connected';
  } catch (err) { status.sql = 'error: ' + err.message; }
  try {
    await axios.get(GLS_API_URL, { timeout: 3000 });
    status.gls = 'connected';
  } catch (err) {
    status.gls = err.response ? 'connected' : 'error: ' + err.message;
  }
  res.json(status);
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GLS Printer backend uruchomiony na porcie ${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/api/health`);
  console.log(`   Docs:     http://localhost:${PORT}/api/documents`);
  console.log(`   DocTypes: http://localhost:${PORT}/api/doctypes`);
  if (NUMER_PREFIXES.length > 0)
    console.log(`   Filtr prefiksów: ${NUMER_PREFIXES.join(', ')}`);
  else
    console.log(`   Pokazuje wszystkie dokumenty sprzedaży (TYP='s')`);
  console.log('');
  getPool().catch(() => console.warn('⚠️  SQL połączy się przy pierwszym zapytaniu.'));
});

module.exports = app;