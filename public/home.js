import { iconElement } from './icons.js?v=0.23.2';

const moduleGrid = document.querySelector('#module-grid');
const emptyState = document.querySelector('#module-empty');
const toast = document.querySelector('#toast');

const moduleMeta = {
  workshop: { href: '/workshop', number: '01', action: 'Відкрити майстерню' },
  service: { href: '/service', number: '02', action: 'Відкрити сервіс' },
  devices: { href: '/devices', number: '03', action: 'Відкрити пристрої' },
  erp: { href: '/erp', number: '04', action: 'Відкрити виробництво' }
};

function showToast(message) {
  toast.textContent = message;
  toast.className = 'toast show error';
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Помилка ${response.status}`);
  return body;
}

function moduleCard(module) {
  const meta = moduleMeta[module.key];
  const link = document.createElement('a');
  link.className = `module-card module-card-${module.key}`;
  link.href = meta.href;
  const number = document.createElement('span');
  number.className = 'module-number';
  number.textContent = meta.number;
  const content = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = module.title;
  const description = document.createElement('p');
  description.textContent = module.description;
  content.append(title, description);
  const action = document.createElement('span');
  action.className = 'module-action';
  action.textContent = meta.action;
  const arrow = iconElement('arrow-right', 'module-action-icon');
  action.append(arrow);
  link.append(number, content, action);
  return link;
}

async function start() {
  try {
    const [me, response] = await Promise.all([api('/api/me'), api('/api/modules')]);
    document.querySelector('#identity-name').textContent = me.displayName || me.email;
    document.querySelector('#admin-link').classList.toggle('hidden', me.role !== 'admin');
    moduleGrid.replaceChildren(...response.modules.map(moduleCard));
    emptyState.classList.toggle('hidden', response.modules.length > 0);
  } catch (error) {
    moduleGrid.replaceChildren();
    showToast(error.message);
  }
}

start();
