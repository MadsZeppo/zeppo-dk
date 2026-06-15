function clean(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const raw = clean(value).replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getWooEnv() {
  return {
    url: normalizeBaseUrl(process.env.WOO_URL || process.env.WOOCOMMERCE_URL),
    consumerKey: clean(
      process.env.WOO_CONSUMER_KEY ||
      process.env.WOOCOMMERCE_CONSUMER_KEY ||
      process.env.WC_CONSUMER_KEY
    ),
    consumerSecret: clean(
      process.env.WOO_CONSUMER_SECRET ||
      process.env.WOOCOMMERCE_CONSUMER_SECRET ||
      process.env.WC_CONSUMER_SECRET
    ),
    basicAuthUser: clean(process.env.WP_BASIC_AUTH_USER || process.env.WOOCOMMERCE_BASIC_AUTH_USER),
    basicAuthPassword: clean(process.env.WP_BASIC_AUTH_PASSWORD || process.env.WOOCOMMERCE_BASIC_AUTH_PASSWORD),
  };
}

export function assertWooConfig() {
  const env = getWooEnv();
  const missing = [];
  if (!env.url) missing.push('WOO_URL');
  if (!env.consumerKey) missing.push('WOO_CONSUMER_KEY');
  if (!env.consumerSecret) missing.push('WOO_CONSUMER_SECRET');

  if (missing.length > 0) {
    const error = new Error(`Mangler WooCommerce env vars: ${missing.join(', ')}`);
    error.code = 'CONFIG_MISSING';
    throw error;
  }
}

export class WooCommerceError extends Error {
  constructor(message, status, body, code = 'WOOCOMMERCE_ERROR') {
    super(message);
    this.name = 'WooCommerceError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

function buildWooUrl(path) {
  const env = getWooEnv();
  let url;
  try {
    url = new URL(`/wp-json/wc/v3${path}`, env.url);
  } catch (error) {
    throw new WooCommerceError(
      `Ugyldig WooCommerce URL: ${error.message}`,
      500,
      null,
      'INVALID_WOO_URL'
    );
  }
  const useSiteBasicAuth = env.basicAuthUser && env.basicAuthPassword;
  if (useSiteBasicAuth) {
    url.searchParams.set('consumer_key', env.consumerKey);
    url.searchParams.set('consumer_secret', env.consumerSecret);
  }
  return url;
}

function buildHeaders(extraHeaders = {}) {
  const env = getWooEnv();
  const useSiteBasicAuth = env.basicAuthUser && env.basicAuthPassword;
  const authUser = useSiteBasicAuth ? env.basicAuthUser : env.consumerKey;
  const authPassword = useSiteBasicAuth ? env.basicAuthPassword : env.consumerSecret;

  return {
    Authorization: `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new WooCommerceError(`WooCommerce timeout efter ${timeoutMs}ms`, 504, null, 'WOO_TIMEOUT');
    }
    throw new WooCommerceError(
      `Kunne ikke kontakte WooCommerce: ${error.message}`,
      502,
      { cause: error.cause?.code || error.code || error.name || 'FETCH_FAILED' },
      'WOO_NETWORK_ERROR'
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function wooFetch(path, options = {}) {
  assertWooConfig();
  const url = buildWooUrl(path);
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: buildHeaders(options.headers || {}),
  });

  const text = await response.text();
  const body = parseMaybeJson(text);

  if (!response.ok) {
    const message = typeof body === 'object' && body ? body.message : body;
    throw new WooCommerceError(
      `WooCommerce ${response.status}: ${message || response.statusText}`,
      response.status,
      body
    );
  }

  return body;
}

export async function createWooCommerceOrder(payload) {
  return wooFetch('/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getWooCommerceProduct(productId) {
  return wooFetch(`/products/${encodeURIComponent(productId)}`);
}

export async function testWooCommerceConnection() {
  return wooFetch('/system_status');
}
