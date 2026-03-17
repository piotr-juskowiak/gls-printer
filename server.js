/**
 * ══════════════════════════════════════════════════════════════
 *  GLS Printer — Backend Server
 *  Node.js + Express
 *
 *  Endpointy:
 *    GET  /api/documents          — lista dokumentów z WF-Mag
 *    GET  /api/document/:number   — dane konkretnego dokumentu
 *    POST /api/print              — tworzenie przesyłki w GLS ADE
 *
 *  Wymagania:  npm install  (patrz package.json)
 *  Uruchomienie: node server.js  (lub: npm run dev)
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const xml2js   = require('xml2js');
const sql      = require('mssql');
const net      = require('net');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  KONFIGURACJA MS SQL (WF-Mag)
// ─────────────────────────────────────────────
const sqlConfig = {
  server:   process.env.WFMAG_HOST     || '192.168.1.10',
  port:     parseInt(process.env.WFMAG_PORT || '1433'),
  database: process.env.WFMAG_DATABASE || 'wfmag',
  user:     process.env.WFMAG_USER     || 'sa',
  password: process.env.WFMAG_PASSWORD || '',
  options: {
    encrypt:              process.env.WFMAG_ENCRYPT      === 'true',
    trustServerCertificate: process.env.WFMAG_TRUST_CERT !== 'false',
    enableArithAbort:     true,
    connectTimeout:       10000,
    requestTimeout:       15000,
  },
  pool: {
    max: 10, min: 0, idleTimeoutMillis: 30000,
  },
};

// Pool połączeń — inicjalizowany przy starcie
let pool = null;

async function getPool() {
  if (!pool) {
    try {
      pool = await sql.connect(sqlConfig);
      console.log('✅ Połączono z WF-Mag SQL Server');
    } catch (err) {
      console.error('❌ Błąd połączenia z SQL:', err.message);
      throw err;
    }
  }
  return pool;
}

// ─────────────────────────────────────────────
//  POMOCNICZE — parsowanie numeru dokumentu
// ─────────────────────────────────────────────
function parseDocNumber(numStr) {
  // Formaty: WZ/2024/1042, MW/04339/26, FV/2024/0089
  const parts = numStr.trim().toUpperCase().split('/');
  return {
    type:   parts[0] || '',        // WZ / MW / FV
    series: parts[1] || '',        // 2024 lub 04339
    number: parseInt(parts[2]) || 0, // 1042 lub 26
    raw:    numStr.trim().toUpperCase(),
  };
}

// ─────────────────────────────────────────────
//  ZAPYTANIA SQL — WF-Mag
//
//  UWAGA: Nazwy tabel i kolumn WF-Mag mogą się
//  różnić między wersjami. Sprawdź w swoim SQL:
//    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
//  i dostosuj poniższe zapytania.
// ─────────────────────────────────────────────

/**
 * Pobiera listę dokumentów WZ/MW z dzisiaj
 * Tabela: dbo.DokHan (główna tabela dokumentów handlowych)
 */
async function fetchDocumentList() {
  const db = await getPool();

  // ══ DOSTOSUJ: Sprawdź rzeczywiste nazwy kolumn w swojej bazie ══
  // Typowe kolumny WF-Mag: DH_NrDok, DH_TrNazwa, DH_Nazwa, DH_Ulica, DH_KodPoczt, DH_Miasto
  const query = `
    SELECT TOP 100
      DH_Symbol + '/' + CAST(DH_NrDok AS VARCHAR) AS numer,
      DH_Symbol                                    AS typ,
      DH_NrDok                                     AS nr,
      COALESCE(DH_TrNazwa, DH_Nazwa, '')           AS nazwa_kontrahenta,
      COALESCE(DH_TrUlica, DH_Ulica, '')           AS ulica,
      COALESCE(DH_TrKodPoczt, DH_KodPoczt, '')     AS kod_pocztowy,
      COALESCE(DH_TrMiasto, DH_Miasto, '')         AS miasto,
      COALESCE(DH_TrTelefon, '')                   AS telefon,
      COALESCE(DH_Uwagi, '')                       AS uwagi,
      COALESCE(DH_OpisZaw, '')                     AS opis_zawartosci,
      CONVERT(VARCHAR(5), DH_DataDok, 108)         AS godzina,
      CASE
        WHEN DH_Zrealizowany = 1 THEN 'ready'
        WHEN DH_Pilne = 1        THEN 'urgent'
        ELSE                          'new'
      END AS status
    FROM dbo.DokHan
    WHERE
      DH_Symbol IN ('WZ','MW','FV')
      AND CAST(DH_DataDok AS DATE) = CAST(GETDATE() AS DATE)
      AND (DH_Anulowany IS NULL OR DH_Anulowany = 0)
    ORDER BY DH_DataDok DESC, DH_NrDok DESC
  `;

  const result = await db.request().query(query);
  return result.recordset;
}

/**
 * Pobiera szczegóły jednego dokumentu po numerze
 */
async function fetchDocumentByNumber(numStr) {
  const db  = await getPool();
  const doc = parseDocNumber(numStr);

  // ══ DOSTOSUJ: poniższe kolumny jak wyżej ══
  const query = `
    SELECT TOP 1
      DH_Symbol + '/' + CAST(DH_NrDok AS VARCHAR) AS numer,
      DH_Symbol                                    AS typ,
      DH_NrDok                                     AS nr,
      COALESCE(DH_TrNazwa, DH_Nazwa, '')           AS nazwa_kontrahenta,
      COALESCE(DH_TrUlica, DH_Ulica, '')           AS ulica,
      COALESCE(DH_TrKodPoczt, DH_KodPoczt, '')     AS kod_pocztowy,
      COALESCE(DH_TrMiasto, DH_Miasto, '')         AS miasto,
      COALESCE(DH_TrTelefon, '')                   AS telefon,
      COALESCE(DH_Uwagi, '')                       AS uwagi,
      COALESCE(DH_OpisZaw, '')                     AS opis_zawartosci
    FROM dbo.DokHan
    WHERE
      DH_Symbol  = @typ
      AND DH_NrDok = @nr
      AND (DH_Anulowany IS NULL OR DH_Anulowany = 0)
  `;

  const result = await db.request()
    .input('typ', sql.VarChar(10), doc.type)
    .input('nr',  sql.Int,         doc.number)
    .query(query);

  return result.recordset[0] || null;
}

// ─────────────────────────────────────────────
//  GLS ADE — SOAP Web Service
//  Dokumentacja: https://ade.gls-poland.com/
// ─────────────────────────────────────────────

const GLS_API_URL = process.env.GLS_API_URL || 'https://ade.gls-poland.com/service.php';
const GLS_USER    = process.env.GLS_USERNAME || '';
const GLS_PASS    = process.env.GLS_PASSWORD || '';

/**
 * Buduje kopertę SOAP dla GLS ADE
 */
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

/**
 * Tworzy przesyłkę GLS i zwraca numer trackingowy + dane do wydruku
 *
 * @param {Object} parcel - dane przesyłki
 * @returns {Object} { trackingNumber, labelData, parcelId }
 */
async function createGlsParcel(parcel) {
  const {
    recipientName,
    recipientStreet,
    recipientCity,
    recipientZip,
    recipientPhone,
    weight,        // kg
    reference,     // numer dokumentu WZ/MW
    notes,         // uwagi (np. numer zamówienia Empik)
    packageCount,  // liczba paczek
  } = parcel;

  // Dane nadawcy z .env
  const senderName    = process.env.SENDER_NAME    || 'Henry Sp. z o.o.';
  const senderStreet  = process.env.SENDER_STREET  || 'ul. Przykladowa 1';
  const senderCity    = process.env.SENDER_CITY    || 'Warszawa';
  const senderZip     = process.env.SENDER_ZIP     || '00-001';
  const senderPhone   = process.env.SENDER_PHONE   || '';
  const senderContact = process.env.SENDER_CONTACT || 'Magazyn';

  const trackingNumbers = [];
  const labelDataList   = [];

  // Tworzymy osobną przesyłkę dla każdej paczki
  for (let i = 0; i < packageCount; i++) {

    // ══ DOSTOSUJ: Sprawdź w dokumentacji GLS ADE jaką metodę
    //    i jakie pola obsługuje Twój kontrakt ══
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
        'SOAPAction':   'urn:GlsAde#InsertParcel',
      },
      timeout: 15000,
    });

    // Parsuj odpowiedź XML
    const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });

    // ══ DOSTOSUJ: ścieżka do numeru trackingowego zależy od wersji GLS ADE ══
    const body   = parsed['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'];
    const result = body?.['ns1:InsertParcelResponse']?.return
                || body?.['InsertParcelResponse']?.return;

    if (!result) {
      throw new Error('Nieoczekiwana odpowiedź GLS API: ' + response.data.substring(0, 300));
    }

    if (result.Status && result.Status !== 'OK' && result.Status !== '0') {
      throw new Error('GLS API błąd: ' + (result.ErrorDesc || result.Status));
    }

    const tracking = result.TrackingNumber || result.ParcelNumber || result.Number;
    trackingNumbers.push(tracking);

    // Pobierz etykietę PDF/ZPL jeśli dostępna w odpowiedzi
    if (result.LabelData || result.Label) {
      labelDataList.push(result.LabelData || result.Label);
    }
  }

  return {
    trackingNumbers,
    labelDataList,
    success: true,
  };
}

/**
 * (Opcjonalne) Wyślij ZPL bezpośrednio do drukarki GODEX przez TCP
 */
async function sendZplToPrinter(zplData) {
  return new Promise((resolve, reject) => {
    const printerIp   = process.env.PRINTER_IP   || '192.168.1.50';
    const printerPort = parseInt(process.env.PRINTER_PORT || '9100');

    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(printerPort, printerIp, () => {
      client.write(zplData, 'utf8', () => {
        client.end();
        resolve({ success: true });
      });
    });

    client.on('error', (err) => {
      reject(new Error('Błąd połączenia z drukarką: ' + err.message));
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Timeout połączenia z drukarką'));
    });
  });
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

// ─────────────────────────────────────────────
//  HELPER — formatuj wiersz SQL → obiekt dla frontendu
// ─────────────────────────────────────────────
function formatDocRow(row) {
  const addr = [
    row.ulica,
    (row.kod_pocztowy + ' ' + row.miasto).trim()
  ].filter(Boolean).join(', ');

  // Wykryj Empik po nazwie kontrahenta lub uwagach
  const isEmpik = /empik/i.test(row.nazwa_kontrahenta);

  // Wyłuskaj GLN i numer zamówienia z pola uwag (format: "GLN: XXXX, zam. YYYY")
  const glnMatch   = (row.uwagi || '').match(/GLN[:\s]+(\d{13})/i);
  const orderMatch = (row.uwagi || '').match(/zam[.\s]+(\d+)/i);

  return {
    numer:     row.numer,
    typ:       row.typ,
    status:    row.status || 'new',
    godzina:   row.godzina || '',
    name:      row.nazwa_kontrahenta,
    addr:      addr,
    phone:     row.telefon,
    desc:      row.opis_zawartosci,
    uwagi:     row.uwagi,
    empik:     isEmpik,
    empikGLN:   glnMatch  ? glnMatch[1]  : '',
    empikOrder: orderMatch ? orderMatch[1] : '',
  };
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /api/documents
 * Zwraca listę dokumentów z dzisiaj do wyświetlenia w tabeli
 */
app.get('/api/documents', async (req, res) => {
  try {
    const rows = await fetchDocumentList();
    const docs = rows.map(formatDocRow);
    res.json({ ok: true, data: docs });
  } catch (err) {
    console.error('GET /api/documents error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/document/:number
 * Zwraca dane konkretnego dokumentu (po kliknięciu lub wpisaniu numeru)
 * Przykład: GET /api/document/MW%2F04339%2F26
 */
app.get('/api/document/:number(*)', async (req, res) => {
  try {
    const numStr = decodeURIComponent(req.params.number);
    const row    = await fetchDocumentByNumber(numStr);

    if (!row) {
      return res.status(404).json({ ok: false, error: 'Dokument nie znaleziony: ' + numStr });
    }

    res.json({ ok: true, data: formatDocRow(row) });
  } catch (err) {
    console.error('GET /api/document error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/print
 * Tworzy przesyłkę GLS i (opcjonalnie) drukuje etykietę
 *
 * Body: {
 *   docNum, name, addr, phone, desc,
 *   weight, packageCount, uwagi,
 *   isEmpik, empikOrderNum
 * }
 */
app.post('/api/print', async (req, res) => {
  try {
    const {
      docNum, name, addr, phone,
      weight, packageCount, uwagi,
    } = req.body;

    if (!docNum || !name || !weight) {
      return res.status(400).json({ ok: false, error: 'Brak wymaganych danych (docNum, name, weight)' });
    }

    // Podziel adres na ulicę i miasto
    const addrParts = (addr || '').split(',');
    const street    = (addrParts[0] || '').trim();
    const cityPart  = (addrParts[1] || '').trim();
    const zipMatch  = cityPart.match(/(\d{2}-\d{3})\s*(.*)/);
    const zip       = zipMatch ? zipMatch[1] : '';
    const city      = zipMatch ? zipMatch[2].trim() : cityPart;

    const result = await createGlsParcel({
      recipientName:   name,
      recipientStreet: street,
      recipientCity:   city,
      recipientZip:    zip,
      recipientPhone:  phone || '',
      weight:          parseFloat(weight),
      reference:       docNum,
      notes:           uwagi || '',
      packageCount:    parseInt(packageCount) || 1,
    });

    // Jeśli GLS zwróciło etykiety ZPL — wyślij do drukarki
    if (result.labelDataList && result.labelDataList.length > 0) {
      for (const zpl of result.labelDataList) {
        try {
          await sendZplToPrinter(zpl);
        } catch (printerErr) {
          console.warn('⚠️ Etykieta utworzona w GLS, ale drukarka niedostępna:', printerErr.message);
          // Nie przerywamy — przesyłka jest już zarejestrowana w GLS
        }
      }
    }

    res.json({
      ok: true,
      trackingNumbers: result.trackingNumbers,
      labelAvailable:  result.labelDataList.length > 0,
    });

  } catch (err) {
    console.error('POST /api/print error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/health
 * Status serwera — używany przez frontend do sprawdzenia połączenia
 */
app.get('/api/health', async (req, res) => {
  const status = { server: 'ok', sql: 'unknown', timestamp: new Date().toISOString() };

  try {
    await getPool();
    const db = await getPool();
    await db.request().query('SELECT 1 AS test');
    status.sql = 'connected';
  } catch (err) {
    status.sql = 'error: ' + err.message;
  }

  res.json(status);
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GLS Printer backend uruchomiony na porcie ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Docs:   http://localhost:${PORT}/api/documents\n`);

  // Inicjalizuj połączenie SQL przy starcie (opcjonalne — lazy init też działa)
  getPool().catch(err => {
    console.warn('⚠️  SQL nie połączony przy starcie. Połączy się przy pierwszym zapytaniu.');
    console.warn('   Sprawdź .env (WFMAG_HOST, WFMAG_USER, WFMAG_PASSWORD)');
  });
});

module.exports = app;
