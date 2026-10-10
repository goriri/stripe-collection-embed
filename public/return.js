async function checkSessionStatus() {
  const loadingEl = document.getElementById('loading');
  const successEl = document.getElementById('success');
  const customerEmailEl = document.getElementById('customer-email');
  const paymentStatusEl = document.getElementById('payment-status');
  const errorEl = document.getElementById('error-message');

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');

  if (!sessionId) {
    loadingEl.classList.add('hidden');
    errorEl.textContent = 'Missing session_id query parameter.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch(`/session-status?session_id=${encodeURIComponent(sessionId)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to retrieve session status.');
    }

    if (data.status === 'open') {
      window.location.replace('/');
      return;
    }

    loadingEl.classList.add('hidden');

    if (data.status === 'complete') {
      customerEmailEl.textContent = data.customer_email || 'your email';
      paymentStatusEl.textContent = data.payment_status || 'paid';
      successEl.classList.remove('hidden');
    } else {
      errorEl.textContent = `Session status: ${data.status}`;
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    loadingEl.classList.add('hidden');
    errorEl.textContent = err.message || 'Unable to verify checkout session.';
    errorEl.classList.remove('hidden');
  }
}

checkSessionStatus();
