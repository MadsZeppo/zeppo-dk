function clean(value) {
  return String(value || '').trim();
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\d{8}$/.test(digits)) return `+45${digits}`;
  return digits;
}

function normalizeBaseUrl(value) {
  const raw = clean(value).replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractPayload(body) {
  const toolCall = body?.message?.toolCalls?.[0] || body?.message?.toolCallList?.[0] || body?.toolCall;
  const candidates = [
    body?.arguments,
    body?.parameters,
    body?.data,
    toolCall?.function?.arguments,
    toolCall?.function?.parameters,
    body,
  ];

  for (const candidate of candidates) {
    const parsed = parseMaybeJson(candidate);
    if (parsed && typeof parsed === 'object') return parsed;
  }

  return {};
}

function wooCredentials() {
  return {
    key: clean(process.env.WOOCOMMERCE_CONSUMER_KEY),
    secret: clean(process.env.WOOCOMMERCE_CONSUMER_SECRET),
  };
}

function localSiteAuthHeader() {
  const user = clean(process.env.WOOCOMMERCE_BASIC_AUTH_USER);
  const password = clean(process.env.WOOCOMMERCE_BASIC_AUTH_PASSWORD);
  if (!user || !password) return null;
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function withWooCredentials(url) {
  const { key, secret } = wooCredentials();
  url.searchParams.set('consumer_key', key);
  url.searchParams.set('consumer_secret', secret);
  return url;
}

function assertConfig() {
  const missing = [
    ['WOOCOMMERCE_URL', process.env.WOOCOMMERCE_URL],
    ['WOOCOMMERCE_CONSUMER_KEY', process.env.WOOCOMMERCE_CONSUMER_KEY],
    ['WOOCOMMERCE_CONSUMER_SECRET', process.env.WOOCOMMERCE_CONSUMER_SECRET],
  ].filter(([, value]) => !clean(value)).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Mangler env vars: ${missing.join(', ')}`);
  }
}

function validateVapiSecret(req) {
  const expected = clean(process.env.VAPI_SECRET);
  if (!expected) return true;

  const headers = req.headers || {};
  const provided =
    headers['x-vapi-secret'] ||
    headers['x-secret'] ||
    headers['vapi-secret'] ||
    headers.authorization?.replace(/^Bearer\s+/i, '');

  return clean(provided) === expected;
}

function normalizeProductName(value) {
  return clean(value)
    .toLowerCase()
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'oe')
    .replaceAll('å', 'aa')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreProduct(product, wantedName) {
  const wanted = normalizeProductName(wantedName);
  const name = normalizeProductName(product?.name);
  const slug = normalizeProductName(product?.slug);

  if (!wanted || !name) return 0;
  if (name === wanted) return 100;
  if (slug === wanted) return 95;
  if (name.includes(wanted)) return 85;
  if (wanted.includes(name)) return 75;

  const wantedWords = new Set(wanted.split(' ').filter(Boolean));
  const nameWords = new Set(name.split(' ').filter(Boolean));
  const overlap = [...wantedWords].filter((word) => nameWords.has(word)).length;
  return overlap * 20;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout efter ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function wooFetch(path, options = {}) {
  const baseUrl = normalizeBaseUrl(process.env.WOOCOMMERCE_URL);
  const url = withWooCredentials(new URL(`/wp-json/wc/v3${path}`, baseUrl));
  const basicAuth = localSiteAuthHeader();

  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      ...(basicAuth ? { Authorization: basicAuth } : {}),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? parseMaybeJson(text) || text : null;

  if (!response.ok) {
    const message = typeof data === 'object' ? data?.message : data;
    throw new Error(`WooCommerce ${response.status}: ${message || response.statusText}`);
  }

  return data;
}

async function findProductByName(productName) {
  const query = clean(productName);
  if (!query) throw new Error('Produkt mangler');

  const baseUrl = normalizeBaseUrl(process.env.WOOCOMMERCE_URL);
  const url = withWooCredentials(new URL('/wp-json/wc/v3/products', baseUrl));
  url.searchParams.set('search', query);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('status', 'publish');
  const basicAuth = localSiteAuthHeader();

  const response = await fetchWithTimeout(url, {
    headers: {
      ...(basicAuth ? { Authorization: basicAuth } : {}),
      Accept: 'application/json',
    },
  });

  const text = await response.text();
  const products = text ? parseMaybeJson(text) : [];

  if (!response.ok) {
    const message = Array.isArray(products) ? null : products?.message;
    throw new Error(`WooCommerce produktsøgning ${response.status}: ${message || response.statusText}`);
  }

  if (!Array.isArray(products) || products.length === 0) {
    throw new Error(`Kunne ikke finde produktet "${query}"`);
  }

  const ranked = products
    .map((product) => ({ product, score: scoreProduct(product, query) }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0].score <= 0) {
    throw new Error(`Intet sikkert produktmatch for "${query}"`);
  }

  return ranked[0].product;
}

function buildOrderPayload(input, product) {
  const quantity = Math.max(1, Number.parseInt(input.quantity || input.antal || '1', 10) || 1);
  const name = clean(input.name || input.navn || 'Vapi kunde');
  const phone = normalizePhone(input.phone || input.telefon);
  const pickupTime = clean(input.pickup_time || input.afhentningstid || input.tidspunkt);
  const notes = clean(input.notes || input.note || input.besked);
  const deliveryType = clean(input.delivery_type || input.type || 'Afhentning') || 'Afhentning';

  return {
    payment_method: 'cod',
    payment_method_title: 'Betaling ved afhentning',
    set_paid: false,
    status: 'processing',
    billing: {
      first_name: name,
      phone,
    },
    line_items: [
      {
        product_id: product.id,
        quantity,
      },
    ],
    customer_note: [
      `Bestilt via Vapi agent`,
      `Type: ${deliveryType}`,
      pickupTime ? `Tidspunkt: ${pickupTime}` : '',
      notes ? `Note: ${notes}` : '',
    ].filter(Boolean).join('\n'),
    meta_data: [
      { key: 'zeppo_source', value: 'vapi' },
      { key: 'zeppo_product_spoken', value: clean(input.product || input.produkt || input.item) },
      { key: 'zeppo_pickup_time', value: pickupTime || 'Ikke oplyst' },
    ],
  };
}

function vapiToolResponse(result) {
  return {
    results: [
      {
        toolCallId: result.toolCallId || 'create_woocommerce_order',
        result: JSON.stringify(result),
      },
    ],
    ...result,
  };
}

function debugInfo() {
  return {
    woo_url: normalizeBaseUrl(process.env.WOOCOMMERCE_URL),
    has_consumer_key: Boolean(clean(process.env.WOOCOMMERCE_CONSUMER_KEY)),
    has_consumer_secret: Boolean(clean(process.env.WOOCOMMERCE_CONSUMER_SECRET)),
    basic_auth_user: clean(process.env.WOOCOMMERCE_BASIC_AUTH_USER) || 'Ikke sat',
    has_basic_auth_password: Boolean(clean(process.env.WOOCOMMERCE_BASIC_AUTH_PASSWORD)),
    has_vapi_secret: Boolean(clean(process.env.VAPI_SECRET)),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!validateVapiSecret(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    assertConfig();

    const input = extractPayload(req.body || {});
    const productName = clean(input.product || input.produkt || input.item || input.vare);
    const product = await findProductByName(productName);
    const orderPayload = buildOrderPayload(input, product);
    const order = await wooFetch('/orders', {
      method: 'POST',
      body: JSON.stringify(orderPayload),
    });

    const result = {
      ok: true,
      message: `Ordre #${order.id} er oprettet for ${product.name}.`,
      order_id: order.id,
      order_number: order.number,
      product_id: product.id,
      product_name: product.name,
      quantity: orderPayload.line_items[0].quantity,
      status: order.status,
      toolCallId: req.body?.message?.toolCalls?.[0]?.id || req.body?.toolCallId,
    };

    console.log('WooCommerce ordre oprettet:', result);
    return res.status(200).json(vapiToolResponse(result));
  } catch (error) {
    console.error('WooCommerce ordre fejl:', error.message);
    const result = {
      ok: false,
      error: error.message,
      debug: debugInfo(),
      toolCallId: req.body?.message?.toolCalls?.[0]?.id || req.body?.toolCallId,
    };
    return res.status(200).json(vapiToolResponse(result));
  }
}
