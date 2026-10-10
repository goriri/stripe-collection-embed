let stripeInstance = null;
let embeddedCheckoutInstance = null;
let cachedConfig = null;

const emailForm = document.getElementById('email-form');
const emailInput = document.getElementById('email-input');
const submitBtn = document.getElementById('submit-btn');
const errorBox = document.getElementById('error-message');
const planHeading = document.getElementById('plan-heading');
const planPrice = document.getElementById('plan-price');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function renderPlanDetails(config) {
  if (planHeading) {
    if (config && config.productName) {
      planHeading.textContent = 'Subscribe to ';
      const nameSpan = document.createElement('span');
      nameSpan.id = 'product-name';
      nameSpan.textContent = config.productName;
      planHeading.appendChild(nameSpan);
    } else {
      planHeading.textContent = 'Subscribe';
    }
  }
  if (planPrice) {
    if (config && config.displayPrice) {
      planPrice.textContent = config.displayPrice;
      planPrice.classList.remove('hidden');
    } else {
      planPrice.textContent = '';
      planPrice.classList.add('hidden');
    }
  }
}

async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const res = await fetch('/config');
  const data = await res.json();
  if (!res.ok || !data.publishableKey) {
    throw new Error(data.error || 'Failed to load Stripe publishable key.');
  }
  cachedConfig = data;
  renderPlanDetails(data);
  return data;
}

async function getStripe() {
  if (stripeInstance) return stripeInstance;
  const data = await loadConfig();
  stripeInstance = window.Stripe(data.publishableKey);
  return stripeInstance;
}

loadConfig().catch(() => {
  // Keep fallback heading if initial config fetch fails; form submit will retry
});

emailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const email = emailInput.value.trim();
  if (!email || !emailInput.checkValidity()) {
    showError('Please enter a valid email address.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Loading Checkout...';

  try {
    const stripe = await getStripe();

    const sessionRes = await fetch('/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const sessionData = await sessionRes.json();
    if (!sessionRes.ok) {
      throw new Error(sessionData.error || 'Failed to create checkout session.');
    }

    if (embeddedCheckoutInstance) {
      embeddedCheckoutInstance.destroy();
      embeddedCheckoutInstance = null;
    }

    const fetchClientSecret = async () => sessionData.clientSecret;

    embeddedCheckoutInstance = await stripe.initEmbeddedCheckout({
      fetchClientSecret,
    });

    emailForm.classList.add('hidden');
    embeddedCheckoutInstance.mount('#checkout');
  } catch (err) {
    showError(err.message || 'Unable to start checkout.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Continue to Checkout';
  }
});
