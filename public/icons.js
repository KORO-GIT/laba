const paths = {
  'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  'arrow-up': '<path d="m6 11 6-6 6 6"/><path d="M12 5v14"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m18 13-6 6-6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  square: '<rect x="7" y="7" width="10" height="10" rx="1"/>'
};

export function iconMarkup(name) {
  const path = paths[name];
  if (!path) throw new Error(`Unknown icon: ${name}`);
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

export function iconElement(name, className = '') {
  const node = document.createElement('span');
  node.className = `ui-icon${className ? ` ${className}` : ''}`;
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = iconMarkup(name);
  return node;
}
