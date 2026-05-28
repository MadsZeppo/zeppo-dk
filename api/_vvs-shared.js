import crypto from 'crypto';
import OpenAI from 'openai';
import twilio from 'twilio';

const CALL_TTL_MS = 24 * 60 * 60 * 1000;
const processedCalls = globalThis.__zeppoProcessedCalls || new Map();
globalThis.__zeppoProcessedCalls = processedCalls;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function markCallProcessed(callId) {
  processedCalls.set(callId, Date.now());
}

export function isCallProcessed(callId) {
  const ts = processedCalls.get(callId);
  if (!ts) return false;
  if (Date.now() - ts > CALL_TTL_MS) {
    processedCalls.delete(callId);
    return false;
  }
  return true;
}

export function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout efter ${ms}ms`)), ms)
    ),
  ]);
}

export function getSaesonKontekst(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m === 12 || m === 1 || m === 2) return 'vinter/frost';
  if (m === 11 || m === 3) return 'vinter';
  if (m >= 6 && m <= 8) return 'sommer';
  return 'overgangssæson';
}

export function safe(value, fallback = 'Ikke oplyst') {
  if (!value || String(value).trim() === '' || String(value).trim() === 'null') return fallback;
  return String(value).trim();
}

function cleanField(value) {
  const cleaned = safe(value, '');
  return cleaned === 'Ikke oplyst' ? '' : cleaned;
}

export function getCustomerPhone(message) {
  const businessNumbers = [
    process.env.TWILIO_NUMBER,
    process.env.VVS_NUMBER,
  ].map(normalizePhone).filter(Boolean);

  const directCandidates = [
    message?.call?.customer?.number,
    message?.call?.customer?.phoneNumber,
    message?.call?.customer?.sipUri,
    message?.call?.customerNumber,
    message?.call?.from,
    message?.call?.phoneCallProviderDetails?.from,
    message?.call?.twilio?.from,
    message?.customer?.number,
    message?.customer?.phoneNumber,
    message?.customerNumber,
    message?.from,
  ].map(normalizePhone).filter(Boolean);

  const direct = directCandidates.find((number) => !businessNumbers.includes(number));
  if (direct) return direct;

  const allCandidates = collectPhoneCandidates(message)
    .map(normalizePhone)
    .filter(Boolean)
    .filter((number) => !businessNumbers.includes(number));

  return allCandidates[0] || null;
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

function collectPhoneCandidates(value, depth = 0) {
  if (!value || depth > 6) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  return Object.values(value).flatMap((child) => collectPhoneCandidates(child, depth + 1));
}

export function getCallId(message) {
  return (
    message?.call?.id ||
    message?.callId ||
    message?.call?.callId ||
    null
  );
}

export function getTranscript(message) {
  const directTranscript =
    message?.transcript ||
    message?.artifact?.transcript ||
    message?.call?.artifact?.transcript;

  if (typeof directTranscript === 'string' && directTranscript.trim()) {
    return directTranscript;
  }

  const messages =
    message?.messages ||
    message?.artifact?.messages ||
    message?.call?.artifact?.messages;

  if (Array.isArray(messages) && messages.length > 0) {
    return messages
      .map((item) => {
        const role = item.role || item.speaker || item.type || 'ukendt';
        const content = item.message || item.content || item.text || item.transcript || '';
        return content ? `${role}: ${content}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export function validateVapiRequest(req) {
  const secret = process.env.VAPI_SECRET;
  if (!secret) {
    console.warn('VAPI_SECRET ikke sat - webhook er ikke beskyttet');
    return true;
  }

  const possibleHeaders = [
    'x-vapi-secret',
    'x-vapi-signature',
    'vapi-secret',
    'x-secret',
    'authorization',
    'x-webhook-secret',
  ];

  let headerSecret = null;
  for (const name of possibleHeaders) {
    if (req.headers[name]) {
      headerSecret = req.headers[name];
      break;
    }
  }

  if (!headerSecret) return false;
  const cleanedSecret = String(headerSecret).replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(cleanedSecret);
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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

function looksMissing(value) {
  return safe(value) === 'Ikke oplyst';
}

function applyTranscriptAddressFallback(info, transcript = '') {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return info;

  const postnummer = normalizePostnummerStrict(info.postnummer, transcript);
  const parsedPostnummer = postnummer !== 'Ikke oplyst'
    ? postnummer
    : normalizePostnummerStrict(text.match(/\b[1-9]\d{3}\b/)?.[0], transcript);

  const patterns = [
    /(?:adresse(?:n)?\s*(?:er|på)?\s*)?([A-ZÆØÅa-zæøå][A-ZÆØÅa-zæøå0-9 .'-]{2,70}?)\s+(\d{1,4}[A-Za-z]?)\s*,?\s*(?:\d{1,2}\.?\s*(?:tv|th|mf|[a-z])\s*)?(?:postnummer\s*)?([1-9]\d{3})\b/i,
    /(?:adresse(?:n)?\s*(?:er|på)?|jeg bor(?:\s+på)?|bor\s+på)\s+([A-ZÆØÅa-zæøå][A-ZÆØÅa-zæøå0-9 .'-]{2,70}?)\s+(\d{1,4}[A-Za-z]?)/i,
  ];

  let match = null;
  for (const pattern of patterns) {
    match = text.match(pattern);
    if (match) break;
  }

  if (!match) return { ...info, postnummer: parsedPostnummer };

  const vejnavn = safe(match[1]).replace(/\b(adresse|adressen|er|på|hedder|jeg bor|bor på)$/i, '').trim();
  const husnummer = safe(match[2]);
  const matchPostnummer = normalizePostnummerStrict(match[3], transcript);
  const finalPostnummer = matchPostnummer !== 'Ikke oplyst' ? matchPostnummer : parsedPostnummer;
  const adresseRaw = finalPostnummer !== 'Ikke oplyst'
    ? `${vejnavn} ${husnummer}, ${finalPostnummer}`
    : `${vejnavn} ${husnummer}`;

  return {
    ...info,
    adresse_raw: looksMissing(info.adresse_raw) ? adresseRaw : info.adresse_raw,
    vejnavn: looksMissing(info.vejnavn) ? vejnavn : info.vejnavn,
    husnummer: looksMissing(info.husnummer) ? husnummer : info.husnummer,
    postnummer: looksMissing(info.postnummer) ? finalPostnummer : postnummer,
    adresse: looksMissing(info.adresse) ? adresseRaw : info.adresse,
  };
}

export async function validerAdresseMedDawa(info, transcript = '') {
  info = applyTranscriptAddressFallback(info, transcript);
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
    return {
      ...info, postnummer,
      adresse_status: 'USIKKER',
      adresse_note: `DAWA-fejl: ${err.message}`,
      adresse_forslag: safe(info.adresse_forslag),
    };
  }
}

export function defaultInfo(customerPhone, saesonKontekst) {
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

export async function extractBookingInfo(transcript, customerPhone, saesonKontekst) {
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

export function buildVvsSms(info) {
  const niveau = safe(info.akut_niveau);
  const emoji =
    niveau === 'RØD' ? '🚨' :
    niveau === 'GUL' ? '⚠️' : '🔧';
  const adresseLinje = getSmsAddressLine(info);
  const kategori = safe(info.kategori);

  const linjer = [
    `${emoji} ZEPPO · NY VVS-SAG`,
    `${safe(info.prioritet)} · ${niveau} · ${kategori.toUpperCase()}`,
    ``,
    `KUNDE`,
    `Navn: ${safe(info.navn)}`,
    `Telefon: ${safe(info.telefon)}`,
    adresseLinje,
    `Bolig: ${safe(info.boligtype)}`,
  ];

  pushKnown(linjer, 'Bygning', info.bygningsalder);

  linjer.push(
    ``,
    `OPGAVE`,
    `Problem: ${safe(info.problem)}`,
    `Omfang: ${safe(info.omfang)}`
  );

  if (info.eneste_toilet === 'ja') linjer.push(`⚠️ Eneste toilet: Ja`);
  if (
    safe(info.toilet_type) !== 'Ikke oplyst' &&
    safe(info.toilet_type) !== 'ikke relevant' &&
    safe(info.toilet_type) !== 'ukendt'
  ) {
    linjer.push(`Toilet: ${info.toilet_type}`);
  }
  if (
    safe(info.varmekilde) !== 'Ikke oplyst' &&
    safe(info.varmekilde) !== 'ikke relevant' &&
    safe(info.varmekilde) !== 'ukendt'
  ) {
    linjer.push(`Varmekilde: ${info.varmekilde}`);
  }
  pushKnown(linjer, 'Fejlkode', info.fejlkode);
  pushKnown(linjer, 'Startede', info.startede);
  pushKnown(linjer, 'Kunden har prøvet', info.forsogt);

  const obs = [];
  if (info.kemikalier_brugt === 'ja') {
    obs.push(`Kemikalier brugt - medbring syrebestandige handsker/briller`);
  }
  if (info.vicevaert_relevant === 'ja') {
    obs.push(`Mulig fællessag - kunden er bedt om at kontakte vicevært`);
  }
  if (safe(info.forsikring_informeret) === 'ja') obs.push(`Forsikring er informeret`);

  linjer.push(``);
  linjer.push(`PRAKTISK`);
  linjer.push(`Ønsket tid: ${safe(info.tidspunkt)}`);
  pushKnown(linjer, 'Adgang', info.adgang);

  if (obs.length > 0) {
    linjer.push(``);
    linjer.push(`OBS`);
    obs.forEach((item) => linjer.push(`⚠️ ${item}`));
  }

  if (safe(info.ekstra_noter) !== 'Ikke oplyst') {
    linjer.push(``);
    linjer.push(`NOTE`);
    linjer.push(safe(info.ekstra_noter));
  }

  return linjer.join('\n');
}

function pushKnown(lines, label, value) {
  if (safe(value) !== 'Ikke oplyst') {
    lines.push(`${label}: ${safe(value)}`);
  }
}

function getSmsAddressLine(info) {
  const status = safe(info.adresse_status, 'USIKKER').toUpperCase();
  const adresse = safe(info.adresse);
  const adresseRaw = safe(info.adresse_raw, adresse);
  const smsAdresse = status === 'BEKRÆFTET' || status === 'MULIGT_MATCH'
    ? adresse
    : adresseRaw;
  return `Adresse: ${smsAdresse}`;
}

export function buildCustomerSms(info) {
  const navn = safe(info.navn) !== 'Ikke oplyst' ? ` ${info.navn}` : '';
  const adresseLinje = getSmsAddressLine(info);
  let extra = '';
  if (info.vicevaert_relevant === 'ja') {
    extra = `\n\nHusk også at give viceværten eller ejerforeningen besked, hvis du ikke allerede har gjort det.`;
  }

  return `Hej${navn}

Din henvendelse til Dansk VVS Teknik er modtaget.

Problem: ${safe(info.problem)}
${adresseLinje}

Installatøren ringer dig tilbage og bekræfter tidspunktet.${extra}

Hvis adressen eller noget andet ikke passer — svar på denne SMS med rettelsen.
- Dansk VVS Teknik`;
}

export async function sendSmsSikkert(to, body, label) {
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({ body, from: process.env.TWILIO_NUMBER, to });
    console.log(`SMS sendt: ${label} -> ${to}`);
    return true;
  } catch (err) {
    console.error(`SMS fejl (${label} -> ${to}):`, err.message);
    return false;
  }
}
