/**
 * admin.js — Operator dashboard.
 *
 * Static SPA that talks to the /admin/* and /fee/* endpoints on the
 * payment worker. The operator secret is stored in sessionStorage and
 * cleared when the tab closes. All requests send it as
 * X-Operator-Secret.
 *
 * No framework. Everything is vanilla DOM.
 */

import { WORKER_SUBDOMAIN } from '../env.js';

const PAYMENT_WORKER_URL = `https://sweep-payment.${WORKER_SUBDOMAIN}.workers.dev`;
const SECRET_KEY = 'sweep_operator_secret';

const state = {
  secret: null,
  currentView: 'pending',
};

// =====================================================================
// HELPERS
// =====================================================================

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

async function apiCall(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Operator-Secret': state.secret };
  if (body) headers['Content-Type'] = 'application/json';
  const resp = await fetch(`${PAYMENT_WORKER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.error || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

function showError(target, err) {
  target.innerHTML = '';
  target.appendChild(el('div', { class: 'error', text: `Error: ${err.message}` }));
}

// =====================================================================
// LOGIN
// =====================================================================

function renderLogin() {
  const root = $('#admin-root');
  root.innerHTML = '';

  const saved = sessionStorage.getItem(SECRET_KEY);
  if (saved) {
    state.secret = saved;
    renderShell();
    return;
  }

  root.appendChild(el('div', { class: 'card login-card' }, [
    el('h2', { text: 'Operator login' }),
    el('p', { class: 'hint', text: 'Paste your operator secret. Stored in sessionStorage and cleared when you close this tab.' }),
    el('input', {
      id: 'secret-input',
      type: 'password',
      placeholder: 'operator secret',
      autocomplete: 'off',
    }),
    el('button', {
      class: 'btn btn-primary',
      text: 'Unlock',
      onclick: () => {
        const val = $('#secret-input').value;
        if (!val) return;
        state.secret = val;
        sessionStorage.setItem(SECRET_KEY, val);
        renderShell();
      },
    }),
  ]));
}

// =====================================================================
// SHELL
// =====================================================================

function renderShell() {
  const root = $('#admin-root');
  root.innerHTML = '';

  const nav = el('div', { class: 'admin-nav' }, [
    el('button', { class: 'btn btn-secondary btn-sm', text: 'Pending forwards', onclick: () => switchView('pending') }),
    el('button', { class: 'btn btn-secondary btn-sm', text: 'Summary', onclick: () => switchView('summary') }),
    el('button', { class: 'btn btn-secondary btn-sm', text: 'Grant credits', onclick: () => switchView('grant') }),
    el('button', { class: 'btn btn-secondary btn-sm', text: 'Lookup client', onclick: () => switchView('lookup') }),
    el('button', { class: 'btn btn-secondary btn-sm', text: 'List clients', onclick: () => switchView('list') }),
    el('button', { class: 'btn btn-secondary btn-sm', text: 'Fingerprint lookup', onclick: () => switchView('fingerprint') }),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-secondary btn-sm',
      text: 'Log out',
      onclick: () => {
        sessionStorage.removeItem(SECRET_KEY);
        state.secret = null;
        renderLogin();
      },
    }),
  ]);

  const content = el('div', { id: 'admin-content' });

  root.appendChild(nav);
  root.appendChild(content);

  switchView(state.currentView);
}

function switchView(view) {
  state.currentView = view;
  const content = $('#admin-content');
  if (!content) return;
  content.innerHTML = '';
  content.appendChild(el('div', { class: 'spinner' }));

  switch (view) {
    case 'pending':     return renderPending(content);
    case 'summary':     return renderSummary(content);
    case 'grant':       return renderGrant(content);
    case 'lookup':      return renderLookup(content);
    case 'list':        return renderList(content);
    case 'fingerprint': return renderFingerprintLookup(content);
    default:            return renderPending(content);
  }
}

// =====================================================================
// VIEW: PENDING FORWARDS
// =====================================================================

async function renderPending(content) {
  try {
    const data = await apiCall('/fee/pending?limit=100');
    content.innerHTML = '';

    if (data.items.length === 0) {
      content.appendChild(el('p', { class: 'hint', text: 'No pending forwards.' }));
      return;
    }

    content.appendChild(el('h2', { text: `Pending forwards (${data.items.length})` }));

    for (const item of data.items) {
      content.appendChild(renderPendingCard(item));
    }
  } catch (err) {
    showError(content, err);
  }
}

function renderPendingCard(item) {
  const card = el('div', { class: 'card' });

  card.appendChild(el('div', { class: 'row' }, [
    el('strong', { text: `Sweep ${item.sweepId.slice(0, 8)}…` }),
    el('span', { class: 'hint', text: ` · ${item.recordedAt}` }),
    el('span', { class: 'hint', text: ` · client ${item.clientId.slice(0, 8)}…` }),
  ]));

  for (const r of item.receipts) {
    const chainLabel = r.family === 'evm' ? `${r.chain}` : r.family;
    card.appendChild(el('div', { class: 'receipt-row' }, [
      el('code', { text: chainLabel }),
      el('span', { text: ` ${r.amountRaw} raw ${r.symbol} (dec ${r.decimals})` }),
      el('span', { class: 'hint', text: ` → ${r.userDestination}` }),
    ]));
  }

  if (item.gasSponsorships && item.gasSponsorships.length > 0) {
    for (const gs of item.gasSponsorships) {
      card.appendChild(el('div', { class: 'receipt-row' }, [
        el('code', { text: `gas·${gs.chain}` }),
        el('span', { text: ` sponsored ${gs.totalSponsoredWei} wei` }),
        el('span', { class: 'hint', text: ` fee ${gs.sponsorshipFeeUsdcRaw} raw USDC` }),
      ]));
    }
  }

  // ---- Inline forward form ----
  //
  // Previously this used window.prompt(), which is blocked in some
  // embedded contexts and gives the operator no way to review what
  // they typed. Now it's a small inline form: two inputs, a save
  // button, and a status line. The form collapses to a "Mark
  // forwarded" button until clicked.

  const formWrap = el('div', { class: 'actions' });

  const openBtn = el('button', {
    class: 'btn btn-primary btn-sm',
    text: 'Mark forwarded',
  });
  formWrap.appendChild(openBtn);

  const form = el('div', { class: 'forward-form', style: 'display:none; margin-top: 12px;' });

  const txInput = el('input', {
    id: `tx-${item.sweepId}`,
    type: 'text',
    placeholder: 'Transaction hashes (comma-separated, optional)',
    autocomplete: 'off',
  });
  const noteInput = el('input', {
    id: `note-${item.sweepId}`,
    type: 'text',
    placeholder: 'Optional note',
    autocomplete: 'off',
  });
  const status = el('div', { class: 'result' });

  const saveBtn = el('button', {
    class: 'btn btn-primary btn-sm',
    text: 'Confirm',
    onclick: async () => {
      const txHashesRaw = txInput.value.trim();
      const txHashes = txHashesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const note = noteInput.value.trim();

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      status.innerHTML = '';

      try {
        await apiCall('/fee/mark-forwarded', {
          method: 'POST',
          body: { sweepId: item.sweepId, txHashes, note },
        });
        card.classList.add('done');
        status.appendChild(el('p', { class: 'success', text: 'Marked as forwarded.' }));
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Confirm';
        showError(status, err);
      }
    },
  });

  const cancelBtn = el('button', {
    class: 'btn btn-secondary btn-sm',
    text: 'Cancel',
    onclick: () => {
      form.style.display = 'none';
      formWrap.style.display = '';
      status.innerHTML = '';
      txInput.value = '';
      noteInput.value = '';
    },
  });

  form.appendChild(el('div', { class: 'field' }, [
    el('label', { for: `tx-${item.sweepId}`, text: 'Transaction hashes' }),
    txInput,
  ]));
  form.appendChild(el('div', { class: 'field' }, [
    el('label', { for: `note-${item.sweepId}`, text: 'Note' }),
    noteInput,
  ]));
  form.appendChild(el('div', { class: 'actions' }, [saveBtn, cancelBtn]));
  form.appendChild(status);

  openBtn.addEventListener('click', () => {
    formWrap.style.display = 'none';
    form.style.display = '';
    txInput.focus();
  });

  card.appendChild(formWrap);
  card.appendChild(form);

  return card;
}

// =====================================================================
// VIEW: SUMMARY
// =====================================================================

async function renderSummary(content) {
  try {
    const data = await apiCall('/fee/summary');
    content.innerHTML = '';

    content.appendChild(el('h2', { text: 'Pending summary' }));
    content.appendChild(el('p', { class: 'hint', text: `${data.totalPendingSweeps} sweeps pending` }));

    const table = el('table', { class: 'summary-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Chain' }),
        el('th', { text: 'Symbol' }),
        el('th', { text: 'Amount' }),
        el('th', { text: 'Count' }),
      ]),
    ]));

    const tbody = el('tbody');
    for (const [key, v] of Object.entries(data.totals)) {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: key }),
        el('td', { text: v.symbol }),
        el('td', { text: String(v.amount) }),
        el('td', { text: String(v.count) }),
      ]));
    }
    table.appendChild(tbody);
    content.appendChild(table);
  } catch (err) {
    showError(content, err);
  }
}

// =====================================================================
// VIEW: GRANT
// =====================================================================

function renderGrant(content) {
  content.innerHTML = '';

  content.appendChild(el('h2', { text: 'Grant credits' }));

  const form = el('div', { class: 'card' });
  form.appendChild(field('Client ID', 'grant-clientId', 'text'));
  form.appendChild(field('Amount (negative to deduct)', 'grant-amount', 'number'));
  form.appendChild(field('Reason', 'grant-reason', 'text', 'manual'));

  const result = el('div', { class: 'result' });

  form.appendChild(el('button', {
    class: 'btn btn-primary',
    text: 'Grant',
    onclick: async () => {
      const clientId = $('#grant-clientId').value.trim();
      const amount = parseInt($('#grant-amount').value, 10);
      const reason = $('#grant-reason').value.trim() || 'manual';

      try {
        const data = await apiCall('/admin/credits/grant', {
          method: 'POST',
          body: { clientId, amount, reason },
        });
        result.innerHTML = '';
        result.appendChild(el('p', { class: 'success', text: `Granted. New balance: ${data.newBalance}` }));
      } catch (err) {
        showError(result, err);
      }
    },
  }));

  form.appendChild(result);
  content.appendChild(form);
}

// =====================================================================
// VIEW: LOOKUP
// =====================================================================

function renderLookup(content) {
  content.innerHTML = '';

  content.appendChild(el('h2', { text: 'Look up a client' }));

  const form = el('div', { class: 'card' });
  form.appendChild(field('Client ID', 'lookup-clientId', 'text'));

  const result = el('div', { class: 'result' });

  form.appendChild(el('button', {
    class: 'btn btn-primary',
    text: 'Look up',
    onclick: async () => {
      const clientId = $('#lookup-clientId').value.trim();
      try {
        const data = await apiCall('/admin/credits/lookup', {
          method: 'POST',
          body: { clientId },
        });
        result.innerHTML = '';
        result.appendChild(el('p', { text: `Balance: ${data.balance}` }));
        if (data.history.length > 0) {
          const list = el('ul');
          for (const h of data.history.slice(0, 20)) {
            list.appendChild(el('li', { text: `${h.at}  delta=${h.delta}  balance=${h.balance}  type=${h.type || '?'}` }));
          }
          result.appendChild(list);
        }
      } catch (err) {
        showError(result, err);
      }
    },
  }));

  form.appendChild(result);
  content.appendChild(form);
}

// =====================================================================
// VIEW: LIST
// =====================================================================

async function renderList(content) {
  try {
    const data = await apiCall('/admin/credits/list?limit=100');
    content.innerHTML = '';

    content.appendChild(el('h2', { text: `Clients (${data.count})` }));

    const table = el('table', { class: 'summary-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Client ID' }),
        el('th', { text: 'Balance' }),
        el('th', { text: 'Fingerprint' }),
        el('th', { text: 'IP' }),
        el('th', { text: 'Host' }),
        el('th', { text: 'First seen' }),
      ]),
    ]));
    const tbody = el('tbody');
    for (const item of data.items) {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [el('code', { text: item.clientId })]),
        el('td', { text: String(item.balance) }),
        el('td', {}, [item.fingerprint ? el('code', { text: item.fingerprint }) : '—']),
        el('td', { text: item.ip || '—' }),
        el('td', { text: item.host || '—' }),
        el('td', { text: item.firstSeen || '—' }),
      ]));
    }
    table.appendChild(tbody);
    content.appendChild(table);
  } catch (err) {
    showError(content, err);
  }
}

// =====================================================================
// VIEW: FINGERPRINT LOOKUP
// =====================================================================

async function renderFingerprintLookup(content) {
  content.innerHTML = '';

  content.appendChild(el('h2', { text: 'Look up by fingerprint' }));
  content.appendChild(el('p', { class: 'hint', text: 'Paste a fingerprint from the List clients view. Returns every clientId that shares it.' }));

  const form = el('div', { class: 'card' });
  form.appendChild(field('Fingerprint', 'fp-input', 'text'));

  const result = el('div', { class: 'result' });

  form.appendChild(el('button', {
    class: 'btn btn-primary',
    text: 'Look up',
    onclick: async () => {
      const fingerprint = $('#fp-input').value.trim();
      if (!fingerprint) return;
      try {
        const data = await apiCall('/admin/clients/lookup-by-fingerprint', {
          method: 'POST',
          body: { fingerprint },
        });
        result.innerHTML = '';
        const countText = `${data.count} match${data.count === 1 ? '' : 'es'}${data.truncated ? ' (truncated — more may exist)' : ''}`;
        result.appendChild(el('p', { text: countText }));

        if (data.matches.length === 0) return;

        const table = el('table', { class: 'summary-table' });
        table.appendChild(el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Client ID' }),
            el('th', { text: 'Balance' }),
            el('th', { text: 'IP' }),
            el('th', { text: 'Host' }),
            el('th', { text: 'First seen' }),
          ]),
        ]));
        const tbody = el('tbody');
        for (const m of data.matches) {
          tbody.appendChild(el('tr', {}, [
            el('td', {}, [el('code', { text: m.clientId })]),
            el('td', { text: String(m.balance) }),
            el('td', { text: m.ip || '—' }),
            el('td', { text: m.host || '—' }),
            el('td', { text: m.firstSeen || '—' }),
          ]));
        }
        table.appendChild(tbody);
        result.appendChild(table);
      } catch (err) {
        showError(result, err);
      }
    },
  }));

  form.appendChild(result);
  content.appendChild(form);
}

// =====================================================================
// FIELD HELPER
// =====================================================================

function field(label, id, type = 'text', placeholder = '') {
  return el('div', { class: 'field' }, [
    el('label', { for: id, text: label }),
    el('input', { id, type, placeholder, autocomplete: 'off' }),
  ]);
}

// =====================================================================
// BOOT
// =====================================================================

document.addEventListener('DOMContentLoaded', renderLogin);