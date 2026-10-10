let stripeInstance = null;
let embeddedCheckoutInstance = null;

const emailForm = document.getElementById('email-form');
const emailInput = document.getElementById('email-input');
const submitBtn = document.getElementById('submit-btn');
const errorBox = document.getElementById('error-message');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

async function getStripe() {
  if (stripeInstance) return stripeInstance;
  const res = await fetch('/config');
  const data = await res.json();
  if (!res.ok || !data.publishableKey) {
    throw new Error(data.error || 'Failed to load Stripe publishable key.');
  }
  stripeInstance = window.Stripe(data.publishableKey);
  return stripeInstance;
}

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
