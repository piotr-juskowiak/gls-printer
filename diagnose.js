/**
 * GLS-Printer — rozszerzona diagnostyka połączeń
 * Zastąp tym plikiem oryginalny diagnose.js
 */
require('dotenv').config();
const sql   = require('mssql');
const axios = require('axios');
const net   = require('net');

let ok = 0, warn = 0, err = 0;

function pass(msg)    { console.log('  ✅', msg); ok++; }
function warning(msg) { console.log('  ⚠️ ', msg); warn++; }
function fail(msg)    { console.log('  ❌', msg); err++; }
function info(msg)    { console.log('  ℹ️ ', msg); }
function hint(msg)    { console.log('  💡', msg); }
function sep(title)   { console.log('\n──────────────────────────────────'); console.log(' ', title); console.log('──────────────────────────────────\n'); }

console.log('\n══════════════════════════════════');
console.log('  GLS-Printer — Diagnostyka v2');
console.log('══════════════════════════════════\n');

// ─────────────────────────────────
//  1. ZMIENNE ŚRODOWISKOWE (.env)
// ─────────────────────────────────
sep('Krok 1: Zmienne .env');

const required = {
  WFMAG_HOST:     process.env.WFMAG_HOST,
  WFMAG_DATABASE: process.env.WFMAG_DATABASE,
  WFMAG_USER:     process.env.WFMAG_USER,
  WFMAG_PASSWORD: process.env.WFMAG_PASSWORD,
  GLS_API_URL:    process.env.GLS_API_URL,
  GLS_USERNAME:   process.env.GLS_USERNAME,
  GLS_PASSWORD:   process.env.GLS_PASSWORD,
};

const sender = {
  SENDER_NAME:    process.env.SENDER_NAME,
  SENDER_STREET:  process.env.SENDER_STREET,
  SENDER_CITY:    process.env.SENDER_CITY,
  SENDER_ZIP:     process.env.SENDER_ZIP,
  SENDER_PHONE:   process.env.SENDER_PHONE,
};

for (const [key, val] of Object.entries(required)) {
  const secret = key.includes('PASSWORD');
  if (!val)       fail(`Brakuje zmiennej: ${key}`);
  else if (secret) pass(`${key}: ****(ustawione)`);
  else             pass(`${key}: ${val}`);
}

console.log('');
for (const [key, val] of Object.entries(sender)) {
  if (!val) warning(`Dane nadawcy (${key}) nie ustawione — używane domyślne`);
  else      pass(`${key}: ${val}`);
}

if (process.env.PRINTER_IP) {
  pass(`PRINTER_IP: ${process.env.PRINTER_IP}  PORT: ${process.env.PRINTER_PORT || '9100'}`);
} else {
  warning('PRINTER_IP nie ustawiony — drukowanie ZPL przez sieć wyłączone');
}

// ─────────────────────────────────
//  2. PARSOWANIE HOSTA SQL
// ─────────────────────────────────
sep('Krok 2: Parsowanie adresu WF-Mag');

let rawHost = process.env.WFMAG_HOST || '';
let parsedServer = rawHost;
let parsedPort = process.env.WFMAG_PORT ? parseInt(process.env.WFMAG_PORT) : null;
let parsedInstance = null;

if (parsedServer.includes(',')) {
  const parts = parsedServer.split(',');
  parsedServer = parts[0].trim();
  parsedPort = parseInt(parts[1].trim());
}
if (parsedServer.includes('\\')) {
  const parts = parsedServer.split('\\');
  parsedServer = parts[0].trim();
  parsedInstance = parts[1].trim();
}

info(`Oryginalny WFMAG_HOST: "${rawHost}"`);
info(`Serwer (IP/hostname):  "${parsedServer}"`);
info(`Instancja SQL:         ${parsedInstance ? `"${parsedInstance}"` : '(brak — łączymy przez TCP)'}`);
info(`Port TCP:              ${parsedPort ? parsedPort : parsedInstance ? '(SQL Browser UDP 1434)' : '1433 (domyślny)'}`);
info(`Baza danych:           "${process.env.WFMAG_DATABASE || 'wfmag'}"`);

const sqlConfig = {
  server:   parsedServer,
  database: process.env.WFMAG_DATABASE || 'wfmag',
  user:     process.env.WFMAG_USER     || 'sa',
  password: process.env.WFMAG_PASSWORD || '',
  options: {
    encrypt:                process.env.WFMAG_ENCRYPT === 'true',
    trustServerCertificate: process.env.WFMAG_TRUST_CERT !== 'false',
    enableArithAbort:       true,
    connectTimeout:         8000,
    requestTimeout:         8000,
  },
};
if (!parsedPort && parsedInstance) {
  sqlConfig.options.instanceName = parsedInstance;
} else if (parsedPort) {
  sqlConfig.port = parsedPort;
}

// ─────────────────────────────────
//  3. PING TCP DO SERWERA SQL
// ─────────────────────────────────
sep('Krok 3: Ping TCP do serwera SQL');

async function tcpPing(host, port, label) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(4000);
    s.connect(port, host, () => {
      pass(`Port TCP ${port} na ${host} — OTWARTY (${label})`);
      s.destroy();
      resolve(true);
    });
    s.on('error', e => {
      fail(`Port TCP ${port} na ${host} — ${e.code || e.message} (${label})`);
      if (e.code === 'ECONNREFUSED') hint('Sprawdź czy SQL Server nasłuchuje na tym porcie (SQL Server Configuration Manager).');
      if (e.code === 'ETIMEDOUT')    hint('Host nieosiągalny lub firewall blokuje port. Sprawdź sieć i reguły zapory.');
      resolve(false);
    });
    s.on('timeout', () => { fail(`Timeout TCP do ${host}:${port} (${label})`); s.destroy(); resolve(false); });
  });
}

async function runTcpTests() {
  if (parsedPort) {
    await tcpPing(parsedServer, parsedPort, 'port SQL');
  } else {
    // Sprawdź domyślny 1433 i SQL Browser 1434
    const ok1433 = await tcpPing(parsedServer, 1433, 'domyślny SQL');
    await tcpPing(parsedServer, 1434, 'SQL Browser UDP — wymagany dla instancji');
    if (!ok1433 && parsedInstance) hint('SQL Browser (port 1434 UDP) jest potrzebny do rozwiązania nazwy instancji. Upewnij się, że usługa SQL Server Browser jest uruchomiona.');
  }
}

// ─────────────────────────────────
//  4. POŁĄCZENIE Z SQL SERVER
// ─────────────────────────────────
sep('Krok 4: Połączenie z SQL Server');

async function testSQL() {
  let pool;
  try {
    pool = await sql.connect(sqlConfig);
    pass('Połączenie z SQL Server — OK!');
  } catch (e) {
    fail('Połączenie z SQL Server — BŁĄD: ' + e.message);
    if (e.message.includes('Login failed'))       hint('Złe dane logowania. Sprawdź WFMAG_USER i WFMAG_PASSWORD.');
    if (e.message.includes('ECONNREFUSED'))       hint('SQL Server nie słucha na tym porcie.');
    if (e.message.includes('ETIMEOUT') || e.message.includes('timeout')) hint('Host nieosiągalny. Sprawdź IP i sieć.');
    if (e.message.includes('Cannot open database')) hint('Baza danych nie istnieje lub użytkownik nie ma do niej dostępu.');
    return null;
  }

  // Wersja SQL
  try {
    const r = await pool.request().query('SELECT @@VERSION AS ver');
    const ver = r.recordset[0].ver.split('\n')[0];
    info('Wersja SQL Server: ' + ver);
  } catch(e) { warning('Nie udało się pobrać wersji SQL: ' + e.message); }

  // Lista baz
  try {
    const r = await pool.request().query('SELECT DB_NAME() AS db');
    pass('Aktywna baza danych: ' + r.recordset[0].db);
  } catch(e) { warning('Nie udało się potwierdzić nazwy bazy: ' + e.message); }

  return pool;
}

// ─────────────────────────────────
//  5. STRUKTURA BAZY WF-Mag
// ─────────────────────────────────
sep('Krok 5: Struktura bazy WF-Mag');

async function testSchema(pool) {
  if (!pool) { warning('Pominięto — brak połączenia SQL.'); return; }

  // Tabela DokHan
  try {
    const r = await pool.request().query("SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='DokHan'");
    if (r.recordset[0].cnt > 0) pass('Tabela dbo.DokHan — istnieje');
    else { fail('Tabela dbo.DokHan — NIE ZNALEZIONA'); hint('Sprawdź czy baza jest poprawna i czy użytkownik ma uprawnienia SELECT.'); }
  } catch(e) { fail('Sprawdzenie tabeli DokHan: ' + e.message); }

  // Kolumny krytyczne
  const requiredCols = ['DH_Symbol','DH_NrDok','DH_DataDok','DH_Nazwa','DH_TrNazwa','DH_Ulica','DH_TrUlica','DH_KodPoczt','DH_TrKodPoczt','DH_Miasto','DH_TrMiasto','DH_Zrealizowany','DH_Anulowany'];
  try {
    const r = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='DokHan'");
    const existing = new Set(r.recordset.map(x => x.COLUMN_NAME));
    const missing  = requiredCols.filter(c => !existing.has(c));
    if (missing.length === 0) {
      pass(`Wszystkie wymagane kolumny DokHan istnieją (${requiredCols.length} szt.)`);
    } else {
      fail(`Brakujące kolumny w DokHan: ${missing.join(', ')}`);
      hint('Zapytania SQL w server.js mogą nie działać. Dostosuj nazwy kolumn do swojej wersji WF-Mag.');
    }
    // Informacyjnie — opcjonalne kolumny
    const optional = ['DH_OpisZaw','DH_Uwagi','DH_TrTelefon','DH_Pilne'];
    const missingOpt = optional.filter(c => !existing.has(c));
    if (missingOpt.length > 0) warning(`Kolumny opcjonalne nieobecne (nie krytyczne): ${missingOpt.join(', ')}`);
    else pass('Kolumny opcjonalne DokHan: wszystkie obecne');
  } catch(e) { warning('Nie udało się sprawdzić kolumn: ' + e.message); }

  // Liczba rekordów
  try {
    const r = await pool.request().query('SELECT COUNT(*) AS cnt FROM dbo.DokHan');
    pass(`Tabela dbo.DokHan — łącznie rekordów: ${r.recordset[0].cnt.toLocaleString('pl')}`);
  } catch(e) { fail('Nie udało się pobrać liczby rekordów DokHan: ' + e.message); }

  // Test zapytania listy dokumentów (ostatnie 14 dni)
  try {
    const r = await pool.request().query(`
      SELECT TOP 5
        DH_Symbol + '/' + CAST(DH_NrDok AS VARCHAR) AS numer,
        COALESCE(DH_TrNazwa, DH_Nazwa, '(brak)') AS kontrahent,
        CONVERT(VARCHAR(10), DH_DataDok, 120) AS data
      FROM dbo.DokHan
      WHERE DH_Symbol IN ('WZ','MW','FV')
        AND DH_DataDok >= DATEADD(day, -14, GETDATE())
        AND (DH_Anulowany IS NULL OR DH_Anulowany = 0)
      ORDER BY DH_DataDok DESC
    `);
    if (r.recordset.length > 0) {
      pass(`Zapytanie listowe — OK, ${r.recordset.length} dok. z ostatnich 14 dni:`);
      r.recordset.forEach(row => info(`   ${row.data}  ${row.numer.padEnd(20)}  ${row.kontrahent}`));
    } else {
      warning('Zapytanie listowe działa, ale nie znaleziono dokumentów WZ/MW/FV z ostatnich 14 dni.');
      hint('Sprawdź czy typy dokumentów (DH_Symbol) to dokładnie "WZ", "MW" lub "FV".');
    }
  } catch(e) {
    fail('Zapytanie listowe — BŁĄD: ' + e.message);
    hint('Dostosuj zapytanie w server.js do nazw kolumn w Twojej wersji WF-Mag.');
  }
}

// ─────────────────────────────────
//  6. GLS API
// ─────────────────────────────────
sep('Krok 6: Połączenie z GLS API');

async function testGLS() {
  const url = process.env.GLS_API_URL || 'https://ade.gls-poland.com/service.php';
  info('URL: ' + url);
  try {
    const resp = await axios.get(url, { timeout: 6000 });
    pass('GLS API odpowiada — status: ' + resp.status);
  } catch (e) {
    if (e.response) {
      pass(`GLS API działa (HTTP ${e.response.status}) — endpoint SOAP nie obsługuje GET, to normalne`);
    } else {
      fail('GLS API — brak odpowiedzi: ' + e.message);
      if (e.code === 'ENOTFOUND')    hint('Nie można rozwiązać DNS. Sprawdź połączenie z Internetem.');
      if (e.code === 'ECONNREFUSED') hint('Połączenie odrzucone. Sprawdź GLS_API_URL w .env');
    }
  }

  if (!process.env.GLS_USERNAME || !process.env.GLS_PASSWORD) {
    fail('Dane logowania GLS (GLS_USERNAME lub GLS_PASSWORD) nie są ustawione — drukowanie etykiet nie zadziała!');
  } else {
    pass('Dane logowania GLS — ustawione (nie testujemy wywołania SOAP, bo może rejestrować testową przesyłkę)');
  }
}

// ─────────────────────────────────
//  7. DRUKARKA (opcjonalnie)
// ─────────────────────────────────
sep('Krok 7: Drukarka etykiet (TCP/ZPL)');

async function testPrinter() {
  const ip   = process.env.PRINTER_IP;
  const port = parseInt(process.env.PRINTER_PORT || '9100');
  if (!ip) {
    warning('PRINTER_IP nie ustawiony — test pominięty.');
    info('Jeśli drukarka jest podłączona przez sieć (Godex, Zebra, itp.) ustaw PRINTER_IP w .env');
    return;
  }
  await tcpPing(ip, port, `drukarka ${ip}`);
}

// ─────────────────────────────────
//  MAIN
// ─────────────────────────────────
async function run() {
  await runTcpTests();
  const pool = await testSQL();
  await testSchema(pool);
  await testGLS();
  await testPrinter();

  if (pool) {
    try { await pool.close(); } catch(_) {}
  }

  console.log('\n══════════════════════════════════');
  console.log('  Podsumowanie diagnostyki');
  console.log('══════════════════════════════════');
  console.log(`  ✅ OK:       ${ok}`);
  console.log(`  ⚠️  Ostrzeżenia: ${warn}`);
  console.log(`  ❌ Błędy:    ${err}`);
  if (err === 0 && warn === 0) console.log('\n  🎉 Wszystko gotowe do pracy!\n');
  else if (err === 0)          console.log('\n  🟡 Drobne ostrzeżenia — program może działać, ale sprawdź uwagi.\n');
  else                         console.log('\n  🔴 Są błędy — program może nie działać poprawnie. Przejrzyj wyniki powyżej.\n');
}

run().catch(e => {
  console.error('\n  ❌ Nieoczekiwany błąd diagnostyki:', e.message);
  process.exit(1);
});
