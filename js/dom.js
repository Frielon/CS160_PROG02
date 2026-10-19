// Tiny DOM helpers shared by the pages.

/** Build an element: h('a', { href: '#x', class: 'y', onclick: fn }, 'text', childNode, [more]) */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const fmt = (n) => n.toLocaleString('en-US');

function link(href, label) {
  return h('a', { href, target: '_blank', rel: 'noopener' }, label, ' ↗');
}
