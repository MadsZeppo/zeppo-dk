import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendFile, mkdir, readFile } from 'fs/promises';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vapi sender store payloads — sæt 10MB limit.
 * Gem rå body til Twilio signature-validering.
 */
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({
  extended: true,
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.static(__dirname));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const VVS_NUMBER = process.env.VVS_NUMBER;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VAPI_SECRET = process.env.VAPI_SECRET;

/**
 * ==================================================
 * IDEMPOTENS
 * ==================================================
 */
const processedCalls = new Map();
const CALL_TTL_MS = 24 * 60 * 60 * 1000;

function markCallProcessed(callId) { processedCalls.set(callId, Date.now()); }
function isCallProcessed(callId) { return processedCalls.has(callId); }

setInterval(() => {
  const now = Date.now();
  for (const [callId, ts] of processedCalls.entries()) {
    if (now - ts > CALL_TTL_MS) processedCalls.delete(callId);
  }
}, 60 * 60 * 1000);

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout efter ${ms}ms`)), ms)
    ),
  ]);
}

function getSaesonKontekst(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m === 12 || m === 1 || m === 2) return 'vinter/frost';
  if (m === 11 || m === 3) return 'vinter';
  if (m >= 6 && m <= 8) return 'sommer';
  return 'overgangssæson';
}

function safe(value, fallback = 'Ikke oplyst') {
  if (!value || String(value).trim() === '' || String(value).trim() === 'null') return fallback;
  return String(value).trim();
}

function cleanField(value) {
  const cleaned = safe(value, '');
  return cleaned === 'Ikke oplyst' ? '' : cleaned;
}

function getCustomerPhone(message) {
  return (
    message?.call?.customer?.number ||
    message?.call?.phoneNumber ||
    message?.customer?.number ||
    message?.phoneNumber ||
    null
  );
}

function getCallId(message) {
  return (
    message?.call?.id ||
    message?.callId ||
    message?.call?.callId ||
    null
  );
}

/**
 * ==================================================
 * VAPI WEBHOOK VALIDERING
 * ==================================================
 */
function validerVapiRequest(req) {
  if (!VAPI_SECRET) {
    console.warn('⚠️  VAPI_SECRET ikke sat — webhook er IKKE beskyttet!');
    return true;
  }

  const muligeHeaders = [
    'x-vapi-secret', 'x-vapi-signature', 'vapi-secret',
    'x-secret', 'authorization', 'x-webhook-secret',
  ];

  let headerSecret = null;
  let foundHeader = null;
  for (const name of muligeHeaders) {
    if (req.headers[name]) {
      headerSecret = req.headers[name];
      foundHeader = name;
      break;
    }
  }

  if (!headerSecret) {
    console.warn('🚫 Ingen secret-header fundet. Modtagne headers:',
      Object.keys(req.headers).filter(h => !h.startsWith('x-forwarded') && h !== 'user-agent').join(', ')
    );
    return false;
  }

  const cleanedSecret = String(headerSecret).replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(cleanedSecret);
  const b = Buffer.from(String(VAPI_SECRET));
  if (a.length !== b.length) {
    console.warn(`🚫 Secret-længde mismatch i header "${foundHeader}" (modtog ${a.length} tegn, forventede ${b.length})`);
    return false;
  }
  const match = crypto.timingSafeEqual(a, b);
  if (match) console.log(`🔐 Webhook valideret via header "${foundHeader}"`);
  else console.warn(`🚫 Secret-værdi mismatch i header "${foundHeader}"`);
  return match;
}

/**
 * ==================================================
 * POSTNUMMER + DAWA ADRESSEVALIDERING
 * ==================================================
 */
function normalizeDanishText(value = '') {
  return String(value)
    .toLowerCase().trim()
    .replaceAll('æ', 'ae').replaceAll('ø', 'oe').replaceAll('å', 'aa')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
}

function transcriptClearlySays6100(transcript = '') {
  const t = normalizeDanishText(transcript);
  return (
    t.includes('6100') ||
    t.includes('seks tusind et hundrede') || t.includes('seks tusinde et hundrede') ||
    t.includes('seks et nul nul') || t.includes('seks en nul nul') ||
    t.includes('seks ti hundrede') || t.includes('enogtres hundrede')
  );
}

function transcriptClearlySays6200(transcript = '') {
  const t = normalizeDanishText(transcript);
  return (
    t.includes('6200') ||
    t.includes('seks tusind to hundrede') || t.includes('seks tusinde to hundrede') ||
    t.includes('seks to nul nul') || t.includes('toogtres hundrede')
  );
}

function normalizePostnummerStrict(value, transcript = '') {
  const raw = String(value || '').replace(/\D/g, '');
  if (!raw) return 'Ikke oplyst';
  if (/^[1-9]\d{3}$/.test(raw)) return raw;
  if (raw === '0061' && transcriptClearlySays6100(transcript)) return '6100';
  if (raw === '0026' && transcriptClearlySays6200(transcript)) return '6200';
  return 'Ikke oplyst';
}

function levenshtein(a = '', b = '') {
  a = normalizeDanishText(a);
  b = normalizeDanishText(b);
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a = '', b = '') {
  const aa = normalizeDanishText(a);
  const bb = normalizeDanishText(b);
  if (!aa || !bb) return 0;
  return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length);
}

async function dawaFetch(params, timeoutMs = 6000) {
  const url = new URL('https://api.dataforsyningen.dk/adresser');
  for (const [key, value] of Object.entries(params)) {
    if (value && String(value).trim() !== '' && value !== 'Ikke oplyst') {
      url.searchParams.set(key, String(value).trim());
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DAWA svarede ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function getRoadNameFromDawaAddress(address) {
  return address?.adgangsadresse?.vejstykke?.navn || address?.vejstykke?.navn || '';
}

async function validerAdresseMedDawa(info, transcript = '') {
  const vejnavn = cleanField(info.vejnavn);
  const husnummer = cleanField(info.husnummer);
  const postnummer = normalizePostnummerStrict(info.postnummer, transcript);

  if (!vejnavn || !husnummer || !postnummer || postnummer === 'Ikke oplyst') {
    return {
      ...info, postnummer,
      adresse_status: 'USIKKER',
      adresse_note: 'Mangler sikkert vejnavn, husnummer eller postnummer',
      adresse_forslag: safe(info.adresse_forslag),
    };
  }

  try {
    console.log('🔎 DAWA søger:', { vejnavn, husnummer, postnummer });
    const exact = await dawaFetch({ vejnavn, husnr: husnummer, postnr: postnummer });

    if (Array.isArray(exact) && exact.length > 0) {
      return {
        ...info, postnummer,
        adresse: exact[0].betegnelse || info.adresse,
        adresse_status: 'BEKRÆFTET',
        adresse_note: 'Fundet som præcis adresse i DAWA',
        adresse_forslag: exact[0].betegnelse || 'Ikke oplyst',
      };
    }

    const candidates = await dawaFetch({ husnr: husnummer, postnr: postnummer });
    console.log('🏠 DAWA candidates:', Array.isArray(candidates) ? candidates.length : 0);

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return {
        ...info, postnummer,
        adresse_status: 'USIKKER',
        adresse_note: `Ingen adresse fundet med husnummer ${husnummer} i postnummer ${postnummer}`,
        adresse_forslag: 'Ikke oplyst',
      };
    }

    const ranked = candidates.map((candidate) => {
      const candidateRoad = getRoadNameFromDawaAddress(candidate);
      return { candidate, candidateRoad, score: similarity(vejnavn, candidateRoad) };
    }).sort((a, b) => b.score - a.score);

    const best = ranked[0];
    const second = ranked[1];

    console.log('🏁 Bedste adresse-match:', {
      road: best?.candidateRoad, score: best?.score,
      address: best?.candidate?.betegnelse,
      secondRoad: second?.candidateRoad, secondScore: second?.score,
    });

    const strongEnough = best?.score >= 0.86;
    const clearlyBest = !second || best.score - second.score >= 0.12;

    if (best && strongEnough && clearlyBest) {
      return {
        ...info, postnummer,
        adresse: best.candidate.betegnelse || info.adresse,
        adresse_status: 'MULIGT_MATCH',
        adresse_note: `Sikkert fuzzy match: "${vejnavn}" ligner "${best.candidateRoad}"`,
        adresse_forslag: best.candidate.betegnelse || 'Ikke oplyst',
      };
    }

    return {
      ...info, postnummer,
      adresse_status: 'USIKKER',
      adresse_note: `Kunne ikke sikkert matche "${vejnavn}" med husnummer ${husnummer} i postnummer ${postnummer}`,
      adresse_forslag: best?.candidate?.betegnelse || 'Ikke oplyst',
    };
  } catch (err) {
    console.error('❌ DAWA adressefejl:', err.message);
    return {
      ...info, postnummer,
      adresse_status: 'USIKKER',
      adresse_note: `DAWA-fejl: ${err.message}`,
      adresse_forslag: safe(info.adresse_forslag),
    };
  }
}

/**
 * ==================================================
 * EKSTRAKTION AF BOOKING INFO
 * ==================================================
 *
 * "problem"-feltet skal være en FYLDIG, sammenhængende beskrivelse
 * så mester kan læse den og vide hvad han kører ud til.
 */
async function udtraekBookingInfo(transcript, customerPhone, saesonKontekst) {
  const erVinter = saesonKontekst === 'vinter' || saesonKontekst === 'vinter/frost';
  const erFrost = saesonKontekst === 'vinter/frost';

  const response = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `
Du udtrækker VVS-arbejdsordre-info fra danske telefonopkald.
Returner KUN gyldig JSON. Ingen markdown. Ingen forklaring.

SÆSON-KONTEKST: Det er ${saesonKontekst}.
${erFrost ? 'Det er FROSTSÆSON. Manglende varme, sprunget rør og afkoblede rør i krybekælder/uopvarmet rum skal opgraderes ét niveau.' : ''}
${erVinter && !erFrost ? 'Det er VINTER. Manglende varme i hele boligen er højere prioritet end om sommeren.' : ''}

PROBLEM-FELTET — KRITISK:
"problem" skal være en KOMPLET, FYLDIG beskrivelse som en mester kan læse i sin bil og forstå præcis hvad han kører ud til. Skriv det som 2-4 sammenhængende sætninger i almindeligt dansk, IKKE punktopstilling.
Inkluder ALT relevant fra samtalen:
- Hvad er der galt (præcise symptomer kunden beskrev: drypper, sprøjter, stiger, gurgler, lugter, blinker, viser fejlkode)
- Omfang (ét sted eller flere, hvor længe det har stået på)
- Sikkerhedshandlinger der allerede er taget (hovedhane lukket, strøm afbrudt, område forladt)
- Vigtige detaljer (om vand er ved el, naboer ramt, vand på gulv, fejlkode på display)

EKSEMPEL GODT:
"Toilet i badeværelset er stoppet og vandet stiger op til kanten når der skylles. Det er ikke det eneste toilet i huset. Kunden har ikke prøvet svupper. Begyndte i morges."

EKSEMPEL DÅRLIGT:
"Toilet stoppet" (mangler symptomer, omfang og kontekst)

EKSEMPEL GODT (lækage):
"Sprunget rør under køkkenvasken, fossede ud. Kunden har lukket hovedhanen og vandet er stoppet. Der er ikke vand i nærheden af stikkontakter. Vasken står med skab nedenunder som er blevet vådt."

VIGTIGE REGLER:
- "omfang" = præcis hvor (fx "ét toilet", "køkkenvask"). ALDRIG "hele boligen" medmindre kunden tydeligt siger det.
- "eneste_toilet" = ja kun hvis kunden eksplicit siger det er det eneste toilet de kan bruge.
- Telefon = altid ${customerPhone || 'Ikke oplyst'}.

PRIORITET:
- P0 = gas, kulilte, vand ved el med fare, akut personfare, ukontrollerbar sprøjtende lækage
- P1 = stoppet aktiv lækage med større skade, kloakvand i bolig, mulig faldstamme med overløb, frostsprængning med stort vandtab${erFrost ? ', ingen varme i hele boligen om vinteren ved frost' : ''}
- P2 = eneste toilet ude af drift, intet varmt vand i hele boligen, ${erVinter ? 'ingen varme i hele boligen' : 'ingen varme i hele boligen i kulde'}, dryplækage under kontrol
- P3 = lokalt varmtvand, enkelt radiator/rum koldt, løbende toilet, dryppende armatur, langsomt afløb, stoppet toilet uden overløb
- P4 = planlagt installation, montering, udskiftning, tilbud
- "pludseligt" alene giver IKKE højere prioritet.
- Hvis i tvivl mellem to niveauer: vælg det LAVERE, medmindre der er klar grund til at opgradere.

AKUT_NIVEAU: P0/P1 → RØD, P2 → GUL, P3 → GUL hvis tidskritisk ellers GRØN, P4 → GRØN

KATEGORI: toilet, afløb, lækage, varme, varmt vand, kedel, radiator, gulvvarme, vandtryk, armatur, installation, gas, frostsprængning, andet

FÆLLES INSTALLATION: vicevaert_relevant = ja hvis lejlighed + (flere afløb ramt ELLER naboer ramt ELLER toilet stiger uden skyl ELLER hele ejendommen uden vand/varme). Ellers nej.

VARMEKILDE: fjernvarme, gasfyr, varmtvandsbeholder, varmepumpe, elvandvarmer, ukendt, ikke relevant
TOILET_TYPE: væghængt, gulvstående, ukendt, ikke relevant

KEMIKALIER: Hvis kunden nævner kaustisk soda, syre, afløbsrens eller andre kemikalier i forsogt, sæt kemikalier_brugt = ja.

ADRESSE:
- vejnavn = kun vejnavn
- husnummer = tal + evt. bogstav
- postnummer = 4 cifre. Danske postnumre starter ikke med 0. Hvis usikker: "Ikke oplyst".
- adresse_raw = kundens ordlyd så tæt som muligt.
          `.trim(),
        },
        {
          role: 'user',
          content: `
Transskript:
${transcript}

Returner præcis dette JSON-objekt:
{
  "navn": "kundens navn eller Ikke oplyst",
  "telefon": "${customerPhone || 'Ikke oplyst'}",

  "adresse_raw": "adressen som kunden sagde den eller Ikke oplyst",
  "vejnavn": "kun vejnavn eller Ikke oplyst",
  "husnummer": "kun husnummer eller Ikke oplyst",
  "postnummer": "kun postnummer, 4 cifre eller Ikke oplyst",
  "adresse": "fuld adresse eller Ikke oplyst",
  "adresse_status": "ikke_valideret",
  "adresse_note": "Ikke oplyst",
  "adresse_forslag": "Ikke oplyst",

  "boligtype": "hus, lejlighed, rækkehus, sommerhus, erhverv eller Ikke oplyst",
  "bygningsalder": "kundens svar eller Ikke oplyst",

  "problem": "FYLDIG beskrivelse på 2-4 sætninger med symptomer, omfang, sikkerhedshandlinger og kontekst",
  "kategori": "se liste ovenfor",
  "prioritet": "P0, P1, P2, P3 eller P4",
  "akut_niveau": "RØD, GUL eller GRØN",
  "omfang": "præcis placering",
  "eneste_toilet": "ja eller nej",
  "toilet_type": "se liste ovenfor",
  "varmekilde": "se liste ovenfor",
  "fejlkode": "fejlkode/display-tekst eller Ikke oplyst",

  "startede": "hvornår eller Ikke oplyst",
  "forsogt": "hvad kunden har prøvet eller Ikke oplyst",
  "kemikalier_brugt": "ja eller nej",

  "vicevaert_relevant": "ja eller nej",
  "forsikring_informeret": "ja, nej eller ikke spurgt",

  "tidspunkt": "ønsket tidspunkt eller Ikke oplyst",
  "adgang": "adgang/parkering/portkode eller Ikke oplyst",

  "ekstra_noter": "vigtige flag eller Ikke oplyst"
}
          `.trim(),
        },
      ],
    }),
    25000,
    'OpenAI extraction'
  );

  try {
    const info = JSON.parse(response.choices[0].message.content.trim());
    info.telefon = customerPhone || 'Ikke oplyst';
    info.adresse_raw = safe(info.adresse_raw);
    info.vejnavn = safe(info.vejnavn);
    info.husnummer = safe(info.husnummer);
    info.postnummer = normalizePostnummerStrict(info.postnummer, transcript);
    info.adresse = safe(info.adresse);
    info.adresse_status = safe(info.adresse_status, 'ikke_valideret');
    info.adresse_note = safe(info.adresse_note);
    info.adresse_forslag = safe(info.adresse_forslag);
    info.bygningsalder = safe(info.bygningsalder);
    info.akut_niveau = safe(info.akut_niveau, 'GRØN');
    info.toilet_type = safe(info.toilet_type, 'ikke relevant');
    info.varmekilde = safe(info.varmekilde, 'ikke relevant');
    info.fejlkode = safe(info.fejlkode);
    info.kemikalier_brugt = safe(info.kemikalier_brugt, 'nej');
    info.vicevaert_relevant = safe(info.vicevaert_relevant, 'nej');
    info.forsikring_informeret = safe(info.forsikring_informeret, 'ikke spurgt');
    info.ekstra_noter = safe(info.ekstra_noter);
    info.saeson_kontekst = saesonKontekst;
    return info;
  } catch (err) {
    console.error('JSON parse fejl:', err.message);
    return defaultInfo(customerPhone, saesonKontekst);
  }
}

function defaultInfo(customerPhone, saesonKontekst) {
  return {
    navn: 'Ikke oplyst', telefon: customerPhone || 'Ikke oplyst',
    adresse_raw: 'Ikke oplyst', vejnavn: 'Ikke oplyst', husnummer: 'Ikke oplyst',
    postnummer: 'Ikke oplyst', adresse: 'Ikke oplyst', adresse_status: 'USIKKER',
    adresse_note: 'Kunne ikke parse JSON', adresse_forslag: 'Ikke oplyst',
    boligtype: 'Ikke oplyst', bygningsalder: 'Ikke oplyst',
    problem: 'Ikke oplyst', kategori: 'andet', prioritet: 'P3', akut_niveau: 'GRØN',
    omfang: 'Ikke oplyst', eneste_toilet: 'nej', toilet_type: 'ikke relevant',
    varmekilde: 'ikke relevant', fejlkode: 'Ikke oplyst',
    startede: 'Ikke oplyst', forsogt: 'Ikke oplyst', kemikalier_brugt: 'nej',
    vicevaert_relevant: 'nej', forsikring_informeret: 'ikke spurgt',
    tidspunkt: 'Ikke oplyst', adgang: 'Ikke oplyst',
    ekstra_noter: 'Ikke oplyst', saeson_kontekst: saesonKontekst,
  };
}

/**
 * ==================================================
 * SMS-OPBYGNING
 * ==================================================
 *
 * VVS-SMS er ren og scannbar. Adresse vises uden status-flag —
 * kunden får selv SMS hvor de bedes rette adressen hvis den er forkert.
 */
function bygVvsSms(info) {
  const niveau = safe(info.akut_niveau);
  const emoji =
    niveau === 'RØD' ? '🚨' :
    niveau === 'GUL' ? '⚠️' : '🔧';

  const linjer = [
    `${emoji} NY VVS SAG`,
    ``,
    `${safe(info.prioritet)} · ${niveau} · ${safe(info.kategori)}`,
    ``,
    `Kunde: ${safe(info.navn)}`,
    `Tlf: ${safe(info.telefon)}`,
    `Adresse: ${safe(info.adresse)}`,
  ];

  linjer.push(`Bolig: ${safe(info.boligtype)}`);
  if (safe(info.bygningsalder) !== 'Ikke oplyst') {
    linjer.push(`Bygning: ${safe(info.bygningsalder)}`);
  }

  linjer.push(``);
  linjer.push(`Problem: ${safe(info.problem)}`);
  linjer.push(`Placering: ${safe(info.omfang)}`);

  if (info.eneste_toilet === 'ja') linjer.push(`⚠️ Eneste toilet: Ja`);
  if (
    safe(info.toilet_type) !== 'Ikke oplyst' &&
    safe(info.toilet_type) !== 'ikke relevant' &&
    safe(info.toilet_type) !== 'ukendt'
  ) {
    linjer.push(`Toilet-type: ${info.toilet_type}`);
  }
  if (
    safe(info.varmekilde) !== 'Ikke oplyst' &&
    safe(info.varmekilde) !== 'ikke relevant' &&
    safe(info.varmekilde) !== 'ukendt'
  ) {
    linjer.push(`Varmekilde: ${info.varmekilde}`);
  }
  if (safe(info.fejlkode) !== 'Ikke oplyst') {
    linjer.push(`Fejlkode: ${info.fejlkode}`);
  }
  if (safe(info.startede) !== 'Ikke oplyst') linjer.push(`Start: ${info.startede}`);
  if (safe(info.forsogt) !== 'Ikke oplyst') linjer.push(`Forsøgt: ${info.forsogt}`);

  if (info.kemikalier_brugt === 'ja') {
    linjer.push(``);
    linjer.push(`⚠️ KEMIKALIER BRUGT — medbring syrebestandige handsker og briller`);
  }
  if (info.vicevaert_relevant === 'ja') {
    linjer.push(`⚠️ Mulig fællessag — kunden er bedt om at kontakte vicevært`);
  }
  if (safe(info.forsikring_informeret) === 'ja') {
    linjer.push(`Forsikring: Informeret`);
  }

  linjer.push(``);
  linjer.push(`Tid: ${safe(info.tidspunkt)}`);
  if (safe(info.adgang) !== 'Ikke oplyst') linjer.push(`Adgang: ${info.adgang}`);

  if (safe(info.ekstra_noter) !== 'Ikke oplyst') {
    linjer.push(``);
    linjer.push(`Noter: ${info.ekstra_noter}`);
  }

  return linjer.join('\n');
}

/**
 * Kunde-SMS beder altid om rettelse hvis noget ikke passer.
 * Det er her vi fanger forkerte adresser uden at forstyrre mester.
 */
function bygKundeSms(info) {
  const navn = safe(info.navn) !== 'Ikke oplyst' ? ` ${info.navn}` : '';
  let extra = '';
  if (info.vicevaert_relevant === 'ja') {
    extra = `\n\nHusk også at give viceværten eller ejerforeningen besked, hvis du ikke allerede har gjort det.`;
  }

  return `Hej${navn}

Din henvendelse til Dansk VVS Teknik er modtaget.

Problem: ${safe(info.problem)}
Adresse: ${safe(info.adresse)}

Installatøren ringer dig tilbage og bekræfter tidspunktet.${extra}

Hvis adressen eller noget andet ikke passer — svar på denne SMS med rettelsen.
- Dansk VVS Teknik`;
}

async function sendSmsSikkert(to, body, label) {
  try {
    await twilioClient.messages.create({ body, from: TWILIO_NUMBER, to });
    console.log(`✅ SMS sendt: ${label} → ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ SMS fejl (${label} → ${to}):`, err.message);
    return false;
  }
}

/**
 * ==================================================
 * VAPI WEBHOOK
 * ==================================================
 */
app.post('/vapi-webhook', async (req, res) => {
  if (!validerVapiRequest(req)) {
    console.warn('🚫 Webhook afvist — ugyldig eller manglende secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;
    if (body.message?.type !== 'end-of-call-report') {
      return res.status(200).json({ ok: true });
    }

    const message = body.message;
    const callId = getCallId(message);
    const transcript = message?.transcript || '';
    const customerPhone = getCustomerPhone(message);

    if (callId && isCallProcessed(callId)) {
      console.log(`⏭️  Duplikat — call ${callId} allerede behandlet`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (callId) markCallProcessed(callId);

    console.log('📞 Opkald sluttede. Behandler...');
    console.log('🆔 Call ID:', callId || 'ingen');

    const saesonKontekst = getSaesonKontekst();
    console.log('🗓️  Sæson:', saesonKontekst);

    let info;
    try {
      info = await udtraekBookingInfo(transcript, customerPhone, saesonKontekst);
    } catch (err) {
      console.error('❌ Ekstraktion fejlede:', err.message);
      info = defaultInfo(customerPhone, saesonKontekst);
      info.ekstra_noter = `EKSTRAKTION FEJLEDE: ${err.message} — installatør skal ringe kunde manuelt`;
    }

    try {
      info = await validerAdresseMedDawa(info, transcript);
    } catch (err) {
      console.error('❌ DAWA fejlede:', err.message);
      info.adresse_status = 'USIKKER';
      info.adresse_note = `DAWA-validering fejlede: ${err.message}`;
    }

    console.log('📋 Booking:', {
      prioritet: info.prioritet,
      akut_niveau: info.akut_niveau,
      kategori: info.kategori,
      adresse_status: info.adresse_status,
      vicevaert: info.vicevaert_relevant,
      kemikalier: info.kemikalier_brugt,
    });

    const vvsSent = await sendSmsSikkert(VVS_NUMBER, bygVvsSms(info), 'VVS-mester');
    if (customerPhone) {
      await sendSmsSikkert(customerPhone, bygKundeSms(info), 'Kunde');
    }

    return res.status(200).json({ ok: true, vvsSent });
  } catch (err) {
    console.error('❌ Webhook fejl:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * ==================================================
 * INDGÅENDE SMS FRA KUNDE
 * ==================================================
 */
app.post('/sms-indgaaende', async (req, res) => {
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  if (TWILIO_AUTH_TOKEN && twilioSignature) {
    const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, url, req.body);
    if (!valid) {
      console.warn('🚫 SMS webhook afvist — ugyldig Twilio signature');
      return res.status(403).send('Forbidden');
    }
  }

  try {
    const fraNummer = req.body.From;
    const besked = req.body.Body;
    console.log(`📩 SMS fra ${fraNummer}`);

    await sendSmsSikkert(
      VVS_NUMBER,
      `📩 RETTELSE FRA KUNDE\n\nFra: ${fraNummer}\n\n"${besked}"`,
      'Rettelse til VVS'
    );

    res.set('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Tak. Vi har sendt din besked videre til installatøren. - Dansk VVS Teknik</Message></Response>`);
  } catch (err) {
    console.error('❌ SMS fejl:', err.message);
    return res.status(500).send('Fejl');
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    saeson: getSaesonKontekst(),
    processedCalls: processedCalls.size,
    uptime: process.uptime(),
  });
});

app.post('/demo-lead', async (req, res) => {
  try {
    const lead = {
      createdAt: new Date().toISOString(),
      name: safe(req.body.name),
      company: safe(req.body.company),
      phone: safe(req.body.phone),
      email: safe(req.body.email),
      message: safe(req.body.message, ''),
    };

    if (lead.name === 'Ikke oplyst' || lead.company === 'Ikke oplyst' || lead.phone === 'Ikke oplyst' || lead.email === 'Ikke oplyst') {
      return res.status(400).json({ ok: false, error: 'Mangler påkrævede felter' });
    }

    await mkdir(path.join(__dirname, 'data'), { recursive: true });
    await appendFile(path.join(__dirname, 'data', 'demo-leads.jsonl'), `${JSON.stringify(lead)}\n`, 'utf8');

    if (VVS_NUMBER) {
      await sendSmsSikkert(
        VVS_NUMBER,
        `📩 NY DEMO FORESPØRGSEL\n\nNavn: ${lead.name}\nFirma: ${lead.company}\nTlf: ${lead.phone}\nEmail: ${lead.email}\n\n${lead.message || 'Ingen besked'}`,
        'Demo lead'
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Demo lead fejl:', err.message);
    return res.status(500).json({ ok: false, error: 'Kunne ikke gemme forespørgsel' });
  }
});

app.get('/api/demo-leads', async (_req, res) => {
  try {
    const file = path.join(__dirname, 'data', 'demo-leads.jsonl');
    const content = await readFile(file, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const leads = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .reverse();

    return res.json({ ok: true, leads });
  } catch (err) {
    console.error('❌ Kunne ikke hente demo leads:', err.message);
    return res.status(500).json({ ok: false, error: 'Kunne ikke hente forespørgsler' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ VVS Backend kører på port ${PORT}`);
  console.log(`📞 Vapi webhook: POST /vapi-webhook`);
  console.log(`📩 SMS indgående: POST /sms-indgaaende`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🗓️  Sæson: ${getSaesonKontekst()}`);
  if (!VAPI_SECRET) console.warn('⚠️  VAPI_SECRET ikke sat — sæt den i .env');
});
