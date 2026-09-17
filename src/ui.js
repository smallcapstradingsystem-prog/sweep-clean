import { state } from './state.js';

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function el(tag, attrs = {}, children = []) {
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

export function show(sel) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (node) node.style.display = '';
}

export function hide(sel) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (node) node.style.display = 'none';
}

export function logLine(msg) {
  const out = $('#run-log');
  if (!out) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  out.textContent += line + '\n';
  out.scrollTop = out.scrollHeight;
}

export function clearLog() {
  const out = $('#run-log');
  if (out) out.textContent = '';
}