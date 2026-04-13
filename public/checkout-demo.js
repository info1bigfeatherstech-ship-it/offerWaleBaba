/**
 * Dummy checkout UI — same origin as API (e.g. http://localhost:8081/checkout-demo.html).
 * Token: sessionStorage checkoutDemoToken
 */
(function () {
  const API = '/api';
  const TOKEN_KEY = 'checkoutDemoToken';

  const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  const panels = ['login', 'products', 'cart', 'address', 'pay'].map((s) => $('p-' + s));

  let selectedAddressId = '';
  let lastQuote = null;

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(t) {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function showMessage(text, isError) {
    msg.hidden = false;
    msg.textContent = text;
    msg.style.background = isError ? '#7f1d1d' : '#14532d';
    msg.style.color = isError ? '#fecaca' : '#bbf7d0';
  }

  function clearMessage() {
    msg.hidden = true;
    msg.textContent = '';
  }

  async function api(path, opt) {
    opt = opt || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(API + path, Object.assign({}, opt, { headers: headers }));
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(data.message || data.error || res.statusText || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showPanel(name) {
    panels.forEach((el) => {
      if (!el) return;
      el.hidden = el.id !== 'p-' + name;
    });
    document.querySelectorAll('.steps button').forEach((b) => {
      b.classList.toggle('on', b.dataset.step === name);
    });
  }

  function buildStepTabs() {
    const nav = $('stepTabs');
    const steps = [
      ['login', 'Login'],
      ['products', 'Products'],
      ['cart', 'Cart'],
      ['address', 'Address'],
      ['pay', 'Pay']
    ];
    nav.innerHTML = '';
    steps.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.step = id;
      b.onclick = () => {
        if (id !== 'login' && !token()) {
          showMessage('Sign in first', true);
          showPanel('login');
          return;
        }
        showPanel(id);
        if (id === 'products') loadProducts();
        if (id === 'cart') loadCart();
        if (id === 'address') loadAddresses();
      };
      nav.appendChild(b);
    });
  }

  // —— Login ——
  $('formLogin').onsubmit = async (e) => {
    e.preventDefault();
    clearMessage();
    const fd = new FormData(e.target);
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: fd.get('identifier'),
          password: fd.get('password')
        })
      });
      if (data.accessToken) {
        setToken(data.accessToken);
        showMessage('Signed in.', false);
        showPanel('products');
        loadProducts();
      }
    } catch (err) {
      showMessage(err.message || 'Login failed', true);
    }
  };

  // —— Products ——
  async function loadProducts() {
    const list = $('productList');
    list.innerHTML = 'Loading…';
    try {
      const data = await api('/products/all?limit=40', { method: 'GET' });
      const products = data.products || [];
      list.innerHTML = '';
      products.forEach((p) => {
        const v = (p.variants || []).find((x) => x.isActive) || p.variants?.[0];
        if (!v) return;
        const price = v.price && (v.price.sale != null ? v.price.sale : v.price.base);
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML =
          '<div><strong>' +
          escapeHtml(p.name) +
          '</strong></div><div class="price">₹' +
          price +
          '</div>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Add to cart';
        btn.onclick = () => addToCart(p._id, v._id);
        card.appendChild(btn);
        list.appendChild(card);
      });
      if (!list.children.length) list.textContent = 'No products.';
    } catch (err) {
      list.textContent = err.message || 'Failed to load products';
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function addToCart(productId, variantId) {
    clearMessage();
    try {
      await api('/cart', {
        method: 'POST',
        body: JSON.stringify({ productId, variantId, quantity: 1 })
      });
      showMessage('Added to cart.', false);
    } catch (err) {
      showMessage(err.message || 'Add to cart failed', true);
    }
  }

  $('btnGoCart').onclick = () => {
    showPanel('cart');
    loadCart();
  };

  // —— Cart ——
  async function loadCart() {
    const body = $('cartBody');
    body.innerHTML = 'Loading…';
    try {
      const data = await api('/cart', { method: 'GET' });
      const cart = data.cart;
      const items = cart && cart.items ? cart.items : [];
      if (!items.length) {
        body.innerHTML = '<p class="muted">Cart is empty.</p>';
        return;
      }
      body.innerHTML =
        '<ul style="margin:0;padding-left:1.1rem">' +
        items
          .map(
            (it) =>
              '<li>' +
              escapeHtml(it.product && it.product.name ? it.product.name : 'Item') +
              ' × ' +
              it.quantity +
              ' — ₹' +
              it.total +
              '</li>'
          )
          .join('') +
        '</ul><p><strong>Subtotal (UI):</strong> ₹' +
        (cart.totalAmount || 0) +
        ' <span class="muted">(server recomputes at checkout)</span></p>';
    } catch (err) {
      body.textContent = err.message || 'Cart error';
    }
  }

  $('btnBackProducts').onclick = () => showPanel('products');
  $('btnGoAddress').onclick = () => {
    showPanel('address');
    loadAddresses();
  };

  // —— Address ——
  $('formAddress').onsubmit = async (e) => {
    e.preventDefault();
    clearMessage();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      await api('/addresses', { method: 'POST', body: JSON.stringify(body) });
      showMessage('Address saved.', false);
      e.target.reset();
      const pc = $('formAddress').querySelector('[name="postalCode"]');
      if (pc) pc.value = '';
      loadAddresses();
    } catch (err) {
      showMessage(err.message || 'Save failed', true);
    }
  };

  async function loadAddresses() {
    const wrap = $('addressList');
    wrap.innerHTML = 'Loading…';
    try {
      const data = await api('/addresses', { method: 'GET' });
      const list = [].concat(data.defaultAddress || [], data.addresses || []);
      wrap.innerHTML = '';
      if (!list.length) {
        wrap.innerHTML = '<p class="muted">No addresses yet — add one above.</p>';
        $('btnCheckDelivery').disabled = true;
        return;
      }
      list.forEach((a) => {
        const id = String(a._id);
        const lab = document.createElement('label');
        const rb = document.createElement('input');
        rb.type = 'radio';
        rb.name = 'selAddr';
        rb.value = id;
        rb.checked = selectedAddressId === id;
        rb.onchange = () => {
          selectedAddressId = id;
          $('btnCheckDelivery').disabled = false;
        };
        lab.appendChild(rb);
        lab.appendChild(
          document.createTextNode(
            ' ' + (a.fullName || '') + ' — ' + (a.addressLine1 || '') + ', ' + (a.city || '') + ' ' + (a.postalCode || '')
          )
        );
        wrap.appendChild(lab);
      });
      if (!selectedAddressId && list[0]) {
        selectedAddressId = String(list[0]._id);
        const first = wrap.querySelector('input[type="radio"]');
        if (first) first.checked = true;
        $('btnCheckDelivery').disabled = false;
      }
    } catch (err) {
      wrap.textContent = err.message || 'Failed to load addresses';
    }
  }

  $('btnCheckDelivery').onclick = async () => {
    if (!selectedAddressId) {
      showMessage('Select an address', true);
      return;
    }
    clearMessage();
    $('deliveryStatus').textContent = 'Checking…';
    $('deliveryEta').textContent = '';
    $('quoteBox').hidden = true;
    try {
      const data = await api('/checkout/quote', {
        method: 'POST',
        body: JSON.stringify({
          addressId: selectedAddressId,
          paymentMethodHint: 'online',
          demoMockShipping: true
        })
      });
      if (!data.success) throw new Error(data.message || 'Quote failed');
      lastQuote = data;
      $('deliveryStatus').textContent = data.isDeliverable ? 'Available for this address' : 'Not available';
      $('deliveryEta').textContent = data.deliveryEstimate || '';
      $('qItems').textContent = data.itemCount;
      $('qSub').textContent = data.itemsSubtotal;
      $('qDisc').textContent = data.promotionDiscount;
      $('qTax').textContent = data.taxes;
      $('qPay').textContent = data.amountPayable;
      $('quoteBox').hidden = false;
      showMessage('Totals from server — demo delivery (no Shiprocket). Shipping is inside amount to pay.', false);
      showPanel('pay');
    } catch (err) {
      $('deliveryStatus').textContent = '—';
      showMessage(err.message || 'Quote failed', true);
    }
  };

  $('btnBackCart').onclick = () => showPanel('cart');
  $('btnBackAddress').onclick = () => showPanel('address');

  function loadRzp() {
    return new Promise(function (resolve, reject) {
      if (window.Razorpay) return resolve();
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error('Razorpay script failed'));
      };
      document.body.appendChild(s);
    });
  }

  async function placeOnline(mode) {
    if (!selectedAddressId || !lastQuote) {
      showMessage('Go back and run “Delivery & total” again.', true);
      return;
    }
    clearMessage();
    $('payHint').textContent = '';
    try {
      const orderRes = await api('/orders/items', {
        method: 'POST',
        body: JSON.stringify({
          addressId: selectedAddressId,
          paymentMethod: 'online',
          onlinePaymentMode: mode
        })
      });
      const rz = orderRes.razorpayOrder;
      const orderId = orderRes.order && orderRes.order.orderId;
      if (!rz || !rz.id) {
        showMessage(orderRes.message || 'No Razorpay order (check server keys)', true);
        return;
      }
      const keyData = await api('/public/razorpay-key', { method: 'GET' });
      const keyId = keyData.keyId;
      if (!keyId) throw new Error('Missing Razorpay key on server');

      await loadRzp();
      var options = {
        key: keyId,
        amount: rz.amount,
        currency: rz.currency || 'INR',
        order_id: rz.id,
        name: 'Demo checkout',
        description: 'Order ' + orderId,
        handler: async function (response) {
          try {
            const vr = await api('/orders/items/verify-payment', {
              method: 'POST',
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                orderId: orderId
              })
            });
            $('payHint').textContent = 'Payment OK. Order: ' + orderId;
            showMessage('Payment verified.', false);
            var bal = vr.order && vr.order.balanceDueInr;
            var wrap = $('balancePayWrap');
            wrap.innerHTML = '';
            wrap.hidden = true;
            if (bal != null && Number(bal) > 0.02) {
              wrap.hidden = false;
              wrap.innerHTML =
                '<p class="muted">Balance due: ₹' +
                bal +
                '</p><button type="button" id="btnPayBalance">Pay remaining (Razorpay)</button>';
              $('btnPayBalance').onclick = function () {
                payRemainingBalance(orderId);
              };
            } else {
              lastQuote = null;
              loadCart();
            }
          } catch (ve) {
            showMessage(ve.message || 'Verify failed', true);
          }
        },
        modal: {
          ondismiss: function () {}
        }
      };
      var rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      showMessage(err.message || 'Order failed', true);
    }
  }

  $('btnPayFull').onclick = function () {
    placeOnline('full');
  };
  $('btnPayPartial').onclick = function () {
    placeOnline('advance');
  };

  async function payRemainingBalance(orderId) {
    clearMessage();
    try {
      const pr = await api('/orders/items/' + encodeURIComponent(orderId) + '/pay-balance', { method: 'POST' });
      const rz = pr.razorpayOrder;
      if (!rz || !rz.id) throw new Error('No Razorpay order for balance');
      const keyData = await api('/public/razorpay-key', { method: 'GET' });
      await loadRzp();
      var options = {
        key: keyData.keyId,
        amount: rz.amount,
        currency: rz.currency || 'INR',
        order_id: rz.id,
        name: 'Balance payment',
        description: 'Order ' + orderId,
        handler: async function (response) {
          try {
            await api('/orders/items/verify-payment', {
              method: 'POST',
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                orderId: orderId
              })
            });
            $('balancePayWrap').hidden = true;
            $('payHint').textContent = 'Fully paid. Order: ' + orderId;
            lastQuote = null;
            loadCart();
          } catch (e) {
            showMessage(e.message || 'Balance verify failed', true);
          }
        }
      };
      new window.Razorpay(options).open();
    } catch (err) {
      showMessage(err.message || 'Balance payment failed', true);
    }
  }

  $('btnCod').onclick = async function () {
    if (!selectedAddressId || !lastQuote) {
      showMessage('Run delivery & total first.', true);
      return;
    }
    clearMessage();
    try {
      const data = await api('/orders/items', {
        method: 'POST',
        body: JSON.stringify({
          addressId: selectedAddressId,
          paymentMethod: 'cod'
        })
      });
      showMessage('COD placed: ' + (data.order && data.order.orderId), false);
      lastQuote = null;
      loadCart();
    } catch (err) {
      showMessage(err.message || 'COD failed', true);
    }
  };

  buildStepTabs();
  showPanel('login');
  if (token()) {
    showMessage('Already signed in — open Products.', false);
  }
})();
