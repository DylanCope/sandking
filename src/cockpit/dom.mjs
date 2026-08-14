export const element = (name, attributes = {}, text = "") => {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "hidden") {
      node.hidden = Boolean(value);
    } else if (key === "disabled") {
      node.disabled = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  node.textContent = text;
  return node;
};
