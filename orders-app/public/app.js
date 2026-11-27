let currentBranch = localStorage.getItem('branch') || '';

const branchSelect = document.getElementById('branchSelect');
const newOrderCard = document.getElementById('newOrderCard');
const toastEl = document.getElementById('toast');

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function rxSummary(rx) {
  if (!rx) return '';
  const parts = [];
  if (rx.r_sph || rx.r_cyl || rx.r_axis) {
    parts.push(`R: SPH ${rx.r_sph || '-'}  CYL ${rx.r_cyl || '-'}  AXIS ${rx.r_axis || '-'}`);
  }
  if (rx.l_sph || rx.l_cyl || rx.l_axis) {
    parts.push(`L: SPH ${rx.l_sph || '-'}  CYL ${rx.l_cyl || '-'}  AXIS ${rx.l_axis || '-'}`);
  }
  const extra = [];
  if (rx.add) extra.push(`ADD ${rx.add}`);
  if (rx.pd) extra.push(`PD ${rx.pd}`);
  if (extra.length) parts.push(extra.join('   '));
  return parts.join('\n');
}

async function loadBranches() {
  const res = await fetch('/api/config');
  const data = await res.json();
  branchSelect.innerHTML = '';
  data.branches.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    branchSelect.appendChild(opt);
  });
  const allOpt = document.createElement('option');
  allOpt.value = 'All';
  allOpt.textContent = 'All Branches (combined)';
  branchSelect.appendChild(allOpt);

  if (currentBranch && [...branchSelect.options].some((o) => o.value === currentBranch)) {
    branchSelect.value = currentBranch;
  } else {
    currentBranch = branchSelect.value;
  }
  updateBranchUI();
}

function updateBranchUI() {
  newOrderCard.style.display = currentBranch === 'All' ? 'none' : 'block';
}

branchSelect.addEventListener('change', () => {
  currentBranch = branchSelect.value;
  localStorage.setItem('branch', currentBranch);
  updateBranchUI();
  loadOrders();
});

function orderCardHtml(order) {
  const badge = `<span class="badge ${order.status}">${order.status.toUpperCase()}</span>`;
  const branchTag = currentBranch === 'All' ? ` &middot; ${order.branch}` : '';
  let actions = '';
  if (order.status === 'placed') {
    actions = `<button class="btn-ready" data-action="ready" data-id="${order.id}">Mark Ready</button>`;
  } else if (order.status === 'ready') {
    actions = `<button class="btn-collect" data-action="collected" data-id="${order.id}">Mark Collected</button>`;
  }
  actions += ` <button class="btn-delete" data-action="delete" data-id="${order.id}">Delete</button>`;

  return `
    <div class="order">
      <div class="top">
        <div>
          <div class="name">${order.customerName}${branchTag}</div>
          <div class="meta">📞 ${order.phone} &middot; Placed: ${fmtTime(order.createdAt)}</div>
        </div>
        ${badge}
      </div>
      <div class="rx-summary">${rxSummary(order.prescription)}</div>
      <div class="actions">${actions}</div>
    </div>
  `;
}

async function loadOrders() {
  const res = await fetch(`/api/orders?branch=${encodeURIComponent(currentBranch)}`);
  const orders = await res.json();

  const pending = orders.filter((o) => o.status === 'placed');
  const ready = orders.filter((o) => o.status === 'ready');
  const collected = orders.filter((o) => o.status === 'collected').slice(0, 20);

  document.getElementById('pendingList').innerHTML =
    pending.length ? pending.map(orderCardHtml).join('') : '<div class="empty">No pending orders.</div>';
  document.getElementById('readyList').innerHTML =
    ready.length ? ready.map(orderCardHtml).join('') : '<div class="empty">No orders ready for pickup.</div>';
  document.getElementById('collectedList').innerHTML =
    collected.length ? collected.map(orderCardHtml).join('') : '<div class="empty">No collected orders yet.</div>';
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;

  if (action === 'delete') {
    if (!confirm('Delete this order? This cannot be undone.')) return;
    await fetch(`/api/orders/${id}`, { method: 'DELETE' });
    showToast('Order deleted.');
    loadOrders();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  const res = await fetch(`/api/orders/${id}/${action}`, { method: 'POST' });
  const data = await res.json();
  if (data.whatsapp && data.whatsapp.ok) {
    showToast('Status updated & WhatsApp sent!');
  } else {
    showToast('Status updated, but WhatsApp message failed to send.');
  }
  loadOrders();
});

document.getElementById('orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    branch: currentBranch,
    customerName: document.getElementById('customerName').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    prescription: {
      r_sph: document.getElementById('r_sph').value.trim(),
      r_cyl: document.getElementById('r_cyl').value.trim(),
      r_axis: document.getElementById('r_axis').value.trim(),
      l_sph: document.getElementById('l_sph').value.trim(),
      l_cyl: document.getElementById('l_cyl').value.trim(),
      l_axis: document.getElementById('l_axis').value.trim(),
      add: document.getElementById('add').value.trim(),
      pd: document.getElementById('pd').value.trim(),
    },
  };

  const submitBtn = e.target.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Placing order...';

  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  submitBtn.disabled = false;
  submitBtn.textContent = 'Place Order & Notify Customer';

  if (data.whatsapp && data.whatsapp.ok) {
    showToast('Order placed & WhatsApp sent to customer!');
  } else {
    showToast('Order saved, but WhatsApp message failed — check phone number.');
  }
  e.target.reset();
  loadOrders();
});

(async function init() {
  await loadBranches();
  await loadOrders();
  setInterval(loadOrders, 15000); // auto-refresh so staff see new/updated orders without reloading
})();
