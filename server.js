import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendFile, mkdir, readFile } from 'fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import realtimeCallHandler from './api/realtime-call.js';
import createWooCommerceOrderHandler from './api/create-woocommerce-order.js';
import createRealtimeOrderHandler, { createRealtimeOrder } from './api/realtime-order-create.js';
import realtimeSessionHandler from './api/realtime-session.js';
import ttsHandler from './api/tts.js';
import { getTranscript as getSharedTranscript } from './api/_vvs-shared.js';
import { GODTFOLK_FAST_INSTRUCTIONS, HAERVEJEN_FAST_INSTRUCTIONS } from './lib/godtfolk-prompt.js';
import {
  createCall as createDashboardCall,
  createOrder as createDashboardOrder,
  findOrCreateCustomer,
  findCustomerById,
  findCustomerByPhone,
  logSystemEvent,
  updateCall as updateDashboardCall,
} from './lib/supabase.js';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer(app);

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
app.use(express.static(path.join(__dirname, 'public')));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const VVS_NUMBER = process.env.VVS_NUMBER;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VAPI_SECRET = process.env.VAPI_SECRET;

const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';

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

function clean(value) {
  return String(value || '').trim();
}

function cleanField(value) {
  const cleaned = safe(value, '');
  return cleaned === 'Ikke oplyst' ? '' : cleaned;
}

function getCustomerPhone(message) {
  const orderedCandidates = [
    message?.call?.customer?.number,
    message?.customer?.number,
    message?.call?.customer?.phoneNumber,
    message?.customer?.phoneNumber,
    message?.call?.phoneCallProviderDetails?.from,
    message?.call?.from,
    message?.call?.twilio?.from,
    message?.from,
  ].map(normalizePhone).filter(Boolean);

  const selected = orderedCandidates[0] || null;
  console.log('Caller-ID:', { selected, candidates: orderedCandidates });
  return selected;
}

function normalizePhone(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/(?:\+45\s*)?(?:\d[\s-]*){8}|\+\d[\d\s-]{7,18}/);
  if (!match) return null;

  const cleaned = match[0].replace(/[^\d+]/g, '');
  if (/^\+45\d{8}$/.test(cleaned)) return cleaned;
  if (/^\d{8}$/.test(cleaned)) return `+45${cleaned}`;
  if (/^\+\d{8,18}$/.test(cleaned)) return cleaned;
  return null;
}

function getAlternativePhoneFromTranscript(transcript, callerPhone) {
  const caller = normalizePhone(callerPhone);
  const matches = String(transcript || '').match(/(?:\+45\s*)?(?:\d[\s-]*){8}|\+\d[\d\s-]{7,18}/g) || [];
  const phones = matches.map(normalizePhone).filter(Boolean);
  return phones.find((phone) => phone !== caller) || null;
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
- Telefon = ${customerPhone || 'Ikke oplyst'} som standard, når kunden bekræfter nummeret de ringer fra.
- Hvis kunden nævner et andet callback-nummer højt, skal "telefon" være det nye nummer.

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
Hvis vicevaert_relevant = ja, er det IKKE en direkte VVS-dispatch endnu. Sæt prioritet = "AFVENTER VICEVÆRT" og akut_niveau = "INGEN FARVE", medmindre der også er gas, personfare, kloakvand i boligen eller vand ved el.

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
  "prioritet": "P0, P1, P2, P3, P4 eller AFVENTER VICEVÆRT",
  "akut_niveau": "RØD, GUL, GRØN eller INGEN FARVE",
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
    const callerPhone = normalizePhone(customerPhone);
    const spokenAlternativePhone = getAlternativePhoneFromTranscript(transcript, callerPhone);
    const modelPhone = normalizePhone(info.telefon);
    info.telefon = spokenAlternativePhone || (modelPhone && modelPhone !== callerPhone ? modelPhone : callerPhone) || 'Ikke oplyst';
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
  const isVicevaert = info.vicevaert_relevant === 'ja';
  const niveau = safe(info.akut_niveau);
  const emoji = isVicevaert ? '🏢' : niveau === 'RØD' ? '🚨' : niveau === 'GUL' ? '⚠️' : '🔧';

  const linjer = [
    `${emoji} NY VVS-SAG`,
    ``,
    `Navn: ${safe(info.navn)}`,
    `Tlf: ${info.telefon !== 'Ikke oplyst' ? safe(info.telefon) : 'Kunden ringer tilbage'}`,
    `Adresse: ${safe(info.adresse)}`,
    `Bolig: ${safe(info.boligtype)}`,
    ``,
    `Problem: ${safe(info.problem)}`,
  ];

  if (isVicevaert) {
    linjer.push(``);
    linjer.push(`⚠️ FÆLLES INSTALLATION`);
    linjer.push(`Kunden er bedt om at kontakte viceværten eller ejerforeningen.`);
    linjer.push(`Intet besøg booket — afventer at viceværten tager kontakt.`);
  } else {
    linjer.push(``);
    linjer.push(`Ønsket tid: ${safe(info.tidspunkt)}`);
    if (safe(info.adgang) !== 'Ikke oplyst') linjer.push(`Adgang: ${safe(info.adgang)}`);
  }

  if (safe(info.fejlkode) !== 'Ikke oplyst') linjer.push(`Fejlkode: ${safe(info.fejlkode)}`);
  if (safe(info.forsogt) !== 'Ikke oplyst') linjer.push(`Forsøgt: ${safe(info.forsogt)}`);
  if (info.kemikalier_brugt === 'ja') linjer.push(`⚠️ KEMIKALIER BRUGT`);
  if (safe(info.ekstra_noter) !== 'Ikke oplyst') linjer.push(`Note: ${safe(info.ekstra_noter)}`);

  return linjer.join('\n');
}

/**
 * Kunde-SMS beder altid om rettelse hvis noget ikke passer.
 * Det er her vi fanger forkerte adresser uden at forstyrre mester.
 */
function bygKundeSms(info) {
  const navn = safe(info.navn) !== 'Ikke oplyst' ? ` ${info.navn}` : '';

  if (info.vicevaert_relevant === 'ja') {
    return `Hej${navn}

Tak for din henvendelse til Dansk VVS Teknik.

Problem: ${safe(info.problem)}
Adresse: ${safe(info.adresse)}

Det her lyder som noget på den fælles installation. Husk at give viceværten eller ejerforeningen besked, så de kan sætte arbejdet i gang.

Vi har noteret din henvendelse og er klar fra vores side, hvis viceværten kontakter os.

Hvis noget ikke passer — svar på denne SMS.
- Dansk VVS Teknik`;
  }

  return `Hej${navn}

Din henvendelse til Dansk VVS Teknik er modtaget.

Problem: ${safe(info.problem)}
Adresse: ${safe(info.adresse)}

Installatøren ringer dig tilbage og bekræfter tidspunktet.

Hvis adressen eller noget andet ikke passer — svar på denne SMS med rettelsen.
- Dansk VVS Teknik`;
}

async function sendSmsSikkert(to, body, label) {
  console.log(`SMS deaktiveret: ${label} → ${to}`, { body });
  return true;
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
    const transcript = getSharedTranscript(message);
    const customerPhone = getCustomerPhone(message);

    if (callId && isCallProcessed(callId)) {
      console.log(`⏭️  Duplikat — call ${callId} allerede behandlet`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (callId) markCallProcessed(callId);

    console.log('🔐 Låsesmed-opkald sluttede. Behandler...');
    console.log('🆔 Call ID:', callId || 'ingen');
    console.log('📝 Transcript længde:', transcript.length);

    let info;
    try {
      info = await extractLaasesmedInfo(transcript, customerPhone);
    } catch (err) {
      console.error('❌ Låsesmed-ekstraktion fejlede:', err.message);
      info = defaultLaasesmedInfo(customerPhone);
      info.ekstra_noter = `EKSTRAKTION FEJLEDE: ${err.message} - ring kunde manuelt`;
    }

    console.log('📋 Låsesmed-sag:', {
      navn: info.navn,
      telefon: info.telefon,
      adresse: info.adresse,
      by: info.by,
      kategori: info.kategori,
      prioritet: info.prioritet,
    });

    const leadSent = await sendSmsSikkert(VVS_NUMBER, buildLaasesmedSms(info), 'Låsesmed');

    return res.status(200).json({ ok: true, leadSent });
  } catch (err) {
    console.error('❌ Webhook fejl:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
});

app.post('/api/create-woocommerce-order', createWooCommerceOrderHandler);
app.post('/api/orders/create', createRealtimeOrderHandler);
app.get('/api/realtime-session', realtimeSessionHandler);
app.get('/api/session', realtimeSessionHandler);
app.post('/api/realtime/session', realtimeSessionHandler);
app.post('/api/realtime/call', express.text({ type: ['application/sdp', 'text/plain'], limit: '1mb' }), realtimeCallHandler);
app.post('/api/tts', ttsHandler);

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

function createElevenLabsUrl() {
  const voiceId = clean(process.env.ELEVENLABS_VOICE_ID);
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not configured');

  const url = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input`);
  url.searchParams.set('model_id', ELEVENLABS_MODEL_ID);
  url.searchParams.set('output_format', ELEVENLABS_OUTPUT_FORMAT);
  url.searchParams.set('auto_mode', 'true');
  return url.toString();
}

function sendJson(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function setupElevenLabsTtsProxy(httpServer) {
  const ttsWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname !== '/api/tts-stream' && pathname !== '/tts') return;

    ttsWss.handleUpgrade(req, socket, head, (client) => {
      ttsWss.emit('connection', client, req);
    });
  });

  ttsWss.on('connection', (client) => {
    let eleven = null;
    let elevenReady = false;
    let closed = false;
    const pendingText = [];

    function closeEleven() {
      if (eleven && eleven.readyState === WebSocket.OPEN) {
        console.log('[tts] eleven_ws_end');
        eleven.send(JSON.stringify({ text: '' }));
        eleven.close();
      }
      eleven = null;
      elevenReady = false;
    }

    function openEleven() {
      if (eleven && (eleven.readyState === WebSocket.OPEN || eleven.readyState === WebSocket.CONNECTING)) return;

      const apiKey = clean(process.env.ELEVENLABS_API_KEY);
      if (!apiKey) {
        sendJson(client, { type: 'error', error: 'ELEVENLABS_API_KEY not configured' });
        return;
      }

      let url;
      try {
        url = createElevenLabsUrl();
      } catch (error) {
        sendJson(client, { type: 'error', error: error.message });
        return;
      }

      eleven = new WebSocket(url);

      eleven.on('open', () => {
        console.log('[tts] eleven_ws_open');
        elevenReady = true;
        sendJson(client, { type: 'ready', model: ELEVENLABS_MODEL_ID, output_format: ELEVENLABS_OUTPUT_FORMAT });
        eleven.send(JSON.stringify({
          text: ' ',
          xi_api_key: apiKey,
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.86,
            style: 0.22,
            use_speaker_boost: true,
            speed: 1.05,
          },
          generation_config: {
            chunk_length_schedule: [50, 90, 140, 200],
          },
          language_code: 'da',
        }));

        while (pendingText.length > 0) {
          const text = pendingText.shift();
          console.log('[tts] text chunk', text);
          eleven.send(JSON.stringify({ text, try_trigger_generation: true }));
        }
      });

      eleven.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (data.audio) {
          console.log('[tts] eleven_ws_audio_chunk', {
            is_final: Boolean(data.isFinal),
            chars: data.audio.length,
          });
          sendJson(client, { type: 'audio', audio: data.audio, is_final: Boolean(data.isFinal) });
        }

        if (data.isFinal) {
          sendJson(client, { type: 'final' });
        }
      });

      eleven.on('close', (code, reason) => {
        elevenReady = false;
        console.warn('[tts] eleven_ws_close', {
          code,
          reason: reason?.toString() || '',
        });
        if (!closed) {
          sendJson(client, {
            type: 'closed',
            code,
            reason: reason?.toString() || '',
          });
        }
      });

      eleven.on('error', (error) => {
        console.error('[tts] eleven_ws_error', error.message);
        sendJson(client, { type: 'error', error: error.message });
      });
    }

    client.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendJson(client, { type: 'error', error: 'Invalid JSON message' });
        return;
      }

      if (message.type === 'start') {
        closeEleven();
        openEleven();
        return;
      }

      if (message.type === 'text') {
        const text = clean(message.text);
        if (!text) return;
        openEleven();
        if (elevenReady && eleven?.readyState === WebSocket.OPEN) {
          console.log('[tts] text chunk', text);
          eleven.send(JSON.stringify({ text, try_trigger_generation: true }));
        } else {
          pendingText.push(text);
        }
        return;
      }

      if (message.type === 'flush') {
        if (elevenReady && eleven?.readyState === WebSocket.OPEN) {
          console.log('[tts] eleven_ws_flush');
          eleven.send(JSON.stringify({ text: ' ', try_trigger_generation: true }));
        }
        return;
      }

      if (message.type === 'cancel') {
        console.log('[tts] eleven_ws_cancel');
        closeEleven();
        pendingText.length = 0;
        sendJson(client, { type: 'cancelled' });
        return;
      }

      if (message.type === 'end') {
        console.log('[tts] client_ws_end');
        closeEleven();
        pendingText.length = 0;
        return;
      }
    });

    client.on('close', (code, reason) => {
      console.warn('[tts] client_ws_close', {
        code,
        reason: reason?.toString() || '',
      });
      closed = true;
      closeEleven();
    });
  });
}

const OPENAI_REALTIME_WS_MODEL = 'gpt-realtime';
const OPENAI_REALTIME_INPUT_RATE = 24000;
const OPENAI_MIN_COMMIT_AUDIO_MS = 100;
const CARTESIA_VERSION = process.env.CARTESIA_VERSION || '2026-03-01';
const CARTESIA_MODEL_ID = process.env.CARTESIA_MODEL_ID || 'sonic-3.5';
const SUPABASE_DEFAULT_CUSTOMER_ID = clean(process.env.SUPABASE_DEFAULT_CUSTOMER_ID || process.env.ZEPPO_CUSTOMER_ID);
const SUPABASE_DEFAULT_CUSTOMER_NAME = clean(process.env.SUPABASE_DEFAULT_CUSTOMER_NAME || process.env.ZEPPO_CUSTOMER_NAME || 'Danske Fragtmænd');

const VOICE_AGENT_PROFILES = {
  napoli: {
    id: 'napoli',
    businessName: 'Danske Fragtmænd',
    assistantName: 'Anja',
    instructions: GODTFOLK_FAST_INSTRUCTIONS,
    greeting: 'Hej og velkommen du har ringet til Danske fragtmænd',
    greetingPronunciation: 'Udtal Danske Fragtmænd roligt og samlet.',
    voiceEnv: 'CARTESIA_VOICE_ID',
    allowOrders: false,
  },
  haervejen: {
    id: 'haervejen',
    businessName: 'Restaurant Hærvejen',
    assistantName: 'Freja',
    instructions: HAERVEJEN_FAST_INSTRUCTIONS,
    greeting: 'Hej og velkommen til Restaurant Hærvejen, hvad kan jeg hjælpe med?',
    greetingPronunciation: 'Udtal Restaurant Hærvejen roligt og samlet.',
    voiceEnv: 'CARTESIA_VOICE_ID_HAERVEJEN',
    allowOrders: false,
  },
};

function resolveVoiceAgentProfile(agentId) {
  return VOICE_AGENT_PROFILES[clean(agentId).toLowerCase()] || VOICE_AGENT_PROFILES.napoli;
}

function setupCartesiaVoiceAgent(httpServer) {
  const voiceWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname !== '/api/voice-agent') return;

    voiceWss.handleUpgrade(req, socket, head, (client) => {
      voiceWss.emit('connection', client, req);
    });
  });

  voiceWss.on('connection', (client) => {
    console.log('[voice] client_connected');
    sendJson(client, { type: 'ws_connected' });

    let openaiWs = null;
    let cartesiaWs = null;
    let cartesiaReady = false;
    let cartesiaOutputRate = 48000;
    let currentContextId = null;
    let responseActive = false;
    let responseCreatePending = false;
    let pendingOpenAiAudio = [];
    let pendingCartesiaText = [];
    let sessionStarted = false;
    let greetingSent = false;
    let greetingResponseActive = false;
    let audioChunkSeenForResponse = false;
    let ttsTextBuffer = '';
    let hasUncommittedOpenAiAudio = false;
    let uncommittedOpenAiAudioMs = 0;
    let manualResponsePending = false;
    let manualCommitPending = false;
    let speechStoppedFallbackTimer = null;
    let binaryFrameLogCount = 0;
    const voiceSessionId = crypto.randomUUID();
    const pendingToolCalls = new Map();
    const handledToolCallIds = new Set();
    let latestUserTranscript = '';
    let knownCustomerName = '';
    let assistantResponseText = '';
    let awaitingOrderConfirmation = false;
    let orderConfirmationAnswered = false;
    let orderConfirmationApproved = false;
    let forceOrderToolOnNextResponse = false;
    let awaitingCustomerName = false;
    let awaitingTranscriptAfterCommit = false;
    let dashboardCustomer = null;
    let dashboardCall = null;
    let dashboardCallStartedAt = 0;
    let dashboardCallInitPromise = null;
    let dashboardCallFinalized = false;
    let dashboardCallHadOrder = false;
    let activeProfile = VOICE_AGENT_PROFILES.napoli;
    const transcriptLines = [];

    function clientJson(data) {
      sendJson(client, data);
    }

    function appendTranscriptLine(role, text) {
      const cleaned = clean(text);
      if (!cleaned) return;
      transcriptLines.push(`${role}: ${cleaned}`);
    }

    function inboundNumberCandidates(options = {}) {
      return [
        options.toNumber,
        options.to,
        options.twilioPhoneNumber,
        process.env.ZEPPO_TWILIO_PHONE_NUMBER,
        process.env.TWILIO_PHONE_NUMBER,
        process.env.VOICE_AGENT_TO_NUMBER,
      ]
        .map((value) => clean(value))
        .flatMap((value) => [value, normalizePhone(value)])
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index);
    }

    function callerNumberFromOptions(options = {}) {
      return (
        clean(options.callerNumber) ||
        clean(options.fromNumber) ||
        clean(options.from) ||
        clean(process.env.VOICE_AGENT_TEST_CALLER_NUMBER) ||
        'browser-test'
      );
    }

    async function resolveDashboardCustomer(options = {}) {
      for (const phone of inboundNumberCandidates(options)) {
        const customer = await findCustomerByPhone(phone);
        if (customer) return customer;
      }

      const defaultCustomer = await findOrCreateCustomer({
        name: clean(options.customerName) || SUPABASE_DEFAULT_CUSTOMER_NAME,
        twilio_phone_number: clean(options.toNumber) || clean(options.to) || clean(process.env.ZEPPO_TWILIO_PHONE_NUMBER),
        contact_phone: clean(process.env.VOICE_AGENT_TEST_CALLER_NUMBER),
      });
      if (defaultCustomer) return defaultCustomer;

      if (SUPABASE_DEFAULT_CUSTOMER_ID) {
        console.warn('[Supabase] falling back to SUPABASE_DEFAULT_CUSTOMER_ID');
        return findCustomerById(SUPABASE_DEFAULT_CUSTOMER_ID);
      }

      return null;
    }

    async function initializeDashboardCall(options = {}) {
      dashboardCallStartedAt = Date.now();
      const customer = await resolveDashboardCustomer(options);
      if (!customer) {
        console.warn('[Supabase] no active customer found for voice session');
        return null;
      }

      const call = await createDashboardCall({
        customer_id: customer.id,
        caller_number: callerNumberFromOptions(options),
      });

      if (!call) return null;

      dashboardCustomer = customer;
      dashboardCall = call;
      logSystemEvent({
        customer_id: customer.id,
        call_id: call.id,
        level: 'info',
        source: 'voice-server',
        message: 'Call started',
        metadata: {
          session_id: voiceSessionId,
          caller_number: call.caller_number,
          transport: 'websocket',
        },
      });

      return { customer, call };
    }

    async function getDashboardContext() {
      if (dashboardCallInitPromise) await dashboardCallInitPromise;
      if (!dashboardCustomer || !dashboardCall) return null;
      return { customer: dashboardCustomer, call: dashboardCall };
    }

    async function finalizeDashboardCall(status) {
      if (dashboardCallFinalized) return;
      dashboardCallFinalized = true;
      const context = await getDashboardContext();
      if (!context) return;

      const endedAt = new Date();
      const durationSeconds = dashboardCallStartedAt
        ? Math.max(0, Math.round((endedAt.getTime() - dashboardCallStartedAt) / 1000))
        : null;
      const finalStatus = status || (dashboardCallHadOrder ? 'order_created' : 'completed');

      await updateDashboardCall(context.call.id, {
        ended_at: endedAt.toISOString(),
        duration_seconds: durationSeconds,
        transcript: transcriptLines.join('\n'),
        status: finalStatus,
      });

      logSystemEvent({
        customer_id: context.customer.id,
        call_id: context.call.id,
        level: 'info',
        source: 'voice-server',
        message: 'Call ended',
        metadata: {
          session_id: voiceSessionId,
          status: finalStatus,
          duration_seconds: durationSeconds,
          transcript_lines: transcriptLines.length,
        },
      });
    }

    function ensureEnv(profile = activeProfile) {
      const missing = [];
      if (!clean(process.env.OPENAI_API_KEY)) missing.push('OPENAI_API_KEY');
      if (!clean(process.env.CARTESIA_API_KEY)) missing.push('CARTESIA_API_KEY');
      if (!clean(process.env[profile.voiceEnv])) missing.push(profile.voiceEnv);
      if (missing.length) {
        clientJson({ type: 'error', error: `Missing environment variables: ${missing.join(', ')}` });
        return false;
      }
      return true;
    }

    function closeOpenAi() {
      if (speechStoppedFallbackTimer) {
        clearTimeout(speechStoppedFallbackTimer);
        speechStoppedFallbackTimer = null;
      }
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      openaiWs = null;
      pendingOpenAiAudio = [];
      greetingSent = false;
      hasUncommittedOpenAiAudio = false;
      uncommittedOpenAiAudioMs = 0;
      manualResponsePending = false;
      manualCommitPending = false;
      responseCreatePending = false;
      awaitingTranscriptAfterCommit = false;
    }

    function closeCartesia() {
      if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) cartesiaWs.close();
      cartesiaWs = null;
      cartesiaReady = false;
      currentContextId = null;
      pendingCartesiaText = [];
    }

    function openOpenAi() {
      if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) return;

      function sendInitialGreeting() {
        if (greetingSent || openaiWs?.readyState !== WebSocket.OPEN) return;
        greetingSent = true;
        greetingResponseActive = true;
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            output_modalities: ['text'],
            instructions: `Sig præcis denne ene sætning og intet andet: "${activeProfile.greeting}" ${activeProfile.greetingPronunciation}`,
          },
        }));
      }

      openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_WS_MODEL}`, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      });

      openaiWs.on('open', () => {
        console.log('[voice] openai_ws_open');
        clientJson({ type: 'openai_status', status: 'connected' });
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: (() => {
            const session = {
            type: 'realtime',
            instructions: activeProfile.instructions,
            output_modalities: ['text'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: OPENAI_REALTIME_INPUT_RATE },
                transcription: { model: 'whisper-1', language: 'da' },
                turn_detection: {
                  type: 'semantic_vad',
                  eagerness: 'high',
                  create_response: false,
                  interrupt_response: true,
                },
              },
            },
            tool_choice: 'auto',
          };

          if (activeProfile.allowOrders) {
            session.tools = [
              {
                type: 'function',
                name: 'create_woocommerce_order',
                description: 'Opretter en bekræftet Pizzaria Napoli ordre i WooCommerce. Må kun kaldes efter kunden tydeligt har bekræftet opsummeringen.',
                parameters: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    confirmed_by_customer: {
                      type: 'boolean',
                      description: 'Skal være true, og kun hvis kunden lige har bekræftet opsummeringen.',
                    },
                    name: { type: 'string' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          product: { type: 'string' },
                          quantity: { type: 'integer', minimum: 1 },
                        },
                        required: ['product', 'quantity'],
                      },
                    },
                    delivery_type: { type: 'string', enum: ['pickup', 'delivery'] },
                    pickup_time_text: { type: 'string' },
                    address: { type: 'string' },
                    city: { type: 'string' },
                    postcode: { type: 'string' },
                    notes: { type: 'string' },
                  },
                  required: ['confirmed_by_customer', 'name', 'items', 'delivery_type', 'pickup_time_text'],
                },
              },
            ];
          }

          return session;
          })(),
        }));

        while (pendingOpenAiAudio.length > 0) {
          hasUncommittedOpenAiAudio = true;
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pendingOpenAiAudio.shift(),
          }));
        }
      });

      openaiWs.on('message', (raw) => {
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          console.warn('[voice] openai_parse_error');
          return;
        }

        if (event.type === 'session.updated') {
          console.log('[voice] openai_session_updated');
          sendInitialGreeting();
          return;
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('[voice] user_speech_started');
          cancelCartesiaContext();
          if ((responseActive || responseCreatePending) && openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          responseActive = false;
          responseCreatePending = false;
          greetingResponseActive = false;
          clientJson({ type: 'interrupt' });
          return;
        }

        if (event.type === 'input_audio_buffer.speech_stopped') {
          console.log('[voice] openai_speech_stopped');
          if (speechStoppedFallbackTimer) clearTimeout(speechStoppedFallbackTimer);
          speechStoppedFallbackTimer = setTimeout(() => {
            speechStoppedFallbackTimer = null;
            startOpenAiResponseFromSpeechEnd('openai_speech_stopped_fallback');
          }, 350);
          return;
        }

        if (event.type === 'input_audio_buffer.committed') {
          console.log('[voice] openai_audio_committed');
          uncommittedOpenAiAudioMs = 0;
          if (manualCommitPending && manualResponsePending && openaiWs?.readyState === WebSocket.OPEN) {
            manualCommitPending = false;
            if (awaitingOrderConfirmation && !orderConfirmationAnswered) {
              awaitingTranscriptAfterCommit = true;
              console.log('[voice] waiting_for_confirmation_transcript_before_response');
            } else {
              awaitingTranscriptAfterCommit = false;
              sendOpenAiResponseCreate('audio_committed');
            }
          }
          return;
        }

        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          latestUserTranscript = event.transcript || '';
          awaitingTranscriptAfterCommit = false;
          updateKnownCustomerName(latestUserTranscript, { afterNameQuestion: awaitingCustomerName });
          if (knownCustomerName) awaitingCustomerName = false;
          if (awaitingOrderConfirmation) {
            orderConfirmationAnswered = true;
            if (isClearDanishConfirmation(latestUserTranscript)) {
              orderConfirmationApproved = true;
              forceOrderToolOnNextResponse = activeProfile.allowOrders;
              console.log('[voice] order_confirmation_approved', {
                latest_user_transcript: latestUserTranscript,
                agent: activeProfile.id,
              });
            } else if (isOrderCorrectionOrRejection(latestUserTranscript) && !orderConfirmationApproved) {
              awaitingOrderConfirmation = false;
              console.log('[voice] order_confirmation_rejected_or_unclear', {
                latest_user_transcript: latestUserTranscript,
              });
            } else {
              console.log('[voice] order_confirmation_waiting_for_clear_yes', {
                latest_user_transcript: latestUserTranscript,
              });
            }
          }
          const ignoredReason =
            manualResponsePending && !manualCommitPending
              ? ignoredTranscriptReason(latestUserTranscript)
              : '';
          if (ignoredReason) {
            console.log('[voice] transcript_ignored', {
              reason: ignoredReason,
              transcript: latestUserTranscript,
            });
            const context = dashboardCustomer && dashboardCall
              ? { customer: dashboardCustomer, call: dashboardCall }
              : null;
            if (context) {
              logSystemEvent({
                customer_id: context.customer.id,
                call_id: context.call.id,
                level: 'debug',
                source: 'voice-server',
                message: 'Transcript ignored',
                metadata: { reason: ignoredReason, transcript: latestUserTranscript },
              });
            }
            manualResponsePending = false;
            manualCommitPending = false;
            awaitingTranscriptAfterCommit = false;
            clientJson({ type: 'input_ignored', reason: ignoredReason });
            return;
          }

          appendTranscriptLine('Kunde', latestUserTranscript);
          clientJson({ type: 'transcript', role: 'user', text: latestUserTranscript });
          if (
            manualResponsePending &&
            !manualCommitPending &&
            !responseActive &&
            !responseCreatePending &&
            openaiWs?.readyState === WebSocket.OPEN
          ) {
            sendOpenAiResponseCreate('transcript_ready');
          }
          return;
        }

        if (event.type === 'response.function_call_arguments.delta') {
          const callId = event.call_id || event.item_id;
          if (!callId) return;
          const existing = pendingToolCalls.get(callId) || { name: event.name || '', arguments: '' };
          existing.name = existing.name || event.name || '';
          existing.arguments += event.delta || '';
          pendingToolCalls.set(callId, existing);
          return;
        }

        if (event.type === 'response.function_call_arguments.done') {
          const callId = event.call_id || event.item_id;
          const existing = pendingToolCalls.get(callId) || {};
          handleFunctionCall({
            callId,
            name: event.name || existing.name,
            argumentsJson: event.arguments || existing.arguments || '{}',
          });
          pendingToolCalls.delete(callId);
          return;
        }

        if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          handleFunctionCall({
            callId: event.item.call_id,
            name: event.item.name,
            argumentsJson: event.item.arguments || '{}',
          });
          return;
        }

        if (event.type === 'response.output_text.delta' || event.type === 'response.text.delta') {
          const delta = event.delta || '';
          if (!delta) return;
          if (!responseActive) {
            responseActive = true;
            responseCreatePending = false;
            manualResponsePending = false;
            manualCommitPending = false;
            audioChunkSeenForResponse = false;
            assistantResponseText = '';
            startCartesiaContext();
          }
          assistantResponseText += delta;
          clientJson({ type: 'latency_mark', name: 'firstOpenaiText' });
          clientJson({ type: 'transcript_delta', role: 'assistant', text: delta });
          bufferCartesiaText(delta);
          return;
        }

        if (
          event.type === 'response.output_text.done' ||
          event.type === 'response.text.done' ||
          event.type === 'response.done'
        ) {
          const shouldLogAssistantResponse = responseActive && clean(assistantResponseText);
          if (responseActive) finishCartesiaContext();
          responseActive = false;
          responseCreatePending = false;
          manualResponsePending = false;
          manualCommitPending = false;
          if (shouldLogAssistantResponse) appendTranscriptLine(activeProfile.assistantName, assistantResponseText);
          if (greetingResponseActive) {
            greetingResponseActive = false;
            clientJson({ type: 'transcript_done', role: 'assistant' });
            return;
          }
          if (/lyder det rigtigt\??/i.test(assistantResponseText)) {
            awaitingOrderConfirmation = true;
            orderConfirmationAnswered = false;
            orderConfirmationApproved = false;
            console.log('[voice] order_confirmation_prompt_seen', {
              text: assistantResponseText.slice(0, 240),
            });
          }
          if (/(må jeg få dit navn|hvad er dit navn|hvad hedder du|og hvad hedder du)/i.test(assistantResponseText)) {
            awaitingCustomerName = true;
            console.log('[voice] customer_name_prompt_seen');
          }
          clientJson({ type: 'transcript_done', role: 'assistant' });
          return;
        }

        if (event.type === 'error') {
          console.error('[voice] openai_error', event.error);
          const message = event.error?.message || 'OpenAI error';
          const isEmptyCommitError = /buffer too small|Expected at least 100ms/i.test(message);
          const isActiveResponseError = /Conversation already has an active response/i.test(message);
          if (isEmptyCommitError) {
            console.warn('[voice] openai_empty_audio_commit_ignored', {
              uncommitted_audio_ms: Math.round(uncommittedOpenAiAudioMs),
            });
            manualResponsePending = false;
            manualCommitPending = false;
            hasUncommittedOpenAiAudio = false;
            uncommittedOpenAiAudioMs = 0;
            return;
          }
          if (isActiveResponseError) {
            console.warn('[voice] openai_active_response_ignored', { message });
            manualResponsePending = false;
            manualCommitPending = false;
            responseCreatePending = true;
            return;
          }
          manualResponsePending = false;
          manualCommitPending = false;
          responseCreatePending = false;
          clientJson({ type: 'error', error: message });
        }
      });

      openaiWs.on('error', (error) => {
        console.error('[voice] openai_ws_error', error.message);
        clientJson({ type: 'error', error: `OpenAI WebSocket error: ${error.message}` });
      });

      openaiWs.on('close', (code, reason) => {
        console.warn('[voice] openai_ws_close', { code, reason: reason?.toString() || '' });
        clientJson({ type: 'openai_status', status: 'closed', code, reason: reason?.toString() || '' });
      });
    }

    function openCartesia() {
      if (cartesiaWs && (cartesiaWs.readyState === WebSocket.OPEN || cartesiaWs.readyState === WebSocket.CONNECTING)) return;

      const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${encodeURIComponent(CARTESIA_VERSION)}`;
      cartesiaWs = new WebSocket(url, {
        headers: {
          'X-API-Key': process.env.CARTESIA_API_KEY,
        },
      });

      cartesiaWs.on('open', () => {
        console.log('[voice] cartesia_ws_open', { model: CARTESIA_MODEL_ID, output_rate: cartesiaOutputRate });
        cartesiaReady = true;
        clientJson({
          type: 'cartesia_status',
          status: 'connected',
          output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: cartesiaOutputRate },
        });
        while (pendingCartesiaText.length > 0) {
          const { text, shouldContinue, contextId } = pendingCartesiaText.shift();
          sendCartesiaPayload(text, shouldContinue, contextId);
        }
      });

      cartesiaWs.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          console.warn('[voice] cartesia_parse_error');
          return;
        }

        if (message.type === 'chunk' && message.data) {
          if (!audioChunkSeenForResponse) {
            audioChunkSeenForResponse = true;
            clientJson({ type: 'latency_mark', name: 'firstCartesiaAudio' });
          }
          const audio = Buffer.from(message.data, 'base64');
          if (client.readyState === WebSocket.OPEN) client.send(audio, { binary: true });
          return;
        }

        if (message.type === 'done') {
          clientJson({ type: 'audio_end', context_id: message.context_id });
          return;
        }

        if (message.type === 'flush_done') {
          clientJson({ type: 'cartesia_flush_done', context_id: message.context_id, flush_id: message.flush_id });
          return;
        }

        if (message.type === 'error') {
          console.error('[voice] cartesia_error', message);
          clientJson({ type: 'error', error: message.message || message.title || 'Cartesia error' });
        }
      });

      cartesiaWs.on('error', (error) => {
        console.error('[voice] cartesia_ws_error', error.message);
        clientJson({ type: 'error', error: `Cartesia WebSocket error: ${error.message}` });
      });

      cartesiaWs.on('close', (code, reason) => {
        console.warn('[voice] cartesia_ws_close', { code, reason: reason?.toString() || '' });
        cartesiaReady = false;
        clientJson({ type: 'cartesia_status', status: 'closed', code, reason: reason?.toString() || '' });
      });
    }

    function startCartesiaContext() {
      currentContextId = crypto.randomUUID();
      pendingCartesiaText = [];
      ttsTextBuffer = '';
    }

    function parseToolArguments(argumentsJson) {
      if (!argumentsJson || typeof argumentsJson !== 'string') return {};
      try {
        return JSON.parse(argumentsJson);
      } catch (error) {
        console.error('[voice] tool_args_parse_error', error.message, argumentsJson);
        return {};
      }
    }

    function normalizeDanishName(name) {
      const cleaned = clean(name).replace(/[^A-Za-zÆØÅæøå'-]/g, '');
      if (!cleaned || cleaned.length < 2 || cleaned.length > 28) return '';
      const blocked = new Set([
        'kan', 'jeg', 'bestille', 'have', 'få', 'pizza', 'pepperoni', 'margherita',
        'durum', 'kebab', 'pepsi', 'max', 'hej', 'hallo', 'tak',
      ]);
      const lower = cleaned.toLowerCase();
      if (blocked.has(lower)) return '';
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    }

    function updateKnownCustomerName(transcript, options = {}) {
      if (knownCustomerName) return;
      const text = String(transcript || '').trim();
      const patterns = [
        /\b(?:jeg hedder|mit navn er|min navn er|du snakker(?: jo)? med)\s+([A-Za-zÆØÅæøå'-]{2,28})\b/i,
        /\b(?:er du|du)?\s*snakke(?:r)?(?: jo)?\s+med\s+([A-Za-zÆØÅæøå'-]{2,28})\b/i,
        /\b([A-Za-zÆØÅæøå'-]{2,28})\s+her\b/i,
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        const name = normalizeDanishName(match?.[1]);
        if (!name) continue;
        knownCustomerName = name;
        console.log('[voice] customer_name_detected', { name: knownCustomerName });
        return;
      }
      if (options.afterNameQuestion) {
        const simpleName = text
          .replace(/[.!?,;:]/g, ' ')
          .trim()
          .split(/\s+/)
          .map(normalizeDanishName)
          .find(Boolean);
        if (simpleName) {
          knownCustomerName = simpleName;
          console.log('[voice] customer_name_detected_after_prompt', { name: knownCustomerName });
        }
      }
    }

    function normalizeTranscriptText(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function transcriptHasActionableContent(normalized) {
      if (!normalized) return false;
      const productPattern = /\b(pepperoni|peberoni|peperoni|pepperon|margherita|margarita|margerita|kebab|durum|pepsi|maks|max|hawaii|calzone|fanta|peanuts)\b/;
      const flowPattern = /\b(henter|hente|afhentning|levering|levere|lever|adresse|vej|gade|stræde|minut|minutter|time|timer|kvarter|hurtigst|nu|senere|navn|hedder|korrekt|rigtigt|passer)\b/;
      const namePattern = /\b(jeg hedder|mit navn er|min navn er|du snakker med|det er [a-zæøå]{2,28}|[a-zæøå]{2,28} her)\b/;
      const clearAnswerPattern = /^(ja|jo|jep|yep|yes|nej|nej tak|okay|fint|perfekt|super)(\b|$)/;
      const genericOrderIntent = /\b(bestille|bestilling|jeg skal have|jeg vil have|jeg vil gerne have|jeg kunne godt tænke mig|kan jeg få|må jeg få)\b/;
      return (
        productPattern.test(normalized) ||
        flowPattern.test(normalized) ||
        namePattern.test(normalized) ||
        clearAnswerPattern.test(normalized) ||
        genericOrderIntent.test(normalized)
      );
    }

    function ignoredTranscriptReason(transcript) {
      const normalized = normalizeTranscriptText(transcript);
      if (!normalized) return 'empty_transcript';
      if (awaitingOrderConfirmation || awaitingCustomerName) return '';
      if (isClearDanishConfirmation(normalized) || isOrderCorrectionOrRejection(normalized)) return '';

      const fillerOrNoisePattern = /^(øh|øhm|uhm|hm|hmm|mmm|nå|tsk|bop|bop bop|skål|okay|ja okay|hej så|hav det|vi ses|god aften)(\s+\1)*$/;
      if (fillerOrNoisePattern.test(normalized)) return 'filler_or_noise_only';

      if (/\b(lad mig|lade mig|vil du lige)\s+snakke\s+færdig/.test(normalized)) {
        return 'customer_still_speaking';
      }

      if (/\b(snakkes.*i morgen|vi snakkes|vi ses|hav det.*godt|god aften|tsk|skål|bop)\b/.test(normalized)) {
        return 'smalltalk_or_noise';
      }

      const danglingOrderPattern = /\b(?:jeg|vi|man)\s+(?:skal|vil|ville|kunne godt tænke mig|må|kan)\s+(?:lige\s+)?(?:have|bestille|få)\s+(?:en|et|noget)?\s*(?:øh|øhm|uhm|hm|hmm|altså)?$/;
      if (danglingOrderPattern.test(normalized)) return 'unfinished_order_phrase';

      if (/\bikke\s+fordi\s+(?:jeg|vi)\s+skal\s+have\b/.test(normalized)) {
        const parts = normalized.split(/\bmen\b/);
        if (parts.length < 2) return 'negated_product';
        const tailAfterMen = parts.pop() || '';
        if (!transcriptHasActionableContent(tailAfterMen) || danglingOrderPattern.test(tailAfterMen)) {
          return 'negated_partial_order';
        }
      }

      if (!transcriptHasActionableContent(normalized)) return 'no_actionable_order_content';
      return '';
    }

    function responseContextInstructions() {
      if (!activeProfile.allowOrders) {
        if (activeProfile.id === 'napoli') {
          return [
            'Du er i en Danske Fragtmænd forsinkelses-demo.',
            'Kald aldrig create_woocommerce_order.',
            'Du skal kun hjælpe en chauffør med at melde forsinkelse.',
            'Hvis chaufføren siger, at han er forsinket på grund af kø eller trafik, spørg: "Okay, hvornår regner du så med at ankomme?"',
            'Når chaufføren har sagt en tydelig forsinkelse eller ny ankomsttid, sig kun: "Det er modtaget, jeg sætter det ind i systemet."',
            'Spørg ikke efter navn, telefonnummer, adresse, ordrenummer eller kundenummer.',
            'Tal aldrig om pizza, takeaway, bordbooking eller restaurant.',
          ].join(' ');
        }

        const rules = [
          'Du er i en Restaurant Hærvejen booking-demo.',
          'Kald aldrig create_woocommerce_order.',
          'Du skal kun hjælpe med bordbooking, ændringer, restaurantspørgsmål og beskeder.',
          'Efter kunden har sagt tydeligt ja til opsummeringen, må du aldrig opsummere igen.',
          'Efter ja, sig kun: "Perfekt, jeg sender ønsket videre til restauranten. Restauranten vender tilbage hvis der er noget."',
          'Hvis kunden spørger om pizza, takeaway eller varer, sig: "Det kan jeg ikke hjælpe med her, men jeg kan hjælpe med at booke bord."',
          'Spørg aldrig efter telefonnummer.',
          'Gæt aldrig antal personer, dag, tid eller navn.',
        ];
        if (knownCustomerName) {
          rules.unshift(`Kundens navn er ${knownCustomerName}. Spørg ikke efter navn igen. Hvis du opsummerer, start med "Okay ${knownCustomerName}."`);
        }
        return rules.join(' ');
      }

      const rules = [
        'Hawaii og calzone findes ikke på menuen. Match dem aldrig til Margherita, Pepperoni eller andre produkter.',
        'Hvis kunden beder om Hawaii, svar præcis: "Vi har desværre ikke Hawaii på kortet. Kan jeg byde på noget andet?"',
        'Hvis kunden beder om calzone, svar præcis: "Vi har desværre ikke calzone på kortet. Kan jeg byde på noget andet?"',
        'Spørg aldrig "hvor mange" efter én almindelig vare. Hvis kunden siger en Pepperoni eller en Margherita, antag antal 1.',
        'Beskriv aldrig ingredienser, smag eller at en vare er lækker.',
        'Opsummer aldrig hele den aktuelle bestilling midt i flowet. Bekræft kun det kunden lige sagde, og opsummer først i det afsluttende "Lyder det rigtigt?"-trin.',
        'Sig aldrig "så har jeg", "nu har du", "jeg noterer", "jeg tilføjer" eller "til din bestilling".',
        'Sig aldrig "Er der mere, du gerne vil have?", "Er der andet, du gerne vil have?", "Er der ellers noget, du ønsker?", "lad os lige få det bekræftet" eller "Du har bestilt" midt i flowet.',
        'Sig aldrig "Lyder det rigtigt:" med kolon, "Lad mig lige opsummere igen", "Lad os lige tage opsummeringen igen", "Bekræfter du" eller "Lyder det helt korrekt?".',
        'Opsummeringen skal have formen: "Okay [navn]. Så det er [ordre], [afhentning/levering] om [tid]. Lyder det rigtigt?"',
        'Efter kunden har sagt tydeligt ja til opsummeringen, må du aldrig opsummere igen. Kald create_woocommerce_order.',
        'Spørg aldrig efter telefonnummer. Telefonnummeret håndteres af systemet.',
        'Gå aldrig til bekræftelse før mad, drikkevarer eller nej til drikkevarer, afhentning eller levering, tidspunkt og navn er kendt.',
        'Hvis kunden lige valgte en drik efter maden, spørg kun: "Skal vi levere den eller henter du selv?"',
        'Hvis kunden lige ændrede maden, nævn kun ændringen og stil næste manglende flowspørgsmål.',
        'Kvitter altid for det kunden lige tilføjede eller ændrede før næste spørgsmål. Eksempel: "Pepsi Max, ja. Skal vi levere den eller henter du selv?"',
        'Hvis kunden ændrer Pepperoni til Margherita, sig at I skifter Pepperoni til Margherita. Nævn ikke hele ordren.',
        'Hvis kunden tilføjer Pepsi Max, må du aldrig svare med Margherita, Pepperoni eller en ændring.',
        'Efter en madvare som Pepperoni, Margherita eller Kebab Durum skal næste spørgsmål altid være "Skal der mere til?", medmindre kunden tydeligt har sagt nej til mere mad.',
        'Hvis kunden vælger Margherita eller Pepperoni efter en vare der ikke findes, svar kun "[Produkt], ja. Skal der mere til?" Spørg ikke om afhentning eller levering endnu.',
        'Hvis kunden spørger "har du snakket med..." eller nævner andre pizzarianavne, vælg aldrig produkt. Spørg kun: "Ja, hvad må det være?"',
      ];
      if (knownCustomerName) {
        rules.unshift(`Kundens navn er ${knownCustomerName}. Spørg ikke efter navn igen. Spring navnetrinnet over. Hvis du opsummerer ordren, start med "Okay ${knownCustomerName}."`);
      }
      return rules.join(' ');
    }

    function createOpenAiResponsePayload() {
      if (forceOrderToolOnNextResponse && activeProfile.allowOrders) {
        forceOrderToolOnNextResponse = false;
        console.log('[voice] forcing_order_tool_response');
        return {
          type: 'response.create',
          response: {
            output_modalities: ['text'],
            tool_choice: 'required',
            instructions: [
              'Kunden har lige bekræftet opsummeringen tydeligt.',
              'Du må IKKE tale, opsummere igen eller stille flere spørgsmål.',
              'Kald create_woocommerce_order nu med den bekræftede ordre.',
              'confirmed_by_customer skal være true.',
            ].join(' '),
          },
        };
      }
      forceOrderToolOnNextResponse = false;

      return {
        type: 'response.create',
        response: {
          output_modalities: ['text'],
          instructions: responseContextInstructions(),
        },
      };
    }

    function sendOpenAiResponseCreate(reason) {
      if (openaiWs?.readyState !== WebSocket.OPEN || responseActive || responseCreatePending) return false;
      manualResponsePending = false;
      manualCommitPending = false;
      responseCreatePending = true;
      console.log('[voice] response_create_sent', { reason });
      openaiWs.send(JSON.stringify(createOpenAiResponsePayload()));
      return true;
    }

    function isClearDanishConfirmation(text) {
      const normalized = String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) return false;
      if (/\b(ikke|forkert|ret|ændr|vent|stop)\b/.test(normalized)) return false;
      if (/\b(ja|jo|jep|yep|yes)\b.*\b(korrekt|rigtigt|godt|passer|stemmer|super|fint)\b/.test(normalized)) return true;
      return /^(ja|jo|jep|yep|korrekt|det er korrekt|det er rigtigt|den er god|det passer|helt rigtigt|super|perfekt|fint|ja tak)(\b|$)/.test(normalized);
    }

    function isOrderCorrectionOrRejection(text) {
      const normalized = String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) return false;
      if (isClearDanishConfirmation(normalized)) return false;
      if (/\b(forkert|ret|rettelse|ændr|skift|vent|stop)\b/.test(normalized)) return true;
      return /^nej\b.*\b(ikke|forkert|ret|rettelse|ændr|skift|pepperoni|margherita|kebab|durum|pepsi|minut|minutter|time|timer|lever|levering|hent|henter|afhentning)\b/.test(normalized);
    }

    function orderResultInstructions(result) {
      if (result?.ok) {
        return 'Sig kort til kunden at ordren er lagt ind. Nævn ordrenummeret hvis det findes.';
      }
      if (result?.code === 'ORDER_CONFIRMATION_PROMPT_REQUIRED') {
        return 'Du forsøgte at oprette ordren før du havde opsummeret og spurgt "Lyder det rigtigt?". Fortsæt flowet fra næste manglende trin. Hvis alle oplysninger er kendt, opsummer ordren og spørg: "Lyder det rigtigt?"';
      }
      if (result?.code === 'CUSTOMER_CONFIRMATION_REQUIRED') {
        return 'Kunden bekræftede ikke tydeligt eller sagde nej. Sig kun: "Okay, hvad skal jeg rette?"';
      }
      if (result?.message_for_agent) {
        return `Sig kort præcis dette til kunden: "${result.message_for_agent}"`;
      }
      return 'Sig kort: "Der driller noget i systemet, men jeg har ordren og giver den videre."';
    }

    async function handleFunctionCall({ callId, name, argumentsJson }) {
      if (!callId || name !== 'create_woocommerce_order') return;
      if (handledToolCallIds.has(callId)) return;
      handledToolCallIds.add(callId);
      const args = parseToolArguments(argumentsJson);
      console.log('[voice] create_woocommerce_order_requested', {
        call_id: callId,
        item_count: Array.isArray(args.items) ? args.items.length : 0,
        delivery_type: args.delivery_type,
        confirmed_by_customer: args.confirmed_by_customer,
        latest_user_transcript: latestUserTranscript,
        awaiting_order_confirmation: awaitingOrderConfirmation,
        order_confirmation_answered: orderConfirmationAnswered,
        order_confirmation_approved: orderConfirmationApproved,
      });

      let result;
      try {
        if (!awaitingOrderConfirmation || !orderConfirmationAnswered || !orderConfirmationApproved) {
          const error = new Error('Ordren må ikke oprettes før opsummering og kundens bekræftelse');
          error.body = {
            ok: false,
            error: error.message,
            code: 'ORDER_CONFIRMATION_PROMPT_REQUIRED',
            message_for_agent: 'Jeg skal lige opsummere ordren først og høre om det lyder rigtigt.',
          };
          throw error;
        }

        if (!orderConfirmationApproved) {
          awaitingOrderConfirmation = false;
          const error = new Error('Kundens seneste svar var ikke en tydelig bekræftelse');
          error.body = {
            ok: false,
            error: error.message,
            code: 'CUSTOMER_CONFIRMATION_REQUIRED',
            message_for_agent: 'Jeg skal lige have et tydeligt ja, før jeg lægger ordren ind.',
          };
          throw error;
        }

        result = await createRealtimeOrder({
          session_id: voiceSessionId,
          confirmed_by_customer: args.confirmed_by_customer === true,
          customer: {
            name: args.name || knownCustomerName || '',
            phone: '22769095',
            address: args.address || '',
            city: args.city || '',
            postcode: args.postcode || '',
          },
          items: Array.isArray(args.items) ? args.items : [],
          delivery_type: args.delivery_type,
          pickup_time_text: args.pickup_time_text || '',
          notes: args.notes || '',
        });
        const context = await getDashboardContext();
        if (context && result?.ok) {
          const totalDkk = Number.isFinite(Number.parseFloat(result.total))
            ? Math.round(Number.parseFloat(result.total))
            : null;
          const orderItems = Array.isArray(result.items)
            ? result.items.map((item) => ({
                product_id: item.product_id,
                name: item.name,
                qty: item.quantity,
              }))
            : (Array.isArray(args.items) ? args.items : []);

          await createDashboardOrder({
            call_id: context.call.id,
            customer_id: context.customer.id,
            order_items: orderItems,
            customer_name: args.name || knownCustomerName || '',
            customer_phone: '22769095',
            delivery_type: args.delivery_type,
            delivery_address: args.address || null,
            delivery_city: args.city || null,
            delivery_postcode: args.postcode || null,
            pickup_time_text: args.pickup_time_text || '',
            subtotal_dkk: totalDkk,
            total_dkk: totalDkk,
            external_system: 'woocommerce',
            external_id: result.order_id ? String(result.order_id) : null,
            external_status: result.status || null,
            status: 'confirmed',
            notes: args.notes || null,
          });

          dashboardCallHadOrder = true;
          await updateDashboardCall(context.call.id, { status: 'order_created' });
          logSystemEvent({
            customer_id: context.customer.id,
            call_id: context.call.id,
            level: 'info',
            source: 'voice-server',
            message: 'Order created',
            metadata: {
              session_id: voiceSessionId,
              order_id: result.order_id,
              order_number: result.order_number,
              total: result.total,
            },
          });
        }
        awaitingOrderConfirmation = false;
        orderConfirmationAnswered = false;
        orderConfirmationApproved = false;
        forceOrderToolOnNextResponse = false;
      } catch (error) {
        result = error.body || {
          ok: false,
          error: error.message || 'Order creation failed',
          code: error.code || 'ORDER_CREATE_FAILED',
          message_for_agent: 'Der driller noget i systemet, men jeg har ordren og giver den videre.',
        };
      }

      console.log('[voice] create_woocommerce_order_result', {
        ok: result.ok,
        order_id: result.order_id,
        code: result.code,
      });
      if (!result.ok) {
        const context = dashboardCustomer && dashboardCall
          ? { customer: dashboardCustomer, call: dashboardCall }
          : null;
        if (context) {
          logSystemEvent({
            customer_id: context.customer.id,
            call_id: context.call.id,
            level: 'warn',
            source: 'voice-server',
            message: 'Order creation failed',
            metadata: {
              session_id: voiceSessionId,
              code: result.code,
              error: result.error,
            },
          });
        }
      }

      if (openaiWs?.readyState !== WebSocket.OPEN) return;
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      }));
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['text'],
          instructions: orderResultInstructions(result),
        },
      }));
    }

    function cartesiaBasePayload(contextId) {
      return {
        model_id: CARTESIA_MODEL_ID,
        voice: {
          mode: 'id',
          id: process.env[activeProfile.voiceEnv],
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_f32le',
          sample_rate: cartesiaOutputRate,
        },
        context_id: contextId,
        language: 'da',
        add_timestamps: false,
        max_buffer_delay_ms: 35,
      };
    }

    function sendCartesiaPayload(text, shouldContinue, contextId) {
      if (!contextId) return;
      const payload = {
        ...cartesiaBasePayload(contextId),
        transcript: text,
        continue: shouldContinue,
      };
      cartesiaWs.send(JSON.stringify(payload));
    }

    function sendCartesiaText(text, shouldContinue) {
      if (!text || !currentContextId) return;
      openCartesia();
      if (cartesiaReady && cartesiaWs?.readyState === WebSocket.OPEN) {
        sendCartesiaPayload(text, shouldContinue, currentContextId);
      } else {
        pendingCartesiaText.push({ text, shouldContinue, contextId: currentContextId });
      }
    }

    function normalizeTtsText(text) {
      return String(text || '')
        .replace(/[—–]/g, ',')
        .replace(/\s+/g, ' ');
    }

    function shouldFlushCartesiaText(text) {
      const trimmed = text.trim();
      const hasSentenceEnd = /[.!?]\s*$/.test(trimmed);
      const hasLongCommaPause = trimmed.length >= 36 && /,\s*$/.test(trimmed);
      const hasEnoughPhraseContext = trimmed.length >= 44 && /[\s,]$/.test(text);
      return hasSentenceEnd || hasLongCommaPause || hasEnoughPhraseContext || trimmed.length >= 68;
    }

    function bufferCartesiaText(delta) {
      ttsTextBuffer += delta;
      if (!shouldFlushCartesiaText(ttsTextBuffer)) return;
      const text = normalizeTtsText(ttsTextBuffer);
      ttsTextBuffer = '';
      sendCartesiaText(text, true);
    }

    function finishCartesiaContext() {
      if (!currentContextId) return;
      const contextId = currentContextId;
      openCartesia();
      if (ttsTextBuffer.trim()) {
        const text = normalizeTtsText(ttsTextBuffer);
        ttsTextBuffer = '';
        if (cartesiaReady && cartesiaWs?.readyState === WebSocket.OPEN) {
          sendCartesiaPayload(text, true, contextId);
        } else {
          pendingCartesiaText.push({ text, shouldContinue: true, contextId });
        }
      }
      if (cartesiaReady && cartesiaWs?.readyState === WebSocket.OPEN) {
        sendCartesiaPayload('', false, contextId);
      } else {
        pendingCartesiaText.push({ text: '', shouldContinue: false, contextId });
      }
      currentContextId = null;
      ttsTextBuffer = '';
    }

    function cancelCartesiaContext() {
      if (!currentContextId) return;
      const contextId = currentContextId;
      currentContextId = null;
      ttsTextBuffer = '';
      pendingCartesiaText = pendingCartesiaText.filter((item) => item.contextId !== contextId);
      if (cartesiaWs?.readyState === WebSocket.OPEN) {
        cartesiaWs.send(JSON.stringify({ context_id: contextId, cancel: true }));
      }
    }

    function startOpenAiResponseFromSpeechEnd(source) {
      if (!sessionStarted || openaiWs?.readyState !== WebSocket.OPEN) return;
      if (!hasUncommittedOpenAiAudio || manualResponsePending || responseActive || responseCreatePending || greetingResponseActive) return;
      if (uncommittedOpenAiAudioMs < OPENAI_MIN_COMMIT_AUDIO_MS) {
        console.warn('[voice] speech_end_ignored_short_audio', {
          source,
          uncommitted_audio_ms: Math.round(uncommittedOpenAiAudioMs),
          minimum_ms: OPENAI_MIN_COMMIT_AUDIO_MS,
        });
        hasUncommittedOpenAiAudio = false;
        uncommittedOpenAiAudioMs = 0;
        return;
      }

      if (speechStoppedFallbackTimer) {
        clearTimeout(speechStoppedFallbackTimer);
        speechStoppedFallbackTimer = null;
      }
      console.log('[voice] speech_end_commit', {
        source,
        uncommitted_audio_ms: Math.round(uncommittedOpenAiAudioMs),
      });
      manualResponsePending = true;
      manualCommitPending = true;
      hasUncommittedOpenAiAudio = false;
      uncommittedOpenAiAudioMs = 0;
      clientJson({ type: 'latency_mark', name: 'speechStopped' });
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      setTimeout(() => {
        if (!manualCommitPending || !manualResponsePending || responseActive || responseCreatePending || openaiWs?.readyState !== WebSocket.OPEN) return;
        if (awaitingOrderConfirmation && !orderConfirmationAnswered) {
          console.log('[voice] openai_audio_commit_timeout_waiting_for_confirmation_transcript');
          return;
        }
        console.warn('[voice] openai_audio_commit_timeout_starting_response');
        manualCommitPending = false;
        sendOpenAiResponseCreate('commit_timeout');
      }, 300);
    }

    function startOpenAiResponseFromLocalSpeechEnd() {
      startOpenAiResponseFromSpeechEnd('local_speech_end');
    }

    function getPcm16MonoDurationMs(buffer) {
      return ((buffer?.byteLength || buffer?.length || 0) / 2 / OPENAI_REALTIME_INPUT_RATE) * 1000;
    }

    async function startSession(options = {}) {
      if (sessionStarted) return;
      activeProfile = resolveVoiceAgentProfile(options.agent);
      console.log('[voice] selected_agent', {
        agent: activeProfile.id,
        business: activeProfile.businessName,
        assistant: activeProfile.assistantName,
        voiceEnv: activeProfile.voiceEnv,
      });
      if (!ensureEnv(activeProfile)) return;
      sessionStarted = true;
      dashboardCallFinalized = false;
      dashboardCallHadOrder = false;
      transcriptLines.length = 0;
      greetingSent = false;
      cartesiaOutputRate = Number(options.outputSampleRate) || 48000;
      dashboardCallInitPromise = initializeDashboardCall(options).catch((error) => {
        console.error('[Supabase] initializeDashboardCall:', error);
        return null;
      });
      clientJson({
        type: 'session_started',
        openai_model: OPENAI_REALTIME_WS_MODEL,
        cartesia_model: CARTESIA_MODEL_ID,
        openai_input_rate: OPENAI_REALTIME_INPUT_RATE,
        cartesia_output_rate: cartesiaOutputRate,
        agent: activeProfile.id,
        assistant_name: activeProfile.assistantName,
        business_name: activeProfile.businessName,
      });
      openCartesia();
      openOpenAi();
    }

    client.on('message', (raw, isBinary) => {
      if (isBinary) {
        binaryFrameLogCount += 1;
        if (binaryFrameLogCount % 100 === 1) {
          console.log('[voice] client_audio_frames', {
            frames: binaryFrameLogCount,
            bytes: raw?.length || raw?.byteLength || 0,
          });
        }
      } else {
        console.log('[voice] client_message', {
          isBinary,
          bytes: raw?.length || raw?.byteLength || 0,
        });
      }
      if (!isBinary) {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          clientJson({ type: 'error', error: 'Invalid JSON message' });
          return;
        }

        if (message.type === 'start') {
          console.log('[voice] client_start', {
            outputSampleRate: message.outputSampleRate,
            agent: message.agent,
          });
          startSession(message).catch((error) => {
            console.error('[voice] start_session_error', error);
            clientJson({ type: 'error', error: error.message || 'Could not start session' });
          });
          return;
        }

        if (message.type === 'local_speech_end') {
          startOpenAiResponseFromLocalSpeechEnd();
          return;
        }

        if (message.type === 'stop') {
          console.log('[voice] client_stop');
          finalizeDashboardCall().catch((error) => console.error('[Supabase] finalizeCall:', error));
          closeOpenAi();
          closeCartesia();
          sessionStarted = false;
          return;
        }
        return;
      }

      if (!sessionStarted) return;
      const base64Audio = Buffer.from(raw).toString('base64');
      const audioMs = getPcm16MonoDurationMs(raw);
      uncommittedOpenAiAudioMs += audioMs;
      if (openaiWs?.readyState === WebSocket.OPEN) {
        hasUncommittedOpenAiAudio = true;
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Audio,
        }));
      } else {
        hasUncommittedOpenAiAudio = true;
        pendingOpenAiAudio.push(base64Audio);
      }
    });

    client.on('close', (code, reason) => {
      console.warn('[voice] client_close', { code, reason: reason?.toString() || '' });
      finalizeDashboardCall().catch((error) => console.error('[Supabase] finalizeCall:', error));
      closeOpenAi();
      closeCartesia();
    });

    client.on('error', (error) => {
      console.error('[voice] client_error', error.message);
    });
  });
}

setupElevenLabsTtsProxy(server);
setupCartesiaVoiceAgent(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ VVS Backend kører på port ${PORT}`);
  console.log(`📞 Vapi webhook: POST /vapi-webhook`);
  console.log(`📩 SMS indgående: POST /sms-indgaaende`);
  console.log(`🔊 ElevenLabs TTS WS: /api/tts-stream`);
  console.log(`🍕 Cartesia voice agent WS: /api/voice-agent`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🗓️  Sæson: ${getSaesonKontekst()}`);
  if (!VAPI_SECRET) console.warn('⚠️  VAPI_SECRET ikke sat — sæt den i .env');
});
