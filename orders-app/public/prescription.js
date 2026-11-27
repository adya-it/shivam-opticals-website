const form = document.getElementById('lookupForm');
const resultEl = document.getElementById('result');

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

function rxRow(label, sph, cyl, axis) {
  return `<tr><td>${label}</td><td>${sph || '-'}</td><td>${cyl || '-'}</td><td>${axis || '-'}</td></tr>`;
}

function statusLabel(status) {
  if (status === 'placed') return 'Being Prepared';
  if (status === 'ready') return 'Ready for Pickup';
  if (status === 'collected') return 'Collected';
  return status;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('phone').value.trim();
  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  resultEl.innerHTML = '<p class="status">Searching...</p>';

  try {
    const res = await fetch(`api/prescription?phone=${encodeURIComponent(phone)}`);
    if (res.status === 404) {
      resultEl.innerHTML = '<p class="status error">No prescription found for this number. Please check the number, or contact the shop directly.</p>';
    } else if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      resultEl.innerHTML = `<p class="status error">${data.error || 'Something went wrong. Please try again.'}</p>`;
    } else {
      const order = await res.json();
      const rx = order.prescription || {};
      resultEl.innerHTML = `
        <div class="slip">
          <div class="slip-header">
            <div class="slip-shop">Shivam Opticals</div>
            <div class="slip-branch">${order.branch} Branch</div>
          </div>
          <div class="slip-row"><span>Customer</span><span>${order.customerName}</span></div>
          <div class="slip-row"><span>Order Date</span><span>${fmtDate(order.createdAt)}</span></div>
          <div class="slip-row"><span>Status</span><span class="badge ${order.status}">${statusLabel(order.status)}</span></div>
          <table class="rx-table">
            <tr><th></th><th>SPH</th><th>CYL</th><th>AXIS</th></tr>
            ${rxRow('Right', rx.r_sph, rx.r_cyl, rx.r_axis)}
            ${rxRow('Left', rx.l_sph, rx.l_cyl, rx.l_axis)}
          </table>
          <div class="slip-row"><span>ADD</span><span>${rx.add || '-'}</span></div>
          <div class="slip-row"><span>PD</span><span>${rx.pd || '-'}</span></div>
        </div>
      `;
    }
  } catch (err) {
    resultEl.innerHTML = '<p class="status error">Something went wrong. Please try again.</p>';
  }

  btn.disabled = false;
  btn.textContent = 'Find My Prescription';
});
