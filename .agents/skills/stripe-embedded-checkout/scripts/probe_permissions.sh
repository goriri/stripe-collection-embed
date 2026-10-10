#!/usr/bin/env bash
# Probe Stripe API key permissions for Embedded Checkout without echoing the secret key.
#
# Required env vars:
#   STRIPE_SECRET_KEY                (rk_test_... / sk_test_... / rk_live_...)
#   PRODUCT_ID or STRIPE_PRODUCT_ID  (prod_...)
# Optional env vars:
#   STRIPE_PRICE_ID                  (price_... fallback if Product has no default_price)
#   CHECKOUT_MODE                    (default: subscription; or payment / setup)
#   UI_MODE                          (default: embedded_page; falls back to embedded if account API version is older)
#   STRIPE_API_VERSION               (auto-detected from ./node_modules/stripe/cjs/apiVersion.js if installed)
#   RETURN_URL                       (default: http://localhost:4242/return.html?session_id={CHECKOUT_SESSION_ID})

set -uo pipefail

if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "[FAIL] Missing STRIPE_SECRET_KEY in environment." >&2
  exit 1
fi

PRODUCT_ID="${PRODUCT_ID:-${STRIPE_PRODUCT_ID:-}}"
if [[ -z "${PRODUCT_ID}" ]]; then
  echo "[FAIL] Missing PRODUCT_ID (or STRIPE_PRODUCT_ID) in environment." >&2
  exit 1
fi

CHECKOUT_MODE="${CHECKOUT_MODE:-subscription}"
UI_MODE="${UI_MODE:-embedded_page}"
RETURN_URL="${RETURN_URL:-http://localhost:4242/return.html?session_id={CHECKOUT_SESSION_ID}}"
RESOLVED_PRICE_ID="${STRIPE_PRICE_ID:-}"
OVERALL_RC=0

if [[ -z "${STRIPE_API_VERSION:-}" && -f "./node_modules/stripe/cjs/apiVersion.js" ]]; then
  STRIPE_API_VERSION="$(node -e 'try { process.stdout.write(require("./node_modules/stripe/cjs/apiVersion.js").ApiVersion || ""); } catch (_) {}')"
fi

CURL_VERSION_HEADER=()
if [[ -n "${STRIPE_API_VERSION:-}" ]]; then
  CURL_VERSION_HEADER=(-H "Stripe-Version: ${STRIPE_API_VERSION}")
fi

extract_json_field() {
  local expr="$1"
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        const fn = new Function("data", "return " + process.argv[1]);
        const val = fn(data);
        if (val !== undefined && val !== null) process.stdout.write(String(val));
      } catch (_) {}
    });
  ' "$expr"
}

# 1. Product Read (GET /v1/products/:id)
PROD_RESP_FILE="$(mktemp)"
PROD_HTTP="$(curl -sS -o "$PROD_RESP_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer ${STRIPE_SECRET_KEY}" \
  ${CURL_VERSION_HEADER[@]+"${CURL_VERSION_HEADER[@]}"} \
  "https://api.stripe.com/v1/products/${PRODUCT_ID}")"

if [[ "$PROD_HTTP" == "200" ]]; then
  DEFAULT_PRICE="$(extract_json_field 'typeof data.default_price === "string" ? data.default_price : (data.default_price && data.default_price.id) || ""' < "$PROD_RESP_FILE")"
  echo "[OK]   product_read: GET /v1/products/${PRODUCT_ID} (default_price=${DEFAULT_PRICE:-none})"
  if [[ -n "$DEFAULT_PRICE" ]]; then
    RESOLVED_PRICE_ID="$DEFAULT_PRICE"
  fi
else
  ERR_MSG="$(extract_json_field 'data.error && data.error.message' < "$PROD_RESP_FILE")"
  echo "[FAIL] product_read: GET /v1/products/${PRODUCT_ID} (HTTP ${PROD_HTTP}) - ${ERR_MSG:-unknown error}"
  OVERALL_RC=1
fi
rm -f "$PROD_RESP_FILE"

# 2. Price List (GET /v1/prices?product=:id&limit=1)
PRICE_RESP_FILE="$(mktemp)"
PRICE_HTTP="$(curl -sS -o "$PRICE_RESP_FILE" -w "%{http_code}" \
  -G \
  -H "Authorization: Bearer ${STRIPE_SECRET_KEY}" \
  ${CURL_VERSION_HEADER[@]+"${CURL_VERSION_HEADER[@]}"} \
  --data-urlencode "product=${PRODUCT_ID}" \
  --data-urlencode "limit=1" \
  "https://api.stripe.com/v1/prices")"

if [[ "$PRICE_HTTP" == "200" ]]; then
  FIRST_PRICE="$(extract_json_field '(data.data && data.data[0] && data.data[0].id) || ""' < "$PRICE_RESP_FILE")"
  echo "[OK]   price_list: GET /v1/prices?product=${PRODUCT_ID}&limit=1 (first_price=${FIRST_PRICE:-none})"
  if [[ -z "$RESOLVED_PRICE_ID" && -n "$FIRST_PRICE" ]]; then
    RESOLVED_PRICE_ID="$FIRST_PRICE"
  fi
else
  ERR_MSG="$(extract_json_field 'data.error && data.error.message' < "$PRICE_RESP_FILE")"
  echo "[FAIL] price_list: GET /v1/prices?product=${PRODUCT_ID}&limit=1 (HTTP ${PRICE_HTTP}) - ${ERR_MSG:-unknown error}"
  if [[ -z "$RESOLVED_PRICE_ID" ]]; then
    OVERALL_RC=1
  fi
fi
rm -f "$PRICE_RESP_FILE"

# 3. Checkout Session Create + Expire (POST /v1/checkout/sessions + POST /v1/checkout/sessions/:id/expire)
if [[ -z "$RESOLVED_PRICE_ID" ]]; then
  echo "[FAIL] checkout_session_create: Cannot test session creation because no Price ID was resolved."
  exit 1
fi

create_session_with_ui_mode() {
  local mode_arg="$1"
  local out_file="$2"
  curl -sS -o "$out_file" -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${STRIPE_SECRET_KEY}" \
    ${CURL_VERSION_HEADER[@]+"${CURL_VERSION_HEADER[@]}"} \
    --data-urlencode "ui_mode=${mode_arg}" \
    --data-urlencode "mode=${CHECKOUT_MODE}" \
    --data-urlencode "customer_email=probe+sandbox@example.com" \
    --data-urlencode "line_items[0][price]=${RESOLVED_PRICE_ID}" \
    --data-urlencode "line_items[0][quantity]=1" \
    --data-urlencode "return_url=${RETURN_URL}" \
    "https://api.stripe.com/v1/checkout/sessions"
}

CREATE_RESP_FILE="$(mktemp)"
ACTIVE_UI_MODE="$UI_MODE"
CREATE_HTTP="$(create_session_with_ui_mode "$ACTIVE_UI_MODE" "$CREATE_RESP_FILE")"

if [[ "$CREATE_HTTP" == "400" && "$ACTIVE_UI_MODE" == "embedded_page" ]]; then
  ERR_MSG="$(extract_json_field 'data.error && data.error.message' < "$CREATE_RESP_FILE")"
  if [[ "$ERR_MSG" == *"Invalid ui_mode: embedded_page"* ]]; then
    ACTIVE_UI_MODE="embedded"
    CREATE_HTTP="$(create_session_with_ui_mode "$ACTIVE_UI_MODE" "$CREATE_RESP_FILE")"
  fi
fi

if [[ "$CREATE_HTTP" == "200" ]]; then
  SESSION_ID="$(extract_json_field 'data.id || ""' < "$CREATE_RESP_FILE")"
  echo "[OK]   checkout_session_create: POST /v1/checkout/sessions (mode=${CHECKOUT_MODE}, ui_mode=${ACTIVE_UI_MODE}, session_id=${SESSION_ID})"
  rm -f "$CREATE_RESP_FILE"

  EXPIRE_RESP_FILE="$(mktemp)"
  EXPIRE_HTTP="$(curl -sS -o "$EXPIRE_RESP_FILE" -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${STRIPE_SECRET_KEY}" \
    ${CURL_VERSION_HEADER[@]+"${CURL_VERSION_HEADER[@]}"} \
    "https://api.stripe.com/v1/checkout/sessions/${SESSION_ID}/expire")"
  if [[ "$EXPIRE_HTTP" == "200" ]]; then
    EXPIRED_STATUS="$(extract_json_field 'data.status || ""' < "$EXPIRE_RESP_FILE")"
    echo "[OK]   checkout_session_expire: POST /v1/checkout/sessions/${SESSION_ID}/expire (status=${EXPIRED_STATUS})"
  else
    ERR_MSG="$(extract_json_field 'data.error && data.error.message' < "$EXPIRE_RESP_FILE")"
    echo "[FAIL] checkout_session_expire: POST /v1/checkout/sessions/${SESSION_ID}/expire (HTTP ${EXPIRE_HTTP}) - ${ERR_MSG:-unknown error}"
    OVERALL_RC=1
  fi
  rm -f "$EXPIRE_RESP_FILE"
else
  ERR_MSG="$(extract_json_field 'data.error && data.error.message' < "$CREATE_RESP_FILE")"
  echo "[FAIL] checkout_session_create: POST /v1/checkout/sessions (HTTP ${CREATE_HTTP}) - ${ERR_MSG:-unknown error}"
  rm -f "$CREATE_RESP_FILE"
  OVERALL_RC=1
fi

exit "$OVERALL_RC"
